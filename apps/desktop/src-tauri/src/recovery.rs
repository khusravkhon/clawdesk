//! Local recovery never discovers a target by a shared Docker name prefix. It uses
//! the install's compose file and a receipt bound to its displayed identity.
use crate::local;
use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;

#[derive(Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    pub project: String,
    pub data_dir: String,
    pub address: String,
    pub version: Option<String>,
    pub running: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub receipt: String,
    pub target: LocalStatus,
    pub manifest: serde_json::Value,
}

pub struct Receipt {
    pub id: String,
    pub target: LocalStatus,
    pub archive: PathBuf,
}

fn root(app: &AppHandle) -> Result<PathBuf> { Ok(app.path().app_local_data_dir()?.join("server")) }

fn settings(app: &AppHandle) -> Result<(PathBuf, LocalStatus)> {
    let dir = root(app)?;
    let text = std::fs::read_to_string(dir.join("deploy/.env")).context("Local installation settings are unavailable. Install or update this computer first.")?;
    parse_settings(dir, &text)
}

fn parse_settings(dir: PathBuf, text: &str) -> Result<(PathBuf, LocalStatus)> {
    for key in ["COMPOSE_PROJECT_NAME", "CLAWDESK_DATA_DIR", "PANEL_PORT", "CLAWDESK_FILES_DIR", "CLAWDESK_VERSION"] {
        if text.lines().filter(|line| line.starts_with(&format!("{key}="))).count() > 1 {
            bail!("Ambiguous duplicate local setting {key}. Resolve it before opening or restoring this installation.");
        }
    }
    let get = |key: &str, default: &str| text.lines().find_map(|line| line.strip_prefix(&format!("{key}="))).unwrap_or(default).to_string();
    let project = get("COMPOSE_PROJECT_NAME", "clawdesk-local");
    // A verify/development stack must never be presented as the person's local install.
    if project != "clawdesk-local" { bail!("This is not the personal clawdesk-local installation (project: {project})."); }
    let port: u16 = get("PANEL_PORT", "18080").parse().context("Invalid local panel port")?;
    if port != local::LOCAL_PORT { bail!("Unexpected personal panel port. Recovery is blocked to protect other installations."); }
    let data_dir = get("CLAWDESK_DATA_DIR", "/var/lib/clawdesk-local");
    if data_dir != "/var/lib/clawdesk-local" { bail!("Unexpected personal data directory. Recovery is blocked to protect other installations."); }
    Ok((dir, LocalStatus { project, data_dir, address: format!("http://127.0.0.1:{port}"), version: None, running: false }))
}

pub async fn status(app: &AppHandle) -> Result<LocalStatus> {
    let (_, mut state) = settings(app)?;
    let output = local::command("docker").args(["ps", "--filter", "label=com.docker.compose.project=clawdesk-local", "--filter", "label=com.docker.compose.service=gateway", "--format", "{{.ID}}"])
        .output().await;
    if let Ok(output) = output {
        if output.status.success() {
            let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !id.is_empty() && !id.contains('\n') {
                let ports = local::command("docker").args(["port", &id, "8080/tcp"]).output().await?;
                let expected = format!("127.0.0.1:{}", local::LOCAL_PORT);
                let bound = String::from_utf8_lossy(&ports.stdout);
                if !ports.status.success() || !bound.lines().any(|line| line.trim() == expected) {
                    bail!("The personal Gateway does not own the expected local panel address. Check Docker port conflicts before opening or restoring.");
                }
                state.running = true;
                if let Ok(version) = local::command("docker").args(["exec", &id, "node", "-p", "require('/app/package.json').version"]).output().await {
                    if version.status.success() { state.version = Some(String::from_utf8_lossy(&version.stdout).trim().to_string()); }
                }
            }
        }
    }
    Ok(state)
}

