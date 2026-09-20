// src/lib/guardian-daemon.js — TASK AUTHORIZATION DAEMON
//
// Run-scoped wrapper around the pure guardian (task-guardian.js). The pure
// module answers ONE question — "does the user's own text authorize this
// risky action?" — this module adds the daemon policies the changelog
// promises, so both agent loops (standard + privacy) share identical
// semantics:
//
//   • EXPLICIT AUTHORIZATION — purchase/delete actions require the user's
//     OWN task text (or a mid-run note) to authorize the class. A task that
//     FORBIDS it ("do not purchase anything") is blocked too: negated
//     authorization = no authorization.
//   • INJECTION PREVENTION — the daemon's ONLY inputs are the user's task
//     snapshot and the user's own notes (guardianUserNotes()/task snapshot).
//     Page text, model reasoning, and history NEVER reach the gate, so an
//     injected page cannot talk or label its way past it. The loops pin the
//     task snapshot at run start; notes are written only by the user.
//   • FAULT SHUTDOWN — if the daemon itself throws (poisoned action shape,
//     regex catastrophe, …) the verdict is fail-closed { fatal: true }: the
//     task STOPS instead of running unverified risky actions.
//   • OVERRIDING SPECULATIVE QUEUES — a block verdict carries a strategy
//     hint and the loops must discard the remaining speculative queue (the
//     queue executes without a fresh VLM turn, so nothing risky may ride
//     behind a gate event).
//   • 3-HIT HONEST EXIT — the 3rd blocked attempt in one run returns
//     { exit: true }; the loop terminates the task with an honest summary
//     (terminal step + history + AGENT_DONE), never with the risky action
//     executed.
//
// Pure & synchronous — safe to call before every primary AND queued action.

import { guardAction, guardianStrategyHint } from './task-guardian.js';

/** Blocked purchase/deletion attempts tolerated per run before the honest exit. */
export const GUARDIAN_HIT_LIMIT = 3;

/**
 * Pin the authorization evidence to what the user typed at run start.
 * Loops call this ONCE per run and pass the snapshot thereafter — a mutated
 * agentState.task mid-run cannot retroactively authorize anything.
 */
export function guardianTaskSnapshot(taskText) {
  return String(taskText || '').trim();
}

/**
 * Normalize the user-note stream to plain strings. Only user-authored notes
 * (sidepanel context box / ask_user replies) flow in here — by contract,
 * never page-derived or model-derived text.
 */
export function guardianUserNotes(notes) {
  return (Array.isArray(notes) ? notes : [])
    .map(n => (n && typeof n === 'object') ? String(n.text || '').trim() : String(n || '').trim())
    .filter(Boolean);
}

/**
 * THE DAEMON VERDICT. Call before every primary AND queued action.
 *
 * @param {object}  action                 Planned action
 * @param {object}  opts
 * @param {string}  opts.taskText          USER's task text (run-start snapshot)
 * @param {Array}   [opts.extraTexts]      USER's mid-run notes ({text}|string)
 * @param {number}  [opts.hits]            Blocked attempts so far in this run
 * @returns {object}
 *   { pass: true }                                  — harmless or user-authorized
 *   { pass: false, skip: true,  hit, verdict, userMessage, hint }  — blocked, skip the action
 *   { pass: false, exit: true,  hit, verdict, userMessage, hint }  — 3rd block, end the run honestly
 *   { pass: false, fatal: true, userMessage }       — daemon fault, fail-closed shutdown
 */
export function authorizeAction(action, { taskText = '', extraTexts = [], hits = 0 } = {}) {
  let verdict;
  try {
    verdict = guardAction(action, {
      taskText: guardianTaskSnapshot(taskText),
      extraTexts: guardianUserNotes(extraTexts),
    });
  } catch (err) {
    return {
      pass: false,
      fatal: true,
      hit: null,
      verdict: null,
      userMessage:
        `🛡️ Task Authorization Daemon fault — ${String(err?.message || err)}. ` +
        `Fail-closed shutdown: nothing risky runs while the gate cannot evaluate it, so the task stops here.`,
    };
  }

  if (!verdict.blocked) return { pass: true, hit: Number(hits) || 0, verdict };

  const hit = (Number(hits) || 0) + 1;
  const base = { hit, verdict, userMessage: verdict.userMessage, hint: guardianStrategyHint(verdict) };
  if (hit >= GUARDIAN_HIT_LIMIT) return { pass: false, exit: true, ...base };
  return { pass: false, skip: true, ...base };
}

// DAEMON COUNTER — visible, honest accounting of every gate decision.
// The counter is PURE state: loops own the instance (per-run) and persistence.

/** Fresh per-run counter. Every field stays numeric — JSON-safe for status. */
export function createGuardianCounter() {
  return { checks: 0, risky: 0, authorized: 0, blocked: 0, exits: 0, faults: 0 };
}

/**
 * Tally ONE daemon verdict into the counter. Harmless passes count as checks;
 * risky-but-authorized as checks+risky+authorized; skips/exits as blocked
 * (exit also exits); daemon faults as faults.
 */
export function tallyGuardian(counter, res) {
  const c = (counter && typeof counter === 'object') ? counter : createGuardianCounter();
  c.checks = (c.checks || 0) + 1;
  if (!res || typeof res !== 'object') return c;
  if (res.fatal) {
    c.faults = (c.faults || 0) + 1;
  } else if (res.pass) {
    if (res.verdict && res.verdict.risk) {
      c.risky = (c.risky || 0) + 1;
      c.authorized = (c.authorized || 0) + 1;
    }
  } else if (res.skip || res.exit) {
    c.blocked = (c.blocked || 0) + 1;
    if (res.exit) c.exits = (c.exits || 0) + 1;
  }
  return c;
}

/** One-line human summary for status payloads / history. */
export function guardianCounterSummary(counter) {
  const c = (counter && typeof counter === 'object') ? counter : {};
  return `checks ${c.checks || 0} · risky ${c.risky || 0} (authorized ${c.authorized || 0}) · blocked ${c.blocked || 0} · exits ${c.exits || 0} · faults ${c.faults || 0}`;
}

/**
 * Merge a per-run counter into the lifetime accumulator (storage.local
 * 'opencometGuardianLifetime'). Pure — the caller owns chrome.storage.
 * `runs` counts FLUSHES (callers flush exactly once per run and reset the
 * per-run counter afterwards, so a run can never be counted twice).
 */
export function mergeGuardianLifetime(prev, run) {
  const p = (prev && typeof prev === 'object') ? prev : {};
  const r = (run && typeof run === 'object') ? run : {};
  return {
    runs: (p.runs || 0) + 1,
    checks: (p.checks || 0) + (r.checks || 0),
    risky: (p.risky || 0) + (r.risky || 0),
    authorized: (p.authorized || 0) + (r.authorized || 0),
    blocked: (p.blocked || 0) + (r.blocked || 0),
    exits: (p.exits || 0) + (r.exits || 0),
    faults: (p.faults || 0) + (r.faults || 0),
    updatedAt: Date.now(),
  };
}
