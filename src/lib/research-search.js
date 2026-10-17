import { searchParallel } from './parallel-search.js';
import { buildSearchUrl, openResearchTab, scrapeSearchResults } from './browser-research.js';

/** Resolve the selected research provider; never fall back after an explicit failure. */
export async function searchResearchSources(query, options = {}) {
  const { provider = 'browser', engine = 'google', maxResults = 12, siteHints = [], tabOptions = {}, onTab, signal } = options;
  signal?.throwIfAborted();
  if (provider === 'parallel') return searchParallel(query, options);
  if (provider !== 'browser') throw new Error(`Unknown research provider: ${provider}`);
  const tab = await openResearchTab(buildSearchUrl(engine, query), tabOptions);
  onTab?.(tab.id);
  signal?.throwIfAborted();
  return scrapeSearchResults(tab.id, engine, maxResults, siteHints);
}
