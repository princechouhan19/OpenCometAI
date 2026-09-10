import { getHostFromUrl, normalizeText } from './utils.js';

function getElementLabel(item = {}) {
  return normalizeText(
    item.label ||
    item.axName ||
    item.ariaLabel ||
    item.text ||
    item.placeholder ||
    item.titleAttr ||
    item.name ||
    item.id ||
    ''
  ).substring(0, 160);
}

function buildStableElementKey(item = {}) {
  const parts = [
    String(item.role || '').toLowerCase(),
    String(item.tag || '').toLowerCase(),
    String(item.type || '').toLowerCase(),
    normalizeText(item.text || '').toLowerCase(),
    normalizeText(item.placeholder || '').toLowerCase(),
    normalizeText(item.ariaLabel || '').toLowerCase(),
    normalizeText(item.name || '').toLowerCase(),
    String(item.href || '').trim().toLowerCase().substring(0, 180),
    normalizeText(item.domPath || '').toLowerCase(),
  ].filter(Boolean);

  return parts.join('|').substring(0, 420);
}

function buildMatchText(item = {}) {
  return normalizeText([
    item.text,
    item.axName,
    item.ariaLabel,
    item.placeholder,
    item.titleAttr,
    item.name,
    item.id,
    item.href,
  ].filter(Boolean).join(' ')).substring(0, 220);
}

function remapSubset(list = [], enrichedByUid = new Map()) {
  return list
    .map(item => enrichedByUid.get(String(item?.uid || '').replace(/^uid:/, '')) || enrichedByUid.get(String(item?.uid || '')) || null)
    .filter(Boolean);
}

function buildScreenshotAnchors(interactiveElements = []) {
  return interactiveElements
    .filter(item => item?.bounds && item.bounds.w > 0 && item.bounds.h > 0)
    .slice(0, 24)
    .map(item => ({
      badge: Number(item.index || 0),
      uid: item.uid,
      selector: item.selector || `uid:${item.uid}`,
      label: item.label || item.text || '',
      role: item.role || '',
      domPath: item.domPath || '',
      center: {
        x: Math.round((item.bounds.x || 0) + ((item.bounds.w || 0) / 2)),
        y: Math.round((item.bounds.y || 0) + ((item.bounds.h || 0) / 2)),
      },
      bounds: item.bounds,
      isNew: Boolean(item.isNew),
    }));
}

export function enrichCapturedPageInfo(pageInfo = {}, previousPageInfo = null) {
  const previousItems = previousPageInfo?.interactiveElements || [];
  const samePage = Boolean(previousPageInfo?.url) && previousPageInfo.url === pageInfo.url;
  const previousStableKeys = new Set(previousItems.map(item => item?.stableKey || buildStableElementKey(item)).filter(Boolean));

  let newInteractiveCount = 0;
  const enrichedByUid = new Map();
  const interactiveElements = (pageInfo.interactiveElements || []).map((item, index) => {
    const uid = String(item?.uid || `nx-${index + 1}`).replace(/^uid:/, '');
    const label = getElementLabel(item);
    const stableKey = buildStableElementKey(item);
    const isNew = samePage && Boolean(stableKey) && !previousStableKeys.has(stableKey);
    if (isNew) newInteractiveCount++;

    const enriched = {
      ...item,
      uid,
      selector: item?.selector || `uid:${uid}`,
      index: index + 1,
      label,
      axName: normalizeText(item?.axName || item?.ariaLabel || item?.titleAttr || label).substring(0, 160),
      stableKey,
      matchText: buildMatchText(item),
      linkHost: getHostFromUrl(item?.href || ''),
      isNew,
    };
    enrichedByUid.set(uid, enriched);
    return enriched;
  });

  const selectorMap = Object.fromEntries(
    interactiveElements.map(item => [
      item.uid,
      {
        selector: item.selector,
        role: item.role || '',
        text: item.text || '',
        axName: item.axName || '',
        stableKey: item.stableKey || '',
        domPath: item.domPath || '',
        bounds: item.bounds || null,
        isNew: Boolean(item.isNew),
      },
    ])
  );

  const screenshotAnchors = buildScreenshotAnchors(interactiveElements);

  return {
    ...pageInfo,
    interactiveElements,
    clickables: remapSubset(pageInfo.clickables || [], enrichedByUid),
    inputs: (pageInfo.inputs || []).map(input => {
      const uid = String(input?.uid || input?.selector || '').replace(/^uid:/, '');
      const enriched = enrichedByUid.get(uid);
      return enriched ? { ...input, ...enriched } : input;
    }),
    links: (pageInfo.links || []).map(link => {
      const uid = String(link?.uid || link?.selector || '').replace(/^uid:/, '');
      const enriched = enrichedByUid.get(uid);
      return enriched ? { ...link, ...enriched } : link;
    }),
    selectorMap,
    screenshotAnchors,
    pageInsights: {
      samePageAsPrevious: samePage,
      newInteractiveCount,
      interactiveCount: interactiveElements.length,
      screenshotAnchorCount: screenshotAnchors.length,
    },
  };
}

export function getScreenshotOverlayItems(pageInfo = {}) {
  return (pageInfo.interactiveElements || [])
    .slice(0, 48)
    .filter(item => item?.bounds && item.bounds.w > 0 && item.bounds.h > 0)
    .map(item => ({
      uid: item.uid,
      bounds: item.bounds,
      editable: Boolean(item.editable),
      isNew: Boolean(item.isNew),
    }));
}

export function getLoopPageSignature(pageInfo = {}) {
  return JSON.stringify({
    url: pageInfo.url || '',
    percent: pageInfo.scrollState?.percent ?? null,
    items: (pageInfo.interactiveElements || [])
      .slice(0, 12)
      .map(item => `${item.stableKey || item.selector || ''}|${item.label || item.text || ''}|${item.isNew ? 'new' : 'seen'}`),
  });
}
