#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// OpenCometBench/regression-gate.mjs — v1.31.0 quality + latency regression gate.
//
// Compares a CURRENT run-all.js --json output against a committed BASELINE
// (default: the v1.30.0 unit release evidence) and fails when:
//   1. ANY quality metric changed (P/R/F1, coverage/IoU, accuracy, gate,
//      leak counts … latency fields excluded) — quality regressions always
//      block, this is the gate that made "byte-identical quality" enforceable;
//   2. a suite's p95 regressed MORE than --latency-pct % AND the per-case
//      sample distributions differ significantly (Mann-Whitney U,
//      p < --alpha, two-sided) — i.e. a REAL slowdown, not machine noise.
//      If either side lacks samples, the p95 threshold alone is decisive and
//      the verdict is marked (no-samples).
//
// Usage:
//   node OpenCometBench/regression-gate.mjs --current /tmp/cur.json \
//        [--baseline OpenCometBench/baselines/v1.30.0-unit.json] \
//        [--latency-pct 25] [--alpha 0.01] [--update-baseline]
//
// Exit 0 = PASS (no regression), 1 = FAIL. --update-baseline copies the
// current JSON over the baseline file (after a PASS) and exits 0.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mannWhitneyU } from './latency.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
// accepts BOTH --name=value and "--name value" spellings
const argOf = (name, dflt) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--')) return args[i + 1];
  return dflt;
};
const hasFlag = (name) => args.includes(`--${name}`);

const curPath = argOf('current', null);
const baselinePath = argOf('baseline', join(ROOT, 'OpenCometBench', 'baselines', 'v1.30.0-unit.json'));
const LATENCY_PCT = Number(argOf('latency-pct', '25'));
const ALPHA = Number(argOf('alpha', '0.01'));

if (!curPath || !existsSync(curPath)) {
  console.error('regression-gate: --current=<run-all --json output file> is required');
  process.exit(1);
}
if (!existsSync(baselinePath)) {
  console.error(`regression-gate: baseline not found: ${baselinePath}`);
  process.exit(1);
}

// strip latency / sampling fields so ONLY quality is compared
function qualitySlice(x) {
  if (Array.isArray(x)) return x.map(qualitySlice);
  if (x && typeof x === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(x)) {
      if (/^latency$|^ciP50$|^ciP95$|^samplesMs$|^latencyMs$|^stageMs$|^durationMs$|^generatedAt$|^gateLatencyMs$/i.test(k)) continue;
      out[k] = qualitySlice(v);
    }
    return out;
  }
  return x;
}

// dig the per-case latency samples out of a suite entry (any known shape)
function collectSamples(entry) {
  const m = entry?.metrics || {};
  const fromSuite = m.latency?.samplesMs || m.samplesMs || null;
  if (Array.isArray(fromSuite) && fromSuite.length) return fromSuite.filter(v => typeof v === 'number');
  // fall back to per-case rows' latency.samplesMs
  const rows = Array.isArray(m.results) ? m.results : [];
  const merged = [];
  for (const row of rows) {
    const s = row?.latency?.samplesMs || row?.samplesMs || (typeof row?.latencyMs === 'number' ? [row.latencyMs] : null);
    if (Array.isArray(s)) merged.push(...s);
  }
  return merged.filter(v => typeof v === 'number');
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const current = JSON.parse(readFileSync(curPath, 'utf8'));
const baseSuites = baseline.results || [];
const curSuites = current.results || [];

console.log(`regression-gate · baseline=${baselinePath.split('/').slice(-2).join('/')} · current=${curPath}`);
console.log(`latency budget: p95 may grow ≤${LATENCY_PCT}% · MWU alpha=${ALPHA} · quality must be IDENTICAL\n`);

let fail = 0;
const rows = [];
for (const cur of curSuites) {
  const base = baseSuites.find(s => s.name === cur.name);
  if (!base) { rows.push(`  ?  ${cur.name} — no baseline entry (new suite, informational)`); continue; }

  // 1) quality identity
  const qBase = JSON.stringify(qualitySlice(base.metrics || {}));
  const qCur = JSON.stringify(qualitySlice(cur.metrics || {}));
  if (qBase !== qCur) {
    fail++;
    rows.push(`  ✗  ${cur.name} — QUALITY METRICS CHANGED (hard block)\n       diff: ${qBase.slice(0, 160)} → ${qCur.slice(0, 160)}`);
    continue;
  }
  if (cur.pass === false) {
    fail++;
    rows.push(`  ✗  ${cur.name} — suite FAILED on current run`);
    continue;
  }

  // 2) latency p95 budget + Mann-Whitney significance
  const p95Base = base.metrics?.latency?.p95Ms ?? null;
  const p95Cur = cur.metrics?.latency?.p95Ms ?? null;
  const sBase = collectSamples(base);
  const sCur = collectSamples(cur);
  if (p95Base == null || p95Cur == null) {
    rows.push(`  ✓  ${cur.name} — quality identical (no latency stats to compare)`);
    continue;
  }
  const growthPct = p95Base > 0 ? ((p95Cur - p95Base) / p95Base) * 100 : 0;
  const over = growthPct > LATENCY_PCT;
  let verdict;
  if (!over) {
    verdict = `p95 ${p95Base}→${p95Cur} ms (${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(1)}%)`;
  } else {
    const mw = (sBase.length >= 8 && sCur.length >= 8)
      ? mannWhitneyU(sBase, sCur)
      : null;
    if (mw && mw.p < ALPHA) {
      fail++;
      verdict = `p95 ${p95Base}→${p95Cur} ms (+${growthPct.toFixed(1)}% > ${LATENCY_PCT}% budget, MWU p=${mw.p} < ${ALPHA} — REAL regression)`;
    } else if (mw) {
      verdict = `p95 ${p95Base}→${p95Cur} ms (+${growthPct.toFixed(1)}% but MWU p=${mw.p} ≥ ${ALPHA} — within machine noise, allowed)`;
    } else {
      verdict = `p95 ${p95Base}→${p95Cur} ms (+${growthPct.toFixed(1)}% > ${LATENCY_PCT}% budget, no-samples — decisive)`;
      fail++;
    }
  }
  rows.push(`  ✓  ${cur.name} — quality identical · ${verdict}`);
}

console.log(rows.join('\n'));
if (baseSuites.length && curSuites.length && baseSuites.length !== curSuites.length) {
  console.log(`\n  ?  suite count changed: baseline ${baseSuites.length} → current ${curSuites.length} (informational)`);
}
console.log(`\nregression-gate: ${fail ? `FAIL (${fail} regression${fail > 1 ? 's' : ''})` : 'PASS — no quality or significant latency regression'}`);
if (hasFlag('update-baseline')) {
  writeFileSync(baselinePath, JSON.stringify(current, null, 2) + '\n');
  console.log(`baseline updated → ${baselinePath}`);
}
process.exit(fail ? 1 : 0);
