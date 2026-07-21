#!/usr/bin/env node

import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import jwt from 'jsonwebtoken';
import { pool } from './db.js';

const MCP_SECRET = randomBytes(32).toString('hex');
const JWT_SECRET = randomBytes(32).toString('hex');
const SWARMS_WEBHOOK_SECRET = randomBytes(32).toString('hex');
const createdAgentIds = [];
const createdAgentNames = [];
let server;
let mcpServer;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function mcpHeaders({ token, method, path, body = '', signMethod = method, signPath = path }) {
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString('hex');
  const bodyHash = sha256(body);
  const tokenHash = sha256(token);
  const payload = `${timestamp}\n${nonce}\n${signMethod.toUpperCase()}\n${signPath}\n${tokenHash}\n${bodyHash}`;
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Bard-MCP-Timestamp': timestamp,
    'X-Bard-MCP-Nonce': nonce,
    'X-Bard-MCP-Body-SHA256': bodyHash,
    'X-Bard-MCP-Signature': createHmac('sha256', MCP_SECRET).update(payload).digest('hex'),
  };
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: response.status, ok: response.ok, data };
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.unref();
    listener.on('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForProcess(child, healthUrl, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Service exited during startup:\n${output.join('')}`);
    }
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch {
      // Keep polling while the service initializes.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Service did not become healthy:\n${output.join('')}`);
}

async function registerAgent(baseUrl, suffix) {
  const agentName = `mcp-only-${suffix}-${Date.now()}-${randomBytes(2).toString('hex')}`;
  const result = await request(baseUrl, '/api/agents/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ownerWallet: '0x0000000000000000000000000000000000000000',
      agentName,
      agentPublicKey: `mcp-only-${suffix}-${randomBytes(8).toString('hex')}`,
      agentType: 'research',
      description: 'MCP-only transport regression test',
    }),
  });
  assert.equal(result.status, 200, `registration failed: ${result.data?.error || result.status}`);
  assert.ok(result.data?.agentId);
  assert.ok(result.data?.token);
  createdAgentIds.push(result.data.agentId);
  createdAgentNames.push(agentName);
  return { agentId: result.data.agentId, token: result.data.token, agentName };
}

function pass(message) {
  console.log(`  PASS ${message}`);
}

