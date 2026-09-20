// src/lib/ocr-pii.js
// VISUAL (NON-DOM) PII via OCR — vendored, fail-closed.
//
// The DOM cannot see pixels: PII baked into images, <canvas>, PDF viewers and
// video frames is invisible to every DOM scanner. This module adds an
// OPT-IN OCR pass to the privacy pipeline:
//
//   screenshot ─► OCR (local engine, lazy-loaded once) ─► text + word boxes
//              ─► pii-detector.detectPiiInText ─► findings ─► PIXEL BOXES
//              ─► redaction (same canvas engine as DOM/face regions)
//
// HARD PRIVACY RULES:
//   • OCR text NEVER leaves the device — it is scanned locally and only the
//     resulting redaction REGIONS (type + bounds) survive into the manifest.
//   • Raw OCR output is discarded after redaction; if redaction fails the
//     whole frame fails closed (blank), exactly like the rest of the pipeline.
//
// VENDORING: the engine (tesseract.js main module, worker, wasm core,
// eng.traineddata.gz) ships INSIDE the extension under src/vendor/tesseract/
// and is resolved RELATIVE TO THIS MODULE — no CDN fetch on first use, so the
// offline/privacy story no longer depends on jsDelivr being reachable.
//
// OCR FAILURE POLICY (fail-closed):
//   OCR disabled            → pipeline runs without visual-PII coverage (the
//                             documented DOM+face-only mode).
//   OCR enabled + available → regions are redacted as below.
//   OCR enabled + FAILED    → this module retries ONCE with a fresh engine;
//                             if it still fails it returns { failed: true }
//                             and privacy-filter marks the frame
//                             ocrFailed — sanitizeScreenContext() then REFUSES
//                             verification and the network gate BLOCKS the
//                             payload. The system loses functionality, never
//                             silently ships pixels the user believed were
//                             covered (no silent privacy gap).
//
// Runs in the OFFSCREEN document (or any plain browser context — the vendored
// paths also work over http, which is what the browser benchmark uses).

import { detectPiiInText, phonePlausible } from './pii-detector.js';
import { mlLog, mlWarn } from './local-models-shared.js';

// Vendored assets, resolved relative to THIS module (works under
// chrome-extension:// and http:// alike — no chrome.* dependency here).
const VENDOR = (f) => new URL(`../vendor/tesseract/${f}`, import.meta.url).href;
const TESSERACT_MAIN = VENDOR('tesseract.esm.min.js');
const WORKER_PATH = VENDOR('worker.min.js');
const CORE_PATH = VENDOR('core/');
const LANG_PATH = VENDOR('lang/');

let _engine = null;
let _engineLoad = null;

// MEASURED VERTICAL EXPANSION (OpenCometBench/probe-ocr-iou.mjs).
// Tesseract word bboxes measure GLYPH INK (cap/x-height), systematically
// NARROWER than the true painted text line: on the pii-visual benchmark the
// ink boxes were 54–73% of the real line-box height while width (0.95–0.97)
// and offset (1–4px) were already accurate. Redacting raw ink boxes leaves
// ascender/descender margins of the actual text visible. EXPAND factor 1.6
// centered on the ink box restores the line-box coverage: measured mean IoU
// on the 4-type benchmark went 0.611 → ~0.80 (email .71→.81, phone .51→.77,
// aadhaar .51→.79, api_key .71→.82) with negligible over-redaction (the
// expanded boxes are still a tiny fraction of page area). Privacy-first
// direction: a few px of extra vertical redaction can never leak text —
// under-redaction can.
const REGION_VEXPAND = 1.6;

