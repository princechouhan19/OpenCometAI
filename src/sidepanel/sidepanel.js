// ─────────────────────────────────────────────────────────────────────────────
import { requestTrialLicense, requestPremiumLicense, validateLicenseKey } from '../lib/license-service.js';
import { DEFAULT_APP_BACKEND_URL } from '../lib/app-backend.js';

// sidepanel.js — Open Comet UI controller
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDER_MODELS = {
  openai:    ['gpt-4o', 'gpt-4o-mini', 'o1'],
  anthropic: ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001', 'claude-opus-4-6'],
  gemini:    ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'],
  groq:      ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  mistral:   ['mistral-small-2506', 'mistral-large-latest', 'pixtral-large-2411'],
  deepseek:  ['deepseek-chat', 'deepseek-reasoner'],
  kimi:      ['kimi-k2.5', 'kimi-k2-thinking', 'kimi-k2-turbo-preview'],
  glm:       ['glm-4.7', 'glm-4.5-air', 'glm-4.5v'],
  custom:    [],
  ollama:    ['llama3.2:3b', 'qwen2.5vl:7b', 'gemma3:4b', 'llava:7b'],
};

const PROVIDER_LABELS = {
  openai: 'GPT-4o', anthropic: 'Claude Sonnet',
  gemini: 'Gemini Flash', groq: 'LLaMA 3.3', mistral: 'Mistral Small',
  deepseek: 'DeepSeek Chat', kimi: 'Kimi', glm: 'GLM', custom: 'OpenAI Compatible', ollama: 'Ollama',
};

// ── State ─────────────────────────────────────────────────────────────────────
let currentMode     = 'auto';
let currentProvider = 'openai';
let isRunning       = false;
let agentBlockEl    = null;
let inputTab        = 'chat'; // 'chat' | 'deep_research' | 'scrape'
let currentRunKind  = null;
let currentSessionId = '';
let renderedStepIndexes = new Set();
let restoredTaskSessionKey = '';
let ollamaModelCatalog = { all: [], text: [], vision: [], recommended: [] };
let currentSettingsPage = 'home';

// ── Sounds ────────────────────────────────────────────────────────────────────
function playNotificationSound(type = 'complete') {
  const audio = new Audio(`../../assets/sounds/${type}.mp3`);
  audio.play().catch(e => console.warn('[Sound] Playback inhibited:', e));
}

// ── DOM refs (all null-safe) ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const taskInput      = $('taskInput');
let sendBtn          = $('sendBtn');
const stopBtn        = $('stopBtn');
const modelPillLabel = $('modelPillLabel');
const modeToggleBtn  = $('modeToggleBtn');
const modeIcon       = $('modeIcon');
const modeLabel      = $('modeLabel');
const modeDropdown   = $('modeDropdown');
const newChatBtn     = $('newChatBtn');
const runContextHint = $('runContextHint');
const researchOptionsBar = $('researchOptionsBar');
const scrapeOptionsBar = $('scrapeOptionsBar');
const initialConvoMarkup = $('convoArea')?.innerHTML || '';
const licenseKeyInput = $('licenseKeyInput');
const licenseEmailInput = $('licenseEmailInput');
const requestTrialBtn = $('requestTrialBtn');
const requestPremiumBtn = $('requestPremiumBtn');
const validateLicenseBtn = $('validateLicenseBtn');
const licenseStatusBadge = $('licenseStatusBadge');
const licenseStatusText = $('licenseStatusText');

function isProviderConfigured(settings = {}) {
  const provider = String(settings.provider || '').toLowerCase();
  if (provider === 'ollama') {
    return Boolean(String(settings.ollamaBaseUrl || 'http://127.0.0.1:11434').trim());
  }
  if (['deepseek', 'kimi', 'glm', 'nvidia', 'custom'].includes(provider)) {
    return Boolean(String(settings.apiKey || '').trim()) && Boolean(String(settings.providerBaseUrl || getProviderDefaultBaseUrl(provider)).trim());
  }
  return Boolean(String(settings.apiKey || '').trim());
}

function supportsOllamaVisionModel(model = '') {
  const lower = String(model || '').toLowerCase();
  return ['llava', 'bakllava', 'vision', 'qwen2.5vl', 'qwen2-vl', 'gemma3', 'minicpm-v', 'moondream']
    .some(kw => lower.includes(kw));
}

function normalizeOllamaCatalog(models = []) {
  const unique = [...new Set((models || []).map(model => String(model?.name || model || '').trim()).filter(Boolean))];
  const vision = unique.filter(supportsOllamaVisionModel);
  const text = [...new Set([...vision, ...unique])];
  return {
    all: unique,
    text,
    vision,
    recommended: vision,
  };
}

function getSelectedOllamaTextModel() {
  return $('ollamaTextModelInput')?.value.trim() || $('modelInput')?.value.trim() || '';
}

function getSelectedOllamaVisionModel() {
  return $('ollamaVisionModelInput')?.value.trim() || $('modelInput')?.value.trim() || '';
}

function getDisplayedOllamaModel(settings = {}) {
  const textModel = String(settings.ollamaTextModel || settings.model || '').trim();
  const visionModel = String(settings.ollamaVisionModel || settings.model || '').trim();
  if (textModel && visionModel && textModel !== visionModel) {
    return `${textModel} + ${visionModel}`;
  }
  return textModel || visionModel || 'Ollama';
}

function updateConnectionFields(provider) {
  const modelInput = $('modelInput');
  const ollamaSection = $('ollamaModelSection');
  
  // Decide which type content to show
  let type = 'cloud';
  if (provider === 'ollama') type = 'ollama';
  else if (provider === 'custom') type = 'custom';
  else if (['deepseek', 'kimi', 'glm'].includes(provider)) type = 'cloud'; // Default cloud for presets

  document.querySelectorAll('.ptype-btn').forEach(tab => {
    tab.classList.toggle('selected', tab.dataset.type === type);
  });
  
  document.querySelectorAll('.provider-type-content').forEach(content => {
    content.style.display = 'none';
  });
  
  const contentEl = $(type === 'cloud' ? 'typeContentCloud' : (type === 'custom' ? 'typeContentCustom' : 'typeContentOllama'));
  if (contentEl) contentEl.style.display = 'block';

  // Ollama specific visibility
  if (ollamaSection) {
    ollamaSection.style.display = provider === 'ollama' ? 'block' : 'none';
  }

  if (modelInput) {
    modelInput.placeholder = provider === 'ollama'
      ? 'Legacy fallback. Prefer the text/vision model selectors below.'
      : 'Leave blank to use default';
    
    // Hide default model input if custom is selected (it has its own)
    const modelSection = modelInput.closest('.s-section');
    if (modelSection) {
      modelSection.style.display = (provider === 'custom') ? 'none' : 'block';
    }
  }

  const providerBaseUrlInput = $('providerBaseUrlInput');
  if (providerBaseUrlInput && ['deepseek', 'kimi', 'glm'].includes(provider) && !providerBaseUrlInput.value.trim()) {
    providerBaseUrlInput.value = getProviderDefaultBaseUrl(provider);
  }
}

function getProviderDefaultBaseUrl(provider) {
  switch (String(provider || '').toLowerCase()) {
    case 'deepseek': return 'https://api.deepseek.com/v1';
    case 'kimi':     return 'https://api.moonshot.ai/v1';
    case 'glm':      return 'https://open.bigmodel.cn/api/paas/v4';
    default:         return '';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════════════════════════════════════
function showView(name) {
  const bottomNav = $('bottomNav');
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
  
  const viewEl = document.getElementById(`view-${name}`);
  if (viewEl) viewEl.classList.add('active');

  // Handle bottom nav visibility
  const navId = { agent: 'navAgent', history: 'navHistory', settings: 'navSettings', skills: 'navSettings' }[name];
  const navEl = document.getElementById(navId);
  if (navEl) navEl.classList.add('active');
  
  if (name === 'auth') {
    if (bottomNav) bottomNav.style.display = 'none';
  } else {
    // Check if we should show bottom nav (only if logged in)
    chrome.storage.local.get(['auth', 'opencometLicense'], (data) => {
      const hasAuth = Boolean(data.auth?.token);
      if (hasAuth && bottomNav) bottomNav.style.display = 'flex';
    });
  }

  closeModeDropdown();
  closeSlashMenu();
  if (name === 'history')  renderHistory();
  if (name === 'settings') { loadSettings(); openSettingsPage('home'); }
}

function openSettingsPage(page = 'home') {
  currentSettingsPage = page;
  const home = $('settingsHome');
  const back = $('settingsBackBtn');
  const title = $('settingsTitle');
  const saveBtn = $('saveSettingsBtn');
  const footer = $('settingsFooterNote');
  const labels = {
    home: 'Settings',
    ai: 'AI & Models',
    research: 'Research',
    storage: 'Storage & Exports',
    profile: 'Profile',
    skills: 'Skills',
    usage: 'Token & Cost Usage',
    license: 'License & Activation',
  };

  if (page === 'skills') {
    showView('skills');
    return;
  }

  if (home) home.style.display = page === 'home' ? 'grid' : 'none';
  if (back) back.style.display = page === 'home' ? 'none' : 'inline-flex';
  if (title) title.textContent = labels[page] || 'Settings';
  const settingsPagesWithSave = new Set(['ai', 'research', 'storage', 'profile']);
  if (saveBtn) saveBtn.style.display = settingsPagesWithSave.has(page) ? 'block' : 'none';
  if (footer) footer.style.display = settingsPagesWithSave.has(page) ? 'block' : 'none';

  document.querySelectorAll('.settings-subpage-section').forEach(section => {
    section.style.display = page === 'home' ? 'none' : (section.dataset.settingsPage === page ? '' : 'none');
  });
}

const navAgent    = $('navAgent');
const navHistory  = $('navHistory');
const navSettings = $('navSettings');
const modelPillBtn = $('modelPillBtn');

if (navAgent)    navAgent.addEventListener('click',    () => showView('agent'));
if (navHistory)  navHistory.addEventListener('click',  () => showView('history'));
if (navSettings) navSettings.addEventListener('click', () => showView('settings'));
if (modelPillBtn) modelPillBtn.addEventListener('click', e => {
  e.stopPropagation();
  toggleModelSelector();
});
if (newChatBtn) {
  newChatBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'RESET_AGENT_STATE' }, () => {});
    resetRenderedSessionState();
    currentRunKind = null;
    setRunning(false);
    resetConversationUI({ clearInput: true });
    showView('agent');
    taskInput?.focus();
  });
}

const openSkillsBtn  = $('openSkillsBtn');
const skillsBackBtn = $('skillsBackBtn');
const settingsBackBtn = $('settingsBackBtn');
if (openSkillsBtn)  openSkillsBtn.addEventListener('click',  () => showView('skills'));
if (skillsBackBtn) skillsBackBtn.addEventListener('click', () => showView('settings'));
if (settingsBackBtn) settingsBackBtn.addEventListener('click', () => openSettingsPage('home'));
document.querySelectorAll('[data-settings-target]').forEach(btn => {
  btn.addEventListener('click', () => openSettingsPage(btn.dataset.settingsTarget || 'home'));
});

// ══════════════════════════════════════════════════════════════════════════════
// MODE DROPDOWN  (opens upward above the toggle button)
// ══════════════════════════════════════════════════════════════════════════════
function closeModeDropdown() {
  if (modeDropdown) modeDropdown.classList.remove('open');
}

function toggleModeDropdown(e) {
  e.stopPropagation();
  if (modeDropdown) modeDropdown.classList.toggle('open');
}

if (modeToggleBtn) modeToggleBtn.addEventListener('click', toggleModeDropdown);
document.addEventListener('click', () => { closeModeDropdown(); closeSlashMenu(); closeModelSelector(); });
if (modeDropdown) modeDropdown.addEventListener('click', e => e.stopPropagation());
if ($('slashMenu')) $('slashMenu').addEventListener('click', e => e.stopPropagation());
if ($('modelSelectorDropdown')) $('modelSelectorDropdown').addEventListener('click', e => e.stopPropagation());

document.querySelectorAll('.mode-option').forEach(opt => {
  opt.addEventListener('click', () => {
    currentMode = opt.dataset.mode;
    const labelText = opt.querySelector('.mode-opt-label')?.textContent || '';
    const iconText  = opt.querySelector('.mode-opt-icon')?.textContent  || '';
    if (modeIcon)  modeIcon.textContent  = iconText;
    if (modeLabel) modeLabel.textContent = labelText;

    document.querySelectorAll('.mode-option').forEach(o => {
      const isThis = o.dataset.mode === currentMode;
      o.classList.toggle('selected', isThis);
      const chk = o.querySelector('.mode-check');
      if (chk) chk.classList.toggle('visible', isThis);
    });
    closeModeDropdown();
  });
});

// Set initial state to 'auto'
if (modeIcon)  modeIcon.textContent  = '⚡';
if (modeLabel) modeLabel.textContent = 'Act without asking';

// ══════════════════════════════════════════════════════════════════════════════
// MODEL SELECTOR DROPDOWN
// ══════════════════════════════════════════════════════════════════════════════
function closeModelSelector() {
  const dropdown = $('modelSelectorDropdown');
  if (dropdown) dropdown.classList.remove('open');
}

