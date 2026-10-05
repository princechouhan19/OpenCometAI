#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// OpenCometBench/run-all.js — SIH benchmark orchestrator (Phases 17-22, 27)
//
//   node OpenCometBench/run-all.js            → run every suite, print the table
//   node OpenCometBench/run-all.js --json     → machine-readable output
//
// Exit code 0 = all suites pass. Every number printed is MEASURED from the
// real modules — nothing here is asserted or fabricated.
// ─────────────────────────────────────────────────────────────────────────────
import { suites } from './suites.js';
import { bootstrapCi } from './latency.js';   // v1.31.0: CIs on published percentiles

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const only = args.find(a => a.startsWith('--only='))?.split('=')[1];

const results = [];
for (const s of suites) {
  if (only && !s.name.toLowerCase().includes(only.toLowerCase())) continue;
  const t0 = performance.now();
  try {
    const r = await s.run();
    r.durationMs = Math.round(performance.now() - t0);
    // v1.31.0: deterministic 95% bootstrap CI around p50 and p95 of THIS
    // suite's per-case samples — published claims now carry error bars.
    const lat = r.metrics?.latency;
    if (lat && typeof lat.n === 'number' && lat.n > 0) {
      const samples = Array.isArray(r.metrics?.samplesMs)
        ? r.metrics.samplesMs
        : (Array.isArray(r.metrics?.latency?.samplesMs) ? r.metrics.latency.samplesMs : null);
      if (samples?.length) {
        lat.ciP50 = bootstrapCi(samples, { q: 0.5 });
        lat.ciP95 = bootstrapCi(samples, { q: 0.95 });
      }
    }
    results.push(r);
  } catch (err) {
    results.push({ name: s.name, pass: false, metrics: { error: err?.message || String(err) }, durationMs: Math.round(performance.now() - t0) });
  }
}

if (jsonOut) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  SIH PS 26171 — OpenCometAI benchmark suite (real measurements)');
  console.log('══════════════════════════════════════════════════════════════════');
  let allPass = true;
  for (const r of results) {
    allPass &&= r.pass;
    console.log(`\n[${r.pass ? 'PASS' : 'FAIL'}] ${r.name} (${r.durationMs} ms)`);
    const m = r.metrics || {};
    if (m.overall) {
      console.log(`     overall: P=${m.overall.precision} R=${m.overall.recall} F1=${m.overall.f1} (TP=${m.overall.tp} FP=${m.overall.fp} FN=${m.overall.fn}) · targets P≥${m.targets?.precision} R≥${m.targets?.recall}`);
      if (m.falsePositives?.length) console.log(`     false positives: ${m.falsePositives.map(f => `${f.id}→${f.type}`).join(', ')}`);
      if (m.misses?.length) console.log(`     misses: ${m.misses.map(f => `${f.id} (${f.got})`).join(', ')}`);
    }
    if (m.avgCoverage !== undefined) {
      console.log(`     coverage=${m.avgCoverage} IoU=${m.meanIou} over-redaction=${m.overRedactionPct}% style=${m.styleCorrect} manifestOk=${m.manifestOk}`);
    }
    if (m.accuracy !== undefined) {
      console.log(`     accuracy=${m.accuracy} (${m.correct}) elements=${m.elementCoverage} gate=${JSON.stringify(m.gate)}`);
    }
    if (m.latency) {
      // v1.30.0: per-test latency measured in EVERY suite (see latency.js)
      // v1.31.0: deterministic 95% bootstrap CIs printed beside p50/p95
      const ci50 = m.latency.ciP50, ci95 = m.latency.ciP95;
      const fmt = (ci) => (ci ? ` [CI95 ${ci.loMs}–${ci.hiMs}]` : '');
      console.log(`     latency: n=${m.latency.n} · min=${m.latency.minMs}ms · p50=${m.latency.p50Ms}ms${fmt(ci50)} · p90=${m.latency.p90Ms}ms · p95=${m.latency.p95Ms}ms${fmt(ci95)} · max=${m.latency.maxMs}ms`);
    }
    if (m.passed !== undefined && m.results) {
      for (const t of m.results) console.log(`     ${t.ok ? '✓' : '✗'} ${t.name}`);
      if (!r.pass) {
        for (const t of m.results.filter(x => !x.ok)) console.log(`       ↳ ${t.name}${t.error ? ' — ' + t.error : ''}`);
      }
    }
    if (m.error) console.log(`     ERROR: ${m.error}`);
  }
  console.log('\n──────────────────────────────────────────────────────────────────');
  console.log(`  ${allPass ? 'ALL SUITES PASS' : 'FAILURES PRESENT'} · ${results.length} suite(s) · ${new Date().toISOString()}`);
  console.log('──────────────────────────────────────────────────────────────────\n');
}

process.exit(results.every(r => r.pass) ? 0 : 1);
