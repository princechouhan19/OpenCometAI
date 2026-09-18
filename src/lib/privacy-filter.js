// ─────────────────────────────────────────────────────────────────────────────
// src/lib/privacy-filter.js
// The heart of the privacy-preserving vision pipeline. Orchestrates:
//
//   ┌──────────────────────────────────────────────────────────────────────┐
//   │  CAPTURE  →  DOM PII scan  →  Face detect  →  Object detect (YOLO)  │
//   │                                                                       │
//   │      ↓                                                                │
//   │                                                                       │
//   │  REDACT (canvas)  →  build "redaction manifest"                       │
//   │                                                                       │
//   │      ↓                                                                │
//   │                                                                       │
//   │  RETURN:  { sanitizedDataUrl, manifest, sanitizedDomText, stats }     │
//   │           (this — and ONLY this — may be sent to the server)          │
//   └──────────────────────────────────────────────────────────────────────┘
//
// The "redaction manifest" is the contract with the server: it tells the
// server-side VLM exactly what kind of redaction was applied to each region
// so the model can reason about the page (e.g. "there's a password field
// here, so I should not type a value into it").
// ─────────────────────────────────────────────────────────────────────────────

import { detectFaces, getFaceDetectorStats, detectFacesTiled, detectFacesInPersonBoxes } from './mediapipe-face.js';
import { detectObjects, getLocalVisionStats, getNerPipeline, classifyPage } from './local-vision.js';
import { detectSensitiveDomElements, detectPiiInText, sanitizeText } from './pii-detector.js';
import { redactImage } from './canvas-redactor.js';
import { mlLog, mlWarn } from './local-models-shared.js';
import { classifyVisualContext } from './page-classifier.js';
import { scanImageForPiiRegions } from './ocr-pii.js';

/**
 * Run the full privacy pipeline on a screenshot.
 *
 * @param {object}  input
 * @param {string}  input.imageDataUrl       PNG/JPEG data-URL from captureVisibleTab
 * @param {string}  input.domText            Concatenated DOM textContent (page snapshot)
 * @param {Array}   input.domSensitive       Output of detectSensitiveDomElements() —
 *                                            pre-collected by content script.
 * @param {object}  opts
 * @param {boolean} opts.blurFaces           Default true
 * @param {boolean} opts.redactDomPii        Default true
 * @param {boolean} opts.redactTextPii       Default true
 * @param {boolean} opts.runYolo             Default false (extra latency; opt-in)
 * @param {boolean} opts.useNer              Default false (large model; opt-in)
 * @param {number}  opts.scaleX              Convert DOM-CSS pixels → image pixels
 * @param {number}  opts.scaleY
 *
 * @returns {Promise<{
 *   sanitizedDataUrl: string,
 *   manifest: Array<{type, bounds, reason}>,
 *   sanitizedDomText: string,
 *   stats: {
 *     totalMs: number,
 *     phaseMs: { faceDetect, objectDetect, domScan, textScan, redact },
 *     redactionCounts: Record<string, number>,
 *     backend: string,
 *     modelStats: { face: object, vision: object },
 *   },
 * }>}
 */
