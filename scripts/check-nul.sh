#!/usr/bin/env bash
file="$1"
echo "Checking $file"
xxd "$file" | grep " 00 " | wc -l