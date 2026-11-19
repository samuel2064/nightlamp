#!/usr/bin/env bash
echo "=== Testing different grep patterns ==="

# Test 1: Using Perl regex with \x00
echo "Test 1: grep -P '\x00'"
grep -P '\x00' .github/workflows/ci.yml 2>/dev/null | wc -l
grep -P '\x00' /tmp/test-nul.yml 2>/dev/null | wc -l

# Test 2: Using -a flag to treat as text
echo "Test 2: grep -a $'\x00'"
grep -a $'\x00' .github/workflows/ci.yml 2>/dev/null | wc -l
grep -a $'\x00' /tmp/test-nul.yml 2>/dev/null | wc -l

# Test 3: Using od approach
echo "Test 3: od approach"
od -An -tx1 .github/workflows/ci.yml | tr -s ' ' '\n' | grep -c '^00$'
od -An -tx1 /tmp/test-nul.yml | tr -s ' ' '\n' | grep -c '^00$'

# Test 4: Using xxd
echo "Test 4: xxd approach"
xxd .github/workflows/ci.yml | grep -c " 00 "
xxd /tmp/test-nul.yml | grep -c " 00 "