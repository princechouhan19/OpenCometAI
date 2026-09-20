// src/lib/pii-detector.js
// Lightweight PII / sensitive-text detector that runs ENTIRELY client-side.
// Combines deterministic regex patterns (high precision, zero model cost)
// with optional Transformers.js NER (Named Entity Recognition) for catching
// free-form names / organisations / addresses that don't follow a pattern.
//
// Output schema (used by privacy-filter.js + canvas-redactor.js):
//   {
//     type:        'email' | 'phone' | 'credit_card' | 'ssn' | 'aadhaar'
//                  | 'pan' | 'iban' | 'api_key' | 'password' | 'url_cred'
//                  | 'ip' | 'dob' | 'person' | 'org' | 'address'
//                  | 'voter_id' | 'passport' | 'driving_license' | 'ifsc'
//                  | 'upi' | 'bank_account' | 'gstin',
//     value:       string,           // the redacted-text view (masked)
//     raw:         string,           // original (kept only in-memory, NEVER sent)
//     start:       number,           // char offset
//     end:         number,
//     confidence:  number,           // 0..1
//     source:      'regex' | 'ner' | 'dom',
//   }

/** Mask helper — keeps first/last char, replaces middle with • */
export function maskValue(str, keep = 1) {
  if (!str) return '';
  if (str.length <= keep * 2) return '•'.repeat(str.length);
  return str.slice(0, keep) + '•'.repeat(Math.min(str.length - keep * 2, 12)) + str.slice(-keep);
}

