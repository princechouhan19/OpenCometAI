// src/lib/goal-verifier.js
// Completion goals as checkable predicates.
//
// The navigator may declare what "done" looks like:
//   { checks: [{ check: 'url_matches', pattern: '#sent$' }] }
// This module turns that into a verdict against a probe of the live page.
// The caller collects the probe (url, title, text, per-selector count/text)
// so nothing here touches the DOM and the whole thing runs under node:test.

const MAX_SELECTOR_LEN = 200;
const MAX_VALUE_LEN = 300;
const MAX_PATTERN_LEN = 300;

export const GOAL_CHECKS = Object.freeze([
  'url_matches',
  'url_contains',
  'title_contains',
  'text_contains',
  'text_absent',
  'count_at_least',
  'count_equals',
  'element_exists',
  'element_text_contains',
]);

// A check missing one of these is malformed and gets dropped, so a half-built
// predicate can never read as satisfied.
const REQUIRES = Object.freeze({
  url_matches: ['pattern'],
  url_contains: ['value'],
  title_contains: ['value'],
  text_contains: ['value'],
  text_absent: ['value'],
  count_at_least: ['selector', 'min'],
  count_equals: ['selector', 'count'],
  element_exists: ['selector'],
  element_text_contains: ['selector', 'value'],
});

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const lower = (s) => norm(s).toLowerCase();

/**
 * Parse a declared goal. Accepts one check, an array of checks, or {checks}.
 * Returns null when nothing usable is left.
 */
export function normalizeGoalContract(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw.checks)
      ? raw.checks
      : [raw];

  const checks = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const kind = String(item.check || item.type || '').trim();
    if (!GOAL_CHECKS.includes(kind)) continue;

    const c = { check: kind };
    if (item.selector != null) c.selector = String(item.selector).slice(0, MAX_SELECTOR_LEN);
    if (item.value != null) c.value = String(item.value).slice(0, MAX_VALUE_LEN);
    if (item.pattern != null) c.pattern = String(item.pattern).slice(0, MAX_PATTERN_LEN);
    if (item.min != null) c.min = Number(item.min);
    if (item.count != null) c.count = Number(item.count);

    const missing = REQUIRES[kind].filter((k) => {
      const v = c[k];
      if (v == null) return true;
      if (k === 'min' || k === 'count') return !Number.isFinite(v) || v < 0;
      return String(v).trim() === '';
    });
    if (missing.length) continue;

    checks.push(c);
  }

  return checks.length ? { checks } : null;
}

/** Selectors the probe needs, in first-seen order. */
export function selectorsForContract(contract) {
  const out = [];
  for (const c of contract?.checks || []) {
    if (c.selector && !out.includes(c.selector)) out.push(c.selector);
  }
  return out;
}

/** One line for the step feed. */
export function describeGoalContract(contract) {
  if (!contract?.checks?.length) return 'no goal contract';
  return contract.checks.map((c) => {
    if (c.check === 'count_at_least') return `${c.selector} >= ${c.min}`;
    if (c.check === 'count_equals') return `${c.selector} = ${c.count}`;
    if (c.check === 'url_matches') return `url ~ /${c.pattern}/`;
    if (c.selector) return `${c.check}(${c.selector}, ${c.value})`;
    return `${c.check}(${c.value})`;
  }).join(' | ');
}

function compilePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) return null;
  if (pattern.length > MAX_PATTERN_LEN) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

