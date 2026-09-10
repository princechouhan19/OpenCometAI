// ─────────────────────────────────────────────────────────────────────────────
// src/lib/tool-calls.js
// Robust tool-call extraction for on-device models (Gemma 4 / Granite 4).
// Ported from the gemma4-browser-extension reference (extractToolCalls.ts).
//
// Models trained for native tool calling emit several shapes:
//   1. JSON style       : {"name":"navigate","arguments":{"url":"…"}}<​/tool_call>
//   2. Gemma style      : <|tool_call>call:navigate{"url":"…"}<tool_call|>
//   3. Bare Gemma style : call:navigate{"url":"…"}   (tags dropped while streaming)
// All three are parsed here; the surrounding prose is returned as `message`.
// ─────────────────────────────────────────────────────────────────────────────

/** Gemma tool-call arguments arrive slightly malformed: unquoted keys and the
 *  `<|"|>` quote token. Normalise before JSON.parse (reference implementation). */
function parseGemmaArguments(rawArguments) {
  const normalized = String(rawArguments || '')
    .replace(/<\|"\|>/g, '"')
    .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
  try {
    const parsed = JSON.parse(normalized);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Brace-depth scanner for bare `call:name{...}` fragments. String- and
 *  escape-aware so braces inside JSON string values never break the scan. */
function extractBareGemmaToolCalls(text) {
  const calls = [];
  let cursor = 0;
  while (cursor < text.length) {
    const callStart = text.indexOf('call:', cursor);
    if (callStart === -1) break;

    const nameStart = callStart + 'call:'.length;
    const braceStart = text.indexOf('{', nameStart);
    if (braceStart === -1) { cursor = nameStart; continue; }

    const name = text.slice(nameStart, braceStart).trim();
    if (!name) { cursor = braceStart + 1; continue; }

    let depth = 0, inString = false, escapeNext = false, braceEnd = -1;
    for (let i = braceStart; i < text.length; i++) {
      const ch = text[i];
      if (escapeNext) { escapeNext = false; continue; }
      if (ch === '\\') { escapeNext = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) { braceEnd = i; break; }
      }
    }
    if (braceEnd === -1) { cursor = braceStart + 1; continue; }

    calls.push({ name, rawArguments: text.slice(braceStart, braceEnd + 1), start: callStart, end: braceEnd + 1 });
    cursor = braceEnd + 1;
  }
  return calls;
}

/**
 * Extract tool calls from model output.
 * @returns {{ toolCalls: Array<{name: string, arguments: object, id: string}>, message: string }}
 */
export function extractToolCalls(text) {
  const cleanedText = String(text || '').replace(/<\|end_of_text\|>/g, '');
  const jsonMatches = Array.from(cleanedText.matchAll(/([\s\S]*?)<\/tool_call>/g));
  const gemmaMatches = Array.from(cleanedText.matchAll(/<\|tool_call\>([\s\S]*?)<tool_call\|>/g));
  const bareGemmaMatches = extractBareGemmaToolCalls(cleanedText);
  const toolCalls = [];

  for (const match of jsonMatches) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed && typeof parsed.name === 'string') {
        toolCalls.push({
          name: parsed.name,
          arguments: parsed.arguments ?? {},
          id: JSON.stringify({ name: parsed.name, arguments: parsed.arguments ?? {} }),
        });
      }
    } catch { /* malformed JSON tool call — skip */ }
  }

  for (const match of gemmaMatches) {
    const payload = match[1].trim();
    const nameMatch = payload.match(/^call:([^\{]+)\{/);
    const argsMatch = payload.match(/^call:[^\{]+(\{[\s\S]*\})$/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    const args = argsMatch ? parseGemmaArguments(argsMatch[1]) : {};
    toolCalls.push({ name, arguments: args, id: JSON.stringify({ name, arguments: args }) });
  }

  const usedBareGemmaFallback = toolCalls.length === 0;
  let textWithoutBareCalls = text;
  if (usedBareGemmaFallback) {
    for (const match of bareGemmaMatches) {
      const args = parseGemmaArguments(match.rawArguments);
      toolCalls.push({ name: match.name, arguments: args, id: JSON.stringify({ name: match.name, arguments: args }) });
    }
    const bareRanges = bareGemmaMatches.sort((a, b) => b.start - a.start);
    for (const range of bareRanges) {
      textWithoutBareCalls =
        textWithoutBareCalls.slice(0, range.start) +
        textWithoutBareCalls.slice(range.end);
    }
  }

  // Strip complete AND incomplete tool-call / tool-response markup from prose.
  // The "leading fragment before </tool_call>" rule is guarded on actual
  // tool-call markup being present — plain prose answers pass through intact.
  const hasCallMarkup = /tool_call/.test(textWithoutBareCalls);
  let message = textWithoutBareCalls
    .replace(/<\|end_of_text\|>/g, '')
    .replace(/<\|tool_response\>[\s\S]*?<tool_response\|>/g, '')
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, '')
    .replace(/<\|tool_response\>|<tool_response\|>/g, '')
    .replace(/<tool_response>|<\/tool_response>/g, '')
    .replace(/<\|tool_call\>[\s\S]*?(?:<tool_call\|>|$)/g, '');
  if (hasCallMarkup) {
    message = message.replace(/[\s\S]*?(?:<\/tool_call>|$)/g, '');
  }
  message = message.trim();

  return { toolCalls, message };
}

/**
 * Convert native tool calls into our ACTION-JSON contract. Unknown tool names
 * are ignored so a hallucinated call can never execute.
 * @param {Array<{name, arguments}>} toolCalls
 * @param {Set<string>} knownActionTypes  e.g. new Set(['navigate','click',…])
 * @returns {{ action: object|null, reasoning: string, extras: object[] }}
 */
export function toolCallsToAction(toolCalls, knownActionTypes) {
  const known = knownActionTypes instanceof Set ? knownActionTypes : new Set(knownActionTypes || []);
  const accepted = [];
  for (const call of toolCalls || []) {
    const type = String(call.name || '').trim();
    if (!known.has(type)) continue;
    const args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
    accepted.push({ type, ...args });
  }
  if (!accepted.length) return { action: null, reasoning: '', extras: [] };
  return { action: accepted[0], reasoning: '', extras: accepted.slice(1) };
}