// Deterministic regex patterns
// Each pattern: { type, re, confidence, preprocessor? }
const REGEX_PATTERNS = [
  // Email (also covers indented/quoted forms)
  {
    type: 'email',
    re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    confidence: 0.99,
  },
  // International / Indian phone numbers. Word-boundary guards (lookbehind /
  // lookahead) stop mid-token matches such as the digit tail of an IBAN
  // ("…L435861152"). Groups widened to {3,5} so the common Indian mobile
  // grouping "+91 XXXXX XXXXX" (5+5) is covered.
  {
    type: 'phone',
    re: /(?<![A-Za-z0-9])(?:(?:\+|00)\d{1,3}[\s.-]?)?(?:\(?(\d{3,4})\)?[\s.-]?)?\d{3,5}[\s.-]?\d{3,5}(?:[\s.-]?\d{1,5})?(?![A-Za-z0-9])/g,
    confidence: 0.75,
  },
  // Credit card (Visa/MC/Amex/Discover, optional separators, 13-19 digits).
  // GREEDY units: the lazy form used to match a 13-16 digit PREFIX of a longer
  // run, fail Luhn on the prefix, and silently drop a valid card.
  {
    type: 'credit_card',
    re: /\b(?:\d[ -]*){13,19}\b/g,
    confidence: 0.85,
  },
  // US SSN
  {
    type: 'ssn',
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
    confidence: 0.99,
  },
  // Indian Aadhaar (12 digits; space, hyphen or no separator — the hyphen-
  // separated form is how printed/physical cards render it, e.g.
  // 1234-5678-9012). Verhoeff-validated below:
  // strong (checksum-valid) fires bare, checksum-failures need a keyword.
  {
    type: 'aadhaar',
    re: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    confidence: 0.90,
  },
  // Indian PAN (ABCDE1234F)
  {
    type: 'pan',
    re: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
    confidence: 0.95,
  },
  // — PARTIAL / MID-ENTRY PAN ("ABCDE1234", check letter not yet
  // typed). Field-reported leak: a live gov-form screenshot showed exactly
  // this, and the strict 10-char pattern above correctly (but unhelpfully)
  // ignored it. The bare 9-char form is context-gated: a PAN keyword within
  // the ±40 window (+0.25/0.30) lifts 0.60 over the 0.85 threshold; without
  // that label ("HOUSE1234", "ROUTE2024") it never redacts.
  {
    type: 'pan',
    re: /\b[A-Z]{5}\d{4}\b/g,
    confidence: 0.60,
  },
  // IBAN (country code + 13-34 digits)
  {
    type: 'iban',
    re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,32}\b/g,
    confidence: 0.85,
  },
  // API keys — common prefixes
  {
    type: 'api_key',
    re: /\b(?:sk|pk|rk|AKIA|ghp|gho|ghu|ghs|xoxb|xoxp|AIza)[A-Za-z0-9_\-]{16,}\b/g,
    confidence: 0.93,
  },
  // Bearer / Authorization headers rendered on screen
  {
    type: 'api_key',
    re: /\bBearer\s+[A-Za-z0-9._\-]{16,}/g,
    confidence: 0.95,
  },
  // URL with embedded credentials: https://user:pass@host
  {
    type: 'url_cred',
    re: /\bhttps?:\/\/[^/\s:@]+:[^/\s:@]+@[^\s/]+/g,
    confidence: 0.99,
  },
  // IPv4 (excludes version numbers like 1.2.3)
  {
    type: 'ip',
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    confidence: 0.80,
  },
  // Date of birth (common formats)
  {
    type: 'dob',
    re: /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2})\b/g,
    confidence: 0.65,
  },
  // — PASSWORD / TOKEN assignments in TEXT (incl. OCR output).
  // A rendered screen that shows "Password: hunter2" or "token=eyJ…" must be
  // redacted even though the DOM saw nothing. Requires a secret-LIKE value
  // (contains a digit, or is a quoted string) so prose such as
  // "Password: required" never matches (same rule as the firewall sweep).
  // the lookaheads are BOUNDED TO THE VALUE RUN. (?=.*\d) anchored
  // at the value start but scanned to END OF the scanned string, and the OCR
  // full-page reconstruction is ONE newline-free blob — so mere prose mentions
  // ("three literal token formats", "four surviving secret families:",
  // "Google key contiguity,") matched whenever ANY digit appeared later on
  // the page (field report: black boxes over safe chat prose). The digit (and
  // letter, where specified) must now sit INSIDE the candidate value; every
  // real assignment still fires (v1158 TP controls + fuzz + PII corpus).
  {
    type: 'password',
    re: /\b(?:password|passwd|pwd|pass)\s*(?:[:=]\s*|\s+)(?:['"][^'"]{4,}['"]|(?=[^\s'"]*\d)[^\s'"]{5,})/gi,
    confidence: 0.92,
  },
  {
    type: 'api_key',
    re: /\b(?:token|secret(?:\s+key)?|api[-_]?key|key)\s*(?:[:=]\s*|\s+)(?:['"][^'"]{4,}['"]|(?=[A-Za-z0-9_.\-+\/=]*\d)(?=[A-Za-z0-9_.\-+\/=]*[A-Za-z])[A-Za-z0-9_.\-+\/=]{6,})/gi,
    confidence: 0.90,
  },
  // — POSTAL / ZIP codes in ADDRESS context. A bare 5/6-digit run
  // is an order id until the surrounding ±80 chars say "address". The context
  // scorer enforces that: without an address keyword the base 0.65 sits below
  // the 0.70 threshold and the candidate is dropped (precision lever).
  {
    type: 'address',
    re: /\b(?:\d{6}|\d{5}(?:-\d{4})?)\b/g,
    confidence: 0.65,
  },

  // SIH INDIAN GOVERNMENT / FINANCIAL ID EXPANSION
  // The original set covered Aadhaar + full PAN only; India's on-screen PII
  // surface is much wider (Voter ID, passport, driving licence, IFSC, UPI
  // VPA, GSTIN, bank accounts, CVV, Aadhaar VID). Patterns follow the same
  // candidate → validator → context-scorer → threshold pipeline as above:
  // checksum-able formats fire bare; free-form ones need their label nearby.
  //
  // Aadhaar Virtual ID (VID, 16 digits, same Verhoeff family as Aadhaar —
  // see verhoeffValid() which now accepts 12 OR 16 digits). A 16-digit run
  // also matches the credit_card candidate, but a non-Luhn run is dropped by
  // the card validator and lands here; a Verhoeff-VALID run wins in dedupe.
  {
    type: 'aadhaar',
    re: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    confidence: 0.62,
  },
  // Voter ID / EPIC (e.g. ABC1234567) — 3 letters + 7 digits, specific
  // enough to fire without context (threshold 0.70).
  {
    type: 'voter_id',
    re: /\b[A-Z]{3}\d{7}\b/g,
    confidence: 0.80,
  },
  // Indian passport number (current series: letter + 7 digits, e.g.
  // A1234567). Far too collision-prone to fire bare — only redacts when a
  // passport keyword sits within ±40 chars (0.50 + 0.25 ≥ 0.70 threshold).
  {
    type: 'passport',
    re: /\b[A-Z]\d{7}\b/g,
    confidence: 0.50,
  },
  // Driving licence (state code + RTO + issue year + serial, e.g.
  // MH12 20110001234; separators optional, serial 6-8 digits by state).
  // Needs its label nearby, same gate as passport.
  {
    type: 'driving_license',
    re: /\b[A-Z]{2}[-\s]?\d{2}[-\s]?(?:19|20)\d{2}[-\s]?\d{6,8}\b/g,
    confidence: 0.55,
  },
  // IFSC (e.g. HDFC0000123) — 4 bank letters + literal 0 + 6 alphanumerics,
  // exactly 11 chars with boundaries. Structure alone is near-unambiguous.
  {
    type: 'ifsc',
    re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    confidence: 0.78,
  },
  // UPI VPA (e.g. prince@okhdfcbank, name@paytm, name@ybl). Handle list is
  // the known PSP/bank namespaces; e-mail never matches (its handle carries
  // a dot TLD, none of these do).
  // SPLIT — precision fix: the previous single pattern carried the
  // catch-all ok[a-z]{2,12} at confidence 0.88, so ANY handle@ok<word> fired
  // bare ("team@okcomputer" — an ordinary .com-style handle — was pixelated).
  // Now: (a) KNOWN PSP namespaces stay strong (0.88, fire bare); (b) the
  // generic ok* catch-all drops to 0.60 — below the 0.70 threshold — so it
  // only redacts when a UPI/VPA/pay keyword sits in its ±80 context window.
  {
    type: 'upi',
    re: /\b[a-zA-Z0-9][a-zA-Z0-9._-]{1,40}@(?:okaxis|oksbi|okicici|okhdfcbank|paytm|ybl|ibl|axl|apl|icici|yapl|aubank|ikwik|airtel|slice|jupiteraxis|federal|finobank|indusind|payzapp|fbl|upi)\b/g,
    confidence: 0.88,
  },
  {
    type: 'upi',
    re: /\b[a-zA-Z0-9][a-zA-Z0-9._-]{1,40}@ok[a-z]{2,12}\b/g,
    confidence: 0.60,
  },
  // GSTIN (15 chars, e.g. 27ABCDE1234F1Z5) — embeds a PAN at chars 3-12, so
  // both candidates fire; GSTIN is priced 0.97 > PAN 0.95 so the dedupe
  // keeps the LONGER span (otherwise "27…1Z5" edges would stay visible).
  {
    type: 'gstin',
    re: /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g,
    confidence: 0.97,
  },
  // Bank account number — digits only via variable-length lookbehind so the
  // LABEL never lands inside the match (mask leaks nothing). Requires the
  // account label glued to the digits (≤4 separator chars) for precision.
  {
    type: 'bank_account',
    re: /(?<=\b(?:a\/c|acct|account)[\s._-]*(?:no\.?|number|#)?[\s.:=-]{0,4})\d{9,18}\b/gi,
    confidence: 0.90,
  },
  // CVV / card PIN — label+value as ONE secret span (password mask reveals
  // nothing). Mirrors the password/token assignment patterns above.
  {
    type: 'password',
    re: /\b(?:cvv|cvc|csc|card\s*pin)\s*(?:[:=]\s*|\s+)\d{3,4}\b/gi,
    confidence: 0.95,
  },
];

// DOM-driven sensitive-field detection
// Inspects element type/attributes — these are extremely high-confidence
// because the page itself is telling us "this is sensitive".
//
// Returns an array of { type, selector, bounds, confidence, source: 'dom' }
// where `bounds` is a { x, y, w, h } viewport-rect suitable for canvas redaction.
export function detectSensitiveDomElements(root = document, opts = {}) {
  const out = [];
  const winW = opts.viewportWidth  || window.innerWidth;
  const winH = opts.viewportHeight || window.innerHeight;
  const seen = new Set();

  const push = (el, type, confidence, extra = {}) => {
    if (!el || seen.has(el)) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // Skip off-screen elements (still safe — captureVisibleTab won't include them)
    if (rect.bottom < 0 || rect.top > winH || rect.right < 0 || rect.left > winW) return;
    seen.add(el);
    out.push({
      type,
      confidence,
      source: 'dom',
      selector: buildSelector(el),
      tag: el.tagName.toLowerCase(),
      label: labelOf(el),
      bounds: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      ...extra,
    });
  };

  // 1) Password fields — always redact
  root.querySelectorAll('input[type="password"]').forEach(el =>
    push(el, 'password', 1.0)
  );

  // 1b) Contact fields — email / tel inputs and free-text areas routinely
  // carry personal data (addresses, messages, phone numbers) and their
  // VALUES are rendered as pixels. A password/autocomplete/name-hints rule
  // alone leaves them visible on the sanitized screenshot — the
  // real-browser redaction matrix measured exactly that leak.
  root.querySelectorAll('input[type="email"], input[type="tel"], textarea').forEach(el =>
    push(el, 'sensitive_input', 0.85, { hint: 'contact/free-text field' })
  );

  // 2) Inputs with sensitive autocomplete tokens
  // the HTML *name* family added — autofill's own classification of
  // a field as person-name is the strongest possible signal that its VALUE is
  // personal data.
  const SENSITIVE_AUTOCOMPLETE = new Set([
    'current-password', 'new-password', 'cc-number', 'cc-exp', 'cc-csc',
    'cc-name', 'cc-given-name', 'cc-family-name', 'cc-type',
    'name', 'given-name', 'additional-name', 'family-name', 'nickname',
    'honorific-prefix', 'honorific-suffix',
    'username', 'email', 'tel', 'ssn', 'aadhaar', 'pan',
    'postal-code', 'address-line1', 'address-line2', 'address-line3',
    'organization', 'transaction-amount',
  ]);
  root.querySelectorAll('input[autocomplete]').forEach(el => {
    const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    if (tokens.some(t => SENSITIVE_AUTOCOMPLETE.has(t))) {
      push(el, 'sensitive_input', 0.95, { autocomplete: tokens.join(' ') });
    }
  });

  // 3) Inputs whose name/id/placeholder strongly hint at PII
  // Indian government/financial ID fields added (pan/voter/
  // passport/dl/gst/ifsc/upi/vpa/ration/bank account …). The field-reported
  // gov-form leak was exactly this: <input name="pan"> held a PARTIAL PAN —
  // the strict text pattern couldn't match it and the DOM hint list only
  // knew "pan[-_]?number", so the field stayed unredacted while the
  // Aadhaar box next to it was correctly black-barred. New tokens use word
  // boundaries where a bare substring would over-match (pan→"companion").
  const PII_HINT_RE = /(password|passwd|pwd|secret|api[-_]?key|access[-_]?token|cvv|cvc|csc|ssn|aadhaar|aadhar|uidai|pan[-_]?number|credit[-_]?card|cc[-_]?number|account[-_]?number|otp|pin|token|private[-_]?key|\bpan(?:card|[-_ ]?(?:no|number|id))?\b|\bvoter[-_ ]?(?:id|no|number|card)?\b|\belection[-_ ]?card\b|epic[-_ ]?(?:no|number|id)|\bpassport(?:[-_ ]?(?:no|number))?\b|driving[-_ ]?licen[cs]e|\bdl[-_ ]?(?:no|number)\b|\bgst(?:in)?[-_ ]?(?:no|number|in)?\b|\bifsc\b|\bupi[-_ ]?(?:id|vpa|no|number)?\b|\bvpa\b|ration[-_ ]?card|debit[-_ ]?card|\bbank[-_ ]?account\b|\bacct[-_ ]?(?:no|number)\b)/i;
  // PERSON-NAME field family (mirrors pageContextScan). A bare
  // <input> labelled "Full name" carries zero attribute signal; the LABEL is
  // the page's own declaration that the value is personal data.
  const NAME_FIELD_RE = /(full[-_ ]?name|your[-_ ]?name|first[-_ ]?name|last[-_ ]?name|given[-_ ]?name|family[-_ ]?name|middle[-_ ]?name|sur[-_ ]?name|customer[-_ ]?name|client[-_ ]?name|card[-_ ]?name|name[-_ ]?on[-_ ]?card|card[-_ ]?holder|account[-_ ]?holder|father['’]?s?[-_ ]?name|mother['’]?s?[-_ ]?name|spouse[-_ ]?name|nominee[-_ ]?name|guardian[-_ ]?name|patient[-_ ]?name|student[-_ ]?name|employee[-_ ]?name|candidate[-_ ]?name|child[-_ ]?name|billing[-_ ]?name|shipping[-_ ]?name|contact[-_ ]?name|person[-_ ]?name|user[-_ ]?name|\bname\b)/i;
  const labelTextsOf = (el) => {
    const texts = [];
    try { if (el.labels) for (const l of el.labels) texts.push(String(l.textContent || '')); } catch { }
    const add = (n) => { if (n) texts.push(String(n.textContent || '')); };
    try {
      if (el.closest) add(el.closest('label'));
      const parent = el.parentElement;
      if (parent) {
        add(parent.querySelector('label'));
        const prev = el.previousElementSibling;
        if (prev && prev.tagName === 'LABEL') add(prev);
      }
    } catch { }
    return texts.join(' ').replace(/\s+/g, ' ').trim();
  };
  root.querySelectorAll('input, textarea').forEach(el => {
    const blob = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), labelTextsOf(el)]
      .filter(Boolean).join(' ');
    if (PII_HINT_RE.test(blob) || NAME_FIELD_RE.test(blob)) push(el, 'sensitive_input', 0.85, { hint: blob.slice(0, 120) });
  });

  // 4) Elements marked aria-hidden="true" with content (often used to hide PII from AT)
  // left out by default; opt in via opts.includeAriaHidden.

  return out;
}

function buildSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === 1 && parts.length < 5) {
    let part = cur.tagName.toLowerCase();
    if (cur.className && typeof cur.className === 'string') {
      const cls = cur.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (cls) part += `.${cls}`;
    }
    const parent = cur.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
      }
    }
    parts.unshift(part);
    cur = parent;
  }
  return parts.join(' > ');
}

