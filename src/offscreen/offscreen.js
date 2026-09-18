// ─────────────────────────────────────────────────────────────────────────────
// src/offscreen/offscreen.js
// The offscreen ML document for Open Comet.
//
// Runs the entire on-device perception + generation stack:
//   • Transformers.js (vendored)  — VLM/LLM inference + weight downloads
//   • MediaPipe FaceDetector      — on-device face boxes for blurring
//   • YOLO / ViT / BERT NER       — optional extra visual context + PII
//   • Canvas redaction            — pixel-level blur/pixelate/black-bar
//
// The service worker routes messages here (target: 'offscreen'). During long
// operations we broadcast LOCAL_MODEL_HEARTBEAT every 8s so the service
// worker's 30s idle timer keeps getting reset while it waits for the reply.
// ─────────────────────────────────────────────────────────────────────────────

import {
  getLocalModelDef,
  broadcast,
  mlLog,
  mlWarn,
  mlError,
  hasWebGPUInContext,
} from '../lib/local-models-shared.js';
import { createLogger, installGlobalErrorTraps } from '../core/logger.js';
import {
  getEngineDevice,
  downloadLocalModel,
  deleteLocalModel,
  generateLocal,
  embedTexts,
  disposeSessionCache,
  ensureDevice,
  activeDownloadIds,
} from '../lib/local-llm-engine.js';
import { runPrivacyPipeline } from '../lib/privacy-filter.js';
import { disposeLocalVision, preloadLocalVision, getImageClassifier } from '../lib/local-vision.js';
import { disposeFaceDetector } from '../lib/mediapipe-face.js';

// Uncaught errors / unhandled rejections in this context never vanish: they
// land in the offscreen console AND are relayed to the SW console.
const logOff = createLogger('Offscreen');
installGlobalErrorTraps(logOff, 'offscreen', 'DIAG_LOG_RELAY');

const HEARTBEAT_MS = 8000;
const IDLE_CLOSE_MS = 5 * 60 * 1000;   // ask the SW to close us after 5 idle minutes

let lastActivity = Date.now();

function touch() { lastActivity = Date.now(); }

/** Run `fn` while broadcasting heartbeats so the SW stays alive. */
async function withHeartbeats(requestId, fn) {
  const timer = setInterval(() => {
    broadcast({ type: 'LOCAL_MODEL_HEARTBEAT', requestId });
  }, HEARTBEAT_MS);
  try { return await fn(); }
  finally { clearInterval(timer); }
}

// ── Boot log ───────────────────────────────────────────────────────────────────
// v1.8 build banner — lets you verify WHICH build is actually running in this
// console (stale unpacked copies were indistinguishable from fresh ones before).
mlLog(`[OpenComet] v${(chrome.runtime && typeof chrome.runtime.getManifest === 'function')
  ? chrome.runtime.getManifest().version : 'dev'} · offscreen ML runtime`);
mlLog(`Offscreen ML runtime booted · backend=${getEngineDevice()} · webgpu=${hasWebGPUInContext()}`);
broadcast({ type: 'LOCAL_MODEL_DEVICE', device: getEngineDevice() });

// Idle self-teardown: keeps RAM free when no download/generation is running.
setInterval(() => {
  if (Date.now() - lastActivity > IDLE_CLOSE_MS) {
    mlLog('Idle for 5 minutes — requesting shutdown of the offscreen ML runtime.');
    broadcast({ type: 'OFFSCREEN_CLOSE_REQUEST' });
  }
}, 60 * 1000);

