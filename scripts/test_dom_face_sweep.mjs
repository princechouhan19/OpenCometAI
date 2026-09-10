#!/usr/bin/env node
// scripts/test_dom_face_sweep.mjs
// v1.15.3 — DOM-guided face sweep regression (user-reported: small profile
// photos get "Faces detected: 0" and stay VISIBLE in the sanitized capture).
//
// Covers, on REAL browser pixels + the REAL vendored MediaPipe model:
//   T1  pageContextScan collects visible <img> rects (avatar rect + score +
//       hint), skips sub-24px icons and src-less images, caps at 32.
//   T2  RESCUE (the user's field condition): with every cascade threshold
//       raised above 1.0 (full-frame + 512px + 256px sweeps guaranteed
//       empty — exactly "Faces detected: 0"), the dom-sweep still detects
//       the face, the redaction lands ON the avatar, byType.face == 1.
//   T3  STAND-DOWN: when the cascade already covers the avatar, the sweep
//       runs ZERO regions (no redundant work, no double redaction).
//   T4  NEGATIVE CONTROL: an icon-only <img> (no human face) is scanned but
//       NOT redacted (byType has no face) — logos/icons are never
//       blanket-redacted.
//   T5  DPR: candidate CSS rects are converted ×DPR before the sweep
//       (1.25×: scanned box ≈ CSS rect × 1.25).
//   T6  Text/DOM PII redaction unchanged on the same page (email still
//       masked in pixels + text channel).
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = '/home/z/my-project/upload/OpenCometAI-SIH-extracted/OpenCometAI-SIH';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.tflite': 'application/octet-stream' };
const srv = createServer((q, r) => {
  const f = ROOT + new URL(q.url, 'http://x').pathname;
  if (!existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': MIME[f.slice(f.lastIndexOf('.'))] || 'application/octet-stream' });
  r.end(readFileSync(f));
});
await new Promise(r => srv.listen(8898, '127.0.0.1', r));

const faceHtml = readFileSync(ROOT + '/OpenCometBench/e2e/adversarial/priv-face.html', 'utf8');
const PORTRAIT = faceHtml.match(/<img id="cam" src="(data:image\/jpeg;base64,[^"]+)"/)[1];
const ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="#8b93ab"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6z" fill="#8b93ab"/></svg>');

const PAGE = ({ icon }) => `<!doctype html><html><head><meta charset="utf-8"><title>Sweep Test</title>
<style>
 body{font:14px Arial;margin:0;background:#f5f6fa}
 .card{background:#fff;border:1px solid #dfe3ee;border-radius:10px;padding:16px;margin:24px;max-width:420px}
 .profile-photo{width:64px;height:72px;border-radius:6px;object-fit:cover}
 .row{display:flex;gap:12px;align-items:center}
 input{font:13px Arial;padding:5px 8px;border:1px solid #c9cfdf;border-radius:6px;width:200px;margin-top:8px}
 .icon{width:28px;height:28px;border-radius:50%}
</style></head><body><div class="card">
 <div class="row">
   <img class="${icon ? 'icon' : 'profile-photo'}" src="${icon ? ICON : PORTRAIT}" alt="${icon ? 'workspace' : 'Real Profile Photo'}">
   <div><b>Profile card</b></div>
 </div>
 <input type="email" value="tester.person@example.com">
</div></body></html>`;

const { readFileSync: rf } = await import('node:fs');
const src = rf(ROOT + '/src/lib/privacy-agent.js', 'utf8');
function extractFunc(name) {
  const start = src.indexOf(`function ${name}() {`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) return src.slice(start, i + 1); } }
  throw new Error(name + ' not found');
}
const scanSrc = extractFunc('pageContextScan');

const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

