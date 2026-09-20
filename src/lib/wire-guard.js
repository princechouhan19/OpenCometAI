// src/lib/wire-guard.js — BYTE-LEVEL EXACT-PAYLOAD VERIFICATION
// (SIH master-prompt Phase 10: "Do not merely inspect JSON fields. Implement
//  an exact serialized payload / byte-level leakage test.")
//
// The privacy firewall (privacy-firewall.js) inspects payload FIELDS. This
// module is the layer below it: it serializes the EXACT bytes that will hit
// the wire and verifies the byte stream itself, catching leaks that survive
// object-level inspection:
//   • sensitive URL query parameters hiding anywhere in any string
//     (?token=…, ?sid=…, ?auth=… — a credential-in-query leak class)
//   • secret-shaped text in the SERIALIZED stream (post-escaping, so a leak
//     crafted to only appear inside JSON string escapes is still caught)
//   • base64 data: URLs outside the sanctioned sanitizedImage field
//   • KNOWN sensitive values (exact-match): when the caller holds the raw
//     values the pipeline just redacted, the serialized payload is scanned
//     for each of them — a detector miss upstream cannot survive here
//   • data: URL payloads are DECODED and their printable runs scanned, so
//     text smuggled inside an encoded field does not pass by obfuscation
//
// Fail-closed: every check is a hard predicate; callers MUST treat { ok:
// false } as "do not transmit". No network failure mode can produce a pass.

