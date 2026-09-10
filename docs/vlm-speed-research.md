# VLM Latency Optimization — Research & Implementation (v1.9.0)

Field log that triggered this work: **"play a song on yt music"** completed in
12 steps / 666.8 s — of which **~571 s (85%) was waiting on the VLM**
(12 decision calls at 26.8–93.3 s each, provider `custom/moonshotai/kimi-k3`).
The actions themselves took <10 s combined. This document records what the
research found, what we implemented, and what to tune next.

---

## 1. Root-cause analysis of the field run

| # | Cause found in the log | Cost |
|---|------------------------|------|
| 1 | **kimi-k3 always reasons.** Kimi's own docs: *"kimi-k3 always reasons and does not support the thinking parameter. Adjust reasoning effort with the top-level `reasoning_effort` field"* (`low`/`high`/`max`). We sent NO effort field, and OpenRouter-routed providers (e.g. Novita) document *"Reasoning is always on… efforts low, high, max; **max is the default**"*. Every turn burned long hidden reasoning before the tiny JSON answer. | 20–70 s/turn — the single biggest cost |
| 2 | **Privacy-off path blinded the agent**: `captureAndSanitize` returned `page=undefined` → prompt said `url=?`, `no <video> elements` while the fingerprint saw `videos=1`. The VLM contradicted its own context, re-navigated to a page it was already on, and hesitated. | ~2 turns (~2 min) |
| 3 | **`media` action was blind to hidden videos**: `domMediaControl` filtered `area > 0`, but YouTube Music keeps its `<video>` mounted at 0×0 until playback starts → "No <video> or <audio> element" while `videos=1` existed. The VLM tried the media action 3 times, failed 3 times. | 3 turns (~3 min) |
| 4 | **Fuzzy click matching**: needle `text:play` first-partial-matched the sidebar button **"New playlist"** (`"new playlist".includes("play")`), opening a dialog that blocked the page for two more rounds. | 2–3 turns |
| 5 | **Raw PNG upload** in the privacy-off path (no 1280px/JPEG normalization like the privacy-on path) → 5–10× more upload bytes and vision tokens per turn. | seconds/turn + tokens |
| 6 | **activeTab revocation mid-run** (Chrome "Site access" restriction): run #1 died at step 2 right after the youtube.com → music.youtube.com cross-origin navigation. | 1 full run |
| 7 | **Start-URL coarse**: "yt music" opened www.youtube.com; the VLM then spent a turn navigating to music.youtube.com. | ~1 turn (~1.5 min) |

## 2. Research survey (papers · repos · vendor docs · threads)

### Vendor documentation (directly actionable for API agents)
- **Kimi "Thinking Models"** — kimi-k3 always reasons; control via top-level
  `reasoning_effort` (`low`/`high`/`max`): <https://platform.kimi.ai/docs/guide/use-thinking-models>
  Kimi platform pricing also shows **automatic context caching** (cache-hit
  input ≈ 10× cheaper than uncached), rewarding stable prompt prefixes:
  <https://platform.kimi.ai>
- **OpenRouter — Reasoning Tokens guide**: unified `reasoning: { effort,
  exclude }` parameter across providers: <https://openrouter.ai/docs/guides/best-practices/reasoning-tokens>
  Provider page example (Novita, a Kimi router): reasoning always on, default
  max: <https://openrouter.ai/provider/novita>. Fast routed variants
  (`:nitro`) trade price for throughput.
- **DeepInfra Kimi K2.5 latency benchmarks** — measured TTFT/throughput per
  provider tier (Turbo vs budget): <https://deepinfra.com/blog/kimi-k2-5-api-benchmarks>

### Systems / agent-engineering references
- **"How Browser Use Achieves the Fastest Agent Execution"** (browser-use
  blog, *Speed Matters*) — the four production levers we mirror:
  ① exploit the KV cache (stable prompt prefix), ② screenshots only when
  needed (each screenshot ≈ +0.8 s encoder time), ③ smart text extraction
  alongside pixels, ④ minimize output tokens:
  <https://browser-use.com/posts/speed-matters>
- **"Efficient GUI Agents: A Systems Survey"** — formalizes agent latency as
  TTFT + TPOT × output tokens and surveys observation/action optimizations:
  <https://arxiv.org/html/2609.02309v1>
- **"Building Browser Agents: Architecture, Security, and Trust"** —
  screenshot-vs-DOM hybrid perception trade-offs: <https://arxiv.org/html/2511.19477v1>

