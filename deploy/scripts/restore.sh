#!/usr/bin/env bash
# Restores a ClawDesk backup made by the panel (System → Backups) over the current install.
#
#   sudo bash deploy/scripts/restore.sh /var/lib/clawdesk/backups/clawdesk-…-daily.tar
#   sudo bash deploy/scripts/restore.sh ~/clawdesk-…-daily.tar.enc      # downloaded copy: asks its password
#
# Unattended (scripts, the desktop installer): --yes skips the confirmation, BACKUP_PASSWORD gives the
# downloaded copy's password.
#
# Everything the install has now is replaced: agents, chats, keys, connections, panel password, the
# shared files folder. Backups stay. The stack is stopped while files are swapped, then started.
# File work happens inside containers, so this runs the same on a Linux server and on Docker Desktop.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DEPLOY_DIR"
export MSYS_NO_PATHCONV=1

YES=0
INSPECT=0
EXPECTED_PROJECT=""
EXPECTED_DATA=""
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --yes) YES=1; shift ;;
    --inspect) INSPECT=1; shift ;;
    --target) EXPECTED_PROJECT="${2:-}"; shift 2 ;;
    --target-data) EXPECTED_DATA="${2:-}"; shift 2 ;;
    *) echo "unknown option"; exit 1 ;;
  esac
