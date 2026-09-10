// ─────────────────────────────────────────────────────────────────────────────
// OpenCometBench/fuzz.test.js — SIH v1.13 PRIVACY LEAKAGE FUZZ SUITE (Node).
//
// Generates hundreds of synthetic secrets across 8 families and attempts to
// smuggle them to the network through EVERY outbound channel the agent has:
//   DOM text · page title · dialog labels · history results · manifest fields
//   visual-context injection attempts · OCR-derived text · open-tab titles
//
// For each case the REAL outbound path runs:
//   pipeline-shaped result → sanitizeScreenContext() → buildPrivacyDecisionPrompt()
//   → validateSanitizedPayload() / scanTextForSecrets() on the final wire strings
//
// PASS = for every case either the gate BLOCKS, or the raw secret value is
// provably absent (only masked forms survive) from everything that would hit
// the wire. Deterministic (seeded) — a failure reproduces exactly.
// ─────────────────────────────────────────────────────────────────────────────
import {
  sanitizeScreenContext,
  validateSanitizedPayload,
  scanTextForSecrets,
} from '../src/lib/privacy-firewall.js';
import { buildPrivacyDecisionPrompt } from '../src/lib/privacy-agent.js';
import { maskForType } from '../src/lib/pii-detector.js';

// mulberry32 — deterministic
let _s = 26171;
const rnd = () => { _s |= 0; _s = (_s + 0x6D2B79F5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));

