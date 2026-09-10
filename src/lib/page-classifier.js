// ─────────────────────────────────────────────────────────────────────────────
// src/lib/page-classifier.js
// SIH Phase 5 — STRUCTURED VISUAL CONTEXT.
//
// Fuses two signal sources into one structured understanding of the screen:
//
//   1. DOM/URL signals (high precision, zero cost)  → page type + elements
//   2. ViT image classification (Xenova/vit-base-patch16-224, run adaptively
//      in the offscreen document)                   → visual scene + confidence
//
// Output contract (consumed by the agent prompt AND the benchmark suite):
//
//   {
//     "pageType": "checkout",
//     "confidence": 0.94,
//     "visualElements": ["product_card", "address_form", "payment_form"],
//     "scene": "screen-like",
//     "vitLabels": [{"label": "monitor", "score": 0.62}],
//     "sources": { "dom": true, "vit": false }
//   }
//
// PURE module — no chrome.* APIs, no DOM — safe for the SW, the offscreen
// document, and the Node benchmark suite.
// ─────────────────────────────────────────────────────────────────────────────

export const PAGE_TYPES = [
  'login', 'signup', 'checkout', 'payment', 'banking', 'profile',
  'dashboard', 'form', 'search', 'article', 'social', 'settings',
  'media', 'email', 'government', 'unknown',
];

// ── URL heuristics (path/host keywords per page type) ────────────────────────
const URL_SIGNALS = {
  login:     [/\/(login|signin|sign-in|auth|session)\b/i, /\baccounts?\.[a-z]+\.[a-z]+\/(login|signin)/i],
  signup:    [/\/(signup|register|create-account|join)\b/i],
  checkout:  [/\/(checkout|cart|basket|order)\b/i],
  payment:   [/\/(payment|pay|billing|subscribe)\b/i],
  banking:   [/\b(netbanking|net-banking|onlinebanking)\b/i, /\b(bank|banking|ifsc|neft|imps|upi)\b/i],
  search:    [/\/(search|results|query)\b/i, /\?(q|query|search|s)=/i],
  profile:   [/\/(profile|account|user|settings|my)\b/i],
  settings:  [/\/(settings|preferences|options)\b/i],
  article:   [/\b(blog|article|news|post|wiki)\b/i],
  media:     [/\/(watch|video|play|listen|album|track|movie|tv)\b/i, /\b(youtube|netflix|spotify|music)\b/i],
  email:     [/\b(mail|gmail|outlook|inbox)\b/i, /\/(mail|inbox|compose)\b/i],
  government:[/\b(gov|govt|nic\.in|sarkari|uidai|incometax|gst)\b/i],
};

