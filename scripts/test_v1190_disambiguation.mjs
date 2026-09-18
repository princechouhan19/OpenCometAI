#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/test_v1190_disambiguation.mjs — v1.19.0 HARNESS
// Verifies, without a browser:
//   1. Ordinal selector parsing ("Buy Now #2" → base + ordinal; negatives)
//   2. Disambiguation primitives (quadrant, dup tag, ref name, nearform)
//   3. Repeated-tag grouping (group of 4 → dup/pos/nearform/ref; singles clean)
//   4. EN/HI guardian parity — mirrored case sets with the SAME structure:
//      each English case has a Hindi twin with the same shape and the same
//      expected verdict (both negation orders: pre-verbal "मत खरीदो" AND
//      post-verbal "खरीदो मत" / "हटाओ मत")
//   5. Daemon counter (tally semantics, summary, lifetime merge)
//   6. Wiring markers (inventory pass, ordinal resolution, receipt, counter)
// Exit code 0 = all pass.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseOrdinalSelector, quadrantOf, dupTagOf, refNameOf, pickNearform,
  receiptFor, tagRepeated, DISAMBIGUATE_VERSION,
} from '../src/lib/element-disambiguate.js';
import { authorizeAction } from '../src/lib/guardian-daemon.js';
import {
  createGuardianCounter, tallyGuardian, guardianCounterSummary, mergeGuardianLifetime,
} from '../src/lib/guardian-daemon.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

// ── 1. Ordinal selector parsing ────────────────────────────────────────────────
console.log('\n1) Ordinal selector parsing:');
{
  const r = parseOrdinalSelector('Buy Now #2');
  check('"Buy Now #2" → { base, ordinal }', r && r.base === 'Buy Now' && r.ordinal === 2);
  const r2 = parseOrdinalSelector('Buy Now #2 of 4');
  check('"Buy Now #2 of 4" keeps the declared total', r2 && r2.base === 'Buy Now' && r2.ordinal === 2 && r2.total === 4);
  const r3 = parseOrdinalSelector('text:अभी खरीदें #3');
  check('Hindi ref with text: prefix parses (Devanagari-safe)', r3 && r3.base === 'अभी खरीदें' && r3.ordinal === 3);
  check('"Buy Now" has no ordinal', parseOrdinalSelector('Buy Now') === null);
  check('bare "#2" is not an ordinal (CSS-id safety)', parseOrdinalSelector('#2') === null);
  check('"#main" is not an ordinal', parseOrdinalSelector('#main') === null);
  check('"div#header" is not an ordinal', parseOrdinalSelector('div#header') === null);
  check('"Buy Now #0" rejected (1-indexed)', parseOrdinalSelector('Buy Now #0') === null);
  check('"Buy Now #9999" rejected (4 digits)', parseOrdinalSelector('Buy Now #9999') === null);
  check('"Buy Now #x" rejected', parseOrdinalSelector('Buy Now #x') === null);
  check('empty selector rejected', parseOrdinalSelector('') === null);
  check('uid selectors never parse as ordinals', parseOrdinalSelector('uid:nx-2') === null);
}

