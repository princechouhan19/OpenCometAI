# OpenComet-SIH Server

Privacy-aware companion server for the OpenComet-SIH browser extension.

## What it does

1. Receives an HTTP `multipart/form-data` POST to `/agent/decide` containing:
   - `image` — already-sanitized screenshot (faces blurred, PII blacked out)
   - `sanitizedText` — DOM text with `[REDACTED:<type>]` tokens in place of PII
   - `manifest` — JSON describing each redacted region (type, bounds, reason)
   - `task` — the user's high-level goal
   - `history` — JSON array of prior actions
   - `settings` — JSON: `{ provider, model, apiKey, providerBaseUrl, ollamaBaseUrl }`
2. Forwards the (already-redacted) payload to a VLM (OpenAI / Anthropic / Gemini / Ollama).
3. Parses the model's JSON response and returns an action plan:
   ```json
   {
     "ok": true,
     "backend": "ollama",
     "latencyMs": 820,
     "actionPlan": {
       "thought": "I see a search box at the top of the page",
       "action": { "type": "type", "selector": "input[name='q']", "text": "ISRO latest mission" },
       "confidence": 0.9,
       "is_complete": false
     }
   }
   ```

## Quick start

```bash
cd server
npm install

# Option A: Use a local Ollama model (fully offline — recommended for SIH judging)
OLLAMA_BASE_URL=http://localhost:11434 node server.js
# Then in the extension settings, choose provider=ollama, model=llava:7b

# Option B: Use OpenAI (cloud)
OPENAI_API_KEY=sk-... node server.js

# Option C: Use Anthropic Claude
ANTHROPIC_API_KEY=sk-ant-... node server.js

# Option D: Use Gemini
GEMINI_API_KEY=... node server.js
```

The server listens on `0.0.0.0:8787` by default. Override with `PORT=9000`.

## Endpoints

| Method | Path                | Purpose                                                        |
|--------|---------------------|----------------------------------------------------------------|
| GET    | `/health`           | Liveness probe.                                                |
| GET    | `/config`           | Which providers are configured.                                |
| POST   | `/agent/decide`     | **Main**: returns next action for the agent to execute.        |
| POST   | `/vision/describe`  | Debug: asks VLM to describe the sanitized image.               |

## Why the server matters for the SIH problem statement

> "Only this anonymized, unidentifiable data should be transmitted to the
> central server which should be aware of this redaction scheme and can
> process data accordingly."

The server is intentionally aware of the redaction manifest. The prompt sent
to the VLM includes:

```
REDACTION MANIFEST (3 regions):
1. type=password bounds=(420,180,180×32) selector="input#pw" reason=dom
2. type=face bounds=(60,40,120×120) reason=mediapipe-face
3. type=email bounds=(420,140,180×32) selector="input#email" reason=dom
```

This lets the model reason about the page (`"there's a password field, so
this is a login form"`) **without ever seeing the actual password**. The
client-side redaction + server-side manifest together form the privacy
contract.

## Redaction tokens in DOM text

Whenever the client-side regex/NER pipeline finds PII in the DOM text, it
replaces the raw value with a `[REDACTED:<type>]` token, e.g.:

```
Welcome back, [REDACTED:person]! We sent a confirmation to [REDACTED:email].
Your order #12345 will arrive at [REDACTED:address] on [REDACTED:dob].
```

The server's prompt explains this convention so the VLM treats the tokens
as opaque placeholders.

## Latency budget

| Phase                  | Typical ms | Where            |
|------------------------|-----------:|------------------|
| DOM PII scan           |        ~3  | client           |
| Face detection         |       15-40| client (WebGPU)  |
| (optional) YOLO detect |       40-90| client           |
| Canvas redaction       |        5-15| client           |
| Network upload (~50KB) |       20-80| network          |
| VLM inference          |      300-1500 | server        |
| **Total end-to-end**   |  **~400-1700** | **e2e**      |

The local vision pipeline adds <100 ms on WebGPU and pays for itself by
eliminating the need for any cloud-side privacy filtering.
