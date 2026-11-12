#!/usr/bin/env bash
# Fail on comment patterns that make the source read as generated.
#
# These are not style preferences: each one is a marker that showed up in
# machine-written prose and reads as a claim about the code rather than a
# description of it.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

PATTERN='WHY THIS EXISTS|fail-honest|PURSUANT TO|As an AI language model|As a large language model|I cannot browse|This is important:'

if grep -rnE "$PATTERN" --include=*.js --include=*.mjs src 2>/dev/null | grep -v '/vendor/'; then
  echo "FAIL generated-prose markers in src (listed above)" >&2
  echo "     Describe what the code does; do not argue for it." >&2
  exit 1
fi

# A comment banner over ~12 lines is a paragraph, not a comment.
LONG_BANNERS="$(awk '
  /^[[:space:]]*\/\// { if (run == 0) { start = FNR; file = FILENAME } run++; next }
  { if (run >= 12) print file ":" start "-" FNR - 1; run = 0 }
  END { if (run >= 12) print file ":" start "-" FNR }
' $(find src -name '*.js' -not -path '*/vendor/*' 2>/dev/null) 2>/dev/null | sort -u | head -20)"

if [ -n "$LONG_BANNERS" ]; then
  echo "note: long comment blocks in src (not fatal):"
  echo "$LONG_BANNERS"
fi

echo "style: clean"
