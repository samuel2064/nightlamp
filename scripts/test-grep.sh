#!/usr/bin/env bash
echo "Testing grep for NUL bytes in ci.yml"
grep -q $'\x00' .github/workflows/ci.yml 2>/dev/null
echo "Exit code: $?"

echo "Testing grep for NUL bytes in test-nul.yml"
grep -q $'\x00' /tmp/test-nul.yml 2>/dev/null
echo "Exit code: $?"