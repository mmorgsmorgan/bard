const API = 'https://bard-production-413a.up.railway.app';
const RPC = 'https://rpc.testnet.arc.network';
const USDC = '0x3600000000000000000000000000000000000000';
const AGENT_ID = 'agent-1781452740433-bgvjqw';
const SENDER_WALLET = '0xB9b00532653e1D634f1cB141f748030a62dC23e6';
const TARGET_USERNAME = 'chiefmmorgs';
const EXPECTED_WALLET = '0xb804d506d5446b1a3befefc903d84f754973c2d2';
const SEND_AMOUNT = '0.05';

async function withRetry(fn, label, n = 4) {
  let last;
  for (let i = 1; i <= n; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      console.log(`  ! ${label} attempt ${i} failed (${e.code || e.name}); retry in ${1500*i}ms`);
      await new Promise(r => setTimeout(r, 1500*i));
    }
  }
  throw last;
}

async function usdcBalance(addr) {
  return withRetry(async () => {
    const data = '0x70a08231' + addr.toLowerCase().replace('0x','').padStart(64,'0');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    const r = await fetch(RPC, {
      method: 'POST', headers: { 'content-type':'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'eth_call', params:[{ to: USDC, data }, 'latest'] }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const j = await r.json();
    if (!j.result || j.result === '0x') return 0;
    return Number(BigInt(j.result)) / 1_000_000;
  }, `usdcBalance(${addr})`);
}

// Need a fresh token — register a new agent for that
async function freshToken() {
  // We can't reuse the previous token since we never captured it persistently.
  // Easier: just register the sender agent again under a NEW agent (smaller).
  // BUT we want to reuse the funded wallet — so we MUST find another way.
  // Easiest: register and provision a NEW agent each time + drip fresh.
  // For now, just register a NEW agent + use the FUNDED previous wallet by
  // passing it as `ownerWallet`? No — agents.turnkey_address is unique per
  // agent. The funded 0xB9b005...3e6 wallet belongs to the previous agent.
  // Simpler: register a new agent, provision a new wallet, drip again.
  return null;
}

(async () => {
  console.log(`▸ Re-register fresh agent (previous token not saved) + drip again`);
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2,5);
  const reg = await withRetry(async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30_000);
    const r = await fetch(`${API}/api/agents/register`, {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({
        ownerWallet: '0x0000000000000000000000000000000000000000',
        agentName: `tu-${stamp}`,
        agentPublicKey: `tu-pk-${stamp}`,
        agentType: 'verification',
        description: 'toUsername smoke',
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return r.json();
  }, 'register');
  const agentId = reg.agent?.id || reg.agentId;
  const token = reg.token;
  console.log(`  ✓ agentId=${agentId}`);

  const wres = await withRetry(async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30_000);
    const r = await fetch(`${API}/api/agents/${agentId}/wallet`, {
      method:'POST',
      headers: {'content-type':'application/json', Authorization:`Bearer ${token}`},
      body:'{}',
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return r.json();
  }, 'wallet provision');
  const senderWallet = wres.address;
  console.log(`  ✓ senderWallet=${senderWallet}`);

  console.log(`▸ Drip USDC`);
  const drip = await withRetry(async () => fetch('https://api.circle.com/v1/faucet/drips', {
    method:'POST', headers:{'content-type':'application/json',Authorization:`Bearer ${process.env.CIRCLE_API_KEY}`},
    body: JSON.stringify({address:senderWallet, blockchain:'ARC-TESTNET', usdc:true})
  }), 'circle drip');
  console.log(`  ✓ drip status=${drip.status}`);
  console.log(`  ... waiting 12s`);
  await new Promise(r => setTimeout(r, 12_000));

  const senderBefore = await usdcBalance(senderWallet);
  const recipientBefore = await usdcBalance(EXPECTED_WALLET);
  console.log(`  sender:    ${senderBefore.toFixed(6)} USDC`);
  console.log(`  recipient: ${recipientBefore.toFixed(6)} USDC`);

  console.log(`▸ SEND via toUsername="${TARGET_USERNAME}", amount=${SEND_AMOUNT}`);
  const send = await withRetry(async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 60_000);
    const r = await fetch(`${API}/api/agents/${agentId}/send-usdc`, {
      method:'POST',
      headers:{'content-type':'application/json',Authorization:`Bearer ${token}`},
      body: JSON.stringify({ toUsername: TARGET_USERNAME, amount: SEND_AMOUNT }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return { status: r.status, body: await r.json() };
  }, 'send-usdc');

  console.log(`  HTTP ${send.status}`);
  console.log(`  ${JSON.stringify(send.body, null, 2)}`);
  if (send.status !== 200) process.exit(1);
  if (send.body.to?.toLowerCase() !== EXPECTED_WALLET) {
    console.log(`  ✗ resolved ${send.body.to} != expected ${EXPECTED_WALLET}`);
    process.exit(1);
  }
  console.log(`  ✓ resolved @${TARGET_USERNAME} → ${send.body.to}`);
  console.log(`  ✓ tx: ${send.body.explorer}`);

  console.log(`▸ Verify on-chain (15s)`);
  await new Promise(r => setTimeout(r, 15_000));
  const senderAfter = await usdcBalance(senderWallet);
  const recipientAfter = await usdcBalance(EXPECTED_WALLET);
  console.log(`  sender after:    ${senderAfter.toFixed(6)}  delta ${(senderAfter-senderBefore).toFixed(6)}`);
  console.log(`  recipient after: ${recipientAfter.toFixed(6)}  delta ${(recipientAfter-recipientBefore).toFixed(6)}`);
  const ok = Math.abs((senderBefore-senderAfter)-parseFloat(SEND_AMOUNT))<0.001 && Math.abs((recipientAfter-recipientBefore)-parseFloat(SEND_AMOUNT))<0.001;
  console.log(ok ? '  ✓ PASS' : '  ✗ FAIL');
  process.exit(ok?0:1);
})().catch(e => { console.error('uncaught:', e); process.exit(1); });
