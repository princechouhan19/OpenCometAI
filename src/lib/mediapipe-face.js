// src/lib/mediapipe-face.js
// MediaPipe FaceDetector wrapper — runs on-device (WASM + optional GPU)
// to detect human faces in a screenshot. The returned bounding boxes are
// passed to canvas-redactor.js for pixel-level blurring.
//
// Why MediaPipe?
//   • Tiny model (~230 KB quantised for web)
//   • First-class WASM SIMD + WebGPU acceleration
//   • No network call — the module, WASM and model are ALL vendored with the
//     extension (src/vendor/mediapipe), so it works fully offline.
//
// IMPORTANT: this module must run inside the offscreen document (not the
// service worker) — it dynamic-imports the vendored tasks-vision module and
// needs DOM/canvas. See offscreen/offscreen.js.

let _vision = null;
let _faceDetector = null;
let _initPromise = null;
let _stats = { initMs: 0, calls: 0, totalMs: 0, lastMs: 0, tiledCalls: 0, tiledHits: 0, verifyDropped: 0 };

// Native console-noise filter
// MediaPipe's WASM graph init prints benign glog lines straight to the console
// through console.warn, e.g. "W… gl_context.cc:1060] OpenGL error checking is
// disabled". That message is purely informational (GL error checking is
// compiled out of release builds for speed) and MediaPipe exposes no option to
// silence it, so we mute EXACTLY those lines for the duration of detector
// creation (the wasm glue looks up console.warn at call time, so this works).
const MEDIAPIPE_NATIVE_NOISE_RE = /gl_context\.cc:\d+\]\s*OpenGL error checking is disabled|OpenGL error checking is disabled/;

async function withMutedNativeNoise(run) {
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const orig = new Map(methods.map((m) => [m, typeof console[m] === 'function' ? console[m].bind(console) : null]));
  const isNoise = (...args) => {
    let line = '';
    try {
      line = args.map((a) => (typeof a === 'string' ? a : (a && a.message) || String(a))).join(' ');
    } catch { /* non-serializable arg — let it through */ }
    return MEDIAPIPE_NATIVE_NOISE_RE.test(line);
  };
  for (const m of methods) {
    console[m] = (...args) => { if (!isNoise(...args)) orig.get(m)?.(...args); };
  }
  try {
    return await run();
  } finally {
    for (const m of methods) {
      if (orig.get(m)) console[m] = orig.get(m);
    }
  }
}

// PERMANENT ultra-narrow native-noise filter.
// The scoped window above only covers FaceDetector creation, but field logs
// showed the glog line can still escape when MediaPipe binds its GL
// context lazily — the wasm glue emits it asynchronously AFTER the window has
// been restored (user saw it 4× across a session). Installing a permanent
// filter costs nothing and is side-effect free because it drops ONLY lines
// matching MEDIAPIPE_NATIVE_NOISE_RE (the exact benign glog wording); every
// other message from every library passes through untouched.
(function installNativeNoiseFilter() {
  if (globalThis.__ocNativeNoiseFilterInstalled) return;
  globalThis.__ocNativeNoiseFilterInstalled = true;
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const orig = new Map(methods.map((m) => [m, typeof console[m] === 'function' ? console[m].bind(console) : null]));
  const isNoise = (...args) => {
    let line = '';
    try {
      line = args.map((a) => (typeof a === 'string' ? a : (a && a.message) || String(a))).join(' ');
    } catch { /* non-serializable arg — let it through */ }
    return MEDIAPIPE_NATIVE_NOISE_RE.test(line);
  };
  for (const m of methods) {
    console[m] = (...args) => { if (!isNoise(...args)) orig.get(m)?.(...args); };
  }
})();

// All assets are bundled with the extension — CSP-clean + offline-friendly.
const MODULE_URL = new URL('../vendor/mediapipe/tasks-vision.mjs', import.meta.url).href;
const WASM_BASE  = new URL('../vendor/mediapipe/wasm/', import.meta.url).href;
const MODEL_URL  = new URL('../vendor/mediapipe/models/blaze_face_short_range.tflite', import.meta.url).href;

