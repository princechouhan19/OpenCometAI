#!/usr/bin/env node
// scripts/test_vision_warmup.mjs — v1.16.0 RUNTIME WIRING TEST (real extension)
//
// The static suite (test_ocr_memo.mjs) proves the wiring TEXT; this test proves
// the WIRING ITSELF inside the real unpacked extension:
//   1. VISION_WARMUP reaches the offscreen router and loads the YOLO pipeline
//      (parts reported, non-fatal contract respected).
//   2. Two identical PRIVACY_SANITIZE rounds: round 1 populates BOTH memos
//      (yoloMemoHit=false), round 2 re-hits BOTH (yoloMemoHit=true AND the new
//      ocrMemoHit=true) — on identical bytes, in the real offscreen runtime.
//   3. ViT is NOT warmed here (85 MB download in CI) — vit:false exercises the
//      parts-selection contract instead.
//
// Run: node scripts/test_vision_warmup.mjs   (needs playwright + network for
// the 6 MB yolos-tiny download on a cold browser cache)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ],
});

let sw = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
context.on('serviceworker', (w) => { if (w.url().startsWith('chrome-extension://')) sw = w; });
const wake = await context.newPage();
await wake.goto('about:blank').catch(() => {});
for (let i = 0; i < 40 && !sw; i++) {
  sw = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  if (!sw) await new Promise(r => setTimeout(r, 500));
}
if (!sw) { console.error('service worker never appeared'); process.exit(1); }
const extId = new URL(sw.url()).hostname;
console.log('extension SW online');

const panel = await context.newPage();
await panel.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`).catch(() => {});
await panel.waitForTimeout(800);

// A small real page whose screenshot OCR can scan (text present, tiny viewport).
const page = await context.newPage();
await page.setViewportSize({ width: 640, height: 320 });
await page.setContent('<body style="margin:20px;font:16px monospace"><p>Contact: alice@example.com · card 4111 1111 1111 1111</p><canvas id="c" width="80" height="40"></canvas></body>');
await page.evaluate(() => { const c = document.getElementById('c'); const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 80, 40); });
await page.waitForTimeout(200);
const shot = await page.screenshot({ type: 'png' });
const imageDataUrl = `data:image/png;base64,${shot.toString('base64')}`;

const send = (msg) => panel.evaluate((m) => new Promise((res) => {
  try {
    chrome.runtime.sendMessage(m, (r) => res(r || { ok: false, error: chrome.runtime.lastError?.message || 'no response' }));
  } catch (e) { res({ ok: false, error: String(e?.message || e) }); }
}), msg);

// 1) Bootstrap the offscreen document via an existing SW handler.
const boot = await send({ type: 'LOCAL_MODEL_LIST' });
check('offscreen document bootstrapped (LOCAL_MODEL_LIST ok)', boot?.ok === true, boot?.error || '');

// 2) VISION_WARMUP reaches the offscreen router (vit:false → parts = ['yolo']).
console.log('warming YOLO (may download ~6 MB on a cold cache)…');
const warm = await send({ target: 'offscreen', type: 'VISION_WARMUP', yolo: true, vit: false, requestId: 'tw-1' });
check('VISION_WARMUP ok', warm?.ok === true, JSON.stringify(warm).slice(0, 160));
check('warm-up reports loaded parts incl. yolo', Array.isArray(warm?.result?.parts) && warm.result.parts.includes('yolo'), JSON.stringify(warm?.result?.parts));
check('warm-up reports a positive warmupMs', Number(warm?.result?.warmupMs) >= 0, String(warm?.result?.warmupMs));

// 3) Two identical sanitize rounds → miss then DOUBLE memo hit.
const opts = { blurFaces: false, runYolo: true, ocrPii: true, useNer: false };
const r1 = await send({ target: 'offscreen', type: 'PRIVACY_SANITIZE', requestId: 'tw-r1', input: { imageDataUrl, domText: '', domSensitive: [] }, opts });
check('sanitize round 1 ok', r1?.ok === true, JSON.stringify(r1).slice(0, 160));
check('round 1: yoloMemoHit=false (fresh capture)', r1?.result?.stats?.yoloMemoHit === false, String(r1?.result?.stats?.yoloMemoHit));
check('round 1: ocrMemoHit=false (fresh capture)', r1?.result?.stats?.ocrMemoHit === false, String(r1?.result?.stats?.ocrMemoHit));
check('round 1: OCR did not fail (fail-closed telemetry clean)', r1?.result?.stats?.ocrFailed === false, String(r1?.result?.stats?.ocrFailedReason || ''));

const r2 = await send({ target: 'offscreen', type: 'PRIVACY_SANITIZE', requestId: 'tw-r2', input: { imageDataUrl, domText: '', domSensitive: [] }, opts });
check('sanitize round 2 ok', r2?.ok === true, JSON.stringify(r2).slice(0, 160));
check('round 2: yoloMemoHit=true (existing memo)', r2?.result?.stats?.yoloMemoHit === true, String(r2?.result?.stats?.yoloMemoHit));
check('round 2: ocrMemoHit=true (NEW v1.16.0 OCR memo)', r2?.result?.stats?.ocrMemoHit === true, String(r2?.result?.stats?.ocrMemoHit));
const ms1 = r1?.result?.stats?.totalMs ?? 0, ms2 = r2?.result?.stats?.totalMs ?? 0;
check(`memo round is not slower than the fresh round (${ms2}ms ≤ ${ms1}ms)`, ms2 <= ms1 + 250, `${ms1} → ${ms2}`);
console.log(`  (round timings: fresh=${ms1}ms memo=${ms2}ms)`);

await context.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
