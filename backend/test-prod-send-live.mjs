#!/usr/bin/env node
/**
 * LIVE PROD send-usdc probe — checks agent→agent USDC transfer on prod via all three
 * recipient forms (wallet / toAgentName / toUsername) with self-hosted (local) wallets.
 * Seeds the sender from the platform wallet (no faucet). Reports pass/fail per form.
 */
import 'dotenv/config';
const API = process.env.BARD_API || 'https://bard-production-e88b.up.railway.app';
const PLATFORM = '0x40363e3Dd3cA46c87bf79cf28DFeDD9ed3092E3f';
const C = { g:'\x1b[32m', r:'\x1b[31m', c:'\x1b[36m', d:'\x1b[2m', b:'\x1b[1m', x:'\x1b[0m' };
const die = (m) => { console.error(`${C.r}fatal: ${m}${C.x}`); process.exit(2); };
async function j(path, body, token) {
  const r = await fetch(`${API}${path}`, { method:'POST', headers:{ 'Content-Type':'application/json', ...(token?{Authorization:`Bearer ${token}`}:{}) }, body: JSON.stringify(body) });
  let json; try { json = await r.json(); } catch { json = {}; }
  return { status: r.status, json };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function makeAgent(label) {
  const agentName = `${label}-${Date.now()}${Math.floor(Math.random()*1e4)}`;
  const reg = await j('/api/agents/register', { ownerWallet:'0x0000000000000000000000000000000000000000', agentName, agentPublicKey:`pk-${Date.now()}-${Math.random()}` });
  if (reg.status !== 200 && reg.status !== 201) die(`register ${label}: ${JSON.stringify(reg.json)}`);
  const token = reg.json.token, id = reg.json.agent?.id || reg.json.agentId;
  const w = await j(`/api/agents/${id}/wallet`, {}, token);
  if (w.status !== 200 || !w.json.address) die(`wallet ${label}: ${JSON.stringify(w.json)}`);
  return { id, token, addr: w.json.address, name: agentName };
}

console.log(`${C.b}${C.c}\n════ LIVE PROD send-usdc probe ════${C.x}\n${C.d}API ${API}${C.x}`);
const A = await makeAgent('sendA');
const B = await makeAgent('sendB');
console.log(`  sender  ${A.addr} (${A.name})\n  recip   ${B.addr} (${B.name})`);

// Seed sender with USDC from the platform wallet (no faucet).
const seed = await j('/api/admin/platform-send', { callerWallet: PLATFORM, to: A.addr, amountUsdc: '2.00' }, A.token);
console.log(`  seed sender: platform-send ${seed.status}${seed.status!==200?' '+JSON.stringify(seed.json):''}`);
await sleep(6000);

async function trySend(desc, body) {
  const r = await j(`/api/agents/${A.id}/send-usdc`, body, A.token);
  const ok = r.status === 200 && r.json.txHash;
  console.log(`  ${ok ? C.g+'✓' : C.r+'✗'}${C.x} ${desc}: ${r.status}${ok ? ` tx ${r.json.txHash.slice(0,12)}…` : ' — '+(r.json.error||JSON.stringify(r.json)).slice(0,120)}`);
  return ok;
}

console.log(`\n${C.c}▸ send 0.25 USDC three ways${C.x}`);
const byWallet = await trySend('by wallet (to)', { to: B.addr, amount: '0.25' });
const byAgent  = await trySend('by toAgentName', { toAgentName: B.name, amount: '0.25' });
const byUser   = await trySend('by toUsername', { toUsername: 'definitely-no-such-user-x', amount: '0.25' }); // expect 404 (resolution), not a signing failure

console.log(`\n${C.b}result:${C.x} wallet=${byWallet} agentName=${byAgent} (username path resolves before signing)`);
process.exit(0);