// ── 2. Disambiguation primitives ───────────────────────────────────────────────
console.log('\n2) Disambiguation primitives:');
{
  check('version constant is v1.19.0', DISAMBIGUATE_VERSION === 'v1.19.0');
  const vp = { w: 300, h: 600 };
  check('top-left zone', quadrantOf({ x: 10, y: 10, w: 80, h: 30 }, vp) === 'top-left');
  check('middle-center zone', quadrantOf({ x: 140, y: 290, w: 20, h: 20 }, vp) === 'middle-center');
  check('bottom-right zone', quadrantOf({ x: 250, y: 500, w: 40, h: 40 }, vp) === 'bottom-right');
  check('exact-third boundary is not <left>', quadrantOf({ x: 100 - 5, y: 0, w: 10, h: 10 }, vp) !== 'top-left');
  check('bad bounds → empty (never guesses)', quadrantOf(null, vp) === '');
  check('bad viewport → empty', quadrantOf({ x: 0, y: 0, w: 10, h: 10 }, { w: 0, h: 0 }) === '');
  check('dup tag "2 of 4"', dupTagOf(2, 4) === '2 of 4');
  check('singles get no dup tag', dupTagOf(1, 1) === '' && dupTagOf(3, 0) === '');
  check('out-of-range index gets no dup tag', dupTagOf(5, 4) === '');
  check('ref name "Buy Now #2"', refNameOf('Buy Now', 2) === 'Buy Now #2');
  check('Hindi ref name keeps Devanagari', refNameOf('अभी खरीदें', 3) === 'अभी खरीदें #3');
  check('whitespace collapsed in ref', refNameOf('  Buy   Now  ', 1) === 'Buy Now #1');
  check('pickNearform takes first meaningful', pickNearform(['', '  ', 'iPhone 15 case']) === 'iPhone 15 case');
  check('pickNearform caps at 40 chars', pickNearform(['x'.repeat(80)]).length === 40);
  check('pickNearform empty → ""', pickNearform([]) === '' && pickNearform(undefined) === '');
  const rc = receiptFor({ label: 'Buy Now', index: 2, total: 4, bounds: { x: 10, y: 10, w: 80, h: 30 }, viewport: vp, nearform: ['Buy Now', 'iPhone 15 case'] });
  check('receipt shape { dup, pos, nearform, ref }', rc.dup === '2 of 4' && rc.pos === 'top-left' && rc.nearform === 'Buy Now' && rc.ref === 'Buy Now #2');
  const r1 = receiptFor({ label: 'Buy Now', index: 1, total: 1, bounds: { x: 0, y: 0, w: 10, h: 10 }, viewport: vp });
  check('singletons get ref "" and dup ""', r1.dup === '' && r1.ref === '');
  const rt = parseOrdinalSelector(refNameOf('Buy Now', 2));
  check('ref round-trips through the ordinal parser', rt && rt.base === 'Buy Now' && rt.ordinal === 2);
}

// ── 3. Repeated-tag grouping ───────────────────────────────────────────────────
console.log('\n3) Repeated-tag grouping (tagRepeated):');
{
  const items = [
    { tag: 'button', text: 'Buy Now', bounds: { x: 10,  y: 10,  w: 80, h: 30 } },
    { tag: 'button', text: 'Buy Now', bounds: { x: 10,  y: 300, w: 80, h: 30 } },
    { tag: 'button', text: 'Buy Now', bounds: { x: 200, y: 10,  w: 80, h: 30 } },
    { tag: 'button', text: 'Buy Now', bounds: { x: 200, y: 300, w: 80, h: 30 } },
    { tag: 'a',      text: 'Buy Now', bounds: { x: 400, y: 10,  w: 60, h: 20 } },  // different tag → own group
    { tag: 'button', text: 'Checkout', bounds: { x: 10, y: 400, w: 90, h: 30 } }, // singleton
  ];
  tagRepeated(items, { w: 300, h: 600 });
  const [b1, b2, b3, b4, anchor, single] = items;
  check('4 identical buttons all tagged', b1.dup === '1 of 4' && b2.dup === '2 of 4' && b3.dup === '3 of 4' && b4.dup === '4 of 4');
  check('ordinal ref names "Buy Now #1…#4"', b1.ref === 'Buy Now #1' && b4.ref === 'Buy Now #4');
  check('second control sits in the top-left zone', b1.pos === 'top-left');
  check('fourth control sits in the middle-right zone', b4.pos === 'middle-right');
  check('different tag → NOT grouped with the buttons', !anchor.dup && !anchor.ref);
  check('singleton stays clean (no tag noise)', !single.dup && !single.ref && !single.pos);
  check('nearHint becomes nearform', (() => {
    const pair = [
      { tag: 'button', text: 'Buy Now', nearHint: 'iPhone 15 case', bounds: { x: 0, y: 0, w: 10, h: 10 } },
      { tag: 'button', text: 'Buy Now', nearHint: 'iPhone 15 cover', bounds: { x: 0, y: 200, w: 10, h: 10 } },
    ];
    tagRepeated(pair, { w: 300, h: 600 });
    return pair[0].nearform === 'iPhone 15 case' && pair[1].nearform === 'iPhone 15 cover';
  })());
  check('ariaLabel fallback labels a group', (() => {
    const pair = [
      { tag: 'button', ariaLabel: 'हटाओ', bounds: { x: 0, y: 0, w: 10, h: 10 } },
      { tag: 'button', ariaLabel: 'हटाओ', bounds: { x: 0, y: 200, w: 10, h: 10 } },
    ];
    tagRepeated(pair, { w: 300, h: 600 });
    return pair[0].dup === '1 of 2' && pair[1].ref === 'हटाओ #2';
  })());
}

