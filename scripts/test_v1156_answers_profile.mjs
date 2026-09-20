#!/usr/bin/env node
// scripts/test_v1156_answers_profile.mjs — v1.15.6 regression (real extension).
//
// Covers the user's field report ("FAILED AT FINAL RESPONSE TASK WAS OF
// SUMMARIZATION … Task complete." with NO summary) + the Profile request:
//
//   T1 SUMMARIZE DELIVERS THE ANSWER — "Summarize this page in clear bullet
//      points." completes with the model's FULL answer rendered in the result
//      card (not a bare "Task complete."), the decision prompt carries the new
//      INFORMATION-TASKS contract, and History stores the answer.
//   T2 PROFILE FEEDS THE AGENT — saved Settings → Profile data (fixed fields +
//      custom label/value rows) reaches the VLM prompt as a TRUSTED USER
//      PROFILE block; the agent answers "What is my age?" from it.
//   T3 PROFILE UI ROUND-TRIP — custom rows render saved values, add/remove
//      works, Save persists to chrome.storage, reload re-renders.
//   T4 About page version chip tracks the manifest (v1.15.6).
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://127.0.0.1:8897';
const MOCK = 'http://127.0.0.1:8898';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.tflite': 'application/octet-stream', '.gz': 'application/gzip', '.png': 'image/png' };

function serve() {
  return new Promise((res) => {
    const srv = createServer((req, resp) => {
      const p = decodeURIComponent(new URL(req.url, BASE).pathname);
      const file = join(ROOT, p);
      if (!file.startsWith(ROOT) || !existsSync(file)) { resp.writeHead(404); resp.end('nf'); return; }
      resp.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      resp.end(readFileSync(file));
    });
    srv.listen(8897, '127.0.0.1', () => res(srv));
  });
}

