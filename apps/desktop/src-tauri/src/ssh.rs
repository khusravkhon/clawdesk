//! SSH with russh: host key check (trust on first use, then an exact match), password or key sign-in,
//! commands with their output line by line, and SFTP upload.

use anyhow::{anyhow, bail, Context, Result};
use russh::client::{self, Handle};
use russh::keys::{decode_secret_key, ssh_key, HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::ChannelMsg;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

pub enum Auth {
    Password(String),
    /// OpenSSH private key text.
    Key(String),
}

pub struct Checker {
    /// None on first contact: any key is accepted and remembered by the caller.
    expected: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
}

impl client::Handler for Checker {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let data = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.key_data(),
            PublicKeyOrCertificate::Certificate(cert) => cert.public_key(),
        };
        let fingerprint = data.fingerprint(HashAlg::Sha256).to_string();
        *self.seen.lock().unwrap() = Some(fingerprint.clone());
        Ok(self.expected.as_deref().map_or(true, |e| e == fingerprint))
    }
}

pub struct Session {
    pub handle: Arc<Handle<Checker>>,
    /// SHA-256 fingerprint of the server's host key.
    pub host_key: String,
}

pub async fn connect(host: &str, port: u16, user: &str, auth: &Auth, expected_host_key: Option<&str>) -> Result<Session> {
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 3,
        ..Default::default()
    });
    let seen = Arc::new(Mutex::new(None));
    let checker = Checker { expected: expected_host_key.map(str::to_owned), seen: seen.clone() };
    let connecting = client::connect(config, (host, port), checker);
    let mut handle = match tokio::time::timeout(Duration::from_secs(20), connecting).await {
        Err(_) => bail!("the server did not answer on {host}:{port}"),
        Ok(Err(e)) => {
            let got = seen.lock().unwrap().clone();
            if let (Some(expected), Some(got)) = (expected_host_key, got) {
                if expected != got {
                    bail!("the server's SSH key changed ({got}, expected {expected}). If the server was reinstalled, remove it from the list and add it again; otherwise someone may be intercepting the connection.");
                }
            }
            return Err(anyhow!(e).context(format!("could not connect to {host}:{port}")));
        }
        Ok(Ok(h)) => h,
    };
    let host_key = seen.lock().unwrap().clone().context("no host key")?;

    let ok = match auth {
        Auth::Password(password) => handle.authenticate_password(user, password).await?.success(),
        Auth::Key(text) => {
            let key: PrivateKey = decode_secret_key(text, None).context("this private key cannot be read (OpenSSH format, no passphrase)")?;
            let hash = handle.best_supported_rsa_hash().await?.flatten();
            handle.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await?.success()
        }
    };
    if !ok {
        bail!("the server did not accept the {} for {user}", if matches!(auth, Auth::Password(_)) { "password" } else { "key" });
    }
    Ok(Session { handle: Arc::new(handle), host_key })
}

impl Session {
    /// Runs a command; output (stdout and stderr) comes line by line. `stdin` is written first (e.g. a sudo password).
    pub async fn exec(&self, command: &str, stdin: Option<&str>, mut on_line: impl FnMut(&str)) -> Result<u32> {
        let mut channel = self.handle.channel_open_session().await?;
        channel.exec(true, command).await?;
        if let Some(input) = stdin {
            channel.data(input.as_bytes()).await?;
            channel.eof().await?;
        }
        let mut pending = Vec::<u8>::new();
        let mut status = None;
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    pending.extend_from_slice(&data);
                    while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = pending.drain(..=pos).collect();
                        on_line(String::from_utf8_lossy(&line).trim_end_matches(['\r', '\n']));
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                _ => {}
            }
        }
        if !pending.is_empty() {
            on_line(String::from_utf8_lossy(&pending).trim_end());
        }
        status.context("the command ended without an exit status")
    }

    /// Output of a short command, failing on a non-zero exit.
    pub async fn run(&self, command: &str) -> Result<String> {
        let mut out = String::new();
        let code = self.exec(command, None, |l| {
            out.push_str(l);
            out.push('\n');
        })
        .await?;
        if code != 0 {
            bail!("`{command}` failed ({code}): {}", out.trim());
        }
        Ok(out)
    }

    pub async fn upload(&self, remote_path: &str, bytes: &[u8]) -> Result<()> {
        let channel = self.handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream()).await.context("the server has no SFTP")?;
        let mut file = sftp.create(remote_path).await.with_context(|| format!("cannot create {remote_path}"))?;
        file.write_all(bytes).await?;
        file.shutdown().await?;
        Ok(())
    }
}

