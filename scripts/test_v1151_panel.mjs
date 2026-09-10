#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/test_v1151_panel.mjs — v1.15.1 regression suite (real browser).
//
// Covers the user-reported fixes:
//   1. Stop button must HIDE + result card must render after a privacy task
//      completes (root cause: sw broadcast() double-wrapped AGENT_DONE).
//   2. "Ask before acting" is ALIVE for privacy runs: approval card appears
//      before every browser action; Allow once → proceeds · Skip → honest
//      skip + fresh decision · Stop task → run aborts, UI resets.
//   3. "Add context while task running" is ALIVE: a mid-run ADD_USER_NOTE is
//      drained and injected into the NEXT decision prompt (asserted at the
//      mock VLM — the note must literally reach the model).
//   4. Media play on an ALREADY playing video reports ALREADY IN STATE
//      (verified no-op) instead of misleading NO CHANGE.
//   5. VLM request/response console logging ([VLM-REQ]/[VLM-RAW]/[VLM-RES]).
//   6. Model pill ellipsis (long model names) + top-right sun/gear icon gone.
// ─────────────────────────────────────────────────────────────────────────────
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const ROOT = '/home/z/my-project/upload/OpenCometAI-SIH-extracted/OpenCometAI-SIH';
const BASE = 'http://127.0.0.1:8895';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.tflite': 'application/octet-stream', '.gz': 'application/gzip' };

function serve() {
  return new Promise((res) => {
    const srv = createServer((req, resp) => {
      const p = decodeURIComponent(new URL(req.url, BASE).pathname);
      const file = join(ROOT, p);
      if (!file.startsWith(ROOT) || !existsSync(file)) { resp.writeHead(404); resp.end('nf'); return; }
      resp.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      resp.end(readFileSync(file));
    });
    srv.listen(8895, '127.0.0.1', () => res(srv));
  });
}

// ── OpenAI-compatible mock that SCRIPTS decisions per task and CAPTURES the
//    exact prompts it receives (so the test can assert user-note injection). ──
const captured = { prompts: [], bodies: [] };
function promptTextOf(bodyStr) {
  try {
    const parsed = JSON.parse(bodyStr);
    // buildCompatMessages: [0] = system prompt, [1] = user (string OR parts)
    const c = parsed?.messages?.[1]?.content;
    return typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(p => p?.type === 'text').map(p => p.text).join('\n') : '');
  } catch { return ''; }
}
function decisionFor(task, n) {
  const done = { thought: 'task verified complete', action: { type: 'done' }, confidence: 0.95, is_complete: true };
  const clickPricing = { thought: 'click the pricing link', action: { type: 'click', selector: '#link-pricing' }, confidence: 0.9 };
  if (task.includes('Pricing')) return n === 0 ? clickPricing : done;
  if (task.includes('Approve flow')) return n === 0 ? clickPricing : done;
  if (task.includes('Skip flow')) return n === 0 ? clickPricing : done;
  if (task.includes('Stop flow')) return n === 0 ? clickPricing : done;
  if (task.includes('Media noop')) return n === 0 ? { thought: 'pause it', action: { type: 'media', command: 'pause' }, confidence: 0.9 } : done;
  return done;
}
function startCompatMock() {
  return new Promise((res) => {
    const srv = createServer((req, resp) => {
      if (req.method === 'POST' && req.url.includes('/chat/completions')) {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          captured.bodies.push(body);
          const pText = promptTextOf(body);
          captured.prompts.push(pText);
          const m = /TASK: (.*)/.exec(pText);
          const key = m ? m[1] : pText.slice(0, 40);
          const callIdx = captured[key] || 0;
          captured[key] = callIdx + 1;
          const decision = decisionFor(key, callIdx);
          const content = JSON.stringify(decision);
          const wantStream = (() => { try { return JSON.parse(body).stream === true; } catch { return false; } })();
          if (wantStream) {
            resp.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
            const chunk = (obj) => resp.write(`data: ${JSON.stringify(obj)}\n\n`);
            chunk({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] });
            chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
            chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
            resp.write('data: [DONE]\n\n');
            resp.end();
          } else {
            resp.writeHead(200, { 'Content-Type': 'application/json' });
            resp.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
          }
        });
        return;
      }
      resp.writeHead(404); resp.end('nf');
    });
    srv.listen(8896, '127.0.0.1', () => res(srv));
  });
}

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: Boolean(cond) });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
}

