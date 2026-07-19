#!/usr/bin/env node
/**
 * Recover USDC from the five Turnkey wallets whose agent rows were deleted by
 * cleanup-test-artifacts.mjs on 2026-07-17.
 *
 * Dry-run by default. Pass --execute to sign and broadcast transfers.
 *
 * Usage:
 *   node --import ./fetch-retry.mjs sweep-funded-orphans.mjs
 *   node --import ./fetch-retry.mjs sweep-funded-orphans.mjs --execute
 *   SWEEP_DESTINATION=0x... node --import ./fetch-retry.mjs sweep-funded-orphans.mjs --execute
 */

import 'dotenv/config';
import { Turnkey } from '@turnkey/sdk-server';
import { createAccount } from '@turnkey/viem';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
} from 'viem';

const ARC_RPC = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const USDC = '0x3600000000000000000000000000000000000000';
const DEFAULT_DESTINATION = '0x40363e3Dd3cA46c87bf79cf28DFeDD9ed3092E3f';
const DESTINATION = getAddress(process.env.SWEEP_DESTINATION || DEFAULT_DESTINATION);
const EXECUTE = process.argv.includes('--execute');
const GAS_RESERVE_NUMERATOR = 3n;
const GAS_RESERVE_DENOMINATOR = 2n;
const NATIVE_WEI_PER_USDC_MICRO = 1_000_000_000_000n;
const RPC_ATTEMPTS = Math.max(1, Number(process.env.SWEEP_RPC_ATTEMPTS || 8));
const RPC_DELAY_MS = Math.max(0, Number(process.env.SWEEP_RPC_DELAY_MS || 500));

const SOURCES = [
  {
    deletedAgentName: 'rv-agent-A-mrfaz4zz3b',
    walletName: 'bard-agent-agent-1783710161919-er5xmt',
    walletId: 'b9b13e85-f31e-52f6-9057-9bec291e6080',
    address: '0x75fF67Dc6f57FC9E83cc1086734653283c8F0f1C',
  },
  {
    deletedAgentName: 'fa-a-mre5qdpl',
    walletName: 'bard-agent-agent-1783640890756-tsbura',
    walletId: '1fbdea07-7284-5b65-ad0b-e17e43854171',
    address: '0x7f6338877bA2Aa91676E6EDF7f30bC227550Ec61',
  },
  {
    deletedAgentName: 'cc-creator-mre5qbkg',
    walletName: 'bard-agent-agent-1783640890292-1z2g63',
    walletId: '8cf4d8fc-dd10-5cb3-8aba-70eaa32ed4b5',
    address: '0x57c41d509200eC74383936182bb785Be488050cb',
  },
  {
    deletedAgentName: 'rv-creator-B-mrfazqu7vx',
    walletName: 'bard-agent-agent-1783710190435-yzeee1',
    walletId: '7af4bb23-2042-5162-b9a5-ed5b00d8f459',
    address: '0xf217176Ed410C1192926D130Ce2ed66DA2fb4D03',
  },
  {
    deletedAgentName: 'rf-creator-mrfay1yi',
    walletName: 'bard-agent-agent-1783710111572-3e0rxt',
    walletId: 'a5e49c52-c629-51f3-b923-03ce2cffd95a',
    address: '0x34791592B68Ca5BeB2170418E9701B1EC77849C4',
  },
].map(source => ({ ...source, address: getAddress(source.address) }));

const chain = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC] } },
  blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
};

const balanceAbi = [{
  name: 'balanceOf',
  type: 'function',
  stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }],
  outputs: [{ name: 'balance', type: 'uint256' }],
}];

const transferAbi = [{
  name: 'transfer',
  type: 'function',
  stateMutability: 'nonpayable',
  inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }],
  outputs: [{ name: 'success', type: 'bool' }],
}];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ceilDiv = (value, divisor) => (value + divisor - 1n) / divisor;
const formatUsdc = value => formatUnits(value, 6);
const formatNativeUsdc = value => formatUnits(value, 18);

