#!/usr/bin/env node
// OpenCometBench/probe-ocr-mv3-extension.mjs
// REAL-BROWSER MV3 VERIFICATION of the vendored OCR chain.
//
// Launches actual Chromium with the ACTUAL unpacked extension loaded
// (--load-extension), opens a chrome-extension:// page (extension origin +
// extension CSP — the same context class the offscreen document runs in) and
// executes the production module src/lib/ocr-pii.js unmodified on synthetic
// pixel-baked PII.
//
// This is the witness for the workerBlobURL:false fix: over http:// the
// default blob-worker path works, so ONLY an extension-context run can
// verify the MV3 behaviour.
//
// PASS:
//   • OCR produced ≥1 PII region and did not fail
//   • Worker created DIRECTLY from chrome-extension://…/worker.min.js (no blob)
//   • zero page-scope external (non-extension-origin) requests
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const ROOT = '/home/z/my-project/upload/OpenCometAI-SIH-extracted/OpenCometAI-SIH';
const HEADLESS = process.env.OCR_PROBE_HEADED !== '1';
const userDataDir = mkdtempSync(join(tmpdir(), 'ocr-mv3-probe-'));

let ctx;
try {
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: HEADLESS,
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  // Extension ID comes from the extension's service-worker URL.
  let sw = ctx.serviceWorkers().find((w) => w.url().includes('sw.js'));
  if (!sw) {
    sw = await ctx
      .waitForEvent('serviceworker', { timeout: 25000 })
      .catch(() => null);
  }
  if (!sw) {
    console.error('NO_SERVICE_WORKER — extension did not boot' +
      (HEADLESS ? ' (retry headed: OCR_PROBE_HEADED=1 xvfb-run -a node …)' : ''));
    process.exit(2);
  }
  const extId = new URL(sw.url()).host;
  console.log('extension id:', extId);

  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (/error|fail/i.test(t)) console.log('[page console]', t.slice(0, 220));
  });
  await page.goto(
    `chrome-extension://${extId}/OpenCometBench/browser/ocr-mv3-probe.html`,
    { waitUntil: 'domcontentloaded' }
  );
  // OCR: wasm core init + LSTM recognize on first run — allow generous time.
  // NOTE: pass a FUNCTION (not a string) — string predicates are evaluated
  // via Runtime.evaluate, which the extension CSP (no 'unsafe-eval') blocks.
  await page.waitForFunction(
    () => window.__OCR_PROBE__ && window.__OCR_PROBE__.done === true,
    null,
    { timeout: 180000 }
  );
  const r = await page.evaluate(() => window.__OCR_PROBE__);
  console.log(JSON.stringify(r, null, 1));

  const checks = {
    ocrProducedRegions: r.ok === true,
    workerDirectExtensionUrl:
      r.workerUrls.length > 0 &&
      r.workerUrls.every(
        (u) => u.startsWith('chrome-extension://') && u.includes('/src/vendor/tesseract/worker.min.js')
      ),
    noBlobWorker: r.workerUrls.every((u) => !u.startsWith('blob:')),
    noExternalPageRequests: r.externalRequests.length === 0,
  };
  const pass = Object.values(checks).every(Boolean);
  console.log('CHECKS:', JSON.stringify(checks, null, 1));
  console.log(pass ? 'OCR-MV3-PROBE: PASS' : 'OCR-MV3-PROBE: FAIL');
  process.exitCode = pass ? 0 : 1;
} finally {
  await ctx?.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true });
}
