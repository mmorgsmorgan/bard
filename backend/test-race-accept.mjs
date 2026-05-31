#!/usr/bin/env node
/**
 * Race condition test for hybrid bounty proposal accept.
 *
 * Verifies that BEGIN/COMMIT + FOR UPDATE row locks in the accept endpoint
 * serialize correctly under contention. Exactly one accept call should win;
 * all others must get HTTP 409 with a clear error.
 *
 * Spawns 5 agents, all submit proposals, then fires 5 PARALLEL accept calls
 * (one per proposal) from the creator. Expectation:
 *   - exactly 1 returns 200
 *   - 4 return 409 (or 400 with state-changed error)
 *   - bounty.amount_usdc snapshots to the winning proposal's price
 *
 * Usage: node test-race-accept.mjs
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

async function createTestAgent(label) {
  const pk = '0x' + randomBytes(32).toString('hex');
  const account = privateKeyToAccount(pk);
  const wallet = account.address;
  const reg = await api('POST', '/api/agents/register', {
    ownerWallet: wallet,
    agentName: `race-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
    agentPublicKey: wallet,
    agentType: 'general',
    description: `race-test agent ${label}`,
  });
  if (!reg.ok) throw new Error(`register: ${JSON.stringify(reg.data)}`);
  const agentId = reg.data.agent.id;
  const ch = await api('POST', '/api/auth/challenge', { agentId });
  const signature = await account.signMessage({ message: ch.data.message });
  const v = await api('POST', '/api/auth/verify', {
    challengeId: ch.data.challengeId, signature, wallet,
  });
  if (!v.ok) throw new Error(`verify: ${JSON.stringify(v.data)}`);
  return { wallet, agentId, token: v.data.token, label, account };
}

async function run() {
  console.log(`\n${c.cyan}════ Race Condition Test — Concurrent Accept ════${c.reset}\n`);

  const N = 5;
  log.test(`Setup: 1 creator + ${N} agents`);
  const creator = privateKeyToAccount('0x' + randomBytes(32).toString('hex'));
  const agents = await Promise.all(
    Array.from({ length: N }, (_, i) => createTestAgent(`R${i}`))
  );
  log.info(`creator=${creator.address.slice(0, 10)}…`);

  // Stamp turnkey_address so the fund auto-claim guard wouldn't matter
  // (we don't fund in this test, but be consistent)
  for (const a of agents) {
    await pool.query('UPDATE agents SET turnkey_address = $1 WHERE id = $2', [a.wallet, a.agentId]);
  }

  // ── Create bounty ──
  log.test('\n1. Create proposal-mode bounty');
  const cb = await api('POST', '/api/bounties', {
    creatorWallet: creator.address,
    title: 'Race Test Bounty',
    description: 'Concurrent accept test',
    bountyType: 'research',
    amountUsdc: '100',
    deadline: new Date(Date.now() + 7 * 86400e3).toISOString(),
    selectionMode: 'proposal',
  });
  assert(cb.ok, 'bounty created', cb.data?.error);
  const bountyId = cb.data.bounty.id;

  // ── All N agents submit ──
  log.test(`\n2. All ${N} agents submit proposals (each at distinct price)`);
  const submits = await Promise.all(
    agents.map((a, i) =>
      api('POST', `/api/bounties/${bountyId}/proposals`, {
        plan: `Proposal from agent ${a.label}. Plan body to satisfy length requirements.`,
        proposedPriceUsdc: 10 + i, // 10, 11, 12, 13, 14
        estimatedHours: 1 + i,
      }, a.token)
    )
  );
  const proposalIds = submits.map((s) => s.data.proposal?.id);
  assert(submits.every((s) => s.ok), `all ${N} submitted`);
  assert(proposalIds.every(Boolean), 'all proposal IDs returned');

  // ── Race: fire all accepts in parallel ──
  log.test(`\n3. Fire ${N} parallel ACCEPT calls (one per proposal)`);
  log.info('  Promise.all with no sequencing — true race');
  const startTs = Date.now();
  const results = await Promise.all(
    proposalIds.map((pid) =>
      api('POST', `/api/bounties/${bountyId}/proposals/${pid}/accept`,
        { callerWallet: creator.address })
    )
  );
  const elapsed = Date.now() - startTs;
  log.info(`  all ${N} resolved in ${elapsed}ms`);

  const winners = results.filter((r) => r.status === 200);
  const losers = results.filter((r) => r.status !== 200);
  log.info(`  winners: ${winners.length} | losers: ${losers.length}`);
  log.info(`  status codes: [${results.map(r => r.status).join(', ')}]`);

  assert(winners.length === 1, `exactly 1 winner (got ${winners.length})`);
  assert(losers.length === N - 1, `${N - 1} losers (got ${losers.length})`);
  assert(losers.every((r) => r.status === 409 || r.status === 404),
    'all losers got 409 or 404');

  // ── Verify final state matches the winner ──
  log.test('\n4. Bounty state consistent with the winner');
  const winner = winners[0];
  const winningProposalId = winner.data.acceptedProposalId;
  const finalBounty = winner.data.bounty;
  assert(finalBounty?.status === 'proposal_selected',
    `status=proposal_selected (got ${finalBounty?.status})`);
  assert(finalBounty?.selected_proposal_id === winningProposalId,
    'selected_proposal_id matches winner');

  // Re-fetch and verify all other proposals are rejected
  const list = await api('GET',
    `/api/bounties/${bountyId}/proposals?callerWallet=${creator.address}`);
  const accepted = list.data.proposals.filter((p) => p.status === 'accepted');
  const rejected = list.data.proposals.filter((p) => p.status === 'rejected');
  assert(accepted.length === 1, `exactly 1 accepted in DB (got ${accepted.length})`);
  assert(rejected.length === N - 1, `${N - 1} rejected in DB (got ${rejected.length})`);
  assert(accepted[0].id === winningProposalId, 'DB-accepted proposal matches API winner');

  // Verify bounty amount_usdc matches winner's proposed_price_usdc
  const winnerProposal = list.data.proposals.find((p) => p.id === winningProposalId);
  assert(
    parseFloat(finalBounty.amount_usdc) === parseFloat(winnerProposal.proposed_price_usdc),
    `amount_usdc=${winnerProposal.proposed_price_usdc} (got ${finalBounty.amount_usdc})`
  );

  // ── Stress: run a second race on a new bounty for good measure ──
  log.test('\n5. Second race on a fresh bounty (smoke check determinism)');
  const cb2 = await api('POST', '/api/bounties', {
    creatorWallet: creator.address,
    title: 'Race Test 2',
    description: 'Second race',
    bountyType: 'research',
    amountUsdc: '50',
    deadline: new Date(Date.now() + 7 * 86400e3).toISOString(),
    selectionMode: 'proposal',
  });
  const bountyId2 = cb2.data.bounty.id;
  const submits2 = await Promise.all(
    agents.map((a, i) =>
      api('POST', `/api/bounties/${bountyId2}/proposals`, {
        plan: `Round 2 proposal from ${a.label}. Plan body.`,
        proposedPriceUsdc: 20 + i,
        estimatedHours: 2,
      }, a.token)
    )
  );
  const pids2 = submits2.map((s) => s.data.proposal?.id);
  const results2 = await Promise.all(
    pids2.map((pid) =>
      api('POST', `/api/bounties/${bountyId2}/proposals/${pid}/accept`,
        { callerWallet: creator.address })
    )
  );
  const w2 = results2.filter((r) => r.status === 200);
  assert(w2.length === 1, `race 2: exactly 1 winner (got ${w2.length})`);

  console.log(`\n${c.cyan}════ Results ════${c.reset}`);
  console.log(`${c.green}Passed: ${passed}${c.reset}`);
  if (failed > 0) console.log(`${c.red}Failed: ${failed}${c.reset}`);
  console.log(`Pass rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%\n`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (e) => {
  console.error(`\n${c.red}Test crashed:${c.reset}`, e);
  await pool.end().catch(() => {});
  process.exit(2);
});
