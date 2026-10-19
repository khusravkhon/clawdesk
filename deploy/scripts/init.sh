#!/usr/bin/env bash
# First-time setup of a ClawDesk install (also used by install.sh and by the
# desktop "install on server" wizard). Safe to re-run.
#
#   deploy/scripts/init.sh          production stack (gateway + panel)
#   deploy/scripts/init.sh --dev    gateway only, published on 127.0.0.1:18789 for host development
#
# CLAWDESK_DOMAIN, CLAWDESK_FILES_DIR, CLAWDESK_TZ, CLAWDESK_VERSION, CLAWDESK_DATA_DIR, PANEL_PORT and
# COMPOSE_PROJECT_NAME in the environment are written to deploy/.env
# (install.sh passes them). With a domain, Caddy serves the panel over HTTPS.
# OPENCLAW_VERSION is written from deploy/openclaw.version (an OPENCLAW_VERSION in the environment wins).
#
# Over a running install this is an update: a backup first, and the previous images come back if the
# new ones fail (deploy/scripts/update-guard.sh).
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DEPLOY_DIR"

DEV=0
[[ "${1:-}" == "--dev" ]] && DEV=1

COMPOSE=(docker compose -f docker-compose.yml)
[[ $DEV == 1 ]] && COMPOSE+=(-f docker-compose.dev.yml)

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
# shellcheck source=update-guard.sh
. "$DEPLOY_DIR/scripts/update-guard.sh"

random_token() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

step "Checking Docker"
docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker and re-run."; exit 1; }

step "Preparing .env"
if [[ ! -f .env ]]; then
  cp .env.example .env
  token="$(random_token)"
  # portable in-place edit (GNU and BSD sed)
  sed -i.bak "s/^OPENCLAW_GATEWAY_TOKEN=.*/OPENCLAW_GATEWAY_TOKEN=${token}/" .env && rm -f .env.bak
  chmod 600 .env
  echo "created deploy/.env with a new gateway token"
else
  echo "deploy/.env exists, keeping it"
fi

# Git Bash on Windows rewrites /var/... arguments into Windows paths; Docker needs them as-is.
export MSYS_NO_PATHCONV=1

env_get() { { grep -E "^$1=" .env || true; } | tail -1 | cut -d= -f2-; }
env_set() {
  if grep -qE "^$1=" .env; then sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak
  else echo "$1=$2" >> .env; fi
}

[[ $DEV == 0 ]] && guard_detect
if [[ $GUARD == 1 ]]; then
  step "Backing up before the update"
  guard_backup
  guard_snapshot
  trap guard_on_exit EXIT
fi

# Values from install.sh (or the person) win over what .env had; set-but-empty clears (e.g. --no-https).
for name in CLAWDESK_DOMAIN CLAWDESK_FILES_DIR CLAWDESK_TZ CLAWDESK_VERSION CLAWDESK_DATA_DIR PANEL_PORT COMPOSE_PROJECT_NAME; do
  if [[ -n "${!name+set}" ]]; then env_set "$name" "${!name}"; fi
done

# The OpenClaw version travels with the code, so an update of the code brings its OpenClaw too.
env_set OPENCLAW_VERSION "${OPENCLAW_VERSION:-$(tr -d '[:space:]' < openclaw.version)}"

if [[ -z "$(env_get FREELLMAPI_ENCRYPTION_KEY)" ]]; then
  env_set FREELLMAPI_ENCRYPTION_KEY "$(random_token)"
  echo "generated FREELLMAPI_ENCRYPTION_KEY"
fi

if [[ -z "$(env_get GOG_KEYRING_PASSWORD)" ]]; then
  env_set GOG_KEYRING_PASSWORD "$(random_token)"
  echo "generated GOG_KEYRING_PASSWORD"
fi

# Shared folder: the person drops files here, the main agent reads them as files/ in its workspace.
if [[ -z "$(env_get CLAWDESK_FILES_DIR)" ]]; then
  files_dir="$HOME/ClawDesk"
  mkdir -p "$files_dir"
  # Docker Desktop on Windows wants C:/Users/... rather than Git Bash's /c/Users/...
  if command -v cygpath >/dev/null 2>&1; then files_dir="$(cygpath -m "$files_dir")"; fi
  env_set CLAWDESK_FILES_DIR "$files_dir"
  echo "shared files folder: $files_dir"
fi

step "Detecting Docker socket group (for agent sandboxes)"
# The Gateway starts sandbox containers through the host socket; it needs the socket's group.
DOCKER_GID="$(docker run --rm -v /var/run/docker.sock:/var/run/docker.sock debian:bookworm-slim stat -c %g /var/run/docker.sock)"
env_set DOCKER_GID "$DOCKER_GID"
echo "docker socket group: $DOCKER_GID"

DATA_DIR="$(env_get CLAWDESK_DATA_DIR)"
DATA_DIR="${DATA_DIR:-/var/lib/clawdesk}"
env_set CLAWDESK_DATA_DIR "$DATA_DIR"
STATE_DIR="$DATA_DIR/openclaw"