// ── 4. EN/HI guardian parity — the Hindi set has the SAME shape ───────────────
console.log('\n4) EN/HI guardian parity (mirrored sets, same structure):');
{
  // Each pair: [name, elementEN, taskEN, elementHI, taskHI, extraEN, extraHI, expectPass]
  const PAIRS = [
    ['silent task blocks purchase', 'Buy Now', 'find me a good laptop under 50k', 'अभी खरीदें', 'मुझे 50 हज़ार से कम में अच्छा लैपटॉप दिखाओ', [], [], false],
    ['explicit task allows purchase', 'Buy Now', 'buy the red shoes', 'अभी खरीदें', 'लाल जूते खरीदो', [], [], true],
    ['explicit ban blocks (pre-verbal negation)', 'Buy Now', 'Do not purchase anything', 'अभी खरीदें', 'कुछ भी मत खरीदो', [], [], false],
    ['explicit ban blocks (no/ban phrasing)', 'Buy Now', 'no buying today', 'अभी खरीदें', 'खरीदो मत', [], [], false],
    ['benign order-status context never authorizes', 'Order Now', 'track my order status', 'ऑर्डर करें', 'मेरा ऑर्डर स्टेटस देखो', [], [], false],
    ['silent task blocks the URL class', 'Buy Now', 'just browsing', 'अभी खरीदें', 'बस देख रहा हूँ', [], [], false],
    ['mid-run USER NOTE authorizes', 'Buy Now', 'find me a good laptop', 'अभी खरीदें', 'अच्छा लैपटॉप खोजो', ['you may complete the purchase'], ['आप खरीद सकते हैं'], true],
    ['silent task blocks deletion', 'Delete', 'clean up my drive view', 'डिलीट करें', 'मेरी ड्राइव दिखाओ', [], [], false],
    ['explicit task allows deletion', 'Delete', 'delete the draft file', 'डिलीट करें', 'ड्राफ़्ट फ़ाइल डिलीट कर दो', [], [], true],
    ['explicit ban blocks deletion (post-verbal negation)', 'Delete', 'do not delete anything', 'हटाओ', 'कुछ भी हटाओ मत', [], [], false],
  ];
  let enShape = [], hiShape = [];
  PAIRS.forEach(([name, elEN, taskEN, elHI, taskHI, xEN, xHI, expectPass], i) => {
    const url = i === 5 ? { type: 'navigate', url: 'https://shop.example/checkout' } : null;
    const en = authorizeAction(url || { type: 'click', selector: elEN }, { taskText: taskEN, extraTexts: xEN, hits: 0 });
    const hi = authorizeAction(url || { type: 'click', selector: elHI }, { taskText: taskHI, extraTexts: xHI, hits: 0 });
    check(`pair ${i + 1} [${name}] — EN ${expectPass ? 'allowed' : 'blocked'}`, en.pass === expectPass);
    check(`pair ${i + 1} [${name}] — HI ${expectPass ? 'allowed' : 'blocked'}`, hi.pass === expectPass);
    check(`pair ${i + 1} [${name}] — verdict parity (same shape)`, en.pass === hi.pass && en.skip === hi.skip && en.exit === hi.exit);
    enShape.push(`${en.pass}|${en.skip}|${en.exit}|${typeof en.userMessage}`);
    hiShape.push(`${hi.pass}|${hi.skip}|${hi.exit}|${typeof hi.userMessage}`);
  });
  check('the two test sets are structurally identical (same byte shape)', JSON.stringify(enShape) === JSON.stringify(hiShape));
  // Negation-window mechanics, proven directly:
  const bannedEN = authorizeAction({ type: 'click', selector: 'Buy Now' }, { taskText: 'do not buy anything', hits: 0 });
  const bannedHIpre = authorizeAction({ type: 'click', selector: 'अभी खरीदें' }, { taskText: 'कुछ भी मत खरीदो', hits: 0 });
  const bannedHIpost = authorizeAction({ type: 'click', selector: 'अभी खरीदें' }, { taskText: 'खरीदो मत', hits: 0 });
  check('EN ban carries the FORBIDS message', bannedEN.verdict.userMessage.includes('FORBIDS'));
  check('HI pre-verbal ban ("मत खरीदो") carries FORBIDS', bannedHIpre.verdict.userMessage.includes('FORBIDS'));
  check('HI post-verbal ban ("खरीदो मत") carries FORBIDS', bannedHIpost.verdict.userMessage.includes('FORBIDS'));
  const engSafe = authorizeAction({ type: 'click', selector: 'Buy Now' }, { taskText: 'buy one get one free offer', hits: 0 });
  check('Devanagari after-window never fires on English prose', engSafe.pass === true);
  // v1.19.0 window fixes (exposed by this parity set):
  const banPhrase = authorizeAction({ type: 'click', selector: 'Buy Now' }, { taskText: 'no buying today', hits: 0 });
  check('EN ban "no buying today" → BLOCKED (cue shares the verb phrase)', banPhrase.pass === false && banPhrase.verdict.userMessage.includes('FORBIDS'));
  const banPost = authorizeAction({ type: 'click', selector: 'Buy Now' }, { taskText: 'buying is not allowed', hits: 0 });
  check('EN post-verbal "buying is not allowed" → BLOCKED', banPost.pass === false);
  const stillAuth1 = authorizeAction({ type: 'click', selector: 'Buy Now' }, { taskText: 'buy one, not the other', hits: 0 });
  check('EN "buy one, not the other" stays authorized (no bare-"not" false negatives)', stillAuth1.pass === true);
  const stillAuth2 = authorizeAction({ type: 'click', selector: 'Buy Now' }, { taskText: 'buy what is needed', hits: 0 });
  check('EN "buy what is needed" stays authorized', stillAuth2.pass === true);
  const hiSuppress = authorizeAction({ type: 'click', selector: 'ऑर्डर करें' }, { taskText: 'ऑर्डर हिस्ट्री दिखाओ', hits: 0 });
  check('HI benign order-history context never authorizes', hiSuppress.pass === false);
  const hiThree = [
    authorizeAction({ type: 'click', selector: 'अभी खरीदें' }, { taskText: 'ब्राउज़िंग करो', hits: 0 }),
    authorizeAction({ type: 'click', selector: 'ऑर्डर करें' }, { taskText: 'ब्राउज़िंग करो', hits: 1 }),
    authorizeAction({ type: 'click', selector: 'भुगतान करें' }, { taskText: 'ब्राउज़िंग करो', hits: 2 }),
  ];
  check('HI blocks hit-account 1→2→3 and exit at 3 (same daemon policy)', hiThree[0].hit === 1 && hiThree[1].hit === 2 && hiThree[2].hit === 3 && hiThree[2].exit === true);
}

