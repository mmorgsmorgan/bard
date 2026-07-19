#!/usr/bin/env node
/**
 * One-shot prod cleanup: deletes test-artifact agents and all their related
 * rows (bounties, proposals, messages, escrow_events, notifications, ...)
 * from the live BARD backend.
 *
 *   1. Lists all agents whose names start with any of the test prefixes
 *   2. Probes each agent's Turnkey wallet USDC balance on-chain
 *   3. SKIPS any agent with > 0 USDC (their winnings are real money)
 *   4. Of zero-balance agents, randomly KEEPS keepPercent (default 20)
 *   5. Prints the plan; with --execute, calls DELETE /api/admin/agents/:id
 *      for each, otherwise dry-run only.
 *
 * Usage:
 *   PLATFORM_OWNER_WALLET=0x… node cleanup-test-artifacts.mjs              # dry run
 *   PLATFORM_OWNER_WALLET=0x… node cleanup-test-artifacts.mjs --execute    # for real
 *   ... --keep 30        # keep 30% instead of 20
 *   ... --prefixes live-,fc-,rv-  # only those prefixes
 */

import 'dotenv/config';
import { createPublicClient, http } from 'viem';

const API = (process.env.BARD_API || 'https://bard-production-e88b.up.railway.app').replace(/\/$/, '');
const PLATFORM_OWNER = process.env.PLATFORM_OWNER_WALLET;
const ARC_RPC = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const USDC = '0x3600000000000000000000000000000000000000';
const ARC_CHAIN_ID = 5042002;
const BALANCE_PROBE_ATTEMPTS = Math.max(1, Number(process.env.CLEANUP_BALANCE_ATTEMPTS || 6));
const BALANCE_PROBE_DELAY_MS = Math.max(0, Number(process.env.CLEANUP_BALANCE_DELAY_MS || 250));

const DEFAULT_PREFIXES = ['live-', 'fc-', 'rf-', 'neg-', 'fa-', 'rv-', 'cc-', 'pc-', 'hybrid-'];

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const KEEP_PERCENT = parseInt(
  args.find(a => a.startsWith('--keep='))?.split('=')[1] ||
  (args.includes('--keep') ? args[args.indexOf('--keep') + 1] : '20'),
  10
);
const PREFIXES_ARG = args.find(a => a.startsWith('--prefixes='))?.split('=')[1] ||
  (args.includes('--prefixes') ? args[args.indexOf('--prefixes') + 1] : null);
const PREFIXES = PREFIXES_ARG ? PREFIXES_ARG.split(',').map(p => p.trim()).filter(Boolean) : DEFAULT_PREFIXES;

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m', magenta: '\x1b[35m',
};

if (!PLATFORM_OWNER) {
  console.error(`${c.red}✗${c.reset} PLATFORM_OWNER_WALLET env var required`);
  process.exit(1);
}

console.log(`${c.bold}${c.cyan}\n════ BARD test-artifact cleanup ════${c.reset}`);
console.log(`${c.dim}API:           ${API}`);
console.log(`Verifier:      ${PLATFORM_OWNER}`);
console.log(`Prefixes:      ${PREFIXES.join(', ')}`);
console.log(`Keep percent:  ${KEEP_PERCENT}% (random sample)`);
console.log(`Mode:          ${EXECUTE ? c.red + 'EXECUTE — destructive' : c.green + 'DRY-RUN — no deletes'}${c.reset}\n`);

const pub = createPublicClient({
  chain: { id: ARC_CHAIN_ID, name: 'Arc Testnet', nativeCurrency:{ name:'USDC', symbol:'USDC', decimals:6 }, rpcUrls:{ default:{ http:[ARC_RPC] } } },
  transport: http(ARC_RPC, { retryCount: 4, retryDelay: 500 }),
});
const ERC20_BAL_ABI = [{
  name: 'balanceOf', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
}];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function usdcBal(addr) {
  let lastError;
  for (let attempt = 1; attempt <= BALANCE_PROBE_ATTEMPTS; attempt++) {
    try {
      const raw = await pub.readContract({
        address: USDC, abi: ERC20_BAL_ABI, functionName: 'balanceOf', args: [addr],
      });
      return Number(raw) / 1_000_000;
    } catch (err) {
      lastError = err;
      if (attempt < BALANCE_PROBE_ATTEMPTS) {
        const backoffMs = Math.min(8_000, 500 * (2 ** (attempt - 1)));
        await sleep(backoffMs);
      }
    }
  }

  const detail = lastError?.details || lastError?.shortMessage || lastError?.message || 'unknown RPC error';
  console.warn(`\n  ${c.yellow}⚠${c.reset} balance UNKNOWN for ${addr}: ${String(detail).split('\n')[0]}`);
  return null;
}

async function listTestAgents() {
  const res = await fetch(`${API}/api/agents`);
  const data = await res.json();
  const all = data.agents || [];
  return all.filter(a => PREFIXES.some(p => (a.agentName || '').startsWith(p)));
}

