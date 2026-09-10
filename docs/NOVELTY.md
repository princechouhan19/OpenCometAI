# Novelty — OpenComet SIH (PS 26171)

This document states, claim by claim, what is **novel** about OpenComet as a
submission for Smart India Hackathon Problem Statement **26171 — “On-device Visual
Perception for Light-weight Browser Agents”**. Every claim is anchored to a shipped
feature and a measured, reproducible number in `OpenCometBench/`; nothing on this
page is asserted without evidence, and the known-limitations policy in
[OpenCometBench/OPENCOMET_BENCH.md](../OpenCometBench/OPENCOMET_BENCH.md) applies to
every figure quoted here.

---

## 1. The gap this project fills

Mainstream browser agents (cloud Copilots, extension assistants, automation LLMs)
solve *perception* by shipping raw pixels off the device: a screenshot of whatever is
on screen — including passwords, OTPs, personal messages, and faces — is uploaded to
a vision model on every decision turn. That design is fundamentally at odds with the
SIH problem statement, which asks for **on-device visual perception** so that a
light-weight browser agent can act *without* exposing the user's screen. OpenComet
inverts the pipeline: perception, PII detection, and redaction happen **locally,
before any outbound request**, and the network layer is engineered to be provably
fail-closed rather than trusted.

## 2. Novelty claims

### N1 — Redaction-before-decision pipeline (perception is on-device)

**What:** a four-layer local perception stack — YOLO person detection, MediaPipe
tiled face detection with a three-stage cascade (full-frame → 512 px tiles → 256 px
fine tiles) plus a DOM-guided face sweep and avatar guard, a ViT scene classifier
(Xenova/vit-base-patch16-224, run adaptively on visual change), and vendored
Tesseract OCR reading text-PII straight out of canvas/SVG pixels — all executed in an
MV3 offscreen document on WebGPU/WASM.

**Why it is novel:** typical agent architectures treat the screenshot as the input
format; OpenComet treats it as a hazard to be sanitized first. The VLM decision turn
receives a **redacted image plus a structured, secret-free context envelope** — not
raw pixels.

**Evidence:** measured redaction coverage 0.983, mean IoU 0.938, over-redaction 5.9%
(`OpenCometBench/redaction.bench.js`); 10/10 page-type classification
(`visual-context.bench.js`); the 72-run browser redaction matrix (DPR × zoom ×
scroll × dialog) with pixel-level leakage verification (`browser/harness.mjs`).

### N2 — Fail-closed outbound privacy firewall with redact-and-verify

**What:** a network gate that inspects every outbound decision payload — the wire
text, the manifest, the settings, all control fields — and applies a
**redact-and-verify** policy: secret-shaped fragments are masked locally, re-verified,
and only provably clean text is transmitted; any residual fails the turn closed.
Prompt-injection fencing (SIH-spec hostile families), smuggler-character stripping,
and inbound response validation complete the loop.

**Why it is novel:** agent frameworks commonly gate on *allow-lists of destinations*;
OpenComet gates on the **content of every byte that leaves**, with the verification
envelope recorded per step so the claim is auditable.

**Evidence:** 216/216 seeded leakage-fuzz cases with zero leaks
(8 secret families × 9 channels, `fuzz.test.js`); 23 adversarial wire-capture E2E
cases where every outbound byte is recorded and asserted
(`e2e/run-adversarial.mjs`); the v1.15.7/v1.15.8 hardening rounds fixed real
field-reported false blocks/over-masks without weakening the fail-closed guarantee
(`scripts/test_v1157_secret_sweep.mjs`, `scripts/test_v1158_prose_safe.mjs`).

### N3 — OpenCometBench: a measured benchmark for privacy-preserving agents

**What:** a four-tier, fully scripted benchmark of **922 scored cases** — a 216-case
leakage fuzz, 23 adversarial wire-capture E2E cases, a 72-run browser redaction
matrix, and a 514-case checksum-validated PII corpus — with stable case IDs,
per-tier scorecard import, environment fingerprinting, and a published
known-limitations policy.

