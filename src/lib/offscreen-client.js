// ─────────────────────────────────────────────────────────────────────────────
// src/lib/offscreen-client.js
// Service-worker side helpers for talking to the offscreen ML document.
//
// MV3 forbids dynamic import() inside the service worker and exposes no
// DOM/canvas, so ALL machine-learning work (Transformers.js, MediaPipe,
// canvas redaction) happens in the offscreen document. This module owns:
//   • ensureOffscreen()  — create the offscreen doc on demand
//   • sendToOffscreen()  — request/response RPC with optional timeout
// ─────────────────────────────────────────────────────────────────────────────

const OFFSCREEN_URL = new URL('../offscreen/offscreen.html', import.meta.url).href;

export async function ensureOffscreen() {
  if (!chrome.offscreen) {
    throw new Error('chrome.offscreen API unavailable — requires Chrome 109+. Update Chrome to use on-device models.');
  }
  // hasDocument() exists since Chrome 116; fall back to create-and-catch.
  if (typeof chrome.offscreen.hasDocument === 'function') {
    try {
      if (await chrome.offscreen.hasDocument()) return;
    } catch { /* fall through */ }
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['WORKERS'],
      justification: 'Run on-device ML models (Transformers.js VLM/LLM, MediaPipe face detection, canvas redaction) for privacy-preserving visual perception.',
    });
    console.log('[OffscreenBridge] offscreen document created');
  } catch (err) {
    // "Only a single offscreen document may be created" → it already exists.
    const m = String(err?.message || err);
    if (m.includes('single offscreen') || m.includes('already exists')) return;
    throw err;
  }
}

/**
 * Send a message to the offscreen document and await its response.
 * @param {object} message       payload (a `target: 'offscreen'` field is added)
 * @param {object} opts
 * @param {number} opts.timeoutMs  0 = wait forever (use heartbeats to stay alive)
 */
export function sendToOffscreen(message, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => reject(new Error(`Offscreen RPC timed out after ${timeoutMs}ms (${message.type})`)), timeoutMs);
    }
    try {
      chrome.runtime.sendMessage({ target: 'offscreen', ...message }, resp => {
        if (timer) clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(resp);
        }
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      reject(err);
    }
  });
}
