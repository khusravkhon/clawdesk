//! ClawDesk desktop: a launcher (servers, install over SSH, "this computer") and the panel of each server in its own window.
//! Agents never run in this app — they live on the server (or in Docker Desktop for "this computer"); it reaches them through
//! HTTPS or an SSH tunnel, keeps SSH keys in the system keychain, and sits in the tray.

mod commands;
mod install;
mod local;
mod recovery;
mod servers;
mod ssh;
mod tunnel;

use commands::AppState;
use std::collections::HashMap;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};

fn show_launcher(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            app.manage(AppState { store: servers::Store::new(config_dir), tunnels: tokio::sync::Mutex::new(HashMap::new()), recovery: tokio::sync::Mutex::new(None) });

            // Tray: tunnels and panel windows keep working while the launcher is hidden.
            let open = MenuItem::with_id(app, "open", "ClawDesk", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit / Выход", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("ClawDesk")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_launcher(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_launcher(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the launcher hides it to the tray; "Quit" in the tray ends the app.
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_servers,
            commands::add_server,
            commands::remove_server,
            commands::open_panel,
            commands::install_server,
            commands::install_local,
            commands::local_status,
            commands::inspect_local_backup,
            commands::restore_local
        ])
        .run(tauri::generate_context!())
        .expect("error while running ClawDesk");
}
