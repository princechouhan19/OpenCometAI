#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/test_v1158_prose_safe.mjs — v1.15.8 regression (unit + real extension).
//
// Field report (v1.15.7 on chat.z.ai): "hiding unwanted safe text". The
// sanitized screenshot drew black boxes over SAFE PROSE:
//     "…three literal [token formats] (AWS/GitHub/Slack)…"
//     "…the four surviving [secret families:]…"
//     "…(Google [key contiguity,] A4 split, A5 self-healing)…"
//
// Root cause: the secret-ASSIGNMENT patterns (pii-detector.js REGEX_PATTERNS
// 'password' + 'api_key', mirrored by privacy-firewall.js SECRET_TEXT_SWEEP
// 'password_assignment' + 'token_assignment') anchored blob-unbounded
// lookaheads at the value start:
//     …\s*(?:[:=]\s*|\s+)(?:…|(?=.*\d)[^\s'"]{5,})
//     …\s*(?:[:=]\s*|\s+)(?:…|(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9…]{6,})
// (?=.*\d) requires a digit ANYWHERE LATER on the scanned line — and the OCR
// full-page reconstruction is ONE newline-free blob — so "token formats",
// "secret families:", "key contiguity," each matched because the page
// contained "v1.15.3" / "22/22" / "Room 42" HUNDREDS of chars later. The
// \s+ separator alternative also meant no "=" / ":" was required at all.
// On the canvas path (OCR → detectPiiInText → word-box union) this painted
// black boxes over ordinary prose — the exact v1.15.7 A4b "documented
// coarseness", now fixed at the regex level.
//
// Fix (this release): lookaheads are BOUNDED TO THE VALUE RUN — a digit
// (and letter, where specified) must sit INSIDE the candidate value:
//     (?=[^\s'"]*\d)[^\s'"]{5,}
//     (?=[A-Za-z0-9_.\-+/=]*\d)(?=[A-Za-z0-9_.\-+/=]*[A-Za-z])[A-Za-z0-9…]{6,}
// Fail-closed preserved: every REAL assignment (digit inside the value)
// still matches — proven below and re-proven by fuzz/security/PII-corpus.
//
//   Part A (Node, pure): the three field phrases must never fire again;
//          blob "Password: required … Room 42." clean; firewall sweep +
//          masking leave the prose untouched; 9 real-secret controls still
//          fire (detector + sweep + mask).
//   Part B (Playwright, real unpacked extension): summarize the prose-only
//          fixture page (prose-discussion.html, digits included) → run
//          completes, OCR canvas pass yields ZERO api_key/password regions
//          (no black boxes), and the safe phrases reach the mock backend
//          unmasked.
// ─────────────────────────────────────────────────────────────────────────────
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { detectPiiInTextSync } from '../src/lib/pii-detector.js';
import { scanTextForSecrets, maskSecretShapedText } from '../src/lib/privacy-firewall.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://127.0.0.1:8899';
const MOCK = 'http://127.0.0.1:8900';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.tflite': 'application/octet-stream', '.gz': 'application/gzip', '.png': 'image/png' };

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: Boolean(cond) });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
}
const overlaps = (f, text, phrase) => {
  const i = text.indexOf(phrase);
  if (i < 0) throw new Error(`phrase not in blob: ${phrase}`);
  return f.start < i + phrase.length && f.end > i;
};

