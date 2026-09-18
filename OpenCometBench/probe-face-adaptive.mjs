#!/usr/bin/env node
// OpenCometBench/probe-face-adaptive.mjs
// Measures the v1.14 ADAPTIVE FACE DETECTION changes on real browser pixels:
//   A. UNCACHED face-less page (redaction-lab, DPR-2) — the production normal
//      path with the risk-adaptive fine cap (16 vs the old 48) and the
//      downscaled full-frame pass. Baseline measurement: faceDetect p50 5570ms.
//   B. HIGH-RISK page (media.html — video present) — fine cap stays 48.
//   C. MEMO — identical pixels: run 2 must return memoHit=true with ~0ms face
//      cost (boxes-only reuse; unchanged-screen optimization).
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.gz': 'application/gzip' };
const srv = createServer((q, r) => {
  const f = ROOT + new URL(q.url, 'http://x').pathname;
  if (!existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': MIME[f.slice(f.lastIndexOf('.'))] || 'application/octet-stream' });
  r.end(readFileSync(f));
});
await new Promise(r => srv.listen(8896, '127.0.0.1', r));

const { readFileSync: rf } = await import('node:fs');
const src = rf(ROOT + '/src/lib/privacy-agent.js', 'utf8');
const start = src.indexOf('function pageContextScan() {');
let i = src.indexOf('{', start), depth = 0, end = -1;
for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) { end = i + 1; break; } } }
const scanSrc = src.slice(start, end);

const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });

async function measure(page, { memo }) {
  const shot = await page.screenshot({ type: 'png' });
  const imageDataUrl = `data:image/png;base64,${shot.toString('base64')}`;
  return page.evaluate(async ({ imageDataUrl, memo }) => {
    const { runPrivacyPipeline } = await import('/src/lib/privacy-filter.js?cb=' + (performance.now() | 0));
    const { classifyFromDomSignals } = await import('/src/lib/page-classifier.js?cb=' + (performance.now() | 0));
    const scan = window.__sihPageContextScan();
    // Emulate the REAL agent wiring (privacy-agent.captureAndSanitize):
    const domDecision = classifyFromDomSignals({ url: location.pathname, title: document.title, text: scan.text, dom: scan.census });
    const faceRisk = {
      visuallyHeavy: (scan.census.videos || 0) > 0 || (scan.census.canvases || 0) > 2,
      hasVideo: (scan.census.videos || 0) > 0,
      canvasHeavy: (scan.census.canvases || 0) >= 2,
      pageType: domDecision.best.type,
    };
    const t0 = performance.now();
    const r = await runPrivacyPipeline(
      { imageDataUrl, domText: scan.text, domSensitive: scan.sensitive, dom: scan.census, url: location.pathname, title: document.title, faceRisk },
      { scaleX: 2, scaleY: 2, maxWidth: 1280, ocrPii: false, runYolo: false, blurFaces: true, redactTextPii: true, faceDetect: { memo } },
    );
    return {
      wallMs: Math.round(performance.now() - t0),
      faceMs: r.stats.phaseMs.faceDetect,
      faces: r.stats.counts.faces,
      debug: {
        tiles: r.stats.faceDebug?.tilesScanned, fineTiles: r.stats.faceDebug?.fineTilesScanned,
        ffScale: r.stats.faceDebug?.ffScale, fineCap: r.stats.faceDebug?.fineCap,
        highRisk: r.stats.faceDebug?.highRisk, memoHit: Boolean(r.stats.faceDebug?.memoHit),
        pageType: r.visualContext?.pageType,
      },
    };
  }, { imageDataUrl, memo });
}

async function open(url) {
  const page = await ctx.newPage();
  await page.addInitScript(`${scanSrc}\nwindow.__sihPageContextScan = () => pageContextScan();`);
  await page.goto(url, { waitUntil: 'networkidle' });
  return page;
}

const out = {};
{
  const page = await open('http://127.0.0.1:8896/OpenCometBench/pages/redaction-lab.html');
  await measure(page, { memo: false }); // warm models
  out.A_normal_uncached = [];
  for (let k = 0; k < 3; k++) out.A_normal_uncached.push(await measure(page, { memo: false }));
  out.C_memo = [];
  for (let k = 0; k < 3; k++) out.C_memo.push(await measure(page, { memo: true }));
  await page.close();
}
{
  const page = await open('http://127.0.0.1:8896/OpenCometBench/pages/media.html');
  await measure(page, { memo: false }); // warm
  out.B_highrisk_uncached = [];
  for (let k = 0; k < 3; k++) out.B_highrisk_uncached.push(await measure(page, { memo: false }));
  await page.close();
}

const median = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(JSON.stringify({
  A_normal_uncached_faceMs: out.A_normal_uncached.map(r => r.faceMs),
  A_median_faceMs: median(out.A_normal_uncached.map(r => r.faceMs)),
  A_debug: out.A_normal_uncached[0].debug,
  B_highrisk_faceMs: out.B_highrisk_uncached.map(r => r.faceMs),
  B_debug: out.B_highrisk_uncached[0].debug,
  C_memo_faceMs: out.C_memo.map(r => r.faceMs),
  C_memoHits: out.C_memo.map(r => r.debug.memoHit),
  C_memo_faces: out.C_memo.map(r => r.faces),
}, null, 1));

await browser.close(); srv.close(); process.exit(0);
