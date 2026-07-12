#!/usr/bin/env node
/**
 * Seed a testnet address with ERC-20 USDC (+ native gas) from a funded key — a
 * faucet-free alternative for local escrow tests. Signs directly with BARD_TEST_W1
 * (a burned/unprivileged Arc-testnet actor recovered from git history; holds no
 * contract authority). Usable as a CLI or an imported helper.
 *
 *   CLI:    BARD_TEST_W1=0x.. node fund-address.mjs <toAddr> <usdc> <native>
 *   module: import { fundAddress } from './fund-address.mjs'
 */
import { createWalletClient, createPublicClient, http, parseUnits, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const USDC = '0x3600000000000000000000000000000000000000'; // ERC-20 USDC (6 decimals)
const ARC = { id: 5042002, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const ERC20_TRANSFER = [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }];

const pub = createPublicClient({ chain: ARC, transport: http(RPC) });

/** Transfer `usdc` ERC-20 USDC and `native` gas to `to`, from the key in BARD_TEST_W1
 *  (or an explicitly passed key). Returns { usdcTx, nativeTx }. */
export async function fundAddress(to, { usdc = 0, native = 0, key = process.env.BARD_TEST_W1 } = {}) {
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('funding key missing — set BARD_TEST_W1');
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain: ARC, transport: http(RPC) });
  const out = {};
  if (native > 0) {
    out.nativeTx = await wallet.sendTransaction({ to, value: parseEther(String(native)) });
    await pub.waitForTransactionReceipt({ hash: out.nativeTx });
  }
  if (usdc > 0) {
    out.usdcTx = await wallet.writeContract({ address: USDC, abi: ERC20_TRANSFER, functionName: 'transfer', args: [to, parseUnits(String(usdc), 6)] });
    await pub.waitForTransactionReceipt({ hash: out.usdcTx });
  }
  return out;
}

// CLI entrypoint.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [to, usdc, native] = process.argv.slice(2);
  if (!to) { console.error('usage: node fund-address.mjs <toAddr> <usdc> <native>'); process.exit(2); }
  const res = await fundAddress(to, { usdc: parseFloat(usdc || '0'), native: parseFloat(native || '0') });
  console.log(`funded ${to}: usdc=${usdc || 0} (${res.usdcTx || '-'})  native=${native || 0} (${res.nativeTx || '-'})`);
}
