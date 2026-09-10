// ─────────────────────────────────────────────────────────────────────────────
// src/lib/local-llm-engine.js
// The on-device model ENGINE — runs ONLY inside the offscreen document.
//
// Why the offscreen document? MV3 service workers forbid dynamic import()
// (see w3c/ServiceWorker#1356) and expose no DOM/canvas. Transformers.js is
// loaded here via a normal dynamic import from the locally vendored bundle,
// WebGPU + Cache APIs are fully available, and long downloads / generations
// are not subject to the service worker's 30s idle termination.
//
// Responsibilities:
//   • getTransformers   — lazy import of vendored Transformers.js + ORT wiring
//   • downloadLocalModel— streams weights from HuggingFace into Cache API
//                         with rich per-file logging + progress broadcasts
//   • deleteLocalModel  — evicts a model's cache entries + in-memory runtime
//   • generateLocal     — single-shot generate (VLM: image+text → text)
// ─────────────────────────────────────────────────────────────────────────────

import {
  getLocalModelDef,
  EMBEDDINGS_MODEL,
  readStatuses,
  writeStatus,
  broadcast,
  mlLog,
  mlWarn,
  mlError,
  fmtMB,
  hasWebGPUInContext,
  probeWebGPUAdapter,
} from './local-models-shared.js';
import { describeHttpError } from '../core/logger.js';

const TRANSFORMERS_URL = new URL('../vendor/transformers/transformers.min.js', import.meta.url).href;
const ORT_BASE_URL = new URL('../vendor/transformers/ort/', import.meta.url).href;

/** Vision auto-class resolver. transformers.js v4 moved multimodal models
 *  (lfm2_vl, qwen2_vl, gemma4, …) into the IMAGE_TEXT_TO_TEXT mapping; the
 *  legacy AutoModelForVision2Seq mapping throws "Unsupported model type" for
 *  them. Prefer the modern class, fall back on older bundles. */
const visionAutoClass = (tr) => tr.AutoModelForImageTextToText || tr.AutoModelForVision2Seq;

// ── Module state ───────────────────────────────────────────────────────────────
let _transformers = null;
let _device = null;                       // 'webgpu' | 'wasm' (cached detection)
let _adapterProbed = false;               // deep WebGPU probe done?
const _runtime = {};                      // id → { model, processor, tokenizer, pipeline, device, dtype }
const _downloads = {};                    // id → Promise (dedupe concurrent downloads)
// Session KV caches (gemma4-browser-extension pattern): sessionId →
// { ids: number[] (token ids already in the cache), cache: DynamicCache }
const _kvSessions = new Map();
const KV_SESSION_LIMIT = 2;

export function getEngineDevice() {
  if (_device) return _device;
  _device = hasWebGPUInContext() ? 'webgpu' : 'wasm';
  return _device;
}

/** Live download ids — lets the SW distinguish a REAL in-flight download from
 *  a stale persisted "downloading" status after a browser/SW restart. */
export function activeDownloadIds() {
  return Object.keys(_downloads);
}

// ── Checkpoint resume (Cache API preflight) ────────────────────────────────────
// Transformers.js stores every FULLY-downloaded file in the browser Cache API
// under its HF resolve-URL (env.cacheKey = "transformers-cache"). A cache entry
// therefore exists only for complete files — a perfect byte-level checkpoint.
// Scanning it before a download lets an interrupted download (browser closed
// mid-way, crash, SW restart) CONTINUE from its real progress: cached files
// are re-served instantly from disk by Transformers.js, and only the missing
// files are actually fetched from HuggingFace.
export async function preflightCachedFiles(def) {
  const empty = { files: {}, bytes: 0, count: 0 };
  try {
    if (typeof caches === 'undefined' || !def?.repo) return empty;
    const cache = await caches.open('transformers-cache');
    const keys = await cache.keys();
    const files = {};
    let bytes = 0, count = 0;
    for (const req of keys) {
      const url = req.url || '';
      if (!url.includes('/' + def.repo + '/') || !url.includes('/resolve/')) continue;
      // "…/<repo>/resolve/<revision>/<file path>" → progress callbacks use the
      // file path WITHOUT the revision segment (e.g. "onnx/decoder_q4f16.onnx").
      const file = (url.split('/resolve/')[1] || '').split('/').slice(1).join('/');
      if (!file) continue;
      let size = 0;
      try {
        const resp = await cache.match(url);
        // Stored responses keep their HF headers — Content-Length is the
        // authoritative byte size (same header Transformers.js itself reads).
        size = parseInt(resp?.headers?.get('content-length') || '0', 10) || 0;
      } catch { size = 0; }
      files[file] = { loaded: size, total: size, done: true, cached: true };
      bytes += size;
      count += 1;
    }
    return { files, bytes, count };
  } catch (e) {
    mlWarn('Cache preflight failed (starting from zero):', String(e?.message || e));
    return empty;
  }
}

