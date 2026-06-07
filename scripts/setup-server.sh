#!/usr/bin/env bash
set -euo pipefail
#
# Nightlamp server bootstrap script
# Usage: ./setup-server.sh [--dry-run]
#
# Bootstraps a Linux VM with Docker and starts the Nightlamp stack.
# Idempotent — safe to re-run.

usage() {
  echo "Usage: $0 [--dry-run]"
  echo ""
  echo "Environment variables:"
  echo "  REPO         Image repository (default: nightlamp/monitoring)"
  echo "  IMAGE_TAG    Docker image tag (default: latest)"
  echo "  COMPOSE_DIR  Target directory (default: /opt/nightlamp)"
  echo "  DATADIR      Data volume path (default: /opt/nightlamp/data)"
  exit 1
}

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
elif [[ -n "${1:-}" ]]; then
  usage
fi

REPO="${REPO:-nightlamp/monitoring}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/nightlamp}"
DATADIR="${DATADIR:-${COMPOSE_DIR}/data}"

run() {
  if $DRY_RUN; then
    echo "[DRY-RUN] $*"
  else
    echo "==> $*"
    "$@"
  fi
}

echo "==> Nightlamp server bootstrap (${DRY_RUN:+"dry-run"})"

# 1. Install Docker if missing
if ! command -v docker &>/dev/null; then
  echo "==> Installing Docker..."
  run apt-get update -qq
  run apt-get install -y -qq ca-certificates curl
  run install -m 0755 -d /etc/apt/keyrings
  run curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  run chmod a+r /etc/apt/keyrings/docker.asc
  run echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
  run apt-get update -qq
  run apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  run systemctl enable --now docker
else
  echo "==> Docker already installed ($(docker --version))"
fi

# 2. Create directories
run mkdir -p "${COMPOSE_DIR}" "${DATADIR}"

# 3. Verify docker compose works
run docker compose version

# 4. Pull the image
run docker pull "${REPO}:${IMAGE_TAG}"

# 5. Copy docker-compose.yml if not present
if [[ ! -f "${COMPOSE_DIR}/docker-compose.yml" ]]; then
  echo "==> docker-compose.yml not found — copy it manually or run deploy.sh"
  echo "    scp docker-compose.yml <host>:${COMPOSE_DIR}/"
else
  echo "==> docker-compose.yml found"
fi

# 6. Warn about .env
if [[ ! -f "${COMPOSE_DIR}/.env" ]]; then
  echo "==> WARNING: .env not found at ${COMPOSE_DIR}/.env"
  echo "    Create it with required secrets before starting the stack."
fi

echo ""
echo "==> Bootstrap complete."
echo "    Start the stack: cd ${COMPOSE_DIR} && docker compose up -d"
echo "    Verify: curl http://localhost:3000/api/healthz"
