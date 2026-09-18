// -----------------------------------------------------------------------------
// src/background/sw.js
// Service-worker entry point.  Orchestrates the agent loop; delegates
// DOM actions, AI calls, storage, and state to focused modules.
// -----------------------------------------------------------------------------

import { callAI, callAIRaw, getProviderCapabilities, isProviderConfigured }   from '../lib/providers.js';
import { isSihMode, sihRawScreenshotDecision } from '../lib/sih-mode.js';
import {
  deepResearch,
  buildDecompositionPrompt,
  buildSynthesisPrompt,
  buildBrowserSourceAnalysisPrompt,
  buildScrapeExtractionPrompt,
} from '../lib/deepsearch.js';
import { getSettings, saveSettings as persistSettings, getHistory, appendHistory, clearHistory, initStorage, appendExport, recordTokenUsage, clearTokenUsage, serializeStorageWrite, STATE_VERSION } from '../lib/storage.js';
import { sleep, getHostFromUrl, normalizeHost, parseJSON } from '../lib/utils.js';
import { MSG, STATUS, STEP_TYPE, PROTECTED_ACTION_LABELS, MODEL_PRICING } from '../lib/constants.js';
import { buildSearchUrl, openResearchTab, scrapeSearchResults, scrapeReadablePage, closeTabs } from '../lib/browser-research.js';
import { downloadExportFile } from '../lib/export.js';
// v1.18.0 TASK AUTHORIZATION DAEMON — purchase/deletion actions need the
// user's own text to authorize them; fault-shutdown + 3-hit honest exit.
import { authorizeAction, GUARDIAN_HIT_LIMIT } from '../lib/guardian-daemon.js';
import { buildHistoryCompactionPrompt, buildNavigatorRequest, buildPlannerRequest, shouldRetryCompactAction } from '../lib/agent-messages.js';
import {
  AGENT_ROLE,
  AGENT_HOOK,
  compactPageContext,
  getCheckpointForAction,
  describeCheckpoint,
  shouldVerifyAction,
  verifyActionAgainstPage,
} from '../lib/agent-runtime.js';
import { enrichCapturedPageInfo, getLoopPageSignature, getScreenshotOverlayItems } from '../lib/page-state.js';
import { createEmptyAgentState } from './state.js';
import { executeAction, describeAction, getMonitors, saveMonitors, fetchPageText, isMailHostTab } from './actions.js';
import { toChatTemplateTools } from '../lib/tool-schemas.js';
import { runPrivacyAgent } from './privacy-loop.js';
// v1.15 TAB-GROUP SANDBOX: single source of truth for the task boundary
// (shared with actions.js so grouping + enforcement can never drift apart).
import { ensureTaskGroup } from '../lib/tab-sandbox.js';
import { configurePrivacy, getPrivacySettings, captureAndSanitize, getLastPrivacyRun, getCumulativePrivacyStats } from '../lib/privacy-agent.js';
import { listLocalModels, downloadLocalModel, deleteLocalModel, getLocalDevice } from '../lib/local-llm.js';
import { ensureOffscreen, sendToOffscreen, warmupVisionModels } from '../lib/offscreen-client.js';
import { detectSkillsForTask } from '../lib/skill-matcher.js';
import { getAllSkills } from '../lib/skills.js';
import { loadLibrarySkills } from '../lib/skill-library.js';
import { createLogger, installGlobalErrorTraps } from '../core/logger.js';

// -- Diagnostics loggers -------------------------------------------------------
// Every context logs with a [Open Comet:<ns>] tag. warn/error lines also reach
// the sidepanel console through the DIAG_LOG relay, so ONE DevTools window
// shows downloads, API errors, model-request errors, limits and busy states.
const logSW     = createLogger('SW',      { relayType: 'DIAG_LOG', relayLevel: 'warn' });
const logRouter = createLogger('Router',  { relayType: 'DIAG_LOG', relayLevel: 'warn' });
const logAgent  = createLogger('Agent',   { relayType: 'DIAG_LOG', relayLevel: 'warn' });
const logLimits = createLogger('Limits',  { relayType: 'DIAG_LOG', relayLevel: 'warn' });
const logBusy   = createLogger('Busy',    { relayType: 'DIAG_LOG', relayLevel: 'warn' });
const logML     = createLogger('LocalML', { relayType: 'DIAG_LOG', relayLevel: 'warn' });

// -- Global agent state --------------------------------------------------------
let agentState = createEmptyAgentState();
// v1.16.1 START TOCTOU GUARD: `running` was checked BEFORE several awaits and
// only set AFTER them, so two rapid START_AGENT messages (double-click) could
// both pass the check and run two concurrent agent loops over one state.
// This synchronous flag closes the window between the check and the state
// swap; it is released when the handler exits (success or failure).
let _startBusy = false;

function trackUsage(usage) {
  if (!usage) return;
  const { model, promptTokens, completionTokens, totalTokens } = usage;
  const pricing = MODEL_PRICING[model] || { prompt: 0, completion: 0 };
  const cost = ((promptTokens || 0) / 1000000) * pricing.prompt + ((completionTokens || 0) / 1000000) * pricing.completion;
  
  if (agentState && agentState.taskUsage) {
    agentState.taskUsage.promptTokens += (promptTokens || 0);
    agentState.taskUsage.completionTokens += (completionTokens || 0);
    agentState.taskUsage.totalTokens += (totalTokens || 0);
    agentState.taskUsage.cost += cost;
  }
  recordTokenUsage(model, promptTokens, completionTokens, totalTokens, cost).catch(() => {});
}

// -- Lifecycle -----------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async () => {
  await initStorage();
  // v1.17.0: Firefox has no chrome.sidePanel — the toolbar button falls back
  // to opening the panel as a regular tab (see the onClicked listener below).
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
});

chrome.action.onClicked.addListener(tab => {
  if (chrome.sidePanel?.open) {
    chrome.sidePanel.open({ tabId: tab.id });
    return;
  }
  // v1.17.0 FIREFOX: the sidebar opens as a tab — same sidepanel.html, same
  // module UI, no sidePanel API required.
  try {
    chrome.tabs.create({
      url: chrome.runtime.getURL('src/sidepanel/sidepanel.html'),
      index: Number.isInteger(tab?.index) ? tab.index + 1 : undefined,
    });
  } catch (err) {
    console.error('[Open Comet] Could not open the panel as a tab:', err?.message || err);
  }
});

// -- Tab event tracking --------------------------------------------------------
chrome.tabs.onCreated.addListener(async tab => {
  if (!agentState.running || !Number.isInteger(tab.openerTabId)) return;
  if (!agentState.taskTabIds.includes(tab.openerTabId)) return;
  agentState.taskTabIds = [...new Set([...agentState.taskTabIds, tab.id])];
  rememberTab(tab);
  await groupTaskTabs([tab.id]);
  if (tab.active) agentState.agentTabId = tab.id;
});

chrome.tabs.onRemoved.addListener(tabId => {
  if (!agentState.taskTabIds.includes(tabId)) return;
  agentState.taskTabIds = agentState.taskTabIds.filter(id => id !== tabId);
  delete agentState.taskTabGraph[tabId];
  if (agentState.agentTabId === tabId) {
    agentState.agentTabId = agentState.taskTabIds.at(-1) ?? agentState.currentTabId;
  }
});

// -- Message router ------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  // Messages addressed to the offscreen ML document are handled there —
  // never route them here (they would double-execute).
  if (msg && msg.target === 'offscreen') return;

  // Offscreen runtime asks us to close it after a long idle period.
  if (msg && msg.type === 'OFFSCREEN_CLOSE_REQUEST') {
    if (chrome.offscreen?.closeDocument) {
      chrome.offscreen.closeDocument().then(
        () => console.log('[Open Comet] Offscreen ML runtime closed (idle).'),
        () => {}
      );
    } else if (typeof document !== 'undefined') {
      // v1.17.0 FIREFOX in-page mode: teardown = removing the hidden iframe.
      document.getElementById('opencomet-ml-frame')?.remove();
      console.log('[Open Comet] In-page ML runtime closed (idle).');
    }
    return;
  }

  const routes = {
    [MSG.START_AGENT]:       () => handleStart(msg, respond),
    [MSG.STOP_AGENT]:        () => handleStop(respond),
    [MSG.RESET_AGENT_STATE]: () => handleReset(respond),
    [MSG.APPROVE_PLAN]:      () => handleApprovePlan(msg.plan, respond),
    [MSG.REJECT_PLAN]:       () => handleStop(respond),
    [MSG.RESOLVE_APPROVAL]:  () => handleResolveApproval(msg, respond),
    [MSG.ADD_USER_NOTE]:     () => handleUserNote(msg.note, respond),
    [MSG.GET_STATE]:         () => respond({ state: agentState }),
    [MSG.SAVE_SETTINGS]:     () => persistSettings(msg.settings).then(() => respond({ ok: true })),
    [MSG.GET_SETTINGS]:      () => getSettings().then(s => respond({ settings: s })),
    [MSG.GET_OLLAMA_MODELS]: () => handleGetOllamaModels(msg, respond),
    [MSG.GET_HISTORY]:       () => getHistory().then(h => respond({ history: h })),
    [MSG.CLEAR_HISTORY]:     () => clearHistory().then(() => respond({ ok: true })),
    'CLEAR_TOKEN_USAGE':     () => clearTokenUsage().then(() => respond({ ok: true })),
    [MSG.DEEP_RESEARCH]:     () => handleDeepResearch(msg, respond),
    [MSG.SUMMARIZE_PAGE]:    () => handleSummarizePage(msg, respond),
    [MSG.SCRAPE_PAGE]:       () => handleScrapePage(msg, respond),
    [MSG.AUTO_SCRAPE]:       () => handleAutoScrape(msg, respond),
    [MSG.EXPORT_DATA]:       () => handleExportData(msg, respond),
    'PRIVACY_START':         () => handlePrivacyStart(msg, respond),
    'PRIVACY_CONFIGURE':     () => { configurePrivacy(msg.settings || {}); respond({ ok: true, settings: getPrivacySettings() }); },
    'PRIVACY_CAPTURE':       () => handlePrivacyCapture(msg, respond),
    'PRIVACY_GET_STATS':     () => respond({ last: getLastPrivacyRun(), cumulative: getCumulativePrivacyStats(), settings: getPrivacySettings() }),
    'LOCAL_MODEL_LIST':      () => handleLocalModelList(respond),
    'LOCAL_MODEL_DOWNLOAD':  () => handleLocalModelDownload(msg, respond),
    'LOCAL_MODEL_DELETE':    () => deleteLocalModel(msg.modelId).then(r => respond({ ok: true, ...r })),
    // Status persistence RPCs — the offscreen document has NO chrome.storage in
    // Chromium (restricted page-like chrome object), so the engine relays here.
    'LOCAL_STATUS_READ':     () => chrome.storage.local.get('opencometLocalModels')
      .then(d => respond({ ok: true, statuses: d?.opencometLocalModels || {} }))
      .catch(e => respond({ ok: false, error: String(e?.message || e) })),
    'LOCAL_STATUS_WRITE':    () => (async () => {
      try {
        const KEY = 'opencometLocalModels';
        // v1.16.1: the get→merge→set cycle is now serialized with the shared
        // storage-write mutex — concurrent per-file progress patches during a
        // multi-file model download used to race and drop updates.
        const statuses = await serializeStorageWrite(async () => {
          const d = await chrome.storage.local.get(KEY);
          const all = d?.[KEY] || {};
          // v1.17.0: each per-model status blob is stamped with stateVersion
          // (obsolete-state gating) — see storage.js STATE_VERSION.
          all[msg.modelId] = { stateVersion: STATE_VERSION, ...(all[msg.modelId] || {}), ...(msg.patch || {}) };
          await chrome.storage.local.set({ [KEY]: all });
          return all;
        });
        respond({ ok: true, statuses });
      } catch (e) { respond({ ok: false, error: String(e?.message || e) }); }
    })(),
  };

  // Offscreen ML runtime log lines → SW console (single pane of glass).
  if (msg.type === 'LOCAL_MODEL_LOG' && msg.text) {
    const style = msg.level === 'error' ? 'color:#f87171;font-weight:bold'
                : msg.level === 'warn'  ? 'color:#fbbf24;font-weight:bold'
                : 'color:#c4390a;font-weight:bold';
    console[msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'warn' : 'log']('%c[LocalML]', style, msg.text);
    return;
  }
  // Uncaught crashes relayed from page contexts (sidepanel / offscreen).
  if (msg.type === 'DIAG_LOG_RELAY' && msg.text) {
    const style = `color:${msg.level === 'error' ? '#f87171' : '#fbbf24'};font-weight:600;font-family:monospace`;
    console[msg.level === 'error' ? 'error' : 'warn'](`%c[Relay:${msg.ctx || 'ctx'}:${msg.ns}]`, style, msg.text);
    return;
  }

  const handler = routes[msg.type];
  if (handler) {
    try { handler(); } catch (err) {
      logRouter.error(`handler for ${msg.type} crashed:`, err?.message || String(err));
      try { respond({ ok: false, error: String(err?.message || err) }); } catch {}
    }
    return true;
  }
});

// ── Page monitors (skills/monitor-page) ───────────────────────────────────
// chrome.alarms fires in the SW even after it was killed. Each alarm re-fetches
// the monitored URL, diffs against the stored snapshot, and notifies on change.
chrome.alarms?.onAlarm.addListener(alarm => {
  // v1.16.1 RUN-KEEPALIVE BACKSTOP: if the SW was killed despite the 20s
  // interval (the interval dies WITH the worker it protects), this alarm
  // wakes it. agentState is fresh after a wake — the boot reconciliation at
  // the bottom of this file finalizes the interrupted run; here we only
  // touch the runtime API so a STILL-ALIVE run gets its idle timer reset.
  if (alarm?.name === 'opencomet_run_keepalive') {
    if (agentState.running) {
      try { chrome.runtime.getPlatformInfo(() => {}); } catch { /* noop */ }
    }
    return;
  }
  if (!alarm?.name?.startsWith('opencomet_monitor_')) return;
  const id = alarm.name.replace('opencomet_monitor_', '');
  (async () => {
    try {
      const monitors = await getMonitors();
      const monitor = monitors.get(id);
      if (!monitor) { chrome.alarms.clear(alarm.name); return; }
      const text = await fetchPageText(monitor.url);
      const prev = monitor.lastText || '';
      const changed = prev && text !== prev;
      const found = monitor.checkText ? text.toLowerCase().includes(monitor.checkText.toLowerCase()) : false;
      const shouldNotify = monitor.checkText ? found : changed;
      if (shouldNotify) {
        const label = monitor.checkText ? `Found "${monitor.checkText}"` : 'Page content changed';
        chrome.notifications.create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
          title: 'Open Comet — page monitor',
          message: `${label}\n${monitor.url}`,
        });
        // v1.16.1: the parallel MONITOR_ALERT broadcast was removed — it had no
        // listener anywhere (the chrome.notifications toast below is the actual
        // delivery); dead traffic on every monitor hit.
      }
      monitor.lastText = text.substring(0, 8000);
      monitor.lastCheckedAt = Date.now();
      monitors.set(id, monitor);
      await saveMonitors(monitors);
    } catch (err) {
      console.warn('[Open Comet] Monitor check failed:', err.message);
    }
  })();
});

// Warm the skill library cache at SW boot so peekLibrarySkills() has data
// before the first prompt is built.
loadLibrarySkills().catch(() => {});

