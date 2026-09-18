// ─────────────────────────────────────────────────────────────────────────────
// src/lib/storage.js
// Thin wrappers around chrome.storage.local.
//
// v1.17.0 STATE GOVERNANCE:
//   • STATE_VERSION — persisted state is stamped; boot-time gating resets
//     state written by a NEWER build (schema this code cannot interpret)
//     and merges/migrates older state. Future-version history entries are
//     dropped on read instead of misrendered.
//   • sanitizeUrlForStorage — URLs persisted to disk (history, exports)
//     have sensitive query/fragment parameters scrubbed, so credentials in
//     links (?token=…, #access_token=…) never touch chrome.storage.
// ─────────────────────────────────────────────────────────────────────────────

import { STORAGE_KEYS, DEFAULT_SETTINGS } from './constants.js';
import { scrubSensitiveUrlParams } from './wire-guard.js';

// v1.17.0 — bump when the persisted schema changes. v2 = stateVersion stamping
// + URL scrubbing introduced (v1 state = anything without a stamp).
export const STATE_VERSION = 2;

/** True when a persisted object is interpretable by THIS build. */
export function isCompatibleState(obj) {
  if (!obj || typeof obj !== 'object') return true;
  const v = obj.stateVersion;
  return typeof v !== 'number' ? true : v <= STATE_VERSION;
}

/**
 * Scrub a URL before it is persisted: sensitive query/fragment values are
 * replaced with [REDACTED:url_param] and basic-auth userinfo is stripped.
 * Non-sensitive URLs pass through unchanged (idempotent).
 */
export function sanitizeUrlForStorage(url) {
  if (typeof url !== 'string' || !url) return url || '';
  let out = scrubSensitiveUrlParams(url);
  // https://user:pass@host → https://host (credentials must never hit disk)
  out = out.replace(/(\w+:\/\/)([^\/\s@]+)@/, '$1');
  return out;
}

/** Sanitize every string field of a persisted record whose key looks like a URL. */
function sanitizeUrlFields(record) {
  if (!record || typeof record !== 'object') return record;
  const out = { ...record };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string' && /url/i.test(k)) out[k] = sanitizeUrlForStorage(v);
  }
  return out;
}

export async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const stored = data[STORAGE_KEYS.SETTINGS] || {};
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    // v1.17.0: settings always read back stamped, so the next save persists it.
    stateVersion: STATE_VERSION,
    profileData: {
      ...(DEFAULT_SETTINGS.profileData || {}),
      ...(stored.profileData || {}),
    },
  };
}

export async function saveSettings(settings) {
  const current = await getSettings();
  const merged = {
    ...current,
    ...(settings || {}),
    // v1.17.0: the stamp is owned by THIS build — never trust a caller's value
    // (a stale or future stamp would trip the boot-time reset gate).
    stateVersion: STATE_VERSION,
    profileData: {
      ...(current.profileData || {}),
      ...((settings || {}).profileData || {}),
    },
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: merged });
}

export async function getHistory() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
  const history = data[STORAGE_KEYS.HISTORY] || [];
  // v1.17.0 obsolete-state gating: entries written by a NEWER schema are
  // dropped on read (this build cannot interpret them) — legacy unstamped
  // entries and same/older versions pass through.
  return history.filter(e => !(e && typeof e === 'object' && typeof e.stateVersion === 'number' && e.stateVersion > STATE_VERSION));
}

export async function appendHistory(entry) {
  const history = await getHistory();
  // v1.17.0: stamped + URL-scrubbed before it touches disk.
  history.unshift({ stateVersion: STATE_VERSION, ...sanitizeUrlFields(entry) });
  if (history.length > 30) history.pop();
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: history });
}

export async function clearHistory() {
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: [] });
}

export async function getExports() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.EXPORTS);
  const exportsList = data[STORAGE_KEYS.EXPORTS] || [];
  return exportsList.filter(e => !(e && typeof e === 'object' && typeof e.stateVersion === 'number' && e.stateVersion > STATE_VERSION));
}

