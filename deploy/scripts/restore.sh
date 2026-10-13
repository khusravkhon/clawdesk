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
if [[ "${1:-}" == "--yes" ]]; then YES=1; shift; fi
[[ $# -eq 1 ]] || { echo "usage: $0 [--yes] <backup .tar or .tar.enc>"; exit 1; }
[[ -f "$1" ]] || { echo "no such file: $1"; exit 1; }
[[ -f .env ]] || { echo "deploy/.env is missing: install ClawDesk first (deploy/install.sh), then restore."; exit 1; }

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
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
FILES_DIR="$(env_get CLAWDESK_FILES_DIR)"
COMPOSE=(docker compose -f docker-compose.yml)
[[ -n "$(env_get CLAWDESK_DOMAIN)" ]] && COMPOSE+=(--profile https)
GATEWAY_IMAGE="$("${COMPOSE[@]}" config --images | grep -m1 clawdesk-gateway)"
PANEL_IMAGE="$("${COMPOSE[@]}" config --images | grep -m1 clawdesk-panel)"
PROJECT="$("${COMPOSE[@]}" config --format json | sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' | head -1)"
PROJECT="${PROJECT:-clawdesk}"
SRC=(-v "$(host_path "$ARCHIVE_DIR"):/in:ro")
TAR="/in/$ARCHIVE_NAME"

step "Reading the backup"
if [[ "$(head -c 21 "$1")" == "CLAWDESK-BACKUP-ENC-1" ]]; then
  password="${BACKUP_PASSWORD:-}"
  [[ -n "$password" ]] || { password="$(ask -s -p "Password of this backup copy: ")"; echo; }
  [[ -n "$password" ]] || { echo "no password given"; exit 1; }
  # Decrypted next to the other backups (owner-only folder), removed at the end.
  docker run --rm --user 1000 -e BACKUP_PASSWORD="$password" "${SRC[@]}" -v "$DATA_DIR/backups:/out" --entrypoint node "$PANEL_IMAGE" \
    dist/cli/backup-decrypt.js "/in/$ARCHIVE_NAME" /out/.restore.tar
  unset password
  SRC=(-v "$DATA_DIR/backups:/in:ro")
  TAR="/in/.restore.tar"
fi
cleanup() { docker run --rm --user 0 -v "$DATA_DIR/backups:/b" --entrypoint rm "$GATEWAY_IMAGE" -f /b/.restore.tar >/dev/null 2>&1 || true; }
trap cleanup EXIT

manifest="$(docker run --rm "${SRC[@]}" --entrypoint tar "$GATEWAY_IMAGE" -xOf "$TAR" ./manifest.json)" \
  || { echo "This is not a ClawDesk backup (no manifest.json)."; exit 1; }
echo "$manifest" | grep -E '"(kind|createdAt|openclawVersion)"'

echo
echo "Everything in this install will be replaced with the backup: agents, chats, AI keys, Telegram,"
echo "Google, Notion, the panel password and the shared files folder. Backups stay."
[[ $YES == 1 || "$(ask -p 'Type RESTORE to continue: ')" == "RESTORE" ]] || { echo "cancelled"; exit 1; }

step "Stopping ClawDesk"
"${COMPOSE[@]}" stop
docker ps -aq --filter name=openclaw-sbx- | xargs -r docker rm -f >/dev/null

step "Replacing the data"
mounts=(-v "$STATE_DIR:$STATE_DIR")
# .env already has the folder the way Docker wants it (also on Docker Desktop).
[[ -n "$FILES_DIR" ]] && mounts+=(-v "$FILES_DIR:/restore/files")
for v in panel-data freellmapi-data openclaw-auth-secrets; do
  if docker volume inspect "${PROJECT}_$v" >/dev/null 2>&1; then mounts+=(-v "${PROJECT}_$v:/restore/$v"); fi
done
# Prints the backup's .env secrets as "ENV KEY=value" lines for this script; everything else is logged.
secrets="$(docker run --rm --user 0 --workdir /app "${SRC[@]}" "${mounts[@]}" -e STATE_DIR="$STATE_DIR" -e TAR="$TAR" --entrypoint sh "$GATEWAY_IMAGE" -c '
set -e
W=$(mktemp -d)
tar -xf "$TAR" -C "$W"
node dist/index.js backup restore "$W/openclaw.tar.gz" --target "$W/oc" --json >/dev/null
# The state folder inside the archive is the one with openclaw.json closest to the root.
SRC=$(find "$W/oc" -name openclaw.json -path "*/payload/posix/*" | awk "{ print length, \$0 }" | sort -n | head -1 | cut -d" " -f2-)
SRC=$(dirname "$SRC")
empty() { [ -d "$1" ] && find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf {} + ; true; }
empty "$STATE_DIR"
cp -a "$SRC/." "$STATE_DIR/"
if [ -d /restore/files ]; then
  empty /restore/files
  [ -d "$STATE_DIR/workspace/files" ] && cp -a "$STATE_DIR/workspace/files/." /restore/files/ && empty "$STATE_DIR/workspace/files"
fi
for pair in panel:panel-data freellmapi:freellmapi-data auth-secrets:openclaw-auth-secrets; do
  from="$W/${pair%%:*}"; to="/restore/${pair#*:}"
  [ -d "$to" ] || continue
  empty "$to"
  [ -d "$from" ] && cp -a "$from/." "$to/"
done
chown -R 1000:1000 "$STATE_DIR" /restore 2>/dev/null || true
sed "s/^/ENV /" "$W/env"
rm -rf "$W"
')"

while IFS= read -r line; do
  [[ "$line" == ENV\ *=* ]] || continue
  kv="${line#ENV }"
  env_set "${kv%%=*}" "${kv#*=}"
done <<< "$secrets"
echo "restored the secrets the data is encrypted with into deploy/.env"

step "Starting ClawDesk"
"${COMPOSE[@]}" up -d
echo
echo "Restored. Sign in with the panel password from the time of the backup."
echo "AI providers installed as plugins (DeepSeek, Qwen, Kimi…) may need to be connected again in the panel."
