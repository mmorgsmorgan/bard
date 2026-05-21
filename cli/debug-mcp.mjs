import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.bard', 'config.json'), 'utf8'));
const mcp = spawn('node', ['/mnt/c/Ubuntu/home/chief/bard/mcp/server.js'], {
  env: { ...process.env, BARD_TOKEN: config.token, BARD_API: 'http://localhost:4000' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

mcp.stderr.on('data', () => {});
mcp.stdout.on('data', (d) => {
  const raw = d.toString();
  // Extract all JSON bodies
  const parts = raw.split(/Content-Length:\s*\d+\r\n\r\n/).filter(Boolean);
  for (const p of parts) {
    try {
      const msg = JSON.parse(p);
      console.log(`  ID=${msg.id} method response keys: ${Object.keys(msg.result || {}).join(', ')}`);
      if (msg.result?.tools) console.log(`  → tools count: ${msg.result.tools.length}`);
      if (msg.result?.serverInfo) console.log(`  → server: ${msg.result.serverInfo.name}`);
    } catch {}
  }
});

function send(id, method, params = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  mcp.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

setTimeout(() => send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } }), 300);
setTimeout(() => send(2, 'tools/list', {}), 1500);
setTimeout(() => send(3, 'tools/call', { name: 'bard_get_identity', arguments: {} }), 2500);
setTimeout(() => { mcp.kill(); process.exit(0); }, 6000);
