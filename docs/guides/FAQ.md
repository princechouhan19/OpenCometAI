# FAQ & Troubleshooting

### General Questions

**Q: Is my data shared with anyone?**
A: No. All API keys, task history, and browser context are stored locally on your machine. The only external communication is between your browser and the AI provider you have selected.

**Q: Does Open Comet support local models?**
A: Yes! You can use Ollama to run models locally and privately. See the [Features Guide](./FEATURES_GUIDE.md) for more details.

**Q: Can Open Comet handle multiple tabs?**
A: Yes. Through the "Deep Research" feature, the agent can spawn and manage multiple background tabs to gather and synthesize information.

---

### Troubleshooting

**Q: The agent keeps clicking the wrong things. What should I do?**
A: This is usually due to a low-resolution screenshot or a model that isn't optimized for vision. We recommend using **Claude 3.5 Sonnet** or **GPT-4o** for the best grounding performance.

**Q: I get a "Rate Limit" error.**
A: This error comes from your AI provider (e.g., OpenAI). Ensure your API key has sufficient balance and that you haven't exceeded the usage limits for your tier.

**Q: The side panel is blank or won't load.**
A: Try reloading the extension from `chrome://extensions`. If the issue persists, ensure you are on the latest version of a Chromium-based browser.

---

### Privacy & Safety

**Q: Can the agent buy things for me?**
A: If instructed, the agent can navigate to a checkout page. However, for your safety, Open Comet is hardcoded to pause and ask for your explicit approval before any transaction-related button (e.g., "Add to Cart", "Pay Now") is clicked.