/**
 * Lazily import MediaPipe tasks-vision and create a FaceDetector.
 * Returns a cached singleton.
 */
export async function getFaceDetector() {
  if (_faceDetector) return _faceDetector;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const t0 = performance.now();
    // Dynamic import of the VENDORED tasks-vision module.
    // Legal here because this code runs in the offscreen document (a normal
    // page context) — NEVER in the service worker (import() is banned there).
    const mod = await import(/* webpackIgnore: true */ MODULE_URL);
    _vision = mod;
    const fileset = await mod.FilesetResolver.forVisionTasks(WASM_BASE);
    // createFromOptions compiles the MediaPipe graph — this is where the wasm
    // emits the benign "gl_context.cc … OpenGL error checking is disabled"
    // glog line. Keep the console clean without hiding anything else.
    _faceDetector = await withMutedNativeNoise(() => mod.FaceDetector.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate: 'GPU',  // try WebGPU; falls back to CPU automatically
      },
      runningMode: 'IMAGE',
      // LOW on purpose: the runtime drops everything below this score BEFORE
      // we see it. We keep the net permissive and apply our own thresholds
      // per pass (full-frame vs tile) so small faces in huge screenshots
      // survive. See detectFacesTiled().
      minDetectionConfidence: 0.2,
    }));
    _stats.initMs = Math.round(performance.now() - t0);
    return _faceDetector;
  })();

  try {
    return await _initPromise;
  } catch (err) {
    _initPromise = null;
    throw err;
  }
}

/**
 * Detect faces in a still image.
 *
 * @param {ImageBitmap|HTMLCanvasElement|HTMLImageElement|Blob} image
 * @returns {Promise<Array<{bounds:{x,y,w,h}, confidence:number, type:'face'}>>}
 */
export async function detectFaces(image, minConfidence = 0.5) {
  const detector = await getFaceDetector();
  const t0 = performance.now();
  const result = detector.detect(image);
  const ms = Math.round(performance.now() - t0);
  _stats.calls++;
  _stats.totalMs += ms;
  _stats.lastMs = ms;

  const detections = (result?.detections || [])
    .map(d => {
      const box = d.boundingBox;
      return {
        type: 'face',
        confidence: Number(d.categories?.[0]?.score || 0.7),
        source: 'mediapipe-face',
        bounds: {
          x: Math.round(box.originX),
          y: Math.round(box.originY),
          w: Math.round(box.width),
          h: Math.round(box.height),
        },
      };
    })
    .filter(d => d.confidence >= minConfidence);
  return detections;
}

// Tiled detection
// WHY: BlazeFace SHORT RANGE is tuned for selfie-distance faces. On a full
// 2560×1440 (DPR-2) screenshot a webcam-overlay face can be ~60 px tall —
// far below what the model reliably fires on, so full-frame passes returned
// 0 faces while faces were clearly visible (user-reported bug). Fix: when
// the full-frame pass finds nothing, re-scan the image in overlapping
// tiles (each tile ≈ the regime the model was trained for) and merge the
// per-tile boxes back into full-image coordinates with NMS.

const _tileCanvas = (typeof document !== 'undefined') ? document.createElement('canvas') : null;

function ensureBitmap(image) {
  if (image instanceof ImageBitmap || image instanceof HTMLCanvasElement || image instanceof OffscreenCanvas) {
    return Promise.resolve(image);
  }
  if (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement) {
    return createImageBitmap(image);
  }
  if (typeof Blob !== 'undefined' && image instanceof Blob) {
    return createImageBitmap(image);
  }
  if (typeof image === 'string') {
    return fetch(image).then(r => r.blob()).then(b => createImageBitmap(b));
  }
  return Promise.reject(new Error('detectFacesTiled: unsupported image source'));
}

