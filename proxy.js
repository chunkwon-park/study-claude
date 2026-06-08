const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PROXY_PORT = 8080;
const WS_PORT = 8081;
const STATIC_PORT = 3000;
const TARGET_HOST = 'api.anthropic.com';
const MAX_CACHE = 50;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB

let reqIdCounter = 0;
const cache = []; // { id, startEvent, responseHeadersEvent, chunks, status, duration, complete }

// ── WebSocket server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: WS_PORT });

wss.on('connection', (ws) => {
  // Replay cached history for new connections
  cache.forEach((entry) => {
    send(ws, entry.startEvent);
    if (entry.responseHeadersEvent) send(ws, entry.responseHeadersEvent);
    entry.chunks.forEach((chunk) => send(ws, { type: 'RESPONSE_CHUNK', id: entry.id, chunk }));
    if (entry.complete) send(ws, { type: 'RESPONSE_END', id: entry.id, duration: entry.duration });
  });
});

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((ws) => { if (ws.readyState === 1) ws.send(msg); });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function maskHeaders(headers) {
  const out = { ...headers };
  ['x-api-key', 'authorization'].forEach((k) => {
    if (out[k] && typeof out[k] === 'string' && out[k].length > 14) {
      out[k] = out[k].slice(0, 14) + '****';
    }
  });
  return out;
}

function tryParseJSON(buf) {
  try { return JSON.parse(buf.toString()); } catch { return buf.toString(); }
}

function addToCache(entry) {
  if (cache.length >= MAX_CACHE) cache.shift();
  cache.push(entry);
}

// ── Proxy server ──────────────────────────────────────────────────────────────

const proxyServer = http.createServer((req, res) => {
  const id = ++reqIdCounter;
  const startTime = Date.now();
  const bodyChunks = [];
  let bodySize = 0;

  req.on('data', (chunk) => {
    bodySize += chunk.length;
    if (bodySize <= MAX_BODY_BYTES) bodyChunks.push(chunk);
  });

  req.on('end', () => {
    const bodyBuffer = Buffer.concat(bodyChunks);
    const bodyParsed = bodySize > MAX_BODY_BYTES
      ? `[body too large: ${bodySize} bytes]`
      : tryParseJSON(bodyBuffer);

    const startEvent = {
      type: 'REQUEST_START',
      id,
      method: req.method,
      path: req.url,
      headers: maskHeaders(req.headers),
      body: bodyParsed,
      timestamp: new Date().toISOString(),
    };

    const entry = { id, startEvent, responseHeadersEvent: null, chunks: [], status: null, duration: null, complete: false };
    addToCache(entry);
    broadcast(startEvent);

    // Forward to Anthropic API
    const forwardHeaders = { ...req.headers, host: TARGET_HOST };
    // Remove compression headers so the response comes back as plain text we can read
    delete forwardHeaders['accept-encoding'];
    const options = { hostname: TARGET_HOST, port: 443, path: req.url, method: req.method, headers: forwardHeaders };

    const proxyReq = https.request(options, (proxyRes) => {
      entry.status = proxyRes.statusCode;

      const responseHeadersEvent = {
        type: 'RESPONSE_HEADERS',
        id,
        status: proxyRes.statusCode,
        headers: proxyRes.headers,
      };
      entry.responseHeadersEvent = responseHeadersEvent;
      broadcast(responseHeadersEvent);

      res.writeHead(proxyRes.statusCode, proxyRes.headers);

      const isSSE = (proxyRes.headers['content-type'] || '').includes('text/event-stream');

      if (isSSE) {
        proxyRes.on('data', (chunk) => {
          res.write(chunk);
          const chunkStr = chunk.toString();
          entry.chunks.push(chunkStr);
          broadcast({ type: 'RESPONSE_CHUNK', id, chunk: chunkStr });
        });
        proxyRes.on('end', () => {
          res.end();
          finalize(entry, id, startTime);
        });
      } else {
        const resChunks = [];
        proxyRes.on('data', (chunk) => { res.write(chunk); resChunks.push(chunk); });
        proxyRes.on('end', () => {
          res.end();
          const body = tryParseJSON(Buffer.concat(resChunks));
          const chunkStr = typeof body === 'object' ? JSON.stringify(body, null, 2) : body;
          entry.chunks.push(chunkStr);
          broadcast({ type: 'RESPONSE_CHUNK', id, chunk: chunkStr });
          finalize(entry, id, startTime);
        });
      }
    });

    proxyReq.on('error', (err) => {
      console.error(`[${id}] proxy error:`, err.message);
      if (!res.headersSent) res.writeHead(502);
      res.end(JSON.stringify({ error: err.message }));
      broadcast({ type: 'RESPONSE_END', id, error: err.message, duration: Date.now() - startTime });
    });

    proxyReq.write(bodyBuffer);
    proxyReq.end();
  });
});

function finalize(entry, id, startTime) {
  const duration = Date.now() - startTime;
  entry.duration = duration;
  entry.complete = true;
  broadcast({ type: 'RESPONSE_END', id, duration });
}

// ── REST API ──────────────────────────────────────────────────────────────────

function handleApi(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const idMatch = req.url.match(/^\/api\/requests\/(\d+)$/);

  if (req.url === '/api/requests' && req.method === 'GET') {
    const summary = cache.map((e) => ({
      id: e.id,
      method: e.startEvent.method,
      path: e.startEvent.path,
      timestamp: e.startEvent.timestamp,
      status: e.status,
      duration: e.duration,
      complete: e.complete,
    }));
    res.writeHead(200);
    res.end(JSON.stringify(summary));

  } else if (idMatch && req.method === 'GET') {
    const entry = cache.find((e) => e.id === parseInt(idMatch[1]));
    if (!entry) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200);
    res.end(JSON.stringify(entry));

  } else if (req.url === '/api/requests' && req.method === 'DELETE') {
    cache.length = 0;
    reqIdCounter = 0;
    broadcast({ type: 'CLEAR' });
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));

  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}

// ── Static file server ────────────────────────────────────────────────────────

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

const staticServer = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    handleApi(req, res);
    return;
  }

  const safePath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(__dirname, 'public', safePath);

  // Prevent path traversal
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); res.end(); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

proxyServer.listen(PROXY_PORT, () => {
  console.log(`\n  Proxy     →  http://localhost:${PROXY_PORT}`);
});
staticServer.listen(STATIC_PORT, () => {
  console.log(`  Dashboard →  http://localhost:${STATIC_PORT}`);
  console.log(`  WebSocket →  ws://localhost:${WS_PORT}`);
  console.log(`\n  Run Claude Code with:\n  ANTHROPIC_BASE_URL=http://localhost:${PROXY_PORT} claude\n`);
});