async function toggleModelSelector() {
  const dropdown = $('modelSelectorDropdown');
  if (!dropdown) return;

  if (dropdown.classList.contains('open')) {
    dropdown.classList.remove('open');
    return;
  }

  const settings = await getSettingsBg();
  const provider = settings.provider || 'openai';
  let models = PROVIDER_MODELS[provider] || [];

  if (provider === 'ollama') {
    models = ollamaModelCatalog.all.length ? ollamaModelCatalog.all : PROVIDER_MODELS.ollama;
  }

  const currentModel = provider === 'ollama' 
    ? (settings.ollamaTextModel || settings.model || '') 
    : (settings.model || models[0] || '');

  dropdown.innerHTML = models.map(m => `
    <div class="model-opt-item${m === currentModel ? ' selected' : ''}" data-model="${esc(m)}">
      <span>${esc(m)}</span>
      <svg class="opt-check" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="2,6 5,9 10,3"/>
      </svg>
    </div>
  `).join('') || '<div class="model-opt-item">No models found</div>';

  dropdown.querySelectorAll('.model-opt-item').forEach(item => {
    item.addEventListener('click', () => {
      const selected = item.dataset.model;
      if (selected) selectDropdownModel(provider, selected);
    });
  });

  dropdown.classList.add('open');
}

async function selectDropdownModel(provider, modelId) {
  const settings = await getSettingsBg();
  settings.model = modelId;
  
  if (provider === 'ollama') {
    settings.ollamaTextModel = modelId;
    // For simplicity, we set both to the same if selecting from this quick menu
    settings.ollamaVisionModel = modelId;
  }

  chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }, () => {
    if (chrome.runtime.lastError) return;
    updateModelPill(provider, provider === 'ollama' ? getDisplayedOllamaModel(settings) : modelId);
    closeModelSelector();
    
    // Also update settings view if it's open or loaded
    const modelInput = $('modelInput');
    if (modelInput) modelInput.value = modelId;
    const ollamaText = $('ollamaTextModelInput');
    if (ollamaText) ollamaText.value = modelId;
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// INPUT TABS  (Chat | Deep Research | Scrape)
// ══════════════════════════════════════════════════════════════════════════════
const tabChat         = $('tabChat');
const tabDeepResearch = $('tabDeepResearch');
const tabScrape       = $('tabScrape');

function getComposerPlaceholder() {
  if (isRunning && currentRunKind === 'agent') {
    return 'Task running. Add extra context or a correction here.';
  }
  return inputTab === 'deep_research'
    ? 'What topic would you like me to research deeply?'
    : inputTab === 'scrape'
      ? 'Describe what data you want to scrape from this page.'
    : 'What are we doing today?';
}

function updateComposerState() {
  if (taskInput) taskInput.placeholder = getComposerPlaceholder();
  if (runContextHint) runContextHint.classList.toggle('visible', isRunning && currentRunKind === 'agent');
  if (researchOptionsBar) researchOptionsBar.classList.toggle('visible', !isRunning && inputTab === 'deep_research');
  if (scrapeOptionsBar) scrapeOptionsBar.classList.toggle('visible', !isRunning && inputTab === 'scrape');

  const modeToggle = $('modeToggleBtn');
  if (modeToggle) modeToggle.style.display = inputTab === 'chat' ? '' : 'none';

  if (sendBtn) {
    sendBtn.title = isRunning && currentRunKind === 'agent'
      ? 'Add context'
      : inputTab === 'deep_research'
        ? 'Deep Research'
        : inputTab === 'scrape'
          ? 'Scrape'
        : 'Run';
  }
}

function setInputTab(tab) {
  inputTab = tab;
  const isResearch = tab === 'deep_research';
  const isScrape = tab === 'scrape';

  if (tabChat)         tabChat.classList.toggle('active', !isResearch && !isScrape);
  if (tabDeepResearch) tabDeepResearch.classList.toggle('active', isResearch);
  if (tabScrape)       tabScrape.classList.toggle('active', isScrape);
  updateComposerState();
}

if (tabChat)         tabChat.addEventListener('click',          () => setInputTab('chat'));
if (tabDeepResearch) tabDeepResearch.addEventListener('click',  () => setInputTab('deep_research'));
if (tabScrape)       tabScrape.addEventListener('click',        () => setInputTab('scrape'));

// ══════════════════════════════════════════════════════════════════════════════
// SEND / STOP
// ══════════════════════════════════════════════════════════════════════════════
async function addRunningNote() {
  const note = taskInput?.value.trim();
  if (!note) return;
  if (!isRunning || currentRunKind !== 'agent') return;

  chrome.runtime.sendMessage({ type: 'ADD_USER_NOTE', note }, resp => {
    if (chrome.runtime.lastError) {
      addStep('error', chrome.runtime.lastError.message);
      return;
    }
    if (!resp?.ok) {
      addStep('error', 'Unable to add context right now.');
      return;
    }
    appendUserBubble(note);
    if (taskInput) taskInput.value = '';
    autoResizeTA();
    updateComposerState();
  });
}

/**
 * Handles the submission of the main task input.
 * Dispatches to deep research, scrape, or agent workflows.
 */
async function submitComposer() {
  if (!taskInput) return;
  if (isRunning) {
    if (currentRunKind !== 'agent') {
      addStep('error', 'Live extra context is only supported for browser tasks right now.');
      return;
    }
    await addRunningNote();
    return;
  }
  if (inputTab === 'deep_research') runDeepResearch();
  else if (inputTab === 'scrape') runScrapePage();
  else runAgentWithSkills();
}

if (sendBtn) sendBtn.addEventListener('click', submitComposer);
if (taskInput) {
  taskInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      submitComposer();
    }
  });
}

if (stopBtn) {
  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_AGENT' });
    addStep('stopped', '⏹ Stopping…');
  });
}

async function runAgent() {
  if (!taskInput) return;
  const task = taskInput.value.trim();
  if (!task || isRunning) return;

  const settings = await getSettingsBg();
  if (!isProviderConfigured(settings)) {
    showView('settings');
    const focusTarget = settings.provider === 'ollama' ? $('ollamaBaseUrlInput') : $('apiKeyInput');
    if (focusTarget) focusTarget.focus();
    return;
  }

  hideEmpty();
  appendUserBubble(task);
  agentBlockEl = appendAgentBlock();
  currentRunKind = 'agent';
  setRunning(true);
  taskInput.value = '';
  autoResizeTA();

  chrome.runtime.sendMessage({ type: 'START_AGENT', task, mode: currentMode, sessionId: currentSessionId }, resp => {
    if (chrome.runtime.lastError) {
      addStep('error', `❌ ${chrome.runtime.lastError.message}`);
      setRunning(false);
      return;
    }
    if (resp && !resp.ok) {
      addStep('error', `❌ ${resp.error || 'Failed to start'}`);
      setRunning(false);
    }
  });
}

async function runDeepResearch() {
  if (!taskInput) return;
  const task = taskInput.value.trim();
  if (!task || isRunning) return;

  const settings = await getSettingsBg();
  if (!isProviderConfigured(settings)) {
    showView('settings');
    const focusTarget = settings.provider === 'ollama' ? $('ollamaBaseUrlInput') : $('apiKeyInput');
    if (focusTarget) focusTarget.focus();
    return;
  }

  hideEmpty();
  appendUserBubble(task);
  agentBlockEl = appendAgentBlock();
  currentRunKind = 'deep_research';
  setRunning(true);
  taskInput.value = '';
  autoResizeTA();

  const maxSites = parseInt($('drMaxSitesInput')?.value || settings.deepResearchMaxSites || 6, 10) || 6;
  const searchEngine = $('drSearchEngineSelect')?.value || settings.deepResearchSearchEngine || 'google';
  const maxQueries = parseInt(settings.deepResearchMaxQueries || 4, 10) || 4;
  const useSubAgents = $('useSubAgentsInput')?.checked ?? settings.useSubAgents ?? true;

  chrome.runtime.sendMessage({ type: 'DEEP_RESEARCH', task, maxSites, maxQueries, searchEngine, useSubAgents, sessionId: currentSessionId }, resp => {
    if (chrome.runtime.lastError) {
      addStep('error', `❌ ${chrome.runtime.lastError.message}`);
      setRunning(false);
      return;
    }
    if (resp && !resp.ok) {
      addStep('error', `❌ ${resp.error}`);
      setRunning(false);
    }
  });
}

