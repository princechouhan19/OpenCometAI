#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// OpenCometBench/browser/harness.mjs — SIH v1.13 REAL BROWSER BENCHMARK
//
// The Node suites verify logic; THIS harness measures the REAL perception
// pipeline on REAL browser-rendered pixels:
//
//   HTML PAGE ─► REAL BROWSER (Chromium via Playwright)
//              ─► REAL SCREENSHOT (page.screenshot, per-DPR)
//              ─► REAL LOCAL PERCEPTION PIPELINE (runPrivacyPipeline in-page:
//                 MediaPipe faces · DOM scan · PII text/OCR · canvas redaction)
//              ─► STRUCTURED VISUAL CONTEXT (page-classifier + real ViT)
//              ─► COMPARE against the page's embedded ground truth
//
// Tiers
//   A  visual-context : 12 page types → page-type accuracy SPLIT into
//                        DOM-derived vs ViT(visual-model)-fused, element /
//                        context completeness, false positives, confidence
//   B  redaction-matrix: DPR {1,1.25,1.5,2} × zoom {100,125,150} ×
//                        scroll {top,middle,bottom} × dialog {closed,open}
//                        → coverage / IoU / over-redaction / under-redaction /
//                        PIXEL-LEVEL leakage verification
//   C  ocr-visual-pii : PII that exists ONLY in canvas/SVG-img/PDF-like
//                        pixels → OCR finds it + pixels really redacted;
//                        also run with OCR OFF to show the honest DOM-only gap
//   D  resources      : per-phase P50/P90/P95, MediaPipe/ViT/OCR load times,
//                        JS heap, payload KB, backend (webgpu/wasm)
//
//   node OpenCometBench/browser/harness.mjs              # all tiers
//   node OpenCometBench/browser/harness.mjs --only=visual,redaction,ocr,resources
//   node OpenCometBench/browser/harness.mjs --vit=false  # skip the ViT download
//   node OpenCometBench/browser/harness.mjs --headed --channel=chrome  # REAL HARDWARE MODE
//        (SIH Task: production numbers MUST come from the user's real Chrome
//         on real hardware — WebGPU/WASM/heap/payload P50/P90/P95 measured
//         headed with the installed Google Chrome and labelled
//         meta.environment = "real-hardware-headed". Headless SwiftShader
//         numbers are CI numbers ONLY and are never production claims.)
//
// Output: OpenCometBench/results/browser-benchmark.json (meta.type = "browser").
// Nothing is asserted — every number comes from the runs above.
// ─────────────────────────────────────────────────────────────────────────────
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'OpenCometBench', 'results');

const args = process.argv.slice(2);
const onlyArg = args.find(a => a.startsWith('--only='))?.split('=')[1];
const TIERS = new Set((onlyArg || 'visual,redaction,ocr,resources').split(','));
const VIT_ENABLED = args.includes('--vit=false') === false;
// v1.14 REAL-HARDWARE MODE: --headed --channel=chrome runs the SAME harness on
// the user's installed Google Chrome, visibly (headed). The report carries the
// environment label + hardware fingerprint so no one can mistake CI numbers
// for production numbers.
const HEADED = args.includes('--headed');
const CHANNEL = args.find(a => a.startsWith('--channel='))?.split('=')[1] || 'chromium';
const ENV_LABEL = HEADED ? 'real-hardware-headed' : 'headless-ci';
const BASE = 'http://127.0.0.1:8891';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.tflite': 'application/octet-stream', '.gz': 'application/gzip', '.css': 'text/css', '.png': 'image/png' };
function serve() {
  return new Promise((res) => {
    const srv = createServer((req, resp) => {
      let p = decodeURIComponent(new URL(req.url, BASE).pathname);
      if (p === '/') p = '/OpenCometBench/browser/runner.html';
      const file = join(ROOT, p);
      if (!file.startsWith(ROOT) || !existsSync(file)) { resp.writeHead(404); resp.end('nf'); return; }
      resp.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      resp.end(readFileSync(file));
    });
    srv.listen(8891, '127.0.0.1', () => res(srv));
  });
}

