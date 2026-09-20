// server/validate.js — INBOUND VALIDATION for /agent/decide.
//
// The companion server previously trusted almost every client field: any
// manifest shape, any settings object, any history size, no MIME checks and
// no requirement that the payload ever passed the extension's privacy
// firewall. This module rejects malformed / unsafe payloads BEFORE any model
// call. The server must not blindly trust arbitrary client fields — and it
// must never become the weak link that an accidental raw-image bypass flows
// through.
//
// Fail-closed posture: /agent/decide requires a privacyVerification envelope
// with enforced=true AND passed=true. Set OPENCOMET_ACCEPT_UNVERIFIED=1 ONLY
// for local diagnostics — the log then carries a permanent warning.
//
// PURE module (no express imports) so the benchmark suite exercises the exact
// validation the server runs.

export const LIMITS = {
  taskMaxChars: 4000,
  sanitizedTextMaxChars: 12000,
  manifestMaxEntries: 200,
  historyMaxEntries: 50,
  historyEntryMaxChars: 2000,
  imageMaxBytes: 16 * 1024 * 1024,
};

const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg']);

const SETTINGS_ALLOWLIST = new Set([
  'provider', 'model', 'providerBaseUrl', 'apiKey', 'ollamaBaseUrl',
]);
// provider values the server knows how to route (mirrors detectBackend)
const KNOWN_PROVIDERS = new Set([
  'openai', 'anthropic', 'gemini', 'ollama', 'mistral', 'groq',
  'deepseek', 'kimi', 'glm', 'custom',
]);

/** Magic-byte sniffing — client-declared MIME is not trusted. */
export function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  return null;
}

function isSafeManifestEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  if (typeof e.regionId !== 'string' || !/^region_\d+$/.test(e.regionId)) return false;
  if (typeof e.type !== 'string' || e.type.length > 40) return false;
  const b = e.bounds;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
  if (!['x', 'y', 'w', 'h'].every(k => Number.isFinite(b[k]))) return false;
  if (b.x < 0 || b.y < 0 || b.w < 0 || b.h < 0) return false;
  // forbidden keys — raw identifiers / values must never reach the model
  if ('selector' in e || 'label' in e || 'raw' in e || 'value' in e || 'ocrText' in e) return false;
  return true;
}

/**
 * Validate the multipart/JSON fields of /agent/decide.
 * @param {object} input
 *   { task, sanitizedText, manifest, history, settings, imageBuffer, imageMime, privacyVerification }
 * @returns {{ ok: boolean, reasons: string[], settings: object }}
 *   settings = the CLEANED allow-listed settings object to use downstream.
 */
export function validateInboundRequest(input = {}) {
  const reasons = [];

  // required fields
  const task = typeof input.task === 'string' ? input.task.trim() : '';
  if (!task) reasons.push('missing required field: task');
  if (task.length > LIMITS.taskMaxChars) reasons.push(`task exceeds ${LIMITS.taskMaxChars} chars`);

  // image: present, allowed type (magic bytes, not the declared MIME),
  //    sane size ──────────────────────────────────────────────────────────────
  const buf = input.imageBuffer;
  if (!buf || !buf.length) {
    reasons.push('missing required field: image');
  } else {
    if (buf.length > LIMITS.imageMaxBytes) reasons.push(`image exceeds ${Math.round(LIMITS.imageMaxBytes / 1048576)}MB`);
    const sniffed = sniffImageMime(buf);
    if (!sniffed) reasons.push('image is not a PNG/JPEG (magic-byte check failed)');
    if (input.imageMime && !ALLOWED_IMAGE_MIME.has(String(input.imageMime))) {
      reasons.push(`image MIME ${input.imageMime} not allowed`);
    }
  }

  // sanitizedText
  if (input.sanitizedText != null) {
    if (typeof input.sanitizedText !== 'string') reasons.push('sanitizedText must be a string');
    else if (input.sanitizedText.length > LIMITS.sanitizedTextMaxChars) reasons.push(`sanitizedText exceeds ${LIMITS.sanitizedTextMaxChars} chars`);
  }

  // manifest: array of safe shapes only
  let manifest = input.manifest;
  if (typeof manifest === 'string') {
    try { manifest = JSON.parse(manifest); } catch { manifest = { __parseError: true }; }
  }
  if (manifest !== undefined && manifest !== null) {
    if (!Array.isArray(manifest)) reasons.push('manifest must be a JSON array');
    else {
      if (manifest.length > LIMITS.manifestMaxEntries) reasons.push(`manifest exceeds ${LIMITS.manifestMaxEntries} entries`);
      const bad = manifest.findIndex(e => !isSafeManifestEntry(e));
      if (bad >= 0) reasons.push(`manifest entry ${bad} is unsafe or malformed (selector/label/raw values are forbidden; regionId/type/bounds required)`);
    }
  }

  // privacyVerification: the firewall envelope is REQUIRED (fail-closed)
  const pv = input.privacyVerification;
  const requireVerified = process.env.OPENCOMET_ACCEPT_UNVERIFIED !== '1';
  if (requireVerified) {
    if (!pv || typeof pv !== 'object') {
      reasons.push('missing privacyVerification envelope — the server only accepts payloads the extension privacy firewall verified');
    } else {
      if (pv.enforced !== true) reasons.push('privacyVerification.enforced must be true');
      if (pv.passed !== true) reasons.push('privacyVerification.passed must be true (the pipeline did not verify — refusing)');
    }
  } else if (pv && pv.enforced === true && pv.passed !== true) {
    // even in diagnostics mode a FAILED verification is never accepted
    reasons.push('privacyVerification.passed is false — refusing (OPENCOMET_ACCEPT_UNVERIFIED only relaxes ABSENCE)');
  }

  // history
  let history = input.history;
  if (typeof history === 'string') {
    try { history = JSON.parse(history); } catch { history = { __parseError: true }; }
  }
  if (history !== undefined && history !== null) {
    if (!Array.isArray(history)) reasons.push('history must be a JSON array');
    else {
      if (history.length > LIMITS.historyMaxEntries) reasons.push(`history exceeds ${LIMITS.historyMaxEntries} entries`);
      const tooBig = history.findIndex(h => h != null && typeof h === 'object'
        && JSON.stringify(h).length > LIMITS.historyEntryMaxChars);
      if (tooBig >= 0) reasons.push(`history entry ${tooBig} exceeds ${LIMITS.historyEntryMaxChars} chars`);
    }
  }

  // settings allowlist
  let settings = input.settings;
  if (typeof settings === 'string') {
    try { settings = JSON.parse(settings); } catch { settings = { __parseError: true }; }
  }
  let cleanSettings = {};
  if (settings !== undefined && settings !== null) {
    if (typeof settings !== 'object' || Array.isArray(settings)) {
      reasons.push('settings must be a JSON object');
    } else {
      if ('__parseError' in settings) reasons.push('settings is not valid JSON');
      else {
        for (const k of Object.keys(settings)) {
          if (!SETTINGS_ALLOWLIST.has(k)) continue; // silently strip unknown keys
          const v = settings[k];
          if (v != null && typeof v !== 'string' && typeof v !== 'number') {
            reasons.push(`settings.${k} must be a string or number`);
            continue;
          }
          cleanSettings[k] = v;
        }
        if (cleanSettings.provider != null && !KNOWN_PROVIDERS.has(String(cleanSettings.provider).toLowerCase())) {
          reasons.push(`settings.provider '${cleanSettings.provider}' is not a known backend`);
        }
      }
    }
  }

  return { ok: reasons.length === 0, reasons, settings: cleanSettings };
}
