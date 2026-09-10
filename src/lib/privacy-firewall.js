import { detectPiiInTextSync, sanitizeText as piiSanitizeText } from './pii-detector.js';
import { stripSmugglers } from './prompt-defense.js';
// ─────────────────────────────────────────────────────────────────────────────
// src/lib/privacy-firewall.js
// SIH PS 26171 — THE CENTRAL PRIVACY FIREWALL.
//
// ARCHITECTURAL INVARIANT (fail-closed):
//
//   raw screen ──► runPrivacyPipeline ──► sanitizeScreenContext ──► NETWORK GATE
//                                          (this module)              │
//                                                                     ▼
//                                                     validateSanitizedPayload()
//                                                     pass ──► send sanitized only
//                                                     fail ──► PrivacyBlockedError
//                                                              (never send raw)
//
// Every module that wants to put screen-derived context on the network MUST
// go through:
//   1. sanitizeScreenContext(...)   — wraps the privacy pipeline result in the
//      canonical firewall envelope { sanitizedImage, sanitizedText,
//      safeManifest, detections, privacyVerification, metadata }.
//   2. validateSanitizedPayload(p)  — pure predicate: is this payload provably
//      sanitized?  Returns { ok, reasons, checks }.
//   3. assertSafeForNetwork(p)      — same, but THROWS PrivacyBlockedError on
//      failure.  Callers convert the throw into a blocked/ask_user decision —
//      the system fails by losing functionality, NEVER by leaking pixels.
//
// Design rules (SIH brief):
//   • The manifest must not leak PII: raw CSS selectors, labels, IDs and raw
//     OCR/PII values are stripped here and replaced with safe normalized
//     identifiers (region_01, region_02, …).
//   • This module is PURE (no chrome.* APIs, no DOM) so the benchmark suite
//     can run it under plain Node.
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown when the network gate refuses a payload. NEVER carries raw data. */
export class PrivacyBlockedError extends Error {
  constructor(reasons, checks) {
    super(`Privacy firewall blocked the network request: ${reasons.join('; ')}`);
    this.name = 'PrivacyBlockedError';
    this.reasons = reasons.map(String);
    this.checks = checks || null;
    this.privacyBlocked = true;
  }
}

// ── Redaction action mapping (single source of truth for the manifest) ───────
const BLACKOUT_TYPES = new Set([
  'password', 'credit_card', 'aadhaar', 'pan', 'ssn', 'iban',
  'api_key', 'url_cred', 'otp', 'secret', 'sensitive_input', 'object',
]);
const PIXELATE_TYPES = new Set(['email', 'phone', 'dob', 'ip', 'person', 'org', 'address']);

export function redactionActionForType(type) {
  if (BLACKOUT_TYPES.has(type)) return 'blackout';
  if (PIXELATE_TYPES.has(type)) return 'pixelate';
  if (type === 'face') return 'blur';
  return 'blackout';
}

/**
 * Build a SAFE redaction manifest from raw pipeline regions.
 *
 * Stripped (must never reach the network):
 *   • selector / domPath (can contain user IDs, e.g. #user_ssn_input)
 *   • label / placeholder / aria-label (can contain personal data)
 *   • raw OCR/PII values
 * Kept (safe + useful to the VLM):
 *   • regionId  — stable, normalized (region_01…)
 *   • type      — detection class
 *   • bounds    — image-pixel rect (used for reasoning about layout only)
 *   • reason    — coarse detector source ('dom' | 'regex' | 'ner' | 'face' | 'yolo')
 *   • confidence, action
 *
 * @param {Array<{type,bounds,reason?,confidence?,selector?,label?}>} regions
 * @returns {Array<{regionId,type,bounds,reason,confidence,action}>}
 */
export function buildSafeManifest(regions = []) {
  return (regions || []).map((r, i) => ({
    regionId: `region_${String(i + 1).padStart(2, '0')}`,
    type: String(r.type || 'unknown'),
    bounds: normalizeBounds(r.bounds),
    reason: String(r.reason || r.source || 'detector'),
    confidence: clamp01(Number(r.confidence ?? 0.9)),
    action: redactionActionForType(r.type),
  }));
}

/**
 * Produce the canonical firewall envelope around a privacy-pipeline result.
 * The ONLY shape the network layer is allowed to transmit.
 *
 * @param {object} pipelineResult   output of runPrivacyPipeline()
 * @param {object} meta             { pageUrl, pageTitle, step, fingerprint, sanitized: true }
 */
