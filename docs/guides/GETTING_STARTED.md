# Getting started

Open Comet is a browser agent. You describe a task in the side panel and it
carries out the steps in a tab.

## Requirements

1. A Chromium-based browser: Chrome, Brave, Edge or Arc.
2. An API key from one supported provider:
   - OpenAI: [platform.openai.com](https://platform.openai.com/)
   - Anthropic: [console.anthropic.com](https://console.anthropic.com/)
   - Google Gemini: [ai.google.dev](https://ai.google.dev/)
   - DeepSeek: [platform.deepseek.com](https://platform.deepseek.com/)
   - Groq: [console.groq.com](https://console.groq.com/)

A local model is an alternative to a key; see the
[Features guide](./FEATURES_GUIDE.md).

## Installation

The extension is not published to the Chrome Web Store, so it loads unpacked.

1. Clone or download the repository.
2. Open `chrome://extensions` in your browser.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. Pin the extension to the toolbar.

## First task

1. Click the extension icon to open the side panel.
2. Open **Settings** and paste your API key.
3. Go to any page and type a task:
   - "Summarize this page into 3 bullet points."
   - "Find the cheapest laptop on this page and tell me the price."
4. Watch the agent capture the page, plan, and act.

## Execution modes

- **Ask mode (default).** The agent pauses before each action and waits for
  approval. Use this when the task touches anything you care about, or when you
  want to see how the agent works.
- **Auto mode.** The agent runs until the task completes or it stops. Use this
  for research and bulk extraction.

The toggle at the bottom of the side panel switches between them at any time.

> [!TIP]
> If a task goes wrong, stop it and reword the task rather than fighting the
> same step. The task text is what the authorization layer reads.
