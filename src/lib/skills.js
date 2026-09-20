// src/lib/skills.js
// Skills system — reusable agent behaviours from three sources:
//   1. LIBRARY  — folder-based skills (skills/<id>/SKILL.md, BrowserOS-style),
//                 loaded via skill-library.js. Primary source.
//   2. USER     — chrome.storage.local 'opencometSkills' (created in the UI).
//   3. FALLBACK — tiny offline set, used only if library files fail to load.
//
// Skills are stored in chrome.storage.local under 'opencometSkills'.

import { loadLibrarySkills } from './skill-library.js';

const STORAGE_KEY = 'opencometSkills';

export const SKILL_CATEGORIES = [
  'Research',
  'Shopping',
  'Social',
  'Productivity',
  'Data Extraction',
  'Form Filling',
  'Custom',
];

// Legacy hardcoded skills were superseded by the folder library (skills/*.md).
// Kept as an empty export for API compatibility with older imports.
export const BUILT_IN_SKILLS = [];

// Storage operations

export async function getAllSkills() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const userSkills = data[STORAGE_KEY] || [];
  const library    = await loadLibrarySkills().catch(() => []);
  const fallback   = library.length ? [] : LEGACY_FALLBACK_SKILLS;
  // Dedupe by id — a user skill may intentionally shadow a library skill.
  const seen = new Set();
  const out  = [];
  for (const s of [...fallback, ...library, ...userSkills]) {
    if (!s?.id || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

export async function getUserSkills() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || [];
}

export async function saveSkill(skill) {
  const skills  = await getUserSkills();
  const cleaned = validateAndClean(skill);
  const idx     = skills.findIndex(s => s.id === cleaned.id);
  if (idx >= 0) {
    skills[idx] = cleaned;
  } else {
    skills.unshift(cleaned);
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: skills });
  return cleaned;
}

export async function deleteSkill(id) {
  const skills = await getUserSkills();
  const filtered = skills.filter(s => s.id !== id);
  await chrome.storage.local.set({ [STORAGE_KEY]: filtered });
}

export async function getSkillById(id) {
  const all = await getAllSkills();
  return all.find(s => s.id === id) || null;
}

// Validation & normalisation

export function createNewSkill(partial = {}) {
  return {
    id:            partial.id            || `skill_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    name:          partial.name          || '',
    description:   partial.description  || '',
    category:      partial.category      || 'Custom',
    icon:          partial.icon          || '⚙️',
    prompt:        partial.prompt        || '',
    allowedHosts:  partial.allowedHosts  || [],
    preferredSites:partial.preferredSites|| [],
    doneChecklist: partial.doneChecklist || [],
    keywords:      partial.keywords      || [],
    builtIn:       false,
    source:        'user',
    createdAt:     partial.createdAt     || Date.now(),
  };
}

function validateAndClean(skill) {
  return {
    id:            String(skill.id || `skill_${Date.now()}`),
    name:          String(skill.name || '').trim().substring(0, 80),
    description:   String(skill.description || '').trim().substring(0, 300),
    category:      SKILL_CATEGORIES.includes(skill.category) ? skill.category : 'Custom',
    icon:          String(skill.icon || '⚙️').substring(0, 4),
    prompt:        String(skill.prompt || '').trim().substring(0, 3000),
    allowedHosts:  (skill.allowedHosts || []).map(h => String(h).trim().toLowerCase()).filter(Boolean),
    preferredSites:(skill.preferredSites || []).map(s => String(s).trim()).filter(Boolean),
    doneChecklist: (skill.doneChecklist || []).map(c => String(c).trim()).filter(Boolean),
    keywords:      (skill.keywords || []).map(k => String(k).trim().toLowerCase()).filter(Boolean),
    builtIn:       Boolean(skill.builtIn),
    source:        String(skill.source || 'user'),
    createdAt:     Number(skill.createdAt) || Date.now(),
  };
}

// Clone skills for agent state (removes non-serialisable stuff)
export function cloneSkillsForAgent(skills) {
  return (skills || []).map(s => ({
    id:            s.id,
    name:          s.name,
    prompt:        s.prompt,
    allowedHosts:  s.allowedHosts  || [],
    preferredSites:s.preferredSites|| [],
    doneChecklist: s.doneChecklist || [],
  }));
}

// Minimal offline fallback (the 12-skill folder library is the real set).
const LEGACY_FALLBACK_SKILLS = [
  {
    id: 'summarize-page', name: 'Summarize Page',
    description: 'Summarize the current page (offline fallback).',
    category: 'Research', icon: '📄', builtIn: true, source: 'fallback',
    prompt: 'Summarize the current page from readable text. Topic, 3-7 key points, under 300 words.',
    allowedHosts: [], preferredSites: [],
    doneChecklist: ['Page summarized'], keywords: ['summarize', 'summary', 'tldr'],
  },
  {
    id: 'extract-data', name: 'Extract Data',
    description: 'Extract structured data from the current page (offline fallback).',
    category: 'Data Extraction', icon: '📊', builtIn: true, source: 'fallback',
    prompt: 'Extract the main repeating data on the page into structured JSON rows. No invented values.',
    allowedHosts: [], preferredSites: [],
    doneChecklist: ['Structured rows returned'], keywords: ['extract', 'scrape', 'table', 'contacts'],
  },
];
