#!/usr/bin/env node
/**
 * FULL-LOCAL on-chain escrow E2E — proves BARD drives the ERC-8183 lifecycle through
 * its HTTP routes using the SELF-HOSTED wallet provider (no Turnkey anywhere).
 *
 *   create local creator+provider wallets → faucet (native gas + USDC) → seed DB
 *     → POST /fund → /deliver → /review → /platform-verify
 *     → assert on-chain job Completed + provider paid + DB escrow_mode='onchain'.
 *
 * Env: WALLET_PROVIDER=local, WALLET_MASTER_KEY (same as server), DATABASE_URL (same),
 *      BARD_API, PLATFORM_ADDR, JWT_SECRET, CIRCLE_API_KEY.
 */
import 'dotenv/config';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { getWalletProvider } from './wallet-provider.js';

const PLATFORM = process.env.PLATFORM_ADDR;
process.env.SELLER_ADDRESS = PLATFORM; // escrow-service reads this at import
const escrow = await import('./escrow-service.js');
const { fromUsdcWei } = escrow;

const API = process.env.BARD_API || 'http://localhost:4124';
const JWT_SECRET = process.env.JWT_SECRET;
const DB = process.env.DATABASE_URL;
const CIRCLE = process.env.CIRCLE_API_KEY;
const EARN = 1.0;

const C = { g:'\x1b[32m', r:'\x1b[31m', c:'\x1b[36m', d:'\x1b[2m', b:'\x1b[1m', x:'\x1b[0m' };
let passed = 0, failed = 0;
const A = (cond, msg) => { console.log(`  ${cond ? C.g+'✓' : C.r+'✗ FAIL'}${C.x} ${msg}`); cond ? passed++ : failed++; };
const die = (m) => { console.error(`${C.r}fatal: ${m}${C.x}`); process.exit(2); };
if (!PLATFORM) die('PLATFORM_ADDR not set');
if (!JWT_SECRET || !DB) die('JWT_SECRET / DATABASE_URL required');

const pool = new pg.Pool({ connectionString: DB });
const provider = getWalletProvider(pool);
if (provider.name !== 'local') die(`expected local provider, got ${provider.name}`);

