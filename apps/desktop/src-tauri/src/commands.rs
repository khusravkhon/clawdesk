//! Commands the launcher window calls (allowed only for it: capabilities/launcher.json).

use crate::install::{self, InstallInput, InstallResult};
use crate::local;
use crate::servers::{self, Server, Store};
use crate::ssh::{self, Auth};
use crate::tunnel::{self, Tunnel};
use serde::Deserialize;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex;

pub struct AppState {
    pub store: Store,
    pub tunnels: Mutex<HashMap<String, Tunnel>>,
    pub recovery: Mutex<Option<crate::recovery::Receipt>>,
}

type Res<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[tauri::command]
pub async fn list_servers(state: State<'_, AppState>) -> Res<Vec<Server>> {
    state.store.list().map_err(err)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddServerInput {
    name: String,
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
    private_key: Option<String>,
    panel_url: Option<String>,
}

/// A server that already runs ClawDesk. With a password the app installs its own key and forgets the password.
#[tauri::command]
pub async fn add_server(state: State<'_, AppState>, input: AddServerInput) -> Res<Server> {
    let panel_url = match input.panel_url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        Some(u) if u.starts_with("https://") => Some(u.trim_end_matches('/').to_owned()),
        Some(_) => return Err("the panel address must start with https://".into()),
        None => None,
    };
    let id = uuid::Uuid::new_v4().to_string();
    let (auth, key) = match (input.password.filter(|p| !p.is_empty()), input.private_key.filter(|k| !k.trim().is_empty())) {
        (_, Some(key)) => (Auth::Key(key.clone()), Some(key)),
        (Some(password), None) => (Auth::Password(password), None),
        (None, None) => return Err("a password or a private key is needed".into()),
    };
    let session = ssh::connect(&input.host, input.port, &input.user, &auth, None).await.map_err(err)?;
    // ClawDesk must be there: the panel answers on the server's loopback.
    session
        .run(&format!("curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:{}/api/health", tunnel::PANEL_PORT))
        .await
        .map_err(|_| "ClawDesk does not answer on this server (port 8080). Install it with “Install on a server”.".to_string())?;
    let key = match key {
        Some(k) => k,
        None => {
            let (private_key, public_key) = ssh::new_key(&format!("clawdesk-desktop-{id}")).map_err(err)?;
            session
                .run(&format!("umask 077 && mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && printf '%s\\n' '{}' >> ~/.ssh/authorized_keys", public_key.replace('\'', "")))
                .await
                .map_err(err)?;
            private_key
        }
    };
    servers::store_key(&id, &key).map_err(err)?;
    let server = Server {
        id,
        name: input.name,
        host: input.host,
        port: input.port,
        user: input.user,
        panel_url,
        host_key: session.host_key.clone(),
        created_at: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        tunnel_port: None,
        local: false,
    };
    state.store.save(&server).map_err(err)?;
    Ok(server)
}

#[tauri::command]
pub async fn remove_server(app: AppHandle, state: State<'_, AppState>, id: String) -> Res<()> {
    state.tunnels.lock().await.remove(&id);
    if let Some(w) = app.get_webview_window(&panel_label(&id)) {
        let _ = w.close();
    }
    state.store.remove(&id).map_err(err)
}

#[tauri::command]
pub async fn install_server(app: AppHandle, state: State<'_, AppState>, input: InstallInput) -> Res<InstallResult> {
    install::run(&app, &state.store, input).await.map_err(err)
}

/// "This computer": sets up (or updates) ClawDesk in Docker Desktop here.
#[tauri::command]
pub async fn install_local(app: AppHandle, state: State<'_, AppState>, name: String) -> Res<InstallResult> {
    let _guard = state.recovery.lock().await;
    local::install(&app, &state.store, name).await.map_err(err)
}

#[tauri::command]
pub async fn local_status(app: AppHandle) -> Res<crate::recovery::LocalStatus> {
    crate::recovery::status(&app).await.map_err(err)
}

#[tauri::command]
pub async fn inspect_local_backup(app: AppHandle, state: State<'_, AppState>, archive: String, password: String) -> Res<crate::recovery::Inspection> {
    let mut pending = state.recovery.lock().await;
    if let Some(old) = pending.take() { let _ = std::fs::remove_file(old.archive); }
    let (inspection, receipt) = crate::recovery::inspect(&app, archive, password).await.map_err(err)?;
    *pending = Some(receipt);
    Ok(inspection)
}

#[tauri::command]
pub async fn restore_local(app: AppHandle, state: State<'_, AppState>, receipt: String, confirmation: String, password: String) -> Res<()> {
    let mut pending = state.recovery.lock().await;
    if pending.as_ref().map(|p| p.id.as_str()) != Some(receipt.as_str()) { return Err("Inspect this backup again before restoring".into()); }
    crate::recovery::restore(&app, pending.take().unwrap(), confirmation, password).await.map_err(err)
}