const captured = { prompts: [] };
function promptTextOf(bodyStr) {
  try {
    const parsed = JSON.parse(bodyStr);
    const c = parsed?.messages?.[1]?.content;
    return typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(p => p?.type === 'text').map(p => p.text).join('\n') : '');
  } catch { return ''; }
}
const SUMMARY_ANSWER = '• The page is a small nav-links fixture with three section links\n• A pricing link is present (#link-pricing)\n• Content is short by design for tests';
function decisionFor(task) {
  if (task.includes('Summarize this page')) {
    return { thought: 'page content already in context', action: { type: 'done', message: SUMMARY_ANSWER }, confidence: 0.95, is_complete: true };
  }
  if (task.includes('What is my age')) {
    return { thought: 'answer from saved profile', action: { type: 'done', message: 'Your saved age is 21.' }, confidence: 0.95, is_complete: true };
  }
  return { thought: 'task verified complete', action: { type: 'done', message: 'Done.' }, confidence: 0.9, is_complete: true };
}
function startCompatMock() {
  return new Promise((res) => {
    const srv = createServer((req, resp) => {
      if (req.method === 'POST' && req.url.includes('/chat/completions')) {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const pText = promptTextOf(body);
          captured.prompts.push(pText);
          const m = /TASK: (.*)/.exec(pText);
          const content = JSON.stringify(decisionFor(m ? m[1] : ''));
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
    srv.listen(8898, '127.0.0.1', () => res(srv));
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
    ],
  });

  const wake = await context.newPage();
  await wake.goto(`${BASE}/OpenCometBench/e2e/pages/nav-links.html`).catch(() => {});
  await wake.waitForTimeout(1200);
  let sw = null;
  for (let i = 0; i < 30 && !sw; i++) {
    sw = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
    if (!sw) await new Promise(r => setTimeout(r, 500));
  }
  if (!sw) { console.error('SW never appeared'); process.exit(1); }
  const extId = new URL(sw.url()).hostname;
  console.log('SW online');

  // Configure provider → mock endpoint + SAVED PROFILE with custom info rows.
  await sw.evaluate(async () => {
    const key = 'opencometSettings';
    const data = await chrome.storage.local.get(key);
    const settings = { ...(data[key] || {}) };
    settings.provider = 'custom';
    settings.providerBaseUrl = 'http://127.0.0.1:8898/v1';
    settings.apiKey = 'test-key';
    settings.model = 'mock-vlm';
    settings.profileData = {
      fullName: 'Aarav Sharma',
      email: 'aarav.sharma@example.com',
      phone: '+91 98765 43210',
      address: '12 Example Road, Jaipur',
      company: '', website: '', notes: '',
      customInfo: [
        { key: 'Age', value: '21' },
        { key: 'Shirt size', value: 'M' },
      ],
    };
    await chrome.storage.local.set({ [key]: settings });
    return true;
  });

  const panel = await context.newPage();
  const swLogAll = [];
  const currentSw = () => context.serviceWorkers().find(w => w.url().includes(extId)) || sw;
  currentSw().on('console', (msg) => swLogAll.push(msg.text()));
  panel.on('pageerror', (e) => { try { window.__panelErrors.push(String(e.message)); } catch {} });
  await panel.addInitScript(() => {
    window.__panelErrors = [];
    window.addEventListener('error', (e) => {
      try { window.__panelErrors.push(String(e.message)); } catch {}
    });
  });
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`).catch(() => {});
  await panel.waitForTimeout(800);
  await panel.evaluate(() => {
    localStorage.setItem('opencometPrivacyEnabled', '1');
    localStorage.setItem('opencometPrivacyConfig', JSON.stringify({ serverUrl: 'http://127.0.0.1:8898' }));
    localStorage.setItem('opencometAgentMode', 'auto');
  });
  await panel.reload();
  await panel.waitForTimeout(1200);

  async function startTask(task) {
    await panel.evaluate((t) => {
      const ta = document.querySelector('#taskInput');
      ta.value = t;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, task);
    await wake.bringToFront();
    await panel.waitForTimeout(250);
    await panel.evaluate(() => document.querySelector('#sendBtn').click());
  }
  async function resultCardText() {
    return panel.evaluate(() => document.querySelector('.result-card .result-text')?.textContent || '');
  }

  // ═══ T1: summarize task → FULL ANSWER in the result card ═══
  console.log('\n[T1] Summarize task delivers the final answer (not "Task complete.")');
  const promptsBefore = captured.prompts.length;
  await startTask('Summarize this page in clear bullet points.');
  const done1 = await waitFor(() => swLogAll.some(t => /Privacy agent finished/.test(t)), 120000);
  check('privacy run completed', Boolean(done1));
  await panel.waitForTimeout(1200);
  const card1 = await resultCardText();
  check('result card shows the FULL answer', card1.includes('nav-links fixture') && card1.includes('pricing link') && card1.includes('short by design'),
    JSON.stringify(card1.slice(0, 120)));
  check('result card is NOT the bare "Task complete."', card1.trim() !== 'Task complete.', card1.slice(0, 60));
  const sumPrompt = captured.prompts.slice(promptsBefore).find(p => p.includes('Summarize this page'));
  check('decision prompt carries the INFORMATION-TASKS contract', Boolean(sumPrompt && sumPrompt.includes('INFORMATION TASKS')));
  check('done action contract exposes message field', Boolean(sumPrompt && sumPrompt.includes('"message"')));
  check('answer step rendered in transcript', swLogAll.some(t => /Final answer ready/.test(t)));
  const histEntry = await sw.evaluate(async () => {
    const d = await chrome.storage.local.get('opencometHistory');
    const h = d['opencometHistory'] || [];
    return h.find(x => String(x.task || '').includes('Summarize this page')) || null;
  });
  check('History entry stores the answer', Boolean(histEntry && String(histEntry.result || '').includes('nav-links fixture')),
    histEntry ? String(histEntry.result).slice(0, 60) : 'no entry');
  check('no panel page errors (T1)', (await panel.evaluate(() => (window.__panelErrors || []).length)) === 0);

  // ═══ T2: profile data reaches the VLM + agent answers from it ═══
  console.log('\n[T2] Saved Profile (fixed + custom fields) reaches the agent prompt');
  swLogAll.length = 0;
  const promptsBefore2 = captured.prompts.length;
  await startTask('What is my age?');
  const done2 = await waitFor(() => swLogAll.some(t => /Privacy agent finished/.test(t)), 120000);
  check('privacy run completed (profile question)', Boolean(done2));
  await panel.waitForTimeout(1200);
  const agePrompt = captured.prompts.slice(promptsBefore2).find(p => p.includes('What is my age'));
  check('USER PROFILE block present in prompt', Boolean(agePrompt && agePrompt.includes('USER PROFILE')));
  check('custom row "Age: 21" reached the model', Boolean(agePrompt && /-\s*Age:\s*21/.test(agePrompt)));
  check('custom row "Shirt size: M" reached the model', Boolean(agePrompt && /-\s*Shirt size:\s*M/.test(agePrompt)));
  check('fixed field "Full name: Aarav Sharma" reached the model', Boolean(agePrompt && agePrompt.includes('Full name: Aarav Sharma')));
  const card2 = await resultCardText();
  check('agent answers from profile', card2.includes('Your saved age is 21.'), JSON.stringify(card2.slice(0, 80)));

  // ═══ T3: Profile UI round-trip (render · add · save · reload) ═══
  console.log('\n[T3] Settings → Profile custom info UI round-trip');
  await panel.evaluate(() => window.showView ? window.showView('settings') : document.querySelector('#navSettings')?.click());
  await panel.waitForTimeout(400);
  await panel.evaluate(() => document.querySelector('.settings-nav-card[data-settings-target="profile"]')?.click());
  await panel.waitForTimeout(400);
  const rows0 = await panel.$$eval('#customInfoList .ci-row', els => els.map(r => ({
    key: r.querySelector('.ci-key')?.value, value: r.querySelector('.ci-value')?.value,
  })));
  check('saved custom rows render (2 rows)', rows0.length === 2 && rows0[0].key === 'Age' && rows0[0].value === '21' && rows0[1].key === 'Shirt size',
    JSON.stringify(rows0));
  await panel.click('#addCustomInfoBtn');
  await panel.fill('#customInfoList .ci-row:nth-child(3) .ci-key', 'City');
  await panel.fill('#customInfoList .ci-row:nth-child(3) .ci-value', 'Jaipur');
  await panel.evaluate(() => document.querySelector('#saveSettingsBtn')?.click());
  await panel.waitForTimeout(1200);
  const stored = await sw.evaluate(async () => {
    const d = await chrome.storage.local.get('opencometSettings');
    return d['opencometSettings']?.profileData?.customInfo || [];
  });
  check('Save persists 3 custom rows to storage', stored.length === 3 && stored.some(e => e.key === 'City' && e.value === 'Jaipur'),
    JSON.stringify(stored));
  await panel.reload();
  await panel.waitForTimeout(1200);
  const rows1 = await panel.evaluate(() => {
    document.querySelector('#navSettings')?.click();
    return new Promise((res) => setTimeout(() => {
      document.querySelector('.settings-nav-card[data-settings-target="profile"]')?.click();
      setTimeout(() => {
        res([...document.querySelectorAll('#customInfoList .ci-row')].map(r => r.querySelector('.ci-key')?.value));
      }, 350);
    }, 350));
  });
  check('reload re-renders the saved rows', rows1.length === 3 && rows1.includes('City'), JSON.stringify(rows1));
  // remove-row path still works
  await panel.click('#customInfoList .ci-row:nth-child(3) .ci-remove');
  const rows2 = await panel.$$eval('#customInfoList .ci-row', els => els.length);
  check('remove deletes a row in the UI', rows2 === 2, String(rows2));

  // ═══ T4: About page version chip == manifest (v1.15.6) ═══
  console.log('\n[T4] About page version chip');
  await panel.evaluate(() => {
    document.querySelector('.settings-nav-card[data-settings-target="about"]')?.click();
  });
  await panel.waitForTimeout(350);
  const ver = await panel.textContent('#aboutVersion');
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  check('version chip tracks manifest', (ver || '').trim() === `v${manifest.version}`, `${ver} vs v${manifest.version}`);
  // dynamic — the About test owns the changelog structure checks;
  // here we only assert the newest entry matches the on-disk manifest version.
  const manifestV1156 = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  check('changelog newest entry tracks the manifest version', (await panel.textContent('.about-cl-item.newest .about-cl-ver')).trim() === `v${manifestV1156.version}`);

  await context.close();
  srv.close(); mock.close();

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log('FAILED:', failed.map(f => f.name).join(' · ')); process.exit(1); }
  console.log('V1.15.6 ANSWERS+PROFILE SUITE: ALL PASS');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
