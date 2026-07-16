import 'dotenv/config';

const API = 'https://bard-production-e88b.up.railway.app';
const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY;
const TARGET_USERNAME = 'chiefmmorgs';
const EXPECTED_WALLET = '0xb804d506d5446b1a3befefc903d84f754973c2d2'; // lowercase
const SEND_AMOUNT = '0.05';
const RPC = 'https://rpc.testnet.arc.network';
const USDC = '0x3600000000000000000000000000000000000000';

const log = (...a) => console.log(...a);

async function api(path, opts = {}, token = null) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  const r = await fetch(`${API}${path}`, { ...opts, headers, signal: ctrl.signal });
  clearTimeout(t);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

async function usdcBalance(addr) {
  const data = '0x70a08231' + addr.toLowerCase().replace('0x','').padStart(64,'0');
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'content-type':'application/json' },
    body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'eth_call', params:[{ to: USDC, data }, 'latest'] })
  });
  const j = await r.json();
  if (!j.result || j.result === '0x') return 0;
  return Number(BigInt(j.result)) / 1_000_000;
}

(async () => {
  // ── 1. Register throwaway agent
  log('▸ 1. Register throwaway agent');
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  const reg = await api('/api/agents/register', {
    method: 'POST',
    body: JSON.stringify({
      ownerWallet: '0x0000000000000000000000000000000000000000',
      agentName: `test-toUsername-${stamp}`,
      agentPublicKey: `turnkey-pending-${stamp}`,
      agentType: 'verification',
      description: 'one-shot toUsername smoke test',
    }),
  });
  if (reg.status !== 200) { log('  ✗ register failed:', reg.status, reg.body); process.exit(1); }
  const agentId = reg.body.agent?.id || reg.body.agentId;
  const token = reg.body.token;
  log(`  ✓ agentId=${agentId}`);

  // ── 2. Provision Turnkey wallet
  log('▸ 2. Provision Turnkey wallet');
  const wres = await api(`/api/agents/${agentId}/wallet`, { method: 'POST', body: '{}' }, token);
  if (wres.status !== 200) { log('  ✗ wallet provision failed:', wres.status, wres.body); process.exit(1); }
  const senderWallet = wres.body.address;
  log(`  ✓ sender wallet=${senderWallet}`);

  // ── 3. Drip Circle faucet
  log('▸ 3. Circle faucet drip 20 USDC');
  const drip = await fetch('https://api.circle.com/v1/faucet/drips', {
    method: 'POST',
    headers: { Authorization: `Bearer ${CIRCLE_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ address: senderWallet, blockchain: 'ARC-TESTNET', usdc: true }),
  });
  log(`  ✓ drip status=${drip.status}`);
  log('  ... waiting 10s for chain settle');
  await new Promise(r => setTimeout(r, 10_000));

  // ── 4. Balances pre-send
  const senderBefore = await usdcBalance(senderWallet);
  const recipientBefore = await usdcBalance(EXPECTED_WALLET);
  log(`  sender balance pre:    ${senderBefore.toFixed(6)} USDC`);
  log(`  recipient balance pre: ${recipientBefore.toFixed(6)} USDC`);
  if (senderBefore < parseFloat(SEND_AMOUNT) + 0.001) { log('  ✗ sender unfunded, aborting'); process.exit(1); }

  // ── 5. Send by toUsername
  log(`▸ 5. POST send-usdc { toUsername: "${TARGET_USERNAME}", amount: "${SEND_AMOUNT}" }`);
  const send = await api(`/api/agents/${agentId}/send-usdc`, {
    method: 'POST',
    body: JSON.stringify({ toUsername: TARGET_USERNAME, amount: SEND_AMOUNT }),
  }, token);
  log(`  status: ${send.status}`);
  log(`  body:   ${JSON.stringify(send.body, null, 2)}`);
  if (send.status !== 200) process.exit(1);

  if (send.body.to?.toLowerCase() !== EXPECTED_WALLET) {
    log(`  ✗ resolved wallet ${send.body.to} != expected ${EXPECTED_WALLET}`);
    process.exit(1);
  }
  log(`  ✓ resolution correct: @${TARGET_USERNAME} → ${send.body.to}`);
  log(`  ✓ txHash: ${send.body.txHash}`);
  log(`  ✓ explorer: ${send.body.explorer}`);

  // ── 6. Verify on-chain
  log('▸ 6. Verify on-chain (waiting 8s)');
  await new Promise(r => setTimeout(r, 8_000));
  const senderAfter = await usdcBalance(senderWallet);
  const recipientAfter = await usdcBalance(EXPECTED_WALLET);
  log(`  sender balance post:    ${senderAfter.toFixed(6)} USDC  (delta ${(senderAfter-senderBefore).toFixed(6)})`);
  log(`  recipient balance post: ${recipientAfter.toFixed(6)} USDC  (delta ${(recipientAfter-recipientBefore).toFixed(6)})`);
  const sentOk = Math.abs((senderBefore - senderAfter) - parseFloat(SEND_AMOUNT)) < 0.001;
  const recvOk = Math.abs((recipientAfter - recipientBefore) - parseFloat(SEND_AMOUNT)) < 0.001;
  log(sentOk ? '  ✓ sender balance dropped by exactly SEND_AMOUNT' : '  ✗ sender balance delta off');
  log(recvOk ? '  ✓ recipient balance jumped by exactly SEND_AMOUNT' : '  ✗ recipient balance delta off');

  process.exit(sentOk && recvOk ? 0 : 1);
})().catch(e => { console.error('uncaught:', e); process.exit(1); });
