#!/usr/bin/env node
// scripts/test_v1157_secret_sweep.mjs — v1.15.7 regression (real extension).
//
// Field report (v1.15.6): "Summarize this page in clear bullet points." on a
// long chat page died BEFORE the first VLM call —
//   [Privacy] NETWORK GATE BLOCKED the decision turn
//   "secret-shaped text (API key / credentials / password assignment)
//    survived sanitization. No screen data was transmitted."
//
// Root cause: the gate probe AND the decision prompt read the pipeline's
// `sanitizedDomText`, whose text-PII scan truncates at 8000 chars (and passes
// text through RAW on a scan error) — a secret-shaped fragment in the tail of
// a long page reached the sweep and the old policy aborted the WHOLE turn.
// The firewall envelope's `privacy.sanitizedText` (finalPiiSweepText, 16000
// chars + smuggler strip) is the canonical wire text — the v1.14 FormData
// path already used it; v1.15.7 extends that rule to the gate + prompt, and
// upgrades the last-line policy from "block" to REDACT-AND-VERIFY: mask the
// fragment locally, re-verify, transmit only provably clean text (fail-closed
// preserved — residual → block).
//
//   Part A (Node, pure): masking primitive, marker sweep-inertia, envelope-
//          first gate, scrub helper, residual fail-closed, prompt hygiene.
//   Part B (Playwright, real unpacked extension): summarize a >8k-char page
//          carrying five key-shaped strings past char 8000 → the run must
//          COMPLETE with the answer delivered, the gate must NOT fire, and
//          no raw secret may reach the mock backend.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import {
  sanitizeScreenContext, validateSanitizedPayload, scanTextForSecrets, maskSecretShapedText,
} from '../src/lib/privacy-firewall.js';
import { gateOutboundDecision, scrubOutboundDecisionText, buildPrivacyDecisionPrompt } from '../src/lib/privacy-agent.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://127.0.0.1:8899';
const MOCK = 'http://127.0.0.1:8900';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.tflite': 'application/octet-stream', '.gz': 'application/gzip', '.png': 'image/png' };

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: Boolean(cond) });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
}

// ═══════════════════════════════ PART A ══════════════════════════════════════
const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD' + 'A'.repeat(400);
const SECRET = 'sk-test-qw45ab78cd90ef12gh34';
const FILLER = 'Plain sentence of onboarding notes. '.repeat(430); // ~8.6k chars — past the pipeline's 8000-char scan cap

function pipelineShaped(text) {
  return {
    sanitizedDataUrl: IMG, sanitizedDomText: text, manifest: [],
    stats: { counts: { faces: 0, domSensitive: 0, textPii: 0, objects: 0 }, totalMs: 5 },
  };
}
function envelopeOf(text) {
  return sanitizeScreenContext(pipelineShaped(text), {});
}

