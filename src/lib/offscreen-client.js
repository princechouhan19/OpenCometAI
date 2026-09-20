// src/lib/offscreen-client.js — DUAL-TRANSPORT ML RUNTIME CLIENT
// Service-worker side helpers for talking to the ML runtime document.
//
// MV3 forbids dynamic import() inside a Chromium service worker and exposes
// no DOM/canvas there, so ALL machine-learning work (Transformers.js,
// MediaPipe, canvas redaction) happens in a dedicated document. Which document
// hosts it depends on the runtime — ONE source tree, TWO transports:
//
//   Chromium : chrome.offscreen document  → chrome.runtime.sendMessage RPC
//              (byte-for-byte the same protocol)
//   Firefox  : chrome.offscreen does NOT exist. The SAME offscreen/offscreen.html
//              document is hosted in a hidden iframe inside the event page
//              (which has a DOM), and RPCs travel over window.postMessage
//              envelopes correlated by rpcId. The ML runtime code itself is
//              UNCHANGED — only the transport differs.
//
// This module owns:
//   • mlRuntimeMode()    — 'offscreen' | 'inpage' | 'none' (diagnostics)
//   • ensureOffscreen()  — create the offscreen doc / iframe on demand
//   • sendToOffscreen()  — request/response RPC with optional timeout
//   • warmupVisionModels() — vision model warm-up

const OFFSCREEN_URL = new URL('../offscreen/offscreen.html', import.meta.url).href;

const HAS_OFFSCREEN_API = typeof chrome !== 'undefined' && !!chrome.offscreen;
const HAS_INPAGE_DOM = typeof document !== 'undefined' && !!document.documentElement;
const INPAGE_MODE = !HAS_OFFSCREEN_API && HAS_INPAGE_DOM;

/** Which transport backs the ML runtime in THIS context. */
export function mlRuntimeMode() {
  return HAS_OFFSCREEN_API ? 'offscreen' : (INPAGE_MODE ? 'inpage' : 'none');
}

// Transport A — Chromium offscreen document

async function ensureOffscreenDocument() {
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

function sendViaRuntime(message, { timeoutMs }) {
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

// Transport B — Firefox in-page ML runtime (hidden iframe + postMessage)

const ML_FRAME_ID = 'opencomet-ml-frame';
const FRAME_READY_TIMEOUT_MS = 30 * 1000;

/** rpcId → { resolve, reject, timer }; the window 'message' listener drains it. */
const _inpagePending = new Map();
let _mlFrame = null;

function mlTargetOrigin() {
  // The iframe's own extension origin — never postMessage with '*'.
  return new URL(OFFSCREEN_URL).origin;
}

function ensureMlFrame() {
  if (_mlFrame && _mlFrame.isConnected) return _mlFrame;
  let frame = document.getElementById(ML_FRAME_ID);
  if (!frame) {
    frame = document.createElement('iframe');
    frame.id = ML_FRAME_ID;
    frame.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;border:0;visibility:hidden;';
    frame.src = OFFSCREEN_URL;
    (document.body || document.documentElement).appendChild(frame);
    console.log('[OffscreenBridge] in-page ML runtime iframe created (Firefox event page)');
  }
  _mlFrame = frame;
  return frame;
}

// Reply drain: the ML document answers with
//   { target: 'offscreen-client', rpcId, resp }
// Only frames WE created are trusted as sources.
if (INPAGE_MODE && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('message', (ev) => {
    const d = ev && ev.data;
    if (!d || d.target !== 'offscreen-client' || typeof d.rpcId !== 'string') return;
    if (_mlFrame && ev.source && ev.source !== _mlFrame.contentWindow) return; // not our ML frame
    const p = _inpagePending.get(d.rpcId);
    if (!p) return; // stale/late reply — drop
    _inpagePending.delete(d.rpcId);
    if (p.timer) clearTimeout(p.timer);
    p.resolve(d.resp);
  });
}

function sendInpage(message, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const frame = _mlFrame;
    if (!frame || !frame.contentWindow) {
      return reject(new Error('In-page ML runtime iframe is not up — call ensureOffscreen() first'));
    }
    const rpcId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        _inpagePending.delete(rpcId);
        reject(new Error(`In-page ML RPC timed out after ${timeoutMs}ms (${message.type})`));
      }, timeoutMs);
    }
    _inpagePending.set(rpcId, { resolve, reject, timer });
    try {
      frame.contentWindow.postMessage({ target: 'offscreen', rpcId, ...message }, mlTargetOrigin());
    } catch (err) {
      _inpagePending.delete(rpcId);
      if (timer) clearTimeout(timer);
      reject(err);
    }
  });
}

/** Wait until the iframe's ML document answers an OFFSCREEN_PING. */
async function waitForInpageReady(deadlineMs = FRAME_READY_TIMEOUT_MS) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < deadlineMs) {
    try {
      const resp = await sendInpage({ type: 'OFFSCREEN_PING' }, { timeoutMs: 4000 });
      if (resp && resp.ok) return resp;
      lastErr = new Error('ML runtime answered OFFSCREEN_PING with an error');
    } catch (err) {
      lastErr = err; // module graph still loading — retry
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`In-page ML runtime did not become ready within ${deadlineMs}ms (${lastErr?.message || 'no reply'})`);
}

// Public API (transport-agnostic — callers don't care where the ML runs)

export async function ensureOffscreen() {
  if (HAS_OFFSCREEN_API) return ensureOffscreenDocument();
  if (INPAGE_MODE) {
    ensureMlFrame();
    await waitForInpageReady();
    return;
  }
  throw new Error('No ML runtime host in this context — chrome.offscreen is missing and there is no DOM to host the in-page runtime (requires Chrome 109+ or a Firefox event page).');
}

export function sendToOffscreen(message, { timeoutMs = 0 } = {}) {
  if (HAS_OFFSCREEN_API) return sendViaRuntime(message, { timeoutMs });
  if (INPAGE_MODE) return sendInpage(message, { timeoutMs });
  return Promise.reject(new Error('No ML runtime host in this context (chrome.offscreen missing, no in-page DOM).'));
}

/**
 * — fire-and-forget vision model warm-up: asks the ML runtime to load
 * the YOLO (+ optional ViT) pipelines BEFORE the first capture, moving the
 * one-time model download + WASM/GPU-compile cost off the first-capture
 * critical path (cold-cache ViT load measured at 37.9 s on the reference
 * hardware — that single load dominated the real-VLM E2E first-step
 * sanitizeMs 41487). Resolves { ok, result } or { ok:false, error } —
 * NEVER throws: a warm-up failure must not affect the running session
 * (the first capture then warms lazily exactly as before).
 */
export async function warmupVisionModels({ yolo = true, vit = true } = {}) {
  try {
    await ensureOffscreen();
    const resp = await sendToOffscreen({ type: 'VISION_WARMUP', yolo, vit });
    return resp || { ok: false, error: 'ML runtime did not respond' };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * — ask the ML runtime to shut down. On Chromium this closes the
 * offscreen document; on Firefox the SW removes the in-page iframe (see the
 * OFFSCREEN_CLOSE_REQUEST route in sw.js). Exposed so tests/diagnostics can
 * reason about the teardown path without reaching into transport details.
 */
export function mlRuntimeTeardownHint() {
  return HAS_OFFSCREEN_API ? 'closeDocument' : (INPAGE_MODE ? 'remove-iframe' : 'none');
}