// ── 5. Daemon counter ──────────────────────────────────────────────────────────
console.log('\n5) Daemon counter:');
{
  const c = createGuardianCounter();
  check('fresh counter is all zeros', c.checks === 0 && c.risky === 0 && c.authorized === 0 && c.blocked === 0 && c.exits === 0 && c.faults === 0);
  tallyGuardian(c, { pass: true, verdict: { risk: null } });                                   // harmless check
  tallyGuardian(c, { pass: true, verdict: { risk: { class: 'purchase' } } });                  // authorized
  tallyGuardian(c, { pass: false, skip: true, hit: 1, verdict: { userMessage: 'x' } });        // blocked
  tallyGuardian(c, { pass: false, exit: true, hit: 3, verdict: { userMessage: 'x' } });        // exit
  tallyGuardian(c, { pass: false, fatal: true, userMessage: 'fault' });                        // fault
  check('tally semantics', c.checks === 5 && c.risky === 1 && c.authorized === 1 && c.blocked === 2 && c.exits === 1 && c.faults === 1);
  const s = guardianCounterSummary(c);
  check('summary is the one-line format', s === 'checks 5 · risky 1 (authorized 1) · blocked 2 · exits 1 · faults 1');
  check('tally tolerates null verdicts/counter', (() => {
    const c2 = tallyGuardian(null, null);
    return c2.checks === 1 && c2.blocked === 0;
  })());
  const life = mergeGuardianLifetime({ runs: 2, checks: 10, blocked: 3 }, c);
  check('lifetime merge adds runs + every field', life.runs === 3 && life.checks === 15 && life.blocked === 5 && life.exits === 1 && life.faults === 1 && typeof life.updatedAt === 'number');
  check('lifetime merge tolerates empty inputs', mergeGuardianLifetime(null, null).runs === 1);
}

