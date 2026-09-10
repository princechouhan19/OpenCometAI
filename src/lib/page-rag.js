// ─────────────────────────────────────────────────────────────────────────────
// src/lib/page-rag.js
// Retrieval-Augmented Generation over the CURRENT page — ported from the
// gemma4-browser-extension reference (askWebsite.ts + extractWebsiteParts.ts):
//   content script splits h1-h6/p into sectioned parts with sentence chunks →
//   MiniLM embeddings (mean-pooled, normalised) in the offscreen engine →
//   cosine-similarity top-K → parts carry stable "section-paragraph" IDs the
//   agent can pass to highlight_element to show the user the exact spot.
// Falls back to keyword scoring when the embeddings model is unavailable so
// the tool never hard-fails on low-end devices.
// Runs in the SERVICE WORKER (uses chrome.tabs; vectors come from offscreen).
// ─────────────────────────────────────────────────────────────────────────────

const partsCache = new Map();   // key `${tabId}:${url}` → { parts, at }
const CACHE_TTL = 4 * 60 * 1000;

// Static import — MV3 service workers forbid dynamic import().
import { embedTextsLocal } from './local-llm.js';

export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function keywordScore(query, text) {
  const terms = String(query || '').toLowerCase().split(/\W+/).filter(t => t.length > 2);
  if (!terms.length) return 0;
  const hay = String(text || '').toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits += 1;
  return hits / terms.length;
}

/** Ask the content script for structured page parts. */
async function extractParts(tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: 'OC_EXTRACT_PAGE_PARTS' });
    return Array.isArray(resp?.parts) ? resp.parts : null;
  } catch {
    return null;
  }
}

async function embedWithFallback(sentences) {
  try {
    const vectors = await embedTextsLocal(sentences);
    if (Array.isArray(vectors) && vectors.length === sentences.length) return vectors;
  } catch { /* embeddings model unavailable — keyword fallback below */ }
  return null;
}

/**
 * Ensure the active tab's parts (with embeddings) are loaded.
 * @returns {Promise<Array<{id,tagName,content,sentences,embeddings?}>>}
 */
export async function loadPageParts(tabId, url, { force = false } = {}) {
  const key = `${tabId}:${url}`;
  const cached = partsCache.get(key);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL) return cached.parts;

  const raw = await extractParts(tabId);
  if (!raw || !raw.length) return [];
  const parts = raw.map(p => ({ ...p, embeddings: null }));

  // Embed every sentence of every part (batched inside the engine).
  const allSentences = [];
  for (const part of parts) for (const s of part.sentences || []) allSentences.push(s);
  if (allSentences.length) {
    const vectors = await embedWithFallback(allSentences);
    if (vectors) {
      let idx = 0;
      for (const part of parts) {
        const n = (part.sentences || []).length;
        part.embeddings = vectors.slice(idx, idx + n);
        idx += n;
      }
    }
  }

  partsCache.set(key, { parts, at: Date.now() });
  if (partsCache.size > 8) {
    const oldest = partsCache.keys().next().value;
    partsCache.delete(oldest);
  }
  return parts;
}

/**
 * Semantic search over the current page.
 * @returns {Promise<Array<{id, tagName, content, score}>>}
 */
export async function searchPageParts(tabId, url, query, topK = 3) {
  const parts = await loadPageParts(tabId, url);
  if (!parts.length) return [];

  let queryVector = null;
  try {
    const vecs = await embedTextsLocal([query]);
    queryVector = vecs?.[0] || null;
  } catch { queryVector = null; }

  const scored = parts.map(part => {
    let score = 0;
    if (queryVector && part.embeddings?.length) {
      for (const vec of part.embeddings) {
        score = Math.max(score, cosineSimilarity(queryVector, vec));
      }
    } else {
      score = keywordScore(query, part.content);
    }
    return { id: part.id, tagName: part.tagName, content: part.content, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.filter(s => s.score > 0).slice(0, topK);
}

export function clearPagePartsCache() {
  partsCache.clear();
}

/** Highlight a part ID in the page (delegates to the content script registry). */
export async function highlightPart(tabId, id) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'OC_HIGHLIGHT_PART', id });
    return true;
  } catch {
    return false;
  }
}
