#!/usr/bin/env bash
echo "=== Testing grep behavior ==="
echo "File: .github/workflows/ci.yml"
echo "grep -c output:"
grep -c $'\x00' .github/workflows/ci.yml
echo "grep -q exit code:"
grep -q $'\x00' .github/workflows/ci.yml 2>/dev/null
echo "Exit code: $?"
echo "grep output (no -q):"
grep $'\x00' .github/workflows/ci.yml 2>/dev/null | cat -A
echo "---"

echo "File: /tmp/test-nul.yml"
echo "grep -c output:"
grep -c $'\x00' /tmp/test-nul.yml
echo "grep -q exit code:"
grep -q $'\x00' /tmp/test-nul.yml 2>/dev/null
echo "Exit code: $?"
echo "grep output (no -q):"
grep $'\x00' /tmp/test-nul.yml 2>/dev/null | cat -A
echo "---"

echo "=== Testing with od ==="
echo "ci.yml NUL count via od:"
od -An -tx1 .github/workflows/ci.yml | tr -s ' ' '\n' | grep -c '^00$'
echo "test-nul.yml NUL count via od:"
od -An -tx1 /tmp/test-nul.yml | tr -s ' ' '\n' | grep -c '^00$'