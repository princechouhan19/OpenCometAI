# OpenCometBench — Doc & Usage Guide

**OpenCometBench** is the measured benchmark suite of **OpenComet SIH** (SIH Problem
Statement 26171 — *On-device Visual Perception for Light-weight Browser Agents*). It
scores the real extension — the real capture → perception → sanitize → network gate →
action → verification loop — across four tiers, and every number it prints is
**measured from the real runtime**: nothing is asserted, hard-coded, or fabricated.
All fixture data is synthetic (no real personal data, ever).

> **This folder is the operational home of the benchmark.** The branded specification —
> motivation, design principles, tier architecture, stable case IDs, the measured
> scoreboard, the known-limitations policy, and positioning as a contributed benchmark —
> lives in **[OPENCOMET_BENCH.md](./OPENCOMET_BENCH.md)** (moved here from `docs/` so the
> spec, the harnesses, the fixtures and the reports sit together).

---

## 1. Folder map

| Path | What it is |
|---|---|
| `run-opencomet-bench.mjs` | **One-command auto-run** of every tier against OpenComet itself (see §3) |
| `run-all.js` + `suites.js` | UNIT tier orchestrator (Node, no browser needed) |
| `privacy.bench.js` · `redaction.bench.js` · `visual-context.bench.js` | UNIT suites: PII P/R, redaction geometry, visual-context accuracy |
| `security.test.js` · `fuzz.test.js` · `server-validation.test.js` | UNIT suites: network gate invariants, 216-case leakage fuzz, inbound validation |
| `fixtures/pii-corpus.json` | 514-case checksum-validated PII corpus (positives + negatives) |
| `pages/` | 16 synthetic pages with embedded ground truth (`generate-pages.mjs` regenerates them) |
| `browser/harness.mjs` | BROWSER tier — REAL pixels, real screenshots at DPR 1–2, real in-page pipeline |
| `browser/runner.html` | Single-page interactive runner with Export JSON (extension URL or any static server) |
| `e2e/run-e2e.mjs` | E2E tier — the real unpacked extension driven through 10 reproducible tasks (mock decision brain) |
| `e2e/run-e2e-real.mjs` | E2E-REAL tier — same loop with YOUR model (BYO provider); **never merged** with the mock run |
| `e2e/smoke-openrouter-free.mjs` | Pre-flight smoke for OpenRouter free vision models (endpoint + key + vision + JSON shape, in seconds) |
| `probe-yolo-downscale.mjs` | v1.16.0 A/B correctness probe for the `yoloMaxEdge` detector-input knob — MEASURED: correctness-neutral (box parity IoU = 1.000) but latency-neutral (the detector resizes internally to a fixed resolution). Kept as the honest negative result; keep `yoloMaxEdge: 0`. |
| `e2e/run-adversarial.mjs` | ADVERSARIAL tier — 23 wire-capture cases (12 privacy + 11 injection), every outbound byte captured |
| `e2e/mock-vlm.mjs` · `e2e/pages/` · `e2e/adversarial/` | Scripted decision server + fixture pages (`generate-adversarial-pages.mjs`) |
| `dashboard.html` · `dashboard.js` · `dashboard-data.js` | Admin performance monitor (offline render; `scripts/build_dashboard_data.py` rebuilds the seed) |
| `results/` | Every report the harnesses write — import these into **Settings → SIH Scorecard** |

---

## 2. Quick start (copy-paste)

```bash
# ONE COMMAND — runs UNIT + E2E against OpenComet itself and writes a summary:
node OpenCometBench/run-opencomet-bench.mjs

# Everything (UNIT + E2E + ADVERSARIAL + BROWSER; browser tier downloads models):
node OpenCometBench/run-opencomet-bench.mjs --all

# Equivalent npm scripts:
npm run bench            # UNIT + E2E (default)
npm run bench:unit       # Node suites only — no browser required
npm run bench:all        # all four tiers
```

What "against OpenComet itself" means: the E2E / ADVERSARIAL / BROWSER harnesses load
the **real unpacked extension** into Chromium (Playwright `--load-extension`), point its
decision endpoint at the scripted mock-VLM (or your own model for E2E-REAL), and drive
real tasks through the extension's actual service worker, offscreen ML runtime and
privacy firewall. The only mocked component is the decision *brain*, and only where the
tier says so — every byte the pipeline produces is the extension's own.

