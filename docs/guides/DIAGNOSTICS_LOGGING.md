# Diagnostics & Console Logging Guide (v1.5.1)

Every error the extension can hit — API failures, model-request failures, rate
limits, busy locks, step limits, uncaught crashes — now produces a clear,
tagged, timestamped console log. This document lists every tag, where each log
lands, and how to debug the most common failures in under a minute.

---

## 1. Where to open the console

| Surface | How to open | What you'll see |
|---|---|---|
| Service worker | `chrome://extensions` → OpenComet-SIH → **Inspect views: service worker** | Everything: `[API]`, `[Busy]`, `[Limits]`, `[Agent]`, `[Router]`, `[LocalML]` (relayed), `[Relay:*]` |
| Sidepanel | Right-click inside the side panel → **Inspect** | UI logs + all SW `warn`/`error` lines relayed in + `[LocalML]` stream |
| Offscreen ML runtime | `chrome://extensions` → **Inspect views: offscreen.html** | The raw ML engine log: downloads, generation, privacy pipeline |

You normally only need **one** of these — the relay system mirrors the
important lines into the other consoles automatically.

---

## 2. Log tag reference

### `[API]` — AI provider requests (cloud AND on-device)
Logged by `src/lib/providers.js` around every `callAI` / `callAIRaw` call.

```
→ openai/gpt-4o · prompt=4812c · image          (request start)
✓ openai/gpt-4o · 1832ms                        (success + latency)
✗ anthropic/claude-… · 240ms · AUTH error — check the API key · Anthropic 401: …
```

Failure kinds (classifier: `describeHttpError` in `src/core/logger.js`):

| Kind | Meaning | Fix |
|---|---|---|
| `AUTH error` | 401/403, invalid key | Re-enter the API key in Settings → AI & Models |
| `RATE-LIMIT` | 429 / quota / billing | Wait, lower step count, or check provider billing |
| `NOT-FOUND` | 404 — wrong model/endpoint | Check the model id (also applies to HuggingFace repos) |
| `BAD REQUEST` | 400 — prompt/params rejected | Usually too-large attachments; retry without image |
| `SERVER error` | 5xx — provider outage | Retry later |
| `NETWORK error` | fetch failed / DNS / offline | Check connectivity, proxy, or extension network permissions |
| `ABORTED` | Request aborted | Usually a Stop press — harmless |

### `[LocalML]` — on-device model system
Logged by `src/lib/local-llm-engine.js` + `src/lib/local-models-shared.js`.

- **Realtime download progress** — every ~10% with a rolling speed:
  `30% · 690.0 MB / 2.3 GB · 18.4 MB/s`
- Per-file fetch lines (`↓ fetch model.q4f16.onnx (1.9 GB)`), per-file cached
  confirmations (`✓ … cached`), and a completion summary with total time.
- **Model-request errors** are classified with the same `describeHttpError`
  kinds — a HuggingFace 429 during a download prints
  `DOWNLOAD FAILED "Gemma 4 E2B": … — RATE-LIMIT — …` in red (`mlError`).
- Generation metrics: `GENERATE DONE · 412 chars · 3.1s · 214 tok · 68.9 tok/s`
  and KV-cache reuse: `KV cache HIT · 1832 cached tokens · prefilling only 96 new`.

### `[Busy]` — rejected because something is already running
- `START_AGENT rejected — an agent task is already running (busy).`
- `model download already in progress — request for "gemma-4-e2b" rejected.`
- `BUSY: a generation is already running — request for "gemma-4-e2b" rejected.`

The on-device engine enforces one-generation-at-a-time (WebGPU/WASM backend is
single-instance; concurrent runs would corrupt KV caches) and returns the error
`On-device model is busy` to the caller.

### `[Limits]` — budget and context limits
- `max step limit reached (25) — finishing with the best-effort answer.`
- `context compacted at step 12 (14 steps → summary)`

### `[Agent]` — agent loop lifecycle
- `iteration 4 failed (consecutive=2): <reason>` — recoverable step failure
- `fatal: <reason>` — loop-aborting failure (also broadcast to the UI)

### `[Router]` — message-handler crashes
`handler for EXPORT_DATA crashed: …` — the failing `msg.type` is always named,
and the sender receives `{ ok: false, error }` instead of silence.

### `[Open Comet:SW]` / `[Relay:*]` — global error traps
Every uncaught error and unhandled promise rejection in all three contexts is
trapped (`installGlobalErrorTraps`) and printed with a full stack. Page-context
crashes additionally appear in the SW console as
`[Relay:sidepanel:Sidepanel] …` / `[Relay:offscreen:Offscreen] …`.

---

## 3. Relay topology (who mirrors what)

```
offscreen ML runtime ──LOCAL_MODEL_LOG──▶ SW console ──▶ sidepanel console
        │  (boot/download/generate/privacy lines)      ▲
        └──DIAG_LOG_RELAY (uncaught crashes)───────────┘ (printed as [Relay:offscreen])

SW warn/error ──DIAG_LOG broadcast──▶ sidepanel console
sidepanel uncaught crashes ──DIAG_LOG_RELAY──▶ SW console
```

No loops: each line is broadcast exactly once by its origin; receivers only
print.

---

## 4. Quick debugging recipes

| Symptom | Console line to look for | Meaning |
|---|---|---|
| Agent answers nothing, UI shows error | `✗ … RATE-LIMIT` | Provider quota exhausted |
| Download stuck at 0% | `DOWNLOAD FAILED … NETWORK error` | Offline / blocked CDN |
| "Use" button does nothing on-device | `BUSY: a generation is already running` | Stop the agent first, or wait |
| Model seems slow | `KV cache MISS` every turn | Prompt prefix changed (new chat); cache rebuilds next turn |
| Nothing happens on Start | `START_AGENT rejected — no AI provider configured` | Configure a provider in Settings |
| Weird one-off failure | `[unhandled-rejection @…]` | Copy the stack; the ring buffer (`getRecentLogs()`) keeps the last 500 lines |
