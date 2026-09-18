// ─────────────────────────────────────────────────────────────────────────────
// src/background/privacy-loop.js
// Privacy-aware agent loop — alternative to the standard OpenComet loop.
// Triggered when the user enables "Privacy Mode" in the side panel.
//
// Loop:
//   1. captureAndSanitize(tab)         → sanitized image + sanitized DOM + manifest
//   2. decideViaServer(payload, task)  → JSON action plan from VLM
//   3. executeAction(tab, action)      → click / type / scroll / navigate / done
//   4. Repeat until is_complete or maxSteps reached.
//
// Every screenshot is sanitised BEFORE any network call.  The server only
// ever sees redacted pixels + redacted text + the redaction manifest.
// ─────────────────────────────────────────────────────────────────────────────

import { captureAndSanitize, decideViaServer, configurePrivacy, getPrivacySettings, resolvePrivacyTab } from '../lib/privacy-agent.js';
import { getProviderCapabilities } from '../lib/providers.js';
import { executeAction, describeAction } from './actions.js';
import { sleep } from '../lib/utils.js';
import { MSG, STEP_TYPE } from '../lib/constants.js';
import { planQueueActions, detectPlaybackIntent } from '../lib/agent-context.js';
// v1.18.0 TASK AUTHORIZATION DAEMON — purchase/deletion actions need the
// user's own text to authorize them; fault-shutdown + 3-hit honest exit.
import { authorizeAction, GUARDIAN_HIT_LIMIT } from '../lib/guardian-daemon.js';
import { strategyHintFor } from '../lib/field-matching.js';
import { sendToOffscreen } from '../lib/offscreen-client.js';
import { firewallStatusForInspector } from '../lib/privacy-firewall.js';

// v1.16.1: the loop cap now honors Settings → Max steps. The hardcoded 25
// meant the Settings slider silently did not apply to Privacy Mode.
const DEFAULT_MAX_STEPS = 25;
const MAX_STEPS_CAP = 100;

// ── SIH v1.14: FOUR-STATE ACTION VERIFICATION ACCOUNTING ─────────────────
// The old binary "verified / not verified" conflated two very different
// outcomes: "the verifier RAN and says nothing changed" and "the action
// failed to dispatch". The SIH brief requires the four states below. A
// verification failure must NOT automatically mean the browser action
// failed — it is reported as inconclusive (VERIFICATION_FAILED).
//   ACTION_EXECUTED      — dispatched without error; no verifier instrument
//   ACTION_VERIFIED      — dispatched AND an explicit verifier confirmed the effect
//   VERIFICATION_FAILED  — dispatched, verifier ran, could NOT confirm (inconclusive)
//   ACTION_FAILED        — dispatch itself threw / returned not-ok
// The state is emitted as a machine-parseable line for the E2E benchmark.
function verifyStateOf(result) {
  if (!result?.ok) return 'ACTION_FAILED';
  if (result?.changed === true) return 'ACTION_VERIFIED';
  // v1.15.1: a no-op that leaves the media in the REQUESTED state is a
  // verified outcome, not an inconclusive one (see actions.js alreadyInState).
  if (result?.alreadyInState) return 'ACTION_VERIFIED';
  if (result?.changed === false) return 'VERIFICATION_FAILED';
  return 'ACTION_EXECUTED';
}
function logVerifyState(step, action, result, extra = {}) {
  try {
    const state = verifyStateOf(result);
    const line = {
      step, state,
      action: String(action?.type || '?'),
      summary: String(result?.verification?.summary || result?.error || '').slice(0, 160),
      ...extra,
    };
    console.log('[Open Comet][VERIFY] ' + JSON.stringify(line));
  } catch { /* telemetry must never break the loop */ }
}

// SIH Phase 22: per-run latency aggregation (measured, never estimated).
// Emitted in the DONE summary → History + SIH Scorecard ACTUAL column.
const runTiming = { sanitizeMs: [], vlmMs: [], actionMs: [] };

// v1.16.1: bounded, abortable wait for a mid-run user reply (ask_user).
// Resolves with the reply text, '__aborted__' when the abort signal fires,
// or null when the wait window elapsed. Only notes that arrive AFTER the
// wait started are consumed — earlier notes stay for the next decision turn.
async function waitForUserReply(stateRef, signal, timeoutMs) {
  const t0 = Date.now();
  const baseLen = stateRef.userNotes.length;
  while (Date.now() - t0 < timeoutMs) {
    if (signal?.aborted) return '__aborted__';
    if (stateRef.userNotes.length > baseLen) {
      const fresh = stateRef.userNotes.splice(baseLen);
      const text = fresh.map(n => String(n?.text || '').trim()).filter(Boolean).join('\n- ');
      if (text) return text;
    }
    await sleep(500);
  }
  return null;
}

function latencyProfile(t) {
  const pct = (arr, q) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]);
  };
  return {
    steps: t.vlmMs.length,
    sanitize: { p50: pct(t.sanitizeMs, 0.5), p90: pct(t.sanitizeMs, 0.9) },
    vlm: { p50: pct(t.vlmMs, 0.5), p90: pct(t.vlmMs, 0.9) },
    action: { p50: pct(t.actionMs, 0.5), p90: pct(t.actionMs, 0.9) },
  };
}

