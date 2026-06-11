// State
const requests = new Map(); // id -> { startEvent, responseHeadersEvent, chunks, status, duration, complete }
let selectedId = null;
let currentBodyText = ''; // raw body text of the selected request, for clipboard copy

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connect() {
  const ws = new WebSocket('ws://localhost:8081');
  const statusEl = document.getElementById('ws-status');

  ws.onopen = () => {
    statusEl.textContent = 'Connected';
    statusEl.className = 'connected';
  };

  ws.onclose = () => {
    statusEl.textContent = 'Disconnected — reconnecting...';
    statusEl.className = 'disconnected';
    setTimeout(connect, 2000);
  };

  ws.onmessage = (e) => {
    try { handleMessage(JSON.parse(e.data)); } catch {}
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'REQUEST_START': {
      const entry = { startEvent: msg, responseHeadersEvent: null, chunks: [], status: null, duration: null, complete: false };
      requests.set(msg.id, entry);
      addToList(msg);
      // Auto-select the newest request
      selectRequest(msg.id);
      break;
    }
    case 'RESPONSE_HEADERS': {
      const entry = requests.get(msg.id);
      if (!entry) break;
      entry.responseHeadersEvent = msg;
      entry.status = msg.status;
      updateListStatus(msg.id, msg.status, null);
      if (selectedId === msg.id) renderResponseHeaders(msg);
      break;
    }
    case 'RESPONSE_CHUNK': {
      const entry = requests.get(msg.id);
      if (!entry) break;
      entry.chunks.push(msg.chunk);
      if (selectedId === msg.id) appendChunk(msg.chunk);
      break;
    }
    case 'RESPONSE_END': {
      const entry = requests.get(msg.id);
      if (!entry) break;
      entry.duration = msg.duration;
      entry.complete = true;
      updateListStatus(msg.id, entry.status, msg.duration);
      if (selectedId === msg.id) markDone(msg.duration);
      break;
    }
  }
}

// ── Request List ──────────────────────────────────────────────────────────────

function addToList(req) {
  const list = document.getElementById('request-list');
  // Remove empty state
  const empty = list.querySelector('.empty-state');
  if (empty) empty.remove();

  const li = document.createElement('li');
  li.className = 'req-item';
  li.dataset.id = req.id;
  li.innerHTML = `
    <div class="req-item-top">
      <span class="method-badge">${esc(req.method)}</span>
      <span class="req-path" title="${esc(req.path)}">${esc(req.path)}</span>
    </div>
    <div class="req-item-bottom">
      <span class="status-badge pending" id="status-${req.id}">···</span>
      <span class="req-time">${formatTime(req.timestamp)}</span>
      <span class="req-duration" id="duration-${req.id}"></span>
    </div>`;
  li.addEventListener('click', () => selectRequest(req.id));
  list.prepend(li);
}

function updateListStatus(id, status, duration) {
  const badge = document.getElementById(`status-${id}`);
  const durEl = document.getElementById(`duration-${id}`);
  if (badge && status) {
    badge.textContent = status;
    badge.className = `status-badge ${statusClass(status)}`;
  }
  if (durEl && duration != null) durEl.textContent = `${duration}ms`;
}

// ── Detail View ───────────────────────────────────────────────────────────────

function selectRequest(id) {
  selectedId = id;

  // Update active state in list
  document.querySelectorAll('.req-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.id == id);
  });

  const entry = requests.get(id);
  if (!entry) return;

  document.getElementById('no-selection').style.display = 'none';
  document.getElementById('panels').style.display = 'flex';

  renderRequest(entry.startEvent);
  resetResponsePanel();

  if (entry.responseHeadersEvent) renderResponseHeaders(entry.responseHeadersEvent);
  entry.chunks.forEach(appendChunk);
  if (entry.complete) markDone(entry.duration);
}

function renderRequest(req) {
  document.getElementById('req-meta').textContent =
    `${req.method} ${req.path}  ·  ${formatTime(req.timestamp)}`;

  if (req.body && typeof req.body === 'object') {
    renderMessagesTab(req.body);
  } else {
    document.getElementById('req-messages-content').innerHTML =
      '<div class="msg-empty">(no structured body)</div>';
  }

  document.getElementById('req-headers-table').innerHTML = buildHeadersTable(req.headers);

  const bodyEl = document.getElementById('req-body-content');
  let bodyText;
  if (req.body && typeof req.body === 'object') {
    bodyText = JSON.stringify(req.body, null, 2);
    bodyEl.innerHTML = syntaxHighlight(req.body);
  } else {
    bodyText = req.body || '';
    bodyEl.textContent = bodyText || '(empty)';
  }

  const countEl = document.getElementById('req-body-count');
  countEl.innerHTML = `Body: <strong>${bodyText.length.toLocaleString()}</strong> chars`;

  currentBodyText = bodyText;
}

function renderMessagesTab(body) {
  const container = document.getElementById('req-messages-content');
  container.innerHTML = '';

  if (body.system) container.appendChild(buildMsgCard('system', body.system));

  if (Array.isArray(body.messages)) {
    const total = body.messages.length;
    body.messages.forEach((msg, i) => {
      container.appendChild(buildMsgCard(msg.role, msg.content, i + 1, total));
    });
  }
}

