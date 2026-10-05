#!/usr/bin/env node
// scripts/test_v1310_verify.mjs — v1.31.0 verification harness.
//
// Covers:
//   A) latency.js statistical helpers — bootstrapCi (deterministic, empty-safe,
//      brackets the point estimate) + mannWhitneyU (separates shifted
//      distributions, accepts identical ones, tie-corrected)
//   B) OpenRouter prompt-cache helpers — openRouterCacheFeatures host gating,
//      cacheUsageFrom field normalization, sessionIdForTask stability + no-PII
//   C) Regression gate — REAL end-to-end: builds fake baseline/current JSONs,
//      runs OpenCometBench/regression-gate.mjs as a subprocess, and asserts
//      PASS on identical quality / FAIL on quality drift / FAIL on significant
//      p95 regression / PASS on within-noise p95 growth
//   D) Wiring markers — every v1.31.0 integration point present in source
//
// Run: node scripts/test_v1310_verify.mjs   → exit 0 = all pass

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${name}`); } };
const bench = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// ── A) statistical helpers ───────────────────────────────────────────────────
const L = await import(pathToFileURL(join(ROOT, 'OpenCometBench', 'latency.js')));

{
  const s = Array.from({ length: 300 }, (_, i) => 0.05 + (i % 41) * 0.01);
  const ci = L.bootstrapCi(s, { q: 0.95 });
  const st = L.latencyStats(s);
  t('bootstrapCi: deterministic (same seed → same interval)', JSON.stringify(L.bootstrapCi(s, { q: 0.95 })) === JSON.stringify(ci));
  t('bootstrapCi: brackets the point estimate (lo ≤ p95 ≤ hi)', ci.loMs <= st.p95Ms && st.p95Ms <= ci.hiMs);
  t('bootstrapCi: n preserved', ci.n === 300);
  t('bootstrapCi: lo < hi (non-degenerate)', ci.loMs < ci.hiMs);
  const e = L.bootstrapCi([]);
  t('bootstrapCi: empty → n=0, zeros (never fabricated)', e.n === 0 && e.loMs === 0 && e.hiMs === 0);
  const ci50 = L.bootstrapCi(s, { q: 0.5 });
  t('bootstrapCi: p50 CI below p95 CI', ci50.hiMs <= ci.hiMs);
}
{
  const fast = Array.from({ length: 150 }, (_, i) => 0.10 + (i % 25) * 0.001);
  const slow = Array.from({ length: 150 }, (_, i) => 0.40 + (i % 25) * 0.001);
  const same = Array.from({ length: 150 }, (_, i) => fast[i]);
  const shifted = L.mannWhitneyU(fast, slow);
  const identical = L.mannWhitneyU(fast, same);
  t('MWU: shifted distributions → p ≈ 0 (significant)', shifted.p < 0.001);
  t('MWU: identical samples → p = 1 (not significant)', identical.p === 1);
  t('MWU: symmetric statistic (u = μ when swapped)', L.mannWhitneyU(slow, fast).mu === shifted.mu);
  const ties = L.mannWhitneyU([1, 1, 2, 2, 3, 3], [1, 2, 2, 3, 3, 3]);
  t('MWU: tie-heavy sets → no NaN / p in [0,1]', Number.isFinite(ties.p) && ties.p >= 0 && ties.p <= 1);
  t('MWU: empty side → p = 1 (no fabricated significance)', L.mannWhitneyU([], [1, 2, 3]).p === 1);
}

// ── B) OpenRouter cache helpers + session id ─────────────────────────────────
const P = await import(pathToFileURL(join(ROOT, 'src', 'lib', 'providers.js')));
const PA = await import(pathToFileURL(join(ROOT, 'src', 'lib', 'privacy-agent.js')));

{
  const or = P.openRouterCacheFeatures('https://openrouter.ai/api/v1');
  const orSub = P.openRouterCacheFeatures('https://openrouter.ai.example.com/api/v1'.replace('.example.com', ''));
  const off = P.openRouterCacheFeatures('http://127.0.0.1:8787');
  const off2 = P.openRouterCacheFeatures('https://api.deepseek.com/v1');
  const garbage = P.openRouterCacheFeatures('not a url');
  t('cacheFeatures: openrouter.ai → sticky + promptCache', or.stickySession === true && or.promptCache === true);
  t('cacheFeatures: openrouter.ai bare host (subdomain path) → enabled', orSub.stickySession === true);
  t('cacheFeatures: localhost companion server → OFF', off.stickySession === false && off.promptCache === false);
  t('cacheFeatures: other providers → OFF', off2.stickySession === false && off2.promptCache === false);
  t('cacheFeatures: garbage input → OFF (no throw)', garbage.stickySession === false && garbage.promptCache === false);
}
{
  const u1 = P.cacheUsageFrom({ prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 100 }, cache_discount: 80 });
  const u2 = P.cacheUsageFrom({ cache_read_tokens: 42 });
  const u3 = P.cacheUsageFrom(null);
  t('cacheUsage: OpenAI-style details parsed', u1.cachedTokens === 900 && u1.cacheWriteTokens === 100 && u1.cacheDiscountPct === 80);
  t('cacheUsage: flat fallback field parsed', u2.cachedTokens === 42);
  t('cacheUsage: null usage → zeros (never fabricated)', u3.cachedTokens === 0 && u3.cacheWriteTokens === 0 && u3.cacheDiscountPct === 0);
}
{
  const a = PA.sessionIdForTask('Buy 1kg basmati rice');
  const b = PA.sessionIdForTask('Buy 1kg basmati rice');
  const c = PA.sessionIdForTask('Book a table for two');
  t('sessionId: deterministic per task', a === b);
  t('sessionId: distinct tasks → distinct ids', a !== c);
  t('sessionId: oc-<base36> shape, no task text leaks', /^oc-[0-9a-z]+$/.test(a) && !a.includes('rice'));
  t('sessionId: empty task → still a valid id', /^oc-[0-9a-z]+$/.test(PA.sessionIdForTask('')));
}

// ── C) regression gate — REAL subprocess runs ────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'ocgate-'));
  const mkSuite = (name, p95, samples) => ({
    name, pass: true,
    metrics: {
      overall: { precision: 1, recall: 1, f1: 1, tp: 366, fp: 0, fn: 0 },
      latency: { n: samples.length, p50Ms: 0.01, p95Ms: p95, samplesMs: samples },
      samplesMs: undefined,
    },
  });
  const baseSamples = Array.from({ length: 100 }, (_, i) => 0.1 + (i % 20) * 0.01);
  // symmetric, seeded random jitter — a genuine "machine noise" pattern:
  // no systematic shift, so MWU must NOT call it significant even at n=100
  let _seed = 42 >>> 0;
  const rnd = () => { _seed |= 0; _seed = (_seed + 0x6D2B79F5) | 0; let tt = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed); tt = (tt + Math.imul(tt ^ (tt >>> 7), 61 | tt)) ^ tt; return ((tt ^ (tt >>> 14)) >>> 0) / 4294967296; };
  const noiseSamples = baseSamples.map(v => v + (rnd() - 0.5) * 0.008);
  const slowSamples = Array.from({ length: 100 }, (_, i) => 0.16 + (i % 20) * 0.01 + (i % 5) * 0.002);
  const baseline = { results: [mkSuite('suiteA', 0.30, baseSamples), mkSuite('suiteB', 0.50, baseSamples)] };

  const runGate = (current) => {
    const curPath = join(dir, 'cur.json');
    const basePath = join(dir, 'base.json');
    writeFileSync(curPath, JSON.stringify(current));
    writeFileSync(basePath, JSON.stringify(baseline));
    try {
      const out = execFileSync('node', [join(ROOT, 'OpenCometBench', 'regression-gate.mjs'), '--current', curPath, '--baseline', basePath], { encoding: 'utf8' });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
    }
  };

  const same = runGate({ results: [mkSuite('suiteA', 0.31, baseSamples), mkSuite('suiteB', 0.50, baseSamples)] });
  t('gate: identical quality + within-budget p95 → PASS', same.code === 0);

  const drift = { results: [mkSuite('suiteA', 0.30, baseSamples), mkSuite('suiteB', 0.50, baseSamples)] };
  drift.results[0].metrics.overall.f1 = 0.97;
  const q = runGate(drift);
  t('gate: quality-metric change → FAIL (hard block)', q.code === 1 && /QUALITY METRICS CHANGED/.test(q.out));

  const slower = runGate({ results: [mkSuite('suiteA', 0.45, slowSamples), mkSuite('suiteB', 0.50, baseSamples)] });
  t('gate: p95 +50% with SIGNIFICANT distribution shift → FAIL', slower.code === 1 && /REAL regression/.test(slower.out));

  const noisy = runGate({ results: [mkSuite('suiteA', 0.40, noiseSamples), mkSuite('suiteB', 0.50, baseSamples)] });
  t('gate: p95 growth within machine noise (MWU p ≥ alpha) → PASS', noisy.code === 0 && /within machine noise/.test(noisy.out));

  const failed = { results: [{ ...mkSuite('suiteA', 0.30, baseSamples), pass: false }, mkSuite('suiteB', 0.50, baseSamples)] };
  const f = runGate(failed);
  t('gate: suite failing on current run → FAIL', f.code === 1 && /suite FAILED/.test(f.out));

  rmSync(dir, { recursive: true, force: true });
}

// ── D) wiring markers ────────────────────────────────────────────────────────
{
  const lv = bench('src/lib/local-vision.js');
  t('local-vision: numThreads from ortThreadCount() (not pinned 1)', lv.includes('numThreads = ortThreadCount()'));
  t('local-vision: SAB + isolation feature-detect', lv.includes('typeof SharedArrayBuffer') && lv.includes('crossOriginIsolated'));
  t('local-vision: thread override for tests', lv.includes('setVisionThreadCount'));
  t('local-vision: thread count in stats', lv.includes('threads: _stats.threads'));
  t('local-vision: hard cap ≤4 threads', /Math\.min\(4,\s*cores\)/.test(lv));

  const pv = bench('src/lib/providers.js');
  t('providers: host-gated cache features', pv.includes('export function openRouterCacheFeatures'));
  t('providers: session_id only via cacheFeat.stickySession', pv.includes('cacheFeat.stickySession && options.sessionId') && pv.includes('body.session_id'));
  t('providers: cache_control breakpoint on system prompt', pv.includes('cache_control: { type: \'ephemeral\' }'));
  t('providers: per-attempt message build (fallback can strip)', pv.includes('const messages = buildCompatMessages(prompt, images, { cacheBreakpoint: promptCacheOn })'));
  t('providers: one clean retry without breakpoint on 400/422', pv.includes('retrying the ladder without it'));
  t('providers: cache telemetry on stream + non-stream paths', (pv.match(/cacheUsageFrom\(/g) || []).length >= 3);

  const pa = bench('src/lib/privacy-agent.js');
  t('privacy-agent: sessionIdForTask exported + passed to callAI', pa.includes('export function sessionIdForTask') && pa.includes('sessionId,'));

  const pl = bench('src/background/privacy-loop.js');
  t('privacy-loop: TTFA stamped once per run', pl.includes('runTiming.firstDecisionMs = Date.now() - runT0'));
  t('privacy-loop: TTFA per-run reset', pl.includes('runTiming.firstDecisionMs = 0'));
  t('privacy-loop: TTFA in latencyProfile (all DONE paths)', pl.includes('firstDecisionMs: Math.round(t.firstDecisionMs || 0)'));

  const ra = bench('OpenCometBench/e2e/run-adversarial.mjs');
  t('adversarial: --context-budget parsed (default 8)', ra.includes('--context-budget=8'));
  t('adversarial: rotation guard in both suite loops', (ra.match(/memory guard after \$\{CONTEXT_BUDGET\} cases/g) || []).length === 2);
  t('adversarial: TTFA row from recorder arrival timestamp', ra.includes('row.ttfaMs = r3(Math.max(0, call.at - privacyStartWall))'));
  t('adversarial: report carries contextBudget/rotations', ra.includes('contextBudget: CONTEXT_BUDGET || null'));

  const ra2 = bench('OpenCometBench/run-all.js');
  t('run-all: bootstrap CIs attached to latency stats', ra2.includes('lat.ciP50 = bootstrapCi(samples, { q: 0.5 })'));
  t('run-all: CIs printed in the table', ra2.includes('[CI95'));

  const gh = bench('.github/workflows/bench-gate.yml');
  t('workflow: runs run-all --json then the gate', gh.includes('run-all.js --json') && gh.includes('regression-gate.mjs'));
  t('workflow: no Gemini Nano / built-in AI anywhere (per user decision)', !/nano|gemini|built-in ai/i.test(gh));

  // v1.31.0-touched source must not reference Chrome built-in AI at all
  for (const f of ['src/lib/providers.js', 'src/lib/privacy-agent.js', 'src/background/privacy-loop.js', 'src/lib/local-vision.js']) {
    t(`no Nano wiring in v1.31.0-touched source (${f.split('/').pop()})`, !/nano|built-in ai|prompt api/i.test(bench(f)));
  }
  // README may state the exclusion — but only as a "Not included" statement,
  // never as a feature claim
  const readme = bench('README.md');
  const notIncludedAt = readme.indexOf('Not included, by decision');
  const nanoHits = [...readme.matchAll(/gemini nano/gi)].map(m => m.index);
  t('README: Gemini Nano appears only inside the explicit "Not included" bullet',
    nanoHits.every(i => notIncludedAt >= 0 && i > notIncludedAt && i - notIncludedAt < 400));
}

console.log(`\nv1.31.0 verification: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
