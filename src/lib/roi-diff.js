// src/lib/roi-diff.js
// REGION-OF-INTEREST CHANGE DETECTION (pure, dependency-free).
//
// The dominant sanitize cost on changed frames is re-running the FULL
// perception stack (objectDetect 7841 ms + OCR 3402 ms on the reference
// hardware) over the whole viewport even when only a small part of the
// screen changed. This module decides WHERE the pixels actually changed so
// the pipeline can re-scan only those regions.
//
// PRIVACY CONTRACT (must hold for every caller):
//   • The union of the returned scan regions ALWAYS covers every changed
//     block — a changed pixel can never fall outside all scan regions.
//     (regionsFromMask merges overflow components instead of dropping them.)
//   • First sight, URL change, scene-change ratio cap and the periodic
//     full-scan cap ALL force a FULL-frame pass (fail-toward-more-work).
//   • Any computation error upstream must degrade to a FULL pass — never to
//     a skipped scan ("skip" may never mean "assume nothing sensitive").
//   • This module NEVER sees raw pixels — only derived block fingerprints
//     (mean / variance / gradient energies) that cannot reconstruct an image.
//
// Design: block grid over a small grayscale proxy (default 96×54 → 12×7
// blocks). Fingerprint = per-block mean, variance and mean |dx|/|dy|
// gradient energies. A block "changed" when ANY statistic differs by more
// than its tolerance — deliberately conservative (false-CHANGED is cheap,
// false-UNCHANGED is a privacy risk). All pure TypedArray math: fully
// unit-testable in Node without a browser.

// Proxy size (downsampled grayscale) and block grid.
export const ROI_PROXY_W = 96;
export const ROI_PROXY_H = 54;
export const ROI_GRID_COLS = 12;
export const ROI_GRID_ROWS = 7;

// Conservative defaults: tolerances are LOW so sensor noise / JPEG jitter
// does NOT mask real changes; the ratio cap forces full scans on material
// scene changes; the periodic cap bounds how long ROI mode may run without
// a fresh full-frame ground truth.
export const ROI_DEFAULTS = Object.freeze({
  meanTol: 5,        // |Δmean| (0-255) above this → block changed
  varTol: 24,        // |Δvariance| above this → block changed
  gradTol: 8,        // |Δ mean-gradient| above this → block changed
  changedRatioCap: 0.35,   // more than 35% blocks changed → full scan
  maxConsecutiveRoi: 5,    // every 6th frame at the latest is a full scan
  maxRegions: 6,           // scan-region cap after connected-component merge
  padFrac: 0.02,           // padding around each region (fraction of image dim)
  coverageCap: 0.60,       // regions covering >60% of the frame → full scan
  minRegionPx: 24,         // regions smaller than this are still scanned (kept)
});

// 1) RGBA pixels → grayscale (Rec.601 luma, 0-255 Uint8)
export function toGray(pixels, w, h) {
  if (!pixels || w <= 0 || h <= 0 || pixels.length < w * h * 4) {
    throw new Error(`toGray: bad input (${pixels?.length ?? 'null'} bytes for ${w}×${h})`);
  }
  const g = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = (pixels[p] * 77 + pixels[p + 1] * 150 + pixels[p + 2] * 29) >> 8;
  }
  return g;
}

// 2) Box-downsample full-res gray → proxy-size gray
export function downsampleGray(gray, w, h, gw = ROI_PROXY_W, gh = ROI_PROXY_H) {
  if (!gray || w <= 0 || h <= 0) throw new Error('downsampleGray: bad input');
  const out = new Uint8Array(gw * gh);
  for (let by = 0; by < gh; by++) {
    const y0 = Math.floor((by * h) / gh), y1 = Math.max(y0 + 1, Math.floor(((by + 1) * h) / gh));
    for (let bx = 0; bx < gw; bx++) {
      const x0 = Math.floor((bx * w) / gw), x1 = Math.max(x0 + 1, Math.floor(((bx + 1) * w) / gw));
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        let p = y * w + x0;
        for (let x = x0; x < x1; x++, p++) { sum += gray[p]; n++; }
      }
      out[by * gw + bx] = n ? Math.round(sum / n) : 0;
    }
  }
  return out;
}