function msgContentLength(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum, b) => {
      if (typeof b === 'string') return sum + b.length;
      if (b.type === 'text') return sum + (b.text || '').length;
      if (b.type === 'tool_result') {
        const c = b.content;
        if (typeof c === 'string') return sum + c.length;
        if (Array.isArray(c)) return sum + c.reduce((s, x) => s + (x.text || '').length, 0);
      }
      return sum + JSON.stringify(b).length;
    }, 0);
  }
  return JSON.stringify(content).length;
}

function buildMsgCard(role, content, index, total) {
  const card = document.createElement('div');
  card.className = 'msg-card';

  const charLen = msgContentLength(content);
  const startCollapsed = role === 'system' || charLen > 3000;
  if (startCollapsed) card.classList.add('collapsed');

  const header = document.createElement('div');
  header.className = 'msg-header';

  const badge = document.createElement('span');
  badge.className = `msg-role-badge msg-role-${role}`;
  badge.textContent = role;
  header.appendChild(badge);

  if (index !== undefined) {
    const idx = document.createElement('span');
    idx.className = 'msg-index';
    idx.textContent = `#${index}${total ? '/' + total : ''}`;
    header.appendChild(idx);
  }

  if (Array.isArray(content)) {
    const types = [...new Set(content.map(b => b.type).filter(Boolean))];
    if (types.length) {
      const summary = document.createElement('span');
      summary.className = 'msg-summary';
      summary.textContent = types.join(' · ');
      header.appendChild(summary);
    }
  }

  const chars = document.createElement('span');
  chars.className = 'msg-char-count';
  chars.textContent = charLen.toLocaleString() + ' chars';
  header.appendChild(chars);

  const toggle = document.createElement('span');
  toggle.className = 'msg-toggle';
  toggle.textContent = startCollapsed ? '▸' : '▾';
  header.appendChild(toggle);

  header.addEventListener('click', () => {
    card.classList.toggle('collapsed');
    toggle.textContent = card.classList.contains('collapsed') ? '▸' : '▾';
  });

  const body = document.createElement('div');
  body.className = 'msg-body';
  renderMsgContent(body, content);
  card.appendChild(header);
  card.appendChild(body);
  return card;
}

function renderMsgContent(container, content) {
  if (typeof content === 'string') {
    const div = document.createElement('div');
    div.className = 'msg-text';
    div.textContent = content;
    container.appendChild(div);
  } else if (Array.isArray(content)) {
    content.forEach(block => container.appendChild(buildContentBlock(block)));
  } else {
    const div = document.createElement('div');
    div.className = 'json-block';
    div.innerHTML = syntaxHighlight(content);
    container.appendChild(div);
  }
}

function buildContentBlock(block) {
  const wrap = document.createElement('div');
  wrap.className = 'content-block';

  const typeClass = (block.type || 'unknown').replace(/[^a-z_]/gi, '');
  const badge = document.createElement('div');
  badge.className = `content-type-badge content-type-${typeClass}`;

  if (block.type === 'tool_use') {
    badge.textContent = `tool_use  ·  ${block.name || ''}`;
  } else if (block.type === 'tool_result') {
    badge.textContent = block.is_error ? 'tool_result  ·  error' : 'tool_result';
    if (block.is_error) badge.classList.add('error');
  } else {
    badge.textContent = block.type || 'unknown';
  }
  wrap.appendChild(badge);

  const body = document.createElement('div');
  body.className = 'content-block-body';

  if (block.type === 'text') {
    const pre = document.createElement('div');
    pre.className = 'msg-text';
    pre.textContent = block.text || '';
    body.appendChild(pre);
  } else if (block.type === 'tool_use') {
    const pre = document.createElement('div');
    pre.className = 'json-block';
    pre.innerHTML = syntaxHighlight(block.input || {});
    body.appendChild(pre);
  } else if (block.type === 'tool_result') {
    const c = block.content;
    if (typeof c === 'string') {
      const pre = document.createElement('div');
      pre.className = 'msg-text';
      pre.textContent = c;
      body.appendChild(pre);
    } else if (Array.isArray(c)) {
      c.forEach(item => {
        if (item.type === 'text') {
          const pre = document.createElement('div');
          pre.className = 'msg-text';
          pre.textContent = item.text || '';
          body.appendChild(pre);
        }
      });
    }
  } else {
    const pre = document.createElement('div');
    pre.className = 'json-block';
    pre.innerHTML = syntaxHighlight(block);
    body.appendChild(pre);
  }

  wrap.appendChild(body);
  return wrap;
}

function resetResponsePanel() {
  document.getElementById('sse-container').innerHTML = '';
  document.getElementById('res-raw-content').textContent = '';
  document.getElementById('res-headers-table').innerHTML = '';
  document.getElementById('res-meta').textContent = '';
  document.getElementById('res-done').style.display = 'none';
  document.getElementById('res-streaming').style.display = 'inline';
  document.getElementById('text-accumulator').style.display = 'none';
  document.getElementById('text-accumulator').textContent = '';
  document.getElementById('text-accumulator-label').style.display = 'none';
}