export async function runPrivacyPipeline(input, opts = {}) {
  const cfg = {
    blurFaces: true,
    redactDomPii: true,
    redactTextPii: true,
    runYolo: false,
    yoloMemo: true,         // v1.14.1: unchanged-screen reuse of YOLO detections (exact-capture-keyed)
    ocrMemo: true,          // v1.16.0: unchanged-screen reuse of OCR PII regions (exact-capture + ROI keyed)
    useNer: false,
    ocrPii: false,          // SIH Phase 9: opt-in OCR pass for non-DOM PII
    scaleX: 1,
    scaleY: 1,
    yoloPersonOnly: true,   // redact only person-class YOLO boxes
    yoloMinScore: 0.4,
    yoloMaxEdge: 0,         // v1.16.0: optional detector-input downscale (longest edge px). 0 = disabled.
                            // Box coordinates are mapped back to full image size; redaction semantics unchanged.
                            // MEASURED (probe-yolo-downscale.mjs): correctness-neutral (box parity IoU=1.000) but
                            // LATENCY-NEUTRAL — the model resizes internally to a fixed resolution, so input
                            // downscale does NOT cut compute. Keep 0 unless a future use needs smaller inputs.
    maxWidth: 1280,         // downscale the sanitized image for the VLM (latency)
    ...opts,
  };

  const phaseMs = { faceDetect: 0, objectDetect: 0, vit: 0, ocr: 0, domScan: 0, textScan: 0, redact: 0 };
  const tTotal = performance.now();
  const logs = [];               // pipeline log lines (mirrored to console + stats)
  const log = (line) => { logs.push(line); mlLog(`[Privacy] ${line}`); };

  // ── 1) DOM-based sensitive elements (already pre-collected by content script)
  const domSensitive = (input.domSensitive || []).filter(r =>
    cfg.redactDomPii || r.type === 'password'
  );
  phaseMs.domScan = Math.round(performance.now() - tTotal);
  log(`DOM scan: ${domSensitive.length} sensitive element(s) (${(input.domSensitive || []).length} found, redactDomPii=${cfg.redactDomPii})`);

  // ── 2) Face detection via MediaPipe (two-pass: full frame → tiled sweep)
  // The tiled sweep exists because BlazeFace short-range misses small faces
  // (webcam overlays, thumbnail avatars) on large DPR-2 screenshots — the
  // user-visible bug was "Faces detected: 0" while a face was clearly on
  // screen. Face boxes are in IMAGE pixels (no dpr scaling needed).
  let faceDetections = [];
  let faceDebug = null;
  // v1.16.1 FAIL-CLOSED FACE POLICY — mirrors the v1.13 OCR policy below.
  // Previously a face-detection failure was caught, logged and the pipeline
  // CONTINUED — which meant a frame whose faces were never detected could
  // ship with zero face coverage and still pass every firewall check (the
  // gate verifies process, not content). The worst case was raw pixels on
  // the wire. Now a failed face stage FAILS verification, exactly like a
  // failed OCR stage: functionality is lost, pixels are never leaked.
  let faceDetectFailed = false;
  let faceDetectFailedReason = '';
  if (cfg.blurFaces) {
    const t0 = performance.now();
    try {
      // v1.14.1: unchanged-screen memo keys are now the EXACT capture string
      // (byte-identical data-URL equality — zero hash-collision risk) for both
      // faces and YOLO. The previously used sampled content hash carried a
      // small (≤4096-sample) collision surface; for a privacy-relevant cache
      // we don't accept even that theoretical risk, and the exact key gives
      // the strongest possible "scene has not changed" signal: ANY pixel
      // difference → different key → full re-detection (scene-change attack
      // is covered by scripts/test_scene_change_attack.mjs).
      // riskHints still drive the adaptive fine-sweep cap — the caller
      // (privacy-agent) derives them from the DOM census; explicit
      // cfg.faceDetect.riskHints win when provided.
      const fdOpts = { ...(cfg.faceDetect || {}) };
      fdOpts.riskHints = { ...(input.faceRisk || {}), ...(fdOpts.riskHints || {}) };
      if (fdOpts.imageHash === undefined) fdOpts.imageHash = input.imageDataUrl;
      const tiled = await detectFacesTiled(await dataUrlToBitmap(input.imageDataUrl), fdOpts);
      faceDetections = tiled.detections;
      faceDebug = tiled.debug;
      if (faceDetections.length) {
        log(`Faces: ${faceDetections.length} detected in ${faceDebug.totalMs}ms ` +
          `(image ${faceDebug.width}×${faceDebug.height}, full-frame hits ${faceDebug.fullFrameDets}, tiles ${faceDebug.tilesScanned}, verify ${faceDebug.verifyMs ?? 0}ms, kept by ${faceDebug.stageKept || 'n/a'}) — ` +
          faceDetections.map(d => `(${d.bounds.x},${d.bounds.y} ${d.bounds.w}×${d.bounds.h} @${d.confidence.toFixed(2)}${d.verifyScore != null ? `→v${d.verifyScore.toFixed(2)}` : ''})`).join(' '));
      } else {
        log(`Faces: 0 detected in ${faceDebug?.totalMs ?? 0}ms ` +
          `(image ${faceDebug?.width}×${faceDebug?.height}, full-frame scanned, ${faceDebug?.tilesScanned ?? 0} tiles swept incl. ${faceDebug?.fineTilesScanned ?? 0} fine — nothing above threshold)`);
      }
      // Verification-rescan telemetry: layout hallucinations caught and
      // rejected BEFORE they could reach the redaction canvas.
      const vDropped = faceDebug?.verifiedDropped || [];
      if (vDropped.length) {
        log(`Face-verify: rejected ${vDropped.length} layout false-positive(s) — ` +
          vDropped.map(d => `${d.bounds.w}×${d.bounds.h} native ${d.native} → rescan ${d.verify}`).join(', '));
      }
    } catch (err) {
      faceDetectFailed = true;
      faceDetectFailedReason = String(err?.message || err);
      mlWarn('[Privacy] Face detection failed — fail-closed (frame will FAIL verification):', faceDetectFailedReason);
      log(`Faces: detection ERROR — ${faceDetectFailedReason} (fail-closed: transmission will be BLOCKED)`);
    }
    phaseMs.faceDetect = Math.round(performance.now() - t0);
  } else {
    log('Faces: skipped (blurFaces=false)');
  }

  // ── 3) YOLO object detection (opt-in — adds latency)
  // The data-URL is passed straight to the pipeline — Transformers.js RawImage
  // decodes it natively inside the offscreen document.
  // PRIVACY FILTER: only PERSON-class boxes are redacted. Generic objects
  // (sports balls, furniture…) black-boxed on the user's screen read as
  // broken/misaligned redaction (user-reported: gameplay areas covered by
  // black squares while the actual face stayed visible).
  //
  // v1.14.1 — UNCHANGED-SCREEN YOLO MEMO (the dominant sanitize cost):
  // objectDetect is the #1 sanitize phase on real hardware (P50 6766 ms of the
  // 8014 ms total — OpenCometBench/results/browser-benchmark-1788724999257.json).
  // The memo reuses the RAW detection set ONLY when the capture is
  // BYTE-IDENTICAL to the capture that produced it (the exact data-URL string
  // is the memo key — JS string equality, zero hash collisions possible), so
  // a changed screen — the scene-change attack — can NEVER be served from the
  // cache: any pixel difference produces a different capture → different key
  // → full re-detection. This is the strongest possible "scene has not
  // materially changed" signal, far stronger than a sampled/perceptual hash.
  // Semantics preserved:
  //   • a memo hit re-uses the SAME boxes the detector produced for THESE
  //     pixels — "skipped" never becomes "assume no sensitive object";
  //   • the person-only/minScore filters re-apply per call (config may change);
  //   • stores BOXES ONLY (never pixels beyond the caller's own string ref);
  //   • 2-entry LRU in the offscreen document, in memory only;
  //   • cfg.yoloMemo=false disables it entirely (fail-safe switch).
  let objectDetections = [];
  let yoloAll = [];
  let yoloMemoHit = false;
  if (cfg.runYolo) {
    const t0 = performance.now();
    try {
      let r = null;
      if (cfg.yoloMemo !== false) r = yoloMemoGet(input.imageDataUrl);
      if (r) {
        yoloMemoHit = true;
        yoloAll = r.detections;
      } else {
        r = await detectObjects(input.imageDataUrl, { maxEdge: cfg.yoloMaxEdge });
        yoloAll = r.detections;
        if (cfg.yoloMemo !== false) yoloMemoSet(input.imageDataUrl, { detections: yoloAll, latencyMs: r.latencyMs });
      }
      objectDetections = r.detections
        .filter(d => cfg.yoloPersonOnly
          ? d.label === 'person'
          : true)
        .filter(d => d.score >= (cfg.yoloMinScore ?? 0.4))
        .map(d => ({
          type: 'object',
          label: d.label,
          bounds: d.bounds,
          confidence: d.score,
          source: 'yolo',
        }));
      log(`YOLO${yoloMemoHit ? ' [memo hit — unchanged screen]' : ''}: ${yoloAll.length} object(s) in ${r.latencyMs}ms → ${objectDetections.length} redacted ` +
        `(person-only=${cfg.yoloPersonOnly}, minScore=${cfg.yoloMinScore ?? 0.4}); ` +
        `all: ${yoloAll.map(d => `${d.label}@${d.score.toFixed(2)}`).join(', ') || 'none'}`);
    } catch (err) {
      mlWarn('[Privacy] YOLO detection failed:', err?.message || err);
      log(`YOLO: detection ERROR — ${err?.message || err}`);
    }
    phaseMs.objectDetect = Math.round(performance.now() - t0);
  }

  // ── 3b) Person-guided face sweep (last-resort recall boost) ────────────────
  // If MediaPipe found NO faces but YOLO DID find person(s), crop each person
  // box, upscale it, and re-run face detection inside just that region. This
  // catches tiny faces — e.g. a ~65px circular avatar on the demo page, where
  // the side panel shrinks the viewport — that neither the full-frame pass nor
  // the 512/256px tile sweeps can fire on.
  if (cfg.blurFaces && faceDetections.length === 0 && cfg.runYolo && objectDetections.length) {
    const t0 = performance.now();
    try {
      const personBoxes = objectDetections
        .filter(d => d.label === 'person')
        .map(d => d.bounds);
      if (personBoxes.length) {
        const guided = await detectFacesInPersonBoxes(
          await dataUrlToBitmap(input.imageDataUrl), personBoxes,
          ...(cfg.faceDetect ? [cfg.faceDetect] : []),
        );
        faceDetections = guided.detections;
        const ms = Math.round(performance.now() - t0);
        log(`Faces(person-sweep): ${faceDetections.length} detected in ${ms}ms ` +
          `(${guided.debug.regionsScanned} YOLO person region(s) re-scanned upscaled)` +
          (faceDetections.length
            ? ' — ' + faceDetections.map(d => `(${d.bounds.x},${d.bounds.y} ${d.bounds.w}×${d.bounds.h} @${d.confidence.toFixed(2)})`).join(' ')
            : ''));
      }
    } catch (err) {
      mlWarn('[Privacy] Person-guided face sweep failed:', err?.message || err);
      log(`Faces(person-sweep): ERROR — ${err?.message || err}`);
    }
  }

  // ── 3b′) DOM-guided face sweep (v1.15.3 — small-profile-photo recall) ──────
  // USER-REPORTED (field): small profile photos (~48–72 CSS px) repeatedly end
  // with "Faces detected: 0" and the face stays VISIBLE in the sanitized
  // capture, while every text/DOM PII family redacts correctly. The pixel
  // cascade above is probabilistic — tile caps sample positions, YOLO rarely
  // boxes a thumbnail person, and a head-only crop inside a small <img> can
  // sit below every stage's firing threshold. The DOM scan (pageContextScan)
  // now hands us the exact rects of visible <img> elements: crop each one
  // from the capture, upscale it (min edge ≈256px, ×4 cap — a 64px avatar
  // face becomes ~200px), and let the SAME detector confirm. Model-confirmed
  // only: an image with no detectable face is left untouched, so logos and
  // generic icons are NOT blanket-redacted. Rects arrive in CSS px — the ONE
  // allowed DPR conversion applies (cssRectToImage, same contract as step 5).
  let domSweep = null;
  if (cfg.blurFaces && Array.isArray(input.photoCandidates) && input.photoCandidates.length) {
    const t0 = performance.now();
    try {
      // Stand-down test shared with the avatar guard (step 3b″): a cascade
      // face box whose CENTER sits inside the candidate rect covers it —
      // face-box/element ratios vary 33–52% across portraits, so the old
      // ratio-only 0.5 test re-swept already-covered avatars and appended a
      // near-duplicate box (measured in probe-v1154-final: faces 3 where 2
      // faces exist). The 0.35 floor stays as the wide-avatar belt.
      const coveredByFace = (b) => faceDetections.some(f => {
        const fb = f.bounds;
        const cx = fb.x + fb.w / 2, cy = fb.y + fb.h / 2;
        if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) return true;
        const ix = Math.max(0, Math.min(b.x + b.w, fb.x + fb.w) - Math.max(b.x, fb.x));
        const iy = Math.max(0, Math.min(b.y + b.h, fb.y + fb.h) - Math.max(b.y, fb.y));
        return ix * iy >= 0.35 * b.w * b.h;
      });
      const needSweep = input.photoCandidates
        .map(c => ({ ...c, bounds: cssRectToImage(c.bounds, cfg.scaleX, cfg.scaleY) }))
        .filter(c => !coveredByFace(c.bounds))
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 32);
      if (needSweep.length) {
        const guided = await detectFacesInPersonBoxes(
          await dataUrlToBitmap(input.imageDataUrl),
          needSweep.map(c => c.bounds),
          { sourceLabel: 'mediapipe-dom-crop' },
        );
        const hits = guided.detections;
        domSweep = {
          candidates: input.photoCandidates.length,
          scanned: needSweep.length,
          hits: hits.length,
          ms: Math.round(performance.now() - t0),
        };
        if (hits.length) {
          faceDetections = [...faceDetections, ...hits];
          log(`Faces(dom-sweep): ${hits.length} detected in ${domSweep.ms}ms ` +
            `(${needSweep.length} DOM image region(s) re-scanned upscaled of ${input.photoCandidates.length} candidate(s))` +
            ' — ' + hits.map(d => `(${d.bounds.x},${d.bounds.y} ${d.bounds.w}×${d.bounds.h} @${d.confidence.toFixed(2)})`).join(' '));
        } else {
          log(`Faces(dom-sweep): 0 in ${domSweep.ms}ms (${needSweep.length} DOM image region(s) scanned — no model-confirmed face; icons/logos left unredacted)`);
        }
      }
    } catch (err) {
      mlWarn('[Privacy] DOM-guided face sweep failed:', err?.message || err);
      log(`Faces(dom-sweep): ERROR — ${err?.message || err}`);
    }
  }

  // ── 3b″) AVATAR GUARD (v1.15.4 — deterministic small-profile-photo cover) ──
  // THIRD field report of the same leak ("WHEN PROFILE IMAGE IS SMALL ITS
  // UNABLE TO HIDE THAT", Master Perception Test page, Faces detected: 0).
  // Root causes the model-confirmed sweep cannot fully close:
  //   • avatars painted as CSS background-image (v1.15.3 collector gap — now
  //     collected as bg-avatar-hint candidates, but still model-gated), and
  //   • portraits the detector genuinely refuses to confirm at any scale —
  //     head-only crops, heavy compression, faces < ~35px even after ×4
  //     upscale.
  // Policy change, privacy-first: an image the page ITSELF labels as an
  // avatar/profile photo (avatar-hint / bg-avatar-hint) that no confirmed
  // face covers is redacted on its element rect EVEN WITHOUT model
  // confirmation. Asymmetry: a wrongly blurred 64px logo-hinted img costs a
  // small black square; a missed real face ships the user's identity to the
  // VLM. Non-hinted icons/logos (the negative controls) are STILL scanned,
  // never blanket-redacted — the guard keys on the page's own avatar naming.
  let avatarGuard = null;
  if (cfg.blurFaces && Array.isArray(input.photoCandidates) && input.photoCandidates.length) {
    const t0 = performance.now();
    try {
      const guarded = [];
      for (const c of input.photoCandidates) {
        // Only page-declared avatars qualify (hint tokens set by the scanner).
        if (c.hint !== 'avatar-hint' && c.hint !== 'bg-avatar-hint') continue;
        const b = cssRectToImage(c.bounds, cfg.scaleX, cfg.scaleY);
        // min-edge clamp: tiny icons (<24px) never became candidates; large
        // images (>180 CSS px min edge) are reliably covered by the cascade.
        const minEdge = Math.min(b.w, b.h);
        if (minEdge < 24 || minEdge > 180 * (Number(cfg.scaleX) || 1)) continue;
        // Already covered by a confirmed (or person/dom-crop) face? stand down.
        // A face BOX sits inside the avatar element and its coverage ratio
        // varies with the portrait's head scale (measured 33-52% across two
        // portraits) — ratio thresholds keep mis-firing, so the decisive test
        // is geometric: the face box CENTER inside the avatar rect, with a
        // 0.25 intersection floor as the belt to that suspenders.
        const covered = faceDetections.some(f => {
          const fb = f.bounds;
          const cx = fb.x + fb.w / 2, cy = fb.y + fb.h / 2;
          if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) return true;
          const ix = Math.max(0, Math.min(b.x + b.w, fb.x + fb.w) - Math.max(b.x, fb.x));
          const iy = Math.max(0, Math.min(b.y + b.h, fb.y + fb.h) - Math.max(b.y, fb.y));
          return ix * iy >= 0.25 * b.w * b.h;
        });
        if (!covered) {
          guarded.push({
            type: 'face',
            confidence: 0.5,          // honest: heuristic, not model-confirmed
            source: 'dom-avatar-guard',
            bounds: b,
          });
        }
      }
      if (guarded.length) {
        faceDetections = [...faceDetections, ...guarded];
        avatarGuard = { candidates: input.photoCandidates.length, guarded: guarded.length, ms: Math.round(performance.now() - t0) };
        log(`Faces(avatar-guard): ${guarded.length} page-declared avatar image(s) NOT covered by a confirmed face — redacted on their element rects (heuristic, privacy-first). ` +
          guarded.map(d => `(${d.bounds.x},${d.bounds.y} ${d.bounds.w}×${d.bounds.h})`).join(' '));
      } else {
        avatarGuard = { candidates: input.photoCandidates.length, guarded: 0, ms: Math.round(performance.now() - t0) };
      }
    } catch (err) {
      mlWarn('[Privacy] Avatar guard failed:', err?.message || err);
      log(`Faces(avatar-guard): ERROR — ${err?.message || err}`);
    }
  }

  // ── 3c) ViT page classification (SIH Phase 5 — ADAPTIVE, gated upstream).
  // The gate (page-classifier.shouldRunVisionClassifier) already decided this
  // BEFORE capture: thin/uncertain DOM, visually-heavy pages, or user request.
  // The ViT contributes the visual SCENE + confidence to the structured
  // visual context that steers the agent — it does NOT run on every step.
  let vitLabels = null;
  if (input.vit) {
    const t0 = performance.now();
    try {
      const r = await classifyPage(input.imageDataUrl, 3);
      vitLabels = r.labels;
      log(`ViT: top labels ${vitLabels.map(l => `${l.label}@${(l.score || 0).toFixed(2)}`).join(', ')} in ${r.latencyMs}ms`);
    } catch (err) {
      mlWarn('[Privacy] ViT classification failed:', err?.message || err);
      log(`ViT: classification ERROR — ${err?.message || err}`);
    }
    phaseMs.vit = Math.round(performance.now() - t0);
  } else {
    log(`ViT: skipped (adaptive gate: ${input.vitReason || 'dom-sufficient or disabled'})`);
  }

  // ── 3d) STRUCTURED VISUAL CONTEXT — fuse DOM/URL signals + ViT scene.
  // This is the SIH "visual context" artifact: pageType + visualElements +
  // confidence + scene, attached to the payload AND the agent prompt.
  // v1.14: the pixel-level detectors that ran ABOVE (faces / YOLO persons /
  // OCR regions) are passed in as explicit source attribution, so the visual
  // context honestly reports which perception sources contributed.
  let visualContext = null;
  try {
    // v1.14.1 FIX: this block previously read `ocrRegions.length`, but
    // `ocrRegions` is declared LATER (the OCR pass runs in step 3e, after the
    // fusion). That is a temporal-dead-zone ReferenceError which this catch
    // swallowed — so `visualContext` came out null on EVERY capture and the
    // whole structured visual-context feature silently vanished from the
    // payload and the agent prompt. The fusion now runs with the sources that
    // have actually executed at this point (faces / YOLO); the OCR region
    // count is enriched into sources.visualDetector right after the OCR pass
    // (see the enrichment block below, which was already written for that
    // purpose). No privacy semantics change — sources stay honest.
    visualContext = classifyVisualContext({
      url: input.pageUrl || '',
      title: input.pageTitle || '',
      text: input.domText || '',
      dom: input.dom || {},
    }, vitLabels, {
      visualDetector: {
        used: faceDetections.length > 0 || objectDetections.length > 0,
        faces: faceDetections.length,
        objects: objectDetections.length,
        ocrRegions: 0,   // OCR has not run yet — enriched below after step 3e
      },
    });
    log(`Visual context: pageType=${visualContext.pageType} conf=${visualContext.confidence} scene=${visualContext.scene} basis=${visualContext.decision?.basis} elements=[${visualContext.visualElements.join(', ')}]`);
  } catch (err) {
    mlWarn('[Privacy] Visual-context fusion failed:', err?.message || err);
  }

  // ── 3e) OCR visual-PII scan (SIH Phase 9 — OPT-IN) ───────────────────
  // Pixels the DOM cannot see: text baked into images, canvas, PDF viewers.
  // OCR runs locally (lazy engine); ONLY the resulting redaction regions are
  // used — raw OCR text never leaves this function.
  let ocrRegions = [];
  let ocrFailed = false;          // v1.13 fail-closed flag (OCR requested but unavailable)
  let ocrFailedReason = '';
  let ocrMemoHit = false;         // v1.16.0 telemetry: unchanged-screen OCR memo reuse
  // v1.15.4 TARGETED CROP ROIs: canvases (pixel-text containers) + photo
  // candidates, in IMAGE space, capped. The full-page OCR pass drops small
  // text on busy pages (field report: 1 of 6+ pixel-PII instances redacted);
  // a ×2-upscaled per-ROI re-read is deterministic where segmentation fails.
  const ocrRois = (
    [
      ...(Array.isArray(input.pixelTextRects) ? input.pixelTextRects : []),
      ...(Array.isArray(input.photoCandidates)
        ? input.photoCandidates.filter(c => (c.bounds?.w || 0) >= 120).map(c => c.bounds)
        : []),
    ]
      .map(b => cssRectToImage(b, cfg.scaleX, cfg.scaleY))
      .slice(0, 12)
  );
  if (cfg.ocrPii) {
    const t0 = performance.now();
    try {
      // v1.16.0 OCR MEMO — same safety pattern as the YOLO memo (v1.14.1):
      //   • key = the EXACT capture data-URL string + the serialized ROI list
      //     (the OCR result depends on BOTH — a different crop set is a
      //     different scan); string equality means a hit proves byte-identical
      //     pixels AND an identical crop set, so any pixel or DOM-census change
      //     forces a miss → full re-scan;
      //   • stores the region list ONLY (no raw OCR text beyond what the
      //     regions already carry — the same objects the pipeline itself holds
      //     in memory for this frame);
      //   • FAILED and SKIPPED scans are never memoized (fail-closed stays
      //     honest — an unavailable engine re-reports on every call);
      //   • 2-entry LRU, in-memory in the offscreen document;
      //   • cfg.ocrMemo=false disables it entirely (fail-safe switch).
      const ocrMemoKey = cfg.ocrMemo === false ? null
        : `${input.imageDataUrl}\u0000${JSON.stringify(ocrRois)}`;
      let ocr = ocrMemoKey ? ocrMemoGet(ocrMemoKey) : null;
      ocrMemoHit = Boolean(ocr);
      if (!ocr) {
        ocr = await scanImageForPiiRegions(input.imageDataUrl, { rois: ocrRois });
        if (ocrMemoKey && !ocr.failed && !ocr.skipped) ocrMemoSet(ocrMemoKey, ocr);
      }
      ocrRegions = ocr.regions || [];
      if (ocr.failed) {
        // v1.13 OCR FAILURE POLICY — the user explicitly enabled visual-PII
        // protection, so an unavailable engine must NOT silently create a
        // privacy gap. The pipeline still finishes (faces/DOM/redaction),
        // but stats.ocrFailed makes sanitizeScreenContext() REFUSE
        // verification → the network gate blocks transmission (fail-closed).
        ocrFailed = true;
        ocrFailedReason = ocr.reason || 'unavailable';
        mlWarn('[Privacy] OCR enabled but UNAVAILABLE — frame will FAIL verification (fail-closed):', ocrFailedReason);
        log(`OCR: FAILED (${ocrFailedReason}) — fail-closed: transmission will be BLOCKED`);
      } else if (ocr.skipped) {
        log(`OCR: skipped (${ocr.reason}); pipeline continues`);
      } else if (ocrMemoHit) {
        // Memo hit: report the ACTUAL phase cost (≈0 ms), never the stored
        // original scan time — the log must stay honest about what ran.
        log(`OCR [memo hit — unchanged screen+ROIs]: ${ocrRegions.length} PII region(s) reused in ${Math.round(performance.now() - t0)}ms ` +
          `(original scan ${ocr.ms ?? '?'}ms)`);
      } else {
        log(`OCR: ${ocr.textChars} chars scanned → ${ocrRegions.length} PII region(s) in ${ocr.ms}ms` +
          (ocr.roiRegions ? ` (+${ocr.roiRegions} from ${ocr.roisScanned ?? 0} targeted crop ROI(s))` : ''));
      }
    } catch (err) {
      ocrFailed = true;
      ocrFailedReason = String(err?.message || err);
      mlWarn('[Privacy] OCR pass CRASHED — fail-closed:', ocrFailedReason);
      log(`OCR: ERROR — ${ocrFailedReason} (fail-closed: transmission will be BLOCKED)`);
    }
    phaseMs.ocr = Math.round(performance.now() - t0);
  }

  // v1.14: OCR runs AFTER the visual-context fusion, so its region count is
  // enriched into the source attribution here (keeps the contract honest).
  if (visualContext?.sources?.visualDetector) {
    visualContext.sources.visualDetector.ocrRegions = ocrRegions.length;
    visualContext.sources.visualDetector.used =
      visualContext.sources.visualDetector.used || ocrRegions.length > 0;
  }

  // ── 4) Text-level PII scan (regex + optional NER)
  let textFindings = [];
  let knownValues = [];   // v1.16.1: raw matched values for the wire-guard scan
  let sanitizedDomText = input.domText || '';
  if (cfg.redactTextPii && input.domText) {
    const t0 = performance.now();
    try {
      textFindings = await detectPiiInText(input.domText, {
        useNer: cfg.useNer,
        nerPipeline: cfg.useNer ? await getNerPipeline() : null,
        maxChars: 8000,
      });
      sanitizedDomText = sanitizeText(input.domText, textFindings);
    } catch (err) {
      console.warn('[Privacy] Text PII scan failed:', err);
    }
    phaseMs.textScan = Math.round(performance.now() - t0);
  }

  // ── 5) Build the unified region list for canvas redaction
  // COORDINATE SPACES (important!):
  //   • Face + YOLO boxes are ALREADY in image pixels (detected on the
  //     physical-resolution capture) — they must NOT be scaled again.
  //   • DOM-sensitive rects come from getBoundingClientRect() in CSS pixels —
  //     the ONLY regions that need the ×DPR conversion.
  // Everything is normalised into image space HERE and redactImage() is called
  // with scale=1. (Previously the CSS→image factor was applied to ALL regions,
  // double-scaling face/YOLO boxes by DPR — their redactions were drawn
  // offset down-right: on the demo page the avatar's person box landed on the
  // "LOGIN FORM" heading instead of on the avatar.)
  const regions = [
    ...faceDetections,
    // v1.15.4 DRAW-ORDER FIX: OCR regions are painted FIRST so a DOM box can
    // overpaint them. The previous order (OCR last) let a pixelated OCR hit
    // re-draw UNREDACTED source pixels over an already-black-boxed input —
    // the mosaic fringes visible on top of the Aadhaar/Date/Expiry black bars
    // in the user's field screenshots. Coverage is identical (the DOM rect
    // contains the OCR text box); only the paint order changed. Face boxes
    // stay first so their blur is never degraded by a later pixelate.
    ...ocrRegions,   // SIH Phase 9: already in image pixels (OCR ran on the raw capture)
    ...domSensitive.map(r => ({ ...r, bounds: cssRectToImage(r.bounds, cfg.scaleX, cfg.scaleY) })),
    ...(cfg.runYolo ? objectDetections : []),
  ];

  // For text PII findings without screen coordinates we cannot redact pixels;
  // instead they are masked inside the sanitizedDomText returned to the server.
  // We DO include them in the manifest so the server knows what types were masked.

  // ── 6) Pixel-level redaction
  let redactionResult = null;
  let redactionFailedFlag = false;
  const tRedact = performance.now();
  try {
    redactionResult = await redactImage(input.imageDataUrl, regions, {
      faceBlurRadius: 18,
      drawBadges: false,
      // Orange per-region debug outlines removed (user report: the thin orange
      // border around each redaction box read as a rendering error and added
      // visual noise to the image the VLM receives). The redaction marks are
      // self-explanatory: solid black fill / blur+eye-bar / pixelation.
      drawOutlines: false,
      maxWidth: cfg.maxWidth,
    }); // regions are already normalised to image pixels (see step 5)
    log(`Redact: ${regions.length} region(s) drawn · ${redactionResult.width}×${redactionResult.height}px` +
      (redactionResult.scaledDown ? ` → downscaled to ${redactionResult.outWidth}×${redactionResult.outHeight} for the VLM (faster upload + vision tokens)` : '') +
      ` · byType=${JSON.stringify(redactionResult.byType)}`);
  } catch (err) {
    console.error('[Privacy] Redaction failed:', err);
    mlWarn('[Privacy] Redaction failed:', err?.message || err);
    // Fail-closed: do NOT send the un-redacted image. Return a blank instead.
    // SIH: the failure is REPORTED in stats so the privacy firewall can show
    // the degraded status in the inspector (and so the benchmark can detect it).
    // The blank 1×1 frame carries zero user pixels — structurally unsensitive.
    redactionResult = { dataUrl: blankImage(), width: 0, height: 0, redactedCount: 0, byType: {}, scaledDown: false, outWidth: 0, outHeight: 0 };
    redactionFailedFlag = true;
  }
  phaseMs.redact = Math.round(performance.now() - tRedact);

  // ── 7) Build the manifest for the server
  const manifest = regions.map(r => ({
    type: r.type,
    bounds: r.bounds,
    reason: r.source,
    confidence: r.confidence,
    // For DOM-discovered elements, include the selector so the server-side VLM
    // can refer to it (e.g. "click element with selector '#submit'")
    ...(r.selector ? { selector: r.selector, label: r.label } : {}),
  }));

  // Also include text-level PII summary (no raw values)
  const textPiiSummary = summariseTextPii(textFindings);

  // v1.16.1 WIRE-GUARD FEED: the RAW matched values the text detector just
  // redacted stay in-memory only (never serialized into the envelope) and are
  // handed to the caller so decideViaServer() can run the byte-level
  // exact-match leakage scan (wire-guard.js) over the outbound payload.
  // A detector miss upstream cannot survive an exact-match scan downstream.
  knownValues = [...new Set(textFindings
    .map(f => String(f?.raw || ''))
    .filter(v => v.length >= 6 && v.length <= 200))].slice(0, 80);

  return {
    sanitizedDataUrl: redactionResult.dataUrl,
    manifest,
    sanitizedDomText,
    textPiiSummary,
    visualContext,
    vitLabels,
    pipelineLogs: logs,
    stats: {
      totalMs: Math.round(performance.now() - tTotal),
      phaseMs,
      redactionFailed: redactionFailedFlag,
      ...(redactionFailedFlag ? { safeFallback: 'blank' } : {}),
      redactionCounts: { ...redactionResult.byType, ...textPiiSummary.byType },
      backend: getLocalVisionStats().backend,
      modelStats: {
        face: getFaceDetectorStats(),
        vision: getLocalVisionStats(),
      },
      faceDebug,
      // v1.15.3 DOM-guided face sweep telemetry (candidates/scanned/hits/ms)
      domSweep,
      // v1.15.4 avatar-guard telemetry (deterministic heuristic cover)
      avatarGuard,
      image: { width: redactionResult.width, height: redactionResult.height, outWidth: redactionResult.outWidth, outHeight: redactionResult.outHeight, scaledDown: Boolean(redactionResult.scaledDown) },
      counts: {
        faces: faceDetections.length,
        domSensitive: domSensitive.length,
        objects: objectDetections.length,
        textPii: textFindings.length,
        ocrPii: ocrRegions.length,
      },
      // v1.14.1 memo telemetry (honest reporting of the reuse path):
      yoloMemoHit,
      ocrMemoHit,
      faceMemoHit: Boolean(faceDebug?.memoHit),
      // v1.13 fail-closed OCR policy — see the OCR block above.
      ocrFailed,
      ocrFailedReason,
      // v1.16.1 fail-closed face policy — see the face-detect block above.
      faceDetectFailed,
      faceDetectFailedReason,
    },
    // v1.16.1: internal-only (SW ↔ offscreen channel). Consumed by the
    // wire-guard byte-level scan in decideViaServer; NEVER serialized into
    // the firewall envelope or any network payload.
    knownValues,
  };
}