// ── The field page, transcribed (OCR variant A = space-joined, ONE line) ────
const PAGE_BLOB = [
  'The external content obfuscation layer (environment redactor) has removed three literal token formats (AWS/GitHub/Slack) from files written to disk',
  'production files are unaffected and functioning correctly. I will work around this issue in tests and fixtures: building these literals in unit tests via runtime string concatenation and rewriting the fixture using the four surviving secret families:',
  'Ran 1 commands',
  'Explored 1 files , Wrote 2 files',
  'The Read output itself may be filtered. Let me inspect the raw bytes:',
  'The bytes are fine on disk — AKIA is present, and the [REDACTED: ...] text only appears in the tool-result display (the gateway masks secret-shaped strings when streaming results back to me). The fixture and test files are intact with all 5 families; my failed edits were matching against display-filtered text. The MultiEdit fixes (Google key contiguity, A4 split, A5 self-healing) applied correctly. Verifying disk truth and re-running:',
  '22/22 All passed – Unit tests + real-world extended E2E tests. The bug has been fixed and verified through regression testing. Now, let\'s begin the release process: update the changelog, tests, manifest, documentation, and build scripts on the About page. First, check the current changelog structure and',
  'Chat Agent New Task AI PPT PPT Creation for SIH Project OpenCometSIH TacticOperatorConsole Learning Journey Medirecord Prince Chouhan Send a Message GLM-5.3-Flash',
].join(' ');
const FP_PHRASES = ['token formats', 'secret families', 'key contiguity'];
const SECRET_IDS = new Set(['password_assignment', 'token_assignment']);

async function partA() {
  console.log('\n[Part A] unit — prose false positives dead · real assignments still fire');

  // P1 — THE FIELD BUG: no detector finding may touch any of the three phrases
  for (const phrase of FP_PHRASES) {
    let hits = [];
    try { hits = detectPiiInTextSync(PAGE_BLOB, { maxChars: 16000 }).filter(f => overlaps(f, PAGE_BLOB, phrase)); }
    catch (e) { check(`P1 prose "${phrase}" never redacted`, false, e.message); continue; }
    check(`P1 prose "${phrase}" never redacted (detector)`, hits.length === 0,
      hits.length ? hits.map(h => `${h.type}:"${h.raw.slice(0, 40)}"`).join(' | ') : '');
  }

  // P1b — the v1.15.7 A4b canonical blob FP: prose + a LATER digit must stay clean
  const reqBlob = 'Password: required for login. Room 42.';
  check('P1b "Password: required … Room 42." blob yields no findings',
    detectPiiInTextSync(reqBlob, { maxChars: 16000 }).length === 0);

  // P1c — OCR line-fused variant (variant B) stays clean on the same prose
  const fused = PAGE_BLOB.replace(/\s+/g, '');
  check('P1c line-fused OCR variant yields no findings', detectPiiInTextSync(fused, { maxChars: 16000 }).length === 0);

  // P2 — firewall sweep: no secret-shaped id on the page blob; masking is a no-op there
  const sweepIds = scanTextForSecrets(PAGE_BLOB).filter(id => SECRET_IDS.has(id));
  check('P2 sweep finds no assignment secrets on the field page', sweepIds.length === 0, sweepIds.join(','));
  const m = maskSecretShapedText(PAGE_BLOB);
  check('P3 maskSecretShapedText leaves the field page untouched',
    m.residual.length === 0 && !m.masked.some(x => SECRET_IDS.has(x.id))
    && FP_PHRASES.every(p => m.text.includes(p)),
    m.masked.map(x => x.id).join(','));
  check('P4 sweep/mask "AKIA" chip mention is untouched (4 chars alone is not a key)',
    PAGE_BLOB.includes('AKIA is present') && m.text.includes('AKIA is present'));

  // ── TRUE-POSITIVE CONTROLS — every real assignment must STILL fire ────────
  const tp = (text) => detectPiiInTextSync(text, { maxChars: 16000 });
  check('TP1 "password: hunter2" detected', tp('password: hunter2').some(f => f.type === 'password'));
  check('TP2 "Password: \'Str0ngPass!x\'" (quoted) detected',
    tp("Password: 'Str0ngPass!x'").some(f => f.type === 'password'));
  check('TP3 "password Hunter2Str0ng" (space-separated, digit in value) detected',
    tp('password Hunter2Str0ng').some(f => f.type === 'password'));
  check('TP4 "token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" detected',
    tp('token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9').some(f => f.type === 'api_key'));
  check('TP5 "api_key = sk-live-9f8a7b6c5d4e3f2a1b" detected',
    tp('api_key = sk-live-9f8a7b6c5d4e3f2a1b').some(f => f.type === 'api_key'));
  check('TP6 "secret: ghp_AbCdEf1234567890abcXYZ" detected',
    tp('secret: ghp_AbCdEf1234567890abcXYZ').some(f => f.type === 'api_key'));
  check('TP7 "key QmFzZTY0X1NlY3JldA==" (space-separated) detected',
    tp('key QmFzZTY0X1NlY3JldA==').some(f => f.type === 'api_key'));
  check('TP8 labelled AWS literal detected', tp('key AKIAIOSFODNN7EXAMPLE').some(f => f.type === 'api_key'));

  // sweep + mask controls
  check('TP9 sweep: token_assignment fires on "token=eyJ…"',
    scanTextForSecrets('set token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 in config').includes('token_assignment'));
  check('TP10 sweep: password_assignment fires on "password: Hunter2Xyz"',
    scanTextForSecrets('password: Hunter2Xyz').includes('password_assignment'));
  const mixed = 'we kept password: Hunter2Xyz in the vault alongside three token formats (AWS/GitHub/Slack)';
  const mm = maskSecretShapedText(mixed);
  check('TP11 mixed blob: real assignment masked, prose "token formats" survives',
    mm.masked.some(x => x.id === 'password_assignment') && mm.residual.length === 0
    && !mm.text.includes('Hunter2Xyz') && mm.text.includes('token formats'), mm.text);
  check('TP12 sweep: quoted assignment fires', scanTextForSecrets(`secret: 'abc123xyz456'`).includes('token_assignment'));
}

