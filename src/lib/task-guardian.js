// ─────────────────────────────────────────────────────────────────────────────
// src/lib/task-guardian.js — v1.18.0 TASK AUTHORIZATION GUARDIAN
//
// Safety layer designed during SIH competitor research (re-implemented from
// scratch, zero code shared): a click that COMMITS MONEY (purchase) or
// DESTROYS DATA (deletion)
// must be explicitly authorized by the USER'S OWN TASK TEXT before the agent
// may execute it. Fail-closed: when the task does not clearly authorize the
// risky class, the action is rejected BEFORE the approval gate / executor.
//
// Design properties (all deliberate):
//   • Authorization evidence comes ONLY from the user (task text + mid-run
//     user notes). The model's thought, page text and history are NEVER
//     consulted for authorization — a prompt-injected page cannot talk its
//     way past this gate.
//   • Negation windows: "do not buy anything", "compare without buying",
//     "track my order" (order-status context) do NOT authorize.
//   • Fail-closed default: empty/missing task ⇒ BLOCKED.
//   • Pure & synchronous: regex-only, sub-millisecond, zero network, no DOM
//     dependency — safe to run on every plan (primary AND queued) in both
//     the privacy loop and the standard loop.
//   • v1.19.0: HINDI (Devanagari) task-text matching — authorization intent,
//     element triggers, benign-context suppression and BOTH negation orders
//     ("मत खरीदो" pre-verbal AND "खरीदो मत" post-verbal) are recognized.
//     JS `\b` is ASCII-only (it NEVER matches around Devanagari letters), so
//     Hindi patterns deliberately use substring/variant matching with
//     explicit suffix forms instead of word boundaries.
//   • A rare false BLOCK costs one ask_user round-trip; a false ALLOW would
//     cost real money/data — the asymmetry justifies strictness.
//
// Known honest limitations (documented in docs/changelog/v1.19.0.md):
//   • Classification is plan-level: it reads the model's declared target
//     label (action.selector) / navigate URL. It cannot see pixels.
//   • press_key Enter / key submission are not classifiable (no label) —
//     they remain covered by the page-fingerprint verifier and ask-mode.
// ─────────────────────────────────────────────────────────────────────────────

export const GUARDIAN_VERSION = 'v1.19.0';

