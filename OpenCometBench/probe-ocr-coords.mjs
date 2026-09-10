#!/usr/bin/env node
// Probe: OCR region coords vs GT element coords on pii-visual.html
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';
const ROOT = '/home/z/my-project/upload/OpenCometAI-SIH-extracted/OpenCometAI-SIH';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.gz': 'application/gzip' };
const srv = createServer((q, r) => {
  const f = ROOT + new URL(q.url, 'http://x').pathname;
  if (!existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': MIME[f.slice(f.lastIndexOf('.'))] || 'application/octet-stream' });
  r.end(readFileSync(f));
});
await new Promise(r => srv.listen(8895, '127.0.0.1', r));

const src = readFileSync(ROOT + '/src/lib/privacy-agent.js', 'utf8');
const start = src.indexOf('function pageContextScan() {');
let i = src.indexOf('{', start), depth = 0, end = -1;
for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) { end = i + 1; break; } } }
const scanSrc = src.slice(start, end);

const b = await chromium.launch();
const p = await b.newPage();
await p.addInitScript(`${scanSrc}
window.__sihPageContextScan = () => pageContextScan();`);
await p.goto('http://127.0.0.1:8895/OpenCometBench/pages/pii-visual.html', { waitUntil: 'networkidle' });
const shot = await p.screenshot({ type: 'png' });
const imageDataUrl = `data:image/png;base64,${shot.toString('base64')}`;

const gt = await p.evaluate(() => {
  return (window.__SIH_GT__.visualPiiElements || []).map(s => {
    const r = document.querySelector(s.selector).getBoundingClientRect();
    return { sel: s.selector, css: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } };
  });
});
console.log('GT boxes:', JSON.stringify(gt, null, 1));

const out = await p.evaluate(async ({ imageDataUrl }) => {
  const { runPrivacyPipeline } = await import('/src/lib/privacy-filter.js?cb=9');
  const scan = window.__sihPageContextScan();
  const r = await runPrivacyPipeline({ imageDataUrl, domText: scan.text, domSensitive: scan.sensitive },
    { scaleX: 1, scaleY: 1, maxWidth: 1280, ocrPii: true, runYolo: false, blurFaces: false, redactTextPii: true });
  return {
    manifest: r.manifest.map(m => ({ type: m.type, bounds: m.bounds, reason: m.reason || m.source })),
    counts: r.stats.counts,
    img: r.stats.image,
  };
}, { imageDataUrl });
console.log('manifest:', JSON.stringify(out.manifest, null, 1));
console.log('counts:', JSON.stringify(out.counts), 'img:', JSON.stringify(out.img));
await b.close(); srv.close(); process.exit(0);
