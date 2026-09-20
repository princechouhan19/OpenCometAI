// src/lib/local-vision.js
// Transformers.js wrapper for on-device vision + NER models.
//
// Models (lazy-loaded, cached in the browser Cache API):
//   • Object detection:  Xenova/yolos-tiny                (~6 MB, INT8)
//                         – used to detect UI elements / generic objects
//                           on the page screenshot (extra context for the LLM)
//   • Image classification: Xenova/vit-base-patch16-224   (~85 MB)
//                         – fallback when YOLO is unavailable; tells us the
//                           overall scene class (form, login page, list, etc.)
//   • NER:               Xenova/bert-base-NER-uncased     (~110 MB)
//                         – picks up person/org/location entities in DOM
//                           text that don't follow regex patterns
//
// Backend selection:
//   WebGPU  →  preferred (Chrome ≥ 113)
//   WASM    →  fallback (works everywhere, SIMD-accelerated)
//
// IMPORTANT: this module must run inside the offscreen document — it
// dynamic-imports the VENDORED Transformers.js bundle (CSP-clean, offline)
// and needs image/canvas APIs. NEVER import this from the service worker.
// See offscreen/offscreen.js.

const TRANSFORMERS_URL = new URL('../vendor/transformers/transformers.min.js', import.meta.url).href;
const ORT_BASE_URL = new URL('../vendor/transformers/ort/', import.meta.url).href;

let _transformers = null;
let _pipelines = {
  objectDetection: null,
  imageClassification: null,
  ner: null,
};
// creation LOCKS — two concurrent first-calls (e.g. YOLO and
// ViT both firing on the first capture) previously double-loaded the model.
let _pipelineLocks = {};
async function lockedPipeline(key, loader) {
  if (_pipelines[key]) return _pipelines[key];
  _pipelineLocks[key] ??= loader().then(p => {
    _pipelines[key] = p;
    delete _pipelineLocks[key];
    return p;
  }).catch(err => {
    delete _pipelineLocks[key];
    throw err;
  });
  return _pipelineLocks[key];
}
let _stats = {
  initMs: { objectDetection: 0, imageClassification: 0, ner: 0 },
  calls: { objectDetection: 0, imageClassification: 0, ner: 0 },
  totalMs: { objectDetection: 0, imageClassification: 0, ner: 0 },
  lastMs: { objectDetection: 0, imageClassification: 0, ner: 0 },
  backend: 'unknown',
};

const MODEL_ID = {
  objectDetection: 'Xenova/yolos-tiny',
  imageClassification: 'Xenova/vit-base-patch16-224',
  ner: 'Xenova/bert-base-NER-uncased',
};

/** Lazy import of the VENDORED Transformers.js (legal in a page context). */
async function loadTransformers() {
  if (_transformers) return _transformers;
  _transformers = await import(/* webpackIgnore: true */ TRANSFORMERS_URL);

  // Configure backends + cache
  // disable the ORT-wasm Cache API preloader FIRST, outside the try —
  // same rationale as local-llm-engine.js (it previously sat inside the try,
  // so any throw above it left the preloader enabled and the Cache API then
  // rejected the chrome-extension:// wasm URLs).
  _transformers.env.useWasmCache = false;
  try {
    // MUST match the vendored esm bundle's ORT build (asyncify naming, see
    // local-llm-engine.js for the full webgpuInit rationale).
    _transformers.env.backends.onnx.wasm.wasmPaths = {
      mjs: ORT_BASE_URL + 'ort-wasm-simd-threaded.asyncify.mjs',
      wasm: ORT_BASE_URL + 'ort-wasm-simd-threaded.asyncify.wasm',
    };
    _transformers.env.backends.onnx.wasm.numThreads = 1; // no crossOriginIsolated in extension pages
    // The vendored artifacts are local bundle files — nothing to cache (the
    // useWasmCache=false above is the operative override; see comment above).
  } catch {}
  // Use remote HF hub for model files (cached by the browser automatically)
  _transformers.env.allowLocalModels = false;
  _transformers.env.useBrowserCache = true;
  try {
    _transformers.env.remoteHost = 'https://huggingface.co';
    _transformers.env.remotePathTemplate = '{model}/resolve/main/';
  } catch {}
  _stats.backend = await detectBackendProbed();
  return _transformers;
}