async function runScrapePage() {
  if (!taskInput) return;
  const task = taskInput.value.trim() || 'Scrape the current page';
  if (isRunning) return;

  const settings = await getSettingsBg();
  if (!isProviderConfigured(settings)) {
    showView('settings');
    (settings.provider === 'ollama' ? $('ollamaBaseUrlInput') : $('apiKeyInput'))?.focus();
    return;
  }

  hideEmpty();
  appendUserBubble(task);
  agentBlockEl = appendAgentBlock();
  currentRunKind = 'scrape';
  setRunning(true);
  taskInput.value = '';
  autoResizeTA();

  const formats = [
    $('scrapeFormatJson')?.checked ? 'json' : '',
    $('scrapeFormatCsv')?.checked ? 'csv' : '',
    $('scrapeFormatTxt')?.checked ? 'txt' : '',
  ].filter(Boolean);

  const autoCampaign = Boolean($('scrapeAutoCampaignInput')?.checked);

  chrome.runtime.sendMessage({
    type: autoCampaign ? 'AUTO_SCRAPE' : 'SCRAPE_PAGE',
    task,
    formats: formats.length ? formats : ['json'],
    autoExport: $('scrapeAutoExportInput')?.checked !== false,
  }, resp => {
    if (chrome.runtime.lastError) {
      addStep('error', `❌ ${chrome.runtime.lastError.message}`);
      setRunning(false);
      return;
    }
    if (resp && !resp.ok) {
      addStep('error', `❌ ${resp.error || 'Failed to scrape page'}`);
      setRunning(false);
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// BACKGROUND MESSAGES
// ══════════════════════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener(msg => {
  switch (msg.type) {
    case 'AGENT_STARTED':
      currentRunKind = 'agent';
      setRunning(true);
      if (msg.state) hydrateFromAgentState(msg.state);
      else requestAgentStateHydration({ force: true });
      break;

    case 'STEP_UPDATE': {
      if (msg.sessionId && currentSessionId && currentSessionId !== msg.sessionId) {
        requestAgentStateHydration({ force: true });
        break;
      }
      if (msg.sessionId && !currentSessionId) currentSessionId = msg.sessionId;
      renderIncomingStep(msg.step);
      break;
    }

    case 'STATE_UPDATE':
      if (msg.state && (!currentSessionId || currentSessionId !== (msg.state.sessionId || ''))) {
        hydrateFromAgentState(msg.state);
      }
      syncUiFromAgentState(msg.state);
      break;

    case 'PLAN_READY':
      renderPlanCard(msg.plan);
      break;

    case 'APPROVAL_REQUIRED':
      renderApprovalCard(msg.approval);
      break;

    case 'AGENT_DONE':
      currentRunKind = null;
      setRunning(false);
      renderResultCard(msg.answer || 'Task complete.');
      renderHistory();
      playNotificationSound('complete');
      break;

    case 'AGENT_STOPPED':
    case 'AGENT_ERROR':
      currentRunKind = null;
      setRunning(false);
      renderHistory();
      if (msg.error) {
        addStep('error', `❌ ${msg.error}`);
        playNotificationSound('error');
      }
      break;

    // ── Deep Research messages ───────────────────────────────────────────────
    case 'DEEP_RESEARCH_STEP':
      addStep('spin', msg.text || '');
      break;

    case 'DEEP_RESEARCH_DONE':
      currentRunKind = null;
      setRunning(false);
      renderResearchCard(msg.task, msg.report, msg.subQueries, msg.sources);
      playNotificationSound('complete');
      break;

    case 'DEEP_RESEARCH_ERROR':
      currentRunKind = null;
      setRunning(false);
      addStep('error', `❌ ${msg.error}`);
      playNotificationSound('error');
      break;

    case 'SUMMARIZE_DONE':
      currentRunKind = null;
      setRunning(false);
      renderResultCard(msg.summary || msg.answer || 'Summary complete.');
      playNotificationSound('complete');
      break;

    case 'SUMMARIZE_ERROR':
      currentRunKind = null;
      setRunning(false);
      addStep('error', `❌ ${msg.error}`);
      playNotificationSound('error');
      break;

    case 'SCRAPE_DONE':
      currentRunKind = null;
      setRunning(false);
      renderScrapeCard(msg.task, msg.dataset || msg.result, msg.page || msg.dataset, msg.exports || msg.exportMeta);
      playNotificationSound('complete');
      break;

    case 'SCRAPE_STEP':
      addStep('spin', msg.text || '');
      break;

    case 'SCRAPE_ERROR':
      currentRunKind = null;
      setRunning(false);
      addStep('error', `❌ ${msg.error}`);
      playNotificationSound('error');
      break;

    case 'AUTO_SCRAPE_DONE':
      currentRunKind = null;
      setRunning(false);
      // Re-use renderScrapeCard which expects task, result, page, exportMeta
      renderScrapeCard(msg.task, msg.dataset || msg.result, msg.page || msg.dataset, msg.exports || msg.exportMeta);
      playNotificationSound('complete');
      break;

    case 'AUTO_SCRAPE_ERROR':
      currentRunKind = null;
      setRunning(false);
      addStep('error', `❌ ${msg.error}`);
      playNotificationSound('error');
      break;

    case 'CHAT_RESET':
      resetRenderedSessionState();
      currentRunKind = null;
      resetConversationUI({ clearInput: true });
      setRunning(false);
      break;

    case 'TOKEN_USAGE_UPDATED':
      renderUsageDashboard(msg.usage);
      break;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CONVO HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function hideEmpty() {
  const e = $('emptyState');
  if (e) e.style.display = 'none';
}

function resetConversationUI({ clearInput = false } = {}) {
  closeLightbox();
  const convoArea = $('convoArea');
  if (convoArea) convoArea.innerHTML = initialConvoMarkup;
  agentBlockEl = null;
  if (clearInput && taskInput) taskInput.value = '';
  autoResizeTA();
}

function resetRenderedSessionState() {
  currentSessionId = '';
  renderedStepIndexes = new Set();
  restoredTaskSessionKey = '';
}

function renderIncomingStep(step) {
  const s = step;
  if (!s) return;
  if (typeof s.index === 'number') renderedStepIndexes.add(s.index);

  const text = (s.text || '').replace(/^[\u{1F300}-\u{1FFFF}\u2600-\u27FF][\uFE0F]?\s*/u, '').trim();

  if      (s.type === 'thinking')          addStep('thinking',   text);
  else if (s.type === 'screenshot')        addScreenshotStep(s.imageDataUrl, text);
  else if (s.type === 'api')               addStep('bullet',     text);
  else if (s.type === 'action')            addStep('action',     text);
  else if (s.type === 'plan_ready')        addStep('bullet',     text);
  else if (s.type === 'executing')         addStep('spin',       text);
  else if (s.type === 'done')              addStep('done',       text);
  else if (s.type === 'error')             addStep('error',      text);
  else if (s.type === 'stopped')           addStep('stopped',    text);
  else if (s.type === 'checklist_update')  addStep('checklist',  text);
  else                                     addStep('bullet',     text);
}

function syncUiFromAgentState(state) {
  if (!state) return;
  const isAgentActive = Boolean(state.running || state.paused);
  if (state.task) currentRunKind = 'agent';
  if (!isAgentActive && !state.task) currentRunKind = null;
  setRunning(isAgentActive);
}

function requestAgentStateHydration({ force = false } = {}) {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, resp => {
    if (chrome.runtime.lastError) return;
    const state = resp?.state;
    if (!state) return;
    hydrateFromAgentState(state, { force });
    syncUiFromAgentState(state);
  });
}

function hydrateFromAgentState(state, { force = false } = {}) {
  if (!state) return;

  const steps = Array.isArray(state.steps) ? state.steps : [];
  const sessionKey = state.sessionId || (state.task ? '__active__' : '');
  const sessionChanged = Boolean(sessionKey && sessionKey !== currentSessionId);
  const shouldReset = force || sessionChanged;

  if (shouldReset) {
    resetConversationUI({ clearInput: false });
    resetRenderedSessionState();
    currentSessionId = sessionKey;
  } else if (!currentSessionId && sessionKey) {
    currentSessionId = sessionKey;
  }

  if (state.task || steps.length) hideEmpty();

  const taskSessionKey = sessionKey || '__task__';
  if (state.task && restoredTaskSessionKey !== taskSessionKey) {
    appendUserBubble(state.task);
    restoredTaskSessionKey = taskSessionKey;
  }

  const sortedSteps = [...steps].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));
  for (const step of sortedSteps) {
    if (typeof step?.index === 'number' && renderedStepIndexes.has(step.index)) continue;
    renderIncomingStep(step);
  }

  if (state.pendingApproval && !document.querySelector('.approval-card')) {
    renderApprovalCard(state.pendingApproval);
  } else if (state.plan) {
    renderPlanCard(state.plan);
  }
}

function appendUserBubble(text) {
  const convoArea = $('convoArea');
  if (!convoArea) return;
  const el = document.createElement('div');
  el.className = 'msg-user';
  el.textContent = text;
  convoArea.appendChild(el);
  scrollConvo();
}

function appendAgentBlock() {
  const convoArea = $('convoArea');
  if (!convoArea) return null;
  const el = document.createElement('div');
  el.className = 'agent-block';
  convoArea.appendChild(el);
  scrollConvo();
  return el;
}

function addStep(type, text) {
  if (!agentBlockEl) agentBlockEl = appendAgentBlock();
  if (!agentBlockEl) return;
  const row = document.createElement('div');
  row.className = 'agent-step';

  let iconHtml  = '';
  let textClass = 'step-text';

  switch (type) {
    case 'thinking':
      // Chain of Thought — distinct visual: animated brain icon + italic text
      iconHtml  = `<div class="step-icon step-icon--thinking"><div class="step-loader"><span></span><span></span><span></span></div></div>`;
      textClass += ' thinking';
      break;
    case 'spin':
      iconHtml  = `<div class="step-icon"><div class="step-loader"><span></span><span></span><span></span></div></div>`;
      textClass += ' active';
      break;
    case 'done':
    case 'success':
      iconHtml  = `<div class="step-icon"><div class="done-circle"><svg viewBox="0 0 8 8" fill="none" stroke="white" stroke-width="1.6"><polyline points="1.2,4 3,5.8 6.8,2" stroke-linecap="round" stroke-linejoin="round"/></svg></div></div>`;
      textClass += ' done';
      break;
    case 'action':
      iconHtml  = `<div class="step-icon" style="margin-left:1px"><svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="var(--tx3)" stroke-width="1.4"><polygon points="2,1.2 11,6 2,10.8"/></svg></div>`;
      textClass += ' action';
      break;
    case 'checklist':
      // Live checklist item completion — green tick, distinct class
      iconHtml  = `<div class="step-icon"><div class="checklist-tick"><svg viewBox="0 0 8 8" fill="none" stroke="white" stroke-width="1.6"><polyline points="1.2,4 3,5.8 6.8,2" stroke-linecap="round" stroke-linejoin="round"/></svg></div></div>`;
      textClass += ' checklist-done';
      row.className += ' step-checklist';
      break;
    case 'error':
      iconHtml  = `<div class="step-icon" style="font-size:14px">⚠️</div>`;
      textClass += ' error';
      break;
    case 'stopped':
      iconHtml  = `<div class="step-icon" style="font-size:14px">⏹</div>`;
      textClass += ' done';
      break;
    default: // bullet
      iconHtml  = `<div class="step-icon" style="margin-left:2px"><div class="step-bullet"></div></div>`;
  }

  row.innerHTML = `${iconHtml}<span class="${textClass}">${esc(text)}</span>`;
  agentBlockEl.appendChild(row);
  scrollConvo();
}

// ── Screenshot step with inline thumbnail ─────────────────────────────────────
function addScreenshotStep(dataUrl, text) {
  if (!agentBlockEl) agentBlockEl = appendAgentBlock();
  if (!agentBlockEl) return;

  const row = document.createElement('div');
  row.className = 'agent-step screenshot-step';

  // Safely handle missing/invalid dataUrl
  const hasImage = dataUrl && typeof dataUrl === 'string' && dataUrl.startsWith('data:image');
  if (!hasImage) return;

  row.innerHTML = `
    <div class="step-icon" style="margin-left:2px"><div class="step-bullet"></div></div>
    <div class="screenshot-content">
      <span class="step-text">${esc(text || 'Screenshot taken')}</span>
      ${hasImage ? `<div class="screenshot-thumb-wrap">
        <img class="screenshot-thumb" src="${dataUrl}" alt="Screenshot" title="Click to enlarge"/>
        <span class="screenshot-hint">Click to view</span>
      </div>` : ''}
    </div>`;

  if (hasImage) {
    const thumb = row.querySelector('.screenshot-thumb');
    if (thumb) {
      thumb.addEventListener('click', () => openLightbox(dataUrl));
      thumb.addEventListener('error', () => {
        // If image fails to load, remove the thumb wrapper gracefully
        const wrap = row.querySelector('.screenshot-thumb-wrap');
        if (wrap) wrap.remove();
      });
    }
  }

  agentBlockEl.appendChild(row);
  scrollConvo();
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
function openLightbox(src) {
  const lb  = $('lightbox');
  const img = $('lightboxImg');
  if (!lb || !img) return;
  img.src = src;
  lb.classList.add('open');
}

function closeLightbox() {
  const lb = $('lightbox');
  if (lb) lb.classList.remove('open');
  const img = $('lightboxImg');
  if (img) img.src = '';
}

const lightboxClose   = $('lightboxClose');
const lightboxOverlay = $('lightboxOverlay');
if (lightboxClose)   lightboxClose.addEventListener('click',   closeLightbox);
if (lightboxOverlay) lightboxOverlay.addEventListener('click', closeLightbox);

function scrollConvo() {
  const convoArea = $('convoArea');
  if (convoArea) {
    requestAnimationFrame(() => { convoArea.scrollTop = convoArea.scrollHeight; });
  }
}

// ── Plan card ─────────────────────────────────────────────────────────────────
function renderPlanCard(plan) {
  if (!plan || !agentBlockEl) return;

  document.querySelector('.plan-card')?.remove();

  const sites = (plan.sites || []).slice(0, 6).map(s => `
    <div class="plan-site-row">
      <svg class="site-globe" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">
        <circle cx="7" cy="7" r="5.5"/>
        <path d="M7 1.5C7 1.5 5 4 5 7s2 5.5 2 5.5M7 1.5C7 1.5 9 4 9 7s-2 5.5-2 5.5M1.5 7h11"/>
      </svg>
      ${esc(s)}
    </div>`).join('');

  const steps = (plan.steps || []).slice(0, 8).map((step, i) => {
    const stepText = typeof step === 'string' ? step : (step?.text || `Step ${i + 1}`);
    const status = typeof step === 'string' ? 'pending' : (step?.status || 'pending');
    const badge = status === 'done' ? '✓' : status === 'current' ? '>' : status === 'skipped' ? '-' : i + 1;
    return `
    <div class="plan-step-row plan-step-${status}">
      <div class="plan-step-num">${badge}</div>
      <span>${esc(stepText)}</span>
    </div>`;
  }).join('');
  const showApprovalButtons = !isRunning;

  const card = document.createElement('div');
  card.className = 'plan-card';
  card.innerHTML = `
    <div class="plan-card-head">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3">
        <rect x="1.5" y="1.5" width="11" height="11" rx="2"/>
        <line x1="4" y1="5" x2="10" y2="5"/><line x1="4" y1="7.5" x2="8" y2="7.5"/><line x1="4" y1="10" x2="7" y2="10"/>
      </svg>
      Open Comet's plan
    </div>
    <div class="plan-card-body">
      ${sites ? `<div><div class="plan-sec-label">Allow actions on these sites</div>${sites}</div>` : ''}
      ${steps ? `<div><div class="plan-sec-label">Approach to follow</div>${steps}</div>` : ''}
      <div class="plan-note">Open Comet will only use the sites and tools listed. You'll be asked before accessing anything else.</div>
      ${showApprovalButtons ? `<div class="plan-btns">
        <button class="btn-approve" data-action="approve">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8">
            <polyline points="1.5,7 5,10.5 12.5,3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Approve plan
        </button>
        <button class="btn-edit" data-action="edit">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4">
            <path d="M9.5 2.5L11.5 4.5L5 11H3V9L9.5 2.5Z"/><line x1="1.5" y1="13" x2="12.5" y2="13"/>
          </svg>
          Make changes
        </button>
      </div>` : ''}
    </div>`;

  agentBlockEl.appendChild(card);
  scrollConvo();

  card.querySelector('[data-action="approve"]')?.addEventListener('click', () => {
    const btns = card.querySelector('.plan-btns');
    if (btns) btns.innerHTML = `<p style="font-size:12.5px;color:var(--tx3);text-align:center;padding:6px 0">Running…</p>`;
    chrome.runtime.sendMessage({ type: 'APPROVE_PLAN', plan });
    agentBlockEl = appendAgentBlock();
  });

  card.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'REJECT_PLAN' });
    card.remove();
    addStep('stopped', 'Plan cancelled. Edit your task and try again.');
    setRunning(false);
  });
}

// ── Approval card ─────────────────────────────────────────────────────────────
function renderApprovalCard(approval) {
  if (!approval || !agentBlockEl) return;
  const card = document.createElement('div');
  card.className = 'approval-card';
  card.innerHTML = `
    <div class="approval-title">⚠️ Approval needed</div>
    <div class="approval-msg">${esc(approval.message || 'The agent needs permission to continue.')}</div>
    <div class="approval-btns">
      <button class="btn-allow" data-action="allow">Allow once</button>
      <button class="btn-deny"  data-action="deny">Cancel</button>
    </div>`;
  agentBlockEl.appendChild(card);
  scrollConvo();

  card.querySelector('[data-action="allow"]').addEventListener('click', () => {
    card.remove();
    chrome.runtime.sendMessage({ type: 'RESOLVE_APPROVAL', approvalId: approval.id, decision: 'approve_once' });
    agentBlockEl = appendAgentBlock();
  });
  card.querySelector('[data-action="deny"]').addEventListener('click', () => {
    card.remove();
    chrome.runtime.sendMessage({ type: 'RESOLVE_APPROVAL', approvalId: approval.id, decision: 'cancel' });
    setRunning(false);
  });
}

// ── Research report card ──────────────────────────────────────────────────────
function renderResearchCard(task, report, subQueries, sources) {
  if (!agentBlockEl) return;
  const card = document.createElement('div');
  card.className = 'research-card';

  // Render report markdown as safe HTML (simple renderer)
  const reportHtml = markdownToHtml(report || '');

  // Source chips
  const srcsHtml = (sources || []).slice(0, 12).map((s, i) =>
    `<a class="src-chip" href="${esc(s.url)}" target="_blank" title="${esc(s.title)}">
       <span class="src-num">[${i + 1}]</span>
       <span class="src-title">${esc((s.title || s.displayUrl || s.url).substring(0, 50))}</span>
     </a>`
  ).join('');

  // Sub-queries used
  const queriesHtml = (subQueries || []).map(q =>
    `<span class="query-chip">${esc(q)}</span>`
  ).join('');

  card.innerHTML = `
    <div class="research-head">
      <div class="research-label">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <circle cx="6" cy="6" r="4.5"/><line x1="9.5" y1="9.5" x2="13" y2="13"/>
        </svg>
        Deep Research Report
      </div>
      <button class="result-copy" data-action="copy">Copy</button>
    </div>
    ${queriesHtml ? `<div class="research-queries"><div class="research-qlabel">Queries explored</div><div class="query-chips">${queriesHtml}</div></div>` : ''}
    <div class="research-body">${reportHtml}</div>
    ${srcsHtml ? `<div class="research-sources"><div class="sources-label">Sources</div><div class="src-chips">${srcsHtml}</div></div>` : ''}`;

  agentBlockEl.appendChild(card);
  scrollConvo();

  card.querySelector('[data-action="copy"]').addEventListener('click', function() {
    navigator.clipboard.writeText(report || '').then(() => {
      this.textContent = 'Copied!';
      setTimeout(() => { this.textContent = 'Copy'; }, 1600);
    }).catch(() => {});
  });
}

