#!/usr/bin/env bash
set -euo pipefail
#
# Nightlamp environment validation
# Usage: ./validate-env.sh [path/to/.env]
#
# Validates that required environment variables are set correctly.

usage() {
  echo "Usage: $0 [path/to/.env]"
  echo ""
  echo "If no path is given, checks .env in the repo root."
  exit 1
}

ENV_FILE="${1:-}"
if [[ -z "$ENV_FILE" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  ENV_FILE="$(cd "$SCRIPT_DIR/.." && pwd)/.env"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found."
  exit 1
fi

echo "==> Validating $ENV_FILE"
echo ""

# shellcheck source=/dev/null
source "$ENV_FILE"

HAS_ERROR=false
HAS_WARNING=false

check_required() {
  local var_name="$1"
  local var_value="${!var_name:-}"
  local label="${2:-}"

  if [[ -z "$var_value" || "$var_value" == "REQUIRED" ]]; then
    echo "  [ERR] $var_name is required but not set${label:+ ($label)}"
    HAS_ERROR=true
  else
    echo "  [OK]  $var_name = ${var_value:0:20}..."
  fi
}

check_optional() {
  local var_name="$1"
  local var_value="${!var_name:-}"
  local label="${2:-}"

  if [[ -z "$var_value" || "$var_value" == "REQUIRED" ]]; then
    echo "  [WARN] $var_name is not set${label:+ ($label)} — service will run without it"
    HAS_WARNING=true
  else
    echo "  [OK]  $var_name = ${var_value:0:20}..."
  fi
}

# --- Required vars ---
check_required "NODE_ENV" "Should be development, staging, or production"

# Stripe validation
if [[ -n "${STRIPE_SECRET_KEY:-}" && "${STRIPE_SECRET_KEY}" != "REQUIRED" ]]; then
  if [[ "${STRIPE_SECRET_KEY}" == sk_test_* ]]; then
    echo "  [OK]  STRIPE_SECRET_KEY matches test mode prefix (sk_test_)"
    if [[ "${NODE_ENV}" == "production" ]]; then
      echo "  [ERR] STRIPE_SECRET_KEY uses test key (sk_test_) but NODE_ENV=production"
      HAS_ERROR=true
    fi
  elif [[ "${STRIPE_SECRET_KEY}" == sk_live_* ]]; then
    echo "  [OK]  STRIPE_SECRET_KEY matches live mode prefix (sk_live_)"
    if [[ "${NODE_ENV}" != "production" ]]; then
      echo "  [WARN] STRIPE_SECRET_KEY uses live key (sk_live_) but NODE_ENV=${NODE_ENV}"
      HAS_WARNING=true
    fi
  else
    echo "  [WARN] STRIPE_SECRET_KEY doesn't match sk_test_ or sk_live_ — verify key format"
    HAS_WARNING=true
  fi
else
  check_required "STRIPE_SECRET_KEY" "Required for billing"
fi

check_required "STRIPE_WEBHOOK_SECRET" "Required for Stripe webhook verification"

# --- Optional vars ---
check_optional "SENTRY_DSN" "Error tracking — leave blank to disable"
check_optional "UPTIMEROBOT_API_KEY" "UptimeRobot integration"
check_optional "UPTIMEROBOT_MAIN_MONITOR_ID" "UptimeRobot monitor ID"

# --- Server config ---
check_required "BASE_URL" "Should be set to the server's public URL"

echo ""
if $HAS_ERROR; then
  echo "!! Errors found — fix before deploying."
  exit 1
elif $HAS_WARNING; then
  echo "==> Warnings found (non-blocking). Review before deploying."
  exit 0
else
  echo "==> All checks passed. Environment is ready."
  exit 0
fi