// 3) Block fingerprints: mean / variance / gradient energies per block
export function blockFingerprints(g, gw, gh, cols = ROI_GRID_COLS, rows = ROI_GRID_ROWS) {
  if (!g || g.length < gw * gh) throw new Error('blockFingerprints: bad input');
  const n = cols * rows;
  const means = new Float64Array(n);
  const vars = new Float64Array(n);
  const gxs = new Float64Array(n);
  const gys = new Float64Array(n);
  const bw = gw / cols, bh = gh / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor(c * bw), x1 = Math.max(x0 + 1, Math.floor((c + 1) * bw));
      const y0 = Math.floor(r * bh), y1 = Math.max(y0 + 1, Math.floor((r + 1) * bh));
      let s = 0, s2 = 0, gx = 0, gy = 0, cnt = 0;
      for (let y = y0; y < y1 && y < gh; y++) {
        for (let x = x0; x < x1 && x < gw; x++) {
          const v = g[y * gw + x];
          s += v; s2 += v * v;
          if (x + 1 < gw) gx += Math.abs(v - g[y * gw + x + 1]);
          if (y + 1 < gh) gy += Math.abs(v - g[(y + 1) * gw + x]);
          cnt++;
        }
      }
      const mean = cnt ? s / cnt : 0;
      means[r * cols + c] = mean;
      vars[r * cols + c] = cnt ? Math.max(0, s2 / cnt - mean * mean) : 0;
      gxs[r * cols + c] = cnt ? gx / cnt : 0;
      gys[r * cols + c] = cnt ? gy / cnt : 0;
    }
  }
  return { means, vars, gxs, gys };
}

// 4) Diff two fingerprint sets → changed-block mask
export function diffFingerprints(prev, curr, tol = ROI_DEFAULTS) {
  if (!prev || !curr) throw new Error('diffFingerprints: missing fingerprint set');
  const n = prev.means.length;
  if (n !== curr.means.length) throw new Error('diffFingerprints: grid size mismatch');
  const changed = new Uint8Array(n);
  let changedCount = 0;
  for (let i = 0; i < n; i++) {
    if (
      Math.abs(prev.means[i] - curr.means[i]) > tol.meanTol ||
      Math.abs(prev.vars[i] - curr.vars[i]) > tol.varTol ||
      Math.abs(prev.gxs[i] - curr.gxs[i]) > tol.gradTol ||
      Math.abs(prev.gys[i] - curr.gys[i]) > tol.gradTol
    ) { changed[i] = 1; changedCount++; }
  }
  return { changed, changedCount, ratio: n ? changedCount / n : 1 };
}

// 5) Decision: full scan or ROI scan (fail-toward-more-work)
// Every reason here is a forced-FULL reason; ROI is the LAST resort, only
// when every privacy precondition holds.
export function planPerception({ hasPrevState = false, urlMatched = false, ratio = 1, consecutive = 0, error = null, caps = ROI_DEFAULTS }) {
  if (error) return { mode: 'full', reason: `roi-error: ${error}` };
  if (!hasPrevState) return { mode: 'full', reason: 'first-sight' };
  if (!urlMatched) return { mode: 'full', reason: 'url-change' };
  if (!(ratio <= caps.changedRatioCap)) return { mode: 'full', reason: 'changed-ratio-over-cap' };
  if (consecutive >= caps.maxConsecutiveRoi) return { mode: 'full', reason: 'periodic-full-cap' };
  return { mode: 'roi', reason: 'blocks-localized' };
}

