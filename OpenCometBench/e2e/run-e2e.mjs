#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// OpenCometBench/e2e/run-e2e.mjs — SIH v1.13 END-TO-END benchmark.
//
// Loads the REAL extension (unpacked) into Chromium via Playwright, points its
// decision endpoint at the scripted mock-VLM server (real /agent/decide
// contract incl. the privacy-verification envelope + inbound validation), and
// runs 10 reproducible tasks through the REAL privacy agent loop:
//
//   capture (chrome.tabs/debugger) → perception pipeline (offscreen) →
//   sanitize → network gate → server validation → action → verification
//
//   1. find-and-open      "Open the Pricing page"
//   2. search-info        "Search for quantum"
//   3. navigate-form      "Fill the newsletter form and submit"
//   4. play-media         "Pause the video"
//   5. safe-form          "Complete the checkout form"
//   6. banking-transfer   "Transfer funds between accounts"
//   7. gov-application    "Submit the scheme application"
//   8. canvas-clear       "Clear the drawing canvas"
//   9. article-navigation "Read the full article"
//  10. mixed-pii-contact  "Save the new contact"
//
// Per step, the loop's own timing log (privacy-loop.js) is parsed:
//   "Step N took Xms (sanitize Ams · VLM Bms · action Cms)"
// The VLM leg is MOCK (scripted decisions) — everything else is the real
// extension runtime. The report labels this honestly.
//
//   node OpenCometBench/e2e/run-e2e.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { startMockVlm } from './mock-vlm.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'OpenCometBench', 'results');
const BASE = 'http://127.0.0.1:8890';
const SERVER_URLS = { mock: 'http://127.0.0.1:8892' };

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.tflite': 'application/octet-stream', '.gz': 'application/gzip' };
function serve() {
  return new Promise((res) => {
    const srv = createServer((req, resp) => {
      let p = decodeURIComponent(new URL(req.url, BASE).pathname);
      const file = join(ROOT, p);
      if (!file.startsWith(ROOT) || !existsSync(file)) { resp.writeHead(404); resp.end('nf'); return; }
      resp.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      resp.end(readFileSync(file));
    });
    srv.listen(8890, '127.0.0.1', () => res(srv));
  });
}

const SCENARIOS = [
  { id: 'find-and-open', page: '/OpenCometBench/e2e/pages/nav-links.html', task: 'Open the Pricing page' },
  { id: 'search-info', page: '/OpenCometBench/e2e/pages/search.html', task: 'Search for quantum' },
  { id: 'navigate-form', page: '/OpenCometBench/e2e/pages/newsletter.html', task: 'Fill the newsletter form and submit' },
  { id: 'media-control', page: '/OpenCometBench/pages/media.html', task: 'Mute the video' },
  { id: 'safe-form', page: '/OpenCometBench/e2e/pages/checkout.html', task: 'Complete the checkout form' },
  // v1.14 expansion (SIH brief Task 8): +5 scenarios, synthetic data only.
  { id: 'banking-transfer', page: '/OpenCometBench/e2e/pages/banking.html', task: 'Transfer funds between accounts' },
  { id: 'gov-application', page: '/OpenCometBench/e2e/pages/gov-form.html', task: 'Submit the scheme application' },
  { id: 'canvas-clear', page: '/OpenCometBench/e2e/pages/canvas-app.html', task: 'Clear the drawing canvas' },
  { id: 'article-navigation', page: '/OpenCometBench/e2e/pages/article.html', task: 'Read the full article' },
  { id: 'mixed-pii-contact', page: '/OpenCometBench/e2e/pages/mixed-pii.html', task: 'Save the new contact' },
];

const STEP_RE = /Step (\d+) took ([\d.]+)s \(sanitize ([\d.]+)ms · VLM ([\d.]+)ms · action ([\d.]+)ms\)/g;
const VERIFY_LINE_RE = /^\[Open Comet\]\[VERIFY\] (\{.*\})$/;

const pct = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };
const r3 = (v) => Math.round(v * 1000) / 1000;

