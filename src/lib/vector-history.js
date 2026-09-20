// src/lib/vector-history.js
// Semantic browsing-history search — adapted from the gemma4-browser-extension
// VectorHistory (their IndexedDB store + MiniLM embeddings + time filtering).
// Lightweight variant: chrome.history supplies recent visits, titles are
// embedded (in-memory cache keyed by url+title) and ranked by cosine
// similarity; graceful keyword fallback when the embeddings model isn't
// available. Runs in the SERVICE WORKER.

import { cosineSimilarity } from './page-rag.js';
// Static import — MV3 service workers forbid dynamic import().
import { embedTextsLocal } from './local-llm.js';

const embedCache = new Map();   // key `${url}|${title}` → vector
const EMBED_CACHE_LIMIT = 400;

function tokenOverlap(query, text) {
  const terms = String(query || '').toLowerCase().split(/\W+/).filter(t => t.length > 2);
  if (!terms.length) return 0;
  const hay = String(text || '').toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits += 1;
  return hits / terms.length;
}

async function embedMany(texts) {
  return embedTextsLocal(texts);
}

/**
 * Search browsing history semantically.
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.maxResults=6]
 * @param {number} [opts.days=30]       time window
 * @param {number} [opts.candidateLimit=120]  how many recent visits to rank
 * @returns {Promise<Array<{title,url,lastVisitTime,score,semantic}>>}
 */
export async function findInHistory(query, { maxResults = 6, days = 30, candidateLimit = 120 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];

  const startTime = Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000;
  let items = [];
  try {
    items = await chrome.history.search({ text: '', startTime, maxResults: candidateLimit });
  } catch {
    return [];
  }
  items = items.filter(it => it?.url && !String(it.url).startsWith('chrome://'));
  if (!items.length) return [];

  // Try semantic ranking (embeddings model may not be downloaded yet).
  let queryVector = null;
  let itemVectors = null;
  try {
    const [qv] = await embedMany([q]);
    queryVector = qv || null;
    if (queryVector) {
      const needEmbed = items.filter(it => it.title);
      const keys = needEmbed.map(it => `${it.url}|${it.title}`);
      const missing = keys
        .map((k, i) => [k, i])
        .filter(([k]) => !embedCache.has(k));
      if (missing.length) {
        const texts = missing.map(([k, i]) => needEmbed[i].title);
        const vectors = await embedMany(texts);
        missing.forEach(([k, i], j) => {
          if (vectors[j]) embedCache.set(k, vectors[j]);
        });
        if (embedCache.size > EMBED_CACHE_LIMIT) {
          for (const k of Array.from(embedCache.keys()).slice(0, embedCache.size - EMBED_CACHE_LIMIT)) {
            embedCache.delete(k);
          }
        }
      }
      itemVectors = needEmbed.map(it => embedCache.get(`${it.url}|${it.title}`) || null);
    }
  } catch {
    queryVector = null;   // embeddings unavailable — keyword fallback
  }

  const scored = items.map((it, i) => {
    let score;
    let semantic = false;
    if (queryVector && itemVectors?.[i]) {
      score = cosineSimilarity(queryVector, itemVectors[i]);
      semantic = true;
    } else {
      score = tokenOverlap(q, `${it.title || ''} ${it.url}`);
    }
    return { title: it.title || it.url, url: it.url, lastVisitTime: it.lastVisitTime, score, semantic };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.filter(s => s.score > 0.05).slice(0, maxResults);
}
