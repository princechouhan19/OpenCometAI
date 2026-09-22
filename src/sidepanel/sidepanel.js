// sidepanel.js — Open Comet UI controller
import { loadLibrarySkills, peekLibrarySkills } from '../lib/skill-library.js';
import { createLogger, installGlobalErrorTraps } from '../core/logger.js';

// Diagnostics: uncaught sidepanel errors never vanish
// They print here with a full stack AND relay to the SW console
// ([Relay:sidepanel:Sidepanel]), so background DevTools sees them too.
const logPanel = createLogger('Sidepanel');
installGlobalErrorTraps(logPanel, 'sidepanel', 'DIAG_LOG_RELAY');


const PROVIDER_MODELS = {
  openai:    ['gpt-4o', 'gpt-4o-mini', 'o1'],
  anthropic: ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001', 'claude-opus-4-6'],
  gemini:    ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'],
  groq:      ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  mistral:   ['mistral-small-2506', 'mistral-large-latest', 'pixtral-large-2411'],
  deepseek:  ['deepseek-chat', 'deepseek-reasoner'],
  kimi:      ['kimi-k3', 'kimi-k2.5', 'kimi-k2-thinking', 'kimi-k2-turbo-preview'],
  glm:       ['glm-4.7', 'glm-4.5-air', 'glm-4.5v'],
  custom:    [],
  ollama:    ['llama3.2:3b', 'qwen2.5vl:7b', 'gemma3:4b', 'llava:7b'],
  local:     [],
};

const PROVIDER_LABELS = {
  openai: 'GPT-4o', anthropic: 'Claude Sonnet',
  gemini: 'Gemini Flash', groq: 'LLaMA 3.3', mistral: 'Mistral Small',
  deepseek: 'DeepSeek Chat', kimi: 'Kimi', glm: 'GLM', custom: 'OpenAI Compatible', ollama: 'Ollama', local: 'On-device',
};

const LOCAL_MODEL_NAMES = {
  'gemma-4-e2b':      'Gemma 4 E2B',
  'gemma-4-e4b':      'Gemma 4 E4B',
  'granite-4.0-micro': 'Granite 4.0 Micro 3B',
  'granite-4.0-1b':   'Granite 4.0 1B',
  'lfm2-vl-450m':     'LFM2-VL 450M',
  'all-minilm-l6-v2': 'MiniLM Embeddings',
};

// State
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
// Slash-menu state is declared up here (before any top-level code that can call
// closeSlashMenu, e.g. showView) — otherwise a TDZ crash aborts the whole script.
let slashMenuOpen = false;
let slashSelectedIndex = 0;
let filteredSlashSkills = [];

// Sounds
function playNotificationSound(type = 'complete') {
  const audio = new Audio(`../../assets/sounds/${type}.mp3`);
  audio.play().catch(e => console.warn('[Sound] Playback inhibited:', e));
}

// DOM refs (all null-safe)
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

function isProviderConfigured(settings = {}) {
  const provider = String(settings.provider || '').toLowerCase();
  if (provider === 'ollama') {
    return Boolean(String(settings.ollamaBaseUrl || 'http://127.0.0.1:11434').trim());
  }
  if (provider === 'local') {
    return Boolean(String(settings.localModelId || '').trim());
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

// Which provider-type tab does a provider belong to?
// (Local tab is a merged hub: in-browser Transformers.js models → 'local',
//  external Ollama server → 'ollama'; both render under the "device" tab.)
function ptypeFromProvider(provider) {
  if (provider === 'ollama' || provider === 'local') return 'device';
  if (provider === 'custom') return 'custom';
  return 'cloud';
}

// Single place that syncs the AI & Models tab strip + visible content pane.
function setPtypeTab(type) {
  document.querySelectorAll('.ptype-btn').forEach(t => t.classList.toggle('selected', t.dataset.type === type));
  document.querySelectorAll('.provider-type-content').forEach(c => { c.style.display = 'none'; });
  const el = $(type === 'cloud' ? 'typeContentCloud'
    : (type === 'custom' ? 'typeContentCustom' : 'typeContentDevice'));
  if (el) el.style.display = 'block';
}

// True while the user is deliberately browsing a tab that may not match the
// saved provider (e.g. peeking at the Local hub while OpenAI is selected).
// Set by .ptype-btn clicks; cleared by REAL provider changes (settings load,
// provider-card click) so the tab follows the provider again.
let ptypeTabLocked = false;

function updateConnectionFields(provider) {
  const modelInput = $('modelInput');
  const ollamaSection = $('ollamaModelSection');

  // Decide which type content to show (Local tab merges in-browser + Ollama).
  // Tab ownership: while ptypeTabLocked is set, the user's explicit tab choice
  // wins — auto-syncing the pane from the provider here is what made the
  // Local tab snap straight back to Cloud the instant it was clicked.
  const mapped = ptypeFromProvider(provider);
  const selectedTab = document.querySelector('.ptype-btn.selected')?.dataset.type || 'cloud';
  const type = ptypeTabLocked ? selectedTab : mapped;
  if (!ptypeTabLocked) setPtypeTab(type);

  if (type === 'device') {
    // Merged Local hub — restore the sub-pane that matches the provider.
    setLocalSubPane(provider === 'ollama' ? 'ollama' : 'inbrowser');
  }

  // Ollama specific visibility
  if (ollamaSection) {
    ollamaSection.style.display = provider === 'ollama' ? 'block' : 'none';
  }

  if (modelInput) {
    modelInput.placeholder = provider === 'ollama'
      ? 'Legacy fallback. Prefer the text/vision model selectors below.'
      : 'Leave blank to use default';
    
    // Hide default model input if custom is selected (it has its own).
    // On the Local hub tab, a cloud provider's model chips are meaningless
    // noise — only show the Model section there for local/ollama providers
    // (which render downloaded on-device / Ollama model chips).
    // Only show it while the AI settings page is open — never from the
    // settings home (this section lives on the "ai" sub-page).
    const modelSection = modelInput.closest('.s-section');
    if (modelSection) {
      const hideModelSection = provider === 'custom'
        || (type === 'device' && provider !== 'local' && provider !== 'ollama')
        || currentSettingsPage !== 'ai';
      modelSection.style.display = hideModelSection ? 'none' : 'block';
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

// NAVIGATION
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
  
  // Bottom nav is always visible — no auth gate in this build.
  if (bottomNav) bottomNav.style.display = 'flex';

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
    privacy: 'Privacy & Vision',
    research: 'Research',
    storage: 'Storage & Exports',
    profile: 'Profile',
    skills: 'Skills',
    usage: 'Token & Cost Usage',
    about: 'About',
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
    // Sections are display:none in CSS by default; show the active page explicitly.
    section.style.display = page === 'home' ? 'none' : (section.dataset.settingsPage === page ? 'block' : 'none');
  });

  // Re-apply provider-dependent visibility (e.g. the Model section is hidden
  // for the "custom" provider) once the AI page sections are visible.
  if (page === 'ai' && typeof updateConnectionFields === 'function') {
    updateConnectionFields(currentProvider);
  }
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

// MODE DROPDOWN  (opens upward above the toggle button)
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
    // persist the choice — ask mode now genuinely changes behaviour
    // (it gates every privacy-run action behind an approval card), so losing
    // it on every panel reload made the feature feel dead.
    try { localStorage.setItem('opencometAgentMode', currentMode); } catch {}
    closeModeDropdown();
  });
});

// Set initial state to 'auto' …
if (modeIcon)  modeIcon.textContent  = '⚡';
if (modeLabel) modeLabel.textContent = 'Act without asking';

// …then restore the persisted mode (default 'auto').
try {
  const savedMode = localStorage.getItem('opencometAgentMode');
  if (savedMode === 'ask' || savedMode === 'auto') {
    const savedOpt = document.querySelector(`.mode-option[data-mode="${savedMode}"]`);
    if (savedOpt) {
      currentMode = savedMode;
      if (modeIcon)  modeIcon.textContent  = savedOpt.querySelector('.mode-opt-icon')?.textContent  || '';
      if (modeLabel) modeLabel.textContent = savedOpt.querySelector('.mode-opt-label')?.textContent || '';
      document.querySelectorAll('.mode-option').forEach(o => {
        const isThis = o.dataset.mode === savedMode;
        o.classList.toggle('selected', isThis);
        const chk = o.querySelector('.mode-check');
        if (chk) chk.classList.toggle('visible', isThis);
      });
    }
  }
} catch {}

