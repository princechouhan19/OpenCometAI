// src/lib/providers.js
// One function per AI provider. All return parsed JSON objects.

import { parseJSON } from './utils.js';
import { SYSTEM_PROMPT } from './prompts.js';
import { callLocalAI, callLocalAIRaw, resolveLocalModel } from './local-llm.js';
import { createLogger, describeHttpError } from '../core/logger.js';

// Diagnostics: every AI request logs [API] start / latency / failure kind
// (auth · rate-limit · network · server …). warn+error also reach the
// sidepanel console via the DIAG_LOG relay.
const logAPI = createLogger('API', { relayType: 'DIAG_LOG', relayLevel: 'warn' });

// Capability registry
export function getProviderCapabilities(settings = {}) {
  const provider = String(settings.provider || 'openai').toLowerCase();
  const model    = String(settings.model    || '').trim();
  const ollamaTextModel = resolveOllamaTextModel(settings);
  const ollamaVisionModel = resolveOllamaVisionModel(settings);
  const customVision = Boolean(settings.providerSupportsVision);

  const registry = {
    openai:    { vision: true,  json: true, attachments: true,  browserAgentSafe: true,  defaultModel: 'gpt-4o' },
    anthropic: { vision: true,  json: true, attachments: true,  browserAgentSafe: true,  defaultModel: 'claude-sonnet-4-20250514' },
    gemini:    { vision: true,  json: true, attachments: true,  browserAgentSafe: true,  defaultModel: 'gemini-1.5-flash' },
    groq:      { vision: false, json: true, attachments: false, browserAgentSafe: false, defaultModel: 'llama-3.3-70b-versatile' },
    mistral:   {
      vision:           supportsMistralVision(model || 'mistral-small-2506'),
      json:             true,
      attachments:      true,
      browserAgentSafe: supportsMistralVision(model || 'mistral-small-2506'),
      defaultModel:     'mistral-small-2506',
    },
    ollama: {
      vision:           supportsOllamaVision(ollamaVisionModel || 'llava:7b'),
      json:             true,
      attachments:      true,
      browserAgentSafe: supportsOllamaVision(ollamaVisionModel || ollamaTextModel || 'llama3.2:3b'),
      defaultModel:     ollamaTextModel || 'llama3.2:3b',
    },
    deepseek: {
      vision:           false,
      json:             true,
      attachments:      false,
      browserAgentSafe: false,
      defaultModel:     'deepseek-chat',
    },
    kimi: {
      vision:           supportsModelVision(model || 'kimi-k3'),
      json:             true,
      attachments:      supportsModelVision(model || 'kimi-k3'),
      browserAgentSafe: supportsModelVision(model || 'kimi-k3'),
      defaultModel:     'kimi-k3',
    },
    glm: {
      vision:           supportsModelVision(model || 'glm-4.7'),
      json:             true,
      attachments:      supportsModelVision(model || 'glm-4.7'),
      browserAgentSafe: supportsModelVision(model || 'glm-4.7'),
      defaultModel:     'glm-4.7',
    },
    custom: {
      vision:           customVision || supportsModelVision(model || ''),
      json:             true,
      attachments:      customVision || supportsModelVision(model || ''),
      browserAgentSafe: customVision || supportsModelVision(model || ''),
      defaultModel:     model || '',
    },
    local: (() => {
      const lm = resolveLocalModel(settings);
      const vision = Boolean(lm?.vision);
      return {
        vision,
        json:             true,
        attachments:      vision,
        browserAgentSafe: vision || Boolean(lm?.nativeTools),
        defaultModel:     lm?.id || 'gemma-4-e2b',
      };
    })(),
  };

  return registry[provider] ?? { vision: false, json: false, attachments: false, browserAgentSafe: false, defaultModel: '' };
}

export function isProviderConfigured(settings = {}) {
  const provider = String(settings.provider || 'openai').toLowerCase();
  if (provider === 'ollama') {
    return Boolean(resolveOllamaBaseUrl(settings));
  }
  if (provider === 'local') {
    return Boolean(String(settings.localModelId || '').trim());
  }
  if (['deepseek', 'kimi', 'glm', 'custom'].includes(provider)) {
    return Boolean(String(resolveCompatibleBaseUrl(settings)).trim()) && Boolean(String(settings.apiKey || '').trim());
  }
  return Boolean(String(settings.apiKey || '').trim());
}

