import assert from 'node:assert/strict';
import pg from 'pg';
import { reserveSpend, spendingSchema } from './vcr-spending.js';
const pool = new pg.Pool({ connectionString: process.env.BARD_TEST_DATABASE_URL });
if (!process.env.BARD_TEST_DATABASE_URL) throw new Error('Supply an isolated BARD_TEST_DATABASE_URL.');
try {
  await pool.query(spendingSchema);
  const wallet = '0x' + '11'.repeat(20);
  const recipient = '0x' + '22'.repeat(20);
  const prefix = 'test-' + crypto.randomUUID();
  const request = { wallet, recipient, amount: '60', operation: prefix + '1' };
  const options = { policyNames: { [wallet]: prefix + '.eth' }, verifierUrl: 'https://example.invalid',
    fetchImpl: async () => Response.json({ result: { allowed: true, policyCid: 'cid', dailySpentAtCheck: '0', policy: { constraints: { dailyLimit: { token: 'USDC', chain: 'arc-testnet', amount: '100' } } } } }) };
  const outcomes = await Promise.allSettled([reserveSpend(pool, request, options), reserveSpend(pool, { ...request, operation: prefix + '2' }, options)]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  const operation = outcomes[0].status === 'fulfilled' ? request.operation : prefix + '2';
  await reserveSpend(pool, { ...request, operation }, options);
  await assert.rejects(reserveSpend(pool, { ...request, operation, amount: '59' }, options), /changed/);
  await assert.rejects(reserveSpend(pool, request, { ...options, fetchImpl: async () => Response.json({ result: { allowed: false } }) }));
  assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM vcr_reservations WHERE policy_name = $1', [prefix + '.eth'])).rows[0].count), 1);
  console.log('VCR concurrency, retry accounting, changed terms and denial passed.');
} finally { await pool.end(); }
