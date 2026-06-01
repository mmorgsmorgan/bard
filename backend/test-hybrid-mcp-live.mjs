#!/usr/bin/env node
/**
 * Live MCP-driven hybrid bounty walkthrough.
 *
 * Drives the real production BARD MCP server (no direct backend HTTP) with
 * four real agents — 1 creator + 3 bidders. Each transition pauses so you
 * can refresh the live /bounties page and watch the status pill change:
 *
 *   open  →  proposal_open  →  proposal_selected  →  assigned
 *         →  submitted  →  client_approved  →  completed (Verified)
 *
 * Usage:
 *   node test-hybrid-mcp-live.mjs
 *
 * Env (optional overrides):
 *   BARD_API     = https://bard-production-413a.up.railway.app
 *   BARD_MCP_URL = https://mellow-balance-production-25cb.up.railway.app
 *   PLATFORM_OWNER_WALLET = the prod owner wallet (defaults to live health value)
 */

import 'dotenv/config';
import readline from 'readline';

const API = (process.env.BARD_API || 'https://bard-production-413a.up.railway.app').replace(/\/$/, '');
const MCP = (process.env.BARD_MCP_URL || 'https://mellow-balance-production-25cb.up.railway.app').replace(/\/$/, '');
const FRONTEND = (process.env.BARD_FRONTEND || 'https://bard-six.vercel.app').replace(/\/$/, '');
// PLATFORM_OWNER_WALLET passed in /platform-verify body. No signature is required
// — only that this string matches a wallet in the platform_verifiers table on the
// deployed backend. The live owner is configured in Railway env.
const PLATFORM_OWNER = (process.env.PLATFORM_OWNER_WALLET || '0xA1a16e5eE45A999845eF6c7CF99b16666b2Ba3c8');

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', dim: '\x1b[2m', magenta: '\x1b[35m', bold: '\x1b[1m',
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pause = (msg) => new Promise((resolve) => {
  console.log(`\n${c.yellow}⏸  ${msg}${c.reset}`);
  console.log(`${c.dim}   (press Enter to continue, Ctrl-C to stop)${c.reset}`);
  rl.question('', () => resolve());
});

// ── HTTP helpers ──────────────────────────────────────
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
  const id = ++rpcId;
  const res = await fetch(`${MCP}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (res.status === 204) return null;
  const out = await res.json();
  if (out.error) throw new Error(`MCP ${method}: ${out.error.message}`);
  return out.result;
}

async function mcpTool(token, tool, args = {}) {
  const out = await mcp(token, 'tools/call', { name: tool, arguments: args });
  const raw = out?.content?.[0]?.text;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return { raw }; }
}

// ── Agent provisioning (uses backend register + Turnkey wallet endpoint) ──
async function provisionAgent(name, type) {
  // 1) Register agent → returns agentId + JWT
  const reg = await apiFetch('/api/agents/register', {
    method: 'POST',
    body: JSON.stringify({
      ownerWallet: '0x0000000000000000000000000000000000000000',
      agentName: name,
      agentPublicKey: 'turnkey-pending-' + Date.now() + Math.random().toString(36).slice(2, 6),
      agentType: type,
      description: `live MCP hybrid test — ${type}`,
    }),
  });
  if (!reg.ok) throw new Error(`register ${name}: ${reg.data.error || reg.data.raw}`);
  const agentId = reg.data.agent?.id || reg.data.agentId;
  const token = reg.data.token;
  if (!token) throw new Error(`register ${name}: no token returned`);

  // 2) Provision Turnkey wallet
  const w = await apiFetch(`/api/agents/${agentId}/wallet`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
  if (!w.ok || !w.data.address) throw new Error(`turnkey ${name}: ${w.data.error || 'no address'}`);

  return { name, type, agentId, token, wallet: w.data.address };
}

async function balanceOf(wallet) {
  // Pull from the public /api/agents/:id snapshot? The simplest signal is the
  // platform health for the seller wallet. For agent balances we'd need a
  // public RPC. Here we just rely on the test backend's verification path.
  return null;
}

function bountyUrl(id) {
  return `${FRONTEND}/bounties/${id}`;
}

// ── Main flow ─────────────────────────────────────────
async function run() {
  console.log(`${c.bold}${c.cyan}\n════ BARD Live MCP Hybrid Bounty Walkthrough ════${c.reset}`);
  console.log(`${c.dim}API:       ${API}`);
  console.log(`MCP:       ${MCP}`);
  console.log(`Frontend:  ${FRONTEND}`);
  console.log(`Verifier:  ${PLATFORM_OWNER}${c.reset}\n`);

  // ── 0. Health
  console.log(`${c.cyan}▸ 0. Probing live services${c.reset}`);
  const h = await apiFetch('/api/health');
  if (!h.ok) throw new Error(`backend health: ${h.data.error || h.status}`);
  console.log(`  ✓ backend up — turnkey=${h.data.turnkey}, platform balance=${h.data.platformWallet?.balance_usdc} USDC`);
  if (!h.data.turnkey) throw new Error('Turnkey not enabled on prod backend — cannot run live test');
  if (parseFloat(h.data.platformWallet?.balance_usdc || '0') < 1) {
    throw new Error('Platform wallet has <1 USDC — top up before running');
  }
  const mh = await fetch(`${MCP}/health`).then(r => r.json()).catch(() => null);
  if (!mh) throw new Error('MCP /health unreachable');
  console.log(`  ✓ MCP up (${mh.service})`);

  // ── 1. Provision creator + 3 bidders
  console.log(`\n${c.cyan}▸ 1. Provisioning 1 creator + 3 bidder agents${c.reset}`);
  const stamp = Date.now().toString(36);
  const [creator, A, B, C] = await Promise.all([
    provisionAgent(`live-creator-${stamp}`, 'research'),
    provisionAgent(`live-bidder-a-${stamp}`, 'research'),
    provisionAgent(`live-bidder-b-${stamp}`, 'research'),
    provisionAgent(`live-bidder-c-${stamp}`, 'research'),
  ]);
  for (const a of [creator, A, B, C]) {
    console.log(`  ${c.green}✓${c.reset} ${a.name.padEnd(28)} ${c.dim}agent=${a.agentId.slice(0, 12)}…  wallet=${a.wallet}${c.reset}`);
  }

  // Sanity: confirm identity via MCP for each
  for (const a of [creator, A, B, C]) {
    const me = await mcpTool(a.token, 'bard_get_identity');
    if (!me?.authenticated && !me?.agent) {
      throw new Error(`bard_get_identity failed for ${a.name}: ${JSON.stringify(me)}`);
    }
  }
  console.log(`  ${c.green}✓${c.reset} all 4 BARD_TOKENs accepted by MCP`);

  // ── 2. Create proposal-mode bounty via MCP
  console.log(`\n${c.cyan}▸ 2. Creator posts a proposal-mode bounty via MCP${c.reset}`);
  const deadlineISO = new Date(Date.now() + 7 * 86400e3).toISOString();
  const cb = await mcpTool(creator.token, 'bard_create_bounty', {
    title: `Live walkthrough — ${stamp}`,
    description: 'End-to-end live test: 3 agents bargain via proposals, you watch the pill change.',
    bountyType: 'research',
    amountUsdc: '5',
    deadline: deadlineISO,
    selectionMode: 'proposal',
  });
  if (cb?.error) throw new Error(`create bounty: ${cb.error}`);
  const bounty = cb.bounty;
  if (!bounty?.id) throw new Error(`create bounty: no id in response — ${JSON.stringify(cb)}`);
  console.log(`  ${c.green}✓${c.reset} bounty created  id=${bounty.id}  status=${bounty.status}`);
  console.log(`  ${c.magenta}→ open in frontend:  ${bountyUrl(bounty.id)}${c.reset}`);

  await pause(`Frontend should show pill: ${c.bold}"Proposals Open"${c.reset} ${c.yellow}(cyan)`);

  // ── 3. Three bidders submit proposals at different prices via MCP
  console.log(`\n${c.cyan}▸ 3. Bidders A/B/C submit proposals via MCP${c.reset}`);
  const submits = await Promise.all([
    mcpTool(A.token, 'bard_submit_proposal', {
      bountyId: bounty.id,
      plan: 'Approach A: thorough investigation with citations. 5 hours.',
      proposedPriceUsdc: 4,
      estimatedHours: 5,
    }),
    mcpTool(B.token, 'bard_submit_proposal', {
      bountyId: bounty.id,
      plan: 'Approach B: focused analysis, faster turnaround. 3 hours.',
      proposedPriceUsdc: 3,
      estimatedHours: 3,
    }),
    mcpTool(C.token, 'bard_submit_proposal', {
      bountyId: bounty.id,
      plan: 'Approach C: premium deliverable with extras. 8 hours.',
      proposedPriceUsdc: 5,
      estimatedHours: 8,
    }),
  ]);
  for (const [i, s] of submits.entries()) {
    const tag = ['A', 'B', 'C'][i];
    if (s?.error) throw new Error(`proposal ${tag}: ${s.error}`);
    console.log(`  ${c.green}✓${c.reset} ${tag} proposal id=${s.proposal?.id?.slice(0, 14)}…  price=${s.proposal?.proposed_price_usdc}`);
  }

  // Bargaining message (B answers a clarification)
  const msg1 = await mcpTool(creator.token, 'bard_send_bounty_message', {
    bountyId: bounty.id,
    proposalId: submits[1].proposal.id,
    message: 'Hi B — can you commit to 3 hours?',
  });
  if (msg1?.error) throw new Error(`creator->B msg: ${msg1.error}`);
  const msg2 = await mcpTool(B.token, 'bard_send_bounty_message', {
    bountyId: bounty.id,
    proposalId: submits[1].proposal.id,
    message: 'Yes — 3 hours confirmed.',
  });
  if (msg2?.error) throw new Error(`B->creator msg: ${msg2.error}`);
  console.log(`  ${c.green}✓${c.reset} message thread exchanged (creator ⇄ B)`);

  await pause(`Still ${c.bold}"Proposals Open"${c.reset}${c.yellow} — but 3 proposals are now visible to the creator`);

  // ── 4. Creator accepts B
  console.log(`\n${c.cyan}▸ 4. Creator accepts B's proposal via MCP${c.reset}`);
  const acc = await mcpTool(creator.token, 'bard_accept_proposal', {
    bountyId: bounty.id,
    proposalId: submits[1].proposal.id,
  });
  if (acc?.error) throw new Error(`accept: ${acc.error}`);
  console.log(`  ${c.green}✓${c.reset} accepted — bounty.status=${acc.bounty?.status}  amount=${acc.bounty?.amount_usdc}  rejected siblings=${acc.rejectedProposalCount}`);

  await pause(`Frontend pill should now read ${c.bold}"Awaiting Funding"${c.reset}${c.yellow} (amber)`);

  // ── 5. Fund the bounty
  //
  // Funding requires the creator's wallet to send USDC to the platform's
  // SELLER_ADDRESS on Arc Testnet. The creator wallet was just minted by
  // Turnkey and has 0 USDC. We have two options:
  //   (a) call the Circle faucet to drip 40 USDC to the creator wallet, then
  //       send 3 USDC on-chain to SELLER_ADDRESS, then pass txHash to /fund
  //   (b) call /fund without txHash — the backend logs a warning and proceeds
  //       (the validation path is "if txHash, verify; else skip"). This is
  //       the backward-compat branch used by test-hybrid-flow.mjs.
  //
  // We take (b) for the live walkthrough because the user's intent is to see
  // the pill transitions — not to demonstrate on-chain ingress. The platform
  // wallet (already funded) still pays out the bidder for real in step 8.
  console.log(`\n${c.cyan}▸ 5. Creator funds bounty (no txHash — escrow lock only)${c.reset}`);
  const fund = await apiFetch(`/api/bounties/${bounty.id}/fund`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creator.token}` },
    body: JSON.stringify({
      clientWallet: creator.wallet,
      budgetUsdc: parseFloat(acc.bounty.amount_usdc),
    }),
  });
  if (!fund.ok) throw new Error(`fund: ${fund.data.error || fund.status}`);
  console.log(`  ${c.green}✓${c.reset} funded — status=${fund.data.bounty?.status}  escrow=${fund.data.bounty?.escrow_status}  provider=${fund.data.bounty?.provider_agent_id}`);
  if (fund.data.bounty?.provider_agent_id !== B.agentId) {
    throw new Error(`auto-claim went to wrong agent: ${fund.data.bounty?.provider_agent_id}`);
  }

  await pause(`Frontend pill should now read ${c.bold}"Assigned"${c.reset}${c.yellow} (blue)`);

  // ── 6. B delivers via MCP
  console.log(`\n${c.cyan}▸ 6. B submits the deliverable via MCP${c.reset}`);
  const deliver = await mcpTool(B.token, 'bard_submit_deliverable', {
    bountyId: bounty.id,
    content: 'Final report: detailed analysis of the topic with key findings, recommendations, and references. ' +
      'Includes data sources, methodology notes, and a one-page executive summary.',
  });
  if (deliver?.error) throw new Error(`deliver: ${deliver.error}`);
  console.log(`  ${c.green}✓${c.reset} delivered — status=${deliver.bounty?.status}  escrow=${deliver.bounty?.escrow_status}`);

  await pause(`Frontend pill should now read ${c.bold}"Submitted"${c.reset}${c.yellow} (yellow)`);

  // ── 7. Creator reviews → approves
  console.log(`\n${c.cyan}▸ 7. Creator approves the deliverable${c.reset}`);
  const review = await apiFetch(`/api/bounties/${bounty.id}/review`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creator.token}` },
    body: JSON.stringify({
      clientWallet: creator.wallet,
      decision: 'approved',
      reason: 'Excellent work, all requirements met.',
    }),
  });
  if (!review.ok) throw new Error(`review: ${review.data.error || review.status}`);
  console.log(`  ${c.green}✓${c.reset} reviewed — escrow=${review.data.bounty?.escrow_status} (client_approved; awaiting platform verifier)`);

  // ── 8. Platform verifier releases escrow → real USDC payout
  console.log(`\n${c.cyan}▸ 8. Platform verifier releases escrow (REAL USDC TRANSFER)${c.reset}`);
  console.log(`  ${c.dim}verifierWallet = ${PLATFORM_OWNER}${c.reset}`);
  const verify = await apiFetch(`/api/bounties/${bounty.id}/platform-verify`, {
    method: 'POST',
    body: JSON.stringify({
      verifierWallet: PLATFORM_OWNER,
      decision: 'approved',
      reasoning: 'All quality checks passed. Released.',
    }),
  });
  if (!verify.ok) {
    console.log(`  ${c.red}✗${c.reset} platform-verify failed: ${verify.data.error}`);
    console.log(`  ${c.dim}If 403 "not a platform verifier", set PLATFORM_OWNER_WALLET env to a real verifier.${c.reset}`);
    throw new Error(`platform-verify: ${verify.data.error}`);
  }
  console.log(`  ${c.green}✓${c.reset} released — status=${verify.data.bounty?.status}  escrow=${verify.data.bounty?.escrow_status}`);
  if (verify.data.bounty?.release_tx_hash) {
    console.log(`  ${c.green}→${c.reset} on-chain tx: ${c.bold}${verify.data.bounty.release_tx_hash}${c.reset}`);
    console.log(`  ${c.dim}   https://testnet.arcscan.app/tx/${verify.data.bounty.release_tx_hash}${c.reset}`);
  }

  await pause(`Final pill: ${c.bold}"Verified"${c.reset}${c.yellow} (orange) — bounty card is complete`);

  // ── Summary
  console.log(`\n${c.bold}${c.green}════ Walkthrough Complete ════${c.reset}`);
  console.log(`  bounty:       ${bounty.id}`);
  console.log(`  url:          ${bountyUrl(bounty.id)}`);
  console.log(`  release tx:   ${verify.data.bounty?.release_tx_hash || '(none)'}`);
  console.log(`  winning bid:  B at ${acc.bounty.amount_usdc} USDC → ${B.wallet}`);
  console.log(`  losing bids:  A (${submits[0].proposal?.proposed_price_usdc}) + C (${submits[2].proposal?.proposed_price_usdc}) auto-rejected\n`);

  rl.close();
  process.exit(0);
}

run().catch((err) => {
  console.error(`\n${c.red}✗ Test failed:${c.reset} ${err.message}\n`);
  rl.close();
  process.exit(1);
});
