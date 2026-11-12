import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOAL_CHECKS,
  normalizeGoalContract,
  selectorsForContract,
  describeGoalContract,
  evaluateGoalContract,
} from '../src/lib/goal-verifier.js';

test('normalizeGoalContract accepts a single check, an array, and {checks}', () => {
  const single = normalizeGoalContract({ check: 'text_contains', value: 'Message sent' });
  assert.equal(single.checks.length, 1);

  const arr = normalizeGoalContract([{ check: 'element_exists', selector: '#sent' }]);
  assert.equal(arr.checks.length, 1);

  const wrapped = normalizeGoalContract({ checks: [{ check: 'url_contains', value: '/sent' }] });
  assert.equal(wrapped.checks.length, 1);
});

test('normalizeGoalContract drops unknown checks and malformed fields', () => {
  assert.equal(normalizeGoalContract({ check: 'make_it_work' }), null);
  assert.equal(normalizeGoalContract({ check: 'element_exists' }), null, 'missing selector must be dropped');
  assert.equal(normalizeGoalContract({ check: 'count_at_least', selector: '#x', min: 'lots' }), null);
  assert.equal(normalizeGoalContract(null), null);
  assert.equal(normalizeGoalContract({ checks: [] }), null);
});

test('every advertised check is normalizable with valid fields', () => {
  const sample = {
    url_matches: { pattern: '^https://' },
    url_contains: { value: '/sent' },
    title_contains: { value: 'Inbox' },
    text_contains: { value: 'sent' },
    text_absent: { value: 'error' },
    count_at_least: { selector: '#a', min: 1 },
    count_equals: { selector: '#a', count: 1 },
    element_exists: { selector: '#a' },
    element_text_contains: { selector: '#a', value: 'x' },
  };
  for (const check of GOAL_CHECKS) {
    const c = normalizeGoalContract({ check, ...sample[check] });
    assert.ok(c, `${check} should normalize`);
    assert.equal(c.checks[0].check, check);
  }
});

test('selectorsForContract dedupes and preserves order', () => {
  const c = normalizeGoalContract({
    checks: [
      { check: 'element_exists', selector: '#b' },
      { check: 'element_text_contains', selector: '#a', value: 'x' },
      { check: 'count_at_least', selector: '#b', min: 1 },
    ],
  });
  assert.deepEqual(selectorsForContract(c), ['#b', '#a']);
});

test('evaluateGoalContract verifies when every check holds', () => {
  const c = normalizeGoalContract([
    { check: 'url_matches', pattern: '#sent$' },
    { check: 'text_contains', value: 'Message sent' },
    { check: 'count_at_least', selector: '#toast', min: 1 },
  ]);
  const v = evaluateGoalContract(c, {
    url: 'https://mail.google.com/mail/u/0/#sent',
    title: 'Sent Mail',
    text: 'Message sent. Your message   has been delivered.',
    counts: { '#toast': 1 },
    texts: {},
  });
  assert.equal(v.status, 'verified');
  assert.equal(v.ok, true);
  assert.equal(v.results.length, 3);
});

test('evaluateGoalContract fails when a check does not hold', () => {
  const c = normalizeGoalContract({ check: 'text_contains', value: 'Message sent' });
  const v = evaluateGoalContract(c, { text: 'Draft saved' });
  assert.equal(v.status, 'failed');
  assert.equal(v.ok, false);
  assert.match(v.reason, /does not contain/);
});

test('text_absent fails loudly when the forbidden text is still present', () => {
  const c = normalizeGoalContract({ check: 'text_absent', value: 'Captcha' });
  assert.equal(evaluateGoalContract(c, { text: 'Please solve the captcha' }).status, 'failed');
  assert.equal(evaluateGoalContract(c, { text: 'All good' }).status, 'verified');
});

test('element_text_contains inspects the collected element text', () => {
  const c = normalizeGoalContract({ check: 'element_text_contains', selector: '#status', value: 'paid' });
  assert.equal(evaluateGoalContract(c, { texts: { '#status': 'Payment PAID' } }).status, 'verified');
  assert.equal(evaluateGoalContract(c, { texts: { '#status': 'Pending' } }).status, 'failed');
});

test('a missing probe field is unevaluable, never a silent pass', () => {
  const c = normalizeGoalContract({ check: 'text_contains', value: 'sent' });
  const v = evaluateGoalContract(c, {});
  assert.equal(v.status, 'unevaluable');
  assert.equal(v.ok, false);
});

test('an invalid regex is unevaluable, not a crash', () => {
  const c = normalizeGoalContract({ check: 'url_matches', pattern: '([' });
  const v = evaluateGoalContract(c, { url: 'https://example.com' });
  assert.equal(v.status, 'unevaluable');
});

test('no contract is unevaluable', () => {
  assert.equal(evaluateGoalContract(null, { text: 'x' }).status, 'unevaluable');
});

test('describeGoalContract renders without throwing', () => {
  const c = normalizeGoalContract([
    { check: 'count_at_least', selector: '#rows', min: 3 },
    { check: 'url_contains', value: '/done' },
  ]);
  const s = describeGoalContract(c);
  assert.match(s, /#rows/);
  assert.match(s, /\/done/);
  assert.equal(describeGoalContract(null), 'no goal contract');
});