Exit code `0` = every tier that ran passed. A tier that cannot run (e.g. playwright not
installed) is reported as **SKIPPED** with the reason; pass `--strict` to fail instead.

---

## 3. Tier guide

### 3.1 UNIT — Node suites (run anywhere, seconds)

```bash
node OpenCometBench/run-all.js          # all suites, human-readable table
node OpenCometBench/run-all.js --json   # machine-readable (feeds the Scorecard)
node OpenCometBench/run-all.js --only=privacy   # a single suite
```

| Suite | SIH metric | What it measures |
|---|---|---|
| `privacy.bench.js` | PII precision/recall (20%) | TP/FP/FN per PII type over `fixtures/pii-corpus.json` — regex + checksum validators (Luhn/Verhoeff/mod-97) + contextual risk scoring, exactly what ships in the extension |
| `redaction.bench.js` | Redaction precision (20%) | region coverage, mean IoU, over-redaction %, style mapping (secret→blackout, personal→pixelate, face→blur), safe-manifest integrity |
| `visual-context.bench.js` | Visual context accuracy (25%) | page-type classification accuracy, visual-element recognition, adaptive ViT gate decisions |
| `security.test.js` | Security invariant | network gate blocks: raw screenshots, secret-shaped text, unsafe manifests, privacy-off payloads; fail-closed on detector crash; prompt-injection fencing incl. the SIH spec example; DPR 1/1.25/1.5/2 coordinate regression |
| `fuzz.test.js` | Leakage fuzz | 216 seeded cases (8 secret families × 9 channels) — zero leakage |

Targets are encoded per suite (P≥0.97, R≥0.95, coverage≥0.98, accuracy≥0.95…).
**Exit code 0 = every target met.** The `--json` output is what Settings → SIH
Scorecard imports as UNIT rows.

### 3.2 BROWSER — REAL pixels (automated)

```bash
node OpenCometBench/browser/harness.mjs            # all four tiers (headless — regression only)
node OpenCometBench/browser/harness.mjs --only=visual,ocr
node OpenCometBench/browser/harness.mjs --vit=false   # skip the ViT model download
node OpenCometBench/browser/harness.mjs --headed --channel=chrome   # REAL-HARDWARE MODE (your Chrome, your GPU)
```

Reports carry `meta.environment`: `headless-ci` numbers are for regression tracking
only and are **never** production claims; `real-hardware-headed` reports (run on YOUR
installed Chrome, visibly, with your GPU) are the ones you may quote. Each report
fingerprints the machine (user agent, CPU cores, WebGL renderer, WebGPU adapter).

Renders `OpenCometBench/pages/*.html` (16 synthetic pages with embedded ground truth)
in a real browser, takes REAL screenshots at DPR 1–2, and runs the REAL pipeline
in-page:

- **visual** — page-type accuracy SPLIT into DOM-derived vs ViT-fused (real
  Xenova/vit-base-patch16-224), plus the element-source split: DOM-semantic controls
  vs pixel-only controls (`canvas-controls` / `svg-controls` pages — DOM-invisible BY
  DESIGN, reported honestly), context completeness, confidence
- **redaction** — DPR × zoom × scroll × dialog matrix (72 runs), coverage/IoU/
  over-redaction + **pixel-level leakage verification**
- **ocr** — PII that exists ONLY in canvas/SVG pixels; vendored Tesseract must find it
  and the pixels must verify redacted (also run with OCR off to show the honest
  DOM-only gap)
- **resources** — per-phase P50/P90/P95, model load times, heap, payload KB

Output: `OpenCometBench/results/browser-benchmark-<ts>.json` (`meta.type:"browser"`)
→ import in **Settings → SIH Scorecard** (kept separate from UNIT rows).

### 3.3 E2E — the real extension loop (scripted decisions)

```bash
node OpenCometBench/e2e/run-e2e.mjs
```

