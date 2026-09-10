// ─────────────────────────────────────────────────────────────────────────────
// src/lib/local-models-shared.js
// Shared plumbing for the on-device model system. Safe to import from BOTH
// the service worker and the offscreen document — it only touches
// chrome.storage + chrome.runtime messaging (no DOM, no dynamic import).
// ─────────────────────────────────────────────────────────────────────────────

export const STATUS_KEY = 'opencometLocalModels';

// ── Curated catalog ────────────────────────────────────────────────────────────
// Agent-grade on-device models only. Toy models (<1B, no tool calling) were
// removed — a browser agent needs instruction following, native tool calling
// and (ideally) vision. Lineup follows the Gemma-4-in-the-browser reference
// stack (pyimagesearch 2026-07 + nico-martin/gemma4-browser-extension):
//   • Gemma 4 E2B/E4B — MoE multimodal agent brain (text + image + audio,
//     native tool calling via the chat template), default E2B q4f16 on WebGPU.
//   • Granite 4.0 — IBM's web-ONNX agent line, strong tool caller at 1–3B.
//   • LFM2-VL 450M — tiny vision fallback kept ONLY for weak-GPU devices.
// dtype maps per backend. VLMs use per-component dtypes (official pattern).
export const LOCAL_MODEL_CATALOG = [
  {
    id: 'gemma-4-e2b',
    repo: 'onnx-community/gemma-4-E2B-it-ONNX',
    name: 'Gemma 4 E2B',
    vendor: 'Google DeepMind · open weights',
    kind: 'gemma4',
    params: 'E2B (MoE · ~2B active)',
    sizeLabel: '~2.3 GB',
    vision: true,
    audio: true,
    nativeTools: true,
    blurb: 'Best default agent brain — native tool calling, MoE speed, sees screenshots, hears audio. Requires WebGPU.',
    recommended: true,
    requiresWebGPU: true,   // reference stack mandates WebGPU; the q4 all-components build is ~3.8 GB — far past the wasm32 heap
    // dtype note: q4f16 needs fp16 compute → WebGPU only. Kept for documentation;
    // the engine gate blocks downloads on machines without a usable GPU adapter.
    dtypes: { webgpu: 'q4f16', wasm: 'q4' },
  },
  {
    id: 'gemma-4-e4b',
    repo: 'onnx-community/gemma-4-E4B-it-ONNX',
    name: 'Gemma 4 E4B',
    vendor: 'Google DeepMind · open weights',
    kind: 'gemma4',
    params: 'E4B (MoE · ~4B active)',
    sizeLabel: '~4.4 GB',
    vision: true,
    audio: true,
    nativeTools: true,
    heavy: true,
    blurb: 'Maximum on-device quality for complex multi-site research and form-heavy automation. Requires WebGPU + a capable GPU.',
    requiresWebGPU: true,   // same wasm32-heap math as E2B, only worse (~4.4 GB)
    dtypes: { webgpu: 'q4f16', wasm: 'q4' },
  },
  {
    id: 'granite-4.0-micro',
    repo: 'onnx-community/granite-4.0-micro-ONNX-web',
    name: 'Granite 4.0 Micro 3B',
    vendor: 'IBM · open weights',
    kind: 'llm',
    params: '3B',
    sizeLabel: '~1.8 GB',
    vision: false,
    nativeTools: true,
    requiresWebGPU: true,   // granite-4.0-micro-ONNX-web ships q4f16 weights ONLY — no _q4 files exist upstream
    blurb: 'Text-only agent alternative — reliable planner and tool caller for page-text and research tasks. Requires WebGPU (weights ship as q4f16 only).',
    dtypes: { webgpu: 'q4f16', wasm: 'q4f16' },
  },
  {
    id: 'granite-4.0-1b',
    repo: 'onnx-community/granite-4.0-1b-ONNX-web',
    name: 'Granite 4.0 1B',
    vendor: 'IBM · open weights',
    kind: 'llm',
    params: '1B',
    sizeLabel: '~0.8 GB',
    vision: false,
    nativeTools: true,
    blurb: 'Lightest agent-capable planner — tool-calling text model for low-RAM machines.',
    dtypes: { webgpu: 'q4', wasm: 'q4' },
  },
  {
    id: 'lfm2-vl-450m',
    repo: 'onnx-community/LFM2-VL-450M-ONNX',
    name: 'LFM2-VL 450M',
    vendor: 'LiquidAI · open weights',
    kind: 'vlm',
    params: '450M',
    sizeLabel: '~300 MB',
    vision: true,
    blurb: 'Tiny vision fallback for weak GPUs — quick screenshot glances when Gemma 4 is too heavy.',
    dtypes: {
      webgpu: { embed_tokens: 'q8', vision_encoder: 'q4f16', decoder_model_merged: 'q4f16' },
      // WASM cannot execute fp16 kernels → use the _q4 (int4/fp32) vision encoder too.
      wasm:   { embed_tokens: 'q8', vision_encoder: 'q4', decoder_model_merged: 'q4' },
    },
  },
];

