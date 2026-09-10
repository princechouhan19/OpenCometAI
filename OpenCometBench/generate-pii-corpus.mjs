#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// OpenCometBench/generate-pii-corpus.mjs — SIH v1.13
// Generates fixtures/pii-corpus.json: several hundred DETERMINISTIC synthetic
// PII cases (no real personal data) with valid/invalid checksums, contextual
// traps, false-positive probes, multilingual labels and embedded-in-prose
// variants. Re-run any time:  node OpenCometBench/generate-pii-corpus.mjs
//
// Every value is produced by the same algorithms validators use (Luhn /
// Verhoeff / mod-97), so "valid" positives are genuinely valid and the
// "invalid" negatives differ ONLY in their check digit — the cleanest
// possible precision probe.
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = 26171;
let _s = SEED >>> 0;
const rnd = () => {                        // mulberry32
  _s |= 0; _s = (_s + 0x6D2B79F5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[ri(0, arr.length - 1)];
const digits = (n) => Array.from({ length: n }, () => ri(0, 9)).join('');

// ── checksum helpers ─────────────────────────────────────────────────────────
function luhnComplete(partial) {           // partial[0..n-2] + computed check
  const sum = (s, alt) => [...s].reverse().reduce((acc, ch, i) => {
    let n = Number(ch); if ((i % 2) === (alt ? 0 : 1)) { n *= 2; if (n > 9) n -= 9; }
    return acc + n;
  }, 0);
  for (let d = 0; d <= 9; d++) if ((sum(partial, true) + d) % 10 === 0) return partial + d;
  return partial + '0';
}
const VER_D = [
  [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
  [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
  [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
  [9,8,7,6,5,4,3,2,1,0]];
const VER_P = [
  [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
  [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
  [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
function verhoeffCheck(phis) {             // returns the check digit for 11-digit phi
  let c = 0;
  const rev = (phis + '0').split('').reverse();   // append placeholder check digit
  for (let i = 0; i < rev.length; i++) c = VER_D[c][VER_P[i % 8][Number(rev[i])]];
  // c is the checksum state; the digit that makes it 0:
  for (let d = 0; d <= 9; d++) {
    let cc = 0;
    const r2 = (phis + d).split('').reverse();
    for (let i = 0; i < r2.length; i++) cc = VER_D[cc][VER_P[i % 8][Number(r2[i])]];
    if (cc === 0) return d;
  }
  return c;
}
function ibanComplete(countryLen) {        // build a valid IBAN of total length countryLen
  const cc = pick(['DE', 'GB', 'FR', 'NL', 'ES', 'IT']);
  const bban = Array.from({ length: countryLen - 4 }, () =>
    rnd() < 0.8 ? ri(0, 9) : pick('ABCDEFGHJKLMNPQRSTUVWXYZ'.split(''))).join('');
  const rearranged = bban + cc + '00';
  const numeric = [...rearranged].map(ch => /[A-Z]/.test(ch) ? ch.charCodeAt(0) - 55 : ch).join('');
  let rem = 0; for (const ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
  const check = String(98 - rem).padStart(2, '0');
  return cc + check + bban;
}

// ── value factories (each returns { value, expect }) ─────────────────────────
const FIRST = ['Aarav','Priya','Rohan','Ananya','Vikram','Meera','Arjun','Kavya','Dev','Ishaan','Fatima','Rahul','Sneha','Karan','Neha','Sameer','Divya','Aditya','Pooja','Manav'];
const LAST = ['Sharma','Patel','Iyer','Reddy','Singh','Gupta','Nair','Mehta','Kulkarni','Joshi','Verma','Das','Khan','Rao','Bose'];
const STREETS = ['MG Road','Park Street','Anna Salai','Ringen Road','Lake View Ave','Oak Avenue','Maple Drive','Cedar Lane','Hill Road','Jubilee Hills'];
const CITIES = ['Bengaluru 560001','Mumbai 400001','Chennai 600001','Delhi 110001','Pune 411001','Hyderabad 500001','Kolkata 700001','Jaipur 302001'];
const DOMAINS = ['example.com','example.org','mail.example.in','test.example.net'];
const WORDS = ['the','quick','team','memo','note','parcel','letter','parcel','notice','paper','file','entry','record','sample','column','plain']; // no suppressor/booster keywords

const gen = {
  email: () => {
    const styles = [
      () => `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}@${pick(DOMAINS)}`,
      () => `${pick(FIRST).toLowerCase()}${ri(10, 999)}@${pick(DOMAINS)}`,
      () => `${pick(['support','info','admin','noreply','help','careers','sales'])}@${pick(DOMAINS)}`,
    ];
    const v = pick(styles)();
    return v;
  },
  phone: () => {
    const styles = [
      () => `+91 ${ri(6, 9)}${digits(4)} ${digits(5)}`,
      () => `+91-${ri(6, 9)}${digits(4)}-${digits(5)}`,
      () => `0${ri(11, 79)} ${digits(8)}`,
      () => `(${ri(201, 989)}) ${digits(3)}-${digits(4)}`,
      () => `+1 ${ri(200, 989)}-${digits(3)}-${digits(4)}`,
      () => `${ri(6, 9)}${digits(9)}`,
    ];
    return pick(styles)();
  },
  credit_card: () => {
    const prefix = pick(['4532', '4559', '4917', '5100', '5264', '5425', '34', '37', '6011']);
    const len = pick([16, 16, 16, 15, 13, 19]);
    let partial = (prefix + digits(len - prefix.length - 1)).slice(0, len - 1);
    while (partial.length < len - 1) partial += ri(0, 9);   // guarantee exact length
    const full = luhnComplete(partial);
    const fmt = pick([
      (s) => s.replace(/(.{4})/g, '$1 ').trim(),
      (s) => s.replace(/(.{4})/g, '$1-').replace(/-$/, ''),
      (s) => s,
    ]);
    return fmt(full);
  },
  aadhaar: () => {
    const phi = `${ri(1, 9)}${digits(3)} ${digits(4)} ${digits(3)}`.replace(/\D/g, '').slice(0, 11);
    const ok = phi.length === 11 ? phi : digits(11);
    const full = ok + verhoeffCheck(ok);
    return pick([full, full.replace(/(.{4})(.{4})/, '$1 $2'), full.replace(/(.{4})(.{4})/, '$1 $2 ')].map(s => s.trim()).filter(Boolean).length ? full : full);
  },
  aadhaarSpaced: () => {
    const phi = digits(11);
    const full = phi + verhoeffCheck(phi);
    return `${full.slice(0, 4)} ${full.slice(4, 8)} ${full.slice(8)}`;
  },
  pan: () => {
    const letters = () => Array.from({ length: 5 }, () => pick('BCDEFGHJKLMNPQRSTUVWXYZ'.split(''))).join('');
    return `${letters()}${digits(4)}${pick('ABCDEFGHJKLMNPQRSTUVWXYZ'.split(''))}`;
  },
  ssn: () => `${ri(1, 899) === 666 ? 665 : ri(1, 665) === 0 ? 100 : ri(100, 665)}`.padStart(3, '0').replace(/^(\d{3})$/, (m) => (m === '000' || m === '666' || m[0] === '9') ? '421' : m)
    + '-' + String(ri(1, 99)).padStart(2, '0') + '-' + String(ri(1, 9999)).padStart(4, '0'),
  iban: () => ibanComplete(pick([22, 22, 18, 27, 24])),
  api_key: () => {
    const kinds = [
      () => 'sk-' + Array.from({ length: ri(20, 40) }, () => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'.split(''))).join(''),
      () => 'AKIA' + Array.from({ length: 16 }, () => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.split(''))).join(''),
      () => 'ghp_' + Array.from({ length: ri(25, 36) }, () => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split(''))).join(''),
      () => 'xoxb-' + ri(100000000, 999999999) + '-' + ri(100000000, 999999999) + '-' + ri(100000000, 999999999),
      () => 'AIza' + Array.from({ length: 35 }, () => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'.split(''))).join(''),
      () => 'pk_live_' + Array.from({ length: 24 }, () => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split(''))).join(''),
    ];
    return pick(kinds)();
  },
  token: () => {
    const kinds = [
      () => 'tok_' + Array.from({ length: 22 }, () => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split(''))).join('') + ri(10, 99),
      () => 'ey' + Array.from({ length: 40 }, () => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'.split(''))).join(''),
      () => 'pat_' + Array.from({ length: 28 }, () => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split(''))).join('') + ri(10, 99),
    ];
    return pick(kinds)();
  },
  bearer: () => 'Bearer ' + Array.from({ length: 32 }, () => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-'.split(''))).join(''),
  password: () => {
    const kinds = [
      () => `Hunt3r${ri(1000, 9999)}!`,
      () => `"${pick(['cor', 'str0ng', 'S3cret', 'pass1'])}${ri(10, 999)}"`,
      () => `${pick(WORDS)}${ri(100, 999)}${pick(['!', '#', '$'])}`,
      () => 'correct-horse-battery-' + ri(10, 99),
    ];
    return pick(kinds)();
  },
  otp: () => String(ri(1000, 99999999)),
  url_cred: () => {
    const user = pick(FIRST).toLowerCase();
    const pass = `${pick(WORDS)}${ri(10, 999)}`;
    return `https://${user}:${pass}@${pick(['vault.example.com','git.example.net','db.example.internal'])}/${pick(['repo','stash','backup'])}`;
  },
  ip: () => `${ri(10, 223)}.${ri(0, 255)}.${ri(0, 255)}.${ri(1, 254)}`,
  dob: () => {
    const y = ri(1950, 2006);
    const m = ri(1, 12);
    const d = ri(1, 28);
    const styles = [
      () => `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`,
      () => `${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}-${y}`,
      () => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      () => `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`,
    ];
    return pick(styles)();
  },
  address: () => {
    const styles = [
      () => `${ri(1, 999)} ${pick(STREETS)}, ${pick(CITIES)}`,
      () => `${pick(STREETS)}, Apt ${ri(1, 64)}, ${pick(CITIES)}`,
      () => `House ${ri(1, 200)}, ${pick(['Sector ' + ri(1, 62), pick(LAST) + ' Nagar', pick(LAST) + ' Colony'])}, ${pick(CITIES)}`,
      () => `${ri(10, 9999)} ${pick(['Oak Avenue','Maple Drive','Elm Street'])}, Springfield, IL ${ri(10001, 62899)}-${ri(1000, 9999)}`,
    ];
    return pick(styles)();
  },
};

// ── context wrappers ─────────────────────────────────────────────────────────
const LABELS = {
  email: ['Email', 'email address', 'E-mail', 'Contact', 'ईमेल', 'மின்னஞ்சல்'],
  phone: ['Phone', 'Mobile', 'Contact number', 'Call', 'फ़ोन', 'मोबाइल', 'கைபேசி'],
  credit_card: ['Card number', 'Credit card', 'Visa', 'Card no', 'Debit card'],
  aadhaar: ['Aadhaar', 'Aadhar', 'UIDAI', 'आधार'],
  pan: ['PAN', 'PAN number', 'PAN card'],
  ssn: ['SSN', 'Social security number', 'Social Security'],
  iban: ['IBAN', 'Bank account (IBAN)', 'Account IBAN'],
  api_key: ['API key', 'api key', 'Key', 'Secret key'],
  password: ['Password', 'password', 'pwd', 'login password'],
  otp: ['OTP', 'verification code', 'one-time password', 'security code'],
  url_cred: ['Repo URL', 'Stash', 'Backup endpoint', 'Clone URL'],
  ip: ['IP', 'Server IP', 'IP address', 'Last login IP'],
  dob: ['DOB', 'Date of birth', 'Birth date', 'जन्म तिथि'],
  address: ['Address', 'Billing address', 'Shipping address', 'Home address'],
  token: ['Token', 'Access token', 'Auth token', 'API token'],
  bearer: ['Authorization', 'Auth header'],
};

function wrap(type, value, variant) {
  const label = pick(LABELS[type] || ['Field']);
  const prose1 = `The ${pick(WORDS)} ${pick(WORDS)} was ${pick(WORDS)}d yesterday`;
  const prose2 = `please ${pick(['review', 'check', 'verify', 'confirm'])} the ${pick(WORDS)}`;
  switch (variant) {
    case 'labeled':     return `${label}: ${value}`;
    case 'form':        return `Form field — ${label}: ${value} (required)`;
    case 'dialog':      return `Sign in — ${label} ${value} [Cancel] [OK]`;
    case 'prose':       return `${prose1}. ${label} ${value}. ${prose2}.`;
    case 'prefix':      return `${pick(WORDS)} ${pick(WORDS)} ${value} ${pick(WORDS)}`;
    case 'bare':        return value;
    case 'hindi':       return `${label}: ${value}`;
    case 'tamil':       return `${label}: ${value}`;
    case 'table':       return `| ${label} | ${value} |  | id | ${digits(6)} |`;
    case 'multiline':   return `${prose1}\n${label}: ${value}\n${prose2}`;
    default:            return `${label}: ${value}`;
  }
}

// ── negatives (no PII of any type should be detected) ────────────────────────
function luhnBroken() {
  const partial = '4' + digits(14);
  const c = luhnComplete(partial);
  const bad = c.slice(0, -1) + String((Number(c.slice(-1)) + ri(1, 9)) % 10);
  return bad.replace(/(.{4})/g, '$1 ').trim();
}
function ibanBroken() {
  const ok = ibanComplete(22);
  const check = Number(ok.slice(2, 4));
  const bad = ok.slice(0, 2) + String((check + ri(1, 8)) % 100).padStart(2, '0') + ok.slice(4);
  return bad;
}
function yearTriple() { const y = ri(1990, 2020); return `${y} ${y + 1} ${y + 2}`; }
function aadhaarBroken() {
  const phi = digits(11);
  const d = verhoeffCheck(phi);
  const bad = phi + String((d + ri(1, 9)) % 10);
  return bad;    // no aadhaar keyword nearby → validator must drop it
}
const NEGATIVES = [];
let negId = 0;
const neg = (text, reason) => NEGATIVES.push({ id: `neg-${String(++negId).padStart(3, '0')}`, text, reason });

// Luhn-invalid card-shaped runs (order/transaction ids)
for (let i = 0; i < 14; i++) neg(`Order confirmation — payment reference ${luhnBroken()} has been recorded.`, 'Luhn-invalid 16-digit run (order id)');
for (let i = 0; i < 4; i++) neg(`Shipment ID ${digits(15)} processed at hub ${pick(CITIES)}.`, '15-digit tracking-like run, not Luhn-valid');
// Aadhaar-shaped year triples + Verhoeff failures without keyword
for (let i = 0; i < 8; i++) neg(`Archive coverage: ${yearTriple()} — see appendix.`, 'year triple (aadhaar shape)');
for (let i = 0; i < 10; i++) neg(`Reference sheet ${aadhaarBroken()} filed under civil records.`, 'Verhoeff-invalid aadhaar, no aadhaar keyword');
// implausible SSNs
for (const area of ['000', '666', '900', '987']) neg(`Legacy taxpayer file ${area}-${String(ri(1, 99)).padStart(2, '0')}-${String(ri(1, 9999)).padStart(4, '0')} migrated.`, `SSN area ${area} implausible`);
for (let i = 0; i < 3; i++) neg(`Draft form shows ${String(ri(100, 899))}-00-${'0000'} pending review.`, 'SSN group/serial zeros');
// IBAN mod-97 failures
for (let i = 0; i < 10; i++) neg(`Wire template (unverified): ${ibanBroken()} — do not use.`, 'mod-97 invalid IBAN');
// phones in counter-context
const SUPPRESS_PHONE = ['Order 9876543210 was placed', 'Invoice 9876543210 generated', 'Tracking 9876543210 updated', 'Transaction 9876543210 settled', 'Amount due ₹9876543210', 'Reference 9876543210 assigned', 'Build 5551234567 finished', 'Version 1234567890 deployed'];
for (const t of SUPPRESS_PHONE) neg(t, 'digit run in order/invoice/tracking/amount context');
for (let i = 0; i < 5; i++) neg(`Milestones ${ri(1990, 2019)} ${ri(1990, 2021)} in the timeline.`, 'year pair (phone-shaped, implausible cluster)');
// DOB-shaped dates in counter-context
for (let i = 0; i < 6; i++) neg(`Invoice due ${gen.dob()} — pay by then.`, 'date next to invoice/due (not DOB)');
for (let i = 0; i < 4; i++) neg(`Article published ${gen.dob()} by the desk.`, 'date next to published (not DOB)');
for (let i = 0; i < 4; i++) neg(`Deadline ${gen.dob()} for the scheme application.`, 'date next to deadline (not DOB)');
// calendar-invalid dates
for (let i = 0; i < 6; i++) neg(`Review the filing dated 31/02/${ri(1990, 2030)} (invalid calendar date).`, '31/02 is not a real date');
for (let i = 0; i < 3; i++) neg(`Audit window 30/02/${ri(1990, 2030)} — placeholder.`, '30/02 invalid');
// IPs in version/chapter context
for (let i = 0; i < 6; i++) neg(`Since version ${gen.ip().replace(/\./g, '.')} of the spec — historical numbering.`, 'IP-shaped version context');
for (let i = 0; i < 3; i++) neg(`See chapter ${ri(1, 223)}.${ri(0, 255)}.${ri(0, 255)}.${ri(0, 255)} of the manual.`, 'IP-shaped chapter reference');
// PAN lowercase / partial
for (let i = 0; i < 5; i++) neg(`Draft id (lowercase) ${gen.pan().toLowerCase()} must still be uppercase.`, 'lowercase PAN does not match format');
neg('PAN verification pending — number not issued yet.', 'prose about PAN without a value');
// email-lookalikes
neg('Reach the team at help desk (see portal) for access.', 'no email present');
for (const t of ['contact admin at example dot com', 'user AT example DOT com', 'root@localhost']) neg(t, 'not a valid email literal');
for (let i = 0; i < 3; i++) neg(`Handle: ${pick(FIRST).toLowerCase()}@${pick(WORDS)}`, 'email without TLD');
// prose about secrets (no values)
for (const t of ['Password: required for login', 'Enter your password to continue', 'token expired — refresh the page', 'API key management lives in settings', 'Your OTP will arrive shortly', 'Verification code sent to your phone', 'Set a strong secret for the vault']) neg(t, 'keyword without a secret value');
// bare 5/6-digit runs without address context
for (let i = 0; i < 10; i++) neg(`Confirmation number ${ri(10000, 999999)} — keep for returns.`, '5-6 digit id, no address context');
for (let i = 0; i < 4; i++) neg(`Model ${ri(10000, 99999)} discontinued in ${ri(2015, 2024)}.`, 'model number, no address context');
// currency / amounts
for (let i = 0; i < 6; i++) neg(`Total payable ₹${digits(ri(4, 7))} including GST.`, 'currency amount');
for (let i = 0; i < 4; i++) neg(`Invoice total $${digits(ri(3, 6))}.00 settled.`, 'dollar amount');
// misc structured non-PII
neg('Release 2.14.3 ships the new sanitizer.', 'version string');
neg('Coordinates 17.42 78.51 mark the site.', 'geo coordinates');
neg('Uptime 99.95 percent this quarter.', 'percentage');
neg('Latency p50 1.2 p95 3.4 seconds.', 'latency stats');
for (let i = 0; i < 4; i++) neg(`Build ${ri(100000, 999999)} passed all checks.`, 'build number');
neg('Room 404, Wing B — meeting moved.', 'room number');

// ── positives ────────────────────────────────────────────────────────────────
const POSITIVES = [];
let posId = 0;
function pos(type, value, variant, expectOverride) {
  const text = wrap(type, value, variant);
  POSITIVES.push({
    id: `pos-${String(++posId).padStart(3, '0')}`,
    type,
    text,
    expect: expectOverride || value,
    variant,
  });
}

// email — 30
for (let i = 0; i < 8; i++)  pos('email', gen.email(), 'labeled');
for (let i = 0; i < 4; i++)  pos('email', gen.email(), 'form');
for (let i = 0; i < 4; i++)  pos('email', gen.email(), 'prose');
for (let i = 0; i < 4; i++)  pos('email', gen.email(), 'dialog');
for (let i = 0; i < 4; i++)  pos('email', gen.email(), 'table');
for (let i = 0; i < 3; i++)  pos('email', gen.email(), 'hindi');
for (let i = 0; i < 3; i++)  pos('email', gen.email(), 'tamil');
// phone — 30
for (let i = 0; i < 8; i++)  pos('phone', gen.phone(), 'labeled');
for (let i = 0; i < 4; i++)  pos('phone', gen.phone(), 'prose');
for (let i = 0; i < 4; i++)  pos('phone', gen.phone(), 'form');
for (let i = 0; i < 3; i++)  pos('phone', gen.phone(), 'hindi');
for (let i = 0; i < 3; i++)  pos('phone', gen.phone(), 'tamil');
for (let i = 0; i < 4; i++)  pos('phone', gen.phone(), 'multiline');
for (let i = 0; i < 4; i++)  pos('phone', gen.phone(), 'dialog');
// credit_card — 30
for (let i = 0; i < 10; i++) pos('credit_card', gen.credit_card(), 'labeled');
for (let i = 0; i < 6; i++)  pos('credit_card', gen.credit_card(), 'form');
for (let i = 0; i < 6; i++)  pos('credit_card', gen.credit_card(), 'prose');
for (let i = 0; i < 4; i++)  pos('credit_card', gen.credit_card(), 'dialog');
for (let i = 0; i < 4; i++)  pos('credit_card', gen.credit_card(), 'bare');
// aadhaar — 26
for (let i = 0; i < 8; i++)  pos('aadhaar', gen.aadhaarSpaced(), 'labeled');
for (let i = 0; i < 6; i++)  pos('aadhaar', gen.aadhaarSpaced(), 'form');
for (let i = 0; i < 4; i++)  pos('aadhaar', gen.aadhaarSpaced(), 'hindi');
for (let i = 0; i < 4; i++)  pos('aadhaar', gen.aadhaarSpaced(), 'prose');
for (let i = 0; i < 4; i++)  pos('aadhaar', gen.aadhaarSpaced(), 'dialog');
// pan — 20
for (let i = 0; i < 8; i++)  pos('pan', gen.pan(), 'labeled');
for (let i = 0; i < 6; i++)  pos('pan', gen.pan(), 'form');
for (let i = 0; i < 6; i++)  pos('pan', gen.pan(), 'prose');
// ssn — 18
for (let i = 0; i < 8; i++)  pos('ssn', gen.ssn(), 'labeled');
for (let i = 0; i < 5; i++)  pos('ssn', gen.ssn(), 'form');
for (let i = 0; i < 5; i++)  pos('ssn', gen.ssn(), 'prose');
// iban — 18
for (let i = 0; i < 8; i++)  pos('iban', gen.iban(), 'labeled');
for (let i = 0; i < 5; i++)  pos('iban', gen.iban(), 'form');
for (let i = 0; i < 5; i++)  pos('iban', gen.iban(), 'prose');
// api_key — 30
for (let i = 0; i < 12; i++) { const v = gen.api_key(); pos('api_key', v, 'labeled'); }
for (let i = 0; i < 8; i++)  pos('api_key', gen.api_key(), 'prose');
for (let i = 0; i < 6; i++)  pos('api_key', gen.api_key(), 'multiline');
for (let i = 0; i < 4; i++)  pos('api_key', gen.api_key(), 'dialog');
// token — 18 (token=… → api_key class) + bearer — 8
for (let i = 0; i < 10; i++) { const v = gen.token(); pos('api_key', v, 'labeled', v); }
for (let i = 0; i < 8; i++)  { const v = gen.token(); pos('api_key', v, 'prose', v); }
for (let i = 0; i < 8; i++)  { const v = gen.bearer(); pos('api_key', v, 'labeled', v); }
// password — 20
for (let i = 0; i < 8; i++)  { const v = gen.password(); pos('password', v, 'labeled', v); }
for (let i = 0; i < 6; i++)  { const v = gen.password(); pos('password', v, 'form', v); }
for (let i = 0; i < 6; i++)  { const v = gen.password(); pos('password', v, 'dialog', v); }
// otp — 18
for (let i = 0; i < 8; i++)  pos('otp', gen.otp(), 'labeled');
for (let i = 0; i < 6; i++)  pos('otp', gen.otp(), 'dialog');
for (let i = 0; i < 4; i++)  pos('otp', gen.otp(), 'prose');
// url_cred — 14
for (let i = 0; i < 8; i++)  pos('url_cred', gen.url_cred(), 'labeled');
for (let i = 0; i < 6; i++)  pos('url_cred', gen.url_cred(), 'prose');
// ip — 18
for (let i = 0; i < 8; i++)  pos('ip', gen.ip(), 'labeled');
for (let i = 0; i < 6; i++)  pos('ip', gen.ip(), 'prose');
for (let i = 0; i < 4; i++)  pos('ip', gen.ip(), 'multiline');
// dob — 22
for (let i = 0; i < 8; i++)  pos('dob', gen.dob(), 'labeled');
for (let i = 0; i < 6; i++)  pos('dob', gen.dob(), 'form');
for (let i = 0; i < 4; i++)  pos('dob', gen.dob(), 'hindi');
for (let i = 0; i < 4; i++)  pos('dob', gen.dob(), 'dialog');
// address — 22
for (let i = 0; i < 10; i++) pos('address', gen.address(), 'labeled');
for (let i = 0; i < 6; i++)  pos('address', gen.address(), 'form');
for (let i = 0; i < 6; i++)  pos('address', gen.address(), 'prose');
// mixed — several PII in one string; one corpus entry PER EXPECTED VALUE,
// typed by that value's class (the bench matches detection type to entry type).
for (let i = 0; i < 8; i++) {
  const em = gen.email(), ph = gen.phone(), cc = gen.credit_card();
  const text = `Customer ${pick(FIRST)} ${pick(LAST)} — ${pick(LABELS.email)}: ${em}, ${pick(LABELS.phone)}: ${ph}. Card on file ${cc}.`;
  for (const [t, val] of [['email', em], ['phone', ph], ['credit_card', cc]]) {
    POSITIVES.push({ id: `pos-${String(++posId).padStart(3, '0')}`, type: t, text, expect: val, variant: 'mixed' });
  }
}

// ── de-dup guard + write ─────────────────────────────────────────────────────
const seenText = new Set();
const uniqPos = POSITIVES.filter(p => { const k = p.type + '|' + p.text + '|' + p.expect; if (seenText.has(k)) return false; seenText.add(k); return true; });
const uniqNeg = NEGATIVES.filter(p => { const k = p.text; if (seenText.has(k)) return false; seenText.add(k); return true; });

const corpus = {
  meta: {
    generator: 'OpenCometBench/generate-pii-corpus.mjs',
    seed: SEED,
    generatedAt: new Date().toISOString(),
    note: 'Fully synthetic values. Valid positives use real Luhn/Verhoeff/mod-97 checksums; invalid negatives differ only in the check digit. No real personal data.',
  },
  positives: uniqPos,
  negatives: uniqNeg,
};
writeFileSync(join(HERE, 'fixtures', 'pii-corpus.json'), JSON.stringify(corpus, null, 2));

const byType = {};
for (const p of uniqPos) byType[p.type] = (byType[p.type] || 0) + 1;
console.log(`pii-corpus.json written: ${uniqPos.length} positives, ${uniqNeg.length} negatives (total ${uniqPos.length + uniqNeg.length})`);
console.log('  positives by type:', JSON.stringify(byType));