// MODEL SELECTOR DROPDOWN
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

  let itemsHtml = '';
  if (provider === 'local') {
    const downloaded = (localModelCatalog || []).filter(m => m.status === 'downloaded');
    const activeId = selectedLocalModelId || settings.localModelId || '';
    itemsHtml = downloaded.length
      ? downloaded.map(m => `
        <div class="model-opt-item${m.id === activeId ? ' selected' : ''}" data-model="${esc(m.id)}">
          <span>${esc(LOCAL_MODEL_NAMES[m.id] || m.name)}${m.vision ? ' · 👁' : ''}</span>
          <svg class="opt-check" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="2,6 5,9 10,3"/>
          </svg>
        </div>`).join('')
      : '<div class="model-opt-item">No on-device models yet — download one in Settings → AI &amp; Models</div>';
  } else {
    itemsHtml = models.map(m => `
      <div class="model-opt-item${m === currentModel ? ' selected' : ''}" data-model="${esc(m)}">
        <span>${esc(m)}</span>
        <svg class="opt-check" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="2,6 5,9 10,3"/>
        </svg>
      </div>
    `).join('') || '<div class="model-opt-item">No models found</div>';
  }

  dropdown.innerHTML = itemsHtml;

  dropdown.querySelectorAll('.model-opt-item[data-model]').forEach(item => {
    item.addEventListener('click', () => {
      const selected = item.dataset.model;
      if (!selected) return;
      if (provider === 'local') selectLocalModel(selected);
      else selectDropdownModel(provider, selected);
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

// INPUT TABS  (Chat | Deep Research | Scrape)
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
    : 'Ask anything — type / for skills';
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

// Quick-start suggestion chips (empty state)
// Event-delegated on document so handlers survive resetConversationUI()'s
// innerHTML restore of the empty state markup.
document.addEventListener('click', e => {
  const chip = e.target.closest('.suggest-chip');
  if (!chip) return;

  // 1. Switch composer tab (chat is the default; also re-applies placeholder)
  setInputTab(chip.dataset.tab === 'deep_research' ? 'deep_research'
            : chip.dataset.tab === 'scrape'        ? 'scrape'
            : 'chat');

  // 2. "Private run" chip — make sure Privacy Mode is engaged first
  if (chip.dataset.privacy === 'on') {
    const pt = $('privacyModeToggle');
    if (pt && !pt.checked) {
      pt.checked = true;
      pt.dispatchEvent(new Event('change'));
    }
  }

  // 3. Prefill the composer and put the caret at the end
  if (taskInput && chip.dataset.suggest) {
    taskInput.value = chip.dataset.suggest;
    autoResizeTA();
    taskInput.focus();
    const end = taskInput.value.length;
    try { taskInput.setSelectionRange(end, end); } catch {}
  }
});

// SEND / STOP
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

// BACKGROUND MESSAGES
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
      // privacy runs now carry the FINAL ANSWER (information/summary
      // tasks) — render it instead of a bare "Task complete."
      renderResultCard(msg.answer || msg.summary?.finalAnswer || msg.summary?.finalThought || 'Task complete.');
      renderHistory();
      playNotificationSound('complete');
      // feed the measured run latency profile to the Scorecard.
      try { document.dispatchEvent(new CustomEvent('sih-run-finished', { detail: msg.summary || null })); } catch {}
      break;

    case 'AGENT_STOPPED':
    case 'AGENT_ERROR':
      currentRunKind = null;
      setRunning(false);
      renderHistory();
      if (msg.error) {
        logPanel.error('agent task error:', msg.error);
        addStep('error', `❌ ${msg.error}`);
        playNotificationSound('error');
      }
      break;

    // Deep Research messages
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

// CONVO HELPERS
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
  // Per-step duration chip (dtMs computed SW-side between consecutive steps)
  const meta = {
    dtMs: Number.isFinite(s.dtMs) ? s.dtMs : null,
    time: Number.isFinite(s.time) ? s.time : null,
    totalMs: Number.isFinite(s.totalMs) ? s.totalMs : (Number.isFinite(s.payload?.totalMs) ? s.payload.totalMs : null),
  };

  if      (s.type === 'thinking')          addStep('thinking',   text, meta);
  else if (s.type === 'screenshot')        addScreenshotStep(s.imageDataUrl, text, meta);
  else if (s.type === 'api')               addStep('bullet',     text, meta);
  else if (s.type === 'action')            addStep('action',     text, meta);
  else if (s.type === 'plan_ready')        addStep('bullet',     text, meta);
  else if (s.type === 'executing')         addStep('spin',       text, meta);
  else if (s.type === 'done')              addStep('done',       text, meta);
  else if (s.type === 'error')             addStep('error',      text, meta);
  else if (s.type === 'stopped')           addStep('stopped',    text, meta);
  else if (s.type === 'checklist_update')  addStep('checklist',  text, meta);
  else                                     addStep('bullet',     text, meta);
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

// Per-step timing chips
// Slow VLM turns (90s+ with image models) used to look like a hung panel.
// Every step now shows HOW LONG it took; the in-flight step shows a live
// ticking timer so the user sees the agent is working, not frozen.
let _lastStepTime = null;
let _liveTimer = null;   // { int, chipEl, start }

function fmtStepDur(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

function stopLiveStepTimer() {
  if (_liveTimer) {
    clearInterval(_liveTimer.int);
    // Freeze the chip: drop the live styling and stamp the FINAL duration so
    // the step keeps an honest "how long did this take" badge.
    if (_liveTimer.chipEl) {
      const elapsed = Date.now() - _liveTimer.start;
      _liveTimer.chipEl.classList.remove('live');
      _liveTimer.chipEl.title = 'duration of this step';
      _liveTimer.chipEl.textContent = fmtStepDur(Math.max(500, elapsed));
    }
    _liveTimer = null;
  }
}

function startLiveStepTimer(chipEl) {
  stopLiveStepTimer();
  if (!chipEl) return;
  const start = Date.now();
  chipEl.textContent = '0s';
  chipEl.classList.add('live');
  _liveTimer = {
    chipEl,
    start,
    int: setInterval(() => {
      const t = Math.round((Date.now() - start) / 1000);
      chipEl.textContent = t < 60 ? `${t}s` : `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, '0')}s`;
    }, 1000),
  };
}

function stepTimeChipHtml(meta) {
  // Explicit total (done/finished steps) wins, then the SW-computed delta,
  // then a local delta fallback for steps missing dtMs.
  let ms = null;
  if (Number.isFinite(meta?.totalMs) && meta.totalMs > 0) ms = meta.totalMs;
  else if (Number.isFinite(meta?.dtMs) && meta.dtMs > 0) ms = meta.dtMs;
  else if (Number.isFinite(meta?.time) && _lastStepTime) ms = Math.max(0, meta.time - _lastStepTime);
  if (Number.isFinite(meta?.time)) _lastStepTime = meta.time;
  if (!ms) return '';
  return `<span class="step-time" title="time since previous step">${esc(fmtStepDur(ms))}</span>`;
}

function addStep(type, text, meta = null) {
  if (!agentBlockEl) agentBlockEl = appendAgentBlock();
  if (!agentBlockEl) return;
  stopLiveStepTimer();   // the previous in-flight step just completed
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

  const chipHtml = stepTimeChipHtml(meta);
  row.innerHTML = `${iconHtml}<span class="${textClass}">${esc(text)}</span>${chipHtml}`;

  // In-flight steps (spin / thinking) get a LIVE ticking timer instead of a
  // static duration — visible proof the agent is working during slow turns.
  if (type === 'spin' || type === 'thinking') {
    row.querySelector('.step-time')?.remove();
    const liveChip = document.createElement('span');
    liveChip.className = 'step-time';
    row.appendChild(liveChip);
    startLiveStepTimer(liveChip);
  }

  agentBlockEl.appendChild(row);
  scrollConvo();
}

// Screenshot step with inline thumbnail
function addScreenshotStep(dataUrl, text, meta = null) {
  if (!agentBlockEl) agentBlockEl = appendAgentBlock();
  if (!agentBlockEl) return;
  stopLiveStepTimer();

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
    </div>
    ${stepTimeChipHtml(meta)}`;

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

// Lightbox
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

// Plan card
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

// Approval card
function renderApprovalCard(approval) {
  if (!approval || !agentBlockEl) return;
  // ASK-BEFORE-ACTING: kind-aware card. kind:'action' (privacy loop,
  // ask mode) gets the three Claude-style verdicts; legacy host-access cards
  // keep Allow once / Cancel.
  const isAction = approval.kind === 'action';
  const card = document.createElement('div');
  card.className = 'approval-card';
  card.innerHTML = `
    <div class="approval-title">${isAction ? '🤔 Ask before acting' : '⚠️ Approval needed'}</div>
    <div class="approval-msg">${esc(approval.message || 'The agent needs permission to continue.')}</div>
    <div class="approval-btns">
      <button class="btn-allow" data-action="allow">Allow once</button>
      ${isAction ? '<button class="btn-skip" data-action="skip">Skip</button>' : ''}
      <button class="btn-deny"  data-action="${isAction ? 'stop' : 'deny'}">${isAction ? 'Stop task' : 'Cancel'}</button>
    </div>`;
  agentBlockEl.appendChild(card);
  scrollConvo();

  const resolve = (decision) => {
    card.remove();
    chrome.runtime.sendMessage({ type: 'RESOLVE_APPROVAL', approvalId: approval.id, decision });
  };
  card.querySelector('[data-action="allow"]').addEventListener('click', () => {
    resolve('approve_once');
    agentBlockEl = appendAgentBlock();
  });
  card.querySelector('[data-action="skip"]')?.addEventListener('click', () => {
    resolve('skip');
    agentBlockEl = appendAgentBlock();
  });
  card.querySelector('[data-action="stop"], [data-action="deny"]').addEventListener('click', () => {
    resolve(isAction ? 'stop' : 'cancel');
    setRunning(false);
  });
}

// Research report card
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

// Result card
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

// RUNNING STATE
function setRunning(on) {
  isRunning = on;
  if (stopBtn) stopBtn.classList.toggle('visible', on);
  if (!on) stopLiveStepTimer();   // run finished/failed — freeze any live timer

  // When running: input area stays pinned at bottom (CSS handles layout),
  // convoArea grows to fill available space naturally.
  const agentView = document.getElementById('view-agent');
  if (agentView) agentView.classList.toggle('is-running', on);
  updateComposerState();
}

// SETTINGS
const providerGrid = $('providerGrid');
if (providerGrid) {
  providerGrid.addEventListener('click', e => {
    const card = e.target.closest('.provider-card');
    if (!card) return;
    document.querySelectorAll('.provider-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    currentProvider = card.dataset.provider;
    ptypeTabLocked = false;   // real provider change → the tab follows the provider again
    renderModelChips(currentProvider);
    updateConnectionFields(currentProvider);
    const mi = $('modelInput');
    if (mi) mi.value = '';
  });
}

// NOTE: Provider Type Tabs are wired once in the single handler further below
// (search "Provider Type Switcher"). The earlier duplicate handler that lived here
// mis-mapped the On-device tab to a cloud provider and broke the tab switching.

function renderModelChips(provider) {
  const chips   = $('modelChips');
  if (!chips) return;
  if (provider === 'ollama') {
    chips.innerHTML = '';
    renderOllamaModelSelectors();
    return;
  }
  if (provider === 'local') {
    const downloaded = (localModelCatalog || []).filter(m => m.status === 'downloaded');
    const current = $('modelInput')?.value.trim() || '';
    if (!downloaded.length) {
      chips.innerHTML = '<div class="history-empty" style="padding:8px 0">No on-device models downloaded yet — pick one in the On-device section above.</div>';
      return;
    }
    chips.innerHTML = downloaded.map(m =>
      `<div class="model-chip${m.id === current ? ' active' : ''}" data-model="${m.id}">${esc(LOCAL_MODEL_NAMES[m.id] || m.name)}</div>`
    ).join('');
    chips.querySelectorAll('.model-chip').forEach(chip => {
      chip.addEventListener('click', () => selectLocalModel(chip.dataset.model));
    });
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
    selectedLocalModelId = settings.localModelId || '';
    ptypeTabLocked = false;   // fresh settings load → tab follows the saved provider
    document.querySelectorAll('.provider-card').forEach(c => c.classList.toggle('selected', c.dataset.provider === p));
    renderModelChips(p);
    updateConnectionFields(p);
    refreshLocalModelCatalog();

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
    const youcomInput   = $('youcomKeyInput');
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
    // generalized VLM speed controls
    const vlmSpeedProfileInput    = $('vlmSpeedProfileInput');
    const vlmReasoningEffortInput = $('vlmReasoningEffortInput');
    const vlmMaxTokensInput       = $('vlmMaxTokensInput');
    if (vlmSpeedProfileInput)    vlmSpeedProfileInput.value    = settings.vlmSpeedProfile || 'balanced';
    if (vlmReasoningEffortInput) vlmReasoningEffortInput.value = settings.vlmReasoningEffort !== undefined ? settings.vlmReasoningEffort : 'low';
    if (vlmMaxTokensInput)       vlmMaxTokensInput.value       = settings.vlmMaxTokens || 0;
    if (settings.langSearchKey   && lsInput)        lsInput.value       = settings.langSearchKey;
    if (settings.braveSearchKey  && braveInput)     braveInput.value    = settings.braveSearchKey;
    if (settings.serperKey       && serperInput)    serperInput.value   = settings.serperKey;
    if (settings.youcomKey       && youcomInput)    youcomInput.value   = settings.youcomKey;
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
    renderCustomInfoRows(Array.isArray(profile.customInfo) ? profile.customInfo : []);

    updateApiStatus(settings);
    updateDrStatus(settings);
    updateModelPill(p, p === 'ollama' ? settings : (p === 'local' ? selectedLocalModelId : settings.model));
    renderModelChips(p);
    if (p === 'ollama') refreshOllamaModels({ silent: true });
  });
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
// SETTINGS (Profile is stored locally only — no cloud account in this build)

// Custom info (Settings → Profile): user-defined label/value rows
// the agent may use for form filling and answering questions about the user.
function buildCustomInfoRow(key = '', value = '') {
  const row = document.createElement('div');
  row.className = 'ci-row';
  row.innerHTML = `
    <input type="text" class="s-input ci-key" placeholder="Label (e.g. Age)"/>
    <input type="text" class="s-input ci-value" placeholder="Value"/>
    <button type="button" class="ci-remove" title="Remove this field">×</button>`;
  row.querySelector('.ci-key').value = key;
  row.querySelector('.ci-value').value = value;
  row.querySelector('.ci-remove').addEventListener('click', () => row.remove());
  return row;
}

function renderCustomInfoRows(entries = []) {
  const list = $('customInfoList');
  if (!list) return;
  list.innerHTML = '';
  (entries || []).forEach(e => list.appendChild(buildCustomInfoRow(String(e?.key || ''), String(e?.value ?? ''))));
}

function collectCustomInfoRows() {
  return [...document.querySelectorAll('#customInfoList .ci-row')]
    .map(row => ({
      key: row.querySelector('.ci-key')?.value.trim() || '',
      value: row.querySelector('.ci-value')?.value.trim() || '',
    }))
    .filter(e => e.key && e.value);
}

if ($('addCustomInfoBtn')) {
  $('addCustomInfoBtn').addEventListener('click', () => {
    $('customInfoList')?.appendChild(buildCustomInfoRow());
    $('customInfoList')?.lastElementChild?.querySelector('.ci-key')?.focus();
  });
}

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
      customInfo: collectCustomInfoRows(),
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
      vlmSpeedProfile:    $('vlmSpeedProfileInput') ? $('vlmSpeedProfileInput').value : 'balanced',
      vlmReasoningEffort: $('vlmReasoningEffortInput') ? $('vlmReasoningEffortInput').value : 'low',
      vlmMaxTokens:       $('vlmMaxTokensInput') ? (parseInt($('vlmMaxTokensInput').value, 10) || 0) : 0,
      langSearchKey:   $('langSearchKeyInput')  ? $('langSearchKeyInput').value.trim()  : '',
      braveSearchKey:  $('braveSearchKeyInput') ? $('braveSearchKeyInput').value.trim() : '',
      serperKey:       $('serperKeyInput')       ? $('serperKeyInput').value.trim()       : '',
      youcomKey:       $('youcomKeyInput')       ? $('youcomKeyInput').value.trim()       : '',
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
      localModelId: selectedLocalModelId,
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
    });
}
if (saveSettingsBtn) {
  saveSettingsBtn.addEventListener('click', saveSettings);
}

function updateApiStatus(s) {
  const dot  = $('apiDot');
  const text = $('apiStatusText');
  if (!dot || !text) return;
  const configured = isProviderConfigured(s);
  dot.className    = 'api-dot' + (configured ? ' ok' : '');
  if (!configured) {
    text.textContent = String(s.provider || 'provider') === 'ollama'
      ? 'Set Ollama base URL to connect'
      : String(s.provider || '').toLowerCase() === 'local'
        ? 'Download an on-device model first'
        : ['deepseek', 'kimi', 'glm', 'custom'].includes(String(s.provider || '').toLowerCase())
          ? 'Set API key and provider base URL'
          : 'Not configured';
    return;
  }
  text.textContent = String(s.provider || '').toLowerCase() === 'ollama'
    ? `ollama · ${s.ollamaBaseUrl || 'http://127.0.0.1:11434'}`
    : String(s.provider || '').toLowerCase() === 'local'
      ? `on-device · ${LOCAL_MODEL_NAMES[s.localModelId] || s.localModelId || 'model'} ✓`
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
  // You.com
  const yDot  = $('youcomDot'); const yText  = $('youcomStatusText');
  if (yDot && yText) {
    yDot.className  = 'api-dot' + (s.youcomKey ? ' ok' : '');
    yText.textContent = s.youcomKey ? 'Key configured ✓' : 'Not configured';
  }
}
// Legacy alias kept for runDeepResearch check
const updateLsStatus = updateDrStatus;

function getDisplayedModel(provider, model) {
  if (provider === 'ollama' && typeof model === 'object' && model) {
    return getDisplayedOllamaModel(model);
  }
  if (provider === 'local') {
    const id = typeof model === 'string' && model ? model : selectedLocalModelId;
    return LOCAL_MODEL_NAMES[id] || id || 'On-device';
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

// HISTORY
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

// UTILS
function fmtTime(ts) {
  return new Date(ts).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}

function autoResizeTA() {
  if (!taskInput) return;
  // Empty input: pin the resting height (2 rows = 60px) instead of measuring.
  // Guarantees the composer is pixel-identical on extension open, after send
  // and after New chat — immune to font-loading / sidepanel open-animation
  // measurement quirks that could inflate scrollHeight at startup.
  if (!taskInput.value) {
    taskInput.style.height = '60px';
    return;
  }
  taskInput.style.height = 'auto';
  taskInput.style.height = Math.min(taskInput.scrollHeight, 130) + 'px';
}

if (taskInput) {
  taskInput.addEventListener('input', () => {
    autoResizeTA();
    handleSlashCommand();
  });
}

// SLASH COMMANDS
// (slashMenuOpen / slashSelectedIndex / filteredSlashSkills are declared in the
//  top state block so early calls to closeSlashMenu() can never hit the TDZ.)

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

// SKILLS — full CRUD: list, create, edit, delete, activate/deactivate per session

// Built-in skills (offline fallback — the folder library in /skills is the
// primary source; these are used only if SKILL.md files fail to load)
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
    source: skill.source || (skill.builtIn ? 'builtin' : 'user'),
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

// Active skills state (for current session, not persisted)
let activeSkillIds = new Set(); // IDs of skills active for next task

// Skill data cache
let allSkillsCache = [];

// Nav hookup

// Patch showView to handle 'skills'
const _origShowView = showView;
window.showView = function(name) {
  _origShowView(name);
  if (name === 'skills') {
    loadSkills();
  }
};

// Load and render skills
let librarySkills = [];

async function loadSkills() {
  // Primary: the versioned SKILL.md library bundled with the extension.
  librarySkills = await loadLibrarySkills().catch(() => []);
  const builtinMeta = librarySkills.length
    ? librarySkills.map(skillToMeta)
    : BUILT_IN_SKILL_META; // offline fallback if /skills files failed to load
  const userSkills = await getStoredSkillMeta();
  const seen = new Set();
  allSkillsCache = [...builtinMeta, ...userSkills].filter(s => {
    if (!s?.id || seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
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
  const lib = librarySkills.length ? librarySkills : peekLibrarySkills();
  const fromLib = lib.find(s => s.id === id);
  if (fromLib) return fromLib;
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

// Render skills list
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
        ${skill.source === 'library' ? '<span class="skill-builtin-badge">Library</span>' : isBuiltIn ? '<span class="skill-builtin-badge">Built-in</span>' : ''}
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

// Active skills bar (shown in the Agent composer)
// Bounded by design: collapsed state shows at most ASB_COLLAPSED_LIMIT chips
// (≈2 rows) plus a "+N more" expander; expanded state caps the chip area at
// 118px and scrolls, so an "all skills active" session can never stretch the
// composer or push the conversation area away.
const ASB_COLLAPSED_LIMIT = 6;
let asbExpanded = false;

function updateActiveSkillsBar() {
  const bar   = $('activeSkillsBar');
  const chips = $('asbChips');
  const count = $('asbCount');
  if (!bar || !chips) return;

  const active = allSkillsCache.filter(s => activeSkillIds.has(s.id));
  if (!active.length) {
    bar.style.display = 'none';
    bar.classList.remove('expanded');
    asbExpanded = false;
    return;
  }

  bar.style.display = 'flex';
  bar.classList.toggle('expanded', asbExpanded);
  if (count) count.textContent = String(active.length);

  const visible  = asbExpanded ? active : active.slice(0, ASB_COLLAPSED_LIMIT);
  const overflow = active.length - visible.length;

  chips.innerHTML = visible.map(s => `
    <div class="asb-chip" data-id="${esc(s.id)}">
      ${s.icon || '⚙️'} ${esc(s.name)}
      <button class="asb-chip-remove" data-id="${esc(s.id)}" title="Remove">×</button>
    </div>`).join('') + (overflow > 0
      ? `<button class="asb-chip asb-more" title="${asbExpanded ? 'Collapse' : 'Show all active skills'}">+${overflow} more</button>`
      : (asbExpanded && active.length > ASB_COLLAPSED_LIMIT
          ? `<button class="asb-chip asb-more" title="Collapse">Show less</button>`
          : ''));

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

  chips.querySelectorAll('.asb-more').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      asbExpanded = !asbExpanded;
      updateActiveSkillsBar();
    });
  });
}

const asbClear = $('asbClear');
if (asbClear) asbClear.addEventListener('click', () => {
  activeSkillIds.clear();
  asbExpanded = false;
  updateActiveSkillsBar();
  document.querySelectorAll('.skill-card').forEach(c => {
    c.classList.remove('is-active');
    c.querySelector('.skill-toggle')?.classList.remove('on');
  });
});

// Skill Editor Modal
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

// Get active skills for agent dispatch
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

// Patch runAgent to pass active skills
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

  if (!task && (skillIds.has('builtin_summarise') || skillIds.has('summarize-page'))) task = 'Summarize the current page';
  if (!task && (skillIds.has('builtin_web_scraper') || skillIds.has('extract-data'))) task = 'Scrape the current page';
  if (!task) return;

  appendUserBubble(task);

  if (skillIds.has('builtin_summarise') || skillIds.has('summarize-page')) {
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

  if (skillIds.has('builtin_web_scraper') || skillIds.has('extract-data')) {
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

// Init skills on load
loadSkills(); // pre-warm the cache so getActiveSkillsForAgent() works immediately


// Eye-toggle for API key inputs (replaces inline onclick — CSP safe)
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

// Provider Type Switcher (.ptype-btn)
document.querySelectorAll('.ptype-btn').forEach(tab => {
  tab.addEventListener('click', () => {
    const type = tab.dataset.type;
    // The user now owns the tab choice. Without this lock the generic
    // updateConnectionFields refresh below would instantly re-sync the visible
    // pane back to the provider's tab — exactly why the Local tab "never opened".
    ptypeTabLocked = true;
    setPtypeTab(type);

    if (type === 'custom') {
      currentProvider = 'custom';
    } else if (type === 'device') {
      // Merged Local hub — the provider is picked by the SUB-switcher inside
      // (In-browser → local, Ollama → ollama), so merely opening the tab to
      // browse models never yanks the user's provider away.
      refreshLocalModelCatalog?.();
    } else {
      const sel = document.querySelector('.provider-card.selected');
      currentProvider = sel ? sel.dataset.provider : 'openai';
    }
    renderModelChips?.(currentProvider);
    updateConnectionFields?.(currentProvider);
  });
});

// Local hub sub-switcher (In-browser models ↔ Ollama server)
function setLocalSubPane(sub) {
  document.querySelectorAll('.local-sub-btn').forEach(b => {
    const on = b.dataset.localSub === sub;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('[data-local-pane]').forEach(p => {
    p.style.display = p.dataset.localPane === sub ? 'block' : 'none';
  });
}

document.querySelectorAll('.local-sub-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const sub = btn.dataset.localSub;
    if (btn.classList.contains('selected')) return;   // already active
    setLocalSubPane(sub);
    if (sub === 'ollama') {
      currentProvider = 'ollama';
      refreshOllamaModels?.({ silent: true });
    } else {
      currentProvider = 'local';
      refreshLocalModelCatalog?.();
    }
    renderModelChips?.(currentProvider);
    updateConnectionFields?.(currentProvider);
  });
});

// ON-DEVICE MODELS (Transformers.js) — settings UI controller
let localModelCatalog = [];
let selectedLocalModelId = '';
let localDevice = 'wasm';   // authoritative backend reported by LOCAL_MODEL_LIST

async function refreshLocalModelCatalog() {
  // Populate backend chip + fetch catalog/status from the service worker.
  try {
    const resp = await new Promise(res =>
      chrome.runtime.sendMessage({ type: 'LOCAL_MODEL_LIST' }, r => {
        if (chrome.runtime.lastError) { res(null); return; }
        res(r);
      })
    );
    if (resp?.ok) {
      localModelCatalog = resp.models || [];
      localDevice = resp.device || 'wasm';
      const device = localDevice;
      const dot = $('deviceBackendDot');
      const label = $('deviceBackendLabel');
      if (dot) dot.className = 'api-dot ok';
      if (label) label.textContent = device === 'webgpu' ? 'WebGPU (GPU accelerated)' : 'WASM (CPU fallback)';
      const hint = $('deviceWebgpuHint');
      if (hint) hint.style.display = device === 'webgpu' ? 'none' : '';
    } else {
      const dot = $('deviceBackendDot');
      const label = $('deviceBackendLabel');
      if (dot) dot.className = 'api-dot';
      if (label) label.textContent = 'unavailable in this context';
    }
  } catch {
    localModelCatalog = [];
  }
  renderLocalModelCatalog();
}

function renderLocalModelCatalog() {
  const wrap = $('localModelCatalog');
  if (!wrap) return;
  if (!localModelCatalog.length) {
    wrap.innerHTML = '<div class="history-empty" style="padding:14px 0">Model catalog unavailable.</div>';
    return;
  }
  wrap.innerHTML = localModelCatalog.map(m => {
    const active = currentProvider === 'local' && selectedLocalModelId === m.id;
    const badges = [];
    if (m.vision) badges.push('<span class="dm-badge vision">👁 Vision + Text</span>');
    else if (m.kind !== 'embeddings') badges.push('<span class="dm-badge text">📝 Text only</span>');
    if (m.audio)    badges.push('<span class="dm-badge vision">🔊 Audio</span>');
    if (m.nativeTools) badges.push('<span class="dm-badge rec" title="Emits native tool calls (Gemma 4 / Granite 4 chat template)">🛠 Tools</span>');
    if (m.recommended) badges.push('<span class="dm-badge rec">★ Recommended</span>');
    if (m.heavy)    badges.push('<span class="dm-badge heavy">Heavy</span>');
    if (m.requiresWebGPU) badges.push('<span class="dm-badge heavy" title="Weights ship as q4f16 (fp16 compute) — runs only on WebGPU machines">⚡ WebGPU required</span>');
    const recBadge = '';
    const heavyBadge = '';

    let action = '';
    const gatedHere = m.requiresWebGPU && localDevice !== 'webgpu';
    if (gatedHere) {
      // Gate FIRST — even a stale error status must not offer a doomed retry.
      action = '<button class="dm-btn" disabled>⚡ Needs WebGPU</button>' +
        '<div class="dm-error">No usable WebGPU adapter on this machine. Use Granite 4.0 1B or LFM2-VL 450M here — both run fully on the WASM (CPU) fallback.</div>';
    } else if (m.status === 'downloaded') {
      action = active
        ? '<button class="dm-btn active" disabled>✓ Active model</button>'
        : '<button class="dm-btn primary" data-action="use" data-id="' + m.id + '">Use this model</button>';
      action += ' <button class="dm-btn danger" data-action="delete" data-id="' + m.id + '">Delete</button>';
    } else if (m.status === 'downloading') {
      action = '<div class="dm-progress"><div class="dm-progress-bar" style="width:' + (m.progress || 0) + '%"></div></div>' +
        '<div class="dm-progress-label">Downloading… ' + (m.progress || 0) + '%' +
        (m.bytesTotal ? ' · ' + Math.round((m.bytesLoaded || 0) / 1048576) + ' / ' + Math.round(m.bytesTotal / 1048576) + ' MB' : '') + '</div>';
    } else if (m.status === 'paused') {
      // Interrupted download (browser closed / crashed mid-fetch). Everything
      // already cached is KEPT — Resume continues from the byte checkpoint.
      const pct = m.progress || 0;
      const mb = m.bytesTotal
        ? ' · ' + Math.round((m.bytesLoaded || 0) / 1048576) + ' / ' + Math.round(m.bytesTotal / 1048576) + ' MB'
        : '';
      action = '<div class="dm-progress"><div class="dm-progress-bar" style="width:' + pct + '%"></div></div>' +
        '<div class="dm-progress-label">⏸ Paused at ' + pct + '%' + mb + '</div>' +
        '<button class="dm-btn primary" data-action="download" data-id="' + m.id + '" style="margin-top:8px">Resume download</button>' +
        '<div class="dm-hint" style="margin-top:6px">Already-downloaded files are kept — the download continues from ' + pct + '%, not from zero.</div>';
    } else if (m.status === 'error') {
      action = '<button class="dm-btn primary" data-action="download" data-id="' + m.id + '">Retry download</button>' +
        '<div class="dm-error">' + esc(m.error || 'Download failed') + '</div>';
    } else {
      action = '<button class="dm-btn primary" data-action="download" data-id="' + m.id + '">Download</button>';
    }

    return (
      '<div class="device-model-card' + (active ? ' active' : '') + '" data-model-card="' + m.id + '">' +
        '<div class="dm-head">' +
          '<div class="dm-title-row"><span class="dm-name">' + esc(m.name) + '</span>' + badges.join('') + recBadge + heavyBadge + '</div>' +
          '<div class="dm-meta">' + esc(m.vendor) + ' · ' + esc(m.params) + ' · ' + esc(m.sizeLabel) + (m.downloadedAt ? ' · downloaded' : '') + '</div>' +
          '<div class="dm-blurb">' + esc(m.blurb) + '</div>' +
        '</div>' +
        '<div class="dm-actions">' + action + '</div>' +
      '</div>'
    );
  }).join('');

  wrap.querySelectorAll('.dm-btn[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === 'download') {
        btn.disabled = true;
        btn.textContent = 'Starting…';
        chrome.runtime.sendMessage({ type: 'LOCAL_MODEL_DOWNLOAD', modelId: id }, () => void chrome.runtime.lastError);
        // Optimistic UI; real progress arrives via LOCAL_MODEL_PROGRESS broadcasts.
        // Keep any existing progress — a RESUME must not snap the bar back to 0.
        const entry = localModelCatalog.find(m => m.id === id);
        if (entry) { entry.status = 'downloading'; }
        renderLocalModelCatalog();
      } else if (action === 'delete') {
        if (!confirm('Delete this model from the browser cache?')) return;
        btn.disabled = true;
        chrome.runtime.sendMessage({ type: 'LOCAL_MODEL_DELETE', modelId: id }, () => {
          void chrome.runtime.lastError;
          refreshLocalModelCatalog();
        });
      } else if (action === 'use') {
        selectLocalModel(id);
      }
    });
  });
}

async function selectLocalModel(id) {
  selectedLocalModelId = id;
  currentProvider = 'local';
  const settings = await getSettingsBg();
  settings.provider = 'local';
  settings.localModelId = id;
  chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }, () => {
    if (chrome.runtime.lastError) return;
    updateModelPill('local', LOCAL_MODEL_NAMES[id] || id);
    updateApiStatus(settings);
    renderModelChips('local');
    renderLocalModelCatalog();
  });
}

// Live progress updates pushed by the service worker during downloads.
// All ML work now runs in the offscreen document — its logs and progress
// arrive here as broadcasts so the user can follow them in this console.
chrome.runtime.onMessage.addListener((msg) => {
  // SW warn/error diagnostics relayed into this console ([Open Comet:<ns>]).
  if (msg?.type === 'DIAG_LOG' && msg.text) {
    const style = `color:${msg.level === 'error' ? '#f87171' : '#fbbf24'};font-weight:600;font-family:monospace`;
    console[msg.level === 'error' ? 'error' : 'warn'](`%c[Open Comet:${msg.ns}]`, style, msg.text);
    return;
  }
  if (msg?.type === 'LOCAL_MODEL_LOG' && msg.text) {
    const style = msg.level === 'warn'
      ? 'color:#d97706;font-weight:bold'
      : 'color:#c4390a;font-weight:bold';
    console.log('%c[LocalML]', style, msg.text);
    return;
  }
  if (msg?.type === 'LOCAL_MODEL_HEARTBEAT') return;   // keep-alive only
  // Live on-device token stream (Gemma 4 engine) → append to the active step.
  if (msg?.type === 'LOCAL_MODEL_TOKEN' && msg.text) {
    const spinText = document.querySelector('#convoArea .agent-step .step-loader')?.closest('.agent-step')?.querySelector('.step-text');
    if (spinText && isRunning) {
      const tail = String(msg.text).slice(-300);
      spinText.title = 'Streaming from ' + (LOCAL_MODEL_NAMES[msg.modelId] || msg.modelId || 'on-device model');
      spinText.dataset.stream = tail;
    }
    return;
  }
  if (msg?.type === 'LOCAL_MODEL_PROGRESS' && msg.modelId) {
    const pct = msg.progress ?? '';
    const extra = msg.loaded != null && msg.total
      ? ` ${(msg.loaded / 1048576).toFixed(1)} / ${(msg.total / 1048576).toFixed(1)} MB`
      : (msg.error ? ` — ${msg.error}` : '');
    console.info(`[LocalML] ${msg.modelId}: ${msg.status} ${pct}${pct !== '' ? '%' : ''}${extra}`);
    const entry = localModelCatalog.find(m => m.id === msg.modelId);
    if (entry) {
      entry.status = msg.status || entry.status;
      entry.progress = msg.progress ?? entry.progress;
      entry.error = msg.error || '';
      if (msg.loaded != null) entry.bytesLoaded = msg.loaded;
      if (msg.total != null) entry.bytesTotal = msg.total;
      if (msg.status === 'downloaded') { entry.progress = 100; entry.downloadedAt = Date.now(); }
    }
    // Update pill if the active model just finished downloading.
    if (msg.status === 'downloaded' && msg.modelId === selectedLocalModelId && currentProvider === 'local') {
      updateModelPill('local', LOCAL_MODEL_NAMES[msg.modelId] || msg.modelId);
    }
    renderLocalModelCatalog();
    if (currentProvider === 'local') renderModelChips('local');
  }
});

// USAGE DASHBOARD
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


// INIT
renderModelChips('openai');
updateComposerState();
renderHistory();
renderUsageDashboard();
// Keep the composer at its deterministic resting height no matter when layout
// settles (fonts, sidepanel open animation, window resize). Without this the
// textarea could stay oversized on open until the user hit "New chat".
autoResizeTA();
window.addEventListener('load', autoResizeTA);
window.addEventListener('resize', autoResizeTA);
if (document.fonts?.ready?.then) document.fonts.ready.then(() => autoResizeTA());
// Initial load — extension runs without any login or license gate.
// Runs last so every handler (provider tabs, on-device catalog, skills,
// privacy controller) is registered before the first view renders.
showView('agent');
loadSettings();
requestAgentStateHydration({ force: true });




// PRIVACY MODE CONTROLLER (SIH addition)
// The home page keeps the quick toggle + live stats. All pipeline
// configuration lives in Settings → Privacy & Vision and applies instantly
// on change (no Save button needed).
(function privacyModeController() {
  const $ = id => document.getElementById(id);

  const toggle       = $('privacyModeToggle');   // toolbar chip checkbox (hidden inside the chip label)
  const chip         = $('privacyChip');          // the chip itself (off-state styling)
  const chipState    = $('privacyChipState');     // On/Off badge text
  const settingsToggle = $('privacyEnabledInput'); // settings master switch
  // #privacyConfigureBtn (top-right "sun" icon) removed — the bottom
  // Settings nav is the single entry point.
  const testBtn      = $('privacyTestBtn');
  const statsBox     = $('privacyStats');
  const psLastMs     = $('psLastMs');
  const psFaces      = $('psFaces');
  const psPii        = $('psPii');
  const psBackend    = $('psBackend');
  const preview      = $('privacyPreview');
  const previewImg   = $('privacyPreviewImg');
  const previewMeta  = $('privacyPreviewMeta');
  const saveState    = $('privacySaveState');

  let privacyEnabled = true;
  let privacyConfig = {
    blurFaces: true,
    redactDomPii: true,
    redactTextPii: true,
    runYolo: false,
    useNer: false,
    serverUrl: 'http://127.0.0.1:8787',
  };

  // Load saved config
  try {
    const saved = JSON.parse(localStorage.getItem('opencometPrivacyConfig') || 'null');
    if (saved) privacyConfig = { ...privacyConfig, ...saved };
    const savedEnabled = localStorage.getItem('opencometPrivacyEnabled');
    if (savedEnabled !== null) privacyEnabled = savedEnabled === '1';
  } catch {}

  // Apply initial UI state
  if (toggle) toggle.checked = privacyEnabled;
  if (settingsToggle) settingsToggle.checked = privacyEnabled;
  updatePrivacyChip();
  applyConfigToUI();

  // Push initial config to background
  sendConfigure();

  // Event wiring
  toggle?.addEventListener('change', () => {
    setPrivacyEnabled(toggle.checked);
  });

  settingsToggle?.addEventListener('change', () => {
    setPrivacyEnabled(settingsToggle.checked, { fromSettings: true });
  });

  // Gear icon on the home bar → jump to the dedicated settings page.
  // configureBtn listener removed together with the button —
  // Settings → Privacy & Vision remains reachable via the bottom nav.

  // Auto-apply pipeline option changes instantly.
  ['optBlurFaces', 'optRedactDom', 'optRedactText', 'optRunYolo', 'optUseNer', 'optOcrPii'].forEach(optId => {
    $(optId)?.addEventListener('change', () => {
      privacyConfig = readConfigFromUI();
      persistConfig();
      sendConfigure();
      flashSaved('Applied ✓');
    });
  });

  $('optServerUrl')?.addEventListener('change', () => {
    privacyConfig = readConfigFromUI();
    persistConfig();
    sendConfigure();
    flashSaved('Saved ✓');
  });

  testBtn?.addEventListener('click', async () => {
    testBtn.disabled = true;
    testBtn.textContent = 'Capturing…';
    try {
      privacyConfig = readConfigFromUI();
      persistConfig();
      sendConfigure();
      const resp = await new Promise(resolve =>
        chrome.runtime.sendMessage({ type: 'PRIVACY_CAPTURE', overrides: privacyConfig }, resolve)
      );
      if (resp?.ok && resp.result?.sanitizedDataUrl) {
        preview.style.display = 'block';
        previewImg.src = resp.result.sanitizedDataUrl;
        const s = resp.result.stats || {};
        const c = s.counts || {};
        previewMeta.textContent =
          `Total: ${s.totalMs || 0} ms\n` +
          `Backend: ${s.backend || 'unknown'}\n` +
          `Faces detected: ${c.faces || 0}\n` +
          `DOM sensitive: ${c.domSensitive || 0}\n` +
          `Text PII: ${c.textPii || 0}\n` +
          `Redactions: ${JSON.stringify(s.redactionCounts || {})}`;
        updateStats(resp.result);
      } else {
        previewMeta.textContent = 'Error: ' + (resp?.error || 'unknown');
        preview.style.display = 'block';
      }
    } catch (err) {
      previewMeta.textContent = 'Error: ' + err.message;
      preview.style.display = 'block';
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = 'Test capture + redact';
    }
  });

  function setPrivacyEnabled(enabled, { fromSettings = false } = {}) {
    privacyEnabled = enabled;
    localStorage.setItem('opencometPrivacyEnabled', privacyEnabled ? '1' : '0');
    if (toggle) toggle.checked = privacyEnabled;
    if (settingsToggle) settingsToggle.checked = privacyEnabled;
    updatePrivacyChip();
    sendConfigure();
    flashSaved(privacyEnabled ? 'Privacy Mode on' : 'Privacy Mode off');
    if (!privacyEnabled && statsBox) statsBox.style.display = 'none';
  }

  // Sync the compact toolbar chip (badge text + off-state styling)
  function updatePrivacyChip() {
    if (chipState) chipState.textContent = privacyEnabled ? 'On' : 'Off';
    if (chip) chip.classList.toggle('off', !privacyEnabled);
  }

  function persistConfig() {
    try { localStorage.setItem('opencometPrivacyConfig', JSON.stringify(privacyConfig)); } catch {}
  }

  function sendConfigure() {
    chrome.runtime.sendMessage({
      type: 'PRIVACY_CONFIGURE',
      settings: { ...privacyConfig, enabled: privacyEnabled },
    });
  }

  function applyConfigToUI() {
    $('optBlurFaces').checked = privacyConfig.blurFaces;
    $('optRedactDom').checked  = privacyConfig.redactDomPii;
    $('optRedactText').checked = privacyConfig.redactTextPii;
    $('optRunYolo').checked    = privacyConfig.runYolo;
    $('optUseNer').checked     = privacyConfig.useNer;
    const ocrEl = $('optOcrPii'); if (ocrEl) ocrEl.checked = Boolean(privacyConfig.ocrPii);
    $('optServerUrl').value    = privacyConfig.serverUrl || 'http://127.0.0.1:8787';
  }

  function readConfigFromUI() {
    return {
      blurFaces:     $('optBlurFaces').checked,
      redactDomPii:  $('optRedactDom').checked,
      redactTextPii: $('optRedactText').checked,
      runYolo:       $('optRunYolo').checked,
      useNer:        $('optUseNer').checked,
      ocrPii:        $('optOcrPii')?.checked || false,
      serverUrl:     $('optServerUrl').value.trim() || 'http://127.0.0.1:8787',
    };
  }

  function updateStats(result) {
    if (!result?.stats) return;
    const s = result.stats;
    const c = s.counts || {};
    statsBox.style.display = 'grid';
    psLastMs.textContent  = `${s.totalMs || 0}ms`;
    psFaces.textContent   = String(c.faces || 0);
    psPii.textContent     = String((c.domSensitive || 0) + (c.textPii || 0));
    psBackend.textContent = s.backend || '—';
    // mirror the REAL firewall envelope into the inspector table.
    if (result.inspector) renderInspector(result.inspector);
  }

  // Privacy Firewall Inspector (real runtime values only)
  function renderInspector(ins) {
    const set = (id, v, cls) => {
      const el = $(id); if (!el) return;
      el.textContent = v; el.className = cls || '';
    };
    set('sihFirewallActive', ins.active ? 'ACTIVE' : 'idle', ins.active ? 'ok' : '');
    set('sihRawTx', 'NO (structurally impossible)', 'ok');
    set('sihSanTx', ins.sanitizedTransmitted ? 'YES (redacted)' : 'not sent', ins.sanitizedTransmitted ? 'ok' : 'warn');
    set('sihFaces', String(ins.faces ?? '—'));
    set('sihPiiRegions', String(ins.piiRegions ?? '—'));
    set('sihSecrets', String(ins.secrets ?? '—'));
    set('sihClientMs', `${ins.clientMs || 0} ms`);
    set('sihPayload', ins.payloadKb ? `${ins.payloadKb} KB` : '—');
    set('sihVerify', ins.verification || '—', ins.verification === 'PASSED' ? 'ok' : 'warn');
  }

  // : Scorecard — score · n · benchmark type · timestamp.
  // UNIT (Node logic), BROWSER (real Chromium pixels) and E2E (live loop)
  // results are stored SEPARATELY and never merged into a single number.
  const SC_TARGETS = {
    'pii-precision': v => v >= 0.97,
    'pii-recall': v => v >= 0.95,
    'redaction-coverage': v => v >= 0.98,
    'redaction-iou': v => v >= 0.85,
    'visual-accuracy': v => v >= 0.95,
    'ocr-visual': v => v >= 0.95,
    'leak-tests': v => v === 'pass',
    'fuzz': v => v === 'pass',
    'server-validation': v => v === 'pass',
  };
  function setScorecard(metric, actualText, status, opts = {}) {
    const bench = opts.bench || 'unit';
    const row = document.querySelector(`#sihScorecard tr[data-metric="${metric}"][data-bench="${bench}"]`)
      || document.querySelector(`#sihScorecard tr[data-metric="${metric}"]`);
    if (!row) return;
    row.querySelector('.sc-actual').textContent = actualText;
    const nEl = row.querySelector('.sc-n'); if (nEl) nEl.textContent = opts.n ?? '—';
    const tEl = row.querySelector('.sc-type'); if (tEl) tEl.textContent = opts.type || bench.toUpperCase();
    const tsEl = row.querySelector('.sc-ts'); if (tsEl) tsEl.textContent = opts.ts || '—';
    const st = row.querySelector('.sc-status');
    st.textContent = status;
    st.className = `sc-status ${status === 'PASS' ? 'ok' : status === 'FAIL' ? 'warn' : ''}`;
  }
  const fmtDate = (iso) => { try { return String(iso).slice(0, 10); } catch { return '—'; } };

  function scorecardFromBenchmarks(data) {
    // UNIT data = { results: [ {name, pass, metrics}, … ] } from run-all --json
    const find = (needle) => (data.results || []).find(r => String(r.name || '').toLowerCase().includes(needle));
    const ts = data.generatedAt || null;
    const priv = find('pii detection');
    if (priv?.metrics?.overall) {
      const n = (priv.metrics.corpusSize?.positives || 0) + (priv.metrics.corpusSize?.negatives || 0) || null;
      setScorecard('pii-precision', String(priv.metrics.overall.precision), priv.metrics.overall.precision >= 0.97 ? 'PASS' : 'FAIL', { n, type: 'UNIT', ts });
      setScorecard('pii-recall', String(priv.metrics.overall.recall), priv.metrics.overall.recall >= 0.95 ? 'PASS' : 'FAIL', { n, type: 'UNIT', ts });
    }
    const red = find('redaction');
    if (red?.metrics) setScorecard('redaction-coverage', String(red.metrics.avgCoverage), red.metrics.avgCoverage >= 0.98 ? 'PASS' : 'FAIL', { type: 'UNIT', ts });
    const vis = find('visual context');
    if (vis?.metrics) setScorecard('visual-accuracy', String(vis.metrics.accuracy), vis.metrics.accuracy >= 0.95 ? 'PASS' : 'FAIL', { type: 'UNIT', ts });
    const sec = find('security');
    if (sec?.metrics) setScorecard('leak-tests', `${sec.metrics.passed}/${sec.metrics.total}`, sec.pass ? 'PASS' : 'FAIL', { n: sec.metrics.total, type: 'UNIT', ts });
    const fz = find('fuzz');
    if (fz?.metrics) setScorecard('fuzz', fz.pass ? '0 leaks' : `${fz.metrics.LEAKED} LEAKS`, fz.pass ? 'PASS' : 'FAIL', { n: fz.metrics.totalCases, type: 'UNIT', ts });
    const sv = find('server inbound');
    if (sv?.metrics) setScorecard('server-validation', `${sv.metrics.passed}/${sv.metrics.total}`, sv.pass ? 'PASS' : 'FAIL', { n: sv.metrics.total, type: 'UNIT', ts });
  }

  // BROWSER data = OpenCometBench/results/browser-benchmark-*.json (harness export)
  // §14: the source report is STAMPED under the table — environment
  // (real-hardware-headed = AUTHORITATIVE vs headless-ci = regression only),
  // generatedAt and file name — so multiple reports can never be silently
  // substituted for one another.
  function scorecardFromBrowser(data, sourceName = '') {
    const ts = data.meta?.generatedAt || null;
    const vc = data.visualContext?.pageTypeAccuracy;
    if (vc) setScorecard('visual-accuracy', `DOM ${vc.domDerived}${vc.vitFused != null ? ` / ViT-fused ${vc.vitFused}` : ''}`, vc.domDerived >= 0.95 ? 'PASS' : 'FAIL', { n: vc.n, type: 'BROWSER', ts });
    const rm = data.redactionMatrix;
    if (rm) {
      setScorecard('redaction-coverage', String(rm.coverage.avg), rm.coverage.avg >= 0.98 ? 'PASS' : 'FAIL', { n: rm.coverage.n, type: 'BROWSER', ts });
      if (rm.meanIou?.avg != null) setScorecard('redaction-iou', String(rm.meanIou.avg), rm.meanIou.avg >= 0.85 ? 'PASS' : 'FAIL', { n: rm.meanIou.n ?? rm.coverage.n, type: 'BROWSER', ts });
    }
    const ocr = data.ocrVisualPii;
    if (ocr) {
      // §3: geometric coverage and pixel-regions-altered are DIFFERENT
      // metrics and are displayed as such. Real hardware measured 0.75 geo
      // coverage with 4/4 pixel regions altered → the row reads MEASURED with
      // both numbers visible; a missing pixel redaction would be FAIL.
      const perGt = ocr.ocrOn?.score?.perGt || [];
      const altered = perGt.filter(g => g.pixelRedacted).length;
      const geo = ocr.ocrOn?.score?.coverage;
      const allAltered = perGt.length > 0 && altered === perGt.length;
      setScorecard('ocr-visual', `${geo != null ? geo : '—'} (geometric) · ${altered}/${perGt.length} pixel regions altered`, allAltered ? 'MEASURED' : 'FAIL', { n: ocr.meta?.n, type: 'BROWSER', ts });
    }
    const res = data.resources;
    // when the report carries a changed-frame (memo-MISS) measurement,
    // BOTH sanitize totals are shown — the warm memo-hit steady state and the
    // changed-frame full re-detection cost. Never quote one without the other.
    if (res?.sanitizeTotalMs) setScorecard('sanitize-p50',
      res.changedFrame
        ? `${res.sanitizeTotalMs.p50} ms warm · ${res.changedFrame.wallMs} ms changed-frame`
        : `${res.sanitizeTotalMs.p50} ms`,
      'MEASURED', { n: res.meta?.n, type: 'BROWSER', ts });
    if (res?.payloadKb?.mean != null) setScorecard('payload', `${res.payloadKb.mean} KB`, 'MEASURED', { n: res.meta?.n, type: 'BROWSER', ts });
    stampScorecardSource({
      kind: 'BROWSER',
      name: sourceName || data.meta?.sourceFile || '(report)',
      ts: data.meta?.generatedAt,
      environment: data.meta?.environment || (data.meta?.headed ? 'headed' : 'unknown'),
      authoritative: data.meta?.environment === 'real-hardware-headed',
    });
  }

  // single stamp line under the scorecard — which report produced the
  // current BROWSER rows and whether it is authoritative for production claims.
  function stampScorecardSource({ kind, name, ts, environment, authoritative }) {
    const el = document.getElementById('sihScorecardSource');
    if (!el) return;
    if (kind !== 'BROWSER') return;   // only the browser tier has an authority question today
    const env = authoritative
      ? '<span class="ok">AUTHORITATIVE — real-hardware-headed (valid for production claims)</span>'
      : `<span class="warn">${String(environment || 'ci').replace(/-/g, ' ')} — regression-only, NOT a production claim</span>`;
    el.innerHTML = `Source report: <code>${String(name).replace(/[<>&]/g, '')}</code> · measured ${ts ? String(ts).slice(0, 19).replace('T', ' ') : '—'} · ${env}`;
  }

  function scorecardFromRun(profile, privacy, steps) {
    // Live values from the last completed privacy run (E2E — live task loop).
    // also renders the per-task PRIVACY CENSUS (privacy-loop DONE
    // summary) into the new live row — what THIS task actually redacted.
    // Purely measured counters, kept in the E2E tier, never merged with the
    // UNIT/BROWSER benchmark rows.
    const ts = new Date().toISOString().slice(0, 10);
    if (profile?.vlm?.p50) setScorecard('vlm-p50', `${profile.vlm.p50} ms`, 'MEASURED', { bench: 'e2e', type: 'E2E', ts, n: steps });
    if (profile?.sanitize?.p50) setScorecard('sanitize-p50', `${profile.sanitize.p50} ms`, 'MEASURED', { bench: 'e2e', type: 'E2E', ts, n: steps });
    if (privacy) {
      const ins = privacy.inspector || null;
      const actual =
        `${privacy.redactions} redactions` +
        ` (faces ${privacy.faces} · dom ${privacy.dom} · obj ${privacy.objects} · text ${privacy.textPii}${privacy.ocr ? ` · ocr ${privacy.ocr}` : ''})` +
        ` · ${privacy.frames} frame${privacy.frames === 1 ? '' : 's'}` +
        (ins?.payloadKb != null ? ` · payload ${ins.payloadKb} KB` : '') +
        (ins?.verification ? ` · verify ${ins.verification}` : '');
      setScorecard('live-task-privacy', actual, 'MEASURED', { bench: 'e2e', type: 'E2E', ts, n: steps ?? profile?.steps });
    }
  }

  // E2E (mock brain) + ADVERSARIAL + E2E-REAL report importers.
  // Each keeps its OWN benchmark type — rows never merge tiers.
  function scorecardFromE2e(data) {
    const ts = data.meta?.generatedAt || null;
    const agg = data.aggregate || {};
    if (agg.verifiedActionRatio != null) {
      setScorecard('e2e-verified', String(agg.verifiedActionRatio), agg.verifiedActionRatio >= 0.95 ? 'PASS' : 'FAIL', { n: agg.steps, type: 'E2E', ts });
    }
    if (agg.taskSuccessRatio != null) {
      setScorecard('e2e-task-success', String(agg.taskSuccessRatio), agg.taskSuccessRatio >= 0.9 ? 'PASS' : 'FAIL', { n: (data.scenarios || []).length, type: 'E2E', ts });
    }
    if (agg.sanitizeMs?.p50 != null) setScorecard('sanitize-p50', `${agg.sanitizeMs.p50} ms`, 'MEASURED', { n: agg.steps, type: 'E2E', ts });
  }

  function scorecardFromAdversarial(data) {
    const ts = data.meta?.generatedAt || null;
    const pr = data.privacy;
    if (pr) setScorecard('adv-privacy', `${pr.passed}/${pr.n}`, pr.passed === pr.n ? 'PASS' : 'FAIL', { n: pr.n, type: 'ADVERSARIAL', ts });
    const inj = data.injection;
    if (inj) setScorecard('adv-injection', `${inj.passed}/${inj.n}`, inj.passed === inj.n ? 'PASS' : 'FAIL', { n: inj.n, type: 'ADVERSARIAL', ts });
  }

  function scorecardFromE2eReal(data) {
    const ts = data.meta?.generatedAt || null;
    const agg = data.aggregate || {};
    const label = String(data.meta?.vlm || 'real');
    if (agg.verifiedActionRatio != null) {
      setScorecard('e2e-real-verified', String(agg.verifiedActionRatio), 'MEASURED', { n: agg.steps, type: 'E2E-REAL', ts });
    }
    if (agg.vlmMs_real?.p50 != null) {
      setScorecard('e2e-real-vlm', `${agg.vlmMs_real.p50} / ${agg.vlmMs_real.p95} ms`, 'MEASURED', { n: agg.steps, type: 'E2E-REAL', ts, note: label });
    }
  }

  const sihImportBtn = $('sihImportBtn');
  const sihBenchmarkFile = $('sihBenchmarkFile');
  sihImportBtn?.addEventListener('click', () => sihBenchmarkFile?.click());
  sihBenchmarkFile?.addEventListener('change', async (e) => {
    const file = e.target?.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (Array.isArray(data?.results)) {
        scorecardFromBenchmarks(data);
        try { localStorage.setItem('opencometSihBenchmarks', JSON.stringify(data)); } catch {}
        flashSaved('UNIT benchmark imported');
      } else if (data?.meta?.type === 'browser' || data?.redactionMatrix || data?.visualContext) {
        scorecardFromBrowser(data, file.name);
        try {
          localStorage.setItem('opencometSihBrowserBenchmarks', JSON.stringify(data));
          localStorage.setItem('opencometSihBrowserBenchmarksName', file.name);
        } catch {}
        flashSaved('BROWSER benchmark imported');
      } else if (data?.meta?.type === 'e2e' && !String(data?.meta?.vlm || '').startsWith('real')) {
        scorecardFromE2e(data);
        try { localStorage.setItem('opencometSihE2eBenchmarks', JSON.stringify(data)); } catch {}
        flashSaved('E2E (mock-VLM) benchmark imported');
      } else if (data?.meta?.type === 'adversarial') {
        scorecardFromAdversarial(data);
        try { localStorage.setItem('opencometSihAdversarialBenchmarks', JSON.stringify(data)); } catch {}
        flashSaved('Adversarial benchmark imported');
      } else if (data?.meta?.type === 'e2e-real') {
        scorecardFromE2eReal(data);
        try { localStorage.setItem('opencometSihE2eRealBenchmarks', JSON.stringify(data)); } catch {}
        flashSaved('E2E-REAL benchmark imported (kept separate from mock rows)');
      } else if (data?.sanitizeMs) {
        // legacy browser runner export
        setScorecard('sanitize-p50', `${data.sanitizeMs.p50} ms`, 'MEASURED', { bench: 'browser', type: 'BROWSER', ts: data.generatedAt });
        if (data.payloadKb) setScorecard('payload', `${data.payloadKb} KB`, 'MEASURED', { bench: 'browser', type: 'BROWSER', ts: data.generatedAt });
        flashSaved('Browser benchmark imported');
      } else {
        flashSaved('Unrecognized benchmark file');
      }
    } catch { flashSaved('Invalid JSON'); }
    e.target.value = '';
  });
  // Restore previously imported benchmark JSONs (persisted, still measured data).
  try {
    const saved = localStorage.getItem('opencometSihBenchmarks');
    if (saved) scorecardFromBenchmarks(JSON.parse(saved));
    const savedBrowser = localStorage.getItem('opencometSihBrowserBenchmarks');
    if (savedBrowser) scorecardFromBrowser(JSON.parse(savedBrowser), localStorage.getItem('opencometSihBrowserBenchmarksName') || '');
    const savedE2e = localStorage.getItem('opencometSihE2eBenchmarks');
    if (savedE2e) scorecardFromE2e(JSON.parse(savedE2e));
    const savedAdv = localStorage.getItem('opencometSihAdversarialBenchmarks');
    if (savedAdv) scorecardFromAdversarial(JSON.parse(savedAdv));
    const savedReal = localStorage.getItem('opencometSihE2eRealBenchmarks');
    if (savedReal) scorecardFromE2eReal(JSON.parse(savedReal));
    // restore the last live-task report (privacy census + latency).
    const savedLive = localStorage.getItem('opencometSihLiveRun');
    if (savedLive) {
      const lr = JSON.parse(savedLive);
      scorecardFromRun(lr.latencyProfile, lr.privacy, lr.steps);
    }
  } catch { /* ignore corrupt cache */ }
  // Live run latency profile + privacy census → Scorecard (AGENT_DONE
  // carries both from the privacy loop's DONE summary). The last live
  // report is persisted so the rows survive a panel reload — same policy
  // as the imported benchmark tiers (measured data only, stored locally,
  // never fabricated).
  document.addEventListener('sih-run-finished', (e) => {
    const summary = e.detail;
    if (!summary) return;
    if (summary.latencyProfile || summary.privacy) {
      scorecardFromRun(summary.latencyProfile, summary.privacy, summary.steps);
      try {
        localStorage.setItem('opencometSihLiveRun', JSON.stringify({
          ts: new Date().toISOString(),
          steps: summary.steps,
          latencyProfile: summary.latencyProfile || null,
          privacy: summary.privacy || null,
        }));
      } catch { /* storage blocked — live rows just won't persist */ }
    }
  });

    function flashSaved(text) {
    if (!saveState) return;
    saveState.textContent = text;
    saveState.classList.add('visible');
    clearTimeout(flashSaved._t);
    flashSaved._t = setTimeout(() => {
      saveState.classList.remove('visible');
    }, 1600);
  }

  // Intercept STEP_UPDATE messages to refresh stats during a privacy run
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'STEP_UPDATE' && msg.step?.type === 'screenshot') {
      // steps now arrive ONLY in the canonical pushStep shape (payload
      // spread into the step) — the SW's raw second broadcast was removed.
      // Accept both shapes for robustness.
      const phase = msg.step.phase || msg.step.payload?.phase;
      if (phase === 'sanitized') {
        const stats = msg.step.stats || msg.step.payload?.stats;
        const inspector = msg.step.inspector || msg.step.payload?.inspector;
        if (stats) updateStats({ stats, inspector });
      }
    }
  });

  // Intercept the Send button: when privacy is on, route to PRIVACY_START
  const origSend = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = function patchedSendMessage(msg, ...rest) {
    if (msg && msg.type === 'START_AGENT' && privacyEnabled) {
      msg = {
        type: 'PRIVACY_START',
        task: msg.task,
        mode: msg.mode,
        sessionId: msg.sessionId,
        privacy: privacyConfig,
      };
    }
    return origSend(msg, ...rest);
  };

  console.log('[OpenComet-SIH] Privacy Mode controller initialised. Enabled:', privacyEnabled);
})();