// ═══════════════════════════════ PART B ══════════════════════════════════════
const ANSWER = '• The page is an internal debugging-notes document\n• It records a regression-fix session and the release checklist\n• All notes are procedural prose with no credentials';
const captured = { bodies: [], prompts: [], swLogs: [] };
function promptTextOf(bodyStr) {
  try {
    const parsed = JSON.parse(bodyStr);
    const c = parsed?.messages?.[1]?.content;
    return typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(p => p?.type === 'text').map(p => p.text).join('\n') : '');
  } catch { return ''; }
}
function serve() {
  return new Promise((res) => {
    const srv = createServer((req, resp) => {
      const p = decodeURIComponent(new URL(req.url, BASE).pathname);
      const file = join(ROOT, p);
      if (!file.startsWith(ROOT) || !existsSync(file)) { resp.writeHead(404); resp.end('nf'); return; }
      resp.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      resp.end(readFileSync(file));
    });
    srv.listen(8899, '127.0.0.1', () => res(srv));
  });
}
function startCompatMock() {
  return new Promise((res) => {
    const srv = createServer((req, resp) => {
      if (req.method === 'POST' && req.url.includes('/chat/completions')) {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          captured.bodies.push(body);
          captured.prompts.push(promptTextOf(body));
          const content = JSON.stringify({ thought: 'prose page', action: { type: 'done', message: ANSWER }, confidence: 0.95, is_complete: true });
          const wantStream = (() => { try { return JSON.parse(body).stream === true; } catch { return false; } })();
          if (wantStream) {
            resp.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
            const chunk = (obj) => resp.write(`data: ${JSON.stringify(obj)}\n\n`);
            chunk({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] });
            chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
            chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
            resp.write('data: [DONE]\n\n');
            resp.end();
            return;
          }
          resp.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          resp.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
        });
        return;
      }
      resp.writeHead(404); resp.end();
    });
    srv.listen(8900, '127.0.0.1', () => res(srv));
  });
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

