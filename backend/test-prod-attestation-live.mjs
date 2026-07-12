#!/usr/bin/env node
/**
 * LIVE PROD attestation-signing E2E — proves a self-hosted (local-keystore) agent
 * wallet signs BARD attestations server-side with ZERO Turnkey. Complements
 * test-prod-onchain-live.mjs (which covers escrow legs but never the contribution/
 * agent-verify attestation path).
 *
 * Registers a local-wallet agent on prod, submits a contribution (no client
 * signature, so the server MUST sign via the wallet provider), then recovers the
 * signer from the returned signature and asserts it equals the agent's local wallet.
 * Recovering a valid signer over the exact canonical message is cryptographic proof
 * the local keystore produced it. Env: BARD_API (defaults prod).
 */
import 'dotenv/config';
import { recoverMessageAddress, keccak256, toHex } from 'viem';

const API = process.env.BARD_API || 'https://bard-production-e88b.up.railway.app';
const C = { g:'\x1b[32m', r:'\x1b[31m', c:'\x1b[36m', d:'\x1b[2m', b:'\x1b[1m', x:'\x1b[0m' };
let passed = 0, failed = 0;
const A = (c, m) => { console.log(`  ${c ? C.g+'✓' : C.r+'✗ FAIL'}${C.x} ${m}`); c ? passed++ : failed++; };
const die = (m) => { console.error(`${C.r}fatal: ${m}${C.x}`); process.exit(2); };

async function j(path, body, token) {
  const r = await fetch(`${API}${path}`, { method:'POST', headers:{ 'Content-Type':'application/json', ...(token?{Authorization:`Bearer ${token}`}:{}) }, body: JSON.stringify(body) });
  let json; try { json = await r.json(); } catch { json = {}; }
  return { status: r.status, json };
}
async function g(path, token) {
  const r = await fetch(`${API}${path}`, { headers: token?{Authorization:`Bearer ${token}`}:{} });
  let json; try { json = await r.json(); } catch { json = {}; }
  return { status: r.status, json };
}

// Canonical message — byte-identical to server.js canonicalContributionMessage().
const canonical = ({ agentId, type, proofHash }) => `BARD contribution attestation\nagent:${agentId}\ntype:${type}\nproof:${proofHash}`;

console.log(`${C.b}${C.c}\n════ LIVE PROD Attestation Signing E2E (zero Turnkey) ════${C.x}`);
console.log(`${C.d}API ${API}${C.x}`);
{ const h = await fetch(`${API}/api/health`).then(r=>r.json()); A(h.status==='ok', `prod up — seller ${h.sellerAddress}`); }

// 1. Register an agent and provision its self-hosted wallet.
console.log(`\n${C.c}▸ 1. register agent + local wallet${C.x}`);
const reg = await j('/api/agents/register', { ownerWallet:'0x0000000000000000000000000000000000000000', agentName:`attest-${Date.now()}${Math.floor(Math.random()*1e4)}`, agentPublicKey:`pk-${Date.now()}-${Math.random()}` });
if (reg.status !== 200 && reg.status !== 201) die(`register failed: ${JSON.stringify(reg.json)}`);
const token = reg.json.token;
const agentId = reg.json.agent?.id || reg.json.agentId;
const w = await j(`/api/agents/${agentId}/wallet`, {}, token);
if (w.status !== 200 || !w.json.address) die(`wallet failed: ${JSON.stringify(w.json)}`);
const localAddr = w.json.address;
A(/^0x[0-9a-fA-F]{40}$/.test(localAddr), `agent got local wallet ${localAddr}`);
A(w.json.turnkeyEnabled !== false, `wallet provider active (provider=${w.json.provider || 'n/a'})`);

// 2. Submit a contribution with NO client signature → server signs via local keystore.
console.log(`\n${C.c}▸ 2. submit contribution (server-side attestation)${C.x}`);
const type = 'research';
const proofHash = keccak256(toHex(`prod-attest-${Date.now()}-${Math.random()}`));
const sub = await j('/api/contributions', { type, proofHash, description: 'live prod attestation-signing proof' }, token);
A(sub.status === 200, `contribution accepted (${sub.status}${sub.status!==200?' — '+JSON.stringify(sub.json):''})`);
const contribution = sub.json.contribution;
A(!!contribution?.id, `contribution id ${contribution?.id}`);
const signature = contribution?.signature;
A(/^0x[0-9a-fA-F]{130}$/.test(signature || ''), `65-byte signature returned`);

// 3. Recover the signer — must be the agent's local wallet (proves the keystore signed).
console.log(`\n${C.c}▸ 3. recover signer from attestation${C.x}`);
if (signature && contribution?.id) {
  const message = canonical({ agentId: contribution.agentId, type, proofHash });
  let recovered = null;
  try { recovered = await recoverMessageAddress({ message, signature }); } catch (e) { A(false, `recover threw: ${e.message}`); }
  if (recovered) {
    console.log(`  ${C.d}recovered ${recovered}${C.x}`);
    A(recovered.toLowerCase() === localAddr.toLowerCase(), `signer === agent local wallet (zero Turnkey)`);
  }
}

// 4. Persisted — re-read the contribution and confirm the signature stuck.
console.log(`\n${C.c}▸ 4. signature persisted${C.x}`);
const reread = await g(`/api/contributions/${contribution?.id}`);
A(reread.status === 200, `re-read 200 (${reread.status})`);
const persisted = reread.json.contribution || reread.json;
A(persisted?.signature === signature, `stored signature matches`);

console.log(`\n${C.b}${C.c}════ Results ════${C.x}\n  passed: ${passed}  failed: ${failed}  ${C.d}(prod, local-keystore attestation)${C.x}`);
process.exit(failed?1:0);
