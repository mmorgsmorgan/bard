#!/usr/bin/env node
/**
 * End-to-end test for BARD hybrid bounty proposal mode.
 *
 * Exercises:
 *   1. Create proposal-mode bounty (status=proposal_open)
 *   2. Create agents A, B, C (each with their own JWT)
 *   3. A, B, C each submit a proposal
 *   4. UNIQUE constraint blocks A from a duplicate
 *   5. A updates own plan
 *   6. /claim is blocked in proposal mode
 *   7. Creator accepts B  ->  A and C auto-rejected, bounty amount becomes B's price
 *   8. Proposer C cannot withdraw a rejected proposal
 *   9. Creator <-> B message thread round-trips
 *  10. Fund with WRONG amount -> rejected
 *  11. Fund with EXACT amount (no on-chain tx, txHash omitted) -> auto-claims to B
 *  12. /cancel disallowed after escrow funded
 *
 * Usage: node test-proposals.mjs
 */

import 'dotenv/config';
import { randomBytes } from 'crypto';
import { privateKeyToAccount } from 'viem/accounts';
import pg from 'pg';

const API = process.env.BARD_API_URL || 'http://localhost:4001';
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', dim: '\x1b[2m',
};
const log = {
  test: (m) => console.log(`${c.cyan}▸${c.reset} ${m}`),
  ok: (m) => console.log(`  ${c.green}✓${c.reset} ${m}`),
  fail: (m) => console.log(`  ${c.red}✗${c.reset} ${m}`),
  info: (m) => console.log(`  ${c.dim}${m}${c.reset}`),
  warn: (m) => console.log(`  ${c.yellow}⚠${c.reset} ${m}`),
};

let passed = 0, failed = 0;
function assert(cond, name, detail) {
  if (cond) { passed++; log.ok(name); }
  else { failed++; log.fail(`${name}${detail ? ` — ${detail}` : ''}`); }
}

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data };
}

// Create a fresh wallet + agent + JWT for testing
async function createTestAgent(label) {
  const pk = '0x' + randomBytes(32).toString('hex');
  const account = privateKeyToAccount(pk);
  const wallet = account.address;

  // 1. Register agent
  const reg = await api('POST', '/api/agents/register', {
    ownerWallet: wallet,
    agentName: `test-${label}-${Date.now().toString(36)}`,
    agentPublicKey: wallet,
    agentType: 'general',
    description: `test agent ${label}`,
  });
  if (!reg.ok) throw new Error(`register failed for ${label}: ${JSON.stringify(reg.data)}`);
  const agentId = reg.data.agent.id;

  // 2. Get auth challenge
  const ch = await api('POST', '/api/auth/challenge', { agentId });
  if (!ch.ok) throw new Error(`challenge failed: ${JSON.stringify(ch.data)}`);

  // 3. Sign challenge message
  const signature = await account.signMessage({ message: ch.data.message });

  // 4. Verify and get JWT
  const v = await api('POST', '/api/auth/verify', {
    challengeId: ch.data.challengeId,
    signature,
    wallet,
  });
  if (!v.ok) throw new Error(`verify failed: ${JSON.stringify(v.data)}`);

  return { wallet, agentId, token: v.data.token, label, account };
}