function renderScrapeCard(task, result, page, exportMeta = null) {
  if (!agentBlockEl) return;
  const card = document.createElement('div');
  card.className = 'research-card';
  const rows = Array.isArray(result?.rows) ? result.rows.slice(0, 8) : [];
  const exportList = Array.isArray(exportMeta) ? exportMeta : (exportMeta ? [exportMeta] : []);
  const preview = rows.length
    ? `<pre class="result-text">${esc(JSON.stringify(rows, null, 2))}</pre>`
    : `<div class="result-text">${esc(result?.summary || 'No structured rows found.')}</div>`;

  card.innerHTML = `
    <div class="research-head">
      <div class="research-label">Web Scrape Result</div>
      <button class="result-copy" data-action="copy">Copy</button>
    </div>
    <div class="research-body">
      <p><strong>Page:</strong> ${esc(page?.title || result?.sourceTitle || page?.url || result?.sourceUrl || 'Current page')}</p>
      <p><strong>Summary:</strong> ${esc(result?.summary || '')}</p>
      ${preview}
      ${exportList.length ? `<p><strong>Saved:</strong> ${exportList.map(item => esc(item.filename || item.format || '')).join(', ')}</p>` : ''}
    </div>
    <div class="research-sources">
      <div class="sources-label">Export</div>
      <div class="skill-actions">
        <button class="skill-action-btn" data-export="json">JSON</button>
        <button class="skill-action-btn" data-export="csv">CSV</button>
        <button class="skill-action-btn" data-export="txt">TXT</button>
      </div>
    </div>`;

  agentBlockEl.appendChild(card);
  scrollConvo();

  const payload = {
    title: result?.title || task || page?.title || 'Scrape Export',
    summary: result?.summary || '',
    rows: result?.rows || [],
    raw: result?.raw || {},
    sourceUrl: page?.url || '',
    sourceTitle: page?.title || '',
  };

  card.querySelector('[data-action="copy"]')?.addEventListener('click', function () {
    navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).then(() => {
      this.textContent = 'Copied!';
      setTimeout(() => { this.textContent = 'Copy'; }, 1600);
    }).catch(() => {});
  });

  card.querySelectorAll('[data-export]').forEach(btn => {
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: 'EXPORT_DATA',
        format: btn.getAttribute('data-export'),
        baseName: `scrape-${Date.now()}`,
        dataset: payload,
      }, resp => {
        if (resp?.ok) {
          const names = (resp.exports || []).map(item => item.filename).filter(Boolean).join(', ');
          addStep('success', `Saved export → ${names || 'file created'}`);
        }
        else addStep('error', `❌ ${resp?.error || 'Export failed'}`);
      });
    });
  });
}

