# Model latency: research and implementation (v1.9.0)

The field run behind this work: "play a song on yt music" took 12 steps and
666.8 s, of which about 571 s (85%) was waiting on the model across 12 decision
calls of 26.8 to 93.3 s each, on
`custom/moonshotai/kimi-k3`. The actions themselves took under 10 s in total.

This document records the research, what was implemented, and what to tune next.

## Where the time went

| Cause found in the log | Cost |
|---|---|
| **kimi-k3 always reasons.** Kimi's documentation states that kimi-k3 does not support a thinking parameter and that effort is set with the top-level `reasoning_effort` field (`low`, `high`, `max`). We sent no effort field, and OpenRouter-routed providers such as Novita document reasoning as always on with `max` as the default. Every turn spent long hidden reasoning before the small JSON answer. | 20-70 s per turn, the largest single cost |
| **The privacy-off path blinded the agent.** `captureAndSanitize` returned `page=undefined`, so the prompt said `url=?` and "no video elements" while the fingerprint reported one video. The model contradicted its own context, re-navigated to the page it was already on, and hesitated. | about 2 turns |
| **The media action ignored hidden videos.** `domMediaControl` filtered on `area > 0`, but YouTube Music keeps its video element mounted at 0x0 until playback starts, so the action reported no media element while one existed. It was tried three times and failed three times. | 3 turns |
| **Fuzzy click matching.** The needle `text:play` matched the sidebar button "New playlist" on the first partial match, opening a dialog that blocked the page for two more rounds. | 2-3 turns |
| **Raw PNG upload** in the privacy-off path, with no 1280 px or JPEG normalization as on the privacy-on path, so each turn uploaded 5-10x more bytes and vision tokens. | seconds per turn plus tokens |
| **activeTab revocation mid-run.** The first run died at step 2, immediately after the cross-origin navigation to music.youtube.com, because of Chrome site-access restrictions. | one full run |
| **A coarse start URL.** "yt music" opened www.youtube.com, costing a turn to navigate to music.youtube.com. | about 1 turn |

## Research

### Vendor documentation

- Kimi thinking models: kimi-k3 always reasons, controlled through top-level
  `reasoning_effort`: <https://platform.kimi.ai/docs/guide/use-thinking-models>.
  Kimi pricing also shows automatic context caching, with cache hits costing
  roughly a tenth of uncached input, which rewards a stable prompt prefix:
  <https://platform.kimi.ai>
- OpenRouter reasoning tokens: a unified `reasoning: { effort, exclude }`
  parameter across providers:
  <https://openrouter.ai/docs/guides/best-practices/reasoning-tokens>.
  A provider page example (Novita, a Kimi router) documents reasoning as always
  on with max as the default: <https://openrouter.ai/provider/novita>. Faster
  routed variants (`:nitro`) trade price for throughput.
- DeepInfra Kimi K2.5 latency benchmarks, with TTFT and throughput per provider
  tier: <https://deepinfra.com/blog/kimi-k2-5-api-benchmarks>

### Agent engineering

- "How Browser Use Achieves the Fastest Agent Execution" (browser-use, Speed
  Matters), which lists four production levers: exploit the KV cache with a
  stable prefix; screenshot only when needed, since each screenshot costs about
  0.8 s of encoder time; combine text extraction with pixels; minimize output
  tokens: <https://browser-use.com/posts/speed-matters>
- "Efficient GUI Agents: A Systems Survey", which models agent latency as
  TTFT plus TPOT times output tokens and surveys observation and action
  optimizations: <https://arxiv.org/html/2609.02309v1>
- "Building Browser Agents: Architecture, Security, and Trust", on the
  trade-offs of screenshot versus DOM perception: <https://arxiv.org/html/2511.19477v1>

### Grounding

- OmniParser (Microsoft): parse the screen into structured interactable
  elements, then label them with Set-of-Marks so the model selects an element
  instead of guessing labels: <https://arxiv.org/abs/2408.00203>,
  repository <https://github.com/microsoft/OmniParser>
- Set-of-Mark prompting: visual overlays outperform coordinate grounding for
  GPT-4V-class models: <https://arxiv.org/abs/2310.11441>
- Process-reward guidance for vision-language agents at inference time:
  <https://arxiv.org/abs/2504.16073>

### Vision-token reduction

- FastV, pruning about half the visual tokens after shallow layers:
  <https://arxiv.org/abs/2403.06764>
- PyramidDrop, dropping redundant visual tokens with negligible loss:
  <https://openreview.net/forum?id=5ncdKonxd4>
- VScan, a training-free two-stage reduction:
  <https://arxiv.org/abs/2505.22654>
- A curated list (FastV, SparseVLM, VTW, TopV and others):
  <https://github.com/daixiangzi/awesome-token-compress>
- For API agents the practical equivalent is downscaling and JPEG encoding
  before upload, which the privacy path already did at 1280 px and the
  privacy-off path now does too.

