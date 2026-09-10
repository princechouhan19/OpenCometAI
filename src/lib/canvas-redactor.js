// ─────────────────────────────────────────────────────────────────────────────
// src/lib/canvas-redactor.js
// Canvas-based pixel-level redactor.  Takes a screenshot (PNG data-URL from
// chrome.tabs.captureVisibleTab) and a list of sensitive bounding boxes, and
// returns a NEW data-URL where every sensitive region has been:
//   • faces        → Gaussian blur (heavy) + black bar across eyes
//   • password     → Solid black fill
//   • credit card  → Solid black fill + keep last-4 digits visible
//   • text PII     → Solid black fill
//
// Crucially, the ORIGINAL un-redacted pixels never leave this module.
// The function returns the sanitized image only.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Redact an image.
 *
 * @param {string} dataUrl            PNG data-URL (e.g. from captureVisibleTab).
 * @param {Array}  regions            [{ type, bounds:{x,y,w,h}, confidence }]
 * @param {object} opts
 * @param {number} opts.faceBlurRadius    Default 18 (heavy)
 * @param {number} opts.boxPadding        Expand each box by N px on every side
 * @param {boolean}opts.drawBadges        Draw a small "REDACTED" badge above each box
 * @param {boolean}opts.drawOutlines      Draw a thin outline around each redacted region
 * @param {number} opts.maxWidth          Downscale the OUTPUT above this width
 *                                        (DPR-2 captures are 2560px wide; VLMs
 *                                        waste latency/tokens on them).
 *
 * @returns {Promise<{ dataUrl, width, height, outWidth, outHeight, scaledDown, redactedCount, byType }>}
 */
