#!/usr/bin/env bash
# scripts/package_v1154.sh — deterministic release packaging for OpenCometAI-SIH v1.15.4.
# Pre-flight spot checks → clean staging → deterministic mtimes → zip -9 -X →
# unzip -t + round-trip byte-diff → SHA256 → copy to /home/z/my-project/download/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
DEST_DIR="/home/z/my-project/download"
OUT="$DEST_DIR/OpenCometAI-SIH-v1.15.4.zip"
cd "$ROOT"

echo "== pre-flight spot checks =="
fail() { echo "PRE-FLIGHT FAIL: $1"; exit 1; }
grep -q '"version": "1.15.4"' manifest.json || fail "manifest version"
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
# ── v1.15.2 features (Indian ID expansion + live scorecard) still intact ──
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
# ── v1.15.3 features (DOM-guided face sweep) ──
grep -q "PHOTO CANDIDATES" src/lib/privacy-agent.js || fail "photoCandidates collector"
grep -q "photoCandidates" src/lib/privacy-agent.js || fail "photoCandidates plumbing"
grep -q "sourceLabel" src/lib/mediapipe-face.js || fail "sourceLabel opt in crop sweep"
grep -q "3b′) DOM-guided face sweep" src/lib/privacy-filter.js || fail "dom-sweep stage 3b′"
grep -q "mediapipe-dom-crop" src/lib/privacy-filter.js || fail "dom-crop source tag"
grep -q "domSweep" src/lib/privacy-filter.js || fail "domSweep telemetry"
grep -q "DOM-guided image sweep (v1.15.3)" docs/PRIVACY_VISION.md || fail "PRIVACY_VISION cascade section"
grep -q "Small-profile-photo face redaction (v1.15.3)" README.md || fail "README v1.15.3 section"
grep -q "Hardening shipped in v1.15.3" docs/SIH_READINESS.md || fail "readiness v1.15.3 section"
# ── v1.15.4 features (avatar guard + name fields + pixel-only OCR ROI) ──
grep -q "3b″) AVATAR GUARD" src/lib/privacy-filter.js || fail "avatar-guard stage 3b″"
grep -q "dom-avatar-guard" src/lib/privacy-filter.js || fail "avatar-guard source tag"
grep -q "avatarGuard" src/lib/privacy-filter.js || fail "avatarGuard telemetry"
grep -q "bg-avatar-hint" src/lib/privacy-agent.js || fail "background-image avatar collector"
grep -q "NAME_FIELD_RE" src/lib/privacy-agent.js || fail "name-field regex (scan copy)"
grep -q "NAME_FIELD_RE" src/lib/pii-detector.js || fail "name-field regex (module copy)"
grep -q "labelTextsOf" src/lib/pii-detector.js || fail "label-aware hint blob"
grep -q "'name', 'given-name', 'additional-name', 'family-name'" src/lib/pii-detector.js || fail "autocomplete name tokens"
grep -q "pixelTextRects" src/lib/privacy-agent.js || fail "canvas ROI collector"
grep -q "pixelTextRects" src/lib/privacy-filter.js || fail "ROI plumbing into pipeline"
grep -q "rois: ocrRois" src/lib/privacy-filter.js || fail "ROI pass to OCR"
grep -q "ocrRoiRegions" src/lib/ocr-pii.js || fail "targeted OCR crop pass"
grep -q "runStructuralBattery" src/lib/ocr-pii.js || fail "OCR structural battery"
grep -q "phonePlausible" src/lib/ocr-pii.js || fail "battery plausibility guard"
grep -q "let textBudget = 400" src/lib/privacy-agent.js || fail "walker budget 400"
grep -q "Field-report hardening round two (v1.15.4)" README.md || fail "README v1.15.4 section"
grep -q "Hardening shipped in v1.15.4" docs/SIH_READINESS.md || fail "readiness v1.15.4 section"
grep -q "v1.15.3 DOM sweep + v1.15.4 avatar guard" docs/PRIVACY_VISION.md || fail "PRIVACY_VISION v1.15.4 cascade"
if grep -q "privacyConfigureBtn" src/sidepanel/sidepanel.html; then fail "sun icon still in HTML"; fi
if grep -R "nvapi-" --include='*.js' --include='*.json' --include='*.mjs' --include='*.md' . >/dev/null 2>&1; then
  grep -R "nvapi-" --include='*.js' --include='*.json' --include='*.mjs' --include='*.md' . | head -3
  fail "API key material found in tree"
fi
node scripts/test_indian_pii.mjs >/dev/null 2>&1 || fail "Indian PII unit tests must pass"
node scripts/test_tab_sandbox.mjs >/dev/null 2>&1 || fail "sandbox unit tests must pass"
node scripts/test_v1151_panel.mjs >/dev/null 2>&1 || fail "v1.15.1 panel regression suite"
node scripts/test_scene_change_attack.mjs >/dev/null 2>&1 || fail "scene-change/pipeline suite"
node scripts/test_dom_face_sweep.mjs >/dev/null 2>&1 || fail "v1.15.3 dom-face-sweep suite (real browser + real model)"
node scripts/test_v1154_fixes.mjs >/dev/null 2>&1 || fail "v1.15.4 fixes suite (real browser + real models)"
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
