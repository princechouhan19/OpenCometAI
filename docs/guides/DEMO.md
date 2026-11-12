# Demo script

A three-minute walkthrough for a judging panel. It exercises all five
evaluation metrics in the problem statement.

## Setup

**On the laptop**

```bash
# Vision model behind Ollama
ollama pull llava:7b
ollama serve

# Companion server
cd OpenCometAI-SIH/server
npm install
OLLAMA_BASE_URL=http://localhost:11434 npm start
```

**In Chrome**

1. Load the extension: `chrome://extensions` → Developer mode → Load unpacked →
   select `OpenCometAI-SIH/`.
2. Open the side panel, click the gear icon next to Privacy Mode, and set:
   - Server URL `http://127.0.0.1:8787`
   - Every checkbox except YOLO and NER, which keeps the demo fast
3. Open DevTools on the Network tab so the panel can see outgoing requests.
4. Open the service worker inspector so the panel can see the local pipeline
   run.

**Page to have open**

- `https://www.google.com/search?q=indian+space+research+organisation`
- A banking login page or a webmail compose window makes a stronger PII demo.

## The walkthrough

### 1. Privacy mode is on by default (30 s)

Show the Privacy Mode toggle in the side panel, then the gear icon and its five
toggles plus the server URL. The point to make: every screenshot is sanitized
locally before any network call.

### 2. What the server will receive (30 s)

Click **Test capture + redact**. The preview shows the sanitized screenshot:

- Faces blurred, with a black bar across the eyes.
- The search box pixelated if it contains text.
- Card and password fields solid black.

The stats block below reports total milliseconds, faces detected, PII regions,
and the backend in use (WebGPU or WASM).

### 3. Run a real task (90 s)

Type *"Find the official ISRO website and tell me what their latest mission
is."* and press Ctrl+Enter.

Sequence to narrate:

1. The overlay pill appears at the bottom of the page: capturing and sanitizing.
2. Within about 50 ms a Privacy pipeline card appears bottom right, showing
   redaction time and backend, faces redacted, PII regions redacted, and a
   thumbnail of the sanitized screenshot.
3. The Network tab shows one request to `http://127.0.0.1:8787/agent/decide`
   carrying multipart form data.
4. Open the Payload tab: `image` is the sanitized JPEG, `sanitizedText` carries
   `[REDACTED:email]` and `[REDACTED:phone]` tokens, `manifest` describes every
   redacted region.
5. About 700 ms later the server returns a JSON action plan.
6. The agent executes the action, for example clicking the first result.
7. The loop repeats: capture, sanitize, upload, decide, execute.

### 4. The privacy contract (30 s)

Look at the last request payload and show the `manifest` field:

```json
[
  {"type":"face","bounds":{"x":60,"y":40,"w":120,"h":120},"reason":"mediapipe-face","confidence":0.97},
  {"type":"email","bounds":{"x":420,"y":140,"w":180,"h":32},"selector":"input#email","reason":"dom","confidence":0.95}
]
```

The model receives this in its prompt, so it knows what it cannot see and why,
without ever seeing the values.

## Mapping to the evaluation criteria

**Visual context accuracy (25%).** The agent still navigates after each redacted
capture, because redaction is targeted: only PII regions are masked, not the
interface.

**PII detection recall and precision (20%).** The on-page card breaks down what
was redacted by type (`password`, `face`, `email`, and so on).

**Redaction precision (20%).** Each redacted region in the preview carries an
outline and a badge naming its type. The rest of the page stays visible to the
model.

**Client resource use (20%).** Chrome's task manager (Shift+Esc) shows the
service worker at roughly 80-150 MB depending on loaded models. Only the
MediaPipe face model and the regex pipeline load by default; YOLO and NER are
opt-in. CPU is idle between captures.

**End-to-end latency (15%).** The on-page card reports about 50 ms per capture,
the network panel about 700 ms for the Ollama response, roughly 750 ms per step.

## If something fails

| Problem | Response |
|---|---|
| Ollama will not start | Switch to a cloud provider: `OPENAI_API_KEY=... npm start`, and update the server URL |
| No WebGPU (Firefox stable) | The pipeline falls back to WASM; about 50 ms becomes about 120 ms per capture |
| Agent gets stuck | Stop it from the overlay or the side panel. Pipeline state is in memory only |

## 30-second pitch

OpenComet-SIH is a browser agent that redacts the screen on-device before any
network call. A face detector, a PII scanner and a vision model run inside the
browser; only the sanitized screenshot, the sanitized text and a manifest of
what was hidden reach the server.