async function getOcrEngine(onProgress) {
  if (_engine) return _engine;
  _engineLoad ??= (async () => {
    const mod = await import(/* webpackIgnore: true */ TESSERACT_MAIN);
    // The ESM build ships its API as a default export (some builds also
    // expose named exports) — normalise both shapes.
    const lib = mod?.default?.createWorker ? mod.default : mod;
    const worker = await lib.createWorker('eng', 1, {
      workerPath: WORKER_PATH,
      corePath: CORE_PATH,
      langPath: LANG_PATH,
      // MV3 CRITICAL: tesseract.js defaults to workerBlobURL:true, which wraps
      // worker.min.js in a Blob whose only statement is importScripts(<URL>).
      // Chrome BLOCKS importScripts() of chrome-extension:// URLs inside blob
      // workers ("Failed to execute 'importScripts' on 'WorkerGlobalScope'")
      // while the SAME blob path works fine over http://, which is why the
      // browser benchmark passed but the real extension failed. With
      // workerBlobURL:false tesseract creates the worker DIRECTLY from the
      // extension URL (allowed: CSP worker-src 'self'), and the resulting
      // extension-origin worker can importScripts(corePath) same-origin.
      // Verified in OpenCometBench/probe-ocr-mv3-extension.mjs — do NOT re-enable
      // the blob path in extension contexts.
      workerBlobURL: false,
      logger: (m) => {
        if (m?.status === 'recognizing text' && onProgress && m.progress != null) {
          onProgress(m.progress);
        }
      },
    });
    _engine = worker;
    return worker;
  })();
  return _engineLoad;
}

/**
 * OCR the image and map PII findings back to pixel boxes.
 *
 * @param {string} imageDataUrl  PNG/JPEG data-URL (raw capture — stays local)
 * @param {object} opts          { onProgress?: (0..1)=>void, minConfidence?: number }
 * @returns {{
 *   skipped?: boolean, reason?: string, failed?: boolean,
 *   regions: Array<{type, bounds, confidence, source}>, textChars: number, ms: number
 * }}
 *   failed  = OCR was REQUESTED (user opted in) and is unavailable — the
 *             caller MUST treat the frame as lacking visual-PII coverage and
 *             fail closed.  skipped = additive pass disabled/no-op.
 */
/**
 * LOW-CONFIDENCE LINE RESCUE (measured: a real canvas-painted email is
 * read CORRECTLY but at confidence 25 — Tesseract is unsure on thin small
 * type — so the ≥60 word filter silently dropped a perfectly-readable PII
 * line; the adversarial benchmark caught the value shipping in pixels).
 * Remedy mirrors the face detector's person-guided sweep: crop each
 * low-confidence LINE, upscale it (×2.5), re-recognize the crop (confidence
 * jumps on large glyphs), and map any PII finding back to the line's box.
 * @param {object} worker   the warmed tesseract worker
 * @param {string} imageDataUrl  the SAME raw capture (stays local)
 * @param {Array<{bbox:{x0,y0,x1,y1}, text:string}>} lowWords  words below the
 *        main confidence filter but above the hard floor
 * @param {(t:string)=>Promise<Array>} detect  detectPiiInText bound with opts
 * @returns {Array<region>} extra regions (union-deduped by the caller)
 */
