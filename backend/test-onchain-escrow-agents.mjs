#!/usr/bin/env node
/**
 * Agent↔agent ON-CHAIN escrow lifecycle against the secure contracts, driven entirely
 * through escrow-service.js (Turnkey-signed legs — no human signing).
 *
 *   provision 2 Turnkey agent wallets (creator + provider)
 *     → faucet USDC to creator → escrow.openAndFund → provider submit
 *     → platform release → assert provider paid + fee to platform on-chain.
 *
 * Run:
 *   cd backend && node --import ./fetch-retry.mjs test-onchain-escrow-agents.mjs
 */
import 'dotenv/config';
import { Turnkey } from '@turnkey/sdk-server';

// The new secure contracts are evaluated/owned by the platform Turnkey wallet.
// Local .env carries a stale SELLER_ADDRESS — pin it to the real platform wallet
// (evaluator + gas source) BEFORE loading escrow-service (which reads it at import).
const PLATFORM = '0xACA613aF220d24Dd8554dF1888c34638A5f8EFBf';
process.env.SELLER_ADDRESS = PLATFORM;

const escrow = await import('./escrow-service.js');
const { toUsdcWei, fromUsdcWei } = escrow;

const C = { g:'\x1b[32m', r:'\x1b[31m', y:'\x1b[33m', c:'\x1b[36m', d:'\x1b[2m', b:'\x1b[1m', x:'\x1b[0m' };
const ok = (b, m) => console.log(`  ${b ? C.g+'✓' : C.r+'✗ FAIL'}${C.x} ${m}`);
const ORG = process.env.TURNKEY_ORGANIZATION_ID;
const CIRCLE = process.env.CIRCLE_API_KEY;

const tk = new Turnkey({
  defaultOrganizationId: ORG, apiBaseUrl: 'https://api.turnkey.com',
  apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY, apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY,
});
const api = tk.apiClient();

async function newWallet(label) {
  const stamp = Math.random().toString(36).slice(2, 8);
  const w = await api.createWallet({
    walletName: `bard-agent-test-${label}-${stamp}`,
    accounts: [{ curve: 'CURVE_SECP256K1', pathFormat: 'PATH_FORMAT_BIP32', path: "m/44'/60'/0'/0/0", addressFormat: 'ADDRESS_FORMAT_ETHEREUM' }],
  });
  return w.addresses[0];
}

async function faucet(address) {
  const d = await fetch('https://api.circle.com/v1/faucet/drips', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CIRCLE}` },
    body: JSON.stringify({ address, blockchain: 'ARC-TESTNET', usdc: true }),
  });
  if (!(d.status === 204 || d.ok)) throw new Error(`faucet failed ${d.status}: ${await d.text()}`);
}

console.log(`${C.b}${C.c}\n════ Agent↔Agent On-Chain Escrow (secure contracts) ════${C.x}`);
console.log(`${C.d}AC ${escrow.AGENTIC_COMMERCE_ADDRESS}  hook ${escrow.BARD_JOB_HOOK_ADDRESS}${C.x}`);

let passed = 0, failed = 0;
const A = (cond, msg) => { ok(cond, msg); cond ? passed++ : failed++; };

// 1. Provision two agent wallets.
console.log(`\n${C.c}▸ 1. Provision creator + provider Turnkey wallets${C.x}`);
const creator  = await newWallet('creator');
const provider = await newWallet('provider');
console.log(`  creator  = ${creator}`);
console.log(`  provider = ${provider}`);

// 2. Fund creator with USDC (earnings + fee) via Circle faucet.
console.log(`\n${C.c}▸ 2. Faucet USDC → creator, gas → both${C.x}`);
await faucet(creator);
await new Promise(r => setTimeout(r, 8000));
const g1 = await escrow.ensureGas(creator);
const g2 = await escrow.ensureGas(provider);
console.log(`  creator USDC : ${fromUsdcWei(await escrow.usdcBalance(creator)).toFixed(2)}  gas topped: ${g1.funded}`);
console.log(`  provider gas topped: ${g2.funded}`);

// 3. Full escrow: openAndFund (creator+provider legs) → submit → release.
const EARN = 1.0, FEE = 0.2;
const provBefore = await escrow.usdcBalance(provider);
const platBefore = await escrow.usdcBalance(PLATFORM);

console.log(`\n${C.c}▸ 3. openAndFund (${EARN} USDC earnings + ${FEE} fee, cap 25%)${C.x}`);
const { jobId, txs } = await escrow.openAndFund({
  creatorWallet: creator, providerWallet: provider,
  earningsUsdc: EARN, platformFeeUsdc: FEE, maxFeeBps: 2500,
  description: 'agent on-chain test bounty',
});
console.log(`  jobId=${jobId}  createJob=${txs.createJob?.slice(0,14)}…  fund=${txs.fund?.slice(0,14)}…`);
let job = await escrow.getJob(jobId);
A(Number(job.status) === 1, `job Funded (status=${job.status})`);
A(job.provider.toLowerCase() === provider.toLowerCase(), 'provider assigned on-chain');

console.log(`\n${C.c}▸ 4. provider submits${C.x}`);
const s = await escrow.submit({ providerWallet: provider, jobId, deliverableLabel: 'work-hash' });
job = await escrow.getJob(jobId);
A(Number(job.status) === 2, `job Submitted (status=${job.status})  tx=${s.txHash.slice(0,14)}…`);

console.log(`\n${C.c}▸ 5. platform releases (complete) → real USDC payout${C.x}`);
const rel = await escrow.release({ jobId, reasonLabel: 'approved' });
console.log(`  complete tx: ${rel.txHash}`);
job = await escrow.getJob(jobId);
const fee = await escrow.getFeeMeta(jobId);
// Gas-independent proof: decode the on-chain settlement events (Arc gas == USDC, so
// raw balance deltas are confounded by gas the payee itself spent).
const settle = await escrow.decodeSettlement(rel.receipt);
// Sanity check that balances at least moved in the right direction too.
const provDelta = fromUsdcWei((await escrow.usdcBalance(provider)) - provBefore);
A(Number(job.status) === 3, `job Completed (status=${job.status})`);
A(settle.paidToProvider === EARN && settle.provider.toLowerCase() === provider.toLowerCase(),
  `PaymentReleased: ${settle.paidToProvider} USDC → provider (exact)`);
A(settle.feePaid === FEE && settle.feeRecipient.toLowerCase() === PLATFORM.toLowerCase(),
  `BardFeeReleased: ${settle.feePaid} USDC → platform (exact)`);
A(provDelta > EARN - 0.02 && provDelta <= EARN, `provider balance rose ~${EARN} (net of gas: ${provDelta})`);
A(fee.feeSettled === true, 'hook feeSettled == true');

console.log(`\n${C.b}${C.c}════ Results ════${C.x}`);
console.log(`  passed: ${passed}   failed: ${failed}   jobId: ${jobId}`);
console.log(`  ${C.d}explorer: https://testnet.arcscan.app/tx/${rel.txHash}${C.x}`);
process.exit(failed ? 1 : 0);
