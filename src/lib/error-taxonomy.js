// src/lib/error-taxonomy.js
// Failure classification and retry policy for the agent loop.
//
// The loop used to treat every error the same way and give up after three
// iterations. A provider 502 and a blocked purchase are not the same event:
// one should be retried, the other must not be. Pure — no I/O, and the jitter
// takes an injected RNG so backoff is deterministic under test.

export const ERROR_KIND = Object.freeze({
  TRANSIENT_NETWORK: 'TRANSIENT_NETWORK',
  RATE_LIMIT: 'RATE_LIMIT',
  PROVIDER_5XX: 'PROVIDER_5XX',
  AUTH: 'AUTH',
  DOM_STALE: 'DOM_STALE',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  PERCEPTION_FAILED: 'PERCEPTION_FAILED',
  POLICY_BLOCKED: 'POLICY_BLOCKED',
  UNKNOWN: 'UNKNOWN',
});

const TERMINAL = new Set([ERROR_KIND.AUTH, ERROR_KIND.POLICY_BLOCKED]);

// Worth one immediate retry against fresh state; waiting does not help.
const REPROBE_ONCE = new Set([
  ERROR_KIND.DOM_STALE,
  ERROR_KIND.TARGET_NOT_FOUND,
  ERROR_KIND.PERCEPTION_FAILED,
]);

const NETWORK_RE = /(failed to fetch|networkerror|network error|err_network|econnreset|econnrefused|enotfound|etimedout|etunnel|socket hang up|load failed|net::err_)/i;
const DOM_RE = /(no node found|not attached|detached from document|stale element|node is detached|element not found|cannot read propert(y|ies) of (null|undefined)|queryselector)/i;
const TARGET_RE = /(target not found|no matching element|selector .*not found|could not locate|element .*not visible|not clickable)/i;
const PERCEPTION_RE = /(ocr|tesseract|perception|engine unavailable|offscreen|wasm|model load)/i;
const POLICY_RE = /(privacyblocked|blocked by (the )?(guardian|firewall|privacy)|guardian|unauthorized|not permitted|forbidden action)/i;
const AUTH_RE = /(invalid api key|unauthorized|authentication|401|api key|credential|token expired|missing token|not configured)/i;
const RATE_RE = /(rate limit|too many requests|429|quota exceeded)/i;

/** HTTP status carried by the error, in any of the shapes SDKs use. */
export function httpStatusOf(err) {
  const s = Number(
    err?.status ?? err?.statusCode ?? err?.response?.status ?? err?.response?.statusCode ?? NaN,
  );
  return Number.isFinite(s) ? s : 0;
}

const MAX_HONOURED_WAIT_MS = 60_000;

/**
 * Retry-After in ms, from a header (seconds or HTTP-date) or a numeric field.
 * Returns 0 when absent, so callers fall back to computed backoff. A provider
 * asking for a longer wait than 60 s is capped: the run would otherwise stall.
 */
export function retryAfterMsFrom(err) {
  if (!err || typeof err !== 'object') return 0;

  const direct = Number(err.retryAfterMs);
  if (Number.isFinite(direct) && direct > 0) return Math.min(MAX_HONOURED_WAIT_MS, Math.round(direct));

  const headers = err.response?.headers || err.headers;
  let header;
  if (headers) {
    header = typeof headers.get === 'function'
      ? headers.get('retry-after')
      : headers['retry-after'] ?? headers['Retry-After'];
  }
  const value = err.retryAfter ?? header;
  if (value == null || value === '') return 0;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(MAX_HONOURED_WAIT_MS, Math.max(0, Math.round(seconds * 1000)));

  const at = Date.parse(String(value));
  if (Number.isFinite(at)) return Math.min(MAX_HONOURED_WAIT_MS, Math.max(0, at - Date.now()));
  return 0;
}

/**
 * Classify a thrown value.
 * @param {unknown} err
 * @param {{status?: number, name?: string, source?: string}} [ctx]
 * @returns {string} one of ERROR_KIND
 */
