// ─────────────────────────────────────────────────────────────────────────────
// OpenCometBench/e2e/mock-vlm.mjs — SIH v1.13 E2E mock decision server.
//
// Implements the REAL /agent/decide contract the extension talks to (multipart
// form with image / sanitizedText / manifest / history / settings / task +
// privacyVerification), but returns SCRIPTED decisions instead of calling a
// real VLM. This measures the true capture → perception → sanitize → network
// gate → server validation → action → verification loop end-to-end; only the
// model's "thinking" is mocked. The report labels every VLM number accordingly.
// ─────────────────────────────────────────────────────────────────────────────
import { createServer } from 'node:http';

/**
 * Scripted decision policy: decide from the task text + the number of prior
 * steps (history arrives as a JSON array in the multipart form).
 */
function decide(task, historyLen) {
  const t = String(task || '').toLowerCase();
  const done = { thought: 'task verified complete', action: { type: 'done' }, confidence: 0.95, is_complete: true };

  if (t.includes('pricing')) {
    if (historyLen === 0) return { thought: 'click the pricing link', action: { type: 'click', selector: '#link-pricing' }, confidence: 0.9 };
    return done;
  }
  if (t.includes('quantum')) {
    if (historyLen === 0) return { thought: 'type the query', action: { type: 'type', selector: '#search-box', text: 'quantum' }, confidence: 0.9 };
    if (historyLen === 1) return { thought: 'submit the search', action: { type: 'click', selector: '#search-btn' }, confidence: 0.9 };
    return done;
  }
  if (t.includes('newsletter form')) {
    if (historyLen === 0) return { thought: 'focus name', action: { type: 'type', selector: '#f-name', text: 'Demo User' }, confidence: 0.9 };
    if (historyLen === 1) return { thought: 'fill email', action: { type: 'type', selector: '#f-email', text: 'demo.user@example.com' }, confidence: 0.9 };
    if (historyLen === 2) return { thought: 'submit', action: { type: 'click', selector: '#f-submit' }, confidence: 0.9 };
    return done;
  }
  if (t.includes('mute the video')) {
    // v1.14: "mute" is DETERMINISTIC — the muted flag never auto-changes (the
    // paused flag does: headless Chromium auto-plays muted MediaStream videos,
    // measured 3×). before muted=false → media mute → after muted=true is a
    // real, environment-independent transition the verifier can confirm.
    if (historyLen === 0) return { thought: 'mute playback via the media action', action: { type: 'media', command: 'mute' }, confidence: 0.9 };
    return done;
  }
  if (t.includes('checkout form')) {
    if (historyLen === 0) return { thought: 'name', action: { type: 'type', selector: '#c-name', text: 'Demo User' }, confidence: 0.9 };
    if (historyLen === 1) return { thought: 'address', action: { type: 'type', selector: '#c-addr', text: '221B Baker Street' }, confidence: 0.9 };
    if (historyLen === 2) return { thought: 'submit order', action: { type: 'click', selector: '#c-submit' }, confidence: 0.9 };
    return done;
  }
  // ── v1.14 expanded scenarios (8–10) ────────────────────────────────────────
  if (t.includes('transfer funds')) {
    if (historyLen === 0) return { thought: 'enter the transfer amount', action: { type: 'type', selector: '#b-amount', text: '2500' }, confidence: 0.9 };
    if (historyLen === 1) return { thought: 'confirm the transfer', action: { type: 'click', selector: '#b-transfer' }, confidence: 0.9 };
    return done;
  }
  if (t.includes('scheme application')) {
    if (historyLen === 0) return { thought: 'applicant name', action: { type: 'type', selector: '#g-name', text: 'Demo User' }, confidence: 0.9 };
    if (historyLen === 1) return { thought: 'application id', action: { type: 'type', selector: '#g-id', text: '2345 6789 0123' }, confidence: 0.9 };
    if (historyLen === 2) return { thought: 'submit the application', action: { type: 'click', selector: '#g-submit' }, confidence: 0.9 };
    return done;
  }
  if (t.includes('clear the drawing canvas') || t.includes('clear the canvas')) {
    if (historyLen === 0) return { thought: 'press the clear-canvas control', action: { type: 'click', selector: '#cv-clear' }, confidence: 0.9 };
    return done;
  }
  if (t.includes('full article')) {
    if (historyLen === 0) return { thought: 'open the article', action: { type: 'click', selector: '#a-link' }, confidence: 0.9 };
    return done;
  }
  if (t.includes('save the new contact')) {
    if (historyLen === 0) return { thought: 'contact name', action: { type: 'type', selector: '#p-name', text: 'Demo User' }, confidence: 0.9 };
    if (historyLen === 1) return { thought: 'contact email', action: { type: 'type', selector: '#p-email', text: 'demo.user@example.com' }, confidence: 0.9 };
    if (historyLen === 2) return { thought: 'contact phone', action: { type: 'type', selector: '#p-phone', text: '+1 415 555 0132' }, confidence: 0.9 };
    if (historyLen === 3) return { thought: 'save the contact', action: { type: 'click', selector: '#p-save' }, confidence: 0.9 };
    return done;
  }
  return done;
}

