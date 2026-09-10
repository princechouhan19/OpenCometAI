// ─────────────────────────────────────────────────────────────────────────────
// src/core/logger.js
// Unified diagnostics logger for EVERY extension context (service worker /
// offscreen ML runtime / sidepanel).
//
//   • Namespaced, levelled, timestamped, colourised console output
//   • In-memory ring buffer (getRecentLogs) for diagnostics dumps
//   • describeHttpError() — classifies API / model-request failures into
//     human-readable kinds (auth / rate-limit / network / server / …)
//   • installGlobalErrorTraps() — uncaught errors + unhandled rejections
//     never vanish silently
//   • Optional relay: background contexts forward warn/error lines to the
//     sidepanel console (DIAG_LOG) and page contexts relay crashes back to
//     the service-worker console (DIAG_LOG_RELAY) — one console sees all.
// ─────────────────────────────────────────────────────────────────────────────

const IS_DEV = true; // flip to false for production builds

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const COLORS = {
  debug: '#9ca3af',
  info:  '#60a5fa',
  warn:  '#fbbf24',
  error: '#f87171',
};
const METHOD = { debug: 'log', info: 'log', warn: 'warn', error: 'error' };

// ── Ring buffer (diagnostics) ────────────────────────────────────────────────
const RING_MAX = 500;
const RING = [];

function pushRing(row) {
  RING.push(row);
  if (RING.length > RING_MAX) RING.shift();
}

/** Get the most recent log rows (optionally filtered). For diagnostics UIs. */
export function getRecentLogs(filter = {}) {
  let rows = RING;
  if (filter.level) rows = rows.filter(r => LEVELS[r.level] >= LEVELS[filter.level]);
  if (filter.ns)    rows = rows.filter(r => r.ns === filter.ns);
  if (filter.q)     rows = rows.filter(r => r.text.toLowerCase().includes(String(filter.q).toLowerCase()));
  return rows.slice();
}

// ── Formatting ───────────────────────────────────────────────────────────────
function fmtArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  try { return JSON.stringify(a); } catch { return String(a); }
}

function safeRelay(payload) {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
      chrome.runtime.sendMessage(payload)?.catch?.(() => {});
    }
  } catch { /* messaging unavailable — console output is enough */ }
}

function _log(level, ns, args, opts = {}) {
  if (!IS_DEV) return;
  const ts   = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const text = args.map(fmtArg).join(' ');
  pushRing({ ts, level, ns, text });
  const style = `color:${COLORS[level]};font-weight:600;font-family:monospace`;
  console[METHOD[level]](`%c[${ts}][Open Comet:${ns}][${level.toUpperCase()}]`, style, text);

  // Relay: which levels leave this context, and to where.
  if (opts.relayType && LEVELS[level] >= LEVELS[opts.relayLevel || 'error']) {
    safeRelay({ type: opts.relayType, ns, level, text: text.slice(0, 600), ctx: opts.ctx || '', ts: Date.now() });
  }
}

/**
 * Create a namespaced logger.
 *   const log = createLogger('Agent');            // local console only
 *   const log = createLogger('API', { relayType: 'DIAG_LOG', relayLevel: 'warn' });
 *       // (service worker) warn+error lines are also broadcast to the sidepanel
 *   const log = createLogger('Sidepanel');
 *   installGlobalErrorTraps(log, 'sidepanel', 'DIAG_LOG_RELAY');
 *       // (page contexts) uncaught crashes are relayed back to the SW console
 */
export function createLogger(namespace, opts = {}) {
  const mk = (level) => (...args) =>
    _log(level, namespace, args, { relayType: opts.relayType, relayLevel: opts.relayLevel, ctx: opts.ctx });
  return { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') };
}

// ── HTTP / network error classifier ──────────────────────────────────────────
// Turns fetch failures (API providers, HuggingFace model requests) into a
// short human-readable kind + hint, so console logs are actionable.
export function describeHttpError(err) {
  const m = String(err?.message || err || '');
  if (/401|403|unauthorized|invalid[ _-]?(api[ _-]? )?key|invalid_api_key/i.test(m)) return 'AUTH error — check the API key';
  if (/429|rate[ ._-]?limit|quota|insufficient_quota|billing|credit/i.test(m))      return 'RATE-LIMIT — too many requests or quota exhausted; slow down / check billing';
  if (/404|not[ _-]?found|entry not found|no such file/i.test(m))                   return 'NOT-FOUND — model/endpoint does not exist (wrong repo or name?)';
  if (/40[028]|bad request|invalid (request|payload)|too large/i.test(m))           return 'BAD REQUEST — prompt/params rejected by the endpoint';
  if (/5\d\d|server error|overloaded|bad gateway|unavailable/i.test(m))             return 'SERVER error — provider outage, retry later';
  if (/abort/i.test(m))                                                             return 'ABORTED';
  if (/failed to fetch|networkerror|load failed|fetch failed|socket|err_name|dns|offline/i.test(m))
                                                                                    return 'NETWORK error — offline, blocked, or DNS failure';
  return 'request failed';
}

// ── Global error traps ───────────────────────────────────────────────────────
// Works in page contexts (window) AND the service worker (self). Uncaught
// errors and unhandled promise rejections are logged with full stacks; if
// relayType is given, they are also forwarded to another context's console.
export function installGlobalErrorTraps(log, scopeName = '', relayType = null) {
  const g = (typeof self !== 'undefined') ? self : globalThis;
  const send = (level, text) => {
    log.error(text);
    if (relayType) safeRelay({ type: relayType, ns: scopeName || 'Trap', level, ctx: scopeName, text: String(text).slice(0, 600), ts: Date.now() });
  };
  try {
    g.addEventListener('error', (e) => {
      const msg = e?.error?.stack || e?.message || (e?.filename ? `${e.filename}:${e.lineno}` : 'unknown error');
      send('error', `[uncaught @${scopeName}] ${msg}`);
    });
    g.addEventListener('unhandledrejection', (e) => {
      const r = e?.reason;
      const msg = r?.stack || r?.message || String(r ?? 'unknown rejection');
      send('error', `[unhandled-rejection @${scopeName}] ${msg}`);
    });
  } catch { /* event listeners unavailable — nothing else to do */ }
}

/** Convenience default logger for quick use. */
export const log = createLogger('Open Comet');
