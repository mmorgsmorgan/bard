export const spendingSchema = `CREATE TABLE IF NOT EXISTS vcr_reservations (
  operation TEXT NOT NULL, day DATE NOT NULL, wallet TEXT NOT NULL,
  policy_name TEXT NOT NULL, recipient TEXT NOT NULL, amount NUMERIC NOT NULL CHECK(amount > 0),
  PRIMARY KEY(operation, day))`;

// Failed or ambiguous broadcasts retain their reservation. An operator can
// reconcile them against Arc receipts before releasing budget.
export async function reserveSpend(pool, request, { fetchImpl = fetch, policyNames = JSON.parse(process.env.BARD_VCR_POLICIES || '{}'), verifierUrl = process.env.BARD_VCR_URL } = {}) {
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
