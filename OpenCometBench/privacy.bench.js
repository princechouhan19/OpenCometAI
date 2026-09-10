// ─────────────────────────────────────────────────────────────────────────────
// OpenCometBench/privacy.bench.js — SIH Phase 18
// PII DETECTION PRECISION / RECALL / F1 over the synthetic ground truth.
//
//   node OpenCometBench/privacy.bench.js          (or via OpenCometBench/run-all.js)
//
// Measures REAL behaviour of src/lib/pii-detector.js (regex + validators +
// contextual risk scoring). Numbers are computed from actual runs — never
// asserted constants.
// ─────────────────────────────────────────────────────────────────────────────
import { detectPiiInText } from '../src/lib/pii-detector.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(HERE, 'fixtures', 'pii-corpus.json'), 'utf8'));

export async function run() {
  const perType = {};   // type → {tp, fp, fn}
  const misses = [];
  const falsePositives = [];

  for (const p of corpus.positives) {
    const dets = await detectPiiInText(p.text);
    const idx = p.text.indexOf(p.expect);
    const span = { start: idx, end: idx + p.expect.length };
    const hit = dets.some(d => d.type === p.type && d.start < span.end && d.end > span.start);
    perType[p.type] ??= { tp: 0, fp: 0, fn: 0 };
    if (hit) perType[p.type].tp++;
    else {
      perType[p.type].fn++;
      misses.push({ id: p.id, type: p.type, expected: p.expect, got: dets.map(d => `${d.type}:"${d.raw}"`).join(', ') || 'none' });
    }
  }

  for (const n of corpus.negatives) {
    const dets = await detectPiiInText(n.text);
    for (const d of dets) {
      perType[d.type] ??= { tp: 0, fp: 0, fn: 0 };
      perType[d.type].fp++;
      falsePositives.push({ id: n.id, type: d.type, matched: d.raw, reason: n.reason });
    }
  }

  let tp = 0, fp = 0, fn = 0;
  const rows = {};
  for (const [type, c] of Object.entries(perType)) {
    const precision = c.tp + c.fp ? c.tp / (c.tp + c.fp) : 1;
    const recall = c.tp + c.fn ? c.tp / (c.tp + c.fn) : 1;
    const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
    rows[type] = { ...c, precision: r3(precision), recall: r3(recall), f1: r3(f1) };
    tp += c.tp; fp += c.fp; fn += c.fn;
  }
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;

  const targets = { precision: 0.97, recall: 0.95 };
  return {
    name: 'PII detection (precision / recall / F1)',
    pass: precision >= targets.precision && recall >= targets.recall,
    metrics: {
      overall: { tp, fp, fn, precision: r3(precision), recall: r3(recall), f1: r3(f1) },
      perType: rows,
      targets,
      misses,
      falsePositives,
      corpusSize: { positives: corpus.positives.length, negatives: corpus.negatives.length },
    },
  };
}

const r3 = (v) => Math.round(v * 1000) / 1000;

// Direct CLI run
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = await run();
  console.log(JSON.stringify(out, null, 2));
}
