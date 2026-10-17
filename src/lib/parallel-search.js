// Dependency-free Streamable HTTP MCP client for the optional research provider.
const ENDPOINT = 'https://search.parallel.ai/mcp';
const PROTOCOL = '2025-03-26';
const HEADER_RULE_ID = 194019;

/** Identify only this extension's requests to the Parallel MCP endpoint. */
async function prepareHeaders() {
  const allowed = await chrome.permissions.contains({ origins: ['https://search.parallel.ai/*'] });
  if (!allowed) throw new Error('Allow access to search.parallel.ai in the extension site permissions to use Parallel.');
  const version = chrome.runtime.getManifest().version;
  const userAgent = `OpenCometAI/${version} (https://github.com/princechouhan19/OpenCometAI)`;
  if (!chrome.declarativeNetRequest?.updateSessionRules) {
    throw new Error('Parallel search requires a browser with declarativeNetRequest support.');
  }
  // Chromium drops User-Agent supplied to fetch. A session rule sets the actual
  // wire header, scoped to our extension and this one endpoint (no page traffic).
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [HEADER_RULE_ID],
    addRules: [{
      id: HEADER_RULE_ID,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'User-Agent', operation: 'set', value: userAgent }] },
      condition: {
        regexFilter: '^https://search[.]parallel[.]ai/mcp$',
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ['xmlhttprequest'],
      },
    }],
  });
  return { version, userAgent };
}

/** Read JSON or an SSE response's matching JSON-RPC result. */
async function readReply(response, id) {
  const text = await response.text();
  if (text.length > 1000000) throw new Error('Parallel returned an oversized MCP response.');
  let messages;
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    messages = text.replace(/\r\n/g, '\n').split('\n\n').flatMap(event => {
      const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      return data ? [JSON.parse(data)] : [];
    });
  } else {
    messages = [JSON.parse(text)];
  }
  const reply = messages.find(message => message.jsonrpc === '2.0' && message.id === id);
  if (!reply || reply.error || !('result' in reply)) throw new Error('Parallel returned an unsuccessful MCP response.');
  return reply.result;
}

/** Search anonymously; only the explicitly selected research query leaves the browser. */
export async function searchParallel(query, { signal, timeoutMs = 30000, maxResults = 12, sessionId, modelName } = {}) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Parallel search timed out.', 'TimeoutError')), timeoutMs);
  let session;
  let headers;
  try {
    const { version, userAgent } = await prepareHeaders();
    controller.signal.throwIfAborted();
    headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'User-Agent': userAgent };
    let nextId = 0;
    /** Perform one bounded MCP request without redirects or credentials. */
    const rpc = async (method, params, notification = false) => {
      const id = notification ? undefined : ++nextId;
      const response = await fetch(ENDPOINT, {
        method: 'POST', headers, credentials: 'omit', redirect: 'error', signal: controller.signal,
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
      });
      if (response.status === 429) throw new Error('Parallel search is temporarily rate limited. Try again later.');
      if (!response.ok) throw new Error(`Parallel search failed (HTTP ${response.status}).`);
      if (method === 'initialize') {
        session = response.headers.get('mcp-session-id');
        if (session) headers['Mcp-Session-Id'] = session;
      }
      if (notification) { await response.body?.cancel(); return; }
      return readReply(response, id);
    };
    const initialized = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'OpenCometAI', version } });
    if (initialized.protocolVersion !== PROTOCOL) throw new Error('Parallel negotiated an unsupported MCP protocol.');
    headers['MCP-Protocol-Version'] = PROTOCOL;
    await rpc('notifications/initialized', {}, true);
    const discovery = await rpc('tools/list', {});
    if (!discovery.tools?.some(tool => tool.name === 'web_search')) throw new Error('Parallel MCP does not expose web_search.');
    const result = await rpc('tools/call', {
      name: 'web_search', arguments: {
        objective: query, search_queries: [query], session_id: sessionId || crypto.randomUUID(),
        ...(modelName ? { model_name: modelName } : {}),
      },
    });
    if (result.isError) throw new Error('Parallel web search could not complete. Try again later.');
    const data = result.structuredContent || JSON.parse(result.content?.find(part => part.type === 'text')?.text || 'null');
    if (!Array.isArray(data?.results)) throw new Error('Parallel returned invalid search results.');
    return data.results.flatMap(item => {
      try {
        const url = new URL(item.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
        return [{ url: url.href, title: String(item.title || url.hostname), host: url.hostname.replace(/^www\./, ''), snippet: (item.excerpts || []).map(String).join('\n').slice(0, 1200) }];
      } catch { return []; }
    }).slice(0, Math.max(1, Math.min(24, maxResults)));
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (session && headers) {
      // Session cleanup must not extend a cancelled search or hide its outcome.
      fetch(ENDPOINT, { method: 'DELETE', headers, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(2000) })
        .then(response => response.body?.cancel()).catch(() => {});
    }
  }
}
