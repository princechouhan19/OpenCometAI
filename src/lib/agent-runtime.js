import { getHostFromUrl } from './utils.js';

export const AGENT_ROLE = {
  PLANNER: 'planner',
  NAVIGATOR: 'navigator',
  EXTRACTOR: 'extractor',
  VERIFIER: 'verifier',
  SYNTHESIZER: 'synthesizer',
};

export const AGENT_HOOK = {
  BEFORE_NAVIGATE: 'before_navigate',
  BEFORE_CLICK: 'before_click',
  AFTER_SCRAPE: 'after_scrape',
  BEFORE_EXPORT: 'before_export',
};

export function getContextMode(pageInfo = {}, settings = {}, options = {}) {
  const provider = String(settings.provider || '').toLowerCase();
  const role = String(options.role || AGENT_ROLE.NAVIGATOR);
  const host = getHostFromUrl(pageInfo.url || '');
  const textLength = String(pageInfo.readableText || pageInfo.text || '').length;
  const interactiveCount = (pageInfo.interactiveElements || []).length;
  const tabCount = (pageInfo.openTabs || []).length;
  const heavyHost = /(youtube|amazon|flipkart|reddit|news|medium|linkedin|x\.com|twitter|google)/.test(host);

  if (options.forceMinimal) return 'minimal';

  // Feature: Ollama Context Window Awareness
  // Small local models (≤ ~4B params) typically have 4K-8K context windows.
  // Force minimal mode to prevent silent truncation that corrupts JSON output.
  if (provider === 'ollama') {
    const textModel = String(settings.ollamaTextModel || settings.model || '').toLowerCase();
    const visionModel = String(settings.ollamaVisionModel || '').toLowerCase();
    const activeModel = textModel || visionModel;
    if (isSmallContextOllamaModel(activeModel)) {
      return 'minimal';
    }
  }

  if (provider === 'mistral') return heavyHost || textLength > 4000 || interactiveCount > 30 ? 'minimal' : 'compact';
  if (role === AGENT_ROLE.SYNTHESIZER || role === AGENT_ROLE.EXTRACTOR) {
    return textLength > 7000 || heavyHost ? 'compact' : 'normal';
  }
  if (heavyHost || interactiveCount > 45 || textLength > 8000 || tabCount > 8 || options.taskProfile === 'deep_research') {
    return 'compact';
  }
  return 'normal';
}

/**
 * Returns true for Ollama models known to have limited context windows (≤ 8K).
 * Pattern: model name contains a parameter count ≤ 4B, or is a known small model.
 */
function isSmallContextOllamaModel(modelName) {
  if (!modelName) return false;
  const lower = String(modelName).toLowerCase();

  // Explicit small-model identifiers
  const SMALL_MODELS = [
    'llama3.2:1b', 'llama3.2:3b',
    'phi3:mini', 'phi3.5:mini', 'phi4-mini',
    'gemma2:2b', 'gemma3:1b', 'gemma3:4b',
    'qwen2.5:0.5b', 'qwen2.5:1.5b', 'qwen2.5:3b',
    'smollm', 'tinyllama', 'moondream',
    'deepseek-r1:1.5b', 'deepseek-r1:7b',
  ];
  if (SMALL_MODELS.some(m => lower.includes(m))) return true;

  // Pattern match: "modelname:Nb" where N ≤ 4
  const sizeMatch = lower.match(/:(\d+(\.\d+)?)b/);
  if (sizeMatch) {
    const params = parseFloat(sizeMatch[1]);
    if (params <= 4) return true;
  }

  return false;
}