### GUI-grounding papers (fewer mis-clicks ⇒ fewer turns)
- **OmniParser (Microsoft)** — parse the screen into structured interactable
  elements, then Set-of-Marks label overlay so the model clicks "element 12"
  instead of guessing labels: <https://arxiv.org/abs/2408.00203>,
  repo: <https://github.com/microsoft/OmniParser>
- **Set-of-Mark prompting (SoM)** — visual overlays beat coordinate
  grounding for GPT-4V-class models: <https://arxiv.org/abs/2310.11441>
- Process-reward guidance for VLM agents at inference time:
  <https://arxiv.org/abs/2504.16073>

### Vision-token reduction (matters most for self-hosted models)
- **FastV** — prune ~50% of visual tokens after shallow LLM layers:
  <https://arxiv.org/abs/2403.06764>
- **PyramidDrop** — visual redundancy drops with negligible loss:
  <https://openreview.net/forum?id=5ncdKonxd4>
- **VScan** (training-free two-stage token reduction):
  <https://arxiv.org/abs/2505.22654>
- Curated list (FastV/SparseVLM/VTW/TopV…): <https://github.com/daixiangzi/awesome-token-compress>
- For API agents the practical equivalent is **downscale + JPEG before
  upload** (what the privacy path already did at 1280px, and what the
  privacy-off path now does too).

## 3. What v1.9.0 implements (research → code)

