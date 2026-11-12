# Product roadmap

What the product should do next, as opposed to the engineering roadmap in
[`../ROADMAP.md`](../ROADMAP.md), which covers how to measure and sequence the
work.

Current release: **1.32.0**.

## Shipped

- Multi-provider support: local model, OpenAI-compatible gateways, Ollama.
- Visual grounding from a sanitised screenshot plus the DOM.
- Privacy pipeline: faces, credential fields, text PII, redaction manifest,
  byte-level wire guard.
- Verified actions, tab-group sandbox, task authorization daemon.
- Goal contracts, error classification, loop reflection (1.31.1 and 1.32.0).
- Scheduling through a work profile: profiles, skills, token accounting.

## Next

**Distribution.** The extension loads unpacked. Preparing it for the Chrome Web
Store means resolving the `debugger` permission (move it to optional and
document what degrades without it), a store listing, and a privacy policy that
matches the actual data flow.

**Reliability under real pages.** The loop verifies individual actions, but a
multi-step task can still finish with the wrong end state. Goal contracts cover
this when the planner declares one; the remaining work is making that
declaration routine rather than optional.

**Cost and latency transparency.** Per-task token and cost accounting exists.
Surfacing it before a task runs, not after, would let a user choose between a
local model and a cloud one on evidence.

**Language coverage.** The task authorization daemon handles Hindi and English
phrasing. The PII patterns are India-specific by design; other regions would
need their own identifier families rather than a generic detector.

## Not planned

- Chrome built-in AI (Gemini Nano). Considered and declined in 1.31.0; the
  integration would not improve on the on-device path already shipped.
- Detector and OCR model swaps. Any replacement must first pass the quality gate
  across a device matrix, which no candidate does yet.
- Training or fine-tuning models. The project ships inference only.
