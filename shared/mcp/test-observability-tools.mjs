#!/usr/bin/env node

import assert from 'node:assert/strict';
import http from 'node:http';

const wallet = '0x1111111111111111111111111111111111111111';
let requests = 0;
const routes = new Map([
  ['GET /api/auth/me', {
    agentId: 'agent-test',
    agentName: 'TestAgent',
    wallet,
  }],
  ['GET /api/agents/agent-test', {
    agent: { id: 'agent-test', agentName: 'TestAgent', turnkeyAddress: wallet },
  }],
  ['GET /api/agents/agent-test/wallet-balance', {
    agentId: 'agent-test',
    agentName: 'TestAgent',
    wallet,
    balanceUsdc: '19.5',
    nativeGasBalance: '0.01',
  }],
  ['GET /api/bounties/bounty-test/escrow', {
    bounty: { id: 'bounty-test', status: 'completed', escrow_status: 'released' },
    events: [{ event_type: 'released' }],
    decisions: [{ decision: 'approved' }],
    onchain: { jobId: '12', status: 'released' },
  }],
  ['POST /api/agents/agent-test/send-usdc', {
    __status: 202,
    success: true,
    pending: true,
    txHash: '0xpending-send',
    message: 'confirmation pending',
  }],
  ['POST /api/bounties/bounty-test/deliver', {
    __status: 202,
    success: true,
    pending: true,
    txHash: '0xpending-deliver',
    onchainJobId: '12',
    message: 'confirmation pending',
  }],
]);

const server = http.createServer((req, res) => {
  requests++;
  assert.equal(req.headers.authorization, 'Bearer test-token');
  const key = `${req.method} ${req.url}`;
  const fixture = routes.get(key);
  if (!fixture) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `No fixture for ${key}` }));
    return;
  }
  const { __status = 200, ...body } = fixture;
  res.writeHead(__status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
process.env.BARD_API = `http://127.0.0.1:${address.port}`;

try {
  const { TOOLS, handleRpc } = await import('./index.js');
  const names = TOOLS.map(tool => tool.name);
  assert.equal(names.includes('bard_hire_swarm_agent'), false);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes('bard_get_wallet_balance'));
  assert.ok(names.includes('bard_get_bounty'));

  const call = async (name, args = {}) => {
    const response = await handleRpc({
      jsonrpc: '2.0',
      id: name,
      method: 'tools/call',
      params: { name, arguments: args },
    }, 'test-token');
    return JSON.parse(response.result.content[0].text);
  };

  const beforeRetiredCall = requests;
  const retired = await call('bard_hire_swarm_agent', { agentId: 'agent-test', task: 'obsolete', budgetUsdc: 1 });
  assert.match(retired.error, /Unknown tool/);
  assert.equal(requests, beforeRetiredCall, 'an old swarm call must not create or fund a bounty');

  const balance = await call('bard_get_wallet_balance');
  assert.equal(balance.success, true);
  assert.equal(balance.balanceUsdc, '19.5');
  assert.equal(balance.wallet, wallet);

  const bounty = await call('bard_get_bounty', { bountyId: 'bounty-test' });
  assert.equal(bounty.success, true);
  assert.equal(bounty.bounty.id, 'bounty-test');
  assert.equal(bounty.onchain.jobId, '12');

  const missingId = await call('bard_send_usdc', { to:wallet,amount:'0.25' });
  assert.match(missingId.error,/idempotencyKey/);
  const pendingSend = await call('bard_send_usdc', { to:wallet,amount:'0.25',idempotencyKey:'test-payment-1' });
  assert.equal(pendingSend.pending, true);
  assert.equal(pendingSend.txHash, '0xpending-send');
  assert.equal(pendingSend.idempotencyKey,'test-payment-1');

  const pendingDeliver = await call('bard_submit_deliverable', {
    bountyId: 'bounty-test',
    content: 'test deliverable',
  });
  assert.equal(pendingDeliver.pending, true);
  assert.equal(pendingDeliver.txHash, '0xpending-deliver');

  console.log('MCP discovery, retired-tool rejection, balances and pending transaction checks passed.');
} finally {
  await new Promise(resolve => server.close(resolve));
}
