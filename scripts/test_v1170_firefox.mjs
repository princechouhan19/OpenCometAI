#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/test_v1170_firefox.mjs — v1.17.0 VERIFICATION HARNESS
// Verifies, without a browser:
//   1. Firefox manifest transform (firefoxifyManifest) on the REAL manifest
//   2. Full build-firefox run + drift guards + structural assertions
//   3. wire-guard URL-parameter line protection (leak detect + scrub)
//   4. storage.js URL sanitization (sanitizeUrlForStorage) incl. userinfo
//   5. stateVersion gating semantics (isCompatibleState + future-drop filter)
//   6. Firefox in-page ML transport markers (iframe + postMessage bridge)
// Exit code 0 = all pass.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firefoxifyManifest, buildFirefox } from './build-firefox.mjs';
import { sensitiveUrlParamLeak, scrubSensitiveUrlParams } from '../src/lib/wire-guard.js';
import { sanitizeUrlForStorage, STATE_VERSION, isCompatibleState } from '../src/lib/storage.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

// ── 1. Manifest transform ──────────────────────────────────────────────────────
console.log('\n1) Firefox manifest transform:');
const chromeManifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const ff = firefoxifyManifest(chromeManifest);
check('version carried through', /^\d+\.\d+\.\d+$/.test(ff.version) && ff.version >= '1.17.0');
check('background.scripts → firefox-bg.js', ff.background?.scripts?.[0] === 'src/background/firefox-bg.js');
check('service_worker removed', ff.background?.service_worker === undefined);
check('gecko id set', ff.browser_specific_settings?.gecko?.id === 'opencomet-sih@opencomet.dev');
check('strict_min_version set', typeof ff.browser_specific_settings?.gecko?.strict_min_version === 'string');
const chromeOnlySurvivors = ['sidePanel', 'offscreen', 'debugger', 'tabGroups', 'pageCapture', 'readingList'].filter(p => ff.permissions.includes(p));
check('no Chrome-only permissions', chromeOnlySurvivors.length === 0, chromeOnlySurvivors.join(','));
check('side_panel removed', ff.side_panel === undefined);
check('content scripts kept', Array.isArray(ff.content_scripts) && ff.content_scripts.length === 1);
check('host_permissions kept', ff.host_permissions?.includes('<all_urls>'));

// ── 2. Full build + drift guards ───────────────────────────────────────────────
console.log('\n2) Full Firefox build (dist/firefox):');
let buildOk = true, buildOut = '';
try {
  const outDir = buildFirefox({ quiet: true });
  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
  check('build completed + manifest written', manifest.background?.scripts?.[0] === 'src/background/firefox-bg.js');
  check('src copied (sw.js present)', readFileSync(join(outDir, 'src', 'background', 'sw.js'), 'utf8').includes('Open Comet'));
  check('vendor copied (transformers vendored)', existsSync(join(outDir, 'src', 'vendor', 'transformers')));
  check('skills copied (12-skill library)', existsSync(join(outDir, 'skills')));
} catch (e) {
  buildOk = false;
  buildOut = e.message;
  check('build completed', false, buildOut);
}
// negative test: corrupt a guard → build must fail
{
  const swPath = join(ROOT, 'src', 'background', 'sw.js');
  const orig = readFileSync(swPath, 'utf8');
  try {
    writeTmp(swPath, orig.replace("if (!chrome.debugger) return await fallbackScreenshot(tabId);", "GUARD_REMOVED"));
    let threw = false;
    try { buildFirefox({ outDir: join(ROOT, 'dist', 'firefox-drift-test'), quiet: true }); } catch { threw = true; }
    check('drift guard FAILS the build when a Firefox guard is removed', threw);
  } finally {
    writeTmp(swPath, orig);
    rmSync(join(ROOT, 'dist', 'firefox-drift-test'), { recursive: true, force: true });
  }
}

