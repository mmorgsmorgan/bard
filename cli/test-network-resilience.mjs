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
let proposalSubmitCalls = 0;
let deliverableCalls = 0;
const statusRequestTimes = {};

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const tool = rpc.params?.name;
  const args = rpc.params?.arguments || {};

  if (tool === 'bard_get_bounty') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: rpc.id,
      result: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            bounty: {
              id: args.bountyId,
              title: 'Detailed test bounty',
              description: 'Inspect this before claiming.',
              status: 'open',
              selection_mode: 'first_come',
              amount_usdc: 5,
              min_reputation: 10,
              deadline: '2026-08-01T00:00:00.000Z',
              acceptance_criteria: [{ id: 'criterion-1', text: 'Return verified output' }],
            },
            events: [],
            decisions: [],
          }),
        }],
      },
    }));
    return;
  }

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

  if (tool === 'bard_submit_proposal') {
    proposalSubmitCalls++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: rpc.id,
      result: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: `Proposal submitted at ${args.proposedPriceUsdc} USDC.`,
            proposal: { id: 'proposal-test', ...args },
          }),
        }],
      },
    }));
    return;
  }

  if (tool === 'bard_submit_deliverable') {
    deliverableCalls++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: rpc.id,
      result: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'Deliverable submitted.',
            bounty: { id: args.bountyId, status: 'submitted' },
            received: args,
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
const proposalInput = path.join(home, 'proposal.json');
const deliverableInput = path.join(home, 'deliverable.json');
await fs.writeFile(proposalInput, JSON.stringify({
  plan: 'Inspect, implement, test, and report.',
  proposedPriceUsdc: 4,
  estimatedHours: 2,
}));
await fs.writeFile(deliverableInput, JSON.stringify({
  content: 'Completed work output.',
  summary: 'Implemented and tested.',
  evidence: [{ criterionId: 'criterion-1', proof: 'Test output passed.' }],
  testInstructions: 'Run npm test.',
  artifacts: [{ label: 'Repository', url: 'https://example.com/repo', type: 'repository' }],
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

  const detailsResult = await execFileAsync(
    process.execPath,
    [CLI, 'bounty', 'bounty-test', '--json'],
    { env }
  );
  const details = JSON.parse(detailsResult.stdout);
  assert.equal(details.bounty.id, 'bounty-test');
  assert.equal(details.bounty.acceptance_criteria[0].id, 'criterion-1');

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

  const proposalResult = await execFileAsync(
    process.execPath,
    [CLI, 'propose', 'bounty-proposal', '--input', proposalInput, '--json'],
    { env }
  );
  const proposal = JSON.parse(proposalResult.stdout);
  assert.equal(proposal.success, true);
  assert.equal(proposal.proposal.proposedPriceUsdc, 4);
  assert.equal(proposalSubmitCalls, 1);

  const deliverableResult = await execFileAsync(
    process.execPath,
    [CLI, 'submit', 'bounty-test', '--input', deliverableInput, '--json'],
    { env }
  );
  const deliverable = JSON.parse(deliverableResult.stdout);
  assert.equal(deliverable.success, true);
  assert.equal(deliverable.received.evidence[0].criterionId, 'criterion-1');
  assert.equal(deliverable.received.artifacts[0].type, 'repository');
  assert.equal(deliverableCalls, 1);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(home, { recursive: true, force: true });
}

console.log('CLI network resilience and claim tests passed');
