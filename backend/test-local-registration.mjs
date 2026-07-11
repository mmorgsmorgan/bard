#!/usr/bin/env node
/**
 * Turnkey-free AGENT REGISTRATION + attestation E2E.
 * Proves an agent can register, get a self-hosted (local) managed wallet, and
 * produce a real recoverable attestation signature — all with zero Turnkey.
 *
 *   register (zero-addr onboarding) → token
 *     → POST /api/agents/:id/wallet   → assert a local wallet address is provisioned
 *     → POST /api/contributions        → assert server-side attestation signs + recovers
 *
 * Env: BARD_API, DATABASE_URL (to confirm local_wallets row). Server booted with
 *      WALLET_PROVIDER=local + WALLET_MASTER_KEY.
 */
import 'dotenv/config';
import pg from 'pg';

const API = process.env.BARD_API || 'http://localhost:4125';
const DB = process.env.DATABASE_URL;
const C = { g:'\x1b[32m', r:'\x1b[31m', c:'\x1b[36m', d:'\x1b[2m', b:'\x1b[1m', x:'\x1b[0m' };
let passed = 0, failed = 0;
const A = (cond, msg) => { console.log(`  ${cond ? C.g+'✓' : C.r+'✗ FAIL'}${C.x} ${msg}`); cond ? passed++ : failed++; };
const die = (m) => { console.error(`${C.r}fatal: ${m}${C.x}`); process.exit(2); };

async function j(path, body, token) {
  const r = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  let json; try { json = await r.json(); } catch { json = {}; }
  return { status: r.status, json };
}

console.log(`${C.b}${C.c}\n════ Turnkey-Free Registration + Attestation ════${C.x}`);
{
  const h = await fetch(`${API}/api/health`).then(r => r.json()).catch(() => null);
  if (!h || h.status !== 'ok') die(`server not healthy at ${API}`);
  A(true, `server up (db=${h.db}, turnkey=${h.turnkey})`);
}

// 1. Register via zero-address onboarding (exempt from ownership proof).
console.log(`\n${C.c}▸ 1. register agent (zero-addr onboarding)${C.x}`);
const ZERO = '0x0000000000000000000000000000000000000000';
const name = `local-agent-${Date.now()}`;
const reg = await j('/api/agents/register', { ownerWallet: ZERO, agentName: name, agentPublicKey: `pk-${Date.now()}` });
A(reg.status === 200 || reg.status === 201, `register ok (${reg.status}${reg.status>=400?' — '+JSON.stringify(reg.json):''})`);
const token = reg.json.token;
const agentId = reg.json.agent?.id || reg.json.agentId;
A(!!token && !!agentId, `token + agentId issued (${agentId})`);

// 2. Provision a LOCAL wallet through the real route.
console.log(`\n${C.c}▸ 2. POST /wallet → local wallet${C.x}`);
const wallet = await j(`/api/agents/${agentId}/wallet`, {}, token);
A(wallet.status === 200, `wallet 200 (${wallet.status}${wallet.status!==200?' — '+JSON.stringify(wallet.json):''})`);
const addr = wallet.json.address;
A(/^0x[0-9a-fA-F]{40}$/.test(addr || ''), `local wallet address provisioned: ${addr}`);

// 3. Confirm the key lives in local_wallets (self-hosted, not Turnkey).
if (DB && addr) {
  console.log(`\n${C.c}▸ 3. key is in local_wallets (self-hosted)${C.x}`);
  const cx = new pg.Client({ connectionString: DB }); await cx.connect();
  const row = (await cx.query('SELECT enc_ct FROM local_wallets WHERE address = $1', [addr.toLowerCase()])).rows[0];
  A(!!row && !!row.enc_ct, 'encrypted key row present in local_wallets');
  await cx.end();
}

// 4. Submit a contribution — server attests (signs) with the local wallet.
console.log(`\n${C.c}▸ 4. POST /contributions → server-side attestation${C.x}`);
const contrib = await j('/api/contributions', { type: 'code_review', description: 'turnkey-free attestation test', proofHash: '0x' + 'ab'.repeat(32) }, token);
A(contrib.status === 200 || contrib.status === 201, `contribution accepted (${contrib.status}${contrib.status>=400?' — '+JSON.stringify(contrib.json):''})`);
// The route stores signer_address recovered from the attestation; assert it matches.
if (DB) {
  const cx = new pg.Client({ connectionString: DB }); await cx.connect();
  const row = (await cx.query('SELECT signer_address, signature FROM contributions WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1', [agentId])).rows[0];
  A(!!row?.signature && row.signature !== '', 'attestation signature stored (real, non-empty)');
  A(row?.signer_address && addr && row.signer_address.toLowerCase() === addr.toLowerCase(), `signer_address == local wallet (${row?.signer_address})`);
  await cx.end();
}

console.log(`\n${C.b}${C.c}════ Results ════${C.x}\n  passed: ${passed}  failed: ${failed}  ${C.d}(zero Turnkey)${C.x}`);
process.exit(failed ? 1 : 0);
