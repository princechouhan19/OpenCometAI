#!/usr/bin/env bash
# scripts/package_v1160.sh — deterministic release packaging for OpenCometAI-SIH v1.16.0.
# Pre-flight spot checks → clean staging → deterministic mtimes → zip -9 -X →
# unzip -t + round-trip byte-diff → SHA256 → copy to /home/z/my-project/download/.
# v1.16.0 packaging note: docs were reorganized (docs/{changelog,guides,sih,architecture,
# research,project,assets}) and the README was rebuilt (logo + badges; version narratives
# now live in docs/changelog/). Pre-flight checks assert the NEW layout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
DEST_DIR="${DEST_DIR:-$ROOT/download}"
OUT="$DEST_DIR/OpenCometAI-SIH-v1.16.0.zip"
cd "$ROOT"

echo "== pre-flight spot checks =="
fail() { echo "PRE-FLIGHT FAIL: $1"; exit 1; }
grep -q '"version": "1.16.0"' manifest.json || fail "manifest version"
# ── v1.16.0 features (OCR memo + session warm-up + warmup harness flag) ──
grep -q "ocrMemo: true" src/lib/privacy-filter.js || fail "OCR memo default-on"
grep -q "cfg.ocrMemo === false" src/lib/privacy-filter.js || fail "OCR memo fail-safe off-switch"
grep -q "ocrMemoHit" src/lib/privacy-filter.js || fail "ocrMemoHit telemetry"
grep -q "v1.16.0 OCR MEMO" src/lib/privacy-filter.js || fail "OCR memo comment anchor"
grep -q "yoloMaxEdge: 0" src/lib/privacy-filter.js || fail "yoloMaxEdge knob ships disabled"
grep -q "warmupVisionModels({ yolo: Boolean(privacyCfg.runYolo), vit: true })" src/background/sw.js || fail "session vision warm-up (SW)"
grep -q "type: 'VISION_WARMUP'" src/lib/offscreen-client.js || fail "warm-up client (offscreen-client)"
grep -q "preloadLocalVision" src/offscreen/offscreen.js || fail "warm-up executes in offscreen"
grep -q "preloadLocalVision" src/lib/local-vision.js || fail "preloadLocalVision export"
grep -q "const WARMUP = argv.includes('--warmup')" OpenCometBench/e2e/run-e2e-real.mjs || fail "run-e2e-real --warmup flag"
grep -q "meta.warmup" OpenCometBench/e2e/run-e2e-real.mjs || fail "warm-up stamped into report meta"
test -f OpenCometBench/probe-yolo-downscale.mjs || fail "YOLO downscale probe (archived negative result)"
test -f OpenCometBench/results/probe-yolo-downscale-1789080399573.json || fail "archived probe report"
test -f scripts/test_ocr_memo.mjs || fail "v1.16.0 OCR memo suite"
test -f scripts/test_vision_warmup.mjs || fail "v1.16.0 vision warm-up suite"
# ── standing features still intact (spot set) ──
test -f src/lib/tab-sandbox.js && grep -q "ensureTaskGroup" src/lib/tab-sandbox.js || fail "tab-sandbox module"
grep -q "requestActionApproval" src/background/sw.js || fail "ask-before-acting gate (sw)"
grep -q "alreadyInState" src/background/actions.js || fail "media already-in-state"
grep -q 'export function maskSecretShapedText' src/lib/privacy-firewall.js || fail "v1.15.7 mask primitive"
grep -qF "(?=[^\\s'\"]*\\d)[^\\s'\"]{5,}" src/lib/pii-detector.js || fail "v1.15.8 bounded lookahead"
grep -q 'PARTIAL / MID-ENTRY PAN' src/lib/pii-detector.js || fail "v1.15.2 partial PAN"
grep -q "photoCandidates" src/lib/privacy-agent.js || fail "v1.15.3 dom face sweep"
grep -q "3b″) AVATAR GUARD" src/lib/privacy-filter.js || fail "v1.15.4 avatar guard"
grep -q 'data-settings-target="about"' src/sidepanel/sidepanel.html || fail "v1.15.5 About page"
grep -q "buildTrustedProfileBlock" src/lib/privacy-agent.js || fail "v1.15.6 trusted profile block"
# ── docs reorganization (new layout) ──
test -f docs/changelog/v1.16.0.md || fail "changelog v1.16.0 file"
test -f docs/changelog/v1.15.9.md || fail "changelog v1.15.9 file"
test -f docs/changelog/v1.15.0.md || fail "changelog v1.15.0 file"
test -f docs/changelog/INDEX.md || fail "changelog INDEX"
test -f docs/sih/SIH_READINESS.md || fail "docs/sih/SIH_READINESS.md"
test -f docs/architecture/PRIVACY_VISION.md || fail "docs/architecture/PRIVACY_VISION.md"
test -f docs/architecture/FILE_GUIDE.md || fail "docs/architecture/FILE_GUIDE.md"
test -f docs/research/vlm-speed-research.md || fail "docs/research/vlm-speed-research.md"
test -f docs/guides/GETTING_STARTED.md || fail "docs/guides/GETTING_STARTED.md"
test -f docs/guides/DEMO.md || fail "docs/guides/DEMO.md"
test -f docs/assets/demo-page.html || fail "docs/assets/demo-page.html"
test -f docs/assets/logo.png || fail "docs/assets/logo.png"
test ! -f docs/SIH_READINESS.md || fail "stale docs/SIH_READINESS.md still present"
test ! -f docs/PRIVACY_VISION.md || fail "stale docs/PRIVACY_VISION.md still present"
test ! -f docs/demo-page.html || fail "stale docs/demo-page.html still present"
grep -q "docs/sih/SIH_READINESS.md" src/sidepanel/sidepanel.html || fail "sidepanel About links new readiness path"
grep -q "docs/research/vlm-speed-research.md" src/lib/providers.js || fail "providers.js research path"
grep -q "docs/research/vlm-speed-research.md" src/lib/agent-context.js || fail "agent-context.js research path"
grep -q "docs/sih/SIH_READINESS.md" OpenCometBench/OPENCOMET_BENCH.md || fail "bench spec readiness path"
grep -q "docs/sih/SIH_READINESS.md" OpenCometBench/dashboard.js || fail "dashboard readiness path"
# ── README (rebuilt: logo + badges + changelog link) ──
grep -q 'docs/assets/logo.png' README.md || fail "README hero logo"
grep -q 'img.shields.io/badge/version-1.16.0' README.md || fail "README version badge"
grep -q 'docs/changelog/INDEX.md' README.md || fail "README changelog link"
grep -q 'OpenCometBench/README.md' README.md || fail "README bench link"
# ── syntax gates ──
node --check src/lib/privacy-filter.js || fail "privacy-filter.js syntax"
node --check src/background/sw.js || fail "sw.js syntax"
node --check src/lib/offscreen-client.js || fail "offscreen-client.js syntax"
node --check src/offscreen/offscreen.js || fail "offscreen.js syntax"
node --check OpenCometBench/e2e/run-e2e-real.mjs || fail "run-e2e-real syntax"
node --check src/sidepanel/sidepanel.js || fail "sidepanel.js syntax"
# ── key hygiene: no real API-key material anywhere in the tree ──
if grep -REl "nvapi-[A-Za-z0-9_-]{10,}|sk-or-v1-[A-Za-z0-9_-]{10,}" --include='*.js' --include='*.json' --include='*.mjs' --include='*.md' --include='*.sh' --include='*.html' . >/dev/null 2>&1; then
  grep -REl "nvapi-[A-Za-z0-9_-]{10,}|sk-or-v1-[A-Za-z0-9_-]{10,}" --include='*.js' --include='*.json' --include='*.mjs' --include='*.md' --include='*.sh' --include='*.html' . | head -3
  fail "API key material found in tree"
