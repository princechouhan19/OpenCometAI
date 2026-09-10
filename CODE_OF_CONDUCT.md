# Contributor Covenant Code of Conduct

## Our Pledge

We as members, contributors, and leaders pledge to make participation in the
OpenComet community a harassment-free experience for everyone, regardless of age,
body size, visible or invisible disability, ethnicity, sex characteristics, gender
identity and expression, level of experience, education, socio-economic status,
nationality, personal appearance, race, religion, or sexual identity and orientation.

We pledge to act and interact in ways that contribute to an open, welcoming,
diverse, inclusive, and healthy community.

## Our Standards

Examples of behavior that contributes to a positive environment for our
community include:

* Demonstrating empathy and kindness toward other people.
* Being respectful of differing opinions, viewpoints, and experiences.
* Giving and gracefully accepting constructive feedback.
* Accepting responsibility and apologizing to those affected by our mistakes,
  and learning from the experience.
* Focusing on what is best not just for us as individuals, but for the overall
  community.

Examples of unacceptable behavior include:

* The use of sexualized language or imagery, and sexual attention or advances of
  any kind.
* Trolling, insulting or derogatory comments, and personal or political attacks.
* Public or private harassment.
* Publishing others' private information, such as a physical or email address,
  without their explicit permission.
* Other conduct which could reasonably be considered inappropriate in a
  professional setting.

## Project-Specific Expectations

Because OpenComet is a privacy-engineering project, contributors are additionally
expected to:

* **Never commit real personal data, API keys, or tokens.** Benchmarks and tests
  use synthetic data only; a fixture that contains a live credential is a reportable
  incident, not a style issue.
* **Never fabricate measurements.** Every benchmark number must come from a real
  run of the harnesses in `OpenCometBench/`, with its report kept in
  `OpenCometBench/results/`. Headless/CI numbers must be labelled as such.
* **Keep MOCK and REAL results separate.** Mock-decision and real-model runs are
  never merged into a single metric.
* **Preserve fail-closed privacy behavior.** Changes that weaken the network gate,
  the redaction pipeline, or outbound validation need explicit justification and
  review.

## Enforcement Responsibilities

Community leaders are responsible for clarifying and enforcing our standards of
acceptable behavior and will take appropriate and fair corrective action in
response to any behavior that they deem inappropriate, threatening, offensive,
or harmful.

## Scope

This Code of Conduct applies within all community spaces (issues, pull requests,
discussions, and any project chat) and also applies when an individual is
officially representing the community in public spaces.

## Enforcement

Instances of abusive, harassing, or otherwise unacceptable behavior — and any
suspected leak of real credentials or personal data into the repository — may be
reported to the maintainers by opening a **private GitHub issue** marked
`conduct` on the project repository (or by contacting a maintainer directly
through GitHub). All complaints will be reviewed and investigated promptly and
fairly.

All community leaders are obligated to respect the privacy and security of the
reporter of any incident.

## Attribution

This Code of Conduct is adapted from the
[Contributor Covenant](https://www.contributor-covenant.org), version 2.1,
available at
https://www.contributor-covenant.org/version/2/1/code_of_conduct.html.

Community Impact Guidelines were inspired by
[Mozilla's code of conduct enforcement ladder](https://github.com/mozilla/diversity).

For answers to common questions about this code of conduct, see the FAQ at
https://www.contributor-covenant.org/faq. Translations are available at
https://www.contributor-covenant.org/translations.
