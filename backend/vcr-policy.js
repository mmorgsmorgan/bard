// BARD's deliberately small VCR policy profile. Policies are stored in the
// registry, not published to ENS/IPFS. SHA-256 identifies their exact contents.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import stringify from 'fast-json-stable-stringify';

export const CHAIN = 'arc-testnet';
export const ZERO = '0x' + '00'.repeat(20);
export const isAddress = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) && value.toLowerCase() !== ZERO;
export const policyHash = value => createHash('sha256').update(stringify(value)).digest('hex');
export const policyError = (message, code = 'vcr_denied', status = 403) => Object.assign(new Error(message), { code, status });

export function usdcUnits(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value)) {
    throw policyError('Amount must be a decimal USDC string with at most 6 decimal places.', 'invalid_amount', 400);
  }
  const [whole, fraction = ''] = value.split('.');
  const units = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (units <= 0n) throw policyError('Amount must be positive.', 'invalid_amount', 400);
  return units;
}

export function readPolicyTemplate(env = process.env) {
  const max = usdcUnits(env.BARD_VCR_MAX_TX_USDC || '100');
  const daily = usdcUnits(env.BARD_VCR_DAILY_USDC || '250');
  if (max > 100_000_000n || daily < max) throw new Error('VCR limits require max <= 100 USDC and daily >= max.');
  const recipients = JSON.parse(env.BARD_VCR_ALLOWED_RECIPIENTS || '[]');
  const contracts = { escrow: env.AGENTIC_COMMERCE_ADDRESS, fee: env.BARD_JOB_HOOK_ADDRESS };
  if (!Array.isArray(recipients) || recipients.length > 100 || recipients.some(r => !isAddress(r)) ||
      Object.values(contracts).some(r => !isAddress(r))) throw new Error('VCR requires valid escrow, fee and approved recipient addresses.');
  return {
    template: 'bard-arc-v1',
    constraints: {
      maxTransaction: { amount: String(max), token: 'USDC', chain: CHAIN },
      dailyLimit: { amount: String(daily), token: 'USDC', chain: CHAIN },
      allowedTokens: ['USDC'], allowedChains: [CHAIN],
      allowedRecipients: [...new Set(recipients.map(r => r.toLowerCase()))].sort(),
      recipientRules: ['active-bard-wallet', 'proven-owner'],
      contracts: Object.fromEntries(Object.entries(contracts).map(([k,v]) => [k,v.toLowerCase()])),
    },
  };
}

export function makePolicy(agentId, wallet, revision, template) {
  return {
    version: '1.0', profile: 'bard-managed-v1',
    binding: { agentId, wallet: wallet.toLowerCase(), chain: CHAIN },
    metadata: { template: template.template, revision },
    constraints: template.constraints,
  };
}

export function validateSpend(request) {
  if (!request || !isAddress(request.wallet) || !isAddress(request.recipient) ||
      typeof request.agentId !== 'string' || !request.agentId || request.agentId.length > 200 ||
      typeof request.operation !== 'string' || !/^[a-zA-Z0-9:_-]{1,250}$/.test(request.operation) ||
      !['send', 'escrow', 'fee'].includes(request.purpose) || request.token !== 'USDC' || request.chain !== CHAIN ||
      typeof request.amount !== 'string' || !/^[1-9][0-9]{0,30}$/.test(request.amount) ||
      typeof request.contextHash !== 'string' || !/^[a-f0-9]{64}$/.test(request.contextHash)) {
    throw policyError('Invalid VCR spend coordinates.', 'invalid_spend', 400);
  }
}

