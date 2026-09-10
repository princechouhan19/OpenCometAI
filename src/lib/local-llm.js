// ─────────────────────────────────────────────────────────────────────────────
// src/lib/local-llm.js
// On-device model CLIENT for the service worker side.
//
// The heavy lifting (Transformers.js imports, weight downloads, inference)
// happens in the offscreen document — see local-llm-engine.js. MV3 service
// workers cannot dynamic-import() and get killed after 30s idle, which made
// the old in-SW engine impossible.
//
// This module keeps the exact same public API the rest of the background
// code already uses (providers.js, privacy-agent.js, sw.js):
//   • LOCAL_MODEL_CATALOG / getLocalModelDef / resolveLocalModel
//   • listLocalModels / hasWebGPU / getLocalDevice
//   • downloadLocalModel / deleteLocalModel
//   • generateLocal / callLocalAI / callLocalAIRaw
// ─────────────────────────────────────────────────────────────────────────────

import { parseJSON } from './utils.js';
import {
  LOCAL_MODEL_CATALOG,
  EMBEDDINGS_MODEL,
  getLocalModelDef,
  readStatuses,
  writeStatus,
  mlLog,
} from './local-models-shared.js';
import { extractToolCalls } from './tool-calls.js';
import { AGENT_TOOL_NAMES } from './tool-schemas.js';
import { ensureOffscreen, sendToOffscreen } from './offscreen-client.js';

export { LOCAL_MODEL_CATALOG, getLocalModelDef };

// ── Backend detection (best-effort on the SW side; the offscreen document is
//    the source of truth and its answer overrides this fallback) ──────────────
export function hasWebGPU() {
  try { return typeof navigator !== 'undefined' && 'gpu' in navigator && Boolean(navigator.gpu); }
  catch { return false; }
}

export function getLocalDevice() {
  return hasWebGPU() ? 'webgpu' : 'wasm';
}

// ── Listing ────────────────────────────────────────────────────────────────────
// An interrupted download (browser closed / crashed / SW killed mid-fetch)
// leaves a persisted status:"downloading" behind — with nothing actually
// running, the catalog used to render a frozen "Downloading… 0%" forever.
// reconcileInterruptedDownloads() asks the offscreen runtime which downloads
// are genuinely live and downgrades every OTHER "downloading" status to
// "paused", keeping the last checkpoint (progress + bytes). The catalog then
// offers a Resume button; resuming re-uses all cached files (byte-level
// checkpoint via the Cache API — see preflightCachedFiles in the engine).
export async function reconcileInterruptedDownloads() {
  const statuses = await readStatuses();
  const stale = Object.entries(statuses).filter(([, s]) => s?.status === 'downloading');
  if (!stale.length) return statuses;          // fast path — nothing to reconcile

  // Ask the offscreen ML runtime (the only context that downloads) what is
  // REALLY in flight. If it is unreachable, nothing is downloading.
  let active = [];
  try {
    await ensureOffscreen();
    const ping = await sendToOffscreen({ type: 'OFFSCREEN_PING' }, { timeoutMs: 4000 });
    active = Array.isArray(ping?.downloads) ? ping.downloads : [];
  } catch { active = []; }

  for (const [id, s] of stale) {
    if (active.includes(id)) continue;         // genuinely downloading right now
    await writeStatus(id, {
      status: 'paused',
      progress: s.progress ?? 0,
      bytesLoaded: s.bytesLoaded ?? 0,
      bytesTotal: s.bytesTotal ?? 0,
      pausedAt: Date.now(),
      error: '',
    });
    mlLog(`Recovered interrupted download "${id}" — paused at ${s.progress ?? 0}%. Cached files are kept; Resume continues from the checkpoint.`);
  }
  return readStatuses();
}

