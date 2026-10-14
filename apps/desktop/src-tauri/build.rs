fn main() {
    // App commands get permissions of their own, so only the launcher window may call them
    // (capabilities/launcher.json); panel windows loaded from a server cannot.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "list_servers",
        "add_server",
        "remove_server",
        "open_panel",
        "install_server",
        "install_local",
    ])))
    .expect("failed to run tauri-build");
}
