import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE = 'http://localhost:3000/api';

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) throw new Error(`Proxy API error ${res.status}: is the proxy running? (node proxy.js)`);
  return res.json();
}

function formatList(requests) {
  return requests.map((r) => {
    const status = r.status ? String(r.status) : 'pending';
    const duration = r.duration != null ? `${r.duration}ms` : '...';
    const time = new Date(r.timestamp).toLocaleTimeString('ko-KR', { hour12: false });
    return `[${r.id}] ${r.method} ${r.path}  ${status}  ${duration}  ${time}`;
  }).join('\n');
}

function extractTextFromSSE(chunks) {
  const raw = chunks.join('');
  let text = '';
  for (const block of raw.split(/\n\n+/)) {
    let dataLine = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) dataLine = line.slice(5).trim();
    }
    if (!dataLine || dataLine === '[DONE]') continue;
    try {
      const parsed = JSON.parse(dataLine);
      if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
        text += parsed.delta.text;
      }
    } catch {}
  }
  return text;
}

function extractUsage(chunks) {
  const raw = chunks.join('');
  // Try message_delta event which contains final usage
  for (const block of raw.split(/\n\n+/)) {
    let dataLine = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) dataLine = line.slice(5).trim();
    }
    if (!dataLine) continue;
    try {
      const parsed = JSON.parse(dataLine);
      if (parsed.type === 'message_delta' && parsed.usage) return parsed.usage;
      if (parsed.usage) return parsed.usage;
    } catch {}
  }
  // Fallback: regex search
  const m = raw.match(/"usage"\s*:\s*(\{[^}]+\})/);
  if (m) { try { return JSON.parse(m[1]); } catch {} }
  return null;
}

const PRICES = {
  'claude-opus-4':      { input: 15,   output: 75  },
  'claude-opus-3':      { input: 15,   output: 75  },
  'claude-sonnet-4':    { input: 3,    output: 15  },
  'claude-sonnet-3-5':  { input: 3,    output: 15  },
  'claude-haiku-4':     { input: 0.80, output: 4   },
  'claude-haiku-3-5':   { input: 0.80, output: 4   },
  'claude-haiku-3':     { input: 0.25, output: 1.25 },
};

function getPricing(model = '') {
  for (const [key, price] of Object.entries(PRICES)) {
    if (model.includes(key.replace('claude-', ''))) return price;
  }
  return null;
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'claude-proxy-inspector', version: '1.0.0' });

server.tool(
  'list_requests',
  'List all captured Claude API requests',
  {},
  async () => {
    const requests = await api('/requests');
    if (requests.length === 0) {
      return { content: [{ type: 'text', text: 'No requests captured yet.\n\nRun Claude Code with:\n  ANTHROPIC_BASE_URL=http://localhost:8080 claude' }] };
    }
    return { content: [{ type: 'text', text: `${requests.length} request(s):\n\n${formatList(requests)}` }] };
  }
);

