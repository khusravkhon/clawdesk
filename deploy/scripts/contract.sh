#!/usr/bin/env bash
# Contract smoke test against a live OpenClaw Gateway: ClawDesk's own Gateway and panel images, built for
# the pinned OpenClaw (deploy/openclaw.version, or OPENCLAW_VERSION), as a fresh throwaway install; then
# apps/bff/src/contract/smoke.ts runs inside the panel container. CI runs this on every push and on every
# OpenClaw bump.
#
#   bash deploy/scripts/contract.sh
#   OPENCLAW_VERSION=2026.9.1 bash deploy/scripts/contract.sh    another OpenClaw than the pinned one
#   CONTRACT_KEEP=1 bash deploy/scripts/contract.sh              leave the stack up afterwards
#
# Its own compose project (clawdesk-contract), data folder, image tag ("contract") and settings file
# (deploy/.env.contract): it never touches a real install on the same machine, nor its deploy/.env.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DEPLOY_DIR"
# Git Bash on Windows rewrites /var/... arguments into Windows paths; Docker needs them as-is.
export MSYS_NO_PATHCONV=1

PROJECT="${CONTRACT_PROJECT:-clawdesk-contract}"
DATA_DIR="${CONTRACT_DATA_DIR:-/var/lib/clawdesk-contract}"
VERSION="${OPENCLAW_VERSION:-$(tr -d '[:space:]' < openclaw.version)}"
ENV_FILE=.env.contract

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
random_token() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

case "$DATA_DIR" in
  /var/lib/clawdesk|/var/lib/clawdesk-local|/var/lib/clawdesk/*|/var/lib/clawdesk-local/*|/|"") echo "refusing data folder $DATA_DIR: it belongs to a real install"; exit 1 ;;
esac
case "$PROJECT" in
  clawdesk|clawdesk-local) echo "refusing compose project $PROJECT: it belongs to a real install"; exit 1 ;;
esac

# Everything compose interpolates comes from this file, never from deploy/.env.
cat > "$ENV_FILE" <<EOF
COMPOSE_PROJECT_NAME=$PROJECT
CLAWDESK_DATA_DIR=$DATA_DIR
CLAWDESK_FILES_DIR=$DATA_DIR/files
CLAWDESK_VERSION=contract
OPENCLAW_VERSION=$VERSION
OPENCLAW_IMAGE=${OPENCLAW_IMAGE:-ghcr.io/openclaw/openclaw}
OPENCLAW_GATEWAY_TOKEN=$(random_token)
FREELLMAPI_ENCRYPTION_KEY=$(random_token)
GOG_KEYRING_PASSWORD=$(random_token)
PANEL_PORT=${CONTRACT_PANEL_PORT:-18081}
CLAWDESK_SANDBOX=off
EOF
chmod 600 "$ENV_FILE"
COMPOSE=(docker compose --env-file "$ENV_FILE" -p "$PROJECT" -f docker-compose.yml -f docker-compose.contract.yml)

wipe_data() {
  docker run --rm --user 0 -v "$(dirname "$DATA_DIR"):/parent" debian:bookworm-slim rm -rf "/parent/$(basename "$DATA_DIR")"
}

finish() {
  local status=$?
  set +e
  if [[ $status != 0 ]]; then
    step "Gateway log (last 80 lines)"
    "${COMPOSE[@]}" logs --no-color --tail 80 gateway
    step "Panel log (last 40 lines)"
    "${COMPOSE[@]}" logs --no-color --tail 40 panel
  fi
  if [[ "${CONTRACT_KEEP:-}" == 1 ]]; then
    echo "left running: docker compose --env-file deploy/$ENV_FILE -p $PROJECT -f deploy/docker-compose.yml -f deploy/docker-compose.contract.yml down -v"
  else
    step "Removing the test install"
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1
    wipe_data
    rm -f "$ENV_FILE"
  fi
  exit "$status"
}
trap finish EXIT

step "Fresh test install: project $PROJECT, data $DATA_DIR, OpenClaw $VERSION"
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
wipe_data
docker run --rm --user 0 -v "$(dirname "$DATA_DIR"):/parent" debian:bookworm-slim sh -c "
  d=/parent/$(basename "$DATA_DIR") &&
  mkdir -p \$d/openclaw/workspace/files \$d/backups \$d/videos \$d/video-work \$d/files &&
  chown -R 1000:1000 \$d && chmod 700 \$d/openclaw \$d/backups"
DOCKER_GID="$(docker run --rm -v /var/run/docker.sock:/var/run/docker.sock debian:bookworm-slim stat -c %g /var/run/docker.sock)"
echo "DOCKER_GID=$DOCKER_GID" >> "$ENV_FILE"

step "Building the Gateway (OpenClaw $VERSION) and panel images"
"${COMPOSE[@]}" build gateway panel

step "Onboarding OpenClaw"
"${COMPOSE[@]}" run -T --rm --no-deps --entrypoint node gateway dist/index.js onboard \
  --non-interactive --accept-risk --skip-health --mode local --auth-choice skip \
  --gateway-auth token --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN --skip-channels --no-install-daemon >/dev/null

step "Starting the Gateway and the panel"
"${COMPOSE[@]}" up -d gateway panel
probe='fetch("http://127.0.0.1:8080/api/health").then((r) => r.json()).then((h) => process.exit(h.ok && h.gateway.state === "connected" ? 0 : 1), () => process.exit(1))'
for i in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T panel node -e "$probe" >/dev/null 2>&1; then echo "panel connected to the Gateway"; break; fi
  [[ $i == 60 ]] && { echo "the panel did not connect to the Gateway within 5 minutes"; exit 1; }
  sleep 5
done

step "Contract smoke test"
"${COMPOSE[@]}" exec -T -e OPENCLAW_EXPECTED_VERSION="$VERSION" panel node dist/contract/smoke.js