**Why it is novel:** existing agent benchmarks (WebArena, Mind2Web and kin) measure
task success; none measure **what leaked while succeeding**. OpenCometBench scores
exactly that, runs one-command against the real extension
(`node OpenCometBench/run-opencomet-bench.mjs`), and separates MOCK and REAL runs by
design so numbers can never be conflated.

**Evidence:** PII detection P=1.00 / R=1.00 on the synthetic suite; every suite
encodes pass targets and exits non-zero on any miss (`OpenCometBench/README.md`).

### N4 — Trusted local Profile that personalizes the agent without leaking it

**What:** Settings → Profile stores fixed fields **plus custom label/value rows** in
`chrome.storage` and injects them into the decision prompt as a clearly-marked
TRUSTED USER PROFILE block, so the agent can answer “what is my age?” or pre-fill
forms from data the user chose to share — while everything else on the page stays
subject to redaction.

**Why it is novel:** personalization in cloud agents usually means uploading profile
data; here the profile lives on-device, is opt-in per field, and is contractually
separated (as trusted user data) from untrusted page content.

**Evidence:** the v1.15.6 regression suite exercises the full round-trip — saved rows
persist, render, and reach the prompt
(`scripts/test_v1156_answers_profile.mjs`).

### N5 — Verification-instrumented autonomy inside a tab-group sandbox

**What:** every agent action carries one of four verification states
(ACTION_VERIFIED / VERIFICATION_FAILED / ACTION_EXECUTED / ACTION_FAILED);
`verifiedActionRatio` counts only actions that carried an instrument. Task tabs are
grouped into a **tab-group sandbox** and the agent acts only inside it; destructive
steps can require explicit approval (ask-before-acting).

**Why it is novel:** most agent demos report “it worked”; OpenComet reports *what
proof exists that it worked*, per step, and can be held to that ratio in the
scorecard.

**Evidence:** aggregate per-report `verifiedActionRatio` / `taskSuccessRatio` in
every E2E report (`OpenCometBench/results/e2e-benchmark-*.json`).

### N6 — Honest telemetry as a design principle

**What:** the SIH Scorecard renders “—” until a real measurement exists; headless
reports are labelled regression-only; every report fingerprints its machine; live
rows (VLM P50, sanitize P50) come only from tasks that actually ran on that machine.

**Why it is novel:** benchmarks usually optimize for flattering numbers; this one
ships a UI that refuses to display a number it cannot measure, and a packaging
pipeline whose pre-flight checks fail if a claim string or a credential is missing
from (or present in) the tree.

**Evidence:** measured warm sanitize P50 ≈ 1216 ms on the reference machine;
`scripts/package_v1158.sh` pre-flight (regression gates + secret-material scan);
the About page changelog matches the manifest version chain.

## 3. Differentiation summary

| Capability | Typical cloud browser agent | OpenComet SIH |
|---|---|---|
| Perception input to the model | Raw screenshot, uploaded every turn | Redacted image + structured secret-free envelope |
| PII / face handling | Provider-side policy, after upload | On-device, before any request; fail-closed on error |
| Outbound content gating | Destination allow-list | Per-byte content gate with redact-and-verify + audit envelope |
| Prompt injection | Often unaddressed | Fenced + adversarially benchmarked (11 injection cases) |
| Personal data used for personalization | Uploaded profile | Local `chrome.storage` Profile, opt-in, marked trusted |
| Measurement | Task success | Task success **and** leakage, redaction geometry, verification ratio — 922 scored cases, one command |
| Data residency | Provider cloud | On-device by default; fully on-device mode transmits nothing |

## 4. SIH evaluation mapping

The README's SIH scorecard table maps the four problem-statement criteria to the
tiers above: visual-context accuracy (25%) → `visual-context.bench.js` + the browser
harness; PII recall/precision (20%) → `privacy.bench.js` + the fuzz corpus; redaction
precision (20%) → `redaction.bench.js` + the 72-run matrix; the remaining weight is
covered by the security invariant and the E2E/ADVERSARIAL verification loop. See
[README.md](../README.md) for the full table and
[OpenCometBench/OPENCOMET_BENCH.md](../OpenCometBench/OPENCOMET_BENCH.md) for the
benchmark specification.
