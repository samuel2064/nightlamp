#!/usr/bin/env bash
set -euo pipefail
#
# Nightlamp rollback script
# Usage: ./rollback.sh <previous-tag> [target-host]
#
# Rolls back the Nightlamp stack to a previous image tag.
# Example: ./rollback.sh sha-abc1234 user@staging.example.com

usage() {
  echo "Usage: $0 <previous-tag> [target-host]"
  echo ""
  echo "Environment variables:"
  echo "  REPO          Image repository (default: nightlamp/monitoring)"
  echo "  COMPOSE_DIR   Remote compose directory (default: /opt/nightlamp)"
  echo "  TARGET_HOST   SSH target (fallback when not passed as arg)"
  exit 1
}

PREVIOUS_TAG="${1:-}"
TARGET_HOST="${2:-${TARGET_HOST:-}}"

if [[ -z "$PREVIOUS_TAG" ]]; then
  echo "Error: previous-tag argument is required."
  usage
fi

if [[ -z "$TARGET_HOST" ]]; then
  echo "Error: target-host not set. Provide as arg 2 or set TARGET_HOST env var."
  usage
fi

REPO="${REPO:-nightlamp/monitoring}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/nightlamp}"
REGISTRY="${REGISTRY:-ghcr.io}"

echo "==> Rolling back ${TARGET_HOST} to ${PREVIOUS_TAG} ..."

# 1. Verify the tag exists
echo "==> Checking tag ${PREVIOUS_TAG} exists..."
if ! docker manifest inspect "${REGISTRY}/${REPO}:${PREVIOUS_TAG}" &>/dev/null; then
  # Try pulling before declaring failure
  ssh "${TARGET_HOST}" "docker pull ${REGISTRY}/${REPO}:${PREVIOUS_TAG}" || {
    echo "Error: Tag ${PREVIOUS_TAG} not found in registry and pull failed."
    exit 1
  }
fi

# 2. Pull the previous image on remote
ssh "${TARGET_HOST}" "docker pull ${REGISTRY}/${REPO}:${PREVIOUS_TAG}"

# 3. Tag as current on remote
ssh "${TARGET_HOST}" "docker tag ${REGISTRY}/${REPO}:${PREVIOUS_TAG} ${REGISTRY}/${REPO}:rollback-candidate"

# 4. Restart with the rolled-back version
ssh "${TARGET_HOST}" <<-REMOTE
  cd ${COMPOSE_DIR}
  export IMAGE_TAG=${PREVIOUS_TAG}
  docker compose up -d --pull always
REMOTE

# 5. Health check
echo "==> Waiting for service to come up..."
for i in {1..12}; do
  if curl -sf "http://${TARGET_HOST}:3000/api/healthz" > /dev/null 2>&1; then
    echo "==> Rollback successful — service is healthy."
    exit 0
  fi
  echo "    Attempt $i/12 — waiting..."
  sleep 5
done

echo "!! WARNING: Rollback completed but health check did not pass."
echo "   Check the service manually: ssh ${TARGET_HOST} docker compose logs"
exit 1