// ── extract the REAL pageContextScan source from privacy-agent.js so the
//    harness runs the very function the extension injects (no re-implementation)
function extractPageContextScan() {
  const src = readFileSync(join(ROOT, 'src', 'lib', 'privacy-agent.js'), 'utf8');
  const start = src.indexOf('function pageContextScan() {');
  if (start < 0) throw new Error('pageContextScan not found');
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

const PAGE_TYPES = ['login', 'signup', 'checkout', 'payment', 'banking', 'dashboard',
  'email', 'article', 'media', 'gov-form', 'canvas-app', 'mixed-ui'];
// v1.14 Task (element-GT by source): pixel-only-control pages join the
// element-source metrics but NOT the page-type accuracy denominators — they
// genuinely carry no DOM evidence for the classifier, and mixing them into
// page-type accuracy would conflate two different questions.
const PIXEL_ONLY_PAGES = ['canvas-controls.html', 'svg-controls.html'];
const VISUAL_PAGES = [...PAGE_TYPES.map(n => `${n}.html`), ...PIXEL_ONLY_PAGES];
const DPRS = [1, 1.25, 1.5, 2];
const ZOOMS = [1, 1.25, 1.5];
const SCROLLS = ['top', 'middle', 'bottom'];
const DIALOGS = [false, true];

const pct = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
};
const r3 = (v) => Math.round(v * 1000) / 1000;
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

// ── in-page helpers (run inside the browser via evaluate) ────────────────────
/** Open a page with the harness bootstrap (REAL pageContextScan) installed before any page script. */
async function openPage(ctx, url) {
  const page = await ctx.newPage();
  await page.addInitScript(`
    ${scanSrc}
    window.__sihPageContextScan = () => pageContextScan();
  `);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  return page;
}

/** Run the REAL privacy pipeline inside the page on a REAL screenshot. */
async function runPipelineInPage(page, { imageDataUrl, dpr, ocr = true, yolo = true, faces = true }) {
  return page.evaluate(async ({ imageDataUrl, dpr, ocr, yolo, faces }) => {
    const cb = '1';
    const { runPrivacyPipeline } = await import(`/src/lib/privacy-filter.js?cb=${cb}`);
    // Real DOM scan (the exact function the extension injects) — defined by the harness bootstrap.
    const scan = window.__sihPageContextScan();
    return runPrivacyPipeline(
      { imageDataUrl, domText: scan.text, domSensitive: scan.sensitive, dom: scan.census, url: location.origin + location.pathname, title: document.title },
      { scaleX: dpr, scaleY: dpr, maxWidth: 1280, imageQuality: 0.85, ocrPii: ocr, runYolo: yolo, blurFaces: faces, redactTextPii: true },
    );
  }, { imageDataUrl, dpr, ocr, yolo, faces });
}

/** Measure GT boxes + pixel-diff raw vs sanitized for each GT region. */
async function verifyRedactionInPage(page, { gtSelectors, imageDataUrl, sanitizedDataUrl, dpr }) {
  return page.evaluate(async ({ gtSelectors, imageDataUrl, sanitizedDataUrl, dpr }) => {
    const boxes = gtSelectors.map((s, i) => {
      // Line-box GT: the page measured its own painted text (viewport CSS px).
      if (s.lineBox) {
        const b = s.lineBox;
        return {
          i, sel: `pii:${s.type || i}`, type: s.type, dialog: false,
          css: b,
          img: { x: Math.round(b.x * dpr), y: Math.round(b.y * dpr), w: Math.round(b.w * dpr), h: Math.round(b.h * dpr) },
        };
      }
      const el = document.querySelector(s.sel);
      if (!el) return { i, sel: s.sel, type: s.type, missing: true };
      const r = el.getBoundingClientRect();
      // Only VISIBLE boxes are redaction ground truth: a field scrolled (or
      // zoomed) out of the viewport is not in the screenshot at all — the
      // detector skips it for exactly that reason.
      const visible = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      if (!visible) return { i, sel: s.sel, type: s.type, offscreen: true };
      return {
        i, sel: s.sel, type: s.type, dialog: Boolean(s.dialog),
        css: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        img: { x: Math.round(r.left * dpr), y: Math.round(r.top * dpr), w: Math.round(r.width * dpr), h: Math.round(r.height * dpr) },
      };
    }).filter(b => !b.missing && !b.offscreen && b.css.w > 2 && b.css.h > 2);

    async function toCanvas(url) {
      const bmp = await createImageBitmap(await (await fetch(url)).blob());
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      return c;
    }
    const raw = await toCanvas(imageDataUrl);
    const san = await toCanvas(sanitizedDataUrl);
    const sx = san.width / raw.width, sy = san.height / raw.height;
    const S = 10; // sample grid per box
    const results = boxes.map(b => {
      const samplesRaw = [], samplesSan = [];
      const rc = raw.getContext('2d'), sc = san.getContext('2d');
      let diff = 0, n = 0;
      for (let px = 0; px < S; px++) for (let py = 0; py < S; py++) {
        const fx = b.img.x + ((px + 0.5) / S) * b.img.w;
        const fy = b.img.y + ((py + 0.5) / S) * b.img.h;
        const a = rc.getImageData(Math.min(raw.width - 1, fx | 0), Math.min(raw.height - 1, fy | 0), 1, 1).data;
        const d = sc.getImageData(Math.min(san.width - 1, (fx * sx) | 0), Math.min(san.height - 1, (fy * sy) | 0), 1, 1).data;
        diff += (Math.abs(a[0] - d[0]) + Math.abs(a[1] - d[1]) + Math.abs(a[2] - d[2])) / 3;
        n++;
      }
      const meanDiff = diff / Math.max(1, n);
      return { ...b, meanPixelDiff: Math.round(meanDiff * 10) / 10, pixelRedacted: meanDiff > 24 };
    });
    return { boxes: results, rawSize: { w: raw.width, h: raw.height }, sanSize: { w: san.width, h: san.height } };
  }, { gtSelectors, imageDataUrl, sanitizedDataUrl, dpr });
}

