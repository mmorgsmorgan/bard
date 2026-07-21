import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { BardAgent, buildProofHash } from '../src/index.ts';

function toolResult(value) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text: JSON.stringify(value) }],
    },
  };
}

test('BardAgent routes authenticated operations through MCP tools', async (t) => {
  const calls = [];
  const responses = {
    bard_get_identity: {
      agentId: 'agent-sdk-test',
      agent: {
        id: 'agent-sdk-test',
        agentName: 'SDK Test',
      },
      reputation: {
        agentId: 'agent-sdk-test',
        agentName: 'SDK Test',
        score: 7,
        tier: 'Newcomer',
      },
    },
    bard_get_reputation: {
      agentId: 'agent-sdk-test',
      agentName: 'SDK Test',
      score: 7,
      tier: 'Newcomer',
    },
    bard_commit_reasoning: {
      commitmentId: 'commit-sdk-test',
      hash: '0xcommit',
      salt: '0xsalt',
    },
    bard_reveal_reasoning: {
      success: true,
      verified: true,
      commitmentId: 'commit-sdk-test',
    },
    bard_submit_contribution: {
      contribution: {
        id: 'contrib-sdk-test',
        agentId: 'agent-sdk-test',
        status: 'pending',
      },
      reputation: {
        score: 9,
        tier: 'Newcomer',
      },
    },
    bard_list_my_contributions: {
      contributions: [{ id: 'contrib-sdk-test' }],
    },
    bard_list_bounties: {
      bounties: [{ id: 'bounty-sdk-test', status: 'open' }],
    },
    bard_claim_bounty: {
      success: true,
      bounty: { id: 'bounty-sdk-test', status: 'assigned' },
    },
    bard_submit_deliverable: {
      success: true,
      bounty: { id: 'bounty-sdk-test', status: 'submitted' },
    },
    bard_save_agent_state: {
      success: true,
    },
    bard_get_agent_state: {
      state: { context: { cursor: 12 } },
    },
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const rpc = JSON.parse(body);
      const tool = rpc.params?.name;
      calls.push({
        tool,
        args: rpc.params?.arguments,
        authorization: req.headers.authorization,
      });
      const response = responses[tool];
      res.writeHead(response ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response
        ? { ...toolResult(response), id: rpc.id }
        : { jsonrpc: '2.0', id: rpc.id, error: { message: `Unexpected tool ${tool}` } }
      ));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.equal(typeof address, 'object');
  const agent = new BardAgent({
    agentId: 'agent-sdk-test',
    token: 'sdk-test-token',
    mcpUrl: `http://127.0.0.1:${address.port}`,
  });

  assert.equal((await agent.getProfile())?.agent.id, 'agent-sdk-test');
  assert.equal((await agent.getReputation())?.score, 7);

  const committed = await agent.commit('Inspect the transport');
  assert.equal(committed.commitment.salt, '0xsalt');
  assert.equal(await agent.reveal(committed.commitmentId), true);

  const contribution = await agent.submitContribution({
    type: 'research',
    description: 'SDK MCP transport test',
    proof: { result: 'verified' },
  });
  assert.equal(contribution.id, 'contrib-sdk-test');
  assert.equal((await agent.getContributions()).length, 1);
  assert.equal((await agent.listBounties()).length, 1);
  assert.equal((await agent.acceptBounty('bounty-sdk-test'))?.status, 'assigned');
  assert.equal(
    (await agent.submitDeliverable('bounty-sdk-test', 'Completed work')).bounty?.status,
    'submitted'
  );

  await agent.saveState({ cursor: 12 });
  assert.deepEqual(await agent.loadState(), { cursor: 12 });
  await assert.rejects(
    agent.submitBountyWork('bounty-sdk-test', 'contrib-sdk-test'),
    /submitDeliverable/
  );

  assert.deepEqual(
    calls.map((call) => call.tool),
    [
      'bard_get_identity',
      'bard_get_reputation',
      'bard_commit_reasoning',
      'bard_reveal_reasoning',
      'bard_submit_contribution',
      'bard_list_my_contributions',
      'bard_list_bounties',
      'bard_claim_bounty',
      'bard_submit_deliverable',
      'bard_save_agent_state',
      'bard_get_agent_state',
    ]
  );
  assert.ok(calls.every((call) => call.authorization === 'Bearer sdk-test-token'));
  assert.deepEqual(calls[3].args, {
    commitmentId: 'commit-sdk-test',
    reasoning: 'Inspect the transport',
    salt: '0xsalt',
  });
  assert.equal(calls[4].args.proof, JSON.stringify({ result: 'verified' }));
  assert.equal(
    buildProofHash({ result: 'verified' }),
    `0x${await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(JSON.stringify({ result: 'verified' })).digest('hex')
    )}`
  );
});
