#!/usr/bin/env node
/**
 * Live MCP test of the revision + dispute escalation flow.
 *
 * Two scenarios in one run — each is a separate bounty with its own agents:
 *
 *   A) Happy revision:
 *      deliver → reject (revision requested) → re-deliver → approve → release.
 *      Asserts: revision_count goes 0 → 1; escrow returns to 'claimed' after
 *      rejection so the agent can deliver again; final release_tx_hash present.
 *
 *   B) Dispute escalation:
 *      deliver → reject (revision) → re-deliver → reject AGAIN → escrow becomes
 *      'disputed'. Platform verifier resolves with decision='rejected' (refund
 *      to creator). Asserts: escrow_status='disputed' before verify, refund
 *      lands on-chain after.
 *
 * Costs ~6 USDC of platform funds (release in A + refund in B).
 */

import 'dotenv/config';
import { createPublicClient, http } from 'viem';

const API = (process.env.BARD_API || 'https://bard-production-e88b.up.railway.app').replace(/\/$/, '');
const MCP = (process.env.BARD_MCP_URL || 'https://mcp-production-8d2e.up.railway.app').replace(/\/$/, '');
const PLATFORM_OWNER = (process.env.PLATFORM_OWNER_WALLET || '0x93d8E072b983b3119ffffc9F826fd14Ef03513Cd');
const ARC_RPC = 'https://rpc.testnet.arc.network';
const USDC = '0x3600000000000000000000000000000000000000';
const ARC_CHAIN_ID = 5042002;

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', dim: '\x1b[2m', magenta: '\x1b[35m', bold: '\x1b[1m',
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
    if (attempt < 3 && (err.cause?.code || err.message).match(/fetch failed|ECONN|ETIMEDOUT/i)) {
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
      description: 'revision/dispute test',
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

const ERC20_BAL_ABI = [{
  name: 'balanceOf', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
}];
async function usdcBal(client, addr) {
  try {
    const raw = await client.readContract({
      address: USDC, abi: ERC20_BAL_ABI, functionName: 'balanceOf', args: [addr],
    });
    return Number(raw) / 1_000_000;
  } catch { return null; }
}

// Set up a bounty all the way to 'submitted' state (proposal mode).
// Returns { bountyId, creator, agent, pub }.
async function setUpToSubmitted(label, price) {
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
  const [creator, agent] = await Promise.all([
    provisionAgent(`rv-creator-${label}-${stamp}`),
    provisionAgent(`rv-agent-${label}-${stamp}`),
  ]);

  const cb = await mcpTool(creator.token, 'bard_create_bounty', {
    title: `Revision test ${label} — ${stamp}`,
    description: `Revision/dispute test, scenario ${label}.`,
    bountyType: 'research',
    amountUsdc: String(price + 2),
    deadline: new Date(Date.now() + 7 * 86400e3).toISOString(),
    selectionMode: 'proposal',
  });
  if (cb?.error) throw new Error(`create: ${cb.error}`);
  const bountyId = cb.bounty.id;

  const sub = await mcpTool(agent.token, 'bard_submit_proposal', {
    bountyId, plan: `Initial plan for ${label}.`,
    proposedPriceUsdc: price, estimatedHours: 2,
  });
  if (sub?.error) throw new Error(`propose: ${sub.error}`);

  const acc = await mcpTool(creator.token, 'bard_accept_proposal', {
    bountyId, proposalId: sub.proposal.id,
  });
  if (acc?.error) throw new Error(`accept: ${acc.error}`);

  const fund = await apiFetch(`/api/bounties/${bountyId}/fund`, {
    method: 'POST', headers: { Authorization: `Bearer ${creator.token}` },
    body: JSON.stringify({ clientWallet: creator.wallet, budgetUsdc: price }),
  });
  if (!fund.ok) throw new Error(`fund: ${fund.data.error}`);

  const del = await mcpTool(agent.token, 'bard_submit_deliverable', {
    bountyId, content: `Initial deliverable for ${label} — possibly needs revision.`,
  });
  if (del?.error) throw new Error(`deliver: ${del.error}`);

  return { bountyId, creator, agent };
}

async function getBounty(bountyId) {
  const r = await apiFetch(`/api/bounties/${bountyId}`);
  return r.data?.bounty;
}

async function run() {
  console.log(`${c.bold}${c.cyan}\n════ BARD Revision + Dispute Escalation ════${c.reset}`);
  console.log(`${c.dim}API: ${API}  |  MCP: ${MCP}  |  Verifier: ${PLATFORM_OWNER}${c.reset}\n`);

  const h = await apiFetch('/api/health');
  if (!h.ok) throw new Error(`health: ${h.status}`);
  const balUsdc = parseFloat(h.data.platformWallet?.balance_usdc || '0');
  console.log(`${c.cyan}▸ 0.${c.reset} backend up — platform balance=${balUsdc} USDC`);
  if (balUsdc < 7) throw new Error(`Platform balance < 7 USDC — this test costs ~6 USDC (release + refund)`);

  const pub = createPublicClient({
    chain: { id: ARC_CHAIN_ID, name: 'Arc Testnet', nativeCurrency:{ name:'USDC', symbol:'USDC', decimals:6 }, rpcUrls:{ default:{ http:[ARC_RPC] } } },
    transport: http(ARC_RPC),
  });

  // ════════════════════════════════════════════════════
  // Scenario A — happy revision
  // ════════════════════════════════════════════════════
  console.log(`\n${c.bold}${c.cyan}━━━ Scenario A: Happy revision (reject once, accept the revision) ━━━${c.reset}`);
  console.log(`${c.cyan}▸ A.1 setup → submitted${c.reset}`);
  const A = await setUpToSubmitted('A', 3);
  console.log(`  ${c.dim}bounty=${A.bountyId}${c.reset}`);
  let bA = await getBounty(A.bountyId);
  expect(bA?.escrow_status === 'submitted', `pre-rejection escrow=submitted`, bA?.escrow_status);
  expect((bA?.revision_count || 0) === 0, `revision_count starts at 0`, `got ${bA?.revision_count}`);

  console.log(`\n${c.cyan}▸ A.2 Creator rejects (revision requested)${c.reset}`);
  const rejA = await apiFetch(`/api/bounties/${A.bountyId}/review`, {
    method: 'POST', headers: { Authorization: `Bearer ${A.creator.token}` },
    body: JSON.stringify({
      clientWallet: A.creator.wallet, decision: 'rejected',
      reason: 'Needs deeper analysis on section 2 — please revise.',
    }),
  });
  expect(rejA.ok, `first rejection accepted (${rejA.status})`, rejA.data?.error);
  bA = await getBounty(A.bountyId);
  expect(bA?.escrow_status === 'claimed', `escrow back to 'claimed' (re-delivery allowed)`, `got ${bA?.escrow_status}`);
  expect((bA?.revision_count || 0) === 1, `revision_count incremented to 1`, `got ${bA?.revision_count}`);

  console.log(`\n${c.cyan}▸ A.3 Agent re-delivers${c.reset}`);
  const redeliverA = await mcpTool(A.agent.token, 'bard_submit_deliverable', {
    bountyId: A.bountyId,
    content: 'REVISED deliverable: section 2 expanded with deeper analysis, additional citations, and a methodology appendix.',
  });
  expect(!redeliverA?.error, `re-deliver succeeded`, redeliverA?.error);
  bA = await getBounty(A.bountyId);
  expect(bA?.escrow_status === 'submitted', `escrow back to 'submitted' after re-delivery`, `got ${bA?.escrow_status}`);

  console.log(`\n${c.cyan}▸ A.4 Creator approves the revision${c.reset}`);
  const approveA = await apiFetch(`/api/bounties/${A.bountyId}/review`, {
    method: 'POST', headers: { Authorization: `Bearer ${A.creator.token}` },
    body: JSON.stringify({
      clientWallet: A.creator.wallet, decision: 'approved', reason: 'Revision looks good.',
    }),
  });
  expect(approveA.ok, `approval after revision succeeded`, approveA.data?.error);

  console.log(`\n${c.cyan}▸ A.5 Platform releases → real USDC to agent${c.reset}`);
  const agentBalABefore = await usdcBal(pub, A.agent.wallet);
  const verifyA = await apiFetch(`/api/bounties/${A.bountyId}/platform-verify`, {
    method: 'POST',
    body: JSON.stringify({
      verifierWallet: PLATFORM_OWNER, decision: 'approved',
      reasoning: 'Revision meets the spec, releasing.',
    }),
  });
  expect(verifyA.ok, `platform-verify approved (${verifyA.status})`, verifyA.data?.error);
  expect(!!verifyA.data?.bounty?.release_tx_hash, `release_tx_hash present`, verifyA.data?.bounty?.release_tx_hash);
  await new Promise(r => setTimeout(r, 6000));
  const agentBalAAfter = await usdcBal(pub, A.agent.wallet);
  const deltaA = (agentBalAAfter ?? 0) - (agentBalABefore ?? 0);
  console.log(`  ${c.dim}agent delta: ${deltaA.toFixed(6)} USDC${c.reset}`);
  expect(Math.abs(deltaA - 3) < 0.01, `agent received ~3 USDC on revision approval`);

  // ════════════════════════════════════════════════════
  // Scenario B — dispute escalation
  // ════════════════════════════════════════════════════
  console.log(`\n${c.bold}${c.cyan}━━━ Scenario B: Dispute escalation (reject twice, platform refunds) ━━━${c.reset}`);
  console.log(`${c.cyan}▸ B.1 setup → submitted${c.reset}`);
  const B = await setUpToSubmitted('B', 3);
  console.log(`  ${c.dim}bounty=${B.bountyId}${c.reset}`);

  console.log(`\n${c.cyan}▸ B.2 Creator rejects (revision requested)${c.reset}`);
  const rej1B = await apiFetch(`/api/bounties/${B.bountyId}/review`, {
    method: 'POST', headers: { Authorization: `Bearer ${B.creator.token}` },
    body: JSON.stringify({
      clientWallet: B.creator.wallet, decision: 'rejected',
      reason: 'Not what I asked for — first rejection.',
    }),
  });
  expect(rej1B.ok, `first rejection accepted`, rej1B.data?.error);

  console.log(`\n${c.cyan}▸ B.3 Agent re-delivers (still inadequate per creator)${c.reset}`);
  const redeliverB = await mcpTool(B.agent.token, 'bard_submit_deliverable', {
    bountyId: B.bountyId,
    content: 'REVISED — but the creator will reject this too, triggering dispute.',
  });
  expect(!redeliverB?.error, `re-deliver succeeded`);

  console.log(`\n${c.cyan}▸ B.4 Creator rejects AGAIN → escalation to platform${c.reset}`);
  const rej2B = await apiFetch(`/api/bounties/${B.bountyId}/review`, {
    method: 'POST', headers: { Authorization: `Bearer ${B.creator.token}` },
    body: JSON.stringify({
      clientWallet: B.creator.wallet, decision: 'rejected',
      reason: 'Still not acceptable on second review. Escalating.',
    }),
  });
  expect(rej2B.ok, `second rejection accepted`, rej2B.data?.error);
  const bBafter = await getBounty(B.bountyId);
  expect(bBafter?.escrow_status === 'disputed', `escrow_status='disputed' (not 'claimed' — no more revisions)`, `got ${bBafter?.escrow_status}`);

  console.log(`\n${c.cyan}▸ B.5 Platform resolves the dispute (rejects → refund to creator)${c.reset}`);
  const creatorBalBBefore = await usdcBal(pub, B.creator.wallet);
  const agentBalBBefore = await usdcBal(pub, B.agent.wallet);
  console.log(`  ${c.dim}creator before: ${creatorBalBBefore?.toFixed(6) ?? '?'}  agent before: ${agentBalBBefore?.toFixed(6) ?? '?'}${c.reset}`);
  const verifyB = await apiFetch(`/api/bounties/${B.bountyId}/platform-verify`, {
    method: 'POST',
    body: JSON.stringify({
      verifierWallet: PLATFORM_OWNER, decision: 'rejected',
      reasoning: 'Reviewed dispute — deliverable does not meet spec. Refunding creator.',
    }),
  });
  expect(verifyB.ok, `platform-verify (rejected) succeeded`, verifyB.data?.error);
  expect(verifyB.data?.bounty?.status === 'cancelled',
    `bounty status=cancelled after dispute-refund`, verifyB.data?.bounty?.status);
  expect(verifyB.data?.bounty?.escrow_status === 'refunded',
    `escrow_status=refunded after dispute-refund`, verifyB.data?.bounty?.escrow_status);

  await new Promise(r => setTimeout(r, 6000));
  const creatorBalBAfter = await usdcBal(pub, B.creator.wallet);
  const agentBalBAfter = await usdcBal(pub, B.agent.wallet);
  const creatorDeltaB = (creatorBalBAfter ?? 0) - (creatorBalBBefore ?? 0);
  const agentDeltaB = (agentBalBAfter ?? 0) - (agentBalBBefore ?? 0);
  console.log(`  ${c.dim}creator delta: ${creatorDeltaB.toFixed(6)}   agent delta: ${agentDeltaB.toFixed(6)}${c.reset}`);
  expect(Math.abs(creatorDeltaB - 3) < 0.01, `creator received ~3 USDC refund on-chain`);
  expect(Math.abs(agentDeltaB) < 0.01, `agent received nothing (work disputed)`);

  // ════════════════════════════════════════════════════
  console.log(`\n${c.bold}${c.cyan}════ Results ════${c.reset}`);
  console.log(`  passed: ${pass}`);
  if (fail > 0) console.log(`  ${c.red}failed: ${fail}${c.reset}`);
  console.log(`  scenario A bounty: ${API.replace('bard-production-e88b.up.railway.app', 'bard-six.vercel.app')}/bounties/${A.bountyId}`);
  console.log(`  scenario B bounty: ${API.replace('bard-production-e88b.up.railway.app', 'bard-six.vercel.app')}/bounties/${B.bountyId}`);
  console.log(`  release tx (A):    ${verifyA.data?.bounty?.release_tx_hash}`);
  console.log();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(`\n${c.red}✗ Test crashed:${c.reset} ${err.message}\n`);
  process.exit(2);
});
