#!/usr/bin/env node
// Debug failing PII corpus cases — print text + detections side by side.
import { detectPiiInText, verhoeffValid } from '../src/lib/pii-detector.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(HERE, 'fixtures', 'pii-corpus.json'), 'utf8'));

const want = new Set(process.argv.slice(2));
for (const p of corpus.positives) {
  if (want.size && !want.has(p.id)) continue;
  const dets = await detectPiiInText(p.text);
  const hit = dets.some(d => d.type === p.type && (() => {
    const idx = p.text.indexOf(p.expect); const s = idx, e = idx + p.expect.length;
    return d.start < e && d.end > s;
  })());
  if (!hit || want.has(p.id)) {
    console.log(`\n[${p.id}] type=${p.type} variant=${p.variant || '-'}`);
    console.log(`  text  : ${JSON.stringify(p.text)}`);
    console.log(`  expect: ${JSON.stringify(p.expect)}`);
    console.log(`  dets  : ${dets.map(d => `${d.type}@${d.start}-${d.end} ${JSON.stringify(d.raw)}`).join('  |  ') || '(none)'}`);
  }
}
for (const n of corpus.negatives) {
  if (want.size && !want.has(n.id)) continue;
  const dets = await detectPiiInText(n.text);
  if (dets.length) {
    console.log(`\n[FP ${n.id}] reason=${n.reason}`);
    console.log(`  text: ${JSON.stringify(n.text)}`);
    console.log(`  dets: ${dets.map(d => `${d.type} ${JSON.stringify(d.raw)}`).join('  |  ')}`);
  }
}
// sanity: verhoeff generator round-trip
let ok = 0, bad = 0;
for (const p of corpus.positives.filter(x => x.type === 'aadhaar')) {
  const digitsOnly = p.expect.replace(/\D/g, '');
  verhoeffValid(digitsOnly) ? ok++ : bad++;
}
console.log(`\naadhaar positives: verhoeff-valid=${ok} invalid=${bad}`);
