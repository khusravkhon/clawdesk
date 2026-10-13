//! SSH tunnel for a server without a domain: 127.0.0.1:<local port> on this computer → 127.0.0.1:8080 on the
//! server (where the panel listens, never exposed to the internet). One tunnel per server, kept while the app
//! runs; a dropped SSH session is reconnected on the next request.

use crate::ssh::Session;
use anyhow::{Context, Result};
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// The panel's port on the server (deploy/docker-compose.yml, PANEL_PORT).
pub const PANEL_PORT: u32 = 8080;

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

/// Listens on `preferred` (the port used last time, so the panel's cookie stays valid) or any free port.
pub async fn start(session: Session, preferred: Option<u16>) -> Result<Tunnel> {
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
                if let Err(e) = forward(&session, stream, peer.port()).await {
                    eprintln!("clawdesk tunnel: {e:#}");
                }
            });
        }
    });
    Ok(Tunnel { local_port, session, task })
}

async fn forward(session: &Session, mut local: TcpStream, origin_port: u16) -> Result<()> {
    let channel = session
        .handle
        .channel_open_direct_tcpip("127.0.0.1", PANEL_PORT, "127.0.0.1", origin_port as u32)
        .await
        .context("the server refused the tunnel")?;
    let mut remote = channel.into_stream();
    tokio::io::copy_bidirectional(&mut local, &mut remote).await?;
    Ok(())
}