// ── DOM-text heuristics (keyword → [weight, strength]) ──────────────────────────
// v1.14 CONFIDENCE FIX — each keyword is tagged STRONG ('s': a phrase specific
// to exactly one page type: "apply online", "account balance", "cvv", …) or
// WEAK ('w': generic vocabulary that appears on many page kinds: "portal",
// "payment", "submit", …).
//
// WHY: the browser matrix measured mixed-ui.html (a generic portal home whose
// TITLE is "Example Portal — Home") as "government" — the single generic word
// "portal" scored +1, was the ONLY entry on the scoreboard, and won by default
// at the 0.3 confidence floor. Any one generic word could hijack the type.
// The fix is a two-tier evidence rule (see classifyFromDomSignals): weak
// keywords can BREAK TIES or add mass, but can never alone decide the type.
// No page is special-cased — the rule is uniform over the whole vocabulary.
const TEXT_SIGNALS = {
  login:     [[/\bsign\s?in\b/i, 2, 's'], [/\blog\s?in\b/i, 2, 's'], [/\bforgot (your )?password\b/i, 3, 's'], [/\bremember me\b/i, 2, 's'], [/\bpassword\b/i, 1, 'w']],
  signup:    [[/\bsign\s?up\b/i, 2, 's'], [/\bregister\b/i, 2, 's'], [/\bcreate (an )?account\b/i, 3, 's'], [/\balready have an account\b/i, 2, 's']],
  checkout:  [[/\bcheckout\b/i, 2, 's'], [/\bplace (your )?order\b/i, 3, 's'], [/\badd to cart\b/i, 2, 's'], [/\bshopping (cart|bag)\b/i, 2, 's'], [/\border (summary|total)\b/i, 2, 's']],
  payment:   [[/\bcredit card\b/i, 2, 'w'], [/\bdebit card\b/i, 2, 'w'], [/\bcvv\b/i, 3, 's'], [/\bcard (number|holder)\b/i, 3, 's'], [/\bupi\b/i, 2, 'w'], [/\bnet ?banking\b/i, 2, 's'], [/\bpayment\b/i, 1, 'w']],
  banking:   [[/\baccount balance\b/i, 3, 's'], [/\bbeneficiary\b/i, 3, 's'], [/\bifsc\b/i, 3, 's'], [/\btransfer (funds|money)\b/i, 2, 's'], [/\bstatement\b/i, 1, 'w']],
  profile:   [[/\bmy (profile|account)\b/i, 3, 's'], [/\bpersonal (details|information)\b/i, 2, 's'], [/\bedit profile\b/i, 3, 's']],
  dashboard: [[/\bdashboard\b/i, 3, 's'], [/\boverview\b/i, 1, 'w'], [/\b(analytics|insights)\b/i, 2, 's'], [/\bwelcome back\b/i, 2, 's']],
  form:      [[/\bsubmit\b/i, 1, 'w'], [/\brequired\b/i, 1, 'w'], [/\bfill (in|out)\b/i, 2, 'w'], [/\bapplication\b/i, 1, 'w']],
  search:    [[/\bsearch (results|for)\b/i, 3, 's'], [/\bno results\b/i, 2, 's'], [/\bresults? found\b/i, 2, 's']],
  article:   [[/\bminutes? read\b/i, 3, 's'], [/\bposted (on|by)\b/i, 2, 'w'], [/\bcomments? \(\d+\)/i, 2, 's'], [/\btable of contents\b/i, 2, 's']],
  social:    [[/\bfeed\b/i, 2, 'w'], [/\bfollow(er)?s?\b/i, 2, 's'], [/\blike|share|comment\b/i, 1, 'w'], [/\btrending\b/i, 2, 's']],
  settings:  [[/\bsettings\b/i, 2, 's'], [/\bpreferences\b/i, 2, 'w'], [/\bmanage\b/i, 1, 'w'], [/\benable|disable\b/i, 1, 'w']],
  media:     [[/\bplay\b/i, 1, 'w'], [/\bpause\b/i, 2, 'w'], [/\bnow playing\b/i, 3, 's'], [/\bsubscribe\b/i, 1, 'w'], [/\bplaylist\b/i, 2, 's'], [/\bqueue\b/i, 1, 'w']],
  email:     [[/\bcompose\b/i, 3, 's'], [/\binbox\b/i, 3, 's'], [/\bsend\b/i, 1, 'w'], [/\bunread\b/i, 2, 's'], [/\bsubject\b/i, 1, 'w']],
  government:[[/\bgovernment\b/i, 2, 'w'], [/\bscheme\b/i, 2, 'w'], [/\bapply online\b/i, 3, 's'], [/\bcertificate\b/i, 2, 'w'], [/\bportal\b/i, 1, 'w']],
};

// A page-type decision requires STRONG evidence (a URL hit, a structural census
// signal, or ≥3 points of strong keyword mass) or overwhelming weak mass.
// Generic-word-only pages land on 'unknown' — honestly.
const DECIDE_MIN_STRONG = 3;
const DECIDE_MIN_TOTAL = 6;

// ── Visual-element vocabulary (derived from the DOM census) ──────────────────
const INPUT_LABEL = {
  password: 'password_field', email: 'email_field', search: 'search_box',
  tel: 'phone_field', checkbox: 'checkbox', radio: 'radio', file: 'file_upload',
  date: 'date_picker', number: 'number_input',
};

/**
 * Classify the page type from URL + page text + DOM census signals.
 * @param {object} p
 * @param {string} p.url      origin+pathname (+search when safe)
 * @param {string} p.title    document title
 * @param {string} p.text     page text (truncated is fine)
 * @param {object} p.dom      DOM census: { forms, inputs:{password,email,...},
 *                                     buttons, links, hasFileInput, priceHints, videos }
 * @returns {{
 *   scores: Record<string,number>,
 *   strongMass: number,   // URL hits + census signals + strong keywords
 *   weakMass: number,     // generic-keyword mass (tie-breaker only)
 *   urlMatches: string[], // which types the URL pointed at
 *   decided: boolean,     // false → the caller should treat this as 'unknown'
 *   best: {type, confidence}
 * }}
 */
