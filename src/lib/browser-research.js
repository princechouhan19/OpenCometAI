// src/lib/browser-research.js
// Browser-native helpers for deep research and scrape workflows.

import { normalizeHost } from './utils.js';

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

export async function openResearchTab(url, options = {}) {
  if (typeof options === 'boolean') options = { active: options };
  const tab = await chrome.tabs.create({
    url,
    active: Boolean(options.active),
    openerTabId: Number.isInteger(options.openerTabId) ? options.openerTabId : undefined,
  });
  await waitForLoad(tab.id, options.timeoutMs || 15000);
  return chrome.tabs.get(tab.id).catch(() => tab);
}

export async function closeTabs(tabIds = []) {
  const ids = [...new Set((tabIds || []).filter(Number.isInteger))];
  if (!ids.length) return;
  await chrome.tabs.remove(ids).catch(() => {});
}

export async function scrapeSearchResults(tabId, engine, maxResults = 8, siteHints = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [maxResults, siteHints.map(normalizeHost)],
    func: (limit, preferredHosts) => {
      const norm = value => String(value || '').replace(/\s+/g, ' ').trim();
      const hostOf = value => {
        try { return new URL(value).hostname.replace(/^www\./, '').toLowerCase(); }
        catch { return ''; }
      };
      const visible = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const cleanUrl = value => {
        try {
          const url = new URL(value, location.href);
          if (!/^https?:$/.test(url.protocol)) return '';
          return url.href;
        } catch {
          return '';
        }
      };
      const dedupe = new Map();
      const addResult = (url, title, snippet) => {
        const clean = cleanUrl(url);
        const host = hostOf(clean);
        if (!clean || !host) return;
        if (host.includes('google.com') || host.includes('bing.com') || host.includes('duckduckgo.com')) return;
        if (dedupe.has(clean)) return;
        dedupe.set(clean, {
          url: clean,
          host,
          title: norm(title) || host,
          snippet: norm(snippet).substring(0, 300),
        });
      };

      const selectors = [
        'div.g',
        'div[data-snc]',
        'article',
        '.result',
        '.b_algo',
        '.web-result',
      ];

      for (const selector of selectors) {
        for (const card of document.querySelectorAll(selector)) {
          if (!visible(card)) continue;
          const link = card.querySelector('a[href]');
          const title = card.querySelector('h3, h2, [role="heading"]');
          const snippet = card.querySelector('.VwiC3b, .snippet, .b_caption p, .result__snippet, p');
          if (link) addResult(link.href, title?.textContent || link.textContent, snippet?.textContent || '');
        }
      }

      if (!dedupe.size) {
        for (const link of document.querySelectorAll('a[href]')) {
          if (!visible(link)) continue;
          const title = norm(link.textContent || link.getAttribute('aria-label'));
          if (!title || title.length < 8) continue;
          addResult(link.href, title, link.closest('article, div, li')?.textContent || '');
        }
      }

      const preferred = new Set((preferredHosts || []).filter(Boolean));
      return [...dedupe.values()]
        .sort((a, b) => {
          const aPreferred = preferred.has(a.host) ? 1 : 0;
          const bPreferred = preferred.has(b.host) ? 1 : 0;
          if (aPreferred !== bPreferred) return bPreferred - aPreferred;
          return (b.title?.length || 0) - (a.title?.length || 0);
        })
        .slice(0, limit);
    },
  }).catch(() => []);

  return results?.[0]?.result || [];
}

export async function scrapeReadablePage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const norm = value => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };

      const candidates = [
        document.querySelector('main'),
        document.querySelector('article'),
        document.querySelector('[role="main"]'),
        document.querySelector('#main'),
        document.querySelector('.main'),
        document.body,
      ].filter(Boolean);

      let best = document.body;
      let bestScore = 0;
      for (const candidate of candidates) {
        if (!visible(candidate)) continue;
        const text = norm(candidate.innerText || candidate.textContent);
        const score = text.length;
        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      }

      const headings = [...best.querySelectorAll('h1, h2, h3')]
        .map(node => norm(node.textContent))
        .filter(Boolean)
        .slice(0, 20);

      const links = [...best.querySelectorAll('a[href]')]
        .map(node => ({ text: norm(node.textContent), href: node.href }))
        .filter(item => item.text && item.href)
        .slice(0, 40);

      const tables = [...best.querySelectorAll('table')].slice(0, 4).map(table => ({
        rows: [...table.querySelectorAll('tr')].slice(0, 10).map(row =>
          [...row.querySelectorAll('th,td')].slice(0, 8).map(cell => norm(cell.textContent))
        ),
      })).filter(table => table.rows.length);

      const bodyText = best.innerText || best.textContent || '';
      const emails = [...new Set((bodyText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(norm))].slice(0, 30);
      const phones = [...new Set((bodyText.match(/(?:\+?\d[\d\s()-]{7,}\d)/g) || []).map(norm))].slice(0, 30);

      const clone = best.cloneNode(true);
      const noise = clone.querySelectorAll('script, style, noscript, asides, svg, iframe, nav, footer, button, form');
      noise.forEach(n => n.remove());
      const allEls = clone.querySelectorAll('*');
      for (const el of allEls) {
        if (el.tagName !== 'A' && el.tagName !== 'IMG') {
          while (el.attributes.length > 0) {
            el.removeAttribute(el.attributes[0].name);
          }
        } else if (el.tagName === 'A') {
          const href = el.getAttribute('href');
          while (el.attributes.length > 0) el.removeAttribute(el.attributes[0].name);
          if (href) el.setAttribute('href', href);
        } else if (el.tagName === 'IMG') {
          const src = el.getAttribute('src');
          const alt = el.getAttribute('alt');
          while (el.attributes.length > 0) el.removeAttribute(el.attributes[0].name);
          if (src) el.setAttribute('src', src);
          if (alt) el.setAttribute('alt', alt);
        }
      }
      const cleanedHtml = norm(clone.innerHTML).substring(0, 25000);

      const text = norm(best.innerText || best.textContent).substring(0, 18000);
      const metaDescription =
        document.querySelector('meta[name="description"]')?.getAttribute('content') ||
        document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
        '';

      return {
        url: location.href,
        title: document.title || '',
        text,
        readableText: text,
        cleanedHtml,
        headings,
        links,
        tables,
        emails,
        phones,
        description: norm(metaDescription),
        metaDescription: norm(metaDescription),
      };
    },
  }).catch(() => []);

  return results?.[0]?.result || {
    url: '',
    title: '',
    text: '',
    readableText: '',
    headings: [],
    links: [],
    tables: [],
    emails: [],
    phones: [],
    description: '',
    metaDescription: '',
  };
}

async function waitForLoad(tabId, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (tab.status === 'complete') return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
