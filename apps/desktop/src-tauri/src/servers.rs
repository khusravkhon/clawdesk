//! The person's servers: a JSON list in the app's config folder (nothing secret), and each server's SSH
//! private key in the system keychain (Windows Credential Manager, macOS Keychain, Secret Service).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const KEYCHAIN_SERVICE: &str = "ClawDesk";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// https://… when the panel has a domain; None: reached through an SSH tunnel.
    pub panel_url: Option<String>,
    /// SHA-256 fingerprint of the server's SSH host key, remembered on first contact (trust on first use).
    pub host_key: String,
    pub created_at: u64,
    /// Local port of the tunnel, kept so the panel's sign-in cookie (bound to the address) survives restarts.
    #[serde(default)]
    pub tunnel_port: Option<u16>,
    /// "This computer": ClawDesk in Docker Desktop here, no SSH (see local.rs).
    #[serde(default)]
    pub local: bool,
}

pub struct Store {
    file: PathBuf,
}

impl Store {
    pub fn new(config_dir: PathBuf) -> Self {
        Self { file: config_dir.join("servers.json") }
    }

    pub fn list(&self) -> Result<Vec<Server>> {
        match std::fs::read_to_string(&self.file) {
            Ok(text) => Ok(serde_json::from_str(&text).context("servers.json is damaged")?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn get(&self, id: &str) -> Result<Server> {
        self.list()?.into_iter().find(|s| s.id == id).context("no such server")
    }

    pub fn save(&self, server: &Server) -> Result<()> {
        let mut all = self.list()?;
        all.retain(|s| s.id != server.id);
        all.push(server.clone());
        all.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        self.write(&all)
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        let mut all = self.list()?;
        all.retain(|s| s.id != id);
        self.write(&all)?;
        // Missing key is fine: the server may have been added with a key the person keeps elsewhere.
        let _ = keyring::Entry::new(KEYCHAIN_SERVICE, &key_name(id)).and_then(|e| e.delete_credential());
        Ok(())
    }

    fn write(&self, all: &[Server]) -> Result<()> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(all)?)?;
        std::fs::rename(&tmp, &self.file)?;
        Ok(())
    }
}

fn key_name(id: &str) -> String {
    format!("ssh-key:{id}")
}

/// The app's SSH private key for this server (OpenSSH format), from the system keychain.
pub fn load_key(id: &str) -> Result<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &key_name(id))?.get_password().context("the server's key is not in the system keychain")
}

pub fn store_key(id: &str, private_key: &str) -> Result<()> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &key_name(id))?.set_password(private_key).context("could not save the key in the system keychain")
}
