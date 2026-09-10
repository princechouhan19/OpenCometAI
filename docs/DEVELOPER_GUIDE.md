# Developer Guide

This document provides a high-level overview of the Open Comet architecture and instructions for local development.

## Architectural Overview

Open Comet is built as a **Manifest V3** Chrome extension. Its architecture is divided into three primary layers that communicate via standard browser Messaging APIs:

### 1. The Interaction Layer (UI)
-   **Side Panel**: The primary user interface where tasks are entered and history is viewed.
-   **Settings**: Secure management of API keys and model configurations.
-   **Skills**: Management of reusable agent macros.

### 2. The Intelligence Layer (Background)
The "Brain" of the project runs as a persistent Service Worker. It handles:
-   **Task Decomposition**: Breaking a high-level goal into a sequence of atomic browser actions.
-   **Visual Grounding**: Combining screenshots and accessibility trees (DOM) to understand page layout.
-   **Orchestration**: Managing the loop between the AI model and the browser tab.
-   **Storage**: Securely persisting history and usage data in `chrome.storage.local`.

### 3. The Visual Layer (Content)
A lightweight script injected into active tabs to provide real-time feedback:
-   **Status Overlay**: Shows what the agent is currently thinking or doing.
-   **Approval Guards**: Pauses execution on sensitive elements (e.g., checkout buttons) to wait for user confirmation.

---

## Technical Stack

-   **Core**: JavaScript (ES6+), HTML, CSS.
-   **AI Interaction**: Provider-agnostic adapters for OpenAI, Anthropic, Google, and more.
-   **Storage**: Chrome Local Storage (IndexedDB based).
-   **Security**: Manifest V3 compliant, strict Content Security Policy (CSP).

---

## Local Development Setup

### 1. Build Requirements
-   **Node.js**: Recommended for running local tools or build scripts (if applicable).
-   **Browser**: A Chromium-based browser with Developer Mode enabled.

### 2. Installation & Reloading
-   Open `chrome://extensions`.
-   Click **Load unpacked** and select the extension source directory.
-   After making changes to the source code, click the **Reload** icon on the extension card to apply updates.

### 3. Debugging
-   **Background Logic**: Right-click the extension icon and select "Inspect background page" (or click "service worker" on the extensions page).
-   **UI Logic**: Right-click anywhere in the side panel and select "Inspect".
-   **Tab Logic**: Use the standard browser DevTools (F12) in the tab where Open Comet is acting.

---

## Repository Secrecy & Security

Open Comet uses a proprietary visual grounding and reasoning engine. When contributing or documenting:
-   **Do not** expose raw internal prompt structures.
-   **Do not** reference internal architecture file paths in public-facing documentation.
-   **Ensure** all API keys are handled via the secure settings UI and never hardcoded.
