#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/test_scene_change_attack.mjs — v1.14.1 SCENE-CHANGE ATTACK + MEMO
// SAFETY TEST (SIH brief §11: mandatory when detector caching is introduced).
//
// What it proves, without a browser:
//   1. The detector memos reuse results ONLY for byte-identical captures —
//      the memo key is the EXACT data-URL string, so the scene-change attack
//      (safe capture cached → screen switches to sensitive content → immediate
//      capture) can NEVER be served from the cache: any pixel difference
//      produces a different capture string → guaranteed miss → full
//      re-detection. Includes a counterfactual: the OLD sampled-content-hash
//      keying would have collided on crafted inputs; the exact key does not.
//   2. LRU semantics: hit/miss/touch/eviction at cap 2, boxes-only storage.
//   3. Wiring (static, regression-guarded): memo lookup happens BEFORE the
//      detector call; the memo is populated ONLY on detector success (never in
//      the error path); a disable switch (yoloMemo:false) exists; face memo
//      receives the exact capture string too.
//   4. TDZ regression: the visual-context fusion (which previously referenced
//      `ocrRegions` before its declaration and silently returned null on every
//      capture) now yields a non-null structured visual context.
//
// Run: node scripts/test_scene_change_attack.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { memoLruGet, memoLruSet, runPrivacyPipeline } from '../src/lib/privacy-filter.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── 1) LRU primitives ────────────────────────────────────────────────────────
console.log('[1] memo LRU primitives (exported pure from privacy-filter.js)');
{
  const m = new Map();
  check('empty map → miss', memoLruGet(m, 'a') === null);
  memoLruSet(m, 'a', { v: 1 });
  check('store → hit with same value', memoLruGet(m, 'a')?.v === 1);
  memoLruSet(m, 'b', { v: 2 });
  memoLruSet(m, 'c', { v: 3 });           // cap=2 → 'a' evicted
  check('cap 2: oldest entry evicted', !m.has('a') && m.get('c')?.v === 3);
  memoLruGet(m, 'b');                      // touch b
  memoLruSet(m, 'd', { v: 4 });           // evicts LRU = c (not b)
  check('LRU touch protects recently used', m.has('b') && !m.has('c'));
  // Boxes-only semantics: the memo stores what we give it — callers pass
  // detection arrays; verify the stored value is returned by reference.
  const boxes = [{ label: 'person', bounds: { x: 1, y: 2, w: 3, h: 4 } }];
  memoLruSet(m, 'shot', { detections: boxes });
  check('stored detections returned intact', memoLruGet(m, 'shot').detections === boxes);
}

// ── 2) Exact-key scene-change semantics (+ old-hash counterfactual) ─────────
console.log('[2] scene-change attack: exact-capture keying');
{
  // Build a 100k-char fake "data-URL body" pair that the OLD sampled hash
  // (≤4096 samples, step = floor(n/4096)) would have COLLIDED on: identical
  // at every sampled position (i % step === 0), different in between.
  const prefix = 'data:image/png;base64,';
  const n = 100000;
  const step = Math.max(1, Math.floor(n / 4096));   // 24 for n=100000
  const body = new Array(n);
  for (let i = 0; i < n; i++) body[i] = String.fromCharCode(65 + (i % 26));
  const changedBody = body.slice();
  let diffAt = -1;
  for (let i = 1; i < n; i++) { if (i % step !== 0) { changedBody[i] = body[i] === 'A' ? 'Z' : 'A'; diffAt = i; break; } }
  const safe = prefix + body.join('');
  const sensitive = prefix + changedBody.join('');
  check('attack construction: a difference was planted', diffAt > 0);
  check('attack pair: same length', safe.length === sensitive.length);
  check('attack pair: NOT byte-identical', safe !== sensitive);
  check('attack pair: differ OUTSIDE old sampled positions',
    (() => {
      for (let i = 0; i < n; i += step) {
        if (safe[prefix.length + i] !== sensitive[prefix.length + i]) return false;
      }
      return true;
    })());

  // Old scheme counterfactual — replicate the previously shipped hash and
  // show it WOULD have collided (this is why exact keying is now mandatory):
  const oldSampledHash = (s) => {
    let h1 = 0x811c9dc5 >>> 0, h2 = 0x1b873593 >>> 0;
    const len = s.length, st = Math.max(1, Math.floor(len / 4096));
    for (let i = 0; i < len; i += st) {
      h1 = ((h1 ^ s.charCodeAt(i)) * 0x01000193) >>> 0;
      h2 = ((h2 + s.charCodeAt(i) * (i + 1)) * 31) >>> 0;
    }
    return h1.toString(36) + '-' + h2.toString(36) + '-' + len.toString(36);
  };
  console.log(`      (counterfactual: old sampled hash safe=${oldSampledHash(safe)} sensitive=${oldSampledHash(sensitive)})`);

  const m = new Map();
  memoLruSet(m, safe, { detections: [{ label: 'person', bounds: { x: 0, y: 0, w: 8, h: 8 } }] });
  check('EXACT key: identical capture → memo hit (reuse valid)',
    memoLruGet(m, safe)?.detections?.length === 1);
  check('EXACT key: scene-changed capture → MISS (must re-detect)',
    memoLruGet(m, sensitive) === null,
    'a changed screen was served from cache — scene-change attack possible!');
  check('counterfactual proof: old sampled hash WOULD have collided (attack viable there), exact key does not',
    oldSampledHash(safe) === oldSampledHash(sensitive) && memoLruGet(m, sensitive) === null);
}

