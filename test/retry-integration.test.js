import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_KIND,
  classifyError,
  retryDecision,
  retryAfterMsFrom,
  httpStatusOf,
  countsAsStepFailure,
} from '../src/lib/error-taxonomy.js';

// Mirrors what the loop does in the catch block: classify, extract the wait,
// decide. Kept here so a change to either half is caught together.
function decide(err, priorRetries = 0) {
  const kind = classifyError(err, { source: 'loop', status: httpStatusOf(err) });
  return { kind, ...retryDecision(kind, priorRetries + 1, { retryAfterMs: retryAfterMsFrom(err) }) };
}

const providerError = (message, extra = {}) => Object.assign(new Error(message), extra);

test('a 429 with Retry-After seconds is waited out exactly', () => {
  const err = providerError('Too many requests', {
    status: 429,
    response: { status: 429, headers: { 'retry-after': '7' } },
  });
  const d = decide(err);
  assert.equal(d.kind, ERROR_KIND.RATE_LIMIT);
  assert.equal(d.retry, true);
  assert.equal(d.delayMs, 7000);
});

test('a 429 with an HTTP-date header waits until that instant', () => {
  const at = new Date(Date.now() + 4000).toUTCString();
  const err = providerError('slow down', { status: 429, headers: { 'retry-after': at } });
  const d = decide(err);
  assert.equal(d.kind, ERROR_KIND.RATE_LIMIT);
  assert.ok(d.delayMs > 2000 && d.delayMs <= 60000, `delay was ${d.delayMs}`);
});

test('a Headers-like object is read with .get()', () => {
  const err = providerError('nope', {
    status: 503,
    response: { status: 503, headers: { get: (k) => (k === 'retry-after' ? '2' : null) } },
  });
  assert.equal(retryAfterMsFrom(err), 2000);
});

test('an offer to wait longer than a minute is capped', () => {
  const err = providerError('quota', { status: 429, response: { headers: { 'retry-after': '600' } } });
  assert.equal(retryAfterMsFrom(err), 60000);
  assert.equal(decide(err).delayMs, 60000);
});

test('no header falls back to exponential backoff', () => {
  const err = providerError('Bad Gateway', { status: 502 });
  const d = decide(err);
  assert.equal(d.kind, ERROR_KIND.PROVIDER_5XX);
  assert.ok(d.delayMs >= 375 && d.delayMs <= 625, `delay was ${d.delayMs}`);
});

test('a status read from the error still classifies', () => {
  assert.equal(decide(providerError('x', { status: 401 })).kind, ERROR_KIND.AUTH);
  assert.equal(decide(providerError('x', { status: 401 })).fatal, true);
});

test('a 429 message without a status still classifies', () => {
  const d = decide(providerError('HTTP 429: rate limit exceeded'));
  assert.equal(d.kind, ERROR_KIND.RATE_LIMIT);
  assert.equal(d.retry, true);
});

test('the retry budget ends the run instead of looping', () => {
  const err = providerError('Bad Gateway', { status: 502 });
  assert.equal(decide(err, 0).retry, true);
  assert.equal(decide(err, 1).retry, true);
  assert.equal(decide(err, 2).retry, true);
  assert.equal(decide(err, 3).retry, false);
});

test('a blocked action never waits, however many times it is seen', () => {
  const err = providerError('Blocked by the guardian');
  err.name = 'PrivacyBlockedError';
  const d = decide(err, 5);
  assert.equal(d.kind, ERROR_KIND.POLICY_BLOCKED);
  assert.equal(d.retry, false);
  assert.equal(d.fatal, true);
  assert.equal(countsAsStepFailure(d.kind), true);
});

test('a detached-node error re-probes immediately', () => {
  const d = decide(providerError('Node is detached from document'));
  assert.equal(d.kind, ERROR_KIND.DOM_STALE);
  assert.equal(d.retry, true);
  assert.equal(d.delayMs, 0);
});