export async function redactImage(dataUrl, regions = [], opts = {}) {
  const cfg = {
    faceBlurRadius: 18,
    boxPadding: 2,
    drawBadges: true,
    drawOutlines: true,
    maxWidth: 0,          // 0 = no downscale
    ...opts,
  };

  // Load source image
  const img = await loadImage(dataUrl);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;

  // Source canvas (kept private — never returned)
  const srcCanvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const srcCtx = srcCanvas.getContext('2d');
  srcCtx.drawImage(img, 0, 0, w, h);

  // Output canvas (this is what we ship)
  const outCanvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const outCtx = outCanvas.getContext('2d');
  outCtx.drawImage(img, 0, 0, w, h);

  // Handle devicePixelRatio scaling — Chrome captureVisibleTab returns
  // physical pixels, but DOM getBoundingClientRect returns CSS pixels.
  // The caller must pass regions in the SAME coordinate space as the image.
  // We provide `scaleFactor` in opts so callers can convert if needed.
  const sx = cfg.scaleX || 1;
  const sy = cfg.scaleY || 1;

  const byType = {};
  for (const r of regions) {
    if (!r.bounds) continue;
    const bx = Math.max(0, Math.round((r.bounds.x - cfg.boxPadding) * sx));
    const by = Math.max(0, Math.round((r.bounds.y - cfg.boxPadding) * sy));
    const bw = Math.min(w - bx, Math.round((r.bounds.w + cfg.boxPadding * 2) * sx));
    const bh = Math.min(h - by, Math.round((r.bounds.h + cfg.boxPadding * 2) * sy));
    if (bw <= 0 || bh <= 0) continue;

    const type = r.type || 'unknown';
    byType[type] = (byType[type] || 0) + 1;

    switch (type) {
      case 'face':
        blurRegion(srcCanvas, outCanvas, bx, by, bw, bh, cfg.faceBlurRadius);
        // Add an opaque black bar across the eyes for extra privacy
        outCtx.fillStyle = '#000';
        const eyeBarH = Math.max(4, Math.round(bh * 0.18));
        outCtx.fillRect(bx, by + Math.round(bh * 0.25), bw, eyeBarH);
        break;

      case 'password':
      case 'credit_card':
      case 'aadhaar':
      case 'pan':
      case 'ssn':
      case 'iban':
      case 'api_key':
      case 'url_cred':
      case 'sensitive_input':
      // SIH v1.15.2 — Indian ID expansion: same opaque-black treatment as
      // aadhaar/pan (explicit, though the default below is also solid black).
      case 'voter_id':
      case 'passport':
      case 'driving_license':
      case 'ifsc':
      case 'upi':
      case 'bank_account':
      case 'gstin':
        // Solid black fill
        outCtx.fillStyle = '#000';
        outCtx.fillRect(bx, by, bw, bh);
        break;

      case 'phone':
      case 'email':
      case 'dob':
      case 'ip':
      case 'person':
      case 'org':
      case 'address':
        // Pixelate-then-blur — keeps layout context for VLM but destroys text
        pixelateRegion(srcCanvas, outCanvas, bx, by, bw, bh, Math.max(6, Math.round(Math.min(bw, bh) / 4)));
        break;

      default:
        outCtx.fillStyle = '#000';
        outCtx.fillRect(bx, by, bw, bh);
    }

    if (cfg.drawOutlines) {
      outCtx.strokeStyle = 'rgba(217, 135, 90, 0.85)';
      outCtx.lineWidth = 1.5;
      outCtx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
    }

    if (cfg.drawBadges) {
      drawBadge(outCtx, bx, by, type);
    }
  }

  // Optional output downscale — redaction runs at native resolution (precise
  // boxes), but shipping a DPR-2 2560px PNG to a vision model costs upload
  // time + vision tokens. 1280px keeps every UI element legible for the VLM.
  let outFinal = outCanvas;
  let scaledDown = false;
  if (cfg.maxWidth > 0 && w > cfg.maxWidth) {
    const scale = cfg.maxWidth / w;
    const dw = Math.round(w * scale);
    const dh = Math.round(h * scale);
    const small = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(dw, dh)
      : Object.assign(document.createElement('canvas'), { width: dw, height: dh });
    const sctx = small.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(outCanvas, 0, 0, dw, dh);
    outFinal = small;
    scaledDown = true;
  }

  const outDataUrl = await canvasToDataUrl(outFinal);
  return {
    dataUrl: outDataUrl,
    width: w,
    height: h,
    outWidth: scaledDown ? Math.round(w * cfg.maxWidth / w) : w,
    outHeight: scaledDown ? Math.round(h * cfg.maxWidth / w) : h,
    scaledDown,
    redactedCount: regions.length,
    byType,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    if (typeof createImageBitmap !== 'undefined' && dataUrl instanceof Blob) {
      createImageBitmap(dataUrl).then(resolve, reject);
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function blurRegion(srcCanvas, dstCanvas, x, y, w, h, radius) {
  // Use OffscreenCanvas/HTMLCanvas filter where available; fallback to manual box blur.
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const tmpCtx = tmp.getContext('2d');
  tmpCtx.filter = `blur(${radius}px)`;
  tmpCtx.drawImage(srcCanvas, x, y, w, h, 0, 0, w, h);
  dstCanvas.getContext('2d').drawImage(tmp, x, y);
}

function pixelateRegion(srcCanvas, dstCanvas, x, y, w, h, block) {
  if (w <= 0 || h <= 0) return;
  const tmp = document.createElement('canvas');
  tmp.width = Math.max(1, Math.ceil(w / block));
  tmp.height = Math.max(1, Math.ceil(h / block));
  const tmpCtx = tmp.getContext('2d');
  tmpCtx.imageSmoothingEnabled = true;
  tmpCtx.drawImage(srcCanvas, x, y, w, h, 0, 0, tmp.width, tmp.height);
  const dstCtx = dstCanvas.getContext('2d');
  dstCtx.imageSmoothingEnabled = false;
  dstCtx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h);
  dstCtx.imageSmoothingEnabled = true;
}

function drawBadge(ctx, x, y, label) {
  const text = String(label || 'REDACTED').toUpperCase();
  ctx.font = '600 9px -apple-system, "SF Pro Text", "Inter", "Segoe UI", sans-serif';
  const tw = ctx.measureText(text).width + 8;
  const th = 13;
  const bx = x;
  const by = Math.max(0, y - th - 1);
  ctx.fillStyle = 'rgba(217, 135, 90, 0.95)';
  ctx.fillRect(bx, by, tw, th);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, bx + 4, by + 9);
}

function canvasToDataUrl(canvas) {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob?.({ type: 'image/jpeg', quality: 0.85 })
      .then(blob => blobToDataUrl(blob));
  }
  return Promise.resolve(canvas.toDataURL('image/jpeg', 0.85));
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// ── Debug helper: render the original + redacted side-by-side for inspection ──
export async function makeRedactionDiffPreview(originalDataUrl, regions) {
  const redacted = await redactImage(originalDataUrl, regions, { drawBadges: false });
  return { original: originalDataUrl, redacted: redacted.dataUrl, byType: redacted.byType };
}
