// ─────────────────────────────────────────────────────────────────────────────
// src/core/events.js
// Typed event bus — thin safety wrapper around chrome.runtime messaging.
// Prevents magic-string bugs; all message types come from constants.js.
// ─────────────────────────────────────────────────────────────────────────────

import { MSG } from '../lib/constants.js';

/**
 * Send a typed message to the background service worker.
 * Returns a Promise that resolves with the response.
 */
export function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, resp => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(resp);
      }
    });
  });
}

/**
 * Register a listener for incoming messages.
 * Handler receives (type, payload, sendResponse).
 * Returns an unsubscribe function.
 */
export function listen(handler) {
  const fn = (msg, _sender, sendResponse) => {
    const { type, ...payload } = msg;
    const result = handler(type, payload, sendResponse);
    if (result instanceof Promise) {
      result.then(sendResponse).catch(() => {});
      return true; // keep channel open
    }
  };
  chrome.runtime.onMessage.addListener(fn);
  return () => chrome.runtime.onMessage.removeListener(fn);
}

/** Broadcast a message to all tabs in the agent's tab group. */
export function broadcastToTab(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

// Re-export MSG for convenience so consumers need only import from events.js
export { MSG };