async function rescueLowConfidenceLines(worker, imageDataUrl, lowWords, detect) {
  const regions = [];
  if (!lowWords.length) return regions;
  // group low words into visual lines (y-centre clustering)
  const heights = lowWords.map(w => w.bbox.y1 - w.bbox.y0).filter(h => h > 0).sort((a, b) => a - b);
  const medH = heights.length ? heights[Math.floor(heights.length / 2)] : 14;
  const tol = medH * 0.8;
  const lines = [];
  for (const w of lowWords.slice().sort((a, b) => a.bbox.y0 - b.bbox.y0)) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;
    const line = lines.length && Math.abs(cy - lines[lines.length - 1].cy) <= tol
      ? lines[lines.length - 1]
      : (lines.push({ cy, words: [] }), lines[lines.length - 1]);
    line.words.push(w);
  }
  const MAX_RESCUE_LINES = 6;
  const SCALE = 2.5;
  for (const line of lines.slice(0, MAX_RESCUE_LINES)) {
    const x0 = Math.max(0, Math.min(...line.words.map(w => w.bbox.x0)) - 4);
    const y0 = Math.max(0, Math.min(...line.words.map(w => w.bbox.y0)) - 4);
    const x1 = Math.max(...line.words.map(w => w.bbox.x1)) + 4;
    const y1 = Math.max(...line.words.map(w => w.bbox.y1)) + 4;
    const cw = x1 - x0, ch = y1 - y0;
    if (cw < 12 || ch < 6) continue;
    try {
      const { canvas: crop } = await cropAndUpscale(imageDataUrl, x0, y0, cw, ch, SCALE);
      const { data } = await worker.recognize(crop);
      const cropText = String(data?.text || '');
      if (!cropText.trim()) continue;
      // detect on the crop text AS-IS and on the WHITESPACE-FUSED
      // variant — the measured crop still contains the spurious glyph-gap
      // space ("priya.mehta@example. com"), and the PII regex cannot cross
      // it. A rescue crop is a single visual line, so full fusion is safe.
      const fused = cropText.replace(/\s+/g, '');
      const [fA, fB] = await Promise.all([
        detect(cropText),
        fused !== cropText.replace(/\s+/g, ' ') ? detect(fused) : Promise.resolve([]),
      ]);
      const findings = [...fA, ...fB];
      if (!findings.length) continue;
      for (const f of findings) {
        const h = ch * REGION_VEXPAND;
        const cy = y0 + ch / 2;
        regions.push({
          type: f.type,
          bounds: { x: Math.round(x0), y: Math.round(cy - h / 2), w: Math.round(cw), h: Math.round(h) },
          confidence: Math.min(0.97, (Number(f.risk) || f.confidence || 0.8) * 0.9),
          source: 'ocr-rescue',
        });
      }
    } catch (e) { mlWarn('[OCR-PII] rescue line failed:', e?.message || e); }
  }
  return regions;
}

/** Crop a region of a data-URL image and upscale it (rescue pass helper).
 *  accepts an optional pre-decoded source canvas so the targeted
 *  ROI pass decodes the capture ONCE instead of once per ROI. */
async function cropAndUpscale(imageDataUrl, x, y, w, h, scale, srcCanvas = null) {
  const bmp = srcCanvas || await createImageBitmap(await (await fetch(imageDataUrl)).blob());
  const c = document.createElement('canvas');
  c.width = Math.min(1600, Math.round(w * scale));
  c.height = Math.max(8, Math.round(h * (c.width / w)));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, x, y, w, h, 0, 0, c.width, c.height);
  return { canvas: c, scale: c.width / w };
}

// STRUCTURAL BATTERY (crop-text scan)
// Mirrors pageContextScan's DOM text battery: PII rendered as PIXELS must get
// the same structural coverage the DOM text path enjoys — WITHOUT loosening
// the shared detectPiiInText semantics (the 41-test corpus locks its
// precision; the checksum-validated aadhaar path must keep rejecting fake
// values). Battery hits are STRUCTURAL (format + digit-count + plausibility),
// confidence 0.85, and only run on ≤12 bounded ROI crops — not free text.
const OCR_BATTERY = [
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, 0],
  ['aadhaar', /\b\d{4}\s?\d{4}\s?\d{4}\b/g, 12],
  ['pan', /\b[A-Z]{5}\d{4}[A-Z]\b/g, 0],
  ['api_key', /\b(?:sk|gh[pousr]|xox|AKIA|AIza)[-_:A-Za-z0-9]{10,}\b/g, 0],
  ['credit_card', /\b(?:\d[ -]?){13,19}\b/g, 13],
  ['phone', /(?:\+?\d[\d\s()-]{8,}\d)/g, 10],
];