async function detectRaw(source) {
  const detector = await getFaceDetector();
  const t0 = performance.now();
  const result = detector.detect(source);
  const ms = Math.round(performance.now() - t0);
  _stats.calls++;
  _stats.totalMs += ms;
  _stats.lastMs = ms;
  return (result?.detections || []).map(d => ({
    score: Number(d.categories?.[0]?.score || 0),
    box: d.boundingBox, // {originX, originY, width, height} in source coords
  }));
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function nmsMerge(dets, overlapThresh = 0.35) {
  const sorted = [...dets].sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  for (const d of sorted) {
    if (!kept.some(k => iou(k.bounds, d.bounds) >= overlapThresh)) kept.push(d);
  }
  return kept;
}

// Verification rescan (anti-hallucination)
// BlazeFace SHORT-RANGE hallucinates "faces" on page TEXTURES when run
// full-frame — on the demo page it fired 0.41–0.51 on the login form's grid of
// rounded inputs (user-visible as a face blur + black eye bar drawn over an
// EMPTY form area while the real ~64px avatar face stayed unredacted).
// Measured separation (demo page, 1150×734 CSS @ DPR 1.25):
//   • layout false positives : native 0.41–0.51, re-scan ≤ 0.65 at EVERY scale
//     (0.464 big-FP · 0 mid-FP · 0.213 notice-bar · 0.65 notice-bar weak hit)
//   • true 64px avatar face  : re-scan 0.87–0.94 at 96 / 160 / 224 px
// Threshold 0.75 = midpoint of the observed gap [0.65 … 0.87], nudged low to
// stay recall-friendly for a privacy filter (a missed face is worse than an
// extra blur). Field telemetry (verifiedDropped) lets us retune with real data.
export const FACE_VERIFY_CONF = 0.75;
const VERIFY_MARGIN = 1.5;
const VERIFY_TARGET_EDGE = 224;

const _verifyCanvas = (typeof document !== 'undefined') ? document.createElement('canvas') : null;

/**
 * Pure helper: crop rect (with context margin, clamped to the image) + the
 * rescale factor that brings the crop's min edge to ~targetEdge. Exported for
 * unit tests — no canvas/model involved.
 */
export function faceVerifyCrop(box, imgW, imgH, margin = VERIFY_MARGIN, targetEdge = VERIFY_TARGET_EDGE) {
  const mw = box.w * margin, mh = box.h * margin;
  const sx = Math.max(0, Math.round(box.x + box.w / 2 - mw / 2));
  const sy = Math.max(0, Math.round(box.y + box.h / 2 - mh / 2));
  const sw = Math.max(32, Math.min(imgW - sx, Math.round(mw)));
  const sh = Math.max(32, Math.min(imgH - sy, Math.round(mh)));
  const scale = Math.min(4, Math.max(0.05, targetEdge / Math.min(sw, sh)));
  return {
    sx, sy, sw, sh, scale,
    dw: Math.max(32, Math.round(sw * scale)),
    dh: Math.max(32, Math.round(sh * scale)),
  };
}

/**
 * Second-opinion pass over cascade candidates. Each box is re-detected on a
 * margin-cropped, rescaled view; candidates below FACE_VERIFY_CONF are dropped
 * (with telemetry) instead of being blurred onto random page furniture.
 * Person-crop-sourced hits are already produced by exactly this protocol
 * (upscaled crop re-detection inside detectFacesInPersonBoxes) and skip the
 * redundant re-check.
 */
async function verifyFaceCandidates(bmp, detections) {
  if (!_verifyCanvas || detections.length === 0) return { kept: detections, dropped: [] };
  const ctx = _verifyCanvas.getContext('2d', { willReadFrequently: false });
  const kept = [];
  const dropped = [];
  for (const d of detections) {
    if (d.source === 'mediapipe-person-crop') { kept.push(d); continue; }
    const c = faceVerifyCrop(d.bounds, bmp.width, bmp.height);
    _verifyCanvas.width = c.dw;
    _verifyCanvas.height = c.dh;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, c.sx, c.sy, c.sw, c.sh, 0, 0, c.dw, c.dh);
    const hits = await detectRaw(_verifyCanvas);
    const best = hits.reduce((m, h) => Math.max(m, h.score), 0);
    if (best >= FACE_VERIFY_CONF) {
      d.verifyScore = Math.round(best * 1000) / 1000;
      kept.push(d);
    } else {
      dropped.push({
        bounds: d.bounds,
        native: Math.round(Number(d.confidence) * 1000) / 1000,
        verify: Math.round(best * 1000) / 1000,
      });
    }
  }
  return { kept, dropped };
}

