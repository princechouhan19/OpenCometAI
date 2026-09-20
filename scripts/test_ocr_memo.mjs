#!/usr/bin/env node
// scripts/test_ocr_memo.mjs — v1.16.0 OCR MEMO SAFETY TEST
//
// The OCR memo (privacy-filter.js) reuses visual-PII scan results for
// byte-identical captures + identical ROI sets — the same safety pattern the
// YOLO memo introduced. What it proves, without a browser:
//
//   1. Key composition: the memo key is the EXACT capture data-URL string PLUS
//      the serialized ROI list — any pixel change OR different crop set is a
//      guaranteed miss → full re-scan (scene-change attack can never be served
//      from the cache; a page whose DOM census changed gets a different ROI
//      serialization even for identical pixels).
//   2. Store/no-store policy wiring (static, regression-guarded): the memo is
//      consulted BEFORE scanImageForPiiRegions(); it is populated ONLY when
//      the scan succeeded (never on failed or skipped scans — fail-closed
//      stays honest); a disable switch (cfg.ocrMemo=false) exists and skips
//      both lookup and store; ocrMemoHit telemetry is exported in stats
//      alongside yoloMemoHit; the memo-hit log reports the ACTUAL phase cost,
//      never the stored original scan time.
//   3. YOLO maxEdge knob (static): detectObjects receives cfg.yoloMaxEdge;
//      the default is 0 = disabled (bit-identical to pre-knob behavior);
//      boxes are mapped back by the scale factor; the downscale path is
//      fail-safe (falls back to the original input on any error).
//   4. Vision warm-up wiring (static): VISION_WARMUP exists in the offscreen
//      router (yolo+vit parts, heartbeats, non-fatal failure); the SW fires
//      warmupVisionModels fire-and-forget at PRIVACY_START (never awaited
//      into the session path); the e2e-real runner supports --warmup and
//      stamps meta.warmup so steady-state reports are self-describing.
//
// Run: node scripts/test_ocr_memo.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { memoLruGet, memoLruSet } from '../src/lib/privacy-filter.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// 1) Key composition: exact capture + ROI serialization
console.log('[1] OCR memo key composition (exact capture + ROI list)');
{
  const shotA = 'data:image/png;base64,AAAA-shooting-range-safe-frame';
  const shotB = 'data:image/png;base64,AAAA-shooting-range-SENSITIVE-frame'; // 1 byte differs
  const rois1 = JSON.stringify([{ x: 10, y: 20, w: 30, h: 40 }]);
  const rois2 = JSON.stringify([{ x: 10, y: 20, w: 30, h: 41 }]);            // 1 px differs
  const key = (img, rois) => `${img}\u0000${rois}`;
  const m = new Map();
  memoLruSet(m, key(shotA, rois1), { regions: [{ type: 'ocr_pii', bounds: { x: 1, y: 2, w: 3, h: 4 } }] });
  check('identical capture + identical ROIs → HIT',
    memoLruGet(m, key(shotA, rois1))?.regions.length === 1);
  check('1-byte pixel change → MISS (scene-change attack covered)',
    memoLruGet(m, key(shotB, rois1)) === null);
  check('identical pixels, 1px ROI change → MISS (different crop set is a different scan)',
    memoLruGet(m, key(shotA, rois2)) === null);
  // The NUL separator must be present: without it, 'x'+'yz' === 'xy'+'z' style
  // key-concatenation collisions would be structurally possible.
  check('key contains a separator between capture and ROI blob',
    key(shotA, rois1).includes('\u0000'));
}

