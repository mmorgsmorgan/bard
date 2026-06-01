#!/usr/bin/env node
/**
 * Cancel-at-each-state matrix against live prod.
 *
 * Confirms the cancel endpoint's two-layer guard (status whitelist
 * AND escrow-status blocklist) behaves correctly across every reachable
 * exit point a creator might try:
 *
 *   1. open + escrow=none           → 200, cancelled
 *   2. proposal_open (no bids)      → 200, cancelled
 *   3. proposal_open (2 bids)       → 200, cancelled + both proposals
 *                                            auto-rejected with reason
 *   4. proposal_selected (no fund)  → 200, cancelled + accepted proposal
 *                                            flipped to rejected
 *   5. open + escrow=funded         → 409, "active escrow"
 *   6. assigned + escrow=claimed    → 409, "active escrow" (proposal mode
 *                                            after fund + auto-claim)
 *   7. wrong wallet cancels         → 403, "only creator"
 *
 * All cheap — no platform USDC is spent (no on-chain releases or refunds).
 */

import 'dotenv/config';

const API = (process.env.BARD_API || 'https://bard-production-413a.up.railway.app').replace(/\/$/, '');
const MCP = (process.env.BARD_MCP_URL || 'https://mellow-balance-production-25cb.up.railway.app').replace(/\/$/, '');

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m',
};

let pass = 0, fail = 0;
const expect = (cond, name, detail) => cond
  ? (pass++, console.log(`  ${c.green}✓${c.reset} ${name}`))
  : (fail++, console.log(`  ${c.red}✗${c.reset} ${name}${detail ? `   ${c.dim}${detail}${c.reset}` : ''}`));

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data };
}

let rpcId = 0;
async function mcpTool(token, tool, args = {}, attempt = 1) {
  try {
    const res = await fetch(`${MCP}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0', id: ++rpcId,
        method: 'tools/call', params: { name: tool, arguments: args },
      }),
    });
    const out = await res.json();
    if (out.error) throw new Error(out.error.message);
    const raw = out.result?.content?.[0]?.text;
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    if (attempt < 3 && (err.cause?.code || err.message).match(/fetch failed|ECONN/i)) {
      await new Promise(r => setTimeout(r, 800 * attempt));
      return mcpTool(token, tool, args, attempt + 1);
    }
    throw err;
  }
}

async function provisionAgent(name) {
  const reg = await apiFetch('/api/agents/register', {
    method: 'POST',
    body: JSON.stringify({
      ownerWallet: '0x0000000000000000000000000000000000000000',
      agentName: name,
      agentPublicKey: 'turnkey-pending-' + Date.now() + Math.random().toString(36).slice(2, 6),
      agentType: 'research',
      description: 'cancel-matrix test',
    }),
  });
  if (!reg.ok) throw new Error(`register ${name}: ${reg.data.error}`);
  const agentId = reg.data.agent?.id || reg.data.agentId;
  const token = reg.data.token;
  const w = await apiFetch(`/api/agents/${agentId}/wallet`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
  if (!w.ok) throw new Error(`wallet ${name}: ${w.data.error}`);
  return { name, agentId, token, wallet: w.data.address };
}

async function createBounty(creator, mode, label, opts = {}) {
  const cb = await mcpTool(creator.token, 'bard_create_bounty', {
    title: `Cancel-test ${label} — ${Date.now().toString(36)}`,
    description: `Cancel-matrix scenario: ${label}`,
    bountyType: 'research',
    amountUsdc: String(opts.amount || 5),
    deadline: new Date(Date.now() + 7 * 86400e3).toISOString(),
    ...(mode === 'proposal' ? { selectionMode: 'proposal' } : {}),
  });
  if (cb?.error) throw new Error(`create ${label}: ${cb.error}`);
  return cb.bounty.id;
}

async function cancelBounty(creator, bountyId) {
  return await apiFetch(`/api/bounties/${bountyId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ creatorWallet: creator.wallet }),
  });
}

async function getBounty(bountyId) {
  const r = await apiFetch(`/api/bounties/${bountyId}`);
  return r.data?.bounty;
}

async function listProposals(creator, bountyId) {
  const r = await apiFetch(`/api/bounties/${bountyId}/proposals?callerWallet=${encodeURIComponent(creator.wallet)}`);
  return r.data?.proposals || [];
}

