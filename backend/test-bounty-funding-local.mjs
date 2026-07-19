#!/usr/bin/env node
import 'dotenv/config';

const API = (process.env.BARD_API || 'http://127.0.0.1:4001').replace(/\/$/, '');
let pass = 0;

function expect(condition, message) {
  if (!condition) throw new Error(message);
  pass += 1;
  console.log(`  PASS ${message}`);
}

async function request(path, { token, ...init } = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: response.ok, status: response.status, data };
}

async function provision(label) {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const registered = await request('/api/agents/register', {
    method: 'POST',
    body: JSON.stringify({
      ownerWallet: '0x0000000000000000000000000000000000000000',
      agentName: `${label}-${stamp}`,
      agentPublicKey: `managed-pending-${stamp}`,
      agentType: 'research',
      description: 'local bounty funding regression test',
    }),
  });
  if (!registered.ok) throw new Error(`register ${label}: ${registered.data.error}`);
  const id = registered.data.agent?.id || registered.data.agentId;
  const token = registered.data.token;
  let wallet;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    wallet = await request(`/api/agents/${id}/wallet`, {
      method: 'POST',
      token,
      body: '{}',
    });
    if (wallet.ok) break;
    await new Promise(resolve => setTimeout(resolve, attempt * 1_000));
  }
  if (!wallet.ok) throw new Error(`wallet ${label}: ${wallet.data.error}`);
  return { id, token, wallet: wallet.data.address, name: `${label}-${stamp}` };
}

async function balance(agent) {
  const result = await request(`/api/agents/${agent.id}/wallet-balance`, {
    token: agent.token,
  });
  if (!result.ok) throw new Error(`balance ${agent.name}: ${result.data.error}`);
  return Number(result.data.balanceUsdc);
}

async function platformBalance() {
  const result = await request('/api/platform/wallet/balance');
  if (!result.ok) throw new Error(`platform balance: ${result.data.error}`);
  return Number(result.data.balance_usdc);
}

async function waitForBalance(agent, minimum, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await balance(agent);
    if (current >= minimum) return current;
    await new Promise(resolve => setTimeout(resolve, 3_000));
  }
  throw new Error(`faucet balance did not reach ${minimum} USDC`);
}

async function createBounty(creator, selectionMode, amountUsdc, suffix) {
  return request('/api/bounties', {
    method: 'POST',
    token: creator.token,
    body: JSON.stringify({
      title: `Funding regression ${suffix} ${Date.now()}`,
      description: 'Exercises real managed-wallet bounty funding.',
      bountyType: 'research',
      amountUsdc,
      deadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      selectionMode,
    }),
  });
}

async function submitProposal(agent, bountyId, price) {
  return request(`/api/bounties/${bountyId}/proposals`, {
    method: 'POST',
    token: agent.token,
    body: JSON.stringify({
      plan: `Complete regression-test plan from ${agent.name}`,
      proposedPriceUsdc: price,
      estimatedHours: 1,
    }),
  });
}