export function sanitizeScreenContext(pipelineResult, meta = {}) {
  // Final-boundary sweep: even if an upstream detector missed something, the
  // envelope's text is re-masked here before it can ever be validated.
  // v1.14: ALSO strip invisible/bidi/control smugglers at the wire boundary —
  // zero-width and bidi-override characters must never cross the network
  // inside text that a remote fence will wrap (adversarial browser benchmark).
  pipelineResult = { ...pipelineResult, sanitizedDomText: stripSmugglers(finalPiiSweepText(pipelineResult?.sanitizedDomText)) };
  const regions = [
    ...(pipelineResult.manifest || []),
  ];
  const safeManifest = buildSafeManifest(regions);
  const counts = countBy(regions, r => r.type);

  const checks = {
    pipelineRan: Boolean(pipelineResult && typeof pipelineResult.sanitizedDataUrl === 'string'),
    imagePresent: Boolean(pipelineResult?.sanitizedDataUrl),
    // A redaction crash is tolerated ONLY when the pipeline substituted the
    // structurally-empty blank image (fail-closed degradation — the fallback
    // frame contains zero user pixels). Otherwise this is a hard fail.
    redactionOk: !pipelineResult?.stats?.redactionFailed || pipelineResult?.stats?.safeFallback === 'blank',
    manifestSafe: true, // buildSafeManifest strips raw identifiers by construction
    textSanitized: typeof pipelineResult?.sanitizedDomText === 'string',
    // v1.13 OCR FAILURE POLICY (fail-closed): when the user enabled the
    // visual-PII OCR pass and the engine was unavailable, the frame carries
    // NO visual-PII coverage. Silence would be a privacy gap — verification
    // REFUSES, and the network gate blocks the transmission.
    visualPiiCoverageOk: !pipelineResult?.stats?.ocrFailed,
  };
  const passed = Object.values(checks).every(Boolean);
  if (pipelineResult?.stats?.ocrFailed) {
    console.warn('[PrivacyFirewall] OCR was enabled but unavailable — visual-PII coverage missing. '
      + 'FAIL-CLOSED: this frame will not be transmitted. Reason:', pipelineResult?.stats?.ocrFailedReason);
  }

  return {
    sanitizedImage: pipelineResult?.sanitizedDataUrl || '',
    sanitizedText: pipelineResult?.sanitizedDomText || '',
    safeManifest,
    detections: {
      faces: pipelineResult?.stats?.counts?.faces ?? 0,
      domSensitive: pipelineResult?.stats?.counts?.domSensitive ?? 0,
      objects: pipelineResult?.stats?.counts?.objects ?? 0,
      textPii: pipelineResult?.stats?.counts?.textPii ?? 0,
      byType: counts,
    },
    privacyVerification: {
      enforced: true,
      passed,
      checks,
      firewallVersion: FIREWALL_VERSION,
    },
    metadata: {
      ...meta,
      manifestSize: safeManifest.length,
      pipelineMs: pipelineResult?.stats?.totalMs ?? 0,
      generatedAt: Date.now(),
    },
  };
}

