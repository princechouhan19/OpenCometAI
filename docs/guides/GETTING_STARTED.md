# Getting Started with Open Comet

Welcome to the future of autonomous browsing. Open Comet is an AI agent that lives in your browser, helping you automate complex, multi-step tasks simply by describing them.

## Prerequisites

To run Open Comet, you will need:

1.  **Chromium-based Browser**: Chrome, Brave, Edge, or Arc.
2.  **API Keys**: At least one API key from a supported provider:
    -   **OpenAI**: [platform.openai.com](https://platform.openai.com/)
    -   **Anthropic**: [console.anthropic.com](https://console.anthropic.com/)
    -   **Google Gemini**: [ai.google.dev](https://ai.google.dev/)
    -   **DeepSeek**: [platform.deepseek.com](https://platform.deepseek.com/)
    -   **Groq**: [console.groq.com](https://console.groq.com/)

---

## Installation

Since Open Comet is currently in developer preview, it must be installed as an **Unpacked Extension**:

1.  **Download the Source**: Clone or download the repository to your local machine.
2.  **Open Extensions Page**: In your browser, navigate to `chrome://extensions`.
3.  **Enable Developer Mode**: Toggle the switch in the top-right corner.
4.  **Load Unpacked**: Click the "Load unpacked" button and select the `src` folder (or the root folder containing `manifest.json`) from the project directory.
5.  **Pin Extension**: For the best experience, pin Open Comet to your toolbar.

---

## Your First Task

1.  **Open the Side Panel**: Click the Open Comet icon in your toolbar.
2.  **Enter API Key**: Go to **Settings** and paste your API key for your preferred provider.
3.  **Run a Task**: Go to any website (e.g., a news site) and type a command:
    -   *"Summarize this page into 3 bullet points."*
    -   *"Find the cheapest laptop on this page and tell me the price."*
4.  **Observe**: Watch as the agent captures context, reasons through the steps, and interacts with the page in real-time.

---

## Execution Modes

-   **Ask Mode (Default)**: The agent pauses before every action (click, type, etc.) and waits for your approval. Best for sensitive tasks or learning how the agent works.
-   **Auto Mode**: The agent runs continuously until the task is complete. Ideal for research and high-volume data extraction.

> [!TIP]
> You can switch between modes at any time using the toggle at the bottom of the side panel.
