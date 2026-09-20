// src/lib/sih-mode.js — SIH COMPETITION MODE.
//
// SIH MODE = ON is the strict privacy configuration for evaluation:
//
//     RAW SCREEN ──► NEVER NETWORK.
//
// When enabled:
//   • The privacy agent ALWAYS runs the full sanitization pipeline — the
//     "Privacy Mode off" fast path is disabled (a screenshot that has not
//     been redacted can never be captured for the agent loop).
//   • The non-privacy (main) agent keeps working, but every raw screenshot
//     is STRIPPED before it can reach any network call (the agent degrades
//     to DOM-only context; nothing is removed, nothing raw leaves).
//   • The network privacy gate (privacy-firewall) independently blocks any
//     payload not carrying a passed verification envelope.
//
// Normal (non-SIH) usage remains available by toggling SIH MODE off in
// Settings — no existing feature is removed.
//
// PURE module — no top-level chrome access; storage guarded so Node tests
// can exercise the pure helpers.

export const SIH_MODE_KEY = 'sihMode';

const _cache = { value: null };

function storageArea() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.sync) return chrome.storage.sync;
    if (typeof chrome !== 'undefined' && chrome.storage?.local) return chrome.storage.local;
  } catch { /* Node test context */ }
  return null;
}

/** Read SIH mode. DEFAULT: ON (this is the SIH competition build). */
export async function isSihMode() {
  if (_cache.value !== null) return _cache.value;
  const area = storageArea();
  if (!area) return _cache.value ?? true;
  try {
    const data = await area.get(SIH_MODE_KEY);
    // Explicitly stored false wins; absence means the SIH default (ON).
    _cache.value = data?.[SIH_MODE_KEY] !== false;
  } catch {
    _cache.value = true;   // fail closed — storage trouble keeps protection ON
  }
  return _cache.value;
}

export function setSihModeCache(v) { _cache.value = Boolean(v); }

export async function setSihMode(on) {
  _cache.value = Boolean(on);
  const area = storageArea();
  if (area) {
    try { await area.set({ [SIH_MODE_KEY]: Boolean(on) }); } catch { /* best effort */ }
  }
}

/**
 * SIH gate for RAW screenshot transmission (pure, testable).
 * Returns a decision object; callers strip the image when blocked.
 */
export function sihRawScreenshotDecision(sihOn, rawScreenshot) {
  if (!sihOn) return { allowed: true, image: rawScreenshot };
  return {
    allowed: false,
    image: null,
    note: 'SIH MODE: raw screenshot blocked from network transmission (agent continues with sanitized/DOM context only).',
  };
}
