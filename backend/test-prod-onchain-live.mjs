#!/usr/bin/env node
/**
 * LIVE PROD on-chain escrow E2E — drives the real bard-production API end-to-end with
 * ZERO Turnkey (WALLET_PROVIDER=hybrid, local platform wallet). Registers two agents,
 * provisions their self-hosted wallets, faucets, runs a proposal bounty through
 * fund->deliver->approve->platform-verify, and confirms the on-chain release.
 *
 * Reads on-chain job state via public RPC (no keys). Env: BARD_API (defaults prod).
 */
import 'dotenv/config';
import { createPublicClient, http } from 'viem';

const API = process.env.BARD_API || 'https://bard-production-e88b.up.railway.app';
const RPC = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const AC = '0x417b10f3abB5355465e0c6B95B6Ee561e5aB42B5'; // AgenticCommerce proxy
const USDC = '0x3600000000000000000000000000000000000000';
const EARN = 1.0;

const C = { g:'\x1b[32m', r:'\x1b[31m', c:'\x1b[36m', d:'\x1b[2m', b:'\x1b[1m', x:'\x1b[0m' };
let passed = 0, failed = 0;
const A = (c, m) => { console.log(`  ${c ? C.g+'✓' : C.r+'✗ FAIL'}${C.x} ${m}`); c ? passed++ : failed++; };
const die = (m) => { console.error(`${C.r}fatal: ${m}${C.x}`); process.exit(2); };
const pub = createPublicClient({ chain:{id:5042002,name:'Arc',nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18},rpcUrls:{default:{http:[RPC]}}}, transport: http(RPC) });
const JOB_ABI = [{name:'getJob',type:'function',stateMutability:'view',inputs:[{type:'uint256'}],outputs:[{type:'tuple',components:[{name:'client',type:'address'},{name:'status',type:'uint8'},{name:'provider',type:'address'},{name:'expiredAt',type:'uint48'},{name:'evaluator',type:'address'},{name:'submittedAt',type:'uint48'},{name:'budget',type:'uint256'},{name:'hook',type:'address'},{name:'paymentToken',type:'address'},{name:'providerAgentId',type:'uint256'},{name:'description',type:'string'}]}]}];
const jobStatus = async (id) => Number((await pub.readContract({ address:AC, abi:JOB_ABI, functionName:'getJob', args:[BigInt(id)] })).status);
const usdcBal = async (a) => Number(await pub.readContract({ address:USDC, abi:[{name:'balanceOf',type:'function',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]}], functionName:'balanceOf', args:[a] }))/1e6;

