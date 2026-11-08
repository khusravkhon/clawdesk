# shellcheck shell=bash
# Which OpenClaw an install runs (sourced by init.sh; no Node on the host).
#
# deploy/openclaw.version is the version a NEW install gets. deploy/openclaw.supported lists every version this
# code has verified and can build. An existing install keeps the OpenClaw line it runs: an update of ClawDesk
# moves it to the newest verified patch of that line, never to another line by itself. A newer line is the
# owner's choice in the panel (System → OpenClaw, deploy/clawdesk-openclaw-update.mjs).
# Only when this code no longer supports the install's line does it move up — never down to an older line.

openclaw_line() { printf '%s\n' "$1" | cut -d. -f1-2; }

# newest version in $1 (newline-separated) or nothing
openclaw_newest() { printf '%s\n' "$1" | sed '/^$/d' | sort -V | tail -1; }

# openclaw_choose <installed or empty> <default> <supported file>
# Prints the version to run. Exit 2: the install runs a newer OpenClaw than anything this code knows.
openclaw_choose() {
  local installed="$1" default="$2" file="$3" supported line same above lowest
  supported="$(sed 's/#.*//; s/[[:space:]]//g; /^$/d' "$file")"
  if [[ -z "$installed" ]]; then printf '%s\n' "$default"; return 0; fi
  line="$(openclaw_line "$installed")"
  same="$(openclaw_newest "$(printf '%s\n' "$supported" | grep -F "$line." | grep -E "^${line//./\\.}\.[0-9]+$" || true)")"
  if [[ -n "$same" ]]; then printf '%s\n' "$same"; return 0; fi
  # The install's line is not supported any more: the default if it is newer, else the oldest newer line.
  above="$(printf '%s\n' "$supported" | while read -r v; do
    [[ "$(printf '%s\n%s\n' "$installed" "$v" | sort -V | tail -1)" == "$v" && "$v" != "$installed" ]] && printf '%s\n' "$v"
  done)"
  [[ -n "$above" ]] || return 2
  if printf '%s\n' "$above" | grep -qxF "$default"; then printf '%s\n' "$default"; return 0; fi
  lowest="$(openclaw_line "$(printf '%s\n' "$above" | sort -V | head -1)")"
  openclaw_newest "$(printf '%s\n' "$above" | grep -E "^${lowest//./\\.}\.[0-9]+$")"
}

# The OpenClaw the install runs now: the label of the Gateway's image, else what .env says (older images).
# Expects init.sh's COMPOSE array and env_get.
openclaw_installed() {
  local id image v=""
  id="$("${COMPOSE[@]}" ps -a -q gateway 2>/dev/null | head -1 || true)"
  if [[ -n "$id" ]]; then
    image="$(docker inspect -f '{{.Image}}' "$id" 2>/dev/null || true)"
    [[ -n "$image" ]] && v="$(docker image inspect -f '{{index .Config.Labels "org.clawdesk.openclaw-version"}}' "$image" 2>/dev/null || true)"
  fi
  [[ "$v" =~ ^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,4}$ ]] || v="$(env_get OPENCLAW_VERSION)"
  printf '%s' "$v"
}

# The data decides too. OpenClaw refuses to start on state that a newer OpenClaw wrote last (so as not to damage
# it); without this check the person only sees a Gateway that never becomes healthy. openclaw.json keeps the
# version that last wrote it in meta.lastTouchedVersion.
openclaw_config_version() { # openclaw.json text on stdin → the version that wrote it last, or nothing
  grep -oE '"lastTouchedVersion"[[:space:]]*:[[:space:]]*"[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,4}"' | grep -oE '[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,4}' | head -1 || true
}

openclaw_newer() { # $1 newer than $2?
  [[ "$1" != "$2" && "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" == "$1" ]]
}

openclaw_data_version() { # $1 data folder; read through Docker (on Docker Desktop it lives in Docker's VM)
  # --mount fails on a missing folder instead of creating it: a new install has no data, so no version.
  docker run --rm --mount "type=bind,src=$1,dst=/d,readonly" debian:bookworm-slim cat /d/openclaw/openclaw.json 2>/dev/null | openclaw_config_version
}

# Moves a newer install's data aside, nothing deleted: $1/openclaw and the copies of the compose volumes go to
# $1/saved-<time>; the volumes are then removed so the install starts empty. Backups stay where they are.
openclaw_set_aside() { # $1 data folder, $2 compose project
  local dir="$1" project="$2" saved v
  local mounts=() names=()
  saved="$dir/saved-$(date -u +%Y%m%dT%H%M%SZ)"
  docker compose -p "$project" -f docker-compose.yml down >/dev/null 2>&1 || true # containers hold the volumes
  for v in panel-data freellmapi-data openclaw-auth-secrets; do
    if docker volume inspect "${project}_$v" >/dev/null 2>&1; then mounts+=(-v "${project}_$v:/v/$v"); names+=("$v"); fi
  done
  docker run --rm --user 0 -v "$dir:$dir" ${mounts[@]+"${mounts[@]}"} debian:bookworm-slim sh -c '
    set -e; saved="$1"; dir="$2"; shift 2
    mkdir -p "$saved"
    if [ -e "$dir/openclaw" ]; then mv "$dir/openclaw" "$saved/openclaw"; fi
    for v in "$@"; do cp -a "/v/$v" "$saved/$v"; done' _ "$saved" "$dir" ${names[@]+"${names[@]}"}
  for v in ${names[@]+"${names[@]}"}; do docker volume rm "${project}_$v" >/dev/null; done
  echo "set aside in $saved (backups stay in $dir/backups)"
}