// ── Internal embeddings model (RAG + semantic history) ────────────────────────
// Not part of the user-facing agent catalog: downloaded on demand the first
// time ask_website / find_history needs semantic ranking. Same engine plumbing
// (Cache API + progress broadcasts) as the agent models.
export const EMBEDDINGS_MODEL = {
  id: 'all-minilm-l6-v2',
  repo: 'onnx-community/all-MiniLM-L6-v2-ONNX',
  name: 'all-MiniLM-L6-v2',
  vendor: 'sentence-transformers · open weights',
  kind: 'embeddings',
  params: '22M',
  sizeLabel: '~90 MB',
  blurb: 'Semantic search embeddings for page RAG (ask_website) and history search (find_history).',
  dtypes: { webgpu: 'fp32', wasm: 'fp32' },
};

export function getLocalModelDef(id) {
  return LOCAL_MODEL_CATALOG.find(m => m.id === id)
    || (id === EMBEDDINGS_MODEL.id ? EMBEDDINGS_MODEL : null);
}

// ── Status persistence (chrome.storage.local — shared by SW + offscreen) ──────
// ⚠ Offscreen documents expose a RESTRICTED chrome object (runtime messaging
// only — no chrome.storage in Chromium builds). The engine therefore relays
// status reads/writes to the service worker, which owns persistence.
const hasDirectStorage = () => {
  try { return typeof chrome !== 'undefined' && Boolean(chrome.storage?.local); }
  catch { return false; }
};

export async function readStatuses() {
  if (!hasDirectStorage()) {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'LOCAL_STATUS_READ' });
      return resp?.ok ? (resp.statuses || {}) : {};
    } catch { return {}; }
  }
  try {
    const data = await chrome.storage.local.get(STATUS_KEY);
    return data?.[STATUS_KEY] || {};
  } catch { return {}; }
}

export async function writeStatus(modelId, patch = {}) {
  if (!hasDirectStorage()) {
    // Relay to the service worker — it stays alive during long ops (heartbeats).
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'LOCAL_STATUS_WRITE', modelId, patch });
      if (!resp?.ok) mlError(`writeStatus(relay) FAILED for "${modelId}":`, String(resp?.error || 'no response'));
      return resp?.ok ? (resp.statuses?.[modelId] || { ...patch }) : { ...patch };
    } catch (e) {
      mlError(`writeStatus(relay) crashed for "${modelId}":`, String(e?.message || e));
      return { ...patch };
    }
  }
  const all = await readStatuses();
  const prev = all[modelId] || {};
  all[modelId] = { ...prev, ...patch };
  try {
    await chrome.storage.local.set({ [STATUS_KEY]: all });
  } catch (e) {
    // Silent storage failures would make downloaded models "vanish" after a
    // reload — surface them loudly instead (Task 9-1 diagnostics contract).
    mlError(`writeStatus FAILED for "${modelId}":`, String(e?.message || e));
  }
  return all[modelId];
}

// ── Broadcasts (offscreen → SW + sidepanel) ────────────────────────────────────
export function broadcast(payload) {
  try { chrome.runtime.sendMessage(payload)?.catch?.(() => {}); } catch {}
}

// ── Logging: console + forwarded to every extension context ───────────────────
// The sidepanel prints LOCAL_MODEL_LOG lines, so download / inference logs are
// visible in the sidepanel DevTools console as well as the offscreen console.
export function mlLog(...args) {
  const line = args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  console.log('%c[LocalML]', 'color:#c4390a;font-weight:bold', line);
  broadcast({ type: 'LOCAL_MODEL_LOG', text: line, ts: Date.now() });
}

export function mlWarn(...args) {
  const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.warn('[LocalML]', line);
  broadcast({ type: 'LOCAL_MODEL_LOG', level: 'warn', text: line, ts: Date.now() });
}

export function mlError(...args) {
  const line = args.map(a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  console.error('%c[LocalML]', 'color:#f87171;font-weight:bold', line);
  broadcast({ type: 'LOCAL_MODEL_LOG', level: 'error', text: line, ts: Date.now() });
}

export function fmtMB(bytes) {
  if (!bytes || !isFinite(bytes)) return '0 MB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export function hasWebGPUInContext() {
  try { return typeof navigator !== 'undefined' && 'gpu' in navigator && Boolean(navigator.gpu); }
  catch { return false; }
}

// Deep probe: navigator.gpu existing is not enough — request an actual adapter
// (the gemma4-browser-extension reference requires a REAL WebGPU-capable GPU).
// Returns { supported, adapterInfo }.
export async function probeWebGPUAdapter() {
  try {
    if (!hasWebGPUInContext()) return { supported: false, reason: 'no navigator.gpu' };
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { supported: false, reason: 'no GPU adapter' };
    let info = {};
    try {
      const req = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
      if (req) info = { vendor: req.vendor || '', architecture: req.architecture || '' };
    } catch {}
    return { supported: true, ...info };
  } catch (e) {
    return { supported: false, reason: String(e?.message || e) };
  }
}
