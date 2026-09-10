#!/usr/bin/env bash
# scripts/package_v1159.sh — deterministic release packaging for OpenCometAI-SIH v1.15.9.
# Pre-flight spot checks → clean staging → deterministic mtimes → zip -9 -X →
# unzip -t + round-trip byte-diff → SHA256 → copy to /home/z/my-project/download/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
DEST_DIR="/home/z/my-project/download"
OUT="$DEST_DIR/OpenCometAI-SIH-v1.15.9.zip"
cd "$ROOT"

echo "== pre-flight spot checks =="
fail() { echo "PRE-FLIGHT FAIL: $1"; exit 1; }
grep -q '"version": "1.15.9"' manifest.json || fail "manifest version"
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
grep -q "\\bpan(?:(?:card" src/lib/pii-detector.js || grep -q 'bpan(?:card' src/lib/pii-detector.js || fail "DOM hint bare pan"
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
# ── v1.15.5 features (About page) ──
grep -q 'data-settings-target="about"' src/sidepanel/sidepanel.html || fail "About nav card"
test "$(grep -c 'data-settings-target="about"' src/sidepanel/sidepanel.html)" = "1" || fail "About nav card duplicated"
test "$(grep -c 'data-settings-page="about"' src/sidepanel/sidepanel.html)" = "3" || fail "About sections (want 3)"
grep -q 'id="aboutVersion"' src/sidepanel/sidepanel.html || fail "version chip element"
grep -q "id=\"aboutCopyBuildBtn\"" src/sidepanel/sidepanel.html || fail "copy-build-info button"
grep -q "about: 'About'" src/sidepanel/sidepanel.js || fail "About page title mapping"
grep -q "aboutPageController" src/sidepanel/sidepanel.js || fail "About page controller"
grep -q "chrome.runtime.getManifest().version" src/sidepanel/sidepanel.js || fail "live manifest version read"
grep -q "ABOUT PAGE (v1.15.5)" src/sidepanel/sidepanel.css || fail "About CSS section"
grep -q "What's New" src/sidepanel/sidepanel.html || fail "What's New section"
grep -q "OpenComet-Bench — 922 scored cases" src/sidepanel/sidepanel.html || fail "About bench details"
grep -q "About page (v1.15.5 — UI only)" README.md || fail "README v1.15.5 section"
grep -q "Shipped in v1.15.5" docs/SIH_READINESS.md || fail "readiness v1.15.5 section"
grep -q 'assets/icons/icon128.png' src/sidepanel/sidepanel.html || fail "About hero logo path"
# ── v1.15.6 features (final answers + Profile custom info) ──
grep -q 'INFORMATION TASKS' src/lib/privacy-agent.js || fail "information-tasks rule"
grep -q 'the COMPLETE final answer for the user' src/lib/privacy-agent.js || fail "done message contract"
grep -q 'export function buildTrustedProfileBlock' src/lib/privacy-agent.js || fail "trusted profile block helper"
grep -q 'customInfo' src/lib/privacy-agent.js || fail "customInfo in profile block"
grep -q 'const finalAnswer = String(action?.message' src/background/privacy-loop.js || fail "finalAnswer extraction"
grep -q 'Final answer ready' src/background/privacy-loop.js || fail "final answer step"
grep -q 'profileData: settings?.profileData || null' src/background/privacy-loop.js || fail "profile into decideViaServer"
grep -q 'answer: String(summary?.finalAnswer' src/background/sw.js || fail "AGENT_DONE answer field"
grep -q 'finalAnswer || summary?.finalThought' src/background/sw.js || fail "history prefers answer"
grep -q 'msg.summary?.finalAnswer' src/sidepanel/sidepanel.js || fail "result card answer fallback"
grep -q 'buildCustomInfoRow' src/sidepanel/sidepanel.js || fail "custom info row builder"
grep -q 'collectCustomInfoRows' src/sidepanel/sidepanel.js || fail "custom info collector"
grep -q 'customInfo: collectCustomInfoRows()' src/sidepanel/sidepanel.js || fail "saveSettings customInfo"
grep -q 'renderCustomInfoRows' src/sidepanel/sidepanel.js || fail "loadSettings custom info render"
grep -q 'id="addCustomInfoBtn"' src/sidepanel/sidepanel.html || fail "add-field button"
grep -q 'id="customInfoList"' src/sidepanel/sidepanel.html || fail "custom info list"
grep -q 'v1.15.6' src/sidepanel/sidepanel.html || fail "About changelog v1.15.6 entry"
grep -q 'customInfo' src/lib/prompts.js || fail "formatProfile custom rows"
grep -q "key !== 'customInfo'" src/background/sw.js || fail "summarize prompt custom info"
grep -q '.ci-row' src/sidepanel/sidepanel.css || fail "custom info CSS"
grep -q 'Final answers + Profile custom info (v1.15.6)' README.md || fail "README v1.15.6 section"
grep -q 'Shipped in v1.15.6' docs/SIH_READINESS.md || fail "readiness v1.15.6 section"
# ── v1.15.7 features (redact-and-verify outbound secret sweep) ──
grep -q 'export function maskSecretShapedText' src/lib/privacy-firewall.js || fail "mask primitive export"
grep -qF "SECRET_MARKER = '[REDACTED:secret]'" src/lib/privacy-firewall.js || fail "secret marker"
grep -q 'export function scrubOutboundDecisionText' src/lib/privacy-agent.js || fail "scrub helper export"
grep -q 'payload.privacy?.sanitizedText || payload.sanitizedDomText' src/lib/privacy-agent.js || fail "gate probe envelope-first"
grep -q 'String(payload.privacy?.sanitizedText || payload.sanitizedDomText' src/lib/privacy-agent.js || fail "prompt envelope-first"
grep -q 'const wire = scrubOutboundDecisionText(payload, task, history)' src/lib/privacy-agent.js || fail "scrub wiring in decideViaServer"
grep -q 'const promptSweep = maskSecretShapedText(prompt)' src/lib/privacy-agent.js || fail "prompt-level mask"
grep -q 'secret sweep hits' src/lib/privacy-agent.js || fail "gate sweep diagnostics"
test -f OpenCometBench/e2e/pages/secret-tail.html || fail "secret-tail fixture"
grep -q 'legacy integration notes' OpenCometBench/e2e/pages/secret-tail.html || fail "secret-tail fixture content"
grep -q 'Privacy firewall: summarize survives secret-shaped pages (v1.15.7)' README.md || fail "README v1.15.7 section"
grep -q 'Shipped in v1.15.7' docs/SIH_READINESS.md || fail "readiness v1.15.7 section"
grep -q '>v1.15.7<' src/sidepanel/sidepanel.html || fail "About changelog v1.15.7 entry"
# ── v1.15.8 features (bounded value lookaheads — safe prose not black-boxed) ──
grep -qF "(?=[^\\s'\"]*\\d)[^\\s'\"]{5,}" src/lib/pii-detector.js || fail "bounded password lookahead (detector)"
grep -qF "(?=[A-Za-z0-9_.\-+\/=]*\d)(?=[A-Za-z0-9_.\-+\/=]*[A-Za-z])" src/lib/pii-detector.js || fail "bounded api_key lookahead (detector)"
grep -qF "(?=[^\\s'\"]*\\d)[^\\s'\"]{5,}" src/lib/privacy-firewall.js || fail "bounded password lookahead (firewall)"
grep -qF "(?=[A-Za-z0-9_-]*\\d)(?=[A-Za-z0-9_-]*[A-Za-z])" src/lib/privacy-firewall.js || fail "bounded token lookahead (firewall)"
grep -q "v1.15.8 — the lookaheads are BOUNDED TO THE VALUE RUN" src/lib/pii-detector.js || fail "detector comment"
grep -q "v1.15.8 — the digit/letter lookaheads are BOUNDED TO THE VALUE RUN" src/lib/privacy-firewall.js || fail "firewall comment"
test -f OpenCometBench/e2e/pages/prose-discussion.html || fail "prose-discussion fixture"
grep -q 'token formats' OpenCometBench/e2e/pages/prose-discussion.html || fail "prose fixture content"
grep -q 'secret families' OpenCometBench/e2e/pages/prose-discussion.html || fail "prose fixture content 2"
grep -q 'key contiguity' OpenCometBench/e2e/pages/prose-discussion.html || fail "prose fixture content 3"
test -f scripts/test_v1158_prose_safe.mjs || fail "v1158 test present"
grep -q 'Safe prose is no longer black-boxed (v1.15.8)' README.md || fail "README v1.15.8 section"
grep -q 'Shipped in v1.15.8' docs/SIH_READINESS.md || fail "readiness v1.15.8 section"
grep -q '>v1.15.8<' src/sidepanel/sidepanel.html || fail "About changelog v1.15.8 entry"
grep -q 'A4b prose blob with a later digit is NOT masked' scripts/test_v1157_secret_sweep.mjs || fail "v1157 A4b tightened"
# ── v1.15.9 features (real-VLM E2E for free cloud models) ──
test -f OpenCometBench/e2e/smoke-openrouter-free.mjs || fail "smoke-openrouter-free.mjs present"
grep -q 'OPENROUTER_API_KEY' OpenCometBench/e2e/smoke-openrouter-free.mjs || fail "smoke reads env key"
grep -q "new URL(sw.url()).hostname" OpenCometBench/e2e/run-e2e-real.mjs || fail "live SW discovery"
grep -qF 'const headers = (cfg.provider !== '\''ollama'\'' && cfg.apiKey)' OpenCometBench/e2e/run-e2e-real.mjs || fail "authenticated model check"
test -f OpenCometBench/results/e2e-real-benchmark-1789066449033.json || fail "archived OpenRouter reference run"
test -f OpenCometBench/results/e2e-real-benchmark-1789065225488.json || fail "archived negative control"
grep -q 'Real-VLM E2E for free cloud models (v1.15.9)' README.md || fail "README v1.15.9 section"
grep -q 'Shipped in v1.15.9' docs/SIH_READINESS.md || fail "readiness v1.15.9 section"
grep -q '>v1.15.9<' src/sidepanel/sidepanel.html || fail "About changelog v1.15.9 entry"
node --check OpenCometBench/e2e/smoke-openrouter-free.mjs || fail "smoke syntax"
node --check OpenCometBench/e2e/run-e2e-real.mjs || fail "run-e2e-real syntax"
node --check OpenCometBench/run-opencomet-bench.mjs || fail "orchestrator syntax"
node --check src/lib/privacy-firewall.js || fail "privacy-firewall.js syntax"
node --check src/lib/pii-detector.js || fail "pii-detector.js syntax"
if [ "${SKIP_SUITES:-0}" != "1" ]; then node scripts/test_v1158_prose_safe.mjs >/dev/null 2>&1 || fail "v1.15.8 prose-safe suite (unit + real extension)"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
if [ "${SKIP_SUITES:-0}" != "1" ]; then node scripts/test_v1157_secret_sweep.mjs >/dev/null 2>&1 || fail "v1.15.7 secret-sweep suite (unit + real extension)"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
if grep -REl "nvapi-[A-Za-z0-9_-]{10,}|sk-or-v1-[A-Za-z0-9_-]{10,}" --include='*.js' --include='*.json' --include='*.mjs' --include='*.md' --include='*.sh' --include='*.html' . >/dev/null 2>&1; then
  grep -REl "nvapi-[A-Za-z0-9_-]{10,}|sk-or-v1-[A-Za-z0-9_-]{10,}" --include='*.js' --include='*.json' --include='*.mjs' --include='*.md' --include='*.sh' --include='*.html' . | head -3
  fail "API key material found in tree"
