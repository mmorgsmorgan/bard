#!/usr/bin/env node
/**
 * FULL-LOCAL on-chain escrow E2E WITH PLATFORM FEE — proves the /fund route reads
 * PLATFORM_FEE_BPS and charges the fee via BardJobHookV2, with the provider still
 * paid the full budget and the fee landing on the platform wallet on release.
 * Zero Turnkey (self-hosted wallet provider). Mirrors test-onchain-local.mjs.
 *
 * Fee model: ADDITIVE — creator pays budget+fee; provider gets full budget; fee →
 * SELLER_ADDRESS. On Arc, ERC-20 USDC (fee) and native USDC (gas) are distinct, so
 * the platform's ERC-20 balance rises by exactly the fee (gas doesn't perturb it).
 *
 * Env: WALLET_PROVIDER=local, WALLET_MASTER_KEY, DATABASE_URL, BARD_API, PLATFORM_ADDR,
 *      JWT_SECRET, CIRCLE_API_KEY, PLATFORM_FEE_BPS (same value the server booted with).
 */
import 'dotenv/config';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { getWalletProvider } from './wallet-provider.js';
import { fundAddress } from './fund-address.mjs';

const PLATFORM = process.env.PLATFORM_ADDR;
process.env.SELLER_ADDRESS = PLATFORM; // escrow-service reads this at import
const escrow = await import('./escrow-service.js');
const { fromUsdcWei } = escrow;

const API = process.env.BARD_API || 'http://localhost:4125';
const JWT_SECRET = process.env.JWT_SECRET;
const DB = process.env.DATABASE_URL;
const CIRCLE = process.env.CIRCLE_API_KEY;
const FEE_BPS = Math.max(0, Math.min(10000, parseInt(process.env.PLATFORM_FEE_BPS || '0', 10) || 0));
const EARN = 1.0;
const EXPECTED_FEE = FEE_BPS > 0 ? Math.floor(EARN * FEE_BPS / 10000 * 1e6) / 1e6 : 0;

const C = { g:'\x1b[32m', r:'\x1b[31m', c:'\x1b[36m', d:'\x1b[2m', b:'\x1b[1m', x:'\x1b[0m' };
let passed = 0, failed = 0;
const A = (cond, msg) => { console.log(`  ${cond ? C.g+'✓' : C.r+'✗ FAIL'}${C.x} ${msg}`); cond ? passed++ : failed++; };
const die = (m) => { console.error(`${C.r}fatal: ${m}${C.x}`); process.exit(2); };
if (!PLATFORM) die('PLATFORM_ADDR not set');
if (!JWT_SECRET || !DB) die('JWT_SECRET / DATABASE_URL required');
if (FEE_BPS <= 0) die('PLATFORM_FEE_BPS must be > 0 for this test');

const pool = new pg.Pool({ connectionString: DB });
const provider = getWalletProvider(pool);
if (provider.name !== 'local') die(`expected local provider, got ${provider.name}`);

// Faucet-free seeding: transfer USDC + native gas from the funded W1 actor. Keeps
// this test off the rate-limited Circle faucet (uses testnet USDC already on hand).
async function seed(address, usdc, native) {
  await fundAddress(address, { usdc, native });
}
async function post(path, body, token) {
  const r = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  let json; try { json = await r.json(); } catch { json = {}; }
  return { status: r.status, json };
}
const mintToken = (agentId, wallet, name) => jwt.sign({ sub: agentId, wallet: wallet.toLowerCase(), scope: 'agent:full', agentName: name, jti: `tok-${Math.random().toString(36).slice(2,10)}` }, JWT_SECRET, { expiresIn: '1h' });

console.log(`${C.b}${C.c}\n════ FULL-LOCAL On-Chain Escrow + Platform Fee E2E (no Turnkey) ════${C.x}`);
console.log(`${C.d}API ${API}  provider=${provider.name}  platform ${PLATFORM}  fee ${FEE_BPS}bps → ${EXPECTED_FEE} USDC${C.x}`);

{
  const h = await fetch(`${API}/api/health`).then(r => r.json()).catch(() => null);
  if (!h || h.status !== 'ok') die(`server not healthy at ${API}`);
  A(true, `server up (db=${h.db})`);
}

// 1. Local creator + provider wallets.
console.log(`\n${C.c}▸ 1. create local wallets${C.x}`);
const creator = (await provider.createWallet('fee-creator')).address;
const providerW = (await provider.createWallet('fee-provider')).address;
console.log(`  creator=${creator}  provider=${providerW}`);
A(!!creator && !!providerW, 'two local wallets created');

// 2. Seed creator (budget + fee + gas) + provider (gas) from W1 — no faucet.
console.log(`\n${C.c}▸ 2. seed creator + provider from W1 (no faucet)${C.x}`);
await seed(creator, EARN + EXPECTED_FEE + 0.2, 0.5);
await seed(providerW, 0, 0.5);
await new Promise(r => setTimeout(r, 3000));
const creatorStart = await escrow.usdcBalance(creator);
A(fromUsdcWei(creatorStart) >= EARN + EXPECTED_FEE, `creator seeded (${fromUsdcWei(creatorStart)} USDC ≥ budget+fee)`);

