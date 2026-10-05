#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// OpenCometBench/probe-ort-threads.mjs — v1.31.0 ORT-Web THREAD UNLOCK probe.
//
// Measures the REAL vendored Transformers.js + ORT-Web stack (same threaded
// wasm build the extension ships) running the REAL detector model
// (Xenova/yolos-tiny q8) with numThreads=1 vs numThreads=N, inside a
// cross-origin-isolated Playwright page (COOP/COEP headers → SharedArrayBuffer
// available → ORT worker threads possible).
//
// Quality gate: both arms must produce IDENTICAL detections (same count,
// labels, rounded boxes) — the threads change must be latency-only.
//
// Output: OpenCometBench/results/probe-ort-threads-<ts>.json
//   node OpenCometBench/probe-ort-threads.mjs [--runs=3] [--threads=4]
// ─────────────────────────────────────────────────────────────────────────────
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');   // repo root (probe lives directly in OpenCometBench/)
const OUT_DIR = join(ROOT, 'OpenCometBench', 'results');
const PORT = 8896;

const argv = process.argv.slice(2);
const RUNS = Math.max(1, Number((argv.find(a => a.startsWith('--runs=')) || '--runs=3').split('=')[1]) || 3);
const THREADS = Math.max(2, Number((argv.find(a => a.startsWith('--threads=')) || '--threads=4').split('=')[1]) || 4);

const PROBE_HTML = `<!doctype html><meta charset="utf-8"><title>ort-threads probe</title>
<script type="module">
const ORT_BASE = '/src/vendor/transformers/ort/';
const TR_URL = '/src/vendor/transformers/transformers.min.js';
const MODEL = 'Xenova/yolos-tiny';

function sceneDataURL() {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 800;
  const g = c.getContext('2d');
  g.fillStyle = '#f4f4f4'; g.fillRect(0, 0, 1280, 800);
  for (let i = 0; i < 14; i++) {
    const x = 30 + (i % 7) * 170, y = 40 + Math.floor(i / 7) * 220;
    g.fillStyle = '#1a1a2e'; g.fillRect(x, y, 150, 28);
    g.fillStyle = '#e94560'; g.fillRect(x, y + 40, 150, 120);
    g.fillStyle = '#16213e'; g.fillRect(x, y + 170, 150, 30);
  }
  return c.toDataURL('image/png');
}

window.__lastBoxes = null;
window.runProbe = async ({ threads, runs }) => {
  const tr = await import(TR_URL);
  tr.env.useWasmCache = false;
  tr.env.backends.onnx.wasm.wasmPaths = { mjs: ORT_BASE + 'ort-wasm-simd-threaded.asyncify.mjs', wasm: ORT_BASE + 'ort-wasm-simd-threaded.asyncify.wasm' };
  tr.env.backends.onnx.wasm.numThreads = threads;
  tr.env.allowLocalModels = false;
  tr.env.useBrowserCache = true;
  const t0 = performance.now();
  const pipe = await tr.pipeline('object-detection', MODEL, { dtype: 'q8', device: 'wasm' });
  const initMs = Math.round(performance.now() - t0);
  const img = sceneDataURL();
  const times = [];
  let boxes = null;
  for (let i = 0; i < runs; i++) {
    const a = performance.now();
    const out = await pipe(img);
    times.push(performance.now() - a);
    if (i === 0) {
      boxes = (out || []).map(o => ({ label: o.label, score: Math.round(o.score * 1000) / 1000, box: [Math.round(o.box.xmin), Math.round(o.box.ymin), Math.round(o.box.xmax), Math.round(o.box.ymax)] }));
    }
  }
  times.sort((a, b) => a - b);
  window.__lastBoxes = boxes;
  return { threads, initMs, times: times.map(t => Math.round(t)), median: times[Math.floor(times.length / 2)], isolated: self.crossOriginIsolated, sab: typeof SharedArrayBuffer !== 'undefined', cores: navigator.hardwareConcurrency };
};
</script>`;

async function main() {
  const srv = await new Promise((res) => {
    const s = createServer((req, resp) => {
      const cors = {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cache-Control': 'no-store',
      };
      if (req.url === '/__probe.html') {
        resp.writeHead(200, { 'Content-Type': 'text/html', ...cors });
        resp.end(PROBE_HTML);
        return;
      }
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = join(ROOT, p);
      if (!file.startsWith(ROOT) || !existsSync(file)) { resp.writeHead(404); resp.end('nf'); return; }
      const mime = p.endsWith('.mjs') || p.endsWith('.js') ? 'text/javascript' : p.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
      resp.writeHead(200, { 'Content-Type': mime, ...cors });
      resp.end(readFileSync(file));
    });
    s.listen(PORT, '127.0.0.1', () => res(s));
  });

  const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  page.on('console', m => { const t = m.text(); if (/error|fail/i.test(t) && !/Download/i.test(t)) console.log('  [page]', t.slice(0, 200)); });
  await page.goto(`http://127.0.0.1:${PORT}/__probe.html`, { waitUntil: 'load' });

  console.log(`probe: vendored ORT (ort-wasm-simd-threaded) + Xenova/yolos-tiny q8 wasm · ${RUNS} runs/arm · COOP/COEP isolated page`);
  const r1 = await page.evaluate(({ threads, runs }) => window.runProbe({ threads, runs }), { threads: 1, runs: RUNS });
  const refBoxes = await page.evaluate(() => window.__lastBoxes);
  console.log(`  threads=1 · init ${r1.initMs}ms · med ${r1.median}ms · runs ${r1.times.join(', ')} · isolated=${r1.isolated} sab=${r1.sab} cores=${r1.cores}`);

  let rN = null, parity = null;
  try {
    rN = await page.evaluate(({ threads, runs }) => window.runProbe({ threads, runs }), { threads: THREADS, runs: RUNS });
    const gotBoxes = await page.evaluate(() => window.__lastBoxes);
    parity = { refCount: (refBoxes || []).length, gotCount: (gotBoxes || []).length, identical: JSON.stringify(refBoxes) === JSON.stringify(gotBoxes) };
    console.log(`  threads=${THREADS} · init ${rN.initMs}ms · med ${rN.median}ms · runs ${rN.times.join(', ')}`);
    console.log(`  box parity: ${parity.identical ? 'IDENTICAL' : `DIFFERS ref=${parity.refCount} got=${parity.gotCount}`}`);
  } catch (e) {
    console.log(`  threads=${THREADS} arm failed: ${String(e.message || e).slice(0, 200)} (this browser/context may not support SAB worker threads)`);
  }

  const result = {
    meta: {
      type: 'probe-ort-threads', generatedAt: new Date().toISOString(),
      model: 'Xenova/yolos-tiny', dtype: 'q8', device: 'wasm', vendored: true, runs: RUNS,
      note: 'Real vendored ort-wasm-simd-threaded build on a COOP/COEP isolated page. Quality gate: detections must be identical across thread counts.',
    },
    threads1: r1,
    threadsN: rN,
    threadCount: THREADS,
    speedup: (rN && rN.median) ? Math.round((r1.median / rN.median) * 100) / 100 : null,
    boxParity: parity,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, `probe-ort-threads-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`wrote ${out}`);
  await browser.close();
  srv.close();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
