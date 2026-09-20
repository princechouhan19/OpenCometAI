// src/lib/skill-library.js
// Folder-based skill library (BrowserOS-style) — loads skills/<id>/SKILL.md
// files bundled with the extension and parses them into the same skill shape
// the rest of the architecture already consumes.
//
// Why a folder library?
//   • Skills become files — reviewable, versionable, hot-editable, shareable.
//   • Frontmatter carries trigger metadata (keywords, hosts, checklist) that
//     feeds skill auto-matching and the prompt-side SKILL LIBRARY block.
//   • Adding a skill = adding a folder + one index.json line. No JS changes.
//
// Loader contract:
//   skills/index.json        → ["summarize-page", …]  (MV3 cannot readdir)
//   skills/<id>/SKILL.md     → YAML frontmatter + markdown body
//
// The parsed object is compatible with lib/skills.js consumers:
//   { id, name, description, category, icon, prompt, allowedHosts,
//     preferredSites, doneChecklist, keywords, tools, builtIn, source }

const LIB_INDEX_URL = 'skills/index.json';
const CACHE_TTL_MS = 60 * 1000; // brief cache; SW lifetime covers a session

/**
 * Resolve a library path against THIS module's URL. Works in every context:
 *  • extension pages / SW: chrome-extension://<id>/src/lib/ → ../../skills/…
 *  • plain http test servers: /src/lib/ → /skills/…
 * (chrome.runtime.getURL would also work in the extension, but import.meta.url
 *  needs no chrome global and behaves identically.)
 */
function libURL(relPath) {
  return new URL(`../../${relPath}`, import.meta.url).href;
}

let _cache = null;
let _cacheAt = 0;
let _inflight = null;

/**
 * Load all library skills. Cached per context; failures degrade to [].
 * @param {{ force?: boolean }} opts
 * @returns {Promise<Object[]>}
 */
export async function loadLibrarySkills(opts = {}) {
  const fresh = _cache && (Date.now() - _cacheAt) < CACHE_TTL_MS;
  if (!opts.force && fresh) return _cache;
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const idxResp = await fetch(libURL(LIB_INDEX_URL));
      if (!idxResp.ok) throw new Error(`index.json ${idxResp.status}`);
      const index = await idxResp.json();
      const ids = (index?.skills || []).filter(s => typeof s === 'string');

      const loaded = await Promise.all(ids.map(async id => {
        try {
          const res = await fetch(libURL(`skills/${id}/SKILL.md`));
          if (!res.ok) throw new Error(`SKILL.md ${res.status}`);
          const raw = await res.text();
          const skill = parseSkillMarkdown(raw, id);
          return skill || null;
        } catch (err) {
          console.warn(`[SkillLibrary] Failed to load "${id}":`, err.message);
          return null;
        }
      }));

      _cache = loaded.filter(Boolean);
      _cacheAt = Date.now();
      return _cache;
    } catch (err) {
      console.warn('[SkillLibrary] Library load failed:', err.message);
      _cache = [];
      _cacheAt = Date.now();
      return _cache;
    } finally {
      _inflight = null;
    }
  })();

  return _inflight;
}

/** Synchronously returns the last successful load (may be empty). */
export function peekLibrarySkills() {
  return _cache || [];
}

/**
 * Parse one SKILL.md document into a skill object.
 * Tolerant YAML-subset frontmatter parser: flat `key: value` pairs,
 * `- item` block lists, and `>-`/`|` folded text is NOT needed (description
 * stays single-line; the markdown body is the long-form instructions).
 */
export function parseSkillMarkdown(raw, fallbackId = '') {
  if (typeof raw !== 'string' || !raw.trim()) return null;

  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw.trim());
  if (!fm) return null;

  const meta = parseFrontmatter(fm[1]);
  const body = fm[2].trim();

  const id = String(meta.id || fallbackId || slug(meta.name) || '').trim();
  if (!id) return null;

  const name = String(meta.name || titleize(id));
  // Description: explicit, else first non-heading line of the body.
  const description = String(meta.description || firstBodyLine(body));

  return {
    id,
    name,
    description,
    category:     String(meta.category || 'Custom'),
    icon:         String(meta.icon || '⚙️').substring(0, 4),
    // The whole markdown body is the executable instruction set — the
    // SYSTEM_PROMPT contract caps skill prompts at 3000 chars.
    prompt:       body.substring(0, 3000),
    allowedHosts:   toList(meta['allowed-hosts'] || meta.allowedHosts),
    preferredSites: toList(meta['preferred-sites'] || meta.preferredSites),
    doneChecklist:  toList(meta['done-checklist'] || meta.doneChecklist),
    keywords:       toList(meta.keywords).map(k => String(k).toLowerCase()),
    tools:          toList(meta.tools),
    builtIn:      true,
    source:       'library',
    createdAt:    0,
  };
}

// Frontmatter parsing

function parseFrontmatter(text) {
  const meta = {};
  let currentKey = null;

  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;

    // List item under the previous key: "  - value"
    const listItem = /^\s+-\s+(.*)$/.exec(line);
    if (listItem && currentKey) {
      const arr = Array.isArray(meta[currentKey]) ? meta[currentKey] : [];
      arr.push(cleanScalar(listItem[1]));
      meta[currentKey] = arr;
      continue;
    }

    // Flat key: value (value may be empty → list follows)
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      currentKey = kv[1];
      const rawVal = kv[2].trim();
      if (!rawVal || rawVal === '>' || rawVal === '>' + '-' || rawVal === '|' || rawVal === '|-') {
        meta[currentKey] = [];
      } else if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
        // Inline array: [a, b, c]
        meta[currentKey] = rawVal.slice(1, -1).split(',').map(cleanScalar).filter(Boolean);
      } else {
        meta[currentKey] = cleanScalar(rawVal);
      }
    }
  }
  return meta;
}

function cleanScalar(v) {
  return String(v ?? '').trim().replace(/^['"]|['"]$/g, '');
}

function toList(v) {
  if (Array.isArray(v)) return v.filter(Boolean).map(x => String(x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) {
    return v.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function slug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function titleize(id) {
  return String(id || '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function firstBodyLine(body) {
  const line = (body || '').split(/\r?\n/).find(l => l.trim() && !l.startsWith('#'));
  return (line || '').replace(/^\*\*(.+?):\*\*\s*/, '').trim().substring(0, 240);
}
