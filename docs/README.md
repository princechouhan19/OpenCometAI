# Documentation

Everything about OpenComet-SIH, organised by what you are trying to do. Start
with the [README](../README.md) if you have not installed it yet.

Release: **1.32.0**. Documentation for older releases is in
[`changelog/`](changelog/INDEX.md).

## Understand the system

| Document | Contents |
|---|---|
| [`architecture/PRIVACY_VISION.md`](architecture/PRIVACY_VISION.md) | The redaction pipeline stage by stage: capture, detection, redaction, manifest, wire guard |
| [`architecture/FILE_GUIDE.md`](architecture/FILE_GUIDE.md) | What each source file is responsible for |
| [`research/vlm-speed-research.md`](research/vlm-speed-research.md) | Measured model latency behind the speed profiles |
| [`../OpenCometBench/README.md`](../OpenCometBench/README.md) | Benchmark methodology, suites, fixtures and results |

## Use it

| Document | Contents |
|---|---|
| [`guides/GETTING_STARTED.md`](guides/GETTING_STARTED.md) | Install, configure a backend, run a first task |
| [`guides/FEATURES_GUIDE.md`](guides/FEATURES_GUIDE.md) | Every feature, with the setting that controls it |
| [`guides/DEMO.md`](guides/DEMO.md) | A scripted demo path |
| [`guides/FAQ.md`](guides/FAQ.md) | Common questions and failure modes |
| [`guides/GEMMA4_INTEGRATION.md`](guides/GEMMA4_INTEGRATION.md) | On-device model setup |
| [`guides/DOM_DETECTOR.md`](guides/DOM_DETECTOR.md) | How page elements are detected and tagged |
| [`guides/DIAGNOSTICS_LOGGING.md`](guides/DIAGNOSTICS_LOGGING.md) | Reading logs across service worker, offscreen runtime and side panel |

## Work on it

| Document | Contents |
|---|---|
| [`guides/DEVELOPER_GUIDE.md`](guides/DEVELOPER_GUIDE.md) | Architecture, conventions, testing |
| [`ROADMAP.md`](ROADMAP.md) | Engineering roadmap with acceptance criteria |
| [`PLAN-v1.32.md`](PLAN-v1.32.md) | Design review of the 1.32.0 work |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | How to contribute |
| [`../CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | Community expectations |

## Release history

| Document | Contents |
|---|---|
| [`changelog/INDEX.md`](changelog/INDEX.md) | All release notes, one file per version |
| [`changelog/v1.32.0.md`](changelog/v1.32.0.md) | Current release |
| [`changelog/v1.31.1.md`](changelog/v1.31.1.md) | Goal verification, error taxonomy |

## Project context

| Document | Contents |
|---|---|
| [`sih/SIH_READINESS.md`](sih/SIH_READINESS.md) | Problem statement mapping and readiness by version |
| [`sih/NOVELTY.md`](sih/NOVELTY.md) | Claim-by-claim novelty against comparable work |
| [`sih/BROWSEROS_GAP_ANALYSIS.md`](sih/BROWSEROS_GAP_ANALYSIS.md) | Gap analysis |
| [`sih/DISTRIBUTION_STRATEGY.md`](sih/DISTRIBUTION_STRATEGY.md) | Distribution plan |
| [`project/ROADMAP.md`](project/ROADMAP.md) | Product roadmap |
| [`project/LICENSE_FLOW.md`](project/LICENSE_FLOW.md) | Licensing of vendored code and weights |

## Conventions

- Documentation is written to be read once. No restating what the code already
  says, no claims without a source file or a result JSON to point at.
- Every measured number names the artefact it came from.
- Version numbers in prose refer to the release that introduced the behaviour,
  not the current one.
