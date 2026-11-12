# Roadmap

Each item names the measurement that would show it worked. Nothing here is
claimed as done.

## 1. Planner emits a goal contract

`verifyTaskGoal()` works but only fires when the model volunteers `goal`.

- add an instruction to the planner prompt: first decision emits
  `goal: {checks:[...]}` over observable page state
- if the planner says `done` without ever declaring one, ask once for the
  predicate before accepting
- risk: a badly chosen predicate blocks a legitimate completion. The two-attempt
  budget and the `completed_unverified` state bound the damage; do not relax
  verification to make a number move

## 2. Perception latency

From the repo's own instrumentation: `objectDetect` ~7,841 ms and `ocr`
~3,402 ms inside a ~12,885 ms changed-frame pass. Around 87% is two models.

**YOLO input size.** Downscale to longest edge 512 before inference and map the
boxes back. Full-DPR input is roughly 22x the pixel work the model was trained
for. If `probe-yolo-downscale.mjs` still shows no gain, find where the downscale
happens relative to the expensive step.

**Per-model backend.** Measure `wasm` and `webgpu` for each model and cache the
winner. `requiresWebGPU` is right for LLM decode and wrong as a blanket rule for
small vision models, where WebGPU can pay more in dispatch overhead than it
saves.

**OCR split.** Redaction needs boxes, not text. Run a text detector for line
polygons, then recognise only crops that overlap `pixelTextRects`, canvas
regions, or input-like DOM rects.

**Batch the crops.** One recognition pass over a sheet of crops instead of one
pass per box.

**Parallel phases.** `faceDetect` and `ocr` are independent. Run them
concurrently behind a `maxConcurrentPhases` cap, `redact` last.

**Prewarm.** Load the small perception models on install and on first panel
open. Cold start is ~41 s.

Targets: changed-frame p95 under 3 s, warm-unchanged under 400 ms, cold start
under 8 s. Adjust with measurements attached.

## 3. Fewer turns

A published WebVoyager run averaged ~26 model turns per task; halving turns
beats halving per-step time.

- batch deterministic actions into one decision, keeping the guardian gate and
  per-action verification on every action
- skip the model call when `domPageFingerprint` shows the page did not change
- route deterministic sub-steps (dismiss banner, wait, scroll) to a local path
  and report the on-device step share

`captureVisibleTab` is limited to 2 calls per second; no design can outrun that.

## 4. External PII corpus

The 1.00/1.00 figures come from a corpus built from the detector's own
checksum and label rules. Build a second corpus from real banking, UPI,
government and e-commerce screenshots, report recall on it, and publish the
drop. Ship the generator and a checksum, not the raw images.

## 5. Distribution

- move `debugger` to `optional_permissions` with a runtime request, documenting
  what degrades without it (trusted-click CDP fallback, full-page capture).
  Needs a browser test of the degraded path first.
- latency table by device tier (discrete GPU, integrated, Chromebook-class).
  The problem statement is about light-weight agents.

## 6. Fold the one-off scripts into test/

About twenty `scripts/test_v11xx_*.mjs` files are uncollected and unrun.
Move them under `test/` with `node --test`, then delete the originals.