function labelOf(el) {
  return (
    el.getAttribute('aria-label') ||
    el.getAttribute('placeholder') ||
    el.getAttribute('name') ||
    el.id ||
    el.tagName.toLowerCase()
  );
}

// Text-level PII scan (regex + optional Transformers.js NER)
/**
 * SYNC regex pass — the deterministic core of the text scanner (patterns +
 * validators + contextual risk + OTP pass). Shared by the async full scan and
 * the firewall's final-boundary sweep, which must run synchronously.
 */
function runRegexPass(truncated) {
  const findings = [];

  // 1) Regex pass + VALIDATION + CONTEXTUAL RISK (SIH Phases 7/8).
  // A raw regex hit is only a CANDIDATE: checksum validators kill invalid
  // ones (Luhn / Verhoeff / mod-97 / calendar), and the context scorer drops
  // matches that sit in counter-context ("Order 1234567890") or clear their
  // type threshold. Both steps are pure and exported for the benchmark.
  for (const p of REGEX_PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(truncated)) !== null) {
      const raw = m[0];
      if (!raw) { p.re.lastIndex++; continue; }  // avoid zero-length loop
      const start = m.index;
      const end = start + raw.length;
      const near = truncated.slice(Math.max(0, start - 80), Math.min(truncated.length, end + 80));
      const finding = {
        type: p.type,
        raw,
        value: maskForType(p.type, raw),
        start,
        end,
        confidence: p.confidence,
        source: 'regex',
        _near: near,
      };
      const v = validateFinding(finding);
      if (!v.ok) continue;
      // Aadhaar fragment guard: a Verhoeff-valid 12-digit run that is really a
      // SUB-RUN of a longer number (16-digit order id / card) must not fire.
      // A real aadhaar ends at a non-digit (or a lone separator + non-digit).
      if (p.type === 'aadhaar') {
        const before = truncated.slice(Math.max(0, start - 2), start);
        const after = truncated.slice(end, end + 2);
        if (/\d\s?$/.test(before) || /^\s?\d/.test(after)) { p.re.lastIndex = end; continue; }
      }
      // Address fragment guard: "85797" inside "+91-85797-85466" is phone
      // material, not a postal code — drop candidates glued to digits.
      if (p.type === 'address') {
        const prev = truncated[start - 1];
        const prev2 = truncated[start - 2];
        const next = truncated[end];
        const next2 = truncated[end + 1];
        const sep = (c) => c === ' ' || c === '-' || c === '.' || c === '/';
        if ((/\d/.test(prev) || (/\d/.test(prev2) && sep(prev))) ||
            (/\d/.test(next) || (/\d/.test(next2) && sep(next)))) { p.re.lastIndex = end; continue; }
      }
      // Phone: expand to the FULL number cluster so the redaction rectangle
      // covers the prefix too ("+91 " was previously left visible).
      if (p.type === 'phone') {
        const exp = expandPhoneCluster(truncated, start, end);
        if (exp && phonePlausible(exp.raw)) {
          finding.raw = exp.raw;
          finding.start = exp.start;
          finding.end = exp.end;
          finding.value = maskForType(p.type, exp.raw);
        }
      }
      finding.validated = Boolean(v.strong);
      const { risk, keep, context } = scoreRisk(finding, truncated);
      if (!keep) continue;
      // Context-confirmed address findings outrank the overlapping phone
      // detector in dedupe (a ZIP+4 is otherwise claimed as a "phone").
      if (p.type === 'address' && /keyword/.test(context)) finding.confidence = 0.88;
      // same arbitration for the context-gated Indian IDs —
      // with the label present the risk score IS the confidence, so a
      // labelled driving licence / passport wins the span from the greedy
      // phone detector (which otherwise swallows the digit tail of
      // "MH12 20110001234" and leaves the state+RTO prefix visible).
      else if ((p.type === 'driving_license' || p.type === 'passport') && /keyword/.test(context)) {
        finding.confidence = risk;
      }
      delete finding._near;
      finding.risk = risk;
      finding.context = context;
      findings.push(finding);
    }
  }

  // 1b) OTP pass — context-driven (an OTP is meaningless without its label):
  // a 4-8 digit code within 30 chars of an OTP / verification-code keyword.
  // candidates go through the SAME dedupe arbitration as every other
  // finding — the old early-skip let a weaker overlapping detection (a bare
  // 8-digit "phone") win the span and silently drop the OTP.
  {
    const OTP_RE = /(\botp\b|one[-\s]?time\s*(?:password|code)?|\bverification\s*code\b|\bsecurity\s*code\b)[^0-9]{0,30}(\d{4,8})/gi;
    let om;
    while ((om = OTP_RE.exec(truncated)) !== null) {
      const raw = om[2];
      const start = om.index + om[0].length - raw.length;
      const end = start + raw.length;
      const dup = findings.find(f => !(end <= f.start || start >= f.end));
      if (dup && (Number(dup.confidence) || 0) + (dup.validated ? 0.5 : 0) >= 0.95) continue;
      if (dup) findings.splice(findings.indexOf(dup), 1);
      findings.push({
        type: 'otp', raw,
        value: '••••',
        start, end,
        confidence: 0.95,
        source: 'regex',
        risk: 0.95,
        validated: true,
        context: 'keyword:strong',
      });
    }
  }

  return findings;
}

