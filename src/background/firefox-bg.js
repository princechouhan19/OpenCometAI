// ─────────────────────────────────────────────────────────────────────────────
// src/background/firefox-bg.js — FIREFOX ENTRY POINT (v1.17.0)
//
// Firefox MV3 backgrounds are EVENT PAGES (classic scripts), not module
// service workers. This classic loader boots the full Chromium service-worker
// module graph via dynamic import() — one source tree, two runtimes:
//
//   Chrome : manifest.background.service_worker → src/background/sw.js (module SW)
//   Firefox: manifest.background.scripts        → this file             (event page)
//            └─ dynamic import ─► src/background/sw.js (module graph intact)
//
// The chrome.offscreen API does not exist on Firefox. HONEST STATUS (v1.16.1):
// there is NO automatic ML fallback in the event page — offscreen-client.js
// THROWS when chrome.offscreen is missing, so on-device models (Gemma 4,
// vision warm-up, OCR) are NOT available on Firefox. Cloud providers, the
// companion server and the standard agent loop still work; the privacy
// pipeline requires Chromium for now.
// ─────────────────────────────────────────────────────────────────────────────

import(chrome.runtime.getURL('src/background/sw.js')).catch((err) => {
  // Last-ditch visibility: surface boot failures in the background console
  // (about:debugging → Inspect) instead of failing silently.
  console.error('[Open Comet Firefox] background boot failed:', err);
});