function summariseTextPii(findings) {
  // SIH: COUNTS ONLY. The previous shape shipped masked values + char offsets
  // to the server — a leak surface that nothing on the server side consumed.
  // Counts are all the VLM prompt needs ("N emails, 1 card number were masked").
  const byType = {};
  for (const f of findings) byType[f.type] = (byType[f.type] || 0) + 1;
  return {
    total: findings.length,
    byType,
  };
}

function dataUrlToBitmap(dataUrl) {
  return new Promise((resolve, reject) => {
    if (dataUrl instanceof Blob) {
      createImageBitmap(dataUrl).then(resolve, reject);
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/**
 * Convert a CSS-pixel rect (getBoundingClientRect space) into image pixels
 * (captureVisibleTab physical pixels). Exported pure so it can be unit-tested;
 * this is the ONLY place a DPR conversion may happen — face/YOLO boxes are
 * detected directly on the physical capture and must never pass through here.
 */
export function cssRectToImage(bounds, scaleX = 1, scaleY = 1) {
  const sx = Number(scaleX) || 1;
  const sy = Number(scaleY) || 1;
  return {
    x: Math.round((bounds?.x || 0) * sx),
    y: Math.round((bounds?.y || 0) * sy),
    w: Math.round((bounds?.w || 0) * sx),
    h: Math.round((bounds?.h || 0) * sy),
  };
}

function blankImage() {
  // 1×1 transparent PNG
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
}

/**
 * v1.14.1 — unchanged-screen YOLO memo (see the step-3 block for the privacy
 * analysis). Keyed by the EXACT capture data-URL string: JS string equality
 * means a memo hit proves byte-identical pixels, so the reuse of the previous
 * detection set for those identical pixels is as good as re-running the
 * detector — while skipping its 6.8 s real-hardware cost. A collision is
 * structurally impossible; any pixel change forces a miss → full re-detect.
 * 2-entry LRU, boxes only, in-memory in the offscreen document,
 * disableable via cfg.yoloMemo=false. Face memo (mediapipe-face.js) is keyed
 * through the same exact string via fdOpts.imageHash.
 */
const _yoloMemo = new Map();

/**
 * LRU memo primitives — EXPORTED PURE (same pattern as cssRectToImage) so the
 * scene-change attack test (scripts/test_scene_change_attack.mjs) can verify
 * hit/miss/eviction semantics without a browser. The production maps above
 * use the exact capture data-URL string as key.
 */
export function memoLruGet(map, key) {
  if (!map || !map.has(key)) return null;
  const v = map.get(key);
  map.delete(key); map.set(key, v); // LRU touch
  return v;
}
export function memoLruSet(map, key, val, cap = 2) {
  map.set(key, val);
  while (map.size > cap) map.delete(map.keys().next().value);
}
function yoloMemoGet(key) {
  return memoLruGet(_yoloMemo, key);
}
function yoloMemoSet(key, val) {
  memoLruSet(_yoloMemo, key, val, 2);
}

/**
 * v1.16.0 — unchanged-screen OCR memo. Same pattern and same privacy analysis
 * as the YOLO memo above; the key additionally folds in the serialized ROI
 * list because scanImageForPiiRegions() results depend on the crop set too.
 * Region boxes only, 2-entry LRU, in-memory in the offscreen document,
 * disableable via cfg.ocrMemo=false. Failed/skipped scans are never stored.
 */
const _ocrMemo = new Map();
function ocrMemoGet(key) {
  return memoLruGet(_ocrMemo, key);
}
function ocrMemoSet(key, val) {
  memoLruSet(_ocrMemo, key, val, 2);
}

/**
 * Convenience: scan only the DOM of a page (no screenshot).
 * Used by the agent loop BEFORE the screenshot to collect element bounds
 * in the page's own coordinate system.
 */
export async function scanDomForSensitiveElements(opts = {}) {
  // This must run in the page context (content script).  When called from
  // the background service worker, the caller should inject this function.
  return detectSensitiveDomElements(document, opts);
}

export const PRIVACY_PIPELINE_VERSION = '1.0.0';
