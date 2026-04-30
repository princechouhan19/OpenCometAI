// -----------------------------------------------------------------------------
// src/background/sw.js
// Service-worker entry point.  Orchestrates the agent loop; delegates
// DOM actions, AI calls, storage, and state to focused modules.
// -----------------------------------------------------------------------------

import { callAI, callAIRaw, getProviderCapabilities, isProviderConfigured }   from '../lib/providers.js';
import {
  deepResearch,
  buildDecompositionPrompt,
  buildSynthesisPrompt,
  buildBrowserSourceAnalysisPrompt,
  buildScrapeExtractionPrompt,
} from '../lib/deepsearch.js';
import { getSettings, saveSettings as persistSettings, getHistory, appendHistory, clearHistory, initStorage, appendExport, recordTokenUsage, clearTokenUsage } from '../lib/storage.js';
import { sleep, getHostFromUrl, normalizeHost, parseJSON } from '../lib/utils.js';
import { MSG, STATUS, STEP_TYPE, PROTECTED_ACTION_LABELS, MODEL_PRICING } from '../lib/constants.js';
import { buildSearchUrl, openResearchTab, scrapeSearchResults, scrapeReadablePage, closeTabs } from '../lib/browser-research.js';
import { downloadExportFile } from '../lib/export.js';
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
import { executeAction, describeAction } from './actions.js';
import { detectSkillsForTask } from '../lib/skill-matcher.js';
import { getAllSkills } from '../lib/skills.js';
import { validateLicenseKey } from '../lib/license-service.js';

// -- Global agent state --------------------------------------------------------
let agentState = createEmptyAgentState();

async function getStoredLicenseRecord() {
  const data = await chrome.storage.local.get('opencometLicense');
  return data?.opencometLicense || {};
}

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
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.action.onClicked.addListener(tab => chrome.sidePanel.open({ tabId: tab.id }));

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
  };
  const handler = routes[msg.type];
  if (handler) { handler(); return true; }
});

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

// -----------------------------------------------------------------------------
// DEEP RESEARCH (multi-provider: LangSearch, Brave, Serper, DDG fallback)
// -----------------------------------------------------------------------------
async function legacyHandleDeepResearchApiProviders(msg, respond) {
  const settings = await getSettings();

  // Need at least one search provider OR we use DDG fallback (no key needed)
  // But we do require an AI key for decomposition + synthesis
  if (!settings.apiKey) {
    respond({ ok: false, error: 'No AI API key configured in Settings.' });
    return;
  }

  respond({ ok: true }); // ack immediately so the sidepanel doesn't time out

  const task = String(msg.task || '').trim();
  if (!task) {
    broadcastMessage({ type: MSG.DEEP_RESEARCH_ERROR, error: 'No research question provided.' });
    return;
  }

  const onProgress = text => broadcastMessage({ type: MSG.DEEP_RESEARCH_STEP, text });

  // Build keys object for the multi-provider engine
  const searchKeys = {
    tavilyKey:     settings.tavilyKey      || '',
    langSearchKey: settings.langSearchKey  || '',
    braveSearchKey: settings.braveSearchKey || '',
    serperKey:     settings.serperKey      || '',
  };

  // Warn if no paid key — will fall back to DuckDuckGo
  const hasKey = searchKeys.tavilyKey || searchKeys.langSearchKey || searchKeys.braveSearchKey || searchKeys.serperKey;
  if (!hasKey) {
    onProgress('?? No search API key configured — using DuckDuckGo (limited results). Add Tavily/LangSearch/Brave/Serper key in Settings for best results.');
  }

  try {
    onProgress('?? Starting deep research…');

    // -- Phase 1: Search -----------------------------------------------------
    const { subQueries, sources } = await deepResearch(
      task,
      searchKeys,
      onProgress,
      (aiSettings, prompt) => callAI(aiSettings, prompt, null, { onUsage: trackUsage }),
      settings
    );

    if (sources.length === 0) {
      broadcastMessage({
        type: MSG.DEEP_RESEARCH_ERROR,
        error: 'No results found. Check your API key(s) in Settings ? Deep Research, or try a different query.',
      });
      return;
    }

    // -- Phase 2: AI synthesis -----------------------------------------------
    onProgress('?? Synthesizing report from ' + sources.length + ' sources…');
    const synthesisPrompt = buildSynthesisPrompt(task, subQueries, sources);

    let report = '';
    try {
      report = await callAIRaw(settings, synthesisPrompt, { onUsage: trackUsage });
    } catch (e) {
      report = '?? AI synthesis failed: ' + e.message;
    }

    // -- Phase 3: Broadcast result -------------------------------------------
    broadcastMessage({
      type: MSG.DEEP_RESEARCH_DONE,
      task,
      report,
      subQueries,
      sources: sources.slice(0, 20), // send top 20 sources to UI
    });

    // Persist to history
    await appendHistory({
      id:     'dr_' + Date.now(),
      task,
      status: 'done',
      result: report.substring(0, 300),
      steps:  subQueries.length,
      time:   Date.now(),
      mode:   'deep_research',
    });

  } catch (err) {
    broadcastMessage({ type: MSG.DEEP_RESEARCH_ERROR, error: err.message });
  }
}