function detectBackend() {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator && navigator.gpu) return 'webgpu';
  return 'wasm';
}

// `navigator.gpu` existing is NOT the same as a WORKING adapter —
// headless Chromium and some VMs expose navigator.gpu but fail
// requestAdapter() ("No available adapters"), which made ORT throw
// "no available backend found" with NO wasm fallback (the pipeline was
// created with device:'webgpu' unconditionally). Probe the adapter ONCE and
// fall back to wasm when it is absent. On real WebGPU hardware this changes
// nothing (adapter exists → webgpu, identical to the authoritative
// real-hardware benchmark); on adapter-less environments it makes the
// detectors actually RUN instead of erroring.
let _backendProbed = null;
async function detectBackendProbed() {
  if (_backendProbed) return _backendProbed;
  if (typeof navigator !== 'undefined' && 'gpu' in navigator && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) { _backendProbed = 'webgpu'; return _backendProbed; }
    } catch { /* fall through to wasm */ }
  }
  _backendProbed = 'wasm';
  return _backendProbed;
}

async function deviceForPipeline() {
  return (await detectBackendProbed()) === 'webgpu' ? 'webgpu' : 'wasm';
}

/**
 * Pre-load model pipelines (call when the user opts into YOLO / NER).
 * Safe to call multiple times — returns cached pipelines.
 */
export async function preloadLocalVision({ includeNer = true, includeYolo = true } = {}) {
  const tasks = [];
  if (includeYolo) tasks.push(getObjectDetector());
  if (includeNer) tasks.push(getNerPipeline());
  await Promise.all(tasks);
}

/** YOLO object detection pipeline → boxes + labels for everything visible. */
export async function getObjectDetector() {
  return lockedPipeline('objectDetection', async () => {
    const tr = await loadTransformers();
    const t0 = performance.now();
    // Transformers.js v3/v4 pipeline API — dtype 'q8' = INT8 quantisation.
    const p = await tr.pipeline(
      'object-detection', MODEL_ID.objectDetection,
      { dtype: 'q8', device: await deviceForPipeline() }
    );
    _stats.initMs.objectDetection = Math.round(performance.now() - t0);
    return p;
  });
}

/** ViT image classification pipeline → coarse page-type label. */
export async function getImageClassifier() {
  return lockedPipeline('imageClassification', async () => {
    const tr = await loadTransformers();
    const t0 = performance.now();
    const p = await tr.pipeline(
      'image-classification', MODEL_ID.imageClassification,
      { dtype: 'q8', device: await deviceForPipeline() }
    );
    _stats.initMs.imageClassification = Math.round(performance.now() - t0);
    return p;
  });
}

/** BERT NER pipeline → person / org / location entities in text. */
export async function getNerPipeline() {
  return lockedPipeline('ner', async () => {
    const tr = await loadTransformers();
    const t0 = performance.now();
    const p = await tr.pipeline(
      'token-classification', MODEL_ID.ner,
      { dtype: 'q8', device: await deviceForPipeline() }
    );
    _stats.initMs.ner = Math.round(performance.now() - t0);
    return p;
  });
}

/**
 * Run YOLO object detection on an image.
 * Accepts a data-URL (preferred — RawImage handles it natively) or
 * anything Transformers.js can read (URL / Blob / RawImage).
 * opts.maxEdge: v1.16.0 OPTIONAL input downscale — longest edge in px for the
 * detector input. Boxes are mapped BACK to full-image coordinates so redaction
 * semantics are unchanged. Default 0 = disabled (bit-identical to the previous
 * behavior). Any downscale failure falls back to the original input
 * (fail-safe).
 * MEASURED (OpenCometBench/probe-yolo-downscale.mjs, headless-ci): correctness
 * is preserved exactly (box parity IoU=1.000) but latency is NEUTRAL — the
 * model resizes internally to a fixed resolution, so input size does not
 * drive compute. The knob exists for input-size control, not as a latency
 * lever; the changed-frame YOLO cost is addressed by the memo + warm-up
 * instead.
 * Returns { detections: [{label, score, bounds}], latencyMs }
 */