async fn script(app: &AppHandle, archive: &PathBuf, password: &str, inspect: bool, project: &str) -> Result<serde_json::Value> {
    if password.contains(['\r', '\n']) { bail!("Backup password must be a single line"); }
    let docker = local::command("docker").arg("info").stdout(Stdio::null()).stderr(Stdio::null()).status().await;
    if !matches!(docker, Ok(status) if status.success()) {
        bail!("Docker Desktop не готов. Запустите Docker Desktop, дождитесь готовности и повторите проверку. Данные приложения не изменялись.");
    }
    let (dir, _) = settings(app)?;
    let bash = local::find_bash()?;
    let mut command = local::command(bash);
    command.arg("deploy/scripts/restore.sh");
    command.arg(if inspect { "--inspect" } else { "--yes" });
    command.args(["--target", project, "--target-data", "/var/lib/clawdesk-local"]).arg(archive).current_dir(dir)
        .env("BACKUP_PASSWORD_STDIN", "1")
        .env_remove("BACKUP_PASSWORD")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for key in ["COMPOSE_PROJECT_NAME", "CLAWDESK_DATA_DIR", "CLAWDESK_FILES_DIR", "PANEL_PORT", "CLAWDESK_VERSION", "OPENCLAW_VERSION", "PANEL_BIND"] { command.env_remove(key); }
    let mut child = command.spawn().context("Could not start local recovery")?;
    let mut input = child.stdin.take().context("Recovery input unavailable")?;
    input.write_all(password.as_bytes()).await?;
    input.write_all(b"\n").await?;
    drop(input);
    let output = child.wait_with_output().await?;
    if !output.status.success() {
        if output.status.code() == Some(75) {
            bail!("Recovery rollback is incomplete. The selected installation remains stopped. Preserve its .restore-rollback folders and backup staging copy for manual recovery before starting it again.");
        }
        // Raw restore output can contain archive content or tool diagnostics. Keep it out
        // of the launcher: the exact failing phase is safe, archive contents are not.
        if inspect {
            bail!("Проверка архива не пройдена. Проверьте пароль скачанной копии и совместимость версии OpenClaw. Восстановление не запускалось, данные приложения не изменялись.");
        }
        bail!("Восстановление не завершено. Не сбрасывайте установку повторно: сохраните архив и проверьте состояние Gateway и зависимости плагинов. Если ошибка произошла после подтверждения, данные уже могли быть заменены.");
    }
    if inspect { serde_json::from_slice(&output.stdout).context("Invalid recovery inspection response") }
    else { Ok(serde_json::json!({"restored": true})) }
}

pub async fn inspect(app: &AppHandle, archive: String, password: String) -> Result<(Inspection, Receipt)> {
    let target = status(app).await?;
    let source = std::fs::canonicalize(&archive).context("Backup file does not exist")?;
    if !source.is_file() || std::fs::symlink_metadata(&archive)?.file_type().is_symlink() { bail!("Choose an ordinary backup file, not a link"); }
    let id = uuid::Uuid::new_v4().to_string();
    let staged = app.path().app_cache_dir()?.join(format!("recovery-{id}.tar"));
    std::fs::create_dir_all(staged.parent().unwrap())?;
    std::fs::copy(source, &staged).context("Could not stage backup for inspection")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o600))?;
    }
    match script(app, &staged, &password, true, &target.project).await {
        Ok(manifest) => Ok((Inspection { receipt: id.clone(), target: target.clone(), manifest }, Receipt { id, target, archive: staged })),
        Err(error) => { let _ = std::fs::remove_file(staged); Err(error) }
    }
}

pub async fn restore(app: &AppHandle, receipt: Receipt, confirmation: String, password: String) -> Result<()> {
    let result = async {
        let (_, current) = settings(app)?;
        if current.project != receipt.target.project || current.data_dir != receipt.target.data_dir || current.address != receipt.target.address {
            bail!("Selected installation changed. Inspect the archive again.");
        }
        if confirmation != format!("RESTORE {}", current.project) { bail!("Confirmation does not match the selected installation"); }
        script(app, &receipt.archive, &password, false, &current.project).await?;
        Ok(())
    }.await;
    let _ = std::fs::remove_file(receipt.archive);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn personal_identity_is_unambiguous_and_excludes_verify() {
        let parse = |text| parse_settings(PathBuf::from("fixture"), text);
        assert!(parse("COMPOSE_PROJECT_NAME=clawdesk-local\nCLAWDESK_DATA_DIR=/var/lib/clawdesk-local\nPANEL_PORT=18080\n").is_ok());
        assert!(parse("COMPOSE_PROJECT_NAME=clawdesk-verify\n").is_err());
        assert!(parse("CLAWDESK_DATA_DIR=/var/lib/clawdesk-verify\n").is_err());
        assert!(parse("PANEL_PORT=18081\n").is_err());
        assert!(parse("CLAWDESK_DATA_DIR=/var/lib/clawdesk-local\nCLAWDESK_DATA_DIR=/var/lib/other\n").is_err());
        assert!(parse("PANEL_PORT=18080\nPANEL_PORT=18081\n").is_err());
    }
}
