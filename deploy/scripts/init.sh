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

step "Pulling OpenClaw image"
"${COMPOSE[@]}" pull gateway

step "Onboarding OpenClaw (only if not configured yet)"
if "${COMPOSE[@]}" run -T --rm --no-deps --entrypoint sh gateway -c 'test -f /home/node/.openclaw/openclaw.json'; then
  echo "OpenClaw already configured"
else
  # No model here: the user connects any provider (or a subscription) in the panel.
  "${COMPOSE[@]}" run -T --rm --no-deps --entrypoint node gateway dist/index.js onboard \
    --non-interactive --accept-risk --skip-health \
    --mode local \
    --auth-choice skip \
    --gateway-auth token \
    --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
    --skip-channels \
    --no-install-daemon
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
