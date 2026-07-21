#!/usr/bin/env node

/**
 * BARD MCP Server — local stdio wrapper.
 *
 * Most users should use the hosted Streamable HTTP endpoint instead:
 *   POST https://<mcp-service-url>/mcp
 *   Header: Authorization: Bearer <BARD_TOKEN>
 *
 * This stdio variant is a transport adapter for clients that cannot connect
 * to Streamable HTTP directly. It forwards JSON-RPC to the hosted MCP service,
 * which is the only service allowed to call authenticated backend agent APIs.
 *
 * Usage:
 *   BARD_TOKEN=<token> BARD_MCP_URL=<mcp-url> node mcp/server.js
 *
 * MCP client config (Claude Desktop, Cursor, etc.):
 *   {
 *     "mcpServers": {
 *       "bard": {
 *         "command": "node",
 *         "args": ["<abs-path>/bard/mcp/server.js"],
 *         "env": { "BARD_TOKEN": "<token>" }
 *       }
 *     }
 *   }
 */

const TOKEN = process.env.BARD_TOKEN || '';
const MCP_URL = `${(process.env.BARD_MCP_URL || 'https://mcp-production-8d2e.up.railway.app')
  .replace(/\/mcp\/?$/, '')
  .replace(/\/$/, '')}/mcp`;

// ── stdio I/O loop ──

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  processBuffer();
});

function processBuffer() {
  while (buffer.length > 0) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      // Try line-delimited JSON
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) handleMessage(line);
      continue;
    }

    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) handleMessage(line);
      continue;
    }

    const contentLength = parseInt(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) return;

    const body = buffer.slice(bodyStart, bodyStart + contentLength);
    buffer = buffer.slice(bodyStart + contentLength);
    handleMessage(body);
  }
}

async function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  try {
    const response = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(msg),
    });
    if (response.status === 204) return;
    const result = await response.json();
    sendMessage(result);
  } catch (error) {
    sendMessage({
      jsonrpc: '2.0',
      id: msg.id ?? null,
      error: { code: -32603, message: `Hosted BARD MCP unavailable: ${error.message}` },
    });
  }
}

function sendMessage(msg) {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  process.stdout.write(header + body);
}

// Log to stderr so it doesn't interfere with MCP protocol
process.stderr.write(`[bard-mcp] stdio adapter. Hosted MCP: ${MCP_URL}\n`);
if (!TOKEN) process.stderr.write('[bard-mcp] WARNING: No BARD_TOKEN set. Auth-required tools will fail.\n');
