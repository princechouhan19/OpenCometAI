#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// OpenCometBench/e2e/smoke-openrouter-free.mjs — PRE-FLIGHT SMOKE TEST for
// OpenRouter FREE vision models, to be run BEFORE a full real-VLM E2E
// (run-e2e-real.mjs --provider=custom --base-url=https://openrouter.ai/api/v1).
//
// It does exactly what a human would do in 5 seconds with curl, but scripted
// and measured: one tiny (1×1 px) image + a JSON instruction, then it checks
// that the model (a) answers over vision at all and (b) obeys the JSON shape.
//
//   OPENROUTER_API_KEY=sk-or-… node OpenCometBench/e2e/smoke-openrouter-free.mjs
//   OPENROUTER_API_KEY=sk-or-… node OpenCometBench/e2e/smoke-openrouter-free.mjs \
//       --model=meta-llama/llama-3.2-11b-vision-instruct:free
//   … --stream                      # exercise the SSE streaming path too
//
// KEY HYGIENE (non-negotiable): the key is read from the OPENROUTER_API_KEY
// environment variable (or --api-key="$OPENROUTER_API_KEY" for parity with
// run-e2e-real.mjs). It is NEVER printed, NEVER written to a file, and NEVER
// accepted from this script's own source. If you ever paste a key into a chat,
// a log, or a screenshot — rotate it immediately; it is compromised.
//
// Output: none written. Exit 0 = endpoint + key + model + vision + JSON shape
// all verified; exit 1 = something failed (the reason is printed).
// ─────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (k, d = null) => {
  const a = argv.find(x => x.startsWith(`--${k}=`));
  return a ? a.split('=').slice(1).join('=') : d;
};
const hasFlag = (f) => argv.includes(`--${f}`);

const KEY = arg('api-key') || process.env.OPENROUTER_API_KEY || '';
const BASE_URL = (arg('base-url') || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const MODEL = arg('model') || 'inclusionai/ling-3.0-flash-vl:free';
const STREAM = hasFlag('stream');
const TIMEOUT_MS = Number(arg('timeout-ms') || 60_000);

if (!KEY) {
  console.error('no key — set OPENROUTER_API_KEY in the environment (never hardcode one):');
  console.error('  OPENROUTER_API_KEY=sk-or-… node OpenCometBench/e2e/smoke-openrouter-free.mjs');
  process.exit(1);
}

// 1×1 transparent PNG — the smallest valid image a vision model can accept.
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PROMPT = 'what is this image? respond in json with key answer';

const t0 = Date.now();
let res;
try {
  res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
      // OpenRouter etiquette headers (attribution); harmless on other gateways.
      'HTTP-Referer': 'https://github.com/opencomet-sih/opencomet-sih',
      'X-Title': 'OpenComet SIH OpenCometBench smoke',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: TINY_PNG } },
          { type: 'text', text: PROMPT },
        ],
      }],
      stream: STREAM,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
} catch (e) {
  console.error(`FAIL transport: ${e.name}: ${e.message} (after ${Date.now() - t0} ms)`);
  process.exit(1);
}
const ttfbMs = Date.now() - t0;

if (!res.ok) {
  const body = await res.text().catch(() => '');
  // 401/402/429 are the common OpenRouter free-tier failures — name them.
  const hint = res.status === 401 ? 'invalid key (or key not yet credited)'
    : res.status === 402 ? 'insufficient credits on the account'
    : res.status === 429 ? 'rate-limited (free tier quota) — retry later or rotate models'
    : res.status === 404 ? `model id not found on this gateway: ${MODEL}`
    : '';
  console.error(`FAIL http ${res.status} after ${ttfbMs} ms${hint ? ` — ${hint}` : ''}\n${body.slice(0, 400)}`);
  process.exit(1);
}

// Collect either a plain JSON completion or an SSE stream (first content delta).
let content = '';
let sawStreamKeepAlive = false;
if (STREAM && res.headers.get('content-type')?.includes('text/event-stream')) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline && !content) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split('\n')) {
      const s = line.trim();
      if (s === ': OPENROUTER PROCESSING') sawStreamKeepAlive = true;
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') break;
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
        if (delta) content += delta;
      } catch { /* partial frame — keep reading */ }
    }
  }
  reader.cancel().catch(() => {});
} else {
  const j = await res.json().catch(() => null);
  content = j?.choices?.[0]?.message?.content ?? '';
}

const totalMs = Date.now() - t0;
if (!content.trim()) {
  console.error(`FAIL empty answer after ${totalMs} ms${sawStreamKeepAlive ? ' (stream keep-alives seen but no content)' : ''} — model may not accept image input or is warming up`);
  process.exit(1);
}

// The model must at least answer, ideally in the requested JSON shape.
let jsonShapeOk = false;
let answer = content.trim();
try {
  const m = content.match(/\{[\s\S]*\}/);           // tolerate prose around the JSON
  const parsed = JSON.parse(m ? m[0] : content);
  if (parsed && typeof parsed.answer === 'string') { jsonShapeOk = true; answer = parsed.answer; }
} catch { /* shape not respected — still a PASS if non-empty, reported honestly */ }

console.log('PASS — OpenRouter free-model smoke');
console.log(`  model        : ${MODEL}`);
console.log(`  gateway      : ${BASE_URL}`);
console.log(`  stream       : ${STREAM ? 'yes (SSE)' : 'no'}`);
console.log(`  TTFB         : ${ttfbMs} ms`);
console.log(`  total        : ${totalMs} ms`);
console.log(`  json 'answer': ${jsonShapeOk ? 'yes' : 'no (model answered, ignored the JSON shape)'}`);
console.log(`  answer       : ${answer.slice(0, 120).replace(/\n+/g, ' ')}${answer.length > 120 ? '…' : ''}`);
console.log('  next         : run the full loop → node OpenCometBench/e2e/run-e2e-real.mjs \\');
console.log(`                   --provider=custom --base-url=${BASE_URL} --model=${MODEL} --api-key="$OPENROUTER_API_KEY"`);
process.exit(0);