async function run() {
  console.log(`\n${c.cyan}════ BARD Hybrid Bounty Test — Proposal Flow ════${c.reset}\n`);

  // Setup: 1 creator (no agent needed), 3 agents
  log.test('Setup: creating 4 test wallets and 3 agents');
  const creatorPk = '0x' + randomBytes(32).toString('hex');
  const creator = privateKeyToAccount(creatorPk);
  const [A, B, C] = await Promise.all([
    createTestAgent('A'),
    createTestAgent('B'),
    createTestAgent('C'),
  ]);
  log.info(`creator=${creator.address.slice(0, 10)}…`);
  log.info(`A=${A.agentId} wallet=${A.wallet.slice(0, 10)}…`);
  log.info(`B=${B.agentId} wallet=${B.wallet.slice(0, 10)}…`);
  log.info(`C=${C.agentId} wallet=${C.wallet.slice(0, 10)}…`);

  // Test stand-in for Turnkey: stamp a mock turnkey_address on each agent
  // so the fund-mode auto-claim guard passes. In production this is set by the
  // bard_create_wallet flow against a real Turnkey org.
  for (const ag of [A, B, C]) {
    await pool.query('UPDATE agents SET turnkey_address = $1 WHERE id = $2', [ag.wallet, ag.agentId]);
  }
  log.info('stamped mock turnkey_address on test agents');

  // ── Test 1: create proposal-mode bounty ────────────────
  log.test('\n1. Create proposal-mode bounty');
  const tomorrow = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
  const cb = await api('POST', '/api/bounties', {
    creatorWallet: creator.address,
    title: 'Test Proposal Bounty',
    description: 'Pitch your plan',
    bountyType: 'research',
    amountUsdc: '10',
    deadline: tomorrow,
    selectionMode: 'proposal',
  });
  assert(cb.ok, 'bounty created', cb.data?.error);
  assert(cb.data.bounty?.status === 'proposal_open',
    `status=proposal_open (got ${cb.data.bounty?.status})`);
  assert(cb.data.bounty?.selection_mode === 'proposal',
    'selection_mode=proposal');
  const bountyId = cb.data.bounty.id;
  log.info(`bountyId=${bountyId}`);

  // ── Test 2: each agent submits a proposal ──────────────
  log.test('\n2. Agents A, B, C submit proposals');
  const submitA = await api('POST', `/api/bounties/${bountyId}/proposals`,
    { plan: 'I will do this with method A. Lorem ipsum.', proposedPriceUsdc: 8, estimatedHours: 5 },
    A.token);
  assert(submitA.ok, 'A proposal submitted', submitA.data?.error);
  const proposalA = submitA.data.proposal?.id;

  const submitB = await api('POST', `/api/bounties/${bountyId}/proposals`,
    { plan: 'I will do this with method B. Better and faster.', proposedPriceUsdc: 6.5, estimatedHours: 3 },
    B.token);
  assert(submitB.ok, 'B proposal submitted', submitB.data?.error);
  const proposalB = submitB.data.proposal?.id;

  const submitC = await api('POST', `/api/bounties/${bountyId}/proposals`,
    { plan: 'I will do this with method C. Premium quality.', proposedPriceUsdc: 12, estimatedHours: 8 },
    C.token);
  assert(submitC.ok, 'C proposal submitted', submitC.data?.error);

  // ── Test 3: UNIQUE constraint blocks dup from A ────────
  log.test('\n3. Duplicate proposal from A is blocked');
  const dupA = await api('POST', `/api/bounties/${bountyId}/proposals`,
    { plan: 'Trying again', proposedPriceUsdc: 7, estimatedHours: 4 },
    A.token);
  assert(dupA.status === 409, `duplicate gets 409 (got ${dupA.status})`);
  assert(dupA.data?.existing_proposal_id === proposalA,
    'response includes existing_proposal_id');

  // ── Test 4: A updates own plan ─────────────────────────
  log.test('\n4. A updates own plan');
  const upd = await api('PUT', `/api/bounties/${bountyId}/proposals/${proposalA}`,
    { plan: 'I will do this with method A v2. Improved.', proposedPriceUsdc: 7.5 },
    A.token);
  assert(upd.ok, 'A update succeeds', upd.data?.error);
  assert(parseFloat(upd.data.proposal?.proposed_price_usdc) === 7.5, 'price updated to 7.5');

  // ── Test 5: /claim is blocked in proposal mode ─────────
  log.test('\n5. /claim blocked in proposal mode');
  const claimAttempt = await api('POST', `/api/bounties/${bountyId}/claim`,
    { agentId: A.agentId, callerWallet: A.wallet },
    A.token);
  assert(claimAttempt.status === 409,
    `claim returns 409 (got ${claimAttempt.status})`);
  assert(/proposal selection/i.test(claimAttempt.data?.error || ''),
    'error mentions proposal selection');

  // ── Test 6: list proposals (creator sees all) ──────────
  log.test('\n6. Creator lists proposals (sees all 3)');
  const listCreator = await api('GET',
    `/api/bounties/${bountyId}/proposals?callerWallet=${creator.address}`);
  assert(listCreator.ok, 'list ok');
  assert(listCreator.data?.isCreator === true, 'isCreator=true for creator');
  assert(listCreator.data?.proposals?.length === 3,
    `sees 3 proposals (got ${listCreator.data?.proposals?.length})`);

  // ── Test 7: B accepts → A and C auto-rejected ──────────
  log.test('\n7. Creator accepts B');
  const accept = await api('POST',
    `/api/bounties/${bountyId}/proposals/${proposalB}/accept`,
    { callerWallet: creator.address });
  assert(accept.ok, 'accept succeeds', accept.data?.error);
  assert(accept.data.rejectedProposalCount === 2,
    `2 other proposals auto-rejected (got ${accept.data?.rejectedProposalCount})`);
  assert(accept.data.bounty?.status === 'proposal_selected',
    `bounty status=proposal_selected (got ${accept.data.bounty?.status})`);
  assert(parseFloat(accept.data.bounty?.amount_usdc) === 6.5,
    `amount_usdc updated to B's price 6.5 (got ${accept.data.bounty?.amount_usdc})`);

  // ── Test 8: C cannot withdraw a rejected proposal ──────
  log.test('\n8. C cannot withdraw rejected proposal');
  const listC = await api('GET',
    `/api/bounties/${bountyId}/proposals?callerWallet=${C.wallet}`);
  const cProp = listC.data.proposals?.find(p =>
    (p.proposer_wallet || '').toLowerCase() === C.wallet.toLowerCase());
  assert(cProp?.status === 'rejected', `C proposal status=rejected (got ${cProp?.status})`);
  const withdraw = await api('DELETE',
    `/api/bounties/${bountyId}/proposals/${cProp.id}`,
    null, C.token);
  assert(withdraw.status === 409, `withdraw on rejected returns 409 (got ${withdraw.status})`);

  // ── Test 9: Message thread between creator and B ───────
  log.test('\n9. Creator <-> B message thread');
  const m1 = await api('POST', `/api/bounties/${bountyId}/messages`, {
    proposalId: proposalB,
    message: 'Hi B, can you confirm timeline?',
    callerWallet: creator.address,
  });
  assert(m1.ok, 'creator sends message', m1.data?.error);

  const m2 = await api('POST', `/api/bounties/${bountyId}/messages`, {
    proposalId: proposalB,
    message: 'Yes, 3 hours as proposed.',
    callerWallet: B.wallet,
    callerAgentId: B.agentId,
  });
  assert(m2.ok, 'B sends reply', m2.data?.error);

  const getMsgs = await api('GET',
    `/api/bounties/${bountyId}/messages?proposalId=${proposalB}&callerWallet=${creator.address}`);
  assert(getMsgs.ok && getMsgs.data?.messages?.length === 2,
    `creator reads 2 messages (got ${getMsgs.data?.messages?.length})`);

  // Outsider cannot read
  const outsiderRead = await api('GET',
    `/api/bounties/${bountyId}/messages?proposalId=${proposalB}&callerWallet=${A.wallet}`);
  assert(outsiderRead.status === 403,
    `A (rejected, not in thread) gets 403 (got ${outsiderRead.status})`);

  // ── Test 10: fund with wrong amount → rejected ─────────
  log.test('\n10. Fund with wrong amount fails');
  const fundWrong = await api('POST', `/api/bounties/${bountyId}/fund`, {
    clientWallet: creator.address,
    budgetUsdc: 10,  // bounty is now 6.5, this should fail
  });
  assert(fundWrong.status === 400,
    `wrong amount returns 400 (got ${fundWrong.status})`);
  assert(/match accepted proposal/i.test(fundWrong.data?.error || ''),
    'error mentions accepted proposal price');

  // ── Test 11: fund with exact amount → auto-claim to B ──
  log.test('\n11. Fund with exact amount auto-claims to B');
  // Note: passing no txHash skips on-chain verification (backward-compat path)
  const fund = await api('POST', `/api/bounties/${bountyId}/fund`, {
    clientWallet: creator.address,
    budgetUsdc: 6.5,
  });
  assert(fund.ok, 'fund succeeds', fund.data?.error);
  assert(fund.data.bounty?.escrow_status === 'claimed',
    `escrow_status=claimed (got ${fund.data.bounty?.escrow_status})`);
  assert(fund.data.bounty?.status === 'assigned',
    `status=assigned (got ${fund.data.bounty?.status})`);
  assert(fund.data.bounty?.provider_agent_id === B.agentId,
    `provider_agent_id=B (got ${fund.data.bounty?.provider_agent_id})`);

  // ── Test 12: cancel after funding is blocked ───────────
  log.test('\n12. Cancel after funding is blocked');
  const cancelLate = await api('POST', `/api/bounties/${bountyId}/cancel`,
    { creatorWallet: creator.address });
  assert(cancelLate.status === 409,
    `cancel after fund returns 409 (got ${cancelLate.status})`);

  // ── Summary ────────────────────────────────────────────
  console.log(`\n${c.cyan}════ Results ════${c.reset}`);
  console.log(`${c.green}Passed: ${passed}${c.reset}`);
  if (failed > 0) console.log(`${c.red}Failed: ${failed}${c.reset}`);
  const total = passed + failed;
  console.log(`Pass rate: ${((passed / total) * 100).toFixed(1)}% (${passed}/${total})\n`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (e) => {
  console.error(`\n${c.red}Test crashed:${c.reset}`, e);
  await pool.end().catch(() => {});
  process.exit(2);
});
