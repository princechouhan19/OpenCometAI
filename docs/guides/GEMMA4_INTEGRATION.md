# Gemma 4 On-Device Intelligence — Integration Notes (v1.5.0)

This document records the research and the integration of the
**Gemma-4-in-the-browser** reference stack into OpenComet SIH.

Sources analysed:

1. **PyImageSearch** — *Running Gemma 4 in the Browser with Transformers.js and WebGPU*
   (pyimagesearch.com, 2026-07-27, Piyush Thakur)
2. **nico-martin/gemma4-browser-extension** (GitHub, MIT) — an on-device AI agent
   Chrome extension powered by Transformers.js + Gemma 4.

---

## 1. What the references teach

### PyImageSearch browser tutorial

| Technique | Detail |
|---|---|
| Model repo | `onnx-community/gemma-4-E2B-it-ONNX` (also E4B for higher quality) |
| Runtime | Transformers.js **v4** (`@huggingface/transformers@4`) |
| Classes | `AutoProcessor` + `Gemma4ForConditionalGeneration` |
| Load options | `dtype: "q4f16"`, `device: "webgpu"`, `progress_callback` |
| Multimodal template | messages `content: [{type:"image"}, {type:"audio"}, {type:"text"}]` → `apply_chat_template(..., {add_generation_prompt: true})` |
| Generation | `model.generate({...inputs, max_new_tokens: 512, do_sample: false, streamer})` |
| Streaming | `TextStreamer(tokenizer, {skip_prompt, skip_special_tokens, callback_function})` — token-by-token UI |
| Caching | weights cached by the browser Cache API; second runs load instantly |

### gemma4-browser-extension (agent architecture)

| Component | Their design | What we adopted |
|---|---|---|
| **Model lineup** | Gemma 4 E2B (default) / E4B, Granite 4.0 350M/1B/micro, all-MiniLM-L6-v2 for embeddings | Same families — see §2 |
| **Native tool calling** | Tools declared via `apply_chat_template(conversation, {tools})`; model emits `<\|tool_call>call:name{args}<tool_call\|>` | Ported: our ACTION catalogue is declared as WebMCP-style schemas (`src/lib/tool-schemas.js`) and passed to the template for on-device providers |
| **Tool-call parsing** | 3-format tolerant extractor (JSON `<\/tool_call>`, Gemma-tagged, bare `call:`), brace-depth scanner, `<\|"\|>` quote fix, unquoted-key repair | Ported verbatim → `src/lib/tool-calls.js` |
| **KV-cache reuse** | `DynamicCache` passed as `past_key_values` between agent-loop turns — skips re-prefilling the long system+page prompt | Ported SAFER: per-session cache in the offscreen engine, gated on an **exact token-prefix match** (correctness never depends on the cache) |
| **Metrics** | prefill/decode ms, tokens/s, ms/token per generation and per run | Engine now returns `metrics` on every `generateLocal` + `[LocalML]` logs |
| **RAG (ask_website)** | content script splits h1–h6/p into sectioned parts with sentence chunks → MiniLM embeddings → cosine top-K → parts carry `section-paragraph` IDs → chained `highlight_website_element` scrolls + flashes the node | Ported → `content/agent.js` (`OC_EXTRACT_PAGE_PARTS` + registry), `src/lib/page-rag.js`, actions `ask_website` + `highlight_element` |
| **Vector history** | MiniLM embeddings of history titles, semantic `find_history` search | Ported lightweight → `src/lib/vector-history.js` (embeddings when available, keyword fallback otherwise) |
| **WebGPU discipline** | Chrome 113+ and a *real* GPU adapter required | `ensureDevice()` probes `navigator.gpu.requestAdapter()` once; demotes to WASM and broadcasts when no adapter |

Things we deliberately did **not** copy:

- Their full agent loop living next to the model. Our loop already lives in the
  service worker (plan → act → verify); we kept it and only enriched the
  generation calls, so cloud providers and on-device providers share one code path.
- IndexedDB persistence for history vectors. We embed titles lazily with an
  in-memory LRU cache — history re-embedding is cheap and avoids a storage schema.

---

## 2. New on-device model catalog (agent-grade only)

Toy models (<1B without tool calling) were **removed**: SmolLM2 360M,
Qwen2.5 0.5B, FastVLM 0.5B, Qwen2-VL 2B, Llama 3.2 1B.

| Model | Repo | Kind | Size | Why it's here |
|---|---|---|---|---|
| **Gemma 4 E2B** ★ | `onnx-community/gemma-4-E2B-it-ONNX` | gemma4 (MoE, multimodal) | ~2.3 GB | Default agent brain: native tool calling, vision + audio, MoE speed |
| **Gemma 4 E4B** | `onnx-community/gemma-4-E4B-it-ONNX` | gemma4 (MoE, multimodal) | ~4.4 GB | Max on-device quality for complex research/form tasks |
| **Granite 4.0 Micro 3B** | `onnx-community/granite-4.0-micro-ONNX-web` | llm | ~1.8 GB | Text-only agent alternative, reliable tool caller |
| **Granite 4.0 1B** | `onnx-community/granite-4.0-1b-ONNX-web` | llm | ~0.8 GB | Lightest agent-capable planner for low-RAM machines |
| **LFM2-VL 450M** | `onnx-community/LFM2-VL-450M-ONNX` | vlm | ~300 MB | Tiny vision fallback for weak GPUs |
| MiniLM (internal) | `onnx-community/all-MiniLM-L6-v2-ONNX` | embeddings | ~90 MB | Powers `ask_website` + `find_history` semantic ranking; auto-downloaded on first use |

All weights stream from the HuggingFace CDN into the browser Cache API
(vendored Transformers.js v4.2.0 + vendored ORT wasm — CSP-clean, offline after
first download).

