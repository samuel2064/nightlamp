#!/usr/bin/env bash
set -euo pipefail
# Nightlamp deploy — delegates to scripts/deploy.sh
cd "$(dirname "$0")"
exec ./scripts/deploy.sh "$@"