server.tool(
  'get_request',
  'Get full details of a captured request: headers, body, and response',
  { id: z.number().int().describe('Request ID (from list_requests)') },
  async ({ id }) => {
    const e = await api(`/requests/${id}`);
    const lines = [];

    lines.push(`## Request #${e.id}  ${e.startEvent.method} ${e.startEvent.path}`);
    lines.push(`Time: ${e.startEvent.timestamp}`);
    lines.push('');

    lines.push('### Request Headers');
    for (const [k, v] of Object.entries(e.startEvent.headers || {})) {
      lines.push(`  ${k}: ${v}`);
    }
    lines.push('');

    if (e.startEvent.body) {
      lines.push('### Request Body');
      lines.push(
        typeof e.startEvent.body === 'object'
          ? JSON.stringify(e.startEvent.body, null, 2)
          : String(e.startEvent.body)
      );
      lines.push('');
    }

    if (e.responseHeadersEvent) {
      lines.push(`### Response  HTTP ${e.responseHeadersEvent.status}${e.duration != null ? `  (${e.duration}ms)` : ''}`);
      lines.push('');
      lines.push('### Response Headers');
      for (const [k, v] of Object.entries(e.responseHeadersEvent.headers || {})) {
        lines.push(`  ${k}: ${v}`);
      }
    } else {
      lines.push('Response: pending...');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

server.tool(
  'get_response_text',
  'Extract the full text content from a Claude response (handles streaming SSE)',
  { id: z.number().int().describe('Request ID') },
  async ({ id }) => {
    const e = await api(`/requests/${id}`);
    const isSSE = e.chunks.some(
      (c) => typeof c === 'string' && (c.includes('event:') || c.includes('data:'))
    );

    let text = '';
    if (isSSE) {
      text = extractTextFromSSE(e.chunks);
    } else {
      const raw = e.chunks.join('');
      try {
        const parsed = JSON.parse(raw);
        text = (parsed.content || [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('');
      } catch {
        text = raw;
      }
    }

    return { content: [{ type: 'text', text: text || '(no text content found)' }] };
  }
);

server.tool(
  'analyze_request',
  'Analyze a request: model, parameters, token usage, and estimated cost',
  { id: z.number().int().describe('Request ID') },
  async ({ id }) => {
    const e = await api(`/requests/${id}`);
    const body = e.startEvent.body;
    const lines = [];

    lines.push(`## Analysis: Request #${id}`);
    lines.push('');

    if (body && typeof body === 'object') {
      if (body.model)            lines.push(`Model:       ${body.model}`);
      if (body.max_tokens)       lines.push(`Max tokens:  ${body.max_tokens}`);
      if (body.temperature != null) lines.push(`Temperature: ${body.temperature}`);
      if (body.stream != null)   lines.push(`Streaming:   ${body.stream}`);
      if (body.system)           lines.push(`System:      ${body.system.length} chars`);

      if (Array.isArray(body.messages)) {
        lines.push(`Messages:    ${body.messages.length}`);
        const totalChars = body.messages.reduce((acc, m) => {
          const content = Array.isArray(m.content)
            ? m.content.map((c) => c.text || '').join('')
            : String(m.content || '');
          return acc + content.length;
        }, 0);
        lines.push(`Input chars: ~${totalChars}`);
      }
      lines.push('');
    }

    const usage = extractUsage(e.chunks);
    if (usage) {
      lines.push('### Token Usage');
      if (usage.input_tokens)                lines.push(`  Input:           ${usage.input_tokens.toLocaleString()}`);
      if (usage.output_tokens)               lines.push(`  Output:          ${usage.output_tokens.toLocaleString()}`);
      if (usage.cache_read_input_tokens)     lines.push(`  Cache read:      ${usage.cache_read_input_tokens.toLocaleString()}`);
      if (usage.cache_creation_input_tokens) lines.push(`  Cache creation:  ${usage.cache_creation_input_tokens.toLocaleString()}`);

      const pricing = getPricing(body?.model || '');
      if (pricing && usage.input_tokens && usage.output_tokens) {
        const cost = (usage.input_tokens / 1_000_000) * pricing.input
                   + (usage.output_tokens / 1_000_000) * pricing.output;
        lines.push(`  Est. cost:       $${cost.toFixed(6)}`);
      }
      lines.push('');
    }

    if (e.duration != null) lines.push(`Duration: ${e.duration}ms`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

server.tool(
  'search_requests',
  'Filter captured requests by method, status code, or path substring',
  {
    method: z.string().optional().describe('HTTP method (POST, GET, ...)'),
    status: z.number().int().optional().describe('HTTP status code'),
    path:   z.string().optional().describe('Path substring to match'),
    limit:  z.number().int().optional().describe('Max results (default 20)'),
  },
  async ({ method, status, path, limit = 20 }) => {
    let requests = await api('/requests');

    if (method) requests = requests.filter((r) => r.method === method.toUpperCase());
    if (status) requests = requests.filter((r) => r.status === status);
    if (path)   requests = requests.filter((r) => r.path.includes(path));

    requests = requests.slice(-limit);

    if (requests.length === 0) {
      return { content: [{ type: 'text', text: 'No matching requests found.' }] };
    }
    return { content: [{ type: 'text', text: `${requests.length} result(s):\n\n${formatList(requests)}` }] };
  }
);

server.tool(
  'clear_requests',
  'Clear all captured requests from the proxy cache',
  {},
  async () => {
    await api('/requests', { method: 'DELETE' });
    return { content: [{ type: 'text', text: 'All requests cleared.' }] };
  }
);

// ── Boot ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
