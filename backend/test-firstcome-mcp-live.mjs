#!/usr/bin/env node
/**
 * Live MCP-driven first-come bounty walkthrough.
 *
 * Mirror of test-hybrid-mcp-live.mjs but for selectionMode=first_come:
 *
 *   1. Creator posts a normal (first_come) bounty   → status=open
 *   2. Creator funds it                              → escrow=funded (still open)
 *   3. Agent A races to bard_claim_bounty (wins)     → status=assigned
 *   4. Agent B tries to claim too late → 409          (no transition)
 *   5. A delivers                                    → status=submitted
 *   6. Creator approves                              → escrow=client_approved
 *   7. Platform verifier releases                    → status=completed + real USDC tx
 *
 * Usage:
 *   PLATFORM_OWNER_WALLET=0x… BARD_AUTO_PACE=20 node test-firstcome-mcp-live.mjs
 */

import 'dotenv/config';
import readline from 'readline';

const API = (process.env.BARD_API || 'https://bard-production-e88b.up.railway.app').replace(/\/$/, '');
const MCP = (process.env.BARD_MCP_URL || 'https://mcp-production-8d2e.up.railway.app').replace(/\/$/, '');
const FRONTEND = (process.env.BARD_FRONTEND || 'https://bard-six.vercel.app').replace(/\/$/, '');
const PLATFORM_OWNER = (process.env.PLATFORM_OWNER_WALLET || '0x93d8E072b983b3119ffffc9F826fd14Ef03513Cd');

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', dim: '\x1b[2m', magenta: '\x1b[35m', bold: '\x1b[1m',
};

const AUTO_PACE = parseInt(process.env.BARD_AUTO_PACE || '0', 10);
const rl = AUTO_PACE > 0 ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
const pause = (msg) => new Promise((resolve) => {
  console.log(`\n${c.yellow}⏸  ${msg}${c.reset}`);
  if (AUTO_PACE > 0) {
    console.log(`${c.dim}   (auto-pace: sleeping ${AUTO_PACE}s — refresh the frontend now)${c.reset}`);
    setTimeout(resolve, AUTO_PACE * 1000);
  } else {
    console.log(`${c.dim}   (press Enter to continue)${c.reset}`);
    rl.question('', () => resolve());
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
      description: `live first-come MCP test — ${type}`,
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
  if (!w.ok || !w.data.address) throw new Error(`turnkey ${name}: ${w.data.error || 'no address'}`);
  return { name, agentId, token, wallet: w.data.address };
}

const bountyUrl = (id) => `${FRONTEND}/bounties/${id}`;

async function run() {
  console.log(`${c.bold}${c.cyan}\n════ BARD Live MCP First-Come Walkthrough ════${c.reset}`);
  console.log(`${c.dim}API: ${API}  |  MCP: ${MCP}  |  Verifier: ${PLATFORM_OWNER}${c.reset}\n`);

  // ── 0. Health
  console.log(`${c.cyan}▸ 0. Probing live services${c.reset}`);
  const h = await apiFetch('/api/health');
  if (!h.ok) throw new Error(`backend health: ${h.status}`);
  console.log(`  ✓ backend ok — turnkey=${h.data.turnkey}, platform balance=${h.data.platformWallet?.balance_usdc} USDC`);
  if (!h.data.turnkey) throw new Error('Turnkey disabled on prod');
  if (parseFloat(h.data.platformWallet?.balance_usdc || '0') < 1) throw new Error('Platform wallet < 1 USDC — top up first');

  // ── 1. Provision 1 creator + 2 agents
  console.log(`\n${c.cyan}▸ 1. Provisioning 1 creator + 2 agents (A races to claim, B comes too late)${c.reset}`);
  const stamp = Date.now().toString(36);
  const [creator, A, B] = await Promise.all([
    provisionAgent(`fc-creator-${stamp}`, 'research'),
    provisionAgent(`fc-bidder-a-${stamp}`, 'research'),
    provisionAgent(`fc-bidder-b-${stamp}`, 'research'),
  ]);
  for (const a of [creator, A, B]) {
    console.log(`  ${c.green}✓${c.reset} ${a.name.padEnd(24)} wallet=${a.wallet}`);
  }

  // ── 2. Create first_come bounty
  console.log(`\n${c.cyan}▸ 2. Creator posts a first_come bounty via MCP${c.reset}`);
  const cb = await mcpTool(creator.token, 'bard_create_bounty', {
    title: `First-come live test — ${stamp}`,
    description: 'Race to claim, deliver, get paid.',
    bountyType: 'research',
    amountUsdc: '2',
    deadline: new Date(Date.now() + 7 * 86400e3).toISOString(),
    // omit selectionMode → defaults to first_come
  });
  if (cb?.error) throw new Error(`create: ${cb.error}`);
  const bounty = cb.bounty;
  console.log(`  ${c.green}✓${c.reset} bounty=${bounty.id}  status=${bounty.status}  mode=${bounty.selection_mode || 'first_come'}`);
  console.log(`  ${c.magenta}→ ${bountyUrl(bounty.id)}${c.reset}`);

  await pause(`Pill: ${c.bold}"Open"${c.reset} ${c.yellow}(emerald)`);

  // ── 3. Creator funds (stays open, escrow becomes funded)
  console.log(`\n${c.cyan}▸ 3. Creator funds the bounty (no txHash — escrow lock only)${c.reset}`);
  const fund = await apiFetch(`/api/bounties/${bounty.id}/fund`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creator.token}` },
    body: JSON.stringify({ clientWallet: creator.wallet, budgetUsdc: 2 }),
  });
  if (!fund.ok) throw new Error(`fund: ${fund.data.error}`);
  console.log(`  ${c.green}✓${c.reset} status=${fund.data.bounty?.status}  escrow=${fund.data.bounty?.escrow_status}`);

  await pause(`Still ${c.bold}"Open"${c.reset}${c.yellow} — bounty is funded and waiting for first claimer`);

  // ── 4. A claims via MCP (wins). B claims after → 409.
  console.log(`\n${c.cyan}▸ 4. A races to bard_claim_bounty (should win)${c.reset}`);
  const claimA = await mcpTool(A.token, 'bard_claim_bounty', { bountyId: bounty.id });
  if (claimA?.error) throw new Error(`A claim: ${claimA.error}`);
  console.log(`  ${c.green}✓${c.reset} A claimed — bounty.status=${claimA.bounty?.status}  escrow=${claimA.bounty?.escrow_status}`);
  if (claimA.bounty?.provider_agent_id !== A.agentId) {
    throw new Error(`provider should be A (${A.agentId}); got ${claimA.bounty?.provider_agent_id}`);
  }

  console.log(`\n${c.cyan}▸ 4b. B tries to claim too late (expect 409)${c.reset}`);
  const claimB = await mcpTool(B.token, 'bard_claim_bounty', { bountyId: bounty.id });
  if (claimB?.error) {
    console.log(`  ${c.green}✓${c.reset} B was correctly rejected: "${claimB.error}"`);
  } else {
    throw new Error(`B should have been rejected but got: ${JSON.stringify(claimB)}`);
  }

  await pause(`Pill: ${c.bold}"Assigned"${c.reset} ${c.yellow}(blue)`);

  // ── 5. A delivers
  console.log(`\n${c.cyan}▸ 5. A submits the deliverable via MCP${c.reset}`);
  const deliver = await mcpTool(A.token, 'bard_submit_deliverable', {
    bountyId: bounty.id,
    content: 'First-come final report: complete, well-cited research output with summary, sources, and key takeaways.',
  });
  if (deliver?.error) throw new Error(`deliver: ${deliver.error}`);
  console.log(`  ${c.green}✓${c.reset} status=${deliver.bounty?.status}  escrow=${deliver.bounty?.escrow_status}`);

  await pause(`Pill: ${c.bold}"Submitted"${c.reset} ${c.yellow}(yellow)`);

  // ── 6. Creator approves
  console.log(`\n${c.cyan}▸ 6. Creator approves${c.reset}`);
  const review = await apiFetch(`/api/bounties/${bounty.id}/review`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creator.token}` },
    body: JSON.stringify({
      clientWallet: creator.wallet, decision: 'approved', reason: 'Meets brief, ship it.',
    }),
  });
  if (!review.ok) throw new Error(`review: ${review.data.error}`);
  console.log(`  ${c.green}✓${c.reset} escrow=${review.data.bounty?.escrow_status} (client_approved)`);

  // ── 7. Platform verifier releases
  console.log(`\n${c.cyan}▸ 7. Platform verifier releases (REAL USDC TRANSFER)${c.reset}`);
  const verify = await apiFetch(`/api/bounties/${bounty.id}/platform-verify`, {
    method: 'POST',
    body: JSON.stringify({
      verifierWallet: PLATFORM_OWNER, decision: 'approved', reasoning: 'Quality verified, releasing.',
    }),
  });
  if (!verify.ok) throw new Error(`verify: ${verify.data.error}`);
  console.log(`  ${c.green}✓${c.reset} status=${verify.data.bounty?.status}  escrow=${verify.data.bounty?.escrow_status}`);
  if (verify.data.bounty?.release_tx_hash) {
    console.log(`  ${c.green}→${c.reset} tx: ${c.bold}${verify.data.bounty.release_tx_hash}${c.reset}`);
    console.log(`  ${c.dim}   https://testnet.arcscan.app/tx/${verify.data.bounty.release_tx_hash}${c.reset}`);
  }

  await pause(`Final pill: ${c.bold}"Verified"${c.reset} ${c.yellow}(orange)`);

  console.log(`\n${c.bold}${c.green}════ First-Come Walkthrough Complete ════${c.reset}`);
  console.log(`  bounty:     ${bounty.id}`);
  console.log(`  url:        ${bountyUrl(bounty.id)}`);
  console.log(`  release tx: ${verify.data.bounty?.release_tx_hash || '(none)'}`);
  console.log(`  winner:     A (${A.wallet}) — B locked out by first-come\n`);

  if (rl) rl.close();
  process.exit(0);
}

run().catch((err) => {
  console.error(`\n${c.red}✗ Test failed:${c.reset} ${err.message}\n`);
  if (rl) rl.close();
  process.exit(1);
});
