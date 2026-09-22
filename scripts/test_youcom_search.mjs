// scripts/test_youcom_search.mjs — optional You.com Deep Research provider tests
//
// Tests the REAL shipped module (no re-implementations):
//   • src/lib/deepsearch.js — searchYoucom (response parsing, per-query
//     error isolation, empty/invalid hit handling)
//
// global fetch is mocked per-test; every test installs a FRESH mock so state
// can never leak between cases. Run: node scripts/test_youcom_search.mjs

import { strict as assert } from 'node:assert';
import { searchYoucom } from '../src/lib/deepsearch.js';

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  PASS  ${name}`); })
    .catch(err => { failed++; failures.push(`${name}: ${err.message}`); console.log(`  FAIL  ${name}\n        ${err.message}`); });
}

const REAL_FETCH = globalThis.fetch;

function mockFetch(handler) {
  globalThis.fetch = (url, init) => Promise.resolve(handler(url, init));
}

function restoreFetch() {
  globalThis.fetch = REAL_FETCH;
}

console.log('searchYoucom — You.com Web Search API provider');

await test('maps a standard hits response into scrapeSearchResults shape', async () => {
  mockFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({
      hits: [
        {
          url: 'https://example.com/article',
          title: 'Example Article',
          snippets: ['first snippet', 'second snippet'],
        },
        {
          url: 'https://other.org/page',
          title: '',
          description: 'fallback description',
        },
      ],
    }),
  }));
  try {
    const progress = [];
    const results = await searchYoucom('ydc-test', ['test query'], t => progress.push(t), 8);
    assert.equal(results.length, 2);
    assert.equal(results[0].url, 'https://example.com/article');
    assert.equal(results[0].host, 'example.com');
    assert.equal(results[0].title, 'Example Article');
    assert.equal(results[0].snippet, 'first snippet\nsecond snippet');
    assert.equal(results[1].title, 'other.org');
    assert.equal(results[1].snippet, 'fallback description');
    assert.equal(progress.length, 0);
  } finally { restoreFetch(); }
});

await test('sends the documented request shape with the API key header', async () => {
  let captured = null;
  mockFetch((url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, json: async () => ({ hits: [] }) };
  });
  try {
    await searchYoucom('ydc-secret', ['a query'], null, 12);
    assert.equal(captured.url, 'https://api.ydcindex.io/search');
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers['X-API-Key'], 'ydc-secret');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.query, 'a query');
    assert.equal(body.num_search_results, 12);
    assert.equal(body.safesearch, 'Moderate');
  } finally { restoreFetch(); }
});

await test('a failing query reports progress and keeps the other queries\' results', async () => {
  let call = 0;
  mockFetch(() => {
    call++;
    if (call === 1) return { ok: false, status: 429, json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ hits: [{ url: 'https://ok.example/x', title: 'OK', snippets: ['s'] }] }),
    };
  });
  try {
    const progress = [];
    const results = await searchYoucom('k', ['bad query', 'good query'], t => progress.push(t));
    assert.equal(results.length, 1);
    assert.equal(results[0].url, 'https://ok.example/x');
    assert.ok(progress.some(t => t.includes('HTTP 429')));
  } finally { restoreFetch(); }
});

await test('a network error on one query does not reject the whole call', async () => {
  let call = 0;
  mockFetch(() => {
    call++;
    if (call === 1) throw new Error('boom');
    return { ok: true, status: 200, json: async () => ({ hits: [{ url: 'https://fine.example/y', title: 'Fine', snippets: ['s'] }] }) };
  });
  try {
    const progress = [];
    const results = await searchYoucom('k', ['q1', 'q2'], t => progress.push(t));
    assert.equal(results.length, 1);
    assert.ok(progress.some(t => t.includes('boom')));
  } finally { restoreFetch(); }
});

await test('skips hits without a url and returns [] when nothing is found', async () => {
  mockFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ hits: [{ title: 'no url' }, { url: 'https://real.example/z', title: 'Real', snippets: [] }] }),
  }));
  try {
    const results = await searchYoucom('k', ['q'], null, 8);
    assert.equal(results.length, 1);
    assert.equal(results[0].url, 'https://real.example/z');
    assert.equal(results[0].snippet, '');
    assert.equal(results[0].title, 'Real');
  } finally { restoreFetch(); }
});

await test('empty and blank queries make no network calls', async () => {
  let calls = 0;
  mockFetch(() => { calls++; return { ok: true, status: 200, json: async () => ({ hits: [] }) }; });
  try {
    const results = await searchYoucom('k', ['', '   ', null, undefined], null, 8);
    assert.equal(results.length, 0);
    assert.equal(calls, 0);
  } finally { restoreFetch(); }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