// -----------------------------------------------------------------------------
async function legacyHandleDeepResearchBrowserDraft(msg, respond) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    respond({ ok: false, error: 'No AI API key configured in Settings.' });
    return;
  }

  const task = String(msg.task || '').trim();
  if (!task) {
    respond({ ok: false, error: 'No research question provided.' });
    return;
  }

  respond({ ok: true });

  const options = {
    maxSites: clampInt(msg.maxSites, settings.deepResearchMaxSites || 6, 2, 12),
    maxQueries: clampInt(msg.maxQueries, settings.deepResearchMaxQueries || 4, 1, 6),
    searchEngine: String(msg.searchEngine || settings.deepResearchSearchEngine || 'google').toLowerCase(),
    useSubAgents: msg.useSubAgents ?? settings.useSubAgents ?? true,
  };
  const onProgress = text => broadcastMessage({ type: MSG.DEEP_RESEARCH_STEP, text });
  const openedTabs = [];

  try {
    onProgress(`Starting deep research with browser search (${options.searchEngine})...`);

    const raw = await callAI(settings, buildDecompositionPrompt(task), null, { onUsage: trackUsage });
    const subQueries = Array.isArray(raw?.queries) && raw.queries.length
      ? raw.queries.slice(0, options.maxQueries).map(String).filter(Boolean)
      : [task];

    onProgress(`Planner created ${subQueries.length} search angles.`);

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
        candidateSources.push({
          title: result.title || url,
          url,
          snippet: result.snippet || '',
          summary: result.snippet || '',
          source: options.searchEngine,
        });
        if (candidateSources.length >= options.maxSites * 2) break;
      }
      if (candidateSources.length >= options.maxSites * 2) break;
    }

    const selectedSources = candidateSources.slice(0, options.maxSites);
    if (!selectedSources.length) {
      broadcastMessage({ type: MSG.DEEP_RESEARCH_ERROR, error: 'No browser research sources were found.' });
      return;
    }

    onProgress(`Opening ${selectedSources.length} source tabs...`);
    const scrapedSources = [];
    for (const source of selectedSources) {
      const tab = await openResearchTab(source.url, false);
      openedTabs.push(tab.id);
      const page = await scrapeReadablePage(tab.id);
      scrapedSources.push({ ...source, page });
    }

    const analyzedSources = options.useSubAgents
      ? await Promise.all(scrapedSources.map((source, index) => analyzeResearchSource(settings, task, source, index + 1, onProgress)))
      : scrapedSources.map((source, index) => ({
          index: index + 1,
          title: source.page.title || source.title,
          url: source.url,
          summary: summarizeScrapedPage(source.page),
          facts: [],
        }));

    onProgress(`Synthesizing report from ${analyzedSources.length} source analysts...`);
    const report = await callAIRaw(settings, buildBrowserResearchSynthesisPrompt(task, subQueries, analyzedSources), { onUsage: trackUsage });

    broadcastMessage({
      type: MSG.DEEP_RESEARCH_DONE,
      task,
      report,
      subQueries,
      sources: analyzedSources.map(source => ({
        title: source.title,
        url: source.url,
        snippet: source.summary,
        summary: source.summary,
      })),
      meta: {
        maxSites: options.maxSites,
        searchEngine: options.searchEngine,
        usedBrowserResearch: true,
        subAgentsUsed: Boolean(options.useSubAgents),
      },
    });

    await appendHistory({
      id:     'dr_' + Date.now(),
      task,
      status: 'done',
      result: report.substring(0, 300),
      steps:  subQueries.length,
      time:   Date.now(),
      mode:   'deep_research',
    });
  } catch (err) {
    broadcastMessage({ type: MSG.DEEP_RESEARCH_ERROR, error: err.message });
  } finally {
    await closeTabs(openedTabs);
  }
}