// Deep adapter probe (runs once): navigator.gpu presence is not enough — some
// devices expose it without a usable adapter. The result may demote us to wasm.
export async function ensureDevice() {
  if (_adapterProbed && _device) return _device;
  _adapterProbed = true;
  if (getEngineDevice() !== 'webgpu') return _device;
  const probe = await probeWebGPUAdapter();
  if (!probe.supported) {
    mlWarn(`WebGPU adapter unavailable (${probe.reason || 'unknown'}) — falling back to WASM.`);
    _device = 'wasm';
    broadcast({ type: 'LOCAL_MODEL_DEVICE', device: _device });
  } else {
    mlLog(`WebGPU adapter ready${probe.vendor ? ' · ' + probe.vendor : ''}${probe.architecture ? ' ' + probe.architecture : ''}`);
  }
  return _device;
}

/** Dispose one session's KV cache (call on chat reset / session change). */
export function disposeSessionCache(sessionId) {
  const entry = _kvSessions.get(sessionId);
  if (!entry) return;
  try { entry.cache?.dispose?.(); } catch {}
  _kvSessions.delete(sessionId);
  mlLog(`KV cache disposed for session ${String(sessionId).substring(0, 12)}…`);
}

function resetKvSessions() {
  for (const [, entry] of _kvSessions) { try { entry.cache?.dispose?.(); } catch {} }
  _kvSessions.clear();
}

// ── Runtime bootstrap ──────────────────────────────────────────────────────────
async function getTransformers() {
  if (_transformers) return _transformers;
  const t0 = performance.now();
  mlLog('Loading Transformers.js runtime from vendored bundle…');
  // Dynamic import() is perfectly legal here — we are a regular page context.
  const tr = await import(/* webpackIgnore: true */ TRANSFORMERS_URL);

  // Point ORT at the locally vendored wasm assets (keeps us CSP-clean + offline).
  // ⚠ The artifact set MUST come from the SAME onnxruntime-web build as the
  // vendored esm bundle (ort.webgpu.bundle.min.mjs of onnxruntime-web
  // 1.26.0-dev.20260416). That build's WebGPU EP bootstraps itself by calling
  // webgpuInit() ON the instance created from the .mjs artifact — the newer
  // "asyncify" artifacts export it, the older "jsep" artifacts do NOT. Pairing
  // the new esm with jsep artifacts failed with:
  //   "no available backend found. ERR: [webgpu] TypeError: ...webgpuInit is not a function"
  // v1.8: disable the ORT-wasm pre-cache FIRST and OUTSIDE the try block.
  // Previously it was the last statement inside the try — any throw above it
  // left env.useWasmCache at its default (true) and the preloader then routed
  // the wasm artifacts through the Cache API, which REJECTS chrome-extension://
  // URLs ("Failed to execute 'put' on 'Cache': Request scheme 'chrome-extension'
  // is unsupported"). The vendored artifacts are local bundle files — nothing
  // to cache; ORT loads them straight from the extension via wasmPaths below.
  tr.env.useWasmCache = false;
  try {
    tr.env.backends.onnx.wasm.wasmPaths = {
      mjs: ORT_BASE_URL + 'ort-wasm-simd-threaded.asyncify.mjs',
      wasm: ORT_BASE_URL + 'ort-wasm-simd-threaded.asyncify.wasm',
    };
    // Threads need cross-origin isolation; extension pages don't have it.
    tr.env.backends.onnx.wasm.numThreads = 1;
    // Official env override kept as belt-and-braces documentation (set above
    // the try so it can never be skipped):
    //   "Failed to execute 'put' on 'Cache': Request scheme 'chrome-extension'
    //    is unsupported"
    // The vendored artifacts are local bundle files — nothing to cache; ORT
    // loads them straight from the extension via wasmPaths above.
  } catch (e) {
    mlWarn('ORT wasm wiring failed:', String(e?.message || e));
  }

  tr.env.allowLocalModels = false;          // weights come from the HF hub
  tr.env.useBrowserCache = true;            // Cache API — survives restarts
  _transformers = tr;
  mlLog(`Transformers.js ready in ${Math.round(performance.now() - t0)}ms · backend=${getEngineDevice()}`);
  return tr;
}