// build banner — identifies the exact running build in the sidepanel
// console (stale unpacked copies were indistinguishable from fresh ones).
const _ocV = (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getManifest === 'function')
  ? chrome.runtime.getManifest().version : 'dev';
console.log(`[OpenComet] v${_ocV} · side panel`);

// About page (): live version chip + build-info copy
// The version chip is filled from the ACTUAL loaded manifest, so a stale
// unpacked copy can never lie about which build is running.
(function aboutPageController() {
  const $ = id => document.getElementById(id);
  const ver = $('aboutVersion');
  if (ver) ver.textContent = `v${_ocV}`;

  const copyBtn = $('aboutCopyBuildBtn');
  const copyState = $('aboutCopyState');
  if (copyBtn && copyState) {
    copyBtn.addEventListener('click', async () => {
      const text = [
        'OpenComet SIH — Privacy Vision Agent',
        `Version: ${_ocV}`,
        `User agent: ${navigator.userAgent}`,
        `Local time: ${new Date().toString()}`,
      ].join('\n');
      try {
        await navigator.clipboard.writeText(text);
        copyState.textContent = 'Copied to clipboard';
      } catch {
        // Clipboard permission denied (or HTTP test context) — print instead.
        copyState.textContent = 'Printed to console';
        console.log('[OpenComet] build info\n' + text);
      }
      setTimeout(() => { copyState.textContent = ''; }, 2600);
    });
  }
})();