// Unified entry point
// Unified entry point. Every provider funnels through callAI / callAIRaw, so
// the prompt and the returned payload are logged here for all backends. Images
// are summarized (name · mime · KB), never dumped. The raw pre-parse model
// text is logged by the OpenAI-compatible reader (readCompatStream).
function logVlmRequest(tag, prompt, images, options = {}) {
  try {
    const imgs = Array.isArray(images) ? images : [];
    console.groupCollapsed(`[Open Comet][VLM-REQ] → ${tag} · prompt ${prompt?.length ?? 0} chars · ${imgs.length} image(s)`);
    console.log(prompt || '(empty prompt)');
    imgs.forEach((im, i) => console.log(`[image ${i + 1}] ${im?.name || 'image'} · ${im?.mimeType || '?'} · ${(String(im?.imageBase64 || '').length / 1024).toFixed(1)} KB base64 (pixels not printed)`));
    if (options.maxTokens) console.log(`maxTokens=${options.maxTokens}${options.reasoningEffort ? ` · reasoningEffort=${options.reasoningEffort}` : ''}`);
    console.groupEnd();
  } catch { /* logging must never break the call */ }
}
function logVlmResponse(tag, out, ms) {
  try {
    console.groupCollapsed(`[Open Comet][VLM-RES] ← ${tag} · ${ms}ms`);
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
    console.groupEnd();
  } catch { /* logging must never break the call */ }
}
function logVlmRawText(tag, content) {
  try {
    console.groupCollapsed(`[Open Comet][VLM-RAW] ← ${tag} · ${String(content || '').length} chars (model text before JSON parsing)`);
    console.log(content || '(empty)');
    console.groupEnd();
  } catch { /* logging must never break the call */ }
}

export async function callAI(settings, prompt, screenshotBase64 = null, options = {}) {
  const { provider, apiKey, model } = settings;
  const caps   = getProviderCapabilities(settings);
  const hasImageIntent = Boolean(screenshotBase64) || Boolean((options.images || []).length);
  const targetModel = provider === 'ollama'
    ? resolveOllamaModel(settings, hasImageIntent)
    : (model || caps.defaultModel);
  const images = caps.vision
    ? await buildImageInputs(screenshotBase64, options.images || [], { provider, model: targetModel || caps.defaultModel })
    : [];

  const t0 = Date.now();
  const tag = `${provider}/${targetModel || caps.defaultModel || '?'}`;
  logAPI.info(`→ ${tag} · prompt=${prompt?.length ?? 0}c${hasImageIntent ? ' · image' : ''}`);
  logVlmRequest(tag, prompt, images, options);
  try {
    const out = await dispatchAI();
    logAPI.info(`✓ ${tag} · ${Date.now() - t0}ms`);
    logVlmResponse(tag, out, Date.now() - t0);
    return out;
  } catch (err) {
    logAPI.error(`✗ ${tag} · ${Date.now() - t0}ms · ${describeHttpError(err)} · ${String(err?.message || err).slice(0, 220)}`);
    throw err;
  }

  async function dispatchAI() {
  switch (provider) {
    case 'anthropic': return callAnthropic(apiKey, targetModel || caps.defaultModel, prompt, images, options);
    case 'openai':    return callOpenAI   (apiKey, targetModel || caps.defaultModel, prompt, images, options);
    case 'gemini':    return callGemini   (apiKey, targetModel || caps.defaultModel, prompt, images, options);
    case 'groq':      return callGroq     (apiKey, targetModel || caps.defaultModel, prompt, options);
    case 'mistral':   return callMistral  (apiKey, targetModel || caps.defaultModel, prompt, selectMistralImages(images), options);
    case 'deepseek':
    case 'kimi':
    case 'glm':
    case 'custom':    return callOpenAICompatible(settings, targetModel || caps.defaultModel, prompt, images, options);
    case 'ollama':    return callOllama   (settings, targetModel || caps.defaultModel, prompt, images, options);
    case 'local':     return callLocalAI  (settings, prompt, images, options);
    default:          throw new Error(`Unknown provider: ${provider}`);
  }
  }
}

/**
 * Raw text variant — returns the AI's response as a plain string instead of
 * parsed JSON. Used for prose responses (e.g. research report synthesis).
 */
