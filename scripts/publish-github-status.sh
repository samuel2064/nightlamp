#!/usr/bin/env bash
set -euo pipefail

context_prefix=${1:?context prefix required}
source_file=${2:?source file required}
state=${3:-failure}
repo=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
sha=${GITHUB_SHA:?GITHUB_SHA is required}

if [ ! -f "$source_file" ]; then
  echo "no diagnostics at $source_file" >&2
  exit 0
fi

message=$(tr '\n' ' ' < "$source_file" | tr -s ' ' | cut -c1-2000)
index=1
while [ -n "$message" ]; do
  chunk=$(printf '%s' "$message" | cut -c1-140)
  payload=$(jq -n --arg state "$state" --arg context "$context_prefix/$index" --arg description "$chunk" \
    '{state: $state, context: $context, description: $description}')
  curl -sS -o /dev/null -X POST \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -d "$payload" \
    "https://api.github.com/repos/$repo/statuses/$sha"
  message=$(printf '%s' "$message" | cut -c141-)
  index=$((index + 1))
done
