#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// OpenCometBench/e2e/run-e2e-real.mjs — SIH v1.14 REAL-VLM END-TO-END benchmark.
//
// The mock-VLM run (run-e2e.mjs) measures the real extension loop with a
// SCRIPTED decision brain. THIS harness points the same real loop at a REAL
// model so vlmMs measures true inference + transport:
//
//   1. LOCAL OLLAMA (nothing leaves the machine):
//        node OpenCometBench/e2e/run-e2e-real.mjs --provider=ollama \
//             --model=qwen2.5v:7b [--ollama-url=http://127.0.0.1:11434]
//   2. CLOUD PROVIDER (the sanitized payload leaves the device — that is the
//      POINT of this tier: measure the real network leg + real model):
//        node OpenCometBench/e2e/run-e2e-real.mjs --provider=openai \
//             --model=gpt-4o-mini --api-key=sk-… [--base-url=…]
//        (any OpenAI-compatible gateway works with --provider=custom --base-url=…;
//         measured: OpenRouter custom gateway, inclusionai/ling-3.0-flash-vl:free —
//         see OpenCometBench/results/e2e-real-benchmark-1789066449033.json)
//
// KEY HYGIENE: pass the key as --api-key="$ENV_VAR" (e.g. OPENROUTER_API_KEY) —
// never hardcode it, never commit it. The report never contains the key.
//
// The report is meta.type "e2e-real" and meta.vlm "real:<provider>/<model>" —
// REAL results are NEVER merged with the mock-VLM numbers or with UNIT/BROWSER
// rows. No number in this report is asserted; every step timing comes from the
// loop's own log; task success is the loop's own completion signal.
//
// Output: OpenCometBench/results/e2e-real-benchmark-<ts>.json
// ─────────────────────────────────────────────────────────────────────────────
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'OpenCometBench', 'results');
const BASE = 'http://127.0.0.1:8893';

const argv = process.argv.slice(2);
const arg = (k, d = null) => {
  const a = argv.find(x => x.startsWith(`--${k}=`));
  return a ? a.split('=').slice(1).join('=') : d;
};
const PROVIDER = (arg('provider') || '').toLowerCase();     // ollama | openai | custom …
const MODEL = arg('model') || '';
const API_KEY = arg('api-key') || process.env.OPENCOMET_REAL_KEY || '';
const BASE_URL = arg('base-url') || '';
const OLLAMA_URL = arg('ollama-url') || 'http://127.0.0.1:11434';
const ONLY = arg('only');                                   // optional scenario filter

if (!PROVIDER || !MODEL) {
  const usage = 'usage: node OpenCometBench/e2e/run-e2e-real.mjs --provider=ollama --model=<vision-model>\n' +
    '       node OpenCometBench/e2e/run-e2e-real.mjs --provider=openai --model=gpt-4o-mini --api-key=sk-…\n' +
    '       node OpenCometBench/e2e/run-e2e-real.mjs --provider=custom --base-url=https://openrouter.ai/api/v1 \\\n' +
    '             --model=inclusionai/ling-3.0-flash-vl:free --api-key="$OPENROUTER_API_KEY" --only=find-and-open';
  console.error(usage);
  process.exit(1);
}
if (PROVIDER !== 'ollama' && !API_KEY) {
  console.error('refusing to run a cloud provider without --api-key (or OPENCOMET_REAL_KEY)');
  process.exit(1);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.tflite': 'application/octet-stream', '.gz': 'application/gzip' };
function serve() {
  return new Promise((res) => {
    const srv = createServer((req, resp) => {
      const file = join(ROOT, decodeURIComponent(new URL(req.url, BASE).pathname));
      if (!file.startsWith(ROOT) || !existsSync(file)) { resp.writeHead(404); resp.end('nf'); return; }
      resp.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      resp.end(readFileSync(file));
    });
    srv.listen(8893, '127.0.0.1', () => res(srv));
  });
}

const SCENARIOS = [
  { id: 'find-and-open', page: '/OpenCometBench/e2e/pages/nav-links.html', task: 'Open the Pricing page' },
  { id: 'search-info', page: '/OpenCometBench/e2e/pages/search.html', task: 'Search for quantum' },
  { id: 'navigate-form', page: '/OpenCometBench/e2e/pages/newsletter.html', task: 'Fill the newsletter form and submit' },
  { id: 'media-control', page: '/OpenCometBench/pages/media.html', task: 'Mute the video' },
  { id: 'safe-form', page: '/OpenCometBench/e2e/pages/checkout.html', task: 'Complete the checkout form' },
  { id: 'banking-transfer', page: '/OpenCometBench/e2e/pages/banking.html', task: 'Transfer funds between accounts' },
  { id: 'gov-application', page: '/OpenCometBench/e2e/pages/gov-form.html', task: 'Submit the scheme application' },
  { id: 'canvas-clear', page: '/OpenCometBench/e2e/pages/canvas-app.html', task: 'Clear the drawing canvas' },
  { id: 'article-navigation', page: '/OpenCometBench/e2e/pages/article.html', task: 'Read the full article' },
  { id: 'mixed-pii-contact', page: '/OpenCometBench/e2e/pages/mixed-pii.html', task: 'Save the new contact' },
];
const RUN = ONLY ? SCENARIOS.filter(s => ONLY.split(',').includes(s.id)) : SCENARIOS;

const STEP_RE = /Step (\d+) took ([\d.]+)s \(sanitize ([\d.]+)ms · VLM ([\d.]+)ms · action ([\d.]+)ms\)/g;
const VERIFY_LINE_RE = /^\[Open Comet\]\[VERIFY\] (\{.*\})$/;
const pct = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };
const r3 = (v) => Math.round(v * 1000) / 1000;