// Very simple markdown → safe HTML (headings, bold, italic, inline code, lists)
function markdownToHtml(md) {
  return md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // Headings
    .replace(/^#{4,6}\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^###\s+(.+)$/gm,    '<h3>$1</h3>')
    .replace(/^##\s+(.+)$/gm,     '<h2>$1</h2>')
    .replace(/^#\s+(.+)$/gm,      '<h2>$1</h2>')
    // Bold & italic
    .replace(/\*\*\*(.+?)\*\*\*/g,  '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g,      '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,          '<em>$1</em>')
    // Inline code
    .replace(/`([^`]+)`/g,          '<code>$1</code>')
    // Unordered list
    .replace(/^[-*+]\s+(.+)$/gm,   '<li>$1</li>')
    // Ordered list
    .replace(/^\d+\.\s+(.+)$/gm,   '<li>$1</li>')
    // Wrap consecutive <li> in <ul>
    .replace(/(<li>.*?<\/li>\n?)+/gs, m => '<ul>' + m + '</ul>')
    // Paragraphs: double newlines
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^/, '<p>').replace(/$/, '</p>')
    // Citation links [N]
    .replace(/\[(\d+)\]/g, '<sup class="cite">[$1]</sup>');
}

// ── Result card ───────────────────────────────────────────────────────────────
/** Escape HTML special characters for safe DOM insertion. */
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Simple markdown formatter for result cards. */
function formatMarkdown(text) {
  if (!text) return '';
  let html = esc(text);

  // Bold: **text**
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  // Bullet points: - text or * text at start of line
  html = html.replace(/^(\s*)[-*]\s+(.*)$/gm, '$1• $2');

  // Newlines to breaks
  html = html.replace(/\n/g, '<br>');

  return html;
}

function renderResultCard(answer) {
  if (!agentBlockEl) return;
  const card = document.createElement('div');
  card.className = 'result-card';
  card.innerHTML = `
    <div class="result-head">
      <div class="result-label">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8">
          <polyline points="1,6 4.5,9.5 11,2.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Complete
      </div>
      <button class="result-copy" data-action="copy">Copy</button>
    </div>
    <div class="result-text">${formatMarkdown(answer)}</div>`;
  agentBlockEl.appendChild(card);
  scrollConvo();

  card.querySelector('[data-action="copy"]').addEventListener('click', function() {
    navigator.clipboard.writeText(answer).then(() => {
      this.textContent = 'Copied!';
      setTimeout(() => { this.textContent = 'Copy'; }, 1600);
    }).catch(() => {});
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// RUNNING STATE
// ══════════════════════════════════════════════════════════════════════════════
function setRunning(on) {
  isRunning = on;
  if (stopBtn) stopBtn.classList.toggle('visible', on);

  // When running: input area stays pinned at bottom (CSS handles layout),
  // convoArea grows to fill available space naturally.
  const agentView = document.getElementById('view-agent');
  if (agentView) agentView.classList.toggle('is-running', on);
  updateComposerState();
}

// ══════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════════════════════════
const providerGrid = $('providerGrid');
if (providerGrid) {
  providerGrid.addEventListener('click', e => {
    const card = e.target.closest('.provider-card');
    if (!card) return;
    document.querySelectorAll('.provider-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    currentProvider = card.dataset.provider;
    renderModelChips(currentProvider);
    updateConnectionFields(currentProvider);
    const mi = $('modelInput');
    if (mi) mi.value = '';
  });
}

// Handler for Provider Type Tabs
document.querySelectorAll('.ptype-btn').forEach(tab => {
  tab.addEventListener('click', () => {
    const type = tab.dataset.type;
    document.querySelectorAll('.ptype-btn').forEach(t => t.classList.remove('selected'));
    tab.classList.add('selected');
    
    // Switch provider based on type
    if (type === 'ollama') {
      currentProvider = 'ollama';
      refreshOllamaModels({ silent: true });
    } else if (type === 'custom') {
      currentProvider = 'custom';
    } else {
      // Default back to first cloud provider if none selected
      const selectedCloud = document.querySelector('.provider-card.selected');
      currentProvider = selectedCloud ? selectedCloud.dataset.provider : 'openai';
    }
    
    renderModelChips(currentProvider);
    updateConnectionFields(currentProvider);
  });
});

function renderModelChips(provider) {
  const chips   = $('modelChips');
  if (!chips) return;
  if (provider === 'ollama') {
    chips.innerHTML = '';
    renderOllamaModelSelectors();
    return;
  }
  const current = $('modelInput')?.value.trim() || '';
  chips.innerHTML = (PROVIDER_MODELS[provider] || []).map(m =>
    `<div class="model-chip${current === m ? ' active' : ''}" data-model="${m}">${m}</div>`
  ).join('');
  chips.querySelectorAll('.model-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const mi = $('modelInput');
      if (mi) mi.value = chip.dataset.model;
      chips.querySelectorAll('.model-chip').forEach(c => c.classList.toggle('active', c === chip));
    });
  });
}

function renderOllamaChipGroup(containerId, models, currentValue, onPick) {
  const container = $(containerId);
  if (!container) return;
  if (!(models || []).length) {
    container.innerHTML = '<div class="history-empty" style="padding:8px 0">No downloaded models found.</div>';
    return;
  }
  container.innerHTML = models.map(model =>
    `<div class="model-chip${currentValue === model ? ' active' : ''}" data-model="${esc(model)}">${esc(model)}</div>`
  ).join('');
  container.querySelectorAll('.model-chip').forEach(chip => {
    chip.addEventListener('click', () => onPick(chip.dataset.model));
  });
}

function renderOllamaModelSelectors() {
  const textInput = $('ollamaTextModelInput');
  const visionInput = $('ollamaVisionModelInput');
  const textValue = textInput?.value.trim() || $('modelInput')?.value.trim() || '';
  const visionValue = visionInput?.value.trim() || $('modelInput')?.value.trim() || '';

  renderOllamaChipGroup('ollamaUnifiedModelChips', ollamaModelCatalog.recommended, textValue === visionValue ? textValue : '', model => {
    if (textInput) textInput.value = model;
    if (visionInput) visionInput.value = model;
    const legacy = $('modelInput');
    if (legacy) legacy.value = model;
    renderOllamaModelSelectors();
    updateModelPill('ollama', model);
  });

  renderOllamaChipGroup('ollamaTextModelChips', ollamaModelCatalog.text, textValue, model => {
    if (textInput) textInput.value = model;
    if (!getSelectedOllamaVisionModel() && supportsOllamaVisionModel(model) && visionInput) {
      visionInput.value = model;
    }
    renderOllamaModelSelectors();
    updateModelPill('ollama', {
      provider: 'ollama',
      ollamaTextModel: getSelectedOllamaTextModel(),
      ollamaVisionModel: getSelectedOllamaVisionModel(),
    });
  });

  renderOllamaChipGroup('ollamaVisionModelChips', ollamaModelCatalog.vision, visionValue, model => {
    if (visionInput) visionInput.value = model;
    if (!getSelectedOllamaTextModel() && textInput) {
      textInput.value = model;
    }
    renderOllamaModelSelectors();
    updateModelPill('ollama', {
      provider: 'ollama',
      ollamaTextModel: getSelectedOllamaTextModel(),
      ollamaVisionModel: getSelectedOllamaVisionModel(),
    });
  });
}

function updateOllamaCatalogStatus({ ok = false, text = '', loading = false } = {}) {
  const dot = $('ollamaModelsDot');
  const status = $('ollamaModelsStatus');
  if (!dot || !status) return;
  dot.className = 'api-dot' + ((ok || loading) ? ' ok' : '');
  status.textContent = text || (loading ? 'Loading downloaded Ollama models...' : 'Downloaded Ollama models have not been loaded yet.');
}

async function refreshOllamaModels({ silent = false } = {}) {
  const settings = await getSettingsBg();
  const baseUrl = $('ollamaBaseUrlInput')?.value.trim() || settings.ollamaBaseUrl || 'http://127.0.0.1:11434';
  if (!silent) updateOllamaCatalogStatus({ loading: true });
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_OLLAMA_MODELS', baseUrl }, resp => {
      if (chrome.runtime.lastError || !resp?.ok) {
        ollamaModelCatalog = normalizeOllamaCatalog(PROVIDER_MODELS.ollama || []);
        updateOllamaCatalogStatus({
          ok: false,
          text: `Unable to load local Ollama models. Check ${baseUrl} and that ollama serve is running.`,
        });
        renderOllamaModelSelectors();
        resolve(ollamaModelCatalog);
        return;
      }
      ollamaModelCatalog = normalizeOllamaCatalog(resp.models || []);
      const recommended = ollamaModelCatalog.recommended[0] || '';
      const count = ollamaModelCatalog.all.length;
      updateOllamaCatalogStatus({
        ok: true,
        text: recommended
          ? `Loaded ${count} downloaded model${count === 1 ? '' : 's'}. Recommended single-model setup: ${recommended}`
          : `Loaded ${count} downloaded model${count === 1 ? '' : 's'}. Select separate text and vision models.`,
      });
      renderOllamaModelSelectors();
      resolve(ollamaModelCatalog);
    });
  });
}

async function loadSettings() {
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, resp => {
    if (chrome.runtime.lastError) return;
    const settings = resp?.settings;
    if (!settings) return;
    const p = settings.provider || 'openai';
    currentProvider = p;
    document.querySelectorAll('.provider-card').forEach(c => c.classList.toggle('selected', c.dataset.provider === p));
    renderModelChips(p);
    updateConnectionFields(p);

    const apiKeyInput   = $('apiKeyInput');
    const customApiKeyInput = $('customApiKeyInput');
    const ollamaBaseUrlInput = $('ollamaBaseUrlInput');
    const providerBaseUrlInput = $('providerBaseUrlInput');
    const providerSupportsVisionInput = $('providerSupportsVisionInput');
    const modelInput    = $('modelInput');
    const customModelInput = $('customModelInput');
    const ollamaTextModelInput = $('ollamaTextModelInput');
    const ollamaVisionModelInput = $('ollamaVisionModelInput');
    const maxStepsInput = $('maxStepsInput');
    const delayInput    = $('delayInput');
    const lsInput       = $('langSearchKeyInput');
    const braveInput    = $('braveSearchKeyInput');
    const serperInput   = $('serperKeyInput');
    const tavilyInput   = $('tavilyKeyInput');
    const drMaxSitesInput = $('deepResearchMaxSitesInput');
    const drMaxQueriesInput = $('deepResearchMaxQueriesInput');
    const drSearchEngineInput = $('deepResearchSearchEngineInput');
    const drPreferredHostsInput = $('deepResearchPreferredHostsInput');
    const subAgentConcurrencyInput = $('subAgentConcurrencyInput');
    const inlineDrMaxSitesInput = $('drMaxSitesInput');
    const inlineDrSearchEngineSelect = $('drSearchEngineSelect');
    const exportFormatInput = $('exportFormatInput');
    const exportFolderInput = $('exportFolderInput');
    const exportDiskLabelInput = $('exportDiskLabelInput');
    const exportPromptInput = $('exportPromptInput');
    const autoExportScrapesInput = $('autoExportScrapesInput');
    const useSubAgentsInput = $('useSubAgentsInput');

    if (settings.apiKey) {
      if (p === 'custom' && customApiKeyInput) customApiKeyInput.value = settings.apiKey;
      else if (apiKeyInput) apiKeyInput.value = settings.apiKey;
    }
    if (ollamaBaseUrlInput) ollamaBaseUrlInput.value = settings.ollamaBaseUrl || 'http://127.0.0.1:11434';
    if (providerBaseUrlInput) providerBaseUrlInput.value = settings.providerBaseUrl || getProviderDefaultBaseUrl(p);
    if (providerSupportsVisionInput) providerSupportsVisionInput.checked = Boolean(settings.providerSupportsVision);
    
    if (settings.model) {
      if (p === 'custom' && customModelInput) customModelInput.value = settings.model;
      else if (modelInput) modelInput.value = settings.model;
    }
    if (ollamaTextModelInput) ollamaTextModelInput.value = settings.ollamaTextModel || settings.model || '';
    if (ollamaVisionModelInput) ollamaVisionModelInput.value = settings.ollamaVisionModel || settings.model || '';
    if (settings.maxSteps        && maxStepsInput)  maxStepsInput.value = settings.maxSteps;
    if (settings.screenshotDelay && delayInput)     delayInput.value    = settings.screenshotDelay;
    if (settings.langSearchKey   && lsInput)        lsInput.value       = settings.langSearchKey;
    if (settings.braveSearchKey  && braveInput)     braveInput.value    = settings.braveSearchKey;
    if (settings.serperKey       && serperInput)    serperInput.value   = settings.serperKey;
    if (settings.tavilyKey       && tavilyInput)    tavilyInput.value   = settings.tavilyKey;
    if (drMaxSitesInput) drMaxSitesInput.value = settings.deepResearchMaxSites || 6;
    if (drMaxQueriesInput) drMaxQueriesInput.value = settings.deepResearchMaxQueries || 4;
    if (drSearchEngineInput) drSearchEngineInput.value = settings.deepResearchSearchEngine || 'google';
    if (drPreferredHostsInput) drPreferredHostsInput.value = (settings.deepResearchPreferredHosts || []).join('\n');
    if (subAgentConcurrencyInput) subAgentConcurrencyInput.value = settings.subAgentConcurrency || 3;
    if (inlineDrMaxSitesInput) inlineDrMaxSitesInput.value = settings.deepResearchMaxSites || 6;
    if (inlineDrSearchEngineSelect) inlineDrSearchEngineSelect.value = settings.deepResearchSearchEngine || 'google';
    if (exportFormatInput) exportFormatInput.value = settings.exportFormat || 'json';
    if (exportFolderInput) exportFolderInput.value = settings.exportFolder || 'Open Comet Exports';
    if (exportDiskLabelInput) exportDiskLabelInput.value = settings.exportDiskLabel || 'Default Downloads';
    if (exportPromptInput) exportPromptInput.checked = Boolean(settings.exportPrompt);
    if (autoExportScrapesInput) autoExportScrapesInput.checked = Boolean(settings.autoExportScrapes);
    if (useSubAgentsInput) useSubAgentsInput.checked = settings.useSubAgents !== false;

    const profile = settings.profileData || {};
    if ($('profileFullNameInput')) $('profileFullNameInput').value = profile.fullName || '';
    if ($('profileEmailInput')) $('profileEmailInput').value = profile.email || '';
    if ($('profilePhoneInput')) $('profilePhoneInput').value = profile.phone || '';
    if ($('profileAddressInput')) $('profileAddressInput').value = profile.address || '';
    if ($('profileCompanyInput')) $('profileCompanyInput').value = profile.company || '';
    if ($('profileWebsiteInput')) $('profileWebsiteInput').value = profile.website || '';
    if ($('profileNotesInput')) $('profileNotesInput').value = profile.notes || '';

    updateApiStatus(settings);
    updateDrStatus(settings);
    updateModelPill(p, p === 'ollama' ? settings : settings.model);
    renderModelChips(p);
    if (p === 'ollama') refreshOllamaModels({ silent: true });
  });
}

function setLicenseFeedback({ valid = false, message = '', badgeLabel } = {}) {
  if (licenseStatusBadge) {
    licenseStatusBadge.textContent = badgeLabel || (valid ? 'ACTIVE' : 'INACTIVE');
    licenseStatusBadge.classList.toggle('ok', Boolean(valid));
    licenseStatusBadge.classList.toggle('inactive', !Boolean(valid));
  }
  if (licenseStatusText) {
    licenseStatusText.textContent = message || (valid ? 'License is active.' : (licenseKeyInput?.value?.trim() ? 'Validate the saved key to refresh status.' : 'Add a key to enable automation.'));
  }
}

function updateLicenseFromRecord(record = {}) {
  const status = record.status || {};
  const valid = Boolean(status.valid);
  const expiresAt = status.expiresAt ? new Date(status.expiresAt) : null;
  const message = expiresAt
    ? `Expires ${expiresAt.toLocaleString()}`
    : record.key
      ? 'Saved key. Validate to refresh status.'
      : 'Enter a license key to activate the agent.';
  setLicenseFeedback({ valid, message });
}

function loadStoredLicense() {
  chrome.storage.local.get('opencometLicense', data => {
    const record = data.opencometLicense || {};
    if (licenseKeyInput && record.key) licenseKeyInput.value = record.key;
    if (licenseEmailInput && record.email) licenseEmailInput.value = record.email;
    updateLicenseFromRecord(record);
  });
}

async function handleValidateLicense() {
  if (!licenseKeyInput) return;
  const key = licenseKeyInput.value.trim();
  if (!key) {
    setLicenseFeedback({ valid: false, message: 'Paste a license key above and click validate.' });
    return;
  }
  setLicenseFeedback({ valid: false, message: 'Validating license…' });
  const result = await validateLicenseKey(key);
  if (!result.ok) {
    setLicenseFeedback({ valid: false, message: result.error || 'Validation failed.' });
    return;
  }
  const record = {
    key,
    status: result.license || {},
    email: licenseEmailInput?.value?.trim() || '',
    lastCheckedAt: Date.now(),
  };
  chrome.storage.local.set({ opencometLicense: record });
  const expiresAt = record.status.expiresAt ? new Date(record.status.expiresAt) : null;
  const message = expiresAt ? `Expires ${expiresAt.toLocaleString()}` : 'License verified.';
  setLicenseFeedback({ valid: Boolean(result.valid), message });
}

async function handleLicenseRequest(action, button, badgeLabel) {
  if (!licenseEmailInput) return;
  const email = licenseEmailInput.value.trim();
  if (!email) {
    setLicenseFeedback({ valid: false, message: 'Enter an email to request a key.' });
    return;
  }
  button && (button.disabled = true);
  setLicenseFeedback({ valid: false, message: 'Requesting key…' });
  const response = await action(email);
  button && (button.disabled = false);
  if (!response.ok) {
    setLicenseFeedback({ valid: false, message: response.error || 'Request failed.' });
    return;
  }
  const data = response.data || {};
  const key = data.key || '';
  const license = data.license || {};
  if (licenseKeyInput && key) licenseKeyInput.value = key;
  const record = {
    key,
    status: license,
    email,
    lastCheckedAt: Date.now(),
  };
  chrome.storage.local.set({ opencometLicense: record });
  const expiresAt = license.expiresAt ? new Date(license.expiresAt) : null;
  const message = expiresAt ? `${badgeLabel} expires ${expiresAt.toLocaleString()}` : `${badgeLabel} issued.`;
  setLicenseFeedback({ valid: true, message });
}

const saveSettingsBtn = $('saveSettingsBtn');
const refreshOllamaModelsBtn = $('refreshOllamaModelsBtn');
if (refreshOllamaModelsBtn) {
  refreshOllamaModelsBtn.addEventListener('click', () => {
    refreshOllamaModels({ silent: false });
  });
}
$('ollamaBaseUrlInput')?.addEventListener('change', () => {
  if (currentProvider === 'ollama') refreshOllamaModels({ silent: false });
});
$('ollamaTextModelInput')?.addEventListener('input', () => {
  if (currentProvider === 'ollama') {
    renderOllamaModelSelectors();
    updateModelPill('ollama', {
      provider: 'ollama',
      ollamaTextModel: getSelectedOllamaTextModel(),
      ollamaVisionModel: getSelectedOllamaVisionModel(),
    });
  }
});
$('ollamaVisionModelInput')?.addEventListener('input', () => {
  if (currentProvider === 'ollama') {
    renderOllamaModelSelectors();
    updateModelPill('ollama', {
      provider: 'ollama',
      ollamaTextModel: getSelectedOllamaTextModel(),
      ollamaVisionModel: getSelectedOllamaVisionModel(),
    });
  }
});
// ══════════════════════════════════════════════════════════════════════════════
// AUTH & PROFILE SYNC (New in v1.2)
// ══════════════════════════════════════════════════════════════════════════════
const API_BASE = `${DEFAULT_APP_BACKEND_URL.replace(/\/+$/, '')}/api`;

async function authFetch(path, options = {}) {
  const { auth = {} } = await chrome.storage.local.get('auth');
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`;
  
  const resp = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Request failed with status ${resp.status}`);
  }
  return resp.json();
}

function updateAuthUi(user = null) {
  const brief = $('profileUserBrief');
  const status = $('profileAuthStatus');
  if (!brief || !status) return;

  if (user) {
    brief.style.display = 'block';
    status.style.display = 'none';
    if ($('profileUserDisplayName')) $('profileUserDisplayName').textContent = user.fullName || user.name || 'User';
    if ($('profileUserEmail')) $('profileUserEmail').textContent = user.email || '';
    if ($('authDot')) $('authDot').className = 'api-dot ok';
  } else {
    brief.style.display = 'none';
    status.style.display = 'block';
    if ($('authDot')) $('authDot').className = 'api-dot';
  }
}

async function loadCloudProfile() {
  try {
    const { auth = {} } = await chrome.storage.local.get('auth');
    if (!auth.token) {
      updateAuthUi(null);
      return null;
    }

    const data = await authFetch('/auth/me');
    if (data.user) {
      updateAuthUi(data.user);
      return data.user;
    }
  } catch (err) {
    console.warn('[Auth] Not signed in or session expired');
    updateAuthUi(null);
  }
  return null;
}

async function ensureOnboarding() {
  const { auth = {}, opencometLicense = {} } = await chrome.storage.local.get(['auth', 'opencometLicense']);
  const bottomNav = $('bottomNav');

  if (!auth.token) {
    showView('auth');
    if (bottomNav) bottomNav.style.display = 'none';
    return;
  }

  // Logged in!
  if (bottomNav) bottomNav.style.display = 'flex';

  const licenseValid = Boolean(opencometLicense.status?.valid);
  if (!licenseValid) {
    showView('settings');
    openSettingsPage('license');
    return;
  }

  // All good
  showView('agent');
}

async function handleLogin() {
  const email = $('authEmail')?.value.trim();
  const password = $('authPassword')?.value;
  const note = $('authStatusNote');
  if (!email || !password) return;
  
  if (note) { note.style.display = 'block'; note.className = ''; note.textContent = 'Signing in...'; }
  
  try {
    const data = await authFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    await chrome.storage.local.set({ auth: { token: data.token, user: data.user } });
    if (note) { note.className = 'ok'; note.textContent = 'Signed in successfully!'; }
    updateAuthUi(data.user);
    
    // Check next onboarding step
    setTimeout(() => {
        if (note) note.style.display = 'none';
        ensureOnboarding();
    }, 1000);

    // Populate fields from sync
    syncFieldsFromUser(data.user);
  } catch (err) {
    if (note) { note.className = 'error'; note.textContent = err.message; }
  }
}

async function handleRegister() {
  const name = $('regName')?.value.trim();
  const email = $('regEmail')?.value.trim();
  const password = $('regPassword')?.value;
  const note = $('authStatusNote');
  
  if (!name || !email || !password) return;
  if (note) { note.style.display = 'block'; note.className = ''; note.textContent = 'Creating account...'; }
  
  try {
    const data = await authFetch('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    });
    await chrome.storage.local.set({ auth: { token: data.token, user: data.user } });
    if (note) { note.className = 'ok'; note.textContent = 'Account created!'; }
    updateAuthUi(data.user);
    
    setTimeout(() => {
        if (note) note.style.display = 'none';
        ensureOnboarding();
    }, 1000);
  } catch (err) {
    if (note) { note.className = 'error'; note.textContent = err.message; }
  }
}

function syncFieldsFromUser(user) {
  if (!user) return;
  if ($('profileFullNameInput')) $('profileFullNameInput').value = user.fullName || user.name || '';
  if ($('profileEmailInput')) $('profileEmailInput').value = user.email || '';
  if ($('profilePhoneInput')) $('profilePhoneInput').value = user.phone || '';
  if ($('profileAddressInput')) $('profileAddressInput').value = user.address || '';
  if ($('profileCompanyInput')) $('profileCompanyInput').value = user.company || '';
  if ($('profileWebsiteInput')) $('profileWebsiteInput').value = user.website || '';
  if ($('profileNotesInput')) $('profileNotesInput').value = user.notes || '';
}

// Wire up auth UI
$('btnOpenAuth')?.addEventListener('click', () => {
    $('loginForm') && ($('loginForm').style.display = 'block');
    $('registerForm') && ($('registerForm').style.display = 'none');
    $('view-auth')?.classList.add('active'); // Still works as a modal if called from settings
});
// (Auth back btn removed as it's now onboarding view)

$('linkToRegister')?.addEventListener('click', () => {
  $('loginForm') && ($('loginForm').style.display = 'none');
  $('registerForm') && ($('registerForm').style.display = 'block');
});
$('linkToLogin')?.addEventListener('click', () => {
  $('loginForm') && ($('loginForm').style.display = 'block');
  $('registerForm') && ($('registerForm').style.display = 'none');
});
$('btnLoginSubmit')?.addEventListener('click', handleLogin);
$('btnRegisterSubmit')?.addEventListener('click', handleRegister);
$('btnLogout')?.addEventListener('click', async () => {
  await chrome.storage.local.remove('auth');
  updateAuthUi(null);
  ensureOnboarding();
});
$('btnSyncProfile')?.addEventListener('click', async () => {
  const btn = $('btnSyncProfile');
  if (btn) btn.textContent = 'Syncing...';
  const user = await loadCloudProfile();
  syncFieldsFromUser(user);
  if (btn) { btn.textContent = 'Synced ✓'; setTimeout(() => btn.textContent = 'Sync from Cloud', 2000); }
});

async function saveSettings() {
    const apiKeyInput   = $('apiKeyInput');
    const ollamaBaseUrlInput = $('ollamaBaseUrlInput');
    const providerBaseUrlInput = $('providerBaseUrlInput');
    const providerSupportsVisionInput = $('providerSupportsVisionInput');
    const modelInput    = $('modelInput');
    const ollamaTextModelInput = $('ollamaTextModelInput');
    const ollamaVisionModelInput = $('ollamaVisionModelInput');
    const maxStepsInput = $('maxStepsInput');
    const delayInput    = $('delayInput');
    
    const profileData = {
      fullName: $('profileFullNameInput') ? $('profileFullNameInput').value.trim() : '',
      email: $('profileEmailInput') ? $('profileEmailInput').value.trim() : '',
      phone: $('profilePhoneInput') ? $('profilePhoneInput').value.trim() : '',
      address: $('profileAddressInput') ? $('profileAddressInput').value.trim() : '',
      company: $('profileCompanyInput') ? $('profileCompanyInput').value.trim() : '',
      website: $('profileWebsiteInput') ? $('profileWebsiteInput').value.trim() : '',
      notes: $('profileNotesInput') ? $('profileNotesInput').value.trim() : '',
    };

    const settings = {
      provider:        currentProvider,
      apiKey:          currentProvider === 'custom' 
        ? ($('customApiKeyInput')?.value.trim() || '')
        : ($('apiKeyInput')?.value.trim() || ''),
      ollamaBaseUrl:   $('ollamaBaseUrlInput') ? $('ollamaBaseUrlInput').value.trim() : 'http://127.0.0.1:11434',
      providerBaseUrl: (() => {
        const presets = ['deepseek', 'kimi', 'glm'];
        if (presets.includes(currentProvider)) {
          const raw = $('providerBaseUrlInput')?.value.trim();
          return raw || getProviderDefaultBaseUrl(currentProvider);
        }
        return $('providerBaseUrlInput') ? $('providerBaseUrlInput').value.trim() : '';
      })(),
      providerSupportsVision: $('providerSupportsVisionInput') ? $('providerSupportsVisionInput').checked : false,
      model:           currentProvider === 'ollama'
        ? (($('ollamaTextModelInput')?.value.trim() || $('ollamaVisionModelInput')?.value.trim() || $('modelInput')?.value.trim() || ''))
        : (currentProvider === 'custom' ? ($('customModelInput')?.value.trim() || '') : ($('modelInput')?.value.trim() || '')),
      ollamaTextModel: currentProvider === 'ollama' ? ($('ollamaTextModelInput')?.value.trim() || '') : '',
      ollamaVisionModel: currentProvider === 'ollama' ? ($('ollamaVisionModelInput')?.value.trim() || '') : '',
      maxSteps:        maxStepsInput ? (parseInt(maxStepsInput.value) || 20) : 20,
      screenshotDelay: delayInput    ? (parseInt(delayInput.value)    || 1200): 1200,
      langSearchKey:   $('langSearchKeyInput')  ? $('langSearchKeyInput').value.trim()  : '',
      braveSearchKey:  $('braveSearchKeyInput') ? $('braveSearchKeyInput').value.trim() : '',
      serperKey:       $('serperKeyInput')       ? $('serperKeyInput').value.trim()       : '',
      tavilyKey:       $('tavilyKeyInput')       ? $('tavilyKeyInput').value.trim()       : '',
      deepResearchMaxSites: $('deepResearchMaxSitesInput') ? (parseInt($('deepResearchMaxSitesInput').value, 10) || 6) : 6,
      deepResearchMaxQueries: $('deepResearchMaxQueriesInput') ? (parseInt($('deepResearchMaxQueriesInput').value, 10) || 4) : 4,
      deepResearchSearchEngine: $('deepResearchSearchEngineInput') ? $('deepResearchSearchEngineInput').value : 'google',
      deepResearchPreferredHosts: $('deepResearchPreferredHostsInput')
        ? $('deepResearchPreferredHostsInput').value.split('\n').map(v => v.trim()).filter(Boolean)
        : [],
      useSubAgents: $('useSubAgentsInput') ? $('useSubAgentsInput').checked : true,
      subAgentConcurrency: $('subAgentConcurrencyInput') ? (parseInt($('subAgentConcurrencyInput').value, 10) || 3) : 3,
      exportFormat: $('exportFormatInput') ? $('exportFormatInput').value : 'json',
      exportFolder: $('exportFolderInput') ? $('exportFolderInput').value.trim() : 'Open Comet Exports',
      exportDiskLabel: $('exportDiskLabelInput') ? $('exportDiskLabelInput').value.trim() : 'Default Downloads',
      exportPrompt: $('exportPromptInput') ? $('exportPromptInput').checked : false,
      autoExportScrapes: $('autoExportScrapesInput') ? $('autoExportScrapesInput').checked : false,
      profileData,
    };

    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }, () => {
      if (chrome.runtime.lastError) return;
      updateApiStatus(settings);
      updateDrStatus(settings);
      updateModelPill(settings.provider, settings.provider === 'ollama' ? getDisplayedOllamaModel(settings) : settings.model);
      const btn = $('saveSettingsBtn');
      if (btn) {
        btn.textContent = 'Saved ✓';
        setTimeout(() => { btn.textContent = 'Save settings'; }, 1800);
      }
      
      // If signed in, also sync profile data to cloud
      chrome.storage.local.get('auth', async ({ auth }) => {
        if (auth?.token) {
          try {
            await authFetch('/auth/profile', {
              method: 'PATCH',
              body: JSON.stringify(profileData),
            });
          } catch (e) {
            console.error('[Sync] Profile upload failed:', e);
          }
        }
      });
    });
}
if (saveSettingsBtn) {
  saveSettingsBtn.addEventListener('click', saveSettings);
}

// Initial load
ensureOnboarding();
loadCloudProfile();

function updateApiStatus(s) {
  const dot  = $('apiDot');
  const text = $('apiStatusText');
  if (!dot || !text) return;
  const configured = isProviderConfigured(s);
  dot.className    = 'api-dot' + (configured ? ' ok' : '');
  if (!configured) {
    text.textContent = String(s.provider || 'provider') === 'ollama'
      ? 'Set Ollama base URL to connect'
      : ['deepseek', 'kimi', 'glm', 'custom'].includes(String(s.provider || '').toLowerCase())
        ? 'Set API key and provider base URL'
      : 'Not configured';
    return;
  }
  text.textContent = String(s.provider || '').toLowerCase() === 'ollama'
    ? `ollama · ${s.ollamaBaseUrl || 'http://127.0.0.1:11434'}`
    : ['deepseek', 'kimi', 'glm', 'custom'].includes(String(s.provider || '').toLowerCase())
      ? `${s.provider} · ${s.providerBaseUrl || getProviderDefaultBaseUrl(s.provider)}`
    : `${s.provider} · key configured ✓`;
}

function updateDrStatus(s) {
  // LangSearch
  const lsDot  = $('lsDot');  const lsText  = $('lsStatusText');
  if (lsDot && lsText) {
    lsDot.className  = 'api-dot' + (s.langSearchKey ? ' ok' : '');
    lsText.textContent = s.langSearchKey ? 'Key configured ✓' : 'Not configured';
  }
  // Brave
  const bDot  = $('braveDot');  const bText  = $('braveStatusText');
  if (bDot && bText) {
    bDot.className  = 'api-dot' + (s.braveSearchKey ? ' ok' : '');
    bText.textContent = s.braveSearchKey ? 'Key configured ✓' : 'Not configured';
  }
  // Serper
  const sDot  = $('serperDot'); const sText  = $('serperStatusText');
  if (sDot && sText) {
    sDot.className  = 'api-dot' + (s.serperKey ? ' ok' : '');
    sText.textContent = s.serperKey ? 'Key configured ✓' : 'Not configured';
  }
  // Tavily
  const tDot  = $('tavilyDot'); const tText  = $('tavilyStatusText');
  if (tDot && tText) {
    tDot.className  = 'api-dot' + (s.tavilyKey ? ' ok' : '');
    tText.textContent = s.tavilyKey ? 'Key configured ✓' : 'Not configured';
  }
}
// Legacy alias kept for runDeepResearch check
const updateLsStatus = updateDrStatus;

function getDisplayedModel(provider, model) {
  if (provider === 'ollama' && typeof model === 'object' && model) {
    return getDisplayedOllamaModel(model);
  }
  return model || PROVIDER_MODELS[provider]?.[0] || provider || 'GPT-4o';
}

function updateModelPill(provider, model) {
  if (modelPillLabel) modelPillLabel.textContent = getDisplayedModel(provider, model);
}

async function getSettingsBg() {
  return new Promise(res =>
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, r => {
      if (chrome.runtime.lastError) { res({}); return; }
      res(r?.settings || {});
    })
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// HISTORY
// ══════════════════════════════════════════════════════════════════════════════
function renderHistory() {
  const list = $('historyList');
  if (!list) return;
  chrome.runtime.sendMessage({ type: 'GET_HISTORY' }, resp => {
    if (chrome.runtime.lastError) {
      list.innerHTML = '<div class="history-empty">Unable to load history.</div>';
      return;
    }
    const history = resp?.history || [];
    if (!history.length) {
      list.innerHTML = '<div class="history-empty">No tasks run yet.</div>';
      return;
    }
    list.innerHTML = history.map(h => {
      const usageHtml = (h.tokens || h.cost)
        ? `<span class="hdot"></span><span>${h.tokens || 0} tokens ` +
          (h.cost > 0 ? `($${h.cost.toFixed(4)})` : '') + `</span>`
        : '';
        
      return `
      <div class="history-item" data-task="${esc(h.task)}">
        <div class="history-task">${esc(h.task)}</div>
        <div class="history-meta">
          <span class="badge ${h.status || 'done'}">${h.status || 'done'}</span>
          <span class="hdot"></span>
          <span>${h.steps || 0} steps</span>
          <span class="hdot"></span>
          <span>${fmtTime(h.time)}</span>
          ${usageHtml}
        </div>
      </div>`;
    }).join('');
    list.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', () => {
        if (taskInput) taskInput.value = item.dataset.task;
        showView('agent');
        if (taskInput) taskInput.focus();
        autoResizeTA();
      });
    });
  });
}

const clearHistoryBtn = $('clearHistoryBtn');
if (clearHistoryBtn) {
  clearHistoryBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' }, () => {
      if (!chrome.runtime.lastError) renderHistory();
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════════════════════════════════════════
function fmtTime(ts) {
  return new Date(ts).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}

function autoResizeTA() {
  if (!taskInput) return;
  taskInput.style.height = 'auto';
  taskInput.style.height = Math.min(taskInput.scrollHeight, 130) + 'px';
}

if (taskInput) {
  taskInput.addEventListener('input', () => {
    autoResizeTA();
    handleSlashCommand();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// SLASH COMMANDS
// ══════════════════════════════════════════════════════════════════════════════
let slashMenuOpen = false;
let slashSelectedIndex = 0;
let filteredSlashSkills = [];

function handleSlashCommand() {
  const val = taskInput.value;
  const cursor = taskInput.selectionStart;
  const before = val.substring(0, cursor);
  
  // Trigger if ends with / or if typing after /
  const match = before.match(/\/((\w|\s)*)$/);
  if (match) {
    const query = match[1].toLowerCase().trim();
    showSlashMenu(query);
  } else {
    closeSlashMenu();
  }
}

function showSlashMenu(query) {
  const menu = $('slashMenu');
  const list = $('slashMenuList');
  if (!menu || !list) return;

  filteredSlashSkills = allSkillsCache.filter(s => 
    s.name.toLowerCase().includes(query) || 
    (s.category || '').toLowerCase().includes(query)
  );

  if (!filteredSlashSkills.length) {
    closeSlashMenu();
    return;
  }

  slashMenuOpen = true;
  slashSelectedIndex = 0;
  menu.classList.add('open');
  
  list.innerHTML = filteredSlashSkills.map((s, i) => `
    <div class="slash-item${i === 0 ? ' selected' : ''}" data-id="${esc(s.id)}" data-index="${i}">
      <div class="slash-icon">${s.icon || '⚙️'}</div>
      <div class="slash-info">
        <div class="slash-name">${esc(s.name)}</div>
        <div class="slash-desc">${esc(s.description || s.category || '')}</div>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.slash-item').forEach(item => {
    item.addEventListener('click', () => {
      selectSlashSkill(filteredSlashSkills[parseInt(item.dataset.index)].id);
    });
  });
}

