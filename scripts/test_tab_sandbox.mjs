// scripts/test_tab_sandbox.mjs — v1.15 TAB-GROUP SANDBOX unit tests
//
// Tests the REAL shipped modules (no re-implementations):
//   • src/lib/tab-sandbox.js  — ensureTaskGroup / filterToSandbox / isSandboxTab
//   • src/lib/privacy-agent.js — resolvePrivacyTab sandbox constraints
//
// chrome.* is mocked per-test; every test installs a FRESH mock so state can
// never leak between cases. Run: node scripts/test_tab_sandbox.mjs

import { strict as assert } from 'node:assert';

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  PASS  ${name}`); })
    .catch(err => { failed++; failures.push(`${name}: ${err.message}`); console.log(`  FAIL  ${name}\n        ${err.message}`); });
}

// chrome mock harness
function freshChrome(overrides = {}) {
  const calls = { group: [], update: [], tabsUpdate: [], warns: [] };
  const chrome = {
    runtime: { lastError: null },
    tabs: {
      group: async (opts) => {
        calls.group.push(opts);
        if (chrome.tabs._groupBehavior?.(calls.group.length, opts)) throw new Error(chrome.tabs._groupBehavior?.errMsg || 'group failed');
        return chrome.tabs._nextGroupId ?? 777;
      },
      update: async (tabId, props) => { calls.tabsUpdate.push({ tabId, props }); return { id: tabId, ...props }; },
      get: async (tabId) => {
        const t = chrome.tabs._db?.get(tabId);
        if (!t) throw new Error('Tab not found');
        return t;
      },
      query: async (q) => {
        if (q.active && (q.windowId ?? q.lastFocusedWindow ?? q.currentWindow) !== undefined) {
          return chrome.tabs._activeByWindow?.[q.windowId ?? 'focused'] ?? chrome.tabs._active ?? [];
        }
        return chrome.tabs._active ?? [];
      },
      ...overrides.tabs,
    },
    tabGroups: {
      update: async (groupId, props) => { calls.update.push({ groupId, props }); return { id: groupId, ...props }; },
      ...overrides.tabGroups,
    },
  };
  return { chrome, calls };
}

function loadSandboxModule(chrome) {
  globalThis.chrome = chrome;
  return import('../src/lib/tab-sandbox.js');
}

// privacy-agent.js imports several lib modules; none may touch chrome at
// import time in Node — if one ever does, this test fails loudly (good).
let privacyAgent = null;
async function loadPrivacyAgent(chrome) {
  globalThis.chrome = chrome;
  if (!privacyAgent) privacyAgent = await import('../src/lib/privacy-agent.js');
  return privacyAgent;
}

const sandboxState = (over = {}) => ({
  task: 'Play a song on youtube',
  agentGroupId: null,
  taskTabIds: [],
  taskTabGraph: {},
  ...over,
});

// tab-sandbox.js
await test('ensureTaskGroup creates + styles the group on first use', async () => {
  const { chrome, calls } = freshChrome();
  chrome.tabs._nextGroupId = 77;
  const { ensureTaskGroup } = await loadSandboxModule(chrome);
  const st = sandboxState();
  const gid = await ensureTaskGroup(st, [5]);
  assert.equal(gid, 77);
  assert.equal(st.agentGroupId, 77);
  assert.deepEqual(calls.group, [{ tabIds: [5] }]);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0].groupId, 77);
  assert.equal(calls.update[0].props.color, 'blue');
  assert.equal(calls.update[0].props.title, 'Play a song on youtube'); // ≤24 chars, already fits
  assert.equal(calls.update[0].props.collapsed, false);
});

await test('ensureTaskGroup REUSES the existing group for later tabs', async () => {
  const { chrome, calls } = freshChrome();
  const { ensureTaskGroup } = await loadSandboxModule(chrome);
  const st = sandboxState({ agentGroupId: 42 });
  const gid = await ensureTaskGroup(st, [9]);
  assert.equal(gid, 777);
  assert.deepEqual(calls.group, [{ groupId: 42, tabIds: [9] }]);
});

await test('ensureTaskGroup retries with a FRESH group when the stored id is stale', async () => {
  const { chrome, calls } = freshChrome();
  chrome.tabs._groupBehavior = (n) => n === 1;   // first call (reuse) throws
  chrome.tabs._groupBehavior.errMsg = 'Group not found';
  chrome.tabs._nextGroupId = 55;
  const { ensureTaskGroup } = await loadSandboxModule(chrome);
  const st = sandboxState({ agentGroupId: 999 });
  const gid = await ensureTaskGroup(st, [3]);
  assert.equal(gid, 55);
  assert.equal(st.agentGroupId, 55);
  assert.equal(calls.group.length, 2);
  assert.deepEqual(calls.group[0], { groupId: 999, tabIds: [3] });
  assert.deepEqual(calls.group[1], { tabIds: [3] });
});

await test('ensureTaskGroup is a safe no-op on legacy state ({settings}) and empty ids', async () => {
  const { chrome, calls } = freshChrome();
  const { ensureTaskGroup } = await loadSandboxModule(chrome);
  assert.equal(await ensureTaskGroup({ settings: {} }, [4]), null);
  assert.equal(await ensureTaskGroup(sandboxState(), []), null);
  assert.equal(await ensureTaskGroup(null, [4]), null);
  assert.equal(calls.group.length, 0);
  assert.equal(await ensureTaskGroup(sandboxState({ taskTabIds: [] }), [4]), 777); // real state still groups
});

await test('ensureTaskGroup fail-closed honestly when Chrome refuses (pinned tab)', async () => {
  const { chrome, calls } = freshChrome();
  chrome.tabs._groupBehavior = () => true;
  chrome.tabs._groupBehavior.errMsg = 'Cannot group a pinned tab';
  const { ensureTaskGroup } = await loadSandboxModule(chrome);
  const st = sandboxState();
  const gid = await ensureTaskGroup(st, [7]);
  assert.equal(gid, null);            // honest null — enforcement continues via taskTabIds
  assert.equal(st.agentGroupId, null);
  assert.equal(calls.group.length, 1); // no prior group → single fresh-group attempt
});

await test('filterToSandbox + isSandboxTab: pure membership, legacy-safe', async () => {
  const { chrome } = freshChrome();
  const { filterToSandbox, isSandboxTab } = await loadSandboxModule(chrome);
  const st = sandboxState({ taskTabIds: [1, 2] });
  const tabs = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(filterToSandbox(st, tabs).map(t => t.id), [1, 2]);
  assert.deepEqual(filterToSandbox(st, tabs, { includeTabId: 3 }).map(t => t.id), [1, 2, 3]);
  assert.deepEqual(filterToSandbox({ settings: {} }, tabs), []);           // legacy ctx
  assert.deepEqual(filterToSandbox(null, tabs), []);
  assert.equal(isSandboxTab(st, 2), true);
  assert.equal(isSandboxTab(st, 3), false);
  assert.equal(isSandboxTab(st, undefined), false);
  assert.equal(isSandboxTab({ settings: {} }, 2), false);
});

// privacy-agent.js — resolvePrivacyTab sandbox constraints
await test('resolvePrivacyTab: preferred alive + FOREIGN active tab → re-focus task tab', async () => {
  const { chrome, calls } = freshChrome();
  chrome.tabs._db = new Map([[5, { id: 5, windowId: 1 }]]);
  chrome.tabs._activeByWindow = { 1: [{ id: 9 }] };   // foreign tab is visible
  const { resolvePrivacyTab } = await loadPrivacyAgent(chrome);
  const r = await resolvePrivacyTab(5, [5]);
  assert.equal(r.tab.id, 5);
  assert.equal(r.followed, false);
  assert.equal(r.refocused, true);
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 5, props: { active: true } }]);
});

await test('resolvePrivacyTab: preferred alive + sandbox member active → NO refocus', async () => {
  const { chrome, calls } = freshChrome();
  chrome.tabs._db = new Map([[5, { id: 5, windowId: 1 }], [6, { id: 6, windowId: 1 }]]);
  chrome.tabs._activeByWindow = { 1: [{ id: 6 }] };   // another SANDBOX tab
  const { resolvePrivacyTab } = await loadPrivacyAgent(chrome);
  const r = await resolvePrivacyTab(5, [5, 6]);
  assert.equal(r.refocused, false);
  assert.equal(calls.tabsUpdate.length, 0);
});

await test('resolvePrivacyTab: preferred dead + foreign active → adopts the next LIVE sandbox tab', async () => {
  const { chrome, calls } = freshChrome();
  chrome.tabs._db = new Map([[7, { id: 7, windowId: 1 }]]);
  chrome.tabs._active = [{ id: 9 }];                  // foreign active tab
  const { resolvePrivacyTab } = await loadPrivacyAgent(chrome);
  const r = await resolvePrivacyTab(5, [5, 7]);       // 5 is dead
  assert.equal(r.tab.id, 7);
  assert.equal(r.followed, true);
  assert.equal(r.refocused, true);
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 7, props: { active: true } }]);
});

await test('resolvePrivacyTab: sandbox EMPTY → honest fail-closed error', async () => {
  const { chrome } = freshChrome();
  chrome.tabs._db = new Map();                        // every tab dead
  chrome.tabs._active = [{ id: 9 }];
  const { resolvePrivacyTab } = await loadPrivacyAgent(chrome);
  await assert.rejects(
    () => resolvePrivacyTab(5, [5]),
    /Task sandbox is empty/
  );
});

await test('resolvePrivacyTab: NO sandbox supplied → legacy follow-any-active behavior', async () => {
  const { chrome } = freshChrome();
  chrome.tabs._db = new Map();
  chrome.tabs._active = [{ id: 9, windowId: 2 }];
  const { resolvePrivacyTab } = await loadPrivacyAgent(chrome);
  const r = await resolvePrivacyTab(5, null);         // legacy callers
  assert.equal(r.tab.id, 9);
  assert.equal(r.followed, true);
});

await test('resolvePrivacyTab: preferred alive + foreign active + NO sandbox → never steals focus (legacy)', async () => {
  const { chrome, calls } = freshChrome();
  chrome.tabs._db = new Map([[5, { id: 5, windowId: 1 }]]);
  chrome.tabs._activeByWindow = { 1: [{ id: 9 }] };
  const { resolvePrivacyTab } = await loadPrivacyAgent(chrome);
  const r = await resolvePrivacyTab(5, null);
  assert.equal(r.tab.id, 5);
  assert.equal(r.refocused, false);
  assert.equal(calls.tabsUpdate.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