/**
 * Two-pass face detection with tile fallback for small faces.
 *
 * @param {ImageBitmap|HTMLImageElement|Blob|HTMLCanvasElement|string} image
 * @param {object} opts
 *   fullConf   - min score for the fast full-frame pass        (default 0.35)
 *   tileConf   - min score for per-tile detections             (default 0.30)
 *   tileSize   - tile edge in image px                         (default 512)
 *   overlap    - tile overlap fraction                         (default 0.25)
 *   maxTiles   - hard cap so huge pages stay bounded           (default 30)
 *   expand     - grow tile boxes by this factor                (default 1.15)
 * @returns {Promise<{detections: Array, debug: object}>}
 */
// ADAPTIVE FACE DETECTION
// Three measured optimizations, none of which lower the redaction bar:
//   1. DOWNSCALED FULL-FRAME PASS — MediaPipe resizes every input to 128×128
//      internally, so feeding the full 2560×1600 (DPR-2) capture only burns
//      preprocessing time. The full-frame pass now runs on a ≤1280px-long-edge
//      copy (≈4× fewer pixels) and boxes are mapped back — recall for faces
//      that full-frame could catch is unchanged; smaller faces remain the
//      tile sweeps' job (unchanged, full resolution).
//   2. UNCHANGED-SCREEN MEMO — identical pixels produce identical detections;
//      a 2-entry LRU keyed by a sampled content hash of the capture returns
//      them without re-running any model. Stores BOXES ONLY (never pixels),
//      in memory, in the offscreen document.
//   3. RISK-ADAPTIVE FINE-SWEEP CAP — the 256px fine sweep is the last-resort
//      recall stage for TINY faces (48 tiles ≈ half the total cost on face-less
//      pages). When the page shows NO face evidence (no videos, no canvases,
//      not visually heavy, structured page type) the cap is 16 tiles; the
//      YOLO person-guided sweep remains the backstop for tiny faces when a
//      person IS on screen. High-risk pages keep the full 48.
const _memo = new Map();
function memoGet(key) {
  if (!_memo.has(key)) return null;
  const v = _memo.get(key);
  _memo.delete(key); _memo.set(key, v); // LRU touch
  return v;
}
function memoSet(key, val) {
  _memo.set(key, val);
  if (_memo.size > 2) _memo.delete(_memo.keys().next().value);
}

const _ffCanvas = (typeof document !== 'undefined') ? document.createElement('canvas') : null;

