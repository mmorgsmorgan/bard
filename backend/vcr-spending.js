import { CHAIN, callVerifier, policyError, policyHash } from './vcr-policy.js';
import { registryEnabled, checkRegistrySpend, policyLockKey } from './vcr-registry.js';

export const spendingSchema = `CREATE TABLE IF NOT EXISTS vcr_reservations (
  operation TEXT NOT NULL, day DATE NOT NULL, wallet TEXT NOT NULL,
  policy_name TEXT NOT NULL, recipient TEXT NOT NULL, amount NUMERIC NOT NULL CHECK(amount > 0),
  PRIMARY KEY(operation, day));
  ALTER TABLE vcr_reservations ADD COLUMN IF NOT EXISTS policy_hash TEXT;
  ALTER TABLE vcr_reservations ADD COLUMN IF NOT EXISTS policy_version INTEGER;
  ALTER TABLE vcr_reservations ADD COLUMN IF NOT EXISTS request_hash TEXT;
  CREATE INDEX IF NOT EXISTS vcr_budget_day ON vcr_reservations(policy_name,day);`;

async function reserveRegistrySpend(pool, request, options) {
  const spend = { ...request, wallet: request.wallet?.toLowerCase(), recipient: request.recipient?.toLowerCase(),
    amount: String(request.amount), token: 'USDC', chain: CHAIN };
  const db = options.connection || await (options.lockPool || pool).connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [policyLockKey(spend.wallet)]);
    const local = await checkRegistrySpend(db,spend);
    const verified = await callVerifier('/v1/verify',spend,options);
    if (verified?.allowed !== true || verified.requestHash !== policyHash(spend) ||
        verified.policyId !== local.policyId || verified.policyHash !== local.policyHash ||
        verified.policyVersion !== local.policyVersion || verified.day !== local.day ||
        verified.dailyLimit !== local.dailyLimit) throw policyError('VCR decision does not match the reserved policy.', 'vcr_unavailable', 503);
    // The remote and local check must address the same UTC accounting window.
    const day = (await db.query("SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') AS day")).rows[0].day;
    if (day !== local.day) throw policyError('VCR day changed during verification. Retry the same operation.', 'vcr_unavailable', 503);
    await db.query(`INSERT INTO vcr_reservations(operation,day,wallet,policy_name,recipient,amount,policy_hash,policy_version,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [spend.operation,day,spend.wallet,local.policyId,spend.recipient,spend.amount,local.policyHash,local.policyVersion,local.requestHash]);
    await db.query('COMMIT');
    return { ...local, operation: spend.operation };
  } catch (err) { await db.query('ROLLBACK'); throw err; }
  finally { if (!options.connection) db.release(); }
}

// Failed or ambiguous broadcasts retain their reservation. An operator can
// reconcile them against Arc receipts before releasing budget.
export async function reserveSpend(pool, request, options = {}) {
  if (registryEnabled()) return reserveRegistrySpend(pool,request,options);
  const { fetchImpl = fetch, policyNames = JSON.parse(process.env.BARD_VCR_POLICIES || '{}'), verifierUrl = process.env.BARD_VCR_URL } = options;
  const { wallet, recipient, operation } = request;
  if (!/^0x[0-9a-f]{40}$/i.test(wallet || '') || !/^0x[0-9a-f]{40}$/i.test(recipient || '') || !operation) throw new Error('Invalid spend coordinates.');
  const amount = String(request.amount);
  if (!/^[1-9][0-9]*$/.test(amount)) throw new Error('Spend requires positive integer USDC units.');
  const policyName = policyNames[wallet.toLowerCase()]?.toLowerCase();
  if (!policyName || !verifierUrl) throw new Error('VCR policy configuration is required.');
  const spendRequest = { recipient: recipient.toLowerCase(), amount, token: 'USDC', chain: 'arc-testnet' };
  const response = await fetchImpl(new URL('/api/verify', verifierUrl), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ensName: policyName, spendRequest }), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('VCR verifier unavailable.');
  const { result } = await response.json();
  if (result?.allowed !== true || !result.policyCid) throw new Error(result?.reason || 'VCR denied spend.');
  const limit = result.policy?.constraints?.dailyLimit;
  if (limit?.token !== 'USDC' || limit.chain !== 'arc-testnet' ||
      !/^[0-9]+$/.test(String(limit.amount)) || !/^[0-9]+$/.test(String(result.dailySpentAtCheck))) throw new Error('Invalid VCR accounting response.');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [policyName]);
    const prior = (await db.query('SELECT * FROM vcr_reservations WHERE operation = $1', [operation])).rows;
    if (prior.some(p => p.wallet !== wallet.toLowerCase() || p.recipient !== spendRequest.recipient ||
        p.policy_name !== policyName || BigInt(p.amount) !== BigInt(amount))) throw new Error('Spend retry changed its signed terms.');
    const { rows } = await db.query(`SELECT COALESCE(SUM(amount),0) AS total FROM vcr_reservations
      WHERE policy_name = $1 AND day = (now() AT TIME ZONE 'UTC')::date AND operation <> $2`, [policyName, operation]);
    if (BigInt(rows[0].total) + BigInt(amount) + BigInt(result.dailySpentAtCheck) > BigInt(limit.amount)) throw new Error('Daily VCR allowance exhausted.');
    await db.query(`INSERT INTO vcr_reservations(operation,day,wallet,policy_name,recipient,amount)
      VALUES($1,(now() AT TIME ZONE 'UTC')::date,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [operation,wallet.toLowerCase(),policyName,spendRequest.recipient,amount]);
    await db.query('COMMIT');
    return { policyCid: result.policyCid, operation };
  } catch (err) { await db.query('ROLLBACK'); throw err; }
  finally { db.release(); }
}
