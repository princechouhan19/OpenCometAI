// ─────────────────────────────────────────────────────────────────────────────
// src/lib/field-matching.js
// v1.11.0 — provider-agnostic FORM-FIELD TARGETING intelligence.
//
// Field log (Gmail "write a mail" task, 25 steps, task failed):
//   • The compose dialog opens with the recipients row COLLAPSED — the <input>
//     for "To" does not exist in the DOM until the visible "Recipients" chip
//     is clicked (user diagnosis, confirmed by screenshots: inactive row shows
//     "Recipients", expanded row shows "To … Cc Bcc").
//   • Every natural-language click target the VLM invented ("the To field in
//     the New Message window") fell through to the generic text scan, which
//     matched the extension's OWN injected status overlay (its innerText is a
//     live echo of the current action description) — the agent repeatedly
//     clicked ITSELF and verification reported fake "no visible change".
//   • Gmail's rotated class names made all 10 guessed CSS selectors misses.
//
// This module holds the pure (DOM-free) matching logic so the SW-side loop
// governor and the Node unit tests share ONE implementation. The page-injected
// executors (domClick/domType in actions.js) keep small self-contained copies
// of the same rules because chrome.scripting serializes the function source —
// imports are not available inside the page.
// ─────────────────────────────────────────────────────────────────────────────

/** Query looks like a request to target a form field (vs a button/link). */
export const FIELD_QUERY_RE = /\b(field|input|box|textbox|text box|textarea|editor|type into|type in|fill|enter .*(into|in)|recipients?|subject|search bar|search box|email field|password|message body|compose body|body)\b/i;

/** Words that never identify a field (removed before scoring). */
export const FIELD_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'into', 'on', 'at', 'to', 'for',
  'field', 'input', 'box', 'textbox', 'text', 'area', 'element', 'please',
  'window', 'popup', 'pop', 'up', 'dialog', 'panel', 'bar', 'row', 'section',
  'click', 'press', 'type', 'typing', 'enter', 'entering', 'fill', 'filling',
  'then', 'that', 'this', 'with', 'using', 'use', 'again', 'still', 'try',
  'first', 'next', 'top', 'bottom', 'left', 'right', 'large', 'small', 'big',
  'white', 'blue', 'grey', 'gray', 'black', 'red', 'green', 'yellow',
]);

/**
 * Extract the salient tokens from a natural-language field description.
 * "the To field in the New Message compose window" → ['compose', 'message', 'to']
 * Order preserved; stopwords dropped; 'to' is KEPT (it is a field NAME in
 * mail/calendar UIs: "To recipients"), single letters dropped.
 * @param {string} desc
 * @returns {string[]}
 */
export function fieldTokens(desc = '') {
  return String(desc || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w && (w === 'to' || (w.length >= 2 && !FIELD_STOPWORDS.has(w))));
}

/**
 * Score how well an editable element's hint string (aria-label + placeholder +
 * name + id + label text, joined) matches the description tokens.
 *   hint word EQUALS a token           → +3
 *   hint CONTAINS a token (word-bound) → +2
 *   hint contains token as substring   → +1  (only for tokens ≥3 chars)
 * A score > 0 means "plausible match"; the caller picks the max.
 * @param {string[]} tokens   from fieldTokens()
 * @param {string}   hints    normalized hint blob for one element
 * @returns {number}
 */
export function scoreFieldCandidate(tokens = [], hints = '') {
  const h = String(hints || '').toLowerCase();
  if (!h || !tokens.length) return 0;
  let score = 0;
  for (const t of tokens) {
    const wordRe = new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
    if (wordRe.test(h)) { score += 3; continue; }
    if (h.includes(t)) { score += t.length >= 3 ? 1 : 0; }
  }
  return score;
}

/**
 * Extract the first 'single' or "double" quoted span from a click description
 * — VLMs frequently quote the on-screen label ("the blue 'Send' button").
 * @param {string} desc
 * @returns {string} quoted text ('' when none)
 */
export function extractQuotedText(desc = '') {
  const m = String(desc || '').match(/['"“”‘’]([^'"“”‘’]{1,60})['"“”‘’]/);
  return m ? m[1].trim() : '';
}

/**
 * Labels that look like COLLAPSED FIELD-GROUP toggles in modern web apps
 * (Gmail "Recipients", calendar "Add time", generic "Options"/"Advanced").
 * Generic UI vocabulary — no vendor-specific code path.
 */