export function compactPageContext(pageInfo = {}, settings = {}, options = {}) {
  const mode = getContextMode(pageInfo, settings, options);
  if (mode === 'normal') return pageInfo;

  const minimal = mode === 'minimal';
  const pickInteractive = item => ({
    uid: item?.uid || '',
    role: item?.role || '',
    tag: item?.tag || '',
    type: item?.type || '',
    text: String(item?.text || '').substring(0, minimal ? 42 : 80),
    label: String(item?.label || item?.axName || item?.text || '').substring(0, minimal ? 48 : 100),
    axName: String(item?.axName || item?.ariaLabel || item?.text || '').substring(0, minimal ? 48 : 100),
    placeholder: String(item?.placeholder || '').substring(0, minimal ? 42 : 80),
    href: minimal ? '' : String(item?.href || '').substring(0, 120),
    editable: Boolean(item?.editable),
    disabled: Boolean(item?.disabled),
    bounds: minimal ? null : item?.bounds || null,
    selector: item?.selector || '',
    domPath: minimal ? '' : String(item?.domPath || '').substring(0, 160),
    stableKey: String(item?.stableKey || '').substring(0, minimal ? 80 : 220),
    isNew: Boolean(item?.isNew),
  });

  return {
    ...pageInfo,
    text: String(pageInfo.text || '').substring(0, minimal ? 700 : 1800),
    readableText: String(pageInfo.readableText || pageInfo.text || '').substring(0, minimal ? 2200 : 5200),
    headings: (pageInfo.headings || []).slice(0, minimal ? 8 : 16),
    tables: (pageInfo.tables || []).slice(0, minimal ? 1 : 2),
    links: (pageInfo.links || []).slice(0, minimal ? 4 : 10).map(link => ({
      text: String(link?.text || '').substring(0, 60),
      href: String(link?.href || '').substring(0, 120),
      selector: link?.selector || '',
    })),
    inputs: (pageInfo.inputs || []).slice(0, minimal ? 6 : 10).map(input => ({
      type: input?.type || '',
      name: String(input?.name || '').substring(0, minimal ? 42 : 80),
      selector: input?.selector || '',
    })),
    clickables: (pageInfo.clickables || []).slice(0, minimal ? 10 : 18).map(pickInteractive),
    interactiveElements: (pageInfo.interactiveElements || []).slice(0, minimal ? 18 : 32).map(pickInteractive),
    screenshotAnchors: (pageInfo.screenshotAnchors || []).slice(0, minimal ? 10 : 18).map(anchor => ({
      badge: anchor?.badge ?? null,
      uid: anchor?.uid || '',
      selector: anchor?.selector || '',
      label: String(anchor?.label || '').substring(0, minimal ? 48 : 90),
      role: anchor?.role || '',
      center: minimal ? null : anchor?.center || null,
      isNew: Boolean(anchor?.isNew),
    })),
    selectorMap: Object.fromEntries(
      Object.entries(pageInfo.selectorMap || {})
        .slice(0, minimal ? 12 : 20)
        .map(([uid, meta]) => [
          uid,
          {
            selector: meta?.selector || '',
            role: meta?.role || '',
            text: String(meta?.text || '').substring(0, minimal ? 42 : 80),
            axName: String(meta?.axName || '').substring(0, minimal ? 42 : 80),
            domPath: minimal ? '' : String(meta?.domPath || '').substring(0, 120),
            isNew: Boolean(meta?.isNew),
          },
        ])
    ),
    pageInsights: {
      ...(pageInfo.pageInsights || {}),
    },
    openTabs: (pageInfo.openTabs || []).slice(0, minimal ? 4 : 8).map(tab => ({
      title: String(tab?.title || '').substring(0, minimal ? 44 : 80),
      url: String(tab?.url || '').substring(0, minimal ? 80 : 160),
      host: tab?.host || '',
      active: Boolean(tab?.active),
    })),
  };
}

export function shouldVerifyAction(action = {}) {
  return ['navigate', 'new_tab', 'click', 'search', 'type', 'fill', 'submit'].includes(action.type);
}

export function getCheckpointForAction(action = {}) {
  if (['navigate', 'new_tab'].includes(action.type)) return AGENT_HOOK.BEFORE_NAVIGATE;
  if (action.type === 'click') return AGENT_HOOK.BEFORE_CLICK;
  return null;
}

