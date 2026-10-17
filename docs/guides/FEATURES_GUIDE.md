# Features & Capabilities

Open Comet is more than just a chatbot—it is a comprehensive browser operating system for AI. This guide explores its most powerful features.

---

## 🚀 Autonomous Browser Agents
The core of Open Comet is its ability to perform multi-step browser tasks without constant human intervention.
-   **Visual Perceptiveness**: The agent "sees" the page through internal screenshots and DOM mapping.
-   **Element Tagging (upgraded dom-detector)**: Every interactive control is boxed on-screen with a numeric badge; the element list carries the same `uid:nx-N` identity, so the model's pick is relocated to the exact element — not a look-alike. Cursor-first detection reaches shadow DOM, same-origin iframes and custom `<div>` widgets. Deep dive: [DOM Detector](./DOM_DETECTOR.md).
-   **Native Interactions**: It can click, type, scroll, and navigate exactly as a human would.
-   **Continuous Reasoning**: After every action, it re-evaluates the page to ensure it is on the right track.

---

## 📊 Auto Scraper (Vision-Powered)
Extraction that works on any website, even without traditional table structures.
-   **Site-Agnostic**: No CSS selectors or manual training required. If a human can see the data, the agent can extract it.
-   **Multiple Formats**: Export extracted data to **JSON**, **CSV**, or **Markdown**.
-   **Semantic Extraction**: Ask for specific data points like "Extract all contact emails" or "List all product prices."

---

## 🔬 Deep Research

Select **Parallel (cloud, keyless)** in the Deep Research **Provider** menu to
search with [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp).
Search uses Fast mode and needs no Parallel account or API key. To save this
choice, select **Parallel (cloud, no API key)** under **Deep Research search
provider** in Settings. Browser search remains the default; your saved browser
engine and AI provider settings are preserved. The Provider menu overrides the
saved provider for that run.

Parallel receives the planned research queries. Screenshots and page contents
are not sent to Parallel. Source pages are still opened and read in browser tabs,
then summarized by your configured AI provider. Keep **Browser** selected for
browser-only search. Search access follows the extension's site permissions;
Parallel needs access to `https://search.parallel.ai/*`. The request-header
permission identifies OpenComet's MCP requests and applies only to that endpoint.
This provider requires a browser supporting declarative network request session
rules. If access is denied, the service is unavailable or a request times out,
the error appears in the research activity. It does not switch providers. Click
**Stop** to cancel research, including an in-flight Parallel request. The anonymous
service has usage limits; wait before trying again when rate limited.

Handling complex retrieval tasks that span dozens of sources.
-   **Multi-Tab Orchestration**: The agent spawns background tabs to explore multiple search results simultaneously.
-   **Synthesis**: It reads through various articles and compiles a single, comprehensive report with cited sources.
-   **Recursive Search**: If initial results are insufficient, the agent will naturally refine its search queries.

---

## 🧩 The Skill System
Create reusable agent macros for your recurring workflows.
-   **Save & Trigger**: Define a complex task once (e.g., "Summarize the top 3 AI news on TechCrunch") and save it as a "Skill."
-   **Dynamic Variables**: Use `{{variables}}` to create flexible skills that ask for input (e.g., "Find the price of {{product}} on Amazon").
-   **Efficiency**: One-click execution for routine browser chores.

---

## 🛡️ Approval Guards & Privacy
Safety is built into every layer of the architecture.
-   **Approval Hub**: The agent will always pause and ask for confirmation before high-risk actions like payments, account deletions, or form submissions.
-   **Protected Domains**: Hardcoded guards for banking and financial websites ensure the agent never acts without explicit intent.
-   **Local First**: All history, settings, and API keys are stored **100% locally** in your browser. We never see your data.

---

## 🦙 Local AI (Ollama)
Run your agent 100% privately on your own hardware.
-   **Privacy**: No data ever leaves your machine.
-   -   **Cost**: Free to run (no API fees).
-   -   **Setup**: Requires [Ollama](https://ollama.com/) running locally with supported models (e.g., `qwen2.5-vl`).
