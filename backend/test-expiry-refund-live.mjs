#!/usr/bin/env node
/**
 * Live expiry auto-refund walkthrough.
 *
 * Funds a real bounty, then uses the platform-verifier-only
 * /api/admin/bounties/:id/force-expire endpoint to push expires_at into
 * the past and trigger the sweep. The sweep should:
 *   - call transferUSDCFromPlatform(creator_wallet, escrow_budget_usdc)
 *   - flip escrow_status → 'refunded' and status → 'expired'
 *   - log an escrow_event of type 'expired' with the real tx hash
 *   - notify creator + agent
 *
 * Asserts the creator's on-chain USDC balance went up by the refund
 * amount and the agent received nothing.
 *
 * Costs ~3 USDC of platform funds per run.
 *
 * Env:
 *   BARD_API                — backend URL (default prod)
 *   BARD_MCP_URL            — MCP URL (default prod)
 *   PLATFORM_OWNER_WALLET   — bootstrap verifier (gates the admin endpoint)
 *   BARD_AUTO_PACE=20       — non-interactive mode, sleeps 20s between pauses
 */

import 'dotenv/config';
import readline from 'readline';
import { createPublicClient, http } from 'viem';

const API = (process.env.BARD_API || 'https://bard-production-e88b.up.railway.app').replace(/\/$/, '');
const MCP = (process.env.BARD_MCP_URL || 'https://mcp-production-8d2e.up.railway.app').replace(/\/$/, '');
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
      description: `expiry refund test — ${type}`,
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
  console.log(`${c.bold}${c.cyan}\n════ BARD Live Expiry Auto-Refund ════${c.reset}`);
  console.log(`${c.dim}API: ${API}  |  Verifier: ${PLATFORM_OWNER}${c.reset}\n`);

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

  // ── 1. Provision creator + agent
  console.log(`\n${c.cyan}▸ 1. Provisioning creator + agent${c.reset}`);
  const stamp = Date.now().toString(36);
  const [creator, agent] = await Promise.all([
    provisionAgent(`ex-creator-${stamp}`, 'research'),
    provisionAgent(`ex-agent-${stamp}`, 'research'),
  ]);
  console.log(`  ${c.green}✓${c.reset} creator wallet=${creator.wallet}`);
  console.log(`  ${c.green}✓${c.reset} agent   wallet=${agent.wallet}`);

  // ── 2. Create + fund a first-come bounty (no proposal flow needed)
  console.log(`\n${c.cyan}▸ 2. Create + fund a first-come bounty${c.reset}`);
  const cb = await mcpTool(creator.token, 'bard_create_bounty', {
    title: `Expiry-path test — ${stamp}`,
    description: 'Bounty will be auto-refunded via the expiry sweep before any agent delivers.',
    bountyType: 'research',
    amountUsdc: '3',
    deadline: new Date(Date.now() + 7 * 86400e3).toISOString(),
    selectionMode: 'first_come',
  });
  if (cb?.error) throw new Error(`create: ${cb.error}`);
  const bounty = cb.bounty;
  console.log(`  ${c.green}✓${c.reset} bounty=${bounty.id}`);
  console.log(`  ${c.magenta}→ ${bountyUrl(bounty.id)}${c.reset}`);

  const fund = await apiFetch(`/api/bounties/${bounty.id}/fund`, {
    method: 'POST', headers: { Authorization: `Bearer ${creator.token}` },
    body: JSON.stringify({ clientWallet: creator.wallet, budgetUsdc: 3 }),
  });
  if (!fund.ok) throw new Error(`fund: ${fund.data.error}`);
  console.log(`  ${c.green}✓${c.reset} funded — escrow=${fund.data.bounty.escrow_status}, expires_at=${fund.data.bounty.expires_at}`);

  await pause(`Pill should show: ${c.bold}"Open"${c.reset} (funded, unclaimed)`);

  // ── 3. Force-expire + sweep
  console.log(`\n${c.cyan}▸ 3. Force-expire via admin endpoint + run sweep${c.reset}`);
  const creatorBalBefore = await usdcBal(pub, creator.wallet);
  const agentBalBefore = await usdcBal(pub, agent.wallet);
  console.log(`  ${c.dim}creator balance before: ${creatorBalBefore?.toFixed(6) ?? '?'} USDC${c.reset}`);
  console.log(`  ${c.dim}agent   balance before: ${agentBalBefore?.toFixed(6) ?? '?'} USDC${c.reset}`);

  const force = await apiFetch(`/api/admin/bounties/${bounty.id}/force-expire`, {
    method: 'POST',
    body: JSON.stringify({ verifierWallet: PLATFORM_OWNER }),
  });
  if (!force.ok) throw new Error(`force-expire: ${force.data.error}`);
  console.log(`  ${c.green}✓${c.reset} sweep result: refunded=${force.data.refunded?.length || 0}, failed=${force.data.failed?.length || 0}, skipped=${force.data.skipped?.length || 0}`);
  const refundEntry = (force.data.refunded || []).find(r => r.id === bounty.id);
  if (!refundEntry) {
    console.log(`  ${c.red}✗${c.reset} bounty not in refunded summary:`, JSON.stringify(force.data, null, 2));
  } else {
    console.log(`  ${c.green}✓${c.reset} refund tx: ${refundEntry.tx}`);
  }

  // Wait for chain settle
  console.log(`  ${c.dim}waiting 6s for chain settle...${c.reset}`);
  await new Promise(r => setTimeout(r, 6000));

  const creatorBalAfter = await usdcBal(pub, creator.wallet);
  const agentBalAfter = await usdcBal(pub, agent.wallet);
  console.log(`  ${c.dim}creator balance after:  ${creatorBalAfter?.toFixed(6) ?? '?'} USDC${c.reset}`);
  console.log(`  ${c.dim}agent   balance after:  ${agentBalAfter?.toFixed(6) ?? '?'} USDC${c.reset}`);

  // Fetch escrow event trail
  const escrow = await apiFetch(`/api/bounties/${bounty.id}/escrow`);
  const expiredEvent = (escrow.data.events || []).find(e => e.event_type === 'expired');

  // Assertions
  const creatorDelta = (creatorBalAfter ?? 0) - (creatorBalBefore ?? 0);
  const agentDelta = (agentBalAfter ?? 0) - (agentBalBefore ?? 0);
  let pass = 0, fail = 0;
  const expect = (cond, name) => cond ? (pass++, console.log(`  ${c.green}✓${c.reset} ${name}`)) : (fail++, console.log(`  ${c.red}✗${c.reset} ${name}`));

  console.log(`\n${c.cyan}▸ 4. Assertions${c.reset}`);
  expect(!!refundEntry, `sweep summary lists bounty as refunded`);
  expect(force.data.bounty?.status === 'expired', `bounty.status === 'expired' (got ${force.data.bounty?.status})`);
  expect(force.data.bounty?.escrow_status === 'refunded', `escrow_status === 'refunded' (got ${force.data.bounty?.escrow_status})`);
  expect(Math.abs(creatorDelta - 3) < 0.01, `creator received ~3 USDC refund on-chain (delta=${creatorDelta.toFixed(6)})`);
  expect(Math.abs(agentDelta) < 0.01, `agent received nothing (delta=${agentDelta.toFixed(6)})`);
  expect(!!expiredEvent, `escrow_events has an 'expired' row`);
  expect(!!(expiredEvent?.tx_hash && expiredEvent.tx_hash.length > 10), `'expired' event records a real tx_hash (got ${expiredEvent?.tx_hash})`);
  if (refundEntry && expiredEvent) {
    expect(refundEntry.tx === expiredEvent.tx_hash, `sweep summary tx matches escrow_event tx`);
  }

  await pause(`Final pill: ${c.bold}"Expired"${c.reset} (escrow refunded)`);

  console.log(`\n${c.bold}${c.green}════ Expiry Auto-Refund Complete ════${c.reset}`);
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
