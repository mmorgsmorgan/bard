import { randomUUID } from 'node:crypto';
import { activePolicy, registryEnabled } from './vcr-registry.js';
import { isAddress, policyError } from './vcr-policy.js';

export const platformBudgetSchema = `CREATE TABLE IF NOT EXISTS platform_spend_reservations (
  operation TEXT PRIMARY KEY, kind TEXT NOT NULL, wallet TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK(amount>0), day DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE INDEX IF NOT EXISTS platform_spend_day ON platform_spend_reservations(kind,day);`;

// Native amounts use 18 decimal units. Reservations are conservative: failed
// or uncertain sends retain them for operator reconciliation.
export async function reservePlatformSpend(pool, { kind, wallet, amount, operation = randomUUID() }, env = process.env) {
  if (!['gas','operator'].includes(kind) || !isAddress(wallet) || BigInt(amount)<=0n) throw policyError('Invalid platform spend.');
  const prefix = kind === 'gas' ? 'BARD_GAS' : 'BARD_PLATFORM';
  const max = env[prefix+'_MAX_WEI'] || '0';
  const daily = env[prefix+'_DAILY_WEI'] || '0';
  const perWallet = env[prefix+'_WALLET_DAILY_WEI'] || '0';
  if ([max,daily,perWallet].some(v => !/^[0-9]+$/.test(v))) throw policyError('Invalid platform spending limits.');
  if (BigInt(amount)>BigInt(max)) throw policyError('Platform spending or gas sponsorship is disabled or its transaction cap is exceeded.', 'platform_budget_denied');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['platform-budget:'+kind]);
    if (kind === 'gas' && registryEnabled()) await activePolicy(db,wallet);
    const prior = (await db.query('SELECT * FROM platform_spend_reservations WHERE operation=$1',[operation])).rows[0];
    if (prior && (prior.kind !== kind || prior.wallet !== wallet.toLowerCase() || BigInt(prior.amount)!==BigInt(amount))) throw policyError('Platform spend retry changed its terms.');
    const totals = (await db.query(`SELECT COALESCE(SUM(amount),0) AS total,
      COALESCE(SUM(amount) FILTER (WHERE wallet=$2),0) AS wallet_total FROM platform_spend_reservations
      WHERE kind=$1 AND day=(now() AT TIME ZONE 'UTC')::date AND operation<>$3`,[kind,wallet.toLowerCase(),operation])).rows[0];
    if (BigInt(totals.total)+BigInt(amount)>BigInt(daily) || BigInt(totals.wallet_total)+BigInt(amount)>BigInt(perWallet)) throw policyError('Platform daily spending or gas sponsorship allowance exhausted.', 'platform_budget_denied');
    await db.query(`INSERT INTO platform_spend_reservations(operation,kind,wallet,amount,day)
      VALUES($1,$2,$3,$4,(now() AT TIME ZONE 'UTC')::date)
      ON CONFLICT(operation) DO UPDATE SET day=EXCLUDED.day`,[operation,kind,wallet.toLowerCase(),String(amount)]);
    await db.query('COMMIT');
    return { operation };
  } catch (err) { await db.query('ROLLBACK'); throw err; }
  finally { db.release(); }
}