async function openScene({ dpr, icon }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  await page.addInitScript(`${scanSrc}\nwindow.__sihPageContextScan = () => pageContextScan();`);
  await page.route('**/scene.html', route => route.fulfill({ contentType: 'text/html', body: PAGE({ icon }) }));
  await page.goto('http://127.0.0.1:8898/scene.html', { waitUntil: 'networkidle' });
  const scan = await page.evaluate(() => window.__sihPageContextScan());
  const shot = `data:image/png;base64,${(await page.screenshot({ type: 'png' })).toString('base64')}`;
  await page.evaluate((d) => { window.__shot = d; }, shot);

  async function run(opts = {}) {
    return page.evaluate(async (opts) => {
      const { runPrivacyPipeline } = await import('/src/lib/privacy-filter.js?cb=' + (performance.now() | 0));
      const scan = window.__sihPageContextScan();
      const r = await runPrivacyPipeline(
        { imageDataUrl: window.__shot, domText: scan.text, domSensitive: scan.sensitive, dom: scan.census, pageUrl: '/scene.html', pageTitle: 'Sweep Test', photoCandidates: scan.photoCandidates || [] },
        { scaleX: devicePixelRatio, scaleY: devicePixelRatio, maxWidth: 1280, ocrPii: false, runYolo: false, blurFaces: true, redactTextPii: true, ...opts },
      );
      return {
        faces: r.stats.counts.faces, byType: r.stats.redactionCounts, domSweep: r.stats.domSweep,
        manifest: r.manifest.filter(m => m.type === 'face').map(m => m.bounds),
        logs: r.pipelineLogs.filter(l => /Faces|Redact/.test(l)),
      };
    }, opts);
  }
  return { ctx, page, scan, run };
}

// ── warm the detector once ────────────────────────────────────────────────
{
  const s = await openScene({ dpr: 1, icon: false });
  await s.run({ faceDetect: { memo: false } });
  await s.ctx.close();
}