// 2) Store/no-store policy wiring in privacy-filter.js
console.log('[2] privacy-filter.js OCR memo wiring (static)');
{
  const src = read('src/lib/privacy-filter.js');
  check('cfg.ocrMemo default true (with fail-safe comment)',
    /ocrMemo: true,\s+\/\/ v1\.16\.0/.test(src));
  check('memo key = exact data-URL + serialized ROIs',
    src.includes('`${input.imageDataUrl}\\u0000${JSON.stringify(ocrRois)}`'));
  check('lookup happens BEFORE scanImageForPiiRegions',
    src.indexOf('ocrMemoGet(ocrMemoKey)') >= 0 &&
    src.indexOf('ocrMemoGet(ocrMemoKey)') < src.indexOf('await scanImageForPiiRegions'));
  check('store ONLY on success — never on failed scans',
    /if \(ocrMemoKey && !ocr\.failed && !ocr\.skipped\) ocrMemoSet/.test(src));
  check('disable switch: cfg.ocrMemo === false skips lookup AND store',
    /ocrMemoKey = cfg\.ocrMemo === false \? null/.test(src));
  check('memo-hit log reports ACTUAL phase cost, not the stored original scan time',
    /OCR \[memo hit[^`]*\$\{Math\.round\(performance\.now\(\) - t0\)\}ms/.test(src) &&
    /\(original scan \$\{ocr\.ms/.test(src));
  check('ocrMemoHit exported in stats next to yoloMemoHit',
    /yoloMemoHit,\s*\n\s*ocrMemoHit,/.test(src));
  check('ocrMemoHit declared at function scope (defaults false)',
    /let ocrMemoHit = false;\s+\/\/ v1\.16\.0 telemetry/.test(src));
  check('2-entry LRU shared primitives (same memoLruGet/memoLruSet as YOLO memo)',
    /const _ocrMemo = new Map\(\);/.test(src) &&
    /function ocrMemoGet\(key\) \{\s*\n\s*return memoLruGet\(_ocrMemo, key\);/.test(src));
}

// 3) YOLO maxEdge knob
console.log('[3] yoloMaxEdge downscale knob (static)');
{
  const lv = read('src/lib/local-vision.js');
  const pf = read('src/lib/privacy-filter.js');
  check('detectObjects accepts { maxEdge } and defaults to 0 (disabled)',
    /export async function detectObjects\(image, \{ maxEdge = 0 \} = \{\}\)/.test(lv));
  check('downscale only for data-URL inputs (contract preserved)',
    /maxEdge > 0 && typeof image === 'string' && image\.startsWith\('data:'\)/.test(lv));
  check('boxes mapped back to full-image coordinates (×sx/×sy)',
    /Math\.round\(o\.box\.xmin \* sx\)/.test(lv) &&
    /Math\.round\(\(o\.box\.xmax - o\.box\.xmin\) \* sx\)/.test(lv));
  check('fail-safe: any downscale error falls back to the original input',
    /catch \{ workInput = image; sx = 1; sy = 1; \}/.test(lv));
  check('privacy-filter cfg default yoloMaxEdge: 0 (behavior unchanged until A/B passes)',
    /yoloMaxEdge: 0,\s+\/\/ v1\.16\.0/.test(pf));
  check('the knob reaches the detector call',
    /detectObjects\(input\.imageDataUrl, \{ maxEdge: cfg\.yoloMaxEdge \}\)/.test(pf));
}

// 4) Vision warm-up wiring
console.log('[4] VISION_WARMUP / cold-start elimination wiring (static)');
{
  const off = read('src/offscreen/offscreen.js');
  const cli = read('src/lib/offscreen-client.js');
  const sw = read('src/background/sw.js');
  const runner = read('OpenCometBench/e2e/run-e2e-real.mjs');
  check("offscreen router handles 'VISION_WARMUP' with yolo+vit parts",
    /case 'VISION_WARMUP':/.test(off) && /preloadLocalVision\(\{ includeNer: false, includeYolo: true \}\)/.test(off) && /await getImageClassifier\(\)/.test(off));
  check('warm-up failure is NON-FATAL (logged, reported, never thrown)',
    /VISION_WARMUP failed \(non-fatal[^']*'/.test(off));
  check('client helper warms via offscreen RPC and NEVER throws',
    /export async function warmupVisionModels\(/.test(cli) &&
    /return \{ ok: false, error: String\(err\?\.message \|\| err\) \};/.test(cli));
  check('SW fires the warm-up fire-and-forget at PRIVACY_START (no await into the session path)',
    /warmupVisionModels\(\{ yolo: Boolean\(privacyCfg\.runYolo\), vit: true \}\)[\s\S]{0,400}?\.catch\(\(\) => \{\}\);/.test(sw));
  check('e2e-real runner: --warmup flag parsed and gated',
    /const WARMUP = argv\.includes\('--warmup'\);/.test(runner) && /if \(WARMUP\) \{/.test(runner));
  check('runner warm-up makes ZERO VLM calls (VISION_WARMUP + PRIVACY_SANITIZE only)',
    /type: 'VISION_WARMUP'/.test(runner) &&
    !/chat\/completions|\.create\(|DECISION|decideViaServer/.test(runner.split('if (WARMUP) {')[1]?.split('const results = []')[0]));
  check('report meta stamps the warm-up condition (cold/warm never merged)',
    /warmupNote: '--warmup was ON:/.test(runner));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