// ── Download / delete ──────────────────────────────────────────────────────────
export async function downloadLocalModel(id) {
  const def = getLocalModelDef(id);
  if (!def) return { ok: false, error: `Unknown local model: ${id}` };
  if (_downloads[id]) {
    mlLog(`Download already in flight for ${def.name} — joining.`);
    return _downloads[id];
  }

  const task = (async () => {
    const startedAt = Date.now();
    const device = await ensureDevice();

    // WebGPU-only models (Gemma 4 E2B/E4B: MoE multimodal, multi-GB all-component
    // builds; Granite 4.0 Micro: q4f16-only weights) must fail FAST and with a
    // clear message — never after a multi-GB download that could never run.
    // NOTE: no writeStatus('error') here — the catalog UI gates these models
    // with a disabled button on WASM machines; writing an error status would
    // flip the card into a pointless "Retry download" state.
    if (def.requiresWebGPU && device !== 'webgpu') {
      const msg = `${def.name} needs WebGPU, which is not available on this machine (no usable GPU adapter). On WASM-only devices use Granite 4.0 1B or LFM2-VL 450M — both ship _q4 weights that fit and run on CPU.`;
      mlError(`DOWNLOAD BLOCKED "${def.name}": ${msg}`);
      return { ok: false, error: msg };
    }

    const dtype = def.dtypes[device] || def.dtypes.wasm || 'q4f16';

    mlLog(`DOWNLOAD START "${def.name}" (${def.id}) repo=${def.repo} device=${device} dtype=${JSON.stringify(dtype)}`);

    const tr = await getTransformers();

    // CHECKPOINT RESUME — scan the Cache API for files this model ALREADY has
    // on disk (previous session / interrupted download) and pre-seed the
    // progress aggregate with them. Transformers.js serves cached files
    // instantly, so only the missing files are really fetched and the UI
    // starts at the true checkpoint (e.g. 33%) instead of flashing 0%.
    const pre = await preflightCachedFiles(def);
    const files = pre.files;                     // file → {loaded,total,done,cached?}
    const cachedCount = pre.count;
    const cachedBytes = pre.bytes;
    let lastBroadcast = 0;
    let lastPersist = 0;
    let lastPctLogged = -10;
    // NOTE: lastPctLogged must be DIP-AWARE. When a big file registers its
    // total, the aggregate pct can FALL back (tiny config files push it to
    // 99% before the multi-GB weights report in) — without re-baselining,
    // pct never clears the log threshold again and the console goes silent
    // for the rest of a multi-GB download.
    let lastSpeedAt = Date.now();                // rolling MB/s between logged steps
    let lastSpeedBytes = 0;

    const aggregate = () => {
      let loaded = 0, total = 0;
      for (const f of Object.values(files)) { loaded += f.loaded; total += f.total; }
      return { loaded, total, pct: total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0 };
    };

    const onProgress = (p) => {
      if (!p || typeof p !== 'object') return;
      if (p.status === 'initiate' && p.file) {
        // NEVER clobber a pre-seeded cache entry: a cached file may still emit
        // initiate before its instant cache-hit 'done', and resetting it to 0
        // would make the progress bar dip backwards mid-resume.
        if (!files[p.file]) files[p.file] = { loaded: 0, total: p.total || 0, done: false };
        else if (!files[p.file].total && p.total) files[p.file].total = p.total;
        mlLog(`  ↓ fetch ${p.file} ${p.total ? '(' + fmtMB(p.total) + ')' : ''}`);
      } else if (p.status === 'progress' && p.file) {
        files[p.file] = { ...(files[p.file] || { total: 0, done: false }), loaded: p.loaded || 0, total: p.total || 0 };
        const { loaded, total, pct } = aggregate();

        // Realtime console log every ~5% aggregate, with download speed.
        if (pct < lastPctLogged) {
          lastPctLogged = pct;                     // totals just registered — re-baseline on the dip
        } else if (pct - lastPctLogged >= 5) {
          lastPctLogged = pct - (pct % 5);
          const nowMs = Date.now();
          const dt = (nowMs - lastSpeedAt) / 1000;
          const mbDelta = (loaded - lastSpeedBytes) / (1024 * 1024);
          const speed = dt >= 1 && mbDelta >= 0 ? mbDelta / dt : null;
          if (speed !== null) { lastSpeedAt = nowMs; lastSpeedBytes = loaded; }
          mlLog(`  ${pct}% · ${fmtMB(loaded)}${total ? ' / ' + fmtMB(total) : ''}${speed !== null ? ` · ${speed.toFixed(1)} MB/s` : ` · ${((nowMs - startedAt) / 1000).toFixed(0)}s elapsed`}`);
        }

        const now = Date.now();
        if (now - lastBroadcast > 400 || pct >= 99) {   // throttle UI churn
          lastBroadcast = now;
          broadcast({ type: 'LOCAL_MODEL_PROGRESS', modelId: id, status: 'downloading', progress: pct, file: p.file, loaded, total });
          // Crash-checkpoint: persist the running bytes so a browser close /
          // crash mid-download resumes from HERE instead of restarting at 0.
          if (now - lastPersist > 2500) {
            lastPersist = now;
            writeStatus(id, { status: 'downloading', progress: pct, bytesLoaded: loaded, bytesTotal: total })
              .catch(() => {});
          }
        }
      } else if (p.status === 'done' && p.file) {
        // Cache-hit files can fire 'done' without a prior progress event and
        // even without an initiate we saw — accept both, keep the max loaded.
        const f = files[p.file] || (files[p.file] = { loaded: 0, total: 0, done: false });
        if (p.loaded) f.total = Math.max(f.total, p.loaded);
        f.loaded = Math.max(f.loaded, p.loaded || f.total || 0);
        if (!f.done) {
          f.done = true;
          // Always show the running total on every finished file so the
          // console reflects progress even between the 5% aggregate steps.
          const d = aggregate();
          mlLog(`  ✓ ${p.file} cached (${fmtMB(f.loaded)}) · ${d.pct}% of total`);
        }
      } else if (p.status === 'ready') {
        mlLog('  session ready event');
      } else if (p.status === 'initiate' || p.status === 'download') {
        // other lifecycle events — ignore
      }
    };

    try {
      // Seed status + UI with the checkpoint BEFORE from_pretrained runs —
      // the very first thing the user sees on resume is the true %, not 0%.
      const seed = aggregate();
      if (cachedCount > 0) {
        mlLog(`RESUME "${def.name}": ${cachedCount} file(s) already in cache (${fmtMB(cachedBytes)}) — continuing from ${seed.pct}%. Only missing files are fetched; cached files are re-served instantly.`);
      }
      await writeStatus(id, { status: 'downloading', progress: seed.pct, error: '', bytesLoaded: seed.loaded, bytesTotal: seed.total });
      broadcast({ type: 'LOCAL_MODEL_PROGRESS', modelId: id, status: 'downloading', progress: seed.pct, loaded: seed.loaded, total: seed.total, resumed: cachedCount > 0 });

      if (def.kind === 'vlm') {
        mlLog('Fetching processor + tokenizer…');
        await tr.AutoProcessor.from_pretrained(def.repo, { progress_callback: onProgress });
        mlLog('Fetching VLM weights (this is the big one)…');
        await visionAutoClass(tr).from_pretrained(def.repo, { device, dtype, progress_callback: onProgress });
      } else if (def.kind === 'gemma4') {
        // Gemma 4 multimodal MoE — processor + Gemma4ForConditionalGeneration
        // (pyimagesearch / gemma4-browser-extension pattern).
        mlLog('Fetching Gemma 4 processor + tokenizer…');
        await tr.AutoProcessor.from_pretrained(def.repo, { progress_callback: onProgress });
        mlLog('Fetching Gemma 4 weights (this is the big one)…');
        const cls = tr.Gemma4ForConditionalGeneration || visionAutoClass(tr);
        await cls.from_pretrained(def.repo, { device, dtype, progress_callback: onProgress });
      } else if (def.kind === 'embeddings') {
        mlLog('Fetching embeddings model (tokenizer + encoder weights)…');
        await tr.pipeline('feature-extraction', def.repo, { device, dtype, progress_callback: onProgress });
      } else {
        mlLog('Fetching tokenizer…');
        await tr.AutoTokenizer.from_pretrained(def.repo, { progress_callback: onProgress });
        mlLog('Fetching LLM weights…');
        await tr.AutoModelForCausalLM.from_pretrained(def.repo, { device, dtype, progress_callback: onProgress });
      }

      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      const totalBytes = Object.values(files).reduce((a, f) => a + (f.total || f.loaded || 0), 0);
      mlLog(`  100% · all files cached`);
      mlLog(`DOWNLOAD COMPLETE "${def.name}" · ${fmtMB(totalBytes)} in ${secs}s · cached for offline use`);
      await writeStatus(id, {
        status: 'downloaded', progress: 100, downloadedAt: Date.now(), error: '',
        bytesTotal: totalBytes || undefined,
      });
      broadcast({ type: 'LOCAL_MODEL_PROGRESS', modelId: id, status: 'downloaded', progress: 100 });
      return { ok: true, modelId: id };
    } catch (err) {
      const message = String(err?.message || err || 'Download failed');
      mlError(`DOWNLOAD FAILED "${def.name}": ${message} — ${describeHttpError(err)}`, err?.stack || '');
      await writeStatus(id, { status: 'error', error: message });
      broadcast({ type: 'LOCAL_MODEL_PROGRESS', modelId: id, status: 'error', error: message });
      return { ok: false, error: message };
    } finally {
      delete _downloads[id];
    }
  })();

  _downloads[id] = task;
  return task;
}

