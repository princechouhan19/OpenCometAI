// ─────────────────────────────────────────────────────────────────────────────
// OpenCometBench/latency.js — shared per-test latency measurement helpers.
//
// v1.30.0: EVERY benchmark suite records the latency of every individual
// test case (not just the tier wall time that run-all.js already printed).
// Suites import `latencyStats` and report it as metrics.latency; run-all.js
// prints the p50/p90/p95 summary per suite and the JSON output carries the
// full per-case samples.
//
// Percentile method matches the e2e/browser runners' `pct()` (sorted array,
// index floor(q·n), clamped) so latency numbers are comparable across tiers.
// ─────────────────────────────────────────────────────────────────────────────

export const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Time an async (or sync) test-case function.
 * Returns { out, ms } — ms is a raw float (round with r3 at the boundary).
 */
export async function timed(fn) {
  const t0 = performance.now();
  const out = await fn();
  return { out, ms: performance.now() - t0 };
}

/**
 * Aggregate per-case latency samples (ms) into a stats object.
 * Empty / null / non-numeric entries are ignored (never fabricated as 0 —
 * an empty sample set reports n=0 so a missing measurement stays visible).
 */
export function latencyStats(samplesMs) {
  const s = (Array.isArray(samplesMs) ? samplesMs : [])
    .filter(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const n = s.length;
  if (!n) return { n: 0, minMs: 0, p50Ms: 0, meanMs: 0, p90Ms: 0, p95Ms: 0, maxMs: 0, totalMs: 0 };
  const pick = (q) => s[Math.min(n - 1, Math.floor(q * n))];
  const total = s.reduce((a, v) => a + v, 0);
  return {
    n,
    minMs: r3(s[0]),
    p50Ms: r3(pick(0.5)),
    meanMs: r3(total / n),
    p90Ms: r3(pick(0.9)),
    p95Ms: r3(pick(0.95)),
    maxMs: r3(s[n - 1]),
    totalMs: r3(total),
  };
}

/** Round per-case samples once for JSON output (3 decimals). */
export const roundSamples = (samplesMs) =>
  (Array.isArray(samplesMs) ? samplesMs : []).map(v => r3(v));

// ─────────────────────────────────────────────────────────────────────────────
// v1.31.0 — STATISTICAL RIGOR: percentile bootstrap CIs + Mann-Whitney U.
//
// bootstrapCi(): deterministic (seeded mulberry32 PRNG) percentile bootstrap
// confidence interval for ANY latency percentile of a sample set. Same samples
// → same interval, run after run, so published claims are reproducible.
//
// mannWhitneyU(): nonparametric A/B significance test on two sample sets
// (normal approximation with tie correction). The regression gate uses it so
// a p95 "regression" only FAILS when the underlying distributions genuinely
// shifted (p < alpha) — machine noise no longer blocks releases.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Percentile bootstrap CI for one quantile of `samplesMs`.
 * opts: q (quantile, default 0.95), iters (resamples, default 1000),
 *       alpha (1-confidence, default 0.05 → 95% CI), seed (default fixed).
 * Returns { q, n, loMs, hiMs, iters, alpha } — zeros for empty input
 * (a missing measurement is never fabricated, same policy as latencyStats).
 */
export function bootstrapCi(samplesMs, { q = 0.95, iters = 1000, alpha = 0.05, seed = 20260131 } = {}) {
  const s = (Array.isArray(samplesMs) ? samplesMs : [])
    .filter(v => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  if (!s.length || iters < 1) return { q, n: 0, loMs: 0, hiMs: 0, iters, alpha };
  // mulberry32 — tiny, fast, fully deterministic from `seed`
  let a = seed >>> 0;
  const rnd = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = s.length;
  const quantiles = new Array(iters);
  const idx = new Array(n);
  for (let i = 0; i < iters; i++) {
    for (let j = 0; j < n; j++) idx[j] = s[Math.min(n - 1, Math.floor(rnd() * n))];
    idx.sort((x, y) => x - y);
    quantiles[i] = idx[Math.min(n - 1, Math.floor(q * n))];
  }
  quantiles.sort((x, y) => x - y);
  const lo = quantiles[Math.min(iters - 1, Math.floor((alpha / 2) * iters))];
  const hi = quantiles[Math.min(iters - 1, Math.floor((1 - alpha / 2) * iters))];
  return { q, n, loMs: r3(lo), hiMs: r3(hi), iters, alpha };
}

/**
 * Mann-Whitney U (Wilcoxon rank-sum) on two independent samples.
 * Normal approximation with tie correction — fine for n≥8 per side, which
 * every suite clears. Returns { u1, u, mu, sigma, z, p } (two-sided p).
 */
export function mannWhitneyU(a, b) {
  const A = (Array.isArray(a) ? a : []).filter(v => typeof v === 'number' && Number.isFinite(v));
  const B = (Array.isArray(b) ? b : []).filter(v => typeof v === 'number' && Number.isFinite(v));
  const n1 = A.length, n2 = B.length;
  if (!n1 || !n2) return { u1: 0, u: 0, mu: 0, sigma: 0, z: 0, p: 1 };
  const all = [...A.map(v => ({ v, g: 1 })), ...B.map(v => ({ v, g: 2 }))].sort((x, y) => x.v - y.v);
  // average ranks with tie handling
  const ranks = new Array(all.length);
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const avg = (i + j + 2) / 2;   // ranks are 1-based
    for (let k = i; k <= j; k++) ranks[k] = avg;
    i = j + 1;
  }
  const r1 = all.reduce((acc, e, k) => acc + (e.g === 1 ? ranks[k] : 0), 0);
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const u2 = n1 * n2 - u1;
  const mu = (n1 * n2) / 2;
  // tie correction on the combined set
  const counts = new Map();
  for (const e of all) counts.set(e.v, (counts.get(e.v) || 0) + 1);
  let tieSum = 0;
  for (const t of counts.values()) tieSum += t * t * t - t;
  const n = n1 + n2;
  const sigma = Math.sqrt(((n1 * n2) / (n * (n - 1))) * (((n * n * n - n) - tieSum) / 12));
  const z = sigma > 0 ? (Math.max(u1, u2) - mu) / sigma : 0;
  // two-sided p via Abramowitz–Stegun Φ approximation
  const p = 2 * (1 - phi(Math.abs(z)));
  return { u1, u: Math.min(u1, u2), mu, sigma: Math.round(sigma * 1e6) / 1e6, z: Math.round(z * 1e6) / 1e6, p: Math.round(Math.min(1, Math.max(0, p)) * 1e6) / 1e6 };
}

function phi(z) {
  // Φ(z) via erf approximation (Abramowitz & Stegun 7.1.26, |ε|<1.5e-7)
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327; // 1/√(2π)
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = 1 - d * Math.exp(-0.5 * z * z) * poly;
  return z >= 0 ? cdf : 1 - cdf;
}