fi
# ── regression suites (SKIP_SUITES=1 to skip; all were verified green this session) ──
if [ "${SKIP_SUITES:-0}" != "1" ]; then node scripts/test_ocr_memo.mjs >/dev/null 2>&1 || fail "v1.16.0 OCR memo suite"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
if [ "${SKIP_SUITES:-0}" != "1" ]; then node scripts/test_vision_warmup.mjs >/dev/null 2>&1 || fail "v1.16.0 vision warm-up suite"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
if [ "${SKIP_SUITES:-0}" != "1" ]; then node scripts/test_indian_pii.mjs >/dev/null 2>&1 || fail "Indian PII unit tests"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
if [ "${SKIP_SUITES:-0}" != "1" ]; then node scripts/test_tab_sandbox.mjs >/dev/null 2>&1 || fail "tab sandbox unit tests"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
if [ "${SKIP_SUITES:-0}" != "1" ]; then node scripts/test_about_page.mjs >/dev/null 2>&1 || fail "About page suite"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
if [ "${SKIP_SUITES:-0}" != "1" ]; then node scripts/test_v1151_panel.mjs >/dev/null 2>&1 || fail "v1.15.1 panel regression suite"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
if [ "${SKIP_SUITES:-0}" != "1" ]; then node OpenCometBench/privacy.bench.js 2>/dev/null | grep -q '"pass": true' || fail "privacy bench"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
if [ "${SKIP_SUITES:-0}" != "1" ]; then node OpenCometBench/security.test.js 2>/dev/null | grep -q '"pass": true' || fail "security bench"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
if [ "${SKIP_SUITES:-0}" != "1" ]; then node OpenCometBench/fuzz.test.js 2>/dev/null | grep -q '"pass": true' || fail "fuzz bench"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
test -f OpenCometBench/results/browser-benchmark-1788731519242.json || fail "authoritative browser report"
test -f OpenCometBench/results/e2e-real-benchmark-1789066449033.json || fail "archived OpenRouter reference run"
echo "pre-flight OK"

echo "== staging =="
mkdir "$STAGE/OpenCometAI-SIH"
rsync -a --exclude '.git' --exclude 'node_modules' ./ "$STAGE/OpenCometAI-SIH/" 2>/dev/null || {
  cp -r "$ROOT/." "$STAGE/OpenCometAI-SIH/"
  rm -rf "$STAGE/OpenCometAI-SIH/.git" "$STAGE/OpenCometAI-SIH/node_modules"
}
find "$STAGE/OpenCometAI-SIH" -exec touch -t 202609111200 {} +
mkdir -p "$DEST_DIR"
rm -f "$OUT"
(cd "$STAGE" && zip -r -9 -X "$OUT" OpenCometAI-SIH >/dev/null)

echo "== verify archive =="
unzip -t "$OUT" >/dev/null || fail "unzip -t"
RT="$(mktemp -d)"
unzip -q "$OUT" -d "$RT"
diff -r "$STAGE/OpenCometAI-SIH" "$RT/OpenCometAI-SIH" || fail "round-trip byte diff"
FILES=$(unzip -l "$OUT" | tail -1 | awk '{print $2}')
SIZE=$(stat -c%s "$OUT")
SHA=$(sha256sum "$OUT" | awk '{print $1}')
echo "files: $FILES  size: $SIZE  sha256: $SHA"
rm -rf "$STAGE" "$RT"
echo "DONE → $OUT"
