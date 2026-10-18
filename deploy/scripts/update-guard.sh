# shellcheck shell=bash
# Update safety for init.sh (sourced, not run). When init.sh runs over an install that is already up —
# install.sh re-run on a server, the desktop app's "Update" for this computer — it:
#   1. makes a backup with the running (old) version, kind "before-update" (System → Backups);
#   2. keeps the images that run now under clawdesk-rollback/<service>:<project> and the .env they ran with;
#   3. after the new version starts, waits for the Gateway health check and for the panel to reach it;
#   4. if that fails (or any step of the update fails), puts the previous images and .env back and starts
#      them again. Data written by the new version stays; if even the previous version cannot start on it,
#      the log names the backup to restore with deploy/scripts/restore.sh.
# Expects init.sh's COMPOSE array, env_get and step, and to run in deploy/.
#
#   CLAWDESK_UPDATE_SKIP_BACKUP=1   update even if the backup cannot be made (not recommended)

GUARD=0
GUARD_DONE=0
GUARD_BACKUP=""
GUARD_STATE=".update-rollback"
GUARD_ENV=".env.before-update"

guard_warn() { printf '\033[33m%s\033[0m\n' "$*"; }

# Is this an update of a running install? Call before .env changes.
guard_detect() {
  [[ -f .env ]] || return 0
  local gateway
  gateway="$("${COMPOSE[@]}" ps -q gateway 2>/dev/null || true)"
  [[ -n "$gateway" ]] || return 0
  [[ "$(docker inspect -f '{{.State.Running}}' "$gateway" 2>/dev/null)" == true ]] || return 0
  GUARD=1
}

# Backup with the running version. Very old images have no backup module: then the update goes on without one.
guard_backup() {
  local script out code
  script='let m;
try { m = await import("/usr/local/lib/clawdesk-backup.mjs"); } catch { process.exit(3); }
let r;
try { r = await m.createBackup("before-update"); }
catch (e) { if (e.code !== "invalid_kind") throw e; r = await m.createBackup("manual"); }
console.log(`backup: ${r.name}`);'
  set +e
  out="$("${COMPOSE[@]}" exec -T gateway node --input-type=module -e "$script" 2>&1)"
  code=$?
  set -e
  if [[ $code == 0 ]]; then
    GUARD_BACKUP="$(printf '%s\n' "$out" | sed -n 's/^backup: //p' | tail -1)"
    echo "backup: $GUARD_BACKUP"
  elif [[ $code == 3 ]]; then
    guard_warn "This version cannot make backups yet; updating without one."
  elif [[ "${CLAWDESK_UPDATE_SKIP_BACKUP:-}" == 1 ]]; then
    guard_warn "The backup failed; updating anyway (CLAWDESK_UPDATE_SKIP_BACKUP=1)."
    printf '%s\n' "$out" | tail -5
  else
    printf '%s\n' "$out" | tail -5
    echo "The backup before the update failed, so nothing was changed. Fix the cause (often: disk full) and run the update again."
    echo "To update without a backup: CLAWDESK_UPDATE_SKIP_BACKUP=1"
    GUARD=0
    exit 1
  fi
}

# Keeps the running images and .env, so a failed update can go back to them.
guard_snapshot() {
  local service container project image ref
  : > "$GUARD_STATE"
  cp .env "$GUARD_ENV"
  for service in gateway panel; do
    container="$("${COMPOSE[@]}" ps -q "$service" 2>/dev/null || true)"
    [[ -n "$container" ]] || continue
    project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$container")"
    image="$(docker inspect -f '{{.Image}}' "$container")"
    ref="$(docker inspect -f '{{.Config.Image}}' "$container")"
    docker tag "$image" "clawdesk-rollback/$service:$project"
    printf '%s %s\n' "clawdesk-rollback/$service:$project" "$ref" >> "$GUARD_STATE"
  done
  if docker image inspect openclaw-sandbox:bookworm-slim >/dev/null 2>&1; then
    docker tag openclaw-sandbox:bookworm-slim "clawdesk-rollback/sandbox:${project:-clawdesk}"
    printf '%s %s\n' "clawdesk-rollback/sandbox:${project:-clawdesk}" openclaw-sandbox:bookworm-slim >> "$GUARD_STATE"
  fi
  echo "previous images kept: $(cut -d' ' -f2 "$GUARD_STATE" | tr '\n' ' ')"
}

# The Gateway passes its health check and the panel is connected to it. Up to ~6 minutes.
guard_healthy() {
  local probe gateway state
  probe='fetch("http://127.0.0.1:8080/api/health").then((r) => r.json()).then((h) => process.exit(h.ok && h.gateway.state === "connected" ? 0 : 1), () => process.exit(1))'
  for _ in $(seq 1 72); do
    gateway="$("${COMPOSE[@]}" ps -q gateway 2>/dev/null || true)"
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$gateway" 2>/dev/null || true)"
    [[ "$state" == unhealthy ]] && return 1
    if [[ "$state" == healthy ]] && "${COMPOSE[@]}" exec -T panel node -e "$probe" >/dev/null 2>&1; then return 0; fi
    sleep 5
  done
  return 1
}

guard_cleanup() {
  local tag
  if [[ -f "$GUARD_STATE" ]]; then
    while read -r tag _; do docker rmi "$tag" >/dev/null 2>&1 || true; done < "$GUARD_STATE"
  fi
  rm -f "$GUARD_STATE" "$GUARD_ENV"
}

# init.sh calls this once the new version is up.
guard_verify() {
  [[ $GUARD == 1 ]] || return 0
  step "Checking the updated ClawDesk"
  if ! guard_healthy; then
    guard_warn "The updated version did not become healthy."
    exit 1
  fi
  GUARD_DONE=1
  guard_cleanup
  echo "update healthy${GUARD_BACKUP:+; backup before it: $GUARD_BACKUP}"
}

# EXIT trap: any failure after the snapshot puts the previous version back.
guard_on_exit() {
  local status=$?
  [[ $GUARD == 1 && $GUARD_DONE == 0 && -f "$GUARD_STATE" ]] || return 0
  set +e
  step "Update failed: going back to the previous version"
  local tag ref data_dir
  cp "$GUARD_ENV" .env
  while read -r tag ref; do docker tag "$tag" "$ref"; done < "$GUARD_STATE"
  data_dir="$(env_get CLAWDESK_DATA_DIR)"
  if "${COMPOSE[@]}" up -d --no-build --pull never && guard_healthy; then
    guard_cleanup
    echo "ClawDesk is running the previous version again. Nothing was lost${GUARD_BACKUP:+; backup before the update: $GUARD_BACKUP}."
  else
    guard_warn "The previous version does not start either."
    [[ -n "$GUARD_BACKUP" ]] && echo "Restore the backup made before the update: sudo bash deploy/scripts/restore.sh ${data_dir:-/var/lib/clawdesk}/backups/$GUARD_BACKUP"
    echo "The previous images are kept as: $(cut -d' ' -f1 "$GUARD_STATE" | tr '\n' ' ')"
  fi
  exit "$((status == 0 ? 1 : status))"
}