async function faucet(address) {
  const d = await fetch('https://api.circle.com/v1/faucet/drips', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CIRCLE}` },
    body: JSON.stringify({ address, blockchain: 'ARC-TESTNET', usdc: true }),
  });
  if (!(d.status === 204 || d.ok)) throw new Error(`faucet ${d.status}: ${await d.text()}`);
}
async function post(path, body, token) {
  const r = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  let json; try { json = await r.json(); } catch { json = {}; }
  return { status: r.status, json };
}
const mintToken = (agentId, wallet, name) => jwt.sign({ sub: agentId, wallet: wallet.toLowerCase(), scope: 'agent:full', agentName: name, jti: `tok-${Math.random().toString(36).slice(2,10)}` }, JWT_SECRET, { expiresIn: '1h' });

console.log(`${C.b}${C.c}\n════ FULL-LOCAL On-Chain Escrow E2E (no Turnkey) ════${C.x}`);
console.log(`${C.d}API ${API}  provider=${provider.name}  platform ${PLATFORM}${C.x}`);

{
  const h = await fetch(`${API}/api/health`).then(r => r.json()).catch(() => null);
  if (!h || h.status !== 'ok') die(`server not healthy at ${API}`);
  A(true, `server up (db=${h.db})`);
}

// 1. Provision local creator + provider wallets (Turnkey-free).
console.log(`\n${C.c}▸ 1. create local wallets${C.x}`);
const creator = (await provider.createWallet('route-creator')).address;
const providerW = (await provider.createWallet('route-provider')).address;
console.log(`  creator=${creator}  provider=${providerW}`);
A(!!creator && !!providerW, 'two local wallets created');

// 2. Faucet (native gas + USDC to each).
console.log(`\n${C.c}▸ 2. faucet creator + provider${C.x}`);
await faucet(creator); await faucet(providerW);
await new Promise(r => setTimeout(r, 12000));
A(fromUsdcWei(await escrow.usdcBalance(creator)) >= EARN, `creator funded (${fromUsdcWei(await escrow.usdcBalance(creator))} USDC)`);

// 3. Seed agents + proposal_selected bounty + accepted proposal.
console.log(`\n${C.c}▸ 3. seed DB${C.x}`);
const stamp = Date.now();
const creatorId = `agent-ct-${stamp}`, providerId = `agent-pv-${stamp}`;
const bountyId = `bounty-lc-${stamp}`, proposalId = `prop-lc-${stamp}`;
const now = new Date().toISOString();
const cx = new pg.Client({ connectionString: DB }); await cx.connect();
try {
  for (const [id, name, wallet] of [[creatorId,'lc-creator',creator],[providerId,'lc-provider',providerW]])
    await cx.query(`INSERT INTO agents (id, owner_wallet, agent_name, agent_public_key, reputation_score, status, turnkey_address, created_at) VALUES ($1,$2,$3,$4,50,'active',$5,$6)`, [id, wallet.toLowerCase(), name, wallet, wallet, now]);
  await cx.query(`INSERT INTO bounties (id, creator_wallet, title, description, bounty_type, amount_usdc, deadline, status, selection_mode, selected_proposal_id, escrow_status, escrow_mode, created_at, updated_at) VALUES ($1,$2,$3,'e2e','task',$4,$5,'proposal_selected','proposal',$6,'none','custodial',$7,$7)`, [bountyId, creator, 'Full-local test bounty', String(EARN), now, proposalId, now]);
  await cx.query(`INSERT INTO bounty_proposals (id, bounty_id, proposer_agent_id, proposer_wallet, plan, proposed_price_usdc, status, accepted_at, created_at, updated_at) VALUES ($1,$2,$3,$4,'plan',$5,'accepted',$6,$6,$6)`, [proposalId, bountyId, providerId, providerW, EARN, now]);
  A(true, `seeded bounty ${bountyId}`);
} catch (e) { die(`seed failed: ${e.message}`); }

// 4. /fund → on-chain openAndFund (all legs signed by local provider).
console.log(`\n${C.c}▸ 4. POST /fund${C.x}`);
const fund = await post(`/api/bounties/${bountyId}/fund`, { clientWallet: creator, budgetUsdc: EARN });
A(fund.status === 200, `fund 200 (${fund.status}${fund.status!==200?' — '+JSON.stringify(fund.json):''})`);
A(fund.json.escrow_mode === 'onchain', `escrow_mode='onchain'`);
const jobId = fund.json.onchain_job_id;
A(!!jobId, `jobId ${jobId}`);
if (jobId) { const j = await escrow.getJob(jobId); A(Number(j.status) === 1, `job Funded (status=${j.status})`); }

// 5. /deliver → on-chain submit.
console.log(`\n${C.c}▸ 5. POST /deliver${C.x}`);
const deliver = await post(`/api/bounties/${bountyId}/deliver`, { content: 'work' }, mintToken(providerId, providerW, 'lc-provider'));
A(deliver.status === 200, `deliver 200 (${deliver.status}${deliver.status!==200?' — '+JSON.stringify(deliver.json):''})`);
if (jobId) { const j = await escrow.getJob(jobId); A(Number(j.status) === 2, `job Submitted (status=${j.status})`); }

// 6. /review approve (off-chain).
console.log(`\n${C.c}▸ 6. POST /review${C.x}`);
const review = await post(`/api/bounties/${bountyId}/review`, { clientWallet: creator, decision: 'approved' });
A(review.status === 200, `review 200 (${review.status})`);

// 7. /platform-verify → on-chain release.
console.log(`\n${C.c}▸ 7. POST /platform-verify${C.x}`);
const before = jobId ? await escrow.usdcBalance(providerW) : 0n;
const verify = await post(`/api/bounties/${bountyId}/platform-verify`, { verifierWallet: PLATFORM.toLowerCase(), decision: 'approved', reasoning: 'ok' });
A(verify.status === 200, `platform-verify 200 (${verify.status}${verify.status!==200?' — '+JSON.stringify(verify.json):''})`);
if (jobId) {
  const j = await escrow.getJob(jobId); A(Number(j.status) === 3, `job Completed (status=${j.status})`);
  const delta = fromUsdcWei((await escrow.usdcBalance(providerW)) - before);
  A(delta > EARN - 0.02 && delta <= EARN, `provider paid ~${EARN} (net gas: ${delta.toFixed(4)})`);
}
const row = (await cx.query('SELECT escrow_status, escrow_mode, release_tx_hash FROM bounties WHERE id=$1', [bountyId])).rows[0];
A(row?.escrow_status === 'released', `DB escrow_status='released'`);
A(!!row?.release_tx_hash, `DB release_tx_hash set`);
await cx.end(); await pool.end();

console.log(`\n${C.b}${C.c}════ Results ════${C.x}\n  passed: ${passed}  failed: ${failed}  jobId: ${jobId}  ${C.d}(zero Turnkey)${C.x}`);
process.exit(failed ? 1 : 0);
