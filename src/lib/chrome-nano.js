// src/lib/chrome-nano.js
// Service-worker-side CLIENT for Chrome built-in AI (Prompt API /
// Gemini Nano). Same split-brain pattern as local-llm.js:
//
//   • this module (service worker): thin capability probe + RPC relay
//   • chrome-nano-engine.js (offscreen document): the actual Prompt API use
//
// The session lives in the offscreen document because MV3 service workers
// die after ~30s idle (killing any cached session with them), while the
// offscreen document persists (with heartbeats) across a whole agent task.

import { ensureOffscreen, sendToOffscreen } from './offscreen-client.js';

export const CHROME_NANO_MODEL = 'gemini-nano';

/**
 * Honest availability probe. Prefers the SW context when the API is exposed
 * there, else routes to the offscreen document (window context).
 * @returns {Promise<{available: boolean, state: string, via: string}>}
 *   state ∈ 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'no-api'
 */
export async function chromeNanoAvailability() {
  try {
    if (typeof globalThis.LanguageModel !== 'undefined' &&
        typeof globalThis.LanguageModel.availability === 'function') {
      const state = String(await globalThis.LanguageModel.availability());
      return { available: state === 'available' || state === 'downloadable', state, via: 'service-worker' };
    }
  } catch { /* fall through to offscreen probe */ }
  try {
    await ensureOffscreen();
    const resp = await sendToOffscreen({ type: 'NANO_PROBE' });
    if (resp?.ok) {
      return { available: resp.state === 'available' || resp.state === 'downloadable', state: resp.state, via: 'offscreen' };
    }
    return { available: false, state: 'no-api', via: 'offscreen-error' };
  } catch (err) {
    return { available: false, state: 'no-api', via: `error:${String(err?.message || err).slice(0, 80)}` };
  }
}

/**
 * One planning turn through the browser-managed model (via offscreen).
 * @returns {Promise<{text: string, ms: number, sessionReused: boolean, availability: string}>}
 */
export async function chromeNanoGenerate({ prompt, systemPrompt, temperature, topK } = {}) {
  await ensureOffscreen();
  const resp = await sendToOffscreen({
    type: 'NANO_GENERATE',
    params: { prompt, systemPrompt, temperature, topK },
  });
  if (!resp) throw new Error('chrome-nano: offscreen runtime did not respond');
  if (!resp.ok) throw new Error(resp.error || 'chrome-nano: generation failed');
  return { text: resp.text, ms: resp.ms, sessionReused: resp.sessionReused, availability: resp.availability };
}

/** Drop the cached offscreen session (new chat / settings change). */
export async function chromeNanoReset() {
  try {
    await ensureOffscreen();
    await sendToOffscreen({ type: 'NANO_RESET' });
  } catch { /* offscreen may not exist yet — nothing to reset */ }
}
