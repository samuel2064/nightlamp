#!/usr/bin/env bash
set -euo pipefail
#
# Nightlamp staging environment setup
# Usage: ./stage-env.sh [--force]
#
# Copies .env.staging to .env and creates required data directories.

usage() {
  echo "Usage: $0 [--force]"
  echo ""
  echo "  --force    Overwrite existing .env without prompting"
  exit 1
}

FORCE=false
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    -h|--help) usage ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Nightlamp staging environment setup"
echo ""

# 1. Copy .env.staging -> .env
ENV_SRC="$REPO_DIR/.env.staging"
ENV_DST="$REPO_DIR/.env"

if [[ -f "$ENV_DST" ]] && ! $FORCE; then
  echo "!! .env already exists. Use --force to overwrite."
  echo "   Current .env will not be changed."
else
  if [[ ! -f "$ENV_SRC" ]]; then
    echo "Error: $ENV_SRC not found."
    exit 1
  fi
  cp "$ENV_SRC" "$ENV_DST"
  echo "==> Copied .env.staging -> .env"
fi

# 2. Create data directories
mkdir -p "$REPO_DIR/data" "$REPO_DIR/playbook"
echo "==> Created data/ and playbook/ directories"

# 3. Summary
echo ""
echo "==> Environment Summary"
echo ""

CONFIGURED=0
MISSING=0

while IFS='=' read -r key value; do
  # Skip comments and empty lines
  [[ "$key" =~ ^#.*$ ]] && continue
  [[ -z "$key" ]] && continue

  if [[ -z "$value" || "$value" == "REQUIRED" ]]; then
    echo "  [!] $key  (missing — set before starting)"
    MISSING=$((MISSING + 1))
  else
    echo "  [✓] $key"
    CONFIGURED=$((CONFIGURED + 1))
  fi
done < "$ENV_DST"

echo ""
echo "  Configured: $CONFIGURED  Missing: $MISSING"
echo ""
echo "==> Done. Edit .env with real values before starting the stack."
echo "    docker compose up -d"
