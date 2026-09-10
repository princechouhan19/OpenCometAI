#!/usr/bin/env node
// OpenCometBench/probe-small-avatar.mjs
// Reproduces the USER-REPORTED bug: small profile photos (~64×72 CSS px) get
// "Faces detected: 0" — the photo stays visible in the sanitized capture —
// even though every text/DOM PII family redacts correctly.
//
// The replica mirrors the user's "Master Perception Test" section-4 layout:
//   • "Real Profile Photo" card: small <img class="profile-photo"> (64×72 CSS)
//   • an invoice row with a 32×32 GENERIC person-icon SVG (negative control:
//     must NEVER be redacted — it contains no human face)
// Viewport 1280×720 @ DPR 1 — same as the user's capture stats.
//
// Runs the REAL runPrivacyPipeline (vendored MediaPipe + cascade) in headless
// chromium and prints: faces, byType redactions, cascade debug, and — after
// the fix — the dom-sweep stage lines. Also verifies the new pageContextScan
// photoCandidates collector once implemented.
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = '/home/z/my-project/upload/OpenCometAI-SIH-extracted/OpenCometAI-SIH';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.tflite': 'application/octet-stream' };
const srv = createServer((q, r) => {
  const f = ROOT + new URL(q.url, 'http://x').pathname;
  if (!existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': MIME[f.slice(f.lastIndexOf('.'))] || 'application/octet-stream' });
  r.end(readFileSync(f));
});
await new Promise(r => srv.listen(8897, '127.0.0.1', r));

// Reuse the synthetic (public-domain) portrait from the adversarial suite.
const faceHtml = readFileSync(ROOT + '/OpenCometBench/e2e/adversarial/priv-face.html', 'utf8');
const mFace = faceHtml.match(/<img id="cam" src="(data:image\/jpeg;base64,[^"]+)"/);
if (!mFace) { console.error('portrait not found'); process.exit(1); }
const PORTRAIT = mFace[1];

const PAGE = (opts) => `<!doctype html><html><head><meta charset="utf-8"><title>Master Perception Replica</title>
<style>
  body{font:14px/1.45 Arial,Helvetica,sans-serif;margin:0;background:#f5f6fa;color:#1c2333}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:24px;max-width:1160px;margin:0 auto}
  .card{background:#fff;border:1px solid #dfe3ee;border-radius:10px;padding:16px 18px}
  h4{margin:0 0 10px;font-size:14px;color:#33415c}
  .profile-row{display:flex;gap:14px;align-items:center;border:1px solid #e4e7f2;border-radius:8px;padding:10px;${opts.right ? 'margin-left:auto;width:320px;' : ''}}
  .profile-photo{width:${opts.size}px;height:${Math.round(opts.size * 1.125)}px;border-radius:6px;object-fit:cover;${opts.grayscale ? 'filter:grayscale(1) contrast(0.82);' : ''}}
  .t{font-weight:bold}.d{font-size:12px;color:#6b7490}
  .invoice{display:flex;justify-content:space-between;align-items:center;border:1px solid #e4e7f2;border-radius:8px;padding:8px 12px;margin-top:10px}
  .invoice svg{width:32px;height:32px;border-radius:50%;background:#e8ebf4}
  .fields{margin-top:12px}
  input{font:13px Arial;padding:5px 8px;border:1px solid #c9cfdf;border-radius:6px;width:200px}
  ${opts.canvas ? '.chart{width:420px;height:120px;border:1px solid #dde1ec;background:#fff}' : ''}
</style></head><body>
<div class="grid">
  <div class="card">
    <h4>Text &amp; Sensitive Fields</h4>
    <div class="fields">
      <div><label>Full name</label><input value="Aarav Sharma"></div>
      <div><label>Email</label><input type="email" value="aarav.sharma@example.com"></div>
      <div><label>PAN-like ID</label><input value="ABCDE1234F"></div>
    </div>
    ${opts.canvas ? '<canvas class="chart" width="420" height="120"></canvas>' : ''}
  </div>
  <div class="card">
    <h4>Images &amp; Graphics</h4>
    <div class="profile-row">
      <img class="profile-photo" src="${PORTRAIT}" alt="Real Profile Photo">
      <div><div class="t">Real Profile Photo</div><div class="d">Public-domain photograph · face-detection test</div></div>
    </div>
    <div class="invoice">
      <div><b>VIRTUAL INVOICE</b><div class="d">Customer: Pixel Only User</div><div class="d">Invoice email: billing.pixel@example.com</div></div>
      <svg viewBox="0 0 24 24" fill="#8b93ab"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6z"/></svg>
    </div>
  </div>
</div>
</body></html>`;

const { readFileSync: rf } = await import('node:fs');
const src = rf(ROOT + '/src/lib/privacy-agent.js', 'utf8');
function extractFunc(name) {
  const start = src.indexOf(`function ${name}() {`);
  if (start < 0) return null;
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) return src.slice(start, i + 1); } }
  return null;
}
const scanSrc = extractFunc('pageContextScan');
if (!scanSrc) { console.error('pageContextScan not found'); process.exit(1); }

const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });

// Variants — hunt for the user's "Faces detected: 0" condition:
//  A: DPR 1, 64px photo (baseline — cascade should catch)
//  B: DPR 1.25 (Windows default scaling), 64px photo
//  C: DPR 1.25, 48px grayscale photo pushed to the far right (NORMAL-risk page:
//     no video, 1 canvas → fine-tile cap 16 + even sampling can skip the tile)
const VARIANTS = [
  { id: 'A-dpr1-64px', dpr: 1, opts: { size: 64 } },
  { id: 'B-dpr1.25-64px', dpr: 1.25, opts: { size: 64 } },
  { id: 'C-dpr1.25-48px-gray-right-canvas', dpr: 1.25, opts: { size: 48, grayscale: true, right: true, canvas: true } },
  { id: 'D-cascade-disabled-dom-sweep', dpr: 1, opts: { size: 64 } },
];

for (const v of VARIANTS) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: v.dpr });
  const page = await ctx.newPage();
  await page.addInitScript(`${scanSrc}\nwindow.__sihPageContextScan = () => pageContextScan();`);
  await page.route('**/replica.html', route => route.fulfill({ contentType: 'text/html', body: PAGE(v.opts) }));
  await page.goto('http://127.0.0.1:8897/replica.html', { waitUntil: 'networkidle' });

  const scan = await page.evaluate(() => window.__sihPageContextScan());
  if (v.id === VARIANTS[0].id) {
    console.log('=== pageContextScan (variant A) ===');
    console.log('photoCandidates:', JSON.stringify(scan.photoCandidates || null, null, 1));
    console.log('sensitive types:', scan.sensitive.map(s => s.type).join(', '));
  }

  async function runPipeline(label) {
    return page.evaluate(async (label) => {
      const { runPrivacyPipeline } = await import('/src/lib/privacy-filter.js?cb=' + (performance.now() | 0));
      const { classifyFromDomSignals } = await import('/src/lib/page-classifier.js?cb=' + (performance.now() | 0));
      const scan = window.__sihPageContextScan();
      const imageDataUrl = window.__lastShot;
      const domDecision = classifyFromDomSignals({ url: location.pathname, title: document.title, text: scan.text, dom: scan.census });
      const faceRisk = {
        visuallyHeavy: (scan.census.videos || 0) > 0 || (scan.census.canvases || 0) > 2,
        hasVideo: (scan.census.videos || 0) > 0,
        canvasHeavy: (scan.census.canvases || 0) >= 2,
        pageType: domDecision.best.type,
      };
      const t0 = performance.now();
      const r = await runPrivacyPipeline(
        {
          imageDataUrl, domText: scan.text, domSensitive: scan.sensitive, dom: scan.census,
          pageUrl: location.pathname, pageTitle: document.title, faceRisk,
          ...(scan.photoCandidates ? { photoCandidates: scan.photoCandidates } : {}),
        },
        {
          scaleX: devicePixelRatio, scaleY: devicePixelRatio, maxWidth: 1280, ocrPii: false, runYolo: false, blurFaces: true, redactTextPii: true,
          // Variant D (USER-CONDITION SIMULATION): raise every cascade
          // threshold above 1.0 so full-frame + both tile sweeps are
          // guaranteed empty — exactly the field state "Faces detected: 0" —
          // and the ONLY possible source of a face box is the DOM-guided
          // sweep. The user's harder real photos sit in this state.
          ...(label === 'D-cascade-disabled-dom-sweep' ? { faceDetect: { fullConf: 1.1, tileConf: 1.1, fineTileConf: 1.1 } } : {}),
        },
      );
      return {
        label,
        wallMs: Math.round(performance.now() - t0),
        faces: r.stats.counts.faces,
        byType: r.stats.redactionCounts,
        faceDebug: r.stats.faceDebug && {
          tiles: r.stats.faceDebug.tilesScanned, fineTiles: r.stats.faceDebug.fineTilesScanned,
          rawTileHits: r.stats.faceDebug.rawTileHits, stageKept: r.stats.faceDebug.stageKept,
          highRisk: r.stats.faceDebug.highRisk, fineCap: r.stats.faceDebug.fineCap,
          verifiedDropped: r.stats.faceDebug.verifiedDropped,
        },
        domSweep: r.stats.domSweep,
        pipelineLogs: r.pipelineLogs.filter(l => /Face|Redact|DOM scan/.test(l)),
        sanitized: r.sanitizedDataUrl,
      };
    }, label);
  }

  const shotBuf = await page.screenshot({ type: 'png' });
  const imageDataUrl = `data:image/png;base64,${shotBuf.toString('base64')}`;
  await page.evaluate((d) => { window.__lastShot = d; }, imageDataUrl);

  await runPipeline('warm');
  const r1 = await runPipeline(v.id);
  console.log(`=== ${v.id} (dpr ${v.dpr}) ===`);
  console.log('faces:', r1.faces, '· byType:', JSON.stringify(r1.byType), '· wallMs:', r1.wallMs);
  console.log('faceDebug:', JSON.stringify(r1.faceDebug));
  console.log('domSweep:', JSON.stringify(r1.domSweep));
  for (const l of r1.pipelineLogs) console.log('  |', l);
  const safe = v.id.replace(/[^a-z0-9-]/gi, '_');
  writeFileSync(ROOT + `/OpenCometBench/results/probe-small-avatar-${safe}.png`, Buffer.from(r1.sanitized.split(',')[1], 'base64'));
  await ctx.close();
}
console.log('sanitized shots → OpenCometBench/results/probe-small-avatar-*.png');

await browser.close(); srv.close(); process.exit(0);