/** SYNC scan (regex + validators + context only — NO NER). Used by the
 * privacy firewall's final-boundary sweep; also handy for tests. */
export function detectPiiInTextSync(text, opts = {}) {
  if (!text || typeof text !== 'string') return [];
  const truncated = text.length > (opts.maxChars || 16000) ? text.slice(0, opts.maxChars) : text;
  return dedupe(runRegexPass(truncated));
}

/**
 * Scan a free-form text blob (e.g. DOM textContent, OCR output) for PII.
 * Returns an array of findings (see header).
 *
 * @param {string}          text
 * @param {object}          opts
 * @param {boolean}         opts.useNer       If true, also run Transformers.js NER
 *                                            (caller must have pre-loaded the pipeline
 *                                            and pass it via opts.nerPipeline).
 * @param {object|null}     opts.nerPipeline  Pre-initialised Transformers.js NER pipeline.
 * @param {number}          opts.maxChars     Truncate input before NER (perf).
 */
export async function detectPiiInText(text, opts = {}) {
  const truncated = !text || typeof text !== 'string' ? ''
    : (text.length > (opts.maxChars || 8000) ? text.slice(0, opts.maxChars) : text);
  const findings = runRegexPass(truncated);

  // 2) Optional NER pass for person / org / address entities
  if (opts.useNer && opts.nerPipeline) {
    try {
      const ner = await opts.nerPipeline(truncated);
      // HuggingFace JS NER returns: [{ entity_group, word, start, end, score }]
      for (const ent of ner || []) {
        const grp = String(ent.entity_group || ent.entity || '').toUpperCase();
        const mapped =
          grp === 'PER' || grp === 'PERSON' ? 'person' :
          grp === 'ORG' ? 'org' :
          grp === 'LOC' || grp === 'GPE' ? 'address' : null;
        if (!mapped) continue;
        // Skip if overlaps an existing regex finding
        const overlaps = findings.some(f =>
          !(ent.end <= f.start || ent.start >= f.end)
        );
        if (overlaps) continue;
        findings.push({
          type: mapped,
          raw: truncated.slice(ent.start, ent.end),
          value: maskValue(truncated.slice(ent.start, ent.end), 1),
          start: ent.start,
          end: ent.end,
          confidence: Number(ent.score) || 0.7,
          source: 'ner',
        });
      }
    } catch (err) {
      console.warn('[PII] NER pass failed:', err);
    }
  }

  // De-duplicate overlapping findings (keep highest confidence)
  return dedupe(findings);
}