export function describeCheckpoint(name, context = {}) {
  switch (name) {
    case AGENT_HOOK.BEFORE_NAVIGATE:
      return `Hook: checking navigation target ${String(context?.action?.url || '').substring(0, 120)}`;
    case AGENT_HOOK.BEFORE_CLICK:
      return `Hook: rechecking click target ${context?.action?.selector || context?.action?.text || ''}`;
    case AGENT_HOOK.AFTER_SCRAPE:
      return `Hook: validating scraped dataset from ${context?.page?.title || context?.page?.url || 'page'}`;
    case AGENT_HOOK.BEFORE_EXPORT:
      return `Hook: preparing export as ${(context?.formats || []).join(', ') || context?.format || 'json'}`;
    default:
      return 'Hook checkpoint';
  }
}

export function verifyActionAgainstPage(action = {}, pageInfo = {}) {
  if (!shouldVerifyAction(action)) return { ok: true, action, pageInfo };
  if (['navigate', 'new_tab'].includes(action.type)) {
    const url = String(action.url || '').trim();
    return url ? { ok: true, action, pageInfo } : { ok: false, reason: 'Navigation target is missing.' };
  }
  if (action.type === 'search') {
    const searchMatch = findSearchCandidate(pageInfo);
    return searchMatch
      ? { ok: true, action, pageInfo, matchedElement: searchMatch }
      : { ok: false, reason: 'Verifier could not find a search input on the fresh page state.' };
  }
  if (action.type === 'submit') {
    const editable = (pageInfo.inputs || [])[0];
    return editable
      ? { ok: true, action, pageInfo, matchedElement: editable }
      : { ok: false, reason: 'Verifier could not find a form or editable field before submit.' };
  }

  const matchedElement = findInteractiveMatch(action, pageInfo);
  if (!matchedElement) {
    return { ok: false, reason: `Verifier could not match ${action.type} target on the fresh page state.` };
  }

  const normalizedAction = { ...action };
  if (matchedElement.selector && ['click', 'type', 'fill'].includes(action.type)) {
    normalizedAction.selector = matchedElement.selector;
  }
  return { ok: true, action: normalizedAction, pageInfo, matchedElement };
}

function findInteractiveMatch(action, pageInfo) {
  const selector = String(action.selector || '').trim();
  const uid = String(action.uid || selector).replace(/^uid:/, '').trim();
  const exactText = String(action.text || selector.replace(/^text:/, '')).trim().toLowerCase();
  const elements = pageInfo.interactiveElements || [];

  if (uid) {
    const direct = elements.find(item => item?.uid === uid || item?.selector === `uid:${uid}`);
    if (direct) return direct;
  }
  if (selector) {
    const direct = elements.find(item => item?.selector === selector);
    if (direct) return direct;
  }
  if (exactText) {
    const byText = elements.find(item => String(item?.text || '').trim().toLowerCase() === exactText);
    if (byText) return byText;
    const byLabel = elements.find(item => String(item?.label || item?.axName || '').trim().toLowerCase() === exactText);
    if (byLabel) return byLabel;
    const byPlaceholder = elements.find(item => String(item?.placeholder || '').trim().toLowerCase().includes(exactText));
    if (byPlaceholder) return byPlaceholder;

    const normalizedTarget = normalizeMatchText(exactText);
    const scored = elements
      .map(item => ({
        item,
        score: scoreInteractiveMatch(normalizedTarget, item),
      }))
      .filter(entry => entry.score > 0);

    scored.sort((a, b) => b.score - a.score);
    if (scored[0]?.score >= 0.34) return scored[0].item;

    const host = getHostFromUrl(pageInfo.url || '');
    if (host.includes('youtube.com')) {
      const firstVideo = elements.find(item => {
        const href = String(item?.href || '');
        return href.includes('/watch') && !item?.disabled;
      });
      if (firstVideo) return firstVideo;
    }
  }
  return null;
}

function normalizeMatchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^text:/, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreInteractiveMatch(target, item) {
  const text = normalizeMatchText(item?.text || '');
  const label = normalizeMatchText(item?.label || '');
  const axName = normalizeMatchText(item?.axName || '');
  const placeholder = normalizeMatchText(item?.placeholder || '');
  const href = normalizeMatchText(item?.href || '');
  const domPath = normalizeMatchText(item?.domPath || '');
  const role = String(item?.role || '').toLowerCase();
  const tag = String(item?.tag || '').toLowerCase();

  if (!target) return 0;
  if (text && (text.includes(target) || target.includes(text))) {
    return boostForClickable(item, ratioScore(target, text) + 0.32);
  }
  if (label && (label.includes(target) || target.includes(label))) {
    return boostForClickable(item, ratioScore(target, label) + 0.28);
  }
  if (axName && (axName.includes(target) || target.includes(axName))) {
    return boostForClickable(item, ratioScore(target, axName) + 0.24);
  }
  if (placeholder && placeholder.includes(target)) {
    return boostForClickable(item, ratioScore(target, placeholder) + 0.18);
  }

  const targetTokens = tokenSet(target);
  if (!targetTokens.size) return 0;

  const textOverlap = overlapScore(targetTokens, tokenSet(text));
  const labelOverlap = overlapScore(targetTokens, tokenSet(label));
  const axNameOverlap = overlapScore(targetTokens, tokenSet(axName));
  const hrefOverlap = overlapScore(targetTokens, tokenSet(href));
  const domPathOverlap = overlapScore(targetTokens, tokenSet(domPath));
  let score = Math.max(textOverlap, labelOverlap * 0.92, axNameOverlap * 0.86, hrefOverlap * 0.75, domPathOverlap * 0.45);

  if (role === 'link' || tag === 'a') score += 0.08;
  if (role === 'button' || tag === 'button') score += 0.03;
  if (item?.isNew) score += 0.02;
  if (item?.disabled) score -= 0.2;
  return boostForClickable(item, score);
}

function boostForClickable(item, score) {
  const bounds = item?.bounds || {};
  const area = Number(bounds.w || 0) * Number(bounds.h || 0);
  if (area > 1000 && area < 200000) return score + 0.03;
  return score;
}

function tokenSet(value) {
  return new Set(String(value || '').split(' ').map(part => part.trim()).filter(Boolean));
}

function overlapScore(a, b) {
  if (!a.size || !b.size) return 0;
  let hits = 0;
  for (const token of a) {
    if (b.has(token)) hits++;
  }
  return hits / Math.max(a.size, 1);
}

function ratioScore(a, b) {
  const aLen = String(a || '').length;
  const bLen = String(b || '').length;
  if (!aLen || !bLen) return 0;
  return Math.min(aLen, bLen) / Math.max(aLen, bLen);
}

function findSearchCandidate(pageInfo) {
  const candidates = pageInfo.interactiveElements || [];
  return candidates.find(item => {
    const haystack = [
      item?.text,
      item?.label,
      item?.axName,
      item?.placeholder,
      item?.role,
      item?.tag,
      item?.type,
      item?.name,
      item?.id,
      item?.className,
    ].filter(Boolean).join(' ').toLowerCase();
    const isSearchLabel = ['search', 'find', 'query', 'lookup'].some(term => haystack.includes(term)) ||
                         /\b(qs?|search-input|search-field)\b/.test(haystack);
    if (!isSearchLabel) return false;

    // Primary: editable inputs
    if (Boolean(item?.editable)) return true;

    // Secondary: buttons or links that act as search triggers
    if (['button', 'link'].includes(item?.role)) return true;

    return false;
  }) || (pageInfo.inputs || []).find(input => {
    const label = String(input?.name || '').toLowerCase();
    return /search|find|query/i.test(label) || /\bqs?\b/.test(label);
  }) || null;
}