async function cleanup() {
  if (mcpServer && mcpServer.exitCode === null) {
    mcpServer.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      mcpServer.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      server.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  if (createdAgentIds.length > 0) {
    await pool.query('DELETE FROM commitments WHERE agent_id = ANY($1::text[])', [createdAgentIds]);
    await pool.query('DELETE FROM auth_tokens WHERE agent_id = ANY($1::text[])', [createdAgentIds]);
    await pool.query('DELETE FROM agent_state WHERE agent_id = ANY($1::text[])', [createdAgentIds]);
    await pool.query('DELETE FROM agents WHERE id = ANY($1::text[])', [createdAgentIds]);
  }
  if (createdAgentNames.length > 0) {
    await pool.query(
      'DELETE FROM notifications WHERE message = ANY($1::text[])',
      [createdAgentNames.map((name) => `${name} has been registered on BARD.`)]
    );
  }
  await pool.end();
}

async function run() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for the local MCP-only integration test');
  }

  const backendPort = await getFreePort();
  const mcpPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${backendPort}`;
  const mcpUrl = `http://127.0.0.1:${mcpPort}`;
  const output = [];
  server = spawn(process.execPath, ['server.js'], {
    cwd: new URL('.', import.meta.url),
    env: {
      ...process.env,
      PORT: String(backendPort),
      NODE_ENV: 'test',
      JWT_SECRET,
      MCP_INTERNAL_SECRET: MCP_SECRET,
      MCP_ONLY_AGENT_API: '1',
      PLATFORM_OPERATOR_SECRET: randomBytes(32).toString('hex'),
      CORS_ORIGIN: 'http://127.0.0.1:3000',
      SWARMS_ENABLED: 'true',
      SWARMS_WEBHOOK_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => output.push(chunk.toString()));
  server.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitForProcess(server, `${baseUrl}/api/health`, output);

  const agentA = await registerAgent(baseUrl, 'a');
  const agentB = await registerAgent(baseUrl, 'b');

  const mcpOutput = [];
  mcpServer = spawn(process.execPath, ['mcp-server/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(mcpPort),
      BARD_API: baseUrl,
      MCP_INTERNAL_SECRET: MCP_SECRET,
      CORS_ORIGIN: 'http://127.0.0.1:3000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  mcpServer.stdout.on('data', (chunk) => mcpOutput.push(chunk.toString()));
  mcpServer.stderr.on('data', (chunk) => mcpOutput.push(chunk.toString()));
  await waitForProcess(mcpServer, `${mcpUrl}/health`, mcpOutput);

  const mcpIdentity = await request(mcpUrl, '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${agentA.token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'bard_get_identity', arguments: {} },
    }),
  });
  assert.equal(mcpIdentity.status, 200);
  const mcpIdentityText = mcpIdentity.data?.result?.content?.[0]?.text;
  assert.ok(mcpIdentityText);
  assert.equal(JSON.parse(mcpIdentityText).agentId, agentA.agentId);
  pass('hosted MCP tool succeeds through the real HMAC producer');

  const direct = await request(baseUrl, '/api/auth/me', {
    headers: { Authorization: `Bearer ${agentA.token}` },
  });
  assert.equal(direct.status, 403);
  assert.equal(direct.data?.hint, 'use_mcp');
  pass('direct agent JWT request is blocked with hint=use_mcp');

  const legacyProfileWrite = await request(baseUrl, '/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: agentA.agentId, username: 'forged' }),
  });
  assert.equal(legacyProfileWrite.status, 410);
  pass('legacy public profile mutation is retired');

  const unauthenticatedUpload = await request(baseUrl, '/api/upload/pfp', {
    method: 'POST',
  });
  assert.equal(unauthenticatedUpload.status, 401);
  pass('human uploads require a BARD human session before file parsing');

  const directSwarmEstimate = await request(baseUrl, '/api/swarms/estimate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: agentB.agentId, task: 'test' }),
  });
  assert.equal(directSwarmEstimate.status, 401);
  pass('swarm estimate is no longer public');

  const unsignedWebhook = await request(baseUrl, '/api/swarms/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ execution_id: 'unknown', status: 'completed' }),
  });
  assert.equal(unsignedWebhook.status, 401);
  pass('swarm webhook fails closed without a valid signature');

  const mePath = '/api/auth/me';
  const validHeaders = mcpHeaders({
    token: agentA.token,
    method: 'GET',
    path: mePath,
  });
  const signed = await request(baseUrl, mePath, { headers: validHeaders });
  assert.equal(signed.status, 200);
  assert.equal(signed.data?.agentId, agentA.agentId);
  pass('correctly signed MCP proof succeeds');

  const replay = await request(baseUrl, mePath, { headers: validHeaders });
  assert.equal(replay.status, 403);
  assert.equal(replay.data?.hint, 'use_mcp');
  pass('replayed MCP nonce is rejected');

  const statePath = `/api/agents/${agentA.agentId}/state`;
  const signedBody = JSON.stringify({ context: { value: 'signed' } });
  const tamperedBody = JSON.stringify({ context: { value: 'tampered' } });
  const tampered = await request(baseUrl, statePath, {
    method: 'PUT',
    headers: mcpHeaders({
      token: agentA.token,
      method: 'PUT',
      path: statePath,
      body: signedBody,
    }),
    body: tamperedBody,
  });
  assert.equal(tampered.status, 403);
  pass('modified request body invalidates MCP proof');

  const wrongPath = await request(baseUrl, '/api/auth/tokens', {
    headers: mcpHeaders({
      token: agentA.token,
      method: 'GET',
      path: '/api/auth/tokens',
      signPath: '/api/auth/me',
    }),
  });
  assert.equal(wrongPath.status, 403);
  pass('proof signed for a different path is rejected');

  const revokeBody = JSON.stringify({});
  const wrongMethod = await request(baseUrl, '/api/auth/revoke', {
    method: 'POST',
    headers: mcpHeaders({
      token: agentA.token,
      method: 'POST',
      signMethod: 'GET',
      path: '/api/auth/revoke',
      body: revokeBody,
    }),
    body: revokeBody,
  });
  assert.equal(wrongMethod.status, 403);
  pass('proof signed for a different method is rejected');

  const delegatedToken = jwt.sign({
    sub: agentA.agentId,
    agentId: agentA.agentId,
    kind: 'human-agent-session',
    wallet: '0x0000000000000000000000000000000000000000',
    scope: 'agent:human-delegated',
    agentName: agentA.agentName,
    jti: `test-human-${randomBytes(8).toString('hex')}`,
  }, JWT_SECRET, { expiresIn: '15m' });
  const delegated = await request(baseUrl, mePath, {
    headers: { Authorization: `Bearer ${delegatedToken}` },
  });
  assert.equal(delegated.status, 200);
  assert.equal(delegated.data?.agentId, agentA.agentId);
  pass('human-agent-session direct frontend delegation still succeeds');

  const commitmentBody = JSON.stringify({
    agentId: agentB.agentId,
    commitmentHash: `0x${randomBytes(32).toString('hex')}`,
    salt: `0x${randomBytes(32).toString('hex')}`,
  });
  const commitment = await request(baseUrl, '/api/commitments', {
    method: 'POST',
    headers: mcpHeaders({
      token: agentA.token,
      method: 'POST',
      path: '/api/commitments',
      body: commitmentBody,
    }),
    body: commitmentBody,
  });
  assert.equal(commitment.status, 200);
  const storedCommitment = await pool.query(
    'SELECT agent_id FROM commitments WHERE id = $1',
    [commitment.data?.commitmentId]
  );
  assert.equal(storedCommitment.rows[0]?.agent_id, agentA.agentId);
  pass('body-supplied agentId cannot impersonate another agent');

  const legacySubmit = await request(baseUrl, '/api/bounties/not-a-bounty/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contributionId: 'not-a-contribution' }),
  });
  assert.equal(legacySubmit.status, 410);
  assert.match(legacySubmit.data?.hint || '', /bard_submit_deliverable/i);
  pass('legacy bounty submit route returns 410');

  console.log('\nMCP-only agent API regression test passed.');
}

try {
  await run();
} finally {
  await cleanup();
}