| Lever (from research) | Implementation | File |
|---|---|---|
| Reasoning effort control (Kimi docs + OpenRouter) | Decision turns send `reasoning_effort: "low"` to Moonshot-family hosts, `reasoning:{effort:"low",exclude:true}` on OpenRouter; unknown gateways get the de-facto `reasoning_effort`. Strict endpoints that 400/422 automatically retry without the params. Default `low`, overridable via `settings.vlmReasoningEffort`. | providers.js |
| Output-token minimization (browser-use ④) | `max_tokens: 800` for decision turns (was 2500) + prompt now demands `"thought": "max 14 words"`, JSON-only, no prose. Overridable via `settings.vlmMaxTokens`. | providers.js, privacy-agent.js |
| TTFT attribution (systems survey) | Streaming is now the default for kimi/deepseek/glm/custom, with `stream_options.include_usage`; logs `TTFT xms · gen yms · ~z c/s · out=ntok` per turn and warns when TTFT > 30 s (server queue/reasoning burn vs low throughput — now distinguishable in the console). | providers.js |
| KV/context-cache hits (browser-use ①, Kimi caching) | Prompt reordered STABLE-first (role/task/rules) VARIABLE-last (page/DOM/manifest/history); history compacted to last-3-full + one-liners so the prefix stays byte-stable across steps. | privacy-agent.js, agent-context.js |
| Screenshots only when needed / image diet (browser-use ②, token-pruning analog) | Privacy-off path now normalizes to ≤1280px JPEG q0.85 in the SW (OffscreenCanvas) — same as the privacy path; ~5–10× smaller upload per turn. | privacy-agent.js |
| Multi-action planning (WebDreamer-style lookahead, SoM-family pipelines) | Decision JSON accepts an optional `"queue"` of up to 2 pre-authorized follow-up actions; the loop executes them with full verification and **zero VLM calls**, aborting at the first surprise. Validated by `planQueueActions()` (click/type/scroll/wait/media/press_key only). | agent-context.js, privacy-loop.js |
| Closed-loop recovery without re-asking the model | On a verified-ineffective *playback* click with a `<video>` present (even hidden), the loop auto-runs the direct `media` command and writes the honest result to history. | privacy-loop.js, agent-context.js (`detectPlaybackIntent`) |
| Failed-target memory | Verification-proven dead click targets are listed in the next prompt as forbidden repeats. | agent-context.js (`extractFailedTargets`) |
| Grounding hygiene (OmniParser/SoM motivation) | `domClick` text matching is now SCORED (exact 100 > word-boundary 70 > prefix 55 > substring 35, short-label bonus) — "play" can no longer click "New playlist". | actions.js |
| Media action truthfulness | `domMediaControl` accepts hidden/zero-area videos (visible preferred) — YouTube Music's invisible player is drivable again. | actions.js |
| Start-URL fast-path | "yt music / youtube music" opens music.youtube.com directly — no VLM navigation turn. | sw.js |
| Capture resilience | `captureVisibleTab` activeTab-denial now falls back to `chrome.debugger` Page.captureScreenshot with a clear fix-it hint (chrome://extensions → Site access → On all sites). | privacy-agent.js |
| Runtime warmth | Privacy-ON runs ping the offscreen runtime each step (`ML_TOUCH`) so its 5-min idle teardown can't fire mid-run after long VLM turns. | privacy-loop.js, offscreen.js |

### Expected impact on the exact field task (12 steps, 571 s VLM)
- reasoning `low` + 800-token cap + shorter prompt: **each remaining turn
  drops from 27–93 s to roughly 8–25 s** on the same provider (provider-
  dependent; TTFT logs will show it).
- music fast-path (−1 turn), working media action (−3 turns), scored click
  matching (−2 turns), auto-recovery (−1 turn): **12 steps → ~5–7 steps**.
- Combined expectation for this task class: **11 min → ~2–4 min**, and the
  console now attributes any remaining slowness (TTFT vs throughput).

## 4. Tuning knobs & next steps
- `settings.vlmSpeedProfile` (`fast` / `balanced` / `quality`), `settings.vlmReasoningEffort`
  (`low` default), `settings.vlmMaxTokens` (0 = follow profile) — all three are exposed in
  **Settings → AI & Models → Behaviour** since v1.10.0.
- If turns are still slow, the TTFT log tells you which fix applies:
  high TTFT → switch model/route (e.g. OpenRouter `:nitro`, Moonshot direct,
  or a faster model class: kimi-k2-turbo / gemini-flash / glm-4.5v-lite);
  low TTFT but low c/s → provider throughput; switch route, not model.
- Set-of-Marks overlay (numbered element labels from the DOM scan we already
  run) is the highest-ceiling follow-up: it converts grounding from
  label-guessing to ID selection, cuts mis-clicks further, and lets the
  screenshot drop to ~896px (fewer vision tokens).
- ~~Screenshots-optional turns~~ → **shipped in v1.10.0** as automatic shot
  reuse (see §5, lever #1).

## 5. v1.10.0 — the GENERALIZED (any-provider) speed solution

v1.9.0's tuning was validated against one endpoint (kimi-k3). v1.10.0 turns
every lever from §3 into a **provider-agnostic speed system**: the same three
knobs work identically on OpenAI, OpenRouter, Moonshot/Kimi, DeepSeek, GLM,
Qwen/DashScope, Together, Groq, Fireworks, vLLM, Ollama and the on-device
path. Nothing below requires a vendor-specific API, a vendor account, or a
specific model family.

### 5.1 The universal levers (tiered by portability)

**Tier 0 — works on EVERY endpoint, zero provider support (pure client-side):**
1. **Screenshot reuse on unchanged pages** (NEW in v1.10) — before every
   capture the loop fingerprints the page (url + title + scroll + media
   states + text hash). If nothing changed since the previous step, the
   previous (sanitized) screenshot is reused: no capture, no sanitize, no
   upload, no extra image tokens, and the prompt stays byte-identical →
   automatic prompt-cache hits wherever the provider has them. Safety rails:
   any PLAYING video forces a fresh shot; privacy-mode changes invalidate;
   age cap (45–60 s) and a consecutive-reuse cap force periodic refresh.
   *(browser-use lever ②, generalized — no provider feature required.)*
2. **Image diet** — ≤896/1280/1536px JPEG (profile-dependent) on BOTH paths
   (privacy-on via the redaction pipeline `maxWidth`, privacy-off via
   OffscreenCanvas). The API-side equivalent of FastV/PyramidDrop token
   pruning: fewer vision tokens = faster prefill on every provider.
3. **Constant-size prompt** — history compacted to last-N-full + one-liners
   (N from profile); DOM text capped; manifest capped. The prompt no longer
   grows with run length.
4. **Output-token minimization** — terse JSON contract (`thought` ≤ 14 words)
   + profile max_tokens cap (600/800/1400). Output tokens are pure
   TPOT × n seconds on every provider (systems-survey framing).
5. **Fewer turns, not just faster turns** — speculative 2-action queue,
   auto-media recovery, scored click matching, failed-target memory,
   site fast-path. Each avoided turn saves the WHOLE turn latency.

**Tier 1 — auto-detected, works on almost every endpoint (graceful fallback):**
6. **Stable prompt prefix for automatic context/KV caching** — rules/role
   blocks first, variable page/DOM/history blocks last, byte-stable across
   steps. Moonshot (auto caching), DeepSeek (automatic context caching),
   OpenAI (automatic prompt caching), Gemini (implicit caching),
   Anthropic (explicit `cache_control`), OpenRouter (passthrough) all bill
   cached prefixes ~10× cheaper and prefill them faster. We just stop
   mutating the prefix. *(No API call needed — ordering only.)*
7. **Reasoning-effort hint with auto-mapping** — one setting (`low` default)
   mapped per endpoint family by hostname: OpenRouter → `reasoning:{effort,
   exclude:true}`; Moonshot/Kimi + OpenAI o-series + most OpenAI-compatible
   gateways → `reasoning_effort`; unknown gateways → the de-facto
   `reasoning_effort`; '' → send nothing. A 400/422 automatically retries
   without the params, so strict endpoints degrade cleanly instead of
   failing. (Research: Kimi Thinking-Models docs, OpenRouter reasoning guide,
   DeepInfra benchmarks — reasoning burn was the single biggest field cost.)
8. **Streaming + TTFT/throughput attribution** — SSE everywhere with
   `stream_options.include_usage`; every turn logs TTFT and chars/sec so a
   slow turn is attributable (queue/reasoning vs throughput) on any provider.

**Tier 2 — provider-specific opt-ins (documented, not required):**
- OpenRouter: append `:nitro` to the model slug for a faster route.
- Moonshot direct: `platform.kimi.ai` auto context caching (no API change).
- DeepInfra/Together/Groq: pick the turbo/flash variant of the same model.
- Anthropic-native: add `cache_control` breakpoints (only if you route
  Anthropic natively; the OpenAI-compatible layer doesn't expose it).
- On-device (Gemma): profiles also apply — smaller image = fewer vision
  tokens on YOUR GPU.

### 5.2 Speed profiles (Settings → AI & Models → Behaviour)

| Knob | fast | balanced (default) | quality |
|---|---|---|---|
| Screenshot long edge | 896 px | 1280 px | 1536 px |
| JPEG quality | 0.80 | 0.85 | 0.90 |
| DOM text cap | 2 200 chars | 3 500 chars | 6 000 chars |
| Full-detail history entries | 2 | 3 | 5 |
| Decision max tokens | 600 | 800 | 1 400 |
| Reasoning effort hint | low | low | medium |
| Manifest lines | 20 | 40 | 60 |
| Screenshot reuse | ✓ (45 s, streak 3) | ✓ (60 s, streak 2) | — |

Expected impact of `fast` vs the v1.8 field run on ANY provider: image tokens
≈ halved, prompt ≈ constant at ~2 k chars, output capped at 600, no capture
at all on unchanged steps, plus fewer turns from the v1.9 loop fixes — i.e.
the same 12-step task class should land in the **2–4 min** range regardless
of vendor, and the console will attribute whatever remains.

### 5.3 Provider cheat-sheet (all OpenAI-compatible unless noted)

| Provider | Reasoning control | Prompt caching | Fast-route tips |
|---|---|---|---|
| OpenAI | `reasoning_effort` (auto-mapped) | automatic prompt caching (≥1024 tok) | `gpt-4o-mini` class for speed |
| OpenRouter | `reasoning{effort,exclude}` (auto-mapped) | varies by backend | `:nitro` route suffix |
| Moonshot / Kimi | `reasoning_effort` (auto-mapped) | automatic context caching | kimi-k2-turbo class |
| DeepSeek | no effort knob (reasoner always thinks) | automatic context caching | use non-reasoner chat model |
| GLM (Zhipu) | thinking toggle | prefix caching on GLM-4.5+ | glm-4.5v-lite / flash tier |
| Qwen (DashScope) | `enable_thinking:false` tolerated (ignored, clean retry) | implicit prefix cache | qwen-vl-flash |
| Gemini (OpenAI-compat) | ignores effort (clean retry) | implicit caching | gemini-flash class |
| Groq / Cerebras / SambaNova | N/A (speed hosts) | N/A | pick the fastest vision host |
| vLLM / Ollama / llama.cpp | model-dependent (ignored cleanly) | vLLM automatic prefix caching ✓ | smaller quant + 896px shots |
| On-device (Gemma E2B) | N/A | N/A (local) | `fast` profile + 4-bit q4f16 |

Every row is safe with the default settings: unknown fields are either
ignored or get the automatic 400/422 clean retry from the attempt ladder.
