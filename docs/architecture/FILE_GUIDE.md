# File-by-file guide

Map of the modules behind the privacy pipeline and the agent loop. For the
architecture narrative see [PRIVACY_VISION.md](./PRIVACY_VISION.md); for setup
and workflows see the [Developer guide](../guides/DEVELOPER_GUIDE.md).

## `src/lib/pii-detector.js`

Pure-JS PII scanner with no dependencies. Combines eleven high-precision regex
patterns, with Luhn validation for card numbers, and DOM-sensitive-field
detection: `type=password`, sensitive autocomplete tokens, and name or
placeholder hints. Optionally accepts a pre-loaded Transformers.js NER pipeline
for person, organisation and address entities that do not follow a pattern.

## `src/lib/mediapipe-face.js`

Wraps `@mediapipe/tasks-vision` `FaceDetector` around the BlazeFace Short Range
model (INT8, about 1 MB), vendored in `src/vendor/mediapipe/` so no network is
needed. WebGPU delegate preferred, WASM fallback automatic. Runs a tiled sweep
(512 px down to 256 px fine tiles) with a verify-rescan for small faces, and a
YOLO person-crop re-sweep as a recall backstop. Caches the pipeline singleton.

## `src/lib/local-vision.js`

Wraps `@huggingface/transformers` and exposes three lazy-loaded pipelines:
object detection (YOLO), image classification (ViT) and NER (BERT). The backend
is chosen automatically: `webgpu` when `navigator.gpu` exists, otherwise
`wasm`. All models are INT8. Also exposes `preloadLocalVision()`, the warm-up
hook used by the v1.16.0 session warm-up.

## `src/lib/canvas-redactor.js`

Pixel-level redactor. Takes a PNG data URL and a region list, returns a JPEG
data URL with each region treated by type:

- **Faces**: Gaussian blur plus an opaque bar across the eyes.
- **Credentials** (password, API key, card, Aadhaar, PAN, SSN, IBAN): solid
  black.
- **Free-form text PII** (email, phone, date of birth, person, organisation,
  address): pixelated.

Each region can carry an optional badge label.

## `src/lib/privacy-filter.js`

The orchestrator. Calls the modules above in parallel where possible and
produces:

- `sanitizedDataUrl`: the only image allowed to leave the client.
- `manifest`: redacted regions with type, bounds, reason and confidence.
- `sanitizedDomText`: DOM text with `[REDACTED:<type>]` tokens.
- `stats`: per-phase latency, counts, backend, and memo telemetry
  (`ocrMemoHit`, detector memos).

## `src/lib/privacy-agent.js`

Bridges the pipeline to the background worker. Exposes:

- `captureAndSanitize(tabId)`: capture, DOM scan, pipeline run.
- `decideViaServer(payload, task, history)`: multipart POST to `/agent/decide`.
- `configurePrivacy(settings)` and `getPrivacySettings()`: runtime config.
- `getLastPrivacyRun()` and `getCumulativePrivacyStats()`: side panel data.

## `src/background/privacy-loop.js`

The privacy-aware agent loop. Runs the same capture, decide, execute cycle as
the standard loop, but every capture goes through `captureAndSanitize()` first.

## `src/background/sw.js`

The service worker. The privacy surface adds these message routes:

- `PRIVACY_START`: start a privacy-aware run.
- `PRIVACY_CONFIGURE`: update pipeline config at runtime.
- `PRIVACY_CAPTURE`: one-shot capture and sanitize, used by the test button.
- `PRIVACY_GET_STATS`: cumulative stats for the UI.
- `VISION_WARMUP` (v1.16.0): fire-and-forget offscreen warm-up when a privacy
  session starts.

## `server/server.js`

Express server. `POST /agent/decide` accepts a multipart form (sanitized image,
sanitized text, manifest, task, history, settings), forwards it to the chosen
model, parses the JSON response and returns an action plan. Providers: OpenAI,
Anthropic, Gemini, Ollama, and OpenAI-compatible gateways (Mistral, Groq,
DeepSeek, Kimi, GLM).

## `src/sidepanel/sidepanel.html`, `.css`, `.js`

- A Privacy Mode toggle bar below the model selector.
- A gear button opening Privacy & Vision settings: pipeline toggles, SIH
  scorecard, live firewall inspector, About.
- A four-cell stats strip: last capture latency, faces redacted, PII regions
  redacted, active backend.
- A message interceptor that rewrites `START_AGENT` to `PRIVACY_START` when
  Privacy Mode is on.

## `src/content/agent.js`

The on-page Privacy pipeline card. Appears bottom right during a run and shows
what was redacted on the most recent capture, with a thumbnail of the sanitized
screenshot.

## `src/lib/privacy-firewall.js`

The single outbound boundary (v1.14): `sanitizeScreenContext()` then
`validateSanitizedPayload()`. A pass ships sanitized data only; a failure throws
`PrivacyBlockedError`. Contains the redact-and-verify masking from v1.15.7.