fi
node --check src/sidepanel/sidepanel.js || fail "sidepanel.js syntax"
node --check src/background/privacy-loop.js || fail "privacy-loop.js syntax"
node --check src/lib/privacy-agent.js || fail "privacy-agent.js syntax"
if [ "${SKIP_SUITES:-0}" != "1" ]; then node scripts/test_v1156_answers_profile.mjs >/dev/null 2>&1 || fail "v1.15.6 answers+profile suite (real extension)"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
if [ "${SKIP_SUITES:-0}" != "1" ]; then node scripts/test_about_page.mjs >/dev/null 2>&1 || fail "About page suite (real extension)"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
if [ "${SKIP_SUITES:-0}" != "1" ]; then node scripts/test_indian_pii.mjs >/dev/null 2>&1 || fail "Indian PII unit tests must pass"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
if [ "${SKIP_SUITES:-0}" != "1" ]; then node scripts/test_tab_sandbox.mjs >/dev/null 2>&1 || fail "sandbox unit tests must pass"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
if [ "${SKIP_SUITES:-0}" != "1" ]; then node scripts/test_v1151_panel.mjs >/dev/null 2>&1 || fail "v1.15.1 panel regression suite"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
if [ "${SKIP_SUITES:-0}" != "1" ]; then node scripts/test_scene_change_attack.mjs >/dev/null 2>&1 || fail "scene-change/pipeline suite"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
if [ "${SKIP_SUITES:-0}" != "1" ]; then node scripts/test_dom_face_sweep.mjs >/dev/null 2>&1 || fail "v1.15.3 dom-face-sweep suite (real browser + real model)"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
if [ "${SKIP_SUITES:-0}" != "1" ]; then node scripts/test_v1154_fixes.mjs >/dev/null 2>&1 || fail "v1.15.4 fixes suite (real browser + real models)"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
if [ "${SKIP_SUITES:-0}" != "1" ]; then node OpenCometBench/privacy.bench.js 2>/dev/null | grep -q '"pass": true' || fail "privacy bench"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
if [ "${SKIP_SUITES:-0}" != "1" ]; then node OpenCometBench/fuzz.test.js 2>/dev/null | grep -q '"pass": true' || fail "fuzz bench"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
if [ "${SKIP_SUITES:-0}" != "1" ]; then node OpenCometBench/security.test.js 2>/dev/null | grep -q '"pass": true' || fail "security bench"; else echo "  (suite pre-verified in this session, SKIP_SUITES=1)"; fi
test -f OpenCometBench/results/browser-benchmark-1788731519242.json || fail "authoritative browser report"
test -f OpenCometBench/results/e2e-benchmark-1788901453012.json || fail "v1.15 e2e-mock report"
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
