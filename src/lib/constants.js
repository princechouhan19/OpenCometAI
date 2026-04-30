// ─────────────────────────────────────────────────────────────────────────────
// src/lib/constants.js
// Shared constants across background, content, and sidepanel.
// ─────────────────────────────────────────────────────────────────────────────

/** Storage keys */
export const STORAGE_KEYS = {
  SETTINGS:   'opencometSettings',
  HISTORY:    'opencometHistory',
  LANGSEARCH: 'opencometLangSearch',
  EXPORTS:    'opencometExports',
  TOKEN_USAGE:'tokenUsage',
  LICENSE:     'opencometLicense',
};

/** Default user settings */
export const DEFAULT_SETTINGS = {
  provider:            'openai',
  apiKey:              '',
  model:               '',
  ollamaBaseUrl:       'http://127.0.0.1:11434',
  providerBaseUrl:     '',
  providerSupportsVision: false,
  ollamaTextModel:     '',
  ollamaVisionModel:   '',
  maxSteps:            25,
  screenshotDelay:     1200,
  permissionMode:      'ask',
  sitePolicyByHost:    {},
  pageVisibilityByHost:{},
  langSearchKey:       '',
  braveSearchKey:      '',
  serperKey:           '',
  tavilyKey:           '',
  deepResearchMode:    'browser',
  deepResearchMaxSites: 6,
  deepResearchMaxQueries: 4,
  deepResearchSearchEngine: 'google',
  deepResearchPreferredHosts: [],
  useSubAgents:        true,
  subAgentConcurrency: 3,
  exportFormat:        'json',
  exportFolder:        'Open Comet Exports',
  exportPrompt:        false,
  exportDiskLabel:     'Default Downloads',
  defaultScrapeFormats:['json', 'csv'],
  autoExportScrapes:   false,
  profileData: {
    fullName: '',
    email:    '',
    phone:    '',
    address:  '',
    company:  '',
    website:  '',
    notes:    '',
  },
};

/** Message types routed between background ↔ sidepanel ↔ content */
export const MSG = {
  // Sidepanel → Background
  START_AGENT:       'START_AGENT',
  STOP_AGENT:        'STOP_AGENT',
  RESET_AGENT_STATE: 'RESET_AGENT_STATE',
  APPROVE_PLAN:      'APPROVE_PLAN',
  REJECT_PLAN:       'REJECT_PLAN',
  RESOLVE_APPROVAL:  'RESOLVE_APPROVAL',
  ADD_USER_NOTE:     'ADD_USER_NOTE',
  SAVE_SETTINGS:     'SAVE_SETTINGS',
  GET_SETTINGS:      'GET_SETTINGS',
  GET_OLLAMA_MODELS: 'GET_OLLAMA_MODELS',
  GET_HISTORY:       'GET_HISTORY',
  CLEAR_HISTORY:     'CLEAR_HISTORY',
  GET_STATE:         'GET_STATE',
  EXPORT_DATA:       'EXPORT_DATA',

  // Deep Research
  DEEP_RESEARCH:        'DEEP_RESEARCH',
  DEEP_RESEARCH_STEP:   'DEEP_RESEARCH_STEP',
  DEEP_RESEARCH_DONE:   'DEEP_RESEARCH_DONE',
  DEEP_RESEARCH_ERROR:  'DEEP_RESEARCH_ERROR',
  SUMMARIZE_PAGE:       'SUMMARIZE_PAGE',
  SUMMARIZE_DONE:       'SUMMARIZE_DONE',
  SUMMARIZE_ERROR:      'SUMMARIZE_ERROR',
  SCRAPE_PAGE:          'SCRAPE_PAGE',
  SCRAPE_STEP:          'SCRAPE_STEP',
  SCRAPE_DONE:          'SCRAPE_DONE',
  SCRAPE_ERROR:         'SCRAPE_ERROR',
  AUTO_SCRAPE:          'AUTO_SCRAPE',
  AUTO_SCRAPE_DONE:     'AUTO_SCRAPE_DONE',
  AUTO_SCRAPE_ERROR:    'AUTO_SCRAPE_ERROR',

  // Background → Sidepanel / Content
  AGENT_STARTED:     'AGENT_STARTED',
  AGENT_DONE:        'AGENT_DONE',
  AGENT_STOPPED:     'AGENT_STOPPED',
  AGENT_ERROR:       'AGENT_ERROR',
  STEP_UPDATE:       'STEP_UPDATE',
  STATE_UPDATE:      'STATE_UPDATE',
  PLAN_READY:        'PLAN_READY',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  CHAT_RESET:        'CHAT_RESET',
  TOKEN_USAGE_UPDATED: 'TOKEN_USAGE_UPDATED',
};

