// ══════════════════════════════════════════════════════
// ── BARD Postgres Data Layer (node-postgres) ──
// ══════════════════════════════════════════════════════
//
// Replaces the previous better-sqlite3 layer in server.js. Public API:
//   - pool: shared pg.Pool instance
//   - query(sql, params): convenience wrapper that returns pool.query(...)
//   - initSchema(): runs all CREATE TABLE / ALTER TABLE bootstrap SQL (idempotent)
//   - stmts: object of async functions, one per prepared statement
//
// Schema dialect: translated from SQLite — TEXT/INTEGER unchanged, REAL → DOUBLE
// PRECISION, AUTOINCREMENT → BIGSERIAL, datetime('now') → NOW()::text, INSERT OR
// IGNORE → ON CONFLICT DO NOTHING, INSERT OR REPLACE → ON CONFLICT DO UPDATE.
// COLLATE NOCASE has been dropped — callers are expected to .toLowerCase() wallet
// values before insert/lookup (they already do).

import pg from 'pg';

const { Pool } = pg;

// ── Pool ─────────────────────────────────────────────
// One pool, shared across the process. Railway-managed Postgres requires SSL.
if (!process.env.DATABASE_URL) {
  console.error('  ✗ DATABASE_URL is not set. On Railway, attach the Postgres plugin to this service to inject it automatically. Locally, set it in backend/.env.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  // Tuned for Railway hobby tier. Backend is one Node process serving mixed
  // HTTP traffic and MCP loopback calls. pg auto-reconnects on next acquire
  // when an idle client dies.
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  // Idle client died — pg auto-reconnects on next acquire(). Log only.
  console.error('  ! Postgres pool idle client error:', err.message);
});

// Verify connectivity at boot. Server.js calls this before app.listen().
export async function ping() {
  const r = await pool.query('SELECT 1 as ok');
  return r.rows[0].ok === 1;
}

// ── Convenience wrapper ─────────────────────────────
export async function query(sql, params = []) {
  return pool.query(sql, params);
}

// Helpers for the common .get / .all / .run shapes
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const many = async (sql, params) => (await pool.query(sql, params)).rows;
const run = async (sql, params) => {
  const r = await pool.query(sql, params);
  return { changes: r.rowCount, rowCount: r.rowCount };
};