async function partB() {
  console.log('\n[Part B] E2E — real extension: summarize a prose-only page, no black boxes');
  const srv = await serve();
  const mock = await startCompatMock();
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`,
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const extId = crypto.createHash('sha256').update(ROOT).digest('hex').slice(0, 32)
    .split('').map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');

  const wake = await context.newPage();
  await wake.goto(`${BASE}/OpenCometBench/e2e/pages/prose-discussion.html`).catch(() => {});
  await wake.waitForTimeout(1200);
  let sw = null;
  for (let i = 0; i < 30 && !sw; i++) {
    sw = context.serviceWorkers().find(w => w.url().includes(extId));
    if (!sw) await new Promise(r => setTimeout(r, 500));
  }
  if (!sw) { console.error('SW never appeared'); process.exit(1); }

  await sw.evaluate(async () => {
    const key = 'opencometSettings';
    const data = await chrome.storage.local.get(key);
    const settings = { ...(data[key] || {}) };
    settings.provider = 'custom';
    settings.providerBaseUrl = 'http://127.0.0.1:8900/v1';
    settings.apiKey = 'test-key';
    settings.model = 'mock-vlm';
    await chrome.storage.local.set({ [key]: settings });
    return true;
  });

  const panel = await context.newPage();
  const currentSw = () => context.serviceWorkers().find(w => w.url().includes(extId)) || sw;
  currentSw().on('console', (msg) => captured.swLogs.push(msg.text()));
  await panel.addInitScript(() => {
    window.__panelErrors = [];
    window.addEventListener('error', (e) => { try { window.__panelErrors.push(String(e.message)); } catch {} });
  });
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`).catch(() => {});
  await panel.waitForTimeout(800);
  await panel.evaluate(() => {
    localStorage.setItem('opencometPrivacyEnabled', '1');
    localStorage.setItem('opencometPrivacyConfig', JSON.stringify({ serverUrl: 'http://127.0.0.1:8900', ocrPii: true }));
    localStorage.setItem('opencometAgentMode', 'auto');
  });
  await panel.reload();
  await panel.waitForTimeout(1200);

  await panel.evaluate(() => {
    const ta = document.querySelector('#taskInput');
    ta.value = 'Summarize this page in clear bullet points.';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wake.bringToFront();
  await panel.waitForTimeout(250);
  await panel.evaluate(() => document.querySelector('#sendBtn').click());

  const finished = await waitFor(() => captured.swLogs.some(t => /Privacy agent finished/.test(t)), 240000);
  const gateBlocked = captured.swLogs.some(t => /NETWORK GATE BLOCKED/.test(t));
  check('B1 privacy run COMPLETES on the prose page', Boolean(finished),
    gateBlocked ? 'gate blocked — see SW console' : '');
  check('B2 network gate NEVER fires', !gateBlocked);

  // B3 — the canvas proof: byType must contain NO api_key / password regions
  const redactLine = captured.swLogs.find(t => /Redact: \d+ region\(s\) drawn/.test(t));
  const byType = (() => { try { return JSON.parse(redactLine.match(/byType=(\{.*\})/)?.[1] || '{}'); } catch { return {}; } })();
  check('B3 redaction byType contains NO api_key / password (no black boxes over prose)',
    Boolean(redactLine) && !('api_key' in byType) && !('password' in byType), redactLine?.slice(0, 160) || 'no Redact log');

  // B4 — non-vacuity: the OCR canvas pass actually ran on this page
  const ocrLine = captured.swLogs.find(t => /\[OCR-PII\] \d+ words/.test(t));
  check('B4 OCR canvas pass ran (non-vacuous B3)', Boolean(ocrLine), ocrLine?.slice(0, 160) || 'no OCR log');

  await panel.waitForTimeout(1200);
  const card = await panel.evaluate(() => document.querySelector('.result-card .result-text')?.textContent || '');
  check('B5 result card delivers the final answer', card.includes('debugging-notes document'), JSON.stringify(card.slice(0, 80)));

  check('B6 safe phrases reach the backend UNMASKED (text channel keeps prose readable)',
    captured.prompts.length > 0
    && captured.prompts.some(p => p.includes('token formats') && p.includes('secret families') && p.includes('key contiguity')),
    `${captured.prompts.length} prompt(s) captured`);
  check('B7 no panel page errors', (await panel.evaluate(() => (window.__panelErrors || []).length)) === 0);

  await context.close();
  srv.close(); mock.close();
}

// ═══════════════════════════════ RUN ═════════════════════════════════════════
try {
  await partA();
  await partB();
} catch (err) {
  console.error('SUITE ERROR:', err);
  process.exit(1);
}
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('FAILED:', failed.map(f => f.name).join(' · ')); process.exit(1); }
console.log('V1.15.8 PROSE-SAFE SUITE: ALL PASS');
process.exit(0);
