// src/lib/deepsearch.js
// Prompt helpers plus a few browser-research utilities.

import { getHostFromUrl, normalizeHost } from './utils.js';

export async function deepResearch(task, keys, onProgress, callAI, aiSettings) {
  onProgress?.('Preparing browser research...');
  let subQueries = [task];

  try {
    const raw = await callAI(aiSettings, buildDecompositionPrompt(task), null, {});
    if (Array.isArray(raw?.queries) && raw.queries.length) {
      subQueries = raw.queries.map(String).map(v => v.trim()).filter(Boolean).slice(0, 5);
    }
  } catch {
    onProgress?.('Using the original query because decomposition failed.');
  }

  return { subQueries, sources: [], keys };
}

export function buildDecompositionPrompt(task) {
  return `You are a research assistant. Break the following research question into 3-5 focused web-search queries.
Keep each query under 80 characters and make them complementary, not repetitive.

Research question: ${task}

Respond ONLY with valid JSON:
{
  "queries": ["query 1", "query 2", "query 3"]
}`;
}

export function buildSynthesisPrompt(task, subQueries, sources) {
  const sourcesText = (sources || []).slice(0, 20).map((source, index) => {
    const body = String(source.summary || source.snippet || source.text || '').substring(0, 1200);
    return `[${index + 1}] ${source.title || source.url || 'Untitled'}\nURL: ${source.url || ''}\n${body}`;
  }).join('\n\n---\n\n');

  return `You are an expert research analyst. Write a concise but thorough report using only the provided sources.

Research question:
${task}

Sub-queries explored:
${(subQueries || []).map((query, index) => `${index + 1}. ${query}`).join('\n') || '1. Original query'}

Sources:
${sourcesText || 'No sources provided.'}

Instructions:
- Use clear markdown headings.
- Cite sources inline as [1], [2], etc.
- Highlight agreements, disagreements, and notable data points.
- End with a short "Sources" section listing cited references.
- Do not add facts that are not supported by the provided sources.`;
}

export function buildBrowserSourceAnalysisPrompt(task, source, page, index, total) {
  const headings = (page?.headings || []).slice(0, 12).join(' | ');
  const tables = (page?.tables || []).slice(0, 2).map((table, tableIndex) => {
    const rows = (table?.rows || []).slice(0, 5).map(row => row.join(' | ')).join('\n');
    return `Table ${tableIndex + 1}:\n${rows}`;
  }).join('\n\n');

  return `You are a focused research sub-agent.
Read one source page and return structured JSON only.

Main task:
${task}

Source ${index + 1} of ${total}
Title: ${source?.title || page?.title || 'Untitled'}
URL: ${source?.url || page?.url || ''}
Host: ${source?.host || ''}

Headings:
${headings || 'None'}

Page text:
${String(page?.readableText || page?.text || '').substring(0, 7000)}

Tables:
${tables || 'None'}

Respond ONLY with valid JSON:
{
  "summary": "3-6 sentence factual summary",
  "keyPoints": ["point 1", "point 2"],
  "facts": ["fact 1", "fact 2"],
  "entities": ["entity 1", "entity 2"],
  "confidence": "high|medium|low"
}

Rules:
- Use only information present in the page content.
- Do not invent missing details.
- Keep arrays concise and high signal.`;
}

export function buildScrapeExtractionPrompt(goal, page) {
  const tables = (page?.tables || []).slice(0, 3).map((table, tableIndex) => {
    const rows = (table?.rows || []).slice(0, 8).map(row => row.join(' | ')).join('\n');
    return `Table ${tableIndex + 1}:\n${rows}`;
  }).join('\n\n');

  return `You are a data extraction engine.
Turn the page content into a useful structured dataset for the goal below.

Extraction goal:
${goal || 'Extract the most useful structured data from this page.'}

Page title: ${page?.title || ''}
Page URL: ${page?.url || ''}
Headings: ${(page?.headings || []).slice(0, 15).join(' | ') || 'None'}

Page text:
${String(page?.readableText || page?.text || '').substring(0, 9000)}

Tables:
${tables || 'None'}

Respond ONLY with valid JSON:
{
  "title": "short dataset title",
  "summary": "one paragraph",
  "columns": ["Column A", "Column B"],
  "rows": [
    { "Column A": "value", "Column B": "value" }
  ]
}

Rules:
- Prefer repeated entities and concrete facts over prose.
- If there is a natural table on the page, preserve that structure.
- Keep column names short and stable.
- Do not include markdown fences or commentary.`;
}

export function buildSearchUrl(engine, query) {
  const q = encodeURIComponent(String(query || '').trim());
  switch (String(engine || 'google').toLowerCase()) {
    case 'duckduckgo':
      return `https://duckduckgo.com/?q=${q}&ia=web`;
    case 'bing':
      return `https://www.bing.com/search?q=${q}`;
    case 'google':
    default:
      return `https://www.google.com/search?q=${q}`;
  }
}

export function normalizeSiteHints(rawValue) {
  if (!rawValue) return [];
  if (Array.isArray(rawValue)) return rawValue.map(normalizeHost).filter(Boolean);
  return String(rawValue)
    .split(/[\n,\s]+/)
    .map(normalizeHost)
    .filter(Boolean);
}

export function selectResearchSources(results, siteHints = [], maxSites = 6) {
  const hints = new Set(normalizeSiteHints(siteHints));
  const selected = [];
  const seen = new Set();
  const sorted = [...(results || [])].sort((left, right) => {
    const leftHost = getHostFromUrl(left?.url || '');
    const rightHost = getHostFromUrl(right?.url || '');
    const leftPreferred = hints.has(leftHost) ? 1 : 0;
    const rightPreferred = hints.has(rightHost) ? 1 : 0;
    return rightPreferred - leftPreferred;
  });

  for (const result of sorted) {
    if (selected.length >= Math.max(2, maxSites)) break;
    if (!result?.url || seen.has(result.url)) continue;
    seen.add(result.url);
    selected.push({ ...result, host: getHostFromUrl(result.url) });
  }
  return selected;
}
