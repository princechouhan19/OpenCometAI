# OpenComet-SIH Documentation

Documentation for **OpenComet-SIH** — the privacy-preserving vision browser
agent built for **Smart India Hackathon PS #26171** (ISRO). Start at the root
[`README.md`](../README.md); the benchmark has its own home in
[`OpenCometBench/`](../OpenCometBench/README.md).

## Folder map

```
docs/
├── changelog/     ← per-version release notes (v1.14 → v1.29.0)
├── guides/        ← install, features, demos, developer & debugging guides
├── sih/           ← SIH-specific: readiness, novelty claims, gap analysis, distribution
├── architecture/  ← privacy architecture deep-dive
├── research/      ← measured latency research that shaped the speed profiles
├── project/       ← roadmap & historical project notes
└── assets/        ← brand logo + the demo page used in Quick Start
```

Guides carry interactive Mermaid diagrams (rendered natively on GitHub):
architecture and the agent run loop live in the root README; the privacy
pipeline, PII taxonomy and face-recall cascade in
[`architecture/PRIVACY_VISION.md`](./architecture/PRIVACY_VISION.md); the VLM
turn and streaming failure ladder in
[`guides/DIAGNOSTICS_LOGGING.md`](./guides/DIAGNOSTICS_LOGGING.md); the DOM
detector in [`guides/DOM_DETECTOR.md`](./guides/DOM_DETECTOR.md).

## Start here

| Document | What it covers |
|---|---|
| [Getting Started](./guides/GETTING_STARTED.md) | Installation, API keys, first task |
| [Features Guide](./guides/FEATURES_GUIDE.md) | Auto Scraper, Deep Research, Skills, Privacy modes |
| [Demo walkthrough](./guides/DEMO.md) | Step-by-step SIH finale demo script |
| [FAQ & Troubleshooting](./guides/FAQ.md) | Common questions and fixes |

## Changelog

Release notes live in **[`changelog/`](./changelog/INDEX.md)** — one file per
version from v1.15.0 through v1.29.0, plus the v1.14 firewall note and a
summary of earlier milestones. The root README no longer carries version
narratives.

## Development & debugging

| Document | What it covers |
|---|---|
| [Developer Guide](./guides/DEVELOPER_GUIDE.md) | Architecture overview, environment, workflows |
| [Diagnostics & Logging](./guides/DIAGNOSTICS_LOGGING.md) | Console channels, log capture, debugging the agent loop |
| [DOM Detector](./guides/DOM_DETECTOR.md) | Element tagging with boxes + numeric badges, uid relocation chain |
| [Gemma 4 Integration](./guides/GEMMA4_INTEGRATION.md) | On-device WebGPU intelligence and native tool calling |
| [VLM Speed Research](./research/vlm-speed-research.md) | Measured provider latency notes behind the speed profiles |

## SIH & architecture

| Document | What it covers |
|---|---|
| [SIH Readiness](./sih/SIH_READINESS.md) | Readiness vs the problem statement, per version |
| [Novelty](./sih/NOVELTY.md) | Claim-by-claim novelty, each with evidence |
| [BrowserOS Gap Analysis](./sih/BROWSEROS_GAP_ANALYSIS.md) | Comparison against the BrowserOS approach |
| [Distribution Strategy](./sih/DISTRIBUTION_STRATEGY.md) | Rollout & adoption plan |
| [Privacy Vision](./architecture/PRIVACY_VISION.md) | Redaction architecture deep-dive (pipeline stages, cascade, firewall) |
| [File-by-File Guide](./architecture/FILE_GUIDE.md) | Developer map of privacy pipeline modules and background loop |

## Project

| Document | What it covers |
|---|---|
| [Roadmap](./project/ROADMAP.md) | Where the project is heading |
| [License Flow](./project/LICENSE_FLOW.md) | Historical note on the original account/license flow (auth was removed from the product; kept for reference) |

## Assets

- [`assets/logo.png`](./assets/logo.png) — project logo (comet + privacy shield)
- [`assets/demo-page.html`](./assets/demo-page.html) — the demo page from README
  §Quick Start (faces, PII form fields, credential inputs)
