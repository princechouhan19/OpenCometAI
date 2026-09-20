# Diagnostics & Console Logging Guide (v1.29.0)

Every stage of a run — planner calls, VLM requests, privacy gating, action
verification, failures — writes tagged, timestamped console lines. This guide
shows what each channel looks like, walks through a real run line by line,
and explains how to capture logs for a bug report.

Nothing in these logs prints pixels or unredacted personal data: images are
summarized (name · type · size), and page text is only ever logged after the
privacy pipeline has sanitized it.

---

## 1. Where the logs live

Open Comet logs to three consoles, merged into one stream:

| Console | How to open | What appears there |
|---|---|---|
| Service worker | `chrome://extensions` → OpenComet → **Inspect views: service worker** | Everything: run lifecycle, VLM calls, privacy loop, errors |
| Sidepanel | Right-click the sidepanel → **Inspect** | Run UI messages plus warn/error lines relayed from the worker (`DIAG_LOG`) |
| Offscreen ML runtime | `chrome://extensions` → Inspect the offscreen.html view (visible while a model runs) | Model load, WebGPU backend, warm-up, on-device inference |

The service worker console is the one to keep open while debugging. Warn and
error lines raised inside the worker are additionally relayed to the sidepanel
console, so a problem is visible even if you only have the panel open.

---

## 2. Anatomy of a log line

The unified logger (`src/core/logger.js`) prints:

```
[HH:MM:SS.mmm][Open Comet:NAMESPACE][LEVEL] message
```

For example:

```
[18:17:21.534][Open Comet:Agent][WARN] iteration 1 failed (consecutive=1): No input matched: uid:nx-2 — on page: fields: Search (input)
```

| Part | Meaning |
|---|---|
| `HH:MM:SS.mmm` | Local time, millisecond precision |
| `Open Comet:NAMESPACE` | Which subsystem produced the line |
| `LEVEL` | `DEBUG` / `INFO` / `WARN` / `ERROR` (color-coded) |

Namespaces you will see:

| Namespace | Covers |
|---|---|
| `API` | Every AI request: start, latency, TTFT, failures |
| `Agent` | Run loop decisions, iteration failures, verdicts |
| `Busy` | Run-lock contention (a start refused while one is active) |
| `Limits` | Step / token budget accounting |
| `Router` | Message routing between sidepanel, worker, content scripts |
| `SW` | Service-worker lifecycle messages |
| `Sidepanel` | UI-side messages |
| `Offscreen` | ML runtime document lifecycle |
| `LocalML` | On-device model status, ML relay lines (`[Privacy]`, model loads) |

In addition to the tagged lines, three **collapsed console groups** carry the
full AI request/response payloads (see §4), and two special prefixes mark
other channels: `[LocalML]` (model/runtime relay) and `[SIH]`
(competition privacy mode decisions).

A rolling in-memory buffer of the last 500 tagged lines is kept for
diagnostics dumps (`getRecentLogs()` in `logger.js`).

---

## 3. A real run, line by line

Below is an actual captured run (task: search a song on a music site),
trimmed to one line per event. Stack frames that DevTools adds under each
line are omitted.

```
[LocalML] [OpenComet] vdev · offscreen ML runtime
[LocalML] Offscreen ML runtime booted · backend=webgpu · webgpu=true
[LocalML] webnn: N/A: navigator.ml is undefined — this browser does not expose WebNN
[OffscreenBridge] offscreen document created
```
Boot: the ML runtime document is up, WebGPU is available, WebNN is absent
(informational — the runtime falls back to WebGPU).

```
[Open Comet] Planner role: analyzing task and building plan…
[Open Comet] Planning screenshot  (+2.2s)
[Open Comet] Planner role: calling custom...  (+0.0s)
[SIH] SIH MODE: raw screenshot blocked from network transmission (agent continues with sanitized/DOM context only).
```
The planner phase starts. In SIH mode the raw screenshot is **never** put on
the wire — the planner works from the sanitized DOM context instead.

```
[18:16:55.542][Open Comet:API][INFO] → custom/qwen/qwen3-vl-235b-a22b-thinking · prompt=8161c
[Open Comet][VLM-REQ] → custom/qwen/qwen3-vl-235b-a22b-thinking · prompt 8161 chars · 0 image(s)
[18:17:09.306][Open Comet:API][INFO] ⚡ OpenAI Compatible/qwen/qwen3-vl-235b-a22b-thinking · TTFT 12120ms [s1r0j1] — prefill+reasoning done, generating…
[18:17:11.037][Open Comet:API][INFO] ✓ OpenAI Compatible/qwen/qwen3-vl-235b-a22b-thinking · total 13852ms · TTFT 12120ms · gen 1732ms · 435 chars (~251 c/s) · out=865tok
[Open Comet][VLM-RAW] ← OpenAI Compatible/qwen/qwen3-vl-235b-a22b-thinking · 435 chars (model text before JSON parsing)
[18:17:11.039][Open Comet:API][INFO] ✓ custom/qwen/qwen3-vl-235b-a22b-thinking · 15497ms
[Open Comet][VLM-RES] ← custom/qwen/qwen3-vl-235b-a22b-thinking · 15497ms
```
One full VLM turn (§4 explains every field). This turn took 15.5 s end to
end: 12.1 s to first token, then 435 characters at ~251 chars/s.

