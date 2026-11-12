# FAQ and troubleshooting

## General

**Is my data shared with anyone?**

No. API keys, task history and page context stay on your machine. The only
external request is to the provider you configured, and it carries the
sanitized screen context rather than the raw screen.

**Can I run a local model?**

Yes, through Ollama. See the [Features guide](./FEATURES_GUIDE.md).

**Can it work across tabs?**

Yes. Research tasks open and switch between background tabs, up to the task tab
limit.

## Troubleshooting

**The agent keeps clicking the wrong element.**

Usually the model, not the detector. Vision-capable models with strong
grounding perform best; a text-only model on a dense page does not. Capturing
at a higher zoom level also helps.

**Rate limit errors.**

These come from your provider. Check the balance and tier limits for the key.

**The side panel is blank.**

Reload the extension from `chrome://extensions`. If it persists, update the
browser.

**A task stops with an authorization message.**

The action looked like a purchase or a deletion and your task text did not
authorize it. Reword the task if you meant it.

## Privacy and safety

**Can the agent buy something for me?**

It can reach a checkout page, but purchase and deletion clicks require
authorization from your own task text, and approval mode can gate every action.