// Checksum / plausibility VALIDATORS (SIH Phase 7)
// Pure functions, exported for the benchmark suite. A detector match is only
// believed when its validator passes (or contextual risk overrides — see the
// CONTEXT scoring section below).

export function luhnValid(digits) {
  if (!/^\d+$/.test(digits)) return false;
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (Number.isNaN(n)) return false;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Verhoeff checksum — the official Aadhaar/VID validation algorithm.
 *  SIH v1.15.2: also accepts 16-digit Aadhaar Virtual IDs (same algorithm
 *  and tables — UIDAI derives VIDs with Verhoeff too). */
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
export function verhoeffValid(digits) {
  const s = String(digits).replace(/\D/g, '');
  if (s.length !== 12 && s.length !== 16) return false;
  let c = 0;
  const reversed = s.split('').reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(reversed[i])]];
  }
  return c === 0;
}

/** IBAN mod-97 check (ISO 13616). */
export function ibanValid(iban) {
  const s = String(iban).replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,32}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, ch => String(ch.charCodeAt(0) - 55));
  // Modular exponentiation by chunks to stay within Number.MAX_SAFE_INTEGER
  let remainder = 0;
  for (const ch of numeric) {
    remainder = (remainder * 10 + Number(ch)) % 97;
  }
  return remainder === 1;
}

/** US SSN plausibility — rejects 000/666/9xx areas, 00 groups, 0000 serials. */
export function ssnPlausible(ssn) {
  const m = /^(\d{3})-(\d{2})-(\d{4})$/.exec(ssn || '');
  if (!m) return false;
  const [, area, group, serial] = m;
  if (area === '000' || area === '666' || area[0] === '9') return false;
  if (group === '00' || serial === '0000') return false;
  return true;
}

