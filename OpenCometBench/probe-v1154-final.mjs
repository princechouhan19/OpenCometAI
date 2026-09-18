#!/usr/bin/env node
// OpenCometBench/probe-v1154-final.mjs — final visual proof for the field round:
// the FULL production-shaped pipeline (blurFaces + ocrPii + DOM + text) on the
// Master-Perception replica, sanitized screenshot saved for inspection.
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
await new Promise(r => srv.listen(8901, '127.0.0.1', r));

const faceHtml = readFileSync(ROOT + '/OpenCometBench/e2e/adversarial/priv-face.html', 'utf8');
const PORTRAIT = faceHtml.match(/<img id="cam" src="(data:image\/jpeg;base64,[^"]+)"/)[1];

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Master Perception Replica</title>
<style>
  body{font:14px/1.45 Arial,Helvetica,sans-serif;margin:0;background:#f5f6fa;color:#1c2333}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:24px;max-width:1160px;margin:0 auto}
  .card{background:#fff;border:1px solid #dfe3ee;border-radius:10px;padding:16px 18px}
  h4{margin:0 0 10px;font-size:14px;color:#33415c}
  label{display:block;font-size:12px;color:#44506b;margin-top:8px}
  input{font:13px Arial;padding:5px 8px;border:1px solid #c9cfdf;border-radius:6px;width:210px}
  .profile-photo{width:64px;height:72px;border-radius:6px;object-fit:cover}
  .bg-avatar{width:64px;height:72px;border-radius:50%;background-size:cover;background-position:center;display:inline-block}
  .row{display:flex;gap:14px;align-items:center;border:1px solid #e4e7f2;border-radius:8px;padding:10px}
  canvas{border:1px solid #dde1ec;background:#fff;margin-top:10px}
</style></head><body>
<div class="grid">
  <div class="card">
    <h4>Text &amp; Sensitive Fields</h4>
    <div><label>Full name</label><input value="Aarav Sharma"></div>
    <div><label>Email</label><input type="email" value="aarav.sharma@example.com"></div>
    <div><label>PAN-like ID</label><input value="ABCDE1234F"></div>
  </div>
  <div class="card">
    <h4>Images &amp; Pixel PII</h4>
    <div class="row">
      <img class="profile-photo" src="${PORTRAIT}" alt="Real Profile Photo">
      <div class="bg-avatar" id="userAvatarBox" style="background-image:url(${PORTRAIT})"></div>
      <div><b>Real Profile Photo</b><div style="font-size:12px;color:#6b7490">img + background-image avatar</div></div>
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
    <\/script>
  </div>
</div>
</body></html>`;

const { readFileSync: rf } = await import('node:fs');
const src = rf(ROOT + '/src/lib/privacy-agent.js', 'utf8');
function extractFunc(name) {
  const start = src.indexOf(`function ${name}() {`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) return src.slice(start, i + 1); } }
  return null;
}
const scanSrc = extractFunc('pageContextScan');

const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.addInitScript(`${scanSrc}\nwindow.__sihPageContextScan = () => pageContextScan();`);
await page.route('**/replica.html', route => route.fulfill({ contentType: 'text/html', body: PAGE }));
await page.goto('http://127.0.0.1:8901/replica.html', { waitUntil: 'networkidle' });
const scan = await page.evaluate(() => window.__sihPageContextScan());
const shotBuf = await page.screenshot({ type: 'png' });
const imageDataUrl = `data:image/png;base64,${shotBuf.toString('base64')}`;

const r = await page.evaluate(async ({ scan, imageDataUrl }) => {
  const { runPrivacyPipeline } = await import('/src/lib/privacy-filter.js?cb=' + (performance.now() | 0));
  const t0 = performance.now();
  const r = await runPrivacyPipeline(
    { imageDataUrl, domText: scan.text, domSensitive: scan.sensitive, dom: scan.census, pageUrl: '/replica.html', pageTitle: 'Master Perception Replica', photoCandidates: scan.photoCandidates || [], pixelTextRects: scan.pixelTextRects || [] },
    { scaleX: devicePixelRatio, scaleY: devicePixelRatio, maxWidth: 1280, blurFaces: true, ocrPii: true, redactTextPii: true, runYolo: false },
  );
  return {
    wallMs: Math.round(performance.now() - t0),
    faces: r.stats.counts.faces,
    byType: r.stats.redactionCounts,
    domSweep: r.stats.domSweep,
    avatarGuard: r.stats.avatarGuard,
    logs: r.pipelineLogs.filter(l => /Face|OCR|Redact:/.test(l)),
    sanitized: r.sanitizedDataUrl,
  };
}, { scan, imageDataUrl });

console.log('wallMs:', r.wallMs, '· faces:', r.faces, '· domSweep:', JSON.stringify(r.domSweep), '· avatarGuard:', JSON.stringify(r.avatarGuard));
console.log('byType:', JSON.stringify(r.byType));
for (const l of r.logs) console.log(' |', l);
writeFileSync(ROOT + '/OpenCometBench/results/probe-v1154-final-sanitized.png', Buffer.from(r.sanitized.split(',')[1], 'base64'));
writeFileSync(ROOT + '/OpenCometBench/results/probe-v1154-final-raw.png', Buffer.from(imageDataUrl.split(',')[1], 'base64'));
console.log('saved → OpenCometBench/results/probe-v1154-final-{raw,sanitized}.png');
await browser.close(); srv.close(); process.exit(0);
