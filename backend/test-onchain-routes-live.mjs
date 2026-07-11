#!/usr/bin/env node
/**
 * ROUTE-LEVEL on-chain escrow E2E — proves server.js drives the ERC-8183 lifecycle
 * through its HTTP endpoints (not the engine directly). Complements
 * test-onchain-escrow-agents.mjs (which tests escrow-service.js in isolation).
 *
 *   provision 2 Turnkey wallets → faucet creator + gas both
 *     → seed DB (2 agents + proposal_selected bounty + accepted proposal)
 *     → POST /fund      (creator)  → assert on-chain job Funded, DB escrow_mode='onchain'
 *     → POST /deliver   (provider) → assert on-chain job Submitted
 *     → POST /review    (creator)  → client approves (off-chain)
 *     → POST /platform-verify      → assert on-chain job Completed + provider paid
 *
 * Requires a server booted with ONCHAIN_ESCROW=1 against the DATABASE_URL this test
 * seeds, and SELLER_ADDRESS=PLATFORM_OWNER_WALLET=0xACA613… (evaluator + gas + verifier).
 *
 * Run (see run-onchain-routes-live.sh which wires all of this up):
 *   node --import ./fetch-retry.mjs test-onchain-routes-live.mjs
 */
import 'dotenv/config';
import { Turnkey } from '@turnkey/sdk-server';
import jwt from 'jsonwebtoken';
import pg from 'pg';

const PLATFORM = '0xACA613aF220d24Dd8554dF1888c34638A5f8EFBf';
process.env.SELLER_ADDRESS = PLATFORM; // escrow-service reads this at import (gas source)

const escrow = await import('./escrow-service.js');
const { fromUsdcWei } = escrow;

const API = process.env.BARD_API || 'http://localhost:4123';
const JWT_SECRET = process.env.JWT_SECRET;
const ORG = process.env.TURNKEY_ORGANIZATION_ID;
const CIRCLE = process.env.CIRCLE_API_KEY;
const DB = process.env.DATABASE_URL;
const EARN = 1.0; // USDC earnings (no platform fee for P2P bounties)

const C = { g:'\x1b[32m', r:'\x1b[31m', y:'\x1b[33m', c:'\x1b[36m', d:'\x1b[2m', b:'\x1b[1m', x:'\x1b[0m' };
let passed = 0, failed = 0;
const A = (cond, msg) => { console.log(`  ${cond ? C.g+'✓' : C.r+'✗ FAIL'}${C.x} ${msg}`); cond ? passed++ : failed++; };
const die = (m) => { console.error(`${C.r}fatal: ${m}${C.x}`); process.exit(2); };

if (!JWT_SECRET) die('JWT_SECRET not set');
if (!DB) die('DATABASE_URL not set');

const tk = new Turnkey({
  defaultOrganizationId: ORG, apiBaseUrl: 'https://api.turnkey.com',
  apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY, apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY,
});
const api = tk.apiClient();

