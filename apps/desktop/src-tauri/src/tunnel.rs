//! SSH tunnel for a server without a domain: 127.0.0.1:<local port> on this computer → 127.0.0.1:<panel port> on
//! the server (where the panel listens, never exposed to the internet; 8080 unless the install chose another
//! PANEL_PORT). One tunnel per server, kept while the app runs; a dropped SSH session is reconnected on the next
//! request.

use crate::ssh::Session;
use anyhow::{Context, Result};
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// The panel's default port on the server (deploy/docker-compose.yml, PANEL_PORT); see detect_panel_port.
pub const PANEL_PORT: u16 = 8080;

/// Finds the port the panel answers on: the one Docker publishes for the Gateway's 8080 (the panel shares its
/// network), then the default. A port counts only when ClawDesk's own /api/health answers there, so another
/// service on 8080 (CrowdSec on many VPS images) is never taken for the panel.
pub const DETECT_PANEL_PORT: &str = r#"for p in $( { docker ps --filter label=com.docker.compose.service=gateway --format '{{.Ports}}' 2>/dev/null || sudo -n docker ps --filter label=com.docker.compose.service=gateway --format '{{.Ports}}' 2>/dev/null; } | grep -oE '127\.0\.0\.1:[0-9]+->8080/tcp' | sed -E 's/^127\.0\.0\.1:([0-9]+)->.*/\1/') 8080; do curl -fsS --max-time 5 "http://127.0.0.1:$p/api/health" 2>/dev/null | grep -q '"ok"' && { echo "panel-port=$p"; break; }; done; true"#;

/// The port from DETECT_PANEL_PORT's output, or None when no ClawDesk panel answered.
pub fn parse_panel_port(output: &str) -> Option<u16> {
    output.lines().find_map(|line| line.trim().strip_prefix("panel-port=")?.parse().ok()).filter(|p| *p > 0)
}

pub async fn detect_panel_port(session: &Session) -> Result<Option<u16>> {
    Ok(parse_panel_port(&session.run(DETECT_PANEL_PORT).await?))
}

pub struct Tunnel {
    pub local_port: u16,
    session: Arc<Mutex<Arc<Session>>>,
    task: JoinHandle<()>,
}

impl Tunnel {
    pub fn is_alive(&self) -> bool {
        !self.task.is_finished()
    }

    /// Swaps in a fresh SSH session (after the old one dropped); the listener keeps its port.
    pub async fn replace_session(&self, session: Session) {
        *self.session.lock().await = Arc::new(session);
    }

    pub async fn session_closed(&self) -> bool {
        self.session.lock().await.handle.is_closed()
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Listens on `preferred` (the port used last time, so the panel's cookie stays valid) or any free port, and
/// forwards to the server's 127.0.0.1:`remote_port`.
pub async fn start(session: Session, preferred: Option<u16>, remote_port: u16) -> Result<Tunnel> {
    let listener = match preferred {
        Some(port) => match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(_) => TcpListener::bind(("127.0.0.1", 0)).await?,
        },
        None => TcpListener::bind(("127.0.0.1", 0)).await?,
    };
    let local_port = listener.local_addr()?.port();
    let session = Arc::new(Mutex::new(Arc::new(session)));
    let shared = session.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((stream, peer)) = listener.accept().await else { break };
            let session = shared.lock().await.clone();
            tokio::spawn(async move {
                if let Err(e) = forward(&session, stream, peer.port(), remote_port).await {
                    eprintln!("clawdesk tunnel: {e:#}");
                }
            });
        }
    });
    Ok(Tunnel { local_port, session, task })
}

async fn forward(session: &Session, mut local: TcpStream, origin_port: u16, remote_port: u16) -> Result<()> {
    let channel = session
        .handle
        .channel_open_direct_tcpip("127.0.0.1", u32::from(remote_port), "127.0.0.1", u32::from(origin_port))
        .await
        .context("the server refused the tunnel")?;
    let mut remote = channel.into_stream();
    tokio::io::copy_bidirectional(&mut local, &mut remote).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_port_the_panel_answered_on() {
        assert_eq!(parse_panel_port("panel-port=18080\n"), Some(18080));
        assert_eq!(parse_panel_port("noise\npanel-port=8080"), Some(8080));
    }

    #[test]
    fn no_answer_means_no_port() {
        for output in ["", "\n", "panel-port=", "panel-port=abc", "panel-port=0", "panel-port=70000", "18080"] {
            assert_eq!(parse_panel_port(output), None, "{output:?}");
        }
    }

    #[test]
    fn the_probe_tries_the_published_port_before_the_default_and_checks_the_panel() {
        let published = DETECT_PANEL_PORT.find("->8080/tcp").unwrap();
        let default = DETECT_PANEL_PORT.find(") 8080; do").unwrap();
        assert!(published < default);
        assert!(DETECT_PANEL_PORT.contains("/api/health") && DETECT_PANEL_PORT.contains(r#"grep -q '"ok"'"#));
    }
}
