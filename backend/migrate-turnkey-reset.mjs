#!/usr/bin/env node
/**
 * migrate-turnkey-reset.mjs
 *
 * After swapping TURNKEY_ORGANIZATION_ID, every `agents` row that still has
 * `turnkey_wallet_id` or `turnkey_address` set points at a wallet in the OLD
 * org. The new API keys can't sign for those addresses, so any sign attempt
 * will throw an auth error.
 *
 * This script nulls those two columns on affected rows so that the next call
 * to `getOrCreateAgentWallet` provisions a fresh wallet in the new org.
 *
 * SAFETY
 *   - Dry-run by default. Shows the rows it would touch + the row count.
 *   - Always writes a JSON snapshot of the affected rows to
 *     turnkey-reset-backup-<timestamp>.json BEFORE the UPDATE runs. That file
 *     contains agent_id / turnkey_wallet_id / turnkey_address so you can
 *     reconstruct the mapping later if you sweep the old wallets.
 *   - Requires --apply to actually mutate.
 *
 * USAGE
 *   cd backend && node migrate-turnkey-reset.mjs                 # dry-run
 *   cd backend && node migrate-turnkey-reset.mjs --apply         # do it
 *   DATABASE_URL=… node migrate-turnkey-reset.mjs --apply        # against prod
 *
 *   Optional --only-with-walletid limits the migration to rows whose
 *   turnkey_wallet_id is populated. (Local dev rows have a populated
 *   turnkey_address but no wallet id — they're seed stubs and may be safe
 *   to leave alone if you want to.)
 */

import 'dotenv/config';
import fs from 'fs';
import pg from 'pg';

const { Pool } = pg;

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const ONLY_WALLETID = args.has('--only-with-walletid');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const c = { reset:'\x1b[0m', red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m', cyan:'\x1b[36m', dim:'\x1b[2m', bold:'\x1b[1m' };

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('railway') || process.env.DATABASE_URL.includes('amazonaws')
    ? { rejectUnauthorized: false }
    : false,
});

const where = ONLY_WALLETID
  ? 'turnkey_wallet_id IS NOT NULL'
  : '(turnkey_wallet_id IS NOT NULL OR turnkey_address IS NOT NULL)';

const SELECT_SQL = `
  SELECT id, agent_name, owner_wallet, turnkey_wallet_id, turnkey_address, last_active_at
  FROM agents
  WHERE ${where}
  ORDER BY last_active_at DESC NULLS LAST, agent_name ASC
`;

const UPDATE_SQL = `
  UPDATE agents
  SET turnkey_wallet_id = NULL,
      turnkey_address   = NULL
  WHERE ${where}
`;

(async () => {
  const { rows } = await pool.query(SELECT_SQL);

  console.log(`${c.bold}Turnkey reset migration${c.reset}`);
  console.log(`  DB        : ${process.env.DATABASE_URL.split('@').pop()}`);
  console.log(`  Filter    : ${where}`);
  console.log(`  Mode      : ${APPLY ? c.red + 'APPLY (will mutate)' + c.reset : c.green + 'dry-run' + c.reset}`);
  console.log(`  Rows hit  : ${rows.length}`);

  if (rows.length === 0) {
    console.log(`\n${c.green}Nothing to do.${c.reset}`);
    await pool.end();
    return;
  }

  console.log(`\n${c.dim}First 20 rows:${c.reset}`);
  console.log('  agent_id'.padEnd(34), 'name'.padEnd(28), 'wallet_id'.padEnd(40), 'address');
  console.log('  ' + '-'.repeat(140));
  for (const r of rows.slice(0, 20)) {
    console.log(' ',
      (r.id || '').padEnd(32),
      (r.agent_name || '').slice(0, 26).padEnd(28),
      (r.turnkey_wallet_id || '(null)').slice(0, 38).padEnd(40),
      r.turnkey_address || '(null)',
    );
  }
  if (rows.length > 20) console.log(`  ${c.dim}… ${rows.length - 20} more${c.reset}`);

  // Always write the backup snapshot before any mutation, even on dry-run,
  // so you have a record of what was cleared even if you only run --apply later.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `turnkey-reset-backup-${ts}.json`;
  fs.writeFileSync(
    backupPath,
    JSON.stringify({
      generated_at: new Date().toISOString(),
      old_org_id: 'a4a6a419-5e67-4089-b7d8-392fdc45c9ce',
      database_url_host: process.env.DATABASE_URL.split('@').pop().split('/')[0],
      where_clause: where,
      rows,
    }, null, 2),
  );
  fs.chmodSync(backupPath, 0o600);
  console.log(`\n${c.cyan}Backup snapshot:${c.reset} ${backupPath} (chmod 600)`);

  if (!APPLY) {
    console.log(`\n${c.yellow}Dry-run — re-run with --apply to clear ${rows.length} rows.${c.reset}`);
    await pool.end();
    return;
  }

  const result = await pool.query(UPDATE_SQL);
  console.log(`\n${c.green}✓ Cleared ${result.rowCount} rows.${c.reset}`);
  console.log(`  Next call to getOrCreateAgentWallet() on each will provision a fresh wallet in the new org.`);
  await pool.end();
})().catch(e => {
  console.error('FAIL', e);
  process.exit(1);
});