async function main() {
  const srv = await serve();
  const mock = await startMockVlm(8892);
  mkdirSync(OUT_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  // Unpacked extension id = sha256(abs path) hex → a..p (first 32 chars).
  const extId = crypto.createHash('sha256').update(ROOT).digest('hex').slice(0, 32)
    .split('').map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');

  // Wake the MV3 worker, then wait for it.
  const wake = await context.newPage();
  await wake.goto(`${BASE}/OpenCometBench/pages/login.html`).catch(() => {});
  await wake.waitForTimeout(1200);
  let sw = null;
  for (let i = 0; i < 30 && !sw; i++) {
    sw = context.serviceWorkers().find(w => w.url().includes(extId));
    if (!sw) await new Promise(r => setTimeout(r, 500));
  }
  if (!sw) { console.error('service worker never appeared'); process.exit(1); }
  console.log('extension SW online:', sw.url());

  const swErrors = [];
  sw.on('pageerror', (e) => swErrors.push(String(e).slice(0, 300)));

  // IMPORTANT: leave the provider UNCONFIGURED so the privacy loop routes its
  // decision through the COMPANION-SERVER path (the real /agent/decide
  // contract incl. the privacy-verification envelope + inbound validation),
  // pointed at the scripted mock below. Clear any stored provider first.
  await sw.evaluate(async () => {
    const key = 'opencometSettings';
    const data = await chrome.storage.local.get(key);
    const settings = { ...(data[key] || {}) };
    delete settings.provider; delete settings.providerBaseUrl; delete settings.apiKey;
    await chrome.storage.local.set({ [key]: settings });
    return true;
  }).catch((e) => { console.error('settings setup failed:', e.message); process.exit(1); });

  const results = [];
  for (const sc of SCENARIOS) {
    console.log(`\n[e2e] ${sc.id}: "${sc.task}"`);
    const page = await context.newPage();
    const steps = [];
    let swLog = '';
    // MV3 workers die when idle — re-resolve the CURRENT worker each scenario.
    const currentSw = () => context.serviceWorkers().find(w => w.url().includes(extId)) || sw;
    const onConsole = (msg) => { const t = msg.text(); swLog += t + '\n'; };
    currentSw().on('console', onConsole);

    await page.goto(`${BASE}${sc.page}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    sw = context.serviceWorkers().find(w => w.url().includes(extId)) || sw;
    if (!sw) { console.log('  SW dead before start'); continue; }

    // Start the privacy task from an extension page context (runtime message).
    // The TASK page must be the ACTIVE tab when the message lands — the start
    // handler captures chrome.tabs.query({active:true}) and would otherwise
    // navigate the panel itself (an extension page).
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`).catch(() => {});
    await panel.waitForTimeout(1200);           // extension page fully alive
    await page.bringToFront();
    await page.waitForTimeout(400);
    const startResp = await panel.evaluate(({ task, mockUrl }) => new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ type: 'PRIVACY_START', task, privacy: { serverUrl: mockUrl } }, (r) => {
          const le = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
          res({ r: r || null, le });
        });
      } catch (e) { res({ err: e.message }); }
    }), { task: sc.task, mockUrl: SERVER_URLS.mock }).catch((e) => ({ err: e.message }));
    if (!startResp?.r?.ok) console.log(`  start: ${JSON.stringify(startResp)}`);

    // Wait for completion (loop logs "PRIVACY TASK COMPLETE" / agent done) or timeout.
    const t0 = Date.now();
    let finished = false;
    while (Date.now() - t0 < 90000) {
      await new Promise(r => setTimeout(r, 1000));
      if (/PRIVACY TASK COMPLETE|AGENT_DONE|task complete/i.test(swLog)) { finished = true; break; }
      const last = [...swLog.matchAll(STEP_RE)].pop();
      if (last && Number(last[1]) >= 8) break;         // step cap
      if (/ask_user/i.test(swLog) && last) break;       // mock misfire guard
    }
    currentSw().off('console', onConsole);

    for (const m of swLog.matchAll(STEP_RE)) {
      steps.push({ step: Number(m[1]), totalMs: Math.round(parseFloat(m[2]) * 1000), sanitizeMs: Math.round(parseFloat(m[3])), vlmMs: Math.round(parseFloat(m[4])), actionMs: Math.round(parseFloat(m[5])) });
    }
    // v1.14: attach the FOUR-STATE verification from the structured [VERIFY]
    // lines the loop now emits (machine-parseable — no more guessing from
    // human-readable logs, which mis-aligned media/typing verification).
    const verifyStates = [];
    for (const line of swLog.split('\n')) {
      const m = VERIFY_LINE_RE.exec(line.trim());
      if (!m) continue;
      try { verifyStates.push(JSON.parse(m[1])); } catch { /* skip malformed */ }
    }
    for (const s of steps) {
      const v = verifyStates.filter(x => x.step === s.step);
      s.verifyStates = v.map(x => ({ state: x.state, action: x.action, summary: x.summary, queued: Boolean(x.queued), auto: Boolean(x.auto) }));
      // primary-state per step: worst of the states in that step
      // (VERIFICATION_FAILED < ACTION_VERIFIED for honesty; ACTION_FAILED worst)
      s.state = v.length
        ? (v.some(x => x.state === 'ACTION_FAILED') ? 'ACTION_FAILED'
          : v.every(x => x.state === 'ACTION_VERIFIED') ? 'ACTION_VERIFIED'
          : v.some(x => x.state === 'VERIFICATION_FAILED') ? 'VERIFICATION_FAILED'
          : 'ACTION_EXECUTED')
        : 'NO_VERIFY_LINE';
    }

    results.push({
      id: sc.id, task: sc.task, page: sc.page, finished, steps,
      totalMs: steps.reduce((a, s) => a + s.totalMs, 0),
      stepCount: steps.length,
      verified: steps.filter(s => s.state === 'ACTION_VERIFIED').length,
      verifyFailed: steps.filter(s => s.state === 'VERIFICATION_FAILED').length,
      failed: steps.filter(s => s.state === 'ACTION_FAILED').length,
    });
    console.log(`  steps=${steps.length} finished=${finished} states=${steps.map(s => s.state).join(',')}`);
    // v1.14: surface the loop's own media/verify lines — without them a
    // VERIFICATION_FAILED scenario is undebuggable (measured on media-control).
    const mediaLines = swLog.split('\n').filter(l => /\[Open Comet\] (Media|Step)|\[VERIFY\]/.test(l));
    for (const l of mediaLines.slice(0, 6)) console.log(`    ↳ ${l.slice(0, 180)}`);
    if (!steps.length) {
      const tail = swLog.split('\n').filter(Boolean).slice(-8).join('\n  ');
      console.log(`  ↳ sw log tail:\n  ${tail}`);
    }
    await page.close().catch(() => {});
    await panel.close().catch(() => {});
  }

  // Aggregate (all scenario steps).
  const allSteps = results.flatMap(r => r.steps);
  // v1.14 FOUR-STATE accounting. verifiedActionRatio is computed over actions
  // that CARRIED a verification instrument (VERIFIED + VERIFICATION_FAILED),
  // not over all steps — an action with no verifier is counted in execution
  // success, not in verification success. No metric merges the two.
  const verifyCarrying = allSteps.filter(s => s.state === 'ACTION_VERIFIED' || s.state === 'VERIFICATION_FAILED');
  const aggregate = {
    steps: allSteps.length,
    verifyStates: {
      ACTION_VERIFIED: allSteps.filter(s => s.state === 'ACTION_VERIFIED').length,
      VERIFICATION_FAILED: allSteps.filter(s => s.state === 'VERIFICATION_FAILED').length,
      ACTION_EXECUTED: allSteps.filter(s => s.state === 'ACTION_EXECUTED').length,
      ACTION_FAILED: allSteps.filter(s => s.state === 'ACTION_FAILED').length,
      NO_VERIFY_LINE: allSteps.filter(s => s.state === 'NO_VERIFY_LINE').length,
    },
    verifiedActionRatio: r3(verifyCarrying.filter(s => s.state === 'ACTION_VERIFIED').length / Math.max(1, verifyCarrying.length)),
    executionSuccessRatio: r3(allSteps.filter(s => s.state !== 'ACTION_FAILED' && s.state !== 'NO_VERIFY_LINE').length / Math.max(1, allSteps.length)),
    taskSuccessRatio: r3(results.filter(r => r.finished).length / Math.max(1, results.length)),
    sanitizeMs: { p50: pct(allSteps.map(s => s.sanitizeMs), 0.5), p90: pct(allSteps.map(s => s.sanitizeMs), 0.9), p95: pct(allSteps.map(s => s.sanitizeMs), 0.95) },
    vlmMs_mock: { p50: pct(allSteps.map(s => s.vlmMs), 0.5), p90: pct(allSteps.map(s => s.vlmMs), 0.9), p95: pct(allSteps.map(s => s.vlmMs), 0.95) },
    actionMs: { p50: pct(allSteps.map(s => s.actionMs), 0.5), p90: pct(allSteps.map(s => s.actionMs), 0.9), p95: pct(allSteps.map(s => s.actionMs), 0.95) },
    stepTotalMs: { p50: pct(allSteps.map(s => s.totalMs), 0.5), p90: pct(allSteps.map(s => s.totalMs), 0.9), p95: pct(allSteps.map(s => s.totalMs), 0.95) },
  };

  const report = {
    meta: {
      type: 'e2e',
      benchmark: 'real-extension-loop',
      vlm: 'mock',
      generatedAt: new Date().toISOString(),
      note: 'REAL extension (unpacked) run end-to-end through capture → perception → sanitize → network gate → server validation → action → verification. VLM decisions are MOCK (scripted) — vlmMs measures the real network + validation round trip against the decision endpoint, not model inference. Real-VLM runs are a separate benchmark (run-e2e-real.mjs) and are never merged with this one.',
      scenarios: SCENARIOS.map(s => ({ id: s.id, task: s.task })),
      swErrors,
    },
    mockVlmCalls: mock.calls.length,
    aggregate,
    scenarios: results,
  };
  const out = join(OUT_DIR, `e2e-benchmark-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${out}`);
  console.log(JSON.stringify(aggregate, null, 1));

  await context.close();
  mock.server.close();
  srv.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
