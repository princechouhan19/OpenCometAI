#!/usr/bin/env node
// scripts/test_v1300_latency_roi.mjs — v1.30.0 verification harness.
//
// Covers:
//   A) OpenCometBench/latency.js semantics (timed / latencyStats / roundSamples)
//   B) roi-diff.js invariants (changed-pixel coverage, overflow merge,
//      coverage cap, planPerception fail-toward-full, geometry helpers)
//   C) Wiring markers — every v1.30.0 integration point present in source
//
// Run: node scripts/test_v1300_latency_roi.mjs   → exit 0 = all pass

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // repo root — portable, no absolute paths
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${name}`); } };

// ── A) latency.js ────────────────────────────────────────────────────────────
const L = await import(pathToFileURL(join(ROOT, 'OpenCometBench', 'latency.js')));

{
  const s = L.latencyStats([]);
  t('latencyStats: empty → n=0 (never fabricated)', s.n === 0 && s.p50Ms === 0 && s.totalMs === 0);
}
{
  const s = L.latencyStats([3, null, 1, NaN, 2, -5, undefined, 'x']);
  t('latencyStats: non-numeric/negative entries ignored (n=3)', s.n === 3);
  t('latencyStats: sorted p50 of [1,2,3] = 2', s.p50Ms === 2);
  t('latencyStats: total = 6', s.totalMs === 6);
}
{
  // floor-index percentile (matches e2e/browser pct()): index floor(q·n)
  const s = L.latencyStats([1, 2]);            // n=2 → p50 index floor(1)=1 → 2
  t('latencyStats: 2-element p50 = 2 (floor-index method)', s.p50Ms === 2);
}
{
  const s = L.latencyStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  t('latencyStats: p90 of 1..10 = 10 (floor(9))', s.p90Ms === 10);
  t('latencyStats: p95 of 1..10 = 10 (floor(9.5)→9)', s.p95Ms === 10);
  t('latencyStats: min/max', s.minMs === 1 && s.maxMs === 10);
  t('latencyStats: mean = 5.5', s.meanMs === 5.5);
}
{
  t('roundSamples: 3-decimal rounding', JSON.stringify(L.roundSamples([1.23456, 0.0005, 2])) === '[1.235,0.001,2]');
}
{
  const { out, ms } = await L.timed(async () => { await new Promise(r => setTimeout(r, 5)); return 42; });
  t('timed: returns {out, ms}, out passthrough', out === 42 && ms >= 4);
}
{
  t('r3: 3-decimal helper', L.r3(1.23456) === 1.235);
}

// ── B) roi-diff.js invariants ───────────────────────────────────────────────
const R = await import(pathToFileURL(join(ROOT, 'src', 'lib', 'roi-diff.js')));
const COLS = R.ROI_GRID_COLS, ROWS = R.ROI_GRID_ROWS;
// proxy-size grayscale (blockFingerprints input = 96×54 gray, NOT the grid)
const gray = (v) => new Uint8Array(R.ROI_PROXY_W * R.ROI_PROXY_H).fill(v);
// changed-block mask (regionsFromMask input = COLS×ROWS grid)
const mask = (v) => new Uint8Array(COLS * ROWS).fill(v);

{
  const g = new Uint8Array(96 * 54 * 4);   // RGBA input
  t('toGray: length check', R.toGray(g, 96, 54).length === 96 * 54);
  let threw = false;
  try { R.toGray(new Uint8Array(10), 96, 54); } catch { threw = true; }
  t('toGray: bad input THROWS', threw);
}
{
  const f1 = R.blockFingerprints(gray(128), R.ROI_PROXY_W, R.ROI_PROXY_H);
  t('blockFingerprints: shape 12×7', f1.means.length === COLS * ROWS);
}
{
  // localized change → small changedCount, conservative (any-stat diff = changed)
  const g1 = gray(128), g2 = gray(128);
  for (let y = 20; y < 24; y++) for (let x = 10; x < 22; x++) g2[y * R.ROI_PROXY_W + x] = 200;
  const d = R.diffFingerprints(R.blockFingerprints(g1, R.ROI_PROXY_W, R.ROI_PROXY_H), R.blockFingerprints(g2, R.ROI_PROXY_W, R.ROI_PROXY_H));
  t('diffFingerprints: localized change detected', d.changedCount > 0 && d.changedCount < 10);
  t('diffFingerprints: ratio computed', Math.abs(d.ratio - d.changedCount / (COLS * ROWS)) < 1e-9);
}
{
  const d = R.diffFingerprints(R.blockFingerprints(gray(128), R.ROI_PROXY_W, R.ROI_PROXY_H), R.blockFingerprints(gray(128), R.ROI_PROXY_W, R.ROI_PROXY_H));
  t('diffFingerprints: identical fingerprints → changedCount=0', d.changedCount === 0);
  t('diffFingerprints: identical → regionsFromMask []', JSON.stringify(R.regionsFromMask(d.changed, COLS, ROWS, 1280, 720)) === '[]');
}

// INVARIANT: every changed pixel lies inside SOME returned region.
{
  let ok = true;
  for (let trial = 0; trial < 25 && ok; trial++) {
    const m = mask(0);
    for (let i = 0; i < m.length; i++) m[i] = Math.random() < 0.2 ? 1 : 0;
    if (!m.some(v => v)) continue;
    const regions = R.regionsFromMask(m, COLS, ROWS, 1280, 720);
    if (regions === null) continue;   // coverage-cap → caller goes full; still safe
    const bw = 1280 / COLS, bh = 720 / ROWS;
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      const c = i % COLS, r = (i / COLS) | 0;
      const cx = (c + 0.5) * bw, cy = (r + 0.5) * bh;
      if (!regions.some(g => cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h)) { ok = false; break; }
    }
  }
  t('regionsFromMask: every changed block inside SOME region (25 random masks)', ok);
}
{
  // overflow merge: >maxRegions components → kept (maxRegions-1) + ONE merged
  // bounding region; coverage NEVER dropped (semantics: maxRegions-1 largest
  // components stay separate, everything else merges into a single region).
  // 8 scattered single-block components (> maxRegions-1 = 5) — the 3 smallest
  // merge into one bounding region; total coverage stays under the cap.
  const m = mask(0);
  for (const i of [0, 12, 24, 36, 47, 59, 71, 83]) m[i] = 1;
  const regions = R.regionsFromMask(m, COLS, ROWS, 1280, 720);
  t('regionsFromMask: overflow merge → ≤maxRegions regions', regions !== null && regions.length <= R.ROI_DEFAULTS.maxRegions);
  const bw = 1280 / COLS, bh = 720 / ROWS;
  const allCovered = m.every((v, i) => {
    if (!v) return true;
    const cx = ((i % COLS) + 0.5) * bw, cy = (((i / COLS) | 0) + 0.5) * bh;
    return regions.some(g => cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h);
  });
  t('regionsFromMask: overflow merge keeps EVERY changed block covered', allCovered);
}
{
  // coverage cap → null (caller MUST fall back to full)
  const m = mask(1);   // everything changed
  t('regionsFromMask: over-coverage → null (full-scan fallback)', R.regionsFromMask(m, COLS, ROWS, 1280, 720) === null);
}
{
  const m = mask(0); m[0] = 1; m[COLS * ROWS - 1] = 1;   // two far corners
  const regions = R.regionsFromMask(m, COLS, ROWS, 1280, 720);
  t('regionsFromMask: two corners → 2 padded regions clamped to image', regions?.length === 2 && regions.every(g => g.x >= 0 && g.y >= 0 && g.x + g.w <= 1280 && g.y + g.h <= 720));
}
{
  // planPerception — fail-toward-full decision table
  const P = (o) => R.planPerception(o).mode;
  const why = (o) => R.planPerception(o).reason;
  t('planPerception: error → full', P({ error: 'x' }) === 'full' && why({ error: 'x' }).startsWith('roi-error'));
  t('planPerception: first sight → full', P({ hasPrevState: false }) === 'full' && why({ hasPrevState: false }) === 'first-sight');
  t('planPerception: url change → full', P({ hasPrevState: true, urlMatched: false }) === 'full' && why({ hasPrevState: true, urlMatched: false }) === 'url-change');
  t('planPerception: ratio over cap → full', P({ hasPrevState: true, urlMatched: true, ratio: 0.5 }) === 'full' && why({ hasPrevState: true, urlMatched: true, ratio: 0.5 }) === 'changed-ratio-over-cap');
  t('planPerception: periodic cap → full', P({ hasPrevState: true, urlMatched: true, ratio: 0.1, consecutive: R.ROI_DEFAULTS.maxConsecutiveRoi }) === 'full' && why({ hasPrevState: true, urlMatched: true, ratio: 0.1, consecutive: R.ROI_DEFAULTS.maxConsecutiveRoi }) === 'periodic-full-cap');
  t('planPerception: all preconditions → roi', P({ hasPrevState: true, urlMatched: true, ratio: 0.1, consecutive: 0 }) === 'roi' && why({ hasPrevState: true, urlMatched: true, ratio: 0.1, consecutive: 0 }) === 'blocks-localized');
}
{
  const regions = [{ x: 0, y: 0, w: 100, h: 100 }];
  t('boxOutsideAllRegions: inside → false', R.boxOutsideAllRegions({ x: 50, y: 50, w: 5, h: 5 }, regions) === false);
  t('boxOutsideAllRegions: outside → true', R.boxOutsideAllRegions({ x: 200, y: 200, w: 5, h: 5 }, regions) === true);
  t('boxOutsideAllRegions: empty regions → true (keep all)', R.boxOutsideAllRegions({ x: 1, y: 1, w: 1, h: 1 }, []) === true);
  t('boxIntersectsRegion: edge touch', R.boxIntersectsRegion({ x: 100, y: 50, w: 5, h: 5 }, regions[0]) === false);
}
{
  t('roi-diff: module version exported', R.ROI_MODULE_VERSION === '1.0.0');
  t('roi-diff: defaults frozen', Object.isFrozen(R.ROI_DEFAULTS));
}

// ── C) wiring markers ───────────────────────────────────────────────────────
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const pf = read('src/lib/privacy-filter.js');
const op = read('src/lib/ocr-pii.js');
const bench = (p) => read(p);

// P0-B privacy-filter ⇄ roi-diff activation
t('privacy-filter imports roi-diff.js', pf.includes("from './roi-diff.js'"));
t('privacy-filter imports scanImagePiiRegionsRoi', pf.includes('scanImagePiiRegionsRoi'));
t('privacy-filter: planRoiRescan defined', pf.includes('async function planRoiRescan'));
t('privacy-filter: computeRoiFingerprints defined', pf.includes('async function computeRoiFingerprints'));
t('privacy-filter: _roiState chain exists', pf.includes('const _roiState'));
t('privacy-filter: fingerprints-only contract documented', pf.includes('FINGERPRINTS ONLY'));
t('privacy-filter: cfg.roiRescan default ON', pf.includes('roiRescan: true'));
t('privacy-filter: boxOutsideAllRegions keeps prev boxes', pf.includes('boxOutsideAllRegions(b.bounds, plan.regions)'));
t('privacy-filter: changedCount=0 → reuse all prev regions', pf.includes('roiReused: true'));
t('privacy-filter: ROI failure degrades to FULL', pf.includes('ROI rescan failed — degrading to FULL scan'));
t('privacy-filter: failed/skipped scan resets chain', pf.includes('_roiState.fps = null'));
t('privacy-filter: url guard uses pageUrl', pf.includes('input.pageUrl'));
t('privacy-filter: stats.roi telemetry', pf.includes('changedBlocks: roiChangedBlocks'));
t('privacy-filter: roiMode log line', pf.includes("roiMode=roi") && pf.includes("roiMode=full"));

// P0-B ocr-pii STRICT ROI scan
t('ocr-pii exports scanImagePiiRegionsRoi', op.includes('export async function scanImagePiiRegionsRoi'));
t('ocr-pii: empty region-set THROWS', op.includes('empty scan-region set (caller must fall back to a full scan)'));
t('ocr-pii: zero-scanned THROWS', op.includes('zero regions scanned (decode or engine failure)'));
t('ocr-pii: decode 0×0 THROWS', op.includes('image decode produced 0×0'));
t('ocr-pii: min crop window 60×24 expansion', op.includes('Math.max(60, Math.round(r.w))'));
t('ocr-pii: roi-diff contract doc (fail-toward-full)', op.includes('STRICT CONTRACT'));

// P0-A per-test latency in every suite
t('bench: latency.js exists with shared helpers', read('OpenCometBench/latency.js').includes('export function latencyStats'));
t('privacy.bench.js: per-case timed + samplesMs', bench('OpenCometBench/privacy.bench.js').includes('await timed(() => detectPiiInText') && bench('OpenCometBench/privacy.bench.js').includes('samplesMs: roundSamples(lat)'));
t('redaction.bench.js: per-step timed + stageMs', bench('OpenCometBench/redaction.bench.js').includes('stageMs') && bench('OpenCometBench/redaction.bench.js').includes('samplesMs: roundSamples(lat)'));
t('visual-context.bench.js: rows carry latencyMs + gateLatencyMs', bench('OpenCometBench/visual-context.bench.js').includes('latencyMs: r3(ms)') && bench('OpenCometBench/visual-context.bench.js').includes('gateLatencyMs'));
t('security.test.js: per-test latencyMs + samplesMs', bench('OpenCometBench/security.test.js').includes('latencyMs: r3(ms)') && bench('OpenCometBench/security.test.js').includes('samplesMs: roundSamples(lat)'));
t('server-validation.test.js: per-test latencyMs + samplesMs', bench('OpenCometBench/server-validation.test.js').includes('latencyMs: r3(ms)') && bench('OpenCometBench/server-validation.test.js').includes('samplesMs: roundSamples(lat)'));
t('fuzz.test.js: outbound path timed + samplesMs', bench('OpenCometBench/fuzz.test.js').includes('latencyMs: r3(ms)') && bench('OpenCometBench/fuzz.test.js').includes('samplesMs: roundSamples(lat)'));
t('run-all.js: latency line printed', bench('OpenCometBench/run-all.js').includes('p95=${m.latency.p95Ms}ms'));
t('run-adversarial.mjs: per-case wall time', bench('OpenCometBench/e2e/run-adversarial.mjs').includes('caseT0') && bench('OpenCometBench/e2e/run-adversarial.mjs').includes("row.latencyMs = r3(performance.now() - caseT0)"));
t('run-adversarial.mjs: r3 from shared latency.js', bench('OpenCometBench/e2e/run-adversarial.mjs').includes("import { r3 } from '../latency.js'"));
t('privacy-firewall: pipeline result carries stats.roi untouched (shape check)', pf.includes('roi: {'));

console.log(`\nv1.30.0 verification: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
