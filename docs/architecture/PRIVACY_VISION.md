# Privacy Vision Architecture — Deep Dive

This document describes the internal architecture of the OpenComet-SIH
privacy-preserving vision pipeline. It's intended for developers who want
to extend, debug, or replace parts of the system.

## 1. Module dependency graph

```
                       sidepanel.js
                            │
                            │  chrome.runtime.sendMessage
                            ▼
                       background/sw.js
                            │
                            │  routes PRIVACY_START / PRIVACY_CAPTURE / PRIVACY_CONFIGURE
                            ▼
                  background/privacy-loop.js
                            │
                            │  calls captureAndSanitize() + decideViaServer()
                            ▼
                    lib/privacy-agent.js
                            │
              ┌─────────────┼─────────────────┐
              ▼             ▼                 ▼
   lib/privacy-filter.js  chrome.scripting   fetch(server)
              │             │                 │
              │             ▼                 ▼
              │     injects pageContextScan  /agent/decide
              │     into tab → returns       (multipart POST
              │     { sensitive, text,       with sanitised
              │       photoCandidates }      image + manifest)
              │
       ┌──────┴───────┬──────────────┬───────────────┐
       ▼              ▼              ▼               ▼
  lib/pii-         lib/           lib/           lib/
  detector.js      mediapipe-    local-vision   canvas-
                   face.js       .js            redactor.js
       │              │              │               │
       │ regex + DOM  │ MediaPipe    │ Transformers  │ Canvas 2D
       │ scan         │ FaceDetector │ YOLO/ViT/NER  │ filter
       │              │              │               │
       └──────────────┴──────────────┴───────────────┘
                           │
                           ▼
                  sanitised payload
                  (image + manifest + text)
```

## 2. The data contract between client and server

The client sends a multipart form to `POST /agent/decide`:

| Field           | Type     | Description                                                          |
|-----------------|----------|----------------------------------------------------------------------|
| `image`         | file     | JPEG/PNG screenshot, **already redacted**. ≤ ~500 KB after redaction.|
| `sanitizedText` | string   | DOM text with `[REDACTED:<type>]` tokens in place of PII. ≤ 12 KB.   |
| `manifest`      | JSON str | Array of redacted regions: `{type, bounds, selector?, label?, reason, confidence}` |
| `task`          | string   | The user's high-level goal.                                          |
| `history`       | JSON str | Last 6 `{action, result}` entries.                                   |
| `settings`      | JSON str | `{provider, model, apiKey, providerBaseUrl, ollamaBaseUrl}`          |

The server responds with:

```json
{
  "ok": true,
  "backend": "ollama",
  "latencyMs": 820,
  "rawResponse": "<model's raw text>",
  "actionPlan": {
    "thought": "I see a search box at the top of the page",
    "action": { "type": "type", "selector": "input[name='q']", "text": "ISRO" },
    "confidence": 0.9,
    "is_complete": false
  },
  "manifestSummary": { "regions": 3, "byType": { "password": 1, "face": 1, "email": 1 } }
}
```

## 3. Per-redaction-type strategy

Each PII type gets a different pixel-level treatment. This isn't just
cosmetic — it tells the VLM something useful about what was underneath.

| Type             | Visual treatment        | Why this treatment                                                          |
|------------------|-------------------------|------------------------------------------------------------------------------|
| `face`           | Blur + black eye-bar    | Preserves "there is a person here" signal while destroying identity.         |
| `password`       | Solid black             | Unambiguous "this is a credential" signal.                                  |
| `credit_card`    | Solid black             | Same as password.                                                           |
| `aadhaar` / `pan`| Solid black             | Same.                                                                       |
| `voter_id` / `passport` / `driving_license` / `gstin` / `bank_account` / `ifsc` / `upi` | Solid black | Same — SIH v1.15.2 Indian ID family (EPIC, passport, DL, GSTIN, bank a/c, IFSC, UPI VPA). Context-gated formats (partial PAN, passport, DL) only fire when their label sits within ±40 chars. |
| `api_key`        | Solid black             | Same.                                                                       |
| `email` / `phone`| Pixelate (large blocks) | Preserves "there is contact info here" while destroying the value.          |
| `person` / `org` | Pixelate                | Same.                                                                       |
| `address`        | Pixelate                | Same.                                                                       |
| `dob` / `ip`     | Pixelate                | Same.                                                                       |

