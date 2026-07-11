#!/usr/bin/env node
/**
 * Proves the self-hosted LocalWalletProvider is a Turnkey-free, drop-in signer:
 *   create wallet → keys encrypted at rest → decrypt round-trip → sign → recover.
 * No Turnkey, no chain gas required — this exercises the crypto + storage core.
 *
 * Run (see run-local-wallet.sh): WALLET_PROVIDER=local WALLET_MASTER_KEY=… \
 *   DATABASE_URL=… node test-local-wallet.mjs
 */
import pg from 'pg';
import { verifyMessage } from 'viem';
import { getWalletProvider, encryptSecret, decryptSecret } from './wallet-provider.js';

const C = { g:'\x1b[32m', r:'\x1b[31m', c:'\x1b[36m', d:'\x1b[2m', b:'\x1b[1m', x:'\x1b[0m' };
let passed = 0, failed = 0;
const A = (cond, msg) => { console.log(`  ${cond ? C.g+'✓' : C.r+'✗ FAIL'}${C.x} ${msg}`); cond ? passed++ : failed++; };
const die = (m) => { console.error(`${C.r}fatal: ${m}${C.x}`); process.exit(2); };

if (!process.env.DATABASE_URL) die('DATABASE_URL not set');
if (!process.env.WALLET_MASTER_KEY) die('WALLET_MASTER_KEY not set');

console.log(`${C.b}${C.c}\n════ Local Wallet Provider (Turnkey-free) ════${C.x}`);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const provider = getWalletProvider(pool);

A(provider.name === 'local', `provider selected = ${provider.name}`);
A(provider.enabled() === true, 'provider enabled (master key present)');

// ── 1. create a managed wallet ──
console.log(`\n${C.c}▸ 1. createWallet${C.x}`);
const w = await provider.createWallet('agent-alpha');
A(/^0x[0-9a-fA-F]{40}$/.test(w.address), `address well-formed: ${w.address}`);
A(!!w.walletId, `walletId returned: ${w.walletId}`);

// ── 2. key is encrypted at rest (never plaintext) ──
console.log(`\n${C.c}▸ 2. keys encrypted at rest${C.x}`);
const row = (await pool.query('SELECT * FROM local_wallets WHERE address = $1', [w.address.toLowerCase()])).rows[0];
A(!!row, 'row persisted');
A(!!row.enc_ct && !!row.enc_iv && !!row.enc_tag && !!row.enc_salt, 'AES-256-GCM fields stored (salt/iv/tag/ct)');
A(!row.enc_ct.startsWith('0x') && row.enc_ct.length > 40, 'ciphertext is not the raw private key');

// ── 3. decrypt round-trip yields the same account ──
console.log(`\n${C.c}▸ 3. decrypt round-trip${C.x}`);
const account = await provider.getAccount(w.address);
A(account.address.toLowerCase() === w.address.toLowerCase(), 'decrypted key derives the same address');

// ── 4. sign a message → signature recovers the address (seamless server-side signing) ──
console.log(`\n${C.c}▸ 4. sign + recover${C.x}`);
const message = `BARD wallet proof ${Date.now()}`;
const sig = await provider.signMessage(w.address, message);
const recovered = await verifyMessage({ address: w.address, message, signature: sig });
A(recovered === true, `EIP-191 signature verifies for ${w.address.slice(0,10)}…`);

// ── 5. getSigner returns a viem walletClient with the drop-in send interface ──
console.log(`\n${C.c}▸ 5. drop-in walletClient shape${C.x}`);
const signer = await provider.getSigner(w.address);
A(signer.account.address.toLowerCase() === w.address.toLowerCase(), 'walletClient bound to the agent account');
A(typeof signer.sendTransaction === 'function', 'walletClient.sendTransaction present (escrow-service drop-in)');

// ── 6. tamper resistance: wrong auth tag fails closed ──
console.log(`\n${C.c}▸ 6. tamper resistance${C.x}`);
const enc = encryptSecret('0x' + '11'.repeat(32));
let tamperFailed = false;
try { decryptSecret({ ...enc, tag: 'de'.repeat(16) }); } catch { tamperFailed = true; }
A(tamperFailed, 'GCM auth-tag tamper rejected');
A(decryptSecret(enc) === '0x' + '11'.repeat(32), 'valid ciphertext decrypts exactly');

await pool.end();
console.log(`\n${C.b}${C.c}════ Results ════${C.x}`);
console.log(`  passed: ${passed}   failed: ${failed}`);
process.exit(failed ? 1 : 0);