// ── High-signal secret patterns used as the LAST-LINE text sweep ─────────────
// These have very few false positives; if any appears in text that is about to
// leave the browser, the gate blocks the request. (Defence in depth — the PII
// pipeline should have caught them earlier.)
const SECRET_TEXT_SWEEP = [
  { id: 'api_key_snowflake', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { id: 'api_key_aws', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'api_key_github', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { id: 'api_key_slack', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'api_key_google', re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { id: 'url_credentials', re: /\bhttps?:\/\/[^\s/:@]+:[^\s/:@]+@[^\s/]+/ },
  // Assignment rules require a secret-LIKE value (contains a digit, or is a
  // quoted string) so prose such as "Password: required" never trips the gate.
  // The separator accepts "password = x", "password: x" AND the natural
  // language form "password Hunt3r2Str0ng".
  // v1.15.8 — the digit/letter lookaheads are BOUNDED TO THE VALUE RUN. The
  // old (?=.*\d) anchored at the value but scanned to END OF STRING, so in
  // any multi-sentence text (one line to a regex) "password required … Room
  // 42" tripped — the same field class that black-boxed "token formats" /
  // "secret families:" / "key contiguity," on the chat.z.ai page report. A
  // digit must now sit INSIDE the candidate value; every real assignment
  // still matches (re-proven by fuzz 216 + security suite + v1158 TP set).
  { id: 'password_assignment', re: /\b(?:password|passwd|pwd|pass)\s*(?:[:=]\s*|\s+)(?:['"][^'"]{4,}['"]|(?=[^\s'"]*\d)[^\s'"]{5,})/i },
  { id: 'token_assignment', re: /\b(?:token|secret|api[-_]?key)\s*[:=]\s*(?:['"][^'"]{4,}['"]|(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{6,})/i },
  { id: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/ },
];

/**
 * THE NETWORK PRIVACY GATE (pure predicate).
 *
 * A payload may only reach the network when ALL checks pass:
 *   1. sanitized flag        — envelope says the firewall enforced itself
 *   2. verification passed   — every pipeline stage check passed
 *   3. raw screenshot absent — no raw-size image smuggled into any field
 *   4. raw DOM absent        — no RAW-DOM marker / unsanitized fence
 *   5. manifest valid        — array of {regionId,type,bounds} only
 *   6. secret text absent    — last-line regex sweep of all string fields
 *
 * @param {object} payload  the envelope from sanitizeScreenContext() plus any
 *                          extra fields the caller intends to send (task,
 *                          history, …). Everything reachable is scanned.
 * @returns {{ ok: boolean, reasons: string[], checks: Record<string,boolean> }}
 */
export function validateSanitizedPayload(payload) {
  const checks = {};
  const reasons = [];

  // 1) Sanitized flag + verification
  const pv = payload?.privacyVerification;
  checks.sanitizedFlag = Boolean(pv?.enforced);
  checks.verificationPassed = pv?.passed === true;
  if (!checks.sanitizedFlag) reasons.push('payload is not marked as firewall-sanitized (privacyVerification.enforced)');
  if (!checks.verificationPassed) reasons.push('privacy verification did not pass all pipeline checks');

  // 2) Sanitized image present and plausibly not the RAW capture:
  //    the firewall always ships a JPEG/PNG data URL; a raw capture would have
  //    bypassed the pipeline entirely and carries no verification envelope.
  const img = typeof payload?.sanitizedImage === 'string' ? payload.sanitizedImage : '';
  checks.imagePresent = Boolean(img);
  if (!checks.imagePresent) reasons.push('sanitized image missing (fail-closed: nothing to send)');

  // 3) No raw image / raw capture smuggled into any field OTHER THAN the
  //    sanitized image itself (which is legitimately a data URL and can be
  //    large — it must not trip the oversized-image detector).
  const withoutImage = { ...payload, sanitizedImage: undefined };
  checks.noRawImageString = !deepScanStrings(withoutImage, (s) =>
    /data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]{20000,}/.test(s));
  if (!checks.noRawImageString) reasons.push('base64 image found outside the sanitized image field');

  // 4) No raw-DOM markers
  checks.noRawDomMarkers = !deepScanStrings(withoutImage, (s) =>
    /RAW[-_ ]?DOM[-_ ]?(SNAPSHOT|TEXT)|unsanitized/i.test(s));
  if (!checks.noRawDomMarkers) reasons.push('raw DOM marker detected in payload');

  // 5) Manifest must be an array of safe shapes only
  const mf = payload?.safeManifest;
  checks.manifestValid = Array.isArray(mf) && mf.every(isSafeManifestEntry);
  if (!checks.manifestValid) reasons.push('redaction manifest missing or contains unsafe fields (selector/label/raw values)');

  // 6) Last-line secret sweep over every string EXCEPT the image (base64 can
  //    not contain spaces/colons, but is still excluded for correctness).
  const leaked = deepScanStrings(withoutImage, (s) => SECRET_TEXT_SWEEP.some(p => p.re.test(s)));
  checks.noSecretText = !leaked;
  if (leaked) reasons.push('secret-shaped text (API key / credentials / password assignment) survived sanitization');

  const ok = Object.values(checks).every(Boolean);
  return { ok, reasons, checks };
}

/**
 * SIH v1.13 — FINAL-BOUNDARY PII SWEEP (defence in depth).
 *
 * The upstream pipeline masks PII in DOM text, but the fuzz suite proved a
 * detector miss upstream becomes a network leak downstream. This sweep runs
 * the same regex+validator+context engine (NO NER — cheap, deterministic) one
 * last time on every string that is about to be embedded in a network payload
 * or a VLM prompt, masking whatever it finds with [REDACTED:<type>] markers.
 *
 * Known limitation (documented, not hidden): a context-FREE secret — e.g. the
 * bare string of a password with no "password" label nearby — is
 * indistinguishable from ordinary text. Realistic occurrences carry labels
 * (form fields, OCR of "Password: …"), which the keyword context catches.
 */
export function finalPiiSweepText(text) {
  if (typeof text !== 'string' || !text) return text || '';
  const findings = detectPiiInTextSync(text, { maxChars: 16000 });
  return findings.length ? piiSanitizeText(text, findings) : text;
}

/** Scan one free-form string for secret-shaped content. Returns the ids of the patterns that matched.
 * Used as a second gate: the prompt is what actually hits the wire, so the
 * final string — not just the envelope — must be clean.
 */
export function scanTextForSecrets(text) {
  if (typeof text !== 'string' || !text) return [];
  return SECRET_TEXT_SWEEP.filter(p => p.re.test(text)).map(p => p.id);
}

// ── v1.15.7 REDACT-AND-VERIFY last-line sweep ────────────────────────────────
// Field report (v1.15.6): a "Summarize this page" privacy run BLOCKED at the
// gate because the outbound text carried a secret-shaped fragment. Blocking
// there loses the WHOLE task on any page that merely displays a key-shaped
// string (API docs, config viewers, chats about keys). The privacy-correct
// behavior is the one the rest of the pipeline already applies to faces and
// PII pixels: MASK the fragment locally, RE-VERIFY, and ship only provably
// clean text. Fail-closed is preserved — if anything still trips the sweep
// after masking, the caller must refuse to transmit exactly as before.
// The marker is itself sweep-inert (verified against all 9 patterns: no
// separator/value shape can re-form around it).
const SECRET_MARKER = '[REDACTED:secret]';

/**
 * Replace every secret-shaped fragment in `text` with [REDACTED:secret].
 * Pure. Returns { text, masked, residual }:
 *   masked   — [{ id, count }] per sweep pattern (ids only, never values)
 *   residual — pattern ids that STILL match after masking (fail-closed
 *              signal: the caller must NOT transmit this text)
 */
export function maskSecretShapedText(text) {
  if (typeof text !== 'string' || !text) return { text: text || '', masked: [], residual: [] };
  let out = text;
  const masked = [];
  for (const p of SECRET_TEXT_SWEEP) {
    const g = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`);
    let hits = 0;
    out = out.replace(g, () => { hits += 1; return SECRET_MARKER; });
    if (hits) masked.push({ id: p.id, count: hits });
  }
  const residual = scanTextForSecrets(out);
  return { text: out, masked, residual };
}

/**
 * Gate + throw. Convert into a blocked decision at the call site:
 *
 *   try { assertSafeForNetwork(payload); send(payload); }
 *   catch (e) { if (e instanceof PrivacyBlockedError) return blockedPlan(e); throw e; }
 */
export function assertSafeForNetwork(payload) {
  const { ok, reasons, checks } = validateSanitizedPayload(payload);
  if (!ok) throw new PrivacyBlockedError(reasons, checks);
  return true;
}

/** Human-readable status block for the SIH Privacy Inspector UI. */
export function firewallStatusForInspector(envelope, payloadBytes = 0) {
  const det = envelope?.detections || {};
  const pv = envelope?.privacyVerification || {};
  return {
    active: Boolean(pv.enforced),
    rawTransmitted: false,               // structurally impossible through this gate
    sanitizedTransmitted: Boolean(pv.passed),
    faces: det.faces || 0,
    piiRegions: (det.domSensitive || 0) + (det.textPii || 0),
    secrets: (det.byType?.password || 0) + (det.byType?.api_key || 0) + (det.byType?.credit_card || 0),
    byType: det.byType || {},
    clientMs: envelope?.metadata?.pipelineMs || 0,
    payloadKb: Math.round((payloadBytes || 0) / 1024),
    verification: pv.passed ? 'PASSED' : 'BLOCKED',
    firewallVersion: pv.firewallVersion || FIREWALL_VERSION,
  };
}

export const FIREWALL_VERSION = '1.0.0';

// ── internals ────────────────────────────────────────────────────────────────
function normalizeBounds(b) {
  const n = (v) => Math.max(0, Math.round(Number(v) || 0));
  return { x: n(b?.x), y: n(b?.y), w: n(b?.w), h: n(b?.h) };
}
function clamp01(v) { return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.9)); }
function countBy(arr, fn) {
  const out = {};
  for (const it of arr) { const k = fn(it); out[k] = (out[k] || 0) + 1; }
  return out;
}
/** Manifest entries may carry ONLY the safe keys — no selector/label/raw. */
function isSafeManifestEntry(e) {
  if (!e || typeof e !== 'object') return false;
  if (typeof e.regionId !== 'string' || !/^region_\d+$/.test(e.regionId)) return false;
  if (typeof e.type !== 'string') return false;
  const b = e.bounds;
  if (!b || typeof b !== 'object' ||
      !['x', 'y', 'w', 'h'].every(k => Number.isFinite(b[k]))) return false;
  // forbidden keys
  if ('selector' in e || 'label' in e || 'raw' in e || 'value' in e || 'ocrText' in e) return false;
  return true;
}
/** Depth-first scan of every string value inside a payload object. */
function deepScanStrings(node, test) {
  if (typeof node === 'string') return test(node);
  if (Array.isArray(node)) return node.some(n => deepScanStrings(n, test));
  if (node && typeof node === 'object') {
    return Object.values(node).some(n => deepScanStrings(n, test));
  }
  return false;
}