export async function callAIRaw(settings, prompt, options = {}) {
  const { provider, apiKey, model } = settings;
  const caps = getProviderCapabilities(settings);
  const m    = provider === 'ollama'
    ? resolveOllamaTextModel(settings)
    : (model || caps.defaultModel);

  const t0 = Date.now();
  const tag = `${provider}/${m || caps.defaultModel || '?'}`;
  logAPI.info(`→ ${tag} · prompt=${prompt?.length ?? 0}c (raw)`);
  logVlmRequest(tag, prompt, [], options);
  try {
    const out = await dispatchRaw();
    logAPI.info(`✓ ${tag} · ${Date.now() - t0}ms (raw)`);
    logVlmResponse(tag, out, Date.now() - t0);
    return out;
  } catch (err) {
    logAPI.error(`✗ ${tag} · ${Date.now() - t0}ms · ${describeHttpError(err)} · ${String(err?.message || err).slice(0, 220)}`);
    throw err;
  }

  async function dispatchRaw() {
  switch (provider) {
    case 'openai':
    case 'groq': {
      const url = provider === 'openai'
        ? 'https://api.openai.com/v1/chat/completions'
        : 'https://api.groq.com/openai/v1/chat/completions';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({
          model: m,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 4000,
        }),
      });
      await assertOk(res, provider);
      const data = await res.json();
      if (options.onUsage && data.usage) {
        options.onUsage({
          model: m,
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        });
      }
      return data.choices?.[0]?.message?.content || '';
    }
    case 'anthropic': {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: m,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 4000,
        }),
      });
      await assertOk(res, 'Anthropic');
      const data = await res.json();
      if (options.onUsage && data.usage) {
        options.onUsage({
          model: m,
          promptTokens: data.usage.input_tokens,
          completionTokens: data.usage.output_tokens,
          totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
        });
      }
      return data.content?.[0]?.text || '';
    }
    case 'gemini': {
      const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + m + ':generateContent?key=' + apiKey,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 4000 },
          }),
        }
      );
      await assertOk(res, 'Gemini');
      const data = await res.json();
      if (options.onUsage && data.usageMetadata) {
        options.onUsage({
          model: m,
          promptTokens: data.usageMetadata.promptTokenCount,
          completionTokens: data.usageMetadata.candidatesTokenCount,
          totalTokens: data.usageMetadata.totalTokenCount,
        });
      }
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }
    case 'mistral': {
      const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({
          model: m,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 4000,
        }),
      });
      await assertOk(res, 'Mistral');
      const data = await res.json();
      if (options.onUsage && data.usage) {
        options.onUsage({
          model: m,
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        });
      }
      return data.choices?.[0]?.message?.content || '';
    }
    case 'deepseek':
    case 'kimi':
    case 'glm':
    case 'custom': {
      const res = await fetch(resolveCompatibleBaseUrl(settings) + '/chat/completions', {
        method: 'POST',
        headers: buildCompatibleHeaders(settings),
        body: JSON.stringify({
          model: m,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 4000,
        }),
      });
      await assertOk(res, providerLabel(provider));
      const data = await res.json();
      if (options.onUsage && data.usage) {
        options.onUsage({
          model: m,
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        });
      }
      return data.choices?.[0]?.message?.content || '';
    }
    case 'ollama': {
      const res = await fetch(resolveOllamaBaseUrl(settings) + '/v1/chat/completions', {
        method: 'POST',
        headers: buildOllamaHeaders(settings),
        body: JSON.stringify({
          model: m,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 4000,
        }),
      });
      await assertOk(res, 'Ollama');
      const data = await res.json();
      if (options.onUsage && data.prompt_eval_count) {
        options.onUsage({
          model: m,
          promptTokens: data.prompt_eval_count,
          completionTokens: data.eval_count,
          totalTokens: data.prompt_eval_count + (data.eval_count || 0),
        });
      }
      return data.choices?.[0]?.message?.content || '';
    }
    case 'local':
      return callLocalAIRaw(settings, prompt, options);
    default:
      throw new Error('Unknown provider: ' + provider);
  }
  }
}


// Anthropic
async function callAnthropic(apiKey, model, prompt, images, options = {}) {
  const content = [
    ...images.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: normalizeMime(img.mimeType), data: sanitizeB64(img.imageBase64) },
    })),
    { type: 'text', text: prompt },
  ];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'x-api-key':     apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      system:    SYSTEM_PROMPT,
      messages:  [{ role: 'user', content }],
      max_tokens: 2500,
    }),
  });
  await assertOk(res, 'Anthropic');
  const data = await res.json();
  if (options.onUsage && data.usage) {
    options.onUsage({
      model,
      promptTokens: data.usage.input_tokens,
      completionTokens: data.usage.output_tokens,
      totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
    });
  }
  return parseJSON(data.content?.[0]?.text);
}

// OpenAI
async function callOpenAI(apiKey, model, prompt, images, options = {}) {
  const userContent = [
    ...images.map(img => ({
      type: 'image_url',
      image_url: { url: `data:${normalizeMime(img.mimeType)};base64,${sanitizeB64(img.imageBase64)}`, detail: 'high' },
    })),
    { type: 'text', text: prompt },
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userContent },
      ],
      temperature:     0.1,
      max_tokens:      2500,
      response_format: { type: 'json_object' },
    }),
  });
  await assertOk(res, 'OpenAI');
  const data = await res.json();
  if (options.onUsage && data.usage) {
    options.onUsage({
      model,
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    });
  }
  return parseJSON(data.choices?.[0]?.message?.content);
}

// Gemini
async function callGemini(apiKey, model, prompt, images, options = {}) {
  const parts = [
    ...images.map(img => ({
      inlineData: { mimeType: normalizeMime(img.mimeType), data: sanitizeB64(img.imageBase64) },
    })),
    { text: prompt },
  ];

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents:          [{ role: 'user', parts }],
        generationConfig:  { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 2500 },
      }),
    }
  );
  await assertOk(res, 'Gemini');
  const data = await res.json();
  if (options.onUsage && data.usageMetadata) {
    options.onUsage({
      model,
      promptTokens: data.usageMetadata.promptTokenCount,
      completionTokens: data.usageMetadata.candidatesTokenCount,
      totalTokens: data.usageMetadata.totalTokenCount,
    });
  }
  return parseJSON(data.candidates?.[0]?.content?.parts?.[0]?.text);
}

// Groq
async function callGroq(apiKey, model, prompt, options = {}) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: prompt },
      ],
      temperature:     0.1,
      max_tokens:      2500,
      response_format: { type: 'json_object' },
    }),
  });
  await assertOk(res, 'Groq');
  const data = await res.json();
  if (options.onUsage && data.usage) {
    options.onUsage({
      model,
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    });
  }
  return parseJSON(data.choices?.[0]?.message?.content);
}

