#!/usr/bin/env bash
# ClawDesk on a fresh Ubuntu / Debian server: Docker, the code, HTTPS, first start.
# Safe to re-run: it updates the code (git checkout) and restarts the stack, keeping data and .env.
#
#   From a copy of the repository on the server (the repository is private for now):
#     sudo bash deploy/install.sh
#   Once the repository is public, straight from GitHub:
#     curl -fsSL https://raw.githubusercontent.com/khusravkhon/clawdesk/main/deploy/install.sh | sudo bash
#
# Options (or the same names as environment variables):
#   --domain panel.example.com   address of the panel; its A record must point at this server.
#                                Without a domain the panel gets <ip>.sslip.io (needs nothing to set up).
#   --no-https                   no Caddy: the panel stays on 127.0.0.1:8080 (reach it through an SSH tunnel).
#   --dir /opt/clawdesk          where the code goes when it is downloaded.
set -euo pipefail

REPO="${CLAWDESK_REPO:-https://github.com/khusravkhon/clawdesk.git}"
BRANCH="${CLAWDESK_BRANCH:-main}"
INSTALL_DIR="${CLAWDESK_DIR:-/opt/clawdesk}"
DATA_DIR="${CLAWDESK_DATA_DIR:-/var/lib/clawdesk}"
DOMAIN="${CLAWDESK_DOMAIN:-}"
HTTPS=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --no-https) HTTPS=0; shift ;;
    --dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)"; exit 1 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }

# Questions go to the terminal even when the script itself arrives through a pipe (curl | bash).
ask() {
  local prompt="$1" answer=""
  if [[ -r /dev/tty ]]; then read -r -p "$prompt" answer < /dev/tty || true; fi
  printf '%s' "$answer"
}

[[ $EUID -eq 0 ]] || fail "Run as root: sudo bash $0"

step "Checking the server"
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) echo "$PRETTY_NAME" ;;
  *) fail "This installer supports Ubuntu and Debian (found: ${PRETTY_NAME:-unknown})." ;;
esac
# The Gateway image bundles x86-64 binaries (gog).
[[ "$(uname -m)" == "x86_64" ]] || fail "Only x86-64 servers are supported for now (found: $(uname -m))."

mem_mb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
echo "memory: ${mem_mb} MB"
(( mem_mb >= 1800 )) || warn "Less than 2 GB of memory: agents may run out of it. 4 GB is recommended."
# Building the panel image needs headroom; a swap file keeps small servers from killing the build.
if (( mem_mb < 3500 )) && ! swapon --show | grep -q .; then
  echo "adding a 2 GB swap file (/swapfile)"
  # Some virtual servers forbid swap; the install goes on without it.
  if [[ -f /swapfile ]] || { fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile; } && swapon /swapfile 2>/dev/null; then
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else
    rm -f /swapfile
    warn "Could not turn on swap here; continuing without it."
  fi
fi

free_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
(( free_gb >= 10 )) || warn "Only ${free_gb} GB free on disk; the images need about 6 GB, 20 GB+ is comfortable."

step "Installing Docker"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl >/dev/null
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker --version
else
  # Docker's own apt repository (signed), not the distribution's older packages.
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  codename="${UBUNTU_CODENAME:-$VERSION_CODENAME}"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${codename} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker >/dev/null
  docker --version
fi

step "Getting the code"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/docker-compose.yml" && -f "$SCRIPT_DIR/scripts/init.sh" ]]; then
  CODE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  echo "using the code in $CODE_DIR"
  if [[ -d "$CODE_DIR/.git" ]] && [[ -z "$(git -C "$CODE_DIR" status --porcelain --untracked-files=no)" ]]; then
    git -C "$CODE_DIR" pull --ff-only || warn "Could not update the code with git pull; installing what is here."
  fi
elif [[ -d "$INSTALL_DIR/.git" ]]; then
  CODE_DIR="$INSTALL_DIR"
  echo "updating $CODE_DIR"
  git -C "$CODE_DIR" fetch --quiet origin "$BRANCH" && git -C "$CODE_DIR" checkout --quiet "$BRANCH" && git -C "$CODE_DIR" merge --ff-only --quiet "origin/$BRANCH"
else
  CODE_DIR="$INSTALL_DIR"
  echo "downloading $REPO to $CODE_DIR"
  git clone --quiet --branch "$BRANCH" "$REPO" "$CODE_DIR" \
    || fail "Could not download the code. While the repository is private, copy it to the server and run: sudo bash <copy>/deploy/install.sh"
fi

step "Panel address (HTTPS)"
public_ip() { curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}'; }
existing_domain="$(grep -E '^CLAWDESK_DOMAIN=' "$CODE_DIR/deploy/.env" 2>/dev/null | cut -d= -f2- || true)"
if [[ $HTTPS == 0 ]]; then
  DOMAIN=""
  echo "no HTTPS: the panel stays on 127.0.0.1:8080"
else
  IP="$(public_ip)"
  [[ -z "$DOMAIN" ]] && DOMAIN="$existing_domain"
  if [[ -z "$DOMAIN" ]]; then
    echo "Server address: $IP"
    echo "If you have a domain, point its A record at $IP first. Leave empty to use ${IP//./-}.sslip.io."
    DOMAIN="$(ask "Domain for the panel (e.g. panel.example.com): ")"
  fi
  DOMAIN="$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z' | sed -E 's#^https?://##; s#/.*$##')"
  [[ -z "$DOMAIN" ]] && DOMAIN="${IP//./-}.sslip.io"
  [[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || fail "\"$DOMAIN\" does not look like a domain name."
  resolved="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}' || true)"
  if [[ "$resolved" != "$IP" ]]; then
    warn "$DOMAIN points at ${resolved:-nothing}, not at this server ($IP)."
    warn "The certificate is issued only once the A record points here; Caddy keeps retrying."
  fi
  echo "panel: https://$DOMAIN"

  # Open the web ports if the ufw firewall is on (it is not turned on here: that could cut off SSH).
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw allow 443/udp >/dev/null
    echo "ufw: opened 80/tcp, 443/tcp, 443/udp"
  fi
  warn "If the provider has its own firewall (cloud panel), allow ports 80 and 443 there too."
fi

step "Starting ClawDesk"
TZ_NAME="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
CLAWDESK_DOMAIN="$DOMAIN" \
CLAWDESK_FILES_DIR="$DATA_DIR/files" \
CLAWDESK_TZ="${TZ_NAME:-UTC}" \
  bash "$CODE_DIR/deploy/scripts/init.sh"

cat <<EOF

ClawDesk is installed in $CODE_DIR, data in $DATA_DIR.
  Update:            sudo bash $CODE_DIR/deploy/install.sh
  Logs:              docker compose -f $CODE_DIR/deploy/docker-compose.yml logs -f panel
  New owner code:    docker compose -f $CODE_DIR/deploy/docker-compose.yml exec panel node dist/cli/owner-code.js https://${DOMAIN:-<panel address>}
  Files for agents:  $DATA_DIR/files
EOF