/**
 * Run the privacy-aware agent loop for a single task.
 *
 * @param {object}  ctx
 * @param {string}  ctx.task        User's high-level goal
 * @param {number}  ctx.tabId       Active tab id
 * @param {object}  ctx.settings    Provider settings (provider/model/apiKey/…)
 * @param {function} ctx.onStep     Callback(stepType, text, payload)
 * @param {function} ctx.onDone     Callback(finalSummary)
 * @param {function} ctx.onError    Callback(err)
 * @param {AbortSignal} ctx.signal  Optional — aborts the loop
 */
export async function runPrivacyAgent(ctx) {
  const { task, settings, onStep, onDone, onError, signal } = ctx;
  // v1.15.1 ASK-BEFORE-ACTING: when the task started in 'ask' mode the SW
  // supplies approvalGate — the loop awaits it before EVERY browser action
  // (primary and queued). Verdicts: 'approved' | 'skip' | 'stop'.
  const askBeforeActing = Boolean(ctx.askBeforeActing) && typeof ctx.approvalGate === 'function';
  const approvalGate = askBeforeActing ? ctx.approvalGate : null;
  let tabId = ctx.tabId; // mutable — follows the live tab if the original is closed
  // v1.15 TAB-GROUP SANDBOX: live agent state (when the SW supplies it) —
  // gives tab actions real taskTabIds enforcement and the capture step the
  // sandbox member list. Legacy callers that omit it keep the old behavior.
  const stateRef = ctx.state || null;
  const sandboxTabIds = () => (Array.isArray(stateRef?.taskTabIds) && stateRef.taskTabIds.length ? stateRef.taskTabIds : null);
  const history = [];
  let stepCount = 0;
  const runT0 = Date.now();
  // ── SIH v1.15.2: PER-TASK PRIVACY CENSUS (measured, never estimated) ──
  // Totals across the FRESH frames of THIS run only (memo-reused frames are
  // identical pixels — not re-counted). Emitted in the DONE summary so the
  // SIH Scorecard's live per-task row / History report what THIS task
  // actually redacted, instead of only importing offline benchmark files.
  const runPii = { frames: 0, faces: 0, dom: 0, objects: 0, textPii: 0, ocr: 0, lastInspector: null };
  const caps = getProviderCapabilities(settings);
  // v1.11 loop governor: consecutive ineffective/failed PRIMARY actions drive
  // an escalating STRATEGY HINT into the next decision prompt. Field log: the
  // Gmail To-field failure looped 17 near-identical selector guesses (~10 min
  // of VLM time) because nothing told the model to change APPROACH.
  let stallCount = 0;
  let hintLevel = 0;
  let pendingHint = '';
  // v1.16.1: honor the user's max-steps setting (clamped to a sane range).
  const maxSteps = Math.max(1, Math.min(MAX_STEPS_CAP, Number(settings?.maxSteps) || DEFAULT_MAX_STEPS));

  // ── v1.18.0 TASK AUTHORIZATION DAEMON ────────────────────────────────────
  // Blocked purchase/deletion attempts in THIS run; the 3rd block ends the
  // task honestly. Mirrored into stateRef (agentState) for the SW-side UI.
  let guardianHits = Number(stateRef?.guardianHits) || 0;

  // Honest terminal exit for daemon faults and 3-hit exits — terminal step +
  // history entry + onDone (same finalize idiom as the v1.16.1 zombie fix).
  const finalizeGuardianStop = (message, step) => {
    history.push({ action: { type: 'guardian_stop' }, result: message, latencyMs: 0, step, blockedByGuardian: true });
    onStep?.(STEP_TYPE.DONE, message, { step, phase: 'guardian-stop' });
    console.warn('[Open Comet] Guardian stop:', message);
    onDone?.({
      steps: step,
      history,
      finalThought: message,
      finalAnswer: '',
      totalMs: Date.now() - runT0,
      latencyProfile: latencyProfile(runTiming),
      privacy: {
        frames: runPii.frames, faces: runPii.faces, dom: runPii.dom,
        objects: runPii.objects, textPii: runPii.textPii, ocr: runPii.ocr,
        redactions: runPii.faces + runPii.dom + runPii.objects + runPii.textPii + runPii.ocr,
        inspector: runPii.lastInspector,
      },
    });
  };

  // The ONLY inputs the daemon ever receives (injection prevention):
  // `task` — the user's task text, pinned at run start (loop-local const);
  // `stateRef.userNotes` — notes written exclusively by the user. Page text,
  // model reasoning and history are NEVER passed as authorization evidence.
  const guardianInputs = () => ({
    taskText: task,
    extraTexts: stateRef?.userNotes || [],
    hits: guardianHits,
  });

  try {
    onStep?.(STEP_TYPE.THINKING, 'Starting privacy-preserving agent loop…', {
      privacyEnabled: getPrivacySettings().enabled,
      backend: 'local-vision',
    });
    if (!caps.vision) {
      onStep?.(STEP_TYPE.THINKING, 'Selected model has no vision input — the agent will decide from sanitized page text instead of the screenshot.', { phase: 'vision-note' });
    }

    while (stepCount < maxSteps) {
      if (signal?.aborted) throw new Error('Agent aborted by user');
      const stepT0 = Date.now();
      stepCount++;

      // ── 1) Capture + sanitize ───────────────────────────────────────────
      // v1.8: THINKING (not SCREENSHOT) — the SW drops imageless SCREENSHOT steps
      // and the raw-broadcast fallback that used to render them is gone.
      onStep?.(STEP_TYPE.THINKING, `Capturing & sanitizing screen (step ${stepCount})…`, {
        step: stepCount, phase: 'capture-sanitize',
      });
      const sanitized = await captureAndSanitize(tabId, {}, { tabIds: sandboxTabIds() });
      // Follow the tab that was actually captured — survives the original
      // task tab being closed and keeps actions on the visible page.
      // v1.15: that follow is now sandbox-constrained (privacy-agent.js only
      // ever returns a tab inside { tabIds }, or throws honestly when the
      // sandbox is empty).
      if (Number.isInteger(sanitized.usedTabId) && sanitized.usedTabId !== tabId) {
        tabId = sanitized.usedTabId;
        onStep?.(STEP_TYPE.THINKING, 'Following the newly selected tab…', { step: stepCount, phase: 'tab-followed', tabId });
      }
      // v1.15 TAB-GROUP SANDBOX: the visible/active tab drifted OUT of the
      // task group mid-run (user clicked another tab, or a page stole focus).
      // captureVisibleTab photographs the ACTIVE tab — the capture layer
      // re-focused the sandbox tab instead of photographing a foreign page.
      if (sanitized.sandboxRefocused) {
        onStep?.(STEP_TYPE.MUTED, 'Active tab left the task group — re-focused the task tab so the capture stays inside the sandbox.', { step: stepCount, phase: 'sandbox-refocus' });
      }

      // ── SIH v1.15.2: per-task privacy census (fresh frames only) ───────
      if (sanitized.stats?.counts && !sanitized.stats?.reusedShot) {
        runPii.frames += 1;
        runPii.faces   += sanitized.stats.counts.faces || 0;
        runPii.dom     += sanitized.stats.counts.domSensitive || 0;
        runPii.objects += sanitized.stats.counts.objects || 0;
        runPii.textPii += sanitized.stats.counts.textPii || 0;
        runPii.ocr     += sanitized.stats.counts.ocrPii || 0;
      }
      runPii.lastInspector = sanitized.privacy
        ? firewallStatusForInspector(sanitized.privacy, (sanitized.sanitizedDataUrl || '').length)
        : runPii.lastInspector;

      // Keep the offscreen ML runtime warm while a privacy-ON run is active:
      // long VLM turns (30–180 s each) can otherwise let its 5-minute idle
      // timer fire mid-run, forcing a full model reload (10–15 s) on a later
      // step. Fire-and-forget; never block the loop on this.
      if (getPrivacySettings().enabled) {
        sendToOffscreen({ type: 'ML_TOUCH' }).catch(() => {});
      }

      // v1.10 shot reuse: when the page fingerprint is unchanged, the
      // previous screenshot is re-used — don't push a duplicate SCREENSHOT
      // row into the chat; tell the user why the image is identical instead.
      if (sanitized.stats?.reusedShot) {
        onStep?.(STEP_TYPE.THINKING, `Page unchanged since the previous screenshot — reusing it (no capture, no upload, no extra image tokens${sanitized.stats.reuseStreak ? `, streak ${sanitized.stats.reuseStreak}` : ''})`, {
          step: stepCount, phase: 'shot-reused',
          stats: sanitized.stats, page: sanitized.page,
        });
      } else {
        onStep?.(STEP_TYPE.SCREENSHOT, `Sanitized in ${sanitized.stats.totalMs} ms`, {
          step: stepCount,
          phase: 'sanitized',
          stats: sanitized.stats,
          page: sanitized.page,
          // SIH Phase 25: REAL Privacy Inspector payload (firewall envelope).
          inspector: sanitized.privacy
            ? firewallStatusForInspector(sanitized.privacy, (sanitized.sanitizedDataUrl || '').length)
            : null,
          // v1.8: imageDataUrl (not just previewDataUrl) — pushStep DROPS
          // SCREENSHOT steps without imageDataUrl, so the sanitized screenshot
          // never reached the chat. The sidepanel renders it as the same
          // clickable thumbnail the non-privacy loop shows — with the REDACTED
          // pixels (blurred faces / black bars), never the raw capture.
          imageDataUrl: sanitized.sanitizedDataUrl,
          previewDataUrl: sanitized.sanitizedDataUrl,
        });
      }
      // ── Page/DOM diagnostics in the console (debugging aid, user-requested)
      console.log(`[Open Comet] Step ${stepCount} page state · url=${sanitized.page?.url || '?'} · title="${sanitized.page?.title || ''}" · ` +
        `videos=${(sanitized.page?.videos || []).length} (playing=${(sanitized.page?.videos || []).filter(v => !v.paused).length}) · ` +
        `redactions: faces=${sanitized.stats?.counts?.faces ?? 0} dom=${sanitized.stats?.counts?.domSensitive ?? 0} yoloObj=${sanitized.stats?.counts?.objects ?? 0} textPii=${sanitized.stats?.counts?.textPii ?? 0} · ` +
        `sanitize=${sanitized.stats?.totalMs}ms`);

      // ── 2) Ask the model for next action (server or fully on-device) ────
      const isOnDevice = String(settings?.provider || '').toLowerCase() === 'local';
      onStep?.(STEP_TYPE.API, isOnDevice
        ? 'Asking on-device model for next action (nothing leaves the browser)…'
        : 'Asking VLM for next action (server is redaction-aware)…', {
        step: stepCount, phase: isOnDevice ? 'ondevice-decide' : 'server-decide',
      });
      // v1.15.1 LIVE USER CONTEXT: drain notes the user typed mid-run and
      // inject them into THIS decision prompt ("Add context while task
      // running"). Consumed exactly once — no re-injection on later steps.
      const pendingNotes = Array.isArray(stateRef?.userNotes) ? stateRef.userNotes.splice(0) : [];
      const userContext = pendingNotes.map(n => String(n?.text || '').trim()).filter(Boolean).slice(-4).join('\n- ');
      if (userContext) {
        console.log(`[Open Comet] Step ${stepCount}: injecting ${pendingNotes.length} user note(s) into the decision prompt`);
      }
      const decision = await decideViaServer(sanitized, task, history, settings, { strategyHint: pendingHint, userNotes: userContext, profileData: settings?.profileData || null });
      runTiming.sanitizeMs.push(sanitized.stats?.totalMs || 0);
      runTiming.vlmMs.push(decision.networkLatencyMs || 0);

      onStep?.(STEP_TYPE.API, `VLM responded in ${decision.networkLatencyMs} ms (backend: ${decision.backend})`, {
        step: stepCount, phase: 'server-responded',
        backend: decision.backend,
        networkLatencyMs: decision.networkLatencyMs,
        manifestSummary: decision.manifestSummary,
      });

      // ── 3) Parse + execute ──────────────────────────────────────────────
      const plan = decision.actionPlan || {};
      // `let` (SIH): may be re-bound by the secret-echo guard when a typed
      // value landed in a sensitive field.
      let action = plan.action || { type: 'ask_user' };

      onStep?.(STEP_TYPE.THINKING, `VLM: ${plan.thought || '(no reasoning)'}`, {
        step: stepCount, phase: 'thought', confidence: plan.confidence,
      });

      if (plan.is_complete || action.type === 'done') {
        history.push({ action, result: 'complete' });
        const totalMs = Date.now() - runT0;
        // v1.15.6 FINAL RESPONSE: for information/summary tasks the answer text
        // (action.message) IS the deliverable. Carry it end-to-end — result
        // card, History entry — instead of ending on a bare "Task complete".
        const finalAnswer = String(action?.message || action?.summary || action?.text || plan?.answer || '').trim();
        if (finalAnswer) {
          onStep?.(STEP_TYPE.PLAN_READY, `Final answer ready (${finalAnswer.length} chars) — shown below`, { step: stepCount, phase: 'final-answer' });
        }
        onStep?.(STEP_TYPE.DONE, 'Task complete', { step: stepCount, history, totalMs, finalAnswer });
        console.log(`[Open Comet] Task complete · ${stepCount} step(s) · total ${(totalMs / 1000).toFixed(1)}s`);
        onDone?.({
          steps: stepCount,
          history,
          finalThought: plan.thought,
          finalAnswer,
          totalMs,
          totalLatencyMs: history.reduce((a, h) => a + (h.latencyMs || 0), 0),
          // SIH Phase 22: measured P50/P90 latency profile for this run.
          latencyProfile: latencyProfile(runTiming),
          // SIH v1.15.2: measured per-task privacy census (see runPii).
          privacy: {
            frames: runPii.frames, faces: runPii.faces, dom: runPii.dom,
            objects: runPii.objects, textPii: runPii.textPii, ocr: runPii.ocr,
            redactions: runPii.faces + runPii.dom + runPii.objects + runPii.textPii + runPii.ocr,
            inspector: runPii.lastInspector,
          },
        });
        return;
      }

      if (action.type === 'ask_user') {
        onStep?.(STEP_TYPE.PLAN_READY, `VLM is asking the user: ${action.message || plan.thought}`, {
          step: stepCount, phase: 'ask_user', action,
        });
        // ── v1.16.1 FIX: ZOMBIE RUN. This was a bare `return` — the loop
        // ended without onDone/onError/history, leaving agentState.running
        // true, the PRV badge up and the run keepalive immortal. Worse, the
        // firewall's fail-closed path (privacyBlockedDecision) returns
        // EXACTLY this shape, so every network-gate block produced a zombie
        // run. Two honest paths now:
        //   • privacyBlocked → TERMINAL: the user cannot unblock this turn,
        //     so finalize immediately with the block explanation.
        //   • genuine question → PAUSE: wait (bounded, abortable) for the
        //     user's reply via the sidepanel context box, then continue.
        const question = String(action.message || plan.thought || '').trim();
        if (action.privacyBlocked || plan.privacyBlocked) {
          history.push({
            action,
            result: 'blocked by the privacy firewall — nothing was transmitted',
            latencyMs: decision.networkLatencyMs || 0,
            step: stepCount,
          });
          onStep?.(STEP_TYPE.DONE, 'Privacy firewall blocked this turn — task ended. Nothing was transmitted.', {
            step: stepCount, phase: 'privacy-blocked', action,
          });
          onDone?.({
            steps: stepCount,
            history,
            finalThought: plan.thought || 'Privacy firewall blocked this turn.',
            finalAnswer: question,
            totalMs: Date.now() - runT0,
            latencyProfile: latencyProfile(runTiming),
            privacy: {
              frames: runPii.frames, faces: runPii.faces, dom: runPii.dom,
              objects: runPii.objects, textPii: runPii.textPii, ocr: runPii.ocr,
              redactions: runPii.faces + runPii.dom + runPii.objects + runPii.textPii + runPii.ocr,
              inspector: runPii.lastInspector,
            },
          });
          return;
        }
        if (stateRef && Array.isArray(stateRef.userNotes)) {
          onStep?.(STEP_TYPE.THINKING, 'Waiting for your reply — type it in the context box, or press Stop to end the task (auto-ends in 5 minutes).', {
            step: stepCount, phase: 'ask-user-wait', action,
          });
          const reply = await waitForUserReply(stateRef, signal, 5 * 60 * 1000);
          if (reply === '__aborted__') throw new Error('Agent aborted by user');
          if (reply == null) {
            history.push({
              action,
              result: 'no user response within the 5-minute wait window — task ended',
              latencyMs: decision.networkLatencyMs || 0,
              step: stepCount,
            });
            onStep?.(STEP_TYPE.DONE, 'No user response within 5 minutes — task ended.', { step: stepCount, phase: 'ask-user-timeout' });
            onDone?.({
              steps: stepCount,
              history,
              finalThought: 'ask_user timed out (no user response)',
              finalAnswer: '',
              totalMs: Date.now() - runT0,
              latencyProfile: latencyProfile(runTiming),
              privacy: {
                frames: runPii.frames, faces: runPii.faces, dom: runPii.dom,
                objects: runPii.objects, textPii: runPii.textPii, ocr: runPii.ocr,
                redactions: runPii.faces + runPii.dom + runPii.objects + runPii.textPii + runPii.ocr,
                inspector: runPii.lastInspector,
              },
            });
            return;
          }
          history.push({
            action,
            result: `answered by the user: ${String(reply).substring(0, 300)}`,
            latencyMs: decision.networkLatencyMs || 0,
            step: stepCount,
          });
          onStep?.(STEP_TYPE.THINKING, `Reply received — continuing with it.`, { step: stepCount, phase: 'ask-user-answered' });
          continue;   // fresh capture + decision with the reply in history
        }
        // No way to receive a reply (legacy caller without live state) →
        // finalize honestly instead of leaving a zombie run.
        onDone?.({
          steps: stepCount,
          history,
          finalThought: plan.thought || 'Model asked the user a question.',
          finalAnswer: question,
          totalMs: Date.now() - runT0,
          latencyProfile: latencyProfile(runTiming),
          privacy: {
            frames: runPii.frames, faces: runPii.faces, dom: runPii.dom,
            objects: runPii.objects, textPii: runPii.textPii, ocr: runPii.ocr,
            redactions: runPii.faces + runPii.dom + runPii.objects + runPii.textPii + runPii.ocr,
            inspector: runPii.lastInspector,
          },
        });
        return;
      }

      // ── v1.18.0 TASK AUTHORIZATION DAEMON (primary action) ──────────────
      // Purchase/delete clicks need authorization from the user's OWN text —
      // negated tasks ("do not purchase anything") are blocked too. Rejected
      // BEFORE the approval gate / executor. A block also OVERRIDES any
      // speculative queue for the next turn via the strategy hint.
      {
        const auth = authorizeAction(action, guardianInputs());
        if (typeof auth.hit === 'number') { guardianHits = auth.hit; if (stateRef) stateRef.guardianHits = guardianHits; }
        if (auth.fatal || auth.exit) {
          finalizeGuardianStop(
            auth.fatal ? auth.userMessage : `${auth.userMessage} (3 unauthorized attempts — task ended honestly; nothing risky was executed)`,
            stepCount,
          );
          return;
        }
        if (auth.skip) {
          history.push({ action, result: `BLOCKED by the Task Authorization Guardian — ${auth.verdict.reason}`, latencyMs: 0, step: stepCount, blockedByGuardian: true });
          onStep?.(STEP_TYPE.EXECUTING, `${auth.userMessage} (attempt ${auth.hit}/${GUARDIAN_HIT_LIMIT}) — a fresh decision follows. To allow it, put it in your own words: edit the task or send a note.`, { step: stepCount, phase: 'guardian-blocked', action });
          pendingHint = auth.hint;   // OVERRIDES speculative next-turn guidance
          console.warn(`[Open Comet] Step ${stepCount}: guardian BLOCKED ${describeAction(action)} (${auth.hit}/${GUARDIAN_HIT_LIMIT})`);
          await sleep(300);
          continue;
        }
      }

      onStep?.(STEP_TYPE.ACTION, `Executing: ${describeAction(action)}`, {
        step: stepCount, phase: 'execute', action,
      });

      // ── v1.15.1 ASK-BEFORE-ACTING: per-action approval gate ────────────
      // 'ask' mode pauses BEFORE every browser action; the sidepanel shows
      // an approval card. Approved → run · Skipped → honest history entry +
      // a fresh model decision next step · Stop → normal abort path.
      if (approvalGate) {
        onStep?.(STEP_TYPE.THINKING, 'Ask before acting: waiting for your approval…', { step: stepCount, phase: 'approval-wait', action });
        const verdict = await approvalGate(action, stepCount);
        if (verdict === 'stop') throw new Error('Agent aborted by user');
        if (verdict === 'skip') {
          history.push({ action, result: 'skipped by the user (Ask before acting)', latencyMs: 0, step: stepCount });
          onStep?.(STEP_TYPE.EXECUTING, 'Action skipped by you — asking the model for a different approach…', { step: stepCount, phase: 'approval-skipped', action });
          console.log(`[Open Comet] Step ${stepCount}: action skipped by user (ask-before-acting)`);
          await sleep(300);
          continue;
        }
        onStep?.(STEP_TYPE.EXECUTING, 'Action approved — executing…', { step: stepCount, phase: 'approval-granted', action });
      }

      let result;
      const actT0 = Date.now();
      try {
        // v1.15 TAB-GROUP SANDBOX: pass the LIVE state (not a throwaway) so
        // tab actions (new_tab/switch_tab/close_tab/list_tabs/organize_tabs)
        // enforce taskTabIds membership and keep new tabs inside the group.
        result = await executeAction(tabId, action, stateRef || { settings });
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      const actMs = Date.now() - actT0;

      // ── SIH: SECRET ECHO GUARD — a typed value that went into a sensitive
      // field (password/OTP/CVV) must never reach the next VLM prompt via
      // history. Mask it HERE, at the source.
      if (result?.fieldSensitive && action.type !== 'done') {
        action = { ...action, text: '••••••', value: undefined, masked: 'sensitive-field' };
        console.log('[Open Comet] Typed value into a SENSITIVE field — history entry masked');
      }
      runTiming.actionMs.push(actMs);

      // ── Honest result accounting: the model MUST know when a click was
      // dispatched but had zero effect on the page (YouTube players ignore
      // synthetic clicks) — otherwise it declares victory while the video
      // keeps playing (user-reported bug).
      const noEffect = result?.ok && result?.changed === false && !result?.alreadyInState;
      let resultText;
      if (!result?.ok) {
        resultText = 'failed — ' + (result?.error || 'unknown');
      } else if (result?.alreadyInState) {
        // v1.15.1 honest accounting (field log: "media play" on an ALREADY
        // playing video reported NO CHANGE → the model burned a full extra
        // turn re-playing). Verified no-op ≠ verification failure.
        resultText = 'ok — verified: the media was ALREADY in the requested state (nothing to do — do NOT repeat this action)';
      } else if (noEffect) {
        resultText = 'executed without errors, but VERIFICATION showed NO visible change on the page (the click likely had no effect — try a different approach)';
      } else {
        resultText = 'ok — verified: page state changed';
      }

      history.push({
        action,
        result: resultText,
        latencyMs: decision.networkLatencyMs,
        step: stepCount,
        ...(result?.fieldType ? { fieldType: result.fieldType } : {}),
        ...(result?.verification ? { verify: { changed: result.changed, summary: result.verification.summary } } : {}),
      });

      onStep?.(STEP_TYPE.EXECUTING, `Action result: ${resultText} (${actMs} ms)`, {
        step: stepCount, phase: 'executed', action, result: { ...result, dataUrl: undefined },
      });
      logVerifyState(stepCount, action, result);

      // ── v1.11 loop governor: escalate strategy when the target keeps
      // failing. A verified success resets the ladder. Level mapping:
      //   2 stalls → level 1 (expand collapsed group / type into focused)
      //   4 stalls → level 2 (keyboard Tab / pre-filling URL)
      //   6 stalls → level 3 (keyboard submit shortcut, then verify done)
      const stalled = !result?.ok || noEffect;
      if (stalled) stallCount++; else { stallCount = 0; }
      const newLevel = stallCount >= 6 ? 3 : stallCount >= 4 ? 2 : stallCount >= 2 ? 1 : 0;
      pendingHint = strategyHintFor(newLevel, stallCount);
      if (newLevel > hintLevel && newLevel >= 1) {
        const msgs = {
          1: `⚠️ Same target keeps failing (${stallCount}×). Next turn the model is told to expand collapsed form groups (e.g. a "Recipients" chip) or type into the already-focused field.`,
          2: `⚠️ Target still stuck (${stallCount}×). Next turn hint: switch to keyboard navigation (Tab / Shift+Tab + type into focused) or a pre-filling URL instead of more selector guesses.`,
          3: `⚠️ Still stuck (${stallCount}×). Next turn hint: use the app's keyboard submit shortcut (Ctrl+Enter / Enter), verify from the result, and finish if the goal is already visible.`,
        };
        onStep?.(STEP_TYPE.THINKING, msgs[newLevel], { step: stepCount, phase: 'strategy-hint', level: newLevel, stalls: stallCount });
        console.warn(`[Open Comet] Step ${stepCount}: stall governor → level ${newLevel} after ${stallCount} ineffective step(s)`);
      }
      hintLevel = newLevel;

      // ── v1.9 AUTO-MEDIA RECOVERY (no VLM call) ───────────────────────────
      // Field log: "click play glyph → no effect → VLM burns 2–3 full turns
      // rediscovering the media action each time (~2.5 min)". When the click
      // was playback-related, verified ineffective, and a <video> exists
      // (even hidden), drive the media element DIRECTLY right now and feed
      // the honest result into history — the next VLM turn starts from truth.
      const verifySummary = String(result?.verification?.summary || '');
      const videoCountMatch = /videos=(\d+)/.exec(verifySummary);
      const videosSeen = videoCountMatch ? Number(videoCountMatch[1]) > 0 : /video#/i.test(verifySummary);
      if (noEffect && videosSeen) {
        const cmd = detectPlaybackIntent(action, plan.thought || '');
        if (cmd) {
          try {
            const tR = Date.now();
            const r2 = await executeAction(tabId, { type: 'media', command: cmd }, stateRef || { settings });
            const r2Text = r2?.ok
              ? `auto-recovery: the ineffective click was replaced by media ${cmd} — ${r2?.state ? `now paused=${r2.state.paused} muted=${r2.state.muted}` : 'executed'} (no VLM call needed)`
              : `auto-recovery attempted media ${cmd} — failed: ${r2?.reason || r2?.error || 'unknown'}`;
            history.push({
              action: { type: 'media', command: cmd, auto: true },
              result: r2Text,
              latencyMs: 0,
              step: stepCount,
              ...(r2?.verification ? { verify: { changed: r2.changed, summary: r2.verification.summary } } : {}),
            });
            onStep?.(STEP_TYPE.EXECUTING, `${r2Text} (${Date.now() - tR} ms)`, {
              step: stepCount, phase: 'auto-media', action: { type: 'media', command: cmd },
              result: { ...r2, dataUrl: undefined },
            });
            logVerifyState(stepCount, { type: 'media', command: cmd }, r2, { auto: true });
            console.log(`[Open Comet] Step ${stepCount}: auto-media recovery (${cmd}) → ${r2?.ok ? 'executed' : 'failed: ' + (r2?.reason || '?')}`);
          } catch (e) {
            console.warn(`[Open Comet] Step ${stepCount}: auto-media recovery threw:`, e?.message || e);
          }
        }
      }

      // ── v1.9 SPECULATIVE QUEUE (no VLM call per extra action) ────────────
      // The decision JSON may pre-authorize up to 2 follow-up actions that
      // the model believes still apply once the primary action VERIFIES.
      // We execute them in order, verifying each; the first "no visible
      // change"/failure drops the rest. Each consumed queue item becomes its
      // own step + history entry (latencyMs 0 — no VLM was involved), so a
      // 12-step task like the field log can shrink to ~5 VLM turns.
      const queue = (result?.ok && result?.changed !== false) ? planQueueActions(plan) : [];
      for (const qAction of queue) {
        if (signal?.aborted) break;
        // ── v1.18.0 TASK AUTHORIZATION DAEMON (speculative queue) ─────────
        // Queued actions are SPECULATIVE (no fresh VLM turn) — they get the
        // same gate, and a block OVERRIDES the rest of the queue: nothing
        // risky rides behind an approved one.
        {
          const qAuth = authorizeAction(qAction, guardianInputs());
          if (typeof qAuth.hit === 'number') { guardianHits = qAuth.hit; if (stateRef) stateRef.guardianHits = guardianHits; }
          if (qAuth.fatal || qAuth.exit) {
            finalizeGuardianStop(
              qAuth.fatal ? qAuth.userMessage : `${qAuth.userMessage} (3 unauthorized attempts — task ended honestly; nothing risky was executed)`,
              stepCount + 1,
            );
            return;
          }
          if (qAuth.skip) {
            history.push({ action: qAction, result: `BLOCKED by the Task Authorization Guardian — ${qAuth.verdict.reason}`, latencyMs: 0, step: stepCount + 1, queued: true, blockedByGuardian: true });
            onStep?.(STEP_TYPE.EXECUTING, `${qAuth.userMessage} (attempt ${qAuth.hit}/${GUARDIAN_HIT_LIMIT}) — the remaining speculative queue was discarded.`, { step: stepCount + 1, phase: 'guardian-blocked-queued', action: qAction, queued: true });
            pendingHint = qAuth.hint;
            console.warn(`[Open Comet] Step ${stepCount}: guardian BLOCKED queued ${describeAction(qAction)} — queue overridden`);
            break;   // OVERRIDE: drop the remaining speculative queue
          }
        }
        // v1.15.1 ASK-BEFORE-ACTING: queued actions are real browser actions
        // — they get the same approval gate as primary ones.
        if (approvalGate) {
          const qVerdict = await approvalGate(qAction, stepCount + 1);
          if (qVerdict === 'stop') throw new Error('Agent aborted by user');
          if (qVerdict === 'skip') {
            history.push({ action: qAction, result: 'skipped by the user (Ask before acting)', latencyMs: 0, step: stepCount + 1, queued: true });
            onStep?.(STEP_TYPE.EXECUTING, 'Queued action skipped by you — falling back to a fresh VLM decision next step.', { step: stepCount + 1, phase: 'approval-skipped', action: qAction, queued: true });
            break;
          }
        }
        stepCount++;
        onStep?.(STEP_TYPE.ACTION, `Queued action (no VLM call): ${describeAction(qAction)}`, {
          step: stepCount, phase: 'execute-queued', action: qAction, queued: true,
        });
        const qT0 = Date.now();
        let qResult;
        try {
          qResult = await executeAction(tabId, qAction, stateRef || { settings });
        } catch (err) {
          qResult = { ok: false, error: err.message };
        }
        const qMs = Date.now() - qT0;
        const qNoEffect = qResult?.ok && qResult?.changed === false;
        const qText = !qResult?.ok
          ? 'failed — ' + (qResult?.error || 'unknown')
          : qNoEffect
            ? 'executed without errors, but VERIFICATION showed NO visible change on the page (queued action likely had no effect)'
            : 'ok — verified: page state changed';
        history.push({
          action: qAction,
          result: qText,
          latencyMs: 0,
          step: stepCount,
          queued: true,
          ...(qResult?.verification ? { verify: { changed: qResult.changed, summary: qResult.verification.summary } } : {}),
        });
        onStep?.(STEP_TYPE.EXECUTING, `Queued action result: ${qText} (${qMs} ms)`, {
          step: stepCount, phase: 'executed-queued', action: qAction, result: { ...qResult, dataUrl: undefined }, queued: true,
        });
        logVerifyState(stepCount, qAction, qResult, { queued: true });
        console.log(`[Open Comet] Step ${stepCount} (queued, no VLM) ${describeAction(qAction)} → ${qText} (${qMs}ms)`);
        if (!qResult?.ok || qNoEffect) {
          console.log('[Open Comet] Queue aborted — falling back to a fresh VLM decision next step');
          break;
        }
        await sleep(400); // small settle between queued actions
      }

      // Guidance nudge: a failed media-adjacent click → suggest the direct
      // media action so the very next VLM turn can recover instead of
      // repeating the same ineffective click.
      const videosStillThere = (result?.verification?.summary || '').toLowerCase().includes('video#')
        || /video/i.test(String(action.selector || ''));
      if (noEffect && videosStillThere) {
        onStep?.(STEP_TYPE.THINKING, '⚠️ Click had no visible effect (playback state unchanged). If the goal is to pause/play/mute, the next step will use the direct "media" action on the <video> element instead of clicking the player.', {
          step: stepCount, phase: 'click-no-effect',
        });
        console.warn(`[Open Comet] Step ${stepCount}: click "${action.selector}" had NO effect — media fallback advised`);
      }

      console.log(`[Open Comet] Step ${stepCount} took ${((Date.now() - stepT0) / 1000).toFixed(1)}s (sanitize ${sanitized.stats?.totalMs}ms · VLM ${decision.networkLatencyMs}ms · action ${actMs}ms)`);

      // Small delay for the page to settle
      await sleep(800);
    }

    onDone?.({
      steps: stepCount,
      history,
      finalThought: 'Max steps reached',
      totalMs: Date.now() - runT0,
      // SIH v1.15.2: same privacy census on the max-steps exit path.
      latencyProfile: latencyProfile(runTiming),
      privacy: {
        frames: runPii.frames, faces: runPii.faces, dom: runPii.dom,
        objects: runPii.objects, textPii: runPii.textPii, ocr: runPii.ocr,
        redactions: runPii.faces + runPii.dom + runPii.objects + runPii.textPii + runPii.ocr,
        inspector: runPii.lastInspector,
      },
    });
  } catch (err) {
    onError?.(err);
  }
}