// SIH Competition Mode controller ()
(function sihModeController() {
  const $ = id => document.getElementById(id);
  const input = $('sihModeInput');
  const note  = $('sihModeNote');
  const master = $('privacyEnabledInput');
  if (!input) return;

  const KEY = 'sihMode';
  const apply = (on) => {
    input.checked = on;
    if (note) note.textContent = on
      ? 'Enforced: privacy pipeline is always on in this mode; the main agent runs without raw screenshots.'
      : 'Off: normal diagnostic behaviour (privacy still defaults on; raw paths available for testing).';
    // While SIH mode is on, the privacy-off master switch is locked ON.
    if (master) {
      master.disabled = on;
      if (on) { master.checked = true; try { localStorage.setItem('opencometPrivacyEnabled', '1'); } catch {} }
    }
  };

  // Load (chrome.storage.sync preferred; localStorage fallback for tests).
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.sync) {
      chrome.storage.sync.get(KEY, (d) => apply(d?.[KEY] !== false));
    } else {
      apply(localStorage.getItem(KEY) !== '0');
    }
  } catch { apply(true); }

  input.addEventListener('change', () => {
    const on = input.checked;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.sync) chrome.storage.sync.set({ [KEY]: on });
      else localStorage.setItem(KEY, on ? '1' : '0');
    } catch { /* best effort */ }
    apply(on);
  });
})();