export function classifyFromDomSignals({ url = '', title = '', text = '', dom = {} } = {}) {
  const scores = {};
  let strongMass = 0;
  let weakMass = 0;
  const urlMatches = [];
  const add = (type, w, strong) => {
    scores[type] = (scores[type] || 0) + w;
    if (strong) strongMass += w; else weakMass += w;
  };
  const hay = `${title}\n${String(text).slice(0, 4000)}`;

  for (const [type, patterns] of Object.entries(URL_SIGNALS)) {
    for (const re of patterns) {
      if (re.test(url)) { add(type, 4, true); urlMatches.push(type); break; }
    }
  }
  for (const [type, kws] of Object.entries(TEXT_SIGNALS)) {
    for (const [re, w, strength] of kws) {
      if (re.test(hay)) add(type, w, strength === 's');
    }
  }
  // DOM census contributions — STRUCTURAL signals are strong evidence
  if (dom.inputs?.password) add('login', 4, true);
  if (dom.inputs?.password && (dom.inputs?.email || dom.inputs?.text >= 2)) {
    add('login', 2, true);
    add('signup', 1, true);
  }
  if (dom.inputs?.cc || dom.autocomplete?.cc) add('payment', 5, true);
  if (dom.inputs?.search) add('search', 2, true);
  if (dom.priceHints) add('checkout', 2, true);
  if (dom.videos) add('media', 3, true);
  if (dom.composeEditor) add('email', 4, true);
  // A canvas surrounded by interactive controls is an application surface
  // (design editors, drawing tools, map apps) — the vocabulary's coarse class
  // for that is "form". Weight 3 = strong: canvases are structural, and this
  // must survive the canvas-app benchmark page on its own census.
  if (dom.canvases > 0 && dom.buttons >= 2) add('form', 3, true);

  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const decided = entries.length > 0 &&
    (strongMass >= DECIDE_MIN_STRONG || (strongMass + weakMass) >= DECIDE_MIN_TOTAL);

  let best = { type: 'unknown', confidence: 0.25 };
  if (decided) {
    const [topType, topScore] = entries[0];
    const runnerUp = entries[1]?.[1] ?? 0;
    // Confidence: score mass + margin over the runner-up, saturating at 0.98
    const raw = topScore / (topScore + 8) + Math.min(0.25, Math.max(0, (topScore - runnerUp) / 20));
    best = { type: topType, confidence: Math.min(0.98, Math.max(0.3, Number(raw.toFixed(2)))) };
  } else {
    // Weak-only or no evidence → unknown at honest low confidence. A generic
    // word like "portal" (the measured mixed-ui bug) can no longer win by default.
    best = { type: 'unknown', confidence: entries.length ? 0.28 : 0.25 };
  }
  return { scores, strongMass, weakMass, urlMatches, decided, best };
}

/**
 * Map ViT (ImageNet-1k) top-k labels to a coarse visual scene.
 * ImageNet has no "checkout" class — the ViT contributes the SCENE
 * (screen-like UI vs document vs photo) and a confidence signal, honestly
 * labelled with its source. The page type itself comes from DOM/URL unless
 * the DOM was too thin to decide (see classifyVisualContext).
 */
const VIT_SCENE_MAP = [
  { scene: 'screen-like', re: /\b(monitor|screen|desktop computer|laptop|notebook computer|computer keyboard|mouse|web site|website|television|hand-held computer|cellular telephone|remote control|computer keyboard)\b/i },
  { scene: 'document-like', re: /\b(menu|book jacket|comic book|paperback|envelope|file|binder| rubber eraser|rule)\b/i },
  { scene: 'media-photo', re: /\b(theater curtain|projector|home theater|cinema|telescope|microscope|painting|poster)\b/i },
  { scene: 'natural-photo', re: /\b(lakeside|seashore|valley|volcano|coral reef|forest|mountain|alp|cliff|sandbar|promontory)\b/i },
  { scene: 'people-photo', re: /\b(jersey|sweatshirt|suit|gown|abaya|fez|sombrero|cowboy hat|crash helmet|bikini|swimming trunks)\b/i },
];