/// A new ed25519 key for the app: (private OpenSSH text, public OpenSSH line).
pub fn new_key(comment: &str) -> Result<(String, String)> {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).map_err(|e| anyhow!("no system randomness: {e}"))?;
    let mut key = PrivateKey::from(ssh_key::private::Ed25519Keypair::from_seed(&seed));
    key.set_comment(comment);
    let private = key.to_openssh(ssh_key::LineEnding::LF)?.to_string();
    let public = key.public_key().to_openssh()?;
    Ok((private, public))
}

/// Against a real sshd: `CLAWDESK_TEST_SSH=127.0.0.1:2222 CLAWDESK_TEST_SSH_PASSWORD=… cargo test -- --ignored`.
/// The server must serve GET /api/health on its 127.0.0.1:8080 (the panel's port), like an installed ClawDesk.
#[cfg(test)]
mod e2e {
    use super::*;
    use tokio::io::AsyncReadExt;

    fn target() -> (String, u16, String) {
        let addr = std::env::var("CLAWDESK_TEST_SSH").expect("CLAWDESK_TEST_SSH=host:port");
        let (host, port) = addr.rsplit_once(':').unwrap();
        (host.to_owned(), port.parse().unwrap(), std::env::var("CLAWDESK_TEST_SSH_PASSWORD").unwrap())
    }

    #[tokio::test]
    #[ignore]
    async fn password_then_own_key_then_tunnel() {
        let (host, port, password) = target();
        let first = connect(&host, port, "root", &Auth::Password(password), None).await.unwrap();
        assert!(first.host_key.starts_with("SHA256:"));
        assert_eq!(first.run("id -u").await.unwrap().trim(), "0");

        // The app's own key replaces the password.
        let (private, public) = new_key("clawdesk-test").unwrap();
        first.run(&format!("umask 077 && mkdir -p ~/.ssh && printf '%s\n' '{public}' >> ~/.ssh/authorized_keys")).await.unwrap();
        let session = connect(&host, port, "root", &Auth::Key(private.clone()), Some(&first.host_key)).await.unwrap();

        // A different host key is refused.
        let refused = connect(&host, port, "root", &Auth::Key(private), Some("SHA256:not-this-server")).await;
        assert!(refused.err().unwrap().to_string().contains("changed"));

        // SFTP upload and streamed output.
        session.upload("/tmp/clawdesk-test.txt", b"uploaded over sftp\n").await.unwrap();
        let mut lines = Vec::new();
        let code = session.exec("cat /tmp/clawdesk-test.txt; echo second; exit 3", None, |l| lines.push(l.to_owned())).await.unwrap();
        assert_eq!((code, lines), (3, vec!["uploaded over sftp".to_owned(), "second".to_owned()]));

        // The tunnel reaches the server's 127.0.0.1:8080.
        let t = crate::tunnel::start(session, None).await.unwrap();
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", t.local_port)).await.unwrap();
        stream.write_all(b"GET /api/health HTTP/1.0\r\nHost: x\r\n\r\n").await.unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).await.unwrap();
        assert!(answer.starts_with("HTTP/1.0 200"), "{answer}");
        assert!(answer.contains("\"ok\""));
    }
}
