#!/usr/bin/env python3
"""One-shot patch: pii-visual GT = self-measured PII-substring boxes."""

p = 'OpenCometBench/generate-pages.mjs'
s = open(p).read()

script_open = s.rindex("<script>", 0, s.index("  function measureLine("))
b = s.index("script>`);", script_open) + len("script>`);")
new = '''<script>
  function paintLines(ctx, lines) {
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = '#111827'; ctx.font = '20px system-ui, sans-serif'; ctx.textBaseline = 'top';
    lines.forEach((t, i) => ctx.fillText(t, 24, 14 + i * 30));
  }
  // Self-measured GROUND TRUTH: the exact PII-substring pixel box for each
  // painted value (prefix-measured with the same font the surface used).
  // textBaseline='top' means the paint y IS the glyph top.
  function measurePii(canvasEl, fullText, piiText, ty, fontSize) {
    const ctx = canvasEl.getContext('2d');
    ctx.font = '20px system-ui, sans-serif';
    const prefixW = ctx.measureText(fullText.slice(0, fullText.indexOf(piiText))).width;
    const piiW = ctx.measureText(piiText).width;
    const r = canvasEl.getBoundingClientRect();
    return {
      box: { x: Math.round(r.left + 24 + prefixW), y: Math.round(r.top + ty),
             w: Math.round(piiW + 6), h: Math.round(fontSize * 1.3) },
    };
  }
  const piiBoxes = [];
  // 1) contact canvas — PII on line 2
  const c1 = document.getElementById('v-canvas');
  paintLines(c1.getContext('2d'), ['Account holder: Jane Doe (synthetic)', 'Contact: jane.doe@example.com']);
  piiBoxes.push({ type: 'email', text: 'jane.doe@example.com',
    ...measurePii(c1, 'Contact: jane.doe@example.com', 'jane.doe@example.com', 14 + 30, 20) });
  // 2) SVG data-URL image — text painted by the browser from the SVG markup
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="520" height="70">' +
    '<rect width="520" height="70" fill="#fff"/>' +
    '<text x="24" y="30" font-family="sans-serif" font-size="20" fill="#111827">Call +91 98765 43210</text></svg>';
  const img = document.getElementById('v-img');
  img.src = 'data:image/svg+xml;base64,' + btoa(svg);
  {
    const mc = document.createElement('canvas');
    mc.getContext('2d').font = '20px sans-serif';
    const r = img.getBoundingClientRect();
    const prefixW = mc.getContext('2d').measureText('Call ').width;
    const piiW = mc.getContext('2d').measureText('+91 98765 43210').width;
    piiBoxes.push({ type: 'phone', text: '+91 98765 43210',
      box: { x: Math.round(r.left + 24 + prefixW), y: Math.round(r.top + 12),
             w: Math.round(piiW + 6), h: Math.round(20 * 1.3) } });
  }
  // 3) canvas-rendered PDF-like statement — two PII lines
  const c3 = document.getElementById('v-pdf');
  paintLines(c3.getContext('2d'), ['Statement of Account — Example Bank', 'Aadhaar: 2345 1234 5909',
    'API key: sk-proj-abcdefghij1234567890', 'Page 1 of 1 — synthetic document']);
  piiBoxes.push({ type: 'aadhaar', text: '2345 1234 5909',
    ...measurePii(c3, 'Aadhaar: 2345 1234 5909', '2345 1234 5909', 14 + 30, 20) });
  piiBoxes.push({ type: 'api_key', text: 'sk-proj-abcdefghij1234567890',
    ...measurePii(c3, 'API key: sk-proj-abcdefghij1234567890', 'sk-proj-abcdefghij1234567890', 14 + 60, 20) });
  window.__SIH_GT__.ocrPiiBoxes = piiBoxes;
</scr''' + '''ipt>`);'''
s = s[:script_open] + new + s[b:]
s = s.replace("ocrLineBoxes", "ocrPiiBoxes")
s = s.replace("The page measures its own painted text lines into window.__SIH_GT__.ocrPiiBoxes.",
              "The page measures its own painted PII-substring boxes into window.__SIH_GT__.ocrPiiBoxes.")
open(p, 'w').write(s)
print('generator patched')

h = 'OpenCometBench/browser/harness.mjs'
t = open(h).read()
t = t.replace("window.__SIH_GT__.ocrLineBoxes || []", "window.__SIH_GT__.ocrPiiBoxes || []")
t = t.replace(".map(l => ({ sel: null, lineBox: l.box, type: 'visual_pii' }))",
              ".map(l => ({ sel: null, lineBox: l.box, type: l.type || 'visual_pii' }))")
t = t.replace("sel: `line:${s.text || i}`", "sel: `pii:${s.type || i}`")
t = t.replace("ocrEngineLoadMs: ocrLoadMs,",
              "ocrEngineLoadMs: ocrLoadMs,\n      ocrFoundTypes: (withOcr.manifest || []).map(m => m.type),")
open(h, 'w').write(t)
print('harness patched')
