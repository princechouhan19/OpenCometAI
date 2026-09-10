// ─────────────────────────────────────────────────────────────────────────────
// OpenCometBench/server-validation.test.js — SIH v1.13
// Exercises the EXACT inbound validation the companion server runs
// (server/validate.js) — the server must reject malformed / unsafe payloads
// and never become an accidental raw-image bypass.
// ─────────────────────────────────────────────────────────────────────────────
import { validateInboundRequest, sniffImageMime, LIMITS } from '../server/validate.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(64).fill(0)]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(64).fill(0)]);
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, ...Array(64).fill(0)]);

function envelope(overrides = {}) {
  return {
    task: 'buy headphones',
    sanitizedText: 'Welcome to the shop. Your order 88123 was placed.',
    manifest: [{ regionId: 'region_01', type: 'password', bounds: { x: 10, y: 20, w: 100, h: 20 }, reason: 'dom', confidence: 1, action: 'blackout' }],
    history: [{ action: { type: 'click', selector: '#buy' }, result: 'page changed' }],
    settings: { provider: 'ollama', model: 'llava:7b' },
    privacyVerification: { enforced: true, passed: true, checks: {}, firewallVersion: '1.0.0' },
    imageBuffer: PNG,
    imageMime: 'image/png',
    ...overrides,
  };
}

const TESTS = [
  ['valid sanitized payload → OK', () => validateInboundRequest(envelope()).ok],

  ['missing task → rejected', () => !validateInboundRequest(envelope({ task: '' })).ok],
  ['oversized task → rejected', () => !validateInboundRequest(envelope({ task: 'x'.repeat(LIMITS.taskMaxChars + 1) })).ok],

  ['missing image → rejected', () => !validateInboundRequest(envelope({ imageBuffer: null })).ok],
  ['non-image bytes (MZ exe header) → rejected', () => !validateInboundRequest(envelope({ imageBuffer: EXE })).ok],
  ['declared MIME text/plain → rejected', () => !validateInboundRequest(envelope({ imageMime: 'text/plain' })).ok],
  ['JPEG bytes accepted', () => validateInboundRequest(envelope({ imageBuffer: JPEG, imageMime: 'image/jpeg' })).ok],

  ['manifest with selector key → rejected', () =>
    !validateInboundRequest(envelope({ manifest: [{ regionId: 'region_01', type: 'password', bounds: { x: 1, y: 2, w: 3, h: 4 }, selector: '#user_ssn_input' }] })).ok],
  ['manifest with raw value key → rejected', () =>
    !validateInboundRequest(envelope({ manifest: [{ regionId: 'region_01', type: 'password', bounds: { x: 1, y: 2, w: 3, h: 4 }, value: 'hunter2' }] })).ok],
  ['manifest with bad regionId → rejected', () =>
    !validateInboundRequest(envelope({ manifest: [{ regionId: 'r1', type: 'password', bounds: { x: 1, y: 2, w: 3, h: 4 } }] })).ok],
  ['manifest not an array → rejected', () => !validateInboundRequest(envelope({ manifest: { 0: {} } })).ok],
  ['manifest JSON string parsed then validated', () =>
    validateInboundRequest(envelope({ manifest: JSON.stringify([{ regionId: 'region_01', type: 'email', bounds: { x: 0, y: 0, w: 5, h: 5 } }]) })).ok],
  ['oversized manifest → rejected', () =>
    !validateInboundRequest(envelope({ manifest: Array.from({ length: LIMITS.manifestMaxEntries + 1 }, (_, i) => ({ regionId: `region_${i + 1}`, type: 'email', bounds: { x: 0, y: 0, w: 1, h: 1 } })) })).ok],

  ['missing privacyVerification → rejected (fail-closed server)', () =>
    !validateInboundRequest(envelope({ privacyVerification: undefined })).ok],
  ['privacyVerification.passed=false → rejected even with enforced=true', () =>
    !validateInboundRequest(envelope({ privacyVerification: { enforced: true, passed: false } })).ok],
  ['OPENCOMET_ACCEPT_UNVERIFIED still rejects passed=false', () => {
    process.env.OPENCOMET_ACCEPT_UNVERIFIED = '1';
    try {
      const r = validateInboundRequest(envelope({ privacyVerification: { enforced: true, passed: false } }));
      return !r.ok;
    } finally { delete process.env.OPENCOMET_ACCEPT_UNVERIFIED; }
  }],
  ['OPENCOMET_ACCEPT_UNVERIFIED allows MISSING envelope (diagnostics only)', () => {
    process.env.OPENCOMET_ACCEPT_UNVERIFIED = '1';
    try {
      const r = validateInboundRequest(envelope({ privacyVerification: undefined }));
      return r.ok;
    } finally { delete process.env.OPENCOMET_ACCEPT_UNVERIFIED; }
  }],

  ['unknown settings keys stripped, known kept', () => {
    const r = validateInboundRequest(envelope({ settings: { provider: 'ollama', model: 'llava:7b', EvilField: 'x', nested: { a: 1 } } }));
    return r.ok && r.settings.provider === 'ollama' && !('EvilField' in r.settings) && !('nested' in r.settings);
  }],
  ['settings with function-shaped garbage → rejected', () =>
    !validateInboundRequest(envelope({ settings: { provider: { $gt: 1 } } })).ok],
  ['unknown provider → rejected', () =>
    !validateInboundRequest(envelope({ settings: { provider: 'sketchy-cloud' } })).ok],

  ['history oversize → rejected', () =>
    !validateInboundRequest(envelope({ history: Array.from({ length: LIMITS.historyMaxEntries + 1 }, () => ({ action: {}, result: 'x' })) })).ok],
  ['history entry with huge echoed page text → rejected', () =>
    !validateInboundRequest(envelope({ history: [{ action: {}, result: 'x'.repeat(LIMITS.historyEntryMaxChars + 1) }] })).ok],

  ['magic bytes: PNG sniff', () => sniffImageMime(PNG) === 'image/png'],
  ['magic bytes: JPEG sniff', () => sniffImageMime(JPEG) === 'image/jpeg'],
  ['magic bytes: unknown', () => sniffImageMime(EXE) === null],
];

export async function run() {
  const results = [];
  for (const [name, fn] of TESTS) {
    let ok = false, err = null;
    try { ok = Boolean(await fn()); } catch (e) { err = e?.message || String(e); }
    results.push({ name, ok, ...(err ? { error: err } : {}) });
  }
  const passed = results.filter(r => r.ok).length;
  return {
    name: 'Server inbound validation (reject malformed/unsafe payloads)',
    pass: passed === results.length,
    metrics: { passed, total: results.length, results },
  };
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(JSON.stringify(await run(), null, 2));
}