async function rpcRetry(label, operation) {
  let lastError;
  for (let attempt = 1; attempt <= RPC_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === RPC_ATTEMPTS) break;
      const delay = Math.min(15_000, RPC_DELAY_MS * (2 ** (attempt - 1)));
      console.warn(`   RPC retry ${attempt}/${RPC_ATTEMPTS - 1} for ${label} in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw new Error(
    `${label} failed after ${RPC_ATTEMPTS} attempts: `
    + (lastError?.details || lastError?.shortMessage || lastError?.message || 'unknown RPC error'),
  );
}

for (const name of [
  'TURNKEY_ORGANIZATION_ID',
  'TURNKEY_API_PRIVATE_KEY',
  'TURNKEY_API_PUBLIC_KEY',
]) {
  if (!process.env[name]) {
    console.error(`${name} is required`);
    process.exit(1);
  }
}

if (SOURCES.some(source => source.address.toLowerCase() === DESTINATION.toLowerCase())) {
  console.error('Sweep destination must not be one of the source wallets');
  process.exit(1);
}

const publicClient = createPublicClient({
  chain,
  transport: http(ARC_RPC, { retryCount: 6, retryDelay: 750 }),
});

const turnkey = new Turnkey({
  defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID,
  apiBaseUrl: 'https://api.turnkey.com',
  apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY,
  apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY,
});
const apiClient = turnkey.apiClient();

async function readBalances(address) {
  const token = await rpcRetry(`USDC balance ${address}`, () => (
    publicClient.readContract({
      address: USDC,
      abi: balanceAbi,
      functionName: 'balanceOf',
      args: [address],
    })
  ));
  await sleep(RPC_DELAY_MS);
  const native = await rpcRetry(`native balance ${address}`, () => (
    publicClient.getBalance({ address })
  ));
  return { token, native };
}

async function verifyTurnkeySources() {
  const { wallets } = await apiClient.getWallets({
    organizationId: process.env.TURNKEY_ORGANIZATION_ID,
  });
  const byId = new Map(wallets.map(wallet => [wallet.walletId, wallet]));

  for (const source of SOURCES) {
    const wallet = byId.get(source.walletId);
    if (!wallet) throw new Error(`Turnkey wallet missing: ${source.walletId}`);
    if (wallet.walletName !== source.walletName) {
      throw new Error(`Turnkey wallet-name mismatch for ${source.deletedAgentName}`);
    }

    const { accounts } = await apiClient.getWalletAccounts({
      organizationId: process.env.TURNKEY_ORGANIZATION_ID,
      walletId: source.walletId,
    });
    const actualAddress = accounts?.[0]?.address && getAddress(accounts[0].address);
    if (actualAddress !== source.address) {
      throw new Error(
        `Turnkey address mismatch for ${source.deletedAgentName}: expected ${source.address}, got ${actualAddress || 'none'}`,
      );
    }
  }
}

async function buildSweep(source, tokenBalance, nativeBalance) {
  const probeData = encodeFunctionData({
    abi: transferAbi,
    functionName: 'transfer',
    args: [DESTINATION, 1n],
  });
  const estimatedGas = await rpcRetry(`gas estimate ${source.address}`, () => (
    publicClient.estimateGas({
      account: source.address,
      to: USDC,
      data: probeData,
      value: 0n,
    })
  ));
  await sleep(RPC_DELAY_MS);
  const gasPrice = await rpcRetry('gas price', () => publicClient.getGasPrice());

  const estimatedFee = estimatedGas * gasPrice;
  const reservedFee = ceilDiv(
    estimatedFee * GAS_RESERVE_NUMERATOR,
    GAS_RESERVE_DENOMINATOR,
  );
  const nativeTransferLimit = nativeBalance > reservedFee
    ? (nativeBalance - reservedFee) / NATIVE_WEI_PER_USDC_MICRO
    : 0n;
  const amount = tokenBalance < nativeTransferLimit ? tokenBalance : nativeTransferLimit;

  return { amount, estimatedGas, gasPrice, estimatedFee, reservedFee };
}

async function sendSweep(source, amount) {
  const account = await createAccount({
    client: apiClient,
    organizationId: process.env.TURNKEY_ORGANIZATION_ID,
    signWith: source.address,
  });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(ARC_RPC, { retryCount: 6, retryDelay: 750 }),
  });
  const data = encodeFunctionData({
    abi: transferAbi,
    functionName: 'transfer',
    args: [DESTINATION, amount],
  });
  return walletClient.sendTransaction({ to: USDC, data, value: 0n });
}

async function main() {
  console.log('\nBARD funded-orphan wallet sweep');
  console.log(`Mode:        ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}`);
  console.log(`Destination: ${DESTINATION}`);
  console.log(`Sources:     ${SOURCES.length}\n`);

  console.log('1. Verifying Turnkey wallet IDs, names, and addresses');
  await verifyTurnkeySources();
  console.log('   verified all five source wallets\n');

  const destinationBefore = await readBalances(DESTINATION);
  let totalBefore = 0n;
  let totalPlanned = 0n;
  let totalGasPaid = 0n;
  const results = [];

  console.log('2. Probing balances and gas');
  for (const source of SOURCES) {
    const before = await readBalances(source.address);
    const plan = await buildSweep(source, before.token, before.native);
    totalBefore += before.token;
    totalPlanned += plan.amount;
    results.push({ source, before, plan });
    console.log(
      `   ${source.deletedAgentName.padEnd(28)} balance=${formatUsdc(before.token)} `
      + `send=${formatUsdc(plan.amount)} reserve=${formatNativeUsdc(plan.reservedFee)}`,
    );
    await sleep(500);
  }

  console.log(`\n   total balance: ${formatUsdc(totalBefore)} USDC`);
  console.log(`   total planned: ${formatUsdc(totalPlanned)} USDC`);

  if (!EXECUTE) {
    console.log('\nDry run complete. Re-run with --execute to broadcast the five transfers.\n');
    return;
  }

  console.log('\n3. Broadcasting sweeps');
  for (const result of results) {
    const { source, plan } = result;
    if (plan.amount <= 0n) {
      console.log(`   skip ${source.deletedAgentName}: no transferable balance after gas reserve`);
      continue;
    }

    const txHash = await sendSweep(source, plan.amount);
    console.log(`   sent ${source.deletedAgentName}: ${txHash}`);
    const receipt = await rpcRetry(`receipt ${txHash}`, () => (
      publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
        timeout: 120_000,
      })
    ));
    if (receipt.status !== 'success') {
      throw new Error(`Sweep reverted for ${source.deletedAgentName}: ${txHash}`);
    }

    const effectiveGasPrice = receipt.effectiveGasPrice || plan.gasPrice;
    const gasPaid = receipt.gasUsed * effectiveGasPrice;
    totalGasPaid += gasPaid;
    const after = await readBalances(source.address);
    result.txHash = txHash;
    result.receipt = receipt;
    result.after = after;
    console.log(
      `      confirmed gas=${formatNativeUsdc(gasPaid)} remaining=${formatUsdc(after.token)} USDC`,
    );
    await sleep(1_000);
  }

  const destinationAfter = await readBalances(DESTINATION);
  const destinationDelta = destinationAfter.token - destinationBefore.token;
  const remaining = results.reduce((sum, result) => sum + (result.after?.token ?? result.before.token), 0n);

  console.log('\n4. Verification');
  console.log(`   destination before: ${formatUsdc(destinationBefore.token)} USDC`);
  console.log(`   destination after:  ${formatUsdc(destinationAfter.token)} USDC`);
  console.log(`   destination delta:  ${formatUsdc(destinationDelta)} USDC`);
  console.log(`   source remaining:   ${formatUsdc(remaining)} USDC`);
  console.log(`   gas paid:           ${formatNativeUsdc(totalGasPaid)} USDC`);
  console.log('\nTransactions:');
  for (const result of results.filter(item => item.txHash)) {
    console.log(`   ${result.source.deletedAgentName}: https://testnet.arcscan.app/tx/${result.txHash}`);
  }

  if (destinationDelta !== totalPlanned) {
    throw new Error(
      `Destination delta mismatch: expected ${formatUsdc(totalPlanned)}, got ${formatUsdc(destinationDelta)}`,
    );
  }
  console.log('\nSweep complete and verified.\n');
}

main().catch(error => {
  console.error(`\nSweep failed: ${error.shortMessage || error.message}\n`);
  process.exit(1);
});