Loads the unpacked extension, points the decision endpoint at the scripted mock-VLM
(real `/agent/decide` contract — privacy envelope + inbound validation enforced), and
runs 10 reproducible tasks through the real capture → perception → sanitize → gate →
action → verification loop. Every action carries one of FOUR verification states;
`verifiedActionRatio` counts only actions that carried a verification instrument.
Output: `OpenCometBench/results/e2e-benchmark-<ts>.json` (`meta.type:"e2e"`).
`vlmMs` here is network+validation only — never model latency.

### 3.4 E2E-REAL — your machine, your model (never merged with the mock run)

**Step 0 — smoke the endpoint first (seconds, not minutes):**

```bash
OPENROUTER_API_KEY=sk-or-… node OpenCometBench/e2e/smoke-openrouter-free.mjs
# or pick another free vision model / gateway:
OPENROUTER_API_KEY=sk-or-… node OpenCometBench/e2e/smoke-openrouter-free.mjs \
    --model=meta-llama/llama-3.2-11b-vision-instruct:free
OPENROUTER_API_KEY=sk-or-… node OpenCometBench/e2e/smoke-openrouter-free.mjs --stream
```

Sends one 1×1 px image + a JSON instruction and verifies endpoint + key + model +
vision input + JSON-shape compliance, with measured TTFB/total and named failure
hints (401 invalid key, 402 credits, 429 rate-limit, 404 model id). The key comes
from the `OPENROUTER_API_KEY` environment variable — never hardcoded, never
printed, never written anywhere.

**Then run the full loop:**

```bash
node OpenCometBench/e2e/run-e2e-real.mjs --provider=ollama --model=<vision-model>
node OpenCometBench/e2e/run-e2e-real.mjs --provider=openai --model=gpt-4o-mini --api-key=sk-...
node OpenCometBench/e2e/run-e2e-real.mjs --provider=custom \
    --base-url=https://openrouter.ai/api/v1 \
    --model=inclusionai/ling-3.0-flash-vl:free \
    --api-key="$OPENROUTER_API_KEY" --only=find-and-open
# v1.16.0 — steady-state measurement: one unmeasured warm-up cycle first
# (loads YOLO/ViT/OCR + first-inference JIT, ZERO VLM calls, zero API cost),
# so the reported sanitizeMs is the STEADY STATE, never the one-time cold load:
node OpenCometBench/e2e/run-e2e-real.mjs --provider=custom \
    --base-url=https://openrouter.ai/api/v1 \
    --model=inclusionai/ling-3.0-flash-vl:free \
    --api-key="$OPENROUTER_API_KEY" --warmup
```

Same real loop, REAL decision brain (BYO-provider direct path). Output:
`e2e-real-benchmark-<ts>.json` (`meta.type:"e2e-real"`) — never merged with mock,
UNIT, or BROWSER rows. Fail-fast smoke check: nothing is written unless the provider
endpoint answers.

**Scenario matrix (10 built in):** `find-and-open`, `search-info`, `navigate-form`,
`media-control`, `safe-form`, `banking-transfer`, `gov-application`,
`canvas-clear`, `article-navigation`, `mixed-pii-contact`. `--only` accepts a
comma-separated subset; omit it to run all ten. Report per-phase P50/P90/P95 per
run. The single-scenario reference below is one row of that matrix — a 5–10
scenario run is the statistically meaningful SIH evidence block.

**Cold vs steady state (v1.16.0):** the first sanitize of a FRESH profile pays a
one-time model download + compile (cold-cache ViT load measured 37873 ms on the
reference hardware — that single load dominated the reference run's
`sanitizeMs 41487`). Three honest latency conditions exist and are never merged:
① cold first-step (model load + inference), ② warm memo-hit unchanged screen
(P50 1216 ms authoritative), ③ changed-frame memo-MISS (12885 ms measured). With
`--warmup` the report describes ②/③ conditions only and stamps `meta.warmup`;
production runs warm models at session start (`VISION_WARMUP` in the offscreen
runtime) so real users never pay ① mid-session.

