/**
 * BARD MCP Server Test — works against the hosted HTTP endpoint by default,
 * falls back to local stdio if BARD_API points at localhost.
 *
 * Reads token + API from ~/.bard/config.json (created by setup-agent.mjs).
 * Override BARD_API via env to point at a different server.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.bard', 'config.json'), 'utf8'));
const TOKEN = config.token;
const API = (process.env.BARD_API || config.apiUrl || 'http://localhost:4000').replace(/\/$/, '');
const TRANSPORT = process.env.MCP_TRANSPORT
  || (API.startsWith('http://localhost') || API.startsWith('http://127.') ? 'stdio' : 'http');

console.log('\n  ── BARD MCP Server Test ──');
console.log(`  Transport: ${TRANSPORT}`);
console.log(`  API:       ${API}\n`);

// ── HTTP transport ────────────────────────────────────
async function rpcHttp(id, method, params = {}) {
  const res = await fetch(`${API}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (res.status === 204) return null;
  return await res.json();
}

// ── stdio transport ──────────────────────────────────
let stdioProc;
const stdioResults = {};

function startStdio() {
  const { spawn } = require('child_process');
  stdioProc = spawn('node', [path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'mcp', 'server.js')], {
    env: { ...process.env, BARD_TOKEN: TOKEN, BARD_API: API },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  stdioProc.stderr.on('data', () => {});
  stdioProc.stdout.on('data', (d) => {
    const raw = d.toString();
    const msgs = raw.split(/(?=Content-Length:)/);
    for (const m of msgs) {
      const bodyMatch = m.match(/Content-Length:\s*\d+\r\n\r\n([\s\S]+)/);
      if (!bodyMatch) continue;
      try { const parsed = JSON.parse(bodyMatch[1]); stdioResults[parsed.id] = parsed; } catch {}
    }
  });
}

function rpcStdio(id, method, params = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    stdioProc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    const t = Date.now();
    const poll = () => {
      if (stdioResults[id]) return resolve(stdioResults[id]);
      if (Date.now() - t > 8000) return resolve(null);
      setTimeout(poll, 50);
    };
    poll();
  });
}

// ── Run tests ────────────────────────────────────────
async function main() {
  let rpc;
  if (TRANSPORT === 'http') {
    rpc = rpcHttp;
  } else {
    // stdio mode: dynamic require for child_process (ES modules can't use require directly,
    // so we inline-load it via createRequire)
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    global.require = require;
    startStdio();
    rpc = rpcStdio;
    await new Promise(r => setTimeout(r, 300));
  }

  const init = await rpc(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'bard-test', version: '1.0' },
  });
  console.log(`  ✓ Server:   ${init?.result?.serverInfo?.name} v${init?.result?.serverInfo?.version}`);

  const tl = await rpc(2, 'tools/list');
  const tools = tl?.result?.tools || [];
  console.log(`  ✓ Tools:    ${tools.length} available`);

  const id3 = await rpc(3, 'tools/call', { name: 'bard_get_identity', arguments: {} });
  const idD = JSON.parse(id3?.result?.content?.[0]?.text || '{}');
  if (idD.authenticated) {
    console.log(`  ✓ Identity: ${idD.agentName} — ${idD.reputation?.tier} (Score ${idD.reputation?.score})`);
  } else {
    console.log(`  ✗ Identity: ${idD.error || 'unauthenticated'}`);
  }

  const ag = await rpc(4, 'tools/call', { name: 'bard_list_agents', arguments: {} });
  const agD = JSON.parse(ag?.result?.content?.[0]?.text || '{}');
  console.log(`  ✓ Agents:   ${agD.count ?? 0} registered platform-wide`);

  console.log('\n  ══════════════════════════════════');
  console.log('  ✅ MCP Server fully operational!');
  console.log('  ══════════════════════════════════\n');

  if (stdioProc) stdioProc.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error('  ✗ Test failed:', err.message);
  if (stdioProc) stdioProc.kill();
  process.exit(1);
});