async function newWallet(label) {
  const stamp = Math.random().toString(36).slice(2, 8);
  const w = await api.createWallet({
    walletName: `bard-routetest-${label}-${stamp}`,
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
async function post(path, body, token) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  let json; try { json = await r.json(); } catch { json = {}; }
  return { status: r.status, json };
}
const mintToken = (agentId, wallet, agentName) =>
  jwt.sign({ sub: agentId, wallet: wallet.toLowerCase(), scope: 'agent:full', agentName, jti: `tok-test-${Math.random().toString(36).slice(2,10)}` }, JWT_SECRET, { expiresIn: '1h' });

console.log(`${C.b}${C.c}\n════ Route-Level On-Chain Escrow E2E ════${C.x}`);
console.log(`${C.d}API ${API}  AC ${escrow.AGENTIC_COMMERCE_ADDRESS}${C.x}`);

// ── health preflight: confirm the server is up ──
{
  const h = await fetch(`${API}/api/health`).then(r => r.json()).catch(() => null);
  if (!h || h.status !== 'ok') die(`server not healthy at ${API}`);
  A(h.turnkey === true, `server up (db=${h.db}, turnkey=${h.turnkey})`);
}

// ── 1. Provision creator + provider Turnkey wallets ──
console.log(`\n${C.c}▸ 1. Provision Turnkey wallets${C.x}`);
const creatorWallet = await newWallet('creator');
const providerWallet = await newWallet('provider');
console.log(`  creator  = ${creatorWallet}`);
console.log(`  provider = ${providerWallet}`);

// ── 2. Faucet + gas ──
console.log(`\n${C.c}▸ 2. Faucet USDC → creator, gas → both${C.x}`);
await faucet(creatorWallet);
await new Promise(r => setTimeout(r, 8000));
await escrow.ensureGas(creatorWallet);
await escrow.ensureGas(providerWallet);
const creatorUsdc = fromUsdcWei(await escrow.usdcBalance(creatorWallet));
console.log(`  creator USDC: ${creatorUsdc.toFixed(2)} (need ≥ ${EARN})`);
if (creatorUsdc < EARN) die(`creator underfunded (${creatorUsdc} < ${EARN}) — faucet again`);

// ── 3. Seed DB: 2 agents + proposal_selected bounty + accepted proposal ──
console.log(`\n${C.c}▸ 3. Seed agents + bounty + accepted proposal${C.x}`);
const stamp = Date.now();
const creatorId = `agent-ct-${stamp}`, providerId = `agent-pv-${stamp}`;
const bountyId = `bounty-rt-${stamp}`, proposalId = `prop-rt-${stamp}`;
const now = new Date().toISOString();
const client = new pg.Client({ connectionString: DB });
await client.connect();
try {
  for (const [id, name, wallet] of [[creatorId,'route-creator',creatorWallet],[providerId,'route-provider',providerWallet]]) {
    await client.query(
      `INSERT INTO agents (id, owner_wallet, agent_name, agent_public_key, reputation_score, status, turnkey_address, created_at)
       VALUES ($1,$2,$3,$4,$5,'active',$6,$7)`,
      [id, wallet.toLowerCase(), name, wallet, 50, wallet, now]
    );
  }
  await client.query(
    `INSERT INTO bounties (id, creator_wallet, title, description, bounty_type, amount_usdc, deadline,
       status, selection_mode, selected_proposal_id, escrow_status, escrow_mode, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'task',$5,$6,'proposal_selected','proposal',$7,'none','custodial',$8,$8)`,
    [bountyId, creatorWallet, 'Route on-chain test bounty', 'e2e', String(EARN), now, proposalId, now]
  );
  await client.query(
    `INSERT INTO bounty_proposals (id, bounty_id, proposer_agent_id, proposer_wallet, plan, proposed_price_usdc, status, accepted_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'accepted',$7,$7,$7)`,
    [proposalId, bountyId, providerId, providerWallet, 'do the work', EARN, now]
  );
  A(true, `seeded bounty ${bountyId} (creator agent ${creatorId}, provider agent ${providerId})`);
} catch (e) { die(`seed failed: ${e.message}`); }

// ── 4. POST /fund (creator) → on-chain openAndFund ──
console.log(`\n${C.c}▸ 4. POST /fund → on-chain openAndFund${C.x}`);
const fund = await post(`/api/bounties/${bountyId}/fund`, { clientWallet: creatorWallet, budgetUsdc: EARN });
A(fund.status === 200, `fund 200 (got ${fund.status}${fund.status !== 200 ? ' — ' + JSON.stringify(fund.json) : ''})`);
A(fund.json.escrow_mode === 'onchain', `response escrow_mode='onchain' (got ${fund.json.escrow_mode})`);
const jobId = fund.json.onchain_job_id;
A(!!jobId, `onchain_job_id returned (${jobId})`);
if (jobId) {
  const job = await escrow.getJob(jobId);
  A(Number(job.status) === 1, `on-chain job Funded (status=${job.status})`);
  A(job.provider.toLowerCase() === providerWallet.toLowerCase(), 'provider assigned on-chain');
}

// ── 5. POST /deliver (provider JWT) → on-chain submit ──
console.log(`\n${C.c}▸ 5. POST /deliver → on-chain submit${C.x}`);
const provToken = mintToken(providerId, providerWallet, 'route-provider');
const deliver = await post(`/api/bounties/${bountyId}/deliver`, { content: 'the finished deliverable' }, provToken);
A(deliver.status === 200, `deliver 200 (got ${deliver.status}${deliver.status !== 200 ? ' — ' + JSON.stringify(deliver.json) : ''})`);
if (jobId) {
  const job = await escrow.getJob(jobId);
  A(Number(job.status) === 2, `on-chain job Submitted (status=${job.status})`);
}

// ── 6. POST /review (creator approves — off-chain) ──
console.log(`\n${C.c}▸ 6. POST /review → client approves${C.x}`);
const review = await post(`/api/bounties/${bountyId}/review`, { clientWallet: creatorWallet, decision: 'approved' });
A(review.status === 200, `review 200 (got ${review.status}${review.status !== 200 ? ' — ' + JSON.stringify(review.json) : ''})`);

// ── 7. POST /platform-verify (platform approves) → on-chain release ──
console.log(`\n${C.c}▸ 7. POST /platform-verify → on-chain release${C.x}`);
const provBefore = jobId ? await escrow.usdcBalance(providerWallet) : 0n;
const verify = await post(`/api/bounties/${bountyId}/platform-verify`, { verifierWallet: PLATFORM.toLowerCase(), decision: 'approved', reasoning: 'looks good' });
A(verify.status === 200, `platform-verify 200 (got ${verify.status}${verify.status !== 200 ? ' — ' + JSON.stringify(verify.json) : ''})`);
if (jobId) {
  const job = await escrow.getJob(jobId);
  A(Number(job.status) === 3, `on-chain job Completed (status=${job.status})`);
  const provDelta = fromUsdcWei((await escrow.usdcBalance(providerWallet)) - provBefore);
  A(provDelta > EARN - 0.02 && provDelta <= EARN, `provider balance rose ~${EARN} (net of gas: ${provDelta.toFixed(4)})`);
}
// ── DB reflects released ──
const dbRow = (await client.query('SELECT escrow_status, escrow_mode, release_tx_hash FROM bounties WHERE id = $1', [bountyId])).rows[0];
A(dbRow?.escrow_status === 'released', `DB escrow_status='released' (got ${dbRow?.escrow_status})`);
A(dbRow?.escrow_mode === 'onchain', `DB escrow_mode='onchain'`);
A(!!dbRow?.release_tx_hash, `DB release_tx_hash recorded (${dbRow?.release_tx_hash?.slice(0,16)}…)`);

await client.end();
console.log(`\n${C.b}${C.c}════ Results ════${C.x}`);
console.log(`  passed: ${passed}   failed: ${failed}   jobId: ${jobId}`);
process.exit(failed ? 1 : 0);