// ── On-device model listing ──────────────────────────────────────────────
// Statuses come from chrome.storage; the compute backend is reported by the
// offscreen ML runtime when available (it is the context that actually runs
// WebGPU/WASM, so it is the source of truth).
async function handleLocalModelList(respond) {
  const models = await listLocalModels();
  let device = getLocalDevice();
  try {
    await ensureOffscreen();
    const ping = await sendToOffscreen({ type: 'OFFSCREEN_PING' }, { timeoutMs: 5000 });
    if (ping?.ok && ping.device) device = ping.device;
  } catch { /* offscreen unavailable — fall back to SW-side detection */ }
  respond({ ok: true, models, device });
}

// ── On-device (Transformers.js) model downloads ──────────────────────────
// The download itself streams progress to the UI via LOCAL_MODEL_PROGRESS
// broadcasts; we answer the caller immediately so the sidepanel never blocks.
let _localDownloadBusy = false;
async function handleLocalModelDownload(msg, respond) {
  if (_localDownloadBusy) {
    logBusy.warn(`model download already in progress — request for "${msg.modelId}" rejected.`);
    respond({ ok: false, error: 'Another model download is already in progress.' });
    return;
  }
  _localDownloadBusy = true;
  respond({ ok: true, started: true });
  try {
    const result = await downloadLocalModel(msg.modelId);
    if (!result.ok) logML.warn(`local model download failed:`, result.error);
  } finally {
    _localDownloadBusy = false;
  }
}

async function handleGetOllamaModels(msg, respond) {
  try {
    const settings = await getSettings();
    const baseUrl = String(msg.baseUrl || settings.ollamaBaseUrl || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
    const res = await fetch(baseUrl + '/api/tags');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `Ollama returned ${res.status}`);
    }
    const data = await res.json();
    const models = (data.models || []).map(model => ({
      name: model?.name || '',
      size: model?.size || 0,
      modifiedAt: model?.modified_at || '',
      details: model?.details || {},
    })).filter(model => model.name);
    respond({ ok: true, models });
  } catch (err) {
    respond({ ok: false, error: err.message || 'Unable to fetch Ollama models.' });
  }
}


// START
// -----------------------------------------------------------------------------
/**
 * Handles the start of an agent task.
 * @param {Object} msg - The message object containing task details.
 * @param {Function} respond - Callback to send a response.
 */
async function handleStart(msg, respond) {
  if (agentState.running || _startBusy) {
    logBusy.warn('START_AGENT rejected — an agent task is already running (busy).');
    respond({ ok: false, error: 'Already running' });
    return;
  }
  _startBusy = true;
  try {
    await handleStartInner(msg, respond);
  } finally {
    _startBusy = false;
  }
}