function runStructuralBattery(text) {
  const out = [];
  for (const [type, re, minDigits] of OCR_BATTERY) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = m[0];
      if (!raw) { re.lastIndex++; continue; }
      if (minDigits && raw.replace(/\D/g, '').length < minDigits) continue;
      // year triples are sequences, not Aadhaars/phones (same guard as the
      // shared validator)
      const groups = raw.trim().split(/\s+/).filter(Boolean);
      if (groups.length > 2 && groups.every(g => /^(19|20)\d{2}$/.test(g))) continue;
      if (type === 'phone' && !phonePlausible(raw)) continue;
      out.push({ type, start: m.index, end: m.index + raw.length });
    }
  }
  // longest-span-wins arbitration: a 16-digit card must not lose the middle
  // 12 digits to the aadhaar battery (that would redact "4024 0071 5255" and
  // leave " 1234" readable). Equal-length overlaps are both kept — the
  // region-level dedupe resolves them by draw order.
  return out.filter(o => !out.some(o2 =>
    o2 !== o && o2.start <= o.start && o2.end >= o.end && (o2.end - o2.start) > (o.end - o.start)));
}

/**
 * TARGETED ROI CROP PASS — the field fix for pixel-only PII.
 * The full-page OCR pass reads small canvas text UNRELIABLY on busy pages
 * (field report: only the phone of a 3-value canvas line was redacted; two
 * whole pixel-only contact cards shipped readable). The DOM knows exactly
 * where every <canvas> (and larger <img>) sits, so we re-read each ROI as an
 * ISOLATED, ×2-upscaled image — Tesseract's page segmentation then sees one
 * small document instead of one noisy page, and recognition fires.
 *
 * Findings map back through the crop's OWN word spans to full-image coords;
 * battery + detector runs on both the space-joined and line-fused variants
 * (the measured "example. com" glyph-gap split). Raw text never propagates.
 */