// Mistral
async function callMistral(apiKey, model, prompt, images, options = {}) {
  // Attempt with images first; fall back to text-only if the provider rejects images
  const attempts = dedupeMistralAttempts([
    { label: 'vision', images: supportsMistralVision(model) ? images : [] },
    { label: 'text',   images: [] },
  ]);

  let lastError;
  for (const attempt of attempts) {
    try {
      const content = buildMistralContent(prompt, attempt.images);
      const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content },
          ],
          temperature:     0.1,
          max_tokens:      2500,
          response_format: { type: 'json_object' },
        }),
      });
      await assertOk(res, 'Mistral');
      const data = await res.json();
      if (options.onUsage && data.usage) {
        options.onUsage({
          model,
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        });
      }
      return parseJSON(data.choices?.[0]?.message?.content);
    } catch (err) {
      lastError = err;
      // If the error looks related to vision/images and we have other attempts remaining, continue.
      if (attempt.label === 'vision' && isRecoverableMistralImageError(err)) {
        console.warn(`[Open Comet] Mistral vision attempt failed, falling back to ${attempts[attempts.indexOf(attempt) + 1]?.label || 'next'}:`, err.message);
        continue;
      }
      break; 
    }
  }
  throw lastError || new Error('Mistral request failed completely');
}

async function callOllama(settings, model, prompt, images, options = {}) {
  const jsonHint = `${prompt}\n\nReturn only a valid JSON object.`;
  const attempts = dedupeOllamaAttempts([
    {
      label: 'json-mode',
      body: {
        model,
        messages: buildOllamaMessages(prompt, images),
        temperature: 0.1,
        max_tokens: 2500,
        response_format: { type: 'json_object' },
      },
    },
    {
      label: 'prompt-json',
      body: {
        model,
        messages: buildOllamaMessages(jsonHint, images),
        temperature: 0.1,
        max_tokens: 2500,
      },
    },
    (images || []).length ? {
      label: 'text-only-json',
      body: {
        model,
        messages: buildOllamaMessages(jsonHint, []),
        temperature: 0.1,
        max_tokens: 2500,
      },
    } : null,
  ]);

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const res = await fetch(resolveOllamaBaseUrl(settings) + '/v1/chat/completions', {
        method: 'POST',
        headers: buildOllamaHeaders(settings),
        body: JSON.stringify(attempt.body),
      });
      await assertOk(res, 'Ollama');
      const data = await res.json();
      if (options.onUsage && data.prompt_eval_count) {
        options.onUsage({
          model,
          promptTokens: data.prompt_eval_count,
          completionTokens: data.eval_count,
          totalTokens: data.prompt_eval_count + (data.eval_count || 0),
        });
      }
      return parseJSON(data.choices?.[0]?.message?.content);
    } catch (err) {
      lastError = err;
      if (isRecoverableOllamaCompatError(err)) continue;
      break;
    }
  }

  throw lastError ?? new Error('Ollama request failed');
}

// OpenAI-compatible providers (kimi / deepseek / glm / custom)
// Reasoning effort is provider-specific: Kimi takes a top-level
// `reasoning_effort`, OpenRouter normalizes it as `reasoning: { effort, exclude }`.
// Streaming gives the TTFT vs generation-rate split, so a slow turn is
// attributable (queue / reasoning burn vs throughput).

// Guards for gateways hosting thinking models. A request can return 200 OK
// with zero visible text: the model spends minutes on invisible reasoning and
// either hits the token cap or holds the stream open without emitting
// anything (observed 290s on qwen3-vl-235b-a22b-thinking). These limits make
// that recoverable instead of a silent hang.
const STREAM_IDLE_MS = 45000;      // wire silence before an attempt is written off
const ATTEMPT_TIMEOUT_MS = 150000; // hard cap per attempt, headers + body
const TOTAL_TIMEOUT_MS = 300000;   // cap for the whole ladder

// Escalations applied to a rung when it comes back empty/stalled: double the
// token budget (room for reasoning + answer), then disable thinking, then
// fall through to the next rung (non-streaming last).
const ESCALATIONS = [null, { budget: 2 }, { budget: 2, thinkOff: true }];

function isAbortError(err) {
  return err?.name === 'AbortError' || /abort/i.test(String(err?.message || ''));
}

function attemptTag(a, esc) {
  const base = attemptKey(a);
  return esc ? `${base}·x${esc.budget || 1}${esc.thinkOff ? '-nothink' : ''}` : base;
}

function emptyResponseHint(model) {
  return /thinking/i.test(String(model))
    ? 'Thinking models burn tokens on invisible reasoning — the -instruct variant of the same model typically answers in a few seconds. '
    : '';
}

/** Build provider-appropriate reasoning params. Exported for unit tests. */
export function buildReasoningParam(baseUrl, effort) {
  if (!effort) return null;
  let host = '';
  try { host = new URL(String(baseUrl)).hostname || ''; } catch { return null; }
  if (/openrouter\.ai$/i.test(host)) {
    return { reasoning: { effort: String(effort), exclude: true } };
  }
  if (/(^|\.)moonshot\.(ai|cn)$/i.test(host) || /(^|\.)kimi\.ai$/i.test(host) || /moonshot\.cn$/i.test(host)) {
    return { reasoning_effort: String(effort) };
  }
  // Unknown gateway: `reasoning_effort` is the de-facto standard (OpenAI
  // o-series + Moonshot share the name). callOpenAICompatible strips and
  // retries automatically if a strict server rejects it.
  return { reasoning_effort: String(effort) };
}