step "Preparing OpenClaw state at $STATE_DIR (same path on host and in the Gateway)"
# Created through Docker so it works the same on Linux hosts and inside Docker Desktop's VM; owned by uid 1000 (node).
# workspace/files is where the shared folder is mounted: made here, or Docker creates it (and workspace/) as root
# and OpenClaw's onboarding cannot write the main workspace.
# videos/ keeps the originals the owner asked for and video-work/ is the scratch of a running job;
# both are bind-mounted, so Docker would otherwise create them as root and the Gateway (node)
# could not write a single video there.
docker run --rm --user 0 -v "$DATA_DIR:$DATA_DIR" debian:bookworm-slim   sh -c "mkdir -p '$STATE_DIR/workspace/files' '$DATA_DIR/backups' '$DATA_DIR/videos' '$DATA_DIR/video-work' && chown 1000:1000 '$STATE_DIR' '$STATE_DIR/workspace' '$STATE_DIR/workspace/files' '$DATA_DIR/backups' '$DATA_DIR/videos' '$DATA_DIR/video-work' && chmod 700 '$STATE_DIR' '$DATA_DIR/backups' && chmod 755 '$DATA_DIR/videos' '$DATA_DIR/video-work'"

# A shared folder inside the data folder (servers: install.sh puts it there) belongs to the agent user too.
FILES_DIR="$(env_get CLAWDESK_FILES_DIR)"
if [[ "$FILES_DIR" == "$DATA_DIR"/* ]]; then
  docker run --rm --user 0 -v "$DATA_DIR:$DATA_DIR" debian:bookworm-slim sh -c "mkdir -p '$FILES_DIR' && chown 1000:1000 '$FILES_DIR'"
fi

DOMAIN="$(env_get CLAWDESK_DOMAIN)"
if [[ -n "$DOMAIN" && $DEV == 0 ]]; then
  COMPOSE+=(--profile https)
  echo "HTTPS for $DOMAIN through Caddy (ports 80 and 443)"
fi

VERSION="$(env_get CLAWDESK_VERSION)"
pulled=0
if [[ -n "$VERSION" && "$VERSION" != "dev" && "$VERSION" != "local" && $DEV == 0 ]]; then
  step "Pulling ClawDesk $VERSION images"
  registry="ghcr.io/khusravkhon"
  if "${COMPOSE[@]}" pull gateway panel && docker pull "$registry/clawdesk-sandbox:$VERSION"     && docker tag "$registry/clawdesk-sandbox:$VERSION" openclaw-sandbox:bookworm-slim; then
    pulled=1
  else
    echo "Could not pull the $VERSION images (private packages need: docker login ghcr.io). Building instead."
  fi
fi

built=$pulled
[[ $pulled == 0 ]] && step "Building the Gateway image (OpenClaw + Docker CLI) and the agent sandbox image"
for attempt in 1 2 3; do
  [[ $built == 1 ]] && break
  if "${COMPOSE[@]}" build gateway && docker build -q -t openclaw-sandbox:bookworm-slim -f sandbox.Dockerfile . >/dev/null; then built=1; break; fi
  echo "build failed (attempt $attempt/3), retrying in 5s…"
  sleep 5
done
if [[ $built == 0 ]]; then
  echo "Could not build the images. If ghcr.io is slow or blocked, set in deploy/.env:"
  echo "  OPENCLAW_IMAGE=openclaw/openclaw"
  exit 1
fi

step "Onboarding OpenClaw (only if not configured yet)"
if "${COMPOSE[@]}" run -T --rm --no-deps --entrypoint sh gateway -c "test -f '$STATE_DIR/openclaw.json'"; then
  echo "OpenClaw already configured"
else
  # No model here: the user connects any provider (or a subscription) in the panel.
  "${COMPOSE[@]}" run -T --rm --no-deps --entrypoint node gateway dist/index.js onboard     --non-interactive --accept-risk --skip-health     --mode local     --auth-choice skip     --gateway-auth token     --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN     --skip-channels     --no-install-daemon
fi

step "Checking installed plugin dependencies"
"${COMPOSE[@]}" run -T --rm --no-deps --entrypoint node gateway /usr/local/lib/clawdesk-plugin-repair.mjs

if [[ $DEV == 1 ]]; then
  step "Starting gateway (dev: 127.0.0.1:18789)"
  "${COMPOSE[@]}" up -d gateway freellmapi
  bff_env="$DEPLOY_DIR/../apps/bff/.env"
  if [[ ! -f "$bff_env" ]]; then
    {
      echo "GATEWAY_URL=ws://127.0.0.1:18789"
      grep '^OPENCLAW_GATEWAY_TOKEN=' .env
      echo "DATA_DIR=./data"
      echo "LOG_LEVEL=info"
      echo "CLAWDESK_SANDBOX=on"
      echo "FREELLMAPI_URL=http://127.0.0.1:3001"
    } > "$bff_env"
    chmod 600 "$bff_env"
    echo "wrote apps/bff/.env for host development"
  fi
  echo
  echo "Gateway is up on ws://127.0.0.1:18789. Next: pnpm --filter @clawdesk/bff rpc-inventory"
else
  step "Starting panel + gateway"
  if [[ $pulled == 1 ]]; then "${COMPOSE[@]}" up -d; else "${COMPOSE[@]}" up -d --build; fi
  guard_verify
  port="$(grep '^PANEL_PORT=' .env | cut -d= -f2-)"
  url="http://127.0.0.1:${port:-8080}"
  if [[ -n "$DOMAIN" ]]; then
    url="https://$DOMAIN"
    echo "Caddy is getting the certificate; the first opening can take up to a minute."
  fi
  echo
  echo "ClawDesk is starting: $url"
  # First run: the panel opens only with the owner code (prints nothing once the owner has a password).
  for _ in $(seq 1 30); do
    "${COMPOSE[@]}" exec -T panel node dist/cli/owner-code.js --first-run "$url" 2>/dev/null && break
    sleep 2
  done
fi