export async function detectObjects(image, { maxEdge = 0 } = {}) {
  const pipe = await getObjectDetector();
  const t0 = performance.now();
  let workInput = image;
  let sx = 1, sy = 1;   // box back-scale factors (1 → identical to no-downscale path)
  if (maxEdge > 0 && typeof image === 'string' && image.startsWith('data:')) {
    try {
      const tr = await loadTransformers();
      const raw = await tr.RawImage.fromURL(image);
      const longest = Math.max(raw.width, raw.height);
      if (longest > maxEdge) {
        const k = maxEdge / longest;
        const w = Math.max(1, Math.round(raw.width * k));
        const h = Math.max(1, Math.round(raw.height * k));
        // The vendored pipeline accepts STRING inputs (data-URLs) natively but
        // rejects RawImage instances ("Unsupported input type"), so hand the
        // downscaled pixels back as a PNG data-URL (small: ≤ maxEdge px).
        const blob = await raw.resize(w, h).toBlob('image/png');
        workInput = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result));
          fr.onerror = () => reject(new Error('FileReader failed on downscaled blob'));
          fr.readAsDataURL(blob);
        });
        sx = raw.width / w;
        sy = raw.height / h;
      }
    } catch { workInput = image; sx = 1; sy = 1; }   // fail-safe: original input
  }
  const out = await pipe(workInput);
  const ms = Math.round(performance.now() - t0);
  _stats.calls.objectDetection++;
  _stats.totalMs.objectDetection += ms;
  _stats.lastMs.objectDetection = ms;

  const detections = (out || []).map(o => ({
    label: o.label,
    score: o.score,
    bounds: {
      x: Math.round(o.box.xmin * sx),
      y: Math.round(o.box.ymin * sy),
      w: Math.round((o.box.xmax - o.box.xmin) * sx),
      h: Math.round((o.box.ymax - o.box.ymin) * sy),
    },
  }));
  return { detections, latencyMs: ms };
}

/** Top-K page-type labels for a screenshot. */
export async function classifyPage(image, topK = 3) {
  const pipe = await getImageClassifier();
  const t0 = performance.now();
  const out = await pipe(image, { topk: topK });
  const ms = Math.round(performance.now() - t0);
  _stats.calls.imageClassification++;
  _stats.totalMs.imageClassification += ms;
  _stats.lastMs.imageClassification = ms;
  return { labels: out, latencyMs: ms };
}

/** Convenience: run NER on text, returning standard PII-shaped findings. */
export async function runNer(text) {
  const pipe = await getNerPipeline();
  const t0 = performance.now();
  const out = await pipe(text);
  _stats.lastMs.ner = Math.round(performance.now() - t0);
  _stats.calls.ner++;
  _stats.totalMs.ner += _stats.lastMs.ner;
  return out;
}

export function getLocalVisionStats() {
  return {
    backend: _stats.backend,
    initMs: { ..._stats.initMs },
    calls: { ..._stats.calls },
    lastMs: { ..._stats.lastMs },
    avgMs: {
      objectDetection: _stats.calls.objectDetection ? Math.round(_stats.totalMs.objectDetection / _stats.calls.objectDetection) : 0,
      imageClassification: _stats.calls.imageClassification ? Math.round(_stats.totalMs.imageClassification / _stats.calls.imageClassification) : 0,
      ner: _stats.calls.ner ? Math.round(_stats.totalMs.ner / _stats.calls.ner) : 0,
    },
    pipelinesLoaded: Object.fromEntries(
      Object.entries(_pipelines).map(([k, v]) => [k, Boolean(v)])
    ),
  };
}

export function isBackendWebGPU() {
  return _stats.backend === 'webgpu';
}

/** Release all cached models + workers (frees memory when Privacy Mode is off). */
export async function disposeLocalVision() {
  for (const k of Object.keys(_pipelines)) {
    try { await _pipelines[k]?.dispose?.(); } catch {}
    _pipelines[k] = null;
  }
}