export const GROUP_TOGGLE_VOCAB = new Set([
  'recipients', 'to recipients', 'select recipients', 'add recipients',
  'cc', 'bcc', 'add cc', 'add bcc', 'cc bcc', 'to cc bcc',
  'options', 'more options', 'advanced', 'advanced options',
  'additional options', 'more filters', 'filters', 'details', 'more details',
  'add subject', 'subject', 'add title', 'add description', 'add note',
  'add participants', 'add people', 'invite', 'add invitees',
]);

/** Toggles we must NEVER auto-click when expanding collapsed groups. */
export const FORBIDDEN_TOGGLE_RE = /^(send|delete|remove|discard|close|cancel|ok|okay|save|submit|next|done|undo|archive|report|spam|mute|block|reply|forward|print|share|logout|sign out|minimize|maximize|expand|collapse)\b/i;

/** Short human label? (collapsed group chips are 1–3 words, no symbols) */
export function isShortLabel(label = '') {
  const l = String(label || '').trim();
  return l.length >= 2 && l.length <= 24 && /^[a-z][a-z0-9' ]*$/i.test(l);
}

/**
 * Should this label be considered a collapsed-group toggle worth auto-clicking
 * when the requested field cannot be found in the DOM?
 * @param {string} label    normalized accessible label of a clickable
 * @param {string[]} tokens salient tokens of the failed field query
 * @returns {boolean}
 */
export function isGroupToggleCandidate(label = '', tokens = []) {
  const l = String(label || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!isShortLabel(l)) return false;
  if (FORBIDDEN_TOGGLE_RE.test(l)) return false;
  if (GROUP_TOGGLE_VOCAB.has(l)) return true;
  // token overlap: "add recipients" vs query token "recipients"
  return tokens.some(t => t.length >= 3 && (l === t || l.includes(t) || t.includes(l)));
}

/**
 * Intent tokens for the loop governor (privacy-loop stall detection).
 * Collapses an action + thought into a comparable keyword set.
 * @param {object} action
 * @param {string} thought
 * @returns {string} sorted comma-joined tokens ('' when nothing salient)
 */
export function intentTokens(action = {}, thought = '') {
  const raw = `${action?.selector || ''} ${action?.text || ''} ${action?.url || ''} ${thought || ''}`
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !FIELD_STOPWORDS.has(w) && !['http', 'https', 'com', 'www'].includes(w));
  return [...new Set(raw)].sort().slice(0, 10).join(',');
}

/** Jaccard similarity between two intent token strings. */
export function intentSimilarity(a = '', b = '') {
  const A = new Set(String(a || '').split(',').filter(Boolean));
  const B = new Set(String(b || '').split(',').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * The strategy-hint ladder injected into the decision prompt when the loop
 * keeps failing on the same target. Generic for ANY provider/page.
 * @param {number} level   1..3
 * @param {number} stalls  consecutive ineffective/failed steps
 * @returns {string} hint text ('' when level < 1)
 */
export function strategyHintFor(level = 0, stalls = 0) {
  if (level <= 0) return '';
  if (level === 1) {
    return `Your last ${stalls} actions on this target all failed or had no verified effect. Most likely cause: the form field is COLLAPSED and its <input> does not exist in the DOM yet. Look at the screenshot for a group label inside the dialog (e.g. a "Recipients" chip) and CLICK it first — the field row then expands (To / Cc / Bcc appear) and the next type/click will match. Alternatively type into the field that already has focus: {"type":"type","selector":"focused"} (dialogs usually focus their first field when opened).`;
  }
  if (level === 2) {
    return `Still stuck after ${stalls} attempts. STOP retrying selectors for this field. Two proven escape routes: (1) KEYBOARD — click any nearby field, then press_key "Tab" / "Shift+Tab" to move focus onto the target field and use {"type":"type","selector":"focused"}; (2) URL — navigate to a URL that pre-fills the form directly (web apps commonly support query params; e.g. Gmail compose accepts https://mail.google.com/mail/u/0/?view=cm&fs=1&to=<addr>&su=<subject>&body=<body>).`;
  }
  return `Last resort after ${stalls} failed attempts: submit what you have with the app's KEYBOARD shortcut — press_key "Control+Enter" sends a Gmail compose, plain "Enter" submits many focused forms — then wait, verify from the screenshot/toast, and set is_complete accordingly. If the form visibly shows the task's goal is already satisfied, declare is_complete=true instead of retrying.`;
}