/** Agent status labels broadcast in STATE_UPDATE */
export const STATUS = {
  IDLE:      'IDLE',
  PLANNING:  'PLANNING',
  PAUSED:    'PAUSED',
  EXECUTING: 'EXECUTING',
  ACTING:    'ACTING',
};

/** Step types used in the activity feed */
export const STEP_TYPE = {
  THINKING:          'thinking',
  SCREENSHOT:        'screenshot',
  API:               'api',
  ACTION:            'action',
  PLAN_READY:        'plan_ready',
  EXECUTING:         'executing',
  DONE:              'done',
  STOPPED:           'stopped',
  ERROR:             'error',
  MUTED:             'muted',
  SUCCESS:           'success',
  CHECKLIST_UPDATE:  'checklist_update', // skill checklist item marked complete
};


/** Human-readable labels for protected action categories */
export const PROTECTED_ACTION_LABELS = {
  download:    'download files',
  purchase:    'complete a purchase or checkout',
  account:     'create or modify an account',
  auth:        'submit login, password, OTP, or MFA details',
  permissions: 'change browser or site permissions',
  destructive: 'delete, remove, or otherwise make destructive changes',
};

/** AI provider defaults */
export const PROVIDER_DEFAULTS = {
  openai:    { model: 'gpt-4o',                    label: 'OpenAI' },
  anthropic: { model: 'claude-sonnet-4-20250514',   label: 'Anthropic' },
  gemini:    { model: 'gemini-1.5-flash',           label: 'Google Gemini' },
  groq:      { model: 'llama-3.3-70b-versatile',   label: 'Groq' },
  mistral:   { model: 'mistral-small-2506',         label: 'Mistral' },
  deepseek:  { model: 'deepseek-chat',              label: 'DeepSeek' },
  kimi:      { model: 'kimi-k2.5',                  label: 'Kimi' },
  glm:       { model: 'glm-4.7',                    label: 'GLM' },
  custom:    { model: '',                           label: 'OpenAI Compatible' },
  ollama:    { model: 'llama3.2:3b',                label: 'Ollama' },
};

/** Model options shown per provider in the settings UI */
export const PROVIDER_MODELS = {
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

// ── Skills messages (added in v1.1) ──────────────────────────────────────────
// These are handled entirely in the sidepanel (no background needed for CRUD).
// The background reads skills from agentState.skills during execution.
export const SKILL_MSG = {
  GET_SKILLS:    'GET_SKILLS',
  SAVE_SKILL:    'SAVE_SKILL',
  DELETE_SKILL:  'DELETE_SKILL',
};

/** Approximate pricing per 1 million tokens for cost estimation */
export const MODEL_PRICING = {
  // OpenAI
  'gpt-4o': { prompt: 2.50, completion: 10.00 },
  'gpt-4o-mini': { prompt: 0.15, completion: 0.60 },
  'o1': { prompt: 15.00, completion: 60.00 },
  
  // Anthropic
  'claude-sonnet-4-20250514': { prompt: 3.00, completion: 15.00 },
  'claude-haiku-4-5-20251001': { prompt: 0.25, completion: 1.25 },
  'claude-opus-4-6': { prompt: 15.00, completion: 75.00 },
  
  // Gemini
  'gemini-1.5-flash': { prompt: 0.075, completion: 0.30 },
  'gemini-1.5-pro': { prompt: 1.25, completion: 5.00 },
  'gemini-2.0-flash': { prompt: 0.10, completion: 0.40 },
  
  // DeepSeek
  'deepseek-chat': { prompt: 0.14, completion: 0.28 },
  'deepseek-reasoner': { prompt: 0.55, completion: 2.19 },

  // Groq (assuming standard Llama3 limits, often free but putting market rates)
  'llama-3.3-70b-versatile': { prompt: 0.59, completion: 0.79 },
  'llama-3.1-8b-instant': { prompt: 0.05, completion: 0.08 },
  
  // Mistral
  'mistral-small-2506': { prompt: 0.20, completion: 0.60 },
  'mistral-large-latest': { prompt: 2.00, completion: 6.00 },
  'pixtral-large-2411': { prompt: 2.00, completion: 6.00 },
};