/** Phone plausibility — 7..14 significant digits, not a pure year sequence. */
export function phonePlausible(raw) {
  const s = String(raw).trim();
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 14) return false;
  // Reject pure year sequences ("2023 2024", "1999-2005") — common in
  // tables/list pages and NOT phone numbers.
  const groups = s.split(/\D+/).filter(Boolean);
  if (groups.length > 1 && groups.every(g => /^(19|20)\d{2}$/.test(g))) return false;
  return true;
}

/** DOB plausibility — real calendar date, year 1900..(now + 1yr), not future. */
export function dobPlausible(raw, now = new Date()) {
  const m = /(\d{1,4})([/-])(\d{1,2})\2(\d{1,4})/.exec(String(raw || ''));
  if (!m) return false;
  let a = Number(m[1]), b = Number(m[3]), c = Number(m[4]);
  // y/m/d or d/m/y (US m/d/y also lands here — same plausibility bounds)
  let day, month, year;
  if (String(a).length === 4) { year = a; month = b; day = c; }
  else { day = a; month = b; year = c; }
  if (String(year).length === 2) year = 2000 + year;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (year < 1900 || year > now.getFullYear() + 1) return false;
  const dt = new Date(year, month - 1, day);
  return dt.getFullYear() === year && dt.getMonth() === month - 1 && dt.getDate() === day;
}

// CONTEXTUAL RISK SCORING (SIH Phase 8)
// NOT every 10-digit number is a phone. NOT every date is a DOB. The final
// redaction decision combines:
//     risk = detectorConfidence × validationFactor + contextBoost
// and only findings whose risk clears the type threshold are redacted.
// Keyword windows are taken from the ±80 characters around each match.