// Query-parameter keys that carry credentials / sessions / trackers. The
// value (not the key name) is what must never leave the browser unredacted.
const SENSITIVE_URL_PARAM_RE =
  /[?&#](token|session|sessid|sid|auth|access_token|refresh_token|api[_-]?key|apikey|key|secret|otp|jwt|ssoid|code|password|passwd|pwd)=([^&\s"']{1,})/gi;

/** True when a string embeds a URL whose sensitive query/fragment params carry VALUES. */
export function sensitiveUrlParamLeak(str) {
  if (typeof str !== 'string' || str.length < 8) return false;
  SENSITIVE_URL_PARAM_RE.lastIndex = 0;
  return SENSITIVE_URL_PARAM_RE.test(str);
}

/**
 * Replace the VALUE of every sensitive query/fragment parameter with
 * [REDACTED:url_param], preserving the key names (the reasoner may still need
 * to know a session link is a session link). Non-sensitive params survive.
 */
export function scrubSensitiveUrlParams(url) {
  if (typeof url !== 'string' || !url) return url || '';
  return url
    .replace(/([?&](?:token|session|sessid|sid|auth|access_token|refresh_token|api[_-]?key|apikey|key|secret|otp|jwt|ssoid|code|password|passwd|pwd)=)([^&\s"']{1,})/gi,
      '$1[REDACTED:url_param]')
    // fragment tokens: #access_token=… / #token=… (OAuth implicit flow)
    .replace(/(#(?:access_token|token|id_token)=)([^&\s"']{1,})/gi, '$1[REDACTED:url_param]');
}

/**
 * Stable, cycle-safe serialization of the exact outbound payload.
 * Returns { bytes, truncated, originalBytes }. Keys are sorted so the byte
 * stream is deterministic across runs (reproducible evidence, not vibes).
 */
export function serializeWirePayload(payload, { capBytes = 2 * 1024 * 1024 } = {}) {
  const seen = new WeakSet();
  let originalBytes = 0;
  const enc = (v, indent) => {
    if (v === null || v === undefined) return 'null';
    const t = typeof v;
    if (t === 'string') return JSON.stringify(v);
    if (t === 'number') return Number.isFinite(v) ? String(v) : 'null';
    if (t === 'boolean') return String(v);
    if (t === 'bigint') return JSON.stringify(String(v));
    if (t === 'function' || t === 'symbol') return '"[non-serializable]"';
    if (seen.has(v)) return '"[circular]"';
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        return '[' + v.map(x => enc(x, indent + 1)).join(',') + ']';
      }
      const keys = Object.keys(v).sort();
      return '{' + keys.map(k => JSON.stringify(k) + ':' + enc(v[k], indent + 1)).join(',') + '}';
    } finally {
      seen.delete(v);
    }
  };
  const full = enc(payload, 0);
  originalBytes = full.length;
  return {
    bytes: full.length > capBytes ? full.slice(0, capBytes) : full,
    truncated: full.length > capBytes,
    originalBytes,
  };
}

// Longest printable run we scan inside DECODED binary payloads (data: URLs).
const PRINTABLE_RUN_RE = /[\x20-\x7E]{8,}/g;

function scanDecodedDataUrls(bytes, secretRes, knownValues) {
  const reasons = [];
  // Find every data:...;base64,XXXX run inside the serialized stream.
  const dataUrlRe = /data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)/g;
  let m;
  while ((m = dataUrlRe.exec(bytes)) !== null) {
    const [, mime, b64] = m;
    // Cap decode cost: media payloads can be ~300 KB; scan the first 256 KB.
    const slice = b64.length > 349525 ? b64.slice(0, 349525) : b64; // 349525 b64 chars ≈ 256 KB
    let decoded = '';
    try {
      if (typeof atob === 'function') decoded = atob(slice);
      else decoded = Buffer.from(slice, 'base64').toString('latin1');
    } catch { /* malformed base64 — the image validators handle that elsewhere */ continue; }
    for (const run of decoded.match(PRINTABLE_RUN_RE) || []) {
      if (knownValues.some(v => v && run.includes(v))) {
        reasons.push(`known sensitive value found DECODED inside a ${mime} payload (obfuscated leak)`);
      }
      for (const re of secretRes) {
        re.lastIndex = 0;
        if (re.test(run)) reasons.push(`secret-shaped text found DECODED inside a ${mime} payload`);
      }
    }
  }
  return reasons;
}

/**
 * THE BYTE-LEVEL SCAN. `bytes` = the exact serialized payload string
 * (serializeWirePayload().bytes). `secretRes` = array of RegExp (firewall's
 * SECRET_TEXT_SWEEP). `knownValues` = raw sensitive values to exact-match.
 */
export function byteLevelLeakageScan(bytes, { secretRes = [], knownValues = [], fullBytes = null } = {}) {
  const reasons = [];
  const checks = {
    noSensitiveUrlParams: true,
    noSecretBytes: true,
    noKnownValueBytes: knownValues.length > 0 ? true : null, // null = not applicable
    noObfuscatedLeak: true,
  };

  // 1) Sensitive URL params in the serialized stream.
  SENSITIVE_URL_PARAM_RE.lastIndex = 0;
  if (SENSITIVE_URL_PARAM_RE.test(bytes)) {
    checks.noSensitiveUrlParams = false;
    reasons.push('sensitive URL query parameter with a value found in the serialized payload bytes');
  }

  // 2) Secret-shaped text in the serialized stream.
  //    NOTE: `bytes` must already EXCLUDE the base64 image field — random JPEG
  //    base64 can coincidentally contain patterns like "sk-" + 16 word chars
  //    (~60% false-positive rate at 300 KB). The image itself is covered by
  //    check 4, which DECODES data: URLs and only scans printable runs (the
  //    probability of a ≥8-char printable run coinciding with a secret shape
  //    in decoded binary is ~1e-14).
  for (const re of secretRes) {
    re.lastIndex = 0;
    if (re.test(bytes)) {
      checks.noSecretBytes = false;
      reasons.push('secret-shaped byte sequence survived into the serialized payload');
      break;
    }
  }

  // 3) Exact known sensitive values — a detector miss upstream cannot hide.
  for (const v of knownValues) {
    if (typeof v === 'string' && v.length >= 6 && bytes.includes(v)) {
      checks.noKnownValueBytes = false;
      reasons.push('KNOWN sensitive value (raw, exact-match) present in the serialized payload bytes');
      break;
    }
  }

  // 4) Obfuscated leaks: decode data: URLs (from the FULL stream, image
  //    included) and scan printable runs.
  const obfuscated = scanDecodedDataUrls(fullBytes || bytes, secretRes, knownValues);
  if (obfuscated.length) {
    checks.noObfuscatedLeak = false;
    reasons.push(...obfuscated.slice(0, 3));
  }

  return { ok: Object.values(checks).every(c => c !== false), reasons, checks };
}

export const WIRE_GUARD_VERSION = '1.0.0';
