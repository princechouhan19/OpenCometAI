# OpenComet-SIH — Privacy-Preserving Vision Agent for Browsers

> **SIH Problem Statement #26171** — *On-device Visual Perception for Light-weight Browser Agents*
> Organisation: **Indian Space Research Organisation (ISRO)**, Department of Space

A working prototype that turns the OpenComet browser extension into a **privacy-preserving vision agent**: a local Vision Transformer + face detector + PII scanner runs entirely in the browser (via Transformers.js + MediaPipe on WebGPU/WASM). Sensitive content is redacted on-device **before any network request is made**. Only the sanitised screenshot + sanitised DOM + a redaction manifest are sent to the server, which forwards them to an LLM/VLM and returns an action plan the browser executes.

Since v1.5.0 the on-device brain is **Gemma 4** (Google DeepMind's MoE multimodal lineup): native tool calling, screenshot understanding and live token streaming run fully client-side via Transformers.js v4 + WebGPU — with page-RAG (`ask_website` + `highlight_element`) and semantic history search (`find_history`) ported from the gemma4-browser-extension reference. See **docs/GEMMA4_INTEGRATION.md**.

```
   ┌──────────────── BROWSER (client) ────────────────┐         ┌──── SERVER ────┐
   │                                                   │         │                │
   │  tab capture  →  MediaPipe face detect (WebGPU)   │         │  Express +     │
   │              →  Transformers.js YOLO/ViT (opt)    │         │  VLM adapter   │
   │              →  DOM PII scan (regex + NER opt)    │  HTTPS  │  (OpenAI /     │
   │              →  Canvas redact (blur/black/pix)    │ ──────▶ │   Claude /     │
   │                                                   │         │   Gemini /     │
   │  sanitised image + manifest + redacted text only  │         │   Ollama)      │
   │                                                   │ ◀────── │                │
   │  execute returned action (click / type / scroll)  │         │  JSON action   │
   │                                                   │         │  plan          │
   └───────────────────────────────────────────────────┘         └────────────────┘
```

---

## 1. What's in this package

```
OpenCometAI-SIH/
├── manifest.json                ← MV3 manifest, WebGPU/WASM CSP, CDN host perms
├── src/
│   ├── background/
│   │   ├── sw.js                ← existing OpenComet SW + 4 new privacy routes
│   │   ├── privacy-loop.js      ← NEW: privacy-aware agent loop
│   │   ├── actions.js           ← DOM action executors (unchanged)
│   │   └── state.js
│   ├── content/
│   │   └── agent.js             ← overlay HUD + NEW: on-page redaction viz
│   ├── lib/
│   │   ├── privacy-filter.js    ← NEW: pipeline orchestrator
│   │   ├── privacy-agent.js     ← NEW: bridges pipeline ↔ SW ↔ server
│   │   ├── local-vision.js      ← NEW: Transformers.js wrapper (YOLO + ViT + NER)
│   │   ├── mediapipe-face.js    ← NEW: MediaPipe FaceDetector wrapper
│   │   ├── pii-detector.js      ← NEW: regex + DOM + optional NER PII scanner
│   │   ├── canvas-redactor.js   ← NEW: pixel-level redaction (blur/black/pix)
│   │   └── … (existing OpenComet modules)
│   └── sidepanel/
│       ├── sidepanel.html       ← +Privacy Mode bar + config drawer
│       ├── sidepanel.css        ← +Privacy UI styles
│       └── sidepanel.js         ← +Privacy Mode controller
├── server/                      ← NEW: companion VLM server
│   ├── server.js
│   ├── package.json
│   └── README.md
├── OpenCometBench/              ← THE BENCHMARK (renamed from benchmarks/)
│   ├── README.md                ← doc + usage guide for every tier
│   ├── OPENCOMET_BENCH.md       ← branded benchmark specification
│   ├── run-opencomet-bench.mjs  ← one-command auto-run against OpenComet itself
│   ├── run-all.js + suites      ← UNIT tier (Node, no browser needed)
│   ├── browser/ · e2e/          ← REAL-pixels + real-extension-loop harnesses
│   └── results/                 ← measured reports (import into the Scorecard)
├── scripts/                     ← test suites + deterministic packaging
├── assets/
├── CODE_OF_CONDUCT.md           ← community standards + privacy/measurement rules
├── LEGAL.md                     ← license, vendored components, data policy
├── CONTRIBUTING.md              ← contribution workflow
└── docs/
    ├── NOVELTY.md               ← claim-by-claim novelty, each with evidence
    ├── PRIVACY_VISION.md        ← architecture deep-dive
    ├── SIH_READINESS.md         ← readiness vs the problem statement, per version
    └── DEMO.md                  ← step-by-step demo script
```

---

## 2. Quick start

### 2.1 Load the extension (Chrome / Edge / Brave)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select the `OpenCometAI-SIH/` folder.
4. Pin the OpenComet icon to your toolbar.
5. Open the side panel (click the icon → "Open side panel").

### 2.2 Start the companion server

```bash
cd OpenCometAI-SIH/server
npm install

# Pick ONE backend:
OPENAI_API_KEY=sk-...            npm start   # OpenAI GPT-4o
ANTHROPIC_API_KEY=sk-ant-...     npm start   # Claude Sonnet
GEMINI_API_KEY=...               npm start   # Gemini Flash
OLLAMA_BASE_URL=http://localhost:11434 npm start   # local Ollama llava:7b (offline)
```

The server listens on `http://127.0.0.1:8787` by default.

### 2.3 Try the demo page

Open `docs/demo-page.html` in a browser tab (drag the file into Chrome, or
serve it locally with `python -m http.server`). It contains:
- a profile photo (face-detection target)
- a form with `password`, `email`, `tel`, `cc-number`, `cc-csc`,
  `one-time-code` inputs
- a text block with every supported PII type (email, phone, Aadhaar, PAN,
  SSN, credit card, IBAN, API key, DOB, IP, URL with credentials)

Click **Test capture + redact** in the side panel to instantly see the
sanitised preview — every sensitive field should be either solid black
(credentials), pixelated (free-form PII), or blurred (face).

### 2.4 Run a task

1. Open the side panel. **Privacy Mode is ON by default** (orange toggle).
2. (Optional) Click the gear icon next to the toggle to configure:
   - Blur faces ✓
   - Redact password / card / OTP fields ✓
   - Scan DOM text for emails / phones / Aadhaar / PAN / SSN / API keys ✓
   - Run YOLO object detection (adds ~50ms — opt-in)
   - Run BERT NER for person/org/address entities (large model — opt-in)
   - Server URL → `http://127.0.0.1:8787`
3. Click **Test capture + redact** to see a preview of exactly what the server will receive.
4. Type a task in the chat box, e.g.:
   > "Find the cheapest flight from Bengaluru to Delhi next Friday and tell me the price."
5. Hit **Send** (or `Ctrl/Cmd + Enter`).

The agent will:
- capture the current tab
- run the local vision + PII pipeline (~30–80 ms on WebGPU)
- show an on-page card summarising what was redacted
- upload only the sanitised image + DOM + manifest to the server
- receive a JSON action plan and execute it (click, type, scroll, navigate…)
- repeat until the task is complete

---

## 3. How the privacy contract works

### 3.1 Three-layer redaction

| Layer           | Tool                     | What it catches                                              | Latency |
|-----------------|--------------------------|--------------------------------------------------------------|--------:|
| **Pixel-level** | MediaPipe Face Detector  | Human faces → blur + black eye-bar                           |  15-40ms|
| **Pixel-level** | Canvas redactor          | DOM `<input type=password>`, card fields, OTP fields → black |   3-8ms |
| **Text-level**  | Regex + optional NER     | Emails, phones, Aadhaar, PAN, SSN, IBAN, API keys, DOB, IPs  |   2-5ms |
| **Pixel-level** | Canvas pixelate          | Free-form PII text (person names, addresses) → pixelated     |   3-8ms |

### 3.2 The redaction manifest

Every redacted region is described in a JSON manifest that travels **with** the sanitised image to the server. The server's prompt includes this manifest so the VLM knows *what* it cannot see and *why*:

```json
[
  { "type": "password",     "bounds": {"x":420,"y":180,"w":180,"h":32}, "selector":"input#pw",  "label":"Password", "reason":"dom",           "confidence":1.0  },
  { "type": "face",         "bounds": {"x":60,"y":40,"w":120,"h":120},                                          "reason":"mediapipe-face", "confidence":0.97 },
  { "type": "email",        "bounds": {"x":420,"y":140,"w":180,"h":32}, "selector":"input#email","label":"Email",   "reason":"dom",           "confidence":0.95 }
]
```

### 3.3 Text-level PII tokens

When PII is found in the DOM text, it is replaced inline with `[REDACTED:<type>]` tokens *before* the text is sent. Example:

> `Welcome back, [REDACTED:person]! We sent a confirmation to [REDACTED:email]. Your order #12345 will arrive at [REDACTED:address] on [REDACTED:dob].`

The server's system prompt explains this convention so the VLM treats the tokens as opaque placeholders and never tries to guess the underlying values.

### 3.4 Fail-closed behaviour

If the privacy pipeline throws for any reason (e.g. WebGPU unavailable, model failed to load), the agent does **not** fall through to sending the raw screenshot. Instead it returns a blank 1×1 PNG and surfaces the error in the side panel. **Privacy is the default; sending raw pixels is never the failure mode.**

---

## 4. Evaluation mapping (SIH problem statement)

| Metric                                                        | Weight | How we address it                                                                                                                              |
|---------------------------------------------------------------|-------:|------------------------------------------------------------------------------------------------------------------------------------------------|
| 1. Accuracy of visual context from screen                     |    25% | Structured visual context (`page-classifier.js`): page-type + visual elements fused from DOM/URL signals and ViT (Xenova/vit-base-patch16-224) scene labels, run ADAPTIVELY (only on visual change / DOM uncertainty). Injected into the VLM prompt on every decision. Measured: 10/10 page types in `OpenCometBench/visual-context.bench.js`. |
| 2. Recall & precision for detection of sensitive / PII data   |    20% | Four-layer detector: (a) MediaPipe tiled faces, (b) DOM semantics, (c) regex + CHECKSUM validation (Luhn cards, Verhoeff Aadhaar, mod-97 IBAN, SSN plausibility), (d) contextual risk scoring that suppresses order numbers / year sequences / future dates. Measured P=1.00 R=1.00 on the synthetic suite (`OpenCometBench/privacy.bench.js`). |
| 3. Precision of redaction                                     |    20% | Per-type strategy (secret→black, personal→pixelate, face→blur), fail-closed blank frame on engine crash, SAFE manifest (normalized region ids — no raw selectors/labels leave the browser). Measured: coverage 0.983, IoU 0.938, over-redaction 5.9% (`OpenCometBench/redaction.bench.js`). |
| 4. Client-side resource utilisation                           |    20% | All models quantised INT8. WebGPU first, WASM SIMD fallback. Total client RAM ≈ 50–150 MB. Models lazy-loaded only when Privacy Mode is on.   |
| 5. Overall end-to-end latency                                 |    15% | Speed profiles (fast/balanced/quality) scale image edge / text cap / output tokens for ANY provider; unchanged-page shot REUSE skips capture+upload entirely; per-run P50/P90 latency profile measured by the loop (`privacy-loop.js latencyProfile`) and shown in the SIH Scorecard. |

---

## 4b. SIH benchmark suite (all numbers measured, never fabricated)

```bash
node OpenCometBench/run-all.js          # runs every suite, prints a table, exit 0 = all targets met
node OpenCometBench/run-all.js --json   # machine-readable → importable in the side panel Scorecard
```

The whole benchmark now lives in **[`OpenCometBench/`](./OpenCometBench/README.md)**
(renamed from `benchmarks/` — same harnesses, same measured numbers; the branded
specification is `OpenCometBench/OPENCOMET_BENCH.md`, and the folder README is the
doc + usage guide for every tier). One command auto-runs the tiers against
**OpenComet itself** — the real unpacked extension — and writes a summary report:

```bash
node OpenCometBench/run-opencomet-bench.mjs        # UNIT + E2E (real extension, mock decisions)
node OpenCometBench/run-opencomet-bench.mjs --all  # + ADVERSARIAL + BROWSER tiers
npm run bench                                      # same as the default above
```

Four Node suites run the REAL shipping modules against synthetic data:

| Suite | Measures | Target |
|---|---|---|
| `privacy.bench.js` | PII precision / recall / F1 per type (regex + checksum validators + contextual risk) | P ≥ 0.97, R ≥ 0.95 |
| `redaction.bench.js` | region coverage, mean IoU, over-redaction %, style mapping, safe-manifest integrity | coverage ≥ 0.98 |
| `visual-context.bench.js` | page-type accuracy, visual elements, adaptive ViT gate decisions | accuracy ≥ 0.95 |
| `security.test.js` | 28 leakage/fail-closed/injection/coordinate tests incl. raw-screenshot-block, manifest stripping, nonce fencing, DPR matrix | 28/28 |

`OpenCometBench/browser/runner.html` measures on-hardware values Node cannot
(WebGPU/WASM backend, real sanitize P50/P90, JS heap, payload KB) — export its
JSON and import it in **Settings → Privacy → SIH Scorecard**.

**Authoritative real-hardware result** (`OpenCometBench/results/browser-benchmark-1788731519242.json`,
Windows · Chrome 152 · AMD Radeon · WebGPU · headed — same machine as the v1.14.2
post-memo run `browser-benchmark-1788729358673.json` (warm P50 1215 ms, reproduced)
and the pre-memo baseline `browser-benchmark-1788724999257.json`): visual
context DOM 12/12 and ViT-fused 12/12 (n=12); redaction matrix 72 runs / 340 GT
regions — coverage 1.000, mean IoU 0.987, pixel leakage 0/340, over-redaction 0%;
OCR **0.75 geometric coverage** with **4/4 pixel regions altered** and zero
observed pixel leakage (fail-closed verified); sanitize **P50 1216 ms / P95
1372 ms warm** (unchanged screen — the exact-capture-keyed detector memo hits and
OCR, at 1120 ms, is now the dominant phase), payload 48 KB. The **changed-frame**
(memo-MISS) total is now **measured exactly** on the same silicon:
**12885 ms** wall with **7841 ms** YOLO re-detection and a 3402 ms OCR leg
(n=1, `resources.changedFrame`), and the identical-frame follow-up re-hits the
memo (4412 ms, YOLO 0 ms) — the pre-memo 8014 ms P50 / 6766 ms YOLO remains the
cost-class cross-check. Any pixel change pays the changed-frame cost, by design
(scene-change-attack verified). Both totals are measured results — neither is
"lightweight".
For admins/judges: open `OpenCometBench/dashboard.html` — the performance monitor
pre-loads this report and accepts any newer result JSON by drag-and-drop.

The **Privacy Firewall — Live Inspector** (same settings page) shows the real
runtime firewall envelope for the last sanitized capture: raw-transmitted=NO,
verification status, faces/PII/secrets counts, client ms and payload KB.

### Central privacy firewall & fail-closed network gate

`src/lib/privacy-firewall.js` is the single boundary every network-bound
screen context passes through:

```
raw screen → runPrivacyPipeline → sanitizeScreenContext() → validateSanitizedPayload()
                                                   pass → send sanitized only
                                                   fail → PrivacyBlockedError (nothing sent)
```

All three decision paths (on-device, direct provider, companion server) are
gated; the assembled VLM prompt is additionally swept for secret-shaped text
right before transmission. A redaction engine crash degrades to a blank
1×1 frame — never raw pixels.

### Tab-group sandbox (v1.15.0) — the agent acts only inside its task group

Like Claude for Chrome, every task runs inside a **visible Chrome tab group**
(blue, titled with the task): privacy mode groups the task tab at start, tabs
the task opens (`new_tab`, `target=_blank`, `window.open`) are adopted into
the group, and every tab action (`switch_tab`, `close_tab`, `list_tabs`,
`organize_tabs`) plus the screen capture itself is bounded to the sandbox's
member tabs. `list_tabs` no longer leaks the titles/URLs of the user's OTHER
browser tabs into the VLM prompt, `organize_tabs` can no longer regroup or
close user tabs, and if the visible tab drifts out of the group mid-run the
capture re-focuses the task tab instead of photographing a foreign page —
with an honest sidebar step when that happens. If the sandbox becomes empty
(task tab closed) the loop fails closed instead of wandering. Shared logic
lives in `src/lib/tab-sandbox.js`; unit tests in `scripts/test_tab_sandbox.mjs`.

### Action verification integrity (v1.15.0 fix)

v1.14 introduced content/control/canvas signatures into the click verifier's
page-injected fingerprint — but the four helper functions lived OUTSIDE the
injected function, so `chrome.scripting.executeScript` (which serializes only
the handed function) threw inside the page and every click fingerprint
resolved `null`. The hole was masked by a Gmail-only mail-send probe that
reported `composeClosed=true` on ANY site, labelling unevaluated clicks as
"VERIFIED — compose window closed" (the field log on YouTube caught it
verbatim). v1.15.0 makes the fingerprint self-contained, host-gates the mail
probe, and adds a tab-level navigation lens for pages that are legitimately
mid-teardown — strictly scoped so it can never inflate a readable verdict.
The 10-scenario E2E-MOCK suite re-measures identically (verifiedActionRatio
0.952, task success 1.0) — now with real per-click evidence
(`e2e-benchmark-1788901453012.json`).

### Human-in-the-loop + honest no-ops (v1.15.1)

Field run #2 (6 steps / 194 s, YouTube, qwen3-vl) plus user bug reports drove
five changes. **Stop-button fix:** the privacy flow double-wrapped its
`AGENT_DONE`/`AGENT_ERROR` broadcasts (`broadcast({type:…})` into a helper that
wrapped again), so the sidebar never learned the task had finished — the Stop
button stayed visible after "Task complete" and late clicks produced
"Stopping…"/"Unable to add context right now." noise. **Ask before acting**
(now real): with the composer mode set to "Ask before acting", every privacy-run
action — primary and queued — waits for an in-chat approval card
(**Allow once / Skip / Stop task**); Skip writes an honest history entry and
asks the model again, Stop aborts; the choice survives panel reloads.
**Live context** (now real): text sent while a task runs is drained into the
NEXT decision prompt as high-priority user context (PII-swept, consumed once).
**Media no-ops:** "media play" on an already-playing video now reports a
VERIFIED no-op ("ALREADY IN STATE", ACTION_VERIFIED) instead of a misleading
NO CHANGE — E2E-MOCK verifiedActionRatio 0.952 → 1.000. **Console visibility:**
every model call logs `[VLM-REQ]` (full prompt text + image meta, pixels never
dumped), `[VLM-RAW]` (model text pre-parse) and `[VLM-RES]` (parsed response).
Also: long model names ellipsize in the model pill/dropdown, the duplicate
top-right settings ("sun") icon is gone, and a real-browser regression suite
(`scripts/test_v1151_panel.mjs`, 28 checks) pins all of it.

### Indian ID expansion + live per-task scorecard (v1.15.2)

Field screenshot (gov scheme form): the Aadhaar box was correctly black-barred
but a PARTIALLY-typed PAN ("ABCDE1234", check letter not yet entered) stayed
visible — the strict 10-char PAN pattern couldn't match it and the DOM hint
list only knew `pan[-_]?number`, so the field itself was never redacted. Two
layers fixed. **Detector expansion** (`pii-detector.js`): partial/mid-entry
PAN (context-gated on a PAN label within ±40 chars), Voter ID/EPIC
(`ABC1234567`), Indian passport (context-gated), driving licence
(state+RTO+year+serial, context-gated), IFSC, UPI VPA (known PSP/bank
handles — e-mail never matches), GSTIN (wins the span from the embedded PAN
in dedupe), bank account numbers (label-gated, digits-only match so the label
never leaks through the mask), CVV/card-PIN assignments (secret-span mask),
and 16-digit Aadhaar Virtual IDs (Verhoeff extended to 16). A labelled DL
also wins its span from the greedy phone detector. **DOM layer**: the
sensitive-input hint list now covers every Indian ID family, so a field named
`pan`/`voter`/`passport`/`dl`/`ifsc`/`upi`/`gstin`… is black-barred whole —
exactly the treatment the Aadhaar box already got. All new types render as
solid black. **SIH Scorecard** (Settings → Privacy & Vision): the panel now
says what it is for — benchmark rows fill by importing reports, and the LIVE
rows (VLM P50, sanitize P50 + a new per-task privacy report row) fill in
AUTOMATICALLY when a privacy task completes, from the DONE summary's measured
census (redactions by family, frames, payload, verification), and persist
across panel reloads. No fabricated numbers: untouched rows still read "—".
Verification: `node scripts/test_indian_pii.mjs` 41/41; full unit suites re-run
— PII precision/recall 1.00/1.00 (366+/148−), fuzz 0 leaks (216), security
29/29, server-validation 25/25, redaction coverage 0.983, visual 1.00/0.95.

### Small-profile-photo face redaction (v1.15.3)

Field report: on a complex test page every PII family redacted correctly
(`{"password":1,"sensitive_input":9,"phone":2,"pan":1,"dob":1,"email":2}`) but
the small profile photo stayed VISIBLE with **"Faces detected: 0"** — and the
user had "noticed many times" that small profile images escape the blur. Root
cause: the pixel cascade (full-frame → 512px tiles → 256px fine tiles → YOLO
person-crop) is probabilistic — tile caps sample positions, a head-only crop
inside a small `<img>` can sit below every stage's firing threshold, and YOLO
rarely boxes a thumbnail person, so the last-resort person-guided sweep never
had a region to work with. **Fix — deterministic DOM-guided face sweep**:
`pageContextScan` now also returns `photoCandidates` (rects of every visible,
decoded `<img>` ≥24px; avatar-likeness hints + roundness + small size only
SORT the list, nothing is excluded; 32-region cap; rects only, no image
data). The pipeline crops each region not already covered by a detected face
from the capture, upscales it (min edge ≈256px, ×4 cap — a 64px avatar face
becomes ~200px), and lets the SAME MediaPipe detector confirm (conf ≥ 0.30,
source `mediapipe-dom-crop`, ~5–85ms/region). Model-confirmed only: logos and
generic icons are scanned but never redacted (verified negative control).
When the cascade already caught the face, the sweep stands down (zero extra
work). Console honestly reports the stage: `Faces(dom-sweep): N detected …`.
Verification: new `scripts/test_dom_face_sweep.mjs` 17/17 on real browser
pixels + the real vendored model — collector behaviour (skip <24px/src-less,
cap 32), cascade-disabled rescue (faces 0 → dom-sweep finds it, box lands on
the avatar), cascade-covered stand-down, icon no-redaction, DPR 1.25
coordinate mapping; full regression re-run green (PII 1.00/1.00, fuzz 0
leaks, security 29/29, server-validation 25/25, scene-change 25/25, panel
28/28, sandbox 12/12, redaction coverage 0.983 unchanged).

### Field-report hardening round two (v1.15.4)

Second field round on the user's 7-section "Master Perception Test" page
(Total 18068 ms, `Faces detected: 0`, DOM sensitive 10, Text PII 5): the
small profile photo STILL escaped (`"WHEN PROFILE IMAGE IS SMALL ITS UNABLE
TO HIDE THAT"`), and the screenshots exposed three further leak classes.
Four minimal, targeted fixes — everything else untouched:

1. **Avatar guard (deterministic small-photo cover).** The v1.15.3 sweep is
   model-confirmed-only, so a portrait the detector refuses (or an avatar
   painted as a CSS `background-image`, which the v1.15.3 collector never
   saw) still shipped visible after three field reports. `pageContextScan`
   now ALSO collects background-image avatar elements (avatar-hint word
   prefilter on class/id/style → computed-style check; `hint:
   bg-avatar-hint`), and `privacy-filter.js` step 3b″ adds a GUARD: an image
   the page itself names as an avatar/profile photo (avatar-hint /
   bg-avatar-hint, 24–180 CSS px) that no confirmed face covers is redacted
   on its element rect WITHOUT model confirmation (source
   `dom-avatar-guard`, honest confidence 0.5, stand-down when a confirmed
   face box centers inside the element — measured 33–52% coverage ratios, so
   center-inside is the decisive test). Asymmetry is deliberate: a wrongly
   blurred small hinted img costs a black square, a missed face ships the
   user's identity. Un-hinted icons/logos remain scanned-never-redacted.
2. **Person-name fields.** The "Full name" leak: `<label>Full name</label>
   <input value="Aarav Sharma">` — a bare input with zero attribute signal.
   Both scanners (`pageContextScan` + `detectSensitiveDomElements`) now read
   the field's visible LABEL (`el.labels`, wrapping label, label inside the
   same container, previous-sibling label) and match a word-bounded
   person-name family (full/first/last/given/family/surname, customer/
   card-name/card-holder/account-holder, father's/mother's/spouse/nominee,
   billing/shipping/contact name, `autocomplete="name|given-name|…"`.
   "filename"/"hostname" cannot match (word boundary), the "Search public
   information…" box stays untouched (verified negative control).
3. **Pixel-only PII (targeted OCR crops).** The full-page OCR pass read only
   ONE value of the canvas line (the phone) and NONE of the two pixel-only
   contact cards — small text on busy pages is where Tesseract's page
   segmentation drops lines. `pageContextScan` now returns `pixelTextRects`
   (visible canvases ≥60px, area-sorted, cap 12); the OCR pass re-reads each
   ROI as an ISOLATED ×2-upscaled crop (decode once, same warmed worker) and
   runs BOTH the shared PII detector (space-joined + line-fused variants) AND
   a structural battery mirroring the DOM text battery (email / 4-4-4
   Aadhaar-shape / PAN / api-key / 13–19-digit card / ≥10-digit phone with
   plausibility guards, longest-span-wins arbitration). Findings map back
   through the crop's own word spans to full-image boxes. Raw crop text never
   propagates. The shared `detectPiiInText` semantics are untouched (the
   41-test corpus still locks its precision).
4. **DOM text-PII walker budget 140 → 400.** The battery walker decrements on
   EVERY accepted text node, so on the 7-section page it ran out around
   section 3 — the `Invoice email: billing.pixel@example.com` row (section 4)
   never got scanned and shipped readable. 400 stays O(ms) and bounded.

Verification: new `scripts/test_v1154_fixes.mjs` 23/23 on real browser pixels
+ real models — name-field flag + pixel black-box (both scanners, parity),
background-avatar guard rescue (model-unconfirmable gradient avatar covered;
real portrait confirmed by the sweep with the guard standing down — exactly
ONE face region), un-hinted icon negative control preserved, canvas OCR ROI
(type coverage email/phone/credit_card + ≥2 regions per canvas + PIXEL-LEVEL
raw-vs-sanitized diff proof: 10.0%/31.6% of canvas pixels mutated), walker
budget (email at node ~221 flagged), collector caps. Full regression green:
dom-face-sweep 17/17, indian-pii 41/41, scene-change 25/25, panel 28/28,
sandbox 12/12, security 29/29, server-validation 25/25, fuzz 0 leaks,
privacy bench P/R 1.00/1.00 (366+/0FP/0FN), redaction coverage ~0.98,
visual-context 1.00/0.95.

### About page (v1.15.5 — UI only)

Settings gains an **About** entry (hero with the real running version read
from `chrome.runtime.getManifest()`, a What's-New changelog summarizing
v1.14 → v1.15.5, project details for PS #26171 / ISRO, and a one-click
"copy build info" for bug reports). The version chip always reflects the
actually-loaded build, so a stale unpacked copy can no longer masquerade as
the current one. Zero changes to any detection, redaction or agent-loop
file in this release — the privacy pipeline is byte-identical to v1.15.4.
Verification: new `scripts/test_about_page.mjs` 21/21 on the real unpacked
extension (manifest-version parity, logo load, changelog order, save-button
hidden, copy-build-info outcome, zero page errors); v1.15.1 panel suite
still 28/28.

### Final answers + Profile custom info (v1.15.6)

Field report (summarize task on the qwen thinking backend): the loop
sanitized, asked the VLM once, and finished "in 1 steps" with a bare
**"Task complete."** — the summary the user asked for was NEVER delivered.
Root cause: the privacy decision prompt had no answer channel (no `message`
field on the done action, no information-task rule), the loop dropped the
payload at `is_complete`, and `AGENT_DONE` reached the panel without an
`answer`, so the result card fell back to the hardcoded string.

1. **Answer channel end-to-end.** The decision contract gains
   `action.message` ("the COMPLETE final answer … REQUIRED for done on
   information/summary tasks") and an INFORMATION-TASKS rule that explicitly
   lifts the page-state verification requirement for summarize/QA asks.
   `privacy-loop.js` extracts `finalAnswer` (message → summary → text →
   plan.answer), emits a "Final answer ready (N chars)" step, and ships it in
   the DONE summary; `sw.js` broadcasts `AGENT_DONE` with `answer` and writes
   it to History; the sidepanel renders `msg.answer ‖ summary.finalAnswer ‖
   finalThought` in the result card (markdown preserved).
2. **Profile → agent context (user request: "AGENT CAN TAKE DATA FROM THERE
   FILLED DATA").** Settings → Profile gains **Custom info** — user-defined
   label/value rows (add/remove/persist, empty-state hint). Saved rows flow to
   EVERY decision path: the privacy loop appends a TRUSTED USER PROFILE
   trailer (fixed fields + custom rows, length-capped) AFTER the outbound
   secret scan — the same channel the summarize path already used, so
   page-content gate semantics are untouched; the standard loop's
   `formatProfile` renders custom rows; the summarize prompt formats them
   explicitly (no `[object Object]`).
3. **Verification:** new `scripts/test_v1156_answers_profile.mjs` 20/20 on
   the real unpacked extension with a scripted mock VLM — summarize run
   renders the full bullet answer (card + transcript step + History),
   decision prompt carries the contract, USER PROFILE block with custom rows
   ("Age: 21", "Shirt size: M") reaches the model and the agent answers
   "What is my age?" from it, profile UI round-trip (render → add → save →
   storage → reload → remove), About chip tracks v1.15.6. Regression green:
   v1.15.1 panel 28/28 (same mock harness), About 21/21, plus the standing
   privacy/bench suites in `scripts/package_v1156.sh`.

### Privacy firewall: summarize survives secret-shaped pages (v1.15.7)

Field report (v1.15.6, privacy mode on a long chat page): the run died
BEFORE the first VLM call — **"Privacy firewall BLOCKED the network request:
secret-shaped text (API key / credentials / password assignment) survived
sanitization"** — then a 0 ms `privacy-firewall (blocked)` turn and an
ask_user dead-end. Root cause: the outbound gate probe and the decision
prompt read the pipeline's `sanitizedDomText`, whose text-PII scan truncates
at **8,000 chars** (and passes text through raw on a scan error) — a
key-shaped fragment deeper in the page tripped the sweep, and the old
last-line policy aborted the WHOLE decision turn.

1. **Envelope-first text.** The gate probe and the decision prompt now read
   the firewall envelope's canonical `privacy.sanitizedText` (final PII sweep
   over 16,000 chars + smuggler strip) — the rule the companion-server path
   has followed since v1.14. Fuzz/security suites already feed the prompt the
   envelope text, so no benchmark number changes.
2. **Redact-and-verify.** The last-line policy upgrades from "block the turn"
   to "mask the fragment, re-verify, ship clean": new firewall export
   `maskSecretShapedText()` replaces every `SECRET_TEXT_SWEEP` match with a
   sweep-inert `[REDACTED:secret]` marker; `scrubOutboundDecisionText()`
   masks the task, every history string and both page-text copies before any
   wire string is assembled, and the assembled prompt is masked + re-scanned.
   Fail-closed preserved — anything masking cannot clean still blocks, and
   the trusted Profile trailer stays outside the sweep (v1.15.6 design).
3. **Debuggable blocks.** Gate refusals now name the offending field and
   pattern IDs (never values) in the console and the ask_user message.
4. **Verification:** new `scripts/test_v1157_secret_sweep.mjs` 22/22 —
   Part A (Node): the field failure reproduced at unit level and the fix
   proven (envelope-first gate, all-9-family masking, prose untouched,
   self-healing, scrub semantics, diagnostics). Part B (real unpacked
   extension): summarizing a page that carries five key-shaped strings past
   char 8000 (`OpenCometBench/e2e/pages/secret-tail.html`) COMPLETES with the
   bullet answer in the result card, the gate never fires, and no raw secret
   reaches the mock backend. Standing suites green via `package_v1157.sh`.

### Safe prose is no longer black-boxed (v1.15.8)

Field report (v1.15.7, chat.z.ai, privacy mode): **"hiding unwanted safe
text"** — the sanitized screenshot drew black boxes over prose that merely
MENTIONS secret vocabulary: "three literal ▮token formats▮", "the four
surviving ▮secret families:▮", "(Google ▮key contiguity,▮ A4 split…". The
decision turn itself completed (the v1.15.7 redact-and-verify policy
working as designed) — the damage was to the agent's own eyes: the VLM
received a censored screenshot and a censored page text.

Root cause: the secret-ASSIGNMENT patterns (`pii-detector.js` REGEX_PATTERNS
`password` + `api_key`, mirrored by the firewall's `password_assignment` +
`token_assignment`) anchored **blob-unbounded lookaheads** at the value
start — `(?=.*\d)` requires a digit ANYWHERE LATER in the scanned string,
and the OCR full-page reconstruction is ONE newline-free blob — so
"token formats" matched because "v1.15.3" sat hundreds of chars later. The
`\s+` separator alternative also meant no `=`/`:` was required at all.
v1.15.7's A4b had documented exactly this coarseness ("Password: required
for login. Room 42." trips inside one blob) and accepted it because the
text policy merely MASKED; the canvas path paints real black boxes, so the
class had to die at the regex level.

1. **Lookaheads bounded to the value run.** A digit (and letter, where
   specified) must now sit INSIDE the candidate value:
   `(?=[^\s'"]*\d)[^\s'"]{5,}` and
   `(?=[A-Za-z0-9_.\-+/=]*\d)(?=[A-Za-z0-9_.\-+/=]*[A-Za-z])[A-Za-z0-9…]{6,}`.
   Every real assignment still fires: `token=eyJ…`, `password: hunter2`,
   `api_key = sk-live-…`, quoted forms, space-separated forms with
   digit-bearing values, labelled AWS literals.
2. **Both channels fixed at once.** The detector patterns feed OCR→canvas
   redaction AND the DOM-text masking; the firewall sweep patterns govern
   the outbound wire text. One tightening, four regexes — screenshots AND
   page text now keep safe prose readable.
3. **Fail-closed preserved.** The 216-case leakage fuzz, the security
   suite and the 514-case PII corpus re-ran green with identical PASS
   semantics; every real-secret family still matches (the fuzz generates
   digit-bearing values, so nothing relied on the unbounded lookahead).
4. **Verification:** new `scripts/test_v1158_prose_safe.mjs` 27/27 —
   Part A (Node): the three field phrases + the "Password: required …
   Room 42." blob yield ZERO findings (pre-fix they fired — reproduced
   first); 12 real-secret controls all fire (detector + sweep + masking).
   Part B (real
   unpacked extension): summarizing the prose-only fixture
   (`OpenCometBench/e2e/pages/prose-discussion.html`, digits included) → OCR
   scans 206 words, yields 0 api_key/password regions (no black boxes),
   the run completes, and the safe phrases reach the mock backend
   UNMASKED. `test_v1157_secret_sweep.mjs` A4b honestly re-asserts the
   tightened semantics (prose blob no longer masked).

---

### Real-VLM E2E for free cloud models (v1.15.9)

The REAL-VLM E2E tier is now **measured against OpenRouter free vision models**
(the BYO-key production path, zero companion server). Reference run on real
hardware (2026-09-10, `OpenCometBench/results/e2e-real-benchmark-1789066449033.json`,
`inclusionai/ling-3.0-flash-vl:free`, scenario `find-and-open` — "Open the Pricing
page"):

| Metric | Measured |
|---|---|
| Verified action ratio | **1/1 = 1.0** (`ACTION_VERIFIED`: title · content changed) |
| Execution / task success | 1.0 / 1.0 |
| Privacy blocks | **0** (`blocked: false`) |
| `vlmMs_real` P50 (true inference + transport) | **4679 ms** |
| `actionMs` P50 | 777 ms |
| `sanitizeMs` P50 (full live-path, cold-start) | **41487 ms** |
| Step total | 47000 ms |

Honest reading: this is the **full live agent path with a real multimodal brain**
— capture → on-device sanitize → privacy gate → live OpenRouter VLM → verified
action. The 41.5 s sanitize is the cold-start full-path cost of THIS run and must
NOT be merged with (or replace) the warm unchanged-screen P50 1216 ms figure from
the authoritative browser report — different conditions, different rows, per the
never-merge rule. It also stays the honest headline of the next optimization
target (the 4.7 s VLM leg is not the bottleneck). An earlier attempt with
`llama-3.2-11b-vision-instruct:free` finished 0 steps
(`e2e-real-benchmark-1789065225488.json`) and is kept as the negative control.

Harness changes in the same round: `run-e2e-real.mjs` now discovers the extension
service worker **live** (authoritative ID read from the running worker instead of
a hash guess — Chrome canonicalizes unpacked paths before assigning IDs) and sends
the Bearer header on the pre-run endpoint check for hosted providers. A new
pre-flight smoke, `OpenCometBench/e2e/smoke-openrouter-free.mjs`, verifies
endpoint + key + model + vision input + JSON-shape compliance in seconds (one
1×1 px image, measured TTFB, named hints for 401/402/429/404) before any full
run. **Key hygiene:** keys ride env vars (`--api-key="$OPENROUTER_API_KEY"`);
they are never hardcoded, printed, or committed — a key pasted into any chat,
log, or screenshot is compromised and must be rotated. No report this harness
writes contains key material (verified by tree scan).

## 5. Backend / model choices

### Client-side (in-browser)

| Purpose            | Library          | Model                              | Size    | Backend         |
|--------------------|------------------|------------------------------------|---------:|-----------------|
| Face detection     | MediaPipe Tasks  | blaze_face_short_range (INT8)      |  ~1 MB  | WebGPU / WASM   |
| Object detection   | Transformers.js  | Xenova/yolos-tiny (INT8)           |  ~6 MB  | WebGPU / WASM   |
| Image classification| Transformers.js | Xenova/vit-base-patch16-224 (INT8) | ~85 MB  | WebGPU / WASM   |
| Text NER           | Transformers.js  | Xenova/bert-base-NER-uncased (INT8)| ~110 MB | WebGPU / WASM   |

**Agent brains (on-device provider, user-selectable, v1.5.0):**

| Model | Kind | Size | Role |
|-------|------|-----:|------|
| **Gemma 4 E2B** ★ | MoE multimodal (text+image+audio) | ~2.3 GB | Default agent brain — native tool calling |
| Gemma 4 E4B | MoE multimodal | ~4.4 GB | Max quality, heavy |
| Granite 4.0 Micro 3B | text LLM | ~1.8 GB | Text-only agent alternative |
| Granite 4.0 1B | text LLM | ~0.8 GB | Low-RAM fallback |
| LFM2-VL 450M | vision-language | ~300 MB | Tiny vision fallback |
| all-MiniLM-L6-v2 | embeddings | ~90 MB | Page RAG + history search (auto-download) |

Models are fetched **once** from the HuggingFace CDN and then served from the browser cache. No model files are bundled with the extension — keeping the .crx small. Toy models (SmolLM2-360M, Qwen2.5-0.5B, etc.) were removed in v1.5.0 — a browser agent needs tool calling and real reasoning, so the catalog is agent-grade only.

### Server-side (companion server)

The server is provider-agnostic. Configure via env vars or per-task settings:

| Provider | Recommended model      | Vision | Notes                          |
|----------|------------------------|:------:|--------------------------------|
| OpenAI   | gpt-4o                 |   ✓    | Best overall vision quality    |
| Anthropic| claude-sonnet-4        |   ✓    | Strong reasoning               |
| Gemini   | gemini-1.5-flash       |   ✓    | Cheapest cloud option          |
| **Ollama**| **llava:7b / qwen2.5vl:7b** | ✓ | **Fully offline — best for SIH judging** |

For SIH finale, we recommend running **Ollama + llava:7b** on the judge's laptop to demonstrate a fully-offline, privacy-preserving end-to-end pipeline. Cloud APIs are also supported out-of-the-box.

---

## 6. File-by-file guide

### `src/lib/pii-detector.js`
Pure-JS PII scanner. Zero dependencies. Combines 11 high-precision regex patterns (with Luhn validation for credit cards) + DOM-sensitive-field detection (`type=password`, sensitive autocomplete tokens, name/placeholder hints). Optionally accepts a pre-loaded Transformers.js NER pipeline for catching person/org/address entities that don't follow a pattern.

### `src/lib/mediapipe-face.js`
Wraps `@mediapipe/tasks-vision` `FaceDetector`. Loads the BlazeFace Short Range model (INT8, ~1MB) **fully vendored from the extension bundle** (`src/vendor/mediapipe/` — no network needed). WebGPU delegate preferred, WASM/CPU fallback automatic. Tiled sweep (512px → 256px fine tiles) + verify-rescan for small faces; YOLO person-crop re-sweep as a recall backstop. Caches the pipeline singleton.

### `src/lib/local-vision.js`
Wraps `@huggingface/transformers`. Exposes three lazy-loaded pipelines: object detection (YOLO), image classification (ViT), and NER (BERT). Backend auto-selected (`webgpu` if `navigator.gpu` exists, else `wasm`). All models quantised INT8.

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
- `stats` — per-phase latency + counts + backend info

### `src/lib/privacy-agent.js`
Bridges the pipeline to the OpenComet background. Exposes:
- `captureAndSanitize(tabId)` — capture + DOM scan + pipeline run
- `decideViaServer(payload, task, history)` — multipart POST to `/agent/decide`
- `configurePrivacy(settings)` / `getPrivacySettings()` — runtime config
- `getLastPrivacyRun()` / `getCumulativePrivacyStats()` — for the side panel UI

### `src/background/privacy-loop.js`
The privacy-aware agent loop. Implements the standard `capture → decide → execute → repeat` cycle but routes every capture through `captureAndSanitize()` first.

### `src/background/sw.js`
The existing OpenComet service worker. We added four new message routes:
- `PRIVACY_START` — start a privacy-aware agent run
- `PRIVACY_CONFIGURE` — update pipeline config at runtime
- `PRIVACY_CAPTURE` — one-shot capture + sanitize (used by the "Test capture" button)
- `PRIVACY_GET_STATS` — fetch cumulative stats for the UI

### `server/server.js`
Express server. Single main endpoint `POST /agent/decide` accepts a multipart form (sanitised image + sanitised text + manifest + task + history + settings), forwards to the chosen VLM, parses the JSON response, returns an action plan. Provider implementations for OpenAI, Anthropic, Gemini, and Ollama (and OpenAI-compatible: Mistral / Groq / DeepSeek / Kimi / GLM).

### `src/sidepanel/sidepanel.html` + `.css` + `.js`
Added:
- A **Privacy Mode** toggle bar directly below the model selector
- A **gear button** that opens a configuration drawer (5 toggles + server URL + test button + preview pane)
- A 4-cell stats strip showing last-capture latency, faces redacted, PII regions redacted, and active backend
- A message interceptor that rewrites `START_AGENT` → `PRIVACY_START` when Privacy Mode is on

### `src/content/agent.js`
Added an on-page "Privacy pipeline" card that pops up in the bottom-right of the page during a privacy run, showing what was redacted on the most recent capture + a small preview of the sanitised screenshot.

---

## 7. Demo script (3-minute walkthrough)

See [`docs/DEMO.md`](./docs/DEMO.md) for a complete step-by-step demo you can run on stage during the SIH finale.

The TL;DR:

1. Open a banking login page (e.g. `https://example-bank.com/login`) in Chrome.
2. Open the OpenComet side panel. Privacy Mode is ON.
3. Click "Test capture + redact". You'll see a preview where the password field is solid black, the username field is pixelated, and any visible faces are blurred.
4. Type a task: *"Check my account balance"* and hit send.
5. Watch the on-page redaction card pop up after every capture — the server only ever sees the sanitised version.
6. The agent navigates the banking UI without ever leaking credentials to the server.

---

## 8. Privacy guarantees

| Guarantee                                     | How we enforce it                                                                                  |
|-----------------------------------------------|----------------------------------------------------------------------------------------------------|
| Raw pixels never leave the browser            | `canvas-redactor.js` returns a new canvas; the source `OffscreenCanvas` is GC'd, never serialised. |
| Raw PII text never leaves the browser         | `pii-detector.js` produces a sanitised string with `[REDACTED:<type>]` tokens; raw values stay in-memory only. |
| No third-party tracker / analytics            | The only outbound requests are to (a) HuggingFace CDN for model files, (b) MediaPipe model storage, (c) the user-configured companion server. |
| Fail-closed                                   | If the pipeline throws, the agent returns a 1×1 blank PNG instead of the raw screenshot.           |
| User-visible proof                            | The on-page redaction card + side panel preview pane show *exactly* what the server will receive.  |
| Optional full offline mode                    | Pair with Ollama `llava:7b` on localhost — no internet required after first model download.        |

---

## 9. Known limitations & future work

- **WebGPU on Firefox**: Firefox Nightly supports WebGPU but stable doesn't. On Firefox stable the pipeline falls back to WASM (~2× slower but still real-time).
- **NER model size**: The BERT NER model (~110 MB) is opt-in. For most tasks the regex pass is sufficient. We recommend enabling NER only for high-stakes demos.
- **iframe content**: DOM scan currently skips cross-origin iframes (browser security). Faces inside cross-origin iframes ARE still blurred at the pixel level (because the screenshot includes them).
- **MediaPipe model URL**: We pull from `storage.googleapis.com`. For fully-offline demos, mirror the model locally and update `MODEL_URL` in `mediapipe-face.js`.

---

## 10. Credits

Built on top of [OpenCometAI v1.1.0](https://github.com/) (MIT-licensed autonomous browser agent). SIH privacy pipeline integration by the OpenComet-SIH team.

**Libraries used (all open-source / open-weights):**
- [Transformers.js](https://github.com/huggingface/transformers.js) — Apache 2.0
- [MediaPipe Tasks-Vision](https://github.com/google-ai-edge/mediapipe) — Apache 2.0
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) — MIT
- OpenAI / Anthropic / Gemini / Ollama SDKs — MIT/Apache

---

## 11. Diagnostics & console logging (v1.5.1)

Every context (service worker · offscreen ML runtime · sidepanel) logs through one unified diagnostics system (`src/core/logger.js`). To debug any error, open **chrome://extensions → OpenComet-SIH → Inspect views: service worker / offscreen.html / sidepanel** — all three consoles use the same tag format, and the important lines are mirrored between them automatically:

```
[12:41:07.283][Open Comet:API][ERROR] ✗ openai/gpt-4o · 1832ms · RATE-LIMIT — too many requests or quota exhausted · OpenAI 429: ...
[12:41:09.110][Open Comet:Busy][WARN] model download already in progress — request for "gemma-4-e2b" rejected.
[12:41:14.552][LocalML]  30% · 690.0 MB / 2.3 GB · 18.4 MB/s
[12:41:20.013][Open Comet:Limits][WARN] max step limit reached (25) — finishing with the best-effort answer.
```

| Tag | What it covers |
|-----|----------------|
| `[API]` | Every cloud/on-device AI request: start, latency, and classified failures — `AUTH` (bad key) · `RATE-LIMIT` (429/quota) · `NOT-FOUND` · `BAD REQUEST` · `SERVER` (5xx) · `NETWORK` (offline/blocked) |
| `[LocalML]` | Model downloads with **realtime % / MB / MB·s⁻¹ speed**, model load, generation metrics (tok/s, prefill/decode), KV-cache hits, download/generate failures with classification |
| `[Busy]` | Rejected work while the engine is occupied: agent already running, second concurrent download, second concurrent on-device generation |
| `[Limits]` | Max-step limit reached, context/history compaction events |
| `[Agent]` | Loop lifecycle: iteration failures (with consecutive-failure count), fatal errors |
| `[Router]` | Message-handler crashes with the failing `msg.type` |
| `[Relay:*]` | Uncaught errors / unhandled promise rejections from the sidepanel or offscreen document, relayed into the SW console |

**Relay rule:** SW `warn`/`error` lines are broadcast to the sidepanel console (`DIAG_LOG`), and page-context crashes are relayed back to the SW console (`DIAG_LOG_RELAY`) — one DevTools window is always enough to see the whole system. The last 500 lines of any context are also kept in memory (`getRecentLogs()`) for diagnostics dumps. See `docs/DIAGNOSTICS_LOGGING.md` for the full guide.
