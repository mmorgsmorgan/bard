#!/usr/bin/env node
/**
 * Audit the BARD Turnkey org for orphan wallets — wallets that exist
 * on the Turnkey side but have no matching agent row pointing at them
 * via turnkey_wallet_id / turnkey_address.
 *
 * Reports them in a dry-run table; --execute would NOT delete anything
 * (Turnkey doesn't actually expose wallet deletion in the public API,
 * and even if it did, the no-destructive-state-loss rule applies).
 * Instead, --execute prints the SQL UPDATE that would reconcile each
 * orphan to its expected agent row by deterministic name.
 *
 * Usage:
 *   cd backend && node audit-turnkey-orphans.mjs                      # dry-run
 *   cd backend && node audit-turnkey-orphans.mjs --execute             # print SQL
 *   cd backend && node audit-turnkey-orphans.mjs --execute --apply     # actually run UPDATE
 */

import 'dotenv/config';
import { Turnkey } from '@turnkey/sdk-server';
import pg from 'pg';

const { Pool } = pg;

const ORG = process.env.TURNKEY_ORGANIZATION_ID;
const PRIV = process.env.TURNKEY_API_PRIVATE_KEY;
const PUB = process.env.TURNKEY_API_PUBLIC_KEY;
const DB = process.env.DATABASE_URL;

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const APPLY = args.includes('--apply');

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m',
};

for (const [name, val] of [['TURNKEY_ORGANIZATION_ID', ORG], ['TURNKEY_API_PRIVATE_KEY', PRIV], ['TURNKEY_API_PUBLIC_KEY', PUB], ['DATABASE_URL', DB]]) {
  if (!val) { console.error(`${c.red}✗ ${name} not set${c.reset}`); process.exit(1); }
}

