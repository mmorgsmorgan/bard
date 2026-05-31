#!/usr/bin/env node
/**
 * Full agentic flow test for BARD hybrid bounty proposal mode.
 *
 * Where `test-proposals.mjs` stops at the fund/auto-claim step, this test
 * runs the ENTIRE agentic loop through to on-chain payout:
 *
 *   1. Creator posts a proposal-mode bounty
 *   2. Three agents submit proposals at different prices
 *   3. Creator + winning proposer exchange messages
 *   4. Creator accepts one proposal (others auto-reject, price snapshots)
 *   5. Creator funds the agreed price → bounty auto-assigns to selected agent
 *   6. Winning agent submits the deliverable
 *   7. Creator reviews → approves
 *   8. Platform verifier releases escrow → real USDC transfer (when Turnkey)
 *   9. Assert: agent USDC balance increased by the agreed price
 *  10. Assert: bounty status=completed, escrow_status=released, has release_tx_hash
 *  11. Assert: agent reputation +15, total_earned_usdc bumped
 *  12. Assert: escrow_events audit trail contains the full chain
 *
 * If Turnkey is not configured locally, step 8's on-chain transfer will
 * fail cleanly (this is the expected guard behavior). The test then
 * verifies the failure message and marks on-chain assertions as skipped
 * while still passing the DB-level assertions. To run with a real payout:
 *
 *   - Set TURNKEY_API_PRIVATE_KEY, TURNKEY_API_PUBLIC_KEY, TURNKEY_ORGANIZATION_ID
 *   - Fund the platform wallet (SELLER_ADDRESS) with USDC on Arc Testnet
 *
 * Usage: node test-hybrid-flow.mjs
 */

import 'dotenv/config';
import { randomBytes } from 'crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http } from 'viem';
import pg from 'pg';

const API = process.env.BARD_API_URL || 'http://localhost:4001';
const ARC_RPC = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const USDC = (process.env.USDC_CONTRACT_ADDRESS || '0x3600000000000000000000000000000000000000');
const ARC_CHAIN_ID = 5042002;

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const arcTestnet = {
  id: ARC_CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: { default: { http: [ARC_RPC] } },
};

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
  skip: (m) => console.log(`  ${c.yellow}↷ SKIP${c.reset} ${m}`),
};

let passed = 0, failed = 0, skipped = 0;
function assert(cond, name, detail) {
  if (cond) { passed++; log.ok(name); }
  else { failed++; log.fail(`${name}${detail ? ` — ${detail}` : ''}`); }
}
function skip(name, reason) { skipped++; log.skip(`${name}${reason ? ` (${reason})` : ''}`); }

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

