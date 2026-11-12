// src/lib/goal-probe.js
//
// Self-contained on purpose: chrome.scripting.executeScript serialises this
// function into the page, so it may not reference anything outside its body.
// It reads document/location from the page it is injected into, and the tests
// install a fake document to exercise the same source Chrome runs.

export function pageProbe(selectors) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const counts = {};
  const texts = {};

  for (const sel of selectors || []) {
    try {
      const nodes = document.querySelectorAll(sel);
      counts[sel] = nodes.length;
      texts[sel] = nodes.length
        ? norm(nodes[0].innerText || nodes[0].textContent || '').slice(0, 500)
        : '';
    } catch {
      // An invalid selector is a property of the declared contract, not of the
      // page. Report zero so the check reads as failed, never as satisfied.
      counts[sel] = 0;
      texts[sel] = '';
    }
  }

  return {
    url: location.href,
    title: document.title,
    text: norm(document.body?.innerText || '').slice(0, 20000),
    counts,
    texts,
  };
}
