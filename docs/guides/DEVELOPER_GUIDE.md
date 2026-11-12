# Developer guide

How the extension is put together, and how to work on it.

## Architecture

Open Comet is a Manifest V3 extension in three layers that talk over the
extension messaging APIs.

### Interaction layer

- **Side panel**: task input, history, settings, skills.

### Intelligence layer

The service worker runs the loop:

- **Task decomposition**: turns a goal into a sequence of browser actions.
- **Grounding**: combines screenshots with the DOM to locate elements.
- **Orchestration**: drives the loop between the model and the tab.
- **Storage**: history and usage data in `chrome.storage.local`.

### Page layer

A content script injected into the active tab:

- Renders the status overlay.
- Pauses on sensitive elements when approval is required.
- Reports page state back to the service worker.

## Stack

- JavaScript (ES2022), HTML, CSS. No build step and no runtime dependencies.
- Provider adapters for OpenAI, Anthropic, Google, and OpenAI-compatible
  gateways.
- Chrome storage for persistence.
- Manifest V3 with a strict content security policy.

## Setup

- Node 20 or newer for the test and packaging scripts.
- A Chromium browser with Developer mode enabled.

Open `chrome://extensions`, choose **Load unpacked**, and select the source
directory. After a source change, click **Reload** on the extension card.

## Debugging

| What | Where |
|---|---|
| Service worker | `chrome://extensions`, click **service worker** |
| Side panel | Right-click inside the panel, choose **Inspect** |
| Page | DevTools in the tab the agent is driving |

Logging is unified across all three contexts; see
[Diagnostics](./DIAGNOSTICS_LOGGING.md).

## Testing

```bash
npm test                       # unit tests
npm run check                  # unit tests and benchmark suites
bash scripts/check-style.sh    # comment-style gate
npm run package                # gated build
```

Browser regression suites live in `scripts/`; the ones that do not need a
browser run in CI.

## Contributing

- Do not hardcode API keys. They belong in the settings UI and storage.
- Do not expose raw prompt text in public documentation.
- A behaviour change needs a test that fails without it.