async function handleStartInner(msg, respond) {
  if (agentState.running) {
    logBusy.warn('START_AGENT rejected — an agent task is already running (busy).');
    respond({ ok: false, error: 'Already running' });
    return;
  }

  const settings = await getSettings();
  if (!isProviderConfigured(settings)) {
    logSW.warn('START_AGENT rejected — no AI provider configured. Set one in Settings → AI & Models.');
    respond({ ok: false, error: 'No provider configured' });
    return;
  }

  const caps = getProviderCapabilities(settings);
  if (!caps.browserAgentSafe) {
    respond({ ok: false, error: `${settings.provider} does not support vision — choose a vision-capable provider for best results.` });
    return;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Browser-internal page (chrome://newtab is the DEFAULT landing page) →
  // open the task's target site in the working tab instead of cloning a
  // useless internal page the agent can neither capture nor script.
  const bootstrapped = PRIVILEGED_URL_RE_SW.test(activeTab?.url || '');
  const workingUrl  = bootstrapped ? inferStartUrlFromTask(msg.task) : (activeTab?.url || 'about:blank');
  const startHost   = getHostFromUrl(workingUrl);

  const isContinuing = msg.sessionId && msg.sessionId === agentState.sessionId;
  let reuseTabId = null;
  if (isContinuing && agentState.agentTabId) {
    try {
      const existingTab = await chrome.tabs.get(agentState.agentTabId);
      if (existingTab) reuseTabId = existingTab.id;
    } catch {}
  }

  // Preserve some state if continuing
  const oldGroupId = isContinuing ? agentState.agentGroupId : null;
  const oldTabIds = isContinuing ? agentState.taskTabIds : [];
  const oldTabGraph = isContinuing ? agentState.taskTabGraph : {};

  agentState = createEmptyAgentState({
    running:              true,
    currentTabId:         activeTab.id,
    sessionId:            isContinuing ? msg.sessionId : `session_${Date.now()}`,
    mode:                 msg.mode       || 'ask',
    task:                 msg.task,
    taskProfile:          inferTaskProfile(msg.taskProfile, msg.skills),
    settings,
    maxIterations:        settings.maxSteps || 25,
    startUrl:             workingUrl,
    startTitle:           activeTab.title,
    attachments:          cloneAttachments(msg.attachments || []),
    skills:               cloneSkills(msg.skills || []),
    profileData:          { ...(settings.profileData || {}) },
    sessionApprovedHosts: startHost ? [startHost] : [],
    plannedHosts:         startHost ? [startHost] : [],
    taskMemory: { visitedHosts: startHost ? [startHost] : [], pageSnapshots: [], loopHints: [], workSummary: '' },
    // Reused fields
    agentGroupId:         oldGroupId,
    taskTabIds:           oldTabIds,
    taskTabGraph:         oldTabGraph,
    agentTabId:           reuseTabId,
  });

  startRunKeepalive();   // MV3: hold the SW alive for the whole run (see helper)
  writeActiveRunSnapshot({ sessionId: agentState.sessionId, task: agentState.task, mode: agentState.mode });   // v1.16.1 crash-recovery snapshot

  // -- Feature: Skill Auto-Detection ----------------------------------------
  // Automatically activate relevant skills based on task text + current URL,
  // without requiring manual user selection. Runs before the plan phase.
  try {
    const allSkills = await getAllSkills();
    const activeIds = (agentState.skills || []).map(s => s.id);
    const autoSkills = detectSkillsForTask(msg.task, activeTab.url, allSkills, activeIds);
    if (autoSkills.length) {
      agentState.skills = [...agentState.skills, ...autoSkills.map(s => ({
        id: s.id, name: s.name, prompt: s.prompt,
        allowedHosts: s.allowedHosts || [],
        preferredSites: s.preferredSites || [],
        doneChecklist: s.doneChecklist || [],
      }))];
      pushStep(STEP_TYPE.MUTED, `?? Auto-activated skill${autoSkills.length > 1 ? 's' : ''}: ${autoSkills.map(s => s.name).join(', ')}`);
    }
  } catch (err) {
    // Non-fatal: skill auto-detection failure must never block the agent.
    console.warn('[Open Comet] Skill auto-detection failed silently:', err.message);
  }

  respond({ ok: true, sessionId: agentState.sessionId });
  broadcast(MSG.AGENT_STARTED);
  setBadge('AI', '#7c6af7');

  if (bootstrapped) {
    let bootHost = workingUrl;
    try { bootHost = new URL(workingUrl).hostname.replace(/^www\./, ''); } catch {}
    pushStep(STEP_TYPE.THINKING, `Browser-internal page detected — opening ${bootHost} for your task instead…`);
  }

  // Open the working tab
  if (reuseTabId) {
    await chrome.tabs.update(reuseTabId, { active: true });
    await groupTaskTabs([reuseTabId]);
    broadcastToTabs({ type: MSG.AGENT_STARTED, state: agentState });
  } else {
    const agentTab = await chrome.tabs.create({ url: workingUrl, active: true });
    agentState.agentTabId = agentTab.id;
    agentState.taskTabIds = [agentTab.id];
    rememberTab(agentTab);
    await groupTaskTabs([agentTab.id]);
    broadcastToTabs({ type: MSG.AGENT_STARTED, state: agentState });
  }

  await sleep(1500);
  await planPhase();
}

// -----------------------------------------------------------------------------
// PLAN PHASE
// -----------------------------------------------------------------------------
/**
 * Analyzes the task and builds an execution plan using AI.
 */
async function planPhase() {
  pushStep(STEP_TYPE.THINKING, 'Planner role: analyzing task and building plan…');
  broadcastStatus(STATUS.PLANNING);

  try {
    const { screenshot, pageInfo } = await captureContext(agentState.agentTabId);
    agentState.lastPageInfo = pageInfo;
    agentState.lastScreenshot = screenshot || '';
    pushStep(STEP_TYPE.SCREENSHOT, 'Planning screenshot', {
      imageDataUrl: asImageDataUrl(screenshot),
    });
    const plan = await runPlannerRole(pageInfo, screenshot);

    agentState.plan = normalizePlan(plan);
    syncPlannedHosts();
    await activatePlannedSkills(plan);

    pushStep(STEP_TYPE.PLAN_READY, '?? Plan ready');

    if (agentState.mode === 'ask') {
      agentState.paused = true;
      broadcastStatus(STATUS.PAUSED);
      broadcastMessage({ type: MSG.PLAN_READY, plan, steps: agentState.steps });
    } else {
      await executionPhase();
    }
  } catch (err) {
    fatalError(err);
  }
}

function normalizePlan(plan) {
  const incoming = plan || {};
  const rawSteps = Array.isArray(incoming.steps) ? incoming.steps : [];
  const normalizedSteps = rawSteps.map((step, index) => {
    if (typeof step === 'string') {
      return { text: step, status: index === 0 ? 'current' : 'pending' };
    }
    return {
      text: String(step?.text || `Step ${index + 1}`),
      status: ['pending', 'current', 'done', 'skipped'].includes(step?.status) ? step.status : (index === 0 ? 'current' : 'pending'),
    };
  });
  if (normalizedSteps.length && !normalizedSteps.some(step => step.status === 'current')) {
    const firstPending = normalizedSteps.find(step => step.status === 'pending');
    if (firstPending) firstPending.status = 'current';
  }
  return {
    goal: String(incoming.goal || ''),
    approach: String(incoming.approach || ''),
    sites: Array.isArray(incoming.sites) ? incoming.sites.map(String) : [],
    skills: Array.isArray(incoming.skills) ? incoming.skills.map(String) : [],
    steps: normalizedSteps,
    estimated_actions: Number.isFinite(Number(incoming.estimated_actions)) ? Number(incoming.estimated_actions) : null,
  };
}

// -- Planner-chosen skill activation -----------------------------------------
// The planner lists matching SKILL LIBRARY ids in plan.skills; the loop then
// executes with those expert instructions injected as ACTIVE SKILLS.
async function activatePlannedSkills(plan) {
  const requested = Array.isArray(plan?.skills) ? plan.skills.slice(0, 3) : [];
  if (!requested.length) return;
  try {
    // executeAction is statically imported at the top of this file.
    // NEVER dynamic-import() here — it is banned on ServiceWorkerGlobalScope.
    for (const id of requested) {
      const already = (agentState.skills || []).some(s => s.id === String(id).toLowerCase());
      if (already) continue;
      const meta = await executeAction(agentState.agentTabId, { type: 'use_skill', id }, agentState);
      if (meta?.ok && !meta.alreadyActive) {
        pushStep(STEP_TYPE.MUTED, `✨ Planner engaged skill: ${meta.skill}`);
      }
    }
  } catch (err) {
    console.warn('[Open Comet] Planned skill activation failed:', err.message);
  }
}

function syncPlannedHosts() {
  agentState.plannedHosts = [...new Set([
    ...agentState.sessionApprovedHosts,
    ...((agentState.plan?.sites || []).map(normalizeHost).filter(Boolean)),
  ])];
}

function updatePlanProgressFromResult(result = {}) {
  if (!result) return;

  if (Array.isArray(result.plan_update) && result.plan_update.length) {
    agentState.plan = normalizePlan({
      ...(agentState.plan || {}),
      steps: result.plan_update,
      sites: agentState.plan?.sites || [],
    });
    agentState.currentPlanItemIndex = 0;
    agentState.planGenerationStep = agentState.iterationCount;
    syncPlannedHosts();
    pushStep(STEP_TYPE.MUTED, `?? Plan updated at step ${agentState.iterationCount}.`);
    return;
  }

  if (!agentState.plan?.steps?.length) return;
  const requestedIndex = Number.parseInt(result.current_plan_item, 10);
  if (!Number.isFinite(requestedIndex)) return;

  const clampedIndex = Math.max(0, Math.min(requestedIndex, agentState.plan.steps.length - 1));
  agentState.currentPlanItemIndex = clampedIndex;
  agentState.plan.steps = agentState.plan.steps.map((step, index) => {
    if (index < clampedIndex && (step.status === 'pending' || step.status === 'current')) {
      return { ...step, status: 'done' };
    }
    if (index === clampedIndex) {
      return { ...step, status: 'current' };
    }
    if (index > clampedIndex && step.status === 'current') {
      return { ...step, status: 'pending' };
    }
    return step;
  });
}

function injectRuntimeNudges() {
  const nudges = [];
  // v1.18.0: a guardian block leaves a ONE-SHOT strategy override — it
  // OVERRIDES speculative replans for the next decision (the model is told
  // not to retry the blocked target or a re-labeled equivalent).
  if (agentState.taskMemory.pendingGuardianHint) {
    nudges.push(agentState.taskMemory.pendingGuardianHint);
    agentState.taskMemory.pendingGuardianHint = null;
  }
  if (agentState.plan?.steps?.length && agentState.consecutiveFailures >= 2) {
    nudges.push(`REPLAN SUGGESTED: ${agentState.consecutiveFailures} consecutive failures. Update the plan before repeating the same strategy.`);
  }
  if (!agentState.plan?.steps?.length && agentState.iterationCount >= 4) {
    nudges.push('PLANNING NUDGE: This task appears multi-step. Emit plan_update with a short revised checklist before continuing.');
  }
  if (agentState.loopState.repeatedPageCount >= 2 || agentState.loopState.repeatedScreenshotCount >= 2) {
    nudges.push('LOOP NUDGE: The page state appears stagnant. Change strategy, revise the plan, or finish with the best grounded result.');
  }
  if (nudges.length) {
    agentState.taskMemory.runtimeNudges = nudges;
    agentState.taskMemory.loopHints = [...new Set([...(agentState.taskMemory.loopHints || []), ...nudges])].slice(-8);
  } else {
    agentState.taskMemory.runtimeNudges = [];
  }
}

// -----------------------------------------------------------------------------
// PLAN APPROVAL
// -----------------------------------------------------------------------------
// ── v1.15.1 ASK-BEFORE-ACTING (user request: the composer's "Ask before
// acting" mode was dead for privacy runs — handlePrivacyStart ignored
// msg.mode entirely). When the task is started in 'ask' mode, the privacy
// loop calls requestActionApproval() BEFORE every browser action; the
// sidepanel shows an approval card (Allow once / Skip / Stop) and the loop
// waits on a promise resolved by handleResolveApproval.
let actionApprovalWaiters = [];
function resolveAllActionApprovals(verdict) {
  const waiters = actionApprovalWaiters;
  actionApprovalWaiters = [];
  for (const w of waiters) { try { w(verdict); } catch { /* never break the caller */ } }
}
function requestActionApproval(action, step) {
  const approval = {
    id: `ap_${Date.now()}`,
    kind: 'action',
    step,
    // describeAction mirrors the chat's "Executing: …" line — the user reviews
    // exactly what would run. Typed text is shown (max 40 chars, same as the
    // chat) so the user can catch a wrong value BEFORE it lands in a field.
    message: `Step ${step} — the agent wants to: ${describeAction(action || {})}`,
  };
  agentState.pendingApproval = approval;
  broadcastMessage({ type: MSG.APPROVAL_REQUIRED, approval, steps: agentState.steps });
  setBadge('ASK', '#d9875a');
  return new Promise((resolve) => {
    actionApprovalWaiters.push(resolve);
  });
}

async function handleApprovePlan(editedPlan, respond) {
  agentState.plan   = normalizePlan(editedPlan || agentState.plan);
  agentState.paused = false;
  agentState.pendingApproval = null;
  syncPlannedHosts();
  respond({ ok: true });
  await executionPhase();
}

async function handleResolveApproval(msg, respond) {
  const pending = agentState.pendingApproval;
  if (!pending) { respond({ ok: false, error: 'No pending approval' }); return; }

  const decision = msg.decision || 'cancel';
  agentState.pendingApproval = null;
  agentState.paused          = false;

  // v1.15.1 ASK-BEFORE-ACTING: per-action approval from the privacy loop.
  // approve → run it · skip → drop this action, ask the model again ·
  // stop/cancel → abort the run (the loop's abort check turns it into the
  // normal stopped path: onError → AGENT_ERROR + honest history).
  if (pending.kind === 'action') {
    if (decision === 'approve_once') {
      setBadge('PRV', '#d9875a');
      resolveAllActionApprovals('approved');
    } else if (decision === 'skip') {
      setBadge('PRV', '#d9875a');
      resolveAllActionApprovals('skip');
    } else {
      agentState.stopRequested = true;
      try { agentState._privacyAbort?.abort?.(); } catch { /* already aborted */ }
      resolveAllActionApprovals('stop');
    }
    respond({ ok: true });
    return;
  }

  if (pending.kind === 'host_access') {
    if (decision === 'allow_host') {
      agentState.sessionApprovedHosts = [...new Set([...agentState.sessionApprovedHosts, pending.host])];
    } else if (decision === 'approve_once') {
      agentState.sessionApprovedHosts = [...new Set([...agentState.sessionApprovedHosts, pending.host])];
    } else {
      agentState.running = false;
      respond({ ok: true });
      broadcastMessage({ type: MSG.AGENT_STOPPED, steps: agentState.steps });
      broadcastStatus(STATUS.IDLE);
      return;
    }
  } else if (decision !== 'approve_once') {
    agentState.running = false;
    respond({ ok: true });
    broadcastMessage({ type: MSG.AGENT_STOPPED, steps: agentState.steps });
    broadcastStatus(STATUS.IDLE);
    return;
  }

  respond({ ok: true });
  await executionPhase();
}

function handleUserNote(note, respond) {
  const clean = String(note || '').trim();
  if (!clean || !agentState.running) { respond({ ok: false }); return; }
  agentState.userNotes.push({ text: clean, time: Date.now() });
  pushStep(STEP_TYPE.MUTED, `📝 User note: ${clean.substring(0, 180)}`);
  respond({ ok: true });
}

// -----------------------------------------------------------------------------
// EXECUTION LOOP
// -----------------------------------------------------------------------------
async function executionPhase() {
  pushStep(STEP_TYPE.EXECUTING, '?? Starting execution…');
  broadcastStatus(STATUS.EXECUTING);

  // v1.18.0: authorization evidence is pinned to what the user typed when the
  // task started — a mid-run mutation of agentState.task cannot authorize a
  // purchase/deletion after the fact. (Mid-run USER NOTES stay live — the
  // user may authorize explicitly while the task runs.)
  agentState.guardianTaskSnapshot = String(agentState.task || '');
  agentState.guardianHits = 0;

  while (agentState.running && !agentState.stopRequested) {
    if (agentState.paused) return;
    if (agentState.iterationCount >= agentState.maxIterations) {
      pushStep(STEP_TYPE.DONE, `?? Reached max steps (${agentState.maxIterations})`);
      break;
    }

    agentState.iterationCount++;

    try {
      const tabId = agentState.agentTabId;
      pushStep(STEP_TYPE.SCREENSHOT, `?? Screenshot #${agentState.iterationCount}`);

      const { screenshot, pageInfo } = await captureContext(tabId);
      agentState.lastPageInfo = pageInfo;
      agentState.lastScreenshot = screenshot || '';
      pushStep(STEP_TYPE.SCREENSHOT, `Screenshot #${agentState.iterationCount}`, {
        imageDataUrl: asImageDataUrl(screenshot),
      });
      updateLoopSignals(pageInfo, screenshot);
      recordSnapshot(pageInfo);
      injectRuntimeNudges();

      if (agentState.stopRequested) break;

      // -- Feature: History Compaction ----------------------------------------
      // Every 8 steps, compress the step history into a rolling work summary.
      // This prevents early context from being dropped in long sessions (25+ steps)
      // while keeping the prompt from growing unbounded.
      if (agentState.iterationCount > 0 && agentState.iterationCount % 8 === 0) {
        await compactWorkHistory();
      }

      pushStep(STEP_TYPE.THINKING, `Navigator role: deciding next action… (step ${agentState.iterationCount})`);

      const result = await runNavigatorRole(pageInfo, screenshot);
      updatePlanProgressFromResult(result);

      if (agentState.stopRequested) break;

      // -- Feature: Live Skill Checklist Tracking ----------------------------
      // Scan the agent's reasoning string for [DONE: <item>] markers.
      // When found, emit a CHECKLIST_UPDATE step so the sidepanel can render
      // live checklist progress without waiting for the task to finish.
      if (result && agentState.skills.length) {
        parseChecklistCompletions(result.reasoning || '');
      }

      const action = result.action;
      if (!action || action.type === 'done') {
        await finishSuccess(result);
        return;
      }

      // ── v1.18.0 TASK AUTHORIZATION DAEMON (primary action) ────────────
      // Purchase/delete clicks need authorization from the user's OWN text —
      // negated tasks ("do not purchase anything") are blocked too. Inputs
      // are INJECTION-PROOF BY CONSTRUCTION: only the run-start task
      // snapshot and user-authored notes reach the gate (never page text or
      // model reasoning). Fail-closed: a daemon fault or the 3rd blocked
      // attempt ends the task honestly; a block skips the action and leaves
      // a one-shot strategy override for the next decision.
      {
        const gAuth = authorizeAction(action, {
          taskText: agentState.guardianTaskSnapshot || agentState.task,
          extraTexts: agentState.userNotes || [],
          hits: agentState.guardianHits || 0,
        });
        agentState.guardianHits = typeof gAuth.hit === 'number' ? gAuth.hit : (agentState.guardianHits || 0);
        if (gAuth.fatal || gAuth.exit) {
          await finishGuardianExit(
            gAuth.fatal ? gAuth.userMessage : `${gAuth.userMessage} (3 unauthorized attempts — task ended honestly; nothing risky was executed)`,
          );
          return;
        }
        if (gAuth.skip) {
          pushStep(STEP_TYPE.MUTED, `🛡️ ${gAuth.userMessage} (attempt ${gAuth.hit}/${GUARDIAN_HIT_LIMIT}) — to allow it, put it in your own words: edit the task or send a note.`);
          agentState.taskMemory.pendingGuardianHint = gAuth.hint;   // next-decision override
          console.warn(`[Open Comet] Guardian BLOCKED ${describeAction(action)} (${gAuth.hit}/${GUARDIAN_HIT_LIMIT})`);
          continue;
        }
      }

      // Check if action needs user approval
      const approval = await checkApproval(action, pageInfo);
      if (approval) { await pauseForApproval(approval); return; }

      // Anti-loop scroll guard
      if (action.type === 'scroll' && agentState.loopState.noProgressScrolls >= 2) {
        throw new Error('Repeated no-progress scrolling — switching strategy.');
      }

      // Anti-loop: skip repeated type actions on the same selector
      // (happens when model gets truncated text and tries to retype endlessly)
      if (action.type === 'type' || action.type === 'fill') {
        const sel = action.selector || action.uid || '';
        const typedFields = agentState.taskMemory.typedFields || {};
        const priorValue = String(typedFields[sel] || '');
        const nextValue = String(action.text ?? action.value ?? '');
        if (sel && priorValue && (priorValue === nextValue || priorValue.includes(nextValue) || nextValue.includes(priorValue))) {
          pushStep(STEP_TYPE.MUTED, `?? Skipping repeated type into ${sel} — content already entered.`);
          continue;
        }
        const recentTypes = agentState.steps
          .slice(-6)
          .filter(s => s.type === STEP_TYPE.ACTION)
          .map(s => s.text || '')
          .filter(t => t.includes(sel) && (t.startsWith('? Type') || t.startsWith('? Fill')));
        if (recentTypes.length >= 2) {
          pushStep(STEP_TYPE.MUTED, `?? Skipping repeated type into ${sel} — field already filled. Moving on.`);
          agentState.iterationCount++; // still counts as a step
          continue;
        }
      }

      updateActionLoop(action);

      const checkpoint = getCheckpointForAction(action);
      if (checkpoint) await runCheckpoint(checkpoint, { action, pageInfo });

      if (shouldVerifyAction(action)) {
        const verification = await runVerifierRole(action);
        if (!verification.ok) throw new Error(verification.reason);
        if (verification.action) Object.assign(action, verification.action);
        if (verification.pageInfo) agentState.lastPageInfo = verification.pageInfo;
      }

      pushStep(STEP_TYPE.ACTION, `? ${describeAction(action)}`);
      broadcastStatus(STATUS.ACTING);

      const meta = await executeAction(tabId, action, agentState);
      agentState.consecutiveFailures = 0;
      applyOutcome(action, meta);

      // -- Native tool results become explicit observations -----------------
      // The model can only trust what it sees — surface executor outputs for
      // the skill-library native tools (bookmarks, saves, monitors, skills).
      const nativeMeta = {
        bookmark_add: m => m.ok && `Bookmark ${m.existed ? 'already saved' : 'created'}${m.folder ? ` in "${m.folder}"` : ''}: ${m.bookmark?.title || ''}`,
        bookmark_search: m => m.ok && `Found ${m.count} bookmark(s)${m.count ? ': ' + m.results.slice(0, 3).map(b => b.title).join(' | ') : ''}`,
        save_page: m => m.ok && `Page saved as ${m.filename}`,
        screenshot_save: m => m.ok && `Screenshot saved as ${m.filename}`,
        organize_tabs: m => m.ok && `Tabs organized: closed ${m.closed || 0} duplicate(s), made ${m.groups?.length || 0} group(s)`,
        read_later_add: m => m.ok && (m.existed ? 'Already in reading list' : `Added to reading list — ${m.count} item(s) queued`),
        read_later_list: m => m.ok && `Reading list (${m.count}): ${(m.items || []).slice(0, 4).map(i => i.title).join(' | ')}`,
        monitor_start: m => m.ok && `Monitor registered: ${m.monitor?.url} every ${m.monitor?.intervalMin} min for ${m.monitor?.checkText}`,
        use_skill: m => m.ok && (m.alreadyActive ? `Skill "${m.skill}" already active` : `Skill "${m.skill}" engaged — follow its instructions from the next step`),
      };
      const observation = nativeMeta[action.type]?.(meta);
      if (observation) pushStep(STEP_TYPE.MUTED, `▸ ${observation}`);

      // -- Auto-done: detect send/submit completion -------------------------
      // If the agent just clicked a "Send" button, check whether the compose
      // window closed — if so, the email was sent and we're done.
      // v1.16.1 TWO FIXES:
      //   (a) the whole probe is HOST-GATED behind isMailHostTab — previously
      //       clicking "Send feedback" on ANY page whose body text happened
      //       to contain the word "sent" ended the task with a false
      //       "Email sent successfully";
      //   (b) the body-text regex is narrowed to the "message sent" phrase
      //       (the bare \bsent\b alternative matched any page containing
      //       "sent" — an order-status page was enough).
      if (action.type === 'click') {
        const sel       = String(action.selector || action.text || '').toLowerCase();
        const matched   = String(meta?.matchedText || '').toLowerCase();
        const isSendBtn = /\bsend\b|\bsubmit\b|\bsend email\b|\benvoyer\b/.test(sel + ' ' + matched);
        if (isSendBtn && await isMailHostTab(agentState.agentTabId || tabId)) {
          await sleep(1800); // let Gmail animate the send
          const sentState = await detectEmailSent(agentState.agentTabId || tabId);
          if (sentState.sent) {
            await finishSuccess('? Email sent successfully.');
            return;
          }
        }
      }

      await sleep(agentState.settings.screenshotDelay || 1200);
      if (['navigate', 'click', 'new_tab', 'switch_tab'].includes(action.type)) {
        await waitForLoad(agentState.agentTabId || tabId);
      }
      await syncTab();


    } catch (err) {
      agentState.consecutiveFailures += 1;
      if (isFatalProviderError(err)) {
        const message = `${err.message}${agentState.taskProfile === 'email' || /mail\.google\.com/i.test(agentState.lastPageInfo?.url || '') ? ' Current draft was left as-is.' : ''}`;
        fatalError(new Error(message));
        return;
      }
      pushStep(STEP_TYPE.ERROR, `?? ${err.message}`);
      logAgent.warn(`iteration ${agentState.iterationCount} failed (consecutive=${agentState.consecutiveFailures}): ${err.message}`);
      if (agentState.iterationCount <= 3) { fatalError(err); return; }
      await sleep(2000); // allow agent to recover
    }
  }

  if (agentState.stopRequested) {
    await finishStopped();
  } else if (agentState.running) {
    await finishMaxSteps();
  }

  agentState.running = false;
  broadcastStatus(STATUS.IDLE);
}

// -----------------------------------------------------------------------------
// FINISH HELPERS
// -----------------------------------------------------------------------------
async function finishSuccess(result) {
  const answer = result.answer || 'Task completed.';
  pushStep(STEP_TYPE.DONE, `? ${answer}`);
  agentState.running = false;
  agentState.finalStatus = 'done';
  broadcastMessage({ type: MSG.AGENT_DONE, answer, data: result.data || {}, steps: agentState.steps, sessionId: agentState.sessionId });
  notify('Open Comet — task complete', answer);
  setBadge('', '#7c6af7');
  stopRunKeepalive();
  await appendHistory({ id: agentState.sessionId, task: agentState.task, status: 'done', result: answer.substring(0, 300), steps: agentState.steps.length, tokens: agentState.taskUsage?.totalTokens || 0, cost: agentState.taskUsage?.cost || 0, time: Date.now() });
  broadcastStatus(STATUS.IDLE);
}

async function finishStopped() {
  pushStep(STEP_TYPE.STOPPED, '? Stopped by user.');
  agentState.finalStatus = 'stopped';
  stopRunKeepalive();
  broadcastMessage({ type: MSG.AGENT_STOPPED, steps: agentState.steps, sessionId: agentState.sessionId });
  setBadge('', '#7c6af7');
  await appendHistory({ id: agentState.sessionId, task: agentState.task, status: 'stopped', result: 'Stopped by user.', steps: agentState.steps.length, tokens: agentState.taskUsage?.totalTokens || 0, cost: agentState.taskUsage?.cost || 0, time: Date.now() });
}

async function finishMaxSteps() {
  logLimits.warn(`max step limit reached (${agentState.maxIterations}) — finishing with the best-effort answer.`);
  const answer = `Reached the max step limit (${agentState.maxIterations}).`;
  agentState.finalStatus = 'incomplete';
  stopRunKeepalive();
  broadcastMessage({ type: MSG.AGENT_DONE, answer, data: {}, steps: agentState.steps, sessionId: agentState.sessionId });
  setBadge('', '#7c6af7');
  await appendHistory({ id: agentState.sessionId, task: agentState.task, status: 'incomplete', result: answer, steps: agentState.steps.length, tokens: agentState.taskUsage?.totalTokens || 0, cost: agentState.taskUsage?.cost || 0, time: Date.now() });
}

// v1.18.0 3-HIT HONEST EXIT / DAEMON FAULT SHUTDOWN: the task ends with an
// honest DONE answer + history entry — never with an unauthorized
// purchase/deletion executed.
async function finishGuardianExit(userMessage) {
  const answer = String(userMessage || '').replace(/^🛡️\s*/, '');
  pushStep(STEP_TYPE.DONE, `🛡️ ${answer}`);
  agentState.finalStatus = 'blocked';
  agentState.running = false;
  stopRunKeepalive();
  broadcastMessage({ type: MSG.AGENT_DONE, answer, data: { guardianExit: true }, steps: agentState.steps, sessionId: agentState.sessionId });
  notify('Open Comet — stopped by the Task Authorization Guardian', answer);
  setBadge('', '#7c6af7');
  await appendHistory({ id: agentState.sessionId, task: agentState.task, status: 'blocked', result: answer.substring(0, 300), steps: agentState.steps.length, tokens: agentState.taskUsage?.totalTokens || 0, cost: agentState.taskUsage?.cost || 0, time: Date.now() });
  broadcastStatus(STATUS.IDLE);
}

function fatalError(err) {
  logAgent.error('fatal:', err?.message || String(err));
  pushStep(STEP_TYPE.ERROR, `? ${err.message}`);
  agentState.running = false;
  agentState.finalStatus = 'error';
  stopRunKeepalive();
  broadcastMessage({ type: MSG.AGENT_ERROR, error: err.message, steps: agentState.steps, sessionId: agentState.sessionId });
  broadcastStatus(STATUS.IDLE);
  notify('Open Comet error', err.message);
  setBadge('ERR', '#f04a6a');
  setTimeout(() => setBadge('', '#7c6af7'), 5000);
  appendHistory({ id: agentState.sessionId, task: agentState.task, status: 'error', result: err.message, steps: agentState.steps.length, tokens: agentState.taskUsage?.totalTokens || 0, cost: agentState.taskUsage?.cost || 0, time: Date.now() });
}

// -----------------------------------------------------------------------------
// SCREENSHOT + PAGE INFO
// -----------------------------------------------------------------------------
async function captureContext(tabId) {
  const activeId  = await syncTab() || tabId;
  const tab       = await chrome.tabs.get(activeId).catch(() => null);
  if (tab) rememberTab(tab);

  let pageInfo = enrichCapturedPageInfo(await getPageInfo(activeId), agentState.lastPageInfo);
  pageInfo.openTabs    = await getTabsSnapshot();
  pageInfo.currentHost = getHostFromUrl(tab?.url || pageInfo.url);
  pageInfo.visibility  = 'visible';

  const screenshot = await takeScreenshot(activeId, pageInfo);
  return { screenshot, pageInfo };
}

async function takeScreenshot(tabId, pageInfo = {}) {
  // v1.17.0: Firefox has no chrome.debugger — go straight to the
  // captureVisibleTab fallback instead of dying on the attach call.
  if (!chrome.debugger) return await fallbackScreenshot(tabId);
  let attached = false;
  let overlayReady = false;
  try {
    await chrome.tabs.update(tabId, { active: true });
    overlayReady = await injectScreenshotOverlay(tabId, pageInfo);
    if (overlayReady) await sleep(80);
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    try { await dbg(tabId, 'Page.enable'); } catch {}
    const shot = await dbg(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 82, fromSurface: true });
    return shot?.data || null;
  } catch {
    return await fallbackScreenshot(tabId);
  } finally {
    if (overlayReady) { try { await removeScreenshotOverlay(tabId); } catch {} }
    if (attached) { try { await chrome.debugger.detach({ tabId }); } catch {} }
  }
}

async function fallbackScreenshot(tabId) {
  try {
    const tab    = await chrome.tabs.get(tabId);
    const dataUrl = await new Promise((res, rej) =>
      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 78 }, d =>
        chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(d)
      )
    );
    return String(dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
  } catch {
    return null;
  }
}