// Minimal multipart/form-data parser (enough for the extension's decide call:
// text fields + one image file). No external dependencies.
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const ctype = String(req.headers['content-type'] || '');
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
    if (!m) return reject(new Error('no multipart boundary'));
    const boundary = Buffer.from('--' + (m[1] || m[2]));
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks);
        const fields = {};
        let imageBytes = 0;
        let pos = body.indexOf(boundary);
        while (pos !== -1) {
          const partStart = pos + boundary.length;
          if (body.slice(partStart, partStart + 2).toString() === '--') break;
          const headEnd = body.indexOf(Buffer.from('\r\n\r\n'), partStart);
          if (headEnd === -1) break;
          const next = body.indexOf(boundary, headEnd);
          const partBody = body.slice(headEnd + 4, next - 2);   // strip CRLF
          const head = body.slice(partStart, headEnd).toString();
          const nameM = /name="([^"]+)"/i.exec(head);
          const isFile = /filename="/i.test(head);
          if (nameM) {
            if (isFile) imageBytes = partBody.length;
            else fields[nameM[1]] = partBody.toString('utf8');
          }
          pos = next;
        }
        resolve({ fields, imageBytes });
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export function startMockVlm(port = 8892) {
  const calls = [];
  const srv = createServer((req, res) => {
    (async () => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mock: 'vlm' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/agent/decide') {
        const t0 = Date.now();
        let fields, imageBytes = 0;
        try { ({ fields, imageBytes } = await parseMultipart(req)); } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `bad multipart: ${e.message}` }));
          return;
        }
        const task = String(fields.task || '');
        let history = [];
        try { history = JSON.parse(String(fields.history || '[]')); } catch { /* keep [] */ }
        const pv = String(fields.privacyVerification || '');
        // Enforce the same fail-closed rule the real server enforces.
        let pvOk = false;
        try { const pvj = JSON.parse(pv); pvOk = pvj?.enforced === true && pvj?.passed === true; } catch { /* no envelope */ }
        if (!pvOk) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing/failed privacyVerification envelope' }));
          return;
        }
        const decision = decide(task, history.length);
        calls.push({ task, step: history.length, imageBytes, ms: Date.now() - t0 });
        // A little model latency so P50/P95 numbers are non-zero but fast.
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            backend: 'mock-vlm (scripted)',
            latencyMs: Date.now() - t0,
            actionPlan: decision,
            manifestSummary: { regions: 0, byType: {} },
          }));
        }, 25);
        return;
      }
      res.writeHead(404); res.end();
    })().catch((e) => { try { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); } catch { /* closed */ } });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({
    server: srv,
    url: `http://127.0.0.1:${port}`,
    calls,
  })));
}
