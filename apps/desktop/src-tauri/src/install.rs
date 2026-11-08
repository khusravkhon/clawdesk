//! "Install on a server": sign in with the provider's password once, put the app's own key on the server,
//! upload this version's server code (bundled in the app), run deploy/install.sh, and report its log.

use crate::servers::{self, Server};
use crate::ssh::{self, Auth};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallInput {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    /// "domain" | "sslip" | "tunnel"
    pub https: String,
    pub domain: Option<String>,
    /// The person chose to set aside data a newer ClawDesk wrote (deploy/scripts/init.sh).
    #[serde(default)]
    pub set_aside_newer_data: bool,
}

/// init.sh stops on data a newer ClawDesk wrote and says so on its last line:
/// "CLAWDESK-DATA-NEWER data=<version> app=<version>". Returns (data, app).
pub(crate) fn data_newer(line: &str) -> Option<(String, String)> {
    let rest = line.trim().strip_prefix("CLAWDESK-DATA-NEWER ")?;
    let mut data = None;
    let mut app = None;
    for part in rest.split_whitespace() {
        if let Some(v) = part.strip_prefix("data=") {
            data = Some(v.to_owned());
        } else if let Some(v) = part.strip_prefix("app=") {
            app = Some(v.to_owned());
        }
    }
    let valid = |v: &String| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit() || c == '.');
    Some((data.filter(valid)?, app.filter(valid)?))
}

/// The error the app shows as a choice (update the app / set the data aside / cancel), not as a failure.
pub(crate) fn data_newer_error(found: Option<(String, String)>) -> Option<anyhow::Error> {
    found.map(|(data, app)| anyhow::anyhow!("data_newer:{data}:{app}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub server: Server,
    /// The first-run link install.sh printed (/setup?code=…).
    pub setup_url: Option<String>,
}

#[derive(Clone, Serialize)]
pub(crate) struct LogLine<'a> {
    pub line: &'a str,
}

#[derive(Clone, Serialize)]
pub(crate) struct Step<'a> {
    pub step: &'a str,
}

const REMOTE_ARCHIVE: &str = "/tmp/clawdesk-src.tar.gz";
const REMOTE_DIR: &str = "/opt/clawdesk";

/// Single-quoted for sh.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn valid_domain(d: &str) -> bool {
    d.len() <= 253 && d.contains('.') && d.split('.').all(|p| !p.is_empty() && p.len() <= 63 && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') && !p.starts_with('-') && !p.ends_with('-'))
}

