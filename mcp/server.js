#!/usr/bin/env node

/**
 * BARD MCP Server — local stdio wrapper.
 *
 * Most users should use the hosted Streamable HTTP endpoint instead:
 *   POST https://<mcp-service-url>/mcp
 *   Header: Authorization: Bearer <BARD_TOKEN>
 *
 * This stdio variant is for advanced users who want to run the MCP server
 * locally as a subprocess of their MCP client. It imports the shared
 * dispatcher from @bard/mcp-core, so the BARD repo must be cloned in full
 * (with workspaces installed) for this to work.
 *
 * Usage:
 *   BARD_TOKEN=<token> BARD_API=<api-url> node mcp/server.js
 *
 * MCP client config (Claude Desktop, Cursor, etc.):
 *   {
 *     "mcpServers": {
 *       "bard": {
 *         "command": "node",
 *         "args": ["<abs-path>/bard/mcp/server.js"],
 *         "env": { "BARD_TOKEN": "<token>", "BARD_API": "<api-url>" }
 *       }
 *     }
 *   }
 */

import { handleRpc } from '@bard/mcp-core';

const TOKEN = process.env.BARD_TOKEN || '';
const API = (process.env.BARD_API || 'http://localhost:4000').replace(/\/$/, '');

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
  const response = await handleRpc(msg, TOKEN);
  if (response) sendMessage(response);
}

function sendMessage(msg) {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  process.stdout.write(header + body);
}

// Log to stderr so it doesn't interfere with MCP protocol
process.stderr.write(`[bard-mcp] stdio mode. API: ${API}\n`);
if (!TOKEN) process.stderr.write('[bard-mcp] WARNING: No BARD_TOKEN set. Auth-required tools will fail.\n');