export function mapVitLabelsToScene(vitLabels = []) {
  const top = (vitLabels || []).slice(0, 5);
  if (!top.length) return { scene: null, score: 0 };
  const scores = {};
  for (const { scene, re } of VIT_SCENE_MAP) {
    for (const l of top) {
      if (re.test(String(l.label || ''))) {
        scores[scene] = (scores[scene] || 0) + (Number(l.score) || 0);
      }
    }
  }
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { scene: 'unrecognized', score: top[0]?.score || 0 };
  return { scene: entries[0][0], score: Math.min(1, entries[0][1]) };
}

/**
 * Derive the visualElements vocabulary from the DOM census + page type.
 * @returns {string[]} element tags (bounded, judge-readable)
 */
export function deriveVisualElements(dom = {}, pageType = 'unknown') {
  const el = [];
  const inputs = dom.inputs || {};
  if (inputs.password) el.push('password_field');
  if (inputs.email) el.push('email_field');
  if (inputs.search) el.push('search_box');
  if (inputs.tel) el.push('phone_field');
  if (inputs.file || dom.hasFileInput) el.push('file_upload');
  if (inputs.cc || dom.autocomplete?.cc) el.push('payment_form');
  if ((dom.forms || 0) > 0) el.push('form');
  if ((dom.buttons || 0) > 0) el.push('button');
  if ((dom.links || 0) > 5) el.push('link_list');
  if ((dom.videos || 0) > 0) el.push('video_player');
  if (dom.composeEditor) el.push('text_editor');
  if (dom.priceHints) el.push('price_display');
  if (dom.dialogs) el.push('modal_dialog');
  // page-type-specific enrichments
  if (pageType === 'checkout' || pageType === 'payment') el.push('order_summary');
  if (pageType === 'login') el.push('credential_form');
  if (pageType === 'search') el.push('results_list');
  if (pageType === 'media') el.push('media_controls');
  return [...new Set(el)].slice(0, 12);
}

/**
 * FUSION ENTRY POINT — build the structured visual context.
 * @param {object} p       { url, title, text, dom }
 * @param {Array|null} vitLabels  ViT top-k labels when the adaptive gate ran
 *                                the classifier (null when skipped)
 * @returns structured visual context (see module header)
 */