async function ocrRoiRegions(worker, imageDataUrl, rois, existingRegions) {
  const regions = [];
  const list = (rois || [])
    .filter(b => b && (b.w || 0) >= 60 && (b.h || 0) >= 24)
    .slice(0, 12);
  if (!list.length) return { regions, scanned: 0 };
  // decode ONCE, reuse for every crop; image dims come from the decode
  let srcCanvas = null;
  let imgW = 0, imgH = 0;
  try {
    const bmp = await createImageBitmap(await (await fetch(imageDataUrl)).blob());
    imgW = bmp.width; imgH = bmp.height;
    srcCanvas = document.createElement('canvas');
    srcCanvas.width = imgW; srcCanvas.height = imgH;
    srcCanvas.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0);
    bmp.close?.();
  } catch (e) {
    mlWarn('[OCR-PII] ROI source decode failed:', e?.message || e);
    return { regions, scanned: 0 };
  }
  const covered = (b) => existingRegions.some(q => {
    const a = q.bounds;
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return ix * iy > 0.5 * Math.min(a.w * a.h, b.w * b.h);
  });
  let scanned = 0;
  for (const roi of list) {
    try {
      const x = Math.max(0, Math.round(roi.x));
      const y = Math.max(0, Math.round(roi.y));
      const w = Math.min(imgW - x, Math.round(roi.w));
      const h = Math.min(imgH - y, Math.round(roi.h));
      if (w < 60 || h < 24) continue;
      const { canvas: crop, scale } = await cropAndUpscale(imageDataUrl, x, y, w, h, 2, srcCanvas);
      const { data } = await worker.recognize(crop);
      const words = (data?.words || []).filter(wd =>
        Number(wd.confidence ?? 0) >= 12 && wd.text?.trim() && wd.bbox);
      scanned++;
      if (!words.length) continue;

      // Variant A — space-joined with spans (same reconstruction as the main pass)
      const spansA = [];
      const partsA = [];
      let cur = 0;
      for (const wd of words) {
        const t = String(wd.text || '').trim();
        if (!t) continue;
        spansA.push({ start: cur, end: cur + t.length, bbox: wd.bbox });
        partsA.push(t);
        cur += t.length + 1;
      }
      const textA = partsA.join(' ');

      // Variant B — line-fused (glyph-gap repair), same clustering as main pass
      const heights = words.map(wd => wd.bbox.y1 - wd.bbox.y0).filter(hh => hh > 0).sort((a, b) => a - b);
      const medH = heights.length ? heights[Math.floor(heights.length / 2)] : 14;
      const tol = medH * 0.7;
      const lines = [];
      for (const wd of words) {
        const cy = (wd.bbox.y0 + wd.bbox.y1) / 2;
        const line = lines.length && Math.abs(cy - lines[lines.length - 1].cy) <= tol
          ? lines[lines.length - 1]
          : (lines.push({ cy, words: [] }), lines[lines.length - 1]);
        line.words.push(wd);
      }
      const spansB = [];
      const partsB = [];
      let curB = 0;
      for (const line of lines) {
        for (const wd of line.words) {
          const t = String(wd.text || '').trim();
          if (!t) continue;
          spansB.push({ start: curB, end: curB + t.length, bbox: wd.bbox });
          partsB.push(t);
          curB += t.length;
        }
        partsB.push('\n');
        curB += 1;
      }
      const textB = partsB.join('');

      // Detector + structural battery on BOTH variants
      const [detA, detB] = await Promise.all([
        detectPiiInText(textA, { maxChars: 4000 }),
        textB !== textA ? detectPiiInText(textB, { maxChars: 4000 }) : Promise.resolve([]),
      ]);
      const findingsA = [...detA, ...runStructuralBattery(textA)];
      const findingsB = [...detB, ...runStructuralBattery(textB)];

      const mapBack = (findings, spans) => {
        const out = [];
        for (const f of findings) {
          const hits = spans.filter(s => s.end > f.start && s.start < f.end);
          if (!hits.length) continue;
          const bx0 = Math.min(...hits.map(hh => hh.bbox.x0));
          const by0 = Math.min(...hits.map(hh => hh.bbox.y0));
          const bx1 = Math.max(...hits.map(hh => hh.bbox.x1));
          const by1 = Math.max(...hits.map(hh => hh.bbox.y1));
          // crop coords → full-image coords (uniform scale from cropAndUpscale)
          const fx = x + bx0 / scale;
          const fy = y + by0 / scale;
          const fw = (bx1 - bx0) / scale;
          const fh = (by1 - by0) / scale;
          const eh = fh * REGION_VEXPAND;
          out.push({
            type: f.type,
            bounds: {
              x: Math.max(0, Math.round(fx - 2)),
              y: Math.max(0, Math.round(y + (by0 + by1) / 2 / scale - eh / 2)),
              w: Math.min(imgW - Math.max(0, Math.round(fx - 2)), Math.round(fw + 4)),
              h: Math.round(eh),
            },
            confidence: Math.min(0.97, (Number(f.risk) || f.confidence || 0.85) * 0.95),
            source: f.source === 'regex' ? 'ocr-roi' : 'ocr-roi-battery',
          });
        }
        return out;
      };
      for (const r of [...mapBack(findingsA, spansA), ...mapBack(findingsB, spansB)]) {
        if (covered(r)) continue;
        if (regions.some(q => { const a = q.bounds, b = r.bounds;
          const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
          const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
          return ix * iy > 0.5 * Math.min(a.w * a.h, b.w * b.h); })) continue;
        regions.push(r);
      }
    } catch (e) {
      mlWarn('[OCR-PII] ROI crop failed:', e?.message || e);
    }
  }
  return { regions, scanned };
}