async function main() {
  const srv = await serve();
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

  // Service-worker discovery — live, not guessed: Chrome canonicalizes unpacked
  // extension paths before assigning an ID, so a hash-derived extId can miss.
  // Track the worker as it appears and derive the authoritative ID from it.
  let sw = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  context.on('serviceworker', (w) => {
    if (w.url().startsWith('chrome-extension://')) sw = w;
  });

  const wake = await context.newPage();
  await wake.goto(`${BASE}/OpenCometBench/pages/login.html`).catch(() => {});
  await wake.waitForTimeout(1200);

  for (let i = 0; i < 40 && !sw; i++) {
    sw = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
    if (!sw) await new Promise(r => setTimeout(r, 500));
  }
  if (!sw) { console.error('service worker never appeared'); process.exit(1); }
  const extId = new URL(sw.url()).hostname;
  console.log('extension SW online:', sw.url());

  // Configure the BYO PROVIDER path (real VLM). No companion server involved:
  // decideViaServer takes the direct-provider branch and calls the model with
  // the sanitized payload — the exact production path for BYO users.
  await sw.evaluate(async (cfg) => {
    const key = 'opencometSettings';
    const data = await chrome.storage.local.get(key);
    const settings = { ...(data[key] || {}) };
    settings.provider = cfg.provider;
    settings.model = cfg.model;
    settings.apiKey = cfg.apiKey || '';
    settings.providerBaseUrl = cfg.baseUrl || '';
    settings.ollamaBaseUrl = cfg.ollamaUrl || 'http://127.0.0.1:11434';
    settings.providerSupportsVision = true;
    await chrome.storage.local.set({ [key]: settings });
    return true;
  }, { provider: PROVIDER, model: MODEL, apiKey: API_KEY, baseUrl: BASE_URL, ollamaUrl: OLLAMA_URL })
    .catch((e) => { console.error('provider setup failed:', e.message); process.exit(1); });

  // smoke: can the model answer at all? (fail fast with a clear error)
  const smoke = await sw.evaluate(async (cfg) => {
    try {
      const url = cfg.provider === 'ollama'
        ? `${cfg.ollamaUrl}/api/tags`
        : `${cfg.baseUrl || 'https://api.openai.com/v1'}/models`;
      const headers = (cfg.provider !== 'ollama' && cfg.apiKey)
        ? { Authorization: `Bearer ${cfg.apiKey}` }
        : {};
      const r = await fetch(url, { method: 'GET', headers });
      return { ok: r.ok, status: r.status };
    } catch (e) { return { ok: false, status: String(e) }; }
  }, { provider: PROVIDER, model: MODEL, apiKey: API_KEY, baseUrl: BASE_URL, ollamaUrl: OLLAMA_URL });
  if (!smoke.ok) {
    console.error(`provider endpoint unreachable (${JSON.stringify(smoke)}) — start Ollama or check --base-url/--api-key. NOT writing a report.`);
    await context.close(); srv.close(); process.exit(1);
  }

  const results = [];
  for (const sc of RUN) {
    console.log(`\n[e2e-real ${PROVIDER}/${MODEL}] ${sc.id}: "${sc.task}"`);
    const page = await context.newPage();
    const steps = [];
    let swLog = '';
    const currentSw = () => context.serviceWorkers().find(w => w.url().includes(extId)) || sw;
    const onConsole = (msg) => { swLog += msg.text() + '\n'; };
    currentSw().on('console', onConsole);

    await page.goto(`${BASE}${sc.page}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    sw = currentSw();

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`).catch(() => {});
    await panel.waitForTimeout(1000);
    await page.bringToFront();
    await page.waitForTimeout(400);
    await panel.evaluate(({ task }) => new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ type: 'PRIVACY_START', task }, (r) => {
          res({ r: r || null, le: chrome.runtime.lastError ? chrome.runtime.lastError.message : null });
        });
      } catch (e) { res({ err: e.message }); }
    }), { task: sc.task }).catch((e) => ({ err: e.message }));

    // real models think slower — 180 s per scenario cap
    const t0 = Date.now();
    let finished = false;
    while (Date.now() - t0 < 180000) {
      await new Promise(r => setTimeout(r, 1000));
      if (/PRIVACY TASK COMPLETE|AGENT_DONE|task complete/i.test(swLog)) { finished = true; break; }
      const last = [...swLog.matchAll(STEP_RE)].pop();
      if (last && Number(last[1]) >= 8) break;
      if (/PRIVACY BLOCKED/i.test(swLog)) break;
    }
    currentSw().off('console', onConsole);

    for (const m of swLog.matchAll(STEP_RE)) {
      steps.push({ step: Number(m[1]), totalMs: Math.round(parseFloat(m[2]) * 1000), sanitizeMs: Math.round(parseFloat(m[3])), vlmMs: Math.round(parseFloat(m[4])), actionMs: Math.round(parseFloat(m[5])) });
    }
    const verifyStates = [];
    for (const line of swLog.split('\n')) {
      const m = VERIFY_LINE_RE.exec(line.trim());
      if (m) { try { verifyStates.push(JSON.parse(m[1])); } catch { /* skip */ } }
    }
    for (const s of steps) {
      const v = verifyStates.filter(x => x.step === s.step);
      s.verifyStates = v.map(x => ({ state: x.state, action: x.action, summary: x.summary }));
      s.state = v.length
        ? (v.some(x => x.state === 'ACTION_FAILED') ? 'ACTION_FAILED'
          : v.every(x => x.state === 'ACTION_VERIFIED') ? 'ACTION_VERIFIED'
          : v.some(x => x.state === 'VERIFICATION_FAILED') ? 'VERIFICATION_FAILED'
          : 'ACTION_EXECUTED')
        : 'NO_VERIFY_LINE';
    }
    const blocked = /PRIVACY BLOCKED/i.test(swLog);

    results.push({
      id: sc.id, task: sc.task, page: sc.page, finished, blocked, steps,
      totalMs: steps.reduce((a, s) => a + s.totalMs, 0),
      stepCount: steps.length,
      verified: steps.filter(s => s.state === 'ACTION_VERIFIED').length,
      verifyFailed: steps.filter(s => s.state === 'VERIFICATION_FAILED').length,
      failed: steps.filter(s => s.state === 'ACTION_FAILED').length,
    });
    console.log(`  steps=${steps.length} finished=${finished} blocked=${blocked} states=${steps.map(s => s.state).join(',')}`);
    if (!steps.length) {
      const tail = swLog.split('\n').filter(Boolean).slice(-6).join('\n  ');
      console.log(`  ↳ sw log tail:\n  ${tail}`);
    }
    await page.close().catch(() => {});
    await panel.close().catch(() => {});
  }

  const allSteps = results.flatMap(r => r.steps);
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
    vlmMs_real: { p50: pct(allSteps.map(s => s.vlmMs), 0.5), p90: pct(allSteps.map(s => s.vlmMs), 0.9), p95: pct(allSteps.map(s => s.vlmMs), 0.95) },
    actionMs: { p50: pct(allSteps.map(s => s.actionMs), 0.5), p90: pct(allSteps.map(s => s.actionMs), 0.9), p95: pct(allSteps.map(s => s.actionMs), 0.95) },
    stepTotalMs: { p50: pct(allSteps.map(s => s.totalMs), 0.5), p90: pct(allSteps.map(s => s.totalMs), 0.9), p95: pct(allSteps.map(s => s.totalMs), 0.95) },
  };

  const report = {
    meta: {
      type: 'e2e-real',
      benchmark: 'real-extension-real-vlm',
      vlm: `real:${PROVIDER}/${MODEL}`,
      generatedAt: new Date().toISOString(),
      note: 'REAL extension loop with a REAL model brain (BYO-provider direct path — the production configuration for bring-your-own-key users). vlmMs here measures TRUE model inference + transport for the sanitized payload. This report is NEVER merged with the mock-VLM e2e benchmark or with UNIT/BROWSER tiers. Runs on real user hardware only — never quoted from headless CI machines.',
      provider: { provider: PROVIDER, model: MODEL, endpoint: PROVIDER === 'ollama' ? OLLAMA_URL : (BASE_URL || 'https://api.openai.com/v1'), local: PROVIDER === 'ollama' },
      scenarios: RUN.map(s => ({ id: s.id, task: s.task })),
    },
    aggregate,
    scenarios: results,
  };
  const out = join(OUT_DIR, `e2e-real-benchmark-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${out}`);
  console.log(JSON.stringify(aggregate, null, 1));

  await context.close();
  srv.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