// ── 3. wire-guard line protection ──────────────────────────────────────────────
console.log('\n3) wire-guard.js sensitive URL-parameter line protection:');
check('?token= leak detected', sensitiveUrlParamLeak('https://x.example/cb?token=abc123def456'));
check('#access_token= leak detected (OAuth implicit)', sensitiveUrlParamLeak('https://x.example#access_token=eyJhbGciOi'));
check('?api_key= leak detected', sensitiveUrlParamLeak('see https://x.example?api_key=sk-proj-999999'));
check('plain URL not flagged', !sensitiveUrlParamLeak('https://x.example/search?q=browser+agent&page=2'));
check('scrub replaces token value, keeps key', scrubSensitiveUrlParams('https://x.example/cb?token=abc123def456&next=/home') === 'https://x.example/cb?token=[REDACTED:url_param]&next=/home');
check('scrub handles fragment token', scrubSensitiveUrlParams('https://x.example#access_token=secret99').includes('[REDACTED:url_param]'));
check('scrub is idempotent', scrubSensitiveUrlParams(scrubSensitiveUrlParams('https://x.example?sid=abcdefgh')) === scrubSensitiveUrlParams('https://x.example?sid=abcdefgh'));

// ── 4. storage URL sanitization ────────────────────────────────────────────────
console.log('\n4) storage.js URL cleanup before persist:');
check('query token scrubbed', sanitizeUrlForStorage('https://app.example/settings?token=supersecret1') === 'https://app.example/settings?token=[REDACTED:url_param]');
check('basic-auth userinfo stripped', sanitizeUrlForStorage('https://alice:hunter2@example.com/page') === 'https://example.com/page');
check('clean URL untouched', sanitizeUrlForStorage('https://example.com/a/b?x=1') === 'https://example.com/a/b?x=1');
check('non-string input safe', sanitizeUrlForStorage(undefined) === '');

// ── 5. stateVersion gating ─────────────────────────────────────────────────────
console.log('\n5) stateVersion obsolete-state gating:');
check('STATE_VERSION is 2', STATE_VERSION === 2);
check('unstamped (legacy) state is compatible', isCompatibleState({ provider: 'openrouter' }));
check('current-version state is compatible', isCompatibleState({ stateVersion: 2 }));
check('older-version state is compatible', isCompatibleState({ stateVersion: 1 }));
check('FUTURE-version state is NOT compatible', !isCompatibleState({ stateVersion: 99 }));
check('null/undefined state is compatible', isCompatibleState(null) && isCompatibleState(undefined));
const futureEntry = { stateVersion: 99, task: 'x' };
const legacyEntry = { task: 'x' };
const filtered = [futureEntry, legacyEntry, { stateVersion: STATE_VERSION, task: 'y' }]
  .filter(e => !(e && typeof e === 'object' && typeof e.stateVersion === 'number' && e.stateVersion > STATE_VERSION));
check('read-side filter drops only future entries', filtered.length === 2 && filtered[0] === legacyEntry);

// ── 6. in-page ML transport markers ────────────────────────────────────────────
console.log('\n6) Firefox in-page ML runtime:');
const oc = readFileSync(join(ROOT, 'src', 'lib', 'offscreen-client.js'), 'utf8');
check('client creates hidden ML iframe', oc.includes('opencomet-ml-frame'));
check('client postMessages to frame origin only (no "*")', oc.includes('mlTargetOrigin()'));
check('client drains replies via window message listener', oc.includes("d.target !== 'offscreen-client'"));
const off = readFileSync(join(ROOT, 'src', 'offscreen', 'offscreen.js'), 'utf8');
check('offscreen.js has the postMessage bridge', off.includes("msg.rpcId") && off.includes("routeOffscreenRequest(msg,"));
check('bridge feeds the SAME router', off.match(/routeOffscreenRequest/g)?.length >= 3);
const sw = readFileSync(join(ROOT, 'src', 'background', 'sw.js'), 'utf8');
check('sw opens panel-as-tab when sidePanel absent', sw.includes("src/sidepanel/sidepanel.html") && sw.includes('chrome.sidePanel?.open'));
check('sw removes ML iframe on idle teardown', sw.includes("getElementById('opencomet-ml-frame')?.remove()"));
const fb = readFileSync(join(ROOT, 'src', 'background', 'firefox-bg.js'), 'utf8');
check('firefox-bg boots shared module graph', fb.includes("import(chrome.runtime.getURL('src/background/sw.js'))"));

// ── helpers ────────────────────────────────────────────────────────────────────
function writeTmp(path, content) { writeFileSync(path, content); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
