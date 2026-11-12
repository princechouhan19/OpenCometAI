import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOOP_KIND,
  LOOP_DEFAULTS,
  stepSignature,
  detectLoop,
  buildReflectionPrompt,
  takeReflectionBudget,
} from '../src/lib/loop-reflection.js';

test('stepSignature is type + target, never the action text', () => {
  assert.equal(stepSignature({ type: 'click', selector: '#Buy' }), 'click:#buy');
  assert.equal(stepSignature({ type: 'scroll' }), 'scroll');
  assert.equal(stepSignature(null), '');
});

test('three identical actions in a row is a repeat_action loop', () => {
  const history = [
    { type: 'click', selector: '#next' },
    { type: 'click', selector: '#next' },
    { type: 'click', selector: '#next' },
  ];
  const loop = detectLoop(history);
  assert.equal(loop.kind, LOOP_KIND.REPEAT_ACTION);
  assert.equal(loop.count, 3);
});

test('two identical actions are not yet a loop', () => {
  const loop = detectLoop([{ type: 'click', selector: '#next' }, { type: 'click', selector: '#next' }]);
  assert.equal(loop.kind, LOOP_KIND.NONE);
});

test('alternating between two states is oscillation', () => {
  const history = [
    { type: 'click', selector: '#a' },
    { type: 'click', selector: '#b' },
    { type: 'click', selector: '#a' },
    { type: 'click', selector: '#b' },
  ];
  const loop = detectLoop(history);
  assert.equal(loop.kind, LOOP_KIND.OSCILLATION);
});

test('three alternations are not required - two cycles is enough', () => {
  assert.equal(detectLoop([
    { type: 'click', selector: '#a' },
    { type: 'click', selector: '#b' },
    { type: 'click', selector: '#a' },
  ]).kind, LOOP_KIND.NONE, 'A,B,A is not yet two full cycles');
});

test('repeated waits without progress is dead_wait', () => {
  const loop = detectLoop([
    { type: 'wait', selector: '#result', progress: false },
    { type: 'wait', selector: '#result', progress: false },
  ]);
  assert.equal(loop.kind, LOOP_KIND.DEAD_WAIT);
});

test('waits that reported progress are not a dead wait', () => {
  const loop = detectLoop([
    { type: 'wait', selector: '#result', progress: true },
    { type: 'wait', selector: '#result', progress: true },
  ]);
  assert.equal(loop.kind, LOOP_KIND.NONE);
});

test('mixed productive history is not a loop', () => {
  const loop = detectLoop([
    { type: 'navigate', target: '/a' },
    { type: 'type', selector: '#q', text: 'shoes' },
    { type: 'click', selector: '#go' },
    { type: 'scroll' },
  ]);
  assert.equal(loop.kind, LOOP_KIND.NONE);
});

test('each loop class produces its own strategy-change prompt', () => {
  const repeat = buildReflectionPrompt({ kind: LOOP_KIND.REPEAT_ACTION, evidence: ['x repeated 3 times'] }, { task: 'buy shoes' });
  assert.match(repeat, /REFLECTION REQUIRED/);
  assert.match(repeat, /different route to the goal/);
  assert.match(repeat, /buy shoes/);

  const osc = buildReflectionPrompt({ kind: LOOP_KIND.OSCILLATION });
  assert.match(osc, /third option/);

  const dead = buildReflectionPrompt({ kind: LOOP_KIND.DEAD_WAIT });
  assert.match(dead, /Stop waiting/);

  assert.equal(buildReflectionPrompt({ kind: LOOP_KIND.NONE }), null);
  assert.equal(buildReflectionPrompt(null), null);
});

test('reflection budget is capped per task', () => {
  let state = { used: 0 };
  const first = takeReflectionBudget(state);
  assert.equal(first.allowed, true);
  assert.equal(first.used, 1);

  state = { used: LOOP_DEFAULTS.maxReflectionsPerTask };
  const exhausted = takeReflectionBudget(state);
  assert.equal(exhausted.allowed, false);
  assert.equal(exhausted.remaining, 0);
});

test('lookback keeps detection bounded', () => {
  const noisy = Array.from({ length: 40 }, (_, i) => ({ type: 'click', selector: `#x${i}` }));
  assert.equal(detectLoop(noisy).kind, LOOP_KIND.NONE);
});