async function detectEmailSent(tabId) {
  return await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const bodyText = String(document.body?.innerText || '').toLowerCase();
      // v1.16.1: the bare \bsent\b alternative removed — it matched ANY page
      // containing the word "sent" (order confirmations, blog posts,
      // "Sent from my iPhone" signatures) and faked task success.
      const toastSent = /\bmessage sent\b|\bmail sent\b/.test(bodyText);
      const composeOpen = Boolean(document.querySelector('.aDh,.nH.if,.M9,[role="dialog"] [aria-label*="Message Body"],div[aria-label="Message Body"]'));
      const sendButton = [...document.querySelectorAll('button,[role="button"],div[role="button"]')]
        .find(el => /\bsend\b/.test(String(el.textContent || el.getAttribute?.('aria-label') || '').toLowerCase()));
      return {
        sent: toastSent || (!composeOpen && !sendButton),
        toastSent,
        composeOpen,
      };
    },
  }).then(r => r?.[0]?.result ?? { sent: false }).catch(() => ({ sent: false }));
}

async function injectScreenshotOverlay(tabId, interactiveElements = []) {
  const items = Array.isArray(interactiveElements?.interactiveElements)
    ? getScreenshotOverlayItems(interactiveElements)
    : interactiveElements;
  if (!items.length) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [items],
      func: (itemsToLabel) => {
        const OVERLAY_ID = '__opencomet_capture_overlay';
        document.getElementById(OVERLAY_ID)?.remove();

        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.style.cssText = [
          'position:fixed',
          'inset:0',
          'pointer-events:none',
          'z-index:2147483646',
          'font-family:Inter,Arial,sans-serif',
        ].join(';');

        for (const item of itemsToLabel) {
          const bounds = item?.bounds || {};
          if (bounds.w <= 0 || bounds.h <= 0) continue;

          const outline = document.createElement('div');
          outline.style.cssText = [
            'position:fixed',
            `left:${Math.max(0, bounds.x)}px`,
            `top:${Math.max(0, bounds.y)}px`,
            `width:${Math.max(18, bounds.w)}px`,
            `height:${Math.max(18, bounds.h)}px`,
            `border:2px solid ${item.isNew ? '#2563eb' : item.editable ? '#15803d' : '#c4390a'}`,
            'border-radius:8px',
            'box-shadow:0 0 0 1px rgba(255,255,255,0.7)',
            `background:${item.isNew ? 'rgba(37,99,235,0.10)' : 'rgba(255,255,255,0.03)'}`,
          ].join(';');

          const label = document.createElement('div');
          const shortUid = String(item.uid || '').replace(/^nx-/, '');
          const labelTop = bounds.y > 24 ? bounds.y - 18 : bounds.y + Math.min(bounds.h + 4, 18);
          label.textContent = shortUid;
          label.style.cssText = [
            'position:fixed',
            `left:${Math.max(4, bounds.x + 4)}px`,
            `top:${Math.max(4, labelTop)}px`,
            'padding:1px 6px',
            'border-radius:999px',
            'background:#111827',
            `border:1px solid ${item.isNew ? 'rgba(96,165,250,0.95)' : 'rgba(255,255,255,0.35)'}`,
            'color:#ffffff',
            'font-size:11px',
            'font-weight:700',
            'line-height:1.4',
            'box-shadow:0 2px 8px rgba(0,0,0,0.35)',
            'white-space:nowrap',
          ].join(';');

          overlay.appendChild(outline);
          overlay.appendChild(label);
        }

        document.documentElement.appendChild(overlay);
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function removeScreenshotOverlay(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      document.getElementById('__opencomet_capture_overlay')?.remove();
    },
  }).catch(() => {});
}

function dbg(tabId, method, params = {}) {
  return new Promise((res, rej) =>
    chrome.debugger.sendCommand({ tabId }, method, params, result =>
      chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(result)
    )
  );
}

async function getPageInfo(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args:   [tabId],
      func: (currentTabId) => {
        const UID  = 'data-opencomet-agent-uid';
        const norm = v => String(v || '').replace(/\s+/g, ' ').trim();
        const vis  = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
        const cleanCssToken = value => String(value || '')
          .trim()
          .replace(/[^a-zA-Z0-9_-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .substring(0, 40);
        const buildDomPath = el => {
          const parts = [];
          let node = el;
          let depth = 0;
          while (node && node.nodeType === Node.ELEMENT_NODE && depth < 4) {
            const tag = String(node.tagName || '').toLowerCase();
            if (!tag || tag === 'html') break;
            let token = tag;
            const id = cleanCssToken(node.id);
            if (id) {
              token += `#${id}`;
              parts.unshift(token);
              break;
            }
            const name = norm(node.getAttribute('name'));
            if (name) {
              token += `[name="${name.substring(0, 40).replace(/"/g, '\\"')}"]`;
            } else {
              const classNames = [...(node.classList || [])]
                .map(cleanCssToken)
                .filter(Boolean)
                .slice(0, 2);
              if (classNames.length) token += `.${classNames.join('.')}`;
            }
            parts.unshift(token);
            node = node.parentElement;
            depth += 1;
          }
          return parts.join(' > ').substring(0, 180);
        };
        const interSel = 'a[href],button,[role="button"],[role="searchbox"],input,textarea,select,[role="textbox"],[contenteditable],summary';
        const rawEls   = [...document.querySelectorAll(interSel)].filter(vis);
        const seen     = new Set();
        const items    = [];
        for (const el of rawEls) {
          const text    = norm(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.title).substring(0, 120);
          const ph      = norm(el.placeholder || el.getAttribute('aria-label')).substring(0, 120);
          const ariaLabel = norm(el.getAttribute('aria-label')).substring(0, 120);
          const titleAttr = norm(el.getAttribute('title')).substring(0, 120);
          const href    = el.href || el.closest?.('a')?.href || '';
          const tag     = el.tagName.toLowerCase();
          const name    = norm(el.getAttribute('name') || '').substring(0, 80);
          const id      = norm(el.id || '').substring(0, 80);
          const className = norm(el.className || '').substring(0, 120);
          const domPath = buildDomPath(el);
          const roleAttr = el.getAttribute('role') || '';
          const role    = roleAttr || (tag === 'a'
            ? 'link'
            : tag === 'button'
              ? 'button'
              : tag === 'select'
                ? 'select'
                : String(el.type || '').toLowerCase() === 'search'
                  ? 'searchbox'
                  : 'textbox');
          const key     = [role, text, ph, ariaLabel, href, domPath].join('|').toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          const uid = el.getAttribute(UID) || `nx-${items.length + 1}`;
          el.setAttribute(UID, uid);
          const rect = el.getBoundingClientRect();
          items.push({
            uid,
            role,
            tag,
            type: el.type || '',
            text,
            placeholder: ph,
            ariaLabel,
            titleAttr,
            href,
            name,
            id,
            className,
            domPath,
            axName: ariaLabel || titleAttr || text || ph,
            editable: ['textbox','searchbox','select'].includes(role) || ['input','textarea','select'].includes(tag) || el.isContentEditable,
            disabled: Boolean(el.disabled),
            bounds: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
            selector: `uid:${uid}`,
            tabId: currentTabId,
          });
          if (items.length >= 80) break;
        }
        const scroller = document.scrollingElement || document.documentElement;
        const top = window.scrollY, height = document.body?.scrollHeight || 0, ch = window.innerHeight;
        const mainCandidate = document.querySelector('main, article, [role="main"], #main, .main') || document.body;
        const readableText = norm(mainCandidate?.innerText || mainCandidate?.textContent || document.body?.innerText || '').substring(0, 12000);
        const headings = [...(mainCandidate || document).querySelectorAll('h1, h2, h3')]
          .map(el => norm(el.textContent))
          .filter(Boolean)
          .slice(0, 20);
        const tables = [...(mainCandidate || document).querySelectorAll('table')].slice(0, 3).map(table => ({
          rows: [...table.querySelectorAll('tr')].slice(0, 8).map(row =>
            [...row.querySelectorAll('th,td')].slice(0, 6).map(cell => norm(cell.textContent).substring(0, 160))
          ),
        })).filter(table => table.rows.length);
        const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content')
          || document.querySelector('meta[property="og:description"]')?.getAttribute('content')
          || '';
        return {
          url: location.href, title: document.title,
          text: document.body?.innerText?.substring(0, 5000) || '',
          readableText,
          headings,
          tables,
          metaDescription: norm(metaDescription).substring(0, 500),
          inputs:              items.filter(i => i.editable).slice(0, 20).map(i => ({ uid: i.uid, type: i.type||i.tag, name: i.placeholder||i.text||i.name||i.uid, selector: i.selector })),
          links:               items.filter(i => i.href).slice(0, 25).map(i => ({ uid: i.uid, text: i.text||i.uid, href: i.href, selector: i.selector })),
          clickables:          items.filter(i => ['link','button'].includes(i.role)).slice(0, 50),
          interactiveElements: items,
          scrollState: { top, clientHeight: ch, height, percent: height > ch ? Math.round(top/(height-ch)*100) : 100, atTop: top <= 4, atBottom: top + ch >= height - 8 },
          viewport: { w: innerWidth, h: innerHeight },
        };
      },
    });
    return results?.[0]?.result || {};
  } catch { return {}; }
}

// -----------------------------------------------------------------------------
// APPROVAL HELPERS
// -----------------------------------------------------------------------------
async function checkApproval(action, pageInfo) {
  if (['navigate', 'new_tab'].includes(action.type)) {
    const host = getHostFromUrl(action.url);
    if (host && !agentState.sessionApprovedHosts.includes(host) && agentState.mode !== 'auto' && !agentState.plannedHosts.includes(host)) {
      return { kind: 'host_access', host, message: `Agent wants to open ${host} (not in approved plan).` };
    }
  }

  const subjectText = [action.type, action.selector, action.text, action.value, action.url, action.query].filter(Boolean).join(' ').toLowerCase();
  const guards = [
    ['download',    /\b(download|save|export|install|csv|pdf)\b/],
    ['purchase',    /\b(buy|checkout|pay now|payment|place order|subscribe)\b/],
    ['account',     /\b(sign up|register|create account)\b/],
    ['auth',        /\b(sign in|log in|password|otp|2fa|mfa)\b/],
    ['permissions', /\b(permission|allow notifications|camera|microphone|location)\b/],
    ['destructive', /\b(delete|remove|erase|clear all|close account)\b/],
  ];
  const matched = guards.find(([, re]) => re.test(subjectText));
  if (matched) {
    return { kind: 'protected_action', actionType: matched[0], message: `This step may ${PROTECTED_ACTION_LABELS[matched[0]]}.` };
  }
  return null;
}

async function pauseForApproval(approval) {
  agentState.paused = true;
  agentState.pendingApproval = { id: `ap_${Date.now()}`, ...approval };
  pushStep(STEP_TYPE.MUTED, `? Approval required: ${approval.message}`);
  broadcastStatus(STATUS.PAUSED);
  broadcastMessage({ type: MSG.APPROVAL_REQUIRED, approval: agentState.pendingApproval, steps: agentState.steps });
}

