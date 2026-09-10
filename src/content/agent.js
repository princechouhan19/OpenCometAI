// ═══════════════════════════════════════════════════════════════════
// Open Comet — Content Script
// Injects live overlay HUD into pages while agent is working
// UI matches Claude.ai aesthetic: warm cream/charcoal, minimal, clean
// ═══════════════════════════════════════════════════════════════════

(function () {
  'use strict';
  if (window.__opencometInjected) return;
  window.__opencometInjected = true;

  let overlayEl  = null;
  let statusEl   = null;
  let badgeEl    = null;
  let isActive   = false;
  const originalTitle = document.title;

  const STOP_ICON_SVG = `
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <rect x="2" y="2" width="10" height="10" rx="1.5" />
    </svg>`;

  // ── Create overlay ──────────────────────────────────────────────
  function createOverlay() {
    if (overlayEl || !document.documentElement) return;

    // ── Styles ──────────────────────────────────────────────────
    const style = document.createElement('style');
    style.id = 'open-comet-overlay-styles';
    style.textContent = `

      /* ── Overlay pill ── */
      #open-comet-agent-overlay {
        position: fixed;
        bottom: 32px;
        left: 50%;
        z-index: 2147483647;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: 0;
        background: rgba(28, 25, 23, 0.72); /* Glass dark */
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 0.5px solid rgba(255, 255, 255, 0.18);
        border-radius: 999px; /* Capsule shape */
        padding: 4px 6px;
        font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', sans-serif;
        box-shadow:
          0 4px 12px rgba(0,0,0,0.12),
          0 16px 48px rgba(0,0,0,0.32),
          inset 0 0 0 0.5px rgba(255,255,255,0.08);
        animation: nc-pop-in 0.32s cubic-bezier(0.16, 1, 0.3, 1) both;
        transition: opacity 0.25s ease, transform 0.25s ease;
        min-width: 240px;
        max-width: 440px;
        width: auto;
        pointer-events: all;
        user-select: none;
        overflow: hidden;
      }

      @keyframes nc-pop-in {
        from { opacity: 0; transform: translateX(-50%) translateY(20px) scale(0.95); }
        to   { opacity: 1; transform: translateX(-50%) translateY(0)   scale(1);    }
      }

      #open-comet-agent-overlay.open-comet-hiding {
        opacity: 0;
        transform: translateX(-50%) translateY(12px) scale(0.96);
      }

      /* ── Left: brand mark ── */
      .nc-brand {
        width: 42px;
        height: 42px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        margin-right: 2px;
      }

      /* Spinning ring behind the logo */
      .nc-brand::before {
        content: '';
        position: absolute;
        inset: 4px;
        border-radius: 50%;
        border: 1.2px solid transparent;
        border-top-color: rgba(217, 135, 90, 0.8);
        border-right-color: rgba(217, 135, 90, 0.2);
        animation: nc-spin 1.2s linear infinite;
      }

      @keyframes nc-spin {
        to { transform: rotate(360deg); }
      }

      .nc-logo {
        width: 18px;
        height: 18px;
        flex-shrink: 0;
        position: relative;
        z-index: 1;
        filter: drop-shadow(0 0 8px rgba(217, 135, 90, 0.4));
      }

      /* ── Center: text content ── */
      .nc-content {
        flex: 1;
        min-width: 0;
        padding: 0 12px 0 6px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 1px;
      }

      .nc-label {
        font-size: 8.5px;
        font-weight: 600;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.45);
        line-height: 1;
        margin-bottom: 1px;
      }

      .nc-status {
        font-size: 13.5px;
        font-weight: 500;
        color: #ffffff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.3;
        animation: nc-fade 0.25s ease;
      }

      @keyframes nc-fade {
        from { opacity: 0.4; transform: translateY(1px); }
        to   { opacity: 1;   transform: translateY(0);   }
      }

      .nc-step {
        display: none; /* Hide step for more compact look, or keep very small */
      }

      /* ── Right: stop button ── */
      .nc-stop-wrap {
        padding-right: 4px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
      }

      #open-comet-stop-btn {
        width: 34px;
        height: 34px;
        border-radius: 50%; /* Circle button */
        background: rgba(255, 255, 255, 0.1);
        border: 0.5px solid rgba(255, 255, 255, 0.15);
        color: #ffffff;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      }

      #open-comet-stop-btn:hover {
        background: rgba(255, 255, 255, 0.18);
        border-color: rgba(255, 255, 255, 0.3);
        transform: scale(1.05);
      }

      #open-comet-stop-btn:active {
        transform: scale(0.92);
        background: rgba(255, 255, 255, 0.12);
      }

      #open-comet-stop-btn svg {
        opacity: 0.9;
      }
    `;

    overlayEl = document.createElement('div');
    overlayEl.id = 'open-comet-agent-overlay';
    overlayEl.innerHTML = `
      <div class="nc-brand">
        <div class="nc-logo">
          <img id="open-comet-brand-logo" width="22" height="22" style="display:block;border-radius:4px;" />
        </div>
      </div>
      <div class="nc-content">
        <div class="nc-label">Open Comet is working</div>
        <div class="nc-status" id="open-comet-status-text">Starting…</div>
      </div>
      <div class="nc-stop-wrap">
        <button id="open-comet-stop-btn" title="Stop agent">
          ${STOP_ICON_SVG}
        </button>
      </div>
    `;

    const head = document.head || document.documentElement;
    const body = document.body || document.documentElement;
    head.appendChild(style);
    body.appendChild(overlayEl);

    statusEl = document.getElementById('open-comet-status-text');
    setAgentTitle(true);

    // Set logos
    const brandLogo = document.getElementById('open-comet-brand-logo');
    if (brandLogo) {
      brandLogo.src = chrome.runtime.getURL('assets/icons/icon48.png');
    }

    document.getElementById('open-comet-stop-btn')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STOP_AGENT' });
      removeOverlay();
    });

    isActive = true;
  }

  // ── Remove overlay ───────────────────────────────────────────────
  function removeOverlay() {
    if (!overlayEl) return;
    overlayEl.classList.add('open-comet-hiding');
    setTimeout(() => {
      overlayEl?.remove();
      document.getElementById('open-comet-overlay-styles')?.remove();
      overlayEl = null;
      statusEl  = null;
      badgeEl   = null;
      isActive  = false;
      setAgentTitle(false);
    }, 300);
  }

  // ── Update status text + step badge ─────────────────────────────
  function updateStatus(text, step) {
    if (!overlayEl) createOverlay();
    if (statusEl) statusEl.textContent = text;
    if (badgeEl && step !== undefined) badgeEl.textContent = `step ${step}`;
  }

  // ── Tab title indicator ─────────────────────────────────────────
  function setAgentTitle(active) {
    if (active) {
      if (!document.title.startsWith('◉ ')) {
        document.title = `◉ ${originalTitle}`;
      }
    } else if (document.title.startsWith('◉ ')) {
      document.title = originalTitle;
    }
  }

  // ── Background message listener ──────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {

    if (msg.type === 'STEP_UPDATE') {
      const s = msg.step;
      if (!overlayEl && s.type !== 'stopped' && s.type !== 'done' && s.type !== 'error') {
        createOverlay();
      }
      const cleanText = (s.text || '').replace(/^[^\s]+\s/, '');
      updateStatus(cleanText, msg.stepCount || msg.allSteps?.length || 0);

      // ── SIH: Show on-page redaction visualization ──
      if (s.payload && s.payload.phase === 'sanitized' && s.payload.stats) {
        showRedactionViz(s.payload.stats, s.payload.previewDataUrl);
      }

      if (s.type === 'done' || s.type === 'stopped') {
        setTimeout(removeOverlay, 2800);
        setTimeout(removeRedactionViz, 2800);
      }
      if (s.type === 'error') {
        setTimeout(removeOverlay, 3800);
        setTimeout(removeRedactionViz, 3800);
      }
    }

    if (msg.type === 'AGENT_DONE' || msg.type === 'AGENT_STOPPED' || msg.type === 'AGENT_ERROR') {
      setTimeout(removeOverlay, 3000);
      setTimeout(removeRedactionViz, 3000);
    }

    if (msg.type === 'AGENT_STARTED') {
      createOverlay();
      updateStatus('Starting agent…', 0);
    }

    if (msg.type === 'CHAT_RESET') {
      removeOverlay();
      removeRedactionViz();
    }
  });

  // ── SIH: On-page redaction visualization overlay ─────────────────
  // Shows a small floating card in the bottom-right corner that summarises
  // what the local vision pipeline redacted on the most recent capture.
  let redactionVizEl = null;

  function showRedactionViz(stats, previewDataUrl) {
    removeRedactionViz();
    if (!stats) return;
    const c = stats.counts || {};
    const r = stats.redactionCounts || {};
    const total = (c.faces || 0) + (c.domSensitive || 0) + (c.textPii || 0);

    const el = document.createElement('div');
    el.id = 'open-comet-redaction-viz';
    el.style.cssText = [
      'position:fixed',
      'bottom:88px',
      'right:24px',
      'z-index:2147483646',
      'background:rgba(28,25,23,0.92)',
      'backdrop-filter:blur(20px)',
      'color:#fff',
      'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter",sans-serif',
      'font-size:11px',
      'padding:12px 14px',
      'border-radius:10px',
      'box-shadow:0 8px 32px rgba(0,0,0,0.3)',
      'border:0.5px solid rgba(255,255,255,0.12)',
      'max-width:260px',
      'animation:nc-pop-in 0.3s cubic-bezier(0.16,1,0.3,1)',
    ].join(';');

    const rows = Object.entries(r).map(([k, v]) =>
      `<div style="display:flex;justify-content:space-between;padding:2px 0"><span style="color:rgba(255,255,255,0.6)">${k}</span><span style="font-weight:600">${v}</span></div>`
    ).join('');

    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
        <div style="width:8px;height:8px;border-radius:50%;background:#d9875a;box-shadow:0 0 8px #d9875a"></div>
        <span style="font-weight:600;font-size:11px">Privacy pipeline</span>
        <span style="color:rgba(255,255,255,0.5);margin-left:auto">${stats.totalMs||0}ms · ${stats.backend||''}</span>
      </div>
      <div style="font-size:10px;color:rgba(255,255,255,0.6);margin-bottom:6px">
        Redacted ${total} sensitive region${total===1?'':'s'} before sending
      </div>
      ${rows || '<div style="color:rgba(255,255,255,0.5)">No sensitive regions detected</div>'}
      ${previewDataUrl ? `<img src="${previewDataUrl}" style="width:100%;margin-top:8px;border-radius:4px;border:0.5px solid rgba(255,255,255,0.15);display:block">` : ''}
    `;
    document.body.appendChild(el);
    redactionVizEl = el;

    // Auto-remove after 8 seconds if not refreshed
    setTimeout(() => { if (redactionVizEl === el) removeRedactionViz(); }, 8000);
  }

  function removeRedactionViz() {
    if (redactionVizEl) {
      redactionVizEl.remove();
      redactionVizEl = null;
    }
  }

})();

// ══════════════════════════════════════════════════════════════════════════════
// PAGE RAG — structured content parts + element registry + highlight.
// Ported from the gemma4-browser-extension content layer:
// (extractWebsiteParts.ts + elementRegistry.ts + highlightParagraph.ts)
//   • h1-h6 start a numbered section, every heading/paragraph gets a stable
//     "section-paragraph" id ("2-1") that ask_website returns to the agent.
//   • The registry lets highlight_element scroll to + flash the exact node.
// ══════════════════════════════════════════════════════════════════════════════
(() => {
  if (window.__openCometPageRag) return;   // guard against double injection
  window.__openCometPageRag = true;

  const registry = new Map();              // id → HTMLElement
  let highlightEl = null;

  function clearRegistry() {
    registry.clear();
    clearHighlight();
  }

  function clearHighlight() {
    if (highlightEl) {
      highlightEl.style.background = highlightEl.__ocPrevBg || '';
      highlightEl.style.outline = '';
      highlightEl.style.borderRadius = '';
      highlightEl.style.transition = '';
      highlightEl = null;
    }
  }

  function extractParts() {
    const root = document.body;
    if (!root) return [];
    const elements = Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6, p'));
    clearRegistry();

    const result = [];
    let sectionId = 0;
    let partId = 0;

    for (const element of elements) {
      // Skip invisible nodes and our own overlay markup.
      if (element.closest('#open-comet-overlay, .open-comet-hiding, #open-comet-redaction-viz')) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0 && !element.offsetParent) continue;

      partId += 1;
      if (/^h[1-6]$/i.test(element.tagName)) {
        sectionId += 1;
        partId = 0;
      }

      const id = `${sectionId}-${partId}`;
      registry.set(id, element);

      const content = (element.textContent || '').replace(/\s+/g, ' ').trim();
      if (!content) continue;
      const sentences = content.split(/(?<=[.!?])\s+/).filter(s => s.length > 0);

      result.push({
        id,
        tagName: element.tagName.toLowerCase(),
        content,
        sectionId,
        paragraphId: partId,
        sentences,
      });
    }
    return result;
  }

  function highlightById(id) {
    const el = registry.get(String(id || ''));
    if (!el) return { ok: false, error: `unknown id "${id}" (page may have changed — re-run ask_website)` };

    clearHighlight();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    highlightEl = el;
    el.__ocPrevBg = el.style.background || '';
    el.style.transition = 'background .25s ease';
    el.style.background = 'rgba(255, 213, 79, 0.35)';
    el.style.outline = '2px solid rgba(255, 179, 0, 0.8)';
    el.style.borderRadius = '3px';
    setTimeout(clearHighlight, 6000);
    return { ok: true, id };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'OC_EXTRACT_PAGE_PARTS') {
      try { sendResponse({ ok: true, parts: extractParts(), url: location.href }); }
      catch (e) { sendResponse({ ok: false, error: String(e?.message || e) }); }
      return;
    }

    if (msg.type === 'OC_HIGHLIGHT_PART') {
      sendResponse(highlightById(msg.id));
      return;
    }
  });
})();

