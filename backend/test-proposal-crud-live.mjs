#!/usr/bin/env node
/**
 * Proposal CRUD lifecycle against live prod.
 *
 * Exercises the full proposal table lifecycle that no other test covers:
 *
 *   1.  A submits proposal                                → 200
 *   2.  A updates (new price + plan + hours)              → 200, fields reflect change
 *   3.  A tries to submit AGAIN on same bounty            → 409 + existing_proposal_id hint
 *   4.  B tries to update A's proposal                    → 403
 *   5.  A updates with price=0.5 (below 1 USDC min)       → 400
 *   6.  A updates with too-short plan                     → 400
 *   7.  B tries to withdraw A's proposal                  → 403
 *   8.  A withdraws                                        → 200, status='withdrawn'
 *   9.  A tries to update withdrawn proposal              → 409 'cannot update in status: withdrawn'
 *  10.  A tries to re-submit after withdrawing            → 409 (UNIQUE constraint persists)
 *  11.  Creator tries to accept withdrawn proposal        → 409 'cannot accept in status: withdrawn'
 *
 * Pure DB plumbing — no platform USDC, no on-chain transfers.
 */

import 'dotenv/config';

const API = (process.env.BARD_API || 'https://bard-production-e88b.up.railway.app').replace(/\/$/, '');
const MCP = (process.env.BARD_MCP_URL || 'https://mcp-production-8d2e.up.railway.app').replace(/\/$/, '');

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
      description: 'proposal CRUD test',
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

