#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const server = http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bard-cli-perms-'));

try {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(import.meta.dirname, 'bin', 'bard.js'),
      'use',
      `http://127.0.0.1:${address.port}`,
    ], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`CLI exited ${code}: ${stderr}`));
      else resolve(code);
    });
  });
  assert.equal(exitCode, 0);

  const configDir = path.join(home, '.bard');
  const configFile = path.join(configDir, 'config.json');
  assert.equal(fs.statSync(configDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);

  console.log('cli-config-permissions: 3/3 passed');
} finally {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
}