done
[[ $# -eq 1 ]] || { echo "usage: $0 [--inspect | --yes] [--target project] [--target-data directory] <backup .tar or .tar.enc>"; exit 1; }
[[ -f "$1" ]] || { echo "no such file: $1"; exit 1; }
[[ -f .env ]] || { echo "deploy/.env is missing: install ClawDesk first (deploy/install.sh), then restore."; exit 1; }

step() { [[ $INSPECT == 1 ]] || printf '\n\033[1m==> %s\033[0m\n' "$*"; }
env_get() { { grep -E "^$1=" .env || true; } | tail -1 | cut -d= -f2-; }
env_set() {
  if grep -qE "^$1=" .env; then sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak
  else echo "$1=$2" >> .env; fi
}
host_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
ask() { local a=""; if [[ -r /dev/tty ]]; then read -r "$@" a < /dev/tty || true; fi; printf '%s' "$a"; }

ARCHIVE_DIR="$(cd "$(dirname "$1")" && pwd)"
ARCHIVE_NAME="$(basename "$1")"
DATA_DIR="$(env_get CLAWDESK_DATA_DIR)"; DATA_DIR="${DATA_DIR:-/var/lib/clawdesk}"
STATE_DIR="$DATA_DIR/openclaw"
[[ -z "$EXPECTED_DATA" || "$DATA_DIR" == "$EXPECTED_DATA" ]] || { echo "Selected data directory changed; inspect it again."; exit 1; }
FILES_DIR="$(env_get CLAWDESK_FILES_DIR)"
COMPOSE=(docker compose -f docker-compose.yml)
[[ -n "$(env_get CLAWDESK_DOMAIN)" ]] && COMPOSE+=(--profile https)
GATEWAY_IMAGE="$("${COMPOSE[@]}" config --images | grep clawdesk-gateway | tail -1)"
PANEL_IMAGE="$("${COMPOSE[@]}" config --images | grep clawdesk-panel | tail -1)"
PROJECT="$("${COMPOSE[@]}" config --format json | sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' | awk 'NR==1')"
PROJECT="${PROJECT:-clawdesk}"
[[ -z "$EXPECTED_PROJECT" || "$EXPECTED_PROJECT" == "$PROJECT" ]] || { echo "Selected installation changed; inspect it again."; exit 1; }
[[ "$DATA_DIR" == /* && "$DATA_DIR" != / && "$DATA_DIR" != /var && "$DATA_DIR" != /var/lib ]] || { echo "Unsafe installation data directory"; exit 1; }
SRC=(-v "$(host_path "$ARCHIVE_DIR"):/in:ro")
TAR="/in/$ARCHIVE_NAME"
RESTORE_COPY=".restore-$$-$RANDOM.tar"
RESTORE_STAGE=".restore-stage-$$-$RANDOM"
SAFE=(-v "$(host_path "$DEPLOY_DIR/scripts/restore-safe.mjs"):/restore-safe.mjs:ro")
STOPPED=0
cleanup() {
  # Validation/copy errors after stop must not leave the selected stack stopped.
  if [[ $STOPPED == 1 ]]; then "${COMPOSE[@]}" up -d >/dev/null 2>&1 || true; fi
  if [[ $STOPPED == 2 ]]; then echo "Recovery did not finish safely. Selected stack remains stopped. Keep .restore-rollback folders and the restore staging copy for recovery." >&2; return; fi
  docker run --rm --network none --user 0 -v "$DATA_DIR/backups:/b" --entrypoint sh "$GATEWAY_IMAGE" -c 'rm -f "$1"; rm -rf "$2"' sh "/b/$RESTORE_COPY" "/b/$RESTORE_STAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step "Reading the backup"
encrypted_magic=$'CLAWDESK-BACKUP-ENC-1\n'
if cmp -s -n "${#encrypted_magic}" "$1" <(printf '%s' "$encrypted_magic"); then
  password="${BACKUP_PASSWORD:-}"
  if [[ "${BACKUP_PASSWORD_STDIN:-}" == 1 ]]; then IFS= read -r password || true; fi
  [[ -n "$password" ]] || { password="$(ask -s -p "Password of this backup copy: ")"; echo; }
  [[ -n "$password" ]] || { echo "no password given"; exit 1; }
  # Decrypted next to the other backups (owner-only folder), removed at the end.
  printf '%s' "$password" | docker run --rm --network none -i --user 1000 "${SRC[@]}" -v "$DATA_DIR/backups:/out" --entrypoint node "$PANEL_IMAGE" \
    --input-type=module -e 'import {decryptFile} from "/app/dist/backups/backup-crypto.js"; let password=""; for await (const chunk of process.stdin) password+=chunk; try { await decryptFile(process.argv[1],process.argv[2],password); } catch (e) { console.error(e?.code === "EACCES" ? "Cannot read the backup file: move it to a folder everyone can read (e.g. /opt) and chmod 644 it" : "Wrong password or damaged backup"); process.exitCode=1; }' "/in/$ARCHIVE_NAME" "/out/$RESTORE_COPY"
  unset password
  SRC=(-v "$DATA_DIR/backups:/in:ro")
  TAR="/in/$RESTORE_COPY"
fi

VERSION="$(docker run --rm --network none --entrypoint node "$GATEWAY_IMAGE" -p 'require("/app/package.json").version')"
manifest="$(docker run --rm --network none --user 0 "${SRC[@]}" "${SAFE[@]}" -v "$DATA_DIR/backups:/restore-stage" --entrypoint node "$GATEWAY_IMAGE" /restore-safe.mjs prepare "$TAR" "$VERSION" "/restore-stage/$RESTORE_STAGE")" \
  || { echo "Backup validation failed; existing data was not changed."; exit 1; }
if [[ $INSPECT == 1 ]]; then printf '%s\n' "$manifest"; exit 0; fi
[[ -n "$FILES_DIR" ]] || { echo "Shared files mount missing; refusing partial recovery."; exit 1; }
for v in panel-data freellmapi-data openclaw-auth-secrets; do
  docker volume inspect "${PROJECT}_$v" >/dev/null 2>&1 || { echo "Selected installation volume $v missing; refusing partial recovery."; exit 1; }
done
OWNERSHIP_ROOTS=()
gateway_id="$("${COMPOSE[@]}" ps -a -q gateway)"
[[ -n "$gateway_id" ]] || { echo "Selected Gateway container missing; ownership cannot be verified."; exit 1; }
mount_rows="$(docker inspect -f '{{range .Mounts}}{{printf "%s\t%s\n" .Destination .Source}}{{end}}' "$gateway_id")"
while IFS=$'\t' read -r destination source; do
  if [[ "$destination" == "$STATE_DIR" || "$destination" == "$STATE_DIR/workspace/files" ]]; then
    [[ -n "$source" && "$source" != / ]] && OWNERSHIP_ROOTS+=("${source%/}")
  fi
done <<< "$mount_rows"
[[ ${#OWNERSHIP_ROOTS[@]} -gt 0 ]] || { echo "Selected Gateway state mount missing; refusing recovery."; exit 1; }
echo "$manifest" | grep -E '"(kind|createdAt|openclawVersion)"'

echo
echo "Everything in this install will be replaced with the backup: agents, chats, AI keys, Telegram,"
echo "Google, Notion, the panel password and the shared files folder. Backups stay."
echo "Selected compose project: $PROJECT; data: $DATA_DIR"
[[ $YES == 1 || "$(ask -p 'Type RESTORE to continue: ')" == "RESTORE" ]] || { echo "cancelled"; exit 1; }

step "Stopping ClawDesk"
"${COMPOSE[@]}" stop
STOPPED=1
# Sandboxes are not removed by name: that prefix is shared by unrelated installations.
# Stop only sandboxes whose mount source proves ownership by this state directory.
sandbox_ids="$(docker ps -q --filter name=openclaw-sbx-)"
while IFS= read -r sandbox; do
  [[ -n "$sandbox" ]] || continue
  sources="$(docker inspect -f '{{range .Mounts}}{{println .Source}}{{end}}' "$sandbox")"
  while IFS= read -r source; do
    owned=0
    for root in "${OWNERSHIP_ROOTS[@]}"; do
      if [[ "$source" == "$root" || "$source" == "$root/"* ]]; then owned=1; break; fi
    done
    if [[ $owned == 1 ]]; then docker stop "$sandbox" >/dev/null || exit 1; break; fi
  done <<< "$sources"
done <<< "$sandbox_ids"

step "Replacing the data"
mounts=(-v "$STATE_DIR:$STATE_DIR")
# .env already has the folder the way Docker wants it (also on Docker Desktop).
[[ -n "$FILES_DIR" ]] && mounts+=(-v "$FILES_DIR:/restore/files")
for v in panel-data freellmapi-data openclaw-auth-secrets; do
  if docker volume inspect "${PROJECT}_$v" >/dev/null 2>&1; then mounts+=(-v "${PROJECT}_$v:/restore/$v"); fi
done
# Prints the backup's .env secrets as "ENV KEY=value" lines for this script; everything else is logged.
STOPPED=2
secrets="$(docker run --rm --network none --user 0 --workdir /app "${SAFE[@]}" "${mounts[@]}" -v "$DATA_DIR/backups:/restore-stage" -e STATE_DIR="$STATE_DIR" -e RESTORE_STAGE="$RESTORE_STAGE" --entrypoint sh "$GATEWAY_IMAGE" -c '
set -e
W="/restore-stage/$RESTORE_STAGE"
# The state folder inside the archive is the one with openclaw.json closest to the root.
node --input-type=module -e '\''import fs from "node:fs/promises"; import path from "node:path"; import {applyPayload} from "/restore-safe.mjs";
const root=process.argv[1], source=(await fs.readFile(path.join(root,"prepared-state.txt"),"utf8")).trim();
if(!source.startsWith(root+"/oc/") || !(await fs.stat(path.join(source,"openclaw.json"))).isFile()) throw new Error("prepared restore missing");
const exists=async p=>Boolean(await fs.stat(p).catch(()=>null));
const files=path.join(source,"workspace/files"), empty=path.join(root,"empty"); await fs.mkdir(empty,{recursive:true});
const pairs=[[source,process.env.STATE_DIR],[await exists(files)?files:empty,"/restore/files"]];
if(await exists(files)) { const saved=path.join(root,"shared-files"); await fs.rename(files,saved); pairs[1][0]=saved; await fs.mkdir(files); }
for(const [from,to] of [["panel","panel-data"],["freellmapi","freellmapi-data"],["auth-secrets","openclaw-auth-secrets"]]) pairs.push([await exists(path.join(root,from))?path.join(root,from):empty,"/restore/"+to]);
try { await applyPayload(pairs,process.env.RESTORE_STAGE.replaceAll(".","")); } catch(error) { console.error(error.code === "restore_rolled_back" ? "Restore failed and original data was retained" : "Restore needs manual recovery; keep rollback directories"); process.exit(error.code === "restore_rolled_back" ? 76 : 75); }'\'' "$W"
chown -R 1000:1000 "$STATE_DIR" /restore 2>/dev/null || true
sed "s/^/ENV /" "$W/env"
')" || { restore_status=$?; if [[ $restore_status == 76 ]]; then STOPPED=1; fi; exit "$restore_status"; }

while IFS= read -r line; do
  [[ "$line" == ENV\ *=* ]] || continue
  kv="${line#ENV }"
  env_set "${kv%%=*}" "${kv#*=}"
done <<< "$secrets"
echo "restored the secrets the data is encrypted with into deploy/.env"

step "Restoring approved plugin dependencies"
# Portable OpenClaw backups omit node_modules and managed tool binaries. Hydrate them before health checks.
"${COMPOSE[@]}" run -T --rm --no-deps --entrypoint node gateway /usr/local/lib/clawdesk-plugin-repair.mjs

step "Starting ClawDesk"
"${COMPOSE[@]}" up -d
STOPPED=0
echo
echo "Restored. Sign in with the panel password from the time of the backup."
echo "Approved plugin dependencies were checked before startup. External services may still require sign-in if their tokens expired."
