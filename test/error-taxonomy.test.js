import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_KIND,
  classifyError,
  isTerminalKind,
  retryDecision,
  countsAsStepFailure,
} from '../src/lib/error-taxonomy.js';

const err = (message, extra = {}) => Object.assign(new Error(message), extra);

test('HTTP status classification', () => {
  assert.equal(classifyError(err('x'), { status: 401 }), ERROR_KIND.AUTH);
  assert.equal(classifyError(err('x'), { status: 403 }), ERROR_KIND.AUTH);
  assert.equal(classifyError(err('x'), { status: 429 }), ERROR_KIND.RATE_LIMIT);
  assert.equal(classifyError(err('x'), { status: 502 }), ERROR_KIND.PROVIDER_5XX);
  assert.equal(classifyError(err('x'), { status: 408 }), ERROR_KIND.TRANSIENT_NETWORK);
});

test('status read from the error itself, not only the context', () => {
  assert.equal(classifyError(err('boom', { status: 503 }), {}), ERROR_KIND.PROVIDER_5XX);
  assert.equal(classifyError(err('boom', { response: { status: 429 } }), {}), ERROR_KIND.RATE_LIMIT);
});

test('network faults are transient', () => {
  assert.equal(classifyError(err('Failed to fetch')), ERROR_KIND.TRANSIENT_NETWORK);
  assert.equal(classifyError(err('read ECONNRESET')), ERROR_KIND.TRANSIENT_NETWORK);
  assert.equal(classifyError(err('net::ERR_NETWORK_CHANGED')), ERROR_KIND.TRANSIENT_NETWORK);
});

test('a blocked action is policy, never a retryable transport fault', () => {
  const blocked = err('blocked');
  blocked.name = 'PrivacyBlockedError';
  assert.equal(classifyError(blocked), ERROR_KIND.POLICY_BLOCKED);
  assert.equal(classifyError(err('Blocked by the guardian: purchase needs authorization')), ERROR_KIND.POLICY_BLOCKED);
});

test('DOM faults map to stale/target classes', () => {
  assert.equal(classifyError(err('Node is detached from document')), ERROR_KIND.DOM_STALE);
  assert.equal(classifyError(err('Cannot read properties of null (reading value)')), ERROR_KIND.DOM_STALE);
  assert.equal(classifyError(err('element is not clickable')), ERROR_KIND.TARGET_NOT_FOUND);
});

test('perception faults are recognised by source or message', () => {
  assert.equal(classifyError(err('engine unavailable'), { source: 'perception' }), ERROR_KIND.PERCEPTION_FAILED);
  assert.equal(classifyError(err('tesseract worker failed')), ERROR_KIND.PERCEPTION_FAILED);
});

test('terminal kinds are auth and policy only', () => {
  assert.equal(isTerminalKind(ERROR_KIND.AUTH), true);
  assert.equal(isTerminalKind(ERROR_KIND.POLICY_BLOCKED), true);
  assert.equal(isTerminalKind(ERROR_KIND.PROVIDER_5XX), false);
});

test('transient faults back off exponentially with deterministic jitter', () => {
  const d1 = retryDecision(ERROR_KIND.PROVIDER_5XX, 1, { rand: () => 0.5 });
  const d2 = retryDecision(ERROR_KIND.PROVIDER_5XX, 2, { rand: () => 0.5 });
  assert.equal(d1.retry, true);
  assert.equal(d1.delayMs, 500);
  assert.equal(d2.delayMs, 1000);
  assert.equal(d1.fatal, false);
});

test('jitter stays within the documented +/-25% band', () => {
  const low = retryDecision(ERROR_KIND.TRANSIENT_NETWORK, 1, { rand: () => 0, baseDelayMs: 1000 });
  const high = retryDecision(ERROR_KIND.TRANSIENT_NETWORK, 1, { rand: () => 0.999999, baseDelayMs: 1000 });
  assert.ok(low.delayMs >= 750 && low.delayMs <= 1250, `low was ${low.delayMs}`);
  assert.ok(high.delayMs >= 750 && high.delayMs <= 1250, `high was ${high.delayMs}`);
});

test('retry-after is honoured over computed backoff', () => {
  const d = retryDecision(ERROR_KIND.RATE_LIMIT, 1, { rand: () => 0.5, retryAfterMs: 5000 });
  assert.equal(d.delayMs, 5000);
});

test('retries stop after the attempt budget', () => {
  const d = retryDecision(ERROR_KIND.PROVIDER_5XX, 4, { maxAttempts: 3 });
  assert.equal(d.retry, false);
  assert.equal(d.fatal, true);
});

test('auth and policy are fatal on the first attempt', () => {
  assert.equal(retryDecision(ERROR_KIND.AUTH, 1).fatal, true);
  assert.equal(retryDecision(ERROR_KIND.POLICY_BLOCKED, 1).retry, false);
});

test('stale DOM re-probes immediately instead of waiting', () => {
  const d = retryDecision(ERROR_KIND.DOM_STALE, 1);
  assert.equal(d.retry, true);
  assert.equal(d.delayMs, 0);
  assert.equal(retryDecision(ERROR_KIND.DOM_STALE, 3).retry, false);
});

test('transport faults do not count as step failures', () => {
  assert.equal(countsAsStepFailure(ERROR_KIND.TRANSIENT_NETWORK), false);
  assert.equal(countsAsStepFailure(ERROR_KIND.RATE_LIMIT), false);
  assert.equal(countsAsStepFailure(ERROR_KIND.PROVIDER_5XX), false);
  assert.equal(countsAsStepFailure(ERROR_KIND.TARGET_NOT_FOUND), true);
  assert.equal(countsAsStepFailure(ERROR_KIND.POLICY_BLOCKED), true);
});
