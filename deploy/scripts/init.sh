#!/usr/bin/env bash
# First-time setup of a ClawDesk install (also used by install.sh and by the
# desktop "install on server" wizard). Safe to re-run.
#
#   deploy/scripts/init.sh          production stack (gateway + panel)
#   deploy/scripts/init.sh --dev    gateway only, published on 127.0.0.1:18789 for host development
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DEPLOY_DIR"

DEV=0
[[ "${1:-}" == "--dev" ]] && DEV=1

COMPOSE=(docker compose -f docker-compose.yml)
[[ $DEV == 1 ]] && COMPOSE+=(-f docker-compose.dev.yml)

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

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
docker run --rm --user 0 -v "$DATA_DIR:$DATA_DIR" debian:bookworm-slim   sh -c "mkdir -p '$STATE_DIR' && chown 1000:1000 '$STATE_DIR' && chmod 700 '$STATE_DIR'"

step "Building the Gateway image (OpenClaw + Docker CLI) and the agent sandbox image"
built=0
for attempt in 1 2 3; do
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

if [[ $DEV == 1 ]]; then
  step "Starting gateway (dev: 127.0.0.1:18789)"
  "${COMPOSE[@]}" up -d gateway
  bff_env="$DEPLOY_DIR/../apps/bff/.env"
  if [[ ! -f "$bff_env" ]]; then
    {
      echo "GATEWAY_URL=ws://127.0.0.1:18789"
      grep '^OPENCLAW_GATEWAY_TOKEN=' .env
      echo "DATA_DIR=./data"
      echo "LOG_LEVEL=info"
      echo "CLAWDESK_SANDBOX=on"
    } > "$bff_env"
    chmod 600 "$bff_env"
    echo "wrote apps/bff/.env for host development"
  fi
  echo
  echo "Gateway is up on ws://127.0.0.1:18789. Next: pnpm --filter @clawdesk/bff rpc-inventory"
else
  step "Building and starting panel + gateway"
  "${COMPOSE[@]}" up -d --build
  port="$(grep '^PANEL_PORT=' .env | cut -d= -f2-)"
  echo
  echo "ClawDesk is starting: http://127.0.0.1:${port:-8080}"
fi