export function classifyError(err, ctx = {}) {
  const name = String(err?.name || ctx.name || '');
  const message = String(err?.message || err || '');
  const haystack = `${name} ${message}`;
  const status = Number.isFinite(Number(ctx.status)) ? Number(ctx.status) : httpStatusOf(err);

  // A policy block outranks any transport signal: retrying it would be a
  // safety bug, not a recovery.
  if (name === 'PrivacyBlockedError' || ctx.source === 'policy') return ERROR_KIND.POLICY_BLOCKED;
  if (POLICY_RE.test(haystack)) return ERROR_KIND.POLICY_BLOCKED;

  if (status === 401 || status === 403) return ERROR_KIND.AUTH;
  if (status === 429) return ERROR_KIND.RATE_LIMIT;
  if (Number.isFinite(status) && status >= 500 && status <= 599) return ERROR_KIND.PROVIDER_5XX;
  if (status === 408) return ERROR_KIND.TRANSIENT_NETWORK;

  if (ctx.source === 'perception' || PERCEPTION_RE.test(haystack)) return ERROR_KIND.PERCEPTION_FAILED;
  if (ctx.source === 'dom') return DOM_RE.test(haystack) ? ERROR_KIND.DOM_STALE : ERROR_KIND.TARGET_NOT_FOUND;

  if (NETWORK_RE.test(haystack) || /timeout|timed out/i.test(haystack)) {
    return AUTH_RE.test(haystack) ? ERROR_KIND.AUTH : ERROR_KIND.TRANSIENT_NETWORK;
  }
  if (RATE_RE.test(haystack)) return ERROR_KIND.RATE_LIMIT;
  if (AUTH_RE.test(haystack)) return ERROR_KIND.AUTH;
  if (TARGET_RE.test(haystack)) return ERROR_KIND.TARGET_NOT_FOUND;
  if (DOM_RE.test(haystack)) return ERROR_KIND.DOM_STALE;

  return ERROR_KIND.UNKNOWN;
}

export function isTerminalKind(kind) {
  return TERMINAL.has(kind);
}

/**
 * What to do after the `attempt`-th failure (1-based).
 * retry=false + fatal=true means end the run with `reason`.
 */
export function retryDecision(kind, attempt, opts = {}) {
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : 3;
  const base = Number.isFinite(opts.baseDelayMs) ? opts.baseDelayMs : 500;
  const rand = typeof opts.rand === 'function' ? opts.rand : Math.random;
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;

  if (TERMINAL.has(kind)) {
    return { retry: false, delayMs: 0, fatal: true, kind, reason: `${kind} is terminal` };
  }

  if (REPROBE_ONCE.has(kind)) {
    const allow = n <= Math.min(2, maxAttempts);
    return {
      retry: allow,
      delayMs: 0,
      fatal: !allow,
      kind,
      reason: allow ? `${kind}, re-probing page state` : `${kind} persisted after re-probe`,
    };
  }

  if (kind === ERROR_KIND.TRANSIENT_NETWORK || kind === ERROR_KIND.RATE_LIMIT || kind === ERROR_KIND.PROVIDER_5XX) {
    if (n > maxAttempts) {
      return { retry: false, delayMs: 0, fatal: true, kind, reason: `${kind} after ${maxAttempts} attempts` };
    }
    // A server-supplied Retry-After is an instruction: wait exactly that long.
    // Jittering it downward would retry before the server allowed, and
    // jittering upward only adds load later than asked.
    if (Number.isFinite(opts.retryAfterMs) && opts.retryAfterMs > 0) {
      const wait = Math.min(MAX_HONOURED_WAIT_MS, Math.round(opts.retryAfterMs));
      return {
        retry: true,
        delayMs: wait,
        fatal: false,
        kind,
        reason: `${kind}, retry after ${wait}ms (server)`,
      };
    }

    // Computed backoff carries +/-25% jitter so parallel runs do not resync.
    const raw = base * Math.pow(2, n - 1);
    const jitter = 1 + (rand() * 0.5 - 0.25);
    return {
      retry: true,
      delayMs: Math.max(0, Math.round(raw * jitter)),
      fatal: false,
      kind,
      reason: `${kind}, retry ${n}/${maxAttempts}`,
    };
  }

  const allow = n <= 1;
  return {
    retry: allow,
    delayMs: allow ? base : 0,
    fatal: !allow,
    kind,
    reason: allow ? 'UNKNOWN, one retry' : 'UNKNOWN, no further retry',
  };
}

/** Transport faults should not move the loop's failure counter. */
export function countsAsStepFailure(kind) {
  return kind !== ERROR_KIND.TRANSIENT_NETWORK
    && kind !== ERROR_KIND.RATE_LIMIT
    && kind !== ERROR_KIND.PROVIDER_5XX;
}
