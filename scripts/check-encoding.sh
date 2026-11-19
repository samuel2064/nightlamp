#!/usr/bin/env bash
# check-encoding.sh - Check for encoding issues in tracked files
# Usage: ./scripts/check-encoding.sh [paths...]
# Exits non-zero if any tracked file contains NUL bytes or UTF-16 BOM

set -euo pipefail

# Binary extensions to exclude
BINARY_EXTS=(
  "png" "jpg" "jpeg" "gif" "webp" "ico" "svg"
  "woff" "woff2" "ttf" "eot" "otf"
  "zip" "tar" "gz" "bz2" "xz" "7z" "rar"
  "pdf" "doc" "docx" "xls" "xlsx" "ppt" "pptx"
  "bin" "exe" "dll" "so" "dylib"
  "class" "jar" "war" "ear"
  "pyc" "pyo" "pyd"
  "o" "a" "lib"
  "cache" "log"
)

# Build grep pattern for excluded extensions
EXCLUDE_PATTERN=""
for ext in "${BINARY_EXTS[@]}"; do
  if [ -z "$EXCLUDE_PATTERN" ]; then
    EXCLUDE_PATTERN="\.${ext}$"
  else
    EXCLUDE_PATTERN="${EXCLUDE_PATTERN}|\.${ext}$"
  fi
done

# Get files to check: either from arguments or all tracked files
FILES=()
if [ $# -gt 0 ]; then
  FILES=("$@")
else
  while IFS= read -r -d '' file; do
    FILES+=("$file")
  done < <(git ls-files -z)
fi

OFFENDING_FILES=()

for file in "${FILES[@]}"; do
  # Skip if file doesn't exist (deleted)
  [ -f "$file" ] || continue

  # Skip binary files by extension
  if [[ "$file" =~ $EXCLUDE_PATTERN ]]; then
    continue
  fi

  # Check for NUL bytes using od (reliable across platforms)
  nul_count=$(od -An -tx1 "$file" 2>/dev/null | tr -s ' ' '\n' | grep -c '^00$' || true)
  if [ "$nul_count" -gt 0 ]; then
    OFFENDING_FILES+=("$file:NUL byte found ($nul_count occurrences)")
    continue
  fi

  # Check for UTF-16 BOM (FF FE or FE FF)
  first_bytes=$(head -c 2 "$file" 2>/dev/null | od -An -tx1 | tr -d ' \n')
  if [[ "$first_bytes" == "fffe" || "$first_bytes" == "feff" ]]; then
    OFFENDING_FILES+=("$file:UTF-16 BOM found")
    continue
  fi
done

if [ ${#OFFENDING_FILES[@]} -gt 0 ]; then
  echo "Encoding check failed:" >&2
  for item in "${OFFENDING_FILES[@]}"; do
    echo "  $item" >&2
  done
  exit 1
fi

echo "All tracked files pass encoding check (no NUL bytes, no UTF-16 BOM)"
exit 0