function renderResponseHeaders(msg) {
  document.getElementById('res-meta').textContent = `HTTP ${msg.status}`;
  document.getElementById('res-headers-table').innerHTML = buildHeadersTable(msg.headers);
}

function appendChunk(chunk) {
  // Raw tab
  const rawEl = document.getElementById('res-raw-content');
  rawEl.textContent += chunk;

  const isSSE = chunk.trim().startsWith('event:') || chunk.trim().startsWith('data:');

  if (isSSE) {
    parseSSEChunk(chunk).forEach(renderSSEEvent);
  } else {
    // Non-streaming JSON response
    const container = document.getElementById('sse-container');
    const div = document.createElement('div');
    div.className = 'json-block';
    try {
      div.innerHTML = syntaxHighlight(JSON.parse(chunk));
    } catch {
      div.textContent = chunk;
    }
    container.appendChild(div);
  }
}

function markDone(duration) {
  document.getElementById('res-streaming').style.display = 'none';
  const doneEl = document.getElementById('res-done');
  doneEl.style.display = 'inline';
  doneEl.textContent = `✓ done  ${duration}ms`;
}

// ── SSE Parsing ───────────────────────────────────────────────────────────────

function parseSSEChunk(chunk) {
  const events = [];
  const blocks = chunk.split(/\n\n+/);

  blocks.forEach((block) => {
    if (!block.trim()) return;
    const lines = block.split('\n');
    let eventType = 'unknown';
    let dataLine = '';

    lines.forEach((line) => {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      if (line.startsWith('data:')) dataLine = line.slice(5).trim();
    });

    if (dataLine) events.push({ eventType, dataLine });
  });

  return events;
}

function renderSSEEvent({ eventType, dataLine }) {
  const container = document.getElementById('sse-container');

  let parsed = null;
  try { parsed = JSON.parse(dataLine); } catch {}

  // Extract text delta for accumulator
  if (parsed && parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
    const accLabel = document.getElementById('text-accumulator-label');
    const acc = document.getElementById('text-accumulator');
    accLabel.style.display = 'block';
    acc.style.display = 'block';
    acc.textContent += parsed.delta.text;
  }

  const el = document.createElement('div');
  el.className = 'sse-event';

  const typeClass = eventType.replace(/[^a-z_]/gi, '') || 'unknown';
  el.innerHTML = `
    <div class="sse-event-header">
      <span class="sse-type-badge ${typeClass}">${esc(eventType)}</span>
      <span class="sse-toggle">▾</span>
    </div>
    <div class="sse-event-body">${parsed ? syntaxHighlight(parsed) : esc(dataLine)}</div>`;

  // Collapse ping events by default (noisy)
  if (eventType === 'ping') el.classList.add('collapsed');

  el.querySelector('.sse-event-header').addEventListener('click', () => {
    el.classList.toggle('collapsed');
    el.querySelector('.sse-toggle').textContent = el.classList.contains('collapsed') ? '▸' : '▾';
  });

  container.appendChild(el);
  // Auto-scroll to bottom
  const eventsPanel = document.getElementById('res-events');
  if (eventsPanel.classList.contains('active')) {
    eventsPanel.scrollTop = eventsPanel.scrollHeight;
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-bar').forEach((bar) => {
  bar.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    const targetId = tab.dataset.tab;
    const panel = bar.closest('.panel');
    panel.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    panel.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    tab.classList.add('active');
    panel.querySelector(`#${targetId}`).classList.add('active');
  });
});

// ── Copy Body ─────────────────────────────────────────────────────────────────

document.getElementById('req-body-copy').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (!currentBodyText) return;
  try {
    await navigator.clipboard.writeText(currentBodyText);
  } catch {
    // Fallback for non-secure contexts where navigator.clipboard is unavailable
    const ta = document.createElement('textarea');
    ta.value = currentBodyText;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  btn.textContent = 'Copied!';
  btn.classList.add('copied');
  setTimeout(() => {
    btn.textContent = 'Copy';
    btn.classList.remove('copied');
  }, 1500);
});

// ── Clear ─────────────────────────────────────────────────────────────────────

document.getElementById('clear-btn').addEventListener('click', () => {
  requests.clear();
  selectedId = null;
  document.getElementById('request-list').innerHTML =
    '<li class="empty-state">Waiting for requests...</li>';
  document.getElementById('no-selection').style.display = 'flex';
  document.getElementById('panels').style.display = 'none';
});

// ── Utilities ─────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function syntaxHighlight(obj) {
  const json = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  return esc(json).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = 'number';
      if (/^"/.test(match)) cls = /:$/.test(match) ? 'key' : 'string';
      else if (/true|false/.test(match)) cls = 'boolean';
      else if (/null/.test(match)) cls = 'null';
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

function buildHeadersTable(headers) {
  return Object.entries(headers || {})
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`)
    .join('');
}

function statusClass(code) {
  if (code >= 200 && code < 300) return 's2xx';
  if (code >= 400 && code < 500) return 's4xx';
  if (code >= 500) return 's5xx';
  return 'pending';
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

connect();