// -----------------------------------------------------------------------------
// LOOP DETECTION
// -----------------------------------------------------------------------------
function updateLoopSignals(pageInfo, screenshot) {
  const pageSig  = getLoopPageSignature(pageInfo);
  // v1.16.1: the old screenshot signature was the FIRST 160 chars of the
  // data-URL — mostly the constant JPEG/PNG header, a near-useless loop
  // signal. Now samples head/middle/tail + length, so identical frames still
  // match but different frames almost never do.
  const shotSig = (() => {
    const s = String(screenshot || '');
    if (!s) return '';
    const n = s.length;
    return `${n}:${s.slice(0, 64)}:${s.slice(n >> 1, (n >> 1) + 64)}:${s.slice(-64)}`;
  })();
  const ls       = agentState.loopState;

  ls.repeatedPageCount       = pageSig  && pageSig  === ls.lastPageSignature       ? ls.repeatedPageCount + 1       : 0;
  ls.repeatedScreenshotCount = shotSig  && shotSig  === ls.lastScreenshotSignature ? ls.repeatedScreenshotCount + 1 : 0;
  ls.lastPageSignature       = pageSig;
  ls.lastScreenshotSignature = shotSig;

  agentState.taskMemory.loopHints = [
    ...(ls.repeatedPageCount       >= 2 ? ['Page state has not changed for multiple iterations.'] : []),
    ...(ls.repeatedScreenshotCount >= 2 ? ['Screenshot looks identical across iterations.']       : []),
    ...(ls.noProgressScrolls       >= 2 ? ['Scrolling has not revealed new content recently.']    : []),
  ];
}

function updateActionLoop(action) {
  const key = JSON.stringify({ type: action.type, selector: action.selector||'', text: action.text||action.value||'', url: action.url||'', query: action.query||'', dir: action.direction||'' });
  agentState.loopState.repeatedActionCount = key === agentState.loopState.lastActionKey ? agentState.loopState.repeatedActionCount + 1 : 0;
  agentState.loopState.lastActionKey = key;
}

// SIH MODE: RAW SCREEN → NEVER NETWORK. In SIH mode the main (non-privacy)
// agent keeps working but its RAW screenshot is stripped before any network
// call — the model degrades to DOM-only context for that turn.
async function sihGateShot(rawScreenshot) {
  const decision = sihRawScreenshotDecision(await isSihMode(), rawScreenshot);
  if (!decision.allowed) console.warn('[SIH]', decision.note);
  return decision.image;
}

async function runPlannerRole(pageInfo, screenshot) {
  pushStep(STEP_TYPE.API, `Planner role: calling ${agentState.settings.provider}...`);
  const req = buildPlannerRequest(agentState, pageInfo, screenshot, { images: imageAttachments() });
  return await callAI(agentState.settings, req.prompt, (await sihGateShot(req.screenshotBase64)), { images: req.images, onUsage: trackUsage, ...onDeviceExtras() });
}

async function runCheckpoint(name, context = {}) {
  if (!name) return;
  pushStep(STEP_TYPE.MUTED, describeCheckpoint(name, context));
}

async function runVerifierRole(action) {
  const freshPageInfo = enrichCapturedPageInfo(await getPageInfo(agentState.agentTabId), agentState.lastPageInfo);
  const verified = verifyActionAgainstPage(action, freshPageInfo);
  if (verified.ok) {
    const matched = verified.matchedElement?.selector || verified.matchedElement?.uid || action.selector || action.type;
    pushStep(STEP_TYPE.MUTED, `Verifier role: fresh DOM check passed for ${action.type} (${matched})`);
  }
  return verified;
}

async function runSynthesizerRole(settings, prompt) {
  return await callAIRaw(settings, prompt, { onUsage: trackUsage });
}

async function runNavigatorRole(pageInfo, screenshot) {
  const initialReq = buildNavigatorRequest(agentState, pageInfo, screenshot, {
    compactMode: 'normal',
    images: imageAttachments(),
  });
  try {
    return await callAI(agentState.settings, initialReq.prompt, (await sihGateShot(initialReq.screenshotBase64)), { images: initialReq.images, onUsage: trackUsage, ...onDeviceExtras() });
  } catch (err) {
    if (!shouldRetryCompactAction(err, agentState.settings)) throw err;
    const compactReq = buildNavigatorRequest(agentState, pageInfo, screenshot, {
      compactMode: 'minimal',
      images: imageAttachments(),
    });
    return await callAI(agentState.settings, compactReq.prompt, (await sihGateShot(compactReq.screenshotBase64)), { images: compactReq.images, onUsage: trackUsage, ...onDeviceExtras() });
  }
}

/**
 * On-device generation extras (no-ops for cloud providers):
 *   • tools     — WebMCP-style declarations for native tool calling
 *   • sessionId — KV-cache reuse across loop iterations
 *   • stream    — live token broadcast to the sidepanel
 */
function onDeviceExtras() {
  const provider = String(agentState.settings?.provider || '').toLowerCase();
  if (provider !== 'local') return {};
  return {
    tools: toChatTemplateTools(),
    sessionId: String(agentState.sessionId || ''),
    stream: true,
  };
}

function applyOutcome(action, meta = {}) {
  if (action.type === 'scroll') {
    agentState.loopState.noProgressScrolls = (meta.moved || 0) < 24 ? agentState.loopState.noProgressScrolls + 1 : 0;
  } else if (['navigate','new_tab','switch_tab','click','search','submit'].includes(action.type)) {
    agentState.loopState.noProgressScrolls = 0;
  }
  const host = getHostFromUrl(meta.url || action.url || '');
  if (host) agentState.taskMemory.visitedHosts = [...new Set([...agentState.taskMemory.visitedHosts, host])].slice(-12);
  if (['type', 'fill'].includes(action.type)) {
    const key = String(action.selector || action.uid || '').trim();
    if (key) {
      agentState.taskMemory.typedFields = {
        ...(agentState.taskMemory.typedFields || {}),
        [key]: String(action.text ?? action.value ?? ''),
      };
    }
  }
}

function isFatalProviderError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('unauthorized') ||
         msg.includes('401') ||
         msg.includes('invalid api key') ||
         msg.includes('insufficient_quota') ||
         msg.includes('quota') ||
         msg.includes('credit') ||
         msg.includes('billing');
}

function recordSnapshot(pageInfo) {
  const host = getHostFromUrl(pageInfo.url);
  if (host) agentState.taskMemory.visitedHosts = [...new Set([...agentState.taskMemory.visitedHosts, host])].slice(-12);
  agentState.taskMemory.pageSnapshots = [...agentState.taskMemory.pageSnapshots, { url: pageInfo.url, title: pageInfo.title, host, scrollPercent: pageInfo.scrollState?.percent || 0 }].slice(-8);
}

// -----------------------------------------------------------------------------
// Feature: History Compaction
// Runs every 8 iterations to compress completed step history into a rolling
// work summary. This keeps the action prompt from growing unbounded while
// preserving the semantic gist of what the agent has already done.
// -----------------------------------------------------------------------------
async function compactWorkHistory() {
  const allCompletedSteps = agentState.steps
    .filter(s => ['action', 'done', 'error', 'muted', 'thinking'].includes(s.type))
    .slice(0, -4);
  const lastCompactedStepCount = agentState.taskMemory?.compaction?.lastCompactedStepCount || 0;
  const completedSteps = allCompletedSteps
    .slice(lastCompactedStepCount)
    .map(s => `[${s.type.toUpperCase()}] ${String(s.text || '').substring(0, 160)}`)
    .join('\n');

  if (!completedSteps.trim()) return;

  const compressionPrompt = buildHistoryCompactionPrompt(agentState, completedSteps);

  try {
    const summary = await callAIRaw(agentState.settings, compressionPrompt, { onUsage: trackUsage });
    if (summary && String(summary).trim().length > 20) {
      agentState.taskMemory.workSummary = String(summary).trim().substring(0, 800);
      agentState.taskMemory.compaction = {
        lastCompactedStepCount: allCompletedSteps.length,
        lastCompactedIteration: agentState.iterationCount,
      };
      logLimits.info(`context compacted at step ${agentState.iterationCount} (${allCompletedSteps.length} steps → summary)`);
      pushStep(STEP_TYPE.MUTED, `??? History compacted at step ${agentState.iterationCount}.`);
    }
  } catch {
    // Non-fatal: compaction failure must never block the agent.
  }
}

// -----------------------------------------------------------------------------
// Feature: Live Skill Checklist Tracking
// Scans the agent's reasoning text for [DONE: <item>] markers and broadcasts
// CHECKLIST_UPDATE steps so the UI can tick off progress in real-time.
// -----------------------------------------------------------------------------
function parseChecklistCompletions(reasoning) {
  if (!reasoning) return;

  // Match patterns like: [DONE: Page fully scrolled] or [DONE:All emails extracted]
  const donePattern = /\[DONE:\s*([^\]]+)\]/gi;
  const allChecklist = (agentState.skills || []).flatMap(s => (s.doneChecklist || []));
  if (!allChecklist.length) return;

  let match;
  while ((match = donePattern.exec(reasoning)) !== null) {
    const completedItem = String(match[1] || '').trim();
    if (!completedItem) continue;

    // Guard: only emit if this item is actually in a skill's checklist
    const isKnownItem = allChecklist.some(item =>
      String(item).toLowerCase().includes(completedItem.toLowerCase().substring(0, 20))
    );
    if (!isKnownItem) continue;

    // Avoid duplicate emissions in the same session
    const alreadyEmitted = (agentState.taskMemory.completedChecklist || []).includes(completedItem);
    if (alreadyEmitted) continue;

    agentState.taskMemory.completedChecklist = [
      ...(agentState.taskMemory.completedChecklist || []),
      completedItem,
    ];
    pushStep(STEP_TYPE.CHECKLIST_UPDATE, `? Checklist: ${completedItem}`, { item: completedItem });
  }
}

// -----------------------------------------------------------------------------
function clampInt(value, fallback, min, max) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}


function inferTaskProfile(explicitProfile, skills = []) {
  if (explicitProfile && explicitProfile !== 'default') return explicitProfile;
  const ids = new Set((skills || []).map(skill => String(skill?.id || '').toLowerCase()));
  if (ids.has('builtin_summarise')) return 'summarize';
  if (ids.has('builtin_research_deep') || ids.has('builtin_multi_source')) return 'deep_research';
  return 'default';
}

function summarizeScrapedPage(page = {}) {
  return String(page.description || page.text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 700);
}

async function analyzeResearchSource(settings, task, source, index, onProgress = () => {}) {
  onProgress(`Source analyst ${index}: reading ${source.url}`);
  const analysis = parseJSON(await callAIRaw(
    settings,
    buildBrowserSourceAnalysisPrompt(task, source, source.page, index - 1, 0),
    { onUsage: trackUsage }
  ));
  const facts = Array.isArray(analysis?.facts) ? analysis.facts.slice(0, 6) : [];

  return {
    index,
    title: source.page.title || source.title,
    url: source.url,
    summary: analysis?.summary || summarizeScrapedPage(source.page),
    facts,
  };
}

function buildBrowserResearchSynthesisPrompt(task, subQueries, analyzedSources) {
  const sourceText = analyzedSources.map(source => [
    `[${source.index}] ${source.title}`,
    `URL: ${source.url}`,
    `Summary: ${source.summary}`,
    ...(source.facts || []).map(fact => `- ${fact}`),
  ].join('\n')).join('\n\n');

  return [
    'You are a lead research synthesis agent.',
    `Research question: ${task}`,
    `Query paths used: ${(subQueries || []).join(' | ')}`,
    'Using only the source analyst notes below, write a structured research report.',
    'Requirements:',
    '- Start with a short executive summary.',
    '- Then present key findings and comparisons.',
    '- Mention conflicts or uncertainty when sources disagree.',
    '- Cite sources inline as [1], [2], etc.',
    '- End with a short sources list.',
    '',
    sourceText,
  ].join('\n');
}

function buildSummarizePrompt(task, page, profileData = {}) {
  // v1.15.6: customInfo is an ARRAY of {key,value} — format it explicitly so
  // the generic Object.entries below never renders "[object Object]".
  const custom = Array.isArray(profileData?.customInfo)
    ? profileData.customInfo
      .map(e => `${String(e?.key || '').trim()}: ${String(e?.value ?? '').trim()}`)
      .filter(s => !s.startsWith(':') && !s.endsWith(': ') && s.trim() !== ':')
    : [];
  const profileNotes = [
    ...Object.entries(profileData || {})
      .filter(([key]) => key !== 'customInfo')
      .filter(([, value]) => String(value || '').trim())
      .map(([key, value]) => `${key}: ${value}`),
    ...custom,
  ].join(' | ') || 'none';

  return [
    'You are a page summarization sub-agent.',
    `Goal: ${task}`,
    `Page title: ${page.title || ''}`,
    `URL: ${page.url || ''}`,
    `Description: ${page.description || ''}`,
    `Headings: ${(page.headings || []).slice(0, 15).join(' | ')}`,
    `User profile context: ${profileNotes}`,
    `Page text: ${(page.text || '').substring(0, 12000)}`,
    'Write a concise summary with:',
    '- one paragraph overview',
    '- 4-6 bullet key points',
    '- any important action items or conclusions',
    'Do not mention screenshots.',
  ].join('\n');
}

async function analyzeScrapeWithSubAgents(settings, task, page) {
  const rawResponse = await callAIRaw(settings, buildScrapeExtractionPrompt(task, page), { onUsage: trackUsage });
  
  let jsonString = rawResponse;
  const blocksMatch = rawResponse.match(/<blocks>([\s\S]*?)<\/blocks>/i);
  if (blocksMatch && blocksMatch[1]) {
    jsonString = blocksMatch[1];
  }

  const planned = parseJSON(jsonString);
  return {
    summary: planned?.summary || summarizeScrapedPage(page),
    rows: Array.isArray(planned?.rows) && planned.rows.length ? planned.rows : buildDefaultScrapeRows(page),
    recommendedFormat: Array.isArray(planned?.rows) && planned.rows.length ? 'csv' : 'json',
    raw: {
      title: page.title,
      url: page.url,
      headings: page.headings,
      emails: page.emails,
      phones: page.phones,
      links: (page.links || []).slice(0, 25),
      tables: page.tables,
    },
  };
}

function buildDefaultScrapeRows(page) {
  if (Array.isArray(page.tables?.[0]) && page.tables[0].length > 1) {
    const [header, ...rows] = page.tables[0];
    return rows.map(row => Object.fromEntries(header.map((key, index) => [key || `col_${index + 1}`, row[index] || '']))).slice(0, 50);
  }

  return (page.links || []).slice(0, 30).map(link => ({
    text: link.text,
    href: link.href,
  }));
}

function buildDefaultScrapeResult(task, page) {
  return {
    summary: task ? `${task} completed from the current page.` : 'Structured page scrape completed.',
    rows: buildDefaultScrapeRows(page),
    recommendedFormat: page.tables?.length ? 'csv' : 'json',
    raw: {
      title: page.title,
      url: page.url,
      headings: page.headings,
      emails: page.emails,
      phones: page.phones,
      links: (page.links || []).slice(0, 25),
      tables: page.tables,
    },
  };
}

async function exportDataPayload(payload, options = {}) {
  const settings = options.settings || await getSettings();
  const formats = (Array.isArray(options.formats) && options.formats.length
    ? options.formats
    : [options.format || settings.exportFormat || 'json']
  ).map(item => String(item || '').toLowerCase());
  const result = await downloadExportFile({
    dataset: payload,
    formats,
    baseName: options.baseName,
    folder: settings.exportFolder || 'Open Comet Exports',
    diskLabel: settings.exportDiskLabel || 'Default Downloads',
    prompt: Boolean(settings.exportPrompt),
  });

  const exportList = Array.isArray(result) ? result : [result];
  for (const item of exportList) {
    await appendExport({
      id: `exp_${Date.now()}_${item.format}`,
      time: Date.now(),
      format: item.format,
      filename: item.filename,
      kind: payload?.kind || 'generic',
    });
  }

  return exportList;
}