// ── region matching (image-px GT vs manifest) ────────────────────────────────
const area = (b) => Math.max(0, b.w) * Math.max(0, b.h);
const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const iou = (a, b) => { const i = inter(a, b); const u = area(a) + area(b) - i; return u > 0 ? i / u : 0; };
const cover = (gt, det) => area(gt) > 0 ? inter(gt, det) / area(gt) : 0;

function scoreRedaction(gtBoxes, manifest, rawSize) {
  const pageArea = rawSize.w * rawSize.h;
  let coveredCount = 0, iouSum = 0, underRed = 0, leaked = 0;
  const perGt = gtBoxes.map(g => {
    const best = manifest.reduce((m, d) => Math.max(m, cover(g.img, d.bounds)), 0);
    const bestIou = manifest.reduce((m, d) => Math.max(m, iou(g.img, d.bounds)), 0);
    const cov = Math.min(1, best);
    coveredCount += cov >= 0.5 ? 1 : 0;
    underRed += cov < 0.5 ? 1 : 0;
    leaked += (cov < 0.5 && !g.pixelRedacted) ? 1 : 0;
    iouSum += bestIou;
    return { sel: g.sel, type: g.type, coverage: r3(cov), iou: r3(bestIou), pixelRedacted: g.pixelRedacted, ok: cov >= 0.5 && g.pixelRedacted };
  });
  // over-redaction: manifest area outside every GT box
  const overArea = manifest.reduce((acc, d) => {
    const touching = gtBoxes.some(g => inter(g.img, d.bounds) > 0);
    return acc + (touching ? 0 : area(d.bounds));
  }, 0);
  return {
    perGt,
    coverage: r3(coveredCount / Math.max(1, gtBoxes.length)),
    meanIou: r3(iouSum / Math.max(1, gtBoxes.length)),
    overRedactionPct: Math.round((overArea / Math.max(1, pageArea)) * 10000) / 100,
    underRedactionCount: underRed,
    pixelLeakCount: leaked,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
const report = {
  meta: {
    type: 'browser',
    benchmark: 'real-browser-perception',
    generatedAt: new Date().toISOString(),
    tiers: [...TIERS],
    environment: ENV_LABEL,
    headed: HEADED,
    channel: CHANNEL,
    note: `Every number below was measured by rendering the benchmark pages in Chromium, screenshotting them, and running the real extension perception pipeline (privacy-filter.js) in-page. No value is asserted or imported from the Node suites. environment=${ENV_LABEL} — ${ENV_LABEL === 'real-hardware-headed' ? 'REAL USER HARDWARE: valid for production claims.' : 'headless CI (software GL): valid for regression tracking ONLY, never for production claims.'}`,
  },
  environment: {},
  visualContext: null,
  redactionMatrix: null,
  ocrVisualPii: null,
  resources: null,
};

const srv = await serve();
const browser = await chromium.launch({ headless: !HEADED, channel: CHANNEL, args: ['--disable-dev-shm-usage', '--force-color-profile=srgb'] });
const scanSrc = extractPageContextScan();
try {
  // ── Tier A: visual-context (DOM vs ViT split) ────────────────────────────
  if (TIERS.has('visual')) {
    console.log('\n[visual] rendering 12 page types…');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const vitLoadMs = [], perPage = [];
    let vitPage = null;
    if (VIT_ENABLED) {
      // The ViT model lives on ONE persistent page — window state does not
      // survive navigations, so a dedicated page hosts the pipeline.
      vitPage = await ctx.newPage();
      // Same-origin page hosts the pipeline (module imports need the origin).
      await vitPage.goto(`${BASE}/OpenCometBench/pages/login.html`, { waitUntil: 'load' });
      const vitModUrl = `${BASE}/src/vendor/transformers/transformers.min.js`;
      vitLoadMs.push(await vitPage.evaluate(async (vitModUrl) => {
        const t0 = performance.now();
        const mod = await import(vitModUrl);
        window.__vit = await mod.pipeline('image-classification', 'Xenova/vit-base-patch16-224', { quantized: true });
        return Math.round(performance.now() - t0);
      }, vitModUrl));
    }
    for (const name of VISUAL_PAGES) {
      const pixelsOnlyPage = PIXEL_ONLY_PAGES.includes(name);
      const page = await openPage(ctx, `${BASE}/OpenCometBench/pages/${name}`);
      await page.waitForTimeout(250); // fonts/layout settle
      const shot = await page.screenshot({ type: 'png' });
      const imageDataUrl = `data:image/png;base64,${shot.toString('base64')}`;
      const gt = await page.evaluate(() => window.__SIH_GT__);
      const dom = await page.evaluate(async () => {
        const cb = String(performance.now() | 0);
        const { classifyVisualContext } = await import(`/src/lib/page-classifier.js?cb=${cb}`);
        const scan = window.__sihPageContextScan();
        return { scan, ctx: classifyVisualContext({ url: location.origin + location.pathname, title: document.title, text: scan.text, dom: scan.census }, null) };
      });
      let vit = null, vitMs = null;
      if (VIT_ENABLED) {
        const t0 = Date.now();
        vit = await vitPage.evaluate(async ({ imageDataUrl }) => {
          const bmp = await createImageBitmap(await (await fetch(imageDataUrl)).blob());
          const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
          c.getContext('2d').drawImage(bmp, 0, 0);
          const out = await window.__vit(c);
          return out.slice(0, 5).map(l => ({ label: l.label, score: Math.round(l.score * 1000) / 1000 }));
        }, { imageDataUrl });
        vitMs = Date.now() - t0;
      }
      const fused = vit && vit.length ? await page.evaluate(async ({ imageDataUrl, vit }) => {
        const cb = String(performance.now() | 0);
        const { classifyVisualContext } = await import(`/src/lib/page-classifier.js?cb=${cb}`);
        const scan = window.__sihPageContextScan();
        return classifyVisualContext({ url: location.origin + location.pathname, title: document.title, text: scan.text, dom: scan.census }, vit);
      }, { imageDataUrl, vit }) : null;
      // v1.14 element-source completeness: split GT controls by derivation.
      //   dom-semantic → must be found in the classifier's visualElements
      //   pixels-only  → DOM-invisible BY DESIGN; the honest measured value
      //                  is what the census-level canvas/SVG signal saw
      const gtControls = (gt.actionControls || []);
      const domGt = gtControls.filter(c => (c.via || 'dom-semantic') === 'dom-semantic');
      const pxGt = gtControls.filter(c => c.via === 'pixels-only');
      const completeness = (() => {
        const want = new Set(domGt
          .map(c => (c.kind === 'submit' || c.kind === 'button') ? 'button' : null)
          .filter(Boolean));
        if ((gt.importantElements || []).includes('form')) want.add('form');
        if (!want.size) return null;
        const els = (fused || dom.ctx).visualElements || [];
        return r3([...want].filter(k => els.includes(k)).length / want.size);
      })();
      perPage.push({
        page: name, expect: gt.pageType,
        pixelsOnlyPage,
        domType: dom.ctx.pageType, domConfidence: dom.ctx.confidence,
        vitLabels: vit, vitMs, vitLoadMs: vitLoadMs[0] ?? null,
        fusedType: fused?.pageType ?? null, fusedConfidence: fused?.confidence ?? null,
        elements: (fused || dom.ctx).visualElements,
        okDom: pixelsOnlyPage ? null : (dom.ctx.pageType === gt.pageType),
        okFused: pixelsOnlyPage ? null : (fused ? fused.pageType === gt.pageType : null),
        pixelControls: pxGt.length ? {
          gt: pxGt.length,
          foundInDomElements: pxGt.filter(c => ((fused || dom.ctx).visualElements || []).includes('button')).length,
          censusCanvasSignal: Boolean(dom.ctx.sources?.census?.used),
        } : undefined,
        completeness,
      });
      console.log(`  ${name.padEnd(20)} expect=${gt.pageType.padEnd(11)} dom=${String(dom.ctx.pageType).padEnd(11)} fused=${String(fused?.pageType ?? '—').padEnd(11)} conf=${(fused?.confidence ?? dom.ctx.confidence).toFixed(2)}${pixelsOnlyPage ? ' [pixels-only]' : ''}`);
      await page.close();
    }
    await ctx.close();
    const accRows = perPage.filter(p => !p.pixelsOnlyPage);
    const n = accRows.length;
    const pxRows = perPage.filter(p => p.pixelsOnlyPage);
    report.visualContext = {
      meta: { type: 'browser', n, note: 'DOM-derived = classifyVisualContext on the real DOM census only. ViT-fused = same + real Xenova/vit-base-patch16-224 top-5 labels on the real screenshot. Pixel-only-control pages (canvas-controls, svg-controls) are reported SEPARATELY — they carry no DOM evidence by design.' },
      pageTypeAccuracy: {
        domDerived: r3(accRows.filter(p => p.okDom).length / n),
        vitFused: VIT_ENABLED ? r3(accRows.filter(p => p.okFused).length / n) : null,
        n,
        rows: perPage,
      },
      // v1.14 element-source split (SIH brief Task: ground truth by derivation)
      elementSources: {
        domSemantic: {
          n: accRows.length,
          completeness: (() => { const v = accRows.map(p => p.completeness).filter(x => x != null); return v.length ? r3(mean(v)) : null; })(),
        },
        pixelsOnly: {
          pages: pxRows.map(p => p.page),
          gtControls: pxRows.reduce((a, p) => a + (p.pixelControls?.gt || 0), 0),
          foundInDomElements: pxRows.reduce((a, p) => a + (p.pixelControls?.foundInDomElements || 0), 0),
          censusCanvasSignalPages: pxRows.filter(p => p.pixelControls?.censusCanvasSignal).length,
          note: 'Pixel-only controls are INVISIBLE to DOM-derived elements by design — foundInDomElements=0 is the honest expected value, the same limitation that motivates the OCR and visual-detector paths (measured separately in the ocr tier and the adversarial benchmark).',
        },
      },
      contextCompleteness: (() => { const v = accRows.map(p => p.completeness).filter(x => x != null); return v.length ? r3(mean(v)) : null; })(),
      falsePositives: accRows.filter(p => !p.okDom && p.expect === 'unknown').map(p => p.page),
      meanConfidence: r3(mean(accRows.map(p => p.fusedConfidence ?? p.domConfidence))),
      vit: { loadMs: vitLoadMs[0] ?? null, enabled: VIT_ENABLED },
    };
  }

  // ── Tier B: redaction matrix ─────────────────────────────────────────────
  if (TIERS.has('redaction')) {
    console.log('\n[redaction] DPR × zoom × scroll × dialog matrix on redaction-lab.html…');
    const runs = [];
    for (const dpr of DPRS) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr });
      for (const zoom of ZOOMS) {
        for (const scroll of SCROLLS) {
          for (const dialogOpen of DIALOGS) {
            const page = await openPage(ctx, `${BASE}/OpenCometBench/pages/redaction-lab.html`);
                  await page.evaluate((z) => { document.documentElement.style.zoom = String(z); }, zoom);
            await page.evaluate((s) => {
              const h = document.body.scrollHeight - innerHeight;
              scrollTo(0, s === 'top' ? 0 : s === 'middle' ? Math.round(h / 2) : h);
            }, scroll);
            if (dialogOpen) await page.click('#rl-open-dialog');
            await page.waitForTimeout(180);
            const shot = await page.screenshot({ type: 'png' });
            const imageDataUrl = `data:image/png;base64,${shot.toString('base64')}`;
            const gtSelectors = await page.evaluate(() => (window.__SIH_GT__.sensitiveElements || [])
              .map(s => ({ sel: s.selector, type: s.type, dialog: Boolean(s.dialog) })));
            const t0 = Date.now();
            const result = await runPipelineInPage(page, { imageDataUrl, dpr, ocr: false, yolo: false, faces: false });
            const ms = Date.now() - t0;
            const verify = await verifyRedactionInPage(page, { gtSelectors, imageDataUrl, sanitizedDataUrl: result.sanitizedDataUrl, dpr });
            const manifestRegions = (result.manifest || []).map(m => ({ type: m.type, bounds: m.bounds }));
            const score = scoreRedaction(verify.boxes, manifestRegions, verify.rawSize);
            runs.push({ dpr, zoom, scroll, dialogOpen, pipelineMs: ms, ...score });
            console.log(`  dpr=${dpr} zoom=${zoom} scroll=${scroll.padEnd(6)} dialog=${dialogOpen ? 'open ' : 'off '} → coverage=${score.coverage} IoU=${score.meanIou} leak=${score.pixelLeakCount}/${verify.boxes.length} over=${score.overRedactionPct}% (${ms}ms)`);
            await page.close();
          }
        }
      }
      await ctx.close();
    }
    const n = runs.length;
    const avg = (f) => r3(mean(runs.map(f)));
    report.redactionMatrix = {
      meta: { type: 'browser', n, note: 'Each run: fresh context at the DPR, CSS-zoom emulating browser zoom, real scroll position, dialog state toggled, real screenshot, real pipeline, GT boxes measured live and pixel-verified.' },
      coverage: { avg: avg(r => r.coverage), min: Math.min(...runs.map(r => r.coverage)), n },
      meanIou: { avg: avg(r => r.meanIou), min: Math.min(...runs.map(r => r.meanIou)), n },
      overRedactionPct: { avg: avg(r => r.overRedactionPct), max: Math.max(...runs.map(r => r.overRedactionPct)) },
      pixelLeakage: { totalLeaks: runs.reduce((a, r) => a + r.pixelLeakCount, 0), totalGtBoxes: runs.reduce((a, r) => a + r.perGt.length, 0) },
      pipelineMs: { p50: pct(runs.map(r => r.pipelineMs), 0.5), p90: pct(runs.map(r => r.pipelineMs), 0.9), p95: pct(runs.map(r => r.pipelineMs), 0.95) },
      runs,
    };
  }

  // ── Tier C: OCR visual-PII ───────────────────────────────────────────────
  if (TIERS.has('ocr')) {
    console.log('\n[ocr] pixel-only PII (canvas / SVG image / PDF-like), OCR on vs off…');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    const page = await openPage(ctx, `${BASE}/OpenCometBench/pages/pii-visual.html`);
    const shot = await page.screenshot({ type: 'png' });
    const imageDataUrl = `data:image/png;base64,${shot.toString('base64')}`;
    // GT = the page's OWN measured painted-text line boxes (viewport-absolute
    // CSS px) — an OCR hit should cover the TEXT LINE, not the whole canvas.
    const gtSelectors = await page.evaluate(() => (window.__SIH_GT__.ocrPiiBoxes || []).map(l => ({ sel: null, lineBox: l.box, type: l.type || 'visual_pii' })));
    const ocrLoadMs = await page.evaluate(async () => {
      const cb = String(performance.now() | 0);
      const t0 = performance.now();
      // warm the vendored engine through the real pipeline's import path
      const { scanImageForPiiRegions } = await import(`/src/lib/ocr-pii.js?cb=${cb}`);
      await scanImageForPiiRegions('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=');
      return Math.round(performance.now() - t0);
    });
    const runOne = async (ocr) => {
      const result = await runPipelineInPage(page, { imageDataUrl, dpr: 1, ocr, yolo: false, faces: false });
      const verify = await verifyRedactionInPage(page, { gtSelectors, imageDataUrl, sanitizedDataUrl: result.sanitizedDataUrl, dpr: 1 });
      const manifestRegions = (result.manifest || []).map(m => ({ type: m.type, bounds: m.bounds }));
      return { ocr, score: scoreRedaction(verify.boxes, manifestRegions, verify.rawSize), counts: result.stats.counts, manifest: manifestRegions, stats: { ocrFailed: result.stats.ocrFailed || false, ocrFailedReason: result.stats.ocrFailedReason || '' } };
    };
    const withOcr = await runOne(true);
    console.log(`  OCR ON : regions=${withOcr.counts.ocrPii} covered=${withOcr.score.coverage} pixelRedacted=${withOcr.score.perGt.filter(g => g.pixelRedacted).length}/${withOcr.score.perGt.length}`);
    const withoutOcr = await runOne(false);
    console.log(`  OCR OFF: regions=${withoutOcr.counts.ocrPii} covered=${withoutOcr.score.coverage} (expected leak — DOM-only cannot see pixels)`);
    report.ocrVisualPii = {
      meta: {
        type: 'browser', n: withOcr.score.perGt.length,
        note: 'PII exists ONLY as pixels (canvas paint, SVG data-URL image, aria-free absolutely-positioned PDF-like block). The DOM text contains none of it. ocrLoadMs = vendored engine cold start (first use, local files).',
      },
      ocrEngineLoadMs: ocrLoadMs,
      ocrFoundTypes: (withOcr.manifest || []).map(m => m.type),
      ocrOn: withOcr, ocrOff: withoutOcr,
      failClosedVerified: null, // set below via node-side firewall unit behaviour
    };
    // fail-closed proof (Node, same modules): OCR-failed stats must fail verification
    // Node ESM accepts a POSIX absolute path but Windows drive paths must be
    // converted to file:// URLs before dynamic import.
    const firewallUrl = pathToFileURL(join(ROOT, 'src', 'lib', 'privacy-firewall.js')).href;
    const { sanitizeScreenContext, validateSanitizedPayload } = await import(firewallUrl);
    const env = sanitizeScreenContext({ sanitizedDataUrl: 'data:image/jpeg;base64,AAAA', sanitizedDomText: 'x', manifest: [], stats: { counts: {}, totalMs: 5, ocrFailed: true, ocrFailedReason: 'engine unavailable' } }, {});
    report.ocrVisualPii.failClosedVerified = env.privacyVerification.passed === false
      && validateSanitizedPayload({ privacyVerification: env.privacyVerification, sanitizedImage: 'data:image/jpeg;base64,AAAA', sanitizedText: 'x', safeManifest: env.safeManifest }).ok === false;
    await page.close(); await ctx.close();
  }

  // ── Tier D: resources ────────────────────────────────────────────────────
  if (TIERS.has('resources')) {
    console.log('\n[resources] per-phase percentiles over 7 real pipeline runs…');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    const page = await openPage(ctx, `${BASE}/OpenCometBench/pages/redaction-lab.html`);
    const shot = await page.screenshot({ type: 'png' });
    const imageDataUrl = `data:image/png;base64,${shot.toString('base64')}`;
    // warm all engines once (model load times measured separately)
    await runPipelineInPage(page, { imageDataUrl, dpr: 2, ocr: true, yolo: true, faces: true });
    const heapBefore = await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);
    const runs = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      const r = await runPipelineInPage(page, { imageDataUrl, dpr: 2, ocr: true, yolo: true, faces: true });
      const wall = Math.round(performance.now() - t0);
      runs.push({ wallMs: wall, phaseMs: r.stats.phaseMs, payloadKb: Math.round((r.sanitizedDataUrl.length * 0.75) / 1024), backend: r.stats.backend, counts: r.stats.counts });
      console.log(`  run ${i + 1}: ${wall}ms · phases ${Object.entries(r.stats.phaseMs).map(([k, v]) => `${k}=${v}`).join(' ')} · payload=${runs[i].payloadKb}KB · backend=${r.stats.backend}`);
    }
    const heapAfter = await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);
    // v1.14.2 — CHANGED-FRAME (memo-MISS) measurement: the honest counterpart
    // of the warm steady state above. The 7 runs above re-sanitize the SAME
    // pixels (memo hits → objectDetect ≈ 0); THIS run alters the page pixels,
    // takes a fresh screenshot (different bytes → different memo key → the
    // detector MUST re-run) and measures the full changed-frame cost on THIS
    // hardware. One identical-frame follow-up proves the memo re-hits after
    // the miss. Never quote the warm total without this number alongside it.
    await page.evaluate(() => {
      const b = document.createElement('div');
      b.id = 'sih-changed-frame-marker';
      b.style.cssText = 'position:fixed;top:0;left:0;right:0;height:44px;z-index:2147483647;background:#0b2545;color:#fff;font:14px monospace;display:flex;align-items:center;padding:0 14px;';
      b.textContent = 'changed-frame probe marker ' + Date.now() + '-' + Math.random().toString(36).slice(2);
      document.body.appendChild(b);
    });
    const changedShot = await page.screenshot({ type: 'png' });
    const changedDataUrl = `data:image/png;base64,${changedShot.toString('base64')}`;
    const tChange = performance.now();
    const changedRun = await runPipelineInPage(page, { imageDataUrl: changedDataUrl, dpr: 2, ocr: true, yolo: true, faces: true });
    const changedWall = Math.round(performance.now() - tChange);
    const tReHit = performance.now();
    const reHitRun = await runPipelineInPage(page, { imageDataUrl: changedDataUrl, dpr: 2, ocr: true, yolo: true, faces: true });
    const reHitWall = Math.round(performance.now() - tReHit);
    console.log(`  changed-frame (memo MISS expected): wall=${changedWall}ms objectDetect=${changedRun.stats.phaseMs.objectDetect}ms memoHit=${changedRun.stats.yoloMemoHit === true} · identical re-capture: wall=${reHitWall}ms objectDetect=${reHitRun.stats.phaseMs.objectDetect}ms memoHit=${reHitRun.stats.yoloMemoHit === true}`);
    // v1.14: REAL-HARDWARE fingerprint — GPU adapter + CPU/RAM so production
    // claims are tied to real silicon, never to CI software GL.
    report.environment = await page.evaluate(async () => {
      const env = {
        userAgent: navigator.userAgent,
        platform: navigator.platform || '',
        cpuCores: navigator.hardwareConcurrency || null,
        deviceMemoryGb: navigator.deviceMemory || null,
        webglRenderer: null,
        webgpuAdapter: null,
      };
      try {
        const gl = document.createElement('canvas').getContext('webgl');
        const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
        if (gl && dbg) env.webglRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      } catch { /* headless software GL reports software */ }
      try {
        const adapter = await navigator.gpu?.requestAdapter?.();
        if (adapter) {
          const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
          env.webgpuAdapter = { vendor: info.vendor || '', architecture: info.architecture || '', device: info.device || '' };
        }
      } catch { /* no webgpu */ }
      return env;
    });
    const faceStats = await page.evaluate(async () => {
      const cb = String(performance.now() | 0);
      const { getFaceDetectorStats } = await import(`/src/lib/mediapipe-face.js?cb=${cb}`);
      return getFaceDetectorStats();
    });
    const vitLoad = report.visualContext?.vit?.loadMs ?? null;
    const agg = {};
    for (const key of ['faceDetect', 'objectDetect', 'vit', 'ocr', 'domScan', 'textScan', 'redact']) {
      const vals = runs.map(r => r.phaseMs[key] || 0);
      agg[key] = { p50: pct(vals, 0.5), p90: pct(vals, 0.9), p95: pct(vals, 0.95), mean: Math.round(mean(vals)) };
    }
    report.resources = {
      meta: { type: 'browser', n: runs.length, note: 'In-browser measurements on the REAL pipeline (DPR 2, all detectors enabled). VLM/upload/serialization are measured by the E2E tier and the runner page — Node timings are never used as browser latencies.' },
      sanitizeTotalMs: { p50: pct(runs.map(r => r.wallMs), 0.5), p90: pct(runs.map(r => r.wallMs), 0.9), p95: pct(runs.map(r => r.wallMs), 0.95) },
      phasesMs: agg,
      payloadKb: { mean: Math.round(mean(runs.map(r => r.payloadKb))), range: [Math.min(...runs.map(r => r.payloadKb)), Math.max(...runs.map(r => r.payloadKb))] },
      models: {
        mediapipe: faceStats || null,
        vitLoadMs: vitLoad,
        ocrEngineLoadMs: report.ocrVisualPii?.ocrEngineLoadMs ?? null,
      },
      heap: { beforeMb: heapBefore, afterMb: heapAfter, deltaMb: heapBefore != null && heapAfter != null ? heapAfter - heapBefore : null },
      backend: runs[0]?.backend || null,
      changedFrame: {
        objectDetectMs: changedRun.stats.phaseMs.objectDetect || 0,
        ocrMs: changedRun.stats.phaseMs.ocr || 0,
        wallMs: changedWall,
        yoloMemoHit: changedRun.stats.yoloMemoHit === true,
        reHitWallMs: reHitWall,
        reHitObjectDetectMs: reHitRun.stats.phaseMs.objectDetect || 0,
        reHitYoloMemoHit: reHitRun.stats.yoloMemoHit === true,
        note: 'CHANGED-FRAME (memo MISS): the page pixels were altered and a fresh screenshot sanitized once — objectDetectMs is the REAL full re-detection cost on this hardware and wallMs is the changed-frame sanitize total. sanitizeTotalMs/phasesMs above are the memo-HIT warm steady state of the SAME build and environment. Both numbers carry the same environment label; never quote one without the other.',
      },
    };
    await page.close(); await ctx.close();
  }
} finally {
  await browser.close();
  srv.close();
}

mkdirSync(OUT_DIR, { recursive: true });
const out = join(OUT_DIR, `browser-benchmark-${Date.now()}.json`);
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\nwrote ${out}`);
console.log(JSON.stringify({
  visualContext: report.visualContext?.pageTypeAccuracy ? {
    dom: report.visualContext.pageTypeAccuracy.domDerived,
    fused: report.visualContext.pageTypeAccuracy.vitFused,
  } : null,
  redaction: report.redactionMatrix ? {
    coverage: report.redactionMatrix.coverage.avg,
    iou: report.redactionMatrix.meanIou.avg,
    leaks: report.redactionMatrix.pixelLeakage,
  } : null,
  ocr: report.ocrVisualPii ? {
    onCoverage: report.ocrVisualPii.ocrOn.score.coverage,
    offCoverage: report.ocrVisualPii.ocrOff.score.coverage,
    failClosed: report.ocrVisualPii.failClosedVerified,
  } : null,
}, null, 2));