export async function detectFacesTiled(image, opts = {}) {
  const cfg = {
    fullConf: 0.35,
    tileConf: 0.30,      // stage-2 sweep (512px tiles)
    fineTileConf: 0.28,  // stage-3 sweep (256px tiles — avatars / small faces)
    tileSize: 512,
    fineTileSize: 256,
    overlap: 0.25,
    maxTiles: 30,
    maxFineTiles: 48,       // HIGH-risk cap (v1.14)
    normalFineTiles: 16,    // NORMAL-risk cap (v1.14 adaptive)
    fullFrameMaxEdge: 1280, // v1.14 downscale the full-frame pass
    expand: 1.15,
    fineExpand: 1.2,
    memo: true,
    imageHash: null,
    riskHints: {},
    ...opts,
  };

  // Risk classification (SIH brief matrix):
  //   FACE-LIKELY / HIGH-RISK → full fine sweep (visually heavy, videos,
  //   canvases, social/media/email/profile/unknown pages)
  //   NORMAL + no evidence → capped fine sweep (lightweight pass)
  const h = cfg.riskHints || {};
  const highRisk = Boolean(
    h.visuallyHeavy || h.hasVideo || h.canvasHeavy ||
    ['social', 'media', 'email', 'profile', 'unknown'].includes(String(h.pageType || ''))
  );
  const fineCap = highRisk ? cfg.maxFineTiles : cfg.normalFineTiles;

  // MEMO: unchanged screens reuse the previous detections (boxes only).
  const memoKey = (cfg.memo && cfg.imageHash)
    ? `faces:${cfg.imageHash}:${cfg.fullFrameMaxEdge}:${cfg.maxTiles}:${fineCap}:${cfg.fullConf}:${cfg.tileConf}:${cfg.fineTileConf}`
    : null;
  if (memoKey) {
    const hit = memoGet(memoKey);
    if (hit) return { detections: hit.detections, debug: { ...hit.debug, memoHit: true, highRisk } };
  }

  const t0 = performance.now();
  const bmp = await ensureBitmap(image);
  const W = bmp.width, H = bmp.height;

  // Pass 1: full frame (fast path) — candidates are VERIFIED immediately
  // (see FACE_VERIFY_CONF above): BlazeFace hallucinates 0.4–0.5 "faces" on
  // page textures, and letting unverified hits suppress the tile sweeps is
  // exactly what left the demo page's real avatar unredacted while a phantom
  // blur + eye bar landed on the login form.
  // the pass runs on a downscaled copy (MediaPipe resizes to 128×128
  // internally — full-resolution input only wastes preprocessing); boxes are
  // mapped back to full-image coordinates before verification.
  let detectBmp = bmp;
  let ffScale = 1;
  const maxEdge = Math.max(W, H);
  if (_ffCanvas && maxEdge > cfg.fullFrameMaxEdge) {
    ffScale = cfg.fullFrameMaxEdge / maxEdge;
    _ffCanvas.width = Math.max(1, Math.round(W * ffScale));
    _ffCanvas.height = Math.max(1, Math.round(H * ffScale));
    const fctx = _ffCanvas.getContext('2d', { willReadFrequently: false });
    fctx.imageSmoothingEnabled = true;
    fctx.drawImage(bmp, 0, 0, _ffCanvas.width, _ffCanvas.height);
    detectBmp = _ffCanvas;
  }
  const fullRaw = await detectRaw(detectBmp);
  let merged = nmsMerge(fullRaw
    .filter(d => d.score >= cfg.fullConf)
    .map(d => ({
      type: 'face',
      confidence: d.score,
      source: 'mediapipe-face',
      bounds: {
        x: Math.round(d.box.originX / ffScale),
        y: Math.round(d.box.originY / ffScale),
        w: Math.round(d.box.width / ffScale),
        h: Math.round(d.box.height / ffScale),
      },
    })), 0.35);
  const nFull = merged.length;   // raw full-frame candidate count (telemetry)

  // Verification bookkeeping: every stage's candidates must survive the rescan
  // before they may (a) skip the later, finer stages and (b) reach the canvas.
  const tVerify0 = performance.now();
  const verifiedDropped = [];
  let candidatesBeforeVerify = 0;
  let stageKept = null;
  const verifyStage = async (label) => {
    if (!merged.length) return;
    candidatesBeforeVerify += merged.length;
    const vr = await verifyFaceCandidates(bmp, merged);
    verifiedDropped.push(...vr.dropped);
    merged = vr.kept;
    if (merged.length && !stageKept) stageKept = label;
  };
  await verifyStage('full-frame');

  // Tile sweep helper — shared by stage 2 (512px) and stage 3 (256px).
  // A smaller tile makes a face occupy a larger fraction of the detector's
  // 128×128 internal input — exactly what rescues small faces (avatars,
  // webcam overlays) that the coarser passes can't fire on.
  let tilesScanned = 0;
  let fineTilesScanned = 0;
  let rawTileHits = 0;
  const sweepTiles = async (tileSize, conf, maxTiles, expand) => {
    const step = Math.max(48, Math.round(tileSize * (1 - cfg.overlap)));
    const xs = [];
    for (let x = 0; x < W; x += step) xs.push(Math.min(x, Math.max(0, W - tileSize)));
    const ys = [];
    for (let y = 0; y < H; y += step) ys.push(Math.min(y, Math.max(0, H - tileSize)));

    let positions = [];
    const seen = new Set();
    for (const y of ys) for (const x of xs) {
      const key = `${x},${y}`;
      if (!seen.has(key)) { seen.add(key); positions.push({ x, y }); }
    }
    // Cap the number of tiles on very large pages — sample evenly.
    if (positions.length > maxTiles) {
      const stride = positions.length / maxTiles;
      positions = Array.from({ length: maxTiles }, (_, i) => positions[Math.floor(i * stride)]);
    }

    if (!_tileCanvas) return;
    const tctx = _tileCanvas.getContext('2d', { willReadFrequently: false });
    for (const pos of positions) {
      const sw = Math.min(tileSize, W - pos.x);
      const sh = Math.min(tileSize, H - pos.y);
      if (sw < 24 || sh < 24) continue;
      _tileCanvas.width = sw; _tileCanvas.height = sh;
      tctx.drawImage(bmp, pos.x, pos.y, sw, sh, 0, 0, sw, sh);
      const tileDets = await detectRaw(_tileCanvas);
      tilesScanned++;
      for (const d of tileDets) {
        if (d.score < conf) continue;
        rawTileHits++;
        const bw = d.box.width * expand;
        const bh = d.box.height * expand;
        const cx = d.box.originX + d.box.width / 2;
        const cy = d.box.originY + d.box.height / 2;
        merged.push({
          type: 'face',
          confidence: d.score,
          source: 'mediapipe-face-tile',
          bounds: {
            x: Math.max(0, Math.round(pos.x + cx - bw / 2)),
            y: Math.max(0, Math.round(pos.y + cy - bh / 2)),
            w: Math.min(W, Math.round(bw)),
            h: Math.min(H, Math.round(bh)),
          },
        });
      }
    }
    merged = nmsMerge(merged, 0.35);
  };

  // Pass 2: 512px tiled sweep — only when NO VERIFIED face exists yet and
  // the image is larger than one tile (small faces are exactly the failure
  // mode). Gated on VERIFIED results: unverified full-frame hits must never
  // suppress the sweeps that would find the real, smaller face.
  if (merged.length === 0 && (W > cfg.tileSize * 0.9 || H > cfg.tileSize * 0.9)) {
    await sweepTiles(cfg.tileSize, cfg.tileConf, cfg.maxTiles, cfg.expand);
    await verifyStage('tiles-512');
  }

  // Pass 3: 256px FINE sweep — only when BOTH earlier stages still have no
  // VERIFIED face. Demo-page bug: a ~65px circular avatar (the side panel
  // shrinks the viewport) is only ~16% of a 512px tile — below BlazeFace's
  // firing threshold; inside a 256px tile it's ~32% and the detector fires.
  // the tile CAP is risk-adaptive (48 high-risk / 16 normal) — see the
  // header note. Recall backstop on normal pages: the YOLO person-guided
  // sweep still runs when a person is detected.
  if (merged.length === 0 && (W > cfg.fineTileSize * 0.9 || H > cfg.fineTileSize * 0.9)) {
    const before = tilesScanned;
    await sweepTiles(cfg.fineTileSize, cfg.fineTileConf, fineCap, cfg.fineExpand);
    fineTilesScanned = tilesScanned - before;
    await verifyStage('tiles-256');
  }

  merged = nmsMerge(merged, 0.35);
  const verifyMs = Math.round(performance.now() - tVerify0);
  _stats.verifyDropped += verifiedDropped.length;

  _stats.tiledCalls++;
  if (merged.length) _stats.tiledHits++;
  const ms = Math.round(performance.now() - t0);
  const out = {
    detections: merged,
    debug: {
      width: W, height: H, fullFrameDets: nFull, tilesScanned, fineTilesScanned, rawTileHits,
      candidatesBeforeVerify, verifiedDropped, verifyMs, stageKept, totalMs: ms,
      ffScale, highRisk, fineCap, memoHit: false,
    },
  };
  if (memoKey) memoSet(memoKey, { detections: merged, debug: out.debug });
  return out;
}