async function handleAutoScrape(msg, respond) {
  const settings = await getSettings();
  if (!settings.apiKey && settings.provider !== 'ollama') {
    respond({ ok: false, error: 'No AI API key configured in Settings.' });
    return;
  }

  const task = String(msg.task || '').trim();
  if (!task) {
    respond({ ok: false, error: 'No scraping goal provided.' });
    return;
  }

  respond({ ok: true });

  const options = {
    maxSites: clampInt(msg.maxSites, settings.deepResearchMaxSites || 6, 2, 12),
    maxQueries: 2,
    searchEngine: String(settings.deepResearchSearchEngine || 'google').toLowerCase(),
  };
  
  const onProgress = text => broadcastMessage({ type: MSG.SCRAPE_STEP, text });
  const openedTabs = [];

  try {
    onProgress(`Starting auto-campaign search (${options.searchEngine})...`);

    const raw = await callAI(settings, buildDecompositionPrompt(task), null, { onUsage: trackUsage });
    const subQueries = Array.isArray(raw?.queries) && raw.queries.length
      ? raw.queries.slice(0, options.maxQueries).map(String).filter(Boolean)
      : [task];

    const seenUrls = new Set();
    const candidateSources = [];

    for (let i = 0; i < subQueries.length; i++) {
      const query = subQueries[i];
      onProgress(`Search ${i + 1}/${subQueries.length}: ${query}`);
      const searchTab = await openResearchTab(buildSearchUrl(options.searchEngine, query), false);
      openedTabs.push(searchTab.id);
      const results = await scrapeSearchResults(searchTab.id, options.searchEngine);

      for (const result of results) {
        const url = String(result.url || '');
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);
        candidateSources.push({ url, title: result.title || url });
        if (candidateSources.length >= options.maxSites * 2) break;
      }
      if (candidateSources.length >= options.maxSites * 2) break;
    }

    const selectedSources = candidateSources.slice(0, options.maxSites);
    if (!selectedSources.length) {
      broadcastMessage({ type: MSG.AUTO_SCRAPE_ERROR, error: 'No relevant sources were found.' });
      return;
    }

    let mergedRows = [];
    
    for (let i = 0; i < selectedSources.length; i++) {
      const source = selectedSources[i];
      onProgress(`Scraping tab ${i + 1}/${selectedSources.length}...`);
      const tab = await openResearchTab(source.url, false);
      openedTabs.push(tab.id);
      const page = await scrapeReadablePage(tab.id);
      
      const extraction = await analyzeScrapeWithSubAgents(settings, task, page);
      if (Array.isArray(extraction?.rows)) {
        // Tag rows with source url context since they are merged
        const taggedRows = extraction.rows.map(row => ({ source_parent_url: source.url, ...row }));
        mergedRows = mergedRows.concat(taggedRows);
      }
    }

    if (!mergedRows.length) {
       broadcastMessage({ type: MSG.AUTO_SCRAPE_ERROR, error: 'Failed to extract any structured rows from the selected sites.' });
       return;
    }

    const finalDataset = {
      title: `Auto Campaign: ${task.substring(0, 50)}`,
      summary: `Scraped ${mergedRows.length} total rows from ${selectedSources.length} sources.`,
      rows: mergedRows,
      kind: 'auto_scrape',
      sources: selectedSources.map(s => s.url)
    };

    let exportsMeta = [];
    if (msg.autoExport !== false) {
      onProgress('Exporting compiled dataset...');
      exportsMeta = await exportDataPayload(finalDataset, {
        settings,
        formats: msg.formats,
        baseName: `Campaign Scrape - ${Math.round(Date.now() / 1000)}`,
      });
    }

    broadcastMessage({
      type: MSG.AUTO_SCRAPE_DONE,
      task,
      dataset: finalDataset,
      page: {}, 
      exports: exportsMeta,
      exportMeta: exportsMeta,
    });
  } catch (err) {
    broadcastMessage({ type: MSG.AUTO_SCRAPE_ERROR, error: err.message });
  } finally {
    await closeTabs(openedTabs);
  }
}

// TAB HELPERS
// -----------------------------------------------------------------------------
async function syncTab() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const active = tabs.find(t => t.active && agentState.taskTabIds.includes(t.id));
    if (active) { agentState.agentTabId = active.id; rememberTab(active); return active.id; }
  } catch {}
  return agentState.agentTabId;
}

function rememberTab(tab) {
  if (!tab?.id) return;
  agentState.taskTabGraph[tab.id] = { id: tab.id, title: tab.title || '', url: tab.url || '', host: getHostFromUrl(tab.url), active: Boolean(tab.active), lastSeen: Date.now() };
}

async function getTabsSnapshot() {
  const out = [];
  for (const id of agentState.taskTabIds) {
    try {
      const tab = await chrome.tabs.get(id);
      rememberTab(tab);
      out.push({ id: tab.id, title: tab.title, url: tab.url, host: getHostFromUrl(tab.url), active: tab.active });
    } catch {
      const fb = agentState.taskTabGraph[id];
      if (fb) out.push(fb);
    }
  }
  return out;
}

async function waitForLoad(tabId) {
  return new Promise(resolve => {
    let attempts = 0;
    const check = () => {
      attempts++;
      chrome.tabs.get(tabId, tab => {
        if (chrome.runtime.lastError || attempts > 20 || tab.status === 'complete') resolve();
        else setTimeout(check, 300);
      });
    };
    setTimeout(check, 500);
  });
}

// v1.15 TAB-GROUP SANDBOX: the real logic lives in lib/tab-sandbox.js (shared
// with actions.js); this wrapper keeps the historical call sites stable.
async function groupTaskTabs(tabIds) {
  const groupId = await ensureTaskGroup(agentState, tabIds);
  if (Number.isInteger(groupId)) agentState.agentGroupId = groupId;
  return groupId;
}

// -----------------------------------------------------------------------------
// STOP / RESET
// -----------------------------------------------------------------------------
async function handleStop(respond) {
  const wasPaused  = agentState.paused;     // capture BEFORE clearing (v1.16.1)
  const wasRunning = agentState.running;
  agentState.stopRequested  = true;
  agentState.running        = false;
  agentState.paused         = false;
  agentState.pendingApproval= null;
  stopRunKeepalive();   // user ended the run — release the heartbeat
  clearActiveRunSnapshot();   // v1.16.1: crash-recovery snapshot no longer needed
  // v1.15.1 ASK-BEFORE-ACTING: a run paused on the per-action approval card
  // must be released too, or the loop would wait forever on a dead gate.
  resolveAllActionApprovals('stop');
  // SIH fix: privacy runs were UNSTOPPABLE — the loop's only abort check is
  // its AbortSignal and nothing ever called .abort(). Pull it here so the
  // Stop button (and Reset) actually interrupts a privacy run.
  try { agentState._privacyAbort?.abort?.(); } catch { /* already aborted */ }
  // v1.16.1 ZOMBIE-UI FIX: when the standard loop had ALREADY returned at the
  // approval gate (agentState.paused), nothing was alive to broadcast
  // AGENT_STOPPED — the sidepanel stayed setRunning(true) forever. A paused
  // run has no live loop, so Stop must finalize it here. (A LIVE privacy run
  // finalizes via its own onError on the abort above; a live standard loop
  // sees stopRequested on its next check.)
  if (wasPaused && wasRunning) {
    agentState.finalStatus = 'stopped';
    setBadge('', '#7c6af7');
    pushStep(STEP_TYPE.EXECUTING, 'Task stopped by you.');
    broadcastMessage({ type: MSG.AGENT_STOPPED });
    appendHistory({
      id: agentState.sessionId,
      task: agentState.task,
      status: 'stopped',
      result: 'Stopped by user while paused for approval.',
      steps: agentState.steps.length,
      time: Date.now(),
      mode: agentState.mode || 'agent',
    });
  }
  if (respond) respond({ ok: true });
}

async function handleReset(respond) {
  agentState.stopRequested  = true;
  agentState.running        = false;
  agentState.paused         = false;
  agentState.pendingApproval= null;
  agentState.finalStatus    = 'idle';
  stopRunKeepalive();   // reset ends any run — release the heartbeat
  resolveAllActionApprovals('stop');   // v1.15.1: release a paused approval gate too
  // SIH fix: also abort an in-flight privacy run (same as handleStop).
  try { agentState._privacyAbort?.abort?.(); } catch { /* already aborted */ }
  setBadge('', '#7c6af7');
  broadcastMessage({ type: MSG.CHAT_RESET, sessionId: agentState.sessionId });
  // Free the on-device KV cache for the dead session (gemma4-engine hygiene).
  const deadSessionId = agentState.sessionId;
  try {
    await ensureOffscreen();
    sendToOffscreen({ type: 'LOCAL_KV_DISPOSE', sessionId: deadSessionId }, { timeoutMs: 5000 }).catch(() => {});
  } catch { /* offscreen not running — nothing to free */ }
  if (respond) respond({ ok: true });
}

// -----------------------------------------------------------------------------
// MESSAGING
// -----------------------------------------------------------------------------
function pushStep(type, text, extra = {}) {
  if (type === STEP_TYPE.SCREENSHOT && !extra.imageDataUrl) return;
  const now = Date.now();
  const prev = agentState.steps[agentState.steps.length - 1];
  // dtMs = time since the previous step — the side panel renders this as a
  // per-step duration chip so slow VLM turns are visible while they happen.
  const dtMs = prev ? Math.max(0, now - prev.time) : 0;
  const step = { type, text, ...extra, time: now, dtMs, index: agentState.steps.length };
  agentState.steps.push(step);
  broadcastMessage({ type: MSG.STEP_UPDATE, step, stepCount: agentState.steps.length });
  console.log(`[Open Comet] ${text}${dtMs > 0 ? `  (+${(dtMs / 1000).toFixed(1)}s)` : ''}`);
}

function asImageDataUrl(base64) {
  const clean = String(base64 || '').replace(/\s+/g, '');
  if (!clean) return '';
  return clean.startsWith('data:image') ? clean : `data:image/jpeg;base64,${clean}`;
}

function broadcastStatus(status) {
  broadcastMessage({ type: MSG.STATE_UPDATE, status, state: agentState });
}

function broadcast(type) {
  // v1.15.1 CRITICAL FIX (user-reported: "Task already completed but in Sidebar
  // UI still shows stop button"): privacy-flow callers pass a FULL message
  // object — broadcast({ type: MSG.AGENT_DONE, summary }) — while this helper's
  // name suggests a bare type string. The object was double-wrapped into
  // { type: {type:'AGENT_DONE',…} }, so the sidepanel's switch NEVER matched:
  // AGENT_DONE / AGENT_ERROR were silently dropped, the panel stayed in
  // "running" state forever (Stop button visible after completion, no result
  // card), and clicking Stop afterwards produced the confusing
  // "Stopping…" + "Unable to add context right now." sequence in the field
  // log. Normalize both call styles here.
  broadcastMessage(typeof type === 'string' ? { type } : type);
}

function broadcastMessage(msg) {
  const payload = { ...msg, sessionId: msg.sessionId || agentState.sessionId || '' };
  chrome.runtime.sendMessage(payload).catch(() => {});
  broadcastToTabs(payload);
}

function broadcastToTabs(msg) {
  const ids = new Set([agentState.currentTabId, agentState.agentTabId, ...agentState.taskTabIds].filter(Number.isInteger));
  for (const id of ids) chrome.tabs.sendMessage(id, msg).catch(() => {});
}

// -----------------------------------------------------------------------------
// MISC HELPERS
// -----------------------------------------------------------------------------
function imageAttachments() {
  return (agentState.attachments || []).filter(a => a.kind === 'image' && a.imageBase64).map(a => ({ name: a.name, mimeType: a.mimeType || 'image/jpeg', imageBase64: a.imageBase64 }));
}

function cloneAttachments(list) {
  return (list || []).map(a => ({ id: a.id || `att_${Date.now()}`, kind: a.kind || 'file', name: a.name || 'attachment', mimeType: a.mimeType || 'application/octet-stream', size: Number(a.size) || 0, textContent: String(a.textContent || ''), truncated: Boolean(a.truncated), imageBase64: String(a.imageBase64 || '') }));
}

function cloneSkills(list) {
  return (list || []).map(s => ({ id: s.id || `sk_${Date.now()}`, name: String(s.name || 'Skill'), prompt: String(s.prompt || ''), allowedHosts: (s.allowedHosts || []).map(normalizeHost).filter(Boolean), preferredSites: (s.preferredSites || []).map(String), doneChecklist: (s.doneChecklist || []).map(String) }));
}

function notify(title, message) {
  try {
    chrome.notifications.create({ type: 'basic', iconUrl: 'assets/icons/icon128.png', title: String(title).substring(0, 80), message: String(message).replace(/\s+/g, ' ').trim().substring(0, 240), priority: 1 });
  } catch {}
}

function setBadge(text, color) {
  try { chrome.action.setBadgeBackgroundColor({ color }); chrome.action.setBadgeText({ text: String(text || '') }); } catch {}
}

// Browser-native research, summarize, scrape, and export handlers.
// These late declarations intentionally override any older placeholder versions above.
async function handleDeepResearch(msg, respond) {
  const settings = await getSettings();
  const task = String(msg.task || '').trim();
  if (!task) {
    respond({ ok: false, error: 'No research question provided.' });
    return;
  }
  if (!isProviderConfigured(settings)) {
    respond({ ok: false, error: 'No AI provider configured in Settings.' });
    return;
  }

  respond({ ok: true });

  const onProgress = text => broadcastMessage({ type: MSG.DEEP_RESEARCH_STEP, text });
  const maxSites = clampNumber(msg.maxSites ?? settings.deepResearchMaxSites, 2, 12, 6);
  const maxQueries = clampNumber(msg.maxQueries ?? settings.deepResearchMaxQueries, 1, 6, 4);
  const engine = String(msg.searchEngine || settings.deepResearchSearchEngine || 'google').toLowerCase();
  const preferredHosts = parseSiteHints(msg.siteHints || settings.deepResearchPreferredHosts || []);
  const useSubAgents = msg.useSubAgents ?? settings.useSubAgents ?? true;
  const concurrency = useSubAgents ? clampNumber(settings.subAgentConcurrency, 1, 4, 3) : 1;

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const searchTabIds = [];
  const sourceTabIds = [];

  try {
    onProgress(`Starting browser-powered deep research using ${engine}.`);
    onProgress(`Collecting up to ${maxSites} sites${preferredHosts.length ? ` with preference for ${preferredHosts.join(', ')}` : ''}.`);

    const { subQueries: plannedQueries } = await deepResearch(
      task,
      {},
      onProgress,
      (aiSettings, prompt) => callAI(aiSettings, prompt, null, { onUsage: trackUsage }),
      settings
    );
    const subQueries = (plannedQueries || [task]).slice(0, maxQueries);
    onProgress(`Planner created ${subQueries.length} research queries.`);

    const candidateSources = [];
    const seenUrls = new Set();

    for (let index = 0; index < subQueries.length; index++) {
      const query = subQueries[index];
      onProgress(`Searching query ${index + 1}/${subQueries.length}: ${query}`);
      const searchTab = await openResearchTab(buildSearchUrl(engine, query), {
        active: false,
        openerTabId: activeTab?.id,
      });
      searchTabIds.push(searchTab.id);

      const results = await scrapeSearchResults(searchTab.id, engine, Math.max(6, maxSites * 2), preferredHosts);
      for (const result of results) {
        if (!result?.url || seenUrls.has(result.url)) continue;
        seenUrls.add(result.url);
        candidateSources.push({ ...result, query });
      }
      onProgress(`Found ${results.length} candidate results for query ${index + 1}.`);
    }

    const sources = pickResearchSources(candidateSources, preferredHosts, maxSites);
    if (!sources.length) throw new Error('No sources could be collected from browser search results.');

    onProgress(`Opening ${sources.length} source tabs for review.`);
    for (const source of sources) {
      const tab = await openResearchTab(source.url, { active: false, openerTabId: activeTab?.id });
      source.tabId = tab.id;
      sourceTabIds.push(tab.id);
      rememberTab(tab);
    }
    await groupLooseTabs(sourceTabIds, `Research: ${task}`);
    await closeTabs(searchTabIds);

    const analyzedSources = await runWithConcurrency(
      sources.map((source, index) => async () => {
        onProgress(`${useSubAgents ? `Sub-agent ${index + 1}` : 'Reviewer'} reading ${source.host || getHostFromUrl(source.url)}.`);
        const page = await scrapeReadablePage(source.tabId);
        const digest = await summarizeSourceWithAI(task, source, page, index, sources.length, settings);
        return {
          ...source,
          ...digest,
          page,
          title: source.title || page.title || source.url,
          host: source.host || getHostFromUrl(source.url),
          summary: digest.summary || page.metaDescription || page.readableText?.substring(0, 600) || '',
          snippet: source.snippet || page.metaDescription || '',
        };
      }),
      concurrency
    );

    onProgress(`Synthesizer role: merging ${analyzedSources.length} reviewed sources.`);
    const report = await runSynthesizerRole(settings, buildSynthesisPrompt(task, subQueries, analyzedSources));

    broadcastMessage({
      type: MSG.DEEP_RESEARCH_DONE,
      task,
      report,
      subQueries,
      sources: analyzedSources.map(source => ({
        title: source.title,
        url: source.url,
        host: source.host,
        summary: source.summary,
      })),
    });

    await appendHistory({
      id: `dr_${Date.now()}`,
      task,
      status: 'done',
      result: String(report || '').substring(0, 300),
      steps: analyzedSources.length,
      time: Date.now(),
      mode: 'deep_research',
    });
  } catch (err) {
    broadcastMessage({ type: MSG.DEEP_RESEARCH_ERROR, error: err.message });
  }
}