// ── T1 collector ──────────────────────────────────────────────────────────
console.log('T1: pageContextScan photoCandidates collector');
{
  const s = await openScene({ dpr: 1, icon: false });
  const c = s.scan.photoCandidates || [];
  check('avatar collected', c.length === 1, JSON.stringify(c));
  const b = c[0]?.bounds;
  check('rect is a 64×72 avatar box on-screen', b && b.w === 64 && b.h === 72 && b.x >= 0 && b.y >= 0, JSON.stringify(b));
  check('score 3 + avatar-hint', c[0]?.score === 3 && c[0]?.hint === 'avatar-hint');
  await s.ctx.close();
}
{
  // sub-24px icons and src-less images must be skipped
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.addInitScript(`${scanSrc}\nwindow.__sihPageContextScan = () => pageContextScan();`);
  const html = `<img class="icon" src="${ICON}" style="width:20px;height:20px"><img class="big" src="" style="width:80px;height:80px"><img class="ok" src="${ICON}" style="width:40px;height:40px">`;
  await page.route('**/raw1.html', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://127.0.0.1:8898/raw1.html', { waitUntil: 'networkidle' });
  const scan = await page.evaluate(() => window.__sihPageContextScan());
  const c = scan.photoCandidates || [];
  check('sub-24px + src-less skipped, 40px kept', c.length === 1 && c[0].bounds.w === 40, JSON.stringify(c));
  await ctx.close();
}

// ── T2 RESCUE — the user's field condition ────────────────────────────────
console.log('T2: cascade-disabled rescue (Faces detected: 0 → dom-sweep finds it)');
{
  const s = await openScene({ dpr: 1, icon: false });
  await s.run({ faceDetect: { memo: false } }); // warm
  const r = await s.run({
    memo: false,
    faceDetect: { memo: false, fullConf: 1.1, tileConf: 1.1, fineTileConf: 1.1 },
  });
  check('faces == 1', r.faces === 1, JSON.stringify(r.domSweep));
  check('domSweep scanned 1, hit 1', r.domSweep?.scanned === 1 && r.domSweep?.hits === 1, JSON.stringify(r.domSweep));
  check('byType.face == 1 (pixel redaction drawn)', r.byType?.face === 1, JSON.stringify(r.byType));
  const av = (s.scan.photoCandidates || [])[0]?.bounds;
  const fb = r.manifest?.[0];
  const avImg = av && { x: av.x, y: av.y, w: av.w, h: av.h }; // dpr 1 → CSS == image
  const inside = fb && avImg && fb.x >= avImg.x - 12 && fb.y >= avImg.y - 12 &&
    (fb.x + fb.w) <= (avImg.x + avImg.w + 12) && (fb.y + fb.h) <= (avImg.y + avImg.h + 12);
  check('face box lands ON the avatar', Boolean(inside), JSON.stringify({ fb, av: avImg }));
  check('email input still redacted (sensitive_input channel intact)', (r.byType?.sensitive_input || 0) >= 1, JSON.stringify(r.byType));
  await s.ctx.close();
}

// ── T3 STAND-DOWN — cascade already covers the avatar ─────────────────────
console.log('T3: cascade-covered stand-down (no redundant sweep)');
{
  const s = await openScene({ dpr: 1, icon: false });
  await s.run({ faceDetect: { memo: false } }); // warm
  const r = await s.run({ faceDetect: { memo: false } });
  check('faces == 1 via cascade', r.faces === 1, JSON.stringify(r.byType));
  check('sweep skipped (domSweep null — avatar covered)', r.domSweep === null, JSON.stringify(r.domSweep));
  await s.ctx.close();
}

// ── T4 NEGATIVE CONTROL — icon-only image must NOT be redacted ────────────
console.log('T4: icon-only image (no human face) scanned but not redacted');
{
  const s = await openScene({ dpr: 1, icon: true });
  await s.run({ faceDetect: { memo: false } }); // warm
  const r = await s.run({ faceDetect: { memo: false, fullConf: 1.1, tileConf: 1.1, fineTileConf: 1.1 } });
  check('icon was scanned by the sweep', r.domSweep?.scanned === 1, JSON.stringify(r.domSweep));
  check('NO face redaction on an icon', (r.byType?.face || 0) === 0 && r.domSweep?.hits === 0, JSON.stringify({ byType: r.byType, domSweep: r.domSweep }));
  check('email input still redacted', (r.byType?.sensitive_input || 0) >= 1, JSON.stringify(r.byType));
  await s.ctx.close();
}

// ── T5 DPR conversion ─────────────────────────────────────────────────────
console.log('T5: DPR 1.25 — CSS rect × 1.25 reaches the sweep');
{
  const s = await openScene({ dpr: 1.25, icon: false });
  await s.run({ faceDetect: { memo: false } }); // warm
  const r = await s.run({
    faceDetect: { memo: false, fullConf: 1.1, tileConf: 1.1, fineTileConf: 1.1 },
  });
  const av25 = (s.scan.photoCandidates || [])[0]?.bounds; // CSS px
  const fb = r.manifest?.[0];
  // avatar CSS × 1.25 → image space; detector box sits inside the img rect
  const ok = fb && av25 && fb.x >= av25.x * 1.25 - 16 && fb.y >= av25.y * 1.25 - 16 &&
    (fb.x + fb.w) <= (av25.x + av25.w) * 1.25 + 16 && (fb.y + fb.h) <= (av25.y + av25.h) * 1.25 + 16;
  check('face found in DPR-1.25 image space', Boolean(ok), JSON.stringify({ fb, av25, domSweep: r.domSweep }));
  check('dom-sweep hit at DPR 1.25', r.domSweep?.hits === 1, JSON.stringify(r.domSweep));
  await s.ctx.close();
}

// ── T6 cap ────────────────────────────────────────────────────────────────
console.log('T6: collector caps at 32 candidates');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.addInitScript(`${scanSrc}\nwindow.__sihPageContextScan = () => pageContextScan();`);
  const imgs = Array.from({ length: 40 }, (_, i) => `<img class="pic${i}" src="${ICON}" style="width:40px;height:40px">`).join('');
  await page.route('**/raw2.html', route => route.fulfill({ contentType: 'text/html', body: imgs }));
  await page.goto('http://127.0.0.1:8898/raw2.html', { waitUntil: 'networkidle' });
  const scan = await page.evaluate(() => window.__sihPageContextScan());
  check('40 imgs → 32 candidates', (scan.photoCandidates || []).length === 32, String((scan.photoCandidates || []).length));
  await ctx.close();
}

await browser.close(); srv.close();
console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
