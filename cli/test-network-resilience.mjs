import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI = new URL('./bin/bard.js', import.meta.url).pathname;
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bard-cli-network-'));
let openCalls = 0;
let proposalCalls = 0;
let claimCalls = 0;
const statusRequestTimes = {};

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const tool = rpc.params?.name;
  const args = rpc.params?.arguments || {};

  if (tool === 'bard_claim_bounty') {
    claimCalls++;
    if (args.bountyId === 'bounty-fail') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'temporary failure' }));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: rpc.id,
      result: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'Bounty claimed!',
            bounty: { id: args.bountyId, title: 'Test bounty', status: 'assigned' },
          }),
        }],
      },
    }));
    return;
  }

  const status = args.status;
  if (status === 'open') {
    openCalls++;
    if (openCalls === 1) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'temporary failure' }));
      return;
    }
  }
  if (status === 'proposal_open') proposalCalls++;

  statusRequestTimes[status] = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const bounty = {
    id: `bounty-${status}`,
    title: `${status} bounty`,
    amount_usdc: 1,
    status,
    bounty_type: 'research',
    min_reputation: 0,
    deadline: '2026-08-01T00:00:00.000Z',
    selection_mode: status === 'proposal_open' ? 'proposal' : 'first_come',
  };
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    id: rpc.id,
    result: {
      content: [{ type: 'text', text: JSON.stringify({ bounties: [bounty] }) }],
    },
  }));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
await fs.mkdir(path.join(home, '.bard'), { recursive: true });
await fs.writeFile(path.join(home, '.bard', 'config.json'), JSON.stringify({
  token: 'test-token',
  mcpUrl: `http://127.0.0.1:${address.port}`,
}));

const env = {
  ...process.env,
  HOME: home,
  BARD_HTTP_TIMEOUT_MS: '2000',
  BARD_HTTP_RETRY_DELAY_MS: '25',
};

try {
  const listResult = await execFileAsync(process.execPath, [CLI, 'bounties'], { env });

  assert.equal(listResult.stderr, '');
  assert.match(listResult.stdout, /Bounties \(2\)/);
  assert.equal(openCalls, 2, 'read-only MCP calls should retry after a 503');
  assert.equal(proposalCalls, 1);
  assert.ok(
    Math.abs(statusRequestTimes.open - statusRequestTimes.proposal_open) < 150,
    'status requests should run in parallel'
  );

  const claimResult = await execFileAsync(
    process.execPath,
    [CLI, 'claim', 'bounty-test', '--json'],
    { env }
  );
  assert.equal(claimResult.stderr, '');
  const claim = JSON.parse(claimResult.stdout);
  assert.equal(claim.success, true);
  assert.equal(claim.bounty.id, 'bounty-test');

  await assert.rejects(
    execFileAsync(process.execPath, [CLI, 'claim', 'bounty-fail'], { env }),
    /Could not claim bounty-fail/
  );
  assert.equal(claimCalls, 2, 'mutation MCP calls must not be retried');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(home, { recursive: true, force: true });
}

console.log('CLI network resilience and claim tests passed');