async function handleSummarizePage(msg, respond) {
  const settings = await getSettings();
  if (!isProviderConfigured(settings)) {
    respond({ ok: false, error: 'No AI provider configured in Settings.' });
    return;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  respond({ ok: true });

  try {
    const page = await scrapeReadablePage(activeTab.id);
    const extractPage = compactPageContext(page, settings, {
      role: AGENT_ROLE.EXTRACTOR,
      taskProfile: 'summarize',
    });
    const prompt = `Extractor role: summarize the current page.

URL: ${extractPage.url}
Title: ${extractPage.title}
Headings: ${(extractPage.headings || []).join(' | ')}

Page text:
${String(extractPage.readableText || extractPage.text || '').substring(0, 12000)}

Instructions:
- Return plain markdown.
- Start with a 2-3 sentence overview.
- Then list 4-6 bullet key points.
- Use only the provided content.`;
    const summary = await callAIRaw(settings, prompt, { onUsage: trackUsage });
    broadcastMessage({
      type: MSG.SUMMARIZE_DONE,
      task: msg.task || page.title || 'Summarize current page',
      summary,
      page,
    });
  } catch (err) {
    logSW.error('summarize failed:', err?.message || String(err));
    broadcastMessage({ type: MSG.SUMMARIZE_ERROR, error: err.message });
  }
}

async function handleScrapePage(msg, respond) {
  const settings = await getSettings();
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  respond({ ok: true });

  try {
    const goal = String(msg.task || msg.prompt || '').trim();
    const siteHints = collectScrapeSiteHints(goal, msg.siteHints || []);
    let workingTabId = activeTab.id;
    let page = null;

    if (siteHints.length && !siteHints.includes(normalizeHost(activeTab.url || ''))) {
      const searchEngine = String(settings.deepResearchSearchEngine || 'google').toLowerCase();
      const searchQuery = buildTargetedScrapeQuery(goal, siteHints);
      broadcastMessage({ type: MSG.SCRAPE_STEP, text: `Finding a better source for scraping on ${siteHints.join(', ')}...` });
      const searchTab = await openResearchTab(buildSearchUrl(searchEngine, searchQuery), { active: false, openerTabId: activeTab.id });
      const results = await scrapeSearchResults(searchTab.id, searchEngine, 8, siteHints);
      const picked = pickResearchSources(
        results.map(result => ({ ...result, host: normalizeHost(result.host || result.url || '') })),
        siteHints,
        1
      )[0];
      await closeTabs([searchTab.id]);
      if (picked?.url) {
        const sourceTab = await openResearchTab(picked.url, { active: false, openerTabId: activeTab.id });
        workingTabId = sourceTab.id;
      }
    }

    broadcastMessage({ type: MSG.SCRAPE_STEP, text: workingTabId === activeTab.id ? 'Scraping the current page...' : 'Scraping the best-matched source page...' });
    page = await scrapeReadablePage(workingTabId);
    const requestedFormats = normalizeExportFormats(msg.formats?.length ? msg.formats : [settings.exportFormat, ...(settings.defaultScrapeFormats || [])]);

    let dataset = createFallbackDataset(page, goal);
    dataset.siteHints = siteHints;
    if (isProviderConfigured(settings)) {
      try {
        broadcastMessage({ type: MSG.SCRAPE_STEP, text: 'Structuring scraped data with AI...' });
        const extractPage = compactPageContext(page, settings, {
          role: AGENT_ROLE.EXTRACTOR,
          taskProfile: 'summarize',
        });
        const aiResult = await callAI(settings, buildScrapeExtractionPrompt(goal, extractPage), null, { onUsage: trackUsage });
        if (aiResult && Array.isArray(aiResult.rows) && aiResult.rows.length) {
          dataset = {
            ...dataset,
            ...aiResult,
            sourceUrl: page.url,
            sourceTitle: page.title,
            extractedAt: new Date().toISOString(),
          };
        }
      } catch (err) {
        broadcastMessage({ type: MSG.SCRAPE_STEP, text: `AI structuring fallback: ${err.message}` });
      }
    }

    const baseName = makeExportBaseName(goal || page.title || 'scrape');
    const exports = [];
    const shouldAutoExport = Boolean(msg.autoExport || settings.autoExportScrapes);
    await runCheckpoint(AGENT_HOOK.AFTER_SCRAPE, { page, dataset });
    if (shouldAutoExport) {
      await runCheckpoint(AGENT_HOOK.BEFORE_EXPORT, { page, dataset, formats: requestedFormats });
      for (const format of requestedFormats) {
        const exported = await downloadExportFile({
          dataset,
          format,
          folder: settings.exportFolder,
          diskLabel: settings.exportDiskLabel,
          baseName,
          prompt: Boolean(settings.exportPrompt),
        });
        exports.push(exported);
        await appendExport({
          id: `exp_${Date.now()}_${format}`,
          type: 'scrape',
          format,
          filename: exported.filename,
          task: goal || page.title || 'Scrape page',
          url: page.url,
          time: Date.now(),
        });
      }
    }

    broadcastMessage({
      type: MSG.SCRAPE_DONE,
      task: goal || page.title || 'Scrape page',
      dataset,
      exports,
    });
  } catch (err) {
    broadcastMessage({ type: MSG.SCRAPE_ERROR, error: err.message });
  }
}

async function handleExportData(msg, respond) {
  const settings = await getSettings();
  const formats = normalizeExportFormats(msg.formats || [msg.format || settings.exportFormat || 'json']);
  const dataset = msg.dataset || {};

  try {
    await runCheckpoint(AGENT_HOOK.BEFORE_EXPORT, { dataset, formats });
    const exports = [];
    for (const format of formats) {
      const exported = await downloadExportFile({
        dataset,
        format,
        folder: settings.exportFolder,
        diskLabel: settings.exportDiskLabel,
        baseName: makeExportBaseName(msg.baseName || dataset.title || 'export'),
        prompt: Boolean(msg.prompt ?? settings.exportPrompt),
      });
      exports.push(exported);
      await appendExport({
        id: `exp_${Date.now()}_${format}`,
        type: msg.type || 'manual',
        format,
        filename: exported.filename,
        task: msg.baseName || dataset.title || 'Export data',
        url: dataset.sourceUrl || '',
        time: Date.now(),
      });
    }
    respond({ ok: true, exports });
  } catch (err) {
    respond({ ok: false, error: err.message });
  }
}

function parseSiteHints(value) {
  const rawList = Array.isArray(value)
    ? value
    : String(value || '').split(/[\n,]/);
  return [...new Set(rawList.map(normalizeHost).filter(Boolean))];
}

function collectScrapeSiteHints(task = '', explicitHints = []) {
  const direct = parseSiteHints(explicitHints);
  const text = String(task || '').toLowerCase();
  const inlineDomains = [...text.matchAll(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/g)].map(match => normalizeHost(match[0]));
  const hinted = [];

  const keywordMap = [
    { pattern: /\bamazon\b/, host: 'amazon.in' },
    { pattern: /\bflipkart\b/, host: 'flipkart.com' },
    { pattern: /\bgithub\b/, host: 'github.com' },
    { pattern: /\blinkedin\b/, host: 'linkedin.com' },
    { pattern: /\byoutube\b/, host: 'youtube.com' },
    { pattern: /\bwikipedia\b/, host: 'wikipedia.org' },
    { pattern: /\bimdb\b/, host: 'imdb.com' },
    { pattern: /\bstackoverflow\b/, host: 'stackoverflow.com' },
    { pattern: /\bmedium\b/, host: 'medium.com' },
    { pattern: /\bnews\b/, host: 'news.google.com' },
  ];

  for (const entry of keywordMap) {
    if (entry.pattern.test(text)) hinted.push(entry.host);
  }

  return [...new Set([...direct, ...inlineDomains, ...hinted].filter(Boolean))];
}

function buildTargetedScrapeQuery(task = '', siteHints = []) {
  const cleanTask = String(task || '').trim();
  const sites = (siteHints || []).slice(0, 3).map(host => `site:${host}`);
  return [cleanTask, ...sites].filter(Boolean).join(' ');
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function pickResearchSources(candidates, preferredHosts, maxSites) {
  const preferred = new Set((preferredHosts || []).filter(Boolean));
  const ranked = [...(candidates || [])].sort((a, b) => {
    const aPreferred = preferred.has(a.host) ? 1 : 0;
    const bPreferred = preferred.has(b.host) ? 1 : 0;
    if (aPreferred !== bPreferred) return bPreferred - aPreferred;
    if ((a.host || '') !== (b.host || '')) return (a.host || '').localeCompare(b.host || '');
    return (a.title || '').length - (b.title || '').length;
  });

  const picked = [];
  const seenHosts = new Set();
  const seenUrls = new Set();
  for (const candidate of ranked) {
    if (!candidate?.url || seenUrls.has(candidate.url)) continue;
    if (seenHosts.has(candidate.host) && picked.length < maxSites * 2) continue;
    picked.push(candidate);
    seenUrls.add(candidate.url);
    if (candidate.host) seenHosts.add(candidate.host);
    if (picked.length >= maxSites) break;
  }
  return picked;
}

async function summarizeSourceWithAI(task, source, page, index, total, settings) {
  const compactPage = compactPageContext(page, settings, {
    role: AGENT_ROLE.EXTRACTOR,
    taskProfile: 'deep_research',
  });
  const fallback = {
    summary: String(compactPage.metaDescription || compactPage.readableText || compactPage.text || '').substring(0, 700),
    keyPoints: (compactPage.headings || []).slice(0, 5),
    facts: [],
    entities: [],
    confidence: 'medium',
  };

  try {
    const result = await callAI(settings, buildBrowserSourceAnalysisPrompt(task, source, compactPage, index, total), null, { onUsage: trackUsage });
    return typeof result === 'object' && result ? { ...fallback, ...result } : fallback;
  } catch {
    return fallback;
  }
}

function createFallbackDataset(page, goal = '') {
  const rows = [];

  for (const heading of (page.headings || []).slice(0, 12)) {
    rows.push({ type: 'heading', value: heading, url: page.url });
  }
  for (const link of (page.links || []).slice(0, 20)) {
    rows.push({ type: 'link', text: link.text, href: link.href, url: page.url });
  }
  for (const table of (page.tables || []).slice(0, 2)) {
    for (const row of (table.rows || []).slice(0, 8)) {
      rows.push(Object.fromEntries(row.map((cell, index) => [`Column ${index + 1}`, cell])));
    }
  }

  return {
    title: goal || page.title || 'Page scrape',
    summary: page.metaDescription || String(page.readableText || page.text || '').substring(0, 400),
    columns: inferDatasetColumns(rows),
    rows,
    sourceUrl: page.url,
    sourceTitle: page.title,
    extractedAt: new Date().toISOString(),
  };
}

function inferDatasetColumns(rows) {
  const columns = new Set();
  for (const row of rows || []) {
    Object.keys(row || {}).forEach(key => columns.add(key));
  }
  return [...columns];
}

function normalizeExportFormats(formats) {
  const allowed = new Set(['json', 'csv', 'txt', 'md']);
  const values = Array.isArray(formats) ? formats : [formats];
  const normalized = [...new Set(values.map(value => String(value || '').toLowerCase()).filter(value => allowed.has(value)))];
  return normalized.length ? normalized : ['json'];
}

function makeExportBaseName(value) {
  return String(value || 'open-comet-export')
    .replace(/[^\w\s-]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
    .substring(0, 60)
    .toLowerCase() || `open-comet-export-${Date.now()}`;
}

async function runWithConcurrency(tasks, concurrency = 2) {
  const results = new Array(tasks.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length || 1)) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      results[index] = await tasks[index]();
    }
  });

  await Promise.all(workers);
  return results;
}

