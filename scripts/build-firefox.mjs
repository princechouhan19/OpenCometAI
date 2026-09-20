#!/usr/bin/env node
// scripts/build-firefox.mjs — v1.17.0 FIREFOX BUILD
//
//   node scripts/build-firefox.mjs [--out dist/firefox]
//
// One source tree, two runtimes. Copies the Chromium extension into dist/firefox
// and rewrites manifest.json for Firefox MV3:
//   • background.service_worker (module) → background.scripts (event page)
//     loading src/background/firefox-bg.js, which dynamic-import()s sw.js
//   • Chrome-only permissions removed (sidePanel, offscreen, debugger,
//     tabGroups, pageCapture, readingList)
//   • side_panel removed (the panel opens as a tab on Firefox — sw.js handles
//     this at runtime via feature detection)
//   • browser_specific_settings.gecko id + strict_min_version added
//
// The build FAILS (non-zero exit) if the Firefox feature-detect guards drift
// out of the source tree — that keeps "one source tree" honest over time.

import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Chrome-only permissions Firefox neither needs nor understands.
export const CHROME_ONLY_PERMISSIONS = ['sidePanel', 'offscreen', 'debugger', 'tabGroups', 'pageCapture', 'readingList'];

const GECKO_ID = 'opencomet-sih@opencomet.dev';
const GECKO_MIN_VERSION = '115.0'; // MV3 event pages + object-form WAR/CSP baseline

/**
 * Pure transform: Chromium manifest → Firefox manifest. Exported so the
 * verification harness can test it without running a full build.
 */
export function firefoxifyManifest(chromeManifest) {
  const out = JSON.parse(JSON.stringify(chromeManifest));

  // 1) Background: module service worker → classic event-page script.
  //    (firefox-bg.js boots sw.js through dynamic import() — module graph intact.)
  out.background = { scripts: ['src/background/firefox-bg.js'] };

  // 2) Drop Chrome-only permissions.
  out.permissions = (out.permissions || []).filter(p => !CHROME_ONLY_PERMISSIONS.includes(p));

  // 3) The panel opens as a tab on Firefox — no side_panel key.
  delete out.side_panel;

  // 4) Gecko application identity.
  out.browser_specific_settings = {
    gecko: { id: GECKO_ID, strict_min_version: GECKO_MIN_VERSION },
  };

  return out;
}

// Drift guards: markers that MUST exist in the copied tree. Each corresponds
// to a runtime feature-detect that makes Chrome-only code Firefox-safe.
const DRIFT_GUARDS = [
  { file: 'src/background/sw.js',          re: /sidePanel\?\.setPanelBehavior|sidePanel\?\.open/, why: 'sidePanel feature-detect (sidebar-as-tab fallback)' },
  { file: 'src/background/sw.js',          re: /if \(!chrome\.debugger\) return await fallbackScreenshot/, why: 'takeScreenshot debugger guard' },
  { file: 'src/background/sw.js',          re: /opencomet-ml-frame/, why: 'in-page ML iframe teardown route' },
  { file: 'src/background/actions.js',     re: /chrome\.pageCapture\?\.captureMHTML/, why: 'save_page pageCapture guard' },
  { file: 'src/background/actions.js',     re: /if \(!chrome\.debugger\) return \{ ok: false, reason: 'trusted/, why: 'trustedClick debugger guard' },
  { file: 'src/lib/privacy-agent.js',      re: /chrome\.debugger is unavailable on this browser/, why: 'privacy capture debugger guard' },
  { file: 'src/lib/offscreen-client.js',   re: /INPAGE_MODE/, why: 'in-page ML runtime mode' },
  { file: 'src/lib/offscreen-client.js',   re: /opencomet-ml-frame/, why: 'in-page ML iframe creation' },
  { file: 'src/offscreen/offscreen.js',    re: /offscreen-client/, why: 'postMessage RPC bridge (reply drain)' },
  { file: 'src/background/firefox-bg.js',  re: /import\(chrome\.runtime\.getURL\('src\/background\/sw\.js'\)\)/, why: 'event-page boot of the shared module graph' },
];

function dirSize(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    total += statSync(p).isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

export function buildFirefox({ outDir = join(ROOT, 'dist', 'firefox'), quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const srcManifestPath = join(ROOT, 'manifest.json');
  const manifest = JSON.parse(readFileSync(srcManifestPath, 'utf8'));

  // 1) Fresh output dir.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 2) Copy the runtime tree (src/ includes the vendored ML libs + offscreen
  //    document; assets/ icons; skills/ the 12-skill library).
  for (const dir of ['src', 'assets', 'skills']) {
    const from = join(ROOT, dir);
    if (!existsSync(from)) throw new Error(`required directory missing: ${dir}/`);
    cpSync(from, join(outDir, dir), { recursive: true });
  }
  for (const file of ['LICENSE', 'LEGAL.md']) {
    if (existsSync(join(ROOT, file))) cpSync(join(ROOT, file), join(outDir, file));
  }

  // 3) Firefox manifest.
  const ffManifest = firefoxifyManifest(manifest);
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(ffManifest, null, 2) + '\n');

  // 4) Structural validation.
  const problems = [];
  if (!existsSync(join(outDir, 'src', 'background', 'firefox-bg.js'))) {
    problems.push('background.scripts target missing: src/background/firefox-bg.js');
  }
  if (ffManifest.background.service_worker) problems.push('service_worker key survived the transform');
  for (const p of CHROME_ONLY_PERMISSIONS) {
    if (ffManifest.permissions.includes(p)) problems.push(`Chrome-only permission survived: ${p}`);
  }
  if (!ffManifest.browser_specific_settings?.gecko?.id) problems.push('gecko id missing');
  if (ffManifest.side_panel) problems.push('side_panel key survived the transform');

  // 5) Drift guards — Firefox-safety markers in the copied source.
  for (const guard of DRIFT_GUARDS) {
    const body = readFileSync(join(outDir, guard.file), 'utf8');
    if (!guard.re.test(body)) problems.push(`FIREFOX GUARD DRIFT: ${guard.file} is missing ${guard.why} (matched /${guard.re.source.slice(0, 60)}/)`);
  }

  if (problems.length) {
    for (const p of problems) console.error(`  ✗ ${p}`);
    throw new Error(`Firefox build failed with ${problems.length} problem(s)`);
  }

  const mb = (dirSize(outDir) / (1024 * 1024)).toFixed(1);
  log(`\n✓ Firefox build ready → dist/firefox  (${mb} MB)`);
  log(`  background : ${JSON.stringify(ffManifest.background)}`);
  log(`  permissions: ${ffManifest.permissions.join(', ')}`);
  log(`  gecko id   : ${GECKO_ID} (min ${GECKO_MIN_VERSION})`);
  log(`  drift guards checked: ${DRIFT_GUARDS.length}`);
  log(`\n  Load it: about:debugging#/runtime/this-firefox → "Load Temporary Add-on" → dist/firefox/manifest.json`);
  return outDir;
}

// CLI entry (imported as a module by the harness → skipped).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outIdx = process.argv.indexOf('--out');
  const outDir = outIdx >= 0 ? resolve(process.argv[outIdx + 1]) : undefined;
  try {
    buildFirefox(outDir ? { outDir } : {});
  } catch (err) {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  }
}