async function legacyHandleSummarizePage(msg, respond) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    respond({ ok: false, error: 'No AI API key configured in Settings.' });
    return;
  }

  respond({ ok: true });
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const page = await scrapeReadablePage(tab.id);
    const prompt = buildSummarizePrompt(msg.task || 'Summarize this page clearly.', page, settings.profileData || {});
    const answer = await callAIRaw(settings, prompt, { onUsage: trackUsage });
    broadcastMessage({ type: MSG.SUMMARIZE_DONE, answer, page });
  } catch (err) {
    broadcastMessage({ type: MSG.SUMMARIZE_ERROR, error: err.message });
  }
}

async function legacyHandleScrapePage(msg, respond) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    respond({ ok: false, error: 'No AI API key configured in Settings.' });
    return;
  }

  respond({ ok: true });
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const page = await scrapeReadablePage(tab.id);
    const task = String(msg.task || '').trim();
    const structured = settings.useSubAgents
      ? await analyzeScrapeWithSubAgents(settings, task, page)
      : buildDefaultScrapeResult(task, page);

    let exportMeta = null;
    if (msg.autoExport || settings.autoExportScrapes) {
      const formats = Array.isArray(msg.formats) && msg.formats.length
        ? msg.formats
        : [msg.format || settings.exportFormat || structured.recommendedFormat || 'json'];
      exportMeta = await exportDataPayload({
        kind: 'scrape',
        task,
        page,
        structured,
      }, {
        formats,
        baseName: `scrape-${Date.now()}`,
        settings,
      });
    }

    broadcastMessage({
      type: MSG.SCRAPE_DONE,
      task,
      result: structured,
      page,
      exportMeta,
    });
  } catch (err) {
    broadcastMessage({ type: MSG.SCRAPE_ERROR, error: err.message });
  }
}

async function legacyHandleExportData(msg, respond) {
  try {
    const settings = await getSettings();
    const result = await exportDataPayload(msg.dataset || msg.payload, {
      formats: msg.formats || [msg.format || settings.exportFormat],
      baseName: msg.baseName || `open-comet-export-${Date.now()}`,
      settings,
    });
    const exportsList = Array.isArray(result) ? result : [result];
    respond({ ok: true, exports: exportsList });
  } catch (err) {
    respond({ ok: false, error: err.message });
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
  if (agentState.running) { respond({ ok: false, error: 'Already running' }); return; }

  const storedLicense = await getStoredLicenseRecord();
  const licenseKey = String(storedLicense?.key || '').trim();
  if (!licenseKey) {
    respond({ ok: false, error: 'No license key saved. Open Settings -> License & Activation first.' });
    return;
  }

  const validation = await validateLicenseKey(licenseKey);
  if (!validation.ok || !validation.valid) {
    respond({ ok: false, error: validation.error || 'License is inactive.' });
    return;
  }

  const settings = await getSettings();
  if (!isProviderConfigured(settings)) { respond({ ok: false, error: 'No provider configured' }); return; }

  const caps = getProviderCapabilities(settings);
  if (!caps.browserAgentSafe) {
    respond({ ok: false, error: `${settings.provider} does not support vision — choose a vision-capable provider for best results.` });
    return;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const startHost   = getHostFromUrl(activeTab?.url);

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
    startUrl:             activeTab.url,
    startTitle:           activeTab.title,
    attachments:          cloneAttachments(msg.attachments || []),
    skills:               cloneSkills(msg.skills || []),
    profileData:          { ...(settings.profileData || {}) },
    licenseStatus:        validation.license || { valid: true },
    sessionApprovedHosts: startHost ? [startHost] : [],
    plannedHosts:         startHost ? [startHost] : [],
    taskMemory: { visitedHosts: startHost ? [startHost] : [], pageSnapshots: [], loopHints: [], workSummary: '' },
    // Reused fields
    agentGroupId:         oldGroupId,
    taskTabIds:           oldTabIds,
    taskTabGraph:         oldTabGraph,
    agentTabId:           reuseTabId,
  });

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

  // Open the working tab
  if (reuseTabId) {
    await chrome.tabs.update(reuseTabId, { active: true });
    await groupTaskTabs([reuseTabId]);
    broadcastToTabs({ type: MSG.AGENT_STARTED, state: agentState });
  } else {
    const agentTab = await chrome.tabs.create({ url: activeTab.url, active: true });
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
    steps: normalizedSteps,
    estimated_actions: Number.isFinite(Number(incoming.estimated_actions)) ? Number(incoming.estimated_actions) : null,
  };
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
  pushStep(STEP_TYPE.MUTED, `?? User note: ${clean.substring(0, 180)}`);
  respond({ ok: true });
}

