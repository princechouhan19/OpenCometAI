// src/content/dom-detector.js
// Interactive-element detection with visual tagging (boxes + numeric badges).
//
// Detection model ported from nanobrowser's buildDomTree engine (MIT):
//   - interactivity decided primarily by computed cursor style, then by
//     tag/role/contenteditable checks — catches the custom <div> widgets
//     (YouTube player controls, Gmail chips) that tag-only scans miss;
//   - elementFromPoint check so elements buried under overlays are dropped;
//   - shadow roots and same-origin iframes traversed inline;
//   - nested interactive elements collapse into their parent unless they
//     represent a distinct interaction of their own.
//
// The scan emits Open Comet element items (uid, role, text, bounds, xpath…)
// consumed by sw.js getPageInfo; the uid attribute doubles as the
// click/type relocation key. Cross-origin frames are out of scope — they
// carry an error marker and are skipped.

(() => {
  'use strict';
  if (window.__opencometDomDetector) return;
  window.__opencometDomDetector = true;

  const HIGHLIGHT_CONTAINER_ID = 'oc-dom-highlight-container';
  const UID_ATTR = 'data-opencomet-agent-uid';

  // Live uid -> element map for relocation after SPA re-renders. Registered
  // elements survive querySelector misses inside shadow roots and iframes.
  const registry = (window.__openCometElRegistry = window.__openCometElRegistry || new Map());
  const REGISTRY_LIMIT = 400;

  const BOX_COLORS = [
    '#FF0000', '#00FF00', '#0000FF', '#FFA500', '#800080', '#008080',
    '#FF69B4', '#4B0082', '#FF4500', '#2E8B57', '#DC143C', '#4682B4',
  ];

  // --- cached geometry / style reads -------------------------------------
  const cache = {
    rects: new WeakMap(),
    clientRects: new WeakMap(),
    styles: new WeakMap(),
  };

  function boundingRect(el) {
    if (!el) return null;
    if (cache.rects.has(el)) return cache.rects.get(el);
    const r = el.getBoundingClientRect();
    if (r) cache.rects.set(el, r);
    return r;
  }

  function clientRects(el) {
    if (!el) return null;
    if (cache.clientRects.has(el)) return cache.clientRects.get(el);
    const r = el.getClientRects();
    if (r) cache.clientRects.set(el, r);
    return r;
  }

  function computedStyle(el) {
    if (!el) return null;
    if (cache.styles.has(el)) return cache.styles.get(el);
    const s = window.getComputedStyle(el);
    if (s) cache.styles.set(el, s);
    return s;
  }

  // --- element predicates -------------------------------------------------

  function isElementAccepted(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') return true;
    const deny = new Set(['svg', 'script', 'style', 'link', 'meta', 'noscript', 'template']);
    return !deny.has(tag);
  }

  function isElementVisible(el) {
    const style = computedStyle(el);
    return el.offsetWidth > 0 && el.offsetHeight > 0 &&
      style?.visibility !== 'hidden' && style?.display !== 'none';
  }

  const INTERACTIVE_TAGS = new Set([
    'a', 'button', 'input', 'select', 'textarea', 'details', 'summary',
    'label', 'option', 'optgroup', 'fieldset', 'legend',
  ]);

  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'menu', 'menubar', 'menuitem', 'menuitemradio',
    'menuitemcheckbox', 'radio', 'checkbox', 'tab', 'switch', 'slider',
    'spinbutton', 'combobox', 'searchbox', 'textbox', 'listbox', 'option',
    'scrollbar',
  ]);

  const INTERACTIVE_CURSORS = new Set([
    'pointer', 'move', 'text', 'grab', 'grabbing', 'cell', 'copy', 'alias',
    'all-scroll', 'col-resize', 'context-menu', 'crosshair', 'e-resize',
    'ew-resize', 'help', 'n-resize', 'ne-resize', 'nesw-resize', 'ns-resize',
    'nw-resize', 'nwse-resize', 'row-resize', 's-resize', 'se-resize',
    'sw-resize', 'vertical-text', 'w-resize', 'zoom-in', 'zoom-out',
  ]);

  const NON_INTERACTIVE_CURSORS = new Set(['not-allowed', 'no-drop', 'wait', 'progress', 'initial', 'inherit']);

  function isInteractiveElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName.toLowerCase();
    const style = computedStyle(el);

    // A pointer cursor is the strongest single signal: sites style custom
    // widgets as plain divs but still give them a clickable cursor.
    if (tag !== 'html' && style?.cursor && INTERACTIVE_CURSORS.has(style.cursor)) return true;

    if (INTERACTIVE_TAGS.has(tag)) {
      if (style?.cursor && NON_INTERACTIVE_CURSORS.has(style.cursor)) return false;
      if (el.hasAttribute('disabled') || el.getAttribute('disabled') === 'true' || el.getAttribute('readonly') === 'true') return false;
      if (el.disabled || el.readOnly || el.inert) return false;
      return true;
    }

    if (el.getAttribute('contenteditable') === 'true' || el.isContentEditable) return true;

    if (el.classList &&
      (el.classList.contains('button') ||
        el.classList.contains('dropdown-toggle') ||
        el.getAttribute('data-toggle') === 'dropdown' ||
        el.getAttribute('aria-haspopup') === 'true')) return true;

    const role = el.getAttribute('role');
    const ariaRole = el.getAttribute('aria-role');
    if ((role && INTERACTIVE_ROLES.has(role)) || (ariaRole && INTERACTIVE_ROLES.has(ariaRole))) return true;

    // Event-attribute fallback (getEventListeners is unavailable outside DevTools).
    const mouseAttrs = ['onclick', 'onmousedown', 'onmouseup', 'ondblclick'];
    for (const attr of mouseAttrs) {
      if (el.hasAttribute(attr) || typeof el[attr] === 'function') return true;
    }
    return false;
  }

  // True when a nested interactive element acts on its own instead of just
  // bubbling to its highlighted ancestor (menu items inside menus, links
  // inside cards, …). Prevents duplicate badges over one control.
  const DISTINCT_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'details', 'label', 'option']);

  function isDistinctInteraction(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'iframe') return true;
    if (DISTINCT_TAGS.has(tag)) return true;
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return true;
    if (el.hasAttribute('data-testid') || el.hasAttribute('data-cy') || el.hasAttribute('data-test')) return true;
    if (el.hasAttribute('onclick') || typeof el.onclick === 'function') return true;
    const eventAttrs = ['onmousedown', 'onmouseup', 'onkeydown', 'onkeyup', 'onsubmit', 'onchange', 'oninput', 'onfocus', 'onblur'];
    if (eventAttrs.some(attr => el.hasAttribute(attr))) return true;
    return false;
  }

  // An element is "top" when elementFromPoint at its centre or corners
  // resolves to the element itself or one of its descendants — filters out
  // controls hidden behind modal backdrops, sticky headers and cookie bars.
  function isTopElement(el) {
    const rects = clientRects(el);
    if (!rects || rects.length === 0) return false;

    let inViewport = false;
    for (const rect of rects) {
      if (rect.width > 0 && rect.height > 0 &&
        !(rect.bottom < 0 || rect.top > window.innerHeight ||
          rect.right < 0 || rect.left > window.innerWidth)) {
        inViewport = true;
        break;
      }
    }
    if (!inViewport) return false;

    if (el.ownerDocument !== window.document) return true; // same-origin iframe content

    const shadowRoot = el.getRootNode();
    if (shadowRoot instanceof ShadowRoot) {
      const mid = rects[Math.floor(rects.length / 2)];
      try {
        const topEl = shadowRoot.elementFromPoint(mid.left + mid.width / 2, mid.top + mid.height / 2);
        if (!topEl) return false;
        let current = topEl;
        while (current && current !== shadowRoot) {
          if (current === el) return true;
          current = current.parentElement;
        }
        return false;
      } catch {
        return true;
      }
    }

    const margin = 5;
    const rect = rects[Math.floor(rects.length / 2)];
    const checkPoints = [
      { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      { x: rect.left + margin, y: rect.top + margin },
      { x: rect.right - margin, y: rect.bottom - margin },
    ];
    return checkPoints.some(({ x, y }) => {
      try {
        const topEl = document.elementFromPoint(x, y);
        if (!topEl) return false;
        let current = topEl;
        while (current && current !== document.documentElement) {
          if (current === el) return true;
          current = current.parentElement;
        }
        return false;
      } catch {
        return true;
      }
    });
  }

  function isInViewport(el) {
    const rects = el.getClientRects();
    if (!rects || rects.length === 0) {
      const br = boundingRect(el);
      if (!br || br.width === 0 || br.height === 0) return false;
      return !(br.bottom < 0 || br.top > window.innerHeight || br.right < 0 || br.left > window.innerWidth);
    }
    for (const rect of rects) {
      if (rect.width === 0 || rect.height === 0) continue;
      if (!(rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth)) {
        return true;
      }
    }
    return false;
  }

  // --- xpath --------------------------------------------------------------

  const xpathCache = new WeakMap();

  function elementPosition(el) {
    if (!el.parentElement) return 0;
    const tag = el.nodeName.toLowerCase();
    const siblings = Array.from(el.parentElement.children).filter(sib => sib.nodeName.toLowerCase() === tag);
    return siblings.length === 1 ? 0 : siblings.indexOf(el) + 1;
  }

  // Relative to the nearest boundary (shadow root or iframe), matching how
  // the element is actually reached at relocation time.
  function xpathFor(el) {
    if (xpathCache.has(el)) return xpathCache.get(el);
    const segments = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const parent = node.parentNode;
      if (parent instanceof ShadowRoot || parent instanceof HTMLIFrameElement) break;
      const position = elementPosition(node);
      const tag = node.nodeName.toLowerCase();
      segments.unshift(position > 0 ? `${tag}[${position}]` : tag);
      node = node.parentNode;
    }
    const xpath = segments.join('/');
    xpathCache.set(el, xpath);
    return xpath;
  }

  // --- agent-owned UI exclusion --------------------------------------------

  function isAgentOwned(el) {
    try {
      return !!(el && el.closest && el.closest(
        '[id^="open-comet-"], #' + HIGHLIGHT_CONTAINER_ID + ', #__opencomet_capture_overlay'
      ));
    } catch {
      return false;
    }
  }

  // --- highlight painting ---------------------------------------------------

  function paintHighlight(el, uidNumber, parentIframe) {
    if (!el) return;
    let overlays = [];
    let label = null;
    let labelW = 20;
    let labelH = 16;

    try {
      let container = document.getElementById(HIGHLIGHT_CONTAINER_ID);
      if (!container) {
        container = document.createElement('div');
        container.id = HIGHLIGHT_CONTAINER_ID;
        container.style.cssText =
          'position:fixed;pointer-events:none;top:0;left:0;width:100%;height:100%;' +
          'z-index:2147483647;background-color:transparent;';
        (document.body || document.documentElement).appendChild(container);
      }

      const rects = el.getClientRects();
      if (!rects || rects.length === 0) return;

      const baseColor = BOX_COLORS[uidNumber % BOX_COLORS.length];
      const fill = baseColor + '1A';

      // page-viewport offset for iframe content (cumulative, set at scan time)
      let iframeOffset = { x: parentIframe?.__ocOffsetX || 0, y: parentIframe?.__ocOffsetY || 0 };

      const fragment = document.createDocumentFragment();
      for (const rect of rects) {
        if (rect.width === 0 || rect.height === 0) continue;
        const overlay = document.createElement('div');
        overlay.style.cssText =
          `position:fixed;border:2px solid ${baseColor};background-color:${fill};` +
          'pointer-events:none;box-sizing:border-box;' +
          `top:${rect.top + iframeOffset.y}px;left:${rect.left + iframeOffset.x}px;` +
          `width:${rect.width}px;height:${rect.height}px;`;
        fragment.appendChild(overlay);
        overlays.push({ el: overlay, rect });
      }

      const first = rects[0];
      label = document.createElement('div');
      label.className = 'oc-dom-highlight-label';
      label.style.cssText =
        `position:fixed;background:${baseColor};color:white;padding:1px 4px;` +
        `border-radius:4px;font-size:${Math.min(12, Math.max(8, first.height / 2))}px;` +
        `font-family:Inter,Arial,sans-serif;font-weight:600;line-height:1.2;`;
      label.textContent = String(uidNumber);

      labelW = label.offsetWidth > 0 ? label.offsetWidth : labelW;
      labelH = label.offsetHeight > 0 ? label.offsetHeight : labelH;

      const fTop = first.top + iframeOffset.y;
      const fLeft = first.left + iframeOffset.x;
      let labelTop = fTop + 2;
      let labelLeft = fLeft + first.width - labelW - 2;
      if (first.width < labelW + 4 || first.height < labelH + 4) {
        labelTop = fTop - labelH - 2;
        labelLeft = fLeft + first.width - labelW;
        if (labelLeft < iframeOffset.x) labelLeft = fLeft;
      }
      labelTop = Math.max(0, Math.min(labelTop, window.innerHeight - labelH));
      labelLeft = Math.max(0, Math.min(labelLeft, window.innerWidth - labelW));
      label.style.top = `${labelTop}px`;
      label.style.left = `${labelLeft}px`;

      fragment.appendChild(label);
      container.appendChild(fragment);

      // Keep boxes glued to their elements while the page scrolls or resizes.
      // The frame offset is re-read live: scrolling a parent document moves
      // the iframe element, not the child-frame content rects.
      let last = 0;
      const reposition = () => {
        const now = performance.now();
        if (now - last < 16) return;
        last = now;
        const fresh = el.getClientRects();
        let offset = { x: 0, y: 0 };
        if (parentIframe) {
          const fr = parentIframe.getBoundingClientRect();
          offset.x = fr.left;
          offset.y = fr.top;
        }
        overlays.forEach((entry, i) => {
          if (i < fresh.length) {
            const r = fresh[i];
            entry.el.style.top = `${r.top + offset.y}px`;
            entry.el.style.left = `${r.left + offset.x}px`;
            entry.el.style.width = `${r.width}px`;
            entry.el.style.height = `${r.height}px`;
            entry.el.style.display = r.width === 0 || r.height === 0 ? 'none' : 'block';
          } else {
            entry.el.style.display = 'none';
          }
        });
        if (label && fresh.length > 0) {
          const r0 = fresh[0];
          let lt = r0.top + offset.y + 2;
          let ll = r0.left + offset.x + r0.width - labelW - 2;
          if (r0.width < labelW + 4 || r0.height < labelH + 4) {
            lt = r0.top + offset.y - labelH - 2;
            ll = r0.left + offset.x + r0.width - labelW;
            if (ll < offset.x) ll = r0.left + offset.x;
          }
          lt = Math.max(0, Math.min(lt, window.innerHeight - labelH));
          ll = Math.max(0, Math.min(ll, window.innerWidth - labelW));
          label.style.top = `${lt}px`;
          label.style.left = `${ll}px`;
          label.style.display = 'block';
        } else if (label) {
          label.style.display = 'none';
        }
      };
      window.addEventListener('scroll', reposition, true);
      window.addEventListener('resize', reposition);
      (window.__openCometBoxCleanup = window.__openCometBoxCleanup || []).push(() => {
        window.removeEventListener('scroll', reposition, true);
        window.removeEventListener('resize', reposition);
        overlays.forEach(o => o.el.remove());
        if (label) label.remove();
      });
    } catch {
      // painting is cosmetic — never fail the scan over it
    }
  }

  window.__openCometDomRemoveBoxes = function () {
    try {
      (window.__openCometBoxCleanup || []).forEach(fn => {
        try { fn(); } catch { /* already torn down */ }
      });
      window.__openCometBoxCleanup = [];
      document.getElementById(HIGHLIGHT_CONTAINER_ID)?.remove();
    } catch {
      // container may already be gone with a navigation
    }
  };

  // --- text extraction -------------------------------------------------------
  // Collects the element's own text up to the first nested highlighted
  // descendant, so a card badge shows the card text without repeating every
  // child button's text.

  function collectText(el, highlighted) {
    const parts = [];
    const walk = node => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = child.textContent?.trim();
          if (t) parts.push(t);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          if (highlighted.has(child)) continue;
          walk(child);
        }
      }
    };
    walk(el);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  // --- uid bookkeeping --------------------------------------------------------

  function collectUsedUidNumbers(root) {
    const used = new Set();
    const scanned = new Set([root]);
    const scanDoc = doc => {
      if (!doc || scanned.has(doc)) return;
      scanned.add(doc);
      for (const el of doc.querySelectorAll(`[${UID_ATTR}]`)) {
        const m = /^nx-(\d+)$/.exec(el.getAttribute(UID_ATTR) || '');
        if (m) used.add(Number(m[1]));
      }
      for (const frame of doc.querySelectorAll('iframe')) {
        try { scanDoc(frame.contentDocument); } catch { /* cross-origin */ }
      }
    };
    scanDoc(root);
    return used;
  }

  // --- main scan ----------------------------------------------------------------

  const norm = v => String(v || '').replace(/\s+/g, ' ').trim();
  const cleanCssToken = value => String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 40);

  function domPathFor(el) {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === Node.ELEMENT_NODE && depth < 4) {
      const tag = String(node.tagName || '').toLowerCase();
      if (!tag || tag === 'html') break;
      let token = tag;
      const id = cleanCssToken(node.id);
      if (id) {
        token += `#${id}`;
        parts.unshift(token);
        break;
      }
      const name = norm(node.getAttribute('name'));
      if (name) {
        token += `[name="${name.substring(0, 40).replace(/"/g, '\\"')}"]`;
      } else {
        const classNames = [...(node.classList || [])].map(cleanCssToken).filter(Boolean).slice(0, 2);
        if (classNames.length) token += `.${classNames.join('.')}`;
      }
      parts.unshift(token);
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(' > ').substring(0, 180);
  }

  function roleFor(el, tag) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = String(el.type || '').toLowerCase();
      if (type === 'search') return 'searchbox';
      if (['button', 'submit', 'checkbox', 'radio'].includes(type)) return type === 'submit' ? 'button' : type;
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'button';
  }

  const MAX_DEPTH = 100;
  let uidCounter = 0;
  let usedUidNumbers = new Set();
  const highlighted = new WeakSet();
  let items = [];
  let pending = [];
  let maxElements = 150;

  function nextUid(el) {
    const existing = el.getAttribute(UID_ATTR);
    if (existing && /^nx-\d+$/.test(existing)) return existing;
    let n = uidCounter + 1;
    while (usedUidNumbers.has(n)) n += 1;
    usedUidNumbers.add(n);
    uidCounter = n;
    const uid = `nx-${n}`;
    el.setAttribute(UID_ATTR, uid);
    return uid;
  }

  function emitItem(el, parentIframe, uid) {
    const tag = el.tagName.toLowerCase();
    const role = roleFor(el, tag);
    const ph = norm(el.placeholder || el.getAttribute('aria-label')).substring(0, 120);
    const ariaLabel = norm(el.getAttribute('aria-label')).substring(0, 120);
    const titleAttr = norm(el.getAttribute('title')).substring(0, 120);
    const href = el.href || el.closest?.('a')?.href || '';
    const rect = el.getBoundingClientRect();

    const bounds = {
      x: Math.round(rect.left + (parentIframe?.__ocOffsetX || 0)),
      y: Math.round(rect.top + (parentIframe?.__ocOffsetY || 0)),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };

    // nearest named ancestor for disambiguation ("Buy Now #2" inside which card)
    let nearHint = '';
    try {
      const form = el.closest('form');
      nearHint = norm(form?.getAttribute('aria-label') || form?.getAttribute('name') || form?.id || '');
      if (!nearHint) {
        const legend = el.closest('fieldset')?.querySelector('legend');
        nearHint = norm(legend?.textContent || '');
      }
      if (!nearHint) {
        const card = el.closest('section,article,li,td,[role="listitem"],[role="article"]');
        if (card && card !== el) {
          nearHint = norm(card.getAttribute('aria-label') || '');
          if (!nearHint) nearHint = norm(card.querySelector('h1,h2,h3,h4,h5,h6')?.textContent || '');
        }
      }
    } catch {
      nearHint = '';
    }

    const item = {
      uid,
      role,
      tag,
      type: el.type || '',
      text: '',          // filled after the full pass (see scan tail)
      placeholder: ph,
      ariaLabel,
      titleAttr,
      href,
      name: norm(el.getAttribute('name') || '').substring(0, 80),
      id: norm(el.id || '').substring(0, 80),
      className: norm(el.className || '').substring(0, 120),
      domPath: domPathFor(el),
      xpath: xpathFor(el),
      axName: '',
      editable: ['textbox', 'searchbox', 'select'].includes(role) ||
        ['input', 'textarea', 'select'].includes(tag) || el.isContentEditable,
      disabled: Boolean(el.disabled),
      inShadow: Boolean(el.getRootNode() instanceof ShadowRoot),
      bounds,
      selector: `uid:${uid}`,
      ...(nearHint ? { nearHint } : {}),
    };

    if (parentIframe) item.frame = 'iframe';

    items.push(item);
    pending.push({ item, el });

    if (registry.size >= REGISTRY_LIMIT) {
      const firstKey = registry.keys().next().value;
      registry.delete(firstKey);
    }
    registry.set(uid, el);
  }

  // duplicate-tag receipts: "2 of 4" + position + near-form context
  function annotateDuplicates() {
    try {
      const vpW = window.innerWidth;
      const vpH = window.innerHeight;
      const groups = new Map();
      for (const it of items) {
        const lbl = String(it.text || it.ariaLabel || it.placeholder || '').replace(/\s+/g, ' ').trim().toLowerCase();
        it.__dupKey = lbl ? `${it.tag}|${lbl}` : '';
        if (!it.__dupKey) continue;
        if (!groups.has(it.__dupKey)) groups.set(it.__dupKey, []);
        groups.get(it.__dupKey).push(it);
      }
      for (const members of groups.values()) {
        if (members.length < 2) continue;
        members.forEach((it, i) => {
          const b = it.bounds || {};
          const cx = (b.x || 0) + (b.w || 0) / 2;
          const cy = (b.y || 0) + (b.h || 0) / 2;
          const hz = cx < vpW / 3 ? 'left' : cx > (2 * vpW) / 3 ? 'right' : 'center';
          const vt = cy < vpH / 3 ? 'top' : cy > (2 * vpH) / 3 ? 'bottom' : 'middle';
          const disp = String(it.text || it.ariaLabel || '').replace(/\s+/g, ' ').trim();
          it.dup = `${i + 1} of ${members.length}`;
          it.pos = `${vt}-${hz}`;
          it.nearform = String(it.nearHint || '').replace(/\s+/g, ' ').trim().substring(0, 40);
          it.ref = `${disp.substring(0, 60)} #${i + 1}`;
        });
      }
      for (const it of items) {
        delete it.__dupKey;
        delete it.nearHint;
      }
    } catch {
      // disambiguation is additive
    }
  }

  function traverse(node, parentIframe, parentHighlighted, depth) {
    if (!node || depth > MAX_DEPTH) return;
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) return;
    if (node.id === HIGHLIGHT_CONTAINER_ID || isAgentOwned(node)) return;

    if (node.nodeType === Node.TEXT_NODE) return; // item text is gathered per element

    if (!isElementAccepted(node)) return;

    // cheap rejection: zero-size and clearly off-viewport (fixed/sticky kept)
    if (!node.shadowRoot) {
      const rect = boundingRect(node);
      const style = computedStyle(node);
      const fixedOrSticky = style && (style.position === 'fixed' || style.position === 'sticky');
      const hasSize = node.offsetWidth > 0 || node.offsetHeight > 0;
      if (!rect || (!fixedOrSticky && !hasSize &&
        (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth))) {
        return;
      }
    }

    let nodeHighlighted = false;
    if (isElementVisible(node)) {
      // ARIA menu containers stay interactive even when elementFromPoint
      // does not resolve to them (options render over other content)
      const role = node.getAttribute('role');
      const isMenuContainer = role === 'menu' || role === 'menubar' || role === 'listbox';
      if ((isTopElement(node) || isMenuContainer) && isInteractiveElement(node) &&
        isInViewport(node) && items.length < maxElements) {
        const distinct = !parentHighlighted || isDistinctInteraction(node);
        if (distinct) {
          const uid = nextUid(node);
          highlighted.add(node);
          emitItem(node, parentIframe, uid);
          if (paintBoxes) paintHighlight(node, Number(uid.slice(3)), parentIframe);
          nodeHighlighted = true;
        }
      }
    }

    const tag = node.tagName?.toLowerCase();
    if (tag === 'iframe') {
      const rect = boundingRect(node);
      const invisibleTracking = rect.width <= 1 && rect.height <= 1;
      const sandbox = node.getAttribute('sandbox');
      const restrictive = sandbox !== null && !sandbox.includes('allow-same-origin');
      if (invisibleTracking) return;
      if (restrictive) return;
      try {
        const frameDoc = node.contentDocument || node.contentWindow?.document;
        if (frameDoc && frameDoc.childNodes) {
          // cumulative offset converts child-frame coords to page coords
          node.__ocOffsetX = (parentIframe?.__ocOffsetX || 0) + rect.left;
          node.__ocOffsetY = (parentIframe?.__ocOffsetY || 0) + rect.top;
          for (const child of Array.from(frameDoc.childNodes)) {
            traverse(child, node, false, depth + 1);
          }
        }
      } catch {
        // cross-origin: skipped by design
      }
      return;
    }

    const childPassHighlight = nodeHighlighted || parentHighlighted;
    if (node.shadowRoot) {
      for (const child of Array.from(node.shadowRoot.childNodes)) {
        traverse(child, parentIframe, childPassHighlight, depth + 1);
      }
    }
    for (const child of Array.from(node.childNodes)) {
      traverse(child, parentIframe, childPassHighlight, depth + 1);
    }
  }

  let paintBoxes = true;

  window.__openCometDomDetect = function (options = {}) {
    const {
      paint = true,
      maxElements: cap = 150,
    } = options;

    paintBoxes = paint;
    maxElements = cap;
    items = [];
    pending = [];
    uidCounter = 0;
    usedUidNumbers = collectUsedUidNumbers(document);
    cache.rects = new WeakMap();
    cache.clientRects = new WeakMap();
    cache.styles = new WeakMap();

    if (paint) window.__openCometDomRemoveBoxes();

    if (document.body) traverse(document.body, null, false, 0);

    // Text is gathered once traversal is complete: a parent badge then stops
    // at nested highlighted descendants instead of repeating their labels.
    for (const { item, el } of pending) {
      item.text = collectText(el, highlighted).substring(0, 120);
      item.axName = (item.ariaLabel || item.titleAttr || item.text || item.placeholder || '').substring(0, 120);
    }

    annotateDuplicates();

    return {
      items,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      painted: paint && items.length > 0,
      url: location.href,
    };
  };
})();
