#!/usr/bin/env node
/**
 * One-shot: provision a fresh BARD platform wallet in the Turnkey org,
 * faucet-drip it with USDC, and print the values to paste into Railway.
 *
 * Reads TURNKEY_API_PRIVATE_KEY / TURNKEY_API_PUBLIC_KEY / TURNKEY_ORGANIZATION_ID
 * and CIRCLE_API_KEY from backend/.env. Safe to re-run (creates a NEW wallet
 * each time — never modifies existing ones).
 *
 * Usage:
 *   cd backend && node provision-platform-wallet.mjs
 */

import 'dotenv/config';
import { Turnkey } from '@turnkey/sdk-server';
import { createPublicClient, http } from 'viem';

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m',
};

const ORG = process.env.TURNKEY_ORGANIZATION_ID;
const PRIV = process.env.TURNKEY_API_PRIVATE_KEY;
const PUB = process.env.TURNKEY_API_PUBLIC_KEY;
const CIRCLE = process.env.CIRCLE_API_KEY;
const RPC = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const USDC = '0x3600000000000000000000000000000000000000';

function require(env, name) {
  if (!env) { console.error(`${c.red}✗ ${name} not set in env${c.reset}`); process.exit(1); }
}
require(ORG, 'TURNKEY_ORGANIZATION_ID');
require(PRIV, 'TURNKEY_API_PRIVATE_KEY');
require(PUB, 'TURNKEY_API_PUBLIC_KEY');

console.log(`${c.bold}${c.cyan}\n════ Provision fresh BARD platform wallet ════${c.reset}`);
console.log(`${c.dim}Turnkey org: ${ORG}${c.reset}`);

const tk = new Turnkey({
  defaultOrganizationId: ORG,
  apiBaseUrl: 'https://api.turnkey.com',
  apiPrivateKey: PRIV,
  apiPublicKey: PUB,
});
const api = tk.apiClient();

const stamp = Math.random().toString(36).slice(2, 10);
const walletName = `bard-platform-prod-${stamp}`;

console.log(`\n${c.cyan}▸ 1. Creating Turnkey wallet "${walletName}"${c.reset}`);
const wallet = await api.createWallet({
  walletName,
  accounts: [{
    curve: 'CURVE_SECP256K1',
    pathFormat: 'PATH_FORMAT_BIP32',
    path: "m/44'/60'/0'/0/0",
    addressFormat: 'ADDRESS_FORMAT_ETHEREUM',
  }],
});
const address = wallet.addresses?.[0];
if (!address) { console.error(`${c.red}✗ No address returned${c.reset}`); process.exit(1); }
console.log(`  ${c.green}✓${c.reset} walletId: ${wallet.walletId}`);
console.log(`  ${c.green}✓${c.reset} address:  ${c.bold}${address}${c.reset}`);

console.log(`\n${c.cyan}▸ 2. Verify wallet appears in org via listing${c.reset}`);
const { accounts } = await api.getWalletAccounts({ organizationId: ORG, walletId: wallet.walletId });
const ok = accounts.some(a => a.address.toLowerCase() === address.toLowerCase());
if (!ok) { console.error(`${c.red}✗ Wallet not visible in org listing${c.reset}`); process.exit(1); }
console.log(`  ${c.green}✓${c.reset} confirmed in org (${accounts.length} account on this wallet)`);

if (CIRCLE) {
  console.log(`\n${c.cyan}▸ 3. Drip USDC from Circle faucet${c.reset}`);
  const drip = await fetch('https://api.circle.com/v1/faucet/drips', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CIRCLE}`,
    },
    body: JSON.stringify({ address, blockchain: 'ARC-TESTNET', usdc: true }),
  });
  if (drip.status === 204 || drip.ok) {
    console.log(`  ${c.green}✓${c.reset} faucet dripped (~40 USDC, settles in ~5s)`);
  } else {
    const t = await drip.text();
    console.log(`  ${c.yellow}⚠${c.reset} faucet status=${drip.status}: ${t.slice(0, 200)}`);
  }

  // Wait a tick, then verify on-chain
  await new Promise(r => setTimeout(r, 6000));
  console.log(`\n${c.cyan}▸ 4. Verify on-chain balance${c.reset}`);
  try {
    const client = createPublicClient({
      chain: { id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 }, rpcUrls: { default: { http: [RPC] } } },
      transport: http(RPC),
    });
    const raw = await client.readContract({
      address: USDC,
      abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }],
      functionName: 'balanceOf',
      args: [address],
    });
    const bal = Number(raw) / 1_000_000;
    console.log(`  ${c.green}✓${c.reset} balance: ${c.bold}${bal.toFixed(6)} USDC${c.reset}`);
  } catch (e) {
    console.log(`  ${c.yellow}⚠${c.reset} balance read failed: ${e.message.split('\n')[0]}`);
  }
} else {
  console.log(`\n${c.yellow}⚠ CIRCLE_API_KEY not set — skipping faucet drip${c.reset}`);
}

console.log(`\n${c.bold}${c.green}════ Done ════${c.reset}`);
console.log(`\nSet these on Railway (backend service env, then redeploy):\n`);
console.log(`  ${c.bold}SELLER_ADDRESS=${address}${c.reset}`);
console.log(`  ${c.bold}PLATFORM_OWNER_WALLET=${address}${c.reset}`);
console.log(`\nThen replay the live walkthrough; step 8 will succeed.\n`);