pub async fn run(app: &AppHandle, store: &servers::Store, input: InstallInput) -> Result<InstallResult> {
    let log = |line: &str| {
        let _ = app.emit("install://log", LogLine { line });
    };
    let step = |s: &str| {
        let _ = app.emit("install://step", Step { step: s });
        let _ = app.emit("install://log", LogLine { line: &format!("==> {s}") });
    };
    let domain = match input.https.as_str() {
        "domain" => {
            let d = input.domain.as_deref().unwrap_or("").trim().to_lowercase();
            if !valid_domain(&d) {
                bail!("\"{d}\" does not look like a domain name");
            }
            Some(d)
        }
        "sslip" | "tunnel" => None,
        other => bail!("unknown HTTPS choice {other}"),
    };

    step("Connecting");
    let session = ssh::connect(&input.host, input.port, &input.user, &Auth::Password(input.password.clone()), None).await?;
    log(&format!("server key: {}", session.host_key));
    let root = session.run("id -u").await?.trim() == "0";
    // Not root: everything privileged goes through sudo with the same password on stdin.
    let sudo = if root { String::new() } else { "sudo -S -p '' ".to_owned() };
    let sudo_input = (!root).then(|| format!("{}\n", input.password));

    step("Installing the app's key");
    let id = uuid::Uuid::new_v4().to_string();
    let (private_key, public_key) = ssh::new_key(&format!("clawdesk-desktop-{id}"))?;
    session
        .run(&format!(
            "umask 077 && mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && printf '%s\\n' {} >> ~/.ssh/authorized_keys",
            sh_quote(&public_key)
        ))
        .await?;

    step("Uploading ClawDesk");
    let archive = app.path().resolve("clawdesk-src.tar.gz", tauri::path::BaseDirectory::Resource).context("the app has no bundled server code")?;
    let bytes = std::fs::read(&archive).with_context(|| format!("cannot read {}", archive.display()))?;
    session.upload(REMOTE_ARCHIVE, &bytes).await?;
    log(&format!("uploaded {} KB", bytes.len() / 1024));

    step("Running the installer");
    let args = match (&domain, input.https.as_str()) {
        (Some(d), _) => format!("--domain {}", sh_quote(d)),
        (None, "tunnel") => "--no-https".to_owned(),
        _ => String::new(),
    };
    // install.sh keeps data and .env when re-run, so installing over an existing copy updates it.
    let set_aside = if input.set_aside_newer_data { "CLAWDESK_SET_ASIDE_NEWER_DATA=1 " } else { "" };
    let command = format!(
        "{sudo}sh -c {}",
        sh_quote(&format!(
            "mkdir -p {REMOTE_DIR} && tar -xzf {REMOTE_ARCHIVE} -C {REMOTE_DIR} && rm -f {REMOTE_ARCHIVE} && {set_aside}bash {REMOTE_DIR}/deploy/install.sh {args} < /dev/null 2>&1"
        ))
    );
    let mut setup_url = None;
    let mut panel_url = None;
    let mut newer = None;
    let code = session
        .exec(&command, sudo_input.as_deref(), |line| {
            // Colours and the installer's own step markers.
            let clean: String = strip_ansi(line);
            if let Some(s) = clean.strip_prefix("==> ") {
                let _ = app.emit("install://step", Step { step: s });
            }
            if let Some(url) = clean.strip_prefix("Open ").and_then(|r| r.split_whitespace().next()) {
                if url.contains("/setup?code=") {
                    setup_url = Some(url.to_owned());
                }
            }
            if let Some(url) = clean.strip_prefix("ClawDesk is starting: ") {
                panel_url = url.trim().starts_with("https://").then(|| url.trim().to_owned());
            }
            if let Some(found) = data_newer(&clean) {
                newer = Some(found);
            }
            let _ = app.emit("install://log", LogLine { line: &clean });
        })
        .await?;
    if code != 0 {
        if let Some(error) = data_newer_error(newer) {
            return Err(error);
        }
        bail!("the installer stopped with code {code}; see the log");
    }

    // Re-installing over an install with its own PANEL_PORT keeps that port; the tunnel must lead there.
    let panel_port = crate::tunnel::detect_panel_port(&session).await.ok().flatten();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let server = Server {
        id,
        name: input.name,
        host: input.host,
        port: input.port,
        user: input.user,
        panel_url,
        host_key: session.host_key.clone(),
        created_at: now,
        tunnel_port: None,
        local: false,
        panel_port,
    };
    // Only a server that installed is kept, with its key in the system keychain.
    servers::store_key(&server.id, &private_key)?;
    store.save(&server)?;
    step("Done");
    Ok(InstallResult { server, setup_url })
}

pub(crate) fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_for_sh() {
        assert_eq!(sh_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn domains() {
        assert!(valid_domain("panel.example.com"));
        assert!(!valid_domain("bad domain"));
        assert!(!valid_domain("example"));
        assert!(!valid_domain("-x.com"));
    }

    #[test]
    fn reads_the_installers_newer_data_line() {
        assert_eq!(data_newer("CLAWDESK-DATA-NEWER data=2026.8.35 app=2026.8.1"), Some(("2026.8.35".into(), "2026.8.1".into())));
        assert_eq!(data_newer("  CLAWDESK-DATA-NEWER app=2026.8.1 data=2026.11.2  "), Some(("2026.11.2".into(), "2026.8.1".into())));
        for line in ["", "CLAWDESK-DATA-NEWER", "CLAWDESK-DATA-NEWER data=2026.8.35", "CLAWDESK-DATA-NEWER data=x;rm app=1", "echo CLAWDESK-DATA-NEWER data=1 app=1"] {
            assert_eq!(data_newer(line), None, "{line:?}");
        }
        assert_eq!(data_newer_error(data_newer("CLAWDESK-DATA-NEWER data=2026.8.35 app=2026.8.1")).unwrap().to_string(), "data_newer:2026.8.35:2026.8.1");
    }

    #[test]
    fn strips_colours() {
        assert_eq!(strip_ansi("\u{1b}[1m==> Checking\u{1b}[0m"), "==> Checking");
    }
}
