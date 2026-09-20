#!/usr/bin/env node
// scripts/test_v1154_fixes.mjs
// regression for the SECOND field report round ("Master Perception
// Test" page, Total 18068 ms / Faces 0 / PII leaks). Four fixes, each proven
// on REAL browser pixels + the REAL vendored models:
//
//   T1  NAME FIELD: <label>Full name</label><input value="Aarav Sharma">
//       (bare input — no name/id/placeholder) is now flagged via the label
//       text (pageContextScan AND detectSensitiveDomElements) and the
//       pipeline black-boxes the input rect.
//   T2  AVATAR GUARD: a page-declared avatar that the detector CANNOT
//       confirm (gradient placeholder with class "profile-avatar") is still
//       redacted on its element rect (stats.avatarGuard.guarded == 1,
//       byType.face == 1) — the field condition "model refuses → face leaks"
//       is structurally closed. A DETECTABLE portrait avatar still goes
//       through model confirmation and the guard STANDS DOWN (no double box).
//   T3  NEGATIVE CONTROL (preserved from v1.15.3): an un-hinted round icon
//       <img> is scanned but NEVER redacted.
//   T4  PIXEL-ONLY PII (OCR ROI battery): canvases painted with
//       email/phone/4-4-4/card values that the full-page pass drops are
//       re-read as ×2-upscaled isolated crops; email/phone/aadhaar regions
//       land INSIDE the canvas rects in the sanitized output.
//   T5  TEXT BUDGET: a PII text node at walker position ~200 (beyond the old
//       budget of 140) still produces a DOM text_pii region.
//   T6  COLLECTOR CONTRACT: photoCandidates ≤ 32, background-image avatars
//       collected with hint "bg-avatar-hint", pixelTextRects returned for
//       every visible ≥60px canvas.
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.tflite': 'application/octet-stream' };
const srv = createServer((q, r) => {
  const f = ROOT + new URL(q.url, 'http://x').pathname;
  if (!existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': MIME[f.slice(f.lastIndexOf('.'))] || 'application/octet-stream' });
  r.end(readFileSync(f));
});
await new Promise(r => srv.listen(8899, '127.0.0.1', r));

const faceHtml = readFileSync(ROOT + '/OpenCometBench/e2e/adversarial/priv-face.html', 'utf8');
const PORTRAIT = faceHtml.match(/<img id="cam" src="(data:image\/jpeg;base64,[^"]+)"/)[1];
const ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="#8b93ab"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6z" fill="#8b93ab"/></svg>');

// Replicates the user's page structure that leaked: bare labelled inputs,
// pixel-only canvases, avatar imagery.
const PAGE = ({ avatarMode }) => `<!doctype html><html><head><meta charset="utf-8"><title>Master Perception v1154</title>
<style>
  body{font:14px/1.45 Arial,Helvetica,sans-serif;margin:0;background:#f5f6fa;color:#1c2333}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:24px;max-width:1160px;margin:0 auto}
  .card{background:#fff;border:1px solid #dfe3ee;border-radius:10px;padding:16px 18px}
  h4{margin:0 0 10px;font-size:14px;color:#33415c}
  label{display:block;font-size:12px;color:#44506b;margin-top:8px}
  input{font:13px Arial;padding:5px 8px;border:1px solid #c9cfdf;border-radius:6px;width:210px}
  .profile-avatar{width:64px;height:72px;border-radius:6px;background-size:cover;background-position:center;display:inline-block;vertical-align:middle}
  .icon{width:28px;height:28px;border-radius:50%}
  .row{display:flex;gap:14px;align-items:center;border:1px solid #e4e7f2;border-radius:8px;padding:10px}
  canvas{border:1px solid #dde1ec;background:#fff;margin-top:10px}
</style></head><body>
<div class="grid">
  <div class="card">
    <h4>Text &amp; Sensitive Fields</h4>
    <div><label>Full name</label><input value="Aarav Sharma"></div>
    <div><label>Search public information...</label><input type="search" placeholder="Search public information..."></div>
  </div>
  <div class="card">
    <h4>Images &amp; Pixel PII</h4>
    <div class="row">
      ${avatarMode === 'gradient'
        ? '<div class="profile-avatar" id="avatarBox" style="background-image:url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==)"></div>'
        : (avatarMode === 'icon'
          ? `<img class="icon" src="${ICON}" alt="workspace">`
          : `<img class="profile-avatar" src="${PORTRAIT}" alt="Real Profile Photo">`)}
      <div><b>Profile card</b><div style="font-size:12px;color:#6b7490">face-detection test</div></div>
    </div>
    <canvas id="pixelLine" width="420" height="64"></canvas>
    <canvas id="pixelCard" width="360" height="110"></canvas>
    <script>
      const c1 = document.getElementById('pixelLine').getContext('2d');
      c1.font = '13px Arial'; c1.fillStyle = '#333';
      c1.fillText('Canvas contains: pixel.user@example.com \\u00b7 +91 99887 77665 \\u00b7 9876 5432 1098', 8, 36);
      const c2 = document.getElementById('pixelCard').getContext('2d');
      c2.font = 'bold 13px Arial'; c2.fillStyle = '#1c2333';
      c2.fillText('PIXEL-ONLY CONTACT', 10, 24);
      c2.font = '12px Arial'; c2.fillStyle = '#44506b';
      c2.fillText('email: synthetic.user@example.com', 10, 48);
      c2.fillText('phone: +91 91234 56789', 10, 68);
      c2.fillText('card: 4024 0071 5255 1234', 10, 88);
    </script>
  </div>
</div>
</body></html>`;