async function partA() {
  console.log('\n[Part A] unit — masking primitive · envelope-first gate · scrub helper');

  // A1 — the field failure, reproduced exactly
  const tailText = FILLER + 'Sandbox deploy uses ' + SECRET + ' for the pipeline run.';
  const env = envelopeOf(tailText);
  const oldProbe = validateSanitizedPayload({
    privacyVerification: env.privacyVerification, sanitizedImage: IMG,
    sanitizedText: tailText, safeManifest: env.safeManifest,
    task: 'Summarize this page in clear bullet points.', history: [],
  });
  check('A1 field bug reproduced: old probe (pipeline text) blocks with the sweep reason',
    !oldProbe.ok && oldProbe.reasons.some(r => r.includes('secret-shaped text')),
    oldProbe.reasons[0]);
  check('A1b envelope text is clean (masked marker present, raw absent)',
    !env.sanitizedText.includes(SECRET) && env.sanitizedText.includes('[REDACTED:'));

  // A2 — envelope-first gate passes the payload the old probe refused
  const payload = { ...pipelineShaped(tailText), privacy: env };
  check('A2 gateOutboundDecision (envelope-first) passes the field-failure payload',
    gateOutboundDecision(payload, 'Summarize this page in clear bullet points.', []) === null);

  // A3 — masking primitive: masks every sweep family, raw absent, marker inert
  const dirty = 'keys sk-live-abcdef1234567890abcd and AKIAIOSFODNN7EXAMPLE and ghp_exampletoken1234567890123 '
    + 'plus xoxb-slacktoken12345 and AIzaAAabbccddeeffggHHIIjjkkLLMMnn00pp11qq22 '
    + 'url https://deploy:Tr0ut99@git.example.net/r.git and Bearer v1teenthRowOfChars12345678 and password: Hunt3r2Str0ng';
  const m = maskSecretShapedText(dirty);
  const ids = new Set(m.masked.map(x => x.id));
  check('A3 maskSecretShapedText masks all 9 sweep families',
    ['api_key_snowflake', 'api_key_aws', 'api_key_github', 'api_key_slack', 'api_key_google',
     'url_credentials', 'password_assignment', 'bearer_token'].every(id => ids.has(id)),
    [...ids].join(','));
  check('A3b masked output: raw values absent + residual empty + marker present',
    m.residual.length === 0 && m.text.includes('[REDACTED:secret]')
    && !/(sk-live-abcdef1234567890abcd|AKIAIOSFODNN7EXAMPLE|ghp_exampletoken1234567890123|xoxb-slacktoken12345|AIzaAAabbccddeeffgg|Tr0ut99|v1teenthRowOfChars12345678|Hunt3r2Str0ng)/.test(m.text));
  check('A3c marker itself is sweep-inert (cannot re-form a match)',
    scanTextForSecrets(m.text).length === 0);

  // A4 — isolated prose / existing PII markers must NOT be masked (no false
  // positives at the single-string level the security suite tests)
  const proseSamples = ['Password: required for login.', 'The password assignment) survived review.',
    'Age: 21.', '[REDACTED:password] stays.', 'passed 28/28 checks.'];
  check('A4 prose / existing PII markers untouched (isolated strings)',
    proseSamples.every(s => maskSecretShapedText(s).masked.length === 0));
  // A4b — v1.15.8 TIGHTENED: the blob-level assignment false positive is GONE.
  // The old (?=.*\d) lookahead scanned to end-of-string, so "Password:
  // required" + a later digit ("Room 42.") tripped the sweep inside one blob —
  // the v1.15.7 "documented coarseness" that also black-boxed safe prose on
  // the canvas path (the v1.15.8 field report: "token formats", "secret
  // families:", "key contiguity,"). The lookahead is now BOUNDED TO THE VALUE
  // RUN: this prose blob is left COMPLETELY untouched, while real assignments
  // still mask (A3 / A5 / the v1158 TP controls re-prove that side).
  const blob = 'Password: required for login. Room 42.';
  const mb = maskSecretShapedText(blob);
  check('A4b prose blob with a later digit is NOT masked (v1.15.8 bounded lookahead)',
    mb.masked.length === 0 && mb.residual.length === 0
    && mb.text.includes('Password: required') && mb.text.includes('Room 42.'), mb.text);

  // A5 — pathological adjacency SELF-HEALS: after the key is masked, the
  // assignment pattern consumes "pass + [REDACTED:secret]" entirely, leaving
  // the string clean. Residual stays a fail-closed guard for the theoretical
  // case masking cannot clean.
  const resText = 'pass sk-abcdef1234567890x then room 42';
  const mr = maskSecretShapedText(resText);
  check('A5 pathological text self-heals: raw absent + residual empty + marker present',
    mr.residual.length === 0 && mr.text.includes('[REDACTED:secret]')
    && !mr.text.includes('sk-abcdef1234567890x'), mr.text);
  const scrubRes = scrubOutboundDecisionText({ sanitizedDomText: resText, privacy: null }, 'task', []);
  check('A5b scrub ships the self-healed text (no residual fields, wire text masked)',
    scrubRes.residualFields.length === 0
    && scrubRes.payload.sanitizedDomText.includes('[REDACTED:secret]')
    && !scrubRes.payload.sanitizedDomText.includes('sk-abcdef1234567890x'));

  // A6 — scrub helper: task + history + both text copies, originals untouched
  const hist = [{ action: { type: 'click', selector: '#save' }, result: `clicked; page echoed token: ghp_exampletoken123456789012` }];
  const scrub = scrubOutboundDecisionText({ ...pipelineShaped(tailText), privacy: env },
    'Summarize sk-part-abcdef123456789 page', hist);
  check('A6 scrub masks task + history + page text (note carries ids × counts only)',
    scrub.note.includes('masked') && scrub.note.includes('api_key_snowflake×2') && scrub.note.includes('api_key_github×1')
    && !scrub.note.includes(SECRET),
    scrub.note.slice(0, 90) + '…');
  check('A6b originals untouched (loop display keeps raw history/payload)',
    scrub.payload !== payload && hist[0].result.includes('ghp_exampletoken123456789012'));
  check('A6c scrubbed wire fields pass the gate',
    validateSanitizedPayload({
      privacyVerification: scrub.payload.privacy.privacyVerification, sanitizedImage: IMG,
      sanitizedText: scrub.payload.privacy.sanitizedText, safeManifest: scrub.payload.privacy.safeManifest,
      task: scrub.task, history: scrub.history,
    }).ok);

  // A7 — gate diagnostics name field + pattern ids, never values
  const dirtyEnv = envelopeOf(tailText);
  dirtyEnv.sanitizedText = tailText; // simulate a sweep miss surviving INTO the envelope
  const blockedDiag = gateOutboundDecision({ ...pipelineShaped(tailText), privacy: dirtyEnv }, 'Summarize this page in clear bullet points.', []);
  check('A7 blocked decision carries field+pattern diagnostics (no raw values)',
    Boolean(blockedDiag?.privacyBlocked)
    && String(blockedDiag.actionPlan.action.message).includes('page-text: api_key_snowflake')
    && !String(blockedDiag.actionPlan.action.message).includes(SECRET));

  // A8 — the prompt embeds envelope text (masked), never the raw pipeline tail
  const prompt = buildPrivacyDecisionPrompt(scrub.payload, scrub.task, scrub.history, { vision: true, textCap: 12000 });
  check('A8 prompt is secret-sweep clean and carries the INFORMATION-TASKS contract',
    !prompt.includes(SECRET) && scanTextForSecrets(prompt).length === 0 && prompt.includes('INFORMATION TASKS'));
}

