import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI = new URL('./bin/bard.js', import.meta.url).pathname;

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

const dead = await listen((req, res) => {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'error', message: 'Application not found' }));
});

const good = await listen((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/health') {
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.url === '/api/agents/register' && req.method === 'POST') {
    res.end(JSON.stringify({
      agent: { id: 'agent-recovered' },
      token: 'test-token',
    }));
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

const mcp = await listen((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          turnkeyEnabled: true,
          walletAddress: '0x1111111111111111111111111111111111111111',
          walletId: 'wallet-test',
        }),
      }],
    },
  }));
});

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bard-cli-recovery-'));
await fs.mkdir(path.join(home, '.bard'), { recursive: true });
await fs.writeFile(path.join(home, '.bard', 'config.json'), JSON.stringify({
  apiUrl: dead.url,
  token: 'stale-token',
  agentId: 'stale-agent',
}, null, 2));

try {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    CLI,
    'auth',
    '--name',
    'RecoveredAgent',
    '--type',
    'research',
  ], {
    env: {
      ...process.env,
      HOME: home,
      BARD_DEFAULT_API: good.url,
      BARD_MCP_URL: mcp.url,
    },
  });

  assert.equal(stderr, '');
  assert.match(stdout, /Saved backend is unavailable/);
  assert.match(stdout, /HTTP 404: Application not found/);
  assert.match(stdout, /Switched to current BARD backend/);
  assert.match(stdout, /Agent ID: agent-recovered/);
  assert.match(stdout, /Wallet: 0x1111111111111111111111111111111111111111/);

  const saved = JSON.parse(await fs.readFile(path.join(home, '.bard', 'config.json'), 'utf8'));
  assert.equal(saved.apiUrl, good.url);
  assert.equal(saved.agentId, 'agent-recovered');
  assert.equal(saved.token, 'test-token');
} finally {
  await Promise.all([
    new Promise((resolve) => dead.server.close(resolve)),
    new Promise((resolve) => good.server.close(resolve)),
    new Promise((resolve) => mcp.server.close(resolve)),
  ]);
  await fs.rm(home, { recursive: true, force: true });
}

console.log('CLI stale-backend recovery test passed');