fn panel_label(id: &str) -> String {
    format!("panel-{}", id.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>())
}

fn is_panel_navigation(panel: &tauri::Url, target: &tauri::Url) -> bool {
    panel.origin() == target.origin()
}

fn open_browser(app: &AppHandle, url: &tauri::Url) {
    if matches!(url.scheme(), "https" | "http") {
        if tauri_plugin_opener::open_url(url.as_str(), None::<&str>).is_err() {
            eprintln!("ClawDesk: failed to open the system browser");
            let _ = app.notification().builder()
                .title("ClawDesk")
                .body("Could not open the browser. Copy the sign-in link and open it in your browser.")
                .show();
        }
    }
}

/// Opens (or focuses) the panel of a server in its own window: straight to its HTTPS address, or through the tunnel.
#[tauri::command]
pub async fn open_panel(app: AppHandle, state: State<'_, AppState>, id: String, path: Option<String>) -> Res<()> {
    let mut server = state.store.get(&id).map_err(err)?;
    if server.local {
        // After a reboot Docker Desktop may not be running yet; the containers come back with it.
        local::ensure_running(&app).await.map_err(err)?;
    }
    let base = match &server.panel_url {
        Some(url) => url.clone(),
        None => {
            let port = ensure_tunnel(&state, &server).await.map_err(err)?;
            if server.tunnel_port != Some(port) {
                server.tunnel_port = Some(port);
                state.store.save(&server).map_err(err)?;
            }
            format!("http://127.0.0.1:{port}")
        }
    };
    let path = path.filter(|p| p.starts_with('/') && !p.starts_with("//")).unwrap_or_else(|| "/".into());
    let url: tauri::Url = format!("{base}{path}").parse().map_err(|e| format!("{e}"))?;
    let label = panel_label(&id);
    if let Some(window) = app.get_webview_window(&label) {
        window.navigate(url).map_err(|e| e.to_string())?;
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let browser_app = app.clone();
    let navigation_app = app.clone();
    let panel_url = url.clone();
    WebviewWindowBuilder::new(&app, label, WebviewUrl::External(url))
        .title(format!("ClawDesk — {}", server.name))
        .inner_size(1280.0, 820.0)
        .min_inner_size(420.0, 520.0)
        .on_navigation(move |target| {
            if is_panel_navigation(&panel_url, target) {
                return true;
            }
            open_browser(&navigation_app, target);
            false
        })
        .on_new_window(move |url, _features| {
            // OAuth must use the system browser; remote panel pages get no shell access.
            open_browser(&browser_app, &url);
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn ensure_tunnel(state: &AppState, server: &Server) -> anyhow::Result<u16> {
    let mut tunnels = state.tunnels.lock().await;
    let key = || servers::load_key(&server.id);
    if let Some(t) = tunnels.get(&server.id) {
        if t.is_alive() {
            if t.session_closed().await {
                let session = ssh::connect(&server.host, server.port, &server.user, &Auth::Key(key()?), Some(&server.host_key)).await?;
                t.replace_session(session).await;
            }
            return Ok(t.local_port);
        }
    }
    let session = ssh::connect(&server.host, server.port, &server.user, &Auth::Key(key()?), Some(&server.host_key)).await?;
    let t = tunnel::start(session, server.tunnel_port).await?;
    let port = t.local_port;
    tunnels.insert(server.id.clone(), t);
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_routes_and_oauth_callbacks_stay_in_panel() {
        let panel = tauri::Url::parse("http://127.0.0.1:18080/").unwrap();
        for path in ["sources", "api/sources/notion/callback?code=example&state=example"] {
            assert!(is_panel_navigation(&panel, &panel.join(path).unwrap()));
        }
    }

    #[test]
    fn external_login_and_other_local_apps_leave_panel() {
        let panel = tauri::Url::parse("http://127.0.0.1:18080/").unwrap();
        for target in ["https://www.notion.so/login", "https://accounts.google.com/", "http://127.0.0.1:18081/", "file:///C:/example.html", "about:blank"] {
            assert!(!is_panel_navigation(&panel, &tauri::Url::parse(target).unwrap()));
        }
    }

    #[test]
    fn similar_hostnames_are_not_the_panel() {
        let panel = tauri::Url::parse("https://panel.example.com/").unwrap();
        for target in ["https://panel.example.com.attacker.test/", "https://panel.example.com@attacker.test/", "http://panel.example.com/", "https://panel.example.com:8443/"] {
            assert!(!is_panel_navigation(&panel, &tauri::Url::parse(target).unwrap()));
        }
        assert!(is_panel_navigation(&panel, &panel.join("sources").unwrap()));
    }
}