---

## 3. How the pieces communicate (mixed architecture)

```
sidepanel.js ──LOCAL_MODEL_LIST/DOWNLOAD/DELETE──▶ sw.js ──sendToOffscreen──▶ offscreen.js
     ▲                                                │                          │
     │  LOCAL_MODEL_TOKEN (live stream) ◀─────────────┼────────── broadcast ─────┤
     │  LOCAL_MODEL_PROGRESS / LOG / HEARTBEAT ◀───────┘                          │
     │                                                                            │
     │  agent loop (sw.js): planPhase / runNavigatorRole                          │
     │    └─ callAI(settings,…, { tools, sessionId, stream } for provider=local)  │
     │         └─ callLocalAI → LLM_GENERATE → generateLocal():                   │
     │              apply_chat_template(messages, {tools})   ← native tool calls  │
     │              DynamicCache past_key_values              ← KV reuse          │
     │              TextStreamer → LOCAL_MODEL_TOKEN          ← live output       │
     │         └─ parseJSON(text) OR extractToolCalls(text) → ACTION JSON         │
     │              └─ executeAction() (27 native tools incl. ask_website,        │
     │                   highlight_element, find_history, list_tabs)              │
     │                   └─ page-rag.js ⇄ content script (parts + highlight)     │
     │                   └─ vector-history.js ⇄ chrome.history + embeddings      │
     └── skills library (SKILL.md) ⇄ prompts.js (SKILL LIBRARY protocol) ⇄ tools
```

Guarantees:

- **Provider-agnostic agent loop** — on-device models that answer with native
  tool calls are normalised into the same ACTION-JSON the cloud providers emit
  (`callLocalAI` falls back to `extractToolCalls` when JSON parsing fails).
- **Hallucinated tool names can never execute** — calls are filtered through
  `AGENT_TOOL_NAMES` (the same set documented in the prompt catalogue).
- **KV cache is opportunistic** — reused only on an exact token-prefix match of
  the rendered prompt; disposed on chat reset (`LOCAL_KV_DISPOSE`) and model
  delete, LRU-capped at 2 sessions / 24k tokens.
- **Graceful degradation** — `ask_website` / `find_history` fall back to keyword
  ranking when the MiniLM model isn't downloaded; WASM devices get q4 dtypes;
  no-adapter machines are demoted to WASM automatically.

## 4. Verification

- `node --check` on every touched file
- Playwright harness: catalog shape (Gemma 4 present, toys gone), tool-call
  extractor (all 3 Gemma formats), tool schemas ↔ prompt catalogue consistency,
  actions ↔ describeAction consistency, models UI render, full regression suites.
- Real-model download + inference requires WebGPU — verify manually via
  Settings → AI & Models → On-device → Download "Gemma 4 E2B", then run an
  agent task with provider = On-device and watch `[LocalML]` logs for
  `KV cache HIT`, `tok/s` metrics and token streaming.

---

## 5. v1.5.2 — verified end-to-end + device-availability fixes

A real-browser E2E (scripts/test_gemma4_e2e.js, 13/13) exposed four defects
that only appear at runtime; all are fixed:

| Defect | Root cause | Fix |
|---|---|---|
| `Unsupported model type: lfm2_vl` on download | transformers.js v4 moved multimodal archs (lfm2_vl, qwen2_vl, gemma4…) into the IMAGE_TEXT_TO_TEXT mapping; the legacy `AutoModelForVision2Seq` mapping lacks them | engine resolves `AutoModelForImageTextToText ?? AutoModelForVision2Seq` (local-llm-engine.js `visionAutoClass`) |
| Downloaded models "forgot" they were downloaded after a reload | Chromium offscreen documents expose a RESTRICTED page-like `chrome` object (`[loadTimes, csi, runtime]`) — **no `chrome.storage`** — so the engine's status writes silently failed | `readStatuses/writeStatus` detect the restriction and relay to the SW via `LOCAL_STATUS_READ/WRITE` RPCs (the SW owns persistence; heartbeats keep it alive during downloads) |
| Gemma 4 would download ~3.8 GB on no-GPU machines, then OOM | on WASM the dtype string `q4` pulls ALL components (decoder+vision+audio ≈ 3.8 GB) — far past the wasm32 heap; the reference stack itself requires WebGPU | Gemma 4 E2B/E4B gated with `requiresWebGPU` — catalog shows "⚡ Needs WebGPU" + alternatives, engine fast-fails downloads with a clear message BEFORE any bytes move |
| VLM text-only prompts crashed (`undefined is not iterable`) | LFM2-VL's `processor.preprocess` iterates its images argument; text-only calls passed none | text-only prompts take the tokenizer path (`processor.tokenizer`) — vision path is entered only when an image is actually attached |

Also: LFM2-VL WASM dtype now uses the `_q4` vision encoder (fp16 kernels do not
execute on the ORT wasm backend). Granite 4.0 Micro stays WebGPU-only (upstream
ships q4f16 weights only).

Device availability matrix (v1.5.2):

| Model | WebGPU | WASM (CPU) |
|---|---|---|
| Gemma 4 E2B / E4B | ✅ q4f16 (default brain) | ⛔ gated — needs GPU memory |
| Granite 4.0 Micro 3B | ✅ q4f16 | ⛔ gated — q4f16-only weights |
| Granite 4.0 1B | ✅ q4 | ✅ q4 (lightest agent planner) |
| LFM2-VL 450M | ✅ per-component | ✅ q4/q8 (E2E-verified: download → use → generate) |

Verified 2026-09-04, headless Chromium with the real extension loaded:
13/13 E2E checks (catalog, gating, download, persistence, use, generation),
test_agent_ux 30/30, settings regression green, `node --check` clean.
