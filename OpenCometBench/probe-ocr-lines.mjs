#!/usr/bin/env node
// probe: does the vendored tesseract v5 recognize() return line structure?
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';
const ROOT = '/home/z/my-project/upload/OpenCometAI-SIH-extracted/OpenCometAI-SIH';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.gz': 'application/gzip', '.wasm': 'application/wasm' };
const srv = createServer((q, r) => {
  const f = ROOT + new URL(q.url, 'http://x').pathname;
  if (!existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': MIME[f.slice(f.lastIndexOf('.'))] || 'application/octet-stream' });
  r.end(readFileSync(f));
});
await new Promise(r => srv.listen(8898, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8898/OpenCometBench/pages/pii-visual.html', { waitUntil: 'networkidle' });
const shot = await page.screenshot({ type: 'png' });
const imageDataUrl = `data:image/png;base64,${shot.toString('base64')}`;
const out = await page.evaluate(async ({ imageDataUrl }) => {
  const { scanImageForPiiRegions } = await import('/src/lib/ocr-pii.js?cb=' + (performance.now() | 0));
  await scanImageForPiiRegions('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=');
  // reach into the SAME engine for a raw recognize (via a fresh worker on the page)
  const VENDOR = (f) => new URL(`/src/vendor/tesseract/${f}`, location.href).href;
  const mod = await import(VENDOR('tesseract.esm.min.js'));
  const lib = mod?.default?.createWorker ? mod.default : mod;
  const worker = await lib.createWorker('eng', 1, { workerPath: VENDOR('worker.min.js'), corePath: VENDOR('core/'), langPath: VENDOR('lang/'), workerBlobURL: false });
  const { data } = await worker.recognize(imageDataUrl);
  const keys = Object.keys(data);
  const line0 = data.lines?.[0];
  const word0 = data.words?.[0];
  return {
    keys,
    linesLen: data.lines?.length ?? null,
    line0: line0 ? { bbox: line0.bbox, text: String(line0.text).trim().slice(0, 40) } : null,
    word0: word0 ? { bbox: word0.bbox, text: word0.text } : null,
    lineVsWordHeights: data.lines && data.words ? data.lines.slice(0, 6).map((l, i) => ({
      lineH: l.bbox.y1 - l.bbox.y0,
      wordHs: data.words.filter(w => w.bbox.y0 >= l.bbox.y0 - 4 && w.bbox.y1 <= l.bbox.y1 + 4).slice(0, 4).map(w => w.bbox.y1 - w.bbox.y0),
    })) : null,
  };
}, { imageDataUrl });
console.log(JSON.stringify(out, null, 1));
await browser.close(); srv.close(); process.exit(0);
