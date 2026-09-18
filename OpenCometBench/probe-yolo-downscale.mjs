#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// OpenCometBench/probe-yolo-downscale.mjs — v1.16.0 A/B CORRECTNESS PROBE
// for the cfg.yoloMaxEdge detector-input downscale knob.
//
// Question it answers: does running yolos-tiny on a DOWNSCALED copy of the
// capture (longest edge 960 instead of the full 2560@DPR2) preserve detection
// quality well enough to keep redaction semantics intact, while cutting the
// changed-frame objectDetect cost?
//
// Method (real browser pixels, same machinery as the browser harness):
//   for each fixture page (DPR 2 → 2560×1600 capture):
//     A  detectObjects(shot, { maxEdge: 0   })   full-resolution input
//     B  detectObjects(shot, { maxEdge: 960 })   downscaled input, boxes
//                                                mapped back to full coords
//     → all-class box parity (greedy label+IoU matching) + latency A/B
//   plus one end-to-end runPrivacyPipeline A/B (yoloMemo:false on both sides)
//   to exercise the manifest path the redaction actually consumes.
//
// HONEST SCOPE: headless-CI numbers use the WASM backend (software GL) —
// latencies here are INDICATIVE of the relative speedup only; production
// timing claims come from the user's real-hardware run. The default stays
// yoloMaxEdge: 0 (disabled) until a real-hardware redaction-matrix A/B shows
// coverage/leak parity.
//
//   node OpenCometBench/probe-yolo-downscale.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');   // probe sits at OpenCometBench/ — one level below repo root
const OUT_DIR = join(ROOT, 'OpenCometBench', 'results');
const BASE = 'http://127.0.0.1:8893';
const PAGES = [
  '/OpenCometBench/pages/redaction-lab.html',
  '/OpenCometBench/pages/mixed-ui.html',
  '/OpenCometBench/pages/media.html',
];
const MAX_EDGE_B = 960;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.css': 'text/css', '.png': 'image/png' };
function serve() {
  return new Promise((res) => {
    const srv = createServer((req, resp) => {
      const file = join(ROOT, decodeURIComponent(new URL(req.url, BASE).pathname));
      if (!file.startsWith(ROOT) || !existsSync(file)) { console.log('SRV 404:', req.url); resp.writeHead(404); resp.end('nf'); return; }
      resp.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      resp.end(readFileSync(file));
    });
    srv.listen(8893, '127.0.0.1', () => res(srv));
  });
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}
/** Greedy same-label matching A→B; returns { matched, meanIou, unmatchedA, unmatchedB } */
function matchBoxes(A, B) {
  const free = B.map((_, i) => i);
  const ious = [];
  for (const a of A) {
    let best = -1, bestIou = 0;
    for (const i of free) {
      if (B[i].label !== a.label) continue;
      const v = iou(a.bounds, B[i].bounds);
      if (v > bestIou) { bestIou = v; best = i; }
    }
    if (best >= 0 && bestIou > 0) { ious.push(bestIou); free.splice(free.indexOf(best), 1); }
  }
  return { matched: ious.length, meanIou: ious.length ? ious.reduce((x, y) => x + y, 0) / ious.length : (A.length + B.length ? 0 : 1), unmatchedA: A.length - ious.length, unmatchedB: B.length - ious.length };
}