export function classifyVisualContext(p = {}, vitLabels = null, extra = {}) {
  const domDecision = classifyFromDomSignals(p);
  const vit = mapVitLabelsToScene(vitLabels);
  const vitUsed = Boolean(vitLabels && vitLabels.length);

  // SIH v1.14 — EXPLICIT SOURCE ATTRIBUTION. Every perception result now says
  // WHERE each piece of evidence came from (the SIH brief requires
  // sources: { dom, url, vit, visualDetector }).
  //   dom      — always evaluated (free)
  //   url      — the URL heuristics that matched
  //   census   — structural DOM census signals (forms/inputs/videos/canvases…)
  //   vit      — the (adaptive, gated) image classifier scene
  //   visualDetector — pixel-level detectors that ran downstream in the
  //                    pipeline (faces / YOLO persons / OCR regions); the
  //                    caller enriches this after the pipeline runs.
  const censusSignals = [];
  const d = p.dom || {};
  if (d.inputs?.password) censusSignals.push('password_field');
  if (d.inputs?.cc || d.autocomplete?.cc) censusSignals.push('cc_field');
  if (d.inputs?.search) censusSignals.push('search_input');
  if (d.priceHints) censusSignals.push('price_hints');
  if (d.videos) censusSignals.push('videos');
  if (d.composeEditor) censusSignals.push('compose_editor');
  if (d.canvases > 0) censusSignals.push(`canvases(${d.canvases})`);
  if (d.forms) censusSignals.push(`forms(${d.forms})`);
  if ((d.buttons || 0) > 0) censusSignals.push(`buttons(${d.buttons})`);

  const sources = {
    dom: true, // backward-compatible boolean (the DOM pass always runs)
    url: { used: domDecision.urlMatches.length > 0, matched: domDecision.urlMatches },
    census: { used: censusSignals.length > 0, signals: censusSignals.slice(0, 10) },
    vit: { used: vitUsed, scene: vitUsed ? vit.scene : null, score: vitUsed ? vit.score : 0 },
    visualDetector: {
      used: Boolean(extra.visualDetector && extra.visualDetector.used),
      ...(extra.visualDetector || { faces: 0, objects: 0, ocrRegions: 0 }),
    },
  };

  let pageType = domDecision.best.type;
  let confidence = domDecision.best.confidence;
  let basis = domDecision.decided
    ? (domDecision.strongMass >= DECIDE_MIN_STRONG ? 'dom-strong' : 'dom-total')
    : 'insufficient-evidence';

  // Fusion rules (measured behaviour, SIH brief):
  //   HIGH DOM CONFIDENCE → trust DOM (ViT adds only a small scene-agreement
  //   bonus — or never runs at all: see shouldRunVisionClassifier).
  //   LOW DOM CONFIDENCE / UNKNOWN DOM:
  //     • THIN DOM (zero evidence mass at all — canvas apps, empty shells):
  //       the ViT scene ARBITRATES the coarse class — visual perception earns
  //       its keep exactly where the DOM knows nothing.
  //     • WEAK/MIXED DOM (only generic words — the measured mixed-ui case):
  //       the honest answer is 'unknown'; a coarse ViT scene must NOT invent
  //       a specific page type the DOM never supported.
  const thinDom = (domDecision.strongMass + domDecision.weakMass) === 0;
  if (!domDecision.decided) {
    if (thinDom && vitUsed) {
      if (vit.scene === 'document-like') pageType = 'article';
      else if (vit.scene === 'screen-like') pageType = 'form';
      else if (vit.scene === 'media-photo') pageType = 'media';
      if (pageType !== 'unknown') {
        basis = 'vit-arbitration';
        confidence = Math.min(0.75, 0.3 + 0.25 * (vit.score || 0.5));
      }
    }
    // weak/mixed DOM with ViT: pageType stays unknown, confidence stays low.
  } else if (vitUsed && vit.scene === 'screen-like') {
    // ViT agrees the screen is UI → small confidence bonus
    confidence = Math.min(0.98, confidence + 0.03);
  }

  return {
    pageType,
    confidence: Number(confidence.toFixed(2)),
    visualElements: deriveVisualElements(p.dom || {}, pageType),
    scene: vitUsed ? vit.scene : 'not-classified',
    vitLabels: vitUsed
      ? (vitLabels || []).slice(0, 3).map(l => ({ label: String(l.label), score: Number((l.score || 0).toFixed(2)) }))
      : [],
    sources,
    decision: {
      basis,
      strongMass: domDecision.strongMass,
      weakMass: domDecision.weakMass,
      topScores: Object.entries(domDecision.scores)
        .sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([type, score]) => ({ type, score })),
    },
  };
}

/**
 * ADAPTIVE GATE (SIH Phase 6) — decide whether the ViT should run for this
 * capture. Pure; the caller supplies the census + change flags.
 *
 *   DOM confident AND nothing visually uncertain  → SKIP (saves ~85 MB load
 *                                                    + inference ms)
 *   thin/unknown DOM OR media/canvas-heavy page   → RUN
 *
 * @param {object} p
 * @param {{type:string,confidence:number}} p.domBest   classifyFromDomSignals().best
 * @param {boolean} p.pageChanged     page fingerprint changed since last step
 * @param {boolean} p.visuallyHeavy   videos/canvas/images dominate the page
 * @param {boolean} p.enabled         user-level switch (default true)
 */
export function shouldRunVisionClassifier({ domBest = { type: 'unknown', confidence: 0 }, pageChanged = true, visuallyHeavy = false, enabled = true } = {}) {
  if (!enabled) return { run: false, reason: 'disabled' };
  if (!pageChanged) return { run: false, reason: 'page-unchanged' };
  if (visuallyHeavy) return { run: true, reason: 'visually-heavy' };
  if (domBest.type === 'unknown' || domBest.confidence < 0.55) {
    return { run: true, reason: 'visual-uncertainty' };
  }
  return { run: false, reason: 'dom-sufficient' };
}