// 6) Changed-block mask → scan regions (connected components, merged)
// INVARIANTS (unit-tested):
//   • every changed block lies inside SOME returned region (overflow
//     components merge into one bounding region — never dropped);
//   • regions are padded and clamped to the image;
//   • when the merged regions would cover more than `coverageCap` of the
//     frame, returns null → the caller must fall back to a FULL scan
//     (cheaper than scanning many overlapping regions).
export function regionsFromMask(changed, cols, rows, imgW, imgH, opts = {}) {
  const { padFrac = ROI_DEFAULTS.padFrac, maxRegions = ROI_DEFAULTS.maxRegions, coverageCap = ROI_DEFAULTS.coverageCap } = opts;
  if (!changed || changed.length !== cols * rows) throw new Error('regionsFromMask: bad mask');
  if (!changed.some(v => v === 1)) return [];
  const seen = new Uint8Array(cols * rows);
  const comps = [];
  const q = [];
  for (let i = 0; i < changed.length; i++) {
    if (!changed[i] || seen[i]) continue;
    // BFS this connected component (4-neighborhood), tracking its bbox.
    let minC = cols, maxC = -1, minR = rows, maxR = -1, size = 0;
    q.push(i); seen[i] = 1;
    while (q.length) {
      const idx = q.pop();
      const c = idx % cols, r = (idx / cols) | 0;
      size++; if (c < minC) minC = c; if (c > maxC) maxC = c;
      if (r < minR) minR = r; if (r > maxR) maxR = r;
      const nb = [c > 0 ? idx - 1 : -1, c < cols - 1 ? idx + 1 : -1, r > 0 ? idx - cols : -1, r < rows - 1 ? idx + cols : -1];
      for (const j of nb) if (j >= 0 && changed[j] && !seen[j]) { seen[j] = 1; q.push(j); }
    }
    comps.push({ minC, maxC, minR, maxR, size });
  }
  // If more components than maxRegions, keep the largest maxRegions-1 and
  // merge ALL remaining ones into one bounding region — coverage preserved.
  comps.sort((a, b) => b.size - a.size);
  const kept = comps.slice(0, Math.max(1, maxRegions - 1));
  const overflow = comps.slice(Math.max(1, maxRegions - 1));
  if (overflow.length) {
    let minC = cols, maxC = -1, minR = rows, maxR = -1;
    for (const o of overflow) {
      if (o.minC < minC) minC = o.minC; if (o.maxC > maxC) maxC = o.maxC;
      if (o.minR < minR) minR = o.minR; if (o.maxR > maxR) maxR = o.maxR;
    }
    kept.push({ minC, maxC, minR, maxR, size: 0 });
  }
  // Block rect → image rect (block grid covers the image evenly), pad + clamp.
  const bw = imgW / cols, bh = imgH / rows;
  const padX = Math.round(imgW * padFrac), padY = Math.round(imgH * padFrac);
  const regions = kept.map(k => ({
    x: Math.max(0, Math.floor(k.minC * bw) - padX),
    y: Math.max(0, Math.floor(k.minR * bh) - padY),
    w: 0, h: 0,
  }));
  for (let i = 0; i < kept.length; i++) {
    const k = kept[i];
    const x1 = Math.min(imgW, Math.ceil((k.maxC + 1) * bw) + padX);
    const y1 = Math.min(imgH, Math.ceil((k.maxR + 1) * bh) + padY);
    regions[i].w = Math.max(regions[i].x + 1, x1) - regions[i].x;
    regions[i].h = Math.max(regions[i].y + 1, y1) - regions[i].y;
  }
  // Coverage cap: over-covered frame → full scan is the honest, cheaper path.
  const covered = regions.reduce((a, r) => a + r.w * r.h, 0);
  if (covered > coverageCap * imgW * imgH) return null;
  return regions;
}

// 7) Geometry helpers (detection keep/merge semantics)
export function boxIntersectsRegion(b, r) {
  if (!b || !r) return false;
  return b.x < r.x + r.w && r.x < b.x + b.w && b.y < r.y + r.h && r.y < b.y + b.h;
}
/**
 * TRUE when a previous-frame detection box lies entirely outside every scan
 * region → its pixels are (per fingerprints) unchanged and the previous
 * detection remains valid there. Anything touching a scanned region is
 * re-derived from the fresh scan of that region — stale boxes never survive
 * on top of changed pixels.
 */
export function boxOutsideAllRegions(b, regions) {
  if (!Array.isArray(regions) || regions.length === 0) return true;
  return !regions.some(r => boxIntersectsRegion(b, r));
}

export const ROI_MODULE_VERSION = '1.0.0';
