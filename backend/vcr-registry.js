import { CHAIN, checkPolicy, isAddress, makePolicy, policyError, policyHash, callVerifier, validateSpend } from './vcr-policy.js';

export const registrySchema = `
CREATE TABLE IF NOT EXISTS vcr_policies (
  agent_id TEXT PRIMARY KEY, wallet TEXT UNIQUE NOT NULL, chain TEXT NOT NULL,
  policy_name TEXT UNIQUE NOT NULL, version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','revoked')),
  policy JSONB, policy_hash TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), revoked_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS vcr_policy_events (
  id BIGSERIAL PRIMARY KEY, agent_id TEXT NOT NULL, version INTEGER NOT NULL,
  action TEXT NOT NULL, policy_hash TEXT, actor TEXT NOT NULL, reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS vcr_service_nonces (nonce TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL);
`;

export const registryEnabled = () => {
  const mode = process.env.BARD_VCR_MODE || 'external';
  if (!['external','registry'].includes(mode)) throw policyError('Invalid BARD_VCR_MODE.', 'vcr_unavailable', 503);
  return mode === 'registry';
};
export const policyLockKey = wallet => 'vcr:wallet:' + wallet.toLowerCase();

export async function releaseOperationLock(db,key) {
  let failure;
  try { await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]); }
  catch (err) { failure=err; }
  // A failed unlock must destroy the connection, rather than returning a
  // potentially locked session to the pool.
  db.release(failure);
}

export function policySummary(row) {
  if (!row) return { status: 'pending' };
  return { status: row.status, policyId: row.policy_name, version: row.version,
    policyHash: row.policy_hash, chain: row.chain, constraints: row.policy?.constraints || null };
}

export async function pendingPolicy(db, agentId, wallet) {
  const address = wallet.toLowerCase();
  await db.query(`INSERT INTO vcr_policies(agent_id,wallet,chain,policy_name)
    VALUES($1,$2,$3,$4) ON CONFLICT (agent_id) DO NOTHING`, [agentId,address,CHAIN,`bard:${agentId}:${CHAIN}`]);
  const row = (await db.query('SELECT * FROM vcr_policies WHERE agent_id=$1', [agentId])).rows[0];
  if (row.wallet !== address || row.chain !== CHAIN) throw policyError('Managed wallet and VCR policy binding disagree.');
  return row;
}

export async function enrollAgentPolicy(pool, agentId, wallet, options) {
  if (!registryEnabled()) return { status: 'external', configured: Boolean(process.env.BARD_VCR_URL) };
  try {
    await callVerifier('/v1/policies/enroll', { agentId, wallet: wallet.toLowerCase() }, options);
  } catch (err) {
    if (err.status !== 503) throw err;
    // Wallets can receive funds during an outage; a later create-wallet call
    // retries enrollment. Missing/unconfirmed policies still cannot spend.
    const row = (await pool.query('SELECT * FROM vcr_policies WHERE agent_id=$1', [agentId])).rows[0];
    return { ...policySummary(row), verifierAvailable: false, error: err.message };
  }
  return policySummary((await pool.query('SELECT * FROM vcr_policies WHERE agent_id=$1', [agentId])).rows[0]);
}