// ── 6. Wiring markers ──────────────────────────────────────────────────────────
console.log('\n6) Wiring markers:');
{
  check('lib module exists at src/lib/element-disambiguate.js', existsSync(join(ROOT, 'src/lib/element-disambiguate.js')));
  const sw = read('src/background/sw.js');
  const act = read('src/background/actions.js');
  const rt = read('src/lib/agent-runtime.js');
  const ps = read('src/lib/page-state.js');
  const pl = read('src/background/privacy-loop.js');
  const gd = read('src/lib/guardian-daemon.js');
  const tg = read('src/lib/task-guardian.js');
  const manifest = JSON.parse(read('manifest.json'));

  check('sw.js: inventory disambiguation pass (dup/pos/nearform/ref)', sw.includes('v1.19.0 DISAMBIGUATION PASS') && sw.includes('it.dup =') && sw.includes('it.ref ='));
  check('sw.js: nearform context (nearHint) computed per element', sw.includes('nearHint') && sw.includes("el.closest('form')"));
  check('sw.js: counter created at run start + tallied at the gate', sw.includes('agentState.guardianCounter = createGuardianCounter()') && sw.includes('tallyGuardian(agentState.guardianCounter, gAuth)'));
  check('sw.js: lifetime flush on EVERY honest terminal path', (sw.match(/flushGuardianLifetime\(\)/g) || []).length >= 6 && sw.includes('opencometGuardianLifetime'));
  check('sw.js: counter surfaced on AGENT_DONE broadcasts', sw.includes('guardian: guardianData') && sw.includes('guardianRunData()'));
  check('actions.js: ordinal pre-resolution + honest out-of-range', act.includes('v1.19.0 ORDINAL PRE-RESOLUTION') && act.includes("resolution = 'ordinal'") && act.includes('Ordinal out of range'));
  check('actions.js: disambiguation receipt on click results', act.includes('disambiguation') && act.includes('v1.19.0 DISAMBIGUATION RECEIPT'));
  check('actions.js: context.ref exact-control fallback', act.includes('context.ref') && act.includes('ref: matched.ref'));
  check('agent-runtime.js: receipts pass through to the model prompt', rt.includes("dup: String(item?.dup || '')") && rt.includes("ref: String(item?.ref || '')"));
  check('page-state.js: duplicates surface their ordinal name on anchors', ps.includes('item.ref || item.label'));
  check('privacy-loop.js: BOTH gates tally the counter', pl.includes('tallyGuardian(stateRef?.guardianCounter, auth)') && pl.includes('tallyGuardian(stateRef?.guardianCounter, qAuth)'));
  check('privacy-loop.js: guardian exit flushes the lifetime counter', pl.includes('mergeGuardianLifetime(prev, c)'));
  check('daemon: counter API exported (create/tally/summary/merge)', gd.includes('export function createGuardianCounter') && gd.includes('export function tallyGuardian') && gd.includes('export function guardianCounterSummary') && gd.includes('export function mergeGuardianLifetime'));
  check('guardian: Hindi both negation orders documented in code', tg.includes('HINDI_NEGATION_RE') && tg.includes('HINDI_NEGATION_AFTER_RE') && tg.includes('GUARDIAN_VERSION = \'v1.19.0\''));
  check('manifest bumped to 1.19.0', manifest.version === '1.19.0');
  check('changelog v1.19.0.md exists + INDEX row', existsSync(join(ROOT, 'docs/changelog/v1.19.0.md')) && read('docs/changelog/INDEX.md').includes('v1.19.0'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