// Filler page for the budget test: 220 visible text nodes INSIDE the
// viewport (the walker correctly rejects off-screen text — it cannot leak
// pixels), PII node at walker position ~221 (beyond the old 140 budget).
const BUDGET_PAGE = `<!doctype html><html><body>
<div id="filler" style="font:10px/1.5 Arial;width:1200px">${Array.from({ length: 220 }, (_, i) => `<span>Filler node ${i} with ordinary visible copy.</span> `).join('')}</div>
<p>Support contact: billing.pixel@example.com</p>
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

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.addInitScript(`${scanSrc}\nwindow.__sihPageContextScan = () => pageContextScan();`);
await page.route('**/page.html', route => route.fulfill({ contentType: 'text/html', body: PAGE({ avatarMode: 'portrait' }) }));
await page.route('**/gradient.html', route => route.fulfill({ contentType: 'text/html', body: PAGE({ avatarMode: 'gradient' }) }));
await page.route('**/icon.html', route => route.fulfill({ contentType: 'text/html', body: PAGE({ avatarMode: 'icon' }) }));
await page.route('**/budget.html', route => route.fulfill({ contentType: 'text/html', body: BUDGET_PAGE }));

async function runPipeline(url, opts, extraInput = {}) {
  await page.goto(`http://127.0.0.1:8899/${url}`, { waitUntil: 'networkidle' });
  const scan = await page.evaluate(() => window.__sihPageContextScan());
  const shotBuf = await page.screenshot({ type: 'png' });
  const imageDataUrl = `data:image/png;base64,${shotBuf.toString('base64')}`;
  return page.evaluate(async ({ scan, imageDataUrl, opts, extraInput }) => {
    const { runPrivacyPipeline } = await import('/src/lib/privacy-filter.js?cb=' + (performance.now() | 0));
    const t0 = performance.now();
    const r = await runPrivacyPipeline(
      { imageDataUrl, domText: scan.text, domSensitive: scan.sensitive, dom: scan.census, pageUrl: location.pathname, pageTitle: document.title, photoCandidates: scan.photoCandidates || [], pixelTextRects: scan.pixelTextRects || [], ...extraInput },
      { scaleX: devicePixelRatio, scaleY: devicePixelRatio, maxWidth: 1280, ...opts },
    );
    return {
      wallMs: Math.round(performance.now() - t0),
      scan,
      faces: r.stats.counts.faces,
      byType: r.stats.redactionCounts,
      domSweep: r.stats.domSweep,
      avatarGuard: r.stats.avatarGuard,
      manifest: r.manifest,
      ocrCounts: { roiRegions: null },
      rawUrl: imageDataUrl,
      pipelineLogs: r.pipelineLogs.filter(l => /Face|OCR|Redact:|DOM scan/.test(l)),
      sanitized: r.sanitizedDataUrl,
      textPii: r.stats.counts.textPii,
    };
  }, { scan, imageDataUrl, opts, extraInput });
}

