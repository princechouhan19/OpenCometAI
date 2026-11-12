# On-device models: Gemma 4 integration notes (v1.5.0)

How the Gemma-4-in-the-browser reference stack was evaluated and what was
adopted into OpenComet SIH.

Sources:

1. PyImageSearch, *Running Gemma 4 in the Browser with Transformers.js and
   WebGPU* (pyimagesearch.com, 2026-07-27, Piyush Thakur)
2. `nico-martin/gemma4-browser-extension` (GitHub, MIT), an on-device agent
   extension built on Transformers.js and Gemma 4

## What the reference implementations do

### PyImageSearch tutorial

| Technique | Detail |
|---|---|
| Model repo | `onnx-community/gemma-4-E2B-it-ONNX`, with E4B for higher quality |
| Runtime | Transformers.js v4 (`@huggingface/transformers@4`) |
| Classes | `AutoProcessor` and `Gemma4ForConditionalGeneration` |
| Load options | `dtype: "q4f16"`, `device: "webgpu"`, `progress_callback` |
| Multimodal template | messages carry `content: [{type:"image"}, {type:"audio"}, {type:"text"}]`, rendered with `apply_chat_template(..., {add_generation_prompt: true})` |
| Generation | `model.generate({...inputs, max_new_tokens: 512, do_sample: false, streamer})` |
| Streaming | `TextStreamer(tokenizer, {skip_prompt, skip_special_tokens, callback_function})` |
| Caching | weights cached through the browser Cache API, so the second run starts immediately |

### gemma4-browser-extension

| Component | Their design | What we adopted |
|---|---|---|
| Model lineup | Gemma 4 E2B by default, E4B, Granite 4.0 350M/1B/micro, all-MiniLM-L6-v2 for embeddings | Same families, see the catalog below |
| Native tool calling | Tools declared through `apply_chat_template(conversation, {tools})`; the model emits `<\|tool_call>call:name{args}<tool_call\|>` | Ported: our action catalogue is declared as WebMCP-style schemas (`src/lib/tool-schemas.js`) and passed to the template for on-device providers |
| Tool-call parsing | Tolerant extractor covering three formats (JSON, Gemma-tagged, bare `call:`), brace-depth scanner, quote repair, unquoted-key repair | Ported to `src/lib/tool-calls.js` |
| KV cache reuse | `DynamicCache` passed as `past_key_values` between turns, skipping a re-prefill of the long prefix | Ported with a correctness guard: per-session cache in the offscreen engine, reused only on an exact token-prefix match |
| Metrics | prefill and decode time, tokens per second, milliseconds per token | The engine returns `metrics` on every `generateLocal` and logs them |
| RAG (`ask_website`) | Content script splits headings and paragraphs into sectioned parts, embeds with MiniLM, cosine top-K, parts carry IDs, then scrolls to and highlights the node | Ported to `content/agent.js`, `src/lib/page-rag.js`, and the `ask_website` and `highlight_element` actions |
| Vector history | MiniLM embeddings of history titles for semantic search | Ported in a lighter form to `src/lib/vector-history.js`, embeddings when available and keyword fallback otherwise |
| WebGPU discipline | Chrome 113+ and a real GPU adapter required | `ensureDevice()` probes `navigator.gpu.requestAdapter()` once, demotes to WASM and broadcasts when there is no adapter |

Two things we did not copy:

- **Their agent loop next to the model.** Our loop lives in the service worker
  (plan, act, verify). Only the generation calls were enriched, so cloud and
  on-device providers share one code path.
- **IndexedDB history vectors.** Titles are embedded lazily into an in-memory
  LRU cache. Re-embedding is cheap and avoids a storage schema.

## On-device model catalog

Toy models were removed: SmolLM2 360M, Qwen2.5 0.5B, FastVLM 0.5B, Qwen2-VL 2B
and Llama 3.2 1B.

| Model | Repo | Kind | Size | Purpose |
|---|---|---|---|---|
| Gemma 4 E2B | `onnx-community/gemma-4-E2B-it-ONNX` | gemma4 (MoE, multimodal) | ~2.3 GB | Default on-device brain: native tool calling, vision and audio |
| Gemma 4 E4B | `onnx-community/gemma-4-E4B-it-ONNX` | gemma4 (MoE, multimodal) | ~4.4 GB | Higher quality for complex research and form tasks |
| Granite 4.0 Micro 3B | `onnx-community/granite-4.0-micro-ONNX-web` | llm | ~1.8 GB | Text-only alternative with reliable tool calling |
| Granite 4.0 1B | `onnx-community/granite-4.0-1b-ONNX-web` | llm | ~0.8 GB | Lightest agent-capable planner |
| LFM2-VL 450M | `onnx-community/LFM2-VL-450M-ONNX` | vlm | ~300 MB | Small vision fallback for weak GPUs |
| MiniLM (internal) | `onnx-community/all-MiniLM-L6-v2-ONNX` | embeddings | ~90 MB | Ranking for `ask_website` and `find_history`; downloaded on first use |

Weights stream from the HuggingFace CDN into the browser Cache API. Transformers.js
v4.2.0 and the ORT wasm build are vendored, so the CSP stays clean and the
extension works offline after the first download.