export async function setPolicyState(pool, { agentId, wallet, action, actor, reason = '' }, template) {
  if (!isAddress(wallet) || typeof agentId !== 'string' || !['enroll', 'activate', 'revoke'].includes(action) ||
      typeof actor !== 'string' || !actor || typeof reason !== 'string' || reason.length > 500) throw policyError('Invalid VCR enrollment request.', 'invalid_policy', 400);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [policyLockKey(wallet)]);
    const agent = (await db.query('SELECT id,turnkey_address,status FROM agents WHERE id=$1', [agentId])).rows[0];
    if (!agent || agent.turnkey_address?.toLowerCase() !== wallet.toLowerCase()) throw policyError('VCR agent does not own this managed wallet.');
    if (action !== 'revoke' && agent.status !== 'active') throw policyError('Inactive agents cannot enroll a spending policy.');
    let row = await pendingPolicy(db, agentId, wallet);
    if (action === 'revoke') {
      row = (await db.query(`UPDATE vcr_policies SET status='revoked', revoked_at=now(), updated_at=now()
        WHERE agent_id=$1 RETURNING *`, [agentId])).rows[0];
    } else if (action === 'activate' || row.status === 'pending') {
      const revision = row.version + 1;
      const policy = makePolicy(agentId,wallet,revision,template);
      row = (await db.query(`UPDATE vcr_policies SET status='active',version=$2,policy=$3,policy_hash=$4,
        revoked_at=NULL,updated_at=now() WHERE agent_id=$1 RETURNING *`, [agentId,revision,policy,policyHash(policy)])).rows[0];
    } else {
      // Automatic enrollment must never undo a revocation or change a policy.
      await db.query('COMMIT');
      return policySummary(row);
    }
    await db.query(`INSERT INTO vcr_policy_events(agent_id,version,action,policy_hash,actor,reason)
      VALUES($1,$2,$3,$4,$5,$6)`, [agentId,row.version,action,row.policy_hash,actor,reason]);
    await db.query('COMMIT');
    return policySummary(row);
  } catch (err) { await db.query('ROLLBACK'); throw err; }
  finally { db.release(); }
}

export async function activePolicy(db, wallet, agentId) {
  const row = (await db.query(`SELECT p.*,a.status AS agent_status,a.owner_wallet
    FROM vcr_policies p JOIN agents a ON a.id=p.agent_id AND lower(a.turnkey_address)=p.wallet
    WHERE p.wallet=$1`, [wallet.toLowerCase()])).rows[0];
  if (!row || row.status !== 'active' || row.agent_status !== 'active' || row.chain !== CHAIN ||
      (agentId && row.agent_id !== agentId) || !row.policy || policyHash(row.policy) !== row.policy_hash ||
      row.policy.metadata?.revision !== row.version) throw policyError('An active, matching VCR policy is required.', 'vcr_policy_inactive');
  return row;
}

export async function checkRegistrySpend(db, request) {
  validateSpend(request);
  const row = await activePolicy(db,request.wallet,request.agentId);
  const prior = (await db.query('SELECT * FROM vcr_reservations WHERE operation=$1', [request.operation])).rows;
  if (prior.some(p => p.wallet !== request.wallet || p.recipient !== request.recipient ||
      p.policy_name !== row.policy_name || BigInt(p.amount) !== BigInt(request.amount) ||
      p.request_hash !== policyHash(request))) throw policyError('Spend retry changed its signed terms.', 'spend_conflict', 409);
  const accounting = (await db.query(`SELECT COALESCE(SUM(amount),0) AS total,
    to_char((now() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') AS day FROM vcr_reservations
    WHERE policy_name=$1 AND day=(now() AT TIME ZONE 'UTC')::date AND operation<>$2`, [row.policy_name,request.operation])).rows[0];
  const recipient = (await db.query(`SELECT 1 FROM vcr_policies p JOIN agents a
    ON a.id=p.agent_id AND lower(a.turnkey_address)=p.wallet WHERE p.wallet=$1
    AND p.status='active' AND a.status='active' AND p.chain=$2`, [request.recipient,CHAIN])).rows.length > 0;
  const result = checkPolicy(row.policy,request,{ dailySpent: accounting.total, activeRecipient: recipient, ownerWallet: row.owner_wallet });
  return { ...result, policyId: row.policy_name, policyVersion: row.version, policyHash: row.policy_hash,
    requestHash: policyHash(request), day: accounting.day, dailySpentAtCheck: String(accounting.total) };
}

// Revocation uses the same lock: either a send is admitted first, or revocation
// wins and signing is denied. Keep it through broadcast, not just reservation.
export async function withActiveWallet(pool, wallet, action) {
  const db = await pool.connect();
  const key = policyLockKey(wallet);
  try {
    await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
    await activePolicy(db,wallet);
    return await action(db);
  } finally {
    await releaseOperationLock(db,key);
  }
}