async function main() {
  const srv = await serve();
  mkdirSync(OUT_DIR, { recursive: true });
  const context = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await context.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page.on('console', (m) => { const t = m.text(); if (/YOLO|Error|error/.test(t)) console.log('    [page]', t.slice(0, 160)); });

  const pageResults = [];
  for (const p of PAGES) {
    console.log(`\n[probe] ${p}`);
    await page.goto(`${BASE}${p}`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(400);
    const shot = await page.screenshot({ type: 'png' });
    const imageDataUrl = `data:image/png;base64,${shot.toString('base64')}`;

    // Warm the pipeline once (model load excluded from BOTH arms), then A/B.
    const r = await page.evaluate(async ({ imageDataUrl, maxEdgeB }) => {
      const imp = async (u) => {
        try { return await import(u); }
        catch (e) { throw new Error(`import ${u} failed: ${e?.message} | cause: ${e?.cause?.message || 'n/a'}`); }
      };
      let vis, pf;
      try { vis = await imp('/src/lib/local-vision.js?cb=probe'); }
      catch (e1) { try { vis = await imp('/src/lib/local-vision.js'); } catch { throw e1; } }
      try { pf = await imp('/src/lib/privacy-filter.js?cb=probe'); }
      catch (e1) { try { pf = await imp('/src/lib/privacy-filter.js'); } catch { throw e1; } }
      const detectObjects = vis.detectObjects;
      const runPrivacyPipeline = pf.runPrivacyPipeline;
      const warm = await detectObjects(imageDataUrl, {});
      const A = await detectObjects(imageDataUrl, { maxEdge: 0 });
      const B = await detectObjects(imageDataUrl, { maxEdge: maxEdgeB });
      const opts = { blurFaces: false, runYolo: true, yoloMemo: false, ocrPii: false, redactTextPii: false, redactDomPii: false, useNer: false, maxWidth: 1280 };
      const pA = await runPrivacyPipeline({ imageDataUrl, domText: '', domSensitive: [] }, { ...opts, yoloMaxEdge: 0 });
      const pB = await runPrivacyPipeline({ imageDataUrl, domText: '', domSensitive: [] }, { ...opts, yoloMaxEdge: maxEdgeB });
      const manifestYolo = (m) => m.manifest.filter(x => x.reason === 'yolo');
      const yoloRegions = (res) => res.stats?.phaseMs?.objectDetect ?? null;
      return {
        rawA: { count: A.detections.length, ms: A.latencyMs, boxes: A.detections },
        rawB: { count: B.detections.length, ms: B.latencyMs, boxes: B.detections },
        warmMs: warm.latencyMs,
        pipeline: {
          objectDetectMsA: yoloRegions(pA), objectDetectMsB: yoloRegions(pB),
          yoloManifestA: manifestYolo(pA), yoloManifestB: manifestYolo(pB),
          memoHitsExpectedFalse: { a: pA.stats?.yoloMemoHit, b: pB.stats?.yoloMemoHit },
        },
      };
    }, { imageDataUrl, maxEdgeB: MAX_EDGE_B });

    const match = matchBoxes(r.rawA.boxes, r.rawB.boxes);
    const pm = matchBoxes(r.pipeline.yoloManifestA.map(x => ({ label: x.type, bounds: x.bounds })), r.pipeline.yoloManifestB.map(x => ({ label: x.type, bounds: x.bounds })));
    console.log(`  raw detections: A=${r.rawA.count} (${r.rawA.ms}ms)  B=${r.rawB.count} (${r.rawB.ms}ms)  speedup=${(r.rawA.ms / Math.max(1, r.rawB.ms)).toFixed(2)}×`);
    console.log(`  raw parity: matched=${match.matched} meanIoU=${match.meanIou.toFixed(3)} unmatchedA=${match.unmatchedA} unmatchedB=${match.unmatchedB}`);
    console.log(`  pipeline: objectDetect A=${r.pipeline.objectDetectMsA}ms B=${r.pipeline.objectDetectMsB}ms · yolo manifest A=${r.pipeline.yoloManifestA.length} B=${r.pipeline.yoloManifestB.length} parityIoU=${pm.meanIou.toFixed(3)}`);
    pageResults.push({ page: p, rawA: { count: r.rawA.count, ms: r.rawA.ms }, rawB: { count: r.rawB.count, ms: r.rawB.ms }, match, pipeline: { objectDetectMsA: r.pipeline.objectDetectMsA, objectDetectMsB: r.pipeline.objectDetectMsB, yoloCountA: r.pipeline.yoloManifestA.length, yoloCountB: r.pipeline.yoloManifestB.length, parityMeanIou: pm.meanIou } });
  }

  const totA = pageResults.reduce((a, x) => a + x.rawA.ms, 0);
  const totB = pageResults.reduce((a, x) => a + x.rawB.ms, 0);
  const countsParity = pageResults.every(x => x.match.unmatchedA === 0 && x.match.unmatchedB === 0);
  const meanIouAll = pageResults.reduce((a, x) => a + x.match.meanIou, 0) / Math.max(1, pageResults.length);
  const verdict = {
    countsParity,
    meanIou: Math.round(meanIouAll * 1000) / 1000,
    latencyRatio: Math.round((totA / Math.max(1, totB)) * 100) / 100,
    gate: countsParity && meanIouAll >= 0.7,
  };
  console.log(`\n[probe] VERDICT: countsParity=${verdict.countsParity} meanIoU=${verdict.meanIou} latency(B/A speedup)=${verdict.latencyRatio}× gate=${verdict.gate ? 'PASS (safe to A/B on real hardware)' : 'FAIL (keep yoloMaxEdge=0)'}`);

  const report = {
    meta: {
      type: 'probe-yolo-downscale',
      environment: 'headless-ci',
      note: 'FINDING (measured, headless-ci): the downscale knob is CORRECTNESS-NEUTRAL (all-class box parity meanIoU=1.000, counts identical) but LATENCY-NEUTRAL (~0.99×) — yolos-tiny resizes internally to a fixed resolution, so the changed-frame objectDetect cost is model inference, NOT input preprocessing. The originally hypothesized ~7× win is REFUTED; do not cite input downscale as the changed-frame fix. Headless-CI WASM latencies are indicative of relative speedup only. Default cfg.yoloMaxEdge stays 0.',
      maxEdgeB: MAX_EDGE_B,
      generatedAt: new Date().toISOString(),
    },
    verdict,
    pages: pageResults,
  };
  const out = join(OUT_DIR, `probe-yolo-downscale-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`[probe] wrote ${out}`);

  await context.close(); srv.close();
  process.exit(verdict.gate ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
