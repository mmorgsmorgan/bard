import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { handleRpc } from '../shared/mcp/index.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./bin/bard.js', import.meta.url));
const guide = await readFile(new URL('../shared/mcp/skill.md', import.meta.url), 'utf8');

test('CLI reads the configured guide before authentication without opening other agent actions', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'bard-cli-skill-'));
  const requests = [];
  let emptyGuide = false;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    requests.push({ message, authorization: req.headers.authorization, url: req.url });
    res.setHeader('Content-Type', 'application/json');
    if (message.method !== 'tools/call' || message.params.name !== 'bard_get_skill') {
      res.writeHead(400);
      res.end(JSON.stringify({ error: { message: 'Only the guide may be requested by this fixture.' } }));
      return;
    }
    const result = await handleRpc(message);
    if (emptyGuide) result.result.content[0].text = JSON.stringify({ content: '' });
    res.end(JSON.stringify(result));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}/mcp/`;
    const env = { PATH: process.env.PATH, HOME: fixtureRoot, BARD_API: 'http://127.0.0.1:9', BARD_MCP_URL: endpoint };
    const run = (command, overrides = {}) => exec(process.execPath, [cli, command], { env: { ...env, ...overrides } });

    const first = await run('skill');
    assert.equal(first.stdout, guide);
    assert.equal(first.stderr, '');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, undefined, 'no fake Bearer header for a public guide');
    assert.equal(requests[0].url, '/mcp');
    assert.deepEqual(requests[0].message.params.arguments, {});

    await assert.rejects(run('unlink-human'), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Not authenticated/);
      return true;
    });
    assert.equal(requests.length, 1, 'unauthenticated mutations never reach MCP');

    await mkdir(path.join(fixtureRoot, '.bard'));
    await writeFile(path.join(fixtureRoot, '.bard', 'config.json'), JSON.stringify({ mcpUrl: endpoint, token: 'fixture-agent-token' }), { mode: 0o600 });
    const saved = await run('skill', { BARD_MCP_URL: '' });
    assert.equal(saved.stdout, guide, 'the CLI still reads saved MCP configuration');
    assert.equal(requests[1].authorization, 'Bearer fixture-agent-token');
    assert.ok(!saved.stdout.includes('fixture-agent-token'));

    emptyGuide = true;
    await assert.rejects(run('skill'), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /empty agent guide/);
      return true;
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