function buildCompatMessages(prompt, images) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: images?.length
        ? [
            ...images.map(img => ({
              type: 'image_url',
              image_url: { url: `data:${normalizeMime(img.mimeType)};base64,${sanitizeB64(img.imageBase64)}` },
            })),
            { type: 'text', text: prompt },
          ]
        : prompt,
    },
  ];
}

/** Parse one SSE buffer slice → { events, rest }. Exported for unit tests. */
export function consumeSSEChunk(buffer) {
  const events = [];
  let rest = buffer;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).replace(/\r$/, '');
    buffer = buffer.slice(idx + 1);
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') { if (payload === '[DONE]') events.push({ done: true }); continue; }
    try { events.push(JSON.parse(payload)); } catch { /* partial JSON — skip line */ }
  }
  rest = buffer;
  return { events, rest };
}

function attemptKey(a) {
  return `s${a.stream ? 1 : 0}r${a.reasoning ? 1 : 0}j${a.jsonMode ? 1 : 0}`;
}

/**
 * Streaming/non-streaming OpenAI-compatible chat call.
 *
 * Rungs, fastest first: stream+json+reasoning → stream+json → stream →
 * non-stream. A 400/422 moves down the ladder (gateway rejected a param).
 * A 200 with no usable text escalates the rung in place: 2x token budget,
 * then thinking off, then the next rung. Auth/rate/network errors throw.
 * Hard caps: ATTEMPT_TIMEOUT_MS per attempt, TOTAL_TIMEOUT_MS for everything.
 */
async function callOpenAICompatible(settings, model, prompt, images, options = {}) {
  const base = resolveCompatibleBaseUrl(settings);
  const url = base + '/chat/completions';
  const messages = buildCompatMessages(prompt, images);
  const maxTokens = Number.isFinite(Number(options.maxTokens)) && Number(options.maxTokens) >= 64
    ? Math.min(8000, Math.round(Number(options.maxTokens)))
    : 2500;
  const reasoning = buildReasoningParam(base, options.reasoningEffort);
  const wantStream = options.stream !== false;   // default: streaming ON
  const tag = `${providerLabel(settings.provider)}/${model}`;

  const attempts = [];
  if (wantStream) {
    if (reasoning) attempts.push({ stream: true, jsonMode: true, reasoning });
    attempts.push({ stream: true, jsonMode: true });
    attempts.push({ stream: true, jsonMode: false });
  } else if (reasoning) {
    attempts.push({ stream: false, jsonMode: true, reasoning });
  }
  attempts.push({ stream: false, jsonMode: false });

  // Timeouts are overridable via options so unit tests can run the ladder fast.
  const idleMs = Number(options.streamIdleMs) >= 0 ? Number(options.streamIdleMs) : STREAM_IDLE_MS;
  const attemptMs = Number(options.attemptTimeoutMs) > 0 ? Number(options.attemptTimeoutMs) : ATTEMPT_TIMEOUT_MS;
  const totalMs = Number(options.totalTimeoutMs) > 0 ? Number(options.totalTimeoutMs) : TOTAL_TIMEOUT_MS;
  const deadline = Date.now() + totalMs;
  const canEscalate = (esc, i) =>
    ESCALATIONS.indexOf(esc) < ESCALATIONS.length - 1 || i < attempts.length - 1;
  let lastErr = null;

  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];

    for (const esc of ESCALATIONS) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`${tag} · gave up after ${totalMs / 1000}s total${lastErr ? ` — last error: ${lastErr.message}` : ''}`);
      }

      const budget = Math.min(16000, Math.round(maxTokens * (esc?.budget ?? 1)));
      const body = {
        model,
        messages,
        temperature: 0.1,
        max_tokens: budget,
        stream: a.stream,
      };
      if (a.jsonMode) body.response_format = { type: 'json_object' };
      if (a.stream) body.stream_options = { include_usage: true };
      Object.assign(body, a.reasoning || {});
      // Two spellings: vLLM reads chat_template_kwargs, DashScope-style
      // gateways read the top-level flag. Gateways that reject unknown
      // fields land in the 400/422 handler below.
      if (esc?.thinkOff) Object.assign(body, { enable_thinking: false, chat_template_kwargs: { enable_thinking: false } });

      const ctrl = new AbortController();
      const attemptTimer = setTimeout(() => {
        const err = new Error(`no completion within ${Math.round(Math.min(attemptMs, remaining) / 1000)}s`);
        err.name = 'AbortError';
        ctrl.abort(err);
      }, Math.min(attemptMs, remaining));

      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: buildCompatibleHeaders(settings),
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (err) {
        lastErr = err;
        if (isAbortError(err) && canEscalate(esc, i)) {
          logAPI.warn(`⏱ ${tag} · ${attemptTag(a, esc)} · ${describeHttpError(err)} — escalating`);
          continue; // server never answered; another rung may still make it
        }
        throw err; // network failure — retries with different params won't help
      }

      try {
        if (!res.ok) {
          let errText = '';
          try { errText = (await res.text()).slice(0, 400); } catch {}
          lastErr = new Error(`${providerLabel(settings.provider)} ${res.status}${errText ? ': ' + errText : ''}`);
          if ((res.status === 400 || res.status === 422) && i < attempts.length - 1) {
            logAPI.warn(`${providerLabel(settings.provider)} ${res.status} (${describeHttpError(lastErr)}) on ${attemptTag(a, esc)} — retrying with ${attemptTag(attempts[i + 1], null)}`);
            break; // next rung
          }
          throw lastErr;
        }

        if (a.stream) {
          const out = await readCompatStream(res, { tag, attempt: attemptTag(a, esc), maxTokens: budget, idleMs });
          if (options.onUsage && out.usage) {
            options.onUsage({
              model,
              promptTokens: out.usage.prompt_tokens,
              completionTokens: out.usage.completion_tokens ?? out.usage.completionTokens,
              totalTokens: out.usage.total_tokens,
            });
          }
          if (!String(out.content || '').trim()) {
            lastErr = new Error(`Empty response from model (finish=${out.finishReason || 'unknown'})`);
            if (canEscalate(esc, i)) {
              logAPI.warn(`✗ ${tag} · ${attemptTag(a, esc)} · 200 OK but no text${out.finishReason === 'length' ? ` — hit the ${budget}-token cap` : ''}. ${emptyResponseHint(model)}Escalating.`);
              continue;
            }
            throw lastErr;
          }
          if (out.finishReason === 'length') {
            logAPI.warn(`Output hit the ${budget}-token cap — response may be truncated. Raise vlm maxTokens if JSON parsing starts failing.`);
          }
          logVlmRawText(tag, out.content);
          return parseJSON(out.content);
        }

        const t1 = Date.now();
        const data = await res.json();
        logAPI.info(`✓ ${tag} · non-stream · ${Date.now() - t1}ms${a.reasoning ? ' · reasoning' : ''}`);
        if (options.onUsage && data.usage) {
          options.onUsage({
            model,
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          });
        }
        const rawContent = data.choices?.[0]?.message?.content;
        if (!String(rawContent || '').trim()) {
          lastErr = new Error(`Empty response from model (finish=${data.choices?.[0]?.finish_reason || 'unknown'})`);
          if (canEscalate(esc, i)) {
            logAPI.warn(`✗ ${tag} · ${attemptTag(a, esc)} · 200 OK but no text. ${emptyResponseHint(model)}Escalating.`);
            continue;
          }
          throw lastErr;
        }
        logVlmRawText(tag, rawContent);
        return parseJSON(rawContent);
      } catch (err) {
        if (isAbortError(err) && canEscalate(esc, i)) {
          lastErr = err;
          logAPI.warn(`⏱ ${tag} · ${attemptTag(a, esc)} · ${describeHttpError(err)} — escalating`);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(attemptTimer);
      }
    }
  }

  throw lastErr ?? new Error('OpenAI-compatible request failed');
}


