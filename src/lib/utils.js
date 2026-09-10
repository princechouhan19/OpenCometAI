// ─────────────────────────────────────────────────────────────────────────────
// src/lib/utils.js
// Pure utility helpers shared across all layers.
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve after `ms` milliseconds. */
export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Extract a clean hostname from a URL string. Returns '' on failure. */
export function getHostFromUrl(url) {
  try {
    return new URL(url || '').hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Normalise a raw host/URL string to a bare hostname. */
export function normalizeHost(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const candidate = raw.includes('://') ? raw : `https://${raw}`;
  try {
    return new URL(candidate).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return raw
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .trim()
      .toLowerCase();
  }
}

/** Escape a string for use inside a CSS attribute selector value. */
export function escapeAttr(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Collapse whitespace and trim. */
export function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Parse a JSON string robustly — strips markdown fences, then tries
 * extracting the first `{…}` block if a direct parse fails.
 */
export function parseJSON(text) {
  if (!text) throw new Error('Empty response from AI');
  const clean = String(text).replace(/```json\n?|```\n?/g, '').trim();
  try { return JSON.parse(clean); } catch { /* fall through */ }
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { /* fall through */ }
  }
  throw new Error(`Could not parse AI response: ${clean.substring(0, 200)}`);
}

/** Safely send a Chrome runtime message; silently swallow "no receiver" errors. */
export function safeSendMessage(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {});
}

/** Escape HTML special characters for safe DOM insertion. */
export function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Format a Unix timestamp as a short locale string. */
export function formatTime(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Remove leading emoji/symbol prefix that step text uses. */
export function stripStepPrefix(text) {
  return String(text || '').replace(/^[^\s]+\s*/, '').trim();
}