function closeSlashMenu() {
  slashMenuOpen = false;
  const menu = $('slashMenu');
  if (menu) menu.classList.remove('open');
}

function selectSlashSkill(id) {
  toggleSkillActive(id, document.querySelector(`.skill-card[data-id="${id}"]`) || null);
  
  // Replace the slash command with empty string in input
  const val = taskInput.value;
  const cursor = taskInput.selectionStart;
  const before = val.substring(0, cursor);
  const after  = val.substring(cursor);
  
  taskInput.value = before.replace(/\/((\w|\s)*)$/, '') + after;
  taskInput.focus();
  closeSlashMenu();
  autoResizeTA();
}

// Keyboard nav for slash menu
if (taskInput) {
  taskInput.addEventListener('keydown', e => {
    if (!slashMenuOpen) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      slashSelectedIndex = (slashSelectedIndex + 1) % filteredSlashSkills.length;
      updateSlashSelection();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      slashSelectedIndex = (slashSelectedIndex - 1 + filteredSlashSkills.length) % filteredSlashSkills.length;
      updateSlashSelection();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectSlashSkill(filteredSlashSkills[slashSelectedIndex].id);
    } else if (e.key === 'Escape') {
      closeSlashMenu();
    }
  });
}

function updateSlashSelection() {
  const list = $('slashMenuList');
  if (!list) return;
  list.querySelectorAll('.slash-item').forEach((item, i) => {
    item.classList.toggle('selected', i === slashSelectedIndex);
    if (i === slashSelectedIndex) item.scrollIntoView({ block: 'nearest' });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// SKILLS  (v1.1)
// Full CRUD: list, create, edit, delete, activate/deactivate per session
// ══════════════════════════════════════════════════════════════════════════════

// ── Built-in skills (always available, not stored in chrome.storage) ──────────
const BUILT_IN_SKILLS = [
  {
    id: 'builtin_summarise', name: 'Summarise Page', icon: '📄', category: 'Research', builtIn: true,
    description: 'Summarise the current page directly from scraped page content.',
    prompt: 'Summarise the current page directly from the readable page content. Do not rely on screenshots unless navigation is required first. Extract the main topic, key arguments or facts, and important conclusions. Present a concise summary with bullet points.',
    allowedHosts: [], preferredSites: [],
    doneChecklist: ['Page content summarised', 'Key points listed as bullets', 'Summary under 300 words'],
  },
  {
    id: 'builtin_web_scraper', name: 'Web Scraper', icon: '🕸️', category: 'Data Extraction', builtIn: true,
    description: 'Scrape the current page into structured data and export it.',
    prompt: 'Scrape the current page directly from the DOM. Extract structured rows, key fields, links, tables, and contact data where available. Prefer reusable structured data over prose. Prepare the output for JSON or CSV export.',
    allowedHosts: [], preferredSites: [],
    doneChecklist: ['Structured data extracted', 'Rows or key fields returned', 'Export-ready output prepared'],
  },
  {
    id: 'builtin_price_check', name: 'Price Comparison', icon: '🛒', category: 'Shopping', builtIn: true,
    description: 'Compare product prices across Amazon, Flipkart, and one other site.',
    prompt: 'Search for the product on Amazon, Flipkart, and one other relevant site. For each: extract product name, exact price, rating, and URL. Return a comparison table with the best deal highlighted.',
    allowedHosts: ['amazon.in', 'amazon.com', 'flipkart.com'],
    preferredSites: ['amazon.in', 'flipkart.com'],
    doneChecklist: ['Prices found on ≥2 sites', 'Ratings extracted', 'Best deal identified'],
  },
  {
    id: 'builtin_extract_contacts', name: 'Extract Contacts', icon: '📧', category: 'Data Extraction', builtIn: true,
    description: 'Scrape all emails, phone numbers, and contact names from the page.',
    prompt: 'Scan the entire page (scroll to bottom if needed) and extract every email address, phone number, and contact name visible. Return results structured by type: emails, phones, names. Include the source page URL.',
    allowedHosts: [], preferredSites: [],
    doneChecklist: ['Page fully scrolled', 'All emails extracted', 'All phones extracted', 'Results grouped by type'],
  },
  {
    id: 'builtin_multi_source', name: 'Multi-Source Research', icon: '🔬', category: 'Research', builtIn: true,
    description: 'Research a topic across 3+ independent sources and synthesise findings.',
    prompt: 'Research the given topic. Visit at least 3 independent, authoritative sources (not just Google). Per source: note URL, key claims, data points. Synthesise findings into a cohesive report noting agreements and conflicts. Cite sources by URL.',
    allowedHosts: [], preferredSites: [],
    doneChecklist: ['At least 3 independent sources visited', 'Key claims noted per source', 'Synthesis written with citations'],
  },
  {
    id: 'builtin_form_filler', name: 'Smart Form Filler', icon: '📝', category: 'Form Filling', builtIn: true,
    description: 'Detect and fill all visible form fields using task-provided information.',
    prompt: 'Identify all visible form fields (inputs, textareas, selects, checkboxes). Fill each with appropriate data based on its label, placeholder, and name. Submit only if the user explicitly asked to submit.',
    allowedHosts: [], preferredSites: [],
    doneChecklist: ['All form fields identified', 'Fields filled with appropriate data', 'Not submitted unless requested'],
  },
];

const USER_SKILLS_KEY = 'opencometSkills';
const USER_SKILL_META_KEY = 'opencometSkillMeta';

function skillToMeta(skill) {
  return {
    id: skill.id,
    name: skill.name,
    icon: skill.icon || '⚙️',
    category: skill.category || 'Custom',
    builtIn: Boolean(skill.builtIn),
    description: skill.description || '',
    promptPreview: String(skill.prompt || '').substring(0, 280),
    allowedHosts: skill.allowedHosts || [],
    preferredSites: skill.preferredSites || [],
    doneChecklist: skill.doneChecklist || [],
    createdAt: skill.createdAt || Date.now(),
  };
}

const BUILT_IN_SKILL_MAP = new Map(BUILT_IN_SKILLS.map(skill => [skill.id, skill]));
const BUILT_IN_SKILL_META = BUILT_IN_SKILLS.map(skillToMeta);

// ── Active skills state (for current session, not persisted) ──────────────────
let activeSkillIds = new Set(); // IDs of skills active for next task

// ── Skill data cache ──────────────────────────────────────────────────────────
let allSkillsCache = [];

// ── Nav hookup ────────────────────────────────────────────────────────────────
// ── Nav hookup ────────────────────────────────────────────────────────────────
// navSkills removed from bottom nav in v1.2

// Patch showView to handle 'skills'
const _origShowView = showView;
window.showView = function(name) {
  _origShowView(name);
  if (name === 'skills') {
    loadSkills();
  }
};

// ── Load and render skills ────────────────────────────────────────────────────
async function loadSkills() {
  const userSkills = await getStoredSkillMeta();
  allSkillsCache   = [...BUILT_IN_SKILL_META, ...userSkills];
  renderSkillsList(allSkillsCache);
  updateActiveSkillsBar();
}

function getStoredSkills() {
  return new Promise(resolve => {
    chrome.storage.local.get(USER_SKILLS_KEY, data => {
      resolve(data[USER_SKILLS_KEY] || []);
    });
  });
}

function getStoredSkillMeta() {
  return new Promise(resolve => {
    chrome.storage.local.get([USER_SKILL_META_KEY, USER_SKILLS_KEY], data => {
      const meta = data[USER_SKILL_META_KEY];
      if (Array.isArray(meta) && meta.length) {
        resolve(meta);
        return;
      }
      const derived = (data[USER_SKILLS_KEY] || []).map(skillToMeta);
      chrome.storage.local.set({ [USER_SKILL_META_KEY]: derived }, () => resolve(derived));
    });
  });
}

async function getStoredSkillById(id) {
  const skills = await getStoredSkills();
  return skills.find(skill => skill.id === id) || null;
}

async function materializeSkillById(id) {
  if (BUILT_IN_SKILL_MAP.has(id)) return BUILT_IN_SKILL_MAP.get(id);
  return await getStoredSkillById(id);
}

async function materializeSkillsByIds(ids) {
  const out = [];
  for (const id of ids || []) {
    const skill = await materializeSkillById(id);
    if (skill) out.push(skill);
  }
  return out;
}

function saveStoredSkill(skill) {
  return new Promise(resolve => {
    getStoredSkills().then(skills => {
      const idx = skills.findIndex(s => s.id === skill.id);
      if (idx >= 0) skills[idx] = skill; else skills.unshift(skill);
      chrome.storage.local.set({
        [USER_SKILLS_KEY]: skills,
        [USER_SKILL_META_KEY]: skills.map(skillToMeta),
      }, resolve);
    });
  });
}

function deleteStoredSkill(id) {
  return new Promise(resolve => {
    getStoredSkills().then(skills => {
      const next = skills.filter(s => s.id !== id);
      chrome.storage.local.set({
        [USER_SKILLS_KEY]: next,
        [USER_SKILL_META_KEY]: next.map(skillToMeta),
      }, resolve);
    });
  });
}

// ── Render skills list ────────────────────────────────────────────────────────
function renderSkillsList(skills) {
  const list = $('skillsList');
  if (!list) return;

  if (!skills.length) {
    list.innerHTML = '<div class="history-empty">No skills yet. Create your first skill above.</div>';
    return;
  }

  // Group by category
  const byCategory = {};
  for (const skill of skills) {
    const cat = skill.category || 'Custom';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(skill);
  }

  // Render order: built-in categories first, then user categories
  const catOrder = ['Research', 'Shopping', 'Social', 'Productivity', 'Data Extraction', 'Form Filling', 'Custom'];
  const sortedCats = [...new Set([...catOrder, ...Object.keys(byCategory)])].filter(c => byCategory[c]?.length);

  list.innerHTML = sortedCats.map(cat => `
    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:4px">
      <div class="skill-category-label">${esc(cat)}</div>
      ${byCategory[cat].map(skill => renderSkillCard(skill)).join('')}
    </div>
  `).join('');

  // Wire up toggles, expand/collapse, edit, delete, run
  list.querySelectorAll('.skill-card').forEach(card => {
    const id   = card.dataset.id;
    const body = card.querySelector('.skill-card-body');

    // Expand on head click
    card.querySelector('.skill-card-head')?.addEventListener('click', e => {
      if (e.target.closest('.skill-toggle')) return;
      body?.classList.toggle('open');
    });

    // Toggle active
    card.querySelector('.skill-toggle')?.addEventListener('click', e => {
      e.stopPropagation();
      toggleSkillActive(id, card);
    });

    // Edit
    card.querySelector('[data-action="edit"]')?.addEventListener('click', () => openSkillEditor(id));

    // Delete
    card.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
      if (!confirm(`Delete skill "${card.dataset.name}"?`)) return;
      await deleteStoredSkill(id);
      activeSkillIds.delete(id);
      loadSkills();
    });

    // Use now (run immediately with this skill)
    card.querySelector('[data-action="use"]')?.addEventListener('click', () => {
      if (!activeSkillIds.has(id)) {
        activeSkillIds.add(id);
        updateActiveSkillsBar();
      }
      showView('agent');
      if (taskInput) taskInput.focus();
    });
  });
}

function renderSkillCard(skill) {
  const isActive   = activeSkillIds.has(skill.id);
  const isBuiltIn  = skill.builtIn;
  const checklist  = (skill.doneChecklist || []).slice(0, 4)
    .map(c => `<div class="skill-checklist-item">${esc(c)}</div>`).join('');
  const hosts      = (skill.allowedHosts || []).slice(0, 5)
    .map(h => `<span class="skill-host-chip">${esc(h)}</span>`).join('');

  return `
    <div class="skill-card${isActive ? ' is-active' : ''}" data-id="${esc(skill.id)}" data-name="${esc(skill.name)}">
      <div class="skill-card-head">
        <div class="skill-icon">${skill.icon || '⚙️'}</div>
        <div class="skill-info">
          <div class="skill-name">${esc(skill.name)}</div>
          <div class="skill-sub">${esc(skill.description || skill.category || '')}</div>
        </div>
        ${isBuiltIn ? '<span class="skill-builtin-badge">Built-in</span>' : ''}
        <button class="skill-toggle${isActive ? ' on' : ''}" title="${isActive ? 'Deactivate' : 'Activate'}"></button>
      </div>
      <div class="skill-card-body">
        <div class="skill-prompt-preview">${esc(skill.promptPreview || (skill.prompt || '').substring(0, 280))}${((skill.promptPreview || skill.prompt || '').length > 280) ? '…' : ''}</div>
        ${checklist ? `<div class="skill-checklist">${checklist}</div>` : ''}
        ${hosts     ? `<div class="skill-hosts">${hosts}</div>` : ''}
        <div class="skill-actions">
          <button class="skill-action-btn" data-action="use">Use now</button>
          ${!isBuiltIn ? `<button class="skill-action-btn" data-action="edit">Edit</button>` : ''}
          ${!isBuiltIn ? `<button class="skill-action-btn danger" data-action="delete">Delete</button>` : ''}
        </div>
      </div>
    </div>`;
}

function toggleSkillActive(id, cardEl = null) {
  if (activeSkillIds.has(id)) {
    activeSkillIds.delete(id);
    if (cardEl) {
      cardEl.classList.remove('is-active');
      cardEl.querySelector('.skill-toggle')?.classList.remove('on');
    }
  } else {
    activeSkillIds.add(id);
    if (cardEl) {
      cardEl.classList.add('is-active');
      cardEl.querySelector('.skill-toggle')?.classList.add('on');
    }
  }
  updateActiveSkillsBar();
}

// ── Active skills bar (shown in skills view) ──────────────────────────────────
function updateActiveSkillsBar() {
  const bar   = $('activeSkillsBar');
  const chips = $('asbChips');
  if (!bar || !chips) return;

  const active = allSkillsCache.filter(s => activeSkillIds.has(s.id));
  if (!active.length) { bar.style.display = 'none'; return; }

  bar.style.display = 'flex';
  chips.innerHTML = active.map(s => `
    <div class="asb-chip" data-id="${esc(s.id)}">
      ${s.icon || '⚙️'} ${esc(s.name)}
      <button class="asb-chip-remove" data-id="${esc(s.id)}" title="Remove">×</button>
    </div>`).join('');

  chips.querySelectorAll('.asb-chip-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      activeSkillIds.delete(id);
      updateActiveSkillsBar();
      // Also uncheck the card if visible
      const card = document.querySelector(`.skill-card[data-id="${id}"]`);
      if (card) { card.classList.remove('is-active'); card.querySelector('.skill-toggle')?.classList.remove('on'); }
    });
  });
}

