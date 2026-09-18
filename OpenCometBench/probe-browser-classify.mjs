#!/usr/bin/env node
// Probe: browser census + classification on one page.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pageName = process.argv[2] || 'canvas-app.html';

const srv = createServer((q, r) => {
  const f = ROOT + new URL(q.url, 'http://x').pathname;
  if (!existsSync(f)) { r.writeHead(404); r.end(); return; }
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  r.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': MIME[f.slice(f.lastIndexOf('.'))] || 'application/octet-stream' });
  r.end(readFileSync(f));
});
await new Promise(r => srv.listen(8899, '127.0.0.1', r));

const src = readFileSync(ROOT + '/src/lib/privacy-agent.js', 'utf8');
const start = src.indexOf('function pageContextScan() {');
let i = src.indexOf('{', start), depth = 0, end = -1;
for (; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (!depth) { end = i + 1; break; } }
}
const scanSrc = src.slice(start, end);

const b = await chromium.launch();
const p = await b.newPage();
await p.goto(`http://127.0.0.1:8899/OpenCometBench/pages/${pageName}`, { waitUntil: 'networkidle' });
const scanOut = await p.evaluate(`(${scanSrc})()`);
console.log('scan keys:', Object.keys(scanOut), 'sensitive:', scanOut.sensitive?.length, 'textChars:', scanOut.text?.length, 'census:', JSON.stringify(scanOut.census));
const census = scanOut.census;
console.log('census:', JSON.stringify(census));
const cls = await p.evaluate(async ({ census }) => {
  const m = await import('/src/lib/page-classifier.js?cb=' + Date.now());
  return m.classifyVisualContext({ url: location.origin + location.pathname, title: document.title, text: '', dom: census }, null);
}, { census });
console.log('classify (no text):', JSON.stringify({ pageType: cls.pageType, confidence: cls.confidence, scores: cls.scores ?? null }));
await b.close();
srv.close();
process.exit(0);
