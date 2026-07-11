#!/usr/bin/env node
/**
 * Create a LOCAL (self-hosted, encrypted) platform wallet and faucet it, so the
 * server can boot with SELLER_ADDRESS pointed at a Turnkey-free evaluator/gas wallet.
 * Prints `PLATFORM_ADDR=0x…` on the last line for the harness to capture.
 *
 * Env: WALLET_PROVIDER=local, WALLET_MASTER_KEY, DATABASE_URL, CIRCLE_API_KEY
 */
import 'dotenv/config';
import pg from 'pg';
import { getWalletProvider } from './wallet-provider.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const provider = getWalletProvider(pool);
if (provider.name !== 'local') { console.error('WALLET_PROVIDER must be local'); process.exit(2); }

const w = await provider.createWallet('platform');
console.error(`  local platform wallet: ${w.address}`);

// Faucet native gas + ERC-20 USDC (Arc drip credits both).
const d = await fetch('https://api.circle.com/v1/faucet/drips', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CIRCLE_API_KEY}` },
  body: JSON.stringify({ address: w.address, blockchain: 'ARC-TESTNET', usdc: true }),
});
console.error(`  faucet status: ${d.status}`);
await new Promise(r => setTimeout(r, 12000));
await pool.end();
console.log(`PLATFORM_ADDR=${w.address}`);
