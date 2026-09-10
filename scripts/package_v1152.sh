#!/usr/bin/env bash
# scripts/package_v1152.sh — deterministic release packaging for OpenCometAI-SIH v1.15.2.
# Pre-flight spot checks → clean staging → deterministic mtimes → zip -9 -X →
# unzip -t + round-trip byte-diff → SHA256 → copy to /home/z/my-project/download/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
DEST_DIR="/home/z/my-project/download"
OUT="$DEST_DIR/OpenCometAI-SIH-v1.15.2.zip"
cd "$ROOT"

echo "== pre-flight spot checks =="
fail() { echo "PRE-FLIGHT FAIL: $1"; exit 1; }
grep -q '"version": "1.15.2"' manifest.json || fail "manifest version"
grep -q '"tabGroups"' manifest.json || fail "tabGroups permission"
# ── v1.15.0/1.15.1 features still intact ──
test -f src/lib/tab-sandbox.js && grep -q "ensureTaskGroup" src/lib/tab-sandbox.js || fail "tab-sandbox module"
grep -q "Tab-group sandbox" src/background/sw.js || fail "sw.js privacy-start grouping"
grep -q "isMailHostTab" src/background/actions.js || fail "actions.js mail gate"
grep -q "sandboxTabIds" src/lib/privacy-agent.js || fail "privacy-agent capture sandbox"
grep -q "pathToFileURL" OpenCometBench/browser/harness.mjs || fail "harness pathToFileURL fix (protected)"
grep -q "typeof type === 'string' ? { type } : type" src/background/sw.js || fail "broadcast normalization (stop-button fix)"
grep -q "requestActionApproval" src/background/sw.js || fail "ask-before-acting gate (sw)"
grep -q "askBeforeActing" src/background/privacy-loop.js || fail "loop gate wiring"
grep -q "alreadyInState" src/background/actions.js || fail "media already-in-state"
grep -q "userNotes: userContext" src/background/privacy-loop.js || fail "live user-context drain"
grep -q "logVlmRequest" src/lib/providers.js || fail "VLM request logging"
grep -q "logVlmRawText" src/lib/providers.js || fail "VLM raw/response logging"
grep -q "min-width: 0" src/sidepanel/sidepanel.css || fail "model pill ellipsis fix"
if grep -q "privacyConfigureBtn" src/sidepanel/sidepanel.html; then fail "sun icon still in HTML"; fi
# ── v1.15.2 features ──
grep -q 'PARTIAL / MID-ENTRY PAN' src/lib/pii-detector.js || fail "partial PAN pattern"
grep -q "type: 'voter_id'" src/lib/pii-detector.js || fail "voter_id pattern"
grep -q "type: 'gstin'" src/lib/pii-detector.js || fail "gstin pattern"
grep -q "type: 'upi'" src/lib/pii-detector.js || fail "upi pattern"
grep -q "type: 'ifsc'" src/lib/pii-detector.js || fail "ifsc pattern"
grep -q "type: 'bank_account'" src/lib/pii-detector.js || fail "bank_account pattern"
grep -q "s.length !== 12 && s.length !== 16" src/lib/pii-detector.js || fail "verhoeff VID 16"
grep -q "\\\\bpan(?:(?:card" src/lib/pii-detector.js || grep -q 'bpan(?:card' src/lib/pii-detector.js || fail "DOM hint bare pan"
grep -q "PER-TASK PRIVACY CENSUS" src/background/privacy-loop.js || fail "privacy-loop census"
grep -q "redactions: runPii.faces" src/background/privacy-loop.js || fail "privacy census in DONE summary"
grep -q "live-task-privacy" src/sidepanel/sidepanel.html || fail "live-task scorecard row"
grep -q "opencometSihLiveRun" src/sidepanel/sidepanel.js || fail "live run persistence"
grep -q "case 'voter_id':" src/lib/canvas-redactor.js || fail "redactor Indian ID group"
grep -q "Indian ID family" docs/PRIVACY_VISION.md || fail "PRIVACY_VISION doc row"
grep -q "v1.15.2" docs/SIH_READINESS.md || fail "readiness v1.15.2 section"
grep -q "Indian ID expansion + live per-task scorecard (v1.15.2)" README.md || fail "README v1.15.2 section"
if grep -q "privacyConfigureBtn" src/sidepanel/sidepanel.html; then fail "sun icon still in HTML"; fi
if grep -R "nvapi-" --include='*.js' --include='*.json' --include='*.mjs' --include='*.md' . >/dev/null 2>&1; then
  grep -R "nvapi-" --include='*.js' --include='*.json' --include='*.mjs' --include='*.md' . | head -3
  fail "API key material found in tree"
fi
node scripts/test_indian_pii.mjs >/dev/null 2>&1 || fail "Indian PII unit tests must pass"
node scripts/test_tab_sandbox.mjs >/dev/null 2>&1 || fail "sandbox unit tests must pass"
node scripts/test_v1151_panel.mjs >/dev/null 2>&1 || fail "v1.15.1 panel regression suite"
node OpenCometBench/privacy.bench.js 2>/dev/null | grep -q '"pass": true' || fail "privacy bench"
node OpenCometBench/fuzz.test.js 2>/dev/null | grep -q '"pass": true' || fail "fuzz bench"
node OpenCometBench/security.test.js 2>/dev/null | grep -q '"pass": true' || fail "security bench"
test -f OpenCometBench/results/browser-benchmark-1788731519242.json || fail "authoritative browser report"
test -f OpenCometBench/results/e2e-benchmark-1788901453012.json || fail "v1.15 e2e-mock report"
echo "pre-flight OK"

echo "== staging =="
mkdir "$STAGE/OpenCometAI-SIH"
rsync -a --exclude '.git' --exclude 'node_modules' ./ "$STAGE/OpenCometAI-SIH/" 2>/dev/null || {
  cp -r "$ROOT/." "$STAGE/OpenCometAI-SIH/"
  rm -rf "$STAGE/OpenCometAI-SIH/.git" "$STAGE/OpenCometAI-SIH/node_modules"
}
find "$STAGE/OpenCometAI-SIH" -exec touch -t 202609100000 {} +
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