// Negation cues searched in the 28-char window immediately BEFORE an
// authorization phrase. "don't buy" must not authorize "Buy Now".
const NEGATION_RE =
  /\b(?:do\s*not|don'?t|don’?t|never|no\s+need\s+to|avoid|without|stop|rather\s+than|instead\s+of|refrain\s+from|other\s+than|except)\b/i;
// Explicit "no purchases / no buying / no deleting" style bans.
const BAN_RE =
  /\bno\s+(?:purchases?|buying|shopping|deleting|deletions?|removing|payments?|orders?)\b/i;
// v1.19.0 POST-VERBAL Hindi negation. Hindi negators usually FOLLOW the verb
// ("खरीदो मत" = don't buy, "खरीदना ज़रूरी नहीं" = needn't buy) — the English
// before-window cannot see them. The after-window is DEVANAGARI-ONLY on
// purpose: English prose can never contain मत/नहीं/बिना, so the extra window
// can never falsely negate an English authorization phrase. 16 chars covers
// "खरीदना ज़रूरी नहीं" (negator two words after the verb).
// The SAME regex also joins the BEFORE window — pre-verbal negation
// ("मत खरीदो", "कुछ भी मत खरीदो") is equally natural in Hindi, and a
// Devanagari-only before-window can still never fire on English prose.
const HINDI_NEGATION_RE = /मत|नहीं|कभी\s*नहीं|बिना/;
const HINDI_NEGATION_AFTER_RE = HINDI_NEGATION_RE;

// ── Risk taxonomy ────────────────────────────────────────────────────────────
// triggers    — the ELEMENT side: patterns on the click label / URL that make
//               an action risky. Conservative on purpose.
// auth        — the USER side: ordered authorization phrases (task text or
//               mid-run user notes). `suppress` phrases mark benign contexts
//               ("track my order", "payment status") that do NOT authorize.
// authHint    — human-readable summary for the UI / strategy hint.
const RISK_CLASSES = {
  purchase: {
    id: 'purchase',
    authHint: 'buy / purchase / order / checkout / pay / subscribe / book / transfer',
    triggers: [
      /\bbuy\b/i,
      /\badd\s*to\s*(?:cart|bag|basket)\b/i,
      /\bcheck\s*-?\s*out\b|\bcheckout\b/i,
      /\bplace\s*(?:your\s*|my\s*|an?\s*)?order\b|\border\s*now\b/i,
      /\bproceed\s*to\s*(?:checkout|payment|pay)\b/i,
      /\bcontinue\s*to\s*(?:payment|checkout)\b/i,
      /\bpay\b|\bpay\s*now\b|\bmake\s*(?:a\s*)?payment\b/i,
      /\bcomplete\s*(?:purchase|order|payment|booking)\b/i,
      /\bconfirm\s*(?:order|payment|purchase|booking)\b/i,
      /\bfinalize\s*(?:order|purchase)\b/i,
      /\bsubscribe\b|\bstart\s*(?:my\s*)?subscription\b/i,
      /\brenew\b/i,
      /\bupgrade\s*(?:now|plan|my\s*plan)?\b/i,
      /\bbook\s*now\b|\breserve\s*now\b/i,
      /\bsend\s*money\b|\btransfer\b|\bwithdraw\b/i,
      /\bdonate\b|\bdonation\b/i,
      // v1.19.0 Hindi (Devanagari) ELEMENT triggers — Indian e-commerce
      // labels (Flipkart/IRCTC-style Hindi UIs). Substring matching on
      // purpose (\b never matches Devanagari). Bare "रद्द" (dialog Cancel)
      // stays NOT risky — mirrors the bare-"Cancel" decision above.
      /ख़?रीद(?:ें|ेन|ो|ना|ने|ी|िए|कर)/,            // खरीदें / अभी खरीदें / खरीदो / खरीदना
      /(?:कार्ट|बैग|बास्केट)\s*में\s*(?:डालें|जोड़ें|डालो)/, // Add to Cart/Bag
      /चेक\s*आउट|चेकआउट/,                          // Checkout
      /भुगतान(?:\s*करें|\s*करो)?/,                 // भुगतान / भुगतान करें (payment)
      /पेमेंट\s*करें/,                              // पेमेंट करें
      /ऑर्डर\s*(?:करें|करो|प्लेस|now)/i,           // ऑर्डर करें / Place Order
      /सब्सक्राइब|सब्सक्रिप्शन\s*(?:लें|शुरू)/,     // Subscribe / start subscription
      /बुक\s*(?:करें|करो)|अभी\s*बुक/,              // बुक करें (book — verb)
      /रिन्यू|नवीनीकरण/,                            // Renew
      /अपग्रेड/,                                    // Upgrade
      /पैस[ेा]\s*(?:भेज|ट्रांसफर|ट्रान्सफर)/,       // Send money / transfer money
      /दान\s*(?:करें|करो)|चंदा/,                    // Donate
    ],
    urlTriggers: [/\/checkout/i, /\/payment/i, /\/place-order/i, /\/order-now/i, /\/subscription\/(?:new|start)/i],
    auth: [
      { tag: 'buy',              re: /\bbuy(?:s|ing)?\b/i },
      { tag: 'purchase',         re: /\bpurchas(?:e|es|ed|ing)\b/i },
      { tag: 'place order',      re: /\bplace(?:s|d)?\s+(?:an?\s+|my\s+|the\s+|your\s+)?order\b/i },
      { tag: 'checkout',         re: /\bcheck\s*-?\s*out\b|\bcheckout\b/i,
        suppress: /\bcheck\s*-?\s*out\b(?!\s*(?:with|using|via|now|and\s*pay))/i },
      { tag: 'pay',              re: /\bpay(?:ment|ments|s|ing)?\b/i,
        suppress: /\bpayment\s*(?:status|history|methods?|options?|reminders?|settings)\b|\bpay\s*(?:stub|slip|grade|scale)\b/i },
      { tag: 'subscribe',        re: /\bsubscrib(?:e|es|ed|ing)\b/i },
      { tag: 'renew',            re: /\brenew(?:s|ed|ing|al)?\b/i },
      { tag: 'upgrade',          re: /\bupgrad(?:e|es|ed|ing)\b/i },
      { tag: 'book',             re: /\bbook(?:ing|ed|s)?\b/i,
        suppress: /\b(?:read|reading|wrote|writing|return(?:ing)?)\b[^.;]{0,24}\bbooks?\b|\bbooks?\b\s*(?:club|report|review|list|shelf|author)/i },
      { tag: 'order intent',     re: /\borders?\b|\border(?:ed|ing)\b/i,
        suppress: /\border\s*(?:status|history|tracking|details|number|id|summary)\b|\b(?:track|tracking|check|view|see|find|follow)\b[^.;]{0,30}\border/i },
      { tag: 'money transfer',   re: /\btransfer\b[^.;]{0,24}\b(?:money|funds|amount|\u20b9|\$)\b|\bsend\s+money\b|\bwithdraw\b/i },
      { tag: 'donate',           re: /\bdonat(?:e|es|ed|ing|ion|ions)\b/i },
      // ── v1.19.0 Hindi authorization phrases (user task / mid-run notes) ──
      { tag: 'खरीद (buy)',       re: /ख़?रीद/, suppress: /ख़?रीद(?:ारी)?\s*(?:सूची|लिस्ट|इतिहास)/ },
      { tag: 'ऑर्डर (order)',    re: /ऑर्डर|आर्डर/,
        suppress: /(ऑर्डर|आर्डर)[^.;]{0,16}(स्टेटस|ट्रैक|हिस्ट्री|इतिहास|नंबर|आईडी|डिटेल|सूची|लिस्ट)|ट्रैक[^.;]{0,16}(ऑर्डर|आर्डर)/ },
      { tag: 'चेकआउट (checkout)',re: /चेक\s*आउट|चेकआउट/ },
      { tag: 'भुगतान (pay)',     re: /भुगतान|पेमेंट/,
        suppress: /(भुगतान|पेमेंट)[^.;]{0,16}(स्टेटस|हिस्ट्री|तरीक[ेा]|मोड|रसीद)|पेमेंट\s*बैलेंस/ },
      { tag: 'सब्सक्राइब',       re: /सब्सक्राइब|सब्सक्रिप्शन/,
        suppress: /(सब्सक्रिप्शन|सब्सक्राइब)[^.;]{0,16}(स्टेटस|डिटेल|मैनेज|देख|चेक)/ },
      { tag: 'बुक (book)',       re: /बुक\s*(?:कर|करें|करो|कीजिए)/, suppress: /बुक[^.;]{0,12}(पढ़|समीक्षा|रिव्यू)/ },
      { tag: 'रिन्यू (renew)',   re: /रिन्यू|नवीनीकरण/ },
      { tag: 'अपग्रेड',          re: /अपग्रेड/ },
      { tag: 'पैसे भेजें',       re: /पैस[ेा]?(?:ों)?\s*(?:भेज|ट्रांसफर|ट्रान्सफर)|ट्रांसफर\s*(?:कर|कीजिए)/ },
      // "दान" must not match inside "प्रदान" (to provide) — the lookalike
      // guard requires a NON-Devanagari char (or string start) before it.
      { tag: 'दान (donate)',     re: /(?:^|[^\u0900-\u097F])दान\s*(?:कर|करें|करो)|चंदा/ },
    ],
  },

  deletion: {
    id: 'deletion',
    authHint: 'delete / remove / trash / discard / clear / cancel / revoke / uninstall / wipe',
    triggers: [
      /\bdelete\b/i,
      /\bpermanently\s*delete\b/i,
      /\bremove\b/i,
      /\btrash\b/i,
      /\bdiscard\b/i,
      /\bempty\s*(?:trash|bin|cart|spam)\b/i,
      /\bclear\s*(?:all|history|cart|data|browsing|cookies|cache|everything)\b/i,
      /\brevoke\b/i,
      /\buninstall\b/i,
      /\berase\b|\bwipe\b/i,
      /\bdeactivate\s*(?:my\s*)?account\b/i,
      /\bcancel\s*(?:my\s*)?(?:subscription|order|account|plan|booking|reservation|membership)\b/i,
      /\bclose\s*(?:my\s*)?account\b/i,
      // v1.19.0 Hindi deletion ELEMENT triggers.
      /डिलीट/,                    // डिलीट / डिलीट करें
      /हटा(?:ओ|एं|एँ|यें)/,        // हटाओ / हटाएं / हटाएँ / रिमोव
      /मिटा(?:ओ|एं|एँ)/,           // मिटाओ / मिटाएं
      /रद्द\s*(?:करें|करो)/,       // रद्द करें (bare रद्द = dialog Cancel → NOT risky)
      /ट्रैश/,                     // Move to Trash
      /खाली\s*करें/,               // खाली करें (empty)
      /साफ़?\s*करें/,              // साफ़ करें (clear)
      /अनइंस्टॉल/,                 // Uninstall
      /(अकाउंट|खाता)\s*बंद/,       // Close account
    ],
    urlTriggers: [/\/delete/i, /\/account\/(?:close|deactivate)/i],
    auth: [
      { tag: 'delete',    re: /\bdelet(?:e|es|ed|ing|ion)\b/i },
      { tag: 'remove',    re: /\bremov(?:e|es|ed|ing|al)\b/i },
      { tag: 'trash',     re: /\btrash\b/i },
      { tag: 'discard',   re: /\bdiscard(?:s|ed|ing)?\b/i },
      { tag: 'clear',     re: /\bclear(?:s|ed|ing)?\b/i },
      { tag: 'erase',     re: /\beras(?:e|es|ed|ing)\b/i },
      { tag: 'wipe',      re: /\bwip(?:e|es|ed|ing)\b/i },
      { tag: 'uninstall', re: /\buninstall(?:s|ed|ing)?\b/i },
      { tag: 'cancel',    re: /\bcancel(?:s|ed|ling|led|ing)?\b/i },
      { tag: 'revoke',    re: /\brevok(?:e|es|ed|ing)\b/i },
      { tag: 'deactivate',re: /\bdeactivat(?:e|es|ed|ing)\b/i },
      { tag: 'close account', re: /\bclose\s+(?:my\s+|the\s+)?account\b/i },
      { tag: 'empty trash',   re: /\bempty\s+(?:the\s+)?(?:trash|bin|cart|spam)\b/i },
      // ── v1.19.0 Hindi deletion authorization phrases ─────────────────────
      { tag: 'डिलीट',      re: /डिलीट/ },
      { tag: 'हटाओ',       re: /हटा(?:ओ|एं|एँ|ना|ने|कर|\s*दो|\s*दें|\s*दीजिए|या|ई|यें)?/ },
      { tag: 'मिटाओ',      re: /मिटा(?:ओ|एं|एँ|ना|ने|कर|\s*दो|\s*दें)?/ },
      { tag: 'रद्द',        re: /रद्द\s*(?:कर|करें|करो|कीजिए)?/ },
      { tag: 'खाली करें',  re: /खाली\s*कर/ },
      { tag: 'साफ़ करें',  re: /साफ़?\s*कर(?:ो|ें|ना|ने)?/ },
      { tag: 'ट्रैश',       re: /ट्रैश|कचर[ेा]/ },
      { tag: 'अनइंस्टॉल',  re: /अनइंस्टॉल/ },
      { tag: 'अकाउंट बंद', re: /(अकाउंट|खाता)\s*बंद/ },
      { tag: 'एक्सेस वापस',re: /(एक्सेस|अधिकार)\s*वापस\s*(?:लो|लें|लो|लीजिए)/ },
    ],
  },
};

const LABEL_ACTIONS = new Set(['click', 'submit', 'fill', 'type']);
const URL_ACTIONS = new Set(['navigate', 'new_tab']);

function firstMatch(reList, text) {
  for (const re of reList) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/**
 * Classify a planned action against the risk taxonomy.
 * @param {object} action  The model's planned action ({type, selector, url, …})
 * @returns {null | { class, classDef, label, phrase, where, actionType }}
 *   null = not a risky action.
 */
export function classifyRiskyAction(action) {
  if (!action || typeof action !== 'object') return null;
  const type = String(action.type || '');

  if (LABEL_ACTIONS.has(type)) {
    // The model's declared label for the target element. Same trust level as
    // describeAction() — page-derived data used as evidence, never as auth.
    const label = String(action.selector || action.text || '').trim();
    if (!label) return null;
    for (const classDef of Object.values(RISK_CLASSES)) {
      const phrase = firstMatch(classDef.triggers, label);
      if (phrase) {
        return { class: classDef.id, classDef, label, phrase, where: 'selector', actionType: type };
      }
    }
    return null;
  }

  if (URL_ACTIONS.has(type)) {
    const url = String(action.url || '').trim();
    if (!url) return null;
    for (const classDef of Object.values(RISK_CLASSES)) {
      const phrase = firstMatch(classDef.urlTriggers, url);
      if (phrase) {
        return { class: classDef.id, classDef, label: url, phrase, where: 'url', actionType: type };
      }
    }
    return null;
  }

  return null;
}

/**
 * Search ONE text (task or note) for an authorization phrase of the class.
 * Negation-aware: each occurrence is checked for a negation cue in the
 * preceding window; suppressed contexts (e.g. "track my order") never count.
 */
function findAuthorizationInText(classDef, text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  let sawNegated = false;
  for (const spec of classDef.auth) {
    // Suppressed benign contexts never authorize (e.g. "track my order").
    if (spec.suppress && spec.suppress.test(t)) continue;
    const re = new RegExp(spec.re.source, 'gi');
    let m;
    while ((m = re.exec(t)) !== null) {
      const before = t.slice(Math.max(0, m.index - 28), m.index);
      // v1.19.0: Hindi negators FOLLOW the verb ("खरीदो मत", "खरीदना ज़रूरी
      // नहीं") — a Devanagari-only AFTER window (16 chars) catches them and
      // can never match English prose, so no English regression is possible.
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + 16);
      if (NEGATION_RE.test(before) || BAN_RE.test(before) || HINDI_NEGATION_RE.test(before) || HINDI_NEGATION_AFTER_RE.test(after)) {
        sawNegated = true; // this occurrence is negated — keep scanning others
        continue;
      }
      return { authorized: true, source: null, matched: spec.tag, negated: false, from: t.slice(m.index, m.index + m[0].length) };
    }
  }
  return sawNegated ? { authorized: false, source: null, matched: null, negated: true } : null;
}

/**
 * Does the user's own text (task + mid-run notes) authorize the risky class?
 * @param {object} risk        classifyRiskyAction() result
 * @param {string} taskText    The user's task
 * @param {string[]} extraTexts Optional mid-run user notes (LIVE USER CONTEXT)
 */
export function isAuthorizedByTask(risk, taskText, extraTexts = []) {
  const classDef = risk?.classDef;
  if (!classDef) return { authorized: true, source: null, matched: null, negated: false };

  const texts = [
    { text: taskText, src: 'task' },
    ...extraTexts.map(n => ({ text: n, src: 'note' })),
  ];
  let sawNegated = false;
  for (const { text, src } of texts) {
    const hit = findAuthorizationInText(classDef, text);
    if (!hit) continue;
    if (hit.authorized) return { ...hit, source: src };
    if (hit.negated) sawNegated = true; // negated occurrences → still fail-closed
  }
  return { authorized: false, source: null, matched: null, negated: sawNegated };
}

/**
 * THE gate. Pure function — call before every primary AND queued action.
 *
 * @param {object}   action              Planned action
 * @param {object}   opts
 * @param {string}   opts.taskText       User's task text
 * @param {string[]} [opts.extraTexts]   Mid-run user notes
 * @returns {object} verdict
 *   { blocked:false }                              — harmless action, pass
 *   { blocked:false, authorized:…, risk:… }        — risky but user-authorized
 *   { blocked:true, risk, reason, userMessage }    — FAIL-CLOSED rejection
 */
export function guardAction(action, { taskText = '', extraTexts = [] } = {}) {
  const risk = classifyRiskyAction(action);
  if (!risk) return { blocked: false, risk: null, auth: null };

  const auth = isAuthorizedByTask(risk, taskText, extraTexts);
  if (auth.authorized) {
    return { blocked: false, risk, auth, reason: null, userMessage: null };
  }

  const kind = risk.class === 'purchase' ? 'purchase' : 'deletion';
  const what = risk.where === 'url'
    ? `navigation to a ${kind} page`
    : `clicking "${risk.label.slice(0, 60)}"`;
  // v1.19.0: authorization examples now include Hindi phrasings so a Hindi
  // task author immediately knows what unlocks the action.
  const hindiExample = kind === 'purchase'
    ? 'buy … / "… खरीदना है"'
    : 'delete … / "… डिलीट कर दो"';
  return {
    blocked: true,
    risk,
    auth,
    reason: `unauthorized ${kind} action — ${what} is classified as ${kind}, and the user's task text does not authorize ${kind}s`,
    userMessage:
      `🛡️ Task Authorization Guardian blocked ${what} — a ${kind} action. ` +
      `Your task doesn't authorize ${kind}s. To allow it, add it to the task ` +
      `(e.g. "${hindiExample}") or send a note like ` +
      `"you may complete the ${kind}" / "आप ${kind === 'purchase' ? 'खरीद' : 'डिलीट'} सकते हैं" while the task runs.`,
  };
}

/** Strategy hint injected into the NEXT decision prompt after a block. */
export function guardianStrategyHint(verdict) {
  const kind = verdict?.risk?.class === 'purchase' ? 'purchases' : 'deletions';
  return (
    `TASK AUTHORIZATION GUARDIAN: your proposed action was BLOCKED as an unauthorized ${kind.slice(0, -1)} action — ` +
    `the user's task text does not authorize ${kind}. Do NOT retry this target or a re-labeled equivalent. ` +
    `If the user's goal genuinely requires it, reply with {"type":"ask_user"} and ask them to explicitly authorize it ` +
    `(they can approve or send a note); otherwise continue with a read-only or non-committal path.`
  );
}

/** Exposed for tests/docs. */
export const _internals = { RISK_CLASSES, NEGATION_RE, BAN_RE, HINDI_NEGATION_RE, HINDI_NEGATION_AFTER_RE, findAuthorizationInText };