## What v1.9.0 implemented

| Lever | Implementation | File |
|---|---|---|
| Reasoning effort | Decision turns send `reasoning_effort: "low"` to Moonshot-family hosts, `reasoning: {effort:"low", exclude:true}` on OpenRouter, and the de-facto `reasoning_effort` elsewhere. Strict endpoints that return 400 or 422 retry without it. Default `low`, overridable with `settings.vlmReasoningEffort`. | providers.js |
| Output-token minimization | `max_tokens: 800` for decisions, down from 2500, and the prompt requires a `thought` of at most 14 words and JSON only. Overridable with `settings.vlmMaxTokens`. | providers.js, privacy-agent.js |
| TTFT attribution | Streaming by default for kimi, deepseek, glm and custom endpoints, with `stream_options.include_usage`. Each turn logs TTFT, generation time, characters per second and output tokens, and warns when TTFT exceeds 30 s, which separates queue and reasoning burn from low throughput. | providers.js |
| Cache-friendly ordering | Prompt reordered so stable blocks (role, task, rules) come first and variable blocks (page, DOM, manifest, history) last. History is compacted to the last three full entries plus one-liners so the prefix stays byte-stable across steps. | privacy-agent.js, agent-context.js |
| Image diet | The privacy-off path now normalizes to a 1280 px JPEG at quality 0.85 in the service worker with OffscreenCanvas, matching the privacy path and cutting upload size by 5-10x. | privacy-agent.js |
| Multi-action planning | The decision JSON accepts an optional `queue` of up to two pre-authorized follow-up actions, executed with full verification and no further model calls, aborting at the first surprise. Validated by `planQueueActions()` for click, type, scroll, wait, media and press_key only. | agent-context.js, privacy-loop.js |
| Recovery without re-asking | When a playback click verifies as ineffective and a video element exists, even hidden, the loop runs the direct media command and records the result. | privacy-loop.js, agent-context.js |
| Failed-target memory | Dead click targets proven by verification are listed in the next prompt as forbidden repeats. | agent-context.js |
| Grounding hygiene | `domClick` text matching is scored: exact 100, word boundary 70, prefix 55, substring 35, with a short-label bonus. "play" can no longer select "New playlist". | actions.js |
| Media truthfulness | `domMediaControl` accepts hidden and zero-area videos, preferring visible ones. | actions.js |
| Start-URL fast path | "yt music" and "youtube music" open music.youtube.com directly. | sw.js |
| Capture resilience | An activeTab denial falls back to `chrome.debugger` `Page.captureScreenshot` with a fix-it hint. | privacy-agent.js |
| Runtime warmth | Privacy-on runs ping the offscreen runtime each step (`ML_TOUCH`) so its five-minute idle teardown cannot fire mid-run after a long model turn. | privacy-loop.js, offscreen.js |

### Expected effect on that field task

- With low reasoning, an 800-token cap and a shorter prompt, each remaining turn
  drops from 27-93 s to roughly 8-25 s on the same provider; the TTFT logs show
  it.
- The music fast path removes a turn, the working media action three, scored
  click matching two, and automatic recovery one: 12 steps become roughly 5 to
  7.
- Combined expectation for this class of task: 11 minutes down to 2-4 minutes,
  with any remaining slowness attributed in the console.

## Tuning

Settings, AI & Models, Behaviour, since v1.10.0:

- `settings.vlmSpeedProfile`: `fast`, `balanced` or `quality`.
- `settings.vlmReasoningEffort`: defaults to `low`.
- `settings.vlmMaxTokens`: 0 follows the profile.

If turns are still slow, the TTFT log says which fix applies. High TTFT means
switch model or route, for example an OpenRouter `:nitro` route, Moonshot
direct, or a faster model class such as kimi-k2-turbo, gemini-flash or
glm-4.5v-lite. Low TTFT with low characters per second means provider
throughput, so switch route rather than model.

The highest-ceiling follow-up is the Set-of-Marks overlay from the DOM scan
already running: it turns grounding from label guessing into ID selection, cuts
mis-clicks further, and lets the screenshot drop to about 896 px.

Screenshots-optional turns shipped in v1.10.0 as automatic shot reuse, below.

## v1.10.0: the same levers for every provider

v1.9.0 was validated against one endpoint. v1.10.0 makes each lever
provider-agnostic: the same three settings work on OpenAI, OpenRouter,
Moonshot/Kimi, DeepSeek, GLM, Qwen/DashScope, Together, Groq, Fireworks, vLLM,
Ollama and the on-device path, with no vendor-specific API or model family
required.

### Levers, by how portable they are

**Works everywhere, client-side only**