// ═══════════════════════════════ PART B ══════════════════════════════════════
const RAW_SECRETS = ['sk-test-qw45ab78cd90ef12gh34', 'v1teenthRowOfChars12345678', 'Hunt3r2Str0ng',
  'AKIAIOSFODNN7EXAMPLE', 'ghp_exampletoken1234567890123'];
const ANSWER = '• The page is a team handbook with a long benign filler section\n• An appendix lists five legacy integration notes (all redacted before send)\n• Nothing sensitive left the browser';

const captured = { bodies: [], prompts: [] };
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
          const pText = promptTextOf(body);
          captured.prompts.push(pText);
          const content = JSON.stringify({ thought: 'page content already in context', action: { type: 'done', message: ANSWER }, confidence: 0.95, is_complete: true });
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
  console.log('\n[Part B] E2E — real extension: summarize a page with secrets past char 8000');
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
  await wake.goto(`${BASE}/OpenCometBench/e2e/pages/secret-tail.html`).catch(() => {});
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
  const swLogAll = [];
  const currentSw = () => context.serviceWorkers().find(w => w.url().includes(extId)) || sw;
  currentSw().on('console', (msg) => swLogAll.push(msg.text()));
  await panel.addInitScript(() => {
    window.__panelErrors = [];
    window.addEventListener('error', (e) => { try { window.__panelErrors.push(String(e.message)); } catch {} });
  });
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`).catch(() => {});
  await panel.waitForTimeout(800);
  await panel.evaluate(() => {
    localStorage.setItem('opencometPrivacyEnabled', '1');
    localStorage.setItem('opencometPrivacyConfig', JSON.stringify({ serverUrl: 'http://127.0.0.1:8900' }));
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

  const finished = await waitFor(() => swLogAll.some(t => /Privacy agent finished/.test(t)), 180000);
  const gateBlocked = swLogAll.some(t => /NETWORK GATE BLOCKED/.test(t));
  check('B1 privacy run COMPLETES on the secret-tail page (no ask_user dead-end)', Boolean(finished),
    gateBlocked ? 'gate blocked — see SW console' : '');
  check('B2 network gate NEVER fires', !gateBlocked);
  const blockedLine = swLogAll.find(t => /NETWORK GATE BLOCKED/.test(t));
  if (blockedLine) console.log('    gate log:', blockedLine.slice(0, 200));

  await panel.waitForTimeout(1200);
  const card = await panel.evaluate(() => document.querySelector('.result-card .result-text')?.textContent || '');
  check('B3 result card delivers the final answer (not a firewall dead-end)',
    card.includes('team handbook') && card.includes('legacy integration notes'), JSON.stringify(card.slice(0, 80)));

  check('B4 no raw secret reaches the mock backend (all 5 literals absent from every request body)',
    captured.bodies.length > 0 && captured.bodies.every(b => !RAW_SECRETS.some(s => b.includes(s))),
    `${captured.bodies.length} request(s) captured`);
  check('B5 decision prompt carries the INFORMATION-TASKS contract',
    captured.prompts.some(p => p.includes('INFORMATION TASKS') && p.includes('Summarize this page')));
  check('B6 no panel page errors', (await panel.evaluate(() => (window.__panelErrors || []).length)) === 0);

  // B7 — clean-page control: benign page produces NO masking note (no false positives)
  swLogAll.length = 0;
  captured.bodies.length = 0; captured.prompts.length = 0;
  await wake.goto(`${BASE}/OpenCometBench/e2e/pages/nav-links.html`).catch(() => {});
  await wake.waitForTimeout(900);
  await panel.evaluate(() => {
    const ta = document.querySelector('#taskInput');
    ta.value = 'Summarize this page in clear bullet points.';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wake.bringToFront();
  await panel.waitForTimeout(250);
  await panel.evaluate(() => document.querySelector('#sendBtn').click());
  const finished2 = await waitFor(() => swLogAll.some(t => /Privacy agent finished/.test(t)), 180000);
  check('B7 benign-page control: run completes with NO masking note fired',
    Boolean(finished2) && !swLogAll.some(t => /Outbound secret sweep/.test(t)) && !swLogAll.some(t => /NETWORK GATE BLOCKED/.test(t)));

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
console.log('V1.15.7 SECRET-SWEEP SUITE: ALL PASS');
process.exit(0);
