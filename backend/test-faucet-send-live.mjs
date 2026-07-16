#!/usr/bin/env node
/**
 * Live MCP test of the agent-wallet money plumbing — separate from bounties.
 *
 *   1. Provision two agents A + B (each gets a Turnkey wallet)
 *   2. A calls bard_claim_faucet     → on-chain USDC balance jumps from 0
 *   3. A calls bard_send_usdc to B   → A's balance drops, B's balance jumps,
 *                                       tx hash recorded, amounts match
 *
 * Confirms the Circle faucet → Turnkey signer → ERC-20 transfer chain
 * works end-to-end through MCP.
 */

import 'dotenv/config';
import { createPublicClient, http } from 'viem';

const API = (process.env.BARD_API || 'https://bard-production-e88b.up.railway.app').replace(/\/$/, '');
const MCP = (process.env.BARD_MCP_URL || 'https://mcp-production-8d2e.up.railway.app').replace(/\/$/, '');
const ARC_RPC = 'https://rpc.testnet.arc.network';
const USDC = '0x3600000000000000000000000000000000000000';
const ARC_CHAIN_ID = 5042002;
const SEND_AMOUNT = 2.5;

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
      description: 'faucet+send test',
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

async function run() {
  console.log(`${c.bold}${c.cyan}\n════ BARD Faucet + Agent-to-Agent USDC ════${c.reset}`);
  console.log(`${c.dim}API: ${API}  |  MCP: ${MCP}${c.reset}\n`);

  const pub = createPublicClient({
    chain: { id: ARC_CHAIN_ID, name: 'Arc Testnet', nativeCurrency:{ name:'USDC', symbol:'USDC', decimals:6 }, rpcUrls:{ default:{ http:[ARC_RPC] } } },
    transport: http(ARC_RPC),
  });

  // ── 1. Provision A + B
  console.log(`${c.cyan}▸ 1. Provisioning 2 agents${c.reset}`);
  const stamp = Date.now().toString(36);
  const [A, B] = await Promise.all([
    provisionAgent(`fa-a-${stamp}`),
    provisionAgent(`fa-b-${stamp}`),
  ]);
  console.log(`  ${c.green}✓${c.reset} A wallet=${A.wallet}`);
  console.log(`  ${c.green}✓${c.reset} B wallet=${B.wallet}`);

  // Initial balances should be 0
  const a0 = await usdcBal(pub, A.wallet);
  const b0 = await usdcBal(pub, B.wallet);
  console.log(`  ${c.dim}A balance: ${a0?.toFixed(6) ?? '?'} USDC${c.reset}`);
  console.log(`  ${c.dim}B balance: ${b0?.toFixed(6) ?? '?'} USDC${c.reset}`);
  expect(a0 === 0 && b0 === 0, `both wallets start at 0 USDC`);

  // ── 2. A claims faucet via MCP
  console.log(`\n${c.cyan}▸ 2. A calls bard_claim_faucet via MCP${c.reset}`);
  const drip = await mcpTool(A.token, 'bard_claim_faucet', { blockchain: 'ARC-TESTNET', usdc: true });
  console.log(`  ${c.dim}response: ${JSON.stringify(drip).slice(0, 200)}${c.reset}`);
  if (drip?.error) {
    expect(false, `faucet drip returned error`, drip.error);
  } else {
    expect(drip?.success !== false, `faucet drip succeeded`);
  }

  // Wait for chain settle
  console.log(`  ${c.dim}waiting 8s for Circle drip to settle on-chain...${c.reset}`);
  await new Promise(r => setTimeout(r, 8000));
  const a1 = await usdcBal(pub, A.wallet);
  console.log(`  ${c.dim}A balance after drip: ${a1?.toFixed(6) ?? '?'} USDC${c.reset}`);
  expect(a1 != null && a1 >= 5, `A balance jumped after faucet (got ${a1?.toFixed(6)})`);

  // ── 3. A sends USDC to B via MCP
  console.log(`\n${c.cyan}▸ 3. A sends ${SEND_AMOUNT} USDC to B via bard_send_usdc${c.reset}`);
  const send = await mcpTool(A.token, 'bard_send_usdc', {
    to: B.wallet, amount: String(SEND_AMOUNT),
  });
  console.log(`  ${c.dim}response: ${JSON.stringify(send).slice(0, 250)}${c.reset}`);
  if (send?.error) {
    expect(false, `send failed`, send.error);
  } else {
    expect(!!send?.txHash, `send returned a txHash (got ${send?.txHash})`);
  }

  // Wait + check
  console.log(`  ${c.dim}waiting 8s for transfer to settle...${c.reset}`);
  await new Promise(r => setTimeout(r, 8000));
  const a2 = await usdcBal(pub, A.wallet);
  const b2 = await usdcBal(pub, B.wallet);
  console.log(`  ${c.dim}A balance after send: ${a2?.toFixed(6) ?? '?'} USDC  (delta ${(a2 - a1).toFixed(6)})${c.reset}`);
  console.log(`  ${c.dim}B balance after send: ${b2?.toFixed(6) ?? '?'} USDC  (delta ${b2?.toFixed(6)})${c.reset}`);

  expect(Math.abs((a1 - a2) - SEND_AMOUNT) < 0.01,
    `A balance dropped by ~${SEND_AMOUNT} (delta=${(a1 - a2).toFixed(6)})`);
  expect(Math.abs(b2 - SEND_AMOUNT) < 0.01,
    `B balance jumped to ~${SEND_AMOUNT} (got ${b2?.toFixed(6)})`);

  // ── Results
  console.log(`\n${c.bold}${c.cyan}════ Results ════${c.reset}`);
  console.log(`  passed: ${pass}`);
  if (fail > 0) console.log(`  ${c.red}failed: ${fail}${c.reset}`);
  if (send?.txHash) console.log(`  tx: https://testnet.arcscan.app/tx/${send.txHash}`);
  console.log();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(`\n${c.red}✗ Test crashed:${c.reset} ${err.message}\n`);
  process.exit(2);
});
