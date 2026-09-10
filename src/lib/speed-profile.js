// ─────────────────────────────────────────────────────────────────────────────
// src/lib/speed-profile.js
// v1.10.0 — GENERALIZED (provider-agnostic) VLM speed solution.
//
// The v1.9.0 speed package was tuned against one provider (kimi-k3 via a
// custom gateway). This module turns every latency lever into a single
// "speed profile" that works identically on ANY OpenAI-compatible endpoint
// (OpenAI, OpenRouter, Moonshot/Kimi, DeepSeek, GLM, Qwen/DashScope,
// Together, Groq, vLLM, Ollama, …) and on the on-device path.
//
// Three profiles — fast / balanced / quality — scale ALL knobs together:
//   imageEdge      longest side of the screenshot sent to the VLM (px)
//                  (fewer pixels → fewer vision tokens → faster prefill,
//                   the API-side equivalent of FastV/PyramidDrop token pruning)
//   imageQuality   JPEG quality 0..1 (upload bytes, matters on home uplink)
//   domTextCap     sanitized DOM text characters in the prompt
//   keepFullHistory full-detail history entries; older ones collapse to one
//                  line (constant-size prompt → provider prompt-cache hits)
//   maxTokens      decision-turn output cap (output tokens = TPOT × n)
//   reasoningEffort default effort hint mapped per provider by
//                  providers.buildReasoningParam (null → send nothing)
//   manifestCap    redaction-manifest lines in the prompt
//   reuseShot      when the page fingerprint is unchanged since the previous
//                  capture, REUSE the previous screenshot instead of
//                  re-capturing + re-sanitizing + re-uploading (the
//                  browser-use "screenshots only when needed" lever)
//   reuseMaxAgeMs  never reuse a shot older than this
//   reuseMaxStreak max consecutive reuses before a fresh shot is forced
//
// Pure, dependency-free (no Chrome APIs, no imports) — safe for the SW, the
// offscreen document, and Node unit tests.
// ─────────────────────────────────────────────────────────────────────────────

export const SPEED_PROFILES = {
  fast: {
    name: 'fast',
    imageEdge: 896,
    imageQuality: 0.8,
    domTextCap: 2200,
    keepFullHistory: 2,
    maxTokens: 600,
    reasoningEffort: 'low',
    manifestCap: 20,
    reuseShot: true,
    reuseMaxAgeMs: 45000,
    reuseMaxStreak: 3,
  },
  balanced: {
    name: 'balanced',
    imageEdge: 1280,
    imageQuality: 0.85,
    domTextCap: 3500,
    keepFullHistory: 3,
    maxTokens: 800,
    reasoningEffort: 'low',
    manifestCap: 40,
    reuseShot: true,
    reuseMaxAgeMs: 60000,
    reuseMaxStreak: 2,
  },
  quality: {
    name: 'quality',
    imageEdge: 1536,
    imageQuality: 0.9,
    domTextCap: 6000,
    keepFullHistory: 5,
    maxTokens: 1400,
    reasoningEffort: 'medium',
    manifestCap: 60,
    reuseShot: false,   // fine-detail runs always want a fresh shot
    reuseMaxAgeMs: 0,
    reuseMaxStreak: 0,
  },
};

/**
 * Merge user settings into concrete speed knobs.
 *
 * Precedence:
 *   • settings.vlmSpeedProfile selects the profile ('fast'|'balanced'|'quality';
 *     unknown/missing → 'balanced').
 *   • settings.vlmMaxTokens > 64 overrides the profile's maxTokens
 *     (0/undefined → follow the profile).
 *   • settings.vlmReasoningEffort: undefined → profile default; '' → null
 *     (do NOT send any reasoning param — for strict/plain endpoints);
 *     'low'|'medium'|'high' → used as-is.
 *
 * @param {object} settings  provider settings (any subset)
 * @returns {object} profile knobs + { profile, maxTokens, reasoningEffort }
 */