async function createTestAgent(label) {
  const pk = '0x' + randomBytes(32).toString('hex');
  const account = privateKeyToAccount(pk);
  const wallet = account.address;
  const reg = await api('POST', '/api/agents/register', {
    ownerWallet: wallet,
    agentName: `hybrid-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
    agentPublicKey: wallet,
    agentType: 'general',
    description: `hybrid-flow test agent ${label}`,
  });
  if (!reg.ok) throw new Error(`register ${label}: ${JSON.stringify(reg.data)}`);
  const agentId = reg.data.agent.id;
  const ch = await api('POST', '/api/auth/challenge', { agentId });
  const signature = await account.signMessage({ message: ch.data.message });
  const v = await api('POST', '/api/auth/verify', {
    challengeId: ch.data.challengeId, signature, wallet,
  });
  if (!v.ok) throw new Error(`verify ${label}: ${JSON.stringify(v.data)}`);
  return { wallet, agentId, token: v.data.token, label, account };
}

// USDC balance read (no Turnkey needed, public RPC)
const ERC20_BAL_ABI = [{
  name: 'balanceOf', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'a', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}];
async function usdcBalance(client, addr) {
  try {
    const raw = await client.readContract({
      address: USDC, abi: ERC20_BAL_ABI, functionName: 'balanceOf', args: [addr],
    });
    return Number(raw) / 1_000_000;
  } catch (e) {
    return null;
  }
}

async function run() {
  console.log(`\n${c.cyan}════ BARD Hybrid Flow — Proposal → On-Chain Payout ════${c.reset}\n`);

  // ── Pre-flight ─────────────────────────────────────────
  log.test('0. Pre-flight: detect environment');
  const health = await api('GET', '/api/health');
  if (!health.ok) {
    log.fail(`backend not reachable at ${API}`);
    process.exit(2);
  }
  const turnkeyEnabled = health.data.turnkey === true;
  const platformWallet = health.data.sellerAddress;
  log.info(`API: ${API}`);
  log.info(`Turnkey enabled: ${turnkeyEnabled}`);
  log.info(`Platform wallet: ${platformWallet}`);
  log.info(`USDC contract: ${USDC}`);

  let pubClient = null;
  let platformBalanceStart = null;
  try {
    pubClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_RPC) });
    platformBalanceStart = await usdcBalance(pubClient, platformWallet);
    log.info(`Platform USDC balance: ${platformBalanceStart != null ? platformBalanceStart.toFixed(6) : 'unreadable'}`);
  } catch (e) {
    log.warn(`RPC unreachable: ${e.message} — on-chain assertions will be skipped`);
  }
  const canDoOnChain = turnkeyEnabled && platformBalanceStart != null && platformBalanceStart >= 10;
  if (!canDoOnChain) {
    log.warn(`On-chain assertions DISABLED (turnkey=${turnkeyEnabled}, platform_balance=${platformBalanceStart})`);
    log.info(`The test will still verify all DB state transitions through client_approved,`);
    log.info(`and confirm platform-verify fails cleanly with the expected guard error.`);
  }

  // ── Setup ──────────────────────────────────────────────
  log.test('\n1. Setup: 1 creator + 3 agents (A, B, C)');
  const creator = privateKeyToAccount('0x' + randomBytes(32).toString('hex'));
  const [A, B, C] = await Promise.all([
    createTestAgent('A'), createTestAgent('B'), createTestAgent('C'),
  ]);
  log.info(`creator=${creator.address}`);
  log.info(`A=${A.agentId} wallet=${A.wallet}`);
  log.info(`B=${B.agentId} wallet=${B.wallet}`);
  log.info(`C=${C.agentId} wallet=${C.wallet}`);

  // Stamp mock turnkey_address so fund auto-claim guard passes.
  // In production this is set by bard_create_wallet against a real Turnkey org.
  for (const a of [A, B, C]) {
    await pool.query('UPDATE agents SET turnkey_address = $1 WHERE id = $2', [a.wallet, a.agentId]);
  }
  log.info('stamped mock turnkey_address on A, B, C');

  // ── 2. Create proposal-mode bounty ─────────────────────
  log.test('\n2. Create proposal-mode bounty');
  const cb = await api('POST', '/api/bounties', {
    creatorWallet: creator.address,
    title: 'Full Hybrid Flow Test',
    description: 'End-to-end: propose → accept → fund → deliver → release',
    bountyType: 'research',
    amountUsdc: '20',  // budget cap
    deadline: new Date(Date.now() + 7 * 86400e3).toISOString(),
    selectionMode: 'proposal',
  });
  assert(cb.ok, 'bounty created', cb.data?.error);
  assert(cb.data.bounty?.status === 'proposal_open', `status=proposal_open (got ${cb.data.bounty?.status})`);
  const bountyId = cb.data.bounty.id;

  // ── 3. Three proposals at different prices ─────────────
  log.test('\n3. A, B, C submit proposals at $9, $7.5, $12');
  const submits = await Promise.all([
    api('POST', `/api/bounties/${bountyId}/proposals`, {
      plan: 'Approach A: thorough investigation with citations.',
      proposedPriceUsdc: 9, estimatedHours: 5,
    }, A.token),
    api('POST', `/api/bounties/${bountyId}/proposals`, {
      plan: 'Approach B: focused analysis, faster turnaround.',
      proposedPriceUsdc: 7.5, estimatedHours: 3,
    }, B.token),
    api('POST', `/api/bounties/${bountyId}/proposals`, {
      plan: 'Approach C: premium deliverable with extras.',
      proposedPriceUsdc: 12, estimatedHours: 8,
    }, C.token),
  ]);
  const [pA, pB, pC] = submits.map(s => s.data.proposal?.id);
  assert(submits.every(s => s.ok), 'all three proposals submitted');
  assert(pA && pB && pC, 'three proposal IDs returned');

  // ── 4. Messages: creator <-> B ─────────────────────────
  log.test('\n4. Creator and B exchange messages');
  const m1 = await api('POST', `/api/bounties/${bountyId}/messages`, {
    proposalId: pB, message: 'Hi B, can you commit to 3 hours?', callerWallet: creator.address,
  });
  const m2 = await api('POST', `/api/bounties/${bountyId}/messages`, {
    proposalId: pB, message: 'Yes — 3 hours confirmed.',
    callerWallet: B.wallet, callerAgentId: B.agentId,
  });
  assert(m1.ok && m2.ok, 'both directions of thread send', m1.data?.error || m2.data?.error);

  // ── 5. Creator accepts B ────────────────────────────────
  log.test(`\n5. Creator accepts B's proposal ($7.5)`);
  const acc = await api('POST', `/api/bounties/${bountyId}/proposals/${pB}/accept`, {
    callerWallet: creator.address,
  });
  assert(acc.ok, 'accept succeeds', acc.data?.error);
  assert(acc.data.bounty?.status === 'proposal_selected',
    `status=proposal_selected (got ${acc.data.bounty?.status})`);
  assert(parseFloat(acc.data.bounty?.amount_usdc) === 7.5,
    `amount_usdc snapshotted to 7.5 (got ${acc.data.bounty?.amount_usdc})`);
  assert(acc.data.rejectedProposalCount === 2, '2 siblings auto-rejected');

  // ── 6. Fund the agreed price → auto-claim to B ─────────
  log.test('\n6. Creator funds bounty at $7.5 (auto-claims to B)');
  const fund = await api('POST', `/api/bounties/${bountyId}/fund`, {
    clientWallet: creator.address, budgetUsdc: 7.5,
  });
  assert(fund.ok, 'fund succeeds', fund.data?.error);
  assert(fund.data.bounty?.escrow_status === 'claimed',
    `escrow_status=claimed (got ${fund.data.bounty?.escrow_status})`);
  assert(fund.data.bounty?.status === 'assigned',
    `bounty status=assigned (got ${fund.data.bounty?.status})`);
  assert(fund.data.bounty?.provider_agent_id === B.agentId,
    `provider_agent_id=B (got ${fund.data.bounty?.provider_agent_id})`);

  // ── 7. B submits deliverable ────────────────────────────
  log.test('\n7. B submits the deliverable');
  const deliverContent = 'Final report: detailed analysis of the topic with key findings, recommendations, and references. ' +
    'Includes data sources, methodology notes, and a one-page executive summary.';
  const deliver = await api('POST', `/api/bounties/${bountyId}/deliver`, {
    agentId: B.agentId,
    content: deliverContent,
    callerWallet: B.wallet,
  }, B.token);
  assert(deliver.ok, 'deliver succeeds', deliver.data?.error);
  assert(deliver.data.bounty?.escrow_status === 'submitted',
    `escrow_status=submitted (got ${deliver.data.bounty?.escrow_status})`);

  // ── 8. Creator reviews → approves ───────────────────────
  log.test('\n8. Creator approves the deliverable');
  const review = await api('POST', `/api/bounties/${bountyId}/review`, {
    clientWallet: creator.address,
    decision: 'approved',
    reason: 'Excellent work, all requirements met.',
  });
  assert(review.ok, 'review succeeds', review.data?.error);
  assert(review.data.bounty?.escrow_status === 'client_approved',
    `escrow_status=client_approved (got ${review.data.bounty?.escrow_status})`);

  // ── 9. Platform verifies → release USDC ─────────────────
  log.test('\n9. Platform verifier releases escrow');
  log.info(`  using platform owner wallet: ${platformWallet}`);

  // Snapshot agent stats before release
  const agentBefore = (await pool.query('SELECT reputation_score, total_earned_usdc FROM agents WHERE id = $1', [B.agentId])).rows[0];
  const agentBalBefore = pubClient ? await usdcBalance(pubClient, B.wallet) : null;
  log.info(`  agent rep before: ${agentBefore?.reputation_score}, earned: ${agentBefore?.total_earned_usdc}`);
  if (agentBalBefore != null) log.info(`  agent USDC balance before: ${agentBalBefore.toFixed(6)}`);

  const verify = await api('POST', `/api/bounties/${bountyId}/platform-verify`, {
    verifierWallet: platformWallet,
    decision: 'approved',
    reasoning: 'All quality checks passed. Released.',
  });

  if (canDoOnChain) {
    // ── 10a. On-chain happy path ──────────────────────────
    assert(verify.ok, 'platform-verify succeeds (real payout)', verify.data?.error);
    assert(verify.data.bounty?.escrow_status === 'released',
      `escrow_status=released (got ${verify.data.bounty?.escrow_status})`);
    assert(verify.data.bounty?.status === 'completed',
      `bounty status=completed (got ${verify.data.bounty?.status})`);
    assert(!!verify.data.bounty?.release_tx_hash,
      'release_tx_hash recorded');
    log.info(`  release tx: ${verify.data.bounty?.release_tx_hash}`);

    // 10b. Agent USDC delta (after a brief settle window)
    await new Promise(r => setTimeout(r, 5000));
    const agentBalAfter = await usdcBalance(pubClient, B.wallet);
    log.info(`  agent USDC balance after: ${agentBalAfter?.toFixed(6)}`);
    const delta = agentBalAfter != null && agentBalBefore != null ? agentBalAfter - agentBalBefore : null;
    log.info(`  delta: ${delta?.toFixed(6)} USDC (expected ~7.5)`);
    assert(delta != null && Math.abs(delta - 7.5) < 0.01,
      `agent received ~7.5 USDC on-chain (delta=${delta?.toFixed(6)})`);
  } else {
    // ── 10c. Graceful-skip path ───────────────────────────
    // Without Turnkey or platform balance the transferUSDCFromPlatform call inside the
    // platform-verify transaction throws, the tx rolls back, and we get a 409 back.
    assert(verify.status === 409,
      `platform-verify returns 409 when on-chain transfer unavailable (got ${verify.status})`);
    const err = (verify.data?.error || '').toLowerCase();
    assert(
      err.includes('turnkey') || err.includes('insufficient') || err.includes('balance') || err.includes('platform wallet'),
      'error message mentions turnkey or platform balance', verify.data?.error
    );
    skip('on-chain USDC delta assertion', 'turnkey or platform balance unavailable');

    // Verify the bounty rolled back cleanly (still in client_approved, not stuck in mid-state)
    const rolled = await api('GET', `/api/bounties/${bountyId}/escrow`);
    assert(rolled.data?.bounty?.escrow_status === 'client_approved',
      `bounty rolled back to client_approved (got ${rolled.data?.bounty?.escrow_status})`);
    assert(!rolled.data?.bounty?.release_tx_hash,
      'no spurious release_tx_hash recorded on rolled-back tx');
  }

  // ── 11. Agent stats (only meaningful on happy path) ─────
  if (canDoOnChain) {
    log.test('\n11. Agent reputation and earnings updated');
    const agentAfter = (await pool.query('SELECT reputation_score, total_earned_usdc FROM agents WHERE id = $1', [B.agentId])).rows[0];
    log.info(`  rep after: ${agentAfter?.reputation_score} (was ${agentBefore?.reputation_score})`);
    log.info(`  earned after: ${agentAfter?.total_earned_usdc} (was ${agentBefore?.total_earned_usdc})`);
    assert(agentAfter?.reputation_score >= agentBefore?.reputation_score + 15 || agentAfter?.reputation_score === 100,
      'reputation +15 (or capped at 100)');
    assert(
      parseFloat(agentAfter?.total_earned_usdc) >= parseFloat(agentBefore?.total_earned_usdc) + 7.49,
      `total_earned_usdc bumped by ~7.5 (got +${(parseFloat(agentAfter?.total_earned_usdc) - parseFloat(agentBefore?.total_earned_usdc)).toFixed(2)})`
    );
  }

  // ── 12. Escrow audit trail ─────────────────────────────
  log.test('\n12. Escrow event audit trail is complete');
  const events = await api('GET', `/api/bounties/${bountyId}/events`);
  const types = (events.data?.events || []).map(e => e.event_type);
  log.info(`  events: [${types.join(', ')}]`);
  // Funded + submitted + client_approved should always be present
  assert(types.includes('submitted'), 'audit has submitted event');
  assert(types.includes('client_approved'), 'audit has client_approved event');
  if (canDoOnChain) {
    assert(types.includes('verified'), 'audit has verified event');
    assert(types.includes('released'), 'audit has released event');
  }

  // ── Summary ─────────────────────────────────────────────
  console.log(`\n${c.cyan}════ Results ════${c.reset}`);
  console.log(`${c.green}Passed: ${passed}${c.reset}`);
  if (failed > 0) console.log(`${c.red}Failed: ${failed}${c.reset}`);
  if (skipped > 0) console.log(`${c.yellow}Skipped: ${skipped}${c.reset}`);
  const total = passed + failed;
  console.log(`Pass rate: ${total > 0 ? ((passed / total) * 100).toFixed(1) : 0}% (${passed}/${total})`);
  if (skipped > 0 && !canDoOnChain) {
    console.log(`\n${c.yellow}Note:${c.reset} On-chain assertions were skipped because Turnkey isn't configured`);
    console.log(`(or the platform wallet has insufficient USDC). The DB state machine and the`);
    console.log(`platform-verify guard behavior were still fully validated. To run the on-chain`);
    console.log(`tail, configure TURNKEY_* env vars and fund the platform wallet.\n`);
  } else {
    console.log('');
  }
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (e) => {
  console.error(`\n${c.red}Test crashed:${c.reset}`, e);
  await pool.end().catch(() => {});
  process.exit(2);
});