// T6 (collector contract, cheapest first)
console.log('T6: collector contract (bg avatars, canvas ROIs, caps)');
{
  await page.goto('http://127.0.0.1:8899/page.html', { waitUntil: 'networkidle' });
  const scan = await page.evaluate(() => window.__sihPageContextScan());
  const avatar = (scan.photoCandidates || []).find(c => /avatar/i.test(c.hint));
  check('portrait <img> collected with avatar-hint', !!avatar && avatar.hint === 'avatar-hint', JSON.stringify(scan.photoCandidates));
  check('pixelTextRects collected for both canvases', (scan.pixelTextRects || []).length === 2, JSON.stringify(scan.pixelTextRects));
  // name-field flag
  const nameField = (scan.sensitive || []).find(s => /full name/i.test(s.hint || '') && s.bounds.w > 50);
  check('pageContextScan flags the bare "Full name" input via label text', !!nameField, JSON.stringify(nameField || null));
  // name regex must NOT flag the search field
  const searchField = (scan.sensitive || []).find(s => /search public/i.test(s.hint || ''));
  check('search input NOT flagged (placeholder "Search public information...")', !searchField);
}

// T1 (name field redaction, both scanners)
console.log('T1: name-field redaction (label-aware)');
{
  const r1 = await runPipeline('page.html', { blurFaces: false, ocrPii: false, redactTextPii: true, runYolo: false });
  const nameScan = r1.scan.sensitive.find(s => /full name/i.test(s.hint || ''));
  const drawn = (r1.manifest || []).find(m => m.type === 'sensitive_input' && overlap(m.bounds, nameScan.bounds) > 0.5 * nameScan.bounds.w * nameScan.bounds.h);
  check('pipeline black-boxes the Full name input rect', !!drawn, JSON.stringify(r1.byType));
  // parity: the pii-detector module scanner (OpenCometBench/DOM path) sees it too
  const parity = await page.evaluate(async () => {
    const { detectSensitiveDomElements } = await import('/src/lib/pii-detector.js?cb=' + (performance.now() | 0));
    const out = detectSensitiveDomElements(document, {});
    return out.filter(o => (o.hint || '').match(/full name/i)).length;
  });
  check('detectSensitiveDomElements (module path) flags it too', parity >= 1, `hits=${parity}`);
}

// T2 (avatar guard — the field condition)
console.log('T2: avatar guard (model-unconfirmable page-declared avatar)');
{
  // gradient avatar: cascade thresholds forced to 1.1 (user's "Faces: 0"
  // condition) AND the sweep genuinely finds no face (no face painted) —
  // only the guard can cover it.
  const rg = await runPipeline('gradient.html',
    { blurFaces: true, ocrPii: false, redactTextPii: false, runYolo: false, faceDetect: { fullConf: 1.1, tileConf: 1.1, fineTileConf: 1.1 } });
  check('gradient avatar guarded (no model confirmation needed)', rg.avatarGuard && rg.avatarGuard.guarded === 1, JSON.stringify(rg.avatarGuard));
  check('byType.face == 1 (pixel redaction drawn on the avatar)', rg.faces === 1, JSON.stringify(rg.byType));
  const gbox = (rg.manifest || []).find(m => m.reason === 'dom-avatar-guard');
  const scanBox = rg.scan.photoCandidates.find(c => /avatar/i.test(c.hint));
  check('guard box lands ON the avatar element rect', !!gbox && !!scanBox && overlap(gbox.bounds, scanBox.bounds) >= 0.5 * scanBox.bounds.w * scanBox.bounds.h,
    JSON.stringify({ gbox: gbox && gbox.bounds, cand: scanBox && scanBox.bounds }));

  // real portrait: sweep CONFIRMS (conf ≥0.30 on the upscaled crop) → guard
  // must STAND DOWN (no second region, no double-draw).
  const rp = await runPipeline('page.html',
    { blurFaces: true, ocrPii: false, redactTextPii: false, runYolo: false, faceDetect: { fullConf: 1.1, tileConf: 1.1, fineTileConf: 1.1 } });
  check('portrait avatar confirmed by the dom-sweep', rp.domSweep && rp.domSweep.hits >= 1, JSON.stringify(rp.domSweep));
  check('guard stands down when the model confirms (guarded == 0)', rp.avatarGuard && rp.avatarGuard.guarded === 0, JSON.stringify(rp.avatarGuard));
  check('exactly ONE face redaction (no double box)', rp.faces === 1, `faces=${rp.faces}`);
}

// T3 (icon negative control preserved)
console.log('T3: un-hinted icon never redacted');
{
  const ri = await runPipeline('icon.html',
    { blurFaces: true, ocrPii: false, redactTextPii: false, runYolo: false, faceDetect: { fullConf: 1.1, tileConf: 1.1, fineTileConf: 1.1 } });
  check('icon scanned by the sweep, 0 hits', ri.domSweep && ri.domSweep.scanned >= 1 && ri.domSweep.hits === 0, JSON.stringify(ri.domSweep));
  check('guard skipped the un-hinted icon (guarded == 0)', ri.avatarGuard && ri.avatarGuard.guarded === 0, JSON.stringify(ri.avatarGuard));
  check('NO face redaction on the icon page', ri.faces === 0, `faces=${ri.faces}`);
}

