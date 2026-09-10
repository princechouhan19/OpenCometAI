#!/usr/bin/env node
// scripts/check_dashboard_render.js — headless render check for the SIH admin
// dashboard. Module scripts are blocked under file:// (opaque origin), so this
// serves OpenCometBench/ over loopback HTTP and loads dashboard.html from there.
// Verifies the seed loads and the authoritative KPIs are actually visible.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'OpenCometBench');
const PORT = 8895;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const srv = createServer((req, resp) => {
  const p = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${PORT}`).pathname);
  const file = join(ROOT, p === '/' ? 'dashboard.html' : p);
  if (!file.startsWith(ROOT) || !existsSync(file)) { resp.writeHead(404); resp.end('nf'); return; }
  resp.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  resp.end(readFileSync(file));
});
await new Promise(res => srv.listen(PORT, '127.0.0.1', res));

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:${PORT}/dashboard.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const text = await page.evaluate(() => document.body.innerText);
const seedOk = await page.evaluate(() => Boolean(window.__DASHBOARD_SEED__ && window.__DASHBOARD_SEED__.authoritative));
const checks = [
  ['seed loaded', seedOk],
  ['warm P50 1216 visible', text.includes('1216')],
  ['changed-frame 12885 visible', text.includes('12885')],
  ['OCR 0.75 visible', text.includes('0.75')],
  ['redaction 340 visible', text.includes('340')],
  ['e2e 0.952 visible', text.includes('0.952')],
  ['auth report filename visible', text.includes('browser-benchmark-1788731519242')],
  ['zero page errors', errors.length === 0],
];
let fail = 0;
for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) fail++; }
if (errors.length) console.log('page errors:', errors.join(' | '));
await browser.close();
srv.close();
process.exit(fail ? 1 : 0);
