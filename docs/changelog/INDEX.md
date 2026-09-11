# Changelog — OpenComet-SIH

Per-version release notes. The newest entries carry the full narrative;
each file preserves the section that used to live in the root `README.md`
(moved out in v1.16.0 to keep the README lean).

## Detailed release notes

| Version | File | Headline |
|---|---|---|
| v1.16.0 | [v1.16.0.md](./v1.16.0.md) | Local-perception cost round: session vision warm-up, OCR memo, `--warmup` harness flag, YOLO-downscale negative result |
| v1.15.9 | [v1.15.9.md](./v1.15.9.md) | Real-VLM E2E against OpenRouter free models + key-hygiene smoke |
| v1.15.8 | [v1.15.8.md](./v1.15.8.md) | Safe prose no longer black-boxed (secret-assignment lookaheads bounded) |
| v1.15.7 | [v1.15.7.md](./v1.15.7.md) | Summarize survives secret-shaped pages (redact-and-verify firewall policy) |
| v1.15.6 | [v1.15.6.md](./v1.15.6.md) | Final answers end-to-end + Profile custom info → agent context |
| v1.15.5 | [v1.15.5.md](./v1.15.5.md) | About page with live version chip (UI only) |
| v1.15.4 | [v1.15.4.md](./v1.15.4.md) | Avatar guard, person-name fields, pixel-only OCR ROI crops, walker budget |
| v1.15.3 | [v1.15.3.md](./v1.15.3.md) | DOM-guided face sweep for small profile photos |
| v1.15.2 | [v1.15.2.md](./v1.15.2.md) | Indian ID expansion + live per-task SIH scorecard |
| v1.15.1 | [v1.15.1.md](./v1.15.1.md) | Human-in-the-loop approvals, live context, honest media no-ops, `[VLM-*]` logs |
| v1.15.0 | [v1.15.0.md](./v1.15.0.md) | Tab-group sandbox + click-verification integrity fix |
| v1.14.x | [v1.14-privacy-firewall.md](./v1.14-privacy-firewall.md) | Central privacy firewall + fail-closed network gate; detector memos |

## Earlier milestones (summary only)

Rounds before the per-version notes existed, from the project history:

- **v1.3** — Privacy config moved into Settings → Privacy & Vision; "On-device" provider with open-weight model downloads (Transformers.js + WebGPU/WASM).
- **v1.5.0** — Gemma 4 becomes the on-device agent brain (native tool calling, page-RAG, history search); ONNX Runtime Web vendored.
- **v1.6.x** — Local-model hub, progress reporting, Local tab fixes, download checkpoint/resume (Cache API byte-level).
- **v1.7.x** — Field hardening: new-tab task starts, tiled small-face detection, click verification + `media` action, per-step timing chips; v1.7.1 console clean-up; v1.7.2 redaction coordinate-space fix.
- **v1.14.x** — Detector memos (YOLO/face exact-capture LRU), privacy firewall introduction, speed work (see [v1.14-privacy-firewall.md](./v1.14-privacy-firewall.md)).

Full readiness history against the SIH problem statement:
[`docs/sih/SIH_READINESS.md`](../sih/SIH_READINESS.md).
