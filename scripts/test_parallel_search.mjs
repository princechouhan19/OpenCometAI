// Synthetic browser/model/MCP responses, exercising the shipped message router.
// Run: node --test scripts/test_parallel_search.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { searchResearchSources } from '../src/lib/research-search.js';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../src/lib/constants.js';

let router;
let state;
let messages;
let requests;
let tabs;
let rules;
let mode;
let allowed;
let plannedQueries;
const endpoint = 'https://search.parallel.ai/mcp';
const ua = 'OpenCometAI/1.31.0 (https://github.com/princechouhan19/OpenCometAI)';
const resultUrl = 'https://example.org/research';
const event = { addListener() {}, removeListener() {} };

/** Start each case without saved credentials, provider settings or network state. */
function reset(settings = {}) {
  state = { [STORAGE_KEYS.SETTINGS]: { provider: 'openai', apiKey: 'synthetic-model-key', ...settings } };
  messages = []; requests = []; tabs = []; rules = []; mode = 'json'; allowed = true; plannedQueries = ['synthetic research query'];
}
reset();
globalThis.chrome = {
  runtime: {
    id: 'abcdefghijklmnopabcdefghijklmnop', getManifest: () => ({ version: '1.31.0' }),
    getURL: path => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}`,
    onInstalled: event, onMessage: { addListener(fn) { router = fn; } },
    sendMessage: async msg => { messages.push(msg); },
  },
  permissions: { contains: async query => { assert.deepEqual(query, { origins: ['https://search.parallel.ai/*'] }); return allowed; } },
  declarativeNetRequest: { updateSessionRules: async rule => { rules.push(rule); } },
  action: { onClicked: event, setBadgeText() {}, setBadgeBackgroundColor() {} },
  tabs: {
    onCreated: event, onRemoved: event,
    query: async () => [{ id: 1, url: 'https://example.org/', status: 'complete' }],
    create: async options => { const tab = { id: tabs.length + 2, status: 'complete', ...options }; tabs.push(tab); return tab; },
    get: async id => tabs.find(tab => tab.id === id) || { id, status: 'complete' },
    remove: async () => {}, sendMessage: async () => {},
    group: async () => 1,
  },
  tabGroups: { update: async () => {} },
  scripting: { executeScript: async ({ target, args }) => [{ result: args
    ? [{ url: resultUrl, title: 'Browser result', snippet: 'Synthetic search result' }]
    : { url: resultUrl, title: 'Source page', readableText: 'Synthetic source fact: the result is blue.', headings: ['Synthetic source'], tables: [] } }] },
  storage: {
    local: { get: async key => key ? { [key]: state[key] } : state, set: async value => Object.assign(state, value) },
    session: { get: async () => ({}), remove: async () => {} },
  },
  alarms: { onAlarm: event, clear: async () => {} },
};

/** Return a fixture MCP envelope in either supported response encoding. */
function reply(id, result, sse = false) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result });
  return new Response(sse ? `event: message\r\ndata: ${body}\r\n\r\n` : body, { headers: { 'content-type': sse ? 'text/event-stream' : 'application/json' } });
}

globalThis.fetch = async (url, options) => {
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({ url, ...options, headers: { ...options.headers }, body });
  if (url === 'https://api.openai.com/v1/chat/completions') {
    const content = body.response_format
      ? JSON.stringify({ queries: plannedQueries, summary: 'The result is blue.', facts: ['The result is blue.'] })
      : 'The result is blue [1].\nSources: [1] https://example.org/research';
    if (!body.response_format) assert.match(body.messages[0].content, /https:\/\/example.org\/research/);
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  }
  assert.equal(url, endpoint);
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers['User-Agent'], ua);
  assert.equal(options.headers.Authorization, undefined);
  if (options.method === 'DELETE') return new Response(null, { status: 204 });
  if (body.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } }), { headers: { 'Mcp-Session-Id': 'fixture-session', 'content-type': 'application/json' } });
  assert.equal(options.headers['Mcp-Session-Id'], 'fixture-session');
  assert.equal(options.headers['MCP-Protocol-Version'], '2025-03-26');
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
  if (body.method === 'tools/list') return reply(body.id, { tools: [{ name: 'web_search' }] }, mode === 'sse');
  assert.equal(body.method, 'tools/call');
  assert.equal(body.params.name, 'web_search');
  if (mode === 'quota') return new Response('quota fixture', { status: 429 });
  if (mode === 'http') return new Response('server fixture', { status: 503 });
  if (mode === 'hang') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  if (mode === 'rpc') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -1, message: 'fixture error' } }));
  if (mode === 'tool') return reply(body.id, { isError: true, content: [{ type: 'text', text: 'fixture tool error' }] });
  if (mode === 'malformed') return new Response('malformed fixture');
  const data = { results: [{ url: resultUrl, title: 'Parallel result', excerpts: ['Synthetic search excerpt'] },
    { url: 'javascript:alert(1)', excerpts: [] }, { url: 'file:///private', excerpts: [] }, { url: 'https://user:secret@example.org', excerpts: [] }] };
  return reply(body.id, mode === 'text' ? { content: [{ type: 'text', text: JSON.stringify(data) }] } : { structuredContent: data }, mode === 'sse');
};
await import('../src/background/sw.js');

/** Send the same request as the sidepanel and wait for the terminal result. */
async function runResearch(extra = {}) {
  const response = await new Promise(resolve => router({ type: 'DEEP_RESEARCH', task: 'Synthetic research task', maxQueries: 1, maxSites: 2, ...extra }, {}, resolve));
  assert.equal(response.ok, true);
  for (let i = 0; i < 200; i++) {
    const done = messages.find(msg => ['DEEP_RESEARCH_DONE', 'DEEP_RESEARCH_ERROR'].includes(msg.type));
    if (done) { await new Promise(resolve => setTimeout(resolve, 0)); return done; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Research did not finish');
}

await test('fresh configuration keeps Google browser search and never contacts Parallel', async () => {
  reset();
  assert.equal(DEFAULT_SETTINGS.deepResearchSearchProvider, 'browser');
  const done = await runResearch();
  assert.equal(done.type, 'DEEP_RESEARCH_DONE');
  assert.match(tabs[0].url, /^https:\/\/www.google.com\/search/);
  assert.equal(requests.some(request => request.url === endpoint), false);
  assert.equal(rules.length, 0);
});
await test('saved engine stays active; explicit browser override defeats saved Parallel selection', async () => {
  reset({ deepResearchSearchProvider: 'parallel', deepResearchSearchEngine: 'bing' });
  const done = await runResearch({ searchProvider: 'browser', searchEngine: 'duckduckgo' });
  assert.equal(done.type, 'DEEP_RESEARCH_DONE');
  assert.match(tabs[0].url, /^https:\/\/duckduckgo.com/);
  assert.equal(requests.some(request => request.url === endpoint), false);
  assert.equal(state[STORAGE_KEYS.SETTINGS].deepResearchSearchProvider, 'parallel');
  assert.equal(state[STORAGE_KEYS.SETTINGS].deepResearchSearchEngine, 'bing');
});
await test('saved Parallel reaches the actual router, source analysis and cited report', async () => {
  reset({ deepResearchSearchProvider: 'parallel', model: 'gpt-4o' });
  const done = await runResearch();
  assert.equal(done.type, 'DEEP_RESEARCH_DONE');
  assert.equal(done.sources[0].url, resultUrl);
  assert.equal(done.sources[0].summary, 'The result is blue.');
  assert.match(done.report, /blue \[1\]/);
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].url, resultUrl);
  const calls = requests.filter(request => request.body?.method === 'tools/call');
  assert.deepEqual(calls[0].body.params.arguments.search_queries, ['synthetic research query']);
  assert.match(calls[0].body.params.arguments.session_id, /^[a-f0-9-]{36}$/);
  assert.equal(calls[0].body.params.arguments.model_name, 'gpt-4o');
  assert.equal(rules[0].addRules[0].action.requestHeaders[0].value, ua);
  assert.deepEqual(rules[0].addRules[0].condition, { regexFilter: '^https://search[.]parallel[.]ai/mcp$', initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] });
  assert.equal(JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url))).permissions.includes('declarativeNetRequestWithHostAccess'), true);
});
for (const encoding of ['sse', 'text']) await test(`${encoding} MCP result is consumed by the report workflow`, async () => {
  reset(); mode = encoding;
  const done = await runResearch({ searchProvider: 'parallel' });
  assert.equal(done.type, 'DEEP_RESEARCH_DONE');
  assert.equal(done.sources[0].url, resultUrl);
});
await test('denied endpoint permission performs no MCP request or fallback', async () => {
  reset(); allowed = false;
  const done = await runResearch({ searchProvider: 'parallel' });
  assert.equal(done.type, 'DEEP_RESEARCH_ERROR');
  assert.match(done.error, /site permissions/);
  assert.equal(requests.some(request => request.url === endpoint), false);
  assert.equal(tabs.length, 0);
});
for (const failure of ['quota', 'http', 'rpc', 'tool', 'malformed']) await test(`${failure} is visible without browser fallback`, async () => {
  reset(); mode = failure;
  const done = await runResearch({ searchProvider: 'parallel' });
  assert.equal(done.type, 'DEEP_RESEARCH_ERROR');
  assert.equal(tabs.length, 0);
});
await test('timeout aborts the selected provider through the resolver', async () => {
  reset(); mode = 'hang';
  await assert.rejects(searchResearchSources('synthetic query', { provider: 'parallel', timeoutMs: 15 }), { name: 'TimeoutError' });
});
await test('Stop aborts an in-flight MCP request and produces no report', async () => {
  reset(); mode = 'hang';
  const result = runResearch({ searchProvider: 'parallel' });
  while (!requests.some(request => request.body?.method === 'tools/call')) await new Promise(resolve => setTimeout(resolve, 1));
  await new Promise(resolve => router({ type: 'STOP_AGENT' }, {}, resolve));
  const done = await result;
  assert.equal(done.type, 'DEEP_RESEARCH_ERROR');
  assert.equal(done.error, 'Research stopped.');
  assert.equal(messages.some(msg => msg.type === 'DEEP_RESEARCH_DONE'), false);
});
await test('unknown selection and pre-cancelled requests do not contact a provider', async () => {
  reset();
  await assert.rejects(searchResearchSources('query', { provider: 'disabled' }), /Unknown research provider/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(searchResearchSources('query', { provider: 'parallel', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(requests.length, 0);
});

await test('all planned queries reuse one research session identifier', async () => {
  reset(); plannedQueries = ['first synthetic query', 'second synthetic query'];
  const done = await runResearch({ searchProvider: 'parallel', maxQueries: 2 });
  assert.equal(done.type, 'DEEP_RESEARCH_DONE');
  const calls = requests.filter(request => request.body?.method === 'tools/call');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.params.arguments.session_id, calls[1].body.params.arguments.session_id);
});
await test('missing header API and rejected header permission do not leak an unattributed request', async () => {
  reset();
  const api = chrome.declarativeNetRequest;
  chrome.declarativeNetRequest = undefined;
  await assert.rejects(searchResearchSources('query', { provider: 'parallel' }), /declarativeNetRequest/);
  chrome.declarativeNetRequest = { updateSessionRules: async () => { throw new Error('Denied header rule'); } };
  await assert.rejects(searchResearchSources('query', { provider: 'parallel' }), /Denied header rule/);
  chrome.declarativeNetRequest = api;
  assert.equal(requests.length, 0);
});