async function waitFor(fn, timeoutMs, everyMs = 500) {
  const t0 = Date.now();
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await new Promise(r => setTimeout(r, everyMs));
  }
}

async function main() {
  const srv = await serve();
  const mock = await startCompatMock();

  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const extId = crypto.createHash('sha256').update(ROOT).digest('hex').slice(0, 32)
    .split('').map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');

  const wake = await context.newPage();
  await wake.goto(`${BASE}/OpenCometBench/e2e/pages/nav-links.html`).catch(() => {});
  await wake.waitForTimeout(1200);
  let sw = null;
  for (let i = 0; i < 30 && !sw; i++) {
    sw = context.serviceWorkers().find(w => w.url().includes(extId));
    if (!sw) await new Promise(r => setTimeout(r, 500));
  }
  if (!sw) { console.error('SW never appeared'); process.exit(1); }
  console.log('SW online');

  // Configure provider → mock endpoint
  await sw.evaluate(async () => {
    const key = 'opencometSettings';
    const data = await chrome.storage.local.get(key);
    const settings = { ...(data[key] || {}) };
    settings.provider = 'custom';
    settings.providerBaseUrl = 'http://127.0.0.1:8896/v1';
    settings.apiKey = 'test-key';
    settings.model = 'mock-vlm';
    await chrome.storage.local.set({ [key]: settings });
    return true;
  });

  const panel = await context.newPage();
  await panel.addInitScript(() => {
    // Record every OUTGOING runtime message (pre-interceptor) for diagnostics
    const origSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function (msg, ...rest) {
      try {
        window.__sent = window.__sent || [];
        if (msg && typeof msg === 'object') window.__sent.push({ type: msg.type, mode: msg.mode, task: (msg.task || '').slice(0, 30), decision: msg.decision });
      } catch {}
      return origSend(msg, ...rest);
    };
    window.addEventListener('error', (e) => {
      try { window.__panelErrors = window.__panelErrors || []; window.__panelErrors.push(String(e.message)); } catch {}
    });
  });
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`).catch(() => {});
  await panel.waitForTimeout(800);
  await panel.evaluate(() => {
    localStorage.setItem('opencometPrivacyEnabled', '1');
    localStorage.setItem('opencometPrivacyConfig', JSON.stringify({ serverUrl: 'http://127.0.0.1:8896' }));
    localStorage.setItem('opencometAgentMode', 'auto');
  });
  await panel.reload();
  await panel.waitForTimeout(1200);

  const swLogAll = [];
  const onSwConsole = (msg) => swLogAll.push(msg.text());
  sw.on('console', onSwConsole);
  const currentSw = () => context.serviceWorkers().find(w => w.url().includes(extId)) || sw;

  async function resetMockState() {
    await panel.evaluate(() => { /* nothing — captured is server-side */ });
  }

  async function startTask(task, onPage = null) {
    await panel.evaluate((t) => {
      const ta = document.querySelector('#taskInput');
      ta.value = t;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, task);
    await (onPage || wake).bringToFront();
    await panel.waitForTimeout(250);
    await panel.evaluate(() => document.querySelector('#sendBtn').click());
  }

  // ═════════ T1: UI — sun icon gone, model pill ellipsis ═════════
  console.log('\n[T1] Toolbar UI (sun icon removed · model pill ellipsis)');
  const ui = await panel.evaluate(() => {
    const pill = document.querySelector('#modelPillLabel');
    const cfg = document.querySelector('#privacyConfigureBtn');
    const long = 'qwen/qwen3-vl-235b-a22b-thinking-for-real-production-use';
    pill.textContent = long;
    const cs = getComputedStyle(pill);
    return {
      configureGone: !cfg,
      ellipsis: cs.textOverflow === 'ellipsis' && cs.whiteSpace === 'nowrap',
      clipped: cs.overflowX === 'hidden' && pill.scrollWidth >= pill.clientWidth,
      constrained: pill.clientWidth < 280,
      pillWidth: pill.clientWidth,
      scrollW: pill.scrollWidth,
    };
  });
  check('top-right sun/gear icon removed', ui.configureGone);
  check('model pill ellipsis active (text-overflow + nowrap)', ui.ellipsis);
  check(`long model name clipped inside the pill (label ${ui.pillWidth}px < 280 cap, content ${ui.scrollW}px clipped by overflow:hidden)`, ui.clipped && ui.constrained);

  // ═════════ T2: auto-mode run → Stop hidden + result card + VLM logs + live context ═════════
  console.log('\n[T2] Auto run: Stop-button reset · VLM console logs · mid-run context injection');
  const promptsBefore = captured.prompts.length;
  await startTask('On the Pricing page open the Pricing page');
  // mid-run: add user context while the agent is running
  await waitFor(() => swLogAll.some(t => /Capturing & sanitizing screen \(step 1\)/.test(t)), 30000);
  await panel.evaluate(() => new Promise((res) => {
    chrome.runtime.sendMessage({ type: 'ADD_USER_NOTE', note: 'PREFER the blue button' }, () => res());
  }));
  const done2 = await waitFor(() => swLogAll.some(t => /Privacy agent finished/.test(t)), 90000);
  check('privacy run completed (auto mode)', Boolean(done2));
  await panel.waitForTimeout(1200);
  const after2 = await panel.evaluate(() => ({
    stopVisible: document.querySelector('#stopBtn')?.classList.contains('visible'),
    resultCard: Boolean(document.querySelector('.result-card')),
    errors: (window.__panelErrors || []),
  }));
  check('Stop button hidden after completion', after2.stopVisible === false);
  check('result card rendered after completion', after2.resultCard);
  check('no panel page errors', after2.errors.length === 0, after2.errors.join(' | '));
  check('VLM-REQ prompt logged to console', swLogAll.some(t => /\[Open Comet\]\[VLM-REQ\] → custom\/mock-vlm/.test(t)));
  check('VLM-RAW model text logged to console', swLogAll.some(t => /\[Open Comet\]\[VLM-RAW\]/.test(t)));
  check('VLM-RES response logged to console', swLogAll.some(t => /\[Open Comet]\[VLM-RES\]/.test(t)));
  const noteReachedModel = captured.prompts.slice(promptsBefore).some(p => p.includes('USER CONTEXT') && p.includes('PREFER the blue button'));
  check('mid-run user note injected into the NEXT VLM prompt', noteReachedModel);
  const injectCount = swLogAll.filter(t => /injecting \d+ user note\(s\)/.test(t)).length;
  check('user note injected exactly once (drained — no re-injection)', injectCount === 1, `injectLines=${injectCount}`);

  // ═════════ T3: media pause on an ALREADY-paused video → ALREADY IN STATE ═════════
  console.log('\n[T3] Media no-op honesty (already paused → ALREADY IN STATE)');
  swLogAll.length = 0;
  const mediaPage = await context.newPage();
  await mediaPage.goto(`${BASE}/OpenCometBench/pages/media.html`, { waitUntil: 'networkidle' });
  await mediaPage.waitForTimeout(800);
  const videoPlaying = await mediaPage.evaluate(() => { const v = document.querySelector('video'); return v ? { paused: v.paused, muted: v.muted } : null; });
  console.log('  media.html video state:', JSON.stringify(videoPlaying));
  await startTask('Media noop task — play the video please', mediaPage);
  const done3 = await waitFor(() => swLogAll.some(t => /Privacy agent finished/.test(t)), 90000);
  check('media scenario completed', Boolean(done3));
  check('console says ALREADY IN STATE', swLogAll.some(t => /ALREADY IN STATE/.test(t)), '');
  check('honest step text reaches history/chat', swLogAll.some(t => /ALREADY in the requested state/.test(t)));
  await waitFor(() => swLogAll.some(t => /\[Open Comet\]\[VERIFY\].*ACTION_VERIFIED.*"media"/.test(t)), 5000).then(v => {
    check('VERIFY line classifies media no-op as ACTION_VERIFIED', Boolean(v));
  });
  await mediaPage.close();

  // ═════════ T4: ask mode — approval card → Allow once → completes ═════════
  console.log('\n[T4] Ask before acting — Allow once');
  await panel.evaluate(() => { localStorage.setItem('opencometAgentMode', 'ask'); });
  await panel.reload();
  await panel.waitForTimeout(1200);
  const modeShown = await panel.evaluate(() => document.querySelector('#modeLabel')?.textContent);
  check('mode restored from persistence ("Ask before acting")', modeShown === 'Ask before acting', `shown="${modeShown}"`);
  swLogAll.length = 0;
  await startTask('Approve flow task — open Pricing');
  const card = await waitFor(() => panel.evaluate(() => {
    const c = document.querySelector('.approval-card');
    if (!c) return null;
    return {
      title: c.querySelector('.approval-title')?.textContent || '',
      msg: c.querySelector('.approval-msg')?.textContent || '',
      buttons: [...c.querySelectorAll('button')].map(b => b.textContent.trim()),
    };
  }), 45000);
  if (!card) {
    const sent = await panel.evaluate(() => (window.__sent || []).filter(m => /PRIVACY|START/.test(m.type || '')));
    console.log('  DIAG outgoing:', JSON.stringify(sent));
    console.log('  DIAG swLog tail:', swLogAll.slice(-6).map(t => t.replace(/%c\[LocalML\][^ ]* ?/g, '').slice(0, 120)));
  }
  check('approval card appears before the action', Boolean(card), card ? `title="${card.title}"` : 'no card');
  check('card names the action', Boolean(card && /the agent wants to: Click/.test(card.msg)), card?.msg || '');
  check('card has Allow once / Skip / Stop task', Boolean(card && card.buttons.join('|') === 'Allow once|Skip|Stop task'), card?.buttons?.join('|'));
  const waitIdx = swLogAll.findIndex(t => /Ask before acting: waiting/.test(t));
  const approvedIdx = swLogAll.findIndex(t => /Action approved — executing/.test(t));
  const executedWhileWaiting = swLogAll.slice(waitIdx < 0 ? 0 : waitIdx, approvedIdx < 0 ? swLogAll.length : approvedIdx)
    .some(t => /Action result|Click verify|PAGE CHANGED/.test(t));
  check('action NOT executed while waiting', waitIdx >= 0 && !executedWhileWaiting);
  await panel.evaluate(() => document.querySelector('.approval-card .btn-allow')?.click());
  const done4 = await waitFor(() => swLogAll.some(t => /Privacy agent finished/.test(t)), 90000);
  check('run proceeds and completes after Allow once', Boolean(done4));
  const approvedStep = swLogAll.some(t => /Action approved — executing/.test(t));
  check('approval-granted step logged', approvedStep);

  // ═════════ T5: ask mode — Skip ═════════
  console.log('\n[T5] Ask before acting — Skip');
  await panel.evaluate(() => {
    document.querySelector('#newChatBtn')?.click();
  });
  await panel.waitForTimeout(600);
  swLogAll.length = 0;
  await startTask('Skip flow task — open Pricing');
  await waitFor(() => panel.evaluate(() => Boolean(document.querySelector('.approval-card'))), 45000);
  await panel.evaluate(() => document.querySelector('.approval-card .btn-skip')?.click());
  const skipped = await waitFor(() => swLogAll.some(t => /action skipped by user/.test(t)), 30000);
  check('skip verdict logged SW-side', Boolean(skipped));
  const done5 = await waitFor(() => swLogAll.some(t => /Privacy agent finished/.test(t)), 90000);
  check('run continues after skip and completes', Boolean(done5));

  // ═════════ T6: ask mode — Stop task ═════════
  console.log('\n[T6] Ask before acting — Stop task');
  swLogAll.length = 0;
  await panel.evaluate(() => {
    const ta = document.querySelector('#taskInput');
    ta.value = 'Stop flow task — open Pricing';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wake.bringToFront();
  await panel.waitForTimeout(250);
  await panel.evaluate(() => document.querySelector('#sendBtn').click());
  await waitFor(() => panel.evaluate(() => Boolean(document.querySelector('.approval-card'))), 45000);
  await panel.evaluate(() => document.querySelector('.approval-card .btn-deny')?.click());
  const stopped6 = await waitFor(() => swLogAll.some(t => /Privacy agent error: Agent aborted by user/.test(t)), 30000);
  check('stop verdict aborts the loop (honest error)', Boolean(stopped6));
  await panel.waitForTimeout(1200);
  const after6 = await panel.evaluate(() => ({
    stopVisible: document.querySelector('#stopBtn')?.classList.contains('visible'),
    errors: (window.__panelErrors || []),
  }));
  check('UI reset after stop (Stop button hidden)', after6.stopVisible === false);
  check('no panel page errors across ask flows', after6.errors.length === 0, after6.errors.join(' | '));

  sw.off('console', onSwConsole);
  await context.close();
  mock.close(); srv.close();

  const pass = results.filter(r => r.pass).length;
  console.log(`\n═══ RESULT: ${pass}/${results.length} PASS ═══`);
  if (pass !== results.length) { const f = results.filter(r => !r.pass); console.log('FAILED:', f.map(r => r.name).join(' · ')); process.exit(1); }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