// ok=true passed, ok=false failed, ok=null could not be judged.
function runCheck(c, probe) {
  const fail = (detail) => ({ check: c.check, ok: false, detail });
  const pass = (detail) => ({ check: c.check, ok: true, detail });
  const skip = (detail) => ({ check: c.check, ok: null, detail });

  switch (c.check) {
    case 'url_matches': {
      if (typeof probe.url !== 'string') return skip('probe.url unavailable');
      const re = compilePattern(c.pattern);
      if (!re) return skip('invalid or oversized pattern');
      return re.test(probe.url)
        ? pass(`url matched /${c.pattern}/`)
        : fail(`url did not match /${c.pattern}/ (was ${probe.url.slice(0, 120)})`);
    }

    case 'url_contains': {
      if (typeof probe.url !== 'string') return skip('probe.url unavailable');
      return lower(probe.url).includes(lower(c.value))
        ? pass(`url contains "${c.value}"`)
        : fail(`url does not contain "${c.value}" (was ${probe.url.slice(0, 120)})`);
    }

    case 'title_contains': {
      if (typeof probe.title !== 'string') return skip('probe.title unavailable');
      return lower(probe.title).includes(lower(c.value))
        ? pass(`title contains "${c.value}"`)
        : fail(`title does not contain "${c.value}" (was ${probe.title.slice(0, 120)})`);
    }

    case 'text_contains': {
      if (typeof probe.text !== 'string') return skip('probe.text unavailable');
      return lower(probe.text).includes(lower(c.value))
        ? pass(`text contains "${c.value}"`)
        : fail(`text does not contain "${c.value}"`);
    }

    case 'text_absent': {
      if (typeof probe.text !== 'string') return skip('probe.text unavailable');
      return lower(probe.text).includes(lower(c.value))
        ? fail(`text still contains "${c.value}"`)
        : pass(`text does not contain "${c.value}"`);
    }

    case 'count_at_least':
    case 'count_equals': {
      const counts = probe.counts;
      if (!counts || typeof counts !== 'object' || !(c.selector in counts)) {
        return skip(`no count for ${c.selector}`);
      }
      const got = Number(counts[c.selector]);
      if (!Number.isFinite(got)) return skip(`non-numeric count for ${c.selector}`);
      if (c.check === 'count_at_least') {
        return got >= c.min
          ? pass(`${c.selector} = ${got} (>= ${c.min})`)
          : fail(`${c.selector} = ${got}, expected >= ${c.min}`);
      }
      return got === c.count
        ? pass(`${c.selector} = ${got}`)
        : fail(`${c.selector} = ${got}, expected ${c.count}`);
    }

    case 'element_exists': {
      const counts = probe.counts;
      if (!counts || typeof counts !== 'object' || !(c.selector in counts)) {
        return skip(`no count for ${c.selector}`);
      }
      const got = Number(counts[c.selector]);
      return got > 0 ? pass(`${c.selector} present (${got})`) : fail(`${c.selector} not present`);
    }

    case 'element_text_contains': {
      const texts = probe.texts;
      if (!texts || typeof texts !== 'object' || !(c.selector in texts)) {
        return skip(`no text for ${c.selector}`);
      }
      const got = String(texts[c.selector] || '');
      return lower(got).includes(lower(c.value))
        ? pass(`${c.selector} contains "${c.value}"`)
        : fail(`${c.selector} does not contain "${c.value}" (was "${got.slice(0, 80)}")`);
    }

    default:
      return skip(`unsupported check ${c.check}`);
  }
}

/**
 * Judge a contract against a probe.
 * status: 'verified' (all passed) | 'failed' (one failed) | 'unevaluable'.
 */
export function evaluateGoalContract(contract, probe = {}) {
  if (!contract?.checks?.length) {
    return { status: 'unevaluable', ok: false, results: [], reason: 'no goal contract declared' };
  }

  const results = contract.checks.map((c) => runCheck(c, probe || {}));
  const failed = results.filter((r) => r.ok === false);
  const unknown = results.filter((r) => r.ok === null);

  if (failed.length) {
    return { status: 'failed', ok: false, results, reason: failed.map((r) => r.detail).join('; ') };
  }
  if (unknown.length) {
    return { status: 'unevaluable', ok: false, results, reason: unknown.map((r) => r.detail).join('; ') };
  }
  return { status: 'verified', ok: true, results, reason: results.map((r) => r.detail).join('; ') };
}