1. **Screenshot reuse on unchanged pages.** Before each capture the loop
   fingerprints the page (URL, title, scroll, media states, text hash). If
   nothing changed, the previous sanitized screenshot is reused: no capture, no
   sanitize, no upload, no extra image tokens, and the prompt stays
   byte-identical, so provider prompt caches hit. A playing video forces a fresh
   shot, privacy-mode changes invalidate the cache, and an age cap of 45-60 s
   plus a consecutive-reuse cap force periodic refresh.
2. **Image diet.** A JPEG at 896, 1280 or 1536 px longest edge depending on
   profile, on both paths: privacy-on through the pipeline `maxWidth`,
   privacy-off through OffscreenCanvas. Fewer vision tokens means faster
   prefill on every provider.
3. **Constant-size prompt.** History compacted to the last N full entries plus
   one-liners, DOM text capped, manifest capped. The prompt no longer grows with
   run length.
4. **Output-token minimization.** A terse JSON contract with a `thought` of at
   most 14 words, and a profile cap of 600, 800 or 1400 tokens.
5. **Fewer turns.** A speculative two-action queue, automatic media recovery,
   scored click matching, failed-target memory and site fast paths. Each avoided
   turn saves the whole turn.

**Auto-detected, with graceful fallback**

6. **A stable prompt prefix** for automatic context and KV caching. Rules and
   role first, variable page, DOM and history blocks last, byte-stable across
   steps. Moonshot, DeepSeek, OpenAI, Gemini through implicit caching, Anthropic
   through explicit `cache_control` and OpenRouter passthrough all bill cached
   prefixes cheaper and prefill them faster. Only ordering changes.
7. **A reasoning-effort hint, mapped per endpoint.** OpenRouter gets
   `reasoning: {effort, exclude:true}`; Moonshot/Kimi, OpenAI o-series and most
   OpenAI-compatible gateways get `reasoning_effort`; unknown gateways get the
   de-facto field; an empty value sends nothing. A 400 or 422 retries without
   the parameter, so strict endpoints degrade cleanly.
8. **Streaming with TTFT and throughput attribution.** SSE everywhere with
   `stream_options.include_usage`, and every turn logs TTFT and characters per
   second.

**Provider-specific, optional**

- OpenRouter: append `:nitro` to the model slug for a faster route.
- Moonshot direct: automatic context caching at `platform.kimi.ai`, no API
  change.
- DeepInfra, Together, Groq: pick the turbo or flash variant of the same model.
- Anthropic native: add `cache_control` breakpoints if routing Anthropic
  directly.
- On-device Gemma: profiles apply, and a smaller image means fewer vision tokens
  on your own GPU.

### Speed profiles

| Setting | fast | balanced (default) | quality |
|---|---|---|---|
| Screenshot long edge | 896 px | 1280 px | 1536 px |
| JPEG quality | 0.80 | 0.85 | 0.90 |
| DOM text cap | 2200 chars | 3500 chars | 6000 chars |
| Full-detail history entries | 2 | 3 | 5 |
| Decision max tokens | 600 | 800 | 1400 |
| Reasoning effort hint | low | low | medium |
| Manifest lines | 20 | 40 | 60 |
| Screenshot reuse | 45 s, streak 3 | 60 s, streak 2 | off |

Against the v1.8 field run on any provider, `fast` roughly halves image tokens,
holds the prompt near 2k characters, caps output at 600, captures nothing on
unchanged steps, and combines with the v1.9 loop fixes to bring the same
12-step task class into the 2-4 minute range.

### Provider notes

All are OpenAI-compatible unless stated.

| Provider | Reasoning control | Prompt caching | Fast-route tips |
|---|---|---|---|
| OpenAI | `reasoning_effort`, auto-mapped | Automatic, from 1024 tokens | A mini class model for speed |
| OpenRouter | `reasoning {effort, exclude}`, auto-mapped | Varies by backend | `:nitro` route suffix |
| Moonshot / Kimi | `reasoning_effort`, auto-mapped | Automatic context caching | kimi-k2-turbo class |
| DeepSeek | No effort setting; the reasoner always thinks | Automatic context caching | Use the non-reasoner chat model |
| GLM (Zhipu) | Thinking toggle | Prefix caching on GLM-4.5 and later | glm-4.5v-lite or the flash tier |
| Qwen (DashScope) | `enable_thinking: false` tolerated, ignored with a clean retry | Implicit prefix cache | qwen-vl-flash |
| Gemini (OpenAI-compatible) | Ignores effort with a clean retry | Implicit caching | gemini-flash class |
| Groq, Cerebras, SambaNova | Not applicable | Not applicable | Pick the fastest vision host |
| vLLM, Ollama, llama.cpp | Model-dependent, ignored cleanly | vLLM automatic prefix caching | Smaller quantisation and 896 px shots |
| On-device Gemma E2B | Not applicable | Not applicable | `fast` profile with q4f16 |

Every row is safe with default settings: unknown fields are either ignored or
hit the automatic 400/422 clean retry in the attempt ladder.