export async function appendExport(entry) {
  const exportsList = await getExports();
  exportsList.unshift({ stateVersion: STATE_VERSION, ...sanitizeUrlFields(entry) });
  if (exportsList.length > 40) exportsList.pop();
  await chrome.storage.local.set({ [STORAGE_KEYS.EXPORTS]: exportsList });
}

export async function initStorage() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  if (!data[STORAGE_KEYS.SETTINGS]) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.SETTINGS]: { ...DEFAULT_SETTINGS, stateVersion: STATE_VERSION },
      [STORAGE_KEYS.HISTORY]:  [],
      [STORAGE_KEYS.EXPORTS]:  [],
      [STORAGE_KEYS.TOKEN_USAGE]: {},
    });
    return;
  }

  const stored = data[STORAGE_KEYS.SETTINGS];

  // v1.17.0 obsolete-state gating: state written by a NEWER build carries a
  // schema this code cannot interpret — reset to defaults rather than act on
  // misread values. Older/unstamped state merges forward (standard migration).
  if (typeof stored.stateVersion === 'number' && stored.stateVersion > STATE_VERSION) {
    console.warn(`[Storage] Settings were written by a newer OpenComet build (state v${stored.stateVersion} > v${STATE_VERSION}). Resetting settings to defaults to avoid misreading newer schema.`);
    await chrome.storage.local.set({
      [STORAGE_KEYS.SETTINGS]: { ...DEFAULT_SETTINGS, stateVersion: STATE_VERSION },
    });
    return;
  }

  const merged = {
    ...DEFAULT_SETTINGS,
    ...stored,
    stateVersion: STATE_VERSION,
    profileData: {
      ...DEFAULT_SETTINGS.profileData,
      ...(stored?.profileData || {}),
    },
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: merged });
}

// ── Skills storage (v1.1) ─────────────────────────────────────────────────────
const SKILLS_KEY = 'opencometSkills';

export async function getStoredSkills() {
  const data = await chrome.storage.local.get(SKILLS_KEY);
  return data[SKILLS_KEY] || [];
}

export async function storeSkill(skill) {
  const skills = await getStoredSkills();
  const idx    = skills.findIndex(s => s.id === skill.id);
  if (idx >= 0) skills[idx] = skill; else skills.unshift(skill);
  await chrome.storage.local.set({ [SKILLS_KEY]: skills });
}

export async function removeSkill(id) {
  const skills = await getStoredSkills();
  await chrome.storage.local.set({ [SKILLS_KEY]: skills.filter(s => s.id !== id) });
}

// ── Token Usage Storage ───────────────────────────────────────────────────────
// v1.16.1 STORAGE WRITE MUTEX: read-modify-write cycles (token usage, model
// statuses) previously ran concurrently — two overlapping completions could
// both read the same base and one increment was lost. A tiny promise-chain
// mutex serializes them. Exported so the SW can serialize its own RMW cycles
// (LOCAL_STATUS_WRITE) with the same primitive.
let _rmwChain = Promise.resolve();
export function serializeStorageWrite(fn) {
  const run = _rmwChain.then(fn, fn);   // run regardless of the previous outcome
  _rmwChain = run.catch(() => {});
  return run;
}

export async function getTokenUsage() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.TOKEN_USAGE);
  return data[STORAGE_KEYS.TOKEN_USAGE] || {};
}

export function recordTokenUsage(model, promptTokens, completionTokens, totalTokens, cost) {
  return serializeStorageWrite(async () => {
    const usage = await getTokenUsage();
    if (!usage[model]) {
      usage[model] = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 };
    }
    usage[model].promptTokens += (promptTokens || 0);
    usage[model].completionTokens += (completionTokens || 0);
    usage[model].totalTokens += (totalTokens || 0);
    usage[model].cost += (cost || 0);

    await chrome.storage.local.set({ [STORAGE_KEYS.TOKEN_USAGE]: usage });
    // Broadcast update so settings UI updates if open
    chrome.runtime.sendMessage({ type: 'TOKEN_USAGE_UPDATED', usage }).catch(() => {});
    return usage;
  });
}

export async function clearTokenUsage() {
  await chrome.storage.local.set({ [STORAGE_KEYS.TOKEN_USAGE]: {} });
}
