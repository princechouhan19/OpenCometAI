#!/usr/bin/env bash
# Build dist/opencomet-<version>.zip after the pre-flight gates pass.
#
#   bash scripts/package.sh
#   bash scripts/package.sh --skip-checks
#
# Gates, in order:
#   1. manifest.json and package.json agree
#   2. no corrupted emoji placeholders in shipped source
#   3. no generated-prose markers in source comments
#   4. no credential-shaped strings in the shipped tree
#   4. unit tests pass
#   5. the benchmark suite passes
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_CHECKS=0
for arg in "$@"; do
  case "$arg" in
    --skip-checks) SKIP_CHECKS=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

MANIFEST_VERSION="$(node -e "process.stdout.write(require('./manifest.json').version)")"
PACKAGE_VERSION="$(node -e "process.stdout.write(require('./package.json').version)")"

if [ "$MANIFEST_VERSION" != "$PACKAGE_VERSION" ]; then
  echo "FAIL version drift: manifest.json=$MANIFEST_VERSION package.json=$PACKAGE_VERSION" >&2
  echo "     bump both in the same commit." >&2
  exit 1
fi

if [ "$SKIP_CHECKS" -eq 0 ]; then
  if grep -rn "'?? \|\`?? " --include=*.js src | grep -v vendor; then
    echo "FAIL corrupted emoji placeholders in shipped source (see above)" >&2
    exit 1
  fi
  if grep -rEn "(sk-[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9._-]{20,}|AIza[0-9A-Za-z_-]{30,})" \
       --include=*.js --include=*.json --include=*.html src manifest.json 2>/dev/null | grep -v vendor; then
    echo "FAIL credential-shaped string found in the shipped tree" >&2
    exit 1
  fi
  bash scripts/check-style.sh
  npm test --silent
  node OpenCometBench/run-all.js
fi

OUT="dist/opencomet-${MANIFEST_VERSION}.zip"
mkdir -p dist
rm -f "$OUT"

# Only what Chrome loads: no tests, bench, docs or unreferenced vendor data.
zip -qr "$OUT" \
  manifest.json \
  src \
  skills \
  assets \
  -x "*.DS_Store" "*/.git/*" "src/vendor/tesseract/lang/*.gz.map"

echo
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
echo "Version $MANIFEST_VERSION (manifest == package.json)"
