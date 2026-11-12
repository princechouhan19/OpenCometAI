# Features

## Browser automation

The agent runs multi-step tasks without step-by-step instruction.

- **Visual grounding.** It reads the page from a screenshot and the DOM
  together.
- **Element tagging.** Every interactive control gets a box and a numeric badge
  on screen, and the element list carries the same `uid:nx-N` identity, so the
  model's choice is relocated to that exact element rather than a look-alike.
  Detection follows the cursor first and reaches shadow DOM, same-origin
  iframes and custom `<div>` widgets. See [DOM Detector](./DOM_DETECTOR.md).
- **Native interactions.** Click, type, scroll, navigate, switch tabs.
- **Verification.** After every action it re-reads the page to confirm the
  action had an effect.

## Extraction

- **Site-agnostic.** No selectors and no training. If a person can read the
  data, the agent can extract it.
- **Formats.** JSON, CSV or Markdown.
- **Targeted.** "Extract all contact emails" or "list all product prices".

## Research

- **Multiple tabs.** The agent opens background tabs for several results at
  once.
- **Synthesis.** It reads them and writes one report with sources.
- **Refinement.** If the results are thin it changes the query.

## Skills

Reusable task templates.

- Define a task once and save it as a skill.
- Use `{{variables}}` for inputs, for example "find the price of {{product}} on
  Amazon".
- Run it again with one click.

## Approval and privacy

- **Approval hub.** Purchases, deletions and form submissions pause for
  confirmation.
- **Task authorization.** Destructive actions are authorized only by the words
  of your own task, never by page content.
- **Local storage.** History, settings and keys stay in the browser.

## Local models

- **Privacy.** No request leaves the machine.
- **Cost.** None per request.
- **Setup.** [Ollama](https://ollama.com/) running locally with a vision model,
  such as `qwen2.5-vl`.

The privacy pipeline applies in every mode: cloud, local or companion server.