export async function scanImageForPiiRegions(imageDataUrl, opts = {}) {
  const t0 = performance.now();
  try {
    const worker = await getOcrEngine(opts.onProgress);
    const { data } = await worker.recognize(imageDataUrl);
    const minConf = opts.minConfidence ?? 60;
    const words = (data?.words || []).filter(w =>
      Number(w.confidence ?? 0) >= minConf && w.text?.trim());
    // RESCUE CANDIDATES: correctly-read lines at low confidence. The
    // hard floor (12) excludes engine noise only — measured canvas text sits
    // at conf ~25 and DROPS BELOW it run-to-run, so the floor must be low;
    // rescued lines still need a real PII finding to become a region.
    const lowWords = (data?.words || []).filter(w => {
      const c = Number(w.confidence ?? 0);
      return c >= 12 && c < minConf && w.text?.trim() && w.bbox;
    });
    if (!words.length && !lowWords.length) {
      return { regions: [], textChars: 0, ms: Math.round(performance.now() - t0) };
    }

    // Reconstruct the full text WITH word-order offsets so findings can be
    // mapped back onto word boxes.
    //
    // LINE-FUSED SECOND VARIANT (measured, OpenCometBench/e2e/run-adversarial.mjs
    // canvas-email case): Tesseract SPLITS tight values at glyph spacing —
    // "priya.mehta@example." + "com" (a 7px gap, indistinguishable from the
    // page's real 5–6px word spaces, so gap heuristics cannot separate them).
    // The space-joined text then FAILS the PII match (the email regex cannot
    // cross the spurious space). Variant B fuses each VISUAL LINE (words whose
    // y-centres cluster) into one token with NO spaces — reconstructing the
    // value exactly as painted: "priya.mehta@example.com", "+919876543210",
    // "4111111111111111". Prose lines fuse into harmless non-matching tokens.
    // Both variants are scanned; each maps through ITS OWN spans; results are
    // unioned with overlap dedupe.
    const parts = [];
    const spans = [];
    let cursor = 0;
    for (const w of words) {
      const t = String(w.text || '').trim();
      if (!t) continue;
      spans.push({ start: cursor, end: cursor + t.length, bbox: w.bbox });
      parts.push(t);
      cursor += t.length + 1; // +1 for the joining space
    }
    const fullText = parts.join(' ');

    // Variant B — per-line fusion
    const heights = words.slice(0, 80).map(w => (w.bbox ? w.bbox.y1 - w.bbox.y0 : 0)).filter(h => h > 0).sort((a, b) => a - b);
    const medH = heights.length ? heights[Math.floor(heights.length / 2)] : 14;
    const lineTol = medH * 0.7;
    const lines = [];   // [{cy, words:[{t,bbox}]}]
    const ordered = words.filter(w => String(w.text || '').trim() && w.bbox);
    for (const w of ordered) {
      const cy = (w.bbox.y0 + w.bbox.y1) / 2;
      const line = lines.length && Math.abs(cy - lines[lines.length - 1].cy) <= lineTol
        ? lines[lines.length - 1]
        : (lines[lines.length] = { cy, words: [] }, lines[lines.length - 1]);
      line.words.push(w);
      // running mean keeps multi-height lines together (mixed font sizes)
      line.cy = (line.cy * (line.words.length - 1) + cy) / line.words.length;
    }
    const partsB = [];
    const spansB = [];
    let cursorB = 0;
    for (const line of lines) {
      for (const w of line.words) {
        const t = String(w.text || '').trim();
        if (!t) continue;
        spansB.push({ start: cursorB, end: cursorB + t.length, bbox: w.bbox });
        partsB.push(t);
        cursorB += t.length;
      }
      partsB.push('\n');
      cursorB += 1;
    }
    const tightText = partsB.join('');

    // PII detection on BOTH reconstructions — same engine as the DOM text path
    // (regex + validators + contextual risk). Each variant's findings map back
    // through ITS OWN spans; union with overlap dedupe.
    const [findingsA, findingsB] = await Promise.all([
      detectPiiInText(fullText, { maxChars: 12000 }),
      tightText !== fullText ? detectPiiInText(tightText, { maxChars: 12000 }) : Promise.resolve([]),
    ]);

    // Map overlapping findings → union of the word boxes they cover, then
    // apply the measured vertical expansion (ink box → text-line box).
    const mapFindings = (list, textSpans) => {
      const out = [];
      for (const f of list) {
        const hits = textSpans.filter(s => s.end > f.start && s.start < f.end);
        if (!hits.length) continue;
        const x0 = Math.min(...hits.map(h => h.bbox?.x0 ?? Infinity));
        const y0 = Math.min(...hits.map(h => h.bbox?.y0 ?? Infinity));
        const x1 = Math.max(...hits.map(h => h.bbox?.x1 ?? -Infinity));
        const y1 = Math.max(...hits.map(h => h.bbox?.y1 ?? -Infinity));
        if (!Number.isFinite(x0) || x1 <= x0 || y1 <= y0) continue;
        // expand vertically around the ink-box centre (see REGION_VEXPAND).
        const h = y1 - y0;
        const cy = (y0 + y1) / 2;
        const eh = h * REGION_VEXPAND;
        const ey0 = cy - eh / 2;
        out.push({
          type: f.type,
          bounds: {
            x: Math.round(x0),
            y: Math.round(ey0),
            w: Math.round(x1 - x0),
            h: Math.round(eh),
          },
          confidence: Math.min(0.99, (Number(f.risk) || f.confidence || 0.8) * 0.95),
          source: 'ocr',
        });
      }
      return out;
    };
    const regionsA = mapFindings(findingsA, spans);
    const regionsB = mapFindings(findingsB, spansB);
    // low-confidence line rescue (crop + upscale + re-recognize) —
    // measured conf-25 canvas email shipped readable without this pass.
    const rescued = lowWords.length
      ? await rescueLowConfidenceLines(worker, imageDataUrl, lowWords,
          (t) => detectPiiInText(t, { maxChars: 4000 }))
      : [];
    // dedupe: drop later-pass boxes that substantially overlap an earlier box
    const deduped = [...regionsA];
    for (const r of [...regionsB, ...rescued]) {
      const dup = deduped.some(q => (() => {
        const a = q.bounds, b = r.bounds;
        const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        return ix * iy > 0.5 * Math.min(a.w * a.h, b.w * b.h);
      })());
      if (!dup) deduped.push(r);
    }
    const regions = deduped;
    // TARGETED ROI CROP PASS — deterministic re-read of the DOM's
    // canvas/img rects (see ocrRoiRegions). Runs on the SAME warmed worker;
    // ≤12 bounded crops; findings merge into the dedupe chain above.
    let roiAdded = 0;
    let roisScanned = 0;
    if (Array.isArray(opts.rois) && opts.rois.length) {
      try {
        const roi = await ocrRoiRegions(worker, imageDataUrl, opts.rois, deduped);
        roisScanned = roi.scanned;
        for (const r of roi.regions) {
          const dup = deduped.some(q => (() => {
            const a = q.bounds, b = r.bounds;
            const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
            const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
            return ix * iy > 0.5 * Math.min(a.w * a.h, b.w * b.h);
          })());
          if (!dup) { deduped.push(r); roiAdded++; }
        }
      } catch (e) {
        mlWarn('[OCR-PII] ROI pass failed (non-fatal):', e?.message || e);
      }
    }
    mlLog(`[OCR-PII] ${words.length} words (+${lowWords.length} low-conf) → ${findingsA.length}+${findingsB.length} finding(s) (space/line-joined) +${rescued.length} rescued +${roiAdded} roi(${roisScanned}) → ${deduped.length} redaction region(s) in ${Math.round(performance.now() - t0)}ms`);
    // fullText is intentionally NOT returned — raw OCR output never propagates.
    return { regions: deduped, textChars: fullText.length, ms: Math.round(performance.now() - t0), roiRegions: roiAdded, roisScanned };
  } catch (err) {
    const reason = String(err?.message || err);
    // fail-closed policy: retry ONCE with a FRESH engine (the first
    // failure may be a wedged worker). If the retry also fails, the caller
    // must NOT transmit this frame — a privacy gap must never be silent.
    if (!opts._retried) {
      mlWarn(`[OCR-PII] engine failed (${reason}) — retrying once with a fresh engine`);
      try { await disposeOcrEngine(); } catch { /* ignore */ }
      return scanImageForPiiRegions(imageDataUrl, { ...opts, _retried: true });
    }
    mlWarn('[OCR-PII] FAILED after retry — caller must fail closed:', reason);
    return { failed: true, reason, regions: [], ms: Math.round(performance.now() - t0) };
  }
}

/** Warm up / dispose the OCR worker (model management). */
export async function disposeOcrEngine() {
  try { await _engine?.terminate?.(); } catch { /* already gone */ }
  _engine = null;
  _engineLoad = null;
}