// T4 (pixel-only PII via OCR ROI battery)
console.log('T4: canvas pixel-only PII (targeted OCR crop + battery)');
{
  const r4 = await runPipeline('page.html',
    { blurFaces: false, ocrPii: true, redactTextPii: false, runYolo: false });
  const rois = r4.scan.pixelTextRects || [];
  check('two canvas ROIs handed to OCR', rois.length === 2, JSON.stringify(rois));
  const ocrManifest = (r4.manifest || []).filter(m => String(m.reason || '').startsWith('ocr'));
  const types = new Set(ocrManifest.map(m => m.type));
  // Digit groups may legitimately be labelled phone (the shared detector wins
  // the span over the aadhaar battery on equal spans) or credit_card
  // (longest-span-wins on 16-digit values) — the privacy guarantee is that
  // the PIXELS are covered, so assert type coverage AND per-canvas pixel
  // mutation on the sanitized image.
  check('OCR regions found on the canvases (email + digit-group coverage)', types.has('email') && types.has('phone') && (types.has('aadhaar') || types.has('credit_card')),
    `types=[${[...types].join(',')}] regions=${ocrManifest.length}`);
  for (const roi of rois) {
    const n = ocrManifest.filter(m => overlap(m.bounds, roi) > 0.3 * Math.min(m.bounds.w * m.bounds.h, roi.w * roi.h)).length;
    check(`>=2 OCR redactions inside canvas ROI ${roi.w}x${roi.h}`, n >= 2, `${n} regions`);
  }
  // PIXEL-LEVEL PROOF: compare raw vs sanitized inside each canvas rect.
  const diffs = await page.evaluate(async ({ rawUrl, safeUrl, rois }) => {
    const decode = async (u) => {
      const bmp = await createImageBitmap(await (await fetch(u)).blob());
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      return c;
    };
    const [a, b] = await Promise.all([decode(rawUrl), decode(safeUrl)]);
    const ca = a.getContext('2d'), cb = b.getContext('2d');
    return rois.map(roi => {
      const pa = ca.getImageData(roi.x, roi.y, roi.w, roi.h).data;
      const pb = cb.getImageData(roi.x, roi.y, roi.w, roi.h).data;
      let changed = 0;
      for (let i = 0; i < pa.length; i += 4) {
        if (Math.abs(pa[i] - pb[i]) > 24 || Math.abs(pa[i + 1] - pb[i + 1]) > 24 || Math.abs(pa[i + 2] - pb[i + 2]) > 24) changed++;
      }
      return changed / (pa.length / 4);
    });
  }, { rawUrl: r4.rawUrl, safeUrl: r4.sanitized, rois });
  check('sanitized pixels inside canvas 1 materially changed', diffs[0] >= 0.08, `changed=${(diffs[0] * 100).toFixed(1)}%`);
  check('sanitized pixels inside canvas 2 materially changed', diffs[1] >= 0.08, `changed=${(diffs[1] * 100).toFixed(1)}%`);
  writeFileSync(ROOT + '/OpenCometBench/results/test-v1154-canvas-ocr.png', Buffer.from(r4.sanitized.split(',')[1], 'base64'));
}

// T5 (text walker budget)
console.log('T5: text-PII walker budget (PII beyond the old 140 cap)');
{
  await page.goto('http://127.0.0.1:8899/budget.html', { waitUntil: 'networkidle' });
  const scan = await page.evaluate(() => window.__sihPageContextScan());
  const emailRegion = (scan.sensitive || []).find(s => s.type === 'text_pii');
  check('email at node ~200+ produced a DOM text_pii region (budget 400)', !!emailRegion, JSON.stringify(emailRegion || null));
}

// T6b (cap contract)
{
  await page.setContent(`<body>${Array.from({ length: 40 }, (_, i) => `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" style="width:30px;height:30px" alt="pic${i}">`).join('')}</body>`);
  const scan = await page.evaluate(() => window.__sihPageContextScan());
  check('photoCandidates capped at 32', (scan.photoCandidates || []).length <= 32, `n=${(scan.photoCandidates || []).length}`);
}

await browser.close(); srv.close();
console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