/**
 * Read an OpenAI-compatible SSE stream. Logs TTFT (first token) and total
 * wall time so slow VLM turns are attributable: TTFT far above the
 * generation rate means queue / reasoning burn; low chars/sec after TTFT
 * means provider throughput. A stream silent for idleMs is aborted so the
 * caller can escalate.
 */
async function readCompatStream(res, { tag, attempt, maxTokens, idleMs = STREAM_IDLE_MS }) {
  const t0 = Date.now();
  let ttftMs = null;
  let content = '';
  let usage = null;
  let finishReason = null;
  let buffer = '';
  const reader = res.body?.getReader?.();
  if (!reader) {
    // No stream body (odd gateway) → treat as non-stream JSON.
    const data = await res.json().catch(() => ({}));
    return { content: data.choices?.[0]?.message?.content || '', usage: data.usage || null, finishReason: data.choices?.[0]?.finish_reason || null, ttftMs: null };
  }
  const decoder = new TextDecoder();

  let fireIdle;
  const idle = new Promise((_, reject) => {
    fireIdle = () => {
      const err = new Error(`stream idle > ${Math.round(idleMs / 1000)}s`);
      err.name = 'AbortError'; // treat like a timeout: the caller escalates
      reject(err);
    };
  });
  let idleTimer = setTimeout(fireIdle, idleMs);
  const bumpIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(fireIdle, idleMs);
  };

  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), idle]);
      bumpIdle();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = consumeSSEChunk(buffer);
      buffer = rest;
      for (const ev of events) {
        if (ev.done) continue;
        if (ev.usage) usage = ev.usage;
        const ch = ev.choices?.[0];
        if (!ch) continue;
        if (ch.finish_reason) finishReason = ch.finish_reason;
        const delta = ch.delta?.content ?? ch.message?.content ?? '';
        if (delta) {
          if (ttftMs === null) {
            ttftMs = Date.now() - t0;
            logAPI.info(`⚡ ${tag} · TTFT ${ttftMs}ms [${attempt}] — prefill+reasoning done, generating…`);
            if (ttftMs > 30000) {
              logAPI.warn(`TTFT ${ttftMs}ms is very high — provider queue or reasoning burn. A low-reasoning model or a faster route cuts this dramatically.`);
            }
          }
          content += delta;
        }
      }
    }
  } catch (err) {
    if (!content) {
      try { reader.cancel(); } catch {}
      throw err; // nothing usable — caller escalates
    }
    logAPI.warn(`Stream interrupted after ${content.length} chars (${err?.message || err}) — using partial content`);
  } finally {
    clearTimeout(idleTimer);
  }
  const total = Date.now() - t0;
  const genMs = Math.max(0, total - (ttftMs ?? 0));
  const rate = genMs > 0 ? Math.round(content.length / (genMs / 1000)) : content.length;
  logAPI.info(`✓ ${tag} · total ${total}ms · TTFT ${ttftMs ?? '-'}ms · gen ${genMs}ms · ${content.length} chars (~${rate} c/s)${usage?.completion_tokens ? ` · out=${usage.completion_tokens}tok` : ''}${finishReason && finishReason !== 'stop' ? ` · finish=${finishReason}${finishReason === 'length' ? ` (cap ${maxTokens})` : ''}` : ''}`);
  return { content, usage, finishReason, ttftMs };
}