// -----------------------------------------------------------------------------
// EXECUTION LOOP
// -----------------------------------------------------------------------------
async function executionPhase() {
  pushStep(STEP_TYPE.EXECUTING, '?? Starting execution…');
  broadcastStatus(STATUS.EXECUTING);

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

      // -- Auto-done: detect send/submit completion -------------------------
      // If the agent just clicked a "Send" button, check whether the compose
      // window closed — if so, the email was sent and we're done.
      if (action.type === 'click') {
        const sel       = String(action.selector || action.text || '').toLowerCase();
        const matched   = String(meta?.matchedText || '').toLowerCase();
        const isSendBtn = /\bsend\b|\bsubmit\b|\bsend email\b|\benvoyer\b/.test(sel + ' ' + matched);
        if (isSendBtn) {
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
  await appendHistory({ id: agentState.sessionId, task: agentState.task, status: 'done', result: answer.substring(0, 300), steps: agentState.steps.length, tokens: agentState.taskUsage?.totalTokens || 0, cost: agentState.taskUsage?.cost || 0, time: Date.now() });
  broadcastStatus(STATUS.IDLE);
}

async function finishStopped() {
  pushStep(STEP_TYPE.STOPPED, '? Stopped by user.');
  agentState.finalStatus = 'stopped';
  broadcastMessage({ type: MSG.AGENT_STOPPED, steps: agentState.steps, sessionId: agentState.sessionId });
  setBadge('', '#7c6af7');
  await appendHistory({ id: agentState.sessionId, task: agentState.task, status: 'stopped', result: 'Stopped by user.', steps: agentState.steps.length, tokens: agentState.taskUsage?.totalTokens || 0, cost: agentState.taskUsage?.cost || 0, time: Date.now() });
}

async function finishMaxSteps() {
  const answer = `Reached the max step limit (${agentState.maxIterations}).`;
  agentState.finalStatus = 'incomplete';
  broadcastMessage({ type: MSG.AGENT_DONE, answer, data: {}, steps: agentState.steps, sessionId: agentState.sessionId });
  setBadge('', '#7c6af7');
  await appendHistory({ id: agentState.sessionId, task: agentState.task, status: 'incomplete', result: answer, steps: agentState.steps.length, tokens: agentState.taskUsage?.totalTokens || 0, cost: agentState.taskUsage?.cost || 0, time: Date.now() });
}

function fatalError(err) {
  pushStep(STEP_TYPE.ERROR, `? ${err.message}`);
  agentState.running = false;
  agentState.finalStatus = 'error';
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
      const toastSent = /\bmessage sent\b|\bsent\b/.test(bodyText);
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
  const shotSig  = String(screenshot||'').slice(0,160);
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

async function runPlannerRole(pageInfo, screenshot) {
  pushStep(STEP_TYPE.API, `Planner role: calling ${agentState.settings.provider}...`);
  const req = buildPlannerRequest(agentState, pageInfo, screenshot, { images: imageAttachments() });
  return await callAI(agentState.settings, req.prompt, req.screenshotBase64, { images: req.images, onUsage: trackUsage });
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
    return await callAI(agentState.settings, initialReq.prompt, initialReq.screenshotBase64, { images: initialReq.images, onUsage: trackUsage });
  } catch (err) {
    if (!shouldRetryCompactAction(err, agentState.settings)) throw err;
    const compactReq = buildNavigatorRequest(agentState, pageInfo, screenshot, {
      compactMode: 'minimal',
      images: imageAttachments(),
    });
    return await callAI(agentState.settings, compactReq.prompt, compactReq.screenshotBase64, { images: compactReq.images, onUsage: trackUsage });
  }
}

function compactPageInfoForAI(pageInfo, settings = {}, compactMode = 'normal') {
  const provider = String(settings.provider || '').toLowerCase();
  if (provider !== 'mistral') return pageInfo;

  const minimal = compactMode === 'minimal';

  const pickInteractive = item => ({
    uid: item?.uid || '',
    role: item?.role || '',
    tag: item?.tag || '',
    type: item?.type || '',
    text: String(item?.text || '').substring(0, minimal ? 48 : 80),
    placeholder: String(item?.placeholder || '').substring(0, minimal ? 48 : 80),
    href: minimal ? '' : String(item?.href || '').substring(0, 120),
    editable: Boolean(item?.editable),
    disabled: Boolean(item?.disabled),
    bounds: minimal ? null : item?.bounds || null,
    selector: item?.selector || '',
  });

  return {
    ...pageInfo,
    text: String(pageInfo?.text || '').substring(0, minimal ? 700 : 1800),
    readableText: String(pageInfo?.readableText || pageInfo?.text || '').substring(0, minimal ? 2200 : 4800),
    headings: (pageInfo?.headings || []).slice(0, minimal ? 8 : 16),
    tables: (pageInfo?.tables || []).slice(0, minimal ? 1 : 2),
    openTabs: (pageInfo?.openTabs || []).slice(0, minimal ? 4 : 8).map(tab => ({
      title: String(tab?.title || '').substring(0, minimal ? 50 : 80),
      url: String(tab?.url || '').substring(0, minimal ? 90 : 180),
      host: tab?.host || '',
      active: Boolean(tab?.active),
    })),
    inputs: (pageInfo?.inputs || []).slice(0, minimal ? 6 : 10).map(input => ({
      type: input?.type || '',
      name: String(input?.name || '').substring(0, minimal ? 48 : 80),
      selector: input?.selector || '',
    })),
    links: (pageInfo?.links || []).slice(0, minimal ? 0 : 8).map(link => ({
      text: String(link?.text || '').substring(0, 60),
      href: String(link?.href || '').substring(0, 120),
      selector: link?.selector || '',
    })),
    clickables: (pageInfo?.clickables || []).slice(0, minimal ? 0 : 12).map(pickInteractive),
    interactiveElements: (pageInfo?.interactiveElements || []).slice(0, minimal ? 20 : 30).map(pickInteractive),
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
  const profileNotes = Object.entries(profileData || {})
    .filter(([, value]) => String(value || '').trim())
    .map(([key, value]) => `${key}: ${value}`)
    .join(' | ') || 'none';

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

async function groupTaskTabs(tabIds) {
  try {
    const groupId = Number.isInteger(agentState.agentGroupId)
      ? await chrome.tabs.group({ groupId: agentState.agentGroupId, tabIds })
      : await chrome.tabs.group({ tabIds });
    agentState.agentGroupId = groupId;
    const title = (agentState.task || 'Open Comet Task').replace(/\s+/g, ' ').trim().substring(0, 24);
    await chrome.tabGroups.update(groupId, { title, color: 'blue', collapsed: false });
  } catch {}
}

// -----------------------------------------------------------------------------
// STOP / RESET
// -----------------------------------------------------------------------------
async function handleStop(respond) {
  agentState.stopRequested  = true;
  agentState.running        = false;
  agentState.paused         = false;
  agentState.pendingApproval= null;
  if (respond) respond({ ok: true });
}

async function handleReset(respond) {
  agentState.stopRequested  = true;
  agentState.running        = false;
  agentState.paused         = false;
  agentState.pendingApproval= null;
  agentState.finalStatus    = 'idle';
  setBadge('', '#7c6af7');
  broadcastMessage({ type: MSG.CHAT_RESET, sessionId: agentState.sessionId });
  if (respond) respond({ ok: true });
}

// -----------------------------------------------------------------------------
// MESSAGING
// -----------------------------------------------------------------------------
function pushStep(type, text, extra = {}) {
  if (type === STEP_TYPE.SCREENSHOT && !extra.imageDataUrl) return;
  const step = { type, text, ...extra, time: Date.now(), index: agentState.steps.length };
  agentState.steps.push(step);
  broadcastMessage({ type: MSG.STEP_UPDATE, step, stepCount: agentState.steps.length });
  console.log(`[Open Comet] ${text}`);
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
  broadcastMessage({ type });
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

function inferTaskProfileFallback(taskProfile, skills = []) {
  if (taskProfile) return taskProfile;
  return (skills || []).some(skill => String(skill?.id || '').includes('summar')) ? 'summarize' : 'default';
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

