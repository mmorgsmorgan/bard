#!/usr/bin/env node
/**
 * Live MCP-driven refund-path walkthrough.
 *
 * Same proposal setup as test-hybrid-mcp-live.mjs, but at step 7 the platform
 * verifier returns decision="rejected". Backend should:
 *   - escrow_status → 'refunded'
 *   - status        → 'cancelled'
 *   - transfer escrow_budget_usdc on-chain from platform wallet → creator wallet
 *
 * Asserts the creator's USDC balance on Arc Testnet went up by the refund
 * amount. The frontend bounty card should land on the "Cancelled" pill.
 *
 * Costs ~3 USDC of platform funds per run (the refund is real money out).
 */

import 'dotenv/config';
import readline from 'readline';
import { createPublicClient, http } from 'viem';

const API = (process.env.BARD_API || 'https://bard-production-413a.up.railway.app').replace(/\/$/, '');
const MCP = (process.env.BARD_MCP_URL || 'https://mellow-balance-production-25cb.up.railway.app').replace(/\/$/, '');
const FRONTEND = (process.env.BARD_FRONTEND || 'https://bard-six.vercel.app').replace(/\/$/, '');
const PLATFORM_OWNER = (process.env.PLATFORM_OWNER_WALLET || '0x93d8E072b983b3119ffffc9F826fd14Ef03513Cd');
const ARC_RPC = 'https://rpc.testnet.arc.network';
const USDC = '0x3600000000000000000000000000000000000000';
const ARC_CHAIN_ID = 5042002;

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', dim: '\x1b[2m', magenta: '\x1b[35m', bold: '\x1b[1m',
};

const AUTO_PACE = parseInt(process.env.BARD_AUTO_PACE || '0', 10);
const rl = AUTO_PACE > 0 ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
const pause = (msg) => new Promise((resolve) => {
  console.log(`\n${c.yellow}⏸  ${msg}${c.reset}`);
  if (AUTO_PACE > 0) {
    console.log(`${c.dim}   (sleeping ${AUTO_PACE}s)${c.reset}`);
    setTimeout(resolve, AUTO_PACE * 1000);
  } else {
    rl.question(`${c.dim}   (press Enter)${c.reset} `, () => resolve());
  }
});

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
async function mcp(token, method, params = {}, attempt = 1) {
  const id = ++rpcId;
  try {
    const res = await fetch(`${MCP}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (res.status === 204) return null;
    const out = await res.json();
    if (out.error) throw new Error(out.error.message);
    return out.result;
  } catch (err) {
    if (attempt < 3 && (err.cause?.code || err.message).match(/fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i)) {
      await new Promise(r => setTimeout(r, 800 * attempt));
      return mcp(token, method, params, attempt + 1);
    }
    throw new Error(`MCP ${method}: ${err.message}`);
  }
}
async function mcpTool(token, tool, args = {}) {
  const out = await mcp(token, 'tools/call', { name: tool, arguments: args });
  const raw = out?.content?.[0]?.text;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return { raw }; }
}

async function provisionAgent(name, type) {
  const reg = await apiFetch('/api/agents/register', {
    method: 'POST',
    body: JSON.stringify({
      ownerWallet: '0x0000000000000000000000000000000000000000',
      agentName: name,
      agentPublicKey: 'turnkey-pending-' + Date.now() + Math.random().toString(36).slice(2, 6),
      agentType: type,
      description: `refund path test — ${type}`,
    }),
  });
  if (!reg.ok) throw new Error(`register ${name}: ${reg.data.error || reg.data.raw}`);
  const agentId = reg.data.agent?.id || reg.data.agentId;
  const token = reg.data.token;
  const w = await apiFetch(`/api/agents/${agentId}/wallet`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
  if (!w.ok || !w.data.address) throw new Error(`turnkey ${name}: ${w.data.error}`);
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

const bountyUrl = (id) => `${FRONTEND}/bounties/${id}`;

async function run() {
  console.log(`${c.bold}${c.cyan}\n════ BARD Live MCP Refund Path ════${c.reset}`);
  console.log(`${c.dim}API: ${API}  |  MCP: ${MCP}  |  Verifier: ${PLATFORM_OWNER}${c.reset}\n`);

  const h = await apiFetch('/api/health');
  if (!h.ok) throw new Error(`health: ${h.status}`);
  console.log(`${c.cyan}▸ 0.${c.reset} backend up, platform balance=${h.data.platformWallet?.balance_usdc} USDC`);
  if (parseFloat(h.data.platformWallet?.balance_usdc || '0') < 4) {
    throw new Error('Platform balance < 4 USDC — refund test costs ~3 USDC, top up first');
  }

  const pub = createPublicClient({
    chain: { id: ARC_CHAIN_ID, name: 'Arc Testnet', nativeCurrency:{ name:'USDC', symbol:'USDC', decimals:6 }, rpcUrls:{ default:{ http:[ARC_RPC] } } },
    transport: http(ARC_RPC),
  });

  // ── 1. Provision creator + 1 bidder (only 1 needed for refund path)
  console.log(`\n${c.cyan}▸ 1. Provisioning creator + 1 bidder${c.reset}`);
  const stamp = Date.now().toString(36);
  const [creator, A] = await Promise.all([
    provisionAgent(`rf-creator-${stamp}`, 'research'),
    provisionAgent(`rf-bidder-${stamp}`, 'research'),
  ]);
  console.log(`  ${c.green}✓${c.reset} creator wallet=${creator.wallet}`);
  console.log(`  ${c.green}✓${c.reset} bidder  wallet=${A.wallet}`);

  // ── 2. Create proposal-mode bounty
  console.log(`\n${c.cyan}▸ 2. Proposal-mode bounty${c.reset}`);
  const cb = await mcpTool(creator.token, 'bard_create_bounty', {
    title: `Refund-path test — ${stamp}`,
    description: 'Deliverable will be rejected by the platform verifier; escrow refunds to creator.',
    bountyType: 'research',
    amountUsdc: '5',
    deadline: new Date(Date.now() + 7 * 86400e3).toISOString(),
    selectionMode: 'proposal',
  });
  if (cb?.error) throw new Error(`create: ${cb.error}`);
  const bounty = cb.bounty;
  console.log(`  ${c.green}✓${c.reset} bounty=${bounty.id}`);
  console.log(`  ${c.magenta}→ ${bountyUrl(bounty.id)}${c.reset}`);

  // ── 3. Bidder proposes
  const sub = await mcpTool(A.token, 'bard_submit_proposal', {
    bountyId: bounty.id, plan: 'Deliberately low-effort plan for refund test.',
    proposedPriceUsdc: 3, estimatedHours: 2,
  });
  if (sub?.error) throw new Error(`propose: ${sub.error}`);
  console.log(`  ${c.green}✓${c.reset} A proposal price=3 id=${sub.proposal.id}`);

  // ── 4. Accept + fund + deliver + review (all approved up to platform-verify)
  await mcpTool(creator.token, 'bard_accept_proposal', { bountyId: bounty.id, proposalId: sub.proposal.id });
  console.log(`  ${c.green}✓${c.reset} accepted`);
  await apiFetch(`/api/bounties/${bounty.id}/fund`, {
    method: 'POST', headers: { Authorization: `Bearer ${creator.token}` },
    body: JSON.stringify({ clientWallet: creator.wallet, budgetUsdc: 3 }),
  });
  console.log(`  ${c.green}✓${c.reset} funded`);

  await pause(`Pill: ${c.bold}"Assigned"${c.reset}`);

  await mcpTool(A.token, 'bard_submit_deliverable', {
    bountyId: bounty.id,
    content: 'INTENTIONALLY LOW QUALITY DELIVERABLE for the refund test. Single line, no detail.',
  });
  console.log(`  ${c.green}✓${c.reset} delivered (intentionally weak)`);

  await pause(`Pill: ${c.bold}"Submitted"${c.reset}`);

  await apiFetch(`/api/bounties/${bounty.id}/review`, {
    method: 'POST', headers: { Authorization: `Bearer ${creator.token}` },
    body: JSON.stringify({ clientWallet: creator.wallet, decision: 'approved', reason: 'I will let the platform reject this.' }),
  });
  console.log(`  ${c.green}✓${c.reset} creator approved (so platform-verify gets the say)`);

  // ── 5. Platform verifier REJECTS → on-chain refund
  console.log(`\n${c.cyan}▸ 5. Platform verifier REJECTS the deliverable${c.reset}`);
  const creatorBalBefore = await usdcBal(pub, creator.wallet);
  const agentBalBefore = await usdcBal(pub, A.wallet);
  console.log(`  ${c.dim}creator balance before: ${creatorBalBefore?.toFixed(6) ?? '?'} USDC${c.reset}`);
  console.log(`  ${c.dim}agent   balance before: ${agentBalBefore?.toFixed(6) ?? '?'} USDC${c.reset}`);

  const verify = await apiFetch(`/api/bounties/${bounty.id}/platform-verify`, {
    method: 'POST',
    body: JSON.stringify({
      verifierWallet: PLATFORM_OWNER,
      decision: 'rejected',
      reasoning: 'Deliverable is incomplete and does not meet the brief. Refunding to creator.',
    }),
  });
  if (!verify.ok) throw new Error(`verify: ${verify.data.error}`);
  console.log(`  ${c.green}✓${c.reset} status=${verify.data.bounty?.status}  escrow=${verify.data.bounty?.escrow_status}`);

  // Wait for on-chain settle
  console.log(`  ${c.dim}waiting 6s for chain settle...${c.reset}`);
  await new Promise(r => setTimeout(r, 6000));

  const creatorBalAfter = await usdcBal(pub, creator.wallet);
  const agentBalAfter = await usdcBal(pub, A.wallet);
  console.log(`  ${c.dim}creator balance after:  ${creatorBalAfter?.toFixed(6) ?? '?'} USDC${c.reset}`);
  console.log(`  ${c.dim}agent   balance after:  ${agentBalAfter?.toFixed(6) ?? '?'} USDC${c.reset}`);

  // Assertions
  const creatorDelta = (creatorBalAfter ?? 0) - (creatorBalBefore ?? 0);
  const agentDelta = (agentBalAfter ?? 0) - (agentBalBefore ?? 0);
  let pass = 0, fail = 0;
  const expect = (cond, name) => cond ? (pass++, console.log(`  ${c.green}✓${c.reset} ${name}`)) : (fail++, console.log(`  ${c.red}✗${c.reset} ${name}`));
  expect(verify.data.bounty?.status === 'cancelled', `bounty.status === 'cancelled' (got ${verify.data.bounty?.status})`);
  expect(verify.data.bounty?.escrow_status === 'refunded', `escrow_status === 'refunded' (got ${verify.data.bounty?.escrow_status})`);
  expect(Math.abs(creatorDelta - 3) < 0.01, `creator received ~3 USDC refund on-chain (delta=${creatorDelta.toFixed(6)})`);
  expect(Math.abs(agentDelta) < 0.01, `agent received nothing (delta=${agentDelta.toFixed(6)})`);

  await pause(`Final pill: ${c.bold}"Cancelled"${c.reset} ${c.yellow}(gray)`);

  console.log(`\n${c.bold}${c.green}════ Refund Path Complete ════${c.reset}`);
  console.log(`  bounty:           ${bounty.id}`);
  console.log(`  url:              ${bountyUrl(bounty.id)}`);
  console.log(`  passed/failed:    ${pass}/${pass + fail}`);
  if (fail > 0) {
    console.log(`  ${c.red}assertions failed — investigate${c.reset}\n`);
    process.exit(1);
  }
  console.log();

  if (rl) rl.close();
  process.exit(0);
}

run().catch((err) => {
  console.error(`\n${c.red}✗ Test failed:${c.reset} ${err.message}\n`);
  if (rl) rl.close();
  process.exit(1);
});