// Image helpers
async function buildImageInputs(screenshotBase64, extraImages = [], options = {}) {
  const list = [];
  if (screenshotBase64) {
    list.push({ mimeType: 'image/jpeg', imageBase64: sanitizeB64(screenshotBase64), name: 'browser-screenshot' });
  }
  for (const img of (extraImages || []).slice(0, 3)) {
    if (img?.imageBase64) {
      list.push({ mimeType: normalizeMime(img.mimeType), imageBase64: sanitizeB64(img.imageBase64), name: img.name || 'attachment' });
    }
  }
  const filtered = list.filter(img => img.imageBase64);
  if (String(options.provider || '').toLowerCase() !== 'mistral') return filtered;
  return await optimizeMistralImages(filtered);
}

function selectMistralImages(images) {
  const list = (images || []).filter(img => img?.imageBase64);
  if (!list.length) return [];
  const selected = list.find(img => img.name === 'browser-screenshot') ?? list[0];
  if (!selected?.imageBase64 || selected.imageBase64.length > MAX_MISTRAL_IMAGE_B64) return [];
  return [selected];
}

function buildMistralContent(prompt, images) {
  if (!(images || []).length) return prompt;
  return [
    ...(images || []).map(img => ({
      type: 'image_url',
      image_url: `data:${normalizeMime(img.mimeType)};base64,${sanitizeB64(img.imageBase64)}`,
    })),
    { type: 'text', text: prompt },
  ];
}

function dedupeMistralAttempts(attempts) {
  const seen = new Set();
  return attempts.filter(attempt => {
    const sig = JSON.stringify((attempt.images || []).map(img => `${img.name}:${img.imageBase64?.slice(0, 32) || ''}`));
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

function buildOllamaMessages(prompt, images = []) {
  const validImages = (images || []).filter(img => img?.imageBase64);
  const userContent = validImages.length
    ? [
        ...validImages.map(img => ({
          type: 'image_url',
          image_url: { url: `data:${normalizeMime(img.mimeType)};base64,${sanitizeB64(img.imageBase64)}` },
        })),
        { type: 'text', text: prompt },
      ]
    : prompt;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
}

function dedupeOllamaAttempts(attempts) {
  const seen = new Set();
  return (attempts || []).filter(Boolean).filter(attempt => {
    const sig = JSON.stringify(attempt.body);
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

// Misc helpers
function supportsMistralVision(model) {
  const lower = String(model || '').toLowerCase();
  return ['mistral-large', 'mistral-medium', 'mistral-small', 'ministral', 'pixtral', 'vision']
    .some(kw => lower.includes(kw));
}

function supportsOllamaVision(model) {
  const lower = String(model || '').toLowerCase();
  return ['llava', 'bakllava', 'vision', 'qwen2.5vl', 'qwen2-vl', 'gemma3', 'minicpm-v', 'moondream']
    .some(kw => lower.includes(kw));
}

function supportsModelVision(model) {
  const lower = String(model || '').toLowerCase();
  return ['vision', 'vl', '4o', 'omni', 'gemini', 'pixtral', 'llava', 'qwen2.5vl', 'qwen2-vl', 'gemma3', 'glm-4.5v', 'glm-4.1v', 'moonshot-v']
    .some(kw => lower.includes(kw));
}

function resolveOllamaTextModel(settings = {}) {
  return String(settings.ollamaTextModel || settings.model || 'llama3.2:3b').trim();
}

function resolveOllamaVisionModel(settings = {}) {
  return String(settings.ollamaVisionModel || settings.model || '').trim();
}

function resolveOllamaModel(settings = {}, wantsVision = false) {
  const visionModel = resolveOllamaVisionModel(settings);
  const textModel = resolveOllamaTextModel(settings);
  if (wantsVision) return visionModel || textModel;
  return textModel || visionModel;
}

function resolveOllamaBaseUrl(settings = {}) {
  return String(settings.ollamaBaseUrl || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
}

function buildOllamaHeaders(settings = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const apiKey = String(settings.apiKey || '').trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function resolveCompatibleBaseUrl(settings = {}) {
  const provider = String(settings.provider || '').toLowerCase();
  let custom = String(settings.providerBaseUrl || '').trim().replace(/\/+$/, '');

  if (custom) {
    // Handle cases where the user pasted a full endpoint
    custom = custom.replace(/\/+(chat\/)?completions$/, '');
    
    // If it doesn't end in /v1 or /v4 and it's just a base domain/port, 
    // it's usually safer to append /v1 for "compatible" mode, 
    // as most local or specialty providers expect it.
    if (!custom.toLowerCase().endsWith('/v1') && 
        !custom.toLowerCase().endsWith('/v4') && 
        !custom.toLowerCase().includes('/api/')) {
      custom = `${custom}/v1`;
    }
    return custom;
  }

  switch (provider) {
    case 'deepseek': return 'https://api.deepseek.com/v1';
    case 'kimi':     return 'https://api.moonshot.ai/v1';
    case 'glm':      return 'https://open.bigmodel.cn/api/paas/v4';
    default:         return '';
  }
}

function buildCompatibleHeaders(settings = {}) {
  const apiKey = String(settings.apiKey || '').trim();
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };

  return headers;
}

function providerLabel(provider) {
  const key = String(provider || '').toLowerCase();
  return ({
    deepseek: 'DeepSeek',
    kimi: 'Kimi',
    glm: 'GLM',
    custom: 'OpenAI Compatible',
    ollama: 'Ollama',
    mistral: 'Mistral',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    gemini: 'Gemini',
    groq: 'Groq',
  })[key] || String(provider || 'Provider');
}

function isRecoverableMistralImageError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('unable to download all specified images') || 
         msg.includes('prompt contains') ||
         msg.includes('context length') ||
         msg.includes('image') || 
         msg.includes('400'); // Often vision-rejections are 400s
}

function isRecoverableOllamaCompatError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('response_format') ||
         msg.includes('json_object') ||
         msg.includes('image_url') ||
         msg.includes('content') ||
         msg.includes('vision') ||
         msg.includes('multimodal') ||
         msg.includes('unsupported') ||
         msg.includes('invalid format') ||
         msg.includes('400');
}

const MAX_MISTRAL_IMAGE_B64 = 32000;

async function optimizeMistralImages(images) {
  const out = [];
  for (const image of (images || [])) {
    const optimized = await optimizeMistralImage(image);
    if (optimized?.imageBase64) out.push(optimized);
  }
  return out;
}

async function optimizeMistralImage(image) {
  if (!image?.imageBase64) return image;
  const clean = sanitizeB64(image.imageBase64);
  if (clean.length <= MAX_MISTRAL_IMAGE_B64) {
    return { ...image, imageBase64: clean };
  }

  if (!globalThis.fetch || !globalThis.createImageBitmap || !globalThis.OffscreenCanvas) {
    return { ...image, imageBase64: clean };
  }

  try {
    const inputUrl  = `data:${normalizeMime(image.mimeType)};base64,${clean}`;
    const inputBlob = await fetch(inputUrl).then(res => res.blob());
    const bitmap    = await createImageBitmap(inputBlob);

    const dimensionSteps = [768, 640, 512, 448, 384, 320];
    const qualitySteps   = [0.4, 0.3, 0.22, 0.16];
    let bestBase64 = clean;

    for (const maxDim of dimensionSteps) {
      const scale = Math.min(1, maxDim / Math.max(bitmap.width || 1, bitmap.height || 1));
      const width = Math.max(1, Math.round((bitmap.width || 1) * scale));
      const height = Math.max(1, Math.round((bitmap.height || 1) * scale));
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) continue;

      ctx.drawImage(bitmap, 0, 0, width, height);

      for (const quality of qualitySteps) {
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
        const base64 = await blobToBase64(blob);
        if (base64.length < bestBase64.length) bestBase64 = base64;
        if (base64.length <= MAX_MISTRAL_IMAGE_B64) {
          bitmap.close?.();
          return { ...image, mimeType: 'image/jpeg', imageBase64: base64 };
        }
      }
    }

    bitmap.close?.();
    return { ...image, mimeType: 'image/jpeg', imageBase64: bestBase64 };
  } catch {
    return { ...image, imageBase64: clean };
  }
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function normalizeMime(mimeType) {
  const v = String(mimeType || '').toLowerCase();
  if (v.includes('png'))  return 'image/png';
  if (v.includes('webp')) return 'image/webp';
  if (v.includes('gif'))  return 'image/gif';
  if (v.includes('jpg') || v.includes('jpeg')) return 'image/jpeg';
  return 'image/jpeg';
}

function sanitizeB64(value) {
  let s = String(value || '').replace(/\s+/g, '');
  // Strip any existing data URL prefix to prevent nesting (e.g. data:data:...)
  if (s.startsWith('data:image')) {
    const commaIndex = s.indexOf(',');
    if (commaIndex !== -1) s = s.substring(commaIndex + 1);
  }
  return s;
}

async function assertOk(res, label) {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} ${res.status}: ${body.substring(0, 300)}`);
  }
}