const tk = new Turnkey({
  defaultOrganizationId: ORG,
  apiBaseUrl: 'https://api.turnkey.com',
  apiPrivateKey: PRIV,
  apiPublicKey: PUB,
});
const api = tk.apiClient();
const pool = new Pool({
  connectionString: DB,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function main() {
  console.log(`${c.bold}${c.cyan}\n════ BARD Turnkey orphan-wallet audit ════${c.reset}`);
  console.log(`${c.dim}Org: ${ORG}  |  DB: ${new URL(DB).hostname}${c.reset}\n`);

  console.log(`${c.cyan}▸ 1. Listing Turnkey wallets in org${c.reset}`);
  const { wallets } = await api.getWallets({ organizationId: ORG });
  console.log(`  ${c.green}✓${c.reset} ${wallets.length} wallets in org`);

  // Filter to agent wallets (deterministic name pattern)
  const agentWallets = wallets.filter(w => w.walletName?.startsWith('bard-agent-'));
  const platformWallets = wallets.filter(w => w.walletName?.startsWith('bard-platform-'));
  console.log(`  ${c.dim}— ${agentWallets.length} agent wallets (bard-agent-*)`);
  console.log(`  — ${platformWallets.length} platform wallets (bard-platform-*)`);
  console.log(`  — ${wallets.length - agentWallets.length - platformWallets.length} other${c.reset}`);

  console.log(`\n${c.cyan}▸ 2. Cross-referencing with DB${c.reset}`);
  const { rows: dbAgents } = await pool.query(
    `SELECT id, agent_name, turnkey_wallet_id, turnkey_address, owner_wallet
     FROM agents
     WHERE turnkey_wallet_id IS NOT NULL OR turnkey_address IS NOT NULL`
  );
  const dbByWalletId = new Map(dbAgents.filter(a => a.turnkey_wallet_id).map(a => [a.turnkey_wallet_id, a]));
  console.log(`  ${c.green}✓${c.reset} ${dbAgents.length} agents with Turnkey state in DB`);

  // For each Turnkey agent wallet, check:
  //   - Is its walletId referenced by any agent row?
  //   - If not, does its name 'bard-agent-<id>' point to an extant agent?
  const orphans = [];
  const adoptable = [];
  const fully_orphaned = [];

  for (const w of agentWallets) {
    if (dbByWalletId.has(w.walletId)) continue;  // good, owned by an agent
    const expectedAgentId = w.walletName.replace(/^bard-agent-/, '');
    const { rows: matchRows } = await pool.query(
      `SELECT id, agent_name, turnkey_wallet_id, turnkey_address
       FROM agents WHERE id = $1`,
      [expectedAgentId]
    );
    const matchAgent = matchRows[0];
    if (matchAgent) {
      // Agent exists but doesn't have this wallet bound — can adopt it
      adoptable.push({ wallet: w, agent: matchAgent });
    } else {
      // Agent doesn't exist either — fully orphaned
      fully_orphaned.push({ wallet: w });
    }
  }

  console.log(`\n${c.cyan}▸ 3. Findings${c.reset}`);
  console.log(`  ${c.green}OK${c.reset}        ${agentWallets.length - orphans.length - adoptable.length - fully_orphaned.length} agent wallets correctly bound`);
  console.log(`  ${c.yellow}ADOPTABLE${c.reset} ${adoptable.length} wallets exist in Turnkey but agent row has no link`);
  console.log(`  ${c.red}STRANDED${c.reset}  ${fully_orphaned.length} wallets exist in Turnkey but agent was deleted from DB`);

  if (adoptable.length > 0) {
    console.log(`\n${c.cyan}▸ 4. Adoptable — agent exists, just needs the wallet linked${c.reset}`);
    for (const { wallet, agent } of adoptable) {
      console.log(`  ${c.yellow}→${c.reset} ${agent.agent_name.padEnd(28)} ${c.dim}id=${agent.id}${c.reset}`);
      console.log(`     ${c.dim}walletId=${wallet.walletId}${c.reset}`);
      // Fetch address
      try {
        const { accounts } = await api.getWalletAccounts({ organizationId: ORG, walletId: wallet.walletId });
        const addr = accounts?.[0]?.address;
        console.log(`     ${c.dim}address=${addr || '(none)'}${c.reset}`);
        if (EXECUTE && addr) {
          const sql = `UPDATE agents SET turnkey_wallet_id = '${wallet.walletId}', turnkey_address = '${addr}'${
            agent.owner_wallet === '0x0000000000000000000000000000000000000000' ? `, owner_wallet = '${addr}'` : ''
          } WHERE id = '${agent.id}';`;
          console.log(`     ${c.cyan}SQL:${c.reset} ${sql}`);
          if (APPLY) {
            await pool.query(sql);
            console.log(`     ${c.green}✓ applied${c.reset}`);
          }
        }
      } catch (err) {
        console.log(`     ${c.red}getWalletAccounts failed:${c.reset} ${err.message}`);
      }
    }
  }

  if (fully_orphaned.length > 0) {
    console.log(`\n${c.cyan}▸ 5. Stranded — agent row gone, wallet remains in Turnkey${c.reset}`);
    console.log(`  ${c.dim}(Cleanup not possible — Turnkey doesn't expose wallet deletion. These are inert: no one can sign with them since the agent row that authorized provisioning is gone. They occupy the deterministic-name slot, so if you ever re-create an agent with the same id, the wallet will be auto-adopted.)${c.reset}`);
    for (const { wallet } of fully_orphaned) {
      console.log(`  ${c.dim}- ${wallet.walletName.padEnd(50)} walletId=${wallet.walletId}${c.reset}`);
    }
  }

  if (!EXECUTE && adoptable.length > 0) {
    console.log(`\n${c.green}Dry-run complete.${c.reset} Re-run with ${c.bold}--execute${c.reset} to print reconciliation SQL, or ${c.bold}--execute --apply${c.reset} to apply it.\n`);
  } else if (APPLY && adoptable.length > 0) {
    console.log(`\n${c.green}Adoption complete.${c.reset} ${adoptable.length} agent rows reconciled.\n`);
  } else {
    console.log();
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(`\n${c.red}Audit failed:${c.reset}`, err);
  await pool.end().catch(() => {});
  process.exit(1);
});
