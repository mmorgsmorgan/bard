import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { createServer } from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
const database = process.env.BARD_TEST_DATABASE_URL;
if (!database) throw new Error('Set isolated BARD_TEST_DATABASE_URL.');
const port = 45439;
const ethos = createServer((_req,res) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ humanVerificationStatus: 'VERIFIED', score: 1500 })); });
ethos.listen(45440,'127.0.0.1');
await once(ethos,'listening');
const pool = new pg.Pool({ connectionString: database });
const secret = randomBytes(32).toString('hex');
const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null',
  DATABASE_URL: database, PORT: String(port), JWT_SECRET: secret, MCP_ONLY_AGENT_API: 'false',
  WALLET_PROVIDER: 'local', WALLET_MASTER_KEY: randomBytes(32).toString('hex'),
  PLATFORM_FEE_BPS: '500',
  ETHOS_API_BASE: 'http://127.0.0.1:45440', ARC_TESTNET_RPC: 'http://127.0.0.1:1', ONCHAIN_ESCROW: 'true',
  AGENTIC_COMMERCE_ADDRESS: '0x' + '33'.repeat(20), BARD_JOB_HOOK_ADDRESS: '0x' + '44'.repeat(20), SELLER_ADDRESS: '0x' + '55'.repeat(20) };