// ── 3) Wiring (static assertions on privacy-filter.js source) ────────────────
console.log('[3] wiring: memo before detector, success-only population, disable switch');
{
  const src = readFileSync(join(ROOT, 'src', 'lib', 'privacy-filter.js'), 'utf8');
  const lookupIdx = src.indexOf('yoloMemoGet(input.imageDataUrl)');
  const detectIdx = src.indexOf('await detectObjects(input.imageDataUrl)');
  const setIdx = src.indexOf('yoloMemoSet(input.imageDataUrl');
  const catchIdx = src.indexOf('[Privacy] YOLO detection failed:');
  check('memo lookup present', lookupIdx > 0);
  check('memo lookup happens BEFORE detector call', lookupIdx > 0 && detectIdx > lookupIdx);
  check('exact capture string is the memo key (no hash indirection)',
    src.includes('yoloMemoGet(input.imageDataUrl)') && !src.includes('sampledContentHash'));
  check('memo population only on detector SUCCESS (after detectObjects, before catch)',
    setIdx > detectIdx && (catchIdx < 0 || setIdx < catchIdx));
  check('disable switch present (cfg.yoloMemo !== false)',
    src.includes('cfg.yoloMemo !== false') && src.includes('yoloMemo: true'));
  check('face memo receives the exact capture string too',
    src.includes('fdOpts.imageHash = input.imageDataUrl'));
  check('memo telemetry surfaced in stats (honest reuse reporting)',
    src.includes('yoloMemoHit') && src.includes('faceMemoHit'));
}

// ── 4) TDZ regression: visual-context fusion must produce a result ──────────
console.log('[4] visual-context fusion (was silently null via ocrRegions TDZ)');
{
  const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const r = await runPrivacyPipeline(
    { imageDataUrl: TINY_PNG, domText: 'Login to your account', domSensitive: [], pageUrl: 'https://example.com/login', pageTitle: 'Sign in', dom: {} },
    { blurFaces: false, runYolo: false, ocrPii: false, redactTextPii: false, yoloMemo: false },
  );
  check('runPrivacyPipeline resolves', Boolean(r));
  check('visualContext is NOT null (TDZ fixed)', r.visualContext != null,
    'visual-context fusion still failing — payload loses the SIH visual-context feature');
  if (r.visualContext) {
    check('visualContext carries pageType + confidence + sources',
      typeof r.visualContext.pageType === 'string' &&
      typeof r.visualContext.confidence === 'number' &&
      r.visualContext.sources != null);
    check('visualDetector sources honest (0 faces/objects when detectors off)',
      r.visualContext.sources?.visualDetector?.faces === 0 &&
      r.visualContext.sources?.visualDetector?.objects === 0);
  }
  check('no detector memo telemetry on a memo-disabled run',
    r.stats?.yoloMemoHit === false);
  // Node has no Image/canvas API — redaction cannot draw here. The pipeline
  // must fail CLOSED (blank 1×1 frame carrying zero user pixels), which this
  // environment exercises for free:
  check('redaction failure in a bare-Node env is fail-closed (blank frame, no raw pixels out)',
    r.stats?.redactionFailed === true && r.sanitizedDataUrl.length < 200);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