// ── Schema bootstrap ────────────────────────────────
export async function initSchema() {
  // CREATE TABLEs are idempotent (IF NOT EXISTS) and individual statements are
  // sent in dependency order. Postgres handles ALTER TABLE ... ADD COLUMN IF NOT
  // EXISTS natively (9.6+), so no try/catch needed for column adds.
  const statements = [
    // ── profiles ──
    `CREATE TABLE IF NOT EXISTS profiles (
      wallet TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT DEFAULT '',
      bio TEXT DEFAULT '',
      profile_type TEXT DEFAULT 'human',
      ecosystems TEXT DEFAULT '[]',
      farcaster TEXT DEFAULT '',
      github TEXT DEFAULT '',
      x TEXT DEFAULT '',
      discord TEXT DEFAULT '',
      linkedin TEXT DEFAULT '',
      pfp TEXT DEFAULT '',
      created_at TEXT DEFAULT (NOW()::text)
    )`,

    // ── human accounts ──
    // Privy proves identity. Email accounts use a BARD-managed wallet; wallet
    // logins keep the verified external wallet as their primary signer.
    `CREATE TABLE IF NOT EXISTS human_accounts (
      id TEXT PRIMARY KEY,
      privy_did TEXT UNIQUE NOT NULL,
      email TEXT DEFAULT NULL,
      email_verified_at TEXT DEFAULT NULL,
      login_wallet TEXT DEFAULT NULL,
      wallet_type TEXT DEFAULT NULL,
      wallet_id TEXT UNIQUE DEFAULT NULL,
      wallet_address TEXT UNIQUE DEFAULT NULL,
      legacy_wallet_id TEXT DEFAULT NULL,
      legacy_wallet_address TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (NOW()::text),
      updated_at TEXT DEFAULT (NOW()::text)
    )`,
    `ALTER TABLE human_accounts ADD COLUMN IF NOT EXISTS email_verified_at TEXT DEFAULT NULL`,
    `ALTER TABLE human_accounts ADD COLUMN IF NOT EXISTS wallet_type TEXT DEFAULT NULL`,
    `ALTER TABLE human_accounts ADD COLUMN IF NOT EXISTS legacy_wallet_id TEXT DEFAULT NULL`,
    `ALTER TABLE human_accounts ADD COLUMN IF NOT EXISTS legacy_wallet_address TEXT DEFAULT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_human_accounts_wallet
       ON human_accounts (LOWER(wallet_address))
       WHERE wallet_address IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_human_accounts_legacy_wallet
       ON human_accounts (LOWER(legacy_wallet_address))
       WHERE legacy_wallet_address IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS human_otp_codes (
      id BIGSERIAL PRIMARY KEY,
      human_id TEXT NOT NULL REFERENCES human_accounts(id),
      code_hash TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'key_export',
      attempts INTEGER DEFAULT 0,
      consumed INTEGER DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_human_otp_active
       ON human_otp_codes(human_id, purpose, consumed, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS human_security_events (
      id TEXT PRIMARY KEY,
      human_id TEXT NOT NULL REFERENCES human_accounts(id),
      wallet_address TEXT NOT NULL,
      event_type TEXT NOT NULL,
      ip_address TEXT DEFAULT '',
      user_agent TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_human_security_events
       ON human_security_events(human_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS human_tx_confirmations (
      tx_hash TEXT NOT NULL,
      action TEXT NOT NULL,
      human_id TEXT NOT NULL REFERENCES human_accounts(id),
      resource_id TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (tx_hash, action)
    )`,
    `ALTER TABLE human_tx_confirmations
       ADD COLUMN IF NOT EXISTS resource_id TEXT DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS idx_human_tx_confirmations_human
       ON human_tx_confirmations(human_id, created_at DESC)`,

    // ── proofs ──
    // Note: file_url and submitted_by are included in initial schema so we no
    // longer need the runtime ALTER TABLE migrations that existed in the old code.
    `CREATE TABLE IF NOT EXISTS proofs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      ecosystem TEXT DEFAULT '',
      contribution_type TEXT DEFAULT '',
      description TEXT DEFAULT '',
      external_links TEXT DEFAULT '[]',
      file_url TEXT DEFAULT '',
      contributor TEXT NOT NULL,
      submitted_by TEXT DEFAULT '',
      status TEXT DEFAULT 'unvalidated',
      timestamp TEXT DEFAULT (NOW()::text)
    )`,

    // ── portfolio ──
    `CREATE TABLE IF NOT EXISTS portfolio (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      title TEXT DEFAULT '',
      description TEXT DEFAULT '',
      category TEXT DEFAULT 'other',
      image_url TEXT DEFAULT '',
      external_link TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (NOW()::text),
      sort_order INTEGER DEFAULT 0
    )`,
    `ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS github_repo TEXT DEFAULT ''`,

    // ── notifications ──
    `CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      type TEXT DEFAULT 'system',
      title TEXT DEFAULT '',
      message TEXT DEFAULT '',
      sender TEXT DEFAULT '',
      amount TEXT DEFAULT '',
      read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (NOW()::text)
    )`,

    // ── payments ──
    // Only place AUTOINCREMENT was used. Postgres equivalent: BIGSERIAL.
    `CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,
      payer TEXT NOT NULL,
      amount TEXT NOT NULL,
      network TEXT DEFAULT '',
      endpoint TEXT DEFAULT '',
      transaction_id TEXT DEFAULT '',
      created_at TEXT DEFAULT (NOW()::text)
    )`,

    // ── agents (core reputation table) ──
    `CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      owner_wallet TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      agent_public_key TEXT NOT NULL,
      agent_type TEXT DEFAULT 'general',
      description TEXT DEFAULT '',
      reputation_score INTEGER DEFAULT 0,
      total_contributions INTEGER DEFAULT 0,
      total_endorsements INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      erc8004_metadata_uri TEXT DEFAULT NULL,
      erc8004_tx_hash TEXT DEFAULT NULL,
      erc8004_minted_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (NOW()::text)
    )`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS specializations TEXT DEFAULT '[]'`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS hourly_rate_usdc DOUBLE PRECISION DEFAULT 0`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS availability TEXT DEFAULT 'available'`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_active_at INTEGER`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS total_earned_usdc DOUBLE PRECISION DEFAULT 0`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS success_rate DOUBLE PRECISION DEFAULT 0`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS turnkey_wallet_id TEXT DEFAULT NULL`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS turnkey_address TEXT DEFAULT NULL`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS swarm_config TEXT DEFAULT NULL`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_platform_owned INTEGER DEFAULT 0`,

    // ── contributions ──
    `CREATE TABLE IF NOT EXISTS contributions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT DEFAULT '',
      proof_hash TEXT NOT NULL,
      proof_data TEXT DEFAULT '',
      signature TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      endorsement_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (NOW()::text),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    )`,

    // ── endorsements ──
    `CREATE TABLE IF NOT EXISTS endorsements (
      id TEXT PRIMARY KEY,
      contribution_id TEXT NOT NULL,
      endorser_wallet TEXT NOT NULL,
      endorser_type TEXT DEFAULT 'human',
      comment TEXT DEFAULT '',
      signature TEXT DEFAULT '',
      created_at TEXT DEFAULT (NOW()::text),
      FOREIGN KEY (contribution_id) REFERENCES contributions(id),
      UNIQUE(contribution_id, endorser_wallet)
    )`,

    // ── agent_state ──
    `CREATE TABLE IF NOT EXISTS agent_state (
      agent_id TEXT PRIMARY KEY,
      context TEXT DEFAULT '{}',
      last_activity TEXT DEFAULT (NOW()::text),
      updated_at TEXT DEFAULT (NOW()::text),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    )`,

    // ── commitments (Phase 2) ──
    `CREATE TABLE IF NOT EXISTS commitments (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      commitment_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      revealed INTEGER DEFAULT 0,
      reasoning TEXT DEFAULT '',
      created_at TEXT DEFAULT (NOW()::text),
      revealed_at TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    )`,

    // ── recorded_contributions (Phase 2: on-chain mirror) ──
    `CREATE TABLE IF NOT EXISTS recorded_contributions (
      id TEXT PRIMARY KEY,
      contribution_id TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      tx_hash TEXT DEFAULT '',
      recorded_at TEXT DEFAULT (NOW()::text),
      FOREIGN KEY (contribution_id) REFERENCES contributions(id)
    )`,

    // ── bounties (Phase 3) ──
    `CREATE TABLE IF NOT EXISTS bounties (
      id TEXT PRIMARY KEY,
      creator_wallet TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      bounty_type TEXT NOT NULL,
      amount_usdc TEXT NOT NULL,
      deadline TEXT NOT NULL,
      min_reputation INTEGER DEFAULT 0,
      assigned_agent_id TEXT,
      contribution_id TEXT,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT (NOW()::text),
      updated_at TEXT DEFAULT (NOW()::text)
    )`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS escrow_status TEXT DEFAULT 'none'`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS escrow_budget_usdc DOUBLE PRECISION DEFAULT 0`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS escrow_tx_hash TEXT`,
    // refund_tx_hash is recorded before the bounty leaves `refunding`. This
    // prevents a successfully broadcast refund from being sent twice if a
    // later database write or HTTP response fails.
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS refund_tx_hash TEXT`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS provider_agent_id TEXT`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS provider_wallet TEXT`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS deliverable_hash TEXT`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS deliverable_content TEXT`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS acceptance_criteria TEXT DEFAULT '[]'`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS deliverable_summary TEXT DEFAULT ''`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS deliverable_evidence TEXT DEFAULT '[]'`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS deliverable_instructions TEXT DEFAULT ''`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS deliverable_artifacts TEXT DEFAULT '[]'`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS verification_report TEXT DEFAULT '{}'`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS verification_requested_at TEXT`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS verification_request_note TEXT DEFAULT ''`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS client_decision TEXT`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS client_decision_at TEXT`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS verifier_wallet TEXT`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS verifier_decision TEXT`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS verifier_reason TEXT`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS release_tx_hash TEXT`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS revision_count INTEGER DEFAULT 0`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS expires_at TEXT`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS claimed_at TEXT`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS submitted_at TEXT`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS released_at TEXT`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS swarm_execution_id TEXT`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS selection_mode TEXT DEFAULT 'first_come'`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS selected_proposal_id TEXT DEFAULT NULL`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS proposal_deadline TEXT DEFAULT NULL`,

    // ── On-chain escrow (ERC-8183 + BardJobHookV2) migration. escrow_mode is
    // 'custodial' (platform holds USDC, transferUSDCFromPlatform on release) or
    // 'onchain' (funds live in the escrow contract; server drives the lifecycle
    // via escrow-service.js, signing each leg with the owner's Turnkey wallet).
    // onchain_job_id holds the ERC-8183 jobId (stored as text; it's a uint256). ──
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS escrow_mode TEXT DEFAULT 'custodial'`,
    `ALTER TABLE bounties ADD COLUMN IF NOT EXISTS onchain_job_id TEXT`,
    `CREATE TABLE IF NOT EXISTS bounty_funding_transactions (
      tx_hash TEXT PRIMARY KEY,
      bounty_id TEXT NOT NULL UNIQUE REFERENCES bounties(id) ON DELETE CASCADE,
      funder_wallet TEXT NOT NULL,
      amount_usdc DOUBLE PRECISION NOT NULL,
      created_at TEXT DEFAULT (NOW()::text)
    )`,
    `CREATE TABLE IF NOT EXISTS bounty_refund_transactions (
      tx_hash TEXT PRIMARY KEY,
      bounty_id TEXT NOT NULL UNIQUE REFERENCES bounties(id) ON DELETE CASCADE,
      recipient_wallet TEXT NOT NULL,
      amount_usdc DOUBLE PRECISION NOT NULL,
      created_at TEXT DEFAULT (NOW()::text)
    )`,

    // ── Real-signature auditability: the address recovered from (or that
    // produced) the stored signature over the canonical message. ──
    `ALTER TABLE contributions ADD COLUMN IF NOT EXISTS signer_address TEXT DEFAULT NULL`,
    // NOTE: agent_verifications' signer_address ALTER lives AFTER its CREATE TABLE
    // (below) — on a fresh DB the table doesn't exist yet at this point.

    // ── bounty_proposals (hybrid mode) ──
    `CREATE TABLE IF NOT EXISTS bounty_proposals (
      id TEXT PRIMARY KEY,
      bounty_id TEXT NOT NULL,
      proposer_agent_id TEXT NOT NULL,
      proposer_wallet TEXT NOT NULL,
      plan TEXT NOT NULL,
      proposed_price_usdc DOUBLE PRECISION NOT NULL,
      estimated_hours INTEGER DEFAULT 0,
      portfolio_refs TEXT DEFAULT '[]',
      status TEXT DEFAULT 'pending',
      withdrawn_at TEXT,
      accepted_at TEXT,
      rejected_at TEXT,
      rejection_reason TEXT DEFAULT '',
      created_at TEXT DEFAULT (NOW()::text),
      updated_at TEXT DEFAULT (NOW()::text),
      FOREIGN KEY (bounty_id) REFERENCES bounties(id),
      FOREIGN KEY (proposer_agent_id) REFERENCES agents(id),
      UNIQUE(bounty_id, proposer_agent_id)
    )`,

    // ── bounty_messages (creator <-> proposer thread) ──
    `CREATE TABLE IF NOT EXISTS bounty_messages (
      id TEXT PRIMARY KEY,
      bounty_id TEXT NOT NULL,
      proposal_id TEXT,
      from_wallet TEXT NOT NULL,
      from_agent_id TEXT,
      to_wallet TEXT NOT NULL,
      to_agent_id TEXT,
      message TEXT NOT NULL,
      read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (NOW()::text),
      FOREIGN KEY (bounty_id) REFERENCES bounties(id)
    )`,

    // ── swarm_executions ──
    `CREATE TABLE IF NOT EXISTS swarm_executions (
      id TEXT PRIMARY KEY,
      bounty_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      swarm_type TEXT NOT NULL,
      task TEXT NOT NULL,
      swarms_api_response TEXT,
      status TEXT DEFAULT 'pending',
      swarms_cost_usd DOUBLE PRECISION DEFAULT 0,
      platform_markup_usd DOUBLE PRECISION DEFAULT 0,
      total_charged_usd DOUBLE PRECISION DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT (NOW()::text),
      FOREIGN KEY (bounty_id) REFERENCES bounties(id),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    )`,

    // ── auth ──
    `CREATE TABLE IF NOT EXISTS auth_challenges (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      nonce TEXT NOT NULL,
      message TEXT NOT NULL,
      scope TEXT DEFAULT 'agent:full',
      used INTEGER DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (NOW()::text)
    )`,
    `CREATE TABLE IF NOT EXISTS auth_tokens (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      scope TEXT DEFAULT 'agent:full',
      revoked INTEGER DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (NOW()::text),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    )`,

    // ── agent_verifications, badges, rate_limits, collaborations ──
    `CREATE TABLE IF NOT EXISTS agent_verifications (
      id TEXT PRIMARY KEY,
      contribution_id TEXT NOT NULL,
      verifier_agent_id TEXT NOT NULL,
      result TEXT NOT NULL,
      reasoning TEXT DEFAULT '',
      reasoning_hash TEXT DEFAULT '',
      signature TEXT NOT NULL,
      created_at TEXT DEFAULT (NOW()::text),
      FOREIGN KEY (contribution_id) REFERENCES contributions(id),
      FOREIGN KEY (verifier_agent_id) REFERENCES agents(id)
    )`,
    `ALTER TABLE agent_verifications ADD COLUMN IF NOT EXISTS signer_address TEXT DEFAULT NULL`,
    `CREATE TABLE IF NOT EXISTS badges_earned (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      badge_type TEXT NOT NULL,
      tx_hash TEXT DEFAULT '',
      earned_at TEXT DEFAULT (NOW()::text),
      UNIQUE(agent_id, badge_type)
    )`,
    `CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER DEFAULT 0,
      window_start INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS platform_verifiers (
      wallet TEXT PRIMARY KEY,
      added_by TEXT NOT NULL,
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT (NOW()::text)
    )`,
    `CREATE TABLE IF NOT EXISTS collaborations (
      id TEXT PRIMARY KEY,
      bounty_id TEXT NOT NULL,
      proposer_agent_id TEXT NOT NULL,
      agent_ids TEXT NOT NULL DEFAULT '[]',
      reward_split TEXT NOT NULL DEFAULT '{}',
      status TEXT DEFAULT 'proposed',
      created_at TEXT DEFAULT (NOW()::text),
      FOREIGN KEY (bounty_id) REFERENCES bounties(id),
      FOREIGN KEY (proposer_agent_id) REFERENCES agents(id)
    )`,

    // ── agent_skills (marketplace) ──
    `CREATE TABLE IF NOT EXISTS agent_skills (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      description TEXT,
      keywords TEXT DEFAULT '[]',
      hourly_rate_usdc DOUBLE PRECISION DEFAULT 0,
      fixed_rate_usdc DOUBLE PRECISION DEFAULT 0,
      status TEXT DEFAULT 'active',
      total_completions INTEGER DEFAULT 0,
      total_earned_usdc DOUBLE PRECISION DEFAULT 0,
      avg_rating DOUBLE PRECISION DEFAULT 0,
      created_at TEXT DEFAULT (NOW()::text),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    )`,

    // ── escrow_events ──
    `CREATE TABLE IF NOT EXISTS escrow_events (
      id TEXT PRIMARY KEY,
      bounty_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_wallet TEXT,
      actor_type TEXT DEFAULT 'human',
      details TEXT DEFAULT '',
      tx_hash TEXT,
      created_at TEXT DEFAULT (NOW()::text),
      FOREIGN KEY (bounty_id) REFERENCES bounties(id)
    )`,

    // ── verification_decisions ──
    `CREATE TABLE IF NOT EXISTS verification_decisions (
      id TEXT PRIMARY KEY,
      bounty_id TEXT NOT NULL,
      verifier_wallet TEXT NOT NULL,
      verifier_type TEXT NOT NULL DEFAULT 'platform',
      decision TEXT NOT NULL,
      reasoning TEXT DEFAULT '',
      reasoning_hash TEXT DEFAULT '',
      stage INTEGER DEFAULT 1,
      tx_hash TEXT,
      created_at TEXT DEFAULT (NOW()::text),
      FOREIGN KEY (bounty_id) REFERENCES bounties(id)
    )`,

    // ── storage_metrics ──
    `CREATE TABLE IF NOT EXISTS storage_metrics (
      id BIGSERIAL PRIMARY KEY,
      operation TEXT NOT NULL,
      storage_type TEXT NOT NULL,
      file_type TEXT DEFAULT '',
      file_size BIGINT DEFAULT 0,
      wallet TEXT DEFAULT '',
      success INTEGER DEFAULT 1,
      error_message TEXT DEFAULT '',
      created_at TEXT DEFAULT (NOW()::text)
    )`,

    // ── Indexes ──
    `CREATE INDEX IF NOT EXISTS idx_proofs_contributor ON proofs(contributor)`,
    `CREATE INDEX IF NOT EXISTS idx_portfolio_wallet ON portfolio(wallet)`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_wallet ON notifications(wallet)`,
    `CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username)`,
    `CREATE INDEX IF NOT EXISTS idx_payments_payer ON payments(payer)`,
    `CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_wallet)`,
    `CREATE INDEX IF NOT EXISTS idx_contributions_agent ON contributions(agent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_contributions_status ON contributions(status)`,
    `CREATE INDEX IF NOT EXISTS idx_endorsements_contribution ON endorsements(contribution_id)`,
    `CREATE INDEX IF NOT EXISTS idx_endorsements_endorser ON endorsements(endorser_wallet)`,
    `CREATE INDEX IF NOT EXISTS idx_commitments_agent ON commitments(agent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_bounties_status ON bounties(status)`,
    `CREATE INDEX IF NOT EXISTS idx_bounties_creator ON bounties(creator_wallet)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_verifications_contrib ON agent_verifications(contribution_id)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_verifications_verifier ON agent_verifications(verifier_agent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_badges_agent ON badges_earned(agent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_collaborations_bounty ON collaborations(bounty_id)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_skills_agent ON agent_skills(agent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_skills_category ON agent_skills(category)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_skills_status ON agent_skills(status)`,
    `CREATE INDEX IF NOT EXISTS idx_escrow_events_bounty ON escrow_events(bounty_id)`,
    `CREATE INDEX IF NOT EXISTS idx_verification_decisions_bounty ON verification_decisions(bounty_id)`,
    `CREATE INDEX IF NOT EXISTS idx_bounties_swarm_execution ON bounties(swarm_execution_id)`,
    `CREATE INDEX IF NOT EXISTS idx_swarm_executions_bounty ON swarm_executions(bounty_id)`,
    `CREATE INDEX IF NOT EXISTS idx_swarm_executions_agent ON swarm_executions(agent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_swarm_executions_status ON swarm_executions(status)`,
    `CREATE INDEX IF NOT EXISTS idx_storage_metrics_created ON storage_metrics(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_storage_metrics_operation ON storage_metrics(operation)`,
    `CREATE INDEX IF NOT EXISTS idx_storage_metrics_wallet ON storage_metrics(wallet)`,
    `CREATE INDEX IF NOT EXISTS idx_proposals_bounty ON bounty_proposals(bounty_id)`,
    `CREATE INDEX IF NOT EXISTS idx_proposals_agent ON bounty_proposals(proposer_agent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_proposals_status ON bounty_proposals(status)`,
    `CREATE INDEX IF NOT EXISTS idx_msgs_bounty ON bounty_messages(bounty_id)`,
    `CREATE INDEX IF NOT EXISTS idx_msgs_proposal ON bounty_messages(proposal_id)`,
    `CREATE INDEX IF NOT EXISTS idx_msgs_thread ON bounty_messages(bounty_id, proposal_id, created_at)`,

    `UPDATE agents SET owner_wallet = LOWER(owner_wallet) WHERE owner_wallet <> LOWER(owner_wallet)`,

    // Backfill: rename case-insensitive duplicate agent_names so we can add a
    // UNIQUE(LOWER(agent_name)) index. Keep the oldest of each group as-is,
    // suffix the rest with the last 6 chars of their id (which is already
    // globally unique). Idempotent: re-runs find no dups and no-op.
    `WITH dups AS (
       SELECT id, agent_name,
              ROW_NUMBER() OVER (PARTITION BY LOWER(agent_name) ORDER BY created_at ASC, id ASC) AS rn
       FROM agents
     )
     UPDATE agents a
     SET agent_name = a.agent_name || '-' || RIGHT(a.id, 6)
     FROM dups
     WHERE a.id = dups.id AND dups.rn > 1`,

    // Defensive second pass: if the suffix pass above happened to generate a
    // name that collides with another existing agent (rare — would require
    // someone manually named an agent matching another's id suffix), fall back
    // to the full id as a suffix. No-op in the common case.
    `WITH dups AS (
       SELECT id, agent_name,
              ROW_NUMBER() OVER (PARTITION BY LOWER(agent_name) ORDER BY created_at ASC, id ASC) AS rn
       FROM agents
     )
     UPDATE agents a
     SET agent_name = a.agent_name || '-' || a.id
     FROM dups
     WHERE a.id = dups.id AND dups.rn > 1`,

    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_agents_lower_name ON agents (LOWER(agent_name))`,
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }

  console.log(`  Postgres schema initialized (${statements.length} statements)`);
}

// ── Prepared-statement-shaped async API ─────────────
//
// Each entry is an async function. For named-parameter SQLite queries
// (@col), the public signature takes an object and we map fields → $N.
// For positional SQLite queries (?), the public signature takes positional
// arguments and we pass them through.
//
// Call-site shape:
//   before: stmts.getAgentById.get(id)        → after: await stmts.getAgentById(id)
//   before: stmts.getAllProfiles.all()        → after: await stmts.getAllProfiles()
//   before: stmts.insertAgent.run({id, ...}) → after: await stmts.insertAgent({id, ...})
//
// .get()-shaped queries return a single row or undefined.
// .all()-shaped queries return an array of rows.
// .run()-shaped queries return { changes, rowCount }.

export const stmts = {
  // ── Human accounts ──
  getHumanAccountById: async (id) => one(
    'SELECT * FROM human_accounts WHERE id = $1',
    [id]
  ),
  getHumanAccountByPrivyDid: async (privyDid) => one(
    'SELECT * FROM human_accounts WHERE privy_did = $1',
    [privyDid]
  ),
  getHumanAccountByWallet: async (wallet) => one(
    'SELECT * FROM human_accounts WHERE LOWER(wallet_address) = LOWER($1)',
    [wallet]
  ),
  insertHumanAccount: async (p) => run(
    `INSERT INTO human_accounts
       (id, privy_did, email, email_verified_at, login_wallet, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (privy_did) DO UPDATE SET
       email = COALESCE(EXCLUDED.email, human_accounts.email),
       email_verified_at = COALESCE(EXCLUDED.email_verified_at, human_accounts.email_verified_at),
       login_wallet = COALESCE(EXCLUDED.login_wallet, human_accounts.login_wallet),
       updated_at = EXCLUDED.updated_at`,
    [
      p.id,
      p.privy_did,
      p.email || null,
      p.email_verified_at || null,
      p.login_wallet || null,
      p.created_at,
    ]
  ),
  attachHumanWallet: async (p) => run(
    `UPDATE human_accounts
        SET wallet_id = $1, wallet_address = LOWER($2), updated_at = $3
      WHERE id = $4 AND wallet_address IS NULL`,
    [p.wallet_id, p.wallet_address, p.updated_at, p.id]
  ),

  // ── Profiles ──
  upsertProfile: async (p) => run(
    `WITH matched AS (
       SELECT wallet
         FROM profiles
        WHERE LOWER(wallet) = LOWER($1)
        LIMIT 1
     ),
     updated AS (
       UPDATE profiles AS current
          SET username = $2,
              display_name = $3,
              bio = $4,
              profile_type = $5,
              ecosystems = $6,
              farcaster = $7,
              github = $8,
              x = $9,
              discord = $10,
              linkedin = $11,
              pfp = $12
         FROM matched
        WHERE current.wallet = matched.wallet
       RETURNING current.wallet
     ),
     inserted AS (
       INSERT INTO profiles
         (wallet, username, display_name, bio, profile_type, ecosystems,
          farcaster, github, x, discord, linkedin, pfp, created_at)
       SELECT LOWER($1), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
        WHERE NOT EXISTS (SELECT 1 FROM updated)
       ON CONFLICT (wallet) DO UPDATE SET
         username = EXCLUDED.username,
         display_name = EXCLUDED.display_name,
         bio = EXCLUDED.bio,
         profile_type = EXCLUDED.profile_type,
         ecosystems = EXCLUDED.ecosystems,
         farcaster = EXCLUDED.farcaster,
         github = EXCLUDED.github,
         x = EXCLUDED.x,
         discord = EXCLUDED.discord,
         linkedin = EXCLUDED.linkedin,
         pfp = EXCLUDED.pfp
       RETURNING profiles.wallet
     )
     SELECT wallet FROM updated
     UNION ALL
     SELECT wallet FROM inserted`,
    [p.wallet, p.username, p.display_name, p.bio, p.profile_type, p.ecosystems, p.farcaster, p.github, p.x, p.discord, p.linkedin, p.pfp, p.created_at]
  ),
  getProfileByWallet: async (wallet) => one(
    'SELECT * FROM profiles WHERE LOWER(wallet) = LOWER($1) LIMIT 1',
    [wallet]
  ),
  getProfileByUsername: async (username) => one(
    'SELECT * FROM profiles WHERE LOWER(username) = LOWER($1) LIMIT 1',
    [username]
  ),
  getAllProfiles: async () => many('SELECT * FROM profiles ORDER BY created_at DESC'),

  // ── Proofs ──
  insertProof: async (p) => run(
    `INSERT INTO proofs (id, title, ecosystem, contribution_type, description, external_links, contributor, status, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO NOTHING`,
    [p.id, p.title, p.ecosystem, p.contribution_type, p.description, p.external_links, p.contributor, p.status, p.timestamp]
  ),
  getProofById: async (id) => one('SELECT * FROM proofs WHERE id = $1', [id]),
  getProofsByWallet: async (wallet) => many('SELECT * FROM proofs WHERE contributor = $1 ORDER BY timestamp DESC', [wallet]),

  // ── Portfolio ──
  insertPortfolio: async (p) => run(
    `INSERT INTO portfolio (id, wallet, title, description, category, image_url, external_link, github_repo, tags, created_at, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO NOTHING`,
    [p.id, p.wallet, p.title, p.description, p.category, p.image_url, p.external_link, p.github_repo, p.tags, p.created_at, p.sort_order]
  ),
  getPortfolioByWallet: async (wallet) => many('SELECT * FROM portfolio WHERE wallet = $1 ORDER BY sort_order ASC', [wallet]),
  deletePortfolio: async (id) => run('DELETE FROM portfolio WHERE id = $1', [id]),
  updatePortfolioOrder: async (sortOrder, id) => run('UPDATE portfolio SET sort_order = $1 WHERE id = $2', [sortOrder, id]),

  // ── Notifications ──
  insertNotification: async (n) => run(
    `INSERT INTO notifications (id, wallet, type, title, message, sender, amount, read, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8)`,
    [n.id, n.wallet, n.type, n.title, n.message, n.sender, n.amount, n.created_at]
  ),
  getNotificationsByWallet: async (wallet) => many('SELECT * FROM notifications WHERE wallet = $1 ORDER BY created_at DESC LIMIT 50', [wallet]),
  markRead: async (id) => run('UPDATE notifications SET read = 1 WHERE id = $1', [id]),
  markAllRead: async (wallet) => run('UPDATE notifications SET read = 1 WHERE wallet = $1', [wallet]),

  // ── Payments ──
  insertPayment: async (p) => run(
    `INSERT INTO payments (payer, amount, network, endpoint, transaction_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [p.payer, p.amount, p.network, p.endpoint, p.transaction_id, p.created_at]
  ),
  getPaymentsByPayer: async (payer) => many('SELECT * FROM payments WHERE payer = $1 ORDER BY created_at DESC LIMIT 50', [payer]),
  getPaymentStats: async () => one('SELECT COUNT(*) as total_payments, COALESCE(SUM(CAST(amount AS DOUBLE PRECISION)), 0) as total_amount FROM payments'),

  // ── Agents ──
  insertAgent: async (p) => run(
    `INSERT INTO agents (id, owner_wallet, agent_name, agent_public_key, agent_type, description, reputation_score, created_at, swarm_config, is_platform_owned)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9)`,
    [p.id, p.owner_wallet, p.agent_name, p.agent_public_key, p.agent_type, p.description, p.created_at, p.swarm_config || null, p.is_platform_owned || 0]
  ),
  getAgentById: async (id) => one('SELECT * FROM agents WHERE id = $1', [id]),
  getAgentByName: async (name) => one('SELECT * FROM agents WHERE LOWER(agent_name) = LOWER($1) LIMIT 1', [name]),
  getAgentsByOwner: async (owner) => many('SELECT * FROM agents WHERE LOWER(owner_wallet) = LOWER($1) ORDER BY created_at DESC', [owner]),
  getAllAgents: async (status) => many('SELECT * FROM agents WHERE status = $1 ORDER BY reputation_score DESC', [status]),
  updateAgentReputation: async (score, totalContributions, totalEndorsements, id) => run(
    'UPDATE agents SET reputation_score = $1, total_contributions = $2, total_endorsements = $3 WHERE id = $4',
    [score, totalContributions, totalEndorsements, id]
  ),
  updateAgentStatus: async (status, id) => run('UPDATE agents SET status = $1 WHERE id = $2', [status, id]),

  // ── Contributions ──
  insertContribution: async (p) => run(
    `INSERT INTO contributions (id, agent_id, type, description, proof_hash, proof_data, signature, signer_address, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)`,
    [p.id, p.agent_id, p.type, p.description, p.proof_hash, p.proof_data, p.signature, p.signer_address || null, p.created_at]
  ),
  getContributionById: async (id) => one('SELECT * FROM contributions WHERE id = $1', [id]),
  getContributionsByAgent: async (agentId) => many('SELECT * FROM contributions WHERE agent_id = $1 ORDER BY created_at DESC', [agentId]),
  getContributionsByStatus: async (status) => many('SELECT * FROM contributions WHERE status = $1 ORDER BY created_at DESC LIMIT 50', [status]),
  getRecentContributions: async (limit) => many(
    'SELECT c.*, a.agent_name, a.owner_wallet FROM contributions c JOIN agents a ON c.agent_id = a.id ORDER BY c.created_at DESC LIMIT $1',
    [limit]
  ),
  updateContributionStatus: async (status, id) => run('UPDATE contributions SET status = $1 WHERE id = $2', [status, id]),
  incrementEndorsementCount: async (id) => run('UPDATE contributions SET endorsement_count = endorsement_count + 1 WHERE id = $1', [id]),

  // ── Endorsements ──
  insertEndorsement: async (p) => run(
    `INSERT INTO endorsements (id, contribution_id, endorser_wallet, endorser_type, comment, signature, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [p.id, p.contribution_id, p.endorser_wallet, p.endorser_type, p.comment, p.signature, p.created_at]
  ),
  getEndorsementsByContribution: async (contributionId) => many(
    'SELECT * FROM endorsements WHERE contribution_id = $1 ORDER BY created_at DESC',
    [contributionId]
  ),
  getEndorsementsByWallet: async (wallet) => many(
    `SELECT e.*, c.type as contribution_type, c.description as contribution_desc, a.agent_name
     FROM endorsements e
     JOIN contributions c ON e.contribution_id = c.id
     JOIN agents a ON c.agent_id = a.id
     WHERE e.endorser_wallet = $1
     ORDER BY e.created_at DESC LIMIT 50`,
    [wallet]
  ),
  countEndorsementsByContribution: async (contributionId) => one(
    'SELECT COUNT(*) as count FROM endorsements WHERE contribution_id = $1',
    [contributionId]
  ),

  // ── Agent State ──
  upsertAgentState: async (p) => run(
    `INSERT INTO agent_state (agent_id, context, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (agent_id) DO UPDATE
       SET context = EXCLUDED.context,
           updated_at = EXCLUDED.updated_at,
           last_activity = EXCLUDED.updated_at`,
    [p.agent_id, p.context, p.updated_at]
  ),
  getAgentState: async (agentId) => one('SELECT * FROM agent_state WHERE agent_id = $1', [agentId]),

  // ── Commitments ──
  insertCommitment: async (p) => run(
    `INSERT INTO commitments (id, agent_id, commitment_hash, salt, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [p.id, p.agent_id, p.commitment_hash, p.salt, p.created_at]
  ),
  getCommitmentById: async (id) => one('SELECT * FROM commitments WHERE id = $1', [id]),
  getCommitmentsByAgent: async (agentId) => many(
    'SELECT * FROM commitments WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 20',
    [agentId]
  ),
  revealCommitment: async (p) => run(
    'UPDATE commitments SET revealed = 1, reasoning = $1, revealed_at = $2 WHERE id = $3',
    [p.reasoning, p.revealed_at, p.id]
  ),

  // ── Record Board ──
  insertRecord: async (p) => run(
    `INSERT INTO recorded_contributions (id, contribution_id, agent_id, content_hash, tx_hash, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (contribution_id) DO NOTHING`,
    [p.id, p.contribution_id, p.agent_id, p.content_hash, p.tx_hash, p.recorded_at]
  ),
  getRecordByContribution: async (contributionId) => one(
    'SELECT * FROM recorded_contributions WHERE contribution_id = $1',
    [contributionId]
  ),
  getAllRecords: async (limit) => many(
    `SELECT rc.*, c.type, c.description, a.agent_name
     FROM recorded_contributions rc
     JOIN contributions c ON rc.contribution_id = c.id
     JOIN agents a ON rc.agent_id = a.id
     ORDER BY rc.recorded_at DESC LIMIT $1`,
    [limit]
  ),

  // ── Bounties ──
  insertBounty: async (p) => run(
    `INSERT INTO bounties (id, creator_wallet, title, description, bounty_type, amount_usdc, deadline, min_reputation, acceptance_criteria, created_at, updated_at, status, selection_mode, proposal_deadline, escrow_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      p.id, p.creator_wallet, p.title, p.description, p.bounty_type, p.amount_usdc, p.deadline,
      p.min_reputation, p.acceptance_criteria || '[]', p.created_at, p.updated_at,
      p.status || 'open',
      p.selection_mode || 'first_come',
      p.proposal_deadline || null,
      p.escrow_status || 'none',
    ]
  ),
  getBountyById: async (id) => one('SELECT * FROM bounties WHERE id = $1', [id]),
  // Claimable statuses (open/proposal_open) hide bounties whose deadline has
  // already passed — a new agent browsing for work should never see dead
  // listings (dogfood F6). In-flight statuses (assigned/submitted/...) are
  // not filtered: a past deadline there is a dispute/expiry concern, not a
  // discovery one. The regex guards the ::timestamptz cast against any
  // non-ISO junk in the TEXT deadline column.
  getOpenBounties: async (status, limit) => many(
    `SELECT * FROM bounties WHERE status = $1
       AND (status <> 'open' OR escrow_status = 'funded')
       AND (status NOT IN ('open','proposal_open')
            OR deadline IS NULL OR deadline = ''
            OR CASE WHEN deadline ~ '^\\d{4}-\\d{2}-\\d{2}' THEN deadline::timestamptz > NOW() ELSE TRUE END)
     ORDER BY created_at DESC LIMIT $2`,
    [status, limit]
  ),
  getOpenBountiesIn: async (statuses, limit) => many(
    `SELECT * FROM bounties WHERE status = ANY($1)
       AND (status <> 'open' OR escrow_status = 'funded')
       AND (status NOT IN ('open','proposal_open')
            OR deadline IS NULL OR deadline = ''
            OR CASE WHEN deadline ~ '^\\d{4}-\\d{2}-\\d{2}' THEN deadline::timestamptz > NOW() ELSE TRUE END)
     ORDER BY created_at DESC LIMIT $2`,
    [statuses, limit]
  ),
  getAllBounties: async () => many(
    `SELECT * FROM bounties
      WHERE status <> 'funding'
        AND NOT (status = 'open' AND escrow_status <> 'funded')
      ORDER BY created_at DESC LIMIT 50`
  ),
  getBountiesByCreator: async (wallet) => many(
    'SELECT * FROM bounties WHERE creator_wallet = $1 ORDER BY created_at DESC',
    [wallet]
  ),
  getBountiesByAgent: async (agentId) => many(
    'SELECT * FROM bounties WHERE assigned_agent_id = $1 ORDER BY created_at DESC',
    [agentId]
  ),
  updateBountyStatus: async (p) => run(
    'UPDATE bounties SET status = $1, updated_at = $2 WHERE id = $3',
    [p.status, p.updated_at, p.id]
  ),
  assignBounty: async (p) => run(
    'UPDATE bounties SET assigned_agent_id = $1, status = $2, updated_at = $3 WHERE id = $4',
    [p.agent_id, p.status, p.updated_at, p.id]
  ),
  completeBounty: async (p) => run(
    'UPDATE bounties SET contribution_id = $1, status = $2, updated_at = $3 WHERE id = $4',
    [p.contribution_id, p.status, p.updated_at, p.id]
  ),

  // ── Escrow lifecycle ──
  updateBountyEscrow: async (p) => run(
    `UPDATE bounties SET escrow_status = $1, escrow_budget_usdc = $2, escrow_tx_hash = $3, expires_at = $4, updated_at = $5 WHERE id = $6`,
    [p.escrow_status, p.escrow_budget_usdc, p.escrow_tx_hash, p.expires_at, p.updated_at, p.id]
  ),
  claimBountyEscrow: async (p) => run(
    `UPDATE bounties SET provider_agent_id = $1, provider_wallet = $2, escrow_status = 'claimed', status = 'assigned', claimed_at = $3, updated_at = $4 WHERE id = $5`,
    [p.provider_agent_id, p.provider_wallet, p.claimed_at, p.updated_at, p.id]
  ),
  submitBountyDeliverable: async (p) => run(
    `UPDATE bounties
        SET deliverable_hash = $1,
            deliverable_content = $2,
            deliverable_summary = $3,
            deliverable_evidence = $4,
            deliverable_instructions = $5,
            deliverable_artifacts = $6,
            verification_report = $7,
            verification_requested_at = NULL,
            verification_request_note = '',
            escrow_status = 'submitted',
            status = 'submitted',
            submitted_at = $8,
            updated_at = $9
      WHERE id = $10`,
    [
      p.deliverable_hash,
      p.deliverable_content,
      p.deliverable_summary,
      p.deliverable_evidence,
      p.deliverable_instructions,
      p.deliverable_artifacts,
      p.verification_report,
      p.submitted_at,
      p.updated_at,
      p.id,
    ]
  ),
  clientReviewBounty: async (p) => run(
    `UPDATE bounties SET client_decision = $1, client_decision_at = $2, escrow_status = $3, updated_at = $4 WHERE id = $5`,
    [p.client_decision, p.client_decision_at, p.escrow_status, p.updated_at, p.id]
  ),
  verifyBountyEscrow: async (p) => run(
    `UPDATE bounties SET verifier_wallet = $1, verifier_decision = $2, verifier_reason = $3, escrow_status = $4, updated_at = $5 WHERE id = $6`,
    [p.verifier_wallet, p.verifier_decision, p.verifier_reason, p.escrow_status, p.updated_at, p.id]
  ),
  releaseBountyEscrow: async (p) => run(
    `UPDATE bounties SET release_tx_hash = $1, escrow_status = 'released', status = 'completed', released_at = $2, updated_at = $3 WHERE id = $4`,
    [p.release_tx_hash, p.released_at, p.updated_at, p.id]
  ),
  refundBountyEscrow: async (p) => run(
    `UPDATE bounties
        SET refund_tx_hash = $1,
            escrow_status = 'refunded',
            status = 'cancelled',
            updated_at = $2
      WHERE id = $3`,
    [p.refund_tx_hash, p.updated_at, p.id]
  ),
  incrementBountyRevision: async (p) => run(
    `UPDATE bounties
        SET revision_count = revision_count + 1,
            escrow_status = 'claimed',
            deliverable_hash = NULL,
            deliverable_content = NULL,
            deliverable_summary = '',
            deliverable_evidence = '[]',
            deliverable_instructions = '',
            deliverable_artifacts = '[]',
            verification_report = '{}',
            verification_requested_at = NULL,
            verification_request_note = '',
            client_decision = NULL,
            client_decision_at = NULL,
            updated_at = $1
      WHERE id = $2`,
    [p.updated_at, p.id]
  ),
  getFundedBounties: async (limit) => many(
    "SELECT * FROM bounties WHERE escrow_status = 'funded' ORDER BY created_at DESC LIMIT $1",
    [limit]
  ),
  getMarketplaceBounties: async (limit) => many(
    `SELECT * FROM bounties
      WHERE (
        (status = 'open' AND escrow_status = 'funded')
        OR
        (status = 'proposal_open' AND escrow_status = 'none')
      )
       AND (deadline IS NULL OR deadline = ''
            OR CASE WHEN deadline ~ '^\\d{4}-\\d{2}-\\d{2}' THEN deadline::timestamptz > NOW() ELSE TRUE END)
     ORDER BY escrow_budget_usdc DESC, created_at DESC LIMIT $1`,
    [limit]
  ),

  // ── Escrow events ──
  insertEscrowEvent: async (p) => run(
    `INSERT INTO escrow_events (id, bounty_id, event_type, actor_wallet, actor_type, details, tx_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [p.id, p.bounty_id, p.event_type, p.actor_wallet, p.actor_type, p.details, p.tx_hash, p.created_at]
  ),
  getEscrowEvents: async (bountyId) => many(
    'SELECT * FROM escrow_events WHERE bounty_id = $1 ORDER BY created_at ASC',
    [bountyId]
  ),

  // ── Verification decisions ──
  insertVerificationDecision: async (p) => run(
    `INSERT INTO verification_decisions (id, bounty_id, verifier_wallet, verifier_type, decision, reasoning, reasoning_hash, stage, tx_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [p.id, p.bounty_id, p.verifier_wallet, p.verifier_type, p.decision, p.reasoning, p.reasoning_hash, p.stage, p.tx_hash, p.created_at]
  ),
  getVerificationDecisions: async (bountyId) => many(
    'SELECT * FROM verification_decisions WHERE bounty_id = $1 ORDER BY created_at DESC',
    [bountyId]
  ),

  // ── Agent skills ──
  insertAgentSkill: async (p) => run(
    `INSERT INTO agent_skills (id, agent_id, skill_name, category, description, keywords, hourly_rate_usdc, fixed_rate_usdc, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [p.id, p.agent_id, p.skill_name, p.category, p.description, p.keywords, p.hourly_rate_usdc, p.fixed_rate_usdc, p.status, p.created_at]
  ),
  getAgentSkills: async (agentId, status) => many(
    'SELECT * FROM agent_skills WHERE agent_id = $1 AND status = $2 ORDER BY created_at DESC',
    [agentId, status]
  ),
  getSkillById: async (id) => one('SELECT * FROM agent_skills WHERE id = $1', [id]),
  updateAgentSkill: async (p) => run(
    `UPDATE agent_skills
     SET skill_name = $1, category = $2, description = $3, keywords = $4,
         hourly_rate_usdc = $5, fixed_rate_usdc = $6, status = $7
     WHERE id = $8`,
    [p.skill_name, p.category, p.description, p.keywords, p.hourly_rate_usdc, p.fixed_rate_usdc, p.status, p.id]
  ),
  deleteAgentSkill: async (skillId, agentId) => run(
    'DELETE FROM agent_skills WHERE id = $1 AND agent_id = $2',
    [skillId, agentId]
  ),
  searchSkills: async (limit) => many(
    `SELECT s.*, a.agent_name, a.agent_type, a.reputation_score, a.status as agent_status
     FROM agent_skills s JOIN agents a ON s.agent_id = a.id
     WHERE s.status = 'active' AND a.status = 'active'
     ORDER BY a.reputation_score DESC LIMIT $1`,
    [limit]
  ),
  searchSkillsByCategory: async (category, limit) => many(
    `SELECT s.*, a.agent_name, a.agent_type, a.reputation_score, a.status as agent_status
     FROM agent_skills s JOIN agents a ON s.agent_id = a.id
     WHERE s.status = 'active' AND a.status = 'active' AND s.category = $1
     ORDER BY a.reputation_score DESC LIMIT $2`,
    [category, limit]
  ),
  incrementSkillCompletions: async (amount, agentId, status) => run(
    'UPDATE agent_skills SET total_completions = total_completions + 1, total_earned_usdc = total_earned_usdc + $1 WHERE agent_id = $2 AND status = $3',
    [amount, agentId, status]
  ),

  // ── Auth ──
  insertChallenge: async (p) => run(
    `INSERT INTO auth_challenges (id, agent_id, nonce, message, scope, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [p.id, p.agent_id, p.nonce, p.message, p.scope, p.expires_at, p.created_at]
  ),
  getChallenge: async (id) => one('SELECT * FROM auth_challenges WHERE id = $1', [id]),
  markChallengeUsed: async (id) => run('UPDATE auth_challenges SET used = 1 WHERE id = $1', [id]),
  insertAuthToken: async (p) => run(
    `INSERT INTO auth_tokens (id, agent_id, wallet, scope, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [p.id, p.agent_id, p.wallet, p.scope, p.expires_at, p.created_at]
  ),
  getAuthToken: async (id) => one('SELECT * FROM auth_tokens WHERE id = $1', [id]),
  revokeAuthToken: async (id) => run('UPDATE auth_tokens SET revoked = 1 WHERE id = $1', [id]),
  getTokensByAgent: async (agentId) => many(
    'SELECT * FROM auth_tokens WHERE agent_id = $1 AND revoked = 0 ORDER BY created_at DESC',
    [agentId]
  ),

  // ── Platform verifiers (delegated escrow approval) ──
  isPlatformVerifier: async (wallet) => {
    const r = await pool.query(
      'SELECT 1 FROM platform_verifiers WHERE wallet = $1',
      [(wallet || '').toLowerCase()]
    );
    return r.rowCount > 0;
  },
  listPlatformVerifiers: async () => many(
    'SELECT * FROM platform_verifiers ORDER BY created_at ASC'
  ),
  addPlatformVerifier: async (p) => run(
    `INSERT INTO platform_verifiers (wallet, added_by, note, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (wallet) DO UPDATE SET note = EXCLUDED.note, added_by = EXCLUDED.added_by`,
    [p.wallet.toLowerCase(), p.added_by.toLowerCase(), p.note || '', new Date().toISOString()]
  ),
  removePlatformVerifier: async (wallet) => run(
    'DELETE FROM platform_verifiers WHERE wallet = $1',
    [(wallet || '').toLowerCase()]
  ),

  // ── Storage metrics ──
  logStorageMetric: async (p) => run(
    `INSERT INTO storage_metrics (operation, storage_type, file_type, file_size, wallet, success, error_message, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [p.operation, p.storage_type, p.file_type || '', p.file_size || 0, p.wallet || '', p.success ? 1 : 0, p.error_message || '', new Date().toISOString()]
  ),
  getStorageStats: async (days = 7) => {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return one(
      `SELECT
        COUNT(*) as total_operations,
        COUNT(CASE WHEN success = 1 THEN 1 END) as successful_operations,
        COUNT(CASE WHEN success = 0 THEN 1 END) as failed_operations,
        COUNT(CASE WHEN operation = 'upload' THEN 1 END) as uploads,
        COUNT(CASE WHEN operation = 'delete' THEN 1 END) as deletes,
        SUM(CASE WHEN operation = 'upload' AND success = 1 THEN file_size ELSE 0 END) as total_bytes_uploaded,
        COUNT(CASE WHEN storage_type = 'r2' THEN 1 END) as r2_operations,
        COUNT(CASE WHEN storage_type = 'local' THEN 1 END) as local_operations
      FROM storage_metrics
      WHERE created_at >= $1`,
      [since]
    );
  },

  // ── Bounty proposals (hybrid mode) ──
  insertProposal: async (p) => run(
    `INSERT INTO bounty_proposals (id, bounty_id, proposer_agent_id, proposer_wallet, plan, proposed_price_usdc, estimated_hours, portfolio_refs, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [p.id, p.bounty_id, p.proposer_agent_id, p.proposer_wallet, p.plan, p.proposed_price_usdc, p.estimated_hours || 0, p.portfolio_refs || '[]', p.created_at, p.updated_at]
  ),
  getProposalById: async (id) => one('SELECT * FROM bounty_proposals WHERE id = $1', [id]),
  getProposalsByBounty: async (bountyId) => many(
    `SELECT p.*, a.agent_name, a.reputation_score, a.total_earned_usdc, a.agent_type
     FROM bounty_proposals p
     LEFT JOIN agents a ON p.proposer_agent_id = a.id
     WHERE p.bounty_id = $1
     ORDER BY p.created_at ASC`,
    [bountyId]
  ),
  getProposalByBountyAndAgent: async (bountyId, agentId) => one(
    'SELECT * FROM bounty_proposals WHERE bounty_id = $1 AND proposer_agent_id = $2',
    [bountyId, agentId]
  ),
  getProposalsByAgent: async (agentId) => many(
    `SELECT p.*, b.title as bounty_title, b.status as bounty_status, b.amount_usdc as bounty_amount_usdc, b.selection_mode
     FROM bounty_proposals p
     LEFT JOIN bounties b ON p.bounty_id = b.id
     WHERE p.proposer_agent_id = $1
     ORDER BY p.created_at DESC
     LIMIT 100`,
    [agentId]
  ),
  updateProposal: async (p) => run(
    `UPDATE bounty_proposals
     SET plan = $1, proposed_price_usdc = $2, estimated_hours = $3, portfolio_refs = $4, updated_at = $5
     WHERE id = $6 AND status = 'pending'`,
    [p.plan, p.proposed_price_usdc, p.estimated_hours || 0, p.portfolio_refs || '[]', p.updated_at, p.id]
  ),
  withdrawProposal: async (p) => run(
    `UPDATE bounty_proposals SET status = 'withdrawn', withdrawn_at = $1, updated_at = $1 WHERE id = $2 AND status = 'pending'`,
    [p.withdrawn_at, p.id]
  ),
  acceptProposal: async (p) => run(
    `UPDATE bounty_proposals SET status = 'accepted', accepted_at = $1, updated_at = $1 WHERE id = $2 AND status = 'pending'`,
    [p.accepted_at, p.id]
  ),
  rejectProposal: async (p) => run(
    `UPDATE bounty_proposals SET status = 'rejected', rejected_at = $1, rejection_reason = $2, updated_at = $1 WHERE id = $3 AND status IN ('pending', 'accepted')`,
    [p.rejected_at, p.rejection_reason || '', p.id]
  ),
  setBountySelectedProposal: async (p) => run(
    `UPDATE bounties SET selected_proposal_id = $1, status = $2, amount_usdc = $3, updated_at = $4 WHERE id = $5`,
    [p.selected_proposal_id, p.status, p.amount_usdc, p.updated_at, p.id]
  ),

  // ── Bounty messages (creator <-> proposer threads) ──
  insertBountyMessage: async (p) => run(
    `INSERT INTO bounty_messages (id, bounty_id, proposal_id, from_wallet, from_agent_id, to_wallet, to_agent_id, message, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [p.id, p.bounty_id, p.proposal_id || null, (p.from_wallet || '').toLowerCase(), p.from_agent_id || null, (p.to_wallet || '').toLowerCase(), p.to_agent_id || null, p.message, p.created_at]
  ),
  getBountyMessages: async (bountyId, proposalId) => many(
    proposalId
      ? `SELECT m.*, fa.agent_name as from_agent_name, ta.agent_name as to_agent_name
         FROM bounty_messages m
         LEFT JOIN agents fa ON m.from_agent_id = fa.id
         LEFT JOIN agents ta ON m.to_agent_id = ta.id
         WHERE m.bounty_id = $1 AND m.proposal_id = $2
         ORDER BY m.created_at ASC`
      : `SELECT m.*, fa.agent_name as from_agent_name, ta.agent_name as to_agent_name
         FROM bounty_messages m
         LEFT JOIN agents fa ON m.from_agent_id = fa.id
         LEFT JOIN agents ta ON m.to_agent_id = ta.id
         WHERE m.bounty_id = $1
         ORDER BY m.created_at ASC`,
    proposalId ? [bountyId, proposalId] : [bountyId]
  ),
  markMessagesRead: async (bountyId, proposalId, recipientWallet) => run(
    `UPDATE bounty_messages SET read = 1
     WHERE bounty_id = $1 AND proposal_id = $2 AND LOWER(to_wallet) = LOWER($3) AND read = 0`,
    [bountyId, proposalId, recipientWallet]
  ),
};

export default { pool, query, initSchema, stmts };
