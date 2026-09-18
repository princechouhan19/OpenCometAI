#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/test_about_page.mjs — v1.15.5 About-page regression (real extension).
//
// Covers the new Settings → About page:
//   1. Settings home shows the About nav card (8 cards) and clicking it opens
//      the About page (title "About", Save button hidden, back button visible).
//   2. Hero: name, logo (actually loads), SIH/ISRO badges and a version chip
//      filled from the REAL loaded manifest (chrome.runtime.getManifest) —
//      must equal the on-disk manifest.json version.
//   3. What's New: 12 changelog entries, newest first, v1.16.0 marked newest.
//   4. Project details: PS #26171, ISRO, OpenComet-Bench 922-case headline.
//   5. Copy build info: reports Copied or Printed (never throws), and the
//      printed/copied text contains the real version.
//   6. Back button returns to the settings home.
//   7. Zero uncaught page errors during the whole flow.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const EXPECTED_VER = MANIFEST.version;

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: Boolean(cond) });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
}

async function main() {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    ],
  });

  let sw = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  context.on('serviceworker', (w) => { if (w.url().startsWith('chrome-extension://')) sw = w; });
  const wake = await context.newPage();
  await wake.goto('about:blank').catch(() => {});
  for (let i = 0; !sw && i < 30; i++) {
    await new Promise(r => setTimeout(r, 100));
    sw = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  }
  const extId = sw ? new URL(sw.url()).hostname : crypto.createHash('sha256').update(ROOT).digest('hex').slice(0, 32)
    .split('').map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
  await wake.close().catch(() => {});

  const panel = await context.newPage();
  const pageErrors = [];
  const consoleLines = [];
  panel.on('pageerror', (e) => pageErrors.push(String(e?.message || e)));
  panel.on('console', (m) => consoleLines.push(m.text()));

  await panel.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`).catch(() => {});
  await panel.waitForTimeout(1000);

  // 1. Settings home → About card present
  await panel.click('#navSettings');
  await panel.waitForTimeout(400);
  const navCards = await panel.$$eval('.settings-nav-card', els => els.map(e => e.dataset.settingsTarget));
  check('settings home has 8 nav cards', navCards.length === 8, navCards.join(','));
  check('About card present', navCards.includes('about'));

  await panel.click('.settings-nav-card[data-settings-target="about"]');
  await panel.waitForTimeout(300);

  // 2. Page state
  const title = await panel.textContent('#settingsTitle');
  check('title reads "About"', (title || '').trim() === 'About', title);
  const backVisible = await panel.$eval('#settingsBackBtn', el => getComputedStyle(el).display !== 'none');
  check('back button visible', backVisible);
  const saveVisible = await panel.$eval('#saveSettingsBtn', el => getComputedStyle(el).display !== 'none');
  check('Save button hidden on About', !saveVisible);
  const visibleAboutSections = await panel.$$eval('.settings-subpage-section[data-settings-page="about"]',
    els => els.filter(e => getComputedStyle(e).display !== 'none').length);
  check('3 About sections visible', visibleAboutSections === 3, String(visibleAboutSections));

  // 3. Hero
  const name = await panel.textContent('.about-name');
  check('hero name', (name || '').includes('OpenComet SIH — Privacy Vision Agent'), name);
  const logoOk = await panel.$eval('.about-logo', img => img.complete && img.naturalWidth > 0);
  check('logo image loads', logoOk);
  const badges = await panel.$$eval('.about-badge', els => els.map(e => e.textContent.trim()));
  check('SIH + ISRO badges', badges.some(b => b.includes('26171')) && badges.some(b => b.includes('ISRO')), badges.join('|'));
  const ver = await panel.textContent('#aboutVersion');
  check('version chip = manifest version', (ver || '').trim() === `v${EXPECTED_VER}`, `got ${ver}, want v${EXPECTED_VER}`);

  // 4. What's New
  const clVers = await panel.$$eval('.about-cl-ver', els => els.map(e => e.textContent.trim()));
  check('12 changelog entries', clVers.length === 12, clVers.join(','));
  check('changelog newest-first', clVers[0] === 'v1.16.0' && clVers[clVers.length - 1] === 'v1.14', clVers.join(','));
  const newestMarked = await panel.$eval('.about-cl-item.newest .about-cl-ver', el => el.textContent.trim());
  check('v1.16.0 marked newest', newestMarked === 'v1.16.0');
  const clText = await panel.$$eval('.about-cl-item', els => els.map(e => e.textContent).join(' '));
  check('changelog mentions avatar guard + face sweep + Indian IDs',
    clText.includes('avatar guard') && clText.includes('face sweep') && clText.includes('Indian ID'), '');

  // 5. Project details
  const dd = await panel.$$eval('.about-dd', els => els.map(e => e.textContent).join(' '));
  check('details: PS 26171 + ISRO', dd.includes('26171') && dd.includes('Indian Space Research Organisation'), '');
  check('details: OpenComet-Bench 922 + four tiers', dd.includes('922') && dd.includes('514-case'), '');

  // 6. Copy build info — must never throw; state must report one of the two honest outcomes
  const copyStateBefore = await panel.textContent('#aboutCopyState');
  await panel.click('#aboutCopyBuildBtn');
  await panel.waitForTimeout(500);
  const copyState = await panel.textContent('#aboutCopyState');
  check('copy button reports an outcome', ['Copied to clipboard', 'Printed to console'].includes((copyState || '').trim()),
    `before="${(copyStateBefore || '').trim()}" after="${(copyState || '').trim()}"`);
  const buildInfoLogged = consoleLines.some(l => l.includes('[OpenComet] build info') && l.includes(EXPECTED_VER));
  const copiedViaClipboard = (copyState || '').includes('Copied');
  check('build info carries the real version', copiedViaClipboard || buildInfoLogged, '');

  // 7. Back to home
  await panel.click('#settingsBackBtn');
  await panel.waitForTimeout(300);
  const titleAfter = await panel.textContent('#settingsTitle');
  const homeVisible = await panel.$eval('#settingsHome', el => getComputedStyle(el).display !== 'none');
  check('back returns to Settings home', (titleAfter || '').trim() === 'Settings' && homeVisible, titleAfter);

  // 8. Console banner + zero page errors
  check('version banner logged', consoleLines.some(l => l.includes(`[OpenComet] v${EXPECTED_VER}`)), '');
  check('zero uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  await context.close();

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log('FAILED:', failed.map(f => f.name).join(' · ')); process.exit(1); }
  console.log('ABOUT PAGE SUITE: ALL PASS');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