async function deleteAgent(agentId) {
  const res = await fetch(`${API}/api/admin/agents/${agentId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      verifierWallet: PLATFORM_OWNER,
      confirm: true,
    }),
  });
  const data = await res.json();
  return { status: res.status, ok: res.ok, data };
}

// Fisher-Yates random shuffle
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  console.log(`${c.cyan}▸ 1. Listing test agents${c.reset}`);
  const tests = await listTestAgents();
  console.log(`  ${c.green}✓${c.reset} found ${tests.length} test agents`);
  if (tests.length === 0) {
    console.log(`\n${c.green}Nothing to clean up.${c.reset}\n`);
    return;
  }

  console.log(`\n${c.cyan}▸ 2. Probing on-chain USDC balances (skip any with > 0)${c.reset}`);
  const withBalances = [];
  for (let i = 0; i < tests.length; i++) {
    const a = tests[i];
    const bal = a.turnkeyAddress ? await usdcBal(a.turnkeyAddress) : 0;
    withBalances.push({ ...a, _balance: bal });
    if (i < tests.length - 1) await sleep(BALANCE_PROBE_DELAY_MS);
    if ((i + 1) % 10 === 0 || i === tests.length - 1) {
      process.stdout.write(`\r  ${c.dim}probed ${i + 1}/${tests.length}${c.reset}`);
    }
  }
  console.log();

  const funded = withBalances.filter(a => a._balance !== null && a._balance > 0);
  const unknown = withBalances.filter(a => a._balance === null);
  const empty = withBalances.filter(a => a._balance === 0);
  console.log(`  ${c.yellow}⚠${c.reset} ${funded.length} agents hold USDC (will be PRESERVED)`);
  for (const a of funded) {
    console.log(`    ${c.dim}${a.agentName.padEnd(28)} ${a.turnkeyAddress}  bal=${a._balance.toFixed(6)} USDC${c.reset}`);
  }
  console.log(`  ${c.yellow}⚠${c.reset} ${unknown.length} agents have UNKNOWN balance (will be PRESERVED)`);
  for (const a of unknown) {
    console.log(`    ${c.dim}${a.agentName.padEnd(28)} ${a.turnkeyAddress}${c.reset}`);
  }
  console.log(`  ${c.green}✓${c.reset} ${empty.length} agents have zero balance (candidates for cleanup)`);

  // Random keep
  const shuffled = shuffle(empty);
  const keepCount = Math.ceil(empty.length * KEEP_PERCENT / 100);
  const keep = shuffled.slice(0, keepCount);
  const drop = shuffled.slice(keepCount);

  console.log(`\n${c.cyan}▸ 3. Selection${c.reset}`);
  console.log(`  ${c.green}KEEP${c.reset}     ${keep.length} (${KEEP_PERCENT}% of empty pool, by random sample)`);
  console.log(`  ${c.red}DELETE${c.reset}   ${drop.length}`);
  console.log(`  ${c.yellow}PRESERVE${c.reset} ${funded.length} (funded)`);
  console.log(`  ${c.yellow}PRESERVE${c.reset} ${unknown.length} (balance unknown)`);
  console.log(`  ${c.dim}—— total: ${tests.length}${c.reset}`);

  console.log(`\n${c.dim}First 10 to delete:${c.reset}`);
  for (const a of drop.slice(0, 10)) {
    console.log(`  ${c.red}✗${c.reset} ${a.agentName.padEnd(28)} ${a.id}`);
  }
  if (drop.length > 10) console.log(`  ${c.dim}... and ${drop.length - 10} more${c.reset}`);

  console.log(`\n${c.dim}First 10 to keep:${c.reset}`);
  for (const a of keep.slice(0, 10)) {
    console.log(`  ${c.green}✓${c.reset} ${a.agentName.padEnd(28)} ${a.id}`);
  }
  if (keep.length > 10) console.log(`  ${c.dim}... and ${keep.length - 10} more${c.reset}`);

  if (!EXECUTE) {
    console.log(`\n${c.green}DRY-RUN complete.${c.reset} Re-run with ${c.bold}--execute${c.reset} to actually delete.\n`);
    return;
  }

  console.log(`\n${c.cyan}▸ 4. Executing deletions${c.reset}`);
  let ok = 0, fail = 0;
  for (let i = 0; i < drop.length; i++) {
    const a = drop[i];
    const r = await deleteAgent(a.id);
    if (r.ok) {
      ok++;
      process.stdout.write(`\r  ${c.green}✓${c.reset} ${ok}/${drop.length}  ${c.dim}${a.agentName}${c.reset}                    `);
    } else {
      fail++;
      console.log(`\n  ${c.red}✗${c.reset} ${a.agentName}  status=${r.status}  ${r.data?.error}`);
    }
  }
  console.log();

  console.log(`\n${c.bold}${c.cyan}════ Done ════${c.reset}`);
  console.log(`  deleted: ${c.green}${ok}${c.reset}`);
  if (fail > 0) console.log(`  failed:  ${c.red}${fail}${c.reset}`);
  console.log(`  kept:    ${keep.length}`);
  console.log(`  funded preserved: ${funded.length}`);
  console.log(`  unknown preserved: ${unknown.length}\n`);
}

main().catch(err => {
  console.error(`\n${c.red}✗ Crashed:${c.reset} ${err.message}\n`);
  process.exit(1);
});