async function run() {
  console.log(`${c.bold}${c.cyan}\n════ BARD Proposal CRUD Lifecycle ════${c.reset}`);
  console.log(`${c.dim}API: ${API}${c.reset}\n`);

  // Setup
  console.log(`${c.cyan}▸ 0. Provisioning agents + creating a proposal-mode bounty${c.reset}`);
  const stamp = Date.now().toString(36);
  const [creator, A, B] = await Promise.all([
    provisionAgent(`pc-creator-${stamp}`),
    provisionAgent(`pc-a-${stamp}`),
    provisionAgent(`pc-b-${stamp}`),
  ]);
  const cb = await mcpTool(creator.token, 'bard_create_bounty', {
    title: `Proposal CRUD test — ${stamp}`,
    description: 'Lifecycle test bed for proposal create/update/withdraw.',
    bountyType: 'research',
    amountUsdc: '10',
    deadline: new Date(Date.now() + 7 * 86400e3).toISOString(),
    selectionMode: 'proposal',
  });
  if (cb?.error) throw new Error(`create bounty: ${cb.error}`);
  const bountyId = cb.bounty.id;
  console.log(`  ${c.dim}bounty=${bountyId}${c.reset}`);

  // ════════════════════════════════════════════════════
  // 1. A submits proposal
  // ════════════════════════════════════════════════════
  console.log(`\n${c.cyan}▸ 1. A submits initial proposal${c.reset}`);
  const p1 = await mcpTool(A.token, 'bard_submit_proposal', {
    bountyId,
    plan: 'Initial proposal plan from A — first draft to be revised in step 2.',
    proposedPriceUsdc: 5, estimatedHours: 4,
  });
  expect(!p1?.error && p1?.proposal?.id, `proposal submitted`, p1?.error);
  const pAid = p1.proposal.id;
  expect(p1.proposal.proposed_price_usdc === 5 || parseFloat(p1.proposal.proposed_price_usdc) === 5,
    `initial price=5 (got ${p1.proposal.proposed_price_usdc})`);

  // ════════════════════════════════════════════════════
  // 2. A updates the proposal
  // ════════════════════════════════════════════════════
  console.log(`\n${c.cyan}▸ 2. A updates the proposal (new price=7, new plan, new hours)${c.reset}`);
  const u1 = await mcpTool(A.token, 'bard_update_proposal', {
    bountyId, proposalId: pAid,
    plan: 'REVISED plan from A — after thinking it through, charging more and committing to deeper work.',
    proposedPriceUsdc: 7, estimatedHours: 6,
  });
  expect(!u1?.error, `update succeeded`, u1?.error);
  expect(parseFloat(u1.proposal?.proposed_price_usdc) === 7, `price now 7 (got ${u1.proposal?.proposed_price_usdc})`);
  expect(parseInt(u1.proposal?.estimated_hours) === 6, `hours now 6 (got ${u1.proposal?.estimated_hours})`);
  expect(/REVISED/.test(u1.proposal?.plan || ''), `plan reflects update`);

  // ════════════════════════════════════════════════════
  // 3. A tries to submit a 2nd proposal → 409
  // ════════════════════════════════════════════════════
  console.log(`\n${c.cyan}▸ 3. A tries to submit a SECOND proposal → expect 409 + existing_proposal_id${c.reset}`);
  const p2 = await mcpTool(A.token, 'bard_submit_proposal', {
    bountyId, plan: 'Sneaky second proposal attempt by the same agent.',
    proposedPriceUsdc: 9, estimatedHours: 8,
  });
  expect(!!p2?.error, `duplicate submit returned error`, JSON.stringify(p2));
  expect(/already submitted/i.test(p2?.error || ''), `error mentions already submitted`);
  expect(p2?.existing_proposal_id === pAid, `existing_proposal_id matches original (got ${p2?.existing_proposal_id})`);

  // ════════════════════════════════════════════════════
  // 4. B tries to update A's proposal → 403
  // ════════════════════════════════════════════════════
  console.log(`\n${c.cyan}▸ 4. B tries to update A's proposal via REST → expect 403${c.reset}`);
  const wrongUpdate = await apiFetch(`/api/bounties/${bountyId}/proposals/${pAid}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${B.token}` },
    body: JSON.stringify({ proposedPriceUsdc: 1, plan: 'Trying to lowball someone else.' }),
  });
  expect(wrongUpdate.status === 403, `B's update returns 403 (got ${wrongUpdate.status})`, wrongUpdate.data?.error);
  expect(/your own/i.test(wrongUpdate.data?.error || ''), `error mentions ownership`);

  // ════════════════════════════════════════════════════
  // 5. Invalid price (0.5) → 400
  // ════════════════════════════════════════════════════
  console.log(`\n${c.cyan}▸ 5. A updates with price=0.5 (below 1 USDC min) → expect 400${c.reset}`);
  const lowPrice = await apiFetch(`/api/bounties/${bountyId}/proposals/${pAid}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${A.token}` },
    body: JSON.stringify({ proposedPriceUsdc: 0.5 }),
  });
  expect(lowPrice.status === 400, `low-price update returns 400 (got ${lowPrice.status})`, lowPrice.data?.error);
  expect(/at least 1/i.test(lowPrice.data?.error || ''), `error mentions minimum`);

  // ════════════════════════════════════════════════════
  // 6. Plan too short → 400
  // ════════════════════════════════════════════════════
  console.log(`\n${c.cyan}▸ 6. A updates with too-short plan → expect 400${c.reset}`);
  const shortPlan = await apiFetch(`/api/bounties/${bountyId}/proposals/${pAid}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${A.token}` },
    body: JSON.stringify({ plan: 'too short' }),
  });
  expect(shortPlan.status === 400, `short-plan update returns 400 (got ${shortPlan.status})`, shortPlan.data?.error);
  expect(/10–?—?-?8000|characters/i.test(shortPlan.data?.error || ''), `error mentions length range`);

  // ════════════════════════════════════════════════════
  // 7. B tries to withdraw A's proposal → 403
  // ════════════════════════════════════════════════════
  console.log(`\n${c.cyan}▸ 7. B tries to withdraw A's proposal via REST → expect 403${c.reset}`);
  const wrongWithdraw = await apiFetch(`/api/bounties/${bountyId}/proposals/${pAid}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${B.token}` },
  });
  expect(wrongWithdraw.status === 403, `B's withdraw returns 403 (got ${wrongWithdraw.status})`, wrongWithdraw.data?.error);
  expect(/your own/i.test(wrongWithdraw.data?.error || ''), `error mentions ownership`);

  // ════════════════════════════════════════════════════
  // 8. A withdraws — succeeds, status flips to 'withdrawn'
  // ════════════════════════════════════════════════════
  console.log(`\n${c.cyan}▸ 8. A withdraws their proposal${c.reset}`);
  const wd = await mcpTool(A.token, 'bard_withdraw_proposal', { bountyId, proposalId: pAid });
  expect(!wd?.error, `withdraw succeeded`, wd?.error);

  // verify the status via the proposer's own listing
  const myList = await apiFetch(`/api/agents/${A.agentId}/proposals`, {
    headers: { Authorization: `Bearer ${A.token}` },
  });
  const found = (myList.data?.proposals || []).find(p => p.id === pAid);
  expect(found?.status === 'withdrawn', `proposal.status='withdrawn' (got ${found?.status})`);

  // ════════════════════════════════════════════════════
  // 9. A tries to update withdrawn proposal → 409
  // ════════════════════════════════════════════════════
  console.log(`\n${c.cyan}▸ 9. A tries to update the withdrawn proposal → expect 409${c.reset}`);
  const reUpdate = await mcpTool(A.token, 'bard_update_proposal', {
    bountyId, proposalId: pAid, proposedPriceUsdc: 2,
  });
  expect(!!reUpdate?.error, `update returned error`, JSON.stringify(reUpdate));
  expect(/withdrawn|status/i.test(reUpdate?.error || ''), `error mentions withdrawn/status`);

  // ════════════════════════════════════════════════════
  // 10. A tries to RE-SUBMIT after withdraw → still 409 (UNIQUE persists)
  // ════════════════════════════════════════════════════
  console.log(`\n${c.cyan}▸ 10. A tries to re-submit after withdrawing → expect 409 (UNIQUE constraint)${c.reset}`);
  const reSubmit = await mcpTool(A.token, 'bard_submit_proposal', {
    bountyId,
    plan: 'Re-submission attempt after withdrawing — UNIQUE row still exists.',
    proposedPriceUsdc: 4, estimatedHours: 3,
  });
  expect(!!reSubmit?.error, `re-submit returned error`);
  expect(/already submitted/i.test(reSubmit?.error || ''), `error mentions already submitted (the withdrawn row still occupies UNIQUE slot)`);

  // ════════════════════════════════════════════════════
  // 11. Creator tries to accept the withdrawn proposal → 409
  // ════════════════════════════════════════════════════
  console.log(`\n${c.cyan}▸ 11. Creator tries to accept the withdrawn proposal → expect 409${c.reset}`);
  const acc = await apiFetch(`/api/bounties/${bountyId}/proposals/${pAid}/accept`, {
    method: 'POST',
    body: JSON.stringify({ callerWallet: creator.wallet }),
  });
  expect(acc.status === 409, `accept-withdrawn returns 409 (got ${acc.status})`, acc.data?.error);
  expect(/withdrawn|status/i.test(acc.data?.error || ''), `error mentions withdrawn/status`);

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