**Pixel-only sources (OCR, v1.15.4):** text baked into canvases/images is
covered by two OCR passes — the full-page recognize (word conf ≥ 60, with the
v1.14 low-confidence line rescue at ×2.5) plus a TARGETED crop pass: the DOM
hands over every visible `<canvas>` ≥60px (`pixelTextRects`, area-sorted,
cap 12) and larger `<img>` candidates; each ROI is re-read as an isolated
×2-upscaled crop where Tesseract's segmentation sees one small document
instead of a noisy page. ROI text runs through the shared PII detector (both
space-joined and line-fused variants) AND a structural battery that mirrors
the DOM text battery (email / Aadhaar-shape 4-4-4 / PAN / api-key /
13–19-digit card / ≥10-digit plausible phone; longest-span-wins). Findings
map back through the crop's own word spans; raw OCR text never propagates.
The shared detector's checksum semantics are untouched — battery hits are
structural, bounded to ≤12 crops, and labelled `ocr-roi` / `ocr-roi-battery`
in the manifest.

## 4. Coordinate-space handling

A common bug in canvas-based redaction is mixing CSS pixels (from
`getBoundingClientRect()`) with device pixels (from
`chrome.tabs.captureVisibleTab()`).

We solve this by passing `scaleX = scaleY = window.devicePixelRatio` from
the content script to the redactor. The redactor multiplies every box
coordinate by the scale before drawing.

```js
// privacy-agent.js
const dprInfo = await chrome.scripting.executeScript({
  target: { tabId },
  func: () => ({ dpr: window.devicePixelRatio || 1, ... }),
});
// ...
const result = await runPrivacyPipeline(
  { imageDataUrl, domText: text, domSensitive: sensitive },
  { ...opts, scaleX: dpr, scaleY: dpr }
);
```

## 5. Failure modes & mitigation

| Failure                            | Mitigation                                                                              |
|------------------------------------|------------------------------------------------------------------------------------------|
| WebGPU not available               | `local-vision.js` falls back to WASM SIMD automatically.                                 |
| Transformers.js fails to load      | YOLO / ViT / NER are all opt-in. Face detection + DOM scan + regex still work.           |
| MediaPipe fails to load            | `privacy-filter.js` catches the error and continues without face redaction. Logs warning.|
| Canvas redaction throws            | `privacy-filter.js` returns a 1×1 blank PNG. **The raw screenshot is never sent.**       |
| Server unreachable                 | `decideViaServer()` throws; the agent loop surfaces the error to the user.               |
| Server returns non-JSON            | `parseActionPlan()` returns `{action: {type: 'ask_user'}, parseError: true}`.            |
| VLM tries to "guess" redacted value| The system prompt explicitly forbids this: *"NEVER try to fill in or guess redacted values. Treat them as opaque."* |

### 5.1 Face-recall cascade (v1.15.3 DOM sweep + v1.15.4 avatar guard)

Face detection runs as a recall-ordered cascade in `privacy-filter.js` —
every stage must be model-confirmed before a pixel is blurred, except the
final avatar guard, which trades a slice of precision for closure of a
thrice-field-reported leak:

1. **Full-frame pass** (downscaled ≤1280px long edge, conf ≥ 0.35) — big faces.
2. **512px tile sweep** (conf ≥ 0.30) — medium/small faces on large captures.
3. **256px fine sweep** (conf ≥ 0.28, risk-adaptive cap 16/48 tiles) —
   avatars, webcam-overlay-sized faces.
4. **YOLO person-guided crop sweep** — when YOLO boxed a PERSON but no face
   fired, each person crop is upscaled (min edge ≈ 256px, ×4 cap) and
   re-scanned.
5. **DOM-guided image sweep (v1.15.3)** — the stage that fixed the
   user-reported "small profile photos stay visible" gap. `pageContextScan`
   now collects the rects of every visible `<img>` (≥24px, on-screen,
   decoded; avatar-likeness is a SORT key, not a gate; 32-region cap). Each
   region NOT already covered by a detected face is cropped from the capture,
   upscaled, and re-scanned by the same detector (`source:
   mediapipe-dom-crop`, conf ≥ 0.30, ~5–85ms per region). Deterministic: no
   tile-sampling lottery, no dependence on YOLO person boxes. Model-confirmed
   only — an image with no detectable face (logo, icon, illustration) is left
   untouched, never blanket-redacted.
