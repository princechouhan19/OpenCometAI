// ─────────────────────────────────────────────────────────────────────────────
// src/lib/storage.js
// Thin wrappers around chrome.storage.local.
// ─────────────────────────────────────────────────────────────────────────────

import { STORAGE_KEYS, DEFAULT_SETTINGS } from './constants.js';

export async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const stored = data[STORAGE_KEYS.SETTINGS] || {};
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
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
    profileData: {
      ...(current.profileData || {}),
      ...((settings || {}).profileData || {}),
    },
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: merged });
}

export async function getHistory() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
  return data[STORAGE_KEYS.HISTORY] || [];
}

export async function appendHistory(entry) {
  const history = await getHistory();
  history.unshift(entry);
  if (history.length > 30) history.pop();
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: history });
}

export async function clearHistory() {
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: [] });
}

export async function getExports() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.EXPORTS);
  return data[STORAGE_KEYS.EXPORTS] || [];
}

export async function appendExport(entry) {
  const exportsList = await getExports();
  exportsList.unshift(entry);
  if (exportsList.length > 40) exportsList.pop();
  await chrome.storage.local.set({ [STORAGE_KEYS.EXPORTS]: exportsList });
}

export async function initStorage() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  if (!data[STORAGE_KEYS.SETTINGS]) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS,
      [STORAGE_KEYS.HISTORY]:  [],
      [STORAGE_KEYS.EXPORTS]:  [],
      [STORAGE_KEYS.TOKEN_USAGE]: {},
    });
    return;
  }

  const merged = {
    ...DEFAULT_SETTINGS,
    ...data[STORAGE_KEYS.SETTINGS],
    profileData: {
      ...DEFAULT_SETTINGS.profileData,
      ...(data[STORAGE_KEYS.SETTINGS]?.profileData || {}),
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
export async function getTokenUsage() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.TOKEN_USAGE);
  return data[STORAGE_KEYS.TOKEN_USAGE] || {};
}

export async function recordTokenUsage(model, promptTokens, completionTokens, totalTokens, cost) {
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
}

export async function clearTokenUsage() {
  await chrome.storage.local.set({ [STORAGE_KEYS.TOKEN_USAGE]: {} });
}