async function j(path, body, token) {
  const r = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type':'application/json', ...(token?{Authorization:`Bearer ${token}`}:{}) }, body: JSON.stringify(body) });
  let json; try { json = await r.json(); } catch { json = {}; }
  return { status: r.status, json };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log(`${C.b}${C.c}\n════ LIVE PROD On-Chain Escrow E2E (zero Turnkey) ════${C.x}`);
console.log(`${C.d}API ${API}${C.x}`);
{ const h = await fetch(`${API}/api/health`).then(r=>r.json()); A(h.status==='ok', `prod up — seller ${h.sellerAddress}`); }

async function makeAgent(label) {
  const reg = await j('/api/agents/register', { ownerWallet: '0x0000000000000000000000000000000000000000', agentName: `${label}-${Date.now()}${Math.floor(Math.random()*1e4)}`, agentPublicKey: `pk-${Date.now()}-${Math.random()}` });
  if (reg.status !== 200 && reg.status !== 201) die(`register ${label} failed: ${JSON.stringify(reg.json)}`);
  const token = reg.json.token, id = reg.json.agent?.id || reg.json.agentId;
  const w = await j(`/api/agents/${id}/wallet`, {}, token);
  if (w.status !== 200 || !w.json.address) die(`wallet ${label} failed: ${JSON.stringify(w.json)}`);
  return { id, token, addr: w.json.address, name: reg.json.agent?.agent_name };
}

// 1. Two agents with self-hosted wallets.
console.log(`\n${C.c}▸ 1. register creator + provider (local wallets)${C.x}`);
const creator = await makeAgent('prodC');
const provider = await makeAgent('prodP');
console.log(`  creator ${creator.addr}\n  provider ${provider.addr}`);
A(/^0x[0-9a-fA-F]{40}$/.test(creator.addr) && /^0x[0-9a-fA-F]{40}$/.test(provider.addr), 'both got local wallets');

// 2. Seed creator's budget from the platform wallet (faucet is rate-limited; agent
//    GAS is auto-topped by ensureGas in openAndFund, so we only need the USDC budget).
console.log(`\n${C.c}▸ 2. seed creator budget from platform${C.x}`);
const PLATFORM = '0x40363e3Dd3cA46c87bf79cf28DFeDD9ed3092E3f';
const seed = await j('/api/admin/platform-send', { callerWallet: PLATFORM, to: creator.addr, amountUsdc: (EARN + 0.3).toFixed(2) }, creator.token);
A(seed.status === 200, `platform-send 200 (${seed.status}${seed.status!==200?' — '+JSON.stringify(seed.json):''})`);
await sleep(6000);
const cb = await usdcBal(creator.addr);
A(cb >= EARN, `creator funded (${cb} USDC)`);

// 3. Creator posts a proposal bounty.
console.log(`\n${C.c}▸ 3. create proposal bounty${C.x}`);
const deadline = new Date(Date.now()+7*864e5).toISOString();
const bounty = await j('/api/bounties', { creatorWallet: creator.addr, title:'Prod on-chain E2E', description:'live test bounty', bountyType:'code_review', amountUsdc: EARN, deadline, selectionMode:'proposal' }, creator.token);
A(bounty.status===200||bounty.status===201, `bounty created (${bounty.status})`);
const bountyId = bounty.json.bounty?.id || bounty.json.id;
A(!!bountyId, `bountyId ${bountyId}`);

// 4. Provider proposes; creator accepts.
console.log(`\n${C.c}▸ 4. propose + accept${C.x}`);
const prop = await j(`/api/bounties/${bountyId}/proposals`, { plan:'I will complete this code review thoroughly and on time.', proposedPriceUsdc: EARN }, provider.token);
A(prop.status===200||prop.status===201, `proposal submitted (${prop.status}${prop.status>=400?' — '+JSON.stringify(prop.json):''})`);
const propId = prop.json.proposal?.id || prop.json.id;
const acc = await j(`/api/bounties/${bountyId}/proposals/${propId}/accept`, { callerWallet: creator.addr }, creator.token);
A(acc.status===200, `proposal accepted (${acc.status}${acc.status!==200?' — '+JSON.stringify(acc.json):''})`);

// 5. Fund → on-chain openAndFund.
console.log(`\n${C.c}▸ 5. fund → on-chain${C.x}`);
const fund = await j(`/api/bounties/${bountyId}/fund`, { clientWallet: creator.addr, budgetUsdc: EARN }, creator.token);
A(fund.status===200, `fund 200 (${fund.status}${fund.status!==200?' — '+JSON.stringify(fund.json):''})`);
A(fund.json.escrow_mode==='onchain', `escrow_mode='onchain'`);
const jobId = fund.json.onchain_job_id;
A(!!jobId, `on-chain jobId ${jobId}`);
if (jobId) A(await jobStatus(jobId)===1, `job Funded`);

// 6. Deliver → submit; review approve; platform-verify → release.
console.log(`\n${C.c}▸ 6. deliver → review → platform-verify${C.x}`);
const deliver = await j(`/api/bounties/${bountyId}/deliver`, { content:'the work' }, provider.token);
A(deliver.status===200, `deliver 200 (${deliver.status}${deliver.status!==200?' — '+JSON.stringify(deliver.json):''})`);
if (jobId) A(await jobStatus(jobId)===2, `job Submitted`);
const review = await j(`/api/bounties/${bountyId}/review`, { clientWallet: creator.addr, decision:'approved' }, creator.token);
A(review.status===200, `review 200 (${review.status})`);
const before = await usdcBal(provider.addr);
const verify = await j(`/api/bounties/${bountyId}/platform-verify`, { verifierWallet:'0x40363e3Dd3cA46c87bf79cf28DFeDD9ed3092E3f', decision:'approved', reasoning:'ok' }, creator.token);
A(verify.status===200, `platform-verify 200 (${verify.status}${verify.status!==200?' — '+JSON.stringify(verify.json):''})`);
if (jobId) {
  A(await jobStatus(jobId)===3, `job Completed`);
  await sleep(4000);
  const delta = (await usdcBal(provider.addr)) - before;
  A(delta > EARN-0.05 && delta <= EARN+0.001, `provider paid ~${EARN} on-chain (Δ ${delta.toFixed(4)})`);
}

console.log(`\n${C.b}${C.c}════ Results ════${C.x}\n  passed: ${passed}  failed: ${failed}  jobId: ${jobId}  ${C.d}(prod, zero Turnkey)${C.x}`);
process.exit(failed?1:0);