const asbClear = $('asbClear');
if (asbClear) asbClear.addEventListener('click', () => {
  activeSkillIds.clear();
  updateActiveSkillsBar();
  document.querySelectorAll('.skill-card').forEach(c => {
    c.classList.remove('is-active');
    c.querySelector('.skill-toggle')?.classList.remove('on');
  });
});

// ── Skill Editor Modal ────────────────────────────────────────────────────────
let editingSkillId = null;

async function openSkillEditor(id = null) {
  const modal = $('skillModal');
  if (!modal) return;

  editingSkillId = id;
  const skill = id ? await materializeSkillById(id) : null;

  const title = $('skillModalTitle');
  if (title) title.textContent = skill ? 'Edit Skill' : 'New Skill';

  // Populate fields
  const set = (elId, val) => { const el = $(elId); if (el) el.value = val || ''; };
  set('smName',          skill?.name || '');
  set('smIcon',          skill?.icon || '⚙️');
  set('smCategory',      skill?.category || 'Custom');
  set('smDescription',   skill?.description || '');
  set('smPrompt',        skill?.prompt || '');
  set('smAllowedHosts',  (skill?.allowedHosts || []).join('\n'));
  set('smDoneChecklist', (skill?.doneChecklist || []).join('\n'));

  modal.classList.add('open');
}