const fixture = process.env.BARD_TEST_CHAIN === '1' ? await (await import('./agent-chain-fixture.mjs')).startChain(pool,env) : null;
const startServer = () => spawn(process.execPath, ['backend/server.js'], { env, stdio: ['ignore','pipe','pipe'] });
let server = startServer();
let logs = '';
server.stdout.on('data', b => { logs += b; });
server.stderr.on('data', b => { logs += b; });
async function call(path, body, token, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch('http://127.0.0.1:' + port + path, { signal: AbortSignal.timeout(30000), method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, data: await r.json() };
}
try {
  let ready = false;
  for (let i=0;i<80;i++) {
    if (server.exitCode !== null) throw new Error(logs);
    try { ready = (await call('/api/agents')).status === 200; } catch {}
    if (ready) break;
    await new Promise(r => setTimeout(r,100));
  }
  assert.ok(ready, logs);
  assert.equal((await call('/api/human/wallet')).status, 410);
  for (const path of ['/api/human/profile', '/api/human/bounties', '/auth/login', '/api/profiles', '/api/premium/export/wallet', '/api/portfolio/wallet', '/api/proofs/wallet']) {
    assert.equal((await call(path, {})).status, 410, path + ' must stay retired');
    assert.equal((await call(path)).status, 410, path + ' must stay retired');
  }
  const paymentInfo = await call('/api/x402/info');
  assert.equal(paymentInfo.data.enabled, false);
  assert.deepEqual(paymentInfo.data.endpoints, []);
  const swarmRegistration = await call('/api/agents/register', { agentType: 'swarm', swarmConfig: {} });
  assert.equal(swarmRegistration.status, 503);
  const agents = [];
  for (let i=0;i<2;i++) {
    const r = await call('/api/agents/register', { ownerWallet: '0x' + '00'.repeat(20), agentPublicKey: 'pk-' + crypto.randomUUID(), agentName: 'fresh-' + crypto.randomUUID(), agentType: 'research' });
    assert.equal(r.status,200,JSON.stringify(r.data));
    const token = r.data.token;
    const id = r.data.agent.id;
    const wallet = await call('/api/agents/' + id + '/wallet',{},token);
    assert.equal(wallet.status,200,JSON.stringify(wallet.data));
    agents.push({ id, token, address: wallet.data.address });
    // The buyer can deposit the fee but initially cannot fund the job budget.
    if (fixture) await fixture.fund(wallet.data.address, i === 0 ? 100000n : 100000000n);
  }
  const [buyer, seller] = agents;
  for (const operation of ['dex/swap']) {
    const unavailable = await call('/api/agents/' + buyer.id + '/' + operation, {}, buyer.token);
    assert.equal(unavailable.status, 409);
    assert.match(unavailable.data.error, /VCR/);
  }
  assert.equal((await call('/api/agents/' + buyer.id + '/vouches', {}, buyer.token)).status, 410);
  assert.equal((await call('/api/vouches/contributor/' + buyer.address)).status, 410);
  assert.equal((await call('/api/bounties/old/claim', {}, buyer.token)).status, 410);
  const firstCome = await call('/api/bounties', { selectionMode: 'first_come' }, buyer.token);
  assert.equal(firstCome.status, 400);
  assert.match(firstCome.data.error, /negotiated proposals/);
  const owner = privateKeyToAccount('0x' + '77'.repeat(32));
  const session = await call('/api/agents/' + buyer.id + '/human-link-session', {}, buyer.token);
  assert.equal(session.status, 200, JSON.stringify(session.data));
  const linkToken = new URL(session.data.verificationUrl).hash.slice(1);
  const challenge = await call('/api/human-links/challenge', { wallet: owner.address, providers: ['ethos'] }, linkToken);
  assert.equal(challenge.status,200,JSON.stringify(challenge.data));
  const signature = await owner.signMessage({ message: challenge.data.message });
  const linked = await call('/api/human-links/complete', { challengeId: challenge.data.challengeId, signature }, linkToken);
  assert.equal(linked.status,200,JSON.stringify(linked.data));
  assert.equal((await call('/api/human-links/complete', { challengeId: challenge.data.challengeId, signature }, linkToken)).status,410);
  assert.equal((await call('/api/auth/me', undefined, linkToken)).status, 401);
  assert.equal((await call('/api/auth/verify', { challengeId: challenge.data.challengeId, signature, wallet: owner.address })).status,404);
  const ownerRow = (await pool.query('SELECT owner_wallet,ethos_owner_wallet FROM agents WHERE id = $1',[buyer.id])).rows[0];
  assert.equal(ownerRow.ethos_owner_wallet,owner.address.toLowerCase());
  assert.notEqual(ownerRow.owner_wallet,owner.address.toLowerCase());
  const r = await call('/api/bounties', { title: 'Fresh negotiation', description: 'Review one code defect', bountyType: 'code_review', amountUsdc: '2', deadline: new Date(Date.now()+86400000).toISOString(), selectionMode: 'proposal', acceptanceCriteria: ['Explain the defect'] },buyer.token);
  assert.equal(r.status,200,JSON.stringify(r.data));
  const id = r.data.bounty.id;
  let bid = await call('/api/bounties/' + id + '/proposals', { plan: 'Inspect the code and report a defect', proposedPriceUsdc: '2', estimatedHours: 1 },seller.token);
  assert.equal(bid.status,200,JSON.stringify(bid.data));
  assert.ok(bid.data.proposal.acl_offer.providerSignature);
  const firstOffer = bid.data.proposal.acl_offer;
  bid = await call('/api/bounties/' + id + '/proposals/' + bid.data.proposal.id, { plan: 'Inspect code boundaries and report a reproducible defect', estimatedHours: 2 }, seller.token, 'PUT');
  assert.equal(bid.status, 200, JSON.stringify(bid.data));
  assert.notEqual(bid.data.proposal.acl_offer.message.taskSpecHash, firstOffer.message.taskSpecHash);
  assert.notEqual(bid.data.proposal.acl_offer.providerSignature, firstOffer.providerSignature);
  assert.deepEqual(bid.data.proposal.acl_offer.task.extensions.platformFee, { bps: 500, amount: '100000', recipient: env.SELLER_ADDRESS.toLowerCase() });
  const accepted = await call('/api/bounties/' + id + '/proposals/' + bid.data.proposal.id + '/accept',{},buyer.token);
  assert.equal(accepted.status,200,JSON.stringify(accepted.data));
  const proposals = await call('/api/bounties/' + id + '/proposals', undefined, buyer.token);
  assert.ok(proposals.data.proposals[0].acl_offer.clientSignature);
  const funded = await call('/api/bounties/' + id + '/fund', {}, buyer.token);
  assert.equal(funded.status,502,JSON.stringify(funded.data));
  assert.match(funded.data.error, /VCR/);
  const job = (await pool.query('SELECT onchain_job_id,escrow_status FROM bounties WHERE id = $1',[id])).rows[0];
  assert.equal(job.onchain_job_id,null);
  assert.equal(job.escrow_status,'none');
  if (fixture) {
    server.kill('SIGTERM');
    if (server.exitCode === null) await once(server,'exit');
    env.BARD_VCR_URL = 'http://127.0.0.1:45440';
    env.BARD_VCR_POLICIES = JSON.stringify({ [buyer.address.toLowerCase()]: 'buyer.eth' });
    env.PLATFORM_FEE_BPS = '1000';
    ethos.removeAllListeners('request');
    ethos.on('request',(_req,res) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ result: { allowed: true, policyCid:'fixture',dailySpentAtCheck:'0',policy:{constraints:{dailyLimit:{token:'USDC',chain:'arc-testnet',amount:'100000000'}}} } })); });
    server = startServer();
    server.stdout.on('data',b => { logs += b; });
    server.stderr.on('data',b => { logs += b; });
    for(let i=0;i<80;i++) { try { if ((await call('/api/agents')).status===200) break; } catch {} await new Promise(r=>setTimeout(r,100)); }
    const partial = await call('/api/bounties/' + id + '/fund', {}, buyer.token);
    assert.equal(partial.status, 502, JSON.stringify(partial.data));
    assert.ok(partial.data.onchainJobId, JSON.stringify(partial.data));
    assert.ok(partial.data.completedTransactions.depositFee);
    assert.equal(partial.data.completedTransactions.fund, undefined);
    const partialRow = (await pool.query('SELECT * FROM bounties WHERE id = $1', [id])).rows[0];
    assert.equal(partialRow.escrow_status, 'funding');
    assert.equal(String(partialRow.onchain_job_id), partial.data.onchainJobId);
    assert.equal(await fixture.balance(fixture.hook), 100000n);
    assert.equal(await fixture.balance(fixture.commerce), 0n);
    await fixture.fund(buyer.address, 2000000n);
    const funding = await call('/api/bounties/' + id + '/fund',{},buyer.token);
    assert.equal(funding.status,200,JSON.stringify(funding.data));
    assert.equal(funding.data.onchain_job_id, partial.data.onchainJobId);
    assert.equal(funding.data.tx.depositFee, undefined, 'recovery must not deposit the fee twice');
    assert.equal(funding.data.platform_fee_usdc, 0.1);
    assert.equal(await fixture.balance(buyer.address), 0n);
    assert.equal(await fixture.balance(fixture.hook), 100000n);
    assert.equal(await fixture.balance(fixture.commerce), 2000000n);
    const reservations = (await pool.query('SELECT operation,amount FROM vcr_reservations WHERE wallet = $1', [buyer.address.toLowerCase()])).rows;
    assert.equal(reservations.length, 2);
    assert.equal(reservations.reduce((sum, r) => sum + BigInt(r.amount), 0n), 2100000n);
    const row = (await pool.query('SELECT * FROM bounties WHERE id = $1',[id])).rows[0];
    const chainJob = await fixture.publicClient.readContract({address:fixture.commerce,abi:fixture.abi,functionName:'getJob',args:[BigInt(row.onchain_job_id)]});
    assert.equal(chainJob.description,bid.data.proposal.acl_offer.message.taskSpecHash);
    assert.equal(Number(chainJob.expiredAt),Number(bid.data.proposal.acl_offer.message.expiresAt));
    const feeMeta = await fixture.feeMeta(row.onchain_job_id);
    assert.equal(feeMeta.platformFee, 100000n);
    assert.equal(Number(feeMeta.maxFeeBps), 500);
    assert.equal(feeMeta.feeRecipient.toLowerCase(), env.SELLER_ADDRESS.toLowerCase());
    const escrow = await call('/api/bounties/' + id + '/escrow');
    assert.equal(escrow.status, 200, JSON.stringify(escrow.data));
    assert.equal(escrow.data.onchain.feeBps, 500);
    assert.equal(escrow.data.onchain.platformFeeUsdc, 0.1);
    const retriedFunding = await call('/api/bounties/' + id + '/fund', { onchainJobId: row.onchain_job_id }, buyer.token);
    assert.equal(retriedFunding.status, 200, JSON.stringify(retriedFunding.data));
    assert.equal(retriedFunding.data.alreadyFunded, true);
    assert.equal(await fixture.balance(buyer.address), 0n);
    const delivery = await call('/api/bounties/' + id + '/deliver',{content:'Found an unchecked boundary.',summary:'Boundary defect',testInstructions:'Run boundary case',evidence:[]},seller.token);
    assert.equal(delivery.status,200,JSON.stringify(delivery.data));
    const balance = await fixture.balance(seller.address);
    const feeBalance = await fixture.balance(env.SELLER_ADDRESS);
    await pool.query('UPDATE bounties SET deliverable_content = $1 WHERE id = $2', ['Tampered after provider signing', id]);
    const tampered = await call('/api/bounties/' + id + '/agent-review', { decision: 'approved' }, buyer.token);
    assert.equal(tampered.status, 409, JSON.stringify(tampered.data));
    assert.match(tampered.data.error, /differs from its attestation/);
    assert.equal(await fixture.balance(seller.address), balance);
    assert.equal(await fixture.balance(env.SELLER_ADDRESS), feeBalance);
    await pool.query('UPDATE bounties SET deliverable_content = $1 WHERE id = $2', [delivery.data.bounty.deliverable_content, id]);
    const rejected = await call('/api/bounties/' + id + '/agent-review', { decision: 'rejected', reason: 'Include the exact failing input' }, buyer.token);
    assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
    assert.equal(rejected.data.revisionRequested, true);
    const revised = await call('/api/bounties/' + id + '/deliver', { content: 'Input -1 reaches the unchecked boundary.', summary: 'Boundary defect reproduced', testInstructions: 'Run with input -1', evidence: [] }, seller.token);
    assert.equal(revised.status, 200, JSON.stringify(revised.data));
    assert.notEqual(revised.data.bounty.deliverable_hash, delivery.data.bounty.deliverable_hash);
    await pool.query('UPDATE bounties SET verification_report = $1 WHERE id = $2', [delivery.data.bounty.verification_report, id]);
    const staleProof = await call('/api/bounties/' + id + '/agent-review', { decision: 'approved' }, buyer.token);
    assert.equal(staleProof.status, 409, JSON.stringify(staleProof.data));
    assert.match(staleProof.data.error, /differs from its attestation/);
    assert.equal(await fixture.balance(seller.address), balance);
    await pool.query('UPDATE bounties SET verification_report = $1 WHERE id = $2', [revised.data.bounty.verification_report, id]);
    const review = await call('/api/bounties/' + id + '/agent-review',{decision:'approved',reason:'Evidence checked'},buyer.token);
    assert.equal(review.status,200,JSON.stringify(review.data));
    assert.equal(await fixture.balance(seller.address)-balance,2000000n);
    assert.equal(await fixture.balance(env.SELLER_ADDRESS)-feeBalance,100000n);
    const repeated = await call('/api/bounties/' + id + '/agent-review',{decision:'approved'},buyer.token);
    assert.equal(repeated.status,200,JSON.stringify(repeated.data));
    assert.equal(await fixture.balance(seller.address)-balance,2000000n);
    assert.equal(await fixture.balance(env.SELLER_ADDRESS)-feeBalance,100000n);
    const lateDelivery = await call('/api/bounties/' + id + '/deliver', { content: 'Attempt to replace paid evidence' }, seller.token);
    assert.equal(lateDelivery.status, 409);
    console.log('Local chain: signed fees survive config changes; partial funding resumes once; altered evidence and stale revision proofs block payment; provider and fee recipient are paid once.');
  }
  const human = jwt.sign({ kind: 'human-agent-session', sub: buyer.id },secret);
  assert.equal((await call('/api/auth/me',undefined,human)).status,403);
  console.log('Fresh API registration, wallets, Ethos owner proof/replay, signed proposals, acceptance, VCR denial before funding and human-session rejection passed.');
} catch (err) { console.error(logs.slice(-3000)); throw err; }
finally { server.kill('SIGTERM'); if (server.exitCode === null) await once(server,'exit'); await pool.end(); ethos.close(); if (fixture) await fixture.stop(); }
