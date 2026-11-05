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