async function run() {
  console.log(`BARD bounty funding regression test: ${API}`);
  const [creator, bidderA, bidderB, stranger, empty] = await Promise.all([
    provision('fund-creator'),
    provision('fund-bidder-a'),
    provision('fund-bidder-b'),
    provision('fund-stranger'),
    provision('fund-empty'),
  ]);

  const faucet = await request(`/api/agents/${creator.id}/claim-faucet`, {
    method: 'POST',
    token: creator.token,
    body: JSON.stringify({ blockchain: 'ARC-TESTNET', usdc: true }),
  });
  if (!faucet.ok) {
    const health = await request('/api/health');
    const seed = await request('/api/admin/platform-send', {
      method: 'POST',
      body: JSON.stringify({
        callerWallet: health.data.sellerAddress,
        to: creator.wallet,
        amountUsdc: 10,
      }),
    });
    if (!seed.ok) {
      throw new Error(`creator funding failed: faucet=${faucet.data.error}; seed=${seed.data.error}`);
    }
  }
  await waitForBalance(creator, 8);

  const emptyCreate = await createBounty(empty, 'first_come', 1, 'insufficient');
  expect(!emptyCreate.ok, 'insufficient balance prevents first-come publication');

  const beforeFirst = await balance(creator);
  const platformBeforeFirst = await platformBalance();
  const first = await createBounty(creator, 'first_come', 1, 'first-come');
  if (!first.ok) {
    throw new Error(`first-come creation failed (${first.status}): ${JSON.stringify(first.data)}`);
  }
  expect(first.ok, 'first-come creation succeeds');
  expect(first.data.funded === true, 'first-come creation reports automatic funding');
  expect(first.data.bounty?.status === 'open' && first.data.bounty?.escrow_status === 'funded',
    'first-come bounty publishes only after funding');
  const afterFirst = await balance(creator);
  expect(beforeFirst - afterFirst >= 1 && beforeFirst - afterFirst < 1.05,
    'creator balance decreases by the amount plus bounded Arc gas');
  expect(Math.abs((await platformBalance() - platformBeforeFirst) - 1) < 0.000001,
    'platform escrow balance increases by the exact first-come amount');

  const ownClaim = await request(`/api/bounties/${first.data.bounty.id}/claim`, {
    method: 'POST',
    token: creator.token,
    body: '{}',
  });
  expect(ownClaim.status === 409, 'creator agent cannot claim its own bounty');

  const claims = await Promise.all([
    request(`/api/bounties/${first.data.bounty.id}/claim`, {
      method: 'POST', token: bidderA.token, body: '{}',
    }),
    request(`/api/bounties/${first.data.bounty.id}/claim`, {
      method: 'POST', token: bidderB.token, body: '{}',
    }),
  ]);
  expect(claims.filter(result => result.ok).length === 1,
    'parallel claims produce exactly one winner');
  const cancelClaimed = await request(`/api/bounties/${first.data.bounty.id}/cancel`, {
    method: 'POST', token: creator.token, body: '{}',
  });
  expect(cancelClaimed.status === 409, 'claimed bounty cannot be cancelled');

  const beforeProposal = await balance(creator);
  const proposal = await createBounty(creator, 'proposal', 5, 'proposal');
  expect(proposal.ok && proposal.data.bounty?.status === 'proposal_open',
    'proposal bounty opens without funding');
  expect(Math.abs((await balance(creator)) - beforeProposal) < 0.000001,
    'proposal creation does not move funds');
  const ownProposal = await submitProposal(creator, proposal.data.bounty.id, 2);
  expect(ownProposal.status === 409, 'creator agent cannot propose on its own bounty');
  const bid = await submitProposal(bidderA, proposal.data.bounty.id, 2);
  expect(bid.ok, 'another agent can submit a proposal');

  const spoofAccept = await request(
    `/api/bounties/${proposal.data.bounty.id}/proposals/${bid.data.proposal.id}/accept`,
    {
      method: 'POST',
      token: stranger.token,
      body: JSON.stringify({ callerWallet: creator.wallet }),
    }
  );
  expect(spoofAccept.status === 403, 'spoofed creator wallet cannot accept a proposal');
  const accept = await request(
    `/api/bounties/${proposal.data.bounty.id}/proposals/${bid.data.proposal.id}/accept`,
    { method: 'POST', token: creator.token, body: '{}' }
  );
  expect(accept.ok && Number(accept.data.bounty?.amount_usdc) === 2,
    'accepted proposal snapshots the accepted price');

  const beforeFund = await balance(creator);
  const platformBeforeFund = await platformBalance();
  const funds = await Promise.all([
    request(`/api/bounties/${proposal.data.bounty.id}/fund`, {
      method: 'POST', token: creator.token, body: JSON.stringify({ budgetUsdc: 2 }),
    }),
    request(`/api/bounties/${proposal.data.bounty.id}/fund`, {
      method: 'POST', token: creator.token, body: JSON.stringify({ budgetUsdc: 2 }),
    }),
  ]);
  expect(funds.filter(result => result.ok).length === 1,
    'simultaneous funding requests move funds once');
  const funded = funds.find(result => result.ok);
  expect(beforeFund - await balance(creator) >= 2 && beforeFund - await balance(creator) < 2.05,
    'creator pays the accepted price plus bounded Arc gas');
  expect(Math.abs((await platformBalance() - platformBeforeFund) - 2) < 0.000001,
    'proposal escrow receives the accepted price, not the budget hint');

  const replayBounty = await createBounty(creator, 'proposal', 9, 'replay');
  const replayBid = await submitProposal(bidderB, replayBounty.data.bounty.id, 2);
  await request(
    `/api/bounties/${replayBounty.data.bounty.id}/proposals/${replayBid.data.proposal.id}/accept`,
    { method: 'POST', token: creator.token, body: '{}' }
  );
  const replay = await request(`/api/bounties/${replayBounty.data.bounty.id}/fund`, {
    method: 'POST',
    token: creator.token,
    body: JSON.stringify({ budgetUsdc: 2, txHash: funded.data.txHash }),
  });
  expect(replay.status === 409, 'same transaction hash cannot fund two bounties');

  const refundable = await createBounty(creator, 'first_come', 1, 'refund');
  const beforeRefund = await balance(creator);
  const platformBeforeRefund = await platformBalance();
  const cancelled = await request(`/api/bounties/${refundable.data.bounty.id}/cancel`, {
    method: 'POST',
    token: creator.token,
    body: '{}',
  });
  expect(cancelled.ok && cancelled.data.refunded === true,
    'funded unclaimed first-come cancellation refunds the funder');
  expect(Math.abs((await balance(creator) - beforeRefund) - 1) < 0.000001,
    'cancellation returns the exact funded amount');
  expect(Math.abs((platformBeforeRefund - await platformBalance()) - 1) < 0.05,
    'platform escrow sends one refund without a duplicate transfer');
  const cancelAgain = await request(`/api/bounties/${refundable.data.bounty.id}/cancel`, {
    method: 'POST',
    token: creator.token,
    body: JSON.stringify({ txHash: cancelled.data.txHash }),
  });
  expect(cancelAgain.ok && cancelAgain.data.txHash === cancelled.data.txHash,
    'refund reconciliation is idempotent');

  console.log(`Completed: ${pass} assertions passed.`);
}

run().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
