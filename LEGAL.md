# Legal & Licensing Notes

This document covers licensing, third-party components, data policy, and
trademark notes for the **OpenComet SIH** fork (SIH Problem Statement 26171).
It is informational, not legal advice.

---

## 1. Project license

The OpenComet source code in this repository is released under the **MIT License**
— see [LICENSE](./LICENSE). By contributing, you agree that your contributions are
licensed under the same license (see also
[CONTRIBUTING.md](./CONTRIBUTING.md) and the
[Code of Conduct](./CODE_OF_CONDUCT.md)).

## 2. Third-party components

The extension is **dependency-free at runtime** for its own code: the following
third-party assets are **vendored** into `src/vendor/` so the extension works fully
on-device with no code fetched at runtime. Each vendored component remains under
its upstream license; check the upstream project for the exact text and updates:

| Vendored path | Upstream project | Typical upstream license |
|---|---|---|
| `src/vendor/transformers/` (+ `ort/`) | Hugging Face `transformers.js` and `onnxruntime-web` | Apache-2.0 / MIT |
| `src/vendor/mediapipe/` | Google MediaPipe Tasks Vision (`tasks-vision` + wasm) | Apache-2.0 |
| `src/vendor/tesseract/` | Tesseract.js (core + worker + `eng` language data) | Apache-2.0 |

### Models fetched at runtime (opt-in, cached locally)

Some on-device models are downloaded on first use from public CDNs
(Hugging Face / jsDelivr — the only `host_permissions` beyond `<all_urls>` needed
for that fetch) and are then cached in browser storage:

* **Xenova/vit-base-patch16-224** (scene classification) — served via the
  Hugging Face hub; governed by the model card published upstream.
* **MediaPipe face-detection model** — distributed with MediaPipe Tasks (Apache-2.0).

Users opt in by enabling local models; the extension never uploads anything to
these CDNs — they are fetch-only sources. Verify the exact terms on the upstream
model/project pages before redistribution.

## 3. Data policy (what this project collects)

* **No telemetry. No analytics. No external servers.** All task history,
  screenshots, settings, and API keys stay in your browser's local
  `chrome.storage`; outbound requests go only to the AI provider *you* configure,
  and — in fully on-device mode — nowhere at all.
* **Benchmarks use synthetic data only.** Every page, corpus entry, name, email,
  phone number, Aadhaar/PAN/card value, and face image in `OpenCometBench/` is
  generated or synthetic. No real personal data is committed or processed.
* **Never commit credentials.** API keys belong in the extension's Settings UI or
  your environment, never in the repository, fixtures, or packaged zips (the
  packaging pre-flight checks enforce this).

## 4. Trademarks and affiliation

* **Smart India Hackathon (SIH)**, **ISRO**, and the problem statement
  *“On-device Visual Perception for Light-weight Browser Agents”* (PS 26171) are
  referenced solely to identify the challenge this project was built for. This
  project is **not** affiliated with, endorsed by, or sponsored by ISRO, SIH, the
  Government of India, Google, or Microsoft.
* **Chrome**, **Chromium**, and **Google** are trademarks of Google LLC;
  **Visual Studio Code**/**VS Code** and related marks belong to their respective
  owners. Any use here is nominative and descriptive.
* “OpenComet” is the project name of this fork.

## 5. Responsible use

OpenComet is a privacy-protective automation tool. You remain responsible for
using it in accordance with the terms of service of the websites you run it on
and the laws that apply to you. The redaction and firewall features are
best-effort safety engineering, not a guarantee: verify sensitive output, and
review the published known-limitations policy in
[OpenCometBench/OPENCOMET_BENCH.md](./OpenCometBench/OPENCOMET_BENCH.md) before
relying on any measured claim.

## 6. Disclaimer

The software is provided **“AS IS”**, without warranty of any kind, express or
implied, including but not limited to the warranties of merchantability, fitness
for a particular purpose and noninfringement — see the full MIT License text in
[LICENSE](./LICENSE).