6. **Avatar guard (v1.15.4, heuristic, privacy-first).** Field round two
   proved the model-gated sweep still leaks in two cases: avatars painted as
   CSS `background-image` (the collector only knew `<img>` — now collected
   too, `hint: bg-avatar-hint`) and portraits the detector refuses at every
   scale. An image the page ITSELF names as an avatar/profile photo
   (`avatar-hint` / `bg-avatar-hint` tokens; 24–180 CSS px min edge) that no
   confirmed face covers (stand-down test: a confirmed face box CENTER inside
   the element rect, or ≥25% intersection — measured face-box coverage spans
   33–52% across portraits, so ratio-only thresholds mis-fire) is redacted on
   its element rect with `source: dom-avatar-guard` and honest confidence
   0.5. Deliberate asymmetry: a wrongly guarded small hinted img costs a
   black square; a missed face ships identity. Un-hinted icons/logos are
   still scanned-never-redacted (negative control enforced by test).

Stages 1–3 pass candidates through a **verification rescan** (re-detect on an
upscaled margin crop, threshold 0.75) so page-layout textures cannot
hallucinate into face blurs; stages 4–5 already produce their hits by exactly
that upscaled-crop protocol; stage 6 is heuristic BY DESIGN and labelled as
such in telemetry (`stats.avatarGuard`) and console lines
(`Faces(avatar-guard): …`).

## 6. Performance budget

Measured on a 2023 MacBook Pro M2, Chrome 120, 1280×800 viewport:

| Phase                          | Time (ms) | Notes                                        |
|--------------------------------|----------:|----------------------------------------------|
| `chrome.tabs.captureVisibleTab`|        15 | PNG encode on service worker                 |
| DOM scan (content script)      |         3 | Synchronous, ~4000 text nodes                |
| MediaPipe face detect (WebGPU) |        24 | First call has ~600 ms init; cached after    |
| YOLO object detect (opt-in)    |        62 | First call has ~1.5 s init; cached after     |
| Regex PII scan                 |         2 | Trivial                                      |
| BERT NER (opt-in)              |       180 | First call has ~3 s init; cached after       |
| Canvas redaction               |         8 | 5–20 regions typical                         |
| **Total client pipeline**      |   **~50** | Without YOLO/NER                             |
| Network upload (sanitised PNG) |        40 | ~80 KB                                       |
| Server-side VLM (Ollama llava) |       720 | Local                                        |
| **Total end-to-end per step**  |  **~810** |                                               |

For comparison: a non-private pipeline (raw screenshot + raw DOM upload → cloud GPT-4o) typically takes ~1200 ms end-to-end. The privacy pipeline adds <100 ms client-side and actually *saves* time on the upload (smaller payload).

## 7. CSP & permissions

`manifest.json` declares:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'; object-src 'self'; connect-src 'self' https: http://127.0.0.1:* http://localhost:* data: blob:; img-src 'self' data: blob: https:; worker-src 'self' blob:;"
}
```

- `'wasm-unsafe-eval'` — required by ONNX Runtime Web / Transformers.js / MediaPipe WASM.
- `'unsafe-inline'` — needed because Transformers.js and MediaPipe inject inline styles.
- `connect-src https:` — allows fetching models from `huggingface.co` and `storage.googleapis.com`.
- `connect-src http://127.0.0.1:*` — allows talking to a local Ollama / companion server.
- `worker-src 'self' blob:` — Transformers.js spawns blob: workers for WebGPU.

`host_permissions` includes the three CDN domains so the user doesn't get a permission prompt on first model load.

## 8. Extending the pipeline

### Add a new PII regex

Edit `src/lib/pii-detector.js`:

```js
const REGEX_PATTERNS = [
  // ...existing patterns...
  {
    type: 'my_custom_type',
    re: /MY_PATTERN/g,
    confidence: 0.85,
  },
];
```

Add a corresponding case to `maskForType()` and `canvas-redactor.js`'s switch statement if you want a custom pixel treatment.

### Add a new local model

Edit `src/lib/local-vision.js`:

```js
const MODEL_ID = {
  // ...
  myModel: 'Xenova/my-model',
};

export async function getMyPipeline() {
  if (_pipelines.myModel) return _pipelines.myModel;
  const tr = await loadTransformers();
  _pipelines.myModel = await tr.SomeTask.fromPretrained(MODEL_ID.myModel, {
    quantized: true,
    device: _stats.backend === 'webgpu' ? 'gpu' : 'cpu',
  });
  return _pipelines.myModel;
}
```

### Add a new VLM backend

Edit `server/server.js`:

1. Add the backend name to `detectBackend()`.
2. Add a `defaultModelFor()` case.
3. Add a `callXxx()` function (use `callOllama()` or `callOpenAICompatible()` as templates).
4. Add a case in `callModel()`'s switch.

That's it — the extension doesn't need any changes; the backend is selected server-side based on the `settings` JSON the extension sends.
