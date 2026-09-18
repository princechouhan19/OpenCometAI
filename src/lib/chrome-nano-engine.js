// ─────────────────────────────────────────────────────────────────────────────
// src/lib/chrome-nano-engine.js
// v1.21.0 — Chrome BUILT-IN AI (Prompt API / Gemini Nano) engine.
//
// Runs in the OFFSCREEN document (a window context) where the Prompt API's
// `LanguageModel` is exposed to extensions. The service worker reaches it
// through the same relay pattern as local-llm-engine (NANO_* messages), so
// sessions survive the SW's 30s idle kill and heartbeats keep the pipeline
// alive during long prompts.
//
// WHY THIS PATH (SIH on-device reasoning): the browser owns the model —
// zero weights downloaded by us, zero network calls from us, reasoning
// literally inside the browser process. It is the strongest possible answer
// to the PS data-sovereignty requirement on Chromium; Firefox and
// unsupported devices get an HONEST 'unavailable' and keep the existing
// Transformers.js catalog path.
//
// HONESTY RULES:
//   • availability() reflects the API's own report ('unavailable' /
//     'downloadable' / 'downloading' / 'available') — never invented.
//   • No fetch(), no network, no telemetry anywhere in this file. The only
//     I/O is the browser-managed model itself.
//   • A failed prompt destroys the cached session and reports the error —
//     a degraded session never silently returns stale text.
//
// `setLanguageModelImpl()` injects a fake LanguageModel for the benchmark
// suite (OpenCometBench/chrome-nano.test.js) — the injection point IS the
// seam under test: everything below it is exactly what runs in production.
// ─────────────────────────────────────────────────────────────────────────────

let _impl = null;                     // injected test double (or forced backend)
let _session = null;                  // cached LanguageModel session
let _sessionOpts = null;              // options the cached session was built with
let _lastError = '';

function impl() {
  if (_impl) return _impl;
  try {
    if (typeof globalThis.LanguageModel !== 'undefined') return globalThis.LanguageModel;
  } catch { /* ignore */ }
  return null;
}

/** Test seam: inject a fake LanguageModel (null → restore API probing). */
export function setLanguageModelImpl(x) { _impl = x; nanoReset(); }

/**
 * Availability of the built-in model, straight from the API:
 *   'available' | 'downloadable' | 'downloading' | 'unavailable' | 'no-api'
 * 'no-api' = this browser/context does not expose the Prompt API at all
 * (Firefox, older Chromium, permission-policy denials). Honest states —
 * the UI must present them verbatim, never as a generic failure.
 */
export async function nanoAvailability() {
  const lm = impl();
  if (!lm) return 'no-api';
  try {
    if (typeof lm.availability === 'function') return String(await lm.availability());
    if (typeof lm.available === 'function') return (await lm.available()) ? 'available' : 'unavailable'; // legacy shape
    return 'no-api';
  } catch (err) {
    _lastError = String(err?.message || err);
    return 'no-api';
  }
}

function buildCreateOptions({ systemPrompt, temperature, topK } = {}) {
  const opts = {};
  const initialPrompts = [];
  if (systemPrompt) initialPrompts.push({ role: 'system', content: String(systemPrompt) });
  if (initialPrompts.length) opts.initialPrompts = initialPrompts;
  if (Number.isFinite(Number(temperature))) opts.temperature = Number(temperature);
  if (Number.isFinite(Number(topK))) opts.topK = Number(topK);
  return opts;
}

/**
 * One planning turn through the browser-managed model.
 * @returns {Promise<{text: string, ms: number, sessionReused: boolean, availability: string}>}
 */
export async function nanoGenerate({ prompt, systemPrompt, temperature, topK } = {}) {
  if (!prompt || !String(prompt).trim()) throw new Error('chrome-nano: empty prompt');
  const lm = impl();
  if (!lm) throw new Error('chrome-nano: Prompt API not exposed in this context');

  const availability = await nanoAvailability();
  if (availability === 'unavailable' || availability === 'no-api') {
    throw new Error(`chrome-nano: built-in model not usable in this browser (${availability})`);
  }

  const wantOpts = buildCreateOptions({ systemPrompt, temperature, topK });
  const optsKey = JSON.stringify(wantOpts);
  const t0 = performance.now();
  let sessionReused = false;

  if (_session && _sessionOpts === optsKey) {
    sessionReused = true;
  } else {
    // DestroyParams exist on real sessions; be defensive for test doubles.
    try { if (_session && typeof _session.destroy === 'function') _session.destroy(); } catch { /* ignore */ }
    _session = await lm.create(wantOpts);
    _sessionOpts = optsKey;
  }

  try {
    const text = await _session.prompt(String(prompt));
    const ms = Math.round(performance.now() - t0);
    if (typeof text !== 'string' || !text.length) {
      throw new Error('chrome-nano: empty response from built-in model');
    }
    return { text, ms, sessionReused, availability };
  } catch (err) {
    _lastError = String(err?.message || err);
    // A failed session is suspect — drop it so the NEXT call rebuilds fresh.
    try { if (_session && typeof _session.destroy === 'function') _session.destroy(); } catch { /* ignore */ }
    _session = null;
    _sessionOpts = null;
    throw new Error(`chrome-nano: prompt failed — ${_lastError}`);
  }
}

/** Drop the cached session (new chat / settings change / memory pressure). */
export function nanoReset() {
  try { if (_session && typeof _session.destroy === 'function') _session.destroy(); } catch { /* ignore */ }
  _session = null;
  _sessionOpts = null;
}

export function nanoLastDiagnostics() {
  return { lastError: _lastError, hasSession: Boolean(_session) };
}

export const CHROME_NANO_ENGINE_VERSION = '1.0.0';
