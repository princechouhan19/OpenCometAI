// ─────────────────────────────────────────────────────────────────────────────
// src/lib/agent-context.js
// Pure, dependency-free helpers that shape the CONTEXT the VLM sees each turn.
//
// v1.9.0 VLM-speed package (see docs/vlm-speed-research.md):
//   • compactHistory()      — history window compaction so the prompt does not
//                             grow every step (fewer prompt tokens + a stable
//                             prefix improves provider KV/context cache hits).
//   • extractFailedTargets()— selectors that verification PROVED ineffective;
//                             feeding them back stops the model from burning
//                             turns repeating the same dead click.
//   • planQueueActions()    — validates the model's speculative "queue" of
//                             follow-up actions (multi-action planning) so the
//                             loop can execute them WITHOUT extra VLM calls.
// No chrome.* and no imports — safe to unit-test in Node and cheap to import
// from any context (SW, offscreen, tests).
// ─────────────────────────────────────────────────────────────────────────────

/** Action types allowed inside a speculative queue (never navigate — context
 *  changes too much; never done/ask_user — those are decisions, not actions). */
const QUEUE_ALLOWED_TYPES = new Set(['click', 'type', 'scroll', 'wait', 'media', 'media_control', 'press_key', 'key']);
export const QUEUE_MAX_ACTIONS = 2;

/**
 * Compact the step history for the decision prompt.
 *
 * The last `keepFull` entries keep their full detail (action + result +
 * verification); everything older is collapsed to a single line so the prompt
 * stays roughly constant-sized across a long run instead of growing every
 * step. Compaction is deterministic and prefix-stable for unchanged entries —
 * combined with "static rules first" prompt ordering this maximizes the
 * provider's automatic KV/context-cache hits (Moonshot/OpenRouter bill cached
 * prefixes at ~10% and answer noticeably faster).
 *
 * @param {Array<{action?:object, result?:string, verify?:object, latencyMs?:number}>} history
 * @param {number} keepFull  how many most-recent entries stay detailed (default 3)
 * @returns {{ full: string, brief: string, nFull: number, nBrief: number }}
 */
export function compactHistory(history = [], keepFull = 3) {
  const list = Array.isArray(history) ? history : [];
  const cut = Math.max(0, list.length - keepFull);
  const oneLine = (h, i) => {
    const type = String(h?.action?.type || '?');
    const target = String(h?.action?.selector || h?.action?.url || h?.action?.command || '').replace(/\s+/g, ' ').slice(0, 48);
    const result = String(h?.result || '').replace(/\s+/g, ' ').slice(0, 90);
    return `Step ${i + 1}: ${type}${target ? ` "${target}"` : ''} → ${result}`;
  };
  const briefLines = list.slice(0, cut).map(oneLine);
  const fullLines = list.slice(cut).map((h, k) => {
    const i = cut + k;
    return `Step ${i + 1}: action=${JSON.stringify(h?.action || {})} result=${h?.result || '(none)'}${h?.verify ? ` verification=${JSON.stringify(h.verify)}` : ''}`;
  });
  return {
    full: fullLines.join('\n'),
    brief: briefLines.join('\n'),
    nFull: fullLines.length,
    nBrief: briefLines.length,
  };
}

/**
 * Collect the click/text targets that action verification already PROVED
 * ineffective ("executed … NO visible change"), newest last. The prompt lists
 * them as forbidden repeats so the model stops re-clicking the same dead
 * target — in the field this spiral burned 3 VLM turns (~2.5 min) in a row.
 *
 * @param {Array<{action?:object, result?:string}>} history
 * @param {number} cap  maximum targets to list (default 6, newest last)
 * @returns {string[]} distinct target strings
 */
export function extractFailedTargets(history = [], cap = 6) {
  const out = [];
  const seen = new Set();
  for (const h of (Array.isArray(history) ? history : [])) {
    const r = String(h?.result || '');
    const ineffective = /NO visible change|VERIFICATION showed NO/i.test(r);
    const failed = /^failed —/i.test(r);
    if (!ineffective && !failed) continue;
    const sel = String(h?.action?.selector || '').trim();
    if (!sel || seen.has(sel)) continue;
    seen.add(sel);
    out.push(sel);
  }
  return out.slice(-cap);
}

/**
 * Validate + sanitize the model's speculative action queue.
 *
 * Contract (prompt side): the JSON may contain
 *   "queue": [ {action…}, {action…} ]
 * with follow-up actions that the model is CONFIDENT still apply once the
 * primary action verifies. The loop executes them WITHOUT a VLM call and
 * stops at the first verification failure, so a bad guess costs nothing —
 * it just falls back to the normal per-step decision.
 *
 * Only safe, local, verifiable action types are allowed; entries are
 * shallow-copied and stripped of unknown keys.
 *
 * @param {object} plan  the parsed action plan from the VLM
 * @returns {Array<object>} 0..QUEUE_MAX_ACTIONS clean action objects
 */
export function planQueueActions(plan) {
  const raw = plan?.queue;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= QUEUE_MAX_ACTIONS) break;
    if (!item || typeof item !== 'object') continue;
    const type = String(item.type || '').toLowerCase();
    if (!QUEUE_ALLOWED_TYPES.has(type)) continue;
    const clean = { type };
    if (item.selector != null) clean.selector = String(item.selector).slice(0, 200);
    if (item.text != null) clean.text = String(item.text).slice(0, 300);
    if (item.url != null && (type === 'navigate')) clean.url = String(item.url).slice(0, 500);
    if (item.command != null) clean.command = String(item.command).slice(0, 20);
    if (item.direction != null) clean.direction = String(item.direction).slice(0, 10);
    if (item.amount != null && Number.isFinite(Number(item.amount))) clean.amount = Number(item.amount);
    if (item.key != null) clean.key = String(item.key).slice(0, 30);
    if (item.ms != null && Number.isFinite(Number(item.ms))) clean.ms = Math.min(10000, Math.max(100, Number(item.ms)));
    out.push(clean);
  }
  return out;
}

/**
 * Detect a playback intent from an action + the model's thought, so the loop
 * can auto-recover with the direct `media` action when a player click is
 * verified ineffective (no extra VLM call).
 *
 * @param {object} action  the executed action
 * @param {string} thought the model's reasoning text for this step
 * @returns {string|null} 'play' | 'pause' | 'mute' | 'unmute' | null
 */
export function detectPlaybackIntent(action, thought = '') {
  const blob = `${action?.selector || ''} ${action?.text || ''} ${action?.command || ''} ${thought}`.toLowerCase();
  // Order matters: mute/unmute before play/pause ("unmute" contains neither,
  // but be explicit anyway; "unpause" should map to play).
  if (/\bunmute\b/.test(blob)) return 'unmute';
  if (/\bmute\b/.test(blob) && !/unmute/.test(blob)) return 'mute';
  if (/\bunpause\b|\bresume\b|\bplay\b|\bstart .* (song|music|video|playback)|playback (starts|begins)/.test(blob)) return 'play';
  if (/\b(pause|stop)\b/.test(blob)) return 'pause';
  return null;
}
