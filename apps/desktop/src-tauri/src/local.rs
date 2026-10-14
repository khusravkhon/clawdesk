//! "This computer": ClawDesk in Docker Desktop on this machine — the same stack a server runs, for people
//! who try it before renting a server. The bundled server code is unpacked into the app's data folder and
//! deploy/scripts/local.sh builds and starts it (its own compose project, data and port, so a development
//! checkout on the same machine is not touched). Containers restart with Docker Desktop; opening the panel
//! starts Docker Desktop when it is not running.

use crate::install::{strip_ansi, InstallResult, LogLine, Step};
use crate::servers::{Server, Store};
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// The server entry of this computer (there is only one).
pub const LOCAL_ID: &str = "local";
/// deploy/scripts/local.sh publishes the panel here (servers use 8080; this keeps clear of other local apps).
pub const LOCAL_PORT: u16 = 18080;

const DOCKER_WAIT: Duration = Duration::from_secs(240);
const PANEL_WAIT: Duration = Duration::from_secs(180);

pub fn panel_url() -> String {
    format!("http://127.0.0.1:{LOCAL_PORT}")
}

/// A command without a console window flashing up on Windows.
fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

async fn docker_ready() -> bool {
    let status = command("docker").arg("info").stdout(Stdio::null()).stderr(Stdio::null()).status();
    matches!(tokio::time::timeout(Duration::from_secs(20), status).await, Ok(Ok(s)) if s.success())
}

/// Docker Desktop's own launcher, when it is installed in the usual place.
fn docker_desktop() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let base = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
        let exe = base.join(r"Docker\Docker\Docker Desktop.exe");
        return exe.exists().then_some(exe);
    }
    #[cfg(target_os = "macos")]
    {
        let app = PathBuf::from("/Applications/Docker.app");
        return app.exists().then_some(app);
    }
    #[allow(unreachable_code)]
    None
}

/// Docker answers, starting Docker Desktop first if it is installed but not running.
pub async fn ensure_docker(log: impl Fn(&str)) -> Result<()> {
    if docker_ready().await {
        return Ok(());
    }
    let Some(app) = docker_desktop() else {
        bail!("Docker is not running. Install Docker Desktop (docker.com) and start it, then try again.");
    };
    log("Starting Docker Desktop…");
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg("-a").arg(&app).spawn().context("could not start Docker Desktop")?;
    #[cfg(not(target_os = "macos"))]
    std::process::Command::new(&app).spawn().context("could not start Docker Desktop")?;
    let start = Instant::now();
    while start.elapsed() < DOCKER_WAIT {
        tokio::time::sleep(Duration::from_secs(3)).await;
        if docker_ready().await {
            return Ok(());
        }
    }
    bail!("Docker Desktop did not start in {} minutes. Open it yourself and try again.", DOCKER_WAIT.as_secs() / 60)
}

async fn panel_answers() -> bool {
    matches!(
        tokio::time::timeout(Duration::from_secs(2), tokio::net::TcpStream::connect(("127.0.0.1", LOCAL_PORT))).await,
        Ok(Ok(_))
    )
}

/// Before opening the panel window: Docker Desktop up and the panel listening (it restarts with Docker).
pub async fn ensure_running() -> Result<()> {
    if panel_answers().await {
        return Ok(());
    }
    ensure_docker(|_| {}).await?;
    let start = Instant::now();
    while start.elapsed() < PANEL_WAIT {
        if panel_answers().await {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    bail!("ClawDesk on this computer does not answer. Run “Update” on it to start it again.")
}

/// bash runs the installer: Git Bash on Windows (never the WSL bash.exe in System32).
fn find_bash() -> Result<PathBuf> {
    #[cfg(windows)]
    {
        let roots = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"].iter().filter_map(|v| std::env::var_os(v)).map(PathBuf::from);
        let user = std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Programs"));
        for root in roots.chain(user) {
            let bash = root.join(r"Git\bin\bash.exe");
            if bash.exists() {
                return Ok(bash);
            }
        }
        bail!("Git for Windows is needed (git-scm.com): ClawDesk is set up with its bash. Install it and try again.");
    }
    #[allow(unreachable_code)]
    Ok(PathBuf::from("bash"))
}

/// Unpacks the bundled server code over the previous copy; deploy/.env (settings and secrets) is not in the
/// archive, so it survives updates.
fn unpack(archive: &Path, dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let file = std::fs::File::open(archive).with_context(|| format!("cannot read {}", archive.display()))?;
    tar::Archive::new(flate2::read::GzDecoder::new(file)).unpack(dir).context("could not unpack the server code")
}

pub async fn install(app: &AppHandle, store: &Store, name: String) -> Result<InstallResult> {
    let log = |line: &str| {
        let _ = app.emit("install://log", LogLine { line });
    };
    let step = |s: &str| {
        let _ = app.emit("install://step", Step { step: s });
        let _ = app.emit("install://log", LogLine { line: &format!("==> {s}") });
    };

    step("Checking Docker");
    let bash = find_bash()?;
    ensure_docker(log).await?;

    step("Unpacking ClawDesk");
    let archive = app.path().resolve("clawdesk-src.tar.gz", tauri::path::BaseDirectory::Resource).context("the app has no bundled server code")?;
    let dir = app.path().app_local_data_dir()?.join("server");
    unpack(&archive, &dir)?;
    log(&format!("server code: {}", dir.display()));

    step("Running the installer");
    let mut child = command(&bash)
        .arg("-c")
        .arg("bash deploy/scripts/local.sh < /dev/null 2>&1")
        .current_dir(&dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("could not start the installer")?;
    let mut lines = BufReader::new(child.stdout.take().context("no installer output")?).lines();
    let mut setup_url = None;
    while let Some(line) = lines.next_line().await? {
        let clean = strip_ansi(line.trim_end_matches('\r'));
        if let Some(s) = clean.strip_prefix("==> ") {
            let _ = app.emit("install://step", Step { step: s });
        }
        if let Some(url) = clean.strip_prefix("Open ").and_then(|r| r.split_whitespace().next()) {
            if url.contains("/setup?code=") {
                setup_url = Some(url.to_owned());
            }
        }
        log(&clean);
    }
    let status = child.wait().await?;
    if !status.success() {
        bail!("the installer stopped with code {}; see the log", status.code().unwrap_or(-1));
    }

    let created_at = store.get(LOCAL_ID).map(|s| s.created_at).unwrap_or_else(|_| SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
    let server = Server {
        id: LOCAL_ID.to_owned(),
        name,
        host: "127.0.0.1".to_owned(),
        port: 0,
        user: String::new(),
        panel_url: Some(panel_url()),
        host_key: String::new(),
        created_at,
        tunnel_port: None,
        local: true,
    };
    store.save(&server)?;
    step("Done");
    Ok(InstallResult { server, setup_url })
}