```
[Open Comet] Plan ready  (+15.5s)
[Open Comet] Starting execution…
[Open Comet] Screenshot #1  (+0.5s)
[Open Comet] Navigator role: deciding next action… (step 1)
[18:17:11.572][Open Comet:API][INFO] → custom/qwen/… · prompt=62191c
[18:17:21.425][Open Comet:API][INFO] ✓ OpenAI Compatible/… · total 6177ms · TTFT 4954ms · gen 1223ms · 217 chars (~177 c/s) · out=358tok
```
Execution begins. The navigator prompt is much larger (62 k chars) because it
carries the page manifest and task history.

```
[Open Comet] Verifier role: fresh DOM check passed for type (uid:nx-2)
[Open Comet] Type "Shape of You Ed Sheeran" into uid:nx-2
[Open Comet] No input matched: uid:nx-2 — on page: fields: Search (input)
[18:17:21.534][Open Comet:Agent][WARN] iteration 1 failed (consecutive=1): No input matched: uid:nx-2 — on page: fields: Search (input)
[18:17:21.535][Open Comet:Agent][ERROR] fatal: No input matched: uid:nx-2 — on page: fields: Search (input)
[Open Comet] No input matched: uid:nx-2 — on page: fields: Search (input)
```
The verifier re-checked the DOM, the type action ran, and the target input
was not on the page (the manifest's only field was `Search`). The loop
reports the iteration failure, escalates to a fatal error per its failure
policy, and the run ends with that explanation in History. This is the
honest-failure path working as designed: the run does not claim success.

---

## 4. The AI request lifecycle

Every AI call (all providers) funnels through the same logging in
`src/lib/providers.js`:

| Line / group | Shows |
|---|---|
| `→ provider/model · prompt=Nc · image` (API) | Request start with prompt size in chars |
| `[VLM-REQ]` (collapsed group) | The **exact prompt text**, one summary line per image (`name · mime · KB base64 (pixels not printed)`), plus `maxTokens` / `reasoningEffort` when set |
| `⚡ … TTFT Nms [attempt]` | Time to first token — prefill + reasoning are done, text is arriving. `s1r0j1` = streaming on, reasoning on, JSON mode on |
| `✓ … total Nms · TTFT Nms · gen Nms · M chars (~R c/s) · out=Ttok · finish=…` | Wall-time split and throughput. High TTFT = queue/reasoning burn; low chars/s = provider throughput |
| `[VLM-RAW]` (collapsed group) | The model's text **before** JSON parsing — the fastest way to see why parsing failed |
| `[VLM-RES]` (collapsed group) | The parsed JSON the agent actually received |
| `✗ … · Nms · <kind> · <detail>` (API, ERROR) | The request failed — kind from §7 |

The `⚡` warning threshold is 30 s: a TTFT above that means the provider
queue or reasoning burn dominates, and the log suggests faster routes/models.

---

## 5. Streaming failure ladder (v1.29.0)

Thinking models can return `200 OK` with **no visible text**: the model
spends minutes on invisible reasoning, hits the token cap or holds the SSE
stream open without emitting anything (observed at 290 s on
`qwen3-vl-235b-a22b-thinking`). The OpenAI-compatible provider now guards
every attempt:

| Guard | Behavior |
|---|---|
| **Idle watchdog** | No bytes for **45 s** → the attempt is aborted (`stream idle > 45s`) |
| **Attempt cap** | Each attempt aborts after **150 s** (`no completion within 150s`) |
| **Total budget** | The whole ladder gives up after **300 s** (`gave up after 300s total`) |
| **Empty response** | `200 OK` with no text escalates instead of failing the run |

On an empty or stalled attempt the ladder escalates in place — the attempt
tag shows what changed:

```
s1r0j1            first try            (stream + json + reasoning)
s1r0j1·x2         token budget ×2      (room for reasoning + answer)
s1r0j1·x2-nothink + thinking disabled  (enable_thinking:false / chat_template_kwargs)
s1r0j0            next rung            (no JSON mode) …
s0r0j0            non-streaming fallback
```

Corresponding log lines:

```
[Open Comet:API][WARN] ✗ OpenAI Compatible/qwen3-vl-235b-a22b-thinking · s1r0j1 · 200 OK but no text — hit the 2500-token cap. Thinking models burn tokens on invisible reasoning — the -instruct variant of the same model typically answers in a few seconds. Escalating.
[Open Comet:API][WARN] ⏱ OpenAI Compatible/qwen3-vl-235b-a22b-thinking · s1r0j1 · ABORTED — escalating
[Open Comet:API][WARN] OpenAI Compatible 400 (…) on s1r0j1·x2-nothink — retrying with s1r0j0
[Open Comet:API][ERROR] ✗ custom/qwen3-vl-235b-a22b-thinking · 312041ms · request failed · Empty response from model (finish=length)
```

Only `400`/`422` (unknown parameter) walk down the rungs; auth, rate-limit
and network errors surface immediately. If your model name contains
`-thinking`, the escalation log suggests the `-instruct` variant — in
practice it answers in a few seconds per turn.

---

## 6. Privacy pipeline logs

When privacy mode is on, the pipeline logs its progress under `[LocalML]` /
`[Privacy]` and `[SIH]`:

| Line | Meaning |
|---|---|
| `[SIH] SIH MODE: raw screenshot blocked from network transmission…` | Raw pixels never leave the machine |
| `[Privacy] <stage summary>` | Per-capture stage results (faces, DOM regions, objects, text PII) |
| `[Privacy] Face detection failed — fail-closed (frame will FAIL verification): <reason>` | A failed face stage blocks the frame instead of shipping unverified pixels |
| `[Privacy] YOLO detection failed: …` / `ViT classification failed: …` | Optional stages degrade gracefully; the pipeline continues with what it has |
| `Redact-and-verify: masked N secret-shaped fragment(s), re-verified clean` | Outbound text sweep (§5's policy): mask locally, re-verify, transmit clean text |
| `[REDACTED:password]`, `[REDACTED:api_key]`, … | Tokens that replaced sensitive values **in text and in pixels** — if you see these in a prompt dump, sanitization worked |

What is *never* in the logs: raw screenshots, base64 pixel data (only size
summaries), and unsanitized page text. The `[VLM-REQ]` group prints the exact
prompt the model receives — after sanitization. That is deliberate: the log
shows precisely what left the machine.

---

## 7. Failure kinds

Network/API failures are classified into a short kind + hint
(`describeHttpError` in `logger.js`):

| Kind in the log | Typical cause |
|---|---|
| `AUTH error — check the API key` | 401/403, invalid or revoked key |
| `RATE-LIMIT — too many requests or quota exhausted…` | 429, quota/billing |
| `NOT-FOUND — model/endpoint does not exist…` | 404, wrong model name or repo |
| `BAD REQUEST — prompt/params rejected by the endpoint` | 400/402/428, payload or params refused |
| `SERVER error — provider outage, retry later` | 5xx, gateway overload |
| `ABORTED` | Timed-out attempt or idle-watchdog abort (§5) |
| `NETWORK error — offline, blocked, or DNS failure` | fetch failed, offline, blocked by browser/policy |

The full error line is `✗ provider/model · <elapsed>ms · <kind> · <first
220 chars of the underlying message>`.

### 7.1 Credit-fit refit (402)

Pay-as-you-go gateways (OpenRouter) reject requests whose `max_tokens` the
balance cannot cover and state the largest affordable output. Before v1.29.0's
credit-fit that was a dead end: every step died at `402 … can only afford 544`
before any action ran. Now the request is refitted to the balance and retried
on the same rung:

```
[Open Comet:API][WARN] OpenAI Compatible 402 — balance covers ~544 output tokens · refitting max_tokens=462
```

- `max_tokens` is set to 85% of the affordable count (safety margin) and stays
  clamped for the rest of the call, including the x2 escalation rung.
- A balance that cannot fund ~256 output tokens (below the room an action JSON
  needs) fails fast with the top-up URL instead of returning truncated JSON.
- A plain 402 with no affordable count fails with the same hint.

---

## 8. Capturing logs for a bug report

1. Open the service worker console (`chrome://extensions` → OpenComet →
   Inspect service worker).
2. Reproduce the task. Let the run finish or stop it, so the final state is
   logged.
3. Right-click in the console → **Save as…** (or select all → copy) and
   attach the file.
4. If the problem is UI-side, capture the sidepanel console the same way.

Include the model name, provider/gateway, and the task text. Everything the
console contains is already safe to share (§6) — but skim collapsed
`[VLM-REQ]` groups once before posting publicly if your task text itself
contains personal information: those groups print the sanitized prompt, and
the task text is part of it.