**Measured OpenRouter reference run** (real hardware, 2026-09-10,
`results/e2e-real-benchmark-1789066449033.json`, `inclusionai/ling-3.0-flash-vl:free`,
scenario `find-and-open`): verifiedActionRatio 1/1, taskSuccessRatio 1, privacy
blocks 0 (`blocked:false`), **vlmMs_real P50 4679 ms** (true inference + transport),
actionMs P50 777 ms, sanitizeMs P50 **41487 ms**, step total 47000 ms,
verification `ACTION_VERIFIED` (title · content changed). Read the sanitize number
honestly: it is the **full live-path, cold-start sanitization of this one run** —
it does NOT replace the warm unchanged-screen P50 1216 ms figure from the
authoritative browser report; the two measure different conditions and are never
merged. An earlier attempt with `llama-3.2-11b-vision-instruct:free`
(`e2e-real-benchmark-1789065225488.json`) finished 0 steps and is kept as the
honest negative control for model-choice sensitivity.

**Key hygiene (non-negotiable):** pass keys as env vars / quoted flags
(`--api-key="$OPENROUTER_API_KEY"`); never commit a key, never paste one into
chats, screenshots, reports or the zip — a pasted key is a compromised key:
rotate it immediately. The harness writes no key material into any report.

### 3.5 ADVERSARIAL — every outbound byte captured

```bash
node OpenCometBench/e2e/run-adversarial.mjs                 # both suites
node OpenCometBench/e2e/run-adversarial.mjs --suite=privacy
node OpenCometBench/e2e/run-adversarial.mjs --suite=injection
```

**Privacy (12 cases)** — password/email/phone/aadhaar/pan/card/otp/api-key as labelled
DOM text, email ONLY on canvas, card digits ONLY in an SVG image, Aadhaar in a
PDF-like layer, a realistic synthetic face. Per case asserts: raw secret in NO
outbound field, raw screenshot bytes never transmitted, GT region pixel-verified
redacted (text) / blur-verified via block variance (face), privacy envelope passed, no
apiKey in settings.
**Injection (11 cases)** — 6 hostile families across DOM/title/URL/dialog/OCR-canvas/
failed-target channels: zero invisible/bidi/control chars outbound, hostile text never
in control fields, URL queries never leave, OCR text never leaves.
Output: `adversarial-benchmark-<ts>.json` (`meta.type:"adversarial"`). Fixture pages:
`OpenCometBench/e2e/adversarial/` (regenerate with `generate-adversarial-pages.mjs`).

---

## 4. Reading the results

1. Every run writes timestamped JSON reports into `OpenCometBench/results/`.
2. `run-opencomet-bench.mjs` additionally writes an `opencomet-bench-summary-<ts>.json`
   — an orchestrator republish: each tier's verdict and report path come **verbatim**
   from the child harness; nothing is recomputed.
3. Import reports in **Settings → SIH Scorecard**. UNIT, BROWSER, E2E and ADVERSARIAL
   rows are never merged into one number; LIVE rows (VLM P50, sanitize P50, per-task
   privacy census) fill in automatically on this machine.
4. Reports are environment-fingerprinted. Quote only what the `meta.environment` label
   permits — headless numbers are regression tracking, not production claims.

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `SKIPPED — playwright is not installed` | `npm i playwright` (or `npm i -D playwright`), then re-run |
| Browser tier slow on first run | Model weights (ViT, OCR) download once into the browser profile; subsequent runs are warm |
| `--vit=false` | Skips the ViT scene model — visual tier reports the DOM-only side honestly |
| E2E fails to find the extension | Run from the project root so `OpenCometBench/e2e/run-e2e.mjs` resolves `src/` relative to the repo |
| Adversarial exit code 2 | At least one case failed — the console names each failing case id; the JSON has the captured wire fields |
| Want the per-case table | Drop `--json` — the human table prints PASS/FAIL per suite/case with the failing names |

## 6. Extending

Add cases to `OpenCometBench/fixtures/pii-corpus.json` (positives carry
`{type, text, expect}`; negatives carry `{text, reason}`). Every new detector behaviour
change should come with a fixture update — the numbers recompute automatically. For new
E2E scenarios, follow the `SCENARIOS` shape in `e2e/run-e2e.mjs`; for hostile cases,
`e2e/generate-adversarial-pages.mjs` regenerates the fixture pages. The spec document
([OPENCOMET_BENCH.md](./OPENCOMET_BENCH.md)) explains how new cases earn stable case IDs.
