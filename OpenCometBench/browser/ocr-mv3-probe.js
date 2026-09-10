// OpenCometBench/browser/ocr-mv3-probe.js
// Loaded as a MODULE from an extension page (chrome-extension://), so:
//   • the page CSP is the extension's own CSP (script-src 'self'
//     'wasm-unsafe-eval'; worker-src 'self') — exactly what the offscreen
//     document runs under;
//   • dynamic import of /src/lib/ocr-pii.js resolves to the same-origin
//     extension module — the REAL production code path, unmodified.
//
// The probe instruments Worker construction and outbound fetch/XHR BEFORE the
// module under test is imported, then renders synthetic PII text to a canvas
// and runs scanImageForPiiRegions() on the pixels.
//
// PASS criteria (evaluated by OpenCometBench/probe-ocr-mv3-extension.mjs):
//   1. scan did not fail (r.failed falsy) and produced ≥1 PII region
//   2. every Worker was constructed DIRECTLY from
//      chrome-extension://…/src/vendor/tesseract/worker.min.js (no blob:)
//   3. zero page-scope outbound (non-extension-origin) network requests
//      — the vendored chain must be fully offline
const results = {
  workerUrls: [],
  externalRequests: [],
  ok: false,
  failed: null,
  reason: null,
  regions: [],
  textChars: 0,
  ms: null,
  error: null,
  done: false,
};

// ── 1. Worker instrumentation (before importing ocr-pii.js) ──────────────────
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(url, opts) {
    results.workerUrls.push(String(url));
    super(url, opts);
  }
};

// ── 2. Outbound-network instrumentation (page scope) ─────────────────────────
const EXT = location.origin;
const external = (u) =>
  !u.startsWith(EXT) && !u.startsWith('data:') && !u.startsWith('blob:') &&
  !u.startsWith('about:');
const origFetch = window.fetch.bind(window);
window.fetch = (...args) => {
  const u = String(args[0]);
  if (external(u)) results.externalRequests.push(u);
  return origFetch(...args);
};
const OrigXHR = window.XMLHttpRequest;
window.XMLHttpRequest = class extends OrigXHR {
  open(method, url, ...rest) {
    const u = String(url);
    if (external(u)) results.externalRequests.push(u);
    return super.open(method, url, ...rest);
  }
};

// ── 3. Synthetic PII image (pixels only — invisible to any DOM scanner) ──────
function makePiiImage() {
  const c = document.createElement('canvas');
  c.width = 900;
  c.height = 320;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#000000';
  g.font = '28px monospace';
  [
    'Contact: john.doe@example.com',
    'Phone: +1 415 555 0132',
    'Card: 4111 1111 1111 1111',
    'Aadhaar: 2345 6789 0123',
    'API Key: sk-live-9f8e7d6c5b4a3f2e1d0c',
  ].forEach((t, i) => g.fillText(t, 40, 60 + i * 50));
  return c.toDataURL('image/png');
}

// ── 4. Run the production module, unmodified ─────────────────────────────────
try {
  const t0 = performance.now();
  const { scanImageForPiiRegions } = await import('/src/lib/ocr-pii.js');
  const dataUrl = makePiiImage();
  const r = await scanImageForPiiRegions(dataUrl, { minConfidence: 55 });
  results.ms = Math.round(performance.now() - t0);
  results.failed = !!r.failed;
  results.reason = r.reason || null;
  results.regions = (r.regions || []).map((x) => ({
    type: x.type,
    bounds: x.bounds,
    source: x.source,
  }));
  results.textChars = r.textChars || 0;
  results.ok = !r.failed && results.regions.length > 0;
} catch (e) {
  results.error = String(e?.message || e);
}

results.done = true;
window.__OCR_PROBE__ = results;
document.getElementById('out').textContent = JSON.stringify(results, null, 1);