export async function listLocalModels() {
  const statuses = await reconcileInterruptedDownloads();
  const device = getLocalDevice();
  return LOCAL_MODEL_CATALOG.map(m => ({
    ...m,
    device,
    status: statuses[m.id]?.status || 'not-downloaded',
    progress: statuses[m.id]?.progress ?? 0,
    bytesLoaded: statuses[m.id]?.bytesLoaded ?? 0,
    bytesTotal: statuses[m.id]?.bytesTotal ?? 0,
    pausedAt: statuses[m.id]?.pausedAt || null,
    downloadedAt: statuses[m.id]?.downloadedAt || null,
    error: statuses[m.id]?.error || '',
  }));
}

export function resolveLocalModel(settings = {}) {
  const id = String(settings.localModelId || '').trim();
  return getLocalModelDef(id) || LOCAL_MODEL_CATALOG.find(m => m.id === 'gemma-4-e2b')
      || LOCAL_MODEL_CATALOG[0];
}

// ── Downloads (RPC → offscreen engine) ─────────────────────────────────────────
export async function downloadLocalModel(id) {
  const def = getLocalModelDef(id);
  if (!def) return { ok: false, error: `Unknown local model: ${id}` };
  try {
    await ensureOffscreen();
    // The offscreen engine acks immediately and streams progress via
    // LOCAL_MODEL_PROGRESS broadcasts; completion also arrives as a broadcast.
    const resp = await sendToOffscreen({ type: 'LOCAL_MODEL_DOWNLOAD', modelId: id }, { timeoutMs: 20000 });
    if (!resp) return { ok: false, error: 'Offscreen ML runtime did not respond.' };
    if (resp.ok === false) return { ok: false, error: resp.error || 'Download could not be started.' };
    mlLog(`Download started for "${def.name}" (running in offscreen ML runtime).`);
    return { ok: true, modelId: id, started: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

export async function deleteLocalModel(id) {
  const def = getLocalModelDef(id);
  if (!def) return { ok: false, error: `Unknown local model: ${id}` };
  try {
    await ensureOffscreen();
    const resp = await sendToOffscreen({ type: 'LOCAL_MODEL_DELETE', modelId: id }, { timeoutMs: 30000 });
    if (!resp) return { ok: false, error: 'Offscreen ML runtime did not respond.' };
    return resp.ok ? { ok: true } : { ok: false, error: resp.error || 'Delete failed.' };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

// ── Generation (RPC → offscreen engine) ────────────────────────────────────────
export async function generateLocal(params) {
  await ensureOffscreen();
  // No timeout: the offscreen engine broadcasts LOCAL_MODEL_HEARTBEAT while a
  // generation is running, and each incoming broadcast resets this service
  // worker's 30s idle timer — so long generations cannot kill the worker
  // while we wait for the response.
  const resp = await sendToOffscreen({ type: 'LLM_GENERATE', params });
  if (!resp) throw new Error('Offscreen ML runtime did not respond to LLM_GENERATE.');
  if (!resp.ok) throw new Error(resp.error || 'On-device generation failed.');
  return { text: resp.text, modelId: resp.modelId, device: resp.device, metrics: resp.metrics || null, kvReused: Boolean(resp.kvReused) };
}

/**
 * Embed texts via the offscreen engine's MiniLM pipeline. Downloads the
 * embeddings model on first use (progress arrives via LOCAL_MODEL_PROGRESS).
 */
export async function embedTextsLocal(texts) {
  if (!Array.isArray(texts) || !texts.length) return [];
  await ensureOffscreen();
  // Warm the download if needed — offscreen heartbeats keep the SW alive.
  const statuses = await readStatuses();
  if (statuses[EMBEDDINGS_MODEL.id]?.status !== 'downloaded') {
    mlLog(`Embeddings model "${EMBEDDINGS_MODEL.name}" not cached — downloading (${EMBEDDINGS_MODEL.sizeLabel})…`);
    await sendToOffscreen({ type: 'LOCAL_MODEL_DOWNLOAD', modelId: EMBEDDINGS_MODEL.id }, { timeoutMs: 20000 });
    for (let i = 0; i < 240; i++) {
      await new Promise(r => setTimeout(r, 2500));
      const st = (await readStatuses())[EMBEDDINGS_MODEL.id];
      if (st?.status === 'downloaded') break;
      if (st?.status === 'error') throw new Error(`Embeddings model download failed: ${st.error || 'unknown'}`);
    }
  }
  const resp = await sendToOffscreen({ type: 'LOCAL_EMBED', texts });
  if (!resp?.ok) throw new Error(resp?.error || 'Offscreen ML runtime did not respond to LOCAL_EMBED.');
  return resp.vectors || [];
}

// ── providers.js adapters ──────────────────────────────────────────────────────
/**
 * mirrors the JSON-returning callAI contract.
 * On-device-specific options (all optional):
 *   • options.tools      — WebMCP-style declarations → native tool calling
 *   • options.sessionId  — enables KV-cache reuse across agent-loop turns
 *   • options.stream     — broadcast LOCAL_MODEL_TOKEN for live UI output
 * When a tool-calling model answers with native tool calls instead of our
 * ACTION JSON (Gemma 4 / Granite 4 do this when tools are declared), the calls
 * are converted into the same contract so the agent loop stays provider-
 * agnostic. Unknown tool names are dropped — hallucinated calls never execute.
 */
export async function callLocalAI(settings, prompt, images = [], options = {}) {
  const def = resolveLocalModel(settings);
  if (!def) throw new Error('No on-device model selected.');
  const imageDataUrl = def.vision && images?.length
    ? `data:${images[0].mimeType || 'image/jpeg'};base64,${images[0].imageBase64}`
    : null;

  const { text, device, metrics, kvReused } = await generateLocal({
    modelId: def.id,
    prompt,
    imageDataUrl,
    systemPrompt: options.systemPrompt || '',
    maxNewTokens: options.maxNewTokens || 700,
    tools: Array.isArray(options.tools) && options.tools.length ? options.tools : null,
    sessionId: options.sessionId || '',
    stream: Boolean(options.stream),
  });
  if (options.onRaw) { try { options.onRaw(text); } catch {} }
  if (metrics) {
    mlLog(`on-device metrics · ${metrics.generatedTokens} tok · ${metrics.tokensPerSecond} tok/s · prefill ${metrics.prefillMs}ms${kvReused ? ' · kv-reused' : ''}`);
  }

  const parsed = parseJSON(text);
  if (parsed && typeof parsed === 'object') return parsed;

  const { toolCalls } = extractToolCalls(text);
  if (toolCalls.length) {
    const accepted = toolCalls.filter(c => AGENT_TOOL_NAMES.has(String(c.name || '').trim()));
    if (accepted.length) {
      mlLog(`native tool calls → ACTION JSON: ${accepted.map(c => c.name).join(', ')}`);
      const actions = accepted.map(c => ({
        type: String(c.name).trim(),
        ...(c.arguments && typeof c.arguments === 'object' ? c.arguments : {}),
      }));
      return { action: actions[0], __extraActions: actions.slice(1), reasoning: '' };
    }
  }
  return parsed;
}

/** mirrors callAIRaw — plain prose */
export async function callLocalAIRaw(settings, prompt, options = {}) {
  const def = resolveLocalModel(settings);
  if (!def) throw new Error('No on-device model selected.');
  const { text, metrics } = await generateLocal({
    modelId: def.id,
    prompt,
    systemPrompt: options.systemPrompt || '',
    maxNewTokens: options.maxNewTokens || 1200,
    sessionId: options.sessionId || '',
    stream: Boolean(options.stream),
  });
  if (metrics) mlLog(`on-device metrics · ${metrics.generatedTokens} tok · ${metrics.tokensPerSecond} tok/s`);
  return text;
}
