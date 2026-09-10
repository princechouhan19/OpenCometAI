#!/usr/bin/env bash
# scripts/package_v1151.sh — deterministic release packaging for OpenCometAI-SIH v1.15.1.
# Pre-flight spot checks → clean staging → deterministic mtimes → zip -9 -X →
# unzip -t + round-trip byte-diff → SHA256 → copy to /home/z/my-project/download/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
DEST_DIR="/home/z/my-project/download"
OUT="$DEST_DIR/OpenCometAI-SIH-v1.15.1.zip"
cd "$ROOT"

echo "== pre-flight spot checks =="
fail() { echo "PRE-FLIGHT FAIL: $1"; exit 1; }
grep -q '"version": "1.15.1"' manifest.json || fail "manifest version"
grep -q '"tabGroups"' manifest.json || fail "tabGroups permission"
# ── v1.15.0 features still intact ──
test -f src/lib/tab-sandbox.js && grep -q "ensureTaskGroup" src/lib/tab-sandbox.js || fail "tab-sandbox module"
grep -q "Tab-group sandbox" src/background/sw.js || fail "sw.js privacy-start grouping"
grep -q "isMailHostTab" src/background/actions.js || fail "actions.js mail gate"
grep -q "tabNavigationSignal" src/background/actions.js || fail "actions.js navigation lens"
grep -q "sandboxTabIds" src/lib/privacy-agent.js || fail "privacy-agent capture sandbox"
grep -q "pathToFileURL" OpenCometBench/browser/harness.mjs || fail "harness pathToFileURL fix (protected)"
# ── v1.15.1 features ──
grep -q "typeof type === 'string' ? { type } : type" src/background/sw.js || fail "broadcast normalization (stop-button fix)"
grep -q "requestActionApproval" src/background/sw.js || fail "ask-before-acting gate (sw)"
grep -q "resolveAllActionApprovals" src/background/sw.js || fail "approval waiters"
grep -q "askBeforeActing" src/background/privacy-loop.js || fail "loop gate wiring"
grep -q "alreadyInState" src/background/actions.js || fail "media already-in-state"
grep -q "alreadyInState" src/background/privacy-loop.js || fail "loop already-in-state accounting"
grep -q "userNotes: userContext" src/background/privacy-loop.js || fail "live user-context drain"
grep -q "USER CONTEXT (typed by the user DURING this task" src/lib/privacy-agent.js || fail "prompt user-context block"
grep -q "logVlmRequest" src/lib/providers.js || fail "VLM request logging"
grep -q "logVlmRawText" src/lib/providers.js || fail "VLM raw/response logging"
grep -q "opencometAgentMode" src/sidepanel/sidepanel.js || fail "mode persistence"
grep -q "Ask before acting" src/sidepanel/sidepanel.js || fail "approval card kinds"
grep -q "min-width: 0" src/sidepanel/sidepanel.css || fail "model pill ellipsis fix"
if grep -q "privacyConfigureBtn" src/sidepanel/sidepanel.html; then fail "sun icon still in HTML"; fi
if grep -R "nvapi-" --include='*.js' --include='*.json' --include='*.mjs' --include='*.md' . >/dev/null 2>&1; then
  grep -R "nvapi-" --include='*.js' --include='*.json' --include='*.mjs' --include='*.md' . | head -3
  fail "API key material found in tree"
fi
node scripts/test_tab_sandbox.mjs >/dev/null 2>&1 || fail "sandbox unit tests must pass"
grep -q "v1.15.1" docs/SIH_READINESS.md || fail "readiness v1.15.1 section"
grep -q "Human-in-the-loop + honest no-ops (v1.15.1)" README.md || fail "README v1.15.1 section"
test -f OpenCometBench/results/browser-benchmark-1788731519242.json || fail "authoritative browser report"
test -f OpenCometBench/results/e2e-benchmark-1788901453012.json || fail "v1.15 e2e-mock report"
test -f scripts/test_v1151_panel.mjs || fail "v1.15.1 panel regression suite"
echo "pre-flight OK"

echo "== staging =="
mkdir "$STAGE/OpenCometAI-SIH"
rsync -a --exclude '.git' --exclude 'node_modules' ./ "$STAGE/OpenCometAI-SIH/" 2>/dev/null || {
  cp -r "$ROOT/." "$STAGE/OpenCometAI-SIH/"
  rm -rf "$STAGE/OpenCometAI-SIH/.git" "$STAGE/OpenCometAI-SIH/node_modules"
}
find "$STAGE/OpenCometAI-SIH" -exec touch -t 202609090000 {} +
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
