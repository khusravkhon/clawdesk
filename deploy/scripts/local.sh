#!/usr/bin/env bash
# "This computer": ClawDesk on the person's own computer (Docker Desktop), the same stack a server runs.
# Used by the desktop app's "This computer" button; safe to re-run (that is also how it updates).
#
#   deploy/scripts/local.sh
#
# Kept apart from a development checkout on the same machine: its own compose project, data folder
# inside Docker, images tagged "local" and panel port. Containers restart with Docker Desktop
# (restart: unless-stopped), so after a reboot the panel is back once Docker Desktop is running.
set -euo pipefail

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-clawdesk-local}"
export CLAWDESK_DATA_DIR="${CLAWDESK_DATA_DIR:-/var/lib/clawdesk-local}"
export PANEL_PORT="${PANEL_PORT:-18080}"
export CLAWDESK_VERSION=local

exec bash "$(dirname "${BASH_SOURCE[0]}")/init.sh"
