#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// OpenCometBench/probe-scene-change.mjs — v1.14.1 SCENE-CHANGE ATTACK PROBE
// (SIH brief §11: MANDATORY when detector caching is introduced.)
//
// Runs the REAL perception pipeline (real YOLO Xenova/yolos-tiny, real canvas
// redaction) in a REAL Chromium against programmatically drawn scenes:
//
//   A1  safe scene, first capture      → memo MISS  (detector runs)
//   A2  safe scene, identical capture  → memo HIT   (reuse valid: SAME pixels)
//   B1  scene CHANGES to sensitive     → memo MISS  → full re-detection
//        └─ the attack: a cached "safe" result must NEVER survive a scene
//           change; with exact-capture keying it structurally cannot.
//   B2  sensitive scene, identical     → memo HIT   (same pixels as B1)
//   T   B with one tampered byte       → memo MISS  (no near-duplicate reuse)
//
// PASS = the five memo semantics hold + identical-scene reuse returns the
// SAME detections + the pipeline never throws. Whether yolos-tiny fires on
// the drawn person is reported INFORMATIONALLY (person recall is measured by
// the redaction matrix + adversarial suite, not by a synthetic drawing).
//
// Environment: headless CI (SwiftShader). Memo SEMANTICS are
// environment-independent; absolute latencies here are NOT production claims.
// Result: OpenCometBench/results/scene-change-probe-<ts>.json
// ─────────────────────────────────────────────────────────────────────────────
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
// Repo root derived from this file's location (portable — runs on any machine,
// matching the harness's path handling).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.gz': 'application/gzip' };
const srv = createServer((q, r) => {
  const f = ROOT + new URL(q.url, 'http://x').pathname;
  if (!existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': MIME[f.slice(f.lastIndexOf('.'))] || 'application/octet-stream' });
  r.end(readFileSync(f));
});
await new Promise(r => srv.listen(8896, '127.0.0.1', r));

const b = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const p = await ctx.newPage();
const pageErrors = [];
p.on('pageerror', e => pageErrors.push(String(e).slice(0, 300)));
await p.goto('http://127.0.0.1:8896/OpenCometBench/pages/login.html', { waitUntil: 'load' });

console.log('[scene-change] probing the real pipeline (YOLO model may download on first run)…');
await p.evaluate(`(() => { window.__SCENE_PROBE__ = { done: false }; })()`);
p.evaluate(async () => {
  try {
    const { runPrivacyPipeline } = await import('/src/lib/privacy-filter.js?probe=scene-change');

    const W = 640, H = 400;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');

    function drawSafe() {
      g.fillStyle = '#f4f6fb'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#1d4ed8'; g.fillRect(0, 0, W, 44);           // chrome bar
      g.fillStyle = '#ffffff'; g.fillRect(24, 70, 272, 220);      // card
      g.fillStyle = '#e5e7eb';
      for (let i = 0; i < 4; i++) g.fillRect(40, 96 + i * 44, 240, 14);
      g.fillStyle = '#1d6ef5'; g.fillRect(40, 286, 96, 30);       // button
    }
    function drawPerson(x, y, s) {                                 // synthetic person
      g.fillStyle = '#3b2f2a'; g.beginPath(); g.arc(x, y, 26 * s, 0, 7); g.fill();   // hair/head
      g.fillStyle = '#e8b48c'; g.beginPath(); g.arc(x, y + 6 * s, 20 * s, 0, 7); g.fill(); // face
      g.fillStyle = '#2f6f4f'; g.fillRect(x - 38 * s, y + 34 * s, 76 * s, 110 * s); // torso
      g.fillStyle = '#2f6f4f';
      g.fillRect(x - 58 * s, y + 40 * s, 20 * s, 92 * s);          // arms
      g.fillRect(x + 38 * s, y + 40 * s, 20 * s, 92 * s);
      g.fillStyle = '#1f2937'; g.fillRect(x - 28 * s, y + 144 * s, 22 * s, 60 * s); // legs
      g.fillRect(x + 6 * s, y + 144 * s, 22 * s, 60 * s);
    }
    function drawSensitive() {
      drawSafe();
      drawPerson(470, 130, 1);
      g.fillStyle = '#111827'; g.font = '16px monospace';
      g.fillText('KEY=sk-abcdefghij0123456789', 40, 372);          // pixel-only secret text
    }
    const capture = () => { const u = c.toDataURL('image/png'); return u; };

    const OPTS = { blurFaces: false, runYolo: true, ocrPii: false, redactDomPii: false, redactTextPii: false, yoloMemo: true, maxWidth: 640 };
    const run = async (imageDataUrl, tag) => {
      const r = await runPrivacyPipeline({ imageDataUrl, domText: '', domSensitive: [] }, OPTS);
      return {
        tag,
        yoloMemoHit: r.stats.yoloMemoHit === true,
        objectDetectMs: r.stats.phaseMs.objectDetect,
        totalMs: r.stats.totalMs,
        detections: r.manifest.filter(m => m.type === 'object').map(m => ({ label: m.reason === 'yolo' ? 'person' : m.reason, x: m.bounds.x, y: m.bounds.y, w: m.bounds.w, h: m.bounds.h, conf: m.confidence })),
        manifestCount: r.manifest.length,
        sanitizedLen: r.sanitizedDataUrl.length,
        yoloLog: (r.pipelineLogs || []).filter(l => l.startsWith('YOLO')).join(' | ').slice(0, 300),
      };
    };

    // A1: safe scene, first capture (model cold-start lands here)
    drawSafe();
    const A1 = capture();
    const runA1 = await run(A1, 'A1-safe-first');
    // A2: IDENTICAL capture → memo hit is the OPTIMIZATION being validated
    const runA2 = await run(A1, 'A2-safe-identical');
    // B1: SCENE-CHANGE ATTACK — pixels change to sensitive content
    drawSensitive();
    const B1 = capture();
    const samePixels = B1 === A1;
    const runB1 = await run(B1, 'B1-scene-changed');
    // B2: identical sensitive capture → hit with the SAME detections as B1
    const runB2 = await run(B1, 'B2-sensitive-identical');
    // T: one tampered byte → structurally different capture
    const i = B1.indexOf('base64,') + 40;
    const T = B1.slice(0, i) + (B1[i] === 'A' ? 'B' : 'A') + B1.slice(i + 1);
    const runT = await run(T, 'T-tampered-byte');

    window.__SCENE_PROBE__ = {
      done: true,
      samePixelsFlag: samePixels,
      runs: [runA1, runA2, runB1, runB2, runT],
      detectionsIdenticalOnReuse: JSON.stringify(runB1.detections) === JSON.stringify(runB2.detections),
    };
  } catch (e) {
    window.__SCENE_PROBE__ = { done: true, error: String(e?.message || e).slice(0, 400) };
  }
}).catch(e => { console.error('evaluate dispatch failed:', e.message); });

// CSP-safe wait: poll the done flag from the runner side.
await p.waitForFunction(() => window.__SCENE_PROBE__ && window.__SCENE_PROBE__.done === true, null, { timeout: 420000 });
const out = await p.evaluate(() => window.__SCENE_PROBE__);
await b.close(); srv.close();

if (out.error) { console.error('PROBE ERROR:', out.error); process.exit(1); }

const byTag = Object.fromEntries(out.runs.map(r => [r.tag, r]));
const checks = [
  ['A1 safe first capture → memo MISS (detector ran)', byTag['A1-safe-first'] && byTag['A1-safe-first'].yoloMemoHit === false],
  ['A1 real detection executed (objectDetect > 50ms, model work visible)', byTag['A1-safe-first'] && byTag['A1-safe-first'].objectDetectMs > 50],
  ['A2 identical capture → memo HIT (the optimization)', byTag['A2-safe-identical'] && byTag['A2-safe-identical'].yoloMemoHit === true],
  ['A2 memo hit skips the detector (objectDetect < 20ms)', byTag['A2-safe-identical'] && byTag['A2-safe-identical'].objectDetectMs < 20],
  ['B1 scene-changed capture → memo MISS (attack defeated)', byTag['B1-scene-changed'] && byTag['B1-scene-changed'].yoloMemoHit === false],
  ['B1 re-ran FULL detection on the changed pixels (objectDetect > 50ms)', byTag['B1-scene-changed'] && byTag['B1-scene-changed'].objectDetectMs > 50],
  ['B2 identical sensitive capture → memo HIT', byTag['B2-sensitive-identical'] && byTag['B2-sensitive-identical'].yoloMemoHit === true],
  ['B2 reuse returns the SAME detections as B1', out.detectionsIdenticalOnReuse === true],
  ['T tampered byte → memo MISS (no near-duplicate reuse)', byTag['T-tampered-byte'] && byTag['T-tampered-byte'].yoloMemoHit === false],
  ['pipeline never crashed during the attack sequence', !out.error],
];
console.log(`\n[scene-change] scene-change attack results (environment: headless-ci):`);
for (const r of out.runs) {
  console.log(`  ${r.tag.padEnd(22)} memoHit=${String(r.yoloMemoHit).padEnd(5)} objectDetect=${String(r.objectDetectMs).padStart(6)}ms detections=${r.detections.length} [${r.detections.map(d => `${d.label}@${d.conf?.toFixed?.(2) ?? d.conf}`).join(', ')}]`);
}
let fail = 0;
for (const [name, ok] of checks) { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`); if (!ok) fail++; }
if (byTag['B1-scene-changed']) {
  const dets = byTag['B1-scene-changed'].detections.length;
  console.log(`  info  yolos-tiny on the synthetic person scene: ${dets} object detection(s) — informational; person recall is measured by the redaction matrix + adversarial suite, not by a drawn figure`);
}
console.log(`  info  page errors: ${pageErrors.length ? pageErrors.join(' | ') : 'none'}`);

const result = {
  meta: { type: 'scene-change-probe', benchmark: 'scene-change-attack', environment: 'headless-ci', headed: false, note: 'Memo SEMANTICS are environment-independent. Absolute latencies are headless-CI numbers, not production claims. Real pipeline (privacy-filter.js) with real YOLO Xenova/yolos-tiny.' },
  generatedAt: new Date().toISOString(),
  runs: out.runs,
  detectionsIdenticalOnReuse: out.detectionsIdenticalOnReuse,
  checks: checks.map(([name, ok]) => ({ name, ok: Boolean(ok) })),
  pass: fail === 0,
};
mkdirSync(`${ROOT}/OpenCometBench/results`, { recursive: true });
const ts = Date.now();
writeFileSync(`${ROOT}/OpenCometBench/results/scene-change-probe-${ts}.json`, JSON.stringify(result, null, 2));
console.log(`\nwrote OpenCometBench/results/scene-change-probe-${ts}.json  PASS=${fail === 0}`);
process.exit(fail ? 1 : 0);
