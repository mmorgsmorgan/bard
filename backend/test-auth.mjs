/**
 * BARD Auth E2E Test — Tests the full challenge-sign-verify flow
 */
import { privateKeyToAccount } from 'viem/accounts';

const API = 'http://localhost:4000';
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Hardhat #0
const account = privateKeyToAccount(TEST_KEY);

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function get(path, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { headers });
  return { status: res.status, data: await res.json() };
}

console.log('═══════════════════════════════════════════');
console.log('  BARD Auth E2E Test');
console.log('═══════════════════════════════════════════\n');

// Step 0: Register an agent
console.log('── Step 0: Register Agent ──');
const { data: regData } = await post('/api/agents/register', {
  ownerWallet: account.address,
  agentName: 'AuthTestBot',
  agentPublicKey: account.address,
  agentType: 'research',
  description: 'Auth test agent',
});
const agentId = regData.agent.id;
console.log(`✓ Agent: ${regData.agent.agentName} (${agentId})`);
console.log(`  Owner: ${account.address}\n`);

// Step 1: Get challenge
console.log('── Step 1: Get Challenge ──');
const { data: challengeData } = await post('/api/auth/challenge', { agentId });
console.log(`✓ Challenge ID: ${challengeData.challengeId}`);
console.log(`  Scope: ${challengeData.scope}`);
console.log(`  Nonce: ${challengeData.nonce.slice(0, 20)}...`);
console.log(`  Message: "${challengeData.message.split('\n')[0]}..."\n`);

// Step 2: Sign the challenge
console.log('── Step 2: Sign Challenge ──');
const signature = await account.signMessage({ message: challengeData.message });
console.log(`✓ Signature: ${signature.slice(0, 30)}...\n`);

// Step 3: Verify & get token
console.log('── Step 3: Verify & Get Token ──');
const { data: verifyData, status: verifyStatus } = await post('/api/auth/verify', {
  challengeId: challengeData.challengeId,
  signature,
  wallet: account.address,
});
console.log(`✓ Status: ${verifyStatus}`);
console.log(`  Token: ${verifyData.token.slice(0, 40)}...`);
console.log(`  Agent: ${verifyData.agentName} (${verifyData.agentId})`);
console.log(`  Scope: ${verifyData.scope}`);
console.log(`  Expires: ${verifyData.expiresAt}\n`);

const TOKEN = verifyData.token;

// Step 4: Use token — /api/auth/me
console.log('── Step 4: Introspect Token (/api/auth/me) ──');
const { data: meData, status: meStatus } = await get('/api/auth/me', TOKEN);
console.log(`✓ Status: ${meStatus}`);
console.log(`  Agent: ${meData.agentName}`);
console.log(`  Wallet: ${meData.wallet}`);
console.log(`  Score: ${meData.reputation?.score} (${meData.reputation?.tier})\n`);

// Step 5: Protected endpoint without token
console.log('── Step 5: Protected Endpoint Without Token ──');
const { status: noAuthStatus, data: noAuthData } = await get('/api/auth/me');
console.log(`✓ Status: ${noAuthStatus} (expected 401)`);
console.log(`  Error: ${noAuthData.error}\n`);

// Step 6: Replay protection — reuse challenge
console.log('── Step 6: Challenge Replay Protection ──');
const { status: replayStatus, data: replayData } = await post('/api/auth/verify', {
  challengeId: challengeData.challengeId,
  signature,
  wallet: account.address,
});
console.log(`✓ Status: ${replayStatus} (expected 409)`);
console.log(`  Error: ${replayData.error}\n`);

// Step 7: List tokens
console.log('── Step 7: List Active Tokens ──');
const { data: tokensData } = await get('/api/auth/tokens', TOKEN);
console.log(`✓ Active tokens: ${tokensData.tokens.length}`);
console.log(`  Token ID: ${tokensData.tokens[0]?.id}\n`);

// Step 8: Revoke token
console.log('── Step 8: Revoke Token ──');
const revokeRes = await fetch(`${API}/api/auth/revoke`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
  body: JSON.stringify({}),
});
const revokeData = await revokeRes.json();
console.log(`✓ Revoked: ${revokeData.revoked}`);

// Confirm revoked token fails
const { status: revokedStatus } = await get('/api/auth/me', TOKEN);
console.log(`✓ Revoked token returns: ${revokedStatus} (expected 401)\n`);

// Summary
const allPassed =
  verifyStatus === 200 &&
  meStatus === 200 &&
  noAuthStatus === 401 &&
  replayStatus === 409 &&
  revokedStatus === 401;

console.log('═══════════════════════════════════════════');
console.log(`  ${allPassed ? '✅ All auth tests passed!' : '❌ Some tests failed'}`);
console.log('═══════════════════════════════════════════\n');
process.exit(allPassed ? 0 : 1);