## How the pieces communicate

```
sidepanel.js --LOCAL_MODEL_LIST/DOWNLOAD/DELETE--> sw.js --sendToOffscreen--> offscreen.js
     ^                                              |                          |
     |  LOCAL_MODEL_TOKEN (live stream) <------------+---------- broadcast -----+
     |  LOCAL_MODEL_PROGRESS / LOG / HEARTBEAT <------+
     |
     |  agent loop (sw.js): planPhase / runNavigatorRole
     |    +- callAI(settings,..., { tools, sessionId, stream } for provider=local)
     |         +- callLocalAI -> LLM_GENERATE -> generateLocal():
     |              apply_chat_template(messages, {tools})    native tool calls
     |              DynamicCache past_key_values              KV reuse
     |              TextStreamer -> LOCAL_MODEL_TOKEN         live output
     |         +- parseJSON(text) OR extractToolCalls(text) -> action JSON
     |              +- executeAction() (27 native tools incl. ask_website,
     |                   highlight_element, find_history, list_tabs)
     |                   +- page-rag.js <-> content script (parts + highlight)
     |                   +- vector-history.js <-> chrome.history + embeddings
     +-- skills library (SKILL.md) <-> prompts.js (skill library protocol) <-> tools
```

Guarantees:

- **One loop for every provider.** On-device models that answer with native tool
  calls are normalised into the same action JSON the cloud providers emit;
  `callLocalAI` falls back to `extractToolCalls` when JSON parsing fails.
- **Unknown tool names cannot execute.** Calls are filtered against
  `AGENT_TOOL_NAMES`, the same set documented in the prompt catalogue.
- **The KV cache is opportunistic.** It is reused only on an exact token-prefix
  match, disposed on chat reset (`LOCAL_KV_DISPOSE`) and model delete, and
  capped at two sessions or 24k tokens.
- **Degradation is graceful.** `ask_website` and `find_history` fall back to
  keyword ranking when MiniLM is absent, WASM devices get q4 dtypes, and
  machines without a GPU adapter are demoted to WASM.

## Verification

- `node --check` on every touched file.
- Playwright harness: catalog shape (Gemma 4 present, toy models gone),
  tool-call extractor across all three formats, tool schemas against the prompt
  catalogue, actions against `describeAction`, model UI rendering, and the full
  regression suites.
- Real download and inference need WebGPU. Verify by hand: Settings, AI &
  Models, On-device, download Gemma 4 E2B, run a task with provider set to
  On-device, and watch the `[LocalML]` logs for a KV cache hit, tokens per
  second, and streaming output.

## v1.5.2: end-to-end verification and device gating

A real-browser end-to-end run (`scripts/test_gemma4_e2e.js`, 13/13) exposed four
defects that only appear at runtime. All are fixed.

| Defect | Root cause | Fix |
|---|---|---|
| `Unsupported model type: lfm2_vl` on download | Transformers.js v4 moved multimodal architectures into the IMAGE_TEXT_TO_TEXT mapping, which `AutoModelForVision2Seq` does not cover | The engine resolves `AutoModelForImageTextToText ?? AutoModelForVision2Seq` (`visionAutoClass` in `local-llm-engine.js`) |
| Downloaded models were forgotten after a reload | Offscreen documents get a restricted page-like `chrome` object (`loadTimes`, `csi`, `runtime`) with no `chrome.storage`, so status writes failed silently | `readStatuses` and `writeStatus` detect the restriction and relay through `LOCAL_STATUS_READ/WRITE` RPCs; the service worker owns persistence and heartbeats keep it alive during downloads |
| Gemma 4 downloaded ~3.8 GB on machines without a GPU, then ran out of memory | On WASM the `q4` dtype pulls every component (decoder, vision, audio, about 3.8 GB), past the wasm32 heap | Gemma 4 E2B and E4B are gated behind `requiresWebGPU`; the catalog shows the requirement and the engine fails the download with a clear message before any bytes move |
| Text-only prompts crashed with `undefined is not iterable` | LFM2-VL's `processor.preprocess` iterates its images argument, and text-only calls passed none | Text-only prompts use the tokenizer path; the vision path is entered only when an image is attached |

LFM2-VL on WASM now uses the `_q4` vision encoder, because fp16 kernels do not
run on the ORT wasm backend. Granite 4.0 Micro stays WebGPU-only, since upstream
publishes q4f16 weights only.

Device availability at v1.5.2:

| Model | WebGPU | WASM (CPU) |
|---|---|---|
| Gemma 4 E2B / E4B | Supported, q4f16, default brain | Blocked: needs GPU memory |
| Granite 4.0 Micro 3B | Supported, q4f16 | Blocked: q4f16 weights only |
| Granite 4.0 1B | Supported, q4 | Supported, q4 |
| LFM2-VL 450M | Supported per component | Supported, q4/q8; verified end to end |

Verified 2026-09-04 in headless Chromium with the real extension loaded: 13/13
end-to-end checks (catalog, gating, download, persistence, use, generation),
`test_agent_ux` 30/30, settings regression green, `node --check` clean.
