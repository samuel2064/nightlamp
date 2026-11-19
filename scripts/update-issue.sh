#!/usr/bin/env bash
curl -s -X PATCH \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d @scripts/issue-update.json \
  "$PAPERCLIP_API_URL/api/issues/5321720e-88a8-45f5-b653-58e7d87e47d0"