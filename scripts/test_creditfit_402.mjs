#!/usr/bin/env node
// Regression harness: 402 credit-fit refit in callOpenAICompatible.
// Scenario: OpenRouter rejects max_tokens=800 with "can only afford 544".
// Expected: one same-rung retry with max_tokens=462, result parses;
// caps below the minimum fail with a top-up hint; the ladder still works.
import { callOpenAICompatible } from '../src/lib/providers.js';

const settings = {
  provider: 'custom',
  providerBaseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-test',
  model: 'qwen/qwen3-vl-235b-a22b-instruct',
};

const opts = { streamIdleMs: 500, attemptTimeoutMs: 2000, totalTimeoutMs: 8000 };
const calls = [];
const realFetch = globalThis.fetch;

function sse(content, finish = 'stop') {
  const events = [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}`,
    'data: [DONE]',
    '',
  ];
  return events.join('\n\n');
}

function okStream(content) {
  return new Response(sse(content), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function error402(body) {
  return new Response(JSON.stringify({ error: { message: body, code: 402 } }), { status: 402 });
}

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ max_tokens: body.max_tokens, response_format: body.response_format ?? null });
  if (calls.length === 1) {
    return error402('This request requires more credits, or fewer max_tokens. You requested up to 800 tokens, but can only afford 544. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account');
  }
  return okStream('{"action":"done"}');
};

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

try {
  // 1. Afford 544 -> same-rung refit to 462, success.
  calls.length = 0;
  const out = await callOpenAICompatible(settings, settings.model, 'decide', null, opts);
  check('refit retry issued on the same rung', calls.length === 2 && calls[1].response_format !== null, JSON.stringify(calls));
  check('refit max_tokens = floor(544*0.85) = 462', calls[1]?.max_tokens === 462, `got ${calls[1]?.max_tokens}`);
  check('response parses after refit', out?.action === 'done', JSON.stringify(out));

  // 2. Refit cap holds across the empty-response escalation (no 1600 bypass).
  calls.length = 0;
  let n = 0;
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = async (_u, init) => {
    const body = JSON.parse(init.body);
    calls.push({ max_tokens: body.max_tokens });
    n++;
    if (n === 1) return error402('You requested up to 800 tokens, but can only afford 544. See https://openrouter.ai/settings/credits');
    if (n === 2) return okStream(''); // 200, no text -> escalate budget x2
    return okStream('{"action":"click"}');
  };
  const out2 = await callOpenAICompatible(settings, settings.model, 'decide', null, opts);
  check('creditCap clamps the x2 escalation', calls[2]?.max_tokens === 462, JSON.stringify(calls));
  check('escalated response parses', out2?.action === 'click', JSON.stringify(out2));
  globalThis.fetch = realFetch2;

  // 3. Afford below the minimum -> actionable failure, no retry storm.
  calls.length = 0;
  globalThis.fetch = async () => {
    calls.push({});
    return error402('This request requires more credits, or fewer max_tokens. You requested up to 800 tokens, but can only afford 100. Visit https://openrouter.ai/settings/credits');
  };
  let err3 = null;
  try { await callOpenAICompatible(settings, settings.model, 'decide', null, opts); }
  catch (e) { err3 = e; }
  check('tiny balance fails fast (1 call)', calls.length === 1, `calls=${calls.length}`);
  check('tiny balance message names the fix', /credits too low.*openrouter\.ai\/settings\/credits/s.test(err3?.message || ''), String(err3?.message));

  // 4. 402 without an affordable count -> actionable failure, no refit loop.
  calls.length = 0;
  globalThis.fetch = async () => {
    calls.push({});
    return error402('This request requires more credits. Visit https://openrouter.ai/settings/credits');
  };
  let err4 = null;
  try { await callOpenAICompatible(settings, settings.model, 'decide', null, opts); }
  catch (e) { err4 = e; }
  check('plain 402 fails with top-up hint', calls.length === 1 && /out of credits/.test(err4?.message || ''), String(err4?.message));

  // 5. Ladder regression: 400 (no afford text) still drops a rung.
  calls.length = 0;
  let m = 0;
  globalThis.fetch = async (_u, init) => {
    const body = JSON.parse(init.body);
    calls.push({ response_format: body.response_format ?? null });
    m++;
    if (m === 1) return new Response(JSON.stringify({ error: { message: 'response_format unsupported' } }), { status: 400 });
    return okStream('{"action":"type"}');
  };
  const out5 = await callOpenAICompatible(settings, settings.model, 'decide', null, opts);
  check('400 ladder intact (rung 2 has no response_format)', calls.length === 2 && calls[1].response_format === null, JSON.stringify(calls));
  check('ladder response parses', out5?.action === 'type', JSON.stringify(out5));
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
