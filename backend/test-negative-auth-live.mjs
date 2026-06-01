#!/usr/bin/env node
/**
 * Negative auth + race assertions against the live production stack.
 *
 * Confirms the platform refuses hostile / accidental misuse:
 *   1. Wrong wallet tries to accept a proposal       → 403
 *   2. Two parallel /accept calls (different proposals on the same
 *      proposal_open bounty by the real creator)     → exactly one wins
 *   3. Non-verifier wallet calls /platform-verify    → 403
 *   4. Third party (not creator, not proposer) reads a private message
 *      thread via /api/bounties/:id/messages         → blocked or empty
 *
 * No on-chain transfers, no platform USDC spent (the bounties never reach
 * funded state). Cheap to run.
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
async function mcp(token, method, params = {}) {
  const res = await fetch(`${MCP}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (res.status === 204) return null;
  const out = await res.json();
  if (out.error) throw new Error(out.error.message);
  return out.result;
}
async function mcpTool(token, tool, args = {}) {
  const out = await mcp(token, 'tools/call', { name: tool, arguments: args });
  const raw = out?.content?.[0]?.text;
  return raw ? JSON.parse(raw) : null;
}

async function provisionAgent(name) {
  const reg = await apiFetch('/api/agents/register', {
    method: 'POST',
    body: JSON.stringify({
      ownerWallet: '0x0000000000000000000000000000000000000000',
      agentName: name,
      agentPublicKey: 'turnkey-pending-' + Date.now() + Math.random().toString(36).slice(2, 6),
      agentType: 'research',
      description: 'negative-auth test',
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
  console.log(`${c.bold}${c.cyan}\n════ BARD Negative Auth + Race ════${c.reset}`);
  console.log(`${c.dim}API: ${API}${c.reset}\n`);

  // ── Setup: 4 agents (creator, A, B, stranger)
  console.log(`${c.cyan}▸ 0. Provisioning 4 agents${c.reset}`);
  const stamp = Date.now().toString(36);
  const [creator, A, B, stranger] = await Promise.all([
    provisionAgent(`neg-creator-${stamp}`),
    provisionAgent(`neg-a-${stamp}`),
    provisionAgent(`neg-b-${stamp}`),
    provisionAgent(`neg-stranger-${stamp}`),
  ]);
  for (const a of [creator, A, B, stranger]) {
    console.log(`  ${c.dim}${a.name.padEnd(28)} ${a.wallet}${c.reset}`);
  }

  // ── Setup: create proposal-mode bounty + 2 proposals
  console.log(`\n${c.cyan}▸ 0b. Create proposal bounty + 2 proposals${c.reset}`);
  const cb = await mcpTool(creator.token, 'bard_create_bounty', {
    title: `Negative-auth test — ${stamp}`,
    description: 'No-op bounty for negative auth tests.',
    bountyType: 'research',
    amountUsdc: '5',
    deadline: new Date(Date.now() + 86400e3).toISOString(),
    selectionMode: 'proposal',
  });
  if (cb?.error) throw new Error(`create bounty: ${cb.error}`);
  const bountyId = cb.bounty.id;

  const [pA, pB] = await Promise.all([
    mcpTool(A.token, 'bard_submit_proposal', { bountyId, plan: 'A proposal plan.', proposedPriceUsdc: 2 }),
    mcpTool(B.token, 'bard_submit_proposal', { bountyId, plan: 'B proposal plan.', proposedPriceUsdc: 3 }),
  ]);
  if (pA?.error || pB?.error) throw new Error(`proposals: ${pA?.error || pB?.error}`);
  console.log(`  ${c.dim}bounty=${bountyId}  pA=${pA.proposal.id}  pB=${pB.proposal.id}${c.reset}`);

  // ════════════════════════════════════════════════════
  // 1. Wrong wallet tries to accept a proposal
  // ════════════════════════════════════════════════════
  console.log(`\n${c.cyan}▸ 1. Wrong wallet tries to accept (should 403)${c.reset}`);
  const wrongAccept = await apiFetch(`/api/bounties/${bountyId}/proposals/${pA.proposal.id}/accept`, {
    method: 'POST',
    body: JSON.stringify({ callerWallet: stranger.wallet }),  // not the creator
  });
  expect(wrongAccept.status === 403, `stranger accept returns 403 (got ${wrongAccept.status})`, wrongAccept.data?.error);
  expect(/only the creator/i.test(wrongAccept.data?.error || ''), `error mentions creator-only`, wrongAccept.data?.error);

  // ════════════════════════════════════════════════════
  // 2. Parallel accept race (creator fires 2 accepts at once)
  // ════════════════════════════════════════════════════
  console.log(`\n${c.cyan}▸ 2. Parallel accept of pA and pB (exactly one should win)${c.reset}`);
  const [r1, r2] = await Promise.all([
    apiFetch(`/api/bounties/${bountyId}/proposals/${pA.proposal.id}/accept`, {
      method: 'POST',
      body: JSON.stringify({ callerWallet: creator.wallet }),
    }),
    apiFetch(`/api/bounties/${bountyId}/proposals/${pB.proposal.id}/accept`, {
      method: 'POST',
      body: JSON.stringify({ callerWallet: creator.wallet }),
    }),
  ]);
  const codes = [r1.status, r2.status].sort();
  console.log(`  ${c.dim}status codes: [${codes.join(', ')}]${c.reset}`);
  const winners = [r1, r2].filter(r => r.ok);
  const losers = [r1, r2].filter(r => !r.ok);
  expect(winners.length === 1, `exactly one accept succeeded (got ${winners.length})`);
  expect(losers.length === 1, `exactly one accept failed (got ${losers.length})`);
  expect(losers[0]?.status === 409, `losing accept returns 409 (got ${losers[0]?.status})`, losers[0]?.data?.error);

  // ════════════════════════════════════════════════════
  // 3. Non-verifier calls /platform-verify
  // ════════════════════════════════════════════════════
  // Need a bounty in escrow_status='client_approved' for verify to even check
  // auth — but the auth check is the FIRST gate, so we can use any bounty id.
  console.log(`\n${c.cyan}▸ 3. Non-verifier calls /platform-verify (should 403)${c.reset}`);
  const nonVerifier = await apiFetch(`/api/bounties/${bountyId}/platform-verify`, {
    method: 'POST',
    body: JSON.stringify({
      verifierWallet: stranger.wallet,   // not in platform_verifiers table
      decision: 'approved',
      reasoning: 'Attempt to verify as stranger.',
    }),
  });
  expect(nonVerifier.status === 403, `stranger platform-verify returns 403 (got ${nonVerifier.status})`, nonVerifier.data?.error);
  expect(/not a platform verifier/i.test(nonVerifier.data?.error || ''), `error mentions platform verifier`, nonVerifier.data?.error);

  // ════════════════════════════════════════════════════
  // 4. Third party reads private message thread
  // ════════════════════════════════════════════════════
  // First post a real message in the thread so there's something to leak
  console.log(`\n${c.cyan}▸ 4. Third party reads a private message thread (should be blocked)${c.reset}`);
  // Need a proposal that's still around for messaging — pB might be auto-rejected by the
  // race winner's accept, so use the winning proposal's thread.
  const acceptedProposalId = winners[0]?.data?.bounty?.selected_proposal_id;
  const winningProposalId = acceptedProposalId || pA.proposal.id;
  await mcpTool(creator.token, 'bard_send_bounty_message', {
    bountyId, proposalId: winningProposalId,
    message: 'PRIVATE: only creator + winning proposer should see this.',
  });
  // Stranger queries the thread
  const readUrl = `/api/bounties/${bountyId}/messages?proposalId=${encodeURIComponent(winningProposalId)}&callerWallet=${encodeURIComponent(stranger.wallet)}`;
  const leakAttempt = await apiFetch(readUrl);
  const leakedMessages = leakAttempt.data?.messages || [];
  const leakedSensitive = leakedMessages.some(m => /PRIVATE/.test(m.message || ''));
  console.log(`  ${c.dim}stranger read status=${leakAttempt.status}, messages returned=${leakedMessages.length}${c.reset}`);
  expect(!leakedSensitive, `stranger does NOT see the private message body`);
  expect(leakAttempt.status === 403 || leakedMessages.length === 0,
    `stranger gets 403 or empty list (got status=${leakAttempt.status}, n=${leakedMessages.length})`);

  // Sanity: creator CAN still read their own thread
  const creatorReadUrl = `/api/bounties/${bountyId}/messages?proposalId=${encodeURIComponent(winningProposalId)}&callerWallet=${encodeURIComponent(creator.wallet)}`;
  const creatorRead = await apiFetch(creatorReadUrl);
  const creatorSees = (creatorRead.data?.messages || []).some(m => /PRIVATE/.test(m.message || ''));
  expect(creatorSees, `creator CAN read their own thread (sanity check)`);

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
