// src/lib/loop-reflection.js
// Loop detection for the agent step history.
//
// Detecting a loop used to mean throwing, which ends the task. Injecting a
// reflection prompt instead keeps the agent working with a different strategy.
// Three shapes are worth separating because the fix differs for each:
//   repeat_action - same action on the same target, repeatedly
//   oscillation   - A, B, A, B
//   dead_wait     - waiting on something that is not coming
// Pure: takes a plain step history, returns a detection and prompt text.

export const LOOP_KIND = Object.freeze({
  REPEAT_ACTION: 'repeat_action',
  OSCILLATION: 'oscillation',
  DEAD_WAIT: 'dead_wait',
  NONE: 'none',
});

// Conservative: a false loop interrupts a run that is still working.
export const LOOP_DEFAULTS = Object.freeze({
  repeatThreshold: 3,
  oscillationCycles: 2,
  deadWaitThreshold: 2,
  maxReflectionsPerTask: 3,
  lookback: 8,
});

/** Identity of a step for loop purposes: type + target, never its text. */
export function stepSignature(step) {
  if (!step || typeof step !== 'object') return '';
  const type = String(step.type || '').trim().toLowerCase();
  const target = String(step.target ?? step.selector ?? step.uid ?? step.text ?? '').trim().toLowerCase();
  return target ? `${type}:${target}` : type;
}

/**
 * @param {Array<object>} history step records
 * @param {object} [opts] override LOOP_DEFAULTS
 * @returns {{kind: string, signature?: string, count?: number, evidence: string[]}}
 */
export function detectLoop(history, opts = {}) {
  const cfg = { ...LOOP_DEFAULTS, ...(opts || {}) };
  const steps = Array.isArray(history) ? history.slice(-cfg.lookback) : [];
  if (steps.length < 2) return { kind: LOOP_KIND.NONE, evidence: [] };

  const sigs = steps.map(stepSignature).filter(Boolean);

  let run = 1;
  for (let i = sigs.length - 1; i > 0; i--) {
    if (sigs[i] && sigs[i] === sigs[i - 1]) run++;
    else break;
  }
  if (run >= cfg.repeatThreshold) {
    const sig = sigs[sigs.length - 1];
    return {
      kind: LOOP_KIND.REPEAT_ACTION,
      signature: sig,
      count: run,
      evidence: [`"${sig}" repeated ${run} times in a row`],
    };
  }

  const need = cfg.oscillationCycles * 2;
  if (sigs.length >= need) {
    const tail = sigs.slice(-need);
    const a = tail[0];
    const b = tail[1];
    if (a && b && a !== b && tail.every((s, i) => s === (i % 2 === 0 ? a : b))) {
      return {
        kind: LOOP_KIND.OSCILLATION,
        signature: `${a} <> ${b}`,
        count: cfg.oscillationCycles,
        evidence: [`alternating between "${a}" and "${b}" for ${cfg.oscillationCycles} cycles`],
      };
    }
  }

  const tailWaits = steps.slice(-cfg.deadWaitThreshold);
  if (tailWaits.length === cfg.deadWaitThreshold
      && tailWaits.every((s) => String(s?.type || '').toLowerCase() === 'wait')
      && tailWaits.every((s) => s?.progress !== true)) {
    return {
      kind: LOOP_KIND.DEAD_WAIT,
      signature: stepSignature(tailWaits[tailWaits.length - 1]),
      count: cfg.deadWaitThreshold,
      evidence: [`waited ${cfg.deadWaitThreshold} times with no visible progress`],
    };
  }

  return { kind: LOOP_KIND.NONE, evidence: [] };
}

/**
 * Prompt injected into the next decision. null when there is no loop.
 * @param {{kind: string, evidence?: string[]}} loop
 * @param {{task?: string, url?: string, lastAction?: string, step?: number}} [ctx]
 */
export function buildReflectionPrompt(loop, ctx = {}) {
  if (!loop || loop.kind === LOOP_KIND.NONE) return null;

  const head = [
    'REFLECTION REQUIRED: the current plan stopped making progress.',
    loop.evidence?.length ? `Evidence: ${loop.evidence.join('; ')}.` : '',
    ctx.task ? `Task: ${String(ctx.task).slice(0, 300)}` : '',
    ctx.url ? `URL: ${String(ctx.url).slice(0, 200)}` : '',
    ctx.lastAction ? `Last action: ${String(ctx.lastAction).slice(0, 200)}` : '',
  ].filter(Boolean).join('\n');

  const body = {
    [LOOP_KIND.REPEAT_ACTION]: [
      'Repeating this action will not change the outcome. Before acting again:',
      '1. What did you expect it to cause, and what actually happened?',
      '2. What on the page contradicts the current plan?',
      '3. Name one different route to the goal, then take it.',
    ],
    [LOOP_KIND.OSCILLATION]: [
      'You are moving between two states without progress. Do not pick either',
      'again. Instead:',
      '1. State the goal as an observable page condition.',
      '2. Name the blocker that makes both states useless.',
      '3. Choose a third option: another control, a direct URL, or a smaller',
      '   sub-goal that can be checked.',
    ],
    [LOOP_KIND.DEAD_WAIT]: [
      'The content you are waiting for has not appeared and will not appear by',
      'waiting again. Stop waiting:',
      '1. Try another route to it (scroll, one reload, direct URL, other element).',
      '2. If it cannot be reached, say so and finish with a partial result.',
    ],
  }[loop.kind] || ['Change strategy: the current approach is not producing progress.'];

  return `${head}\n\n${body.join('\n')}`;
}

/** Per-task budget. Reflection is not free and can itself become a loop. */
export function takeReflectionBudget(state, opts = {}) {
  const max = Number.isFinite(opts.maxReflectionsPerTask)
    ? opts.maxReflectionsPerTask
    : LOOP_DEFAULTS.maxReflectionsPerTask;
  const used = Number(state?.used) || 0;
  if (used >= max) return { allowed: false, used, remaining: 0 };
  return { allowed: true, used: used + 1, remaining: max - used - 1 };
}