export async function deleteLocalModel(id) {
  const def = getLocalModelDef(id);
  if (!def) return { ok: false, error: `Unknown local model: ${id}` };
  try {
    mlLog(`DELETE "${def.name}" — evicting cache entries + in-memory runtime.`);
    delete _runtime[id];
    resetKvSessions();
    if (typeof caches !== 'undefined') {
      const cache = await caches.open('transformers-cache');
      const keys = await cache.keys();
      const victims = keys.filter(req => String(req.url).includes(def.repo));
      await Promise.all(victims.map(req => cache.delete(req)));
      mlLog(`  removed ${victims.length} cache entr${victims.length === 1 ? 'y' : 'ies'}`);
    }
    await writeStatus(id, { status: 'not-downloaded', progress: 0, error: '', downloadedAt: null });
    broadcast({ type: 'LOCAL_MODEL_PROGRESS', modelId: id, status: 'not-downloaded', progress: 0 });
    return { ok: true };
  } catch (err) {
    mlWarn(`DELETE failed for ${id}:`, String(err?.message || err));
    return { ok: false, error: String(err?.message || err) };
  }
}

// ── Pipeline loading ───────────────────────────────────────────────────────────
async function ensureRuntime(id) {
  const def = getLocalModelDef(id);
  if (!def) throw new Error(`Unknown local model: ${id}`);
  if (_runtime[id]) return { def, ..._runtime[id] };

  const statuses = await readStatuses();
  if (statuses[id]?.status !== 'downloaded') {
    throw new Error(`"${def.name}" is not downloaded yet. Open Settings → AI & Models → On-device to download it.`);
  }

  const tr = await getTransformers();
  const device = await ensureDevice();
  if (def.requiresWebGPU && device !== 'webgpu') {
    throw new Error(`${def.name} needs WebGPU — unavailable on this machine. Its q4f16 weights cannot run on the WASM fallback.`);
  }
  const dtype = def.dtypes[device] || def.dtypes.wasm || 'q4f16';

  mlLog(`LOAD "${def.name}" from cache (device=${device} dtype=${JSON.stringify(dtype)})…`);
  const t0 = performance.now();
  let rt;
  if (def.kind === 'vlm') {
    const processor = await tr.AutoProcessor.from_pretrained(def.repo);
    const model = await visionAutoClass(tr).from_pretrained(def.repo, { device, dtype });
    rt = { model, processor, device, dtype };
  } else if (def.kind === 'gemma4') {
    // Gemma 4: AutoProcessor (image/audio+text) + Gemma4ForConditionalGeneration
    // (pyimagesearch / gemma4-browser-extension loading pattern).
    const processor = await tr.AutoProcessor.from_pretrained(def.repo);
    const cls = tr.Gemma4ForConditionalGeneration || visionAutoClass(tr);
    const model = await cls.from_pretrained(def.repo, { device, dtype });
    rt = { model, processor, device, dtype, isGemma4: true };
  } else if (def.kind === 'embeddings') {
    const pipe = await tr.pipeline('feature-extraction', def.repo, { device, dtype });
    rt = { pipeline: pipe, tokenizer: pipe.tokenizer, device, dtype };
  } else {
    const tokenizer = await tr.AutoTokenizer.from_pretrained(def.repo);
    const model = await tr.AutoModelForCausalLM.from_pretrained(def.repo, { device, dtype });
    rt = { model, tokenizer, device, dtype };
  }
  mlLog(`  model ready in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  _runtime[id] = rt;
  return { def, ...rt };
}

// ── Generation ─────────────────────────────────────────────────────────────────
function composeUserText(prompt, systemPrompt) {
  return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

// Gemma 4 occasionally leaks its end-of-text special token into decoded prose
// (gemma4-browser-extension sanitises the same way).
const END_OF_TEXT_RE = /<\|end_of_text\|>/g;
const sanitizeModelText = (t) => String(t || '').replace(END_OF_TEXT_RE, '').trim();

async function rawImageFrom(dataUrl, tr) {
  if (!dataUrl) return null;
  if (dataUrl.startsWith('data:')) {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    return tr.RawImage.fromBlob(blob);
  }
  return tr.RawImage.fromURL(dataUrl);
}

/**
 * Single-shot generation with the gemma4-browser-extension superpowers:
 *   • tools        — WebMCP-style tool declarations passed to apply_chat_template
 *                    (native tool calling on Gemma 4 / Granite 4 lineups)
 *   • sessionId    — DynamicCache KV reuse across turns: when the new rendered
 *                    prompt extends the cached one with an EXACT token prefix,
 *                    only the delta is pre-filled (fast agent loop)
 *   • stream       — tokens broadcast as LOCAL_MODEL_TOKEN (throttled) so the
 *                    sidepanel shows live output
 * @returns {Promise<{text: string, modelId: string, device: string, metrics: object, kvReused: boolean}>}
 */
export async function generateLocal(params = {}) {
  // Busy guard: the WebGPU/WASM backend is single-instance — a second
  // concurrent generation would thrash GPU memory and corrupt KV caches.
  if (_generating) {
    mlWarn(`BUSY: a generation is already running — request for "${params.modelId || '?'}" rejected. Stop the agent or wait for it to finish.`);
    throw new Error('On-device model is busy — another generation is already running.');
  }
  _generating = true;
  try {
    return await runGeneration(params);
  } catch (err) {
    mlError(`GENERATE FAILED "${params.modelId || '?'}": ${String(err?.message || err)} — ${describeHttpError(err)}`, err?.stack || '');
    throw err;
  } finally {
    _generating = false;
  }
}

let _generating = false;
async function runGeneration({ modelId, prompt, imageDataUrl = null, systemPrompt = '', maxNewTokens = 700, tools = null, sessionId = '', stream = false }) {
  if (!prompt) throw new Error('Empty prompt for local model.');
  const { def, model, processor, tokenizer, device } = await ensureRuntime(modelId);
  const tr = await getTransformers();
  const userText = composeUserText(prompt, systemPrompt);

  const t0 = performance.now();
  mlLog(`GENERATE "${def.name}" · prompt=${prompt.length} chars${imageDataUrl ? ' · +image' : ''}${Array.isArray(tools) && tools.length ? ' · +tools(' + tools.length + ')' : ''} · maxNewTokens=${maxNewTokens}`);

  const useTools = Array.isArray(tools) && tools.length > 0;
  let firstTokenAt = null;
  let streamed = '';
  let kvReused = false;

  const makeStreamer = (tok) => {
    if (!stream || !tok || !tr.TextStreamer) return undefined;
    let last = 0;
    return new tr.TextStreamer(tok, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text) => {
        if (!text) return;
        if (firstTokenAt === null) firstTokenAt = performance.now();
        streamed += text;
        const now = Date.now();
        if (now - last > 150) {
          last = now;
          broadcast({ type: 'LOCAL_MODEL_TOKEN', sessionId, modelId, text: streamed.slice(-400), ts: now });
        }
      },
    });
  };

  const finishMetrics = (outText, genTokens) => {
    const totalMs = Math.round(performance.now() - t0);
    const prefillMs = Math.round((firstTokenAt ?? performance.now()) - t0);
    const decodeMs = Math.max(0, totalMs - prefillMs);
    const tokens = genTokens > 0 ? genTokens : Math.max(1, Math.round(outText.length / 4));
    return {
      generatedTokens: tokens,
      totalMs, prefillMs, decodeMs,
      tokensPerSecond: decodeMs > 0 ? +(tokens / (decodeMs / 1000)).toFixed(1) : 0,
      msPerToken: tokens > 0 ? +(decodeMs / tokens).toFixed(1) : 0,
    };
  };

  const idsFromTensor = (tensor) => {
    try {
      const list = tensor.tolist();
      return Array.isArray(list?.[0]) ? list[0].map(Number) : list.map(Number);
    } catch { return null; }
  };

  // ── Vision path (VLM / Gemma 4 with an image attached) ─────────────────────
  // Text-only prompts on a VLM must NOT call processor() without an image —
  // LFM2-VL's preprocess iterates its images argument and throws
  // "undefined is not iterable". They take the tokenizer-only path below.
  const wantsVision = def.kind === 'vlm' || def.isGemma4;
  const image = wantsVision ? await rawImageFrom(imageDataUrl, tr) : null;
  if (wantsVision && image) {
    const content = [{ type: 'image' }, { type: 'text', text: userText }];
    const messages = [{ role: 'user', content }];
    const templateOpts = { add_generation_prompt: true, tokenize: false };
    if (useTools) templateOpts.tools = tools;
    const templated = processor.apply_chat_template(messages, templateOpts);
    const inputs = image ? await processor(templated, image) : await processor(templated);
    const outputs = await model.generate({
      ...inputs,
      max_new_tokens: maxNewTokens,
      do_sample: false,
      streamer: makeStreamer(processor.tokenizer),
    });
    const inputLen = Number(inputs.input_ids.dims.at(-1));
    const decoded = processor.tokenizer.batch_decode(
      outputs.slice(null, [inputLen, null]),
      { skip_special_tokens: true }
    );
    const outText = sanitizeModelText(decoded[0]);
    const genTokens = idsFromTensor(outputs.slice(null, [inputLen, null]))?.length || 0;
    const metrics = finishMetrics(outText, genTokens);
    mlLog(`GENERATE DONE · ${outText.length} chars · ${(metrics.totalMs / 1000).toFixed(1)}s · ${metrics.tokensPerSecond} tok/s`);
    if (stream && outText) broadcast({ type: 'LOCAL_MODEL_TOKEN', sessionId, modelId, text: outText.slice(-400), done: true, ts: Date.now() });
    return { text: outText, modelId, device, metrics, kvReused };
  }

  // ── Text-only path (llm / gemma4 text-only) ─────────────────────────────────
  const messages = [{ role: 'user', content: userText }];
  const templateOpts = { add_generation_prompt: true, tokenize: false };
  if (useTools) templateOpts.tools = tools;
  // VLM runtimes carry their tokenizer inside the processor.
  const tok = tokenizer || processor?.tokenizer;
  if (!tok) throw new Error(`No tokenizer available for "${def.name}".`);
  const templated = tok.apply_chat_template(messages, templateOpts);
  const encoded = tok(templated);
  const promptIds = idsFromTensor(encoded.input_ids) || [];

  // KV-cache reuse — gated on an EXACT token-prefix match (never approximate,
  // so correctness never depends on the cache).
  let generateInputs = { ...encoded };
  let pastKeyValues = null;
  if (sessionId && promptIds.length) {
    const prev = _kvSessions.get(sessionId);
    if (prev && prev.ids.length > 0
        && promptIds.length > prev.ids.length
        && prev.ids.every((tok, i) => tok === promptIds[i])) {
      try {
        const delta = promptIds.slice(prev.ids.length);
        const TensorCtor = encoded.input_ids.constructor;
        generateInputs = { input_ids: new TensorCtor('int64', BigInt64Array.from(delta.map(v => BigInt(v))), [1, delta.length]) };
        pastKeyValues = prev.cache;
        kvReused = true;
        mlLog(`KV cache HIT · ${prev.ids.length} cached tokens · prefilling only ${delta.length} new`);
      } catch (e) {
        mlWarn('KV reuse failed — falling back to full prefill:', String(e?.message || e));
        generateInputs = { ...encoded };
        pastKeyValues = null;
        kvReused = false;
      }
    } else if (prev) {
      try { prev.cache?.dispose?.(); } catch {}
      _kvSessions.delete(sessionId);
    }
  }

  const outputs = await model.generate({
    ...generateInputs,
    ...(pastKeyValues ? { past_key_values: pastKeyValues } : {}),
    max_new_tokens: maxNewTokens,
    do_sample: false,
    streamer: makeStreamer(tok),
  });

  const inputLen = Number(generateInputs.input_ids?.dims?.at(-1) ?? encoded.input_ids.dims.at(-1));
  const genSlice = outputs.slice(null, [inputLen, null]);
  const decoded = tok.batch_decode(genSlice, { skip_special_tokens: true });
  const outText = sanitizeModelText(decoded[0] || '');

  // Store/extend the session cache (prompt + generated tokens all have KV).
  if (sessionId) {
    try {
      const genIds = idsFromTensor(genSlice) || [];
      const prev = _kvSessions.get(sessionId);
      const fullIds = (kvReused && prev)
        ? [...prev.ids, ...promptIds.slice(prev.ids.length), ...genIds]
        : [...promptIds, ...genIds];
      const newCache = outputs.past_key_values || pastKeyValues;
      if (newCache && fullIds.length && fullIds.length < 24000) {
        if (_kvSessions.size >= KV_SESSION_LIMIT && !_kvSessions.has(sessionId)) {
          disposeSessionCache(_kvSessions.keys().next().value);
        }
        _kvSessions.set(sessionId, { ids: fullIds, cache: newCache });
      }
    } catch (e) {
      mlWarn('KV cache update skipped:', String(e?.message || e));
    }
  }

  const genTokens = idsFromTensor(genSlice)?.length || 0;
  const metrics = finishMetrics(outText, genTokens);
  mlLog(`GENERATE DONE · ${outText.length} chars · ${(metrics.totalMs / 1000).toFixed(1)}s · ${metrics.generatedTokens} tok · ${metrics.tokensPerSecond} tok/s${kvReused ? ' · kv-reused' : ''}`);
  if (stream && outText) broadcast({ type: 'LOCAL_MODEL_TOKEN', sessionId, modelId, text: outText.slice(-400), done: true, ts: Date.now() });
  return { text: outText, modelId, device, metrics, kvReused };
}

// ── Embeddings (page RAG + semantic history) ──────────────────────────────────
/**
 * Embed texts with the internal MiniLM model — normalised mean-pooled vectors
 * (cosine-ready), exactly the gemma4-browser-extension FeatureExtractor recipe.
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(texts = []) {
  if (!Array.isArray(texts) || !texts.length) return [];
  const { pipeline: extractor, def } = await ensureRuntime(EMBEDDINGS_MODEL.id);
  const t0 = performance.now();
  const output = await extractor(texts, { normalize: true, pooling: 'mean' });
  const vectors = typeof output.tolist === 'function' ? output.tolist() : [];
  mlLog(`EMBED · ${texts.length} texts · ${((performance.now() - t0) / 1000).toFixed(2)}s · dim=${vectors[0]?.length || 0} (${def.name})`);
  return vectors;
}