export function resolveSpeedSettings(settings = {}) {
  const key = String(settings.vlmSpeedProfile || '').toLowerCase();
  const prof = SPEED_PROFILES[key] || SPEED_PROFILES.balanced;
  const explicitTokens = Number(settings.vlmMaxTokens);
  const effort = settings.vlmReasoningEffort === undefined
    ? prof.reasoningEffort
    : String(settings.vlmReasoningEffort || '').toLowerCase();
  return {
    ...prof,
    profile: prof.name,   // convenience: the resolved profile name
    maxTokens: explicitTokens > 64
      ? Math.min(8000, Math.round(explicitTokens))
      : prof.maxTokens,
    reasoningEffort: effort || null,   // '' → null → buildReasoningParam sends nothing
  };
}

/**
 * Decide whether the previous screenshot can be REUSED for this step.
 *
 * A reuse skips capture + sanitize + upload entirely AND keeps the prompt
 * byte-identical (image included), which maximizes provider automatic
 * prompt/KV-cache hits. Safety rails:
 *   • any PLAYING video → always fresh (motion never shows in a fingerprint)
 *   • privacy mode toggled since the cached shot → fresh
 *   • age / consecutive-reuse caps from the profile
 *
 * @param {object} p
 * @param {object|null} p.last          { fingerprint, modeKey, ts, streak } | null
 * @param {string}      p.fingerprint   current page fingerprint
 * @param {object}      p.profile       resolved speed profile
 * @param {number}      p.now           Date.now()
 * @param {boolean}     p.videosPlaying any <video> currently playing
 * @param {string}      p.modeKey       'on' | 'off' (privacy mode)
 * @returns {boolean}
 */
export function shouldReuseShot({ last = null, fingerprint = '', profile, now = Date.now(), videosPlaying = false, modeKey = '' }) {
  if (!profile?.reuseShot) return false;
  if (!last || !last.fingerprint || !last.modeKey) return false;
  if (fingerprint !== last.fingerprint) return false;
  if (modeKey !== last.modeKey) return false;
  if (videosPlaying) return false;
  if (!Number.isFinite(last.ts) || (now - last.ts) > profile.reuseMaxAgeMs) return false;
  if ((last.streak || 0) >= profile.reuseMaxStreak) return false;
  return true;
}

/** Tiny deterministic string hash (djb2, base36) — fingerprint helper. */
export function hashStr(s = '') {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Page-change fingerprint for shot reuse. Covers everything the DOM can
 * see cheaply: url, title, scroll position, media element states, and a
 * length+hash of the visible text. Query strings are never included
 * (page.url is already origin+pathname from pageMediaProbe).
 *
 * v1.11: DIALOGS + FOCUS + EDITABLE census. Field log: Gmail compose expands
 * its recipients row ("Recipients" → "To Cc Bcc") with zero movement in the
 * old fingerprint (url/title/scroll/media/text-hash all unchanged — the
 * compose text sits beyond the 4000-node walk on a 20k-row inbox), so STALE
 * screenshots were reused while the To <input> didn't exist. Dialog
 * labels/field counts and focus are now part of the fingerprint, so any
 * in-dialog state change invalidates the cached shot.
 *
 * @param {object} p
 * @param {object} p.page     { url, title, videos:[{paused,muted,area}], audios,
 *                              dialogs?, editables?, focused? }
 * @param {string} p.domText  sanitized page text
 * @param {number} p.scrollY  window.scrollY from the probe
 * @returns {string}
 */
export function computeShotFingerprint({ page = {}, domText = '', scrollY = 0 } = {}) {
  const vids = (page.videos || [])
    .map(v => `${v?.paused ? 1 : 0}${v?.muted ? 1 : 0}:${Math.round(v?.area || 0)}`)
    .join(',');
  const txt = String(domText || '');
  const dialogs = (page.dialogs || []).map(d => `${d?.label || ''}#${d?.fields ?? '?'}`).join('|');
  const foc = page.focused ? `${page.focused.tag}:${page.focused.label || ''}:${page.focused.editable ? 1 : 0}` : '';
  return [
    page.url || '',
    page.title || '',
    Math.round(scrollY || 0),
    vids,
    page.audios || 0,
    page.editables ?? '',
    dialogs,
    foc,
    txt.length,
    hashStr(txt.slice(0, 4000)),
  ].join('|');
}