const CONTEXT_KEYWORDS = {
  phone: {
    boost: /(\bphone\b|\bmobile\b|\bcontact\b|\btel\b|\bcall\b|\bwhatsapp\b|फोन|मोबाइल)/i,
    strong: /(\bphone\s*[:#]|contact\s*(?:no|number)|mobile\s*[:#])/i,
    suppress: /(\border\b|\binvoice\b|\btracking\b|\btransaction\b|\bamount\b|\bref\b|\breference\b|\bbuild\b|\bdeploy|\bversion\b|\bchapter\b|\bsection\b|\bcv\b|\bdoi\b|₹|\$\s?\d)/i,
  },
  dob: {
    boost: /(\bdob\b|date\s*of\s*birth|\bbirth\b|\bborn\b|\bage\b|जन्म)/i,
    suppress: /(\bdeadline\b|\bdue\b|\bexpiry\b|\bupdated\b|\bpublished\b|\bposted\b|\bschedule\b|\brelease\b|\border\b|\binvoice\b|\bshipped\b|\bdelivered\b|\btracking\b|\bcreated\b|\bmodified\b)/i,
  },
  aadhaar: {
    boost: /(\baadhaar\b|\baadhar\b|\buidai\b|\bvid\b|\bvirtual\s*id\b|आधार)/i,
  },
  // — context keys for the Indian ID expansion. Types priced
  // below threshold (partial pan, passport, driving_license) ONLY redact
  // when their label is this close; the checksum-able ones (voter_id, ifsc,
  // gstin, upi, bank_account) get a boost but don't strictly need it.
  pan: {
    boost: /(\bpan\b|\bpan\s*(?:no|number|card)?\b|\bpermanent\s*account\b|पैन)/i,
    strong: /(pan\s*(?:no\.?|number|card)?\s*[:#]|permanent\s*account\s*no\.?)/i,
  },
  voter_id: {
    boost: /(\bvoter\b|\bepic\b|\belection\s*card\b|मतदाता)/i,
    strong: /(voter\s*(?:id|no\.?|number|card)\s*[:#])/i,
  },
  passport: {
    boost: /(\bpassport\b|\bpassport\s*(?:no|number)\b|पासपोर्ट)/i,
    strong: /(passport\s*(?:no\.?|number)\s*[:#])/i,
  },
  driving_license: {
    boost: /(\bdriving\b|\blicen[cs]e\b|\brto\b|\bdl\s*(?:no|number)\b|ड्राइविंग)/i,
    strong: /(driving\s*licen[cs]e\s*(?:no\.?|number)?\s*[:#]|\bdl\s*(?:no\.?|number)\s*[:#])/i,
  },
  ifsc: {
    boost: /(\bifsc\b|\bmicr\b|\bbranch\b|\bbank\b)/i,
  },
  upi: {
    boost: /(\bupi\b|\bvpa\b|\bupe\b|\bpay\b|\bpayment\b)/i,
  },
  bank_account: {
    boost: /(\baccount\b|\ba\/c\b|\bacct\b|\bbank\b|खाता)/i,
  },
  gstin: {
    boost: /(\bgst\b|\bgstin\b|\btax\b)/i,
  },
  credit_card: {
    boost: /(\bcard\s*(?:no|number)?\b|\bvisa\b|\bmastercard\b|\bexpiry\b|\bcvv\b)/i,
  },
  email: {
    // role/generic accounts get a lower risk (still redacted, but flagged)
    lower: /\b(support|help|info|contact|admin|noreply|no-reply|careers|hr|sales|marketing|team|hello|mail)\b/i,
  },
  otp: {
    strong: /(\botp\b|one[-\s]?time\s*(?:password|code)?|\bverification\s*code\b|\bpin\b)/i,
  },
  ip: {
    // "1.2.3.4" in a version/chapter context is not an address
    suppress: /(\bversion\b|\bchapter\b|\bsection\b|\bbuild\b|\brelease\b|\bv\d)/i,
  },
  // postal codes only count as address PII when the surrounding
  // text speaks of an address (street types, postal keywords, Indian terms).
  address: {
    boost: /(\bpin\s?code\b|\bzip\b|\bpostal\b|\baddress\b|\baddr\b|\bstreet\b|\bst\.\b|\brd\.?\b|\broad\b|\bavenue\b|\bave\b|\bapt\b|\bapartment\b|\bsuite\b|\bste\b|\bblvd\b|\bnagar\b|\bmarg\b|\bcolony\b|\bsector\b|\bhouse\b|\bflat\b|\bvillage\b|\bdistrict\b|\bstate\b)/i,
    suppress: /(\border\b|\binvoice\b|\btracking\b|\btransaction\b|\bamount\b|\bref\b|\bmodel\b|₹|\$)/i,
  },
};

// Redaction thresholds — findings below their type threshold are NOT redacted
// (precision lever); validated/keyworded findings clear them easily (recall).
const RISK_THRESHOLD = {
  email: 0.30, phone: 0.60, credit_card: 0.80, ssn: 0.85, aadhaar: 0.70,
  pan: 0.85, iban: 0.80, api_key: 0.85, url_cred: 0.90, ip: 0.70,
  dob: 0.62, otp: 0.80, person: 0.70, org: 0.75, address: 0.70,
  password: 0.85,
  // — Indian ID expansion. voter_id/ifsc/gstin/upi/bank_account
  // are structurally specific enough to clear their threshold bare;
  // passport/driving_license stay context-gated (base below threshold).
  voter_id: 0.70, passport: 0.70, driving_license: 0.70, ifsc: 0.70,
  upi: 0.75, bank_account: 0.70, gstin: 0.80,
};

/**
 * Compute the contextual risk for one finding.
 * v2: NEAREST-KEYWORD-WINS. The ±80 window earlier let a neighbouring field's
 * suppressor kill a real DOB ("DOB: 14/03/1995 … Deadline: 14/03/2030") and
 * a card label bleed into the aadhaar behind it. Now only the keyword side
 * CLOSER to the match influences the score, and the window is ±40.
 * @returns {{ risk: number, keep: boolean, context: string }}
 */
export function scoreRisk(finding, fullText) {
  const type = finding.type;
  const base = Number(finding.confidence) || 0.5;
  const kw = CONTEXT_KEYWORDS[type] || {};
  // Addresses are multi-token spans; their label ("Billing address:") sits
  // farther away than a short field's, so give them a wider keyword window.
  const W = type === 'address' ? 90 : 40;
  const text = String(fullText || '');
  const start = Math.max(0, (finding.start ?? 0) - W);
  const end = Math.min(text.length, (finding.end ?? finding.start ?? 0) + W);
  const near = text.slice(start, end);
  const fStart = finding.start ?? 0;
  const fEnd = finding.end ?? 0;

  const distOf = (matches) => matches.length
    ? Math.min(...matches.map(mm => {
        const ms = start + mm.index, me = ms + mm[0].length;
        return me <= fStart ? fStart - me : (ms >= fEnd ? ms - fEnd : 0);
      }))
    : Infinity;
  const all = (re) => {
    if (!re) return [];
    return [...near.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))];
  };

  const dStrong = distOf(all(kw.strong));
  const dBoost = Math.min(dStrong, distOf(all(kw.boost)));
  const dSup = distOf(all(kw.suppress));

  let risk = base;
  const tags = [];
  if (Number.isFinite(dBoost) && dBoost <= dSup) {
    const strong = Number.isFinite(dStrong) && dStrong <= 15;
    risk += strong ? 0.30 : 0.25;
    tags.push(strong ? 'keyword:strong' : 'keyword:nearby');
  } else if (Number.isFinite(dSup) && dSup < dBoost) {
    risk -= 0.30;
    tags.push('counter-context');
  }
  if (kw.lower?.test(near) || kw.lower?.test(finding.raw || '')) { risk -= 0.25; tags.push('role-account'); }
  if (!tags.length) tags.push('no_context');

  return { risk: Math.max(0, Math.min(1, risk)), keep: risk >= (RISK_THRESHOLD[type] ?? 0.8), context: tags.join('|') };
}

/**
 * Validate one regex finding.
 * Returns { ok, strong } — ok=false drops the candidate; strong=true means a
 * CHECKSUM verified it (Luhn / Verhoeff / mod-97), which wins type conflicts
 * in the dedupe (a Luhn-valid card overlapping a 12-digit aadhaar-shaped run
 * is a CARD, not an aadhaar).
 */
export function validateFinding(finding) {
  switch (finding.type) {
    case 'credit_card': {
      const digits = finding.raw.replace(/\D/g, '');
      if (luhnValid(digits)) return { ok: true, strong: true };
      // Luhn-failed 13-19 digit runs are usually order/transaction ids —
      // drop them (precision lever).
      return { ok: false, strong: false };
    }
    case 'aadhaar': {
      const digits = finding.raw.replace(/\D/g, '');
      if (verhoeffValid(digits)) {
        // Reject year triples ("2023 2024 2025") — three 19xx/20xx groups
        // are a year sequence, not an Aadhaar (even if the checksum collides).
        const groups = String(finding.raw).trim().split(/\s+/).filter(Boolean);
        if (groups.length > 1 && groups.every(g => /^(19|20)\d{2}$/.test(g))) return { ok: false, strong: false };
        return { ok: true, strong: true };
      }
      // Verhoeff-failed → only keep when the aadhaar keyword sits right next
      // to it (form labels; some demo/test aadhaars fail the checksum).
      return { ok: /aadhaa?r|uidai|आधार/i.test(finding._near || ''), strong: false };
    }
    case 'iban':
      return { ok: ibanValid(finding.raw), strong: ibanValid(finding.raw) };
    case 'ssn':
      return { ok: ssnPlausible(finding.raw), strong: false };
    case 'phone':
      return { ok: phonePlausible(finding.raw), strong: false };
    case 'dob':
      return { ok: dobPlausible(finding.raw), strong: false };
    default:
      return { ok: true, strong: false };
  }
}

/**
 * Expand a phone match to the FULL digit cluster around it ("8765 43210" →
 * "+91 98765 43210") so the redaction covers the entire number, not a tail.
 * Pure; exported for tests.
 */
export function expandPhoneCluster(text, start, end) {
  const CLUSTER = /\+?\d+(?:[ .()-]+\d+)*/g;
  CLUSTER.lastIndex = Math.max(0, start - 8);
  let cm;
  while ((cm = CLUSTER.exec(String(text))) !== null) {
    const cs = cm.index, ce = cm.index + cm[0].length;
    if (cs <= start && ce >= end) return { raw: cm[0], start: cs, end: ce };
    if (cs > end) break;
  }
  return null;
}

export function maskForType(type, raw) {
  switch (type) {
    case 'email': {
      const [u, d] = raw.split('@');
      return `${maskValue(u, 1)}@${d || '•••'}`;
    }
    case 'phone':       return raw.replace(/\d/g, d => d).replace(/(\+?\d{1,3})[\d\s-]+/, '$1 ••••••');
    case 'credit_card': return '•••• •••• •••• ' + raw.slice(-4);
    case 'ssn':         return '•••-••-••••';
    case 'aadhaar':     return '•••• •••• ' + raw.slice(-4);
    case 'pan':         return '••••••••' + raw.slice(-1);
    case 'iban':        return raw.slice(0, 4) + '••••••••••••';
    case 'api_key':     return raw.slice(0, 4) + '••••••••••••••••';
    case 'url_cred':    return raw.replace(/:[^/@]+@/, ':••••@');
    case 'ip': {          // SIH fix: the previous mask returned the RAW IP
      const octets = raw.split('.');
      return `${octets[0]}.${octets[1] ?? '•••'}.•••.•••`;
    }
    case 'dob':         return '••/••/••••';
    case 'password':    return '••••••••';    // secrets: nothing survives
    case 'address':     return /[a-z]/i.test(raw) ? maskValue(raw, 1) : '••••••';
    // — Indian IDs: length-preserving full mask (nothing but
    // length survives), EXCEPT ifsc (routing code, bank identity visible
    // like the IBAN mask) and upi (handle visible, user masked like email).
    case 'voter_id':
    case 'passport':
    case 'driving_license':
    case 'gstin':       return String(raw).replace(/[^\s-]/g, '•');
    case 'ifsc':        return raw.slice(0, 4) + '•••••••';
    case 'upi': {
      const [u, h] = raw.split('@');
      return `${maskValue(u, 1)}@${h || '•••'}`;
    }
    case 'bank_account': return '•••••••• ' + raw.slice(-4);
    default:            return maskValue(raw, 1);
  }
}

function dedupe(findings) {
  // Effective confidence: CHECKSUM-VALIDATED findings outrank format-only
  // matches on overlap (a Luhn-valid card overlapping a 12-digit run is a
  // card, not an aadhaar).
  const eff = (f) => (Number(f.confidence) || 0) + (f.validated ? 0.5 : 0);
  // EXPLICIT CARD-OVER-AADHAAR ARBITRATION: the hyphen-aware aadhaar
  // patterns now match fragments INSIDE hyphen-formatted credit cards (a
  // Luhn-valid 16-digit run contains a Verhoeff-valid 12-digit prefix ~10%
  // of the time — the bench caught pos-072 "Card no: 5425-3349-1327-2364"
  // mislabeled as aadhaar). When a Luhn-VALID card candidate overlaps an
  // aadhaar candidate, the card wins the type label (both would be redacted
  // either way; this keeps the type semantics + the bench contract honest).
  findings.sort((a, b) => a.start - b.start || eff(b) - eff(a));
  const out = [];
  for (const f of findings) {
    const conflict = out.find(o => !(f.end <= o.start || f.start >= o.end));
    if (conflict) {
      const card = conflict.type === 'credit_card' && conflict.validated ? conflict
        : (f.type === 'credit_card' && f.validated ? f : null);
      if (card) {
        const other = card === conflict ? f : conflict;
        if (other.type === 'aadhaar') {
          if (card === conflict) continue;          // incoming aadhaar loses
          out.splice(out.indexOf(conflict), 1);     // stored aadhaar replaced
          out.push(f);
          continue;
        }
      }
      if (eff(conflict) >= eff(f)) continue;
      out.splice(out.indexOf(conflict), 1);
      out.push(f);
      continue;
    }
    out.push(f);
  }
  return out.sort((a, b) => a.start - b.start);
}

// Public: produce a sanitized text snapshot (PII masked in place)
export function sanitizeText(text, findings) {
  if (!findings.length) return text;
  const sorted = [...findings].sort((a, b) => b.start - a.start);
  let out = text;
  for (const f of sorted) {
    out = out.slice(0, f.start) + `[REDACTED:${f.type}]` + out.slice(f.end);
  }
  return out;
}

export const PII_TYPES = REGEX_PATTERNS.map(p => p.type).concat([
  'person', 'org', 'address', 'password', 'sensitive_input', 'otp',
]);
