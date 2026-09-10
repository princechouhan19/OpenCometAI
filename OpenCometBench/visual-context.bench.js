// ─────────────────────────────────────────────────────────────────────────────
// OpenCometBench/visual-context.bench.js — SIH Phase 20
// VISUAL CONTEXT ACCURACY: page-type classification + element recognition.
//
// Measures the REAL classifier (src/lib/page-classifier.js) against synthetic
// page snapshots with ground-truth page types. Includes fusion cases where
// ViT labels (mocked ImageNet top-k, as produced by the offscreen pipeline)
// contribute scene signals.
// ─────────────────────────────────────────────────────────────────────────────
import {
  classifyVisualContext,
  classifyFromDomSignals,
  shouldRunVisionClassifier,
  deriveVisualElements,
} from '../src/lib/page-classifier.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// Synthetic page snapshots. `dom` census mirrors exactly what
// privacy-agent.js pageContextScan() collects in the live page.
const PAGES = [
  {
    id: 'login-form', expect: 'login',
    url: 'https://accounts.example.com/login', title: 'Sign in — Example',
    text: 'Sign in to your account. Forgot your password? Remember me on this computer.',
    dom: { forms: 1, inputs: { password: 1, email: 1, search: 0, tel: 0, file: 0, text: 0 }, autocompleteCc: false, buttons: 2, links: 4, videos: 0, canvases: 0, priceHints: false, composeEditor: false, hasFileInput: false },
  },
  {
    id: 'signup-form', expect: 'signup',
    url: 'https://example.com/register', title: 'Create account',
    text: 'Create an account. Already have an account? Sign up with email.',
    dom: { forms: 1, inputs: { password: 1, email: 1, search: 0, tel: 0, file: 0, text: 2 }, autocompleteCc: false, buttons: 1, links: 3, videos: 0, canvases: 0, priceHints: false, composeEditor: false, hasFileInput: false },
  },
  {
    id: 'checkout-flow', expect: 'checkout',
    url: 'https://shop.example.com/checkout', title: 'Checkout — Example Store',
    text: 'Place your order. Order summary. Add to cart was successful. Delivery address.',
    dom: { forms: 1, inputs: { password: 0, email: 0, search: 0, tel: 0, file: 0, text: 4 }, autocompleteCc: false, buttons: 3, links: 9, videos: 0, canvases: 0, priceHints: true, composeEditor: false, hasFileInput: false },
  },
  {
    id: 'payment-card', expect: 'payment',
    url: 'https://pay.example.com/billing', title: 'Payment',
    text: 'Credit card number, CVV, card holder name. UPI or net banking also accepted.',
    dom: { forms: 1, inputs: { password: 0, email: 0, search: 0, tel: 0, file: 0, text: 3 }, autocompleteCc: true, buttons: 2, links: 5, videos: 0, canvases: 0, priceHints: true, composeEditor: false, hasFileInput: false },
  },
  {
    id: 'banking-portal', expect: 'banking',
    url: 'https://netbanking.examplebank.in/overview', title: 'My Accounts',
    text: 'Account balance, beneficiary list, IFSC code, transfer funds, download statement.',
    dom: { forms: 0, inputs: { password: 0, email: 0, search: 1, tel: 0, file: 0, text: 1 }, autocompleteCc: false, buttons: 6, links: 18, videos: 0, canvases: 0, priceHints: false, composeEditor: false, hasFileInput: false },
  },
  {
    id: 'email-inbox', expect: 'email',
    url: 'https://mail.example.com/mail/u/0', title: 'Inbox',
    text: 'Inbox, compose, unread messages, subject lines, send.',
    dom: { forms: 0, inputs: { password: 0, email: 0, search: 1, tel: 0, file: 0, text: 0 }, autocompleteCc: false, buttons: 8, links: 22, videos: 0, canvases: 0, priceHints: false, composeEditor: true, hasFileInput: false },
  },
  {
    id: 'media-watch', expect: 'media',
    url: 'https://music.example.com/watch', title: 'Now Playing',
    text: 'Now playing. Pause. Playlist queue. Subscribe for more.',
    dom: { forms: 0, inputs: { password: 0, email: 0, search: 0, tel: 0, file: 0, text: 0 }, autocompleteCc: false, buttons: 5, links: 7, videos: 1, canvases: 0, priceHints: false, composeEditor: false, hasFileInput: false },
  },
  {
    id: 'article-page', expect: 'article',
    url: 'https://blog.example.net/posts/2025/on-device-ai.html', title: 'On-device AI — Blog',
    text: 'Posted on March 2025 by the team. 8 minutes read. Comments (12).',
    dom: { forms: 0, inputs: { password: 0, email: 0, search: 0, tel: 0, file: 0, text: 0 }, autocompleteCc: false, buttons: 1, links: 10, videos: 0, canvases: 0, priceHints: false, composeEditor: false, hasFileInput: false },
  },
  {
    id: 'gov-form', expect: 'government',
    url: 'https://portal.gov.in/scheme/apply', title: 'Apply Online — Scheme',
    text: 'Apply online for the certificate scheme on the government portal.',
    dom: { forms: 2, inputs: { password: 0, email: 0, search: 0, tel: 0, file: 1, text: 6 }, autocompleteCc: false, buttons: 3, links: 12, videos: 0, canvases: 0, priceHints: false, composeEditor: false, hasFileInput: true },
  },
  // Thin DOM + ViT fusion case: no real signals in DOM, ViT says screen-like.
  {
    id: 'canvas-app-thin-dom', expect: 'form',
    url: 'https://app.example.com/editor', title: 'App',
    text: '',
    dom: { forms: 0, inputs: { password: 0, email: 0, search: 0, tel: 0, file: 0, text: 0 }, autocompleteCc: false, buttons: 0, links: 1, videos: 0, canvases: 4, priceHints: false, composeEditor: false, hasFileInput: false },
    vitLabels: [{ label: 'monitor', score: 0.44 }, { label: 'computer keyboard', score: 0.19 }],
  },
  // v1.14 REGRESSION (measured browser bug): a generic portal home whose only
  // text evidence is the generic word "Portal" (title) — it used to win the
  // scoreboard by default and misclassify as "government". Expected: unknown,
  // low confidence, decision basis 'insufficient-evidence'.
  {
    id: 'portal-mixed-ui', expect: 'unknown',
    url: 'https://www.example.com/', title: 'Example Portal — Home',
    text: 'Docs Pricing Blog Account Search the portal Projects 3 active Invoices 1 due Team 8 members Recommended Getting started guide API reference',
    dom: { forms: 0, inputs: { password: 0, email: 0, search: 0, tel: 0, file: 0, text: 1 }, autocompleteCc: false, buttons: 1, links: 6, videos: 0, canvases: 0, priceHints: false, composeEditor: false, hasFileInput: false },
  },
];