async function groupLooseTabs(tabIds, title = 'Open Comet Research') {
  const ids = [...new Set((tabIds || []).filter(Number.isInteger))];
  if (!ids.length) return null;
  try {
    const groupId = await chrome.tabs.group({ tabIds: ids });
    await chrome.tabGroups.update(groupId, {
      title: String(title || 'Open Comet Research').substring(0, 40),
      color: 'blue',
      collapsed: false,
    });
    return groupId;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVACY-MODE HANDLERS
// Routes that delegate to the privacy-aware agent loop (privacy-loop.js).
// Triggered when the user enables "Privacy Mode" in the side panel.
// ─────────────────────────────────────────────────────────────────────────────

// ── Browser-internal page bootstrap ────────────────────────────────────────
// Users press Start from chrome://newtab ALL the time (it IS the default
// landing page). Blocking with an error made the product feel broken
// (user: "WTF we always user is not able to start task with new tab?").
// Instead we infer a useful landing page from the task text and navigate
// the disposable tab there automatically.
const PRIVILEGED_URL_RE_SW = /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension):|^https?:\/\/chromewebstore\.google\.com/i;
let pendingBootstrapNote = null;

function inferStartUrlFromTask(task) {
  const t = String(task || '').toLowerCase();
  const SITES = [
    // v1.9: "yt music" / "youtube music" must land on YouTube Music itself —
    // the generic youtube rule used to open www.youtube.com and the VLM then
    // burned 1-2 full turns (30-90 s each) navigating to music.youtube.com.
    [/yt\s*music|youtube\s*music|music\.youtube/, 'https://music.youtube.com'],
    [/youtube|\byt\b|play a song|song\b|music video|watch video/, 'https://www.youtube.com'],
    [/gmail|inbox|check my mail|\bmail\b/, 'https://mail.google.com'],
    [/wikipedia/, 'https://en.wikipedia.org'],
    [/flipkart/, 'https://www.flipkart.com'],
    [/amazon|order online|shop online/, 'https://www.amazon.in'],
    [/github|\brepo\b/, 'https://github.com'],
    [/twitter|x\.com|tweet/, 'https://x.com'],
    [/instagram|\binsta\b/, 'https://www.instagram.com'],
    [/facebook|\bfb\b/, 'https://www.facebook.com'],
    [/netflix|watch a movie|\bmovie\b/, 'https://www.netflix.com'],
    [/spotify|play .*playlist/, 'https://open.spotify.com'],
    [/whatsapp/, 'https://web.whatsapp.com'],
    [/linkedin/, 'https://www.linkedin.com'],
    [/reddit/, 'https://www.reddit.com'],
    [/stack\s*overflow/, 'https://stackoverflow.com'],
    [/chatgpt/, 'https://chatgpt.com'],
    [/\bnews\b|headline/, 'https://news.google.com'],
    [/cricket|\bipl\b|\bscore\b/, 'https://www.cricbuzz.com'],
  ];
  for (const [re, url] of SITES) if (re.test(t)) return url;
  // Explicit domain mention: "on openai.com" / "go to example.org/page"
  const dom = /((?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*\.(?:com|org|net|in|io|co|ai|dev|gov|edu)(?:\/[^\s]*)?)/i.exec(t);
  if (dom) return dom[1].startsWith('http') ? dom[1] : `https://${dom[1]}`;
  return 'https://www.google.com';
}

function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch {}
      resolve(ok);
    };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') done(true); };
    chrome.tabs.onUpdated.addListener(listener);
    // Already complete?
    chrome.tabs.get(tabId).then(t => { if (t && t.status === 'complete') done(true); }).catch(() => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

async function handlePrivacyStart(msg, respond) {
  if (agentState.running || _startBusy) {
    respond({ ok: false, error: 'Already running' });
    return;
  }
  _startBusy = true;
  try {
    await handlePrivacyStartInner(msg, respond);
  } finally {
    _startBusy = false;
  }
}

async function handlePrivacyStartInner(msg, respond) {
  if (agentState.running) {
    respond({ ok: false, error: 'Already running' });
    return;
  }

  const settings = await getSettings();
  // Apply privacy settings from msg or fall back to defaults
  const privacyCfg = msg.privacy || {};
  configurePrivacy({
    enabled: true,
    blurFaces: privacyCfg.blurFaces !== false,
    redactDomPii: privacyCfg.redactDomPii !== false,
    redactTextPii: privacyCfg.redactTextPii !== false,
    runYolo: Boolean(privacyCfg.runYolo),
    useNer: Boolean(privacyCfg.useNer),
    serverUrl: privacyCfg.serverUrl || 'http://127.0.0.1:8787',
  });

  let activeTab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0] || null;
  if (!activeTab) { respond({ ok: false, error: 'No active tab' }); return; }

  // v1.16.0 COLD-START ELIMINATION: warm the on-device vision models in the
  // background while the session's first DOM steps run. The first capture then
  // pays INFERENCE cost only — not the one-time model download + compile
  // (cold-cache ViT load measured 37.9 s on the reference hardware; that load
  // dominated the real-VLM E2E first-step sanitizeMs 41487). YOLO is warmed
  // only when this session opted into it; ViT is warmed unconditionally (the
  // adaptive gate can trigger it on any thin-DOM page). Fire-and-forget: a
  // warm-up failure must never block or fail the session — the first capture
  // would then warm lazily exactly as in every previous version.
  warmupVisionModels({ yolo: Boolean(privacyCfg.runYolo), vit: true })
    .then(r => {
      if (r?.ok) console.log('[Privacy] vision warm-up done:', (r.result?.parts || []).join('+'), `${r.result?.warmupMs ?? '?'}ms`);
      else console.warn('[Privacy] vision warm-up unavailable (non-fatal):', r?.error || 'no response');
    })
    .catch(() => {});

  // Browser-internal page (chrome://newtab etc.) → auto-navigate to a page
  // inferred from the task instead of dead-ending with an error.
  if (PRIVILEGED_URL_RE_SW.test(activeTab.url || '')) {
    activeTab = await (async () => {
      const targetUrl = inferStartUrlFromTask(msg.task);
      let host = targetUrl;
      try { host = new URL(targetUrl).hostname.replace(/^www\./, ''); } catch {}
      pendingBootstrapNote = `Browser-internal page detected (${String(activeTab.url || 'about:blank').slice(0, 40)}) — opening ${host} for your task instead…`;
      try {
        await chrome.tabs.update(activeTab.id, { url: targetUrl });
      } catch {
        try {
          activeTab = await chrome.tabs.create({ url: targetUrl, active: true });
        } catch {
          respond({
            ok: false,
            error: `Privacy mode cannot capture browser-internal pages (${(activeTab.url || 'about:blank').slice(0, 60)}) and automatic navigation failed. Open a normal https:// page and press Start again.`,
          });
          return null;
        }
      }
      await waitForTabLoad(activeTab.id);
      try { const fresh = await chrome.tabs.get(activeTab.id); return fresh || activeTab; } catch { return activeTab; }
    })();
    if (!activeTab) return;
  }

  agentState = createEmptyAgentState({
    running: true,
    currentTabId: activeTab.id,
    sessionId: `privacy_${Date.now()}`,
    mode: 'privacy',
    task: msg.task,
    settings,
    maxIterations: settings.maxSteps || 25,
    startUrl: activeTab.url,
    startTitle: activeTab.title,
  });

  // v1.15.1 ASK-BEFORE-ACTING: the composer mode now REACHES privacy runs
  // (the panel's send interceptor already forwards msg.mode). 'ask' gates
  // every browser action behind an approval card; 'auto' runs immediately.
  agentState.askBeforeActing = String(msg.mode || '') === 'ask';
  resolveAllActionApprovals('stop');   // hygiene: no stale waiter may survive into this run

  // v1.15 TAB-GROUP SANDBOX: privacy runs never created a tab group — the
  // standard agent did, the flagship privacy mode did not. Put the task tab
  // in the sandbox group up front so the boundary exists from step 1 (the
  // loop's capture + actions are additionally enforced against taskTabIds).
  agentState.agentTabId = activeTab.id;
  agentState.taskTabIds = [activeTab.id];
  rememberTab(activeTab);
  await groupTaskTabs([activeTab.id]);

  if (pendingBootstrapNote) {
    pushStep(STEP_TYPE.THINKING, pendingBootstrapNote);
    pendingBootstrapNote = null;
  }
  pushStep(STEP_TYPE.MUTED, 'Tab-group sandbox: task tabs are grouped — the agent acts only inside this group.', { phase: 'sandbox' });

  respond({ ok: true, sessionId: agentState.sessionId });
  broadcast(MSG.AGENT_STARTED);
  setBadge('PRV', '#d9875a');
  startRunKeepalive();
  writeActiveRunSnapshot({ sessionId: agentState.sessionId, task: agentState.task, mode: agentState.mode });   // v1.16.1 crash-recovery snapshot

  const controller = new AbortController();
  agentState._privacyAbort = controller;

  // v1.15.1: this step was broadcast double-wrapped (see broadcast() fix) so
  // it never rendered; pushStep puts it in the chat AND the hydratable state
  // like every other step.
  pushStep(STEP_TYPE.THINKING, 'Privacy mode active — sanitizing before every network call');

  await runPrivacyAgent({
    task: msg.task,
    tabId: activeTab.id,
    settings,
    // v1.15 TAB-GROUP SANDBOX: the loop needs the LIVE state object so
    // executeAction can enforce (and record) task-tab membership. Before this,
    // the privacy loop passed a throwaway `{ settings }` — switch_tab/new_tab/
    // list_tabs/organize_tabs ran blind to the sandbox.
    state: agentState,
    signal: controller.signal,
    // v1.15.1 ASK-BEFORE-ACTING: per-action approval gate (no-op in 'auto').
    askBeforeActing: agentState.askBeforeActing,
    approvalGate: agentState.askBeforeActing ? requestActionApproval : null,
    onStep: (type, text, payload = {}) => {
      // v1.8: pushStep alone is responsible for broadcasting — the previous
      // second raw broadcast below re-sent every step in a DIFFERENT shape
      // (payload nested instead of spread, no index), causing duplicate chat
      // rows and a shape mismatch for the stats interceptor.
      pushStep(type, text, payload);
    },
    onDone: (summary) => {
      agentState.running = false;
      agentState.finalStatus = 'done';
      setBadge('', '#7c6af7');
      stopRunKeepalive();
      pushStep(STEP_TYPE.DONE, `Privacy agent finished in ${summary.steps} steps`, { summary });
      // v1.15.6: information/summary tasks deliver their ANSWER here — the
      // sidepanel's result card renders msg.answer verbatim (markdown ok).
      broadcast({ type: MSG.AGENT_DONE, summary, answer: String(summary?.finalAnswer || '').trim() });
      // v1.8: privacy runs were NEVER written to History (only standard-agent
      // and deep-research runs were) — the History tab therefore showed no
      // chat after privacy-mode tasks. Record done/error/stopped like the
      // standard loop does.
      appendHistory({
        id: agentState.sessionId,
        task: agentState.task,
        status: 'done',
        result: String(summary?.finalAnswer || summary?.finalThought || 'Task complete').substring(0, 300),
        steps: summary?.steps || agentState.steps.length,
        time: Date.now(),
        mode: 'privacy',
      });
    },
    onError: (err) => {
      agentState.running = false;
      agentState.finalStatus = controller.signal.aborted ? 'stopped' : 'error';
      setBadge(controller.signal.aborted ? '' : 'ERR', controller.signal.aborted ? '#7c6af7' : '#f04a6a');
      stopRunKeepalive();
      pushStep(STEP_TYPE.ERROR, `Privacy agent error: ${err.message}`, { error: err.message });
      broadcast({ type: MSG.AGENT_ERROR, error: err.message });
      appendHistory({
        id: agentState.sessionId,
        task: agentState.task,
        status: controller.signal.aborted ? 'stopped' : 'error',
        result: controller.signal.aborted ? 'Stopped by user.' : String(err?.message || err).substring(0, 300),
        steps: agentState.steps.length,
        time: Date.now(),
        mode: 'privacy',
      });
    },
  });
}

// SIH hardening: the ONLY per-call overrides a PRIVACY_CAPTURE message may
// set. Anything else (blurFaces/redactDomPii/redactTextPii/runYolo/force…)
// is dropped — a compromised or malicious sender must never be able to turn
// this into a raw-screenshot-to-cloud primitive.
const SAFE_CAPTURE_OVERRIDES = new Set(['maxWidth', 'quality', 'note']);

async function handlePrivacyCapture(msg, respond) {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) { respond({ ok: false, error: 'No active tab' }); return; }
    const overrides = {};
    for (const [k, v] of Object.entries(msg.overrides || {})) {
      if (SAFE_CAPTURE_OVERRIDES.has(k)) overrides[k] = v;
    }
    const result = await captureAndSanitize(activeTab.id, overrides);
    respond({ ok: true, result });
  } catch (err) {
    respond({ ok: false, error: err.message });
  }
}

// ── Global error traps: uncaught errors / unhandled rejections never vanish ───
installGlobalErrorTraps(logSW, 'SW');

// ── v1.8 build banner ─────────────────────────────────────────────────────────
// Every time this service worker (re)starts it announces its exact build so a
// stale unpacked copy can never be mistaken for the freshly loaded one.
console.log(`[OpenComet] v${(chrome.runtime && typeof chrome.runtime.getManifest === 'function') ? chrome.runtime.getManifest().version : 'dev'} · service worker loaded`);

// ── Run keepalive (MV3 service-worker lifetime) ──────────────────────────────
// An MV3 service worker idles out after ~30s without events. Step broadcasts
// keep it alive BETWEEN phases, but a single long VLM turn (30–180s, zero
// extension-API traffic) can hit the idle timeout mid-run — the worker shows
// as "(Inactive)" and the task dies. While any run is active, a 20s heartbeat
// via chrome.runtime.getPlatformInfo() resets the idle timer; the interval is
// cleared the moment the run finishes/stops/errors.
//
// v1.16.1 CRASH RECOVERY (three stacked mechanisms):
//   1. the 20s interval (primary, as before);
//   2. a 30s chrome.alarms backstop — the interval cannot survive the SW kill
//      it is meant to prevent; an alarm wakes the worker even after a crash;
//   3. a chrome.storage.session run snapshot — boot reconciliation (below)
//      turns a crash mid-run into an honest finalized error instead of an
//      orphaned tab group + a sidepanel stuck on "running".
let _runKeepaliveTimer = null;
function startRunKeepalive() {
  if (_runKeepaliveTimer) return;
  _runKeepaliveTimer = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => {}); } catch { /* noop */ }
  }, 20000);
  // Backstop alarm (~30s minimum period). Failure is non-fatal — the interval
  // and the snapshot still cover the common cases.
  try {
    chrome.alarms?.create('opencomet_run_keepalive', { periodInMinutes: 0.5 });
  } catch { /* alarms unavailable — belt without braces */ }
}
function stopRunKeepalive() {
  if (_runKeepaliveTimer) { clearInterval(_runKeepaliveTimer); _runKeepaliveTimer = null; }
  try { chrome.alarms?.clear('opencomet_run_keepalive'); } catch { /* noop */ }
  clearActiveRunSnapshot();   // every terminal path funnels through here
}

// ── v1.16.1 ACTIVE-RUN SNAPSHOT (chrome.storage.session) ─────────────────
// Written when a run starts, cleared on EVERY terminal path (finish/stop/
// reset/error — all call stopRunKeepalive). If the SW ever boots and the
// snapshot is still present, the previous worker died mid-run.
const ACTIVE_RUN_KEY = 'opencometActiveRun';
function writeActiveRunSnapshot(info) {
  try {
    const p = chrome.storage?.session?.set({ [ACTIVE_RUN_KEY]: { ...info, startedAt: Date.now() } });
    if (p?.catch) p.catch(() => {});
  } catch { /* session storage unavailable — recovery degrades to no-op */ }
}
function clearActiveRunSnapshot() {
  try {
    const p = chrome.storage?.session?.remove(ACTIVE_RUN_KEY);
    if (p?.catch) p.catch(() => {});
  } catch { /* noop */ }
}

// ── v1.16.1 BOOT RECONCILIATION (crash mid-run → honest finalization) ────
// Top-level, runs on every SW start. The snapshot can only still be present
// when the worker died mid-run (every live finalization clears it first):
// the run's async loop is necessarily dead, so we record an honest history
// entry, reset the badge, and release the alarm. The task's tab group is left
// in place (the user may want the tabs) but nothing resumes the dead loop.
(async () => {
  try {
    const data = await chrome.storage?.session?.get(ACTIVE_RUN_KEY);
    const run = data?.[ACTIVE_RUN_KEY];
    if (!run) return;
    await chrome.storage?.session?.remove(ACTIVE_RUN_KEY);
    if (_runKeepaliveTimer) { clearInterval(_runKeepaliveTimer); _runKeepaliveTimer = null; }
    try { await chrome.alarms?.clear('opencomet_run_keepalive'); } catch { /* noop */ }
    try { setBadge('', '#7c6af7'); } catch { /* noop */ }
    await appendHistory({
      id: String(run.sessionId || `session_${Date.now()}`),
      task: String(run.task || '(task text unavailable)'),
      status: 'error',
      result: 'Extension service worker restarted mid-run — the task was interrupted. No further actions were taken.',
      steps: 0,
      time: Date.now(),
      mode: String(run.mode || 'agent'),
    });
    console.warn('[OpenComet] Crash recovery: previous run', run.sessionId, 'was interrupted by a service-worker restart — finalized in History.');
  } catch (err) {
    console.warn('[OpenComet] Crash-recovery reconciliation failed (non-fatal):', err?.message || err);
  }
})();