// Person-guided face sweep
// Last-resort recall boost: YOLO found person(s) but MediaPipe found no
// faces (tiny avatars, heavily downscaled layouts). Crop each person box,
// upscale it so the crop's smallest edge ≈ MIN_CROP_EDGE, and re-run the
// detector on just that region — a ~65px avatar face becomes ~200px inside
// the crop, which BlazeFace detects reliably. Hit boxes are mapped back to
// full-image coordinates and NMS-merged.
const MIN_CROP_EDGE = 256;
const _cropCanvas = (typeof document !== 'undefined') ? document.createElement('canvas') : null;

export async function detectFacesInPersonBoxes(image, boxes, opts = {}) {
  const cfg = { conf: 0.30, expand: 1.12, minEdge: MIN_CROP_EDGE, maxScale: 4, grow: 1.15, sourceLabel: 'mediapipe-person-crop', ...opts };
  const bmp = await ensureBitmap(image);
  const hits = [];
  let regionsScanned = 0;
  if (_cropCanvas) {
    const ctx = _cropCanvas.getContext('2d', { willReadFrequently: false });
    for (const b of boxes || []) {
      if (!b || b.w <= 0 || b.h <= 0) continue;
      // Expand the person box slightly and clamp it to the image.
      const ebw = b.w * cfg.expand, ebh = b.h * cfg.expand;
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const sx = Math.max(0, Math.round(cx - ebw / 2));
      const sy = Math.max(0, Math.round(cy - ebh / 2));
      const sw = Math.min(bmp.width - sx, Math.round(ebw));
      const sh = Math.min(bmp.height - sy, Math.round(ebh));
      if (sw < 32 || sh < 32) continue;
      // Upscale small crops — the face must occupy a decent fraction of the
      // detector's input to fire. Cap so no crop exceeds 768px on its long edge.
      const scale = Math.max(1, Math.min(cfg.maxScale, cfg.minEdge / Math.min(sw, sh), 768 / Math.max(sw, sh)));
      const dw = Math.round(sw * scale);
      const dh = Math.round(sh * scale);
      _cropCanvas.width = dw; _cropCanvas.height = dh;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, dw, dh);
      const dets = await detectRaw(_cropCanvas);
      regionsScanned++;
      for (const d of dets) {
        if (d.score < cfg.conf) continue;
        const gw = (d.box.width / scale) * cfg.grow;
        const gh = (d.box.height / scale) * cfg.grow;
        const gcx = sx + (d.box.originX + d.box.width / 2) / scale;
        const gcy = sy + (d.box.originY + d.box.height / 2) / scale;
        hits.push({
          type: 'face',
          confidence: d.score,
          source: cfg.sourceLabel,
          bounds: {
            x: Math.max(0, Math.round(gcx - gw / 2)),
            y: Math.max(0, Math.round(gcy - gh / 2)),
            w: Math.min(bmp.width, Math.round(gw)),
            h: Math.min(bmp.height, Math.round(gh)),
          },
        });
      }
    }
  }
  return { detections: nmsMerge(hits, 0.35), debug: { regionsScanned } };
}

export function getFaceDetectorStats() {
  return { ..._stats, avgMs: _stats.calls ? Math.round(_stats.totalMs / _stats.calls) : 0 };
}

/** Testability: reset nothing, just expose the verify config. */
export function getFaceVerifyConfig() {
  return { conf: FACE_VERIFY_CONF, margin: VERIFY_MARGIN, targetEdge: VERIFY_TARGET_EDGE };
}

export function isFaceDetectorReady() {
  return _faceDetector !== null;
}

/**
 * Release the underlying model + WASM.  Useful when the user disables
 * Privacy Mode to free memory.
 */
export async function disposeFaceDetector() {
  try { _faceDetector?.close?.(); } catch {}
  _faceDetector = null;
  _initPromise = null;
  _vision = null;
}