function closeSkillEditor() {
  const modal = $('skillModal');
  if (modal) modal.classList.remove('open');
  editingSkillId = null;
}

$('newSkillBtn')    ?.addEventListener('click', ()  => openSkillEditor(null));
$('skillModalClose')?.addEventListener('click', closeSkillEditor);
$('smCancel')       ?.addEventListener('click', closeSkillEditor);

$('smSave')?.addEventListener('click', async () => {
  const name   = $('smName')?.value.trim();
  const prompt = $('smPrompt')?.value.trim();
  if (!name)   { alert('Skill name is required.'); return; }
  if (!prompt) { alert('Agent instructions are required.'); return; }

  const parseLines = id => ($(id)?.value || '').split('\n').map(l => l.trim()).filter(Boolean);

  const skill = {
    id:            editingSkillId || `skill_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    name:          name.substring(0, 80),
    icon:          $('smIcon')?.value.trim() || '⚙️',
    category:      $('smCategory')?.value || 'Custom',
    description:   $('smDescription')?.value.trim().substring(0, 300) || '',
    prompt:        prompt.substring(0, 3000),
    allowedHosts:  parseLines('smAllowedHosts').map(h => h.toLowerCase()),
    preferredSites:[],
    doneChecklist: parseLines('smDoneChecklist'),
    builtIn:       false,
    createdAt:     Date.now(),
  };

  await saveStoredSkill(skill);
  closeSkillEditor();
  loadSkills();
});

// ── Get active skills for agent dispatch ──────────────────────────────────────
async function getActiveSkillsForAgent() {
  const fullSkills = await materializeSkillsByIds([...activeSkillIds]);
  return fullSkills.map(s => ({
    id:            s.id,
    name:          s.name,
    prompt:        s.prompt,
    allowedHosts:  s.allowedHosts  || [],
    preferredSites:s.preferredSites|| [],
    doneChecklist: s.doneChecklist || [],
  }));
}

// ── Patch runAgent to pass active skills ──────────────────────────────────────
// Override the existing runAgent by monkey-patching sendMessage
const _origRunAgent = window.runAgent;

async function runAgentWithSkills() {
  let task = taskInput?.value.trim();
  if (isRunning) return;

  const settings = await getSettingsBg();
  if (!isProviderConfigured(settings)) {
    showView('settings');
    (settings.provider === 'ollama' ? $('ollamaBaseUrlInput') : $('apiKeyInput'))?.focus();
    return;
  }

  hideEmpty();
  // Show active skills in convo if any
  const activeSkills = await getActiveSkillsForAgent();
  const skillIds = new Set(activeSkills.map(skill => skill.id));

  if (!task && skillIds.has('builtin_summarise')) task = 'Summarize the current page';
  if (!task && skillIds.has('builtin_web_scraper')) task = 'Scrape the current page';
  if (!task) return;

  appendUserBubble(task);

  if (skillIds.has('builtin_summarise')) {
    agentBlockEl = appendAgentBlock();
    currentRunKind = 'agent';
    setRunning(true);
    if (taskInput) { taskInput.value = ''; taskInput.style.height = ''; }
    chrome.runtime.sendMessage({ type: 'SUMMARIZE_PAGE', task }, resp => {
      if (resp && !resp.ok) {
        addStep('error', `❌ ${resp.error || 'Failed to summarize'}`);
        setRunning(false);
      }
    });
    return;
  }

  if (skillIds.has('builtin_web_scraper')) {
    agentBlockEl = appendAgentBlock();
    currentRunKind = 'agent';
    setRunning(true);
    if (taskInput) { taskInput.value = ''; taskInput.style.height = ''; }
    const formats = [
      $('scrapeFormatJson')?.checked ? 'json' : '',
      $('scrapeFormatCsv')?.checked ? 'csv' : '',
      $('scrapeFormatTxt')?.checked ? 'txt' : '',
    ].filter(Boolean);
    chrome.runtime.sendMessage({
      type: 'SCRAPE_PAGE',
      task,
      formats: formats.length ? formats : ['json'],
      autoExport: $('scrapeAutoExportInput')?.checked !== false,
    }, resp => {
      if (resp && !resp.ok) {
        addStep('error', `❌ ${resp.error || 'Failed to scrape page'}`);
        setRunning(false);
      }
    });
    return;
  }

  if (activeSkills.length && agentBlockEl === null) {
    agentBlockEl = appendAgentBlock();
    const pillsHtml = activeSkills.map(s => `<span class="active-skill-pill">${esc(s.name)}</span>`).join(' ');
    const info = document.createElement('div');
    info.style.cssText = 'font-size:12px;color:var(--tx3);display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:2px 0';
    info.innerHTML = `<span>Skills active:</span>${pillsHtml}`;
    agentBlockEl.appendChild(info);
  } else {
    agentBlockEl = appendAgentBlock();
  }

  currentRunKind = 'agent';
  setRunning(true);
  if (taskInput) { taskInput.value = ''; taskInput.style.height = ''; }

  chrome.runtime.sendMessage({
    type: inputTab === 'deep_research' ? 'DEEP_RESEARCH' : 'START_AGENT',
    task,
    mode:   currentMode,
    skills: activeSkills,
    sessionId: currentSessionId,
  }, resp => {
    if (resp && !resp.ok) {
      addStep('error', `❌ ${resp.error || 'Failed to start'}`);
      setRunning(false);
    }
  });
}

// Replace existing click handlers with skills-aware version
const sendBtnEl = $('sendBtn');
if (sendBtnEl) {
  // Remove existing listeners by cloning
  const newSendBtn = sendBtnEl.cloneNode(true);
  sendBtnEl.parentNode?.replaceChild(newSendBtn, sendBtnEl);
  sendBtn = newSendBtn;
  newSendBtn.addEventListener('click', submitComposer);
}

// ── Init skills on load ────────────────────────────────────────────────────────
loadSkills(); // pre-warm the cache so getActiveSkillsForAgent() works immediately


// ── Eye-toggle for API key inputs (replaces inline onclick — CSP safe) ─────────
document.addEventListener('click', e => {
  const btn = e.target.closest('.ai-eye-btn');
  if (!btn) return;
  const wrap = btn.closest('.ai-input-wrap');
  if (!wrap) return;
  const input = wrap.querySelector('.ai-input');
  if (!input) return;
  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  // Swap icon: closed eye ↔ open eye
  btn.innerHTML = isHidden
    ? `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
         <path d="M1.5 7S3.5 3.5 7 3.5 12.5 7 12.5 7 10.5 10.5 7 10.5 1.5 7 1.5 7z"/>
         <circle cx="7" cy="7" r="1.6"/>
         <line x1="2" y1="2" x2="12" y2="12"/>
       </svg>`
    : `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
         <path d="M1.5 7S3.5 3.5 7 3.5 12.5 7 12.5 7 10.5 10.5 7 10.5 1.5 7 1.5 7z"/>
         <circle cx="7" cy="7" r="1.6"/>
       </svg>`;
});

// ── Provider Type Switcher (.ptype-btn) ──────────────────────────────────────────
document.querySelectorAll('.ptype-btn').forEach(tab => {
  tab.addEventListener('click', () => {
    const type = tab.dataset.type;
    document.querySelectorAll('.ptype-btn').forEach(t => t.classList.remove('selected'));
    tab.classList.add('selected');

    document.querySelectorAll('.provider-type-content').forEach(c => { c.style.display = 'none'; });
    const contentMap = { cloud: 'typeContentCloud', custom: 'typeContentCustom', ollama: 'typeContentOllama' };
    const el = $(contentMap[type]);
    if (el) el.style.display = 'block';

    if (type === 'ollama') {
      currentProvider = 'ollama';
      refreshOllamaModels?.({ silent: true });
    } else if (type === 'custom') {
      currentProvider = 'custom';
    } else {
      const sel = document.querySelector('.provider-card.selected');
      currentProvider = sel ? sel.dataset.provider : 'openai';
    }
    renderModelChips?.(currentProvider);
    updateConnectionFields?.(currentProvider);
  });
});

if (validateLicenseBtn) {
  validateLicenseBtn.addEventListener('click', handleValidateLicense);
}
if (requestTrialBtn) {
  requestTrialBtn.addEventListener('click', () => handleLicenseRequest(requestTrialLicense, requestTrialBtn, 'Trial key'));
}
if (requestPremiumBtn) {
  requestPremiumBtn.addEventListener('click', () => handleLicenseRequest(requestPremiumLicense, requestPremiumBtn, 'Premium key'));
}

// ══════════════════════════════════════════════════════════════════════════════
// USAGE DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Formats a raw token count into a human-readable string (e.g., 1.2M, 45k).
 * @param {number} count - The number of tokens.
 * @returns {string} The formatted token string.
 */
function formatTokens(count) {
  if (count >= 1000000) return (count / 1000000).toFixed(2) + 'M';
  if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
  return count.toString();
}

/**
 * Renders the usage dashboard with model-specific token counts and costs.
 * @param {Object|null} overrideUsage - Optional usage data to display.
 */
function renderUsageDashboard(overrideUsage = null) {
  const container = $('usageDashboardList');
  if (!container) return;
  
  const displayTokens = (usage) => {
    if (!usage || Object.keys(usage).length === 0) {
      container.innerHTML = '<div class="history-empty">No usage recorded yet.</div>';
      return;
    }
    
    let totalTokens = 0;
    let totalCost = 0;
    const modelRows = [];
    
    for (const [model, stats] of Object.entries(usage)) {
      if (model === 'total') continue; // In case total is stored
      totalTokens += (stats.totalTokens || 0);
      totalCost += (stats.cost || 0);
      
      const niceModel = esc(model).replace('models/', '');
      modelRows.push(`
        <div style="display:flex; justify-content:space-between; align-items:center; background:var(--bg2); padding:10px 12px; border-radius:6px; border:1px solid var(--border);">
          <div style="font-weight:600; color:var(--text);">${niceModel}</div>
          <div style="display:flex; flex-direction:column; align-items:flex-end;">
             <span style="font-family:monaco,monospace; font-size:12px; color:var(--tx2);">${formatTokens(stats.totalTokens || 0)} tokens</span>
             ${stats.cost > 0 ? `<span style="font-size:11px; color:#5cba89; font-weight:600;">$${stats.cost.toFixed(4)}</span>` : ''}
          </div>
        </div>
      `);
    }
    
    // Header cards for overall totals
    const totalHtml = `
      <div style="display:flex; gap:10px; margin-bottom:12px;">
         <div style="flex:1; background:var(--bg2); border-left:3px solid var(--accent); padding:10px; border-radius:4px;">
            <div style="font-size:11px; color:var(--tx3); text-transform:uppercase; margin-bottom:4px;">Total Tokens</div>
            <div style="font-size:18px; font-weight:700; color:var(--text);">${formatTokens(totalTokens)}</div>
         </div>
         <div style="flex:1; background:var(--bg2); border-left:3px solid #5cba89; padding:10px; border-radius:4px;">
            <div style="font-size:11px; color:var(--tx3); text-transform:uppercase; margin-bottom:4px;">Est. Cost</div>
            <div style="font-size:18px; font-weight:700; color:#5cba89;">$${totalCost.toFixed(4)}</div>
         </div>
      </div>
    `;
    
    container.innerHTML = totalHtml + modelRows.join('');
  };

  if (overrideUsage) {
    displayTokens(overrideUsage);
  } else {
    // FIXME: This storage fetch is asynchronous and might cause race conditions during UI updates.
    chrome.storage.local.get('tokenUsage', res => {
      displayTokens(res.tokenUsage || {});
    });
  }
}

const clearUsageBtn = $('btnClearUsage');
if (clearUsageBtn) {
  clearUsageBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear all usage data?')) {
      chrome.runtime.sendMessage({ type: 'CLEAR_TOKEN_USAGE' });
      renderUsageDashboard({});
    }
  });
}


// ══════════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════════
renderModelChips('openai');
updateComposerState();
renderHistory();
renderUsageDashboard();
loadSettings();
loadStoredLicense();
requestAgentStateHydration({ force: true });



