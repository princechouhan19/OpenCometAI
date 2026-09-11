# File-by-file guide

Developer map of the modules that make up the privacy pipeline and the agent
loop (preserved from the README's §6; see also
[PRIVACY_VISION.md](./PRIVACY_VISION.md) for the architecture narrative and
[Developer Guide](../guides/DEVELOPER_GUIDE.md) for setup and workflows).

### `src/lib/pii-detector.js`
Pure-JS PII scanner. Zero dependencies. Combines 11 high-precision regex patterns (with Luhn validation for credit cards) + DOM-sensitive-field detection (`type=password`, sensitive autocomplete tokens, name/placeholder hints). Optionally accepts a pre-loaded Transformers.js NER pipeline for catching person/org/address entities that don't follow a pattern.

### `src/lib/mediapipe-face.js`
Wraps `@mediapipe/tasks-vision` `FaceDetector`. Loads the BlazeFace Short Range model (INT8, ~1MB) **fully vendored from the extension bundle** (`src/vendor/mediapipe/` — no network needed). WebGPU delegate preferred, WASM/CPU fallback automatic. Tiled sweep (512px → 256px fine tiles) + verify-rescan for small faces; YOLO person-crop re-sweep as a recall backstop. Caches the pipeline singleton.

### `src/lib/local-vision.js`
Wraps `@huggingface/transformers`. Exposes three lazy-loaded pipelines: object detection (YOLO), image classification (ViT), and NER (BERT). Backend auto-selected (`webgpu` if `navigator.gpu` exists, else `wasm`). All models quantised INT8. Also exposes `preloadLocalVision()` — the warm-up hook used by the v1.16.0 session warm-up.

### `src/lib/canvas-redactor.js`
Pixel-level redactor. Takes a PNG data-URL + region list, returns a new JPEG data-URL where every region has been:
- **faces** → Gaussian blur + opaque black bar across eyes
- **credentials** (password / API key / card / Aadhaar / PAN / SSN / IBAN) → solid black fill
- **free-form text PII** (email / phone / DOB / person / org / address) → pixelate

Optional badge label on each region.

### `src/lib/privacy-filter.js`
Orchestrator. Calls the four modules above in parallel where possible and produces:
- `sanitizedDataUrl` — the only image allowed to leave the client
- `manifest` — array of redacted regions with type/bounds/reason/confidence
- `sanitizedDomText` — DOM text with `[REDACTED:<type>]` tokens
- `stats` — per-phase latency + counts + backend info (including `ocrMemoHit` and detector-memo telemetry)

### `src/lib/privacy-agent.js`
Bridges the pipeline to the OpenComet background. Exposes:
- `captureAndSanitize(tabId)` — capture + DOM scan + pipeline run
- `decideViaServer(payload, task, history)` — multipart POST to `/agent/decide`
- `configurePrivacy(settings)` / `getPrivacySettings()` — runtime config
- `getLastPrivacyRun()` / `getCumulativePrivacyStats()` — for the side panel UI

### `src/background/privacy-loop.js`
The privacy-aware agent loop. Implements the standard `capture → decide → execute → repeat` cycle but routes every capture through `captureAndSanitize()` first.

### `src/background/sw.js`
The OpenComet service worker. The privacy surface adds message routes:
- `PRIVACY_START` — start a privacy-aware agent run
- `PRIVACY_CONFIGURE` — update pipeline config at runtime
- `PRIVACY_CAPTURE` — one-shot capture + sanitize (used by the "Test capture" button)
- `PRIVACY_GET_STATS` — fetch cumulative stats for the UI
- `VISION_WARMUP` (v1.16.0) — fire-and-forget offscreen vision-model warm-up when a privacy session starts

### `server/server.js`
Express server. Single main endpoint `POST /agent/decide` accepts a multipart form (sanitised image + sanitised text + manifest + task + history + settings), forwards to the chosen VLM, parses the JSON response, returns an action plan. Provider implementations for OpenAI, Anthropic, Gemini, and Ollama (and OpenAI-compatible: Mistral / Groq / DeepSeek / Kimi / GLM).

### `src/sidepanel/sidepanel.html` + `.css` + `.js`
- A **Privacy Mode** toggle bar directly below the model selector
- A **gear button** that opens the Privacy & Vision settings page (pipeline toggles, SIH Scorecard, Live Firewall Inspector, About)
- A 4-cell stats strip showing last-capture latency, faces redacted, PII regions redacted, and active backend
- A message interceptor that rewrites `START_AGENT` → `PRIVACY_START` when Privacy Mode is on

### `src/content/agent.js`
An on-page "Privacy pipeline" card that pops up in the bottom-right of the page during a privacy run, showing what was redacted on the most recent capture + a small preview of the sanitised screenshot.

### `src/lib/privacy-firewall.js`
The single outbound boundary (v1.14): `sanitizeScreenContext()` → `validateSanitizedPayload()`; pass ships sanitized-only, fail throws `PrivacyBlockedError`. Includes the redact-and-verify secret-sweep masking introduced in v1.15.7.