export async function run() {
  let correct = 0;
  const rows = PAGES.map(p => {
    const ctx = classifyVisualContext(p, p.vitLabels || null);
    const ok = ctx.pageType === p.expect;
    if (ok) correct++;
    return { id: p.id, expect: p.expect, got: ctx.pageType, confidence: ctx.confidence, scene: ctx.scene, elements: ctx.visualElements, ok };
  });

  // Element recognition: the checkout page must surface order-relevant elements
  const co = rows.find(r => r.id === 'checkout-flow');
  const wantEls = ['form', 'button', 'price_display', 'order_summary'];
  const elsOk = wantEls.filter(e => co.elements.includes(e)).length;

  // Adaptive gate behaviour (Phase 6)
  const gate = {
    domSufficientSkips: shouldRunVisionClassifier({ domBest: { type: 'login', confidence: 0.9 }, pageChanged: true, visuallyHeavy: false }).run === false,
    uncertaintyRuns: shouldRunVisionClassifier({ domBest: { type: 'unknown', confidence: 0.3 }, pageChanged: true, visuallyHeavy: false }).run === true,
    unchangedSkips: shouldRunVisionClassifier({ domBest: { type: 'unknown', confidence: 0.3 }, pageChanged: false, visuallyHeavy: false }).run === false,
    heavyRuns: shouldRunVisionClassifier({ domBest: { type: 'login', confidence: 0.9 }, pageChanged: true, visuallyHeavy: true }).run === true,
  };
  const gateOk = Object.values(gate).every(Boolean);

  const accuracy = correct / PAGES.length;
  const targets = { accuracy: 0.95, gateOk: true, elementCoverage: 1.0 };
  return {
    name: 'Visual context (page-type accuracy / elements / adaptive gate)',
    pass: accuracy >= targets.accuracy && gateOk && (elsOk / wantEls.length) >= targets.elementCoverage,
    metrics: {
      accuracy: Math.round(accuracy * 1000) / 1000,
      correct: `${correct}/${PAGES.length}`,
      rows,
      elementCoverage: `${elsOk}/${wantEls.length}`,
      gate,
      targets,
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(JSON.stringify(await run(), null, 2));
}