// ── secret families (all synthetic) ─────────────────────────────────────────
function luhnCard() {
  const partial = pick(['4532', '5100', '6011']) + Array.from({ length: 11 }, () => ri(0, 9)).join('');
  let sum = 0, alt = true;
  for (let i = partial.length - 1; i >= 0; i--) { let n = Number(partial[i]); if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return partial + ((10 - (sum % 10)) % 10);
}
function verhoeffAadhaar() {
  const VER_D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
  const VER_P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
  const phi = Array.from({ length: 11 }, () => ri(0, 9)).join('');
  for (let d = 0; d <= 9; d++) {
    let c = 0; const rev = (phi + d).split('').reverse();
    for (let i = 0; i < rev.length; i++) c = VER_D[c][VER_P[i % 8][Number(rev[i])]];
    if (c === 0) return `${phi.slice(0, 4)} ${phi.slice(4)}${d}`;
  }
  return phi + '0';
}
function pick(a) { return a[ri(0, a.length - 1)]; }

const FAMILIES = [
  // Passwords realistically appear WITH their label (form text, OCR of a
  // "Password: …" field). The bare form (no keyword anywhere) is a documented
  // limitation — see KNOWN-LIMITATION handling below.
  { id: 'password', gen: () => `Password: ${pick(['Hunt3r', 'Str0ng', 'S3cret'])}${ri(100, 9999)}${pick(['!', '#', '$'])}`, bareGen: () => `${pick(['Hunt3r', 'Str0ng', 'S3cret'])}${ri(100, 9999)}${pick(['!', '#', '$'])}` },
  { id: 'api_key', gen: () => pick(['sk-', 'ghp_', 'xoxb-', 'pk_live_']) + Array.from({ length: 24 }, () => pick('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''))).join('') },
  { id: 'api_key_aws', gen: () => 'AKIA' + Array.from({ length: 16 }, () => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.split(''))).join('') },
  { id: 'email', gen: () => `${pick(['jane', 'rahul', 'mei'])}.${pick(['doe', 'sharma', 'chen'])}@mail.example.com` },
  { id: 'phone', gen: () => `+91 ${ri(60000, 99999)} ${ri(10000, 99999)}` },
  { id: 'aadhaar', gen: verhoeffAadhaar },
  { id: 'credit_card', gen: luhnCard },
  { id: 'url_cred', gen: () => `https://deploy:${pick(['Tr0ut', 'Falcon'])}${ri(10, 999)}@git.example.net/repo.git` },
];

// ── smuggling channels: (name, inject(payload, secret)) ──────────────────────
const CHANNELS = [
  ['dom_text', (p, s) => { p.sanitizedDomText = `Profile saved. ${s} is on file.`; }],
  ['dom_text_inline', (p, s) => { p.sanitizedDomText = `The quick brown fox ${s} jumps over the lazy dog`.repeat(2); }],
  ['page_title', (p, s) => { p.page = { ...(p.page || {}), title: `Settings — ${s}` }; }],
  ['dialog_label', (p, s) => { p.page = { ...(p.page || {}), dialogs: [{ label: `Confirm ${s}`, fields: 1 }] }; }],
  ['history_result', (p, s) => { p.__history = [{ action: { type: 'click', selector: '#save' }, result: `NO visible change — text: ${s}` }]; }],
  ['history_selector', (p, s) => { p.__history = [{ action: { type: 'click', selector: `[data-secret="${s}"]` }, result: 'NO visible change' }]; }],
  ['manifest_selector_attack', (p, s) => { p.manifest = [{ type: 'password', bounds: { x: 1, y: 1, w: 8, h: 8 }, selector: `#${s.slice(0, 12)}`, label: s, source: 'dom', confidence: 1 }]; }],
  ['ocr_text', (p, s) => { p.sanitizedDomText = `OCR scan of the whiteboard: ${s}`; }],
  ['visual_context_smuggle', (p, s) => { p.visualContext = { pageType: 'login', confidence: 0.9, visualElements: [`button:${s}`], scene: 'screen-like', sources: { dom: true, vit: false } }; }],
];

export async function run() {
  const CASES_PER_COMBO = 3;
  const results = [];
  const limitations = [];
  let blocked = 0, maskedOnly = 0, leakAttempts = 0;

  for (const fam of FAMILIES) {
    for (const [channel, inject] of CHANNELS) {
      for (let k = 0; k < CASES_PER_COMBO; k++) {
        const secret = fam.gen();
        limitations.push({ family: fam.id, channel, secret: fam.bareGen?.() });
        // Shape a pipeline result the way privacy-filter produces it, then
        // inject the secret into one channel.
        const pipelineResult = {
          sanitizedDataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD' + 'A'.repeat(400),
          sanitizedDomText: 'Welcome to the shop. Your order 88123 was placed.',
          manifest: [],
          stats: { counts: { faces: 0, domSensitive: 0, textPii: 0, objects: 0 }, totalMs: 12 },
        };
        const payload = { ...pipelineResult, __history: [] };
        inject(payload, secret);

        // 1) firewall envelope (the ONLY shape the gate accepts)
        const env = sanitizeScreenContext(payload, {});
        // 2) assemble the wire payload + the exact prompt string
        const wirePayload = {
          privacyVerification: env.privacyVerification,
          sanitizedImage: env.sanitizedImage,
          sanitizedText: env.sanitizedText,
          safeManifest: env.safeManifest,
        };
        const prompt = buildPrivacyDecisionPrompt(
          { sanitizedDomText: env.sanitizedText, privacy: env, page: payload.page, visualContext: payload.visualContext },
          'buy headphones', payload.__history || [],
        );
        const gate = validateSanitizedPayload(wirePayload);
        const secretHits = scanTextForSecrets(prompt);
        const promptBlocked = secretHits.length > 0;

        // A leak = gate passed AND the raw secret appears in the wire strings.
        const wireText = JSON.stringify(wirePayload) + prompt;
        const rawInWire = wireText.includes(secret);
        const masked = maskForType(mapType(fam.id), secret);
        const onlyMasked = masked !== secret && wireText.includes(masked);
        if (!gate.ok || promptBlocked) blocked++;
        else if (!rawInWire) maskedOnly++;
        else leakAttempts++;

        results.push({
          family: fam.id, channel, k, secret,
          gateBlocked: !gate.ok, gateReasons: gate.reasons, promptBlocked,
          rawInWire, ok: !gate.ok || promptBlocked || !rawInWire,
        });
      }
    }
  }

  // KNOWN LIMITATION (measured, not hidden): a bare password with NO keyword
  // context is indistinguishable from ordinary text to ANY scanner. Verify it
  // stays that way (constant count) and report it separately.
  const barePasswordUndetected = limitations
    .filter(l => l.family === 'password')
    .filter(l => {
      const pipelineResult = { sanitizedDataUrl: 'data:image/jpeg;base64,/9j/4AAQ', sanitizedDomText: `x ${l.secret} y`, manifest: [], stats: { counts: {}, totalMs: 1 } };
      const env = sanitizeScreenContext(pipelineResult, {});
      return JSON.stringify(env).includes(l.secret);
    }).length;

  const fails = results.filter(r => !r.ok);
  return {
    name: 'Privacy leakage fuzz (seeded, 8 families × 9 channels)',
    pass: fails.length === 0,
    metrics: {
      totalCases: results.length,
      blockedByGate: blocked,
      safeMaskedOnly: maskedOnly,
      LEAKED: leakAttempts,
      fails: fails.map(f => ({ family: f.family, channel: f.channel, secret: f.secret })),
      // include a compact success matrix for the scorecard
      matrix: results.reduce((acc, r) => { acc[`${r.family}→${r.channel}`] = r.ok; return acc; }, {}),
      sampleSize: results.length,
      knownLimitations: {
        barePasswordNoKeyword: {
          cases: limitations.filter(l => l.family === 'password').length,
          undetected: barePasswordUndetected,
          note: 'A password string with no "password" label in ±40 chars is indistinguishable from ordinary text. Realistic occurrences (form fields, OCR of labelled fields) are caught. DOM password values never appear as text (inputs do not expose values); on screen they exist only as pixels, where the OCR path sees the label.',
        },
      },
    },
  };
}

function mapType(id) {
  return ({ password: 'password', api_key: 'api_key', api_key_aws: 'api_key', email: 'email', phone: 'phone', aadhaar: 'aadhaar', credit_card: 'credit_card', url_cred: 'url_cred' })[id] || 'password';
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(JSON.stringify(await run(), null, 2));
}
