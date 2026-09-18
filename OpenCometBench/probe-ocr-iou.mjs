#!/usr/bin/env node
// OpenCometBench/probe-ocr-iou.mjs — v1.14: diagnose the OCR bounding-box error
// DIRECTION before tuning anything. For each GT painted-PII box:
// dump GT box, best OCR region, IoU, and the width/height/offset ratios.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.gz': 'application/gzip', '.wasm': 'application/wasm' };
const srv = createServer((q, r) => {
  const f = ROOT + new URL(q.url, 'http://x').pathname;
  if (!existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': MIME[f.slice(f.lastIndexOf('.'))] || 'application/octet-stream' });
  r.end(readFileSync(f));
});
await new Promise(r => srv.listen(8897, '127.0.0.1', r));

const src = readFileSync(ROOT + '/src/lib/privacy-agent.js', 'utf8');
const start = src.indexOf('function pageContextScan() {');
let i = src.indexOf('{', start), depth = 0, end = -1;
for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) { end = i + 1; break; } } }
const scanSrc = src.slice(start, end);

const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.addInitScript(`${scanSrc}\nwindow.__sihPageContextScan = () => pageContextScan();`);
await page.goto('http://127.0.0.1:8897/OpenCometBench/pages/pii-visual.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const shot = await page.screenshot({ type: 'png' });
const imageDataUrl = `data:image/png;base64,${shot.toString('base64')}`;

const out = await page.evaluate(async ({ imageDataUrl }) => {
  const { scanImageForPiiRegions } = await import('/src/lib/ocr-pii.js?cb=' + (performance.now() | 0));
  // warm
  await scanImageForPiiRegions('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=');
  const r = await scanImageForPiiRegions(imageDataUrl, { minConfidence: 55 });
  const gt = (window.__SIH_GT__.ocrPiiBoxes || []);
  const area = b => Math.max(0, b.w) * Math.max(0, b.h);
  const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return {
    regions: r.regions,
    rows: gt.map(g => {
      const gtImg = { x: g.box.x, y: g.box.y, w: g.box.w, h: g.box.h }; // DPR=1 → css==img
      let best = null, bestIou = 0;
      for (const reg of r.regions) {
        const a = inter(gtImg, reg.bounds), u = area(gtImg) + area(reg.bounds) - a;
        const iou = u > 0 ? a / u : 0;
        if (iou > bestIou) { bestIou = iou; best = reg; }
      }
      return {
        type: g.type, gt: gtImg,
        region: best ? best.bounds : null,
        iou: Math.round(bestIou * 1000) / 1000,
        wRatio: best ? Math.round((best.bounds.w / gtImg.w) * 100) / 100 : null,
        hRatio: best ? Math.round((best.bounds.h / gtImg.h) * 100) / 100 : null,
        dx: best ? best.bounds.x - gtImg.x : null,
        dy: best ? best.bounds.y - gtImg.y : null,
      };
    }),
  };
}, { imageDataUrl });
console.log(JSON.stringify(out, null, 1));
await browser.close(); srv.close(); process.exit(0);
