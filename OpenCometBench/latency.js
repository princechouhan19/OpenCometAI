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
