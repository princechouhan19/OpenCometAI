// src/lib/element-disambiguate.js — ELEMENT DISAMBIGUATION
//
// Repeated tags (the same tag rendered several times with the SAME visible
// label — "Buy Now" ×4) are invisible to a score-based resolver: every
// candidate ties and the first one wins silently. This module gives every member
// of a repeated (tag, label) group a DISAMBIGUATION RECEIPT that resolves to
// the EXACT control:
//
//     dup:      "2 of 4"            ordinal position inside the group
//     pos:      "top-left"          viewport zone of that specific control
//     nearform: "iPhone 15 case"    nearest form/section context label
//     ref:      "Buy Now #2"        the canonical resolvable name
//
// The model can target "Buy Now #2" directly (domClick parses the ordinal and
// picks the 2nd equal-labeled control — out-of-range ordinals fail HONESTLY
// with the group size), and every click result carries the same receipt back,
// so history proves WHICH duplicate fired.
//
// Self-developed, zero external source. The in-page implementations (sw.js
// inventory scan, actions.js domClick) are serialized into pages and must be
// self-contained, so they carry compact mirrors of these primitives — this
// module is the canonical, node-testable definition (same pattern as
// lib/field-matching.js and its domClick mirror).
//
// Pure & synchronous: no DOM, no chrome.* — safe to unit-test in node.

export const DISAMBIGUATE_VERSION = 'v1.19.0';

// "Buy Now #2" / "Buy Now #2 of 4" / "text:Buy Now #2". Requires ≥1 non-space
// char BEFORE the '#' (a bare "#2" or a CSS id selector like "#main" never
// parses as an ordinal) and 1–3 digits AFTER it (an id like "#header" or a
// hex color never matches either).
const ORDINAL_RE = /^(.*\S)\s*#\s*(\d{1,3})(?:\s*(?:of|\/)\s*(\d{1,3}))?$/;

/**
 * Parse an ordinal selector into { base, ordinal, total }.
 * @returns {{ base: string, ordinal: number, total: number|null } | null}
 *   null when the selector carries no ordinal suffix.
 */
export function parseOrdinalSelector(sel) {
  const s = String(sel || '').replace(/^\s*text:/i, '');
  const m = ORDINAL_RE.exec(s);
  if (!m) return null;
  const base = m[1].trim();
  const ordinal = parseInt(m[2], 10);
  if (!base || !Number.isInteger(ordinal) || ordinal < 1) return null;
  const total = m[3] ? parseInt(m[3], 10) : null;
  return { base, ordinal, total: total && total >= 1 ? total : null };
}

/**
 * Viewport zone of an element ("top-left" … "middle-center" … "bottom-right").
 * Uses the element CENTER against viewport thirds. Returns '' when the
 * geometry is unusable — never guesses.
 */
export function quadrantOf(bounds, viewport) {
  const vw = Number(viewport?.w) || 0;
  const vh = Number(viewport?.h) || 0;
  if (!bounds || typeof bounds !== 'object') return '';   // no geometry → no guess
  const b = bounds;
  const cx = (Number(b.x) || 0) + (Number(b.w) || 0) / 2;
  const cy = (Number(b.y) || 0) + (Number(b.h) || 0) / 2;
  if (!(vw > 0) || !(vh > 0) || !Number.isFinite(cx) || !Number.isFinite(cy)) return '';
  const hz = cx < vw / 3 ? 'left' : cx > (2 * vw) / 3 ? 'right' : 'center';
  const vt = cy < vh / 3 ? 'top' : cy > (2 * vh) / 3 ? 'bottom' : 'middle';
  return `${vt}-${hz}`;
}

/** "2 of 4" — empty unless the group actually repeats (total ≥ 2). */
export function dupTagOf(index, total) {
  const i = Number(index);
  const n = Number(total);
  if (!Number.isInteger(i) || !Number.isInteger(n) || n < 2 || i < 1 || i > n) return '';
  return `${i} of ${n}`;
}

/** "Buy Now #2" — the canonical resolvable name for the i-th duplicate. */
export function refNameOf(label, index) {
  const l = String(label || '').replace(/\s+/g, ' ').trim();
  const i = Number(index);
  if (!l || !Number.isInteger(i) || i < 1) return '';
  return `${l.substring(0, 60)} #${i}`;
}

/** First meaningful context label, whitespace-collapsed, capped at 40 chars. */
export function pickNearform(candidates) {
  for (const c of (Array.isArray(candidates) ? candidates : [])) {
    const t = String(c || '').replace(/\s+/g, ' ').trim();
    if (t) return t.substring(0, 40);
  }
  return '';
}

/** The full receipt for one member of a repeated group. */
export function receiptFor({ label, index, total, bounds, viewport, nearform }) {
  const n = Number(total);
  return {
    dup: dupTagOf(index, n),
    pos: quadrantOf(bounds, viewport),
    nearform: pickNearform(nearform),
    ref: n >= 2 ? refNameOf(label, index) : '',
  };
}

/**
 * Tag a whole inventory: group items by (tag, label); every member of a group
 * with ≥2 members receives dup/pos/nearform/ref. Singles stay untouched (no
 * tag noise for unambiguous controls). `nearHint`, when the caller precomputed
 * an ancestor context label, becomes the nearform. Mutates and returns the list.
 */
export function tagRepeated(items, viewport) {
  const list = Array.isArray(items) ? items : [];
  const groups = new Map();
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const label = String(it.text || it.ariaLabel || it.placeholder || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!label) continue;
    const key = `${String(it.tag || it.role || '').toLowerCase()}|${label}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    members.forEach((it, i) => {
      const r = receiptFor({
        label: String(it.text || it.ariaLabel || ''),
        index: i + 1,
        total: members.length,
        bounds: it.bounds,
        viewport,
        nearform: [it.nearHint],
      });
      it.dup = r.dup;
      it.pos = r.pos;
      it.nearform = r.nearform;
      it.ref = r.ref;
    });
  }
  return list;
}

/** Exposed for tests/docs. */
export const _internals = { ORDINAL_RE };