// ── Message router (requests from the service worker) ─────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (!msg || msg.target !== 'offscreen') return;   // not for us

  touch();
  const { type } = msg;

  switch (type) {
    // ── Keep-alive touch (agent loop pings during long VLM turns so the
    //    5-minute idle teardown can't fire mid-run) — ack immediately.
    case 'ML_TOUCH': {
      respond({ ok: true, touched: true });
      return;
    }

    // ── Liveness + backend probe ────────────────────────────────────────────
    case 'OFFSCREEN_PING': {
      // ensureDevice: the deep adapter probe may demote us to wasm — report truth.
      // `downloads` lets the SW tell a LIVE download apart from a stale
      // persisted "downloading" status left behind by a browser restart.
      ensureDevice()
        .then(device => respond({ ok: true, device, webgpu: device === 'webgpu', downloads: activeDownloadIds(), ts: Date.now() }))
        .catch(() => respond({ ok: true, device: getEngineDevice(), webgpu: hasWebGPUInContext(), downloads: activeDownloadIds(), ts: Date.now() }));
      return true;   // async response
    }

    // ── Model download (fire-and-report; progress via broadcasts) ───────────
    case 'LOCAL_MODEL_DOWNLOAD': {
      const { modelId } = msg;
      const def = getLocalModelDef(modelId);
      if (!def) {
        respond({ ok: false, error: `Unknown local model: ${modelId}` });
        return;
      }
      downloadLocalModel(modelId)
        .then(r => { if (!r?.ok) mlError(`Download task for ${modelId} ended with error: ${r?.error || 'unknown'}`); })
        .catch(e => mlError(`Download task for ${modelId} crashed:`, String(e?.message || e), e?.stack || ''));
      respond({ ok: true, started: true });   // ack immediately; UI follows broadcasts
      return;
    }

    // ── Model delete ─────────────────────────────────────────────────────────
    case 'LOCAL_MODEL_DELETE': {
      deleteLocalModel(msg.modelId)
        .then(r => respond({ ok: !!r?.ok, error: r?.error || '' }))
        .catch(e => respond({ ok: false, error: String(e?.message || e) }));
      return true;   // async response
    }

    // ── Generation (VLM / LLM / Gemma 4) ─────────────────────────────────────
    case 'LLM_GENERATE': {
      const { requestId, params } = msg;
      // requestId rides along so LOCAL_MODEL_TOKEN streams can be correlated.
      const genParams = { ...(params || {}), requestId };
      withHeartbeats(requestId, () => generateLocal(genParams))
        .then(r => respond({
          ok: true, requestId,
          text: r.text, modelId: r.modelId, device: r.device,
          metrics: r.metrics || null, kvReused: Boolean(r.kvReused),
        }))
        .catch(err => {
          mlError(`LLM_GENERATE failed:`, String(err?.message || err), err?.stack || '');
          respond({ ok: false, requestId, error: String(err?.message || err) });
        });
      return true;   // async response
    }

    // ── Embeddings for page RAG (ask_website) + history (find_history) ──────
    case 'LOCAL_EMBED': {
      const { requestId, texts } = msg;
      withHeartbeats(requestId, () => embedTexts(Array.isArray(texts) ? texts : []))
        .then(vectors => respond({ ok: true, requestId, vectors }))
        .catch(err => {
          mlError(`LOCAL_EMBED failed:`, String(err?.message || err), err?.stack || '');
          respond({ ok: false, requestId, error: String(err?.message || err) });
        });
      return true;
    }

    // ── Free the agent loop's KV cache (new chat / session change) ──────────
    case 'LOCAL_KV_DISPOSE': {
      disposeSessionCache(msg.sessionId || '');
      respond({ ok: true });
      return;
    }

    // ── Privacy pipeline (face blur + DOM/text PII + canvas redaction) ──────
    case 'PRIVACY_SANITIZE': {
      const { requestId, input, opts } = msg;
      const t0 = performance.now();
      withHeartbeats(requestId, () => runPrivacyPipeline(input || {}, opts || {}))
        .then(result => {
          mlLog(`PRIVACY_SANITIZE ok · ${Math.round(performance.now() - t0)}ms · faces=${result?.stats?.counts?.faces ?? 0} dom=${result?.stats?.counts?.domSensitive ?? 0} textPii=${result?.stats?.counts?.textPii ?? 0}`);
          respond({ ok: true, requestId, result });
        })
        .catch(err => {
          mlError(`PRIVACY_SANITIZE failed:`, String(err?.message || err), err?.stack || '');
          respond({ ok: false, requestId, error: String(err?.message || err) });
        });
      return true;   // async response
    }

    // ── v1.16.0 model warm-up (cold-start off the first-capture critical path)
    // Loads the YOLO (+ optional ViT) pipelines with NO capture pending, so the
    // first PRIVACY_SANITIZE of a session pays inference cost only — not the
    // one-time model download + WASM/GPU compile (measured on the reference
    // hardware: ViT load ALONE is 37.9 s with a cold browser cache — that load
    // dominating the real-VLM E2E first-step sanitizeMs 41487). NER stays lazy
    // (110 MB, only used when useNer is enabled). Fire-and-forget from the SW:
    // failures are logged and reported, never propagated into a running task.
    case 'VISION_WARMUP': {
      const { yolo = true, vit = true, requestId } = msg;
      withHeartbeats(requestId || 'vision-warmup', async () => {
        const t0 = performance.now();
        const parts = [];
        if (yolo) { await preloadLocalVision({ includeNer: false, includeYolo: true }); parts.push('yolo'); }
        if (vit) { await getImageClassifier(); parts.push('vit'); }
        const warmupMs = Math.round(performance.now() - t0);
        mlLog(`VISION_WARMUP ok · ${warmupMs}ms · ${parts.join('+') || 'nothing to load'}`);
        return { parts, warmupMs };
      })
        .then(result => respond({ ok: true, requestId, result }))
        .catch(err => {
          mlWarn('VISION_WARMUP failed (non-fatal — first capture will warm lazily):', String(err?.message || err));
          respond({ ok: false, requestId, error: String(err?.message || err) });
        });
      return true;   // async response
    }

    // ── Free memory (privacy mode off) ───────────────────────────────────────
    case 'VISION_DISPOSE': {
      Promise.all([disposeLocalVision(), disposeFaceDetector()])
        .then(() => respond({ ok: true }))
        .catch(e => respond({ ok: false, error: String(e?.message || e) }));
      return true;
    }

    default:
      mlWarn('Unknown offscreen message type:', type);
      respond({ ok: false, error: `Unknown offscreen message type: ${type}` });
      return;
  }
});
