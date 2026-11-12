# Novelty

What is new in OpenComet as a submission for Smart India Hackathon problem
statement 26171, *On-device Visual Perception for Light-weight Browser Agents*.

Each claim is tied to a shipped feature and to a number in `OpenCometBench/`.
The known-limitations policy in
[`OpenCometBench/OPENCOMET_BENCH.md`](../../OpenCometBench/OPENCOMET_BENCH.md)
applies to every figure quoted here.

## The gap

Most browser agents solve perception by sending raw pixels off the device: a
screenshot of whatever is on screen, including passwords, OTPs, private
messages and faces, uploaded to a vision model on every decision turn. The
problem statement asks for on-device perception so a light-weight agent can act
without exposing the screen.

OpenComet moves detection and redaction before the request: perception, PII
detection and redaction run locally, and the network boundary is built to fail
closed rather than to be trusted.

## Claims

### N1. Redaction happens before the decision

**What.** A local perception stack in an MV3 offscreen document, on WebGPU or
WASM: YOLO person detection; MediaPipe face detection with a three-stage
cascade (full frame, 512 px tiles, 256 px fine tiles) plus a DOM-guided sweep
and avatar guard; a ViT scene classifier (`Xenova/vit-base-patch16-224`) run
adaptively on visual change; and vendored Tesseract OCR reading text PII from
canvas and SVG pixels.

**Why it is different.** Agent architectures usually treat the screenshot as
the input format. Here it is treated as a hazard to sanitize first. The model
receives a redacted image and a structured, secret-free context envelope.

**Evidence.** Redaction coverage 0.983, mean IoU 0.938, over-redaction 5.9%
(`OpenCometBench/redaction.bench.js`); 10/10 page-type classification
(`visual-context.bench.js`); a 72-run browser matrix across DPR, zoom, scroll
and dialog states with pixel-level leakage verification
(`browser/harness.mjs`).

### N2. A fail-closed outbound gate that verifies what it sends

**What.** A network gate inspects every outbound decision payload: wire text,
manifest, settings and control fields. It applies redact-and-verify: secret-shaped
fragments are masked locally, the result is re-checked, and only provably clean
text is transmitted. Any residual fails the turn closed. Prompt-injection
fencing, smuggler-character stripping and inbound response validation complete
the boundary.

**Why it is different.** Agent frameworks typically gate on destination allow
lists. This gates on the content of every byte that leaves, and records a
verification envelope per step so the claim can be audited.

**Evidence.** 216 of 216 seeded leakage-fuzz cases with zero leaks (8 secret
families across 9 channels, `fuzz.test.js`); 23 adversarial wire-capture E2E
cases where every outbound byte is recorded and asserted
(`e2e/run-adversarial.mjs`). The v1.15.7 and v1.15.8 rounds fixed
field-reported false blocks and over-masks without weakening the guarantee
(`scripts/test_v1157_secret_sweep.mjs`, `scripts/test_v1158_prose_safe.mjs`).

### N3. A benchmark that scores leakage, not only success

**What.** A four-tier scripted benchmark of 922 scored cases: a 216-case
leakage fuzz, 23 adversarial wire-capture E2E cases, a 72-run browser redaction
matrix and a 514-case checksum-validated PII corpus, with stable case IDs,
per-tier scorecard import, environment fingerprinting and a published
limitations policy.

**Why it is different.** WebArena, Mind2Web and similar benchmarks measure task
success. None measure what leaked while succeeding. This scores that, runs
against the real extension with one command
(`node OpenCometBench/run-opencomet-bench.mjs`), and keeps mock and real runs
separate so numbers cannot be conflated.

**Evidence.** PII detection precision 1.00 and recall 1.00 on the synthetic
suite; every suite encodes pass targets and exits non-zero on a miss
(`OpenCometBench/README.md`).

### N4. A local profile that personalizes without leaving the device

**What.** Settings, Profile stores fixed fields plus custom label and value
rows in `chrome.storage` and injects them into the decision prompt as a marked
trusted user profile block. The agent can answer "what is my age?" or prefill a
form from data the user chose to share, while everything else on the page
remains subject to redaction.

**Why it is different.** Personalization in cloud agents usually means
uploading profile data. Here it stays on-device, is opt-in per field, and is
kept separate from untrusted page content.

**Evidence.** The v1.15.6 suite exercises the round trip: saved rows persist,
render, and reach the prompt (`scripts/test_v1156_answers_profile.mjs`).

### N5. Autonomy with per-action verification inside a sandbox

**What.** Every action carries one of four verification states
(ACTION_VERIFIED, VERIFICATION_FAILED, ACTION_EXECUTED, ACTION_FAILED) and
`verifiedActionRatio` counts only actions that carried an instrument. Task tabs
are grouped into a sandbox the agent cannot leave, and destructive steps can
require explicit approval.

**Why it is different.** Most agent demos report that a task worked. This
reports what evidence exists that each step worked, and the scorecard can hold
it to that ratio.

**Evidence.** Per-report `verifiedActionRatio` and `taskSuccessRatio` in every
E2E report (`OpenCometBench/results/e2e-benchmark-*.json`).

### N6. Empty states instead of invented numbers

**What.** The scorecard shows a dash until a real measurement exists. Headless
reports are labelled regression-only. Every report fingerprints its machine.
Live rows such as VLM p50 and sanitize p50 come only from tasks that ran on that
machine.

**Why it is different.** Benchmarks tend to optimize for flattering numbers.
This one refuses to display a number it cannot measure, and its packaging
pre-flight fails when a claim or a credential is missing from the tree.

**Evidence.** Warm sanitize p50 of about 1216 ms on the reference machine; the
packaging pre-flight gates; the About page changelog matching the manifest
version chain.

## Differentiation

| Capability | Typical cloud browser agent | OpenComet |
|---|---|---|
| What the model sees | Raw screenshot every turn | Redacted image and a secret-free envelope |
| PII and faces | Provider policy, after upload | On-device, before the request; fail closed |
| Outbound gating | Destination allow list | Per-byte content gate with redact-and-verify |
| Prompt injection | Often unaddressed | Fenced and benchmarked (11 injection cases) |
| Personalization data | Uploaded profile | Local storage, opt-in, marked trusted |
| Measurement | Task success | Task success, leakage, redaction geometry and verification ratio across 922 cases |
| Data residency | Provider cloud | On-device by default; fully local mode transmits nothing |

## Mapping to the evaluation criteria

The scorecard in the [README](../../README.md) maps the four problem-statement
criteria onto these tiers: visual-context accuracy (25%) to
`visual-context.bench.js` and the browser harness; PII recall and precision
(20%) to `privacy.bench.js` and the fuzz corpus; redaction precision (20%) to
`redaction.bench.js` and the 72-run matrix. The remainder is covered by the
security invariant and the end-to-end verification loop. The benchmark
specification is in
[`OpenCometBench/OPENCOMET_BENCH.md`](../../OpenCometBench/OPENCOMET_BENCH.md).