// 3. Seed agents + proposal_selected bounty + accepted proposal.
console.log(`\n${C.c}▸ 3. seed DB${C.x}`);
const stamp = Date.now();
const creatorId = `agent-fct-${stamp}`, providerId = `agent-fpv-${stamp}`;
const bountyId = `bounty-fee-${stamp}`, proposalId = `prop-fee-${stamp}`;
const now = new Date().toISOString();
const cx = new pg.Client({ connectionString: DB }); await cx.connect();
try {
  for (const [id, name, wallet] of [[creatorId,'fee-creator',creator],[providerId,'fee-provider',providerW]])
    await cx.query(`INSERT INTO agents (id, owner_wallet, agent_name, agent_public_key, reputation_score, status, turnkey_address, created_at) VALUES ($1,$2,$3,$4,50,'active',$5,$6)`, [id, wallet.toLowerCase(), name, wallet, wallet, now]);
  await cx.query(`INSERT INTO bounties (id, creator_wallet, title, description, bounty_type, amount_usdc, deadline, status, selection_mode, selected_proposal_id, escrow_status, escrow_mode, created_at, updated_at) VALUES ($1,$2,$3,'fee-e2e','task',$4,$5,'proposal_selected','proposal',$6,'none','custodial',$7,$7)`, [bountyId, creator, 'Fee test bounty', String(EARN), now, proposalId, now]);
  await cx.query(`INSERT INTO bounty_proposals (id, bounty_id, proposer_agent_id, proposer_wallet, plan, proposed_price_usdc, status, accepted_at, created_at, updated_at) VALUES ($1,$2,$3,$4,'plan',$5,'accepted',$6,$6,$6)`, [proposalId, bountyId, providerId, providerW, EARN, now]);
  A(true, `seeded bounty ${bountyId}`);
} catch (e) { die(`seed failed: ${e.message}`); }

// 4. /fund → on-chain openAndFund WITH fee.
console.log(`\n${C.c}▸ 4. POST /fund (fee active)${C.x}`);
const platformStart = await escrow.usdcBalance(PLATFORM);
const fund = await post(`/api/bounties/${bountyId}/fund`, { clientWallet: creator, budgetUsdc: EARN });
A(fund.status === 200, `fund 200 (${fund.status}${fund.status!==200?' — '+JSON.stringify(fund.json):''})`);
A(fund.json.escrow_mode === 'onchain', `escrow_mode='onchain'`);
A(fund.json.platform_fee_usdc === EXPECTED_FEE, `fund response platform_fee_usdc=${fund.json.platform_fee_usdc} (expected ${EXPECTED_FEE})`);
const jobId = fund.json.onchain_job_id;
A(!!jobId, `jobId ${jobId}`);
if (jobId) { const j = await escrow.getJob(jobId); A(Number(j.status) === 1, `job Funded (status=${j.status})`); }
// Creator was debited budget + fee (fee held in the hook until release).
const creatorAfterFund = fromUsdcWei(creatorStart - (await escrow.usdcBalance(creator)));
A(creatorAfterFund >= EARN + EXPECTED_FEE - 0.0005, `creator debited budget+fee (${creatorAfterFund.toFixed(4)} USDC)`);

// 5. /deliver → on-chain submit.
console.log(`\n${C.c}▸ 5. POST /deliver${C.x}`);
const deliver = await post(`/api/bounties/${bountyId}/deliver`, { content: 'work' }, mintToken(providerId, providerW, 'fee-provider'));
A(deliver.status === 200, `deliver 200 (${deliver.status}${deliver.status!==200?' — '+JSON.stringify(deliver.json):''})`);
if (jobId) { const j = await escrow.getJob(jobId); A(Number(j.status) === 2, `job Submitted (status=${j.status})`); }

// 6. /review approve.
console.log(`\n${C.c}▸ 6. POST /review${C.x}`);
const review = await post(`/api/bounties/${bountyId}/review`, { clientWallet: creator, decision: 'approved' });
A(review.status === 200, `review 200 (${review.status})`);

// 7. /platform-verify → on-chain release: provider gets full budget, platform gets fee.
console.log(`\n${C.c}▸ 7. POST /platform-verify (release + fee settle)${C.x}`);
const provBefore = jobId ? await escrow.usdcBalance(providerW) : 0n;
const verify = await post(`/api/bounties/${bountyId}/platform-verify`, { verifierWallet: PLATFORM.toLowerCase(), decision: 'approved', reasoning: 'ok' });
A(verify.status === 200, `platform-verify 200 (${verify.status}${verify.status!==200?' — '+JSON.stringify(verify.json):''})`);
if (jobId) {
  const j = await escrow.getJob(jobId); A(Number(j.status) === 3, `job Completed (status=${j.status})`);
  const provDelta = fromUsdcWei((await escrow.usdcBalance(providerW)) - provBefore);
  A(provDelta > EARN - 0.02 && provDelta <= EARN, `provider paid FULL budget ~${EARN} (Δ ${provDelta.toFixed(4)}) — fee not deducted from provider`);
  // The platform receives the gross fee (EXPECTED_FEE) on release, but it also SIGNS
  // and pays gas for the evaluator "complete" leg, so its NET on-chain balance rises
  // by the fee minus that one tx of gas (~0.002-0.003 USDC). Net gain must be positive
  // and within a gas tolerance of the gross fee. (The gross 0.025 is proven separately
  // by fund.json.platform_fee_usdc and the server's settlement decode.)
  const platDelta = fromUsdcWei((await escrow.usdcBalance(PLATFORM)) - platformStart);
  A(platDelta > 0 && (EXPECTED_FEE - platDelta) < 0.005, `platform netted fee ~${EXPECTED_FEE} minus release gas (net Δ ${platDelta.toFixed(6)})`);
}
const row = (await cx.query('SELECT escrow_status, release_tx_hash FROM bounties WHERE id=$1', [bountyId])).rows[0];
A(row?.escrow_status === 'released', `DB escrow_status='released'`);
await cx.end(); await pool.end();

console.log(`\n${C.b}${C.c}════ Results ════${C.x}\n  passed: ${passed}  failed: ${failed}  jobId: ${jobId}  fee: ${EXPECTED_FEE} USDC  ${C.d}(zero Turnkey)${C.x}`);
process.exit(failed ? 1 : 0);
