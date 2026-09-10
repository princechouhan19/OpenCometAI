# Open Comet Documentation

Welcome to the official documentation for **Open Comet** — the privacy-first,
autonomous AI browser assistant built for SIH PS 26171. This folder is the index;
the benchmark has its own home in [`OpenCometBench/`](../OpenCometBench/README.md).

---

## 🚀 Start Here

- **[Getting Started](./GETTING_STARTED.md)** — Installation, API key setup, and running your first task.
- **[Features & Capabilities](./FEATURES_GUIDE.md)** — Deep dive into the Auto Scraper, Deep Research, Skills, and Privacy models.
- **[FAQ & Troubleshooting](./FAQ.md)** — Answers to common questions and fixes for common issues.

## 🛠️ Development

- **[Developer Guide](./DEVELOPER_GUIDE.md)** — Architectural overview, environment setup, and development workflows.
- **[Diagnostics & Logging](./DIAGNOSTICS_LOGGING.md)** — Console channels, log capture, and debugging the agent loop.
- **[Gemma 4 Integration](./GEMMA4_INTEGRATION.md)** — On-device WebGPU intelligence and native tool calling.
- **[VLM Speed Research](./vlm-speed-research.md)** — Measured provider latency notes that shaped the speed profiles.

## 📊 Benchmark — OpenCometBench

The benchmark suite (harnesses, fixtures, results, dashboard) lives in
**[`OpenCometBench/`](../OpenCometBench/README.md)** with its own doc + usage guide
and a one-command auto-run:

```bash
node OpenCometBench/run-opencomet-bench.mjs
```

- **[OpenComet-Bench specification](../OpenCometBench/OPENCOMET_BENCH.md)** — the contributed adversarial benchmark for privacy-preserving browser agents — 922 scored cases across four tiers (216-case leakage fuzz, 23-case adversarial wire-capture E2E, 72-run browser redaction matrix, 514-case checksum-validated PII corpus), with measured results, stable case IDs, and a published known-limitations policy.

## 🛡️ Privacy, Vision & Strategy

- **[Privacy Vision](./PRIVACY_VISION.md)** — the privacy architecture and its evolution (detector families, redaction strategies, firewall).
- **[Novelty](./NOVELTY.md)** — claim-by-claim statement of what is novel, each anchored to a measured number.
- **[SIH Readiness](./SIH_READINESS.md)** — shipping readiness against the problem statement, version by version.
- **[Roadmap](./ROADMAP.md)** — current version features and the future vision for v2.0.
- **[Distribution Strategy](./DISTRIBUTION_STRATEGY.md)** — packaging and rollout options.
- **[BrowserOS Gap Analysis](./BROWSEROS_GAP_ANALYSIS.md)** — comparison against adjacent agent-browser projects.
- **[Demo](./DEMO.md)** — guided demo script (with `demo-page.html` as the local target page).
- **[License Flow](./LICENSE_FLOW.md)** — how licensing applies to users and contributors.

## ⚖️ Governance (repository root)

- **[Code of Conduct](../CODE_OF_CONDUCT.md)** — community standards + project-specific privacy/measurement rules.
- **[Legal & Licensing Notes](../LEGAL.md)** — MIT license, vendored third-party components, data policy, trademarks.
- **[Contributing](../CONTRIBUTING.md)** — workflow, code style, PR expectations.
- **[License (MIT)](../LICENSE)** — the license text.
- **[Benchmark quick commands](../README.md#4b-sih-benchmark-suite-all-numbers-measured-never-fabricated)** — benchmark commands and the SIH criteria table live in the main README.

---

## 🛡️ Privacy & Security posture

Open Comet is built with a **Privacy-First** philosophy.

1. All API keys are stored in your browser's local storage.
2. All task history and screenshots remain on your machine.
3. We have no external servers — all communication happens directly between your
   browser and your selected AI provider (or nowhere at all in fully on-device mode).
4. Every outbound decision turn passes the on-device privacy firewall first —
   measured, not promised (see the benchmark above).

---
*Open Comet v1.15.9 | Developed with ❤️ for the future of the web.*
