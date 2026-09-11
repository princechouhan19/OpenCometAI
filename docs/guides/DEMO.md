# Demo Script — 3-minute SIH finale walkthrough

This script walks through a complete, judge-ready demonstration of the
OpenComet-SIH privacy-preserving vision agent. It demonstrates all five
evaluation metrics from the problem statement.

## Setup (before going on stage)

1. **On your laptop:**
   ```bash
   # Start Ollama with a vision model
   ollama pull llava:7b
   ollama serve  # already running if you've used Ollama before

   # Start the companion server
   cd OpenCometAI-SIH/server
   npm install
   OLLAMA_BASE_URL=http://localhost:11434 npm start
   ```

2. **In Chrome:**
   - Load the extension (`chrome://extensions` → Developer mode → Load unpacked → select `OpenCometAI-SIH/`).
   - Open the OpenComet side panel.
   - In the side panel, click the gear icon next to Privacy Mode. Set:
     - Server URL: `http://127.0.0.1:8787`
     - All checkboxes ticked **except** YOLO and NER (keep the demo fast).
   - Open Chrome DevTools on the Network tab so judges can see outgoing requests.
   - Open Chrome's Performance tab → "Inspect service worker" so judges can see the local vision pipeline running.

3. **Test page (have this open in a tab):**
   - `https://www.google.com/search?q=indian+space+research+organisation`
   - Or for a stronger PII demo: any banking site login page, or a webmail compose page.

---

## Live demo (3 minutes)

### Step 1 (30 sec) — "Privacy Mode is on by default"
- Show the side panel: the orange **Privacy Mode** toggle is on.
- Explain: *"Every screenshot is sanitised locally before any network call."*
- Click the gear icon → show the 5 toggles + server URL.

### Step 2 (30 sec) — "Let's see what the server will receive"
- Click **Test capture + redact**.
- The preview pane shows the sanitised screenshot:
  - Your face in any profile picture is blurred + has a black bar.
  - The search box is pixelated if it contains text.
  - Any credit card / password fields are solid black.
- Below the preview, a stats block shows: total ms, faces detected, PII regions, backend (webgpu/wasm).

### Step 3 (90 sec) — "Run a real task end-to-end"
- In the chat input, type:
  > *"Find the official ISRO website and tell me what their latest mission is."*
- Press **Ctrl+Enter** (or click Send).

What the judges will see:

1. The OpenComet overlay pill appears at the bottom of the page: "Capturing & sanitizing screen (step 1)…"
2. **Within ~50 ms**, a small "Privacy pipeline" card pops up in the bottom-right of the page showing:
   - Total redaction time + backend
   - Count of faces redacted
   - Count of PII regions redacted
   - A small thumbnail of the sanitised screenshot
3. The Network tab shows ONE outgoing request to `http://127.0.0.1:8787/agent/decide` with multipart form data.
4. Click that request → show the **Payload** tab:
   - `image`: the sanitised JPEG (faces blurred, no PII visible)
   - `sanitizedText`: text with `[REDACTED:email]` / `[REDACTED:phone]` tokens
   - `manifest`: JSON describing every redacted region
5. Within ~700 ms, the server responds with a JSON action plan.
6. The agent executes the action: e.g. clicks the first search result for "ISRO official website".
7. The loop repeats: capture → sanitize → upload → decide → execute.

### Step 4 (30 sec) — "Inspect the privacy contract"
- After the agent finishes (or stop it), look at the last network request in DevTools.
- Show the `manifest` field in the request payload:
  ```json
  [
    {"type":"face","bounds":{"x":60,"y":40,"w":120,"h":120},"reason":"mediapipe-face","confidence":0.97},
    {"type":"email","bounds":{"x":420,"y":140,"w":180,"h":32},"selector":"input#email","reason":"dom","confidence":0.95}
  ]
  ```
- Explain: *"The server's VLM receives this manifest in its prompt, so it knows what it cannot see and why — without ever seeing the original values."*

---

## Things to highlight for the judges

### Metric 1 — Accuracy of visual context (25%)
- The agent successfully navigates the page after every redacted capture.
- The VLM can still identify buttons, links, and form fields because the redaction is targeted (only PII regions are masked, not the whole UI).

### Metric 2 — Recall & precision for PII detection (20%)
- Point to the on-page "Privacy pipeline" card — it shows the breakdown by type: `password`, `face`, `email`, etc.
- Show that nothing was missed: faces are blurred, password fields are black, phone numbers in text are tokenised.

### Metric 3 — Precision of redaction (20%)
- Show the preview pane: each redacted region has an orange outline + a small "REDACTED" badge labelling what type it is.
- The redaction is targeted — only sensitive regions are touched; the rest of the page is fully visible to the VLM.

### Metric 4 — Client-side resource utilisation (20%)
- Open Chrome's Task Manager (Shift+Esc) — point to the OpenComet service worker.
- Show memory usage (~80–150 MB depending on which models are loaded).
- Note: only MediaPipe face model + regex pipeline loaded by default; YOLO and NER are opt-in.
- CPU usage is idle between captures (no polling).

### Metric 5 — End-to-end latency (15%)
- The on-page "Privacy pipeline" card shows `~50 ms` per capture.
- The Network tab shows ~700 ms for Ollama VLM response.
- Total per-step latency: ~750 ms — competitive with non-private cloud pipelines.

---

## Backup scenarios (if something goes wrong)

### If Ollama fails to start
- Switch to cloud OpenAI: stop server, then `OPENAI_API_KEY=sk-... npm start`.
- Update the server URL in the side panel if needed.

### If WebGPU is unavailable (Firefox stable)
- The pipeline falls back to WASM automatically.
- Latency increases from ~50 ms to ~120 ms per capture — still real-time.

### If the agent gets stuck
- Click the Stop button (red square in the overlay pill or in the side panel).
- The privacy pipeline state is in memory only — nothing persists.

---

## One-liner pitch (for the 30-second intro)

> "OpenComet-SIH is a privacy-preserving browser agent. A local Vision Transformer + MediaPipe face detector + PII scanner runs entirely in the browser. Sensitive content is redacted on-device before any network call. Only the sanitised screenshot + a redaction manifest reach the server — so the cloud VLM can reason about the page without ever seeing your password, your face, or your credit card."
