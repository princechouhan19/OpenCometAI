// src/background/firefox-bg.js — FIREFOX ENTRY POINT
//
// Firefox MV3 backgrounds are EVENT PAGES (classic scripts), not module
// service workers. This classic loader boots the full Chromium service-worker
// module graph via dynamic import() — one source tree, two runtimes:
//
//   Chrome : manifest.background.service_worker → src/background/sw.js (module SW)
//   Firefox: manifest.background.scripts        → this file             (event page)
//            └─ dynamic import ─► src/background/sw.js (module graph intact)
//
// IN-PAGE ML RUNTIME: chrome.offscreen does not exist on Firefox, so
// offscreen-client.js detects that and hosts the SAME offscreen/offscreen.html
// document in a hidden iframe inside THIS event page (event pages have a DOM),
// talking to it over a postMessage RPC bridge. On-device models (Gemma 4,
// vision warm-up, OCR, face detection) therefore work on Firefox too — same ML
// code, different transport. Chromium-only niceties (chrome.debugger trusted
// clicks, chrome.pageCapture MHTML save, chrome.sidePanel, tab groups)
// degrade gracefully via runtime feature detection.

import(chrome.runtime.getURL('src/background/sw.js')).catch((err) => {
  // Last-ditch visibility: surface boot failures in the background console
  // (about:debugging → Inspect) instead of failing silently.
  console.error('[Open Comet Firefox] background boot failed:', err);
});