// The dynamic recipient rules are resolved from trusted registry state by the
// service, never from flags supplied by the calling agent.
export function checkPolicy(policy, request, { dailySpent, activeRecipient = false, ownerWallet = null }) {
  validateSpend(request);
  const { constraints: c, binding: b, metadata: m } = policy || {};
  if (policy?.version !== '1.0' || policy.profile !== 'bard-managed-v1' || m?.template !== 'bard-arc-v1' ||
      !Number.isSafeInteger(m.revision) || m.revision < 1 ||
      b?.agentId !== request.agentId || b.wallet !== request.wallet || b.chain !== CHAIN) throw policyError('VCR policy identity does not match the sender.');
  for (const limit of [c?.maxTransaction, c?.dailyLimit]) {
    if (limit?.token !== 'USDC' || limit.chain !== CHAIN || typeof limit.amount !== 'string' ||
        !/^[1-9][0-9]{0,30}$/.test(limit.amount)) throw policyError('Invalid VCR policy limits.');
  }
  if (stringify(c.allowedTokens) !== '["USDC"]' || stringify(c.allowedChains) !== '["arc-testnet"]' ||
      stringify(c.recipientRules) !== '["active-bard-wallet","proven-owner"]' ||
      !Array.isArray(c.allowedRecipients) || c.allowedRecipients.some(r => !isAddress(r)) ||
      !isAddress(c.contracts?.escrow) || !isAddress(c.contracts?.fee) ||
      !/^[0-9]+$/.test(String(dailySpent)) || BigInt(c.maxTransaction.amount) > 100_000_000n ||
      BigInt(c.maxTransaction.amount) > BigInt(c.dailyLimit.amount)) throw policyError('Invalid VCR policy constraints.');
  if (BigInt(request.amount) > BigInt(c.maxTransaction.amount)) throw policyError('VCR per-transaction limit exceeded.');
  if (BigInt(request.amount) + BigInt(dailySpent) > BigInt(c.dailyLimit.amount)) throw policyError('Daily VCR allowance exhausted.');
  const recipient = request.recipient;
  const allowed = request.purpose === 'send'
    ? recipient !== request.wallet && (c.allowedRecipients.includes(recipient) || activeRecipient ||
        (isAddress(ownerWallet) && ownerWallet.toLowerCase() !== request.wallet && ownerWallet.toLowerCase() === recipient))
    : recipient === c.contracts[request.purpose];
  if (!allowed) throw policyError('Recipient is not authorized by this VCR policy.', 'vcr_recipient_denied');
  return { allowed: true, dailyLimit: c.dailyLimit.amount };
}

function secretKey(secret) {
  if (!/^[a-f0-9]{64}$/.test(secret || '')) throw policyError('VCR service authentication is not configured.', 'vcr_unavailable', 503);
  return Buffer.from(secret, 'hex');
}
export function signEnvelope(value, secret, scope) {
  const signature = createHmac('sha256', secretKey(secret)).update(scope + '\n' + stringify(value)).digest('hex');
  return { value, signature };
}
export function verifyEnvelope(envelope, secret, scope) {
  if (!envelope?.value || !/^[a-f0-9]{64}$/.test(envelope.signature || '')) throw policyError('Invalid VCR service authentication.');
  const expected = signEnvelope(envelope.value, secret, scope).signature;
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(envelope.signature, 'hex'))) throw policyError('Invalid VCR service authentication.');
  return envelope.value;
}

export async function callVerifier(path, payload, {
  verifierUrl = process.env.BARD_VCR_URL, secret = process.env.BARD_VCR_SERVICE_SECRET, fetchImpl = fetch,
} = {}) {
  if (!verifierUrl) throw policyError('VCR policy configuration is required.', 'vcr_unavailable', 503);
  const url = new URL(path, verifierUrl);
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw policyError('Invalid VCR URL.', 'vcr_unavailable', 503);
  // Plain HTTP is restricted to loopback and Railway's isolated service network.
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.hostname.endsWith('.railway.internal')) {
    throw policyError('VCR requires HTTPS outside the private service network.', 'vcr_unavailable', 503);
  }
  const request = { issuedAt: Date.now(), nonce: randomBytes(16).toString('hex'), payload };
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signEnvelope(request, secret, path)), signal: AbortSignal.timeout(10_000), redirect: 'error' });
  } catch { throw policyError('VCR verifier unavailable.', 'vcr_unavailable', 503); }
  if (!response.ok) throw policyError('VCR verifier unavailable or rejected authentication.', 'vcr_unavailable', 503);
  let decision;
  try { decision = verifyEnvelope(await response.json(), secret, path + ':response'); }
  catch { throw policyError('Invalid VCR verifier response.', 'vcr_unavailable', 503); }
  if (decision.requestHash !== policyHash(request) || !Number.isSafeInteger(decision.expiresAt) ||
      decision.expiresAt <= Date.now() || decision.expiresAt > Date.now() + 30_000) throw policyError('Stale or mismatched VCR decision.', 'vcr_unavailable', 503);
  if (decision.error) throw policyError(decision.error, decision.code || 'vcr_denied', decision.status || 403);
  return decision.result;
}
