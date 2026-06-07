#!/usr/bin/env bash
set -euo pipefail
#
# Nightlamp deployment script
# Usage: ./deploy.sh [--build-only] [--no-push]
#
# Copies compose config and deploys to target host via SSH.
# Idempotent — safe to re-run.

usage() {
  echo "Usage: $0 [--build-only] [--no-push]"
  echo ""
  echo "Environment variables:"
  echo "  REPO          Image repository (default: nightlamp/monitoring)"
  echo "  REGISTRY      Container registry (default: ghcr.io)"
  echo "  IMAGE_TAG     Docker image tag (default: latest)"
  echo "  TARGET_HOST   SSH target (user@host)"
  echo "  COMPOSE_DIR   Remote compose directory (default: /opt/nightlamp)"
  echo "  DEPLOY_KEY    Optional: SSH private key path"
  exit 1
}

IMAGE_TAG="${IMAGE_TAG:-latest}"
REGISTRY="${REGISTRY:-ghcr.io}"
REPO="${REPO:-nightlamp/monitoring}"
TARGET_HOST="${TARGET_HOST:-}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/nightlamp}"
SSH_OPTS=""
if [[ -n "${DEPLOY_KEY:-}" ]]; then
  SSH_OPTS="-i ${DEPLOY_KEY}"
fi

# ---- Build only ----
if [[ "${1:-}" == "--build-only" ]]; then
  echo "==> Building Docker image locally..."
  docker build -t "${REGISTRY}/${REPO}:${IMAGE_TAG}" .
  echo "==> Done. Publish with: docker push ${REGISTRY}/${REPO}:${IMAGE_TAG}"
  exit 0
fi

# ---- Remote deploy ----
if [[ -z "$TARGET_HOST" ]]; then
  echo "Error: TARGET_HOST not set. Export it or pass --build-only."
  exit 1
fi

echo "==> Deploying to ${TARGET_HOST} (tag: ${IMAGE_TAG}) ..."

# 1. Push local image if --no-push not set
NO_PUSH=false
if [[ "${1:-}" == "--no-push" ]] || [[ "${2:-}" == "--no-push" ]]; then
  NO_PUSH=true
fi

if ! $NO_PUSH; then
  echo "==> Building and pushing image..."
  docker build -t "${REGISTRY}/${REPO}:${IMAGE_TAG}" .
  docker push "${REGISTRY}/${REPO}:${IMAGE_TAG}"
fi

# 2. Pull latest image on remote
ssh $SSH_OPTS "${TARGET_HOST}" "docker pull ${REGISTRY}/${REPO}:${IMAGE_TAG}"

# 3. Ensure remote directories exist
ssh $SSH_OPTS "${TARGET_HOST}" "mkdir -p ${COMPOSE_DIR}"

# 4. Copy docker-compose.yml
scp $SSH_OPTS docker-compose.yml "${TARGET_HOST}:${COMPOSE_DIR}/"

# 5. Copy .env if it exists locally
if [[ -f .env ]]; then
  scp $SSH_OPTS .env "${TARGET_HOST}:${COMPOSE_DIR}/"
  echo "==> Copied .env"
else
  echo "==> WARNING: No .env found locally — ensure secrets exist on target."
fi

# 6. Restart service remotely
ssh $SSH_OPTS "${TARGET_HOST}" <<-REMOTE
  cd ${COMPOSE_DIR}
  export IMAGE_TAG=${IMAGE_TAG}
  docker compose pull
  docker compose up -d
REMOTE

# 7. Health check with retry
echo "==> Verifying health..."
for i in {1..12}; do
  if curl -sf "http://${TARGET_HOST}:3000/api/healthz" > /dev/null 2>&1; then
    echo "==> Deploy complete — service is healthy."
    exit 0
  fi
  echo "    Attempt $i/12 — waiting..."
  sleep 5
done

echo "!! WARNING: Deploy completed but health check did not pass."
echo "   ssh ${TARGET_HOST} docker compose logs --tail=50"
exit 1