async function run() {
  console.log(`${c.bold}${c.cyan}\n════ BARD Cancel-at-Each-State Matrix ════${c.reset}`);
  console.log(`${c.dim}API: ${API}${c.reset}\n`);

  // ── Setup pool of agents
  console.log(`${c.cyan}▸ 0. Provisioning agents${c.reset}`);
  const stamp = Date.now().toString(36);
  const [creator, A, B, stranger] = await Promise.all([
    provisionAgent(`cc-creator-${stamp}`),
    provisionAgent(`cc-a-${stamp}`),
    provisionAgent(`cc-b-${stamp}`),
    provisionAgent(`cc-stranger-${stamp}`),
  ]);
  console.log(`  ${c.dim}creator=${creator.wallet}  A=${A.wallet}  B=${B.wallet}  stranger=${stranger.wallet}${c.reset}`);

  // ════════════════════════════════════════════════════
  // 1. open (first_come, no escrow) → cancel succeeds
  // ════════════════════════════════════════════════════
  console.log(`\n${c.cyan}▸ 1. Cancel from 'open' (first_come, no escrow)${c.reset}`);
  const id1 = await createBounty(creator, 'first_come', '1-open');
  const c1 = await cancelBounty(creator, id1);
  expect(c1.ok, `cancel succeeds (${c1.status})`, c1.data?.error);
  const b1 = await getBounty(id1);
  expect(b1?.status === 'cancelled', `status=cancelled (got ${b1?.status})`);

  // ════════════════════════════════════════════════════
  // 2. proposal_open (no bids) → cancel succeeds
  // ════════════════════════════════════════════════════
  console.log(`\n${c.cyan}▸ 2. Cancel from 'proposal_open' (no bids)${c.reset}`);
  const id2 = await createBounty(creator, 'proposal', '2-prop-empty');
  const b2pre = await getBounty(id2);
  expect(b2pre?.status === 'proposal_open', `pre-cancel status=proposal_open`);
  const c2 = await cancelBounty(creator, id2);
  expect(c2.ok, `cancel succeeds`);
  const b2 = await getBounty(id2);
  expect(b2?.status === 'cancelled', `status=cancelled`);

  // ════════════════════════════════════════════════════
  // 3. proposal_open (2 bids) → cancel succeeds, both proposals rejected
  // ════════════════════════════════════════════════════
  console.log(`\n${c.cyan}▸ 3. Cancel from 'proposal_open' WITH 2 pending bids${c.reset}`);
  const id3 = await createBounty(creator, 'proposal', '3-prop-bids');
  const [pA3, pB3] = await Promise.all([
    mcpTool(A.token, 'bard_submit_proposal', { bountyId: id3, plan: 'Plan from agent A — to be auto-rejected when creator cancels.', proposedPriceUsdc: 3 }),
    mcpTool(B.token, 'bard_submit_proposal', { bountyId: id3, plan: 'Plan from agent B — to be auto-rejected when creator cancels.', proposedPriceUsdc: 4 }),
  ]);
  expect(!pA3?.error && !pB3?.error, `both proposals accepted by backend`, `pA3=${pA3?.error} pB3=${pB3?.error}`);
  const c3 = await cancelBounty(creator, id3);
  expect(c3.ok, `cancel succeeds with bids in flight`);
  const b3 = await getBounty(id3);
  expect(b3?.status === 'cancelled', `bounty status=cancelled`);
  const props3 = await listProposals(creator, id3);
  const allRejected3 = props3.every(p => p.status === 'rejected');
  console.log(`  ${c.dim}proposal statuses: ${props3.map(p => p.status).join(', ')}${c.reset}`);
  expect(allRejected3 && props3.length === 2, `both proposals flipped to 'rejected'`);

  // ════════════════════════════════════════════════════
  // 4. proposal_selected (accepted, not funded) → cancel succeeds
  // ════════════════════════════════════════════════════
  console.log(`\n${c.cyan}▸ 4. Cancel from 'proposal_selected' (accepted, NOT funded)${c.reset}`);
  const id4 = await createBounty(creator, 'proposal', '4-selected');
  const pA4 = await mcpTool(A.token, 'bard_submit_proposal', {
    bountyId: id4, plan: 'A plan to be accepted then orphaned by cancel', proposedPriceUsdc: 3,
  });
  await mcpTool(creator.token, 'bard_accept_proposal', { bountyId: id4, proposalId: pA4.proposal.id });
  const b4pre = await getBounty(id4);
  expect(b4pre?.status === 'proposal_selected', `pre-cancel status=proposal_selected`);
  const c4 = await cancelBounty(creator, id4);
  expect(c4.ok, `cancel succeeds`);
  const b4 = await getBounty(id4);
  expect(b4?.status === 'cancelled', `status=cancelled`);
  const props4 = await listProposals(creator, id4);
  const accepted4 = props4.find(p => p.id === pA4.proposal.id);
  console.log(`  ${c.dim}previously-accepted proposal status now: ${accepted4?.status}${c.reset}`);
  expect(accepted4?.status === 'rejected', `previously-accepted proposal flipped to rejected on cancel`);

  // ════════════════════════════════════════════════════
  // 5. open + escrow=funded → 409 (active escrow)
  // ════════════════════════════════════════════════════
  console.log(`\n${c.cyan}▸ 5. Cancel a FUNDED first_come bounty → expect 409${c.reset}`);
  const id5 = await createBounty(creator, 'first_come', '5-funded');
  const fund5 = await apiFetch(`/api/bounties/${id5}/fund`, {
    method: 'POST', headers: { Authorization: `Bearer ${creator.token}` },
    body: JSON.stringify({ clientWallet: creator.wallet, budgetUsdc: 2 }),
  });
  expect(fund5.ok, `fund succeeded (${fund5.status})`);
  const c5 = await cancelBounty(creator, id5);
  expect(c5.status === 409, `cancel blocked with 409 (got ${c5.status})`, c5.data?.error);
  expect(/escrow/i.test(c5.data?.error || ''), `error mentions escrow`);

  // ════════════════════════════════════════════════════
  // 6. assigned (proposal mode, after fund+auto-claim) → 409
  // ════════════════════════════════════════════════════
  console.log(`\n${c.cyan}▸ 6. Cancel an ASSIGNED proposal-mode bounty (escrow=claimed) → expect 409${c.reset}`);
  const id6 = await createBounty(creator, 'proposal', '6-assigned');
  const pA6 = await mcpTool(A.token, 'bard_submit_proposal', {
    bountyId: id6, plan: 'A plan that gets funded and auto-claimed.', proposedPriceUsdc: 2,
  });
  await mcpTool(creator.token, 'bard_accept_proposal', { bountyId: id6, proposalId: pA6.proposal.id });
  const fund6 = await apiFetch(`/api/bounties/${id6}/fund`, {
    method: 'POST', headers: { Authorization: `Bearer ${creator.token}` },
    body: JSON.stringify({ clientWallet: creator.wallet, budgetUsdc: 2 }),
  });
  expect(fund6.ok, `fund + auto-claim succeeded`);
  const b6pre = await getBounty(id6);
  expect(b6pre?.status === 'assigned' && b6pre?.escrow_status === 'claimed',
    `pre-cancel status=assigned + escrow=claimed`,
    `got status=${b6pre?.status} escrow=${b6pre?.escrow_status}`);
  const c6 = await cancelBounty(creator, id6);
  expect(c6.status === 409, `cancel blocked with 409 (got ${c6.status})`, c6.data?.error);
  expect(/escrow/i.test(c6.data?.error || ''), `error mentions escrow`);

  // ════════════════════════════════════════════════════
  // 7. wrong wallet → 403
  // ════════════════════════════════════════════════════
  console.log(`\n${c.cyan}▸ 7. Stranger tries to cancel someone else's bounty → expect 403${c.reset}`);
  const id7 = await createBounty(creator, 'first_come', '7-wrong-wallet');
  const c7 = await cancelBounty(stranger, id7);
  expect(c7.status === 403, `stranger cancel returns 403 (got ${c7.status})`, c7.data?.error);
  expect(/only creator/i.test(c7.data?.error || ''), `error mentions creator-only`);
  // and the bounty is still open
  const b7 = await getBounty(id7);
  expect(b7?.status === 'open', `bounty still open after blocked cancel (got ${b7?.status})`);

  // ════════════════════════════════════════════════════
  console.log(`\n${c.bold}${c.cyan}════ Results ════${c.reset}`);
  console.log(`  passed: ${pass}`);
  if (fail > 0) console.log(`  ${c.red}failed: ${fail}${c.reset}`);
  console.log();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(`\n${c.red}✗ Test crashed:${c.reset} ${err.message}\n`);
  process.exit(2);
});
