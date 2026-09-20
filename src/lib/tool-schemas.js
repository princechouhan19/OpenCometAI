// src/lib/tool-schemas.js
// WebMCP-style tool declarations for the agent's native actions — the single
// source of truth used BOTH for:
//   • native chat-template tool calling (apply_chat_template tools=[…] in the
//     offscreen engine — Gemma 4 / Granite 4 emit <​|tool_call> blocks), and
//   • prompt-side documentation (prompts.js renders a compact catalogue from
//     these schemas so cloud providers see the same contract).
// Shape mirrors the gemma4-browser-extension WebMCPTool interface:
//   { name, description, inputSchema: { type:'object', properties, required } }

export const AGENT_TOOL_SCHEMAS = [
  {
    name: 'navigate',
    description: 'Navigate the active tab to a URL.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute URL to open' } },
      required: ['url'],
    },
  },
  {
    name: 'search',
    description: 'Run a web search in the active tab (never click into a search box manually).',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search terms' } },
      required: ['query'],
    },
  },
  {
    name: 'click',
    description: 'Click a page element. Prefer uid selectors from INTERACTIVE ELEMENTS.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'uid:nx-N | text:Label | #id | [name=x] | css' },
        x: { type: 'number', description: 'Optional viewport x (screenshot anchors only)' },
        y: { type: 'number', description: 'Optional viewport y (screenshot anchors only)' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'type',
    description: 'Type text into an input element.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Element selector' },
        text: { type: 'string', description: 'Text to enter' },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'submit',
    description: 'Submit a form (only when the user asked to submit).',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'Optional form selector' } },
      required: [],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', description: 'down|up|top|bottom' },
        amount: { type: 'number', description: 'Pixels (default 600)' },
      },
      required: ['direction'],
    },
  },
  {
    name: 'key',
    description: 'Press a keyboard key.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Enter|Tab|Escape|ArrowDown|ArrowUp' } },
      required: ['key'],
    },
  },
  {
    name: 'extract',
    description: 'Extract structured data from the page matching a CSS selector.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS selector for the data' } },
      required: ['selector'],
    },
  },
  {
    name: 'new_tab',
    description: 'Open a URL in a new background tab (max 5 task tabs).',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to open' } },
      required: ['url'],
    },
  },
  {
    name: 'switch_tab',
    description: 'Switch to an already-open tab by hostname.',
    inputSchema: {
      type: 'object',
      properties: { host: { type: 'string', description: 'Hostname of the tab to focus' } },
      required: ['host'],
    },
  },
  {
    name: 'close_tab',
    description: 'Close an open tab by hostname.',
    inputSchema: {
      type: 'object',
      properties: { host: { type: 'string', description: 'Hostname of the tab to close' } },
      required: ['host'],
    },
  },
  {
    name: 'list_tabs',
    description: 'List open tabs (id, title, url) so you can switch_tab by host afterwards.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'wait',
    description: 'Wait for a short time. Last resort — prefer waiting for expected content.',
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'number', description: 'Milliseconds (<=3000)' } },
      required: [],
    },
  },
  {
    name: 'ask_website',
    description: 'Semantic search over the CURRENT page content. Use whenever unsure the page contains the answer; returns the most relevant sections with IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Question or info need' },
        topK: { type: 'number', description: 'Sections to return (default 3)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'highlight_element',
    description: 'Scroll to + visually highlight a page section by its ask_website ID, so the user sees exactly what you refer to.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Section ID from ask_website (e.g. "2-1")' } },
      required: ['id'],
    },
  },
  {
    name: 'find_history',
    description: 'Semantic search over browsing history by natural-language meaning (not just keywords).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for' },
        maxResults: { type: 'number', description: 'Max results (default 6)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'bookmark_add',
    description: 'Bookmark a page (defaults to the current page).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Optional URL' },
        title: { type: 'string', description: 'Optional title' },
      },
      required: [],
    },
  },
  {
    name: 'bookmark_search',
    description: 'Search saved bookmarks.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Text to find' } },
      required: ['query'],
    },
  },
  {
    name: 'save_page',
    description: 'Save the current page offline as MHTML.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'screenshot_save',
    description: 'Save a screenshot of the current viewport to Downloads.',
    inputSchema: {
      type: 'object',
      properties: { label: { type: 'string', description: 'Short file slug' } },
      required: [],
    },
  },
  {
    name: 'organize_tabs',
    description: 'Tidy tabs: group by domain, dedupe, or close empties.',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', description: 'group|dedupe|cleanup' } },
      required: ['mode'],
    },
  },
  {
    name: 'read_later_add',
    description: 'Add a page (default: current) to the reading list.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Optional URL' },
        title: { type: 'string', description: 'Optional title' },
      },
      required: [],
    },
  },
  {
    name: 'read_later_list',
    description: 'List the reading list.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'monitor_start',
    description: 'Watch a page for changes in the background.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Optional URL (default current page)' },
        intervalMin: { type: 'number', description: 'Minutes between checks (default 15)' },
        checkText: { type: 'string', description: 'Text/state to watch for' },
      },
      required: [],
    },
  },
  {
    name: 'use_skill',
    description: 'Engage an expert procedure from the SKILL LIBRARY by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Skill id from the library' } },
      required: ['id'],
    },
  },
  {
    name: 'done',
    description: 'Finish: the task is fully and verifiably complete. Return the final answer alongside.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

/** Names only — used to gate which native tool calls may execute. */
export const AGENT_TOOL_NAMES = new Set(AGENT_TOOL_SCHEMAS.map(t => t.name));

/** Chat-template shape expected by transformers.js apply_chat_template({tools}). */
export function toChatTemplateTools(tools = AGENT_TOOL_SCHEMAS) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

/** Compact prompt-side listing (for providers without native tool calling). */
export function describeToolSchemas(tools = AGENT_TOOL_SCHEMAS) {
  return tools.map(t => {
    const props = Object.entries(t.inputSchema.properties || {})
      .map(([k, v]) => `${k}: ${v.type}`)
      .join(', ');
    return `  • ${t.name}(${props || '—'}) — ${t.description}`;
  }).join('\n');
}
