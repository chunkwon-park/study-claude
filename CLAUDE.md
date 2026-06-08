# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude API proxy that intercepts and inspects requests to `api.anthropic.com`. It exposes a real-time web dashboard and an MCP server with inspection tools.

## Running the Project

```bash
npm start        # Start the proxy + dashboard (node proxy.js)
```

The proxy occupies three ports simultaneously:

| Port | Role |
|------|------|
| 8080 | HTTP proxy — forward here instead of api.anthropic.com |
| 3000 | Static dashboard + REST API (`/api/requests`) |
| 8081 | WebSocket server for real-time event streaming |

## Using with Claude Code

To route Claude Code traffic through the proxy:

```bash
ANTHROPIC_BASE_URL=http://localhost:8080 claude
```

## MCP Server: `claude-proxy-inspector`

Defined in `mcp.mjs`. The `.mcp.json` at the project root registers it automatically with Claude Code.

**Server name:** `claude-proxy-inspector`  
**Start command:** `node mcp.mjs` (or `npm run mcp`)  
**Prerequisite:** `proxy.js` must be running (MCP connects to `localhost:3000/api`)

### Available Tools

| Tool | Description |
|------|-------------|
| `list_requests` | List all captured requests (id, method, path, status, duration, timestamp) |
| `get_request` | Full request/response dump for a given ID (headers, body, status) |
| `get_response_text` | Extract assistant text from a response — handles both SSE and JSON |
| `analyze_request` | Model, token usage, cache hits, and estimated cost for a request |
| `search_requests` | Filter by method, status code, or path substring (default limit: 20) |
| `clear_requests` | Clear all cached requests from the proxy |

## Architecture Notes

- **Compression removed:** The proxy deletes `accept-encoding` from forwarded headers so responses arrive as plain text (readable without decompression).
- **In-memory cache only:** Last 50 requests are held in RAM. Cache resets on restart — no persistence.
- **No authentication:** The dashboard and REST API are open. Run locally only; do not expose ports publicly.
- **Header masking:** `x-api-key` and `authorization` headers are truncated to 14 chars + `****` in logs and broadcasts.
- **SSE handling:** Streaming responses are forwarded chunk-by-chunk and stored as raw SSE strings. `get_response_text` and `analyze_request` parse them client-side.
