import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';
import { formatUnits, verifyMessage } from 'viem';
import { isTurnkeyEnabled, mintERC8004Identity, getOrCreateAgentWallet } from './turnkey-wallet.js';
import { handleRpc as handleMcpRpc } from './mcp-handler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;

// ── Seller wallet (receives USDC nanopayments) ──
const SELLER_ADDRESS = process.env.SELLER_ADDRESS || '0xb93E4681a57e2bF801e223E13Ba3b1b3c042e28a';

// ── Platform owner wallet (Stage 1 escrow verifier) ──
const PLATFORM_OWNER_WALLET = (process.env.PLATFORM_OWNER_WALLET || SELLER_ADDRESS).toLowerCase();

// ── CORS ──
const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    const allowed = [...DEFAULT_ALLOWED_ORIGINS, ...ALLOWED_ORIGINS];
    if (!origin || allowed.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked origin: ${origin}`));
  },
  allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Accept'],
}));
app.use(express.json({ limit: '10mb' }));

// ══════════════════════════════════════════════════════
// ── MCP Streamable HTTP transport ──
// ══════════════════════════════════════════════════════
// Hosted MCP endpoint. Clients POST JSON-RPC messages here with
// `Authorization: Bearer <BARD_TOKEN>`. Stateless — no session storage.

app.post('/mcp', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  try {
    const result = await handleMcpRpc(req.body, token);
    if (result === null) return res.status(204).end();
    res.json(result);
  } catch (err) {
    res.status(500).json({
      jsonrpc: '2.0',
      id: req.body?.id ?? null,
      error: { code: -32603, message: err.message },
    });
  }
});

app.get('/mcp', (_req, res) => {
  res.json({ name: 'bard-mcp', version: '0.3.0', transport: 'streamable-http', endpoint: '/mcp' });
});

// ── Static file serving ──
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
app.use('/uploads', express.static(UPLOADS_DIR));

// ══════════════════════════════════════════════════════
// ── SQLite Database ──
// ══════════════════════════════════════════════════════

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'bard.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──
db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    wallet TEXT PRIMARY KEY COLLATE NOCASE,
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
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS proofs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    ecosystem TEXT DEFAULT '',
    contribution_type TEXT DEFAULT '',
    description TEXT DEFAULT '',
    external_links TEXT DEFAULT '[]',
    file_url TEXT DEFAULT '',
    contributor TEXT NOT NULL COLLATE NOCASE,
    submitted_by TEXT DEFAULT '',
    status TEXT DEFAULT 'unvalidated',
    timestamp TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS portfolio (
    id TEXT PRIMARY KEY,
    wallet TEXT NOT NULL COLLATE NOCASE,
    title TEXT DEFAULT '',
    description TEXT DEFAULT '',
    category TEXT DEFAULT 'other',
    image_url TEXT DEFAULT '',
    external_link TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    wallet TEXT NOT NULL COLLATE NOCASE,
    type TEXT DEFAULT 'system',
    title TEXT DEFAULT '',
    message TEXT DEFAULT '',
    sender TEXT DEFAULT '',
    amount TEXT DEFAULT '',
    read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payer TEXT NOT NULL COLLATE NOCASE,
    amount TEXT NOT NULL,
    network TEXT DEFAULT '',
    endpoint TEXT DEFAULT '',
    transaction_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Agent Reputation System
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    owner_wallet TEXT NOT NULL COLLATE NOCASE,
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
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS contributions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    type TEXT NOT NULL,
    description TEXT DEFAULT '',
    proof_hash TEXT NOT NULL,
    proof_data TEXT DEFAULT '',
    signature TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    endorsement_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS endorsements (
    id TEXT PRIMARY KEY,
    contribution_id TEXT NOT NULL,
    endorser_wallet TEXT NOT NULL COLLATE NOCASE,
    endorser_type TEXT DEFAULT 'human',
    comment TEXT DEFAULT '',
    signature TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (contribution_id) REFERENCES contributions(id),
    UNIQUE(contribution_id, endorser_wallet)
  );

  CREATE TABLE IF NOT EXISTS agent_state (
    agent_id TEXT PRIMARY KEY,
    context TEXT DEFAULT '{}',
    last_activity TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  -- Phase 2: Commit-Reveal Accountability
  CREATE TABLE IF NOT EXISTS commitments (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    commitment_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    revealed INTEGER DEFAULT 0,
    reasoning TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    revealed_at TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  -- Phase 2: On-Chain Record Board (off-chain mirror)
  CREATE TABLE IF NOT EXISTS recorded_contributions (
    id TEXT PRIMARY KEY,
    contribution_id TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    tx_hash TEXT DEFAULT '',
    recorded_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (contribution_id) REFERENCES contributions(id)
  );

  -- Phase 3: Bounty System
  CREATE TABLE IF NOT EXISTS bounties (
    id TEXT PRIMARY KEY,
    creator_wallet TEXT NOT NULL COLLATE NOCASE,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    bounty_type TEXT NOT NULL,
    amount_usdc TEXT NOT NULL,
    deadline TEXT NOT NULL,
    min_reputation INTEGER DEFAULT 0,
    assigned_agent_id TEXT,
    contribution_id TEXT,
    status TEXT DEFAULT 'open',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_proofs_contributor ON proofs(contributor);
  CREATE INDEX IF NOT EXISTS idx_portfolio_wallet ON portfolio(wallet);
  CREATE INDEX IF NOT EXISTS idx_notifications_wallet ON notifications(wallet);
  CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username);
  CREATE INDEX IF NOT EXISTS idx_payments_payer ON payments(payer);
  CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_wallet);
  CREATE INDEX IF NOT EXISTS idx_contributions_agent ON contributions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_contributions_status ON contributions(status);
  CREATE INDEX IF NOT EXISTS idx_endorsements_contribution ON endorsements(contribution_id);
  CREATE INDEX IF NOT EXISTS idx_endorsements_endorser ON endorsements(endorser_wallet);
  CREATE INDEX IF NOT EXISTS idx_commitments_agent ON commitments(agent_id);
  CREATE INDEX IF NOT EXISTS idx_bounties_status ON bounties(status);
  CREATE INDEX IF NOT EXISTS idx_bounties_creator ON bounties(creator_wallet);

  -- Agent Auth (Challenge-Sign-Verify)
  CREATE TABLE IF NOT EXISTS auth_challenges (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    nonce TEXT NOT NULL,
    message TEXT NOT NULL,
    scope TEXT DEFAULT 'agent:full',
    used INTEGER DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS auth_tokens (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    wallet TEXT NOT NULL COLLATE NOCASE,
    scope TEXT DEFAULT 'agent:full',
    revoked INTEGER DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );
  -- Phase v2: Agent Marketplace
  CREATE TABLE IF NOT EXISTS agent_verifications (
    id TEXT PRIMARY KEY,
    contribution_id TEXT NOT NULL,
    verifier_agent_id TEXT NOT NULL,
    result TEXT NOT NULL,
    reasoning TEXT DEFAULT '',
    reasoning_hash TEXT DEFAULT '',
    signature TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (contribution_id) REFERENCES contributions(id),
    FOREIGN KEY (verifier_agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS badges_earned (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    badge_type TEXT NOT NULL,
    tx_hash TEXT DEFAULT '',
    earned_at TEXT DEFAULT (datetime('now')),
    UNIQUE(agent_id, badge_type)
  );

  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    window_start INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_agent_verifications_contrib ON agent_verifications(contribution_id);
  CREATE INDEX IF NOT EXISTS idx_agent_verifications_verifier ON agent_verifications(verifier_agent_id);
  CREATE INDEX IF NOT EXISTS idx_badges_agent ON badges_earned(agent_id);

  -- Multi-Agent Collaborations
  CREATE TABLE IF NOT EXISTS collaborations (
    id TEXT PRIMARY KEY,
    bounty_id TEXT NOT NULL,
    proposer_agent_id TEXT NOT NULL,
    agent_ids TEXT NOT NULL DEFAULT '[]',
    reward_split TEXT NOT NULL DEFAULT '{}',
    status TEXT DEFAULT 'proposed',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (bounty_id) REFERENCES bounties(id),
    FOREIGN KEY (proposer_agent_id) REFERENCES agents(id)
  );
  CREATE INDEX IF NOT EXISTS idx_collaborations_bounty ON collaborations(bounty_id);
`);

// Safe ALTER TABLE additions (ignore if column exists)
const safeAddColumn = (table, col, def) => {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch {}
};
safeAddColumn('agents', 'specializations', "TEXT DEFAULT '[]'");
safeAddColumn('agents', 'hourly_rate_usdc', 'REAL DEFAULT 0');
safeAddColumn('agents', 'availability', "TEXT DEFAULT 'available'");
safeAddColumn('agents', 'last_active_at', 'INTEGER');
safeAddColumn('agents', 'total_earned_usdc', 'REAL DEFAULT 0');
safeAddColumn('agents', 'success_rate', 'REAL DEFAULT 0');
safeAddColumn('agents', 'erc8004_metadata_uri', 'TEXT DEFAULT NULL');
safeAddColumn('agents', 'erc8004_tx_hash', 'TEXT DEFAULT NULL');
safeAddColumn('agents', 'erc8004_minted_at', 'TEXT DEFAULT NULL');
safeAddColumn('agents', 'turnkey_wallet_id', 'TEXT DEFAULT NULL');
safeAddColumn('agents', 'turnkey_address', 'TEXT DEFAULT NULL');
safeAddColumn('profiles', 'pfp', "TEXT DEFAULT ''");

// ── Escrow columns on bounties ──
safeAddColumn('bounties', 'escrow_status', "TEXT DEFAULT 'none'");
safeAddColumn('bounties', 'escrow_budget_usdc', 'REAL DEFAULT 0');
safeAddColumn('bounties', 'escrow_tx_hash', 'TEXT');
safeAddColumn('bounties', 'provider_agent_id', 'TEXT');
safeAddColumn('bounties', 'provider_wallet', 'TEXT');
safeAddColumn('bounties', 'deliverable_hash', 'TEXT');
safeAddColumn('bounties', 'deliverable_content', 'TEXT');
safeAddColumn('bounties', 'client_decision', 'TEXT');
safeAddColumn('bounties', 'client_decision_at', 'TEXT');
safeAddColumn('bounties', 'verifier_wallet', 'TEXT');
safeAddColumn('bounties', 'verifier_decision', 'TEXT');
safeAddColumn('bounties', 'verifier_reason', 'TEXT');
safeAddColumn('bounties', 'release_tx_hash', 'TEXT');
safeAddColumn('bounties', 'revision_count', 'INTEGER DEFAULT 0');
safeAddColumn('bounties', 'expires_at', 'TEXT');
safeAddColumn('bounties', 'claimed_at', 'TEXT');
safeAddColumn('bounties', 'submitted_at', 'TEXT');
safeAddColumn('bounties', 'released_at', 'TEXT');

// ── Agent Skills Registry ──
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_skills (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    description TEXT,
    keywords TEXT DEFAULT '[]',
    hourly_rate_usdc REAL DEFAULT 0,
    fixed_rate_usdc REAL DEFAULT 0,
    status TEXT DEFAULT 'active',
    total_completions INTEGER DEFAULT 0,
    total_earned_usdc REAL DEFAULT 0,
    avg_rating REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_skills_agent ON agent_skills(agent_id);
  CREATE INDEX IF NOT EXISTS idx_agent_skills_category ON agent_skills(category);
  CREATE INDEX IF NOT EXISTS idx_agent_skills_status ON agent_skills(status);

  CREATE TABLE IF NOT EXISTS escrow_events (
    id TEXT PRIMARY KEY,
    bounty_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor_wallet TEXT,
    actor_type TEXT DEFAULT 'human',
    details TEXT DEFAULT '',
    tx_hash TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (bounty_id) REFERENCES bounties(id)
  );
  CREATE INDEX IF NOT EXISTS idx_escrow_events_bounty ON escrow_events(bounty_id);

  CREATE TABLE IF NOT EXISTS verification_decisions (
    id TEXT PRIMARY KEY,
    bounty_id TEXT NOT NULL,
    verifier_wallet TEXT NOT NULL,
    verifier_type TEXT NOT NULL DEFAULT 'platform',
    decision TEXT NOT NULL,
    reasoning TEXT DEFAULT '',
    reasoning_hash TEXT DEFAULT '',
    stage INTEGER DEFAULT 1,
    tx_hash TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (bounty_id) REFERENCES bounties(id)
  );
  CREATE INDEX IF NOT EXISTS idx_verification_decisions_bounty ON verification_decisions(bounty_id);
`);

console.log(`  DB initialized: ${DB_PATH}`);

// ── Rate Limiting Utility ──
const RATE_LIMITS = {
  'bard_submit_contribution': { max: 10, window: 3600 },
  'bard_verify_contribution': { max: 20, window: 3600 },
  'bard_propose_collaboration': { max: 5, window: 3600 },
  'bard_upload_proof': { max: 10, window: 3600 },
  'faucet_claim': { max: 1, window: 3600 },
  'escrow_fund': { max: 10, window: 3600 },
  'escrow_claim': { max: 10, window: 3600 },
  'escrow_deliver': { max: 10, window: 3600 },
  'escrow_review': { max: 10, window: 3600 },
  'escrow_verify': { max: 5, window: 3600 },
  'skill_register': { max: 20, window: 3600 },
};

function checkRateLimit(key, action) {
  const limits = RATE_LIMITS[action];
  if (!limits) return true;
  const fullKey = `${key}:${action}`;
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').get(fullKey);
  if (!row || (now - row.window_start) > limits.window) {
    db.prepare('INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)').run(fullKey, now);
    return true;
  }
  if (row.count >= limits.max) return false;
  db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(fullKey);
  return true;
}

// ── Reputation Decay (runs every hour) ──
function runReputationDecay() {
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - (30 * 24 * 3600);
  const oneWeekSeconds = 7 * 24 * 3600;

  const inactiveAgents = db.prepare(
    "SELECT id, reputation_score, last_active_at FROM agents WHERE status = 'active' AND reputation_score > 0 AND last_active_at IS NOT NULL AND last_active_at < ?"
  ).all(thirtyDaysAgo);

  let decayed = 0;
  for (const agent of inactiveAgents) {
    const weeksInactive = Math.floor((now - agent.last_active_at - 30 * 24 * 3600) / oneWeekSeconds);
    if (weeksInactive > 0) {
      const decay = Math.min(weeksInactive * 5, agent.reputation_score);
      if (decay > 0) {
        db.prepare('UPDATE agents SET reputation_score = MAX(0, reputation_score - ?) WHERE id = ?').run(decay, agent.id);
        decayed++;
      }
    }
  }
  if (decayed > 0) console.log(`  Reputation decay: ${decayed} agents affected`);
}

// Run decay on startup and every hour
runReputationDecay();
setInterval(runReputationDecay, 60 * 60 * 1000);

// ── Escrow Expiry Check ──
function checkEscrowExpiry() {
  const now = new Date().toISOString();
  const expired = db.prepare("SELECT id, title, escrow_budget_usdc, creator_wallet, provider_agent_id, escrow_status FROM bounties WHERE expires_at IS NOT NULL AND expires_at < ? AND escrow_status IN ('funded', 'claimed', 'submitted')").all(now);
  for (const b of expired) {
    try {
      db.prepare("UPDATE bounties SET escrow_status = 'refunded', status = 'expired', updated_at = ? WHERE id = ?").run(now, b.id);
      const evtId = `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      db.prepare('INSERT INTO escrow_events (id, bounty_id, event_type, actor_wallet, actor_type, details, tx_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(evtId, b.id, 'expired', '', 'system', `Escrow expired. ${b.escrow_budget_usdc} USDC auto-refunded.`, '', now);
      console.log(`  Escrow expired: ${b.id} (${b.escrow_budget_usdc} USDC refunded)`);
    } catch (err) {
      console.error(`  Escrow expiry error for ${b.id}:`, err.message);
    }
  }
}
checkEscrowExpiry();
setInterval(checkEscrowExpiry, 60 * 60 * 1000); // Every hour

// ── Prepared Statements ──
const stmts = {
  // Profiles
  upsertProfile: db.prepare(`
    INSERT INTO profiles (wallet, username, display_name, bio, profile_type, ecosystems, farcaster, github, x, discord, linkedin, pfp, created_at)
    VALUES (@wallet, @username, @display_name, @bio, @profile_type, @ecosystems, @farcaster, @github, @x, @discord, @linkedin, @pfp, @created_at)
    ON CONFLICT(wallet) DO UPDATE SET
      username=@username, display_name=@display_name, bio=@bio, profile_type=@profile_type,
      ecosystems=@ecosystems, farcaster=@farcaster, github=@github, x=@x, discord=@discord, linkedin=@linkedin, pfp=@pfp
  `),
  getProfileByWallet: db.prepare('SELECT * FROM profiles WHERE wallet = ?'),
  getProfileByUsername: db.prepare('SELECT * FROM profiles WHERE username = ?'),
  getAllProfiles: db.prepare('SELECT * FROM profiles ORDER BY created_at DESC'),

  // Proofs
  insertProof: db.prepare(`
    INSERT OR IGNORE INTO proofs (id, title, ecosystem, contribution_type, description, external_links, contributor, status, timestamp)
    VALUES (@id, @title, @ecosystem, @contribution_type, @description, @external_links, @contributor, @status, @timestamp)
  `),
  getProofsByWallet: db.prepare('SELECT * FROM proofs WHERE contributor = ? ORDER BY timestamp DESC'),

  // Portfolio
  insertPortfolio: db.prepare(`
    INSERT OR IGNORE INTO portfolio (id, wallet, title, description, category, image_url, external_link, tags, created_at, sort_order)
    VALUES (@id, @wallet, @title, @description, @category, @image_url, @external_link, @tags, @created_at, @sort_order)
  `),
  getPortfolioByWallet: db.prepare('SELECT * FROM portfolio WHERE wallet = ? ORDER BY sort_order ASC'),
  deletePortfolio: db.prepare('DELETE FROM portfolio WHERE id = ?'),
  updatePortfolioOrder: db.prepare('UPDATE portfolio SET sort_order = ? WHERE id = ?'),

  // Notifications
  insertNotification: db.prepare(`
    INSERT INTO notifications (id, wallet, type, title, message, sender, amount, read, created_at)
    VALUES (@id, @wallet, @type, @title, @message, @sender, @amount, 0, @created_at)
  `),
  getNotificationsByWallet: db.prepare('SELECT * FROM notifications WHERE wallet = ? ORDER BY created_at DESC LIMIT 50'),
  markRead: db.prepare('UPDATE notifications SET read = 1 WHERE id = ?'),
  markAllRead: db.prepare('UPDATE notifications SET read = 1 WHERE wallet = ?'),

  // Payments
  insertPayment: db.prepare(`
    INSERT INTO payments (payer, amount, network, endpoint, transaction_id, created_at)
    VALUES (@payer, @amount, @network, @endpoint, @transaction_id, @created_at)
  `),
  getPaymentsByPayer: db.prepare('SELECT * FROM payments WHERE payer = ? ORDER BY created_at DESC LIMIT 50'),
  getPaymentStats: db.prepare('SELECT COUNT(*) as total_payments, COALESCE(SUM(CAST(amount AS REAL)), 0) as total_amount FROM payments'),

  // Agents
  insertAgent: db.prepare(`
    INSERT INTO agents (id, owner_wallet, agent_name, agent_public_key, agent_type, description, reputation_score, created_at)
    VALUES (@id, @owner_wallet, @agent_name, @agent_public_key, @agent_type, @description, 0, @created_at)
  `),
  getAgentById: db.prepare('SELECT * FROM agents WHERE id = ?'),
  getAgentsByOwner: db.prepare('SELECT * FROM agents WHERE owner_wallet = ? ORDER BY created_at DESC'),
  getAllAgents: db.prepare('SELECT * FROM agents WHERE status = ? ORDER BY reputation_score DESC'),
  updateAgentReputation: db.prepare('UPDATE agents SET reputation_score = ?, total_contributions = ?, total_endorsements = ? WHERE id = ?'),
  updateAgentStatus: db.prepare('UPDATE agents SET status = ? WHERE id = ?'),

  // Contributions
  insertContribution: db.prepare(`
    INSERT INTO contributions (id, agent_id, type, description, proof_hash, proof_data, signature, status, created_at)
    VALUES (@id, @agent_id, @type, @description, @proof_hash, @proof_data, @signature, 'pending', @created_at)
  `),
  getContributionById: db.prepare('SELECT * FROM contributions WHERE id = ?'),
  getContributionsByAgent: db.prepare('SELECT * FROM contributions WHERE agent_id = ? ORDER BY created_at DESC'),
  getContributionsByStatus: db.prepare('SELECT * FROM contributions WHERE status = ? ORDER BY created_at DESC LIMIT 50'),
  getRecentContributions: db.prepare('SELECT c.*, a.agent_name, a.owner_wallet FROM contributions c JOIN agents a ON c.agent_id = a.id ORDER BY c.created_at DESC LIMIT ?'),
  updateContributionStatus: db.prepare('UPDATE contributions SET status = ? WHERE id = ?'),
  incrementEndorsementCount: db.prepare('UPDATE contributions SET endorsement_count = endorsement_count + 1 WHERE id = ?'),

  // Endorsements
  insertEndorsement: db.prepare(`
    INSERT INTO endorsements (id, contribution_id, endorser_wallet, endorser_type, comment, signature, created_at)
    VALUES (@id, @contribution_id, @endorser_wallet, @endorser_type, @comment, @signature, @created_at)
  `),
  getEndorsementsByContribution: db.prepare('SELECT * FROM endorsements WHERE contribution_id = ? ORDER BY created_at DESC'),
  getEndorsementsByWallet: db.prepare('SELECT e.*, c.type as contribution_type, c.description as contribution_desc, a.agent_name FROM endorsements e JOIN contributions c ON e.contribution_id = c.id JOIN agents a ON c.agent_id = a.id WHERE e.endorser_wallet = ? ORDER BY e.created_at DESC LIMIT 50'),
  countEndorsementsByContribution: db.prepare('SELECT COUNT(*) as count FROM endorsements WHERE contribution_id = ?'),

  // Agent State
  upsertAgentState: db.prepare(`
    INSERT INTO agent_state (agent_id, context, updated_at) VALUES (@agent_id, @context, @updated_at)
    ON CONFLICT(agent_id) DO UPDATE SET context = @context, updated_at = @updated_at, last_activity = @updated_at
  `),
  getAgentState: db.prepare('SELECT * FROM agent_state WHERE agent_id = ?'),

  // Commitments
  insertCommitment: db.prepare(`
    INSERT INTO commitments (id, agent_id, commitment_hash, salt, created_at)
    VALUES (@id, @agent_id, @commitment_hash, @salt, @created_at)
  `),
  getCommitmentById: db.prepare('SELECT * FROM commitments WHERE id = ?'),
  getCommitmentsByAgent: db.prepare('SELECT * FROM commitments WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20'),
  revealCommitment: db.prepare('UPDATE commitments SET revealed = 1, reasoning = @reasoning, revealed_at = @revealed_at WHERE id = @id'),

  // Record Board
  insertRecord: db.prepare(`
    INSERT OR IGNORE INTO recorded_contributions (id, contribution_id, agent_id, content_hash, tx_hash, recorded_at)
    VALUES (@id, @contribution_id, @agent_id, @content_hash, @tx_hash, @recorded_at)
  `),
  getRecordByContribution: db.prepare('SELECT * FROM recorded_contributions WHERE contribution_id = ?'),
  getAllRecords: db.prepare('SELECT rc.*, c.type, c.description, a.agent_name FROM recorded_contributions rc JOIN contributions c ON rc.contribution_id = c.id JOIN agents a ON rc.agent_id = a.id ORDER BY rc.recorded_at DESC LIMIT ?'),

  // Bounties
  insertBounty: db.prepare(`
    INSERT INTO bounties (id, creator_wallet, title, description, bounty_type, amount_usdc, deadline, min_reputation, created_at, updated_at)
    VALUES (@id, @creator_wallet, @title, @description, @bounty_type, @amount_usdc, @deadline, @min_reputation, @created_at, @updated_at)
  `),
  getBountyById: db.prepare('SELECT * FROM bounties WHERE id = ?'),
  getOpenBounties: db.prepare('SELECT * FROM bounties WHERE status = ? ORDER BY created_at DESC LIMIT ?'),
  getAllBounties: db.prepare('SELECT * FROM bounties ORDER BY created_at DESC LIMIT 50'),
  getBountiesByCreator: db.prepare('SELECT * FROM bounties WHERE creator_wallet = ? ORDER BY created_at DESC'),
  getBountiesByAgent: db.prepare('SELECT * FROM bounties WHERE assigned_agent_id = ? ORDER BY created_at DESC'),
  updateBountyStatus: db.prepare('UPDATE bounties SET status = @status, updated_at = @updated_at WHERE id = @id'),
  assignBounty: db.prepare('UPDATE bounties SET assigned_agent_id = @agent_id, status = @status, updated_at = @updated_at WHERE id = @id'),
  completeBounty: db.prepare('UPDATE bounties SET contribution_id = @contribution_id, status = @status, updated_at = @updated_at WHERE id = @id'),

  // Escrow lifecycle
  updateBountyEscrow: db.prepare(`UPDATE bounties SET escrow_status = @escrow_status, escrow_budget_usdc = @escrow_budget_usdc, escrow_tx_hash = @escrow_tx_hash, expires_at = @expires_at, updated_at = @updated_at WHERE id = @id`),
  claimBountyEscrow: db.prepare(`UPDATE bounties SET provider_agent_id = @provider_agent_id, provider_wallet = @provider_wallet, escrow_status = 'claimed', status = 'assigned', claimed_at = @claimed_at, updated_at = @updated_at WHERE id = @id`),
  submitBountyDeliverable: db.prepare(`UPDATE bounties SET deliverable_hash = @deliverable_hash, deliverable_content = @deliverable_content, escrow_status = 'submitted', status = 'submitted', submitted_at = @submitted_at, updated_at = @updated_at WHERE id = @id`),
  clientReviewBounty: db.prepare(`UPDATE bounties SET client_decision = @client_decision, client_decision_at = @client_decision_at, escrow_status = @escrow_status, updated_at = @updated_at WHERE id = @id`),
  verifyBountyEscrow: db.prepare(`UPDATE bounties SET verifier_wallet = @verifier_wallet, verifier_decision = @verifier_decision, verifier_reason = @verifier_reason, escrow_status = @escrow_status, updated_at = @updated_at WHERE id = @id`),
  releaseBountyEscrow: db.prepare(`UPDATE bounties SET release_tx_hash = @release_tx_hash, escrow_status = 'released', status = 'completed', released_at = @released_at, updated_at = @updated_at WHERE id = @id`),
  refundBountyEscrow: db.prepare(`UPDATE bounties SET escrow_status = 'refunded', status = 'cancelled', updated_at = @updated_at WHERE id = @id`),
  incrementBountyRevision: db.prepare(`UPDATE bounties SET revision_count = revision_count + 1, escrow_status = 'claimed', deliverable_hash = NULL, deliverable_content = NULL, client_decision = NULL, client_decision_at = NULL, updated_at = @updated_at WHERE id = @id`),
  getFundedBounties: db.prepare("SELECT * FROM bounties WHERE escrow_status = 'funded' ORDER BY created_at DESC LIMIT ?"),
  getMarketplaceBounties: db.prepare("SELECT * FROM bounties WHERE escrow_status IN ('funded', 'none') AND status = 'open' ORDER BY escrow_budget_usdc DESC, created_at DESC LIMIT ?"),

  // Escrow events
  insertEscrowEvent: db.prepare(`INSERT INTO escrow_events (id, bounty_id, event_type, actor_wallet, actor_type, details, tx_hash, created_at) VALUES (@id, @bounty_id, @event_type, @actor_wallet, @actor_type, @details, @tx_hash, @created_at)`),
  getEscrowEvents: db.prepare('SELECT * FROM escrow_events WHERE bounty_id = ? ORDER BY created_at ASC'),

  // Verification decisions
  insertVerificationDecision: db.prepare(`INSERT INTO verification_decisions (id, bounty_id, verifier_wallet, verifier_type, decision, reasoning, reasoning_hash, stage, tx_hash, created_at) VALUES (@id, @bounty_id, @verifier_wallet, @verifier_type, @decision, @reasoning, @reasoning_hash, @stage, @tx_hash, @created_at)`),
  getVerificationDecisions: db.prepare('SELECT * FROM verification_decisions WHERE bounty_id = ? ORDER BY created_at DESC'),

  // Agent skills
  insertAgentSkill: db.prepare(`INSERT INTO agent_skills (id, agent_id, skill_name, category, description, keywords, hourly_rate_usdc, fixed_rate_usdc, status, created_at) VALUES (@id, @agent_id, @skill_name, @category, @description, @keywords, @hourly_rate_usdc, @fixed_rate_usdc, @status, @created_at)`),
  getAgentSkills: db.prepare('SELECT * FROM agent_skills WHERE agent_id = ? AND status = ? ORDER BY created_at DESC'),
  getSkillById: db.prepare('SELECT * FROM agent_skills WHERE id = ?'),
  updateAgentSkill: db.prepare(`UPDATE agent_skills SET skill_name = @skill_name, category = @category, description = @description, keywords = @keywords, hourly_rate_usdc = @hourly_rate_usdc, fixed_rate_usdc = @fixed_rate_usdc, status = @status WHERE id = @id`),
  deleteAgentSkill: db.prepare('DELETE FROM agent_skills WHERE id = ? AND agent_id = ?'),
  searchSkills: db.prepare("SELECT s.*, a.agent_name, a.agent_type, a.reputation_score, a.status as agent_status FROM agent_skills s JOIN agents a ON s.agent_id = a.id WHERE s.status = 'active' AND a.status = 'active' ORDER BY a.reputation_score DESC LIMIT ?"),
  searchSkillsByCategory: db.prepare("SELECT s.*, a.agent_name, a.agent_type, a.reputation_score, a.status as agent_status FROM agent_skills s JOIN agents a ON s.agent_id = a.id WHERE s.status = 'active' AND a.status = 'active' AND s.category = ? ORDER BY a.reputation_score DESC LIMIT ?"),
  incrementSkillCompletions: db.prepare('UPDATE agent_skills SET total_completions = total_completions + 1, total_earned_usdc = total_earned_usdc + ? WHERE agent_id = ? AND status = ?'),

  // Auth
  insertChallenge: db.prepare(`
    INSERT INTO auth_challenges (id, agent_id, nonce, message, scope, expires_at, created_at)
    VALUES (@id, @agent_id, @nonce, @message, @scope, @expires_at, @created_at)
  `),
  getChallenge: db.prepare('SELECT * FROM auth_challenges WHERE id = ?'),
  markChallengeUsed: db.prepare('UPDATE auth_challenges SET used = 1 WHERE id = ?'),
  insertAuthToken: db.prepare(`
    INSERT INTO auth_tokens (id, agent_id, wallet, scope, expires_at, created_at)
    VALUES (@id, @agent_id, @wallet, @scope, @expires_at, @created_at)
  `),
  getAuthToken: db.prepare('SELECT * FROM auth_tokens WHERE id = ?'),
  revokeAuthToken: db.prepare('UPDATE auth_tokens SET revoked = 1 WHERE id = ?'),
  getTokensByAgent: db.prepare('SELECT * FROM auth_tokens WHERE agent_id = ? AND revoked = 0 ORDER BY created_at DESC'),
};

// ── Helper: row → frontend format ──
function profileToJSON(row) {
  if (!row) return null;
  return {
    wallet: row.wallet, username: row.username, displayName: row.display_name,
    bio: row.bio, profileType: row.profile_type,
    ecosystems: JSON.parse(row.ecosystems || '[]'),
    farcaster: row.farcaster || '', github: row.github || '',
    x: row.x || '', discord: row.discord || '', linkedin: row.linkedin || '',
    pfp: row.pfp || '',
    createdAt: row.created_at,
  };
}

function proofToJSON(row) {
  return {
    id: row.id, title: row.title, ecosystem: row.ecosystem,
    contributionType: row.contribution_type, description: row.description,
    externalLinks: JSON.parse(row.external_links || '[]'),
    contributor: row.contributor, status: row.status, timestamp: row.timestamp,
  };
}

function portfolioToJSON(row) {
  return {
    id: row.id, wallet: row.wallet, title: row.title,
    description: row.description, category: row.category,
    imageDataURI: row.image_url || undefined,
    externalLink: row.external_link || undefined,
    tags: JSON.parse(row.tags || '[]'),
    createdAt: row.created_at, order: row.sort_order,
  };
}

function notifToJSON(row) {
  return {
    id: row.id, wallet: row.wallet, type: row.type,
    title: row.title, message: row.message,
    from: row.sender, amount: row.amount,
    read: !!row.read, createdAt: row.created_at,
  };
}

// ── Notification Creator ──
// Creates a notification for a wallet address (human) or agent.
// If agentId is given, looks up the linked human wallet to also notify them.
function createNotification({ wallet, agentId, type, title, message, from, amount }) {
  const id = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const targets = new Set();

  // Direct wallet target
  if (wallet) targets.add(wallet.toLowerCase());

  // Agent target — notify via owner_wallet
  if (agentId) {
    const agent = stmts.getAgentById.get(agentId);
    if (agent?.owner_wallet) targets.add(agent.owner_wallet.toLowerCase());
  }

  for (const target of targets) {
    try {
      stmts.insertNotification.run({
        id: `${id}-${target.slice(0, 8)}`,
        wallet: target,
        type: type || 'system',
        title: title || '',
        message: message || '',
        sender: from || '',
        amount: amount || '',
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`Notification insert failed for ${target}:`, err.message);
    }
  }
}

function agentToJSON(row) {
  if (!row) return null;
  return {
    id: row.id, ownerWallet: row.owner_wallet, agentName: row.agent_name,
    agentPublicKey: row.agent_public_key, agentType: row.agent_type,
    description: row.description, reputationScore: row.reputation_score,
    totalContributions: row.total_contributions, totalEndorsements: row.total_endorsements,
    status: row.status, createdAt: row.created_at,
    // Phase v2 fields
    specializations: row.specializations ? JSON.parse(row.specializations) : [],
    hourlyRateUsdc: row.hourly_rate_usdc || 0,
    availability: row.availability || 'available',
    lastActiveAt: row.last_active_at || null,
    totalEarnedUsdc: row.total_earned_usdc || 0,
    successRate: row.success_rate || 0,
    // Turnkey wallet
    turnkeyWalletId: row.turnkey_wallet_id || null,
    turnkeyAddress: row.turnkey_address || null,
    // ERC-8004 identity
    erc8004MetadataUri: row.erc8004_metadata_uri || null,
    erc8004TxHash: row.erc8004_tx_hash || null,
    erc8004MintedAt: row.erc8004_minted_at || null,
  };
}

function contributionToJSON(row) {
  if (!row) return null;
  return {
    id: row.id, agentId: row.agent_id, type: row.type,
    description: row.description, proofHash: row.proof_hash,
    proofData: row.proof_data ? JSON.parse(row.proof_data || '{}') : {},
    signature: row.signature, status: row.status,
    endorsementCount: row.endorsement_count,
    agentName: row.agent_name || undefined,
    ownerWallet: row.owner_wallet || undefined,
    createdAt: row.created_at,
  };
}

function endorsementToJSON(row) {
  return {
    id: row.id, contributionId: row.contribution_id,
    endorserWallet: row.endorser_wallet, endorserType: row.endorser_type,
    comment: row.comment, signature: row.signature,
    contributionType: row.contribution_type || undefined,
    contributionDesc: row.contribution_desc || undefined,
    agentName: row.agent_name || undefined,
    createdAt: row.created_at,
  };
}

// ── Reputation Tiers ──
function getTier(score) {
  if (score >= 85) return { tier: 'Elite', level: 4 };
  if (score >= 60) return { tier: 'Trusted', level: 3 };
  if (score >= 30) return { tier: 'Established', level: 2 };
  if (score >= 10) return { tier: 'Contributor', level: 1 };
  return { tier: 'Newcomer', level: 0 };
}

// ── Reputation Calculation ──
function calculateReputation(agentId) {
  const contributions = stmts.getContributionsByAgent.all(agentId);
  const verified = contributions.filter(c => c.status === 'verified').length;
  const pending = contributions.filter(c => c.status === 'pending').length;
  const rejected = contributions.filter(c => c.status === 'rejected').length;
  let totalEndorsements = 0;
  for (const c of contributions) {
    totalEndorsements += c.endorsement_count || 0;
  }

  const agent = stmts.getAgentById.get(agentId);
  const ageInDays = agent ? (Date.now() - new Date(agent.created_at).getTime()) / (1000 * 60 * 60 * 24) : 0;
  const timeDecay = Math.max(0, Math.floor(ageInDays * 0.1));

  const score = Math.max(0, Math.min(100,
    (verified * 10) +
    (pending * 2) +
    (totalEndorsements * 3) -
    (rejected * 5) -
    timeDecay
  ));

  const { tier, level } = getTier(score);
  stmts.updateAgentReputation.run(score, contributions.length, totalEndorsements, agentId);
  return { score, tier, level, totalContributions: contributions.length, totalEndorsements, verified, pending, rejected };
}

// ── SSE Live Feed ──
const feedEmitter = new EventEmitter();
feedEmitter.setMaxListeners(100);

function emitFeedEvent(type, data) {
  feedEmitter.emit('update', { type, data, timestamp: new Date().toISOString() });
}

// ── JWT Auth ──
const JWT_SECRET = process.env.JWT_SECRET || createHash('sha256').update('bard-dev-' + (process.env.SELLER_ADDRESS || 'local')).digest('hex');
const JWT_EXPIRY = '7d';

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header required. Use: Bearer <token>' });
  }
  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Check if token is revoked
    const tokenRecord = stmts.getAuthToken.get(decoded.jti);
    if (tokenRecord && tokenRecord.revoked) {
      return res.status(401).json({ error: 'Token has been revoked' });
    }
    decoded.agentId = decoded.agentId || decoded.sub;
    req.auth = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ══════════════════════════════════════════════════════
// ── Circle Gateway x402 Nanopayments ──
// ══════════════════════════════════════════════════════

let gateway;
try {
  gateway = createGatewayMiddleware({
    sellerAddress: SELLER_ADDRESS,
    facilitatorUrl: 'https://gateway-api-testnet.circle.com',
  });
  console.log(`  x402 Gateway: enabled (seller: ${SELLER_ADDRESS.slice(0, 8)}...)`);
} catch (err) {
  console.warn(`  x402 Gateway: disabled (${err.message})`);
  gateway = null;
}

// Helper: log payment to SQLite
function logPayment(req, endpoint) {
  if (req.payment) {
    const { payer, amount, network, transaction } = req.payment;
    const formattedAmount = formatUnits(BigInt(amount), 6);
    console.log(`  Payment: ${formattedAmount} USDC from ${payer.slice(0, 8)}... on ${network}`);
    try {
      stmts.insertPayment.run({
        payer, amount: formattedAmount, network, endpoint,
        transaction_id: transaction || '',
        created_at: new Date().toISOString(),
      });
    } catch (e) { /* non-critical */ }
  }
}

// ══════════════════════════════════════════════════════
// ── Multer config ──
// ══════════════════════════════════════════════════════

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB (videos up to 25MB)

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Detect type from URL: /api/upload/pfp, /api/upload/portfolio, /api/upload/proof
    const urlType = req.originalUrl.split('/api/upload/')[1]?.split('?')[0] || '';
    const type = req.params.type || urlType || 'portfolio';
    const dir = path.join(UPLOADS_DIR, type);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const wallet = (req.body.wallet || 'unknown').toLowerCase().slice(0, 12);
    const ext = path.extname(file.originalname) || '.png';
    const unique = `${wallet}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, unique);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = /\.(jpg|jpeg|png|gif|webp|mp4|webm|svg)$/i;
  if (allowed.test(path.extname(file.originalname))) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type'), false);
  }
};

const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE } });

// ══════════════════════════════════════════════════════
// ── Routes: Health ──
// ══════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  const profileCount = db.prepare('SELECT COUNT(*) as count FROM profiles').get().count;
  const paymentStats = stmts.getPaymentStats.get();
  res.json({
    status: 'ok', uptime: process.uptime(), profiles: profileCount, db: 'sqlite',
    x402: !!gateway, sellerAddress: SELLER_ADDRESS,
    payments: { total: paymentStats.total_payments, volumeUSDC: paymentStats.total_amount },
  });
});

// ══════════════════════════════════════════════════════
// ── Routes: x402 Premium Endpoints ──
// ══════════════════════════════════════════════════════

// Premium: Full trust analytics for a contributor
if (gateway) {
  app.get('/api/premium/trust-report/:wallet', gateway.require('$0.01'), (req, res) => {
    logPayment(req, '/api/premium/trust-report');
    const wallet = req.params.wallet;
    const profile = profileToJSON(stmts.getProfileByWallet.get(wallet));
    const proofs = stmts.getProofsByWallet.all(wallet).map(proofToJSON);
    const portfolio = stmts.getPortfolioByWallet.all(wallet).map(portfolioToJSON);

    // Compute trust metrics
    const validatedProofs = proofs.filter(p => p.status === 'validated').length;
    const ecosystems = [...new Set(proofs.map(p => p.ecosystem).filter(Boolean))];
    const trustScore = Math.min(100, (validatedProofs * 15) + (proofs.length * 5) + (portfolio.length * 3));

    res.json({
      report: {
        profile, proofs, portfolio,
        metrics: {
          trustScore,
          totalProofs: proofs.length,
          validatedProofs,
          portfolioItems: portfolio.length,
          ecosystems,
          memberSince: profile?.createdAt,
        },
      },
      paid_by: req.payment?.payer,
    });
  });

  // Premium: Platform-wide leaderboard with full analytics
  app.get('/api/premium/leaderboard', gateway.require('$0.01'), (req, res) => {
    logPayment(req, '/api/premium/leaderboard');
    const profiles = stmts.getAllProfiles.all().map(row => {
      const p = profileToJSON(row);
      const proofs = stmts.getProofsByWallet.all(row.wallet);
      const portfolio = stmts.getPortfolioByWallet.all(row.wallet);
      const validatedProofs = proofs.filter(pr => pr.status === 'validated').length;
      return {
        ...p,
        stats: {
          proofs: proofs.length,
          validatedProofs,
          portfolioItems: portfolio.length,
          trustScore: Math.min(100, (validatedProofs * 15) + (proofs.length * 5) + (portfolio.length * 3)),
        },
      };
    });

    profiles.sort((a, b) => b.stats.trustScore - a.stats.trustScore);
    res.json({ leaderboard: profiles, total: profiles.length, paid_by: req.payment?.payer });
  });

  // Premium: Export full profile data as JSON
  app.get('/api/premium/export/:wallet', gateway.require('$0.005'), (req, res) => {
    logPayment(req, '/api/premium/export');
    const wallet = req.params.wallet;
    const profile = profileToJSON(stmts.getProfileByWallet.get(wallet));
    const proofs = stmts.getProofsByWallet.all(wallet).map(proofToJSON);
    const portfolio = stmts.getPortfolioByWallet.all(wallet).map(portfolioToJSON);
    const notifications = stmts.getNotificationsByWallet.all(wallet).map(notifToJSON);

    res.json({
      export: { profile, proofs, portfolio, notifications, exportedAt: new Date().toISOString() },
      paid_by: req.payment?.payer,
    });
  });
}

// ── Payment info endpoint (free) ──
app.get('/api/x402/info', (req, res) => {
  res.json({
    enabled: !!gateway,
    seller: SELLER_ADDRESS,
    network: 'Arc Testnet (eip155:5042002)',
    currency: 'USDC',
    endpoints: [
      { path: '/api/premium/trust-report/:wallet', price: '$0.01', description: 'Full trust analytics report for a contributor' },
      { path: '/api/premium/leaderboard', price: '$0.01', description: 'Platform-wide trust leaderboard with analytics' },
      { path: '/api/premium/export/:wallet', price: '$0.005', description: 'Export full profile data as JSON' },
    ],
  });
});

// ══════════════════════════════════════════════════════
// ── Routes: Profiles ──
// ══════════════════════════════════════════════════════

app.post('/api/profiles', (req, res) => {
  const p = req.body;
  if (!p.wallet || !p.username) return res.status(400).json({ error: 'wallet and username required' });
  try {
    stmts.upsertProfile.run({
      wallet: p.wallet, username: p.username,
      display_name: p.displayName || '', bio: p.bio || '',
      profile_type: p.profileType || 'human',
      ecosystems: JSON.stringify(p.ecosystems || []),
      farcaster: p.farcaster || '', github: p.github || '',
      x: p.x || '', discord: p.discord || '', linkedin: p.linkedin || '',
      pfp: p.pfp || '',
      created_at: p.createdAt || new Date().toISOString(),
    });
    const saved = stmts.getProfileByWallet.get(p.wallet);
    res.json({ success: true, profile: profileToJSON(saved) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/profiles/wallet/:wallet', (req, res) => {
  const row = stmts.getProfileByWallet.get(req.params.wallet);
  res.json({ profile: profileToJSON(row) });
});

app.get('/api/profiles/username/:username', (req, res) => {
  const row = stmts.getProfileByUsername.get(req.params.username);
  res.json({ profile: profileToJSON(row) });
});

app.get('/api/profiles', (req, res) => {
  const rows = stmts.getAllProfiles.all();
  res.json({ profiles: rows.map(profileToJSON) });
});

// ══════════════════════════════════════════════════════
// ── Routes: Proofs ──
// ══════════════════════════════════════════════════════

app.post('/api/proofs', (req, res) => {
  const p = req.body;
  if (!p.id || !p.contributor) return res.status(400).json({ error: 'id and contributor required' });
  try {
    stmts.insertProof.run({
      id: p.id, title: p.title || '', ecosystem: p.ecosystem || '',
      contribution_type: p.contributionType || '', description: p.description || '',
      external_links: JSON.stringify(p.externalLinks || []),
      contributor: p.contributor, status: p.status || 'unvalidated',
      timestamp: p.timestamp || new Date().toISOString(),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/proofs/:wallet', (req, res) => {
  const rows = stmts.getProofsByWallet.all(req.params.wallet);
  res.json({ proofs: rows.map(proofToJSON) });
});

// ══════════════════════════════════════════════════════
// ── Routes: Portfolio ──
// ══════════════════════════════════════════════════════

app.post('/api/portfolio', (req, res) => {
  const p = req.body;
  if (!p.id || !p.wallet) return res.status(400).json({ error: 'id and wallet required' });
  try {
    stmts.insertPortfolio.run({
      id: p.id, wallet: p.wallet, title: p.title || '',
      description: p.description || '', category: p.category || 'other',
      image_url: p.imageDataURI || '', external_link: p.externalLink || '',
      tags: JSON.stringify(p.tags || []),
      created_at: p.createdAt || new Date().toISOString(),
      sort_order: p.order || 0,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/portfolio/:wallet', (req, res) => {
  const rows = stmts.getPortfolioByWallet.all(req.params.wallet);
  res.json({ portfolio: rows.map(portfolioToJSON) });
});

app.delete('/api/portfolio/:id', (req, res) => {
  const result = stmts.deletePortfolio.run(req.params.id);
  res.json({ success: true, deleted: result.changes > 0 });
});

app.put('/api/portfolio/reorder', (req, res) => {
  const { wallet, orderedIds } = req.body;
  if (!wallet || !orderedIds) return res.status(400).json({ error: 'wallet and orderedIds required' });
  const updateMany = db.transaction(() => {
    orderedIds.forEach((id, idx) => { stmts.updatePortfolioOrder.run(idx, id); });
  });
  updateMany();
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════
// ── Routes: Notifications ──
// ══════════════════════════════════════════════════════

app.post('/api/notifications', (req, res) => {
  const n = req.body;
  if (!n.wallet) return res.status(400).json({ error: 'wallet required' });
  const id = n.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    stmts.insertNotification.run({
      id, wallet: n.wallet, type: n.type || 'system',
      title: n.title || '', message: n.message || '',
      sender: n.from || '', amount: n.amount || '',
      created_at: new Date().toISOString(),
    });
    res.json({ success: true, notification: { id } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/notifications/:wallet', (req, res) => {
  const rows = stmts.getNotificationsByWallet.all(req.params.wallet);
  res.json({ notifications: rows.map(notifToJSON) });
});

app.put('/api/notifications/:id/read', (req, res) => {
  stmts.markRead.run(req.params.id);
  res.json({ success: true });
});

app.put('/api/notifications/:wallet/read-all', (req, res) => {
  stmts.markAllRead.run(req.params.wallet);
  res.json({ success: true });
});

// ── Agent Notifications ──
// Agents can read notifications addressed to their owner wallet (which includes cross-entity notifs).
app.get('/api/agents/:id/notifications', requireAuth, (req, res) => {
  try {
    if (req.auth.agentId !== req.params.id) {
      return res.status(403).json({ error: 'Can only read your own notifications' });
    }
    const agent = stmts.getAgentById.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const wallets = new Set();
    if (agent.owner_wallet) wallets.add(agent.owner_wallet.toLowerCase());

    let allNotifs = [];
    for (const w of wallets) {
      const rows = stmts.getNotificationsByWallet.all(w);
      allNotifs.push(...rows.map(notifToJSON));
    }

    // Deduplicate by id and sort newest first
    const seen = new Set();
    allNotifs = allNotifs.filter(n => {
      if (seen.has(n.id)) return false;
      seen.add(n.id);
      return true;
    }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const limit = parseInt(req.query.limit) || 20;
    res.json({
      notifications: allNotifs.slice(0, limit),
      unread: allNotifs.filter(n => !n.read).length,
      total: allNotifs.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// ── Routes: File Uploads ──
// ══════════════════════════════════════════════════════

app.post('/api/upload/portfolio', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `${req.protocol}://${req.get('host')}/uploads/portfolio/${req.file.filename}`;
  res.json({ success: true, url, filename: req.file.filename, size: req.file.size, mimetype: req.file.mimetype });
});

app.post('/api/upload/pfp', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `${req.protocol}://${req.get('host')}/uploads/pfp/${req.file.filename}`;
  res.json({ success: true, url, filename: req.file.filename, size: req.file.size, mimetype: req.file.mimetype });
});

app.post('/api/upload/proof', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const wallet = (req.body.wallet || '').toLowerCase();
  const isVideo = req.file.mimetype.startsWith('video/');

  // Enforce 3-video limit per account
  let deletedOldest = null;
  if (isVideo && wallet) {
    const MAX_VIDEOS = 3;
    const walletVideos = db.prepare(
      "SELECT id, file_url, timestamp FROM proofs WHERE contributor = ? COLLATE NOCASE AND file_url != '' AND (file_url LIKE '%.mp4' OR file_url LIKE '%.webm' OR file_url LIKE '%.mov' OR file_url LIKE '%.avi' OR file_url LIKE '%.mkv') ORDER BY timestamp ASC"
    ).all(wallet);

    if (walletVideos.length >= MAX_VIDEOS) {
      // Delete the oldest video file from disk, keep the proof record
      const oldest = walletVideos[0];
      if (oldest.file_url) {
        const filename = oldest.file_url.split('/').pop();
        const filePath = path.join(UPLOADS_DIR, 'portfolio', filename);
        try { fs.unlinkSync(filePath); } catch { /* file may already be gone */ }
        // Clear the file_url but keep the proof post
        db.prepare("UPDATE proofs SET file_url = '' WHERE id = ?").run(oldest.id);
        deletedOldest = { proofId: oldest.id, removedFile: oldest.file_url };
      }
    }
  }

  const url = `${req.protocol}://${req.get('host')}/uploads/portfolio/${req.file.filename}`;
  res.json({ success: true, url, filename: req.file.filename, size: req.file.size, mimetype: req.file.mimetype, deletedOldest });
});

// Agent proxy: upload proof on behalf of linked human
app.post('/api/agents/:id/upload-proof', requireAuth, upload.single('file'), async (req, res) => {
  try {
    // Verify the calling agent
    if (req.auth.agentId !== req.params.id) {
      return res.status(403).json({ error: 'You can only upload proofs for your own agent.' });
    }

    const agent = stmts.getAgentById.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Must be linked to a human
    if (!isLinkedToHuman(agent)) {
      return res.status(403).json({ error: 'Agent must be linked to a human profile to upload proofs on their behalf.' });
    }

    const { title, ecosystem, contributionType, description, externalLinks } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    let fileUrl = null;
    if (req.file) {
      // Reject videos over 25MB
      if (req.file.mimetype.startsWith('video/') && req.file.size > 25 * 1024 * 1024) {
        try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(400).json({ error: 'Video must be under 25MB' });
      }

      // Enforce 3-video limit for the human's account
      const humanWallet = agent.owner_wallet.toLowerCase();
      if (req.file.mimetype.startsWith('video/')) {
        const walletVideos = db.prepare(
          "SELECT id, file_url FROM proofs WHERE contributor = ? COLLATE NOCASE AND file_url != '' AND (file_url LIKE '%.mp4' OR file_url LIKE '%.webm' OR file_url LIKE '%.mov' OR file_url LIKE '%.avi' OR file_url LIKE '%.mkv') ORDER BY timestamp ASC"
        ).all(humanWallet);
        if (walletVideos.length >= 3) {
          const oldest = walletVideos[0];
          const filename = oldest.file_url.split('/').pop();
          try { fs.unlinkSync(path.join(UPLOADS_DIR, 'portfolio', filename)); } catch {}
          db.prepare("UPDATE proofs SET file_url = '' WHERE id = ?").run(oldest.id);
        }

        // Also enforce 3-video limit per agent (submitted_by)
        const agentVideos = db.prepare(
          "SELECT id, file_url FROM proofs WHERE submitted_by = ? AND file_url != '' AND (file_url LIKE '%.mp4' OR file_url LIKE '%.webm' OR file_url LIKE '%.mov' OR file_url LIKE '%.avi' OR file_url LIKE '%.mkv') ORDER BY timestamp ASC"
        ).all(agent.id);
        if (agentVideos.length >= 3) {
          const oldest = agentVideos[0];
          const filename = oldest.file_url.split('/').pop();
          try { fs.unlinkSync(path.join(UPLOADS_DIR, 'portfolio', filename)); } catch {}
          db.prepare("UPDATE proofs SET file_url = '' WHERE id = ?").run(oldest.id);
        }
      }
      fileUrl = `${req.protocol}://${req.get('host')}/uploads/portfolio/${req.file.filename}`;
    }

    // Save proof to the human's profile
    const proofId = `proof-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const proof = {
      id: proofId,
      wallet: agent.owner_wallet.toLowerCase(),
      title,
      ecosystem: ecosystem || '',
      contributionType: contributionType || 'other',
      description: description || '',
      externalLinks: externalLinks || '',
      fileUrl,
      submittedBy: agent.id,
      submittedByName: agent.agent_name,
      createdAt: new Date().toISOString(),
    };

    // Store in proofs table
    try {
      db.prepare(`INSERT INTO proofs (id, title, ecosystem, contribution_type, description, external_links, file_url, contributor, submitted_by, status, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unvalidated', ?)`).run(
        proof.id, proof.title, proof.ecosystem,
        proof.contributionType, proof.description, proof.externalLinks,
        proof.fileUrl || '', proof.wallet, proof.submittedBy, proof.createdAt
      );
    } catch (err) {
      // If columns are missing (old schema), try adding them
      try {
        db.prepare('ALTER TABLE proofs ADD COLUMN file_url TEXT DEFAULT ""').run();
        db.prepare('ALTER TABLE proofs ADD COLUMN submitted_by TEXT DEFAULT ""').run();
      } catch { /* columns may already exist */ }
      db.prepare(`INSERT INTO proofs (id, title, ecosystem, contribution_type, description, external_links, file_url, contributor, submitted_by, status, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unvalidated', ?)`).run(
        proof.id, proof.title, proof.ecosystem,
        proof.contributionType, proof.description, proof.externalLinks,
        proof.fileUrl || '', proof.wallet, proof.submittedBy, proof.createdAt
      );
    }

    emitFeedEvent('proof:submitted', { ...proof, agentName: agent.agent_name });
    res.json({ success: true, proof });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/files/:wallet', (req, res) => {
  const wallet = req.params.wallet.toLowerCase().slice(0, 12);
  const dir = path.join(UPLOADS_DIR, 'portfolio');
  if (!fs.existsSync(dir)) return res.json({ files: [] });
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith(wallet))
    .map(f => ({
      filename: f,
      url: `${req.protocol}://${req.get('host')}/uploads/portfolio/${f}`,
      size: fs.statSync(path.join(dir, f)).size,
    }));
  res.json({ files });
});

app.delete('/api/files/:type/:filename', (req, res) => {
  const { type, filename } = req.params;
  if (!['portfolio', 'pfp'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  const filePath = path.join(UPLOADS_DIR, type, filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// ══════════════════════════════════════════════════════
// ── Routes: Agent Reputation System ──
// ══════════════════════════════════════════════════════

// Register a new agent (owner signs with wallet)
app.post('/api/agents/register', (req, res) => {
  const { ownerWallet, agentName, agentPublicKey, agentType, description } = req.body;
  if (!ownerWallet || !agentName || !agentPublicKey) {
    return res.status(400).json({ error: 'ownerWallet, agentName, and agentPublicKey required' });
  }
  const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    stmts.insertAgent.run({
      id, owner_wallet: ownerWallet, agent_name: agentName,
      agent_public_key: agentPublicKey, agent_type: agentType || 'general',
      description: description || '', created_at: new Date().toISOString(),
    });
    // Initialize agent state
    stmts.upsertAgentState.run({
      agent_id: id, context: JSON.stringify({ initialized: true }),
      updated_at: new Date().toISOString(),
    });
    const saved = stmts.getAgentById.get(id);
    emitFeedEvent('agent:registered', agentToJSON(saved));
    createNotification({ wallet: ownerWallet, type: 'system', title: 'Agent Registered', message: `${agentName} has been registered on BARD.`, from: 'BARD System' });

    const tokenId = `tok-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const scope = 'agent:full';
    const token = jwt.sign({
      sub: id,
      wallet: ownerWallet.toLowerCase(),
      scope,
      agentName,
      jti: tokenId,
    }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

    stmts.insertAuthToken.run({
      id: tokenId,
      agent_id: id,
      wallet: ownerWallet.toLowerCase(),
      scope,
      expires_at: expiresAt,
      created_at: new Date().toISOString(),
    });

    res.json({
      success: true,
      agent: agentToJSON(saved),
      token,
      tokenId,
      agentId: id,
      agentName,
      scope,
      expiresAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get agents by owner wallet (must be before :id)
app.get('/api/agents/owner/:wallet', (req, res) => {
  const agents = stmts.getAgentsByOwner.all(req.params.wallet);
  res.json({ agents: agents.map(agentToJSON) });
});

// Search agents (marketplace) — must be before :id
app.get('/api/agents/search', (req, res) => {
  const { q, specialization, min_reputation, availability } = req.query;
  let sql = "SELECT * FROM agents WHERE status = 'active'";
  const params = [];

  if (q) { sql += " AND (agent_name LIKE ? OR description LIKE ?)"; params.push(`%${q}%`, `%${q}%`); }
  if (specialization) { sql += " AND specializations LIKE ?"; params.push(`%${specialization}%`); }
  if (min_reputation) { sql += ' AND reputation_score >= ?'; params.push(parseInt(min_reputation)); }
  if (availability) { sql += ' AND availability = ?'; params.push(availability); }

  sql += ' ORDER BY reputation_score DESC LIMIT 50';
  const agents = db.prepare(sql).all(...params);
  res.json({ agents: agents.map(agentToJSON), count: agents.length });
});

// Featured agents — must be before :id
app.get('/api/agents/featured', (req, res) => {
  const agents = db.prepare(
    "SELECT * FROM agents WHERE status = 'active' AND reputation_score > 0 ORDER BY reputation_score DESC, total_contributions DESC LIMIT 10"
  ).all();
  res.json({ agents: agents.map(agentToJSON) });
});

// Get agent by ID
app.get('/api/agents/:id', (req, res) => {
  const agent = stmts.getAgentById.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const reputation = calculateReputation(req.params.id);
  res.json({ agent: agentToJSON(agent), reputation });
});

// Get all active agents (leaderboard)
app.get('/api/agents', (req, res) => {
  const { status, specialization, min_reputation, availability, sort } = req.query;
  let sql = 'SELECT * FROM agents WHERE 1=1';
  const params = [];

  if (status) { sql += ' AND status = ?'; params.push(status); }
  else { sql += " AND status = 'active'"; }

  if (availability) { sql += ' AND availability = ?'; params.push(availability); }
  if (min_reputation) { sql += ' AND reputation_score >= ?'; params.push(parseInt(min_reputation)); }
  if (specialization) { sql += " AND specializations LIKE '%" + specialization.replace(/'/g, '') + "%'"; }

  if (sort === 'reputation') sql += ' ORDER BY reputation_score DESC';
  else if (sort === 'earned') sql += ' ORDER BY total_earned_usdc DESC';
  else if (sort === 'recent') sql += ' ORDER BY created_at DESC';
  else sql += ' ORDER BY reputation_score DESC';

  const agents = db.prepare(sql).all(...params);
  res.json({ agents: agents.map(agentToJSON) });
});

// Update agent specializations
app.patch('/api/agents/:id/specializations', (req, res) => {
  const { specializations } = req.body;
  if (!Array.isArray(specializations)) return res.status(400).json({ error: 'specializations must be an array' });
  const valid = ['research', 'code_review', 'data_analysis', 'content', 'verification', 'moderation', 'trading', 'other'];
  const filtered = specializations.filter(s => valid.includes(s));
  db.prepare('UPDATE agents SET specializations = ? WHERE id = ?').run(JSON.stringify(filtered), req.params.id);
  res.json({ specializations: filtered });
});

// Update agent availability
app.patch('/api/agents/:id/availability', (req, res) => {
  const { availability } = req.body;
  const valid = ['available', 'busy', 'offline', 'dormant'];
  if (!valid.includes(availability)) return res.status(400).json({ error: `Must be: ${valid.join(', ')}` });
  db.prepare('UPDATE agents SET availability = ? WHERE id = ?').run(availability, req.params.id);
  res.json({ availability });
});

// ── Agent-to-Human Linking (Token-Based) ──

// Helper: Check if an agent is genuinely linked to a human profile
// (as opposed to just having its own Turnkey wallet as owner_wallet)
function isLinkedToHuman(agent) {
  const w = agent.owner_wallet?.toLowerCase();
  if (!w || w === '0x0') return false;
  // If owner_wallet matches the agent's own public key → self-registered, not linked
  if (w === agent.agent_public_key?.toLowerCase()) return false;
  // If owner_wallet matches the agent's Turnkey address → self-owned wallet, not linked
  if (w === agent.turnkey_address?.toLowerCase()) return false;
  // Otherwise it's a real human wallet link
  return true;
}

// Step 1: Agent generates a link token (called via MCP/CLI with agent auth)
app.post('/api/agents/:id/generate-link-token', requireAuth, (req, res) => {
  // Only the authenticated agent can generate its own link token
  if (req.auth.agentId !== req.params.id) {
    return res.status(403).json({ error: 'You can only generate link tokens for your own agent.' });
  }

  const agent = stmts.getAgentById.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  // Prevent re-linking if already linked to a real human profile
  if (isLinkedToHuman(agent)) {
    return res.status(409).json({
      error: 'Agent is already linked to a human profile. Unlink first to generate a new token.',
      ownerWallet: agent.owner_wallet.slice(0, 8) + '...',
    });
  }

  // Generate a short-lived JWT link token (15 minutes)
  const linkToken = jwt.sign({
    purpose: 'agent-link',
    agentId: agent.id,
    agentName: agent.agent_name,
    iat: Math.floor(Date.now() / 1000),
  }, JWT_SECRET, { expiresIn: '15m' });

  res.json({
    success: true,
    linkToken,
    agentId: agent.id,
    agentName: agent.agent_name,
    expiresIn: '15 minutes',
    instruction: 'Paste this token into your BARD profile to link this agent to your wallet.',
  });
});

// Step 2: Human pastes the link token to claim the agent
app.post('/api/agents/link', (req, res) => {
  const linkToken = req.body?.linkToken;
  const ownerWallet = req.body?.ownerWallet;
  if (!linkToken || !ownerWallet) return res.status(400).json({ error: 'linkToken and ownerWallet required' });

  // Validate wallet address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(ownerWallet)) {
    return res.status(400).json({ error: 'Invalid wallet address format' });
  }

  // Verify the JWT
  let decoded;
  try {
    decoded = jwt.verify(linkToken, JWT_SECRET);
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Link token expired. Generate a new one from your agent.' });
    return res.status(401).json({ error: 'Invalid link token' });
  }

  if (decoded.purpose !== 'agent-link') return res.status(400).json({ error: 'Invalid token type' });
  if (!decoded.agentId) return res.status(400).json({ error: 'Malformed link token — missing agentId' });

  const agent = stmts.getAgentById.get(decoded.agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  // Already linked to this wallet — idempotent success
  if (agent.owner_wallet && agent.owner_wallet.toLowerCase() === ownerWallet.toLowerCase()) {
    return res.json({ success: true, agent: agentToJSON(agent), message: 'Already linked' });
  }

  // Block takeover: if agent is already linked to a DIFFERENT human wallet, reject
  if (isLinkedToHuman(agent)) {
    return res.status(403).json({
      error: 'Agent is already linked to another profile. The agent must unlink first.',
    });
  }

  // Perform the link
  db.prepare('UPDATE agents SET owner_wallet = ? WHERE id = ?').run(ownerWallet.toLowerCase(), decoded.agentId);
  const updated = stmts.getAgentById.get(decoded.agentId);
  emitFeedEvent('agent:linked', { agentId: decoded.agentId, agentName: decoded.agentName, ownerWallet });
  createNotification({ wallet: ownerWallet, type: 'system', title: 'Agent Linked', message: `${decoded.agentName} is now linked to your profile.`, from: decoded.agentName });
  createNotification({ agentId: decoded.agentId, type: 'system', title: 'Linked to Human', message: `You are now linked to wallet ${ownerWallet.slice(0,6)}...${ownerWallet.slice(-4)}.`, from: ownerWallet });
  res.json({ success: true, agent: agentToJSON(updated) });
});

// Step 3: Agent can unlink itself from a human profile
app.post('/api/agents/:id/unlink', requireAuth, (req, res) => {
  // Only the authenticated agent can unlink itself
  if (req.auth.agentId !== req.params.id) {
    return res.status(403).json({ error: 'You can only unlink your own agent.' });
  }

  const agent = stmts.getAgentById.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  if (!isLinkedToHuman(agent)) {
    return res.json({ success: true, message: 'Agent is not linked to any human profile.' });
  }

  // Reset to Turnkey address if available, otherwise null
  const previousOwner = agent.owner_wallet;
  const resetWallet = agent.turnkey_address || null;
  db.prepare('UPDATE agents SET owner_wallet = ? WHERE id = ?').run(resetWallet, req.params.id);
  const updated = stmts.getAgentById.get(req.params.id);
  emitFeedEvent('agent:unlinked', { agentId: req.params.id, agentName: agent.agent_name, previousOwner });
  res.json({ success: true, agent: agentToJSON(updated), message: 'Agent unlinked from human profile.' });
});

// ── Agents by Owner Wallet ──
app.get('/api/agents/owner/:wallet', (req, res) => {
  const wallet = req.params.wallet.toLowerCase();
  const agents = db.prepare('SELECT * FROM agents WHERE LOWER(owner_wallet) = ?').all(wallet);
  res.json({ agents: agents.map(agentToJSON) });
});

// ── Agent Turnkey Wallet Provisioning ──
app.post('/api/agents/:id/wallet', async (req, res) => {
  try {
    const agent = stmts.getAgentById.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    if (!isTurnkeyEnabled()) {
      return res.json({
        turnkeyEnabled: false,
        address: null,
        message: 'Turnkey not configured. Set TURNKEY_ORGANIZATION_ID, TURNKEY_API_PRIVATE_KEY, TURNKEY_API_PUBLIC_KEY in .env',
      });
    }

    const wallet = await getOrCreateAgentWallet(db, agent.id, agent.agent_name);
    if (wallet?.address && agent.owner_wallet === '0x0000000000000000000000000000000000000000') {
      db.prepare('UPDATE agents SET owner_wallet = ? WHERE id = ?').run(wallet.address, agent.id);
    }
    res.json({
      turnkeyEnabled: true,
      address: wallet?.address || null,
      walletId: wallet?.walletId || null,
    });
  } catch (err) {
    console.error('Wallet provisioning error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Circle Faucet Claim ──
// Agents can claim testnet USDC via Circle's faucet API.
// Requires CIRCLE_API_KEY in env (testnet key from console.circle.com).
app.post('/api/agents/:id/claim-faucet', requireAuth, async (req, res) => {
  try {
    if (req.auth.agentId !== req.params.id) {
      return res.status(403).json({ error: 'Can only claim for your own agent' });
    }

    const agent = stmts.getAgentById.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const walletAddress = agent.turnkey_address || agent.owner_wallet;
    if (!walletAddress || walletAddress === '0x0') {
      return res.status(400).json({ error: 'Agent has no wallet. Use bard_create_wallet first.' });
    }

    const { blockchain, usdc, native } = req.body;
    const chain = blockchain || 'ARC-TESTNET';

    const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY;
    if (!CIRCLE_API_KEY) {
      return res.json({
        success: false,
        manual: true,
        faucetUrl: 'https://faucet.circle.com',
        cliCommand: `circle wallet fund --address ${walletAddress} --chain ${chain}`,
        message: 'CIRCLE_API_KEY not set. Use the manual faucet or Circle CLI: circle wallet fund --address ' + walletAddress + ' --chain ' + chain,
      });
    }

    // Rate limit: 1 claim per hour per agent
    if (!checkRateLimit(req.params.id, 'faucet_claim')) {
      return res.status(429).json({ error: 'Faucet rate limit: 1 claim per hour' });
    }

    // Call Circle Faucet API
    const faucetRes = await fetch('https://api.circle.com/v1/faucet/drips', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CIRCLE_API_KEY}`,
        'X-Request-Id': `bard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
      body: JSON.stringify({
        address: walletAddress,
        blockchain: chain,
        usdc: usdc !== false,
        native: native === true,
        eurc: false,
      }),
    });

    // Read raw response text first (handles empty bodies)
    const rawText = await faucetRes.text();
    console.log(`[Faucet] Circle API status=${faucetRes.status} body=${rawText.slice(0, 500)}`);

    let faucetData;
    try {
      faucetData = rawText ? JSON.parse(rawText) : {};
    } catch {
      faucetData = { rawResponse: rawText.slice(0, 200) };
    }

    if (!faucetRes.ok) {
      return res.status(faucetRes.status).json({
        error: faucetData.message || faucetData.rawResponse || `Circle API returned ${faucetRes.status}`,
        code: faucetData.code,
        status: faucetRes.status,
        manual: true,
        faucetUrl: 'https://faucet.circle.com',
        hint: faucetRes.status === 403 ? 'Complete mainnet verification at console.circle.com, or regenerate API key with Faucet Read & Write permission.' : undefined,
      });
    }

    // Update agent's last active
    db.prepare('UPDATE agents SET last_active_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), agent.id);
    emitFeedEvent('agent:faucet-claim', { agentId: agent.id, agentName: agent.agent_name, chain, walletAddress });
    createNotification({ agentId: agent.id, type: 'system', title: 'Faucet Claimed', message: `${agent.agent_name} claimed testnet USDC on ${chain}.`, from: 'Circle Faucet' });

    res.json({
      success: true,
      chain,
      walletAddress,
      usdc: usdc !== false,
      native: native === true,
      message: `Testnet funds claimed on ${chain} for ${walletAddress}`,
      faucetResponse: faucetData,
    });
  } catch (err) {
    console.error('Faucet claim error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Agent USDC Transfer ──
// Agents can send testnet USDC from their Turnkey wallet to any address on Arc Testnet.
// USDC is Arc's native gas token at system contract 0x3600...0000 (ERC-20 interface, 6 decimals).
app.post('/api/agents/:id/send-usdc', requireAuth, async (req, res) => {
  try {
    if (req.auth.agentId !== req.params.id) {
      return res.status(403).json({ error: 'Can only send from your own agent wallet' });
    }

    const agent = stmts.getAgentById.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const walletAddress = agent.turnkey_address;
    if (!walletAddress) {
      return res.status(400).json({ error: 'Agent has no Turnkey wallet. Use bard_create_wallet first.' });
    }

    const { to, amount } = req.body;
    if (!to || !amount) {
      return res.status(400).json({ error: 'Missing required fields: to (address), amount (USDC string e.g. "1.00")' });
    }

    // Validate address
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
      return res.status(400).json({ error: 'Invalid recipient address' });
    }

    // Parse amount (USDC has 6 decimals via ERC-20 interface)
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }
    if (parsedAmount > 100) {
      return res.status(400).json({ error: 'Max transfer: 100 USDC per transaction (testnet safety cap)' });
    }

    // Import Turnkey functions dynamically
    const { mintERC8004Identity, isTurnkeyEnabled } = await import('./turnkey-wallet.js');
    if (!isTurnkeyEnabled()) {
      return res.status(400).json({ error: 'Turnkey not configured. Cannot sign transactions.' });
    }

    const { Turnkey } = await import('@turnkey/sdk-server');
    const { createAccount } = await import('@turnkey/viem');
    const { createWalletClient, http, encodeFunctionData } = await import('viem');

    // Arc Testnet chain definition
    const arcTestnet = {
      id: 5042002,
      name: 'Arc Testnet',
      nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 6 },
      rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
      blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
    };

    const ARC_USDC = '0x3600000000000000000000000000000000000000';
    const amountWei = BigInt(Math.round(parsedAmount * 1_000_000)); // 6 decimals

    // Create Turnkey signer
    const tk = new Turnkey({
      defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID,
      apiBaseUrl: 'https://api.turnkey.com',
      apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY,
      apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY,
    });

    const account = await createAccount({
      client: tk.apiClient(),
      organizationId: process.env.TURNKEY_ORGANIZATION_ID,
      signWith: walletAddress,
    });

    const walletClient = createWalletClient({
      account,
      chain: arcTestnet,
      transport: http(),
    });

    // ERC-20 transfer(address, uint256)
    const data = encodeFunctionData({
      abi: [{
        name: 'transfer',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }],
        outputs: [{ name: '', type: 'bool' }],
      }],
      functionName: 'transfer',
      args: [to, amountWei],
    });

    const txHash = await walletClient.sendTransaction({
      to: ARC_USDC,
      data,
      value: 0n,
    });

    console.log(`[Send USDC] ${agent.agent_name}: ${parsedAmount} USDC → ${to} | tx: ${txHash}`);

    // Update agent's last active
    db.prepare('UPDATE agents SET last_active_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), agent.id);
    emitFeedEvent('agent:send-usdc', { agentId: agent.id, agentName: agent.agent_name, to, amount: parsedAmount, txHash });
    createNotification({ agentId: agent.id, type: 'send', title: 'USDC Sent', message: `${agent.agent_name} sent ${parsedAmount} USDC to ${to.slice(0,6)}...${to.slice(-4)}.`, from: walletAddress, amount: String(parsedAmount) });
    createNotification({ wallet: to, type: 'send', title: 'USDC Received', message: `Received ${parsedAmount} USDC from agent ${agent.agent_name}.`, from: walletAddress, amount: String(parsedAmount) });

    res.json({
      success: true,
      from: walletAddress,
      to,
      amount: parsedAmount,
      token: ARC_USDC,
      chain: 'Arc Testnet',
      txHash,
      explorer: `https://testnet.arcscan.app/tx/${txHash}`,
    });
  } catch (err) {
    console.error('Send USDC error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Agent ERC-8004 Identity Mint (agent-side) ──
// Agent calls this to mint ERC-8004 identity via Turnkey wallet.
// If Turnkey is configured, it signs and sends the tx on-chain.
// Otherwise, it records the intent for external signing.
app.post('/api/agents/:id/mint-identity', async (req, res) => {
  try {
    const agent = stmts.getAgentById.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const { metadataURI, txHash: externalTxHash } = req.body || {};
    const uri = metadataURI || `data:application/json,{"agent":"${agent.agent_name}","type":"${agent.agent_type}"}`;
    const now = new Date().toISOString();
    let txHash = externalTxHash || null;
    let turnkeyAddress = null;

    // If Turnkey is configured and no external txHash provided, sign on-chain
    if (isTurnkeyEnabled() && !externalTxHash) {
      try {
        const result = await mintERC8004Identity(db, agent.id, agent.agent_name, uri);
        txHash = result.txHash;
        turnkeyAddress = result.address;
      } catch (err) {
        console.error('Turnkey mint failed:', err.message);
        // Fall through — still record the intent
      }
    }

    // Store the mint intent / result
    db.prepare(`
      UPDATE agents SET
        erc8004_metadata_uri = COALESCE(?, erc8004_metadata_uri),
        erc8004_tx_hash = COALESCE(?, erc8004_tx_hash),
        erc8004_minted_at = ?
      WHERE id = ?
    `).run(uri, txHash, now, agent.id);

    const updated = stmts.getAgentById.get(agent.id);
    emitFeedEvent('agent:erc8004-mint', { agentId: agent.id, agentName: agent.agent_name, txHash });
    createNotification({ agentId: agent.id, type: 'system', title: 'Identity Minted', message: `${agent.agent_name} minted ERC-8004 identity on Arc Testnet.`, from: 'BARD System' });

    res.json({
      success: true,
      agent: agentToJSON(updated),
      turnkeyEnabled: isTurnkeyEnabled(),
      erc8004: {
        identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
        validationRegistry: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
        functionSignature: 'register(string)',
        metadataURI: uri,
        txHash: txHash || null,
        turnkeyAddress: turnkeyAddress || null,
        instruction: txHash
          ? `ERC-8004 identity minted on-chain. Tx: ${txHash}`
          : 'Call IdentityRegistry.register(metadataURI) from the agent wallet on Arc Testnet.',
      },
    });
  } catch (err) {
    console.error('Mint identity error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Cross-Agent Verification (Phase 2) ──
app.post('/api/contributions/:id/agent-verify', (req, res) => {
  const { verifierAgentId, result, reasoning, signature } = req.body;
  if (!verifierAgentId || !result || !signature) {
    return res.status(400).json({ error: 'verifierAgentId, result, and signature required' });
  }
  const validResults = ['approved', 'rejected', 'needs_revision'];
  if (!validResults.includes(result)) return res.status(400).json({ error: `result must be: ${validResults.join(', ')}` });

  const contribution = db.prepare('SELECT * FROM contributions WHERE id = ?').get(req.params.id);
  if (!contribution) return res.status(404).json({ error: 'Contribution not found' });

  const verifier = db.prepare('SELECT * FROM agents WHERE id = ?').get(verifierAgentId);
  if (!verifier) return res.status(404).json({ error: 'Verifier agent not found' });

  // Must be Established+ (rep >= 30)
  if (verifier.reputation_score < 30) {
    return res.status(403).json({ error: 'Verifier must have reputation >= 30 (Established tier)' });
  }

  // Can't verify own work
  if (contribution.agent_id === verifierAgentId) {
    return res.status(403).json({ error: 'Cannot verify your own contribution' });
  }

  // Check for duplicate
  const existing = db.prepare('SELECT id FROM agent_verifications WHERE contribution_id = ? AND verifier_agent_id = ?').get(req.params.id, verifierAgentId);
  if (existing) return res.status(409).json({ error: 'Already verified this contribution' });

  const vId = `averify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const reasoningHash = reasoning ? '0x' + require('crypto').createHash('sha256').update(reasoning).digest('hex') : '';

  db.prepare(`INSERT INTO agent_verifications (id, contribution_id, verifier_agent_id, result, reasoning, reasoning_hash, signature)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(vId, req.params.id, verifierAgentId, result, reasoning || '', reasoningHash, signature);

  // Update verifier's last_active_at
  db.prepare('UPDATE agents SET last_active_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), verifierAgentId);

  // Check if auto-verify threshold reached
  const approvals = db.prepare("SELECT COUNT(*) as c FROM agent_verifications WHERE contribution_id = ? AND result = 'approved'").get(req.params.id);
  const rejections = db.prepare("SELECT COUNT(*) as c FROM agent_verifications WHERE contribution_id = ? AND result = 'rejected'").get(req.params.id);

  let autoAction = null;
  if (approvals.c >= 2 && contribution.status === 'pending') {
    db.prepare("UPDATE contributions SET status = 'verified' WHERE id = ?").run(req.params.id);
    // Record on-chain mirror
    const contentHash = '0x' + require('crypto').createHash('sha256').update(contribution.proof_hash + contribution.description).digest('hex');
    const recId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try { db.prepare('INSERT INTO recorded_contributions (id, contribution_id, agent_id, content_hash) VALUES (?, ?, ?, ?)').run(recId, req.params.id, contribution.agent_id, contentHash); } catch {}
    // Boost submitter reputation
    db.prepare('UPDATE agents SET reputation_score = MIN(100, reputation_score + 10) WHERE id = ?').run(contribution.agent_id);
    autoAction = 'verified';
    // Reward verifiers +2 rep each
    db.prepare("UPDATE agents SET reputation_score = MIN(100, reputation_score + 2) WHERE id IN (SELECT verifier_agent_id FROM agent_verifications WHERE contribution_id = ? AND result = 'approved')").run(req.params.id);
    // Check badges
    checkBadgeEligibility(contribution.agent_id);
  } else if (rejections.c >= 2 && contribution.status === 'pending') {
    db.prepare("UPDATE contributions SET status = 'rejected' WHERE id = ?").run(req.params.id);
    db.prepare('UPDATE agents SET reputation_score = MAX(0, reputation_score - 3) WHERE id = ?').run(contribution.agent_id);
    autoAction = 'rejected';
  }

  res.json({ verification: { id: vId, result, autoAction }, approvals: approvals.c, rejections: rejections.c });
});

// List verifications for a contribution
app.get('/api/contributions/:id/verifications', (req, res) => {
  const verifications = db.prepare('SELECT * FROM agent_verifications WHERE contribution_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ verifications });
});

// Verifier stats
app.get('/api/agents/:id/verification-stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM agent_verifications WHERE verifier_agent_id = ?').get(req.params.id);
  const approved = db.prepare("SELECT COUNT(*) as c FROM agent_verifications WHERE verifier_agent_id = ? AND result = 'approved'").get(req.params.id);
  const rejected = db.prepare("SELECT COUNT(*) as c FROM agent_verifications WHERE verifier_agent_id = ? AND result = 'rejected'").get(req.params.id);
  res.json({ total: total.c, approved: approved.c, rejected: rejected.c, accuracy: total.c > 0 ? Math.round((approved.c / total.c) * 100) : 0 });
});

// ── Badges ──
app.get('/api/agents/:id/badges', (req, res) => {
  const badges = db.prepare('SELECT * FROM badges_earned WHERE agent_id = ? ORDER BY earned_at DESC').all(req.params.id);
  res.json({ badges });
});

// Badge eligibility check helper
function checkBadgeEligibility(agentId) {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
  if (!agent) return;
  const verified = db.prepare("SELECT COUNT(*) as c FROM contributions WHERE agent_id = ? AND status = 'verified'").get(agentId);
  const earned = db.prepare('SELECT badge_type FROM badges_earned WHERE agent_id = ?').all(agentId).map(b => b.badge_type);

  const mint = (type) => {
    if (earned.includes(type)) return;
    const id = `badge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try { db.prepare('INSERT INTO badges_earned (id, agent_id, badge_type) VALUES (?, ?, ?)').run(id, agentId, type); } catch {}
  };

  if (verified.c >= 1) mint('first_blood');
  if (verified.c >= 10) mint('ten_strong');
  if (verified.c >= 50) mint('fifty_club');
  if (agent.reputation_score >= 100) mint('century_club');
  if (agent.total_earned_usdc >= 1000) mint('earner');

  const verifyStats = db.prepare('SELECT COUNT(*) as c FROM agent_verifications WHERE verifier_agent_id = ?').get(agentId);
  if (verifyStats.c >= 50) mint('trusted_verifier');
}

// ── Multi-Agent Collaborations ──

app.post('/api/collaborations', requireAuth, (req, res) => {
  const { bountyId, agentIds, rewardSplit } = req.body;
  if (!bountyId || !agentIds || !Array.isArray(agentIds) || agentIds.length < 2) {
    return res.status(400).json({ error: 'bountyId and at least 2 agentIds required' });
  }

  const bounty = db.prepare('SELECT * FROM bounties WHERE id = ?').get(bountyId);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (bounty.status !== 'open') return res.status(400).json({ error: 'Bounty is not open' });

  // Verify proposer is one of the agents
  if (!agentIds.includes(req.auth.agentId)) {
    return res.status(403).json({ error: 'Proposer must be part of the collaboration' });
  }

  // Rate limit
  if (!checkRateLimit(req.auth.agentId, 'bard_propose_collaboration')) {
    return res.status(429).json({ error: 'Rate limit: max 5 proposals per hour' });
  }

  // Validate all agents exist
  for (const aid of agentIds) {
    const a = db.prepare('SELECT id FROM agents WHERE id = ?').get(aid);
    if (!a) return res.status(404).json({ error: `Agent ${aid} not found` });
  }

  // Build reward split (equal if not provided)
  const split = rewardSplit || {};
  if (Object.keys(split).length === 0) {
    const share = Math.floor(100 / agentIds.length);
    agentIds.forEach(id => split[id] = share);
  }

  const id = `collab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`INSERT INTO collaborations (id, bounty_id, proposer_agent_id, agent_ids, reward_split, status)
    VALUES (?, ?, ?, ?, ?, 'proposed')`).run(id, bountyId, req.auth.agentId, JSON.stringify(agentIds), JSON.stringify(split));

  emitFeedEvent('collaboration:proposed', { id, bountyId, agentIds, proposer: req.auth.agentId });
  res.json({ success: true, collaboration: { id, bountyId, agentIds, rewardSplit: split, status: 'proposed' } });
});

app.get('/api/collaborations/bounty/:bountyId', (req, res) => {
  const collabs = db.prepare('SELECT * FROM collaborations WHERE bounty_id = ? ORDER BY created_at DESC').all(req.params.bountyId);
  res.json({ collaborations: collabs.map(c => ({ ...c, agent_ids: JSON.parse(c.agent_ids), reward_split: JSON.parse(c.reward_split) })) });
});

app.get('/api/agents/:id/collaborations', (req, res) => {
  const collabs = db.prepare("SELECT * FROM collaborations WHERE agent_ids LIKE ? ORDER BY created_at DESC").all(`%${req.params.id}%`);
  res.json({ collaborations: collabs.map(c => ({ ...c, agent_ids: JSON.parse(c.agent_ids), reward_split: JSON.parse(c.reward_split) })) });
});

// Agent analytics/metrics
app.get('/api/agents/:id/analytics', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const totalContributions = db.prepare('SELECT COUNT(*) as c FROM contributions WHERE agent_id = ?').get(req.params.id);
  const verifiedContributions = db.prepare("SELECT COUNT(*) as c FROM contributions WHERE agent_id = ? AND status = 'verified'").get(req.params.id);
  const totalEndorsements = db.prepare("SELECT COUNT(*) as c FROM endorsements WHERE contribution_id IN (SELECT id FROM contributions WHERE agent_id = ?)").get(req.params.id);
  const verificationsGiven = db.prepare('SELECT COUNT(*) as c FROM agent_verifications WHERE verifier_agent_id = ?').get(req.params.id);
  const bountiesCompleted = db.prepare("SELECT COUNT(*) as c FROM bounties WHERE assigned_agent_id = ? AND status = 'completed'").get(req.params.id);
  const badges = db.prepare('SELECT * FROM badges_earned WHERE agent_id = ?').all(req.params.id);
  const recentContributions = db.prepare('SELECT type, created_at FROM contributions WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20').all(req.params.id);
  const collabs = db.prepare("SELECT COUNT(*) as c FROM collaborations WHERE agent_ids LIKE ?").get(`%${req.params.id}%`);

  // Type breakdown
  const typeBreakdown = {};
  db.prepare('SELECT type, COUNT(*) as c FROM contributions WHERE agent_id = ? GROUP BY type').all(req.params.id)
    .forEach(r => typeBreakdown[r.type] = r.c);

  res.json({
    agentId: req.params.id,
    agentName: agent.agent_name,
    reputation: agent.reputation_score,
    tier: agent.reputation_score >= 90 ? 'Sovereign' : agent.reputation_score >= 70 ? 'Architect' : agent.reputation_score >= 40 ? 'Builder' : agent.reputation_score >= 10 ? 'Contributor' : 'Newcomer',
    totalContributions: totalContributions.c,
    verifiedContributions: verifiedContributions.c,
    successRate: totalContributions.c > 0 ? Math.round((verifiedContributions.c / totalContributions.c) * 100) : 0,
    totalEndorsements: totalEndorsements.c,
    verificationsGiven: verificationsGiven.c,
    bountiesCompleted: bountiesCompleted.c,
    totalEarned: agent.total_earned_usdc || 0,
    collaborations: collabs.c,
    badges,
    typeBreakdown,
    recentActivity: recentContributions,
    lastActive: agent.last_active_at,
    registeredAt: agent.created_at,
  });
});
app.post('/api/contributions', (req, res) => {
  const { agentId, type, description, proofHash, proofData, signature } = req.body;
  if (!agentId || !type || !proofHash || !signature) {
    return res.status(400).json({ error: 'agentId, type, proofHash, and signature required' });
  }
  const validTypes = ['research', 'code_review', 'data_analysis', 'content', 'verification', 'other'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
  }
  const agent = stmts.getAgentById.get(agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  // Rate limit
  if (!checkRateLimit(agentId, 'bard_submit_contribution')) {
    return res.status(429).json({ error: 'Rate limit exceeded. Max 10 contributions per hour.' });
  }

  const id = `contrib-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    stmts.insertContribution.run({
      id, agent_id: agentId, type, description: description || '',
      proof_hash: proofHash, proof_data: JSON.stringify(proofData || {}),
      signature, created_at: new Date().toISOString(),
    });
    // Update agent state
    stmts.upsertAgentState.run({
      agent_id: agentId,
      context: JSON.stringify({ lastContribution: id, lastType: type }),
      updated_at: new Date().toISOString(),
    });
    // Recalculate reputation
    const reputation = calculateReputation(agentId);
    const saved = stmts.getContributionById.get(id);
    emitFeedEvent('contribution:new', { ...contributionToJSON(saved), agentName: agent.agent_name });
    createNotification({ agentId: agent.id, type: 'system', title: 'Contribution Submitted', message: `${agent.agent_name} submitted: ${description?.slice(0,60) || type}`, from: agent.agent_name });
    res.json({ success: true, contribution: contributionToJSON(saved), reputation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get contributions by agent
app.get('/api/contributions/agent/:agentId', (req, res) => {
  const contributions = stmts.getContributionsByAgent.all(req.params.agentId);
  res.json({ contributions: contributions.map(contributionToJSON) });
});

// Get recent contributions feed
app.get('/api/contributions/feed', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const contributions = stmts.getRecentContributions.all(limit);
  res.json({ contributions: contributions.map(contributionToJSON) });
});

// Get single contribution with endorsements
app.get('/api/contributions/:id', (req, res) => {
  const contribution = stmts.getContributionById.get(req.params.id);
  if (!contribution) return res.status(404).json({ error: 'Contribution not found' });
  const endorsements = stmts.getEndorsementsByContribution.all(req.params.id);
  const agent = stmts.getAgentById.get(contribution.agent_id);
  res.json({
    contribution: { ...contributionToJSON(contribution), agentName: agent?.agent_name },
    endorsements: endorsements.map(endorsementToJSON),
  });
});

// Endorse a contribution (human or agent with high reputation)
app.post('/api/contributions/:id/endorse', (req, res) => {
  const { endorserWallet, endorserType, comment, signature } = req.body;
  if (!endorserWallet) return res.status(400).json({ error: 'endorserWallet required' });

  const contribution = stmts.getContributionById.get(req.params.id);
  if (!contribution) return res.status(404).json({ error: 'Contribution not found' });

  const id = `endorse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    stmts.insertEndorsement.run({
      id, contribution_id: req.params.id,
      endorser_wallet: endorserWallet, endorser_type: endorserType || 'human',
      comment: comment || '', signature: signature || '',
      created_at: new Date().toISOString(),
    });
    stmts.incrementEndorsementCount.run(req.params.id);

    // Auto-verify: requires 5 human endorsements AND at least 1 agent approval
    const count = stmts.countEndorsementsByContribution.get(req.params.id).count;
    const agentApprovals = db.prepare("SELECT COUNT(*) as c FROM agent_verifications WHERE contribution_id = ? AND result = 'approved'").get(req.params.id);
    const nowVerified = count >= 5 && agentApprovals.c >= 1 && contribution.status === 'pending';
    if (nowVerified) {
      stmts.updateContributionStatus.run('verified', req.params.id);
      // Auto-record on-chain mirror
      const contentHash = '0x' + createHash('sha256').update(req.params.id + contribution.proof_hash).digest('hex');
      const recordId = `record-${Date.now()}`;
      stmts.insertRecord.run({
        id: recordId, contribution_id: req.params.id,
        agent_id: contribution.agent_id, content_hash: contentHash,
        tx_hash: '', recorded_at: new Date().toISOString(),
      });
      emitFeedEvent('contribution:verified', { contributionId: req.params.id, contentHash });
    }

    // Recalculate agent reputation
    const reputation = calculateReputation(contribution.agent_id);

    // Notify agent owner
    const agent = stmts.getAgentById.get(contribution.agent_id);
    if (agent) {
      stmts.insertNotification.run({
        id: `notif-${Date.now()}`, wallet: agent.owner_wallet,
        type: 'vouch', title: 'Contribution Endorsed',
        message: `${endorserWallet.slice(0, 8)}... endorsed "${contribution.description || contribution.type}"`,
        sender: endorserWallet, amount: '',
        created_at: new Date().toISOString(),
      });
    }
    emitFeedEvent('endorsement:new', { contributionId: req.params.id, endorserWallet, endorsementCount: count });
    // Notify the contribution owner they got endorsed
    if (contribution.agent_id) {
      createNotification({ agentId: contribution.agent_id, type: 'vouch', title: 'Endorsement Received', message: `Your contribution was endorsed by ${endorserWallet.slice(0,6)}...${endorserWallet.slice(-4)}. (${count} total)`, from: endorserWallet });
    }
    res.json({ success: true, endorsementCount: count, reputation });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Already endorsed this contribution' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Verify a contribution (agent-to-agent verification)
app.post('/api/contributions/:id/verify', (req, res) => {
  const { verifierAgentId, result, signature, wallet } = req.body;

  const contribution = stmts.getContributionById.get(req.params.id);
  if (!contribution) return res.status(404).json({ error: 'Contribution not found' });

  try {
    // Path 1: Human wallet endorsement (owner or any connected wallet)
    if (wallet && !verifierAgentId) {
      // Record as endorsement (does NOT instantly verify)
      const endorseId = `owner-endorse-${Date.now()}`;
      try {
        stmts.insertEndorsement.run({
          id: endorseId, contribution_id: req.params.id,
          endorser_wallet: wallet, endorser_type: 'human',
          comment: `Endorsed by ${wallet.slice(0, 6)}...${wallet.slice(-4)}`,
          signature: signature || '', created_at: new Date().toISOString(),
        });
        stmts.incrementEndorsementCount.run(req.params.id);
      } catch { return res.status(409).json({ error: 'Already endorsed this contribution' }); }

      // Check if auto-verify threshold reached:
      // Requires 5 human endorsements AND at least 1 agent approval
      const humanCount = stmts.countEndorsementsByContribution.get(req.params.id).count;
      const agentApprovals = db.prepare("SELECT COUNT(*) as c FROM agent_verifications WHERE contribution_id = ? AND result = 'approved'").get(req.params.id);
      const shouldVerify = humanCount >= 5 && agentApprovals.c >= 1 && contribution.status === 'pending';

      if (shouldVerify) {
        stmts.updateContributionStatus.run('verified', req.params.id);
        db.prepare('UPDATE agents SET reputation_score = MIN(100, reputation_score + 5) WHERE id = ?').run(contribution.agent_id);
        createNotification({ agentId: contribution.agent_id, type: 'system', title: '\u2705 Contribution Verified', message: `Your contribution reached 5 endorsements + agent approval and is now verified.`, from: 'BARD System' });
      }

      const reputation = calculateReputation(contribution.agent_id);
      createNotification({ agentId: contribution.agent_id, type: 'vouch', title: '\ud83e\udd1d Endorsement Received', message: `${wallet.slice(0, 6)}...${wallet.slice(-4)} endorsed your contribution. (${humanCount} total, need 5 + 1 agent)`, from: wallet });

      return res.json({ success: true, status: shouldVerify ? 'verified' : 'endorsed', endorsements: humanCount, agentApprovals: agentApprovals.c, reputation });
    }

    // Path 2: Agent-based verification (existing logic)
    if (!verifierAgentId || !result) return res.status(400).json({ error: 'verifierAgentId and result required, or wallet for owner verification' });

    const verifier = stmts.getAgentById.get(verifierAgentId);
    if (!verifier) return res.status(404).json({ error: 'Verifier agent not found' });
    if (verifier.reputation_score < 20) return res.status(403).json({ error: 'Verifier needs reputation >= 20' });

    if (result === 'approved') {
      stmts.updateContributionStatus.run('verified', req.params.id);
    } else if (result === 'rejected') {
      stmts.updateContributionStatus.run('rejected', req.params.id);
    }
    // Also count as endorsement
    const endorseId = `verify-${Date.now()}`;
    try {
      stmts.insertEndorsement.run({
        id: endorseId, contribution_id: req.params.id,
        endorser_wallet: verifier.owner_wallet, endorser_type: 'agent',
        comment: `Verified by ${verifier.agent_name} (${result})`,
        signature: signature || '', created_at: new Date().toISOString(),
      });
      stmts.incrementEndorsementCount.run(req.params.id);
    } catch { /* ignore duplicate */ }

    const reputation = calculateReputation(contribution.agent_id);
    res.json({ success: true, status: result, reputation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get agent reputation
app.get('/api/agents/:id/reputation', (req, res) => {
  const agent = stmts.getAgentById.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const reputation = calculateReputation(req.params.id);
  res.json({ agentId: req.params.id, agentName: agent.agent_name, ...reputation });
});

// Get/update agent state
app.get('/api/agents/:id/state', (req, res) => {
  const state = stmts.getAgentState.get(req.params.id);
  res.json({ state: state ? { agentId: state.agent_id, context: JSON.parse(state.context || '{}'), updatedAt: state.updated_at } : null });
});

app.put('/api/agents/:id/state', (req, res) => {
  const { context } = req.body;
  if (!context) return res.status(400).json({ error: 'context required' });
  stmts.upsertAgentState.run({
    agent_id: req.params.id,
    context: JSON.stringify(context),
    updated_at: new Date().toISOString(),
  });
  res.json({ success: true });
});

// Get endorsements by wallet
app.get('/api/endorsements/wallet/:wallet', (req, res) => {
  const endorsements = stmts.getEndorsementsByWallet.all(req.params.wallet);
  res.json({ endorsements: endorsements.map(endorsementToJSON) });
});

// ══════════════════════════════════════════════════════
// ── SSE Live Feed ──
// ══════════════════════════════════════════════════════

app.get('/api/feed/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send heartbeat every 25s to keep connection alive
  const heartbeat = setInterval(() => res.write(':ping\n\n'), 25000);

  const listener = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  feedEmitter.on('update', listener);

  req.on('close', () => {
    clearInterval(heartbeat);
    feedEmitter.off('update', listener);
  });
});

// ══════════════════════════════════════════════════════
// ── Phase 2: Commit-Reveal Accountability ──
// ══════════════════════════════════════════════════════

// POST /api/commitments — agent commits reasoning hash before acting
app.post('/api/commitments', (req, res) => {
  const { agentId, commitmentHash, salt } = req.body;
  if (!agentId || !commitmentHash || !salt) {
    return res.status(400).json({ error: 'agentId, commitmentHash, and salt required' });
  }
  const agent = stmts.getAgentById.get(agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const id = `commit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  stmts.insertCommitment.run({
    id, agent_id: agentId, commitment_hash: commitmentHash,
    salt, created_at: new Date().toISOString(),
  });
  res.json({ success: true, commitmentId: id, commitmentHash });
});

// POST /api/commitments/:id/reveal — agent reveals reasoning + salt for verification
app.post('/api/commitments/:id/reveal', (req, res) => {
  const { reasoning, salt } = req.body;
  if (!reasoning || !salt) return res.status(400).json({ error: 'reasoning and salt required' });

  const commitment = stmts.getCommitmentById.get(req.params.id);
  if (!commitment) return res.status(404).json({ error: 'Commitment not found' });
  if (commitment.revealed) return res.status(409).json({ error: 'Already revealed' });

  // Verify hash matches
  const expectedHash = '0x' + createHash('sha256').update(reasoning + salt).digest('hex');
  if (expectedHash !== commitment.commitment_hash) {
    return res.status(400).json({ error: 'Reasoning does not match commitment hash', expected: commitment.commitment_hash, got: expectedHash });
  }

  stmts.revealCommitment.run({
    id: req.params.id,
    reasoning,
    revealed_at: new Date().toISOString(),
  });
  res.json({ success: true, verified: true, commitmentId: req.params.id });
});

// GET /api/commitments/agent/:agentId
app.get('/api/commitments/agent/:agentId', (req, res) => {
  const commitments = stmts.getCommitmentsByAgent.all(req.params.agentId);
  res.json({ commitments });
});

// GET /api/commitments/:id
app.get('/api/commitments/:id', (req, res) => {
  const commitment = stmts.getCommitmentById.get(req.params.id);
  if (!commitment) return res.status(404).json({ error: 'Not found' });
  res.json({ commitment });
});

// ── Phase 2: Record Board ──

// GET /api/records — all on-chain mirrored contributions
app.get('/api/records', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const records = stmts.getAllRecords.all(limit);
  res.json({ records });
});

// GET /api/records/:contributionId
app.get('/api/records/:contributionId', (req, res) => {
  const record = stmts.getRecordByContribution.get(req.params.contributionId);
  if (!record) return res.status(404).json({ error: 'Not recorded yet' });
  res.json({ record });
});

// ══════════════════════════════════════════════════════
// ── Phase 3: Bounty System ──
// ══════════════════════════════════════════════════════

// POST /api/bounties — create bounty (human or agent)
app.post('/api/bounties', (req, res) => {
  const { creatorWallet, title, description, bountyType, amountUsdc, deadline, minReputation } = req.body;
  if (!creatorWallet || !title || !bountyType || !amountUsdc || !deadline) {
    return res.status(400).json({ error: 'creatorWallet, title, bountyType, amountUsdc, and deadline required' });
  }
  const validTypes = ['research', 'code_review', 'data_analysis', 'content', 'verification', 'other'];
  if (!validTypes.includes(bountyType)) {
    return res.status(400).json({ error: `Invalid type. Must be: ${validTypes.join(', ')}` });
  }
  const id = `bounty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  stmts.insertBounty.run({
    id, creator_wallet: creatorWallet, title, description: description || '',
    bounty_type: bountyType, amount_usdc: amountUsdc, deadline,
    min_reputation: minReputation || 0, created_at: now, updated_at: now,
  });
  const bounty = stmts.getBountyById.get(id);
  emitFeedEvent('bounty:created', bounty);
  createNotification({ wallet: creatorWallet, type: 'system', title: 'Bounty Created', message: `Your bounty "${title}" is now live.`, from: 'BARD System' });
  res.json({ success: true, bounty });
});

// GET /api/bounties — list bounties
app.get('/api/bounties', (req, res) => {
  const status = req.query.status;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const bounties = status
    ? stmts.getOpenBounties.all(status, limit)
    : stmts.getAllBounties.all();
  res.json({ bounties });
});

// GET /api/bounties/:id
app.get('/api/bounties/:id', (req, res) => {
  const bounty = stmts.getBountyById.get(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  res.json({ bounty });
});

// POST /api/bounties/:id/accept — agent accepts a bounty
app.post('/api/bounties/:id/accept', (req, res) => {
  const { agentId } = req.body;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });

  const bounty = stmts.getBountyById.get(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (bounty.status !== 'open') return res.status(409).json({ error: 'Bounty is not open' });

  const agent = stmts.getAgentById.get(agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (agent.reputation_score < (bounty.min_reputation || 0)) {
    return res.status(403).json({ error: `Agent needs reputation >= ${bounty.min_reputation}` });
  }

  stmts.assignBounty.run({ agent_id: agentId, status: 'assigned', updated_at: new Date().toISOString(), id: req.params.id });
  res.json({ success: true, bounty: stmts.getBountyById.get(req.params.id) });
});

// POST /api/bounties/:id/submit — agent submits work for bounty
app.post('/api/bounties/:id/submit', (req, res) => {
  const { contributionId } = req.body;
  if (!contributionId) return res.status(400).json({ error: 'contributionId required' });

  const bounty = stmts.getBountyById.get(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (bounty.status !== 'assigned') return res.status(409).json({ error: 'Bounty not assigned' });

  stmts.completeBounty.run({ contribution_id: contributionId, status: 'submitted', updated_at: new Date().toISOString(), id: req.params.id });
  emitFeedEvent('bounty:submitted', { bountyId: req.params.id, contributionId });
  res.json({ success: true, bounty: stmts.getBountyById.get(req.params.id) });
});

// POST /api/bounties/:id/cancel — creator cancels open bounty
app.post('/api/bounties/:id/cancel', (req, res) => {
  const { creatorWallet } = req.body;
  const bounty = stmts.getBountyById.get(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (bounty.creator_wallet.toLowerCase() !== (creatorWallet || '').toLowerCase()) {
    return res.status(403).json({ error: 'Only creator can cancel' });
  }
  if (!['open', 'assigned'].includes(bounty.status)) {
    return res.status(409).json({ error: 'Cannot cancel bounty in current state' });
  }
  stmts.updateBountyStatus.run({ status: 'cancelled', updated_at: new Date().toISOString(), id: req.params.id });
  res.json({ success: true });
});

// GET /api/bounties/creator/:wallet
app.get('/api/bounties/creator/:wallet', (req, res) => {
  const bounties = stmts.getBountiesByCreator.all(req.params.wallet);
  res.json({ bounties });
});

// GET /api/bounties/agent/:agentId
app.get('/api/bounties/agent/:agentId', (req, res) => {
  const bounties = stmts.getBountiesByAgent.all(req.params.agentId);
  res.json({ bounties });
});

// ══════════════════════════════════════════════════════
// ── Escrow Lifecycle ──
// ══════════════════════════════════════════════════════

const logEscrowEvent = (bountyId, eventType, actorWallet, actorType, details, txHash) => {
  const id = `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  stmts.insertEscrowEvent.run({ id, bounty_id: bountyId, event_type: eventType, actor_wallet: actorWallet || '', actor_type: actorType || 'system', details: details || '', tx_hash: txHash || '', created_at: new Date().toISOString() });
};

// POST /api/bounties/:id/fund — Client locks USDC into escrow
app.post('/api/bounties/:id/fund', (req, res) => {
  const { clientWallet, budgetUsdc, txHash } = req.body;
  if (!clientWallet || !budgetUsdc) return res.status(400).json({ error: 'clientWallet and budgetUsdc required' });
  if (parseFloat(budgetUsdc) < 1) return res.status(400).json({ error: 'Minimum bounty is 1 USDC' });
  if (!checkRateLimit(clientWallet, 'escrow_fund')) return res.status(429).json({ error: 'Rate limit exceeded' });

  const bounty = stmts.getBountyById.get(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (bounty.creator_wallet.toLowerCase() !== clientWallet.toLowerCase()) return res.status(403).json({ error: 'Only bounty creator can fund' });
  if (bounty.escrow_status !== 'none') return res.status(409).json({ error: `Bounty already in escrow state: ${bounty.escrow_status}` });

  // TODO: Stage 1 — txHash is trusted (not verified on-chain).
  // In Stage 2+, verify txHash against Arc Testnet RPC to confirm USDC transfer.
  // For now, the platform owner manually confirms funding before verifying.
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(); // 72h from fund
  stmts.updateBountyEscrow.run({ escrow_status: 'funded', escrow_budget_usdc: parseFloat(budgetUsdc), escrow_tx_hash: txHash || '', expires_at: expiresAt, updated_at: now, id: req.params.id });
  logEscrowEvent(req.params.id, 'funded', clientWallet, 'human', `${budgetUsdc} USDC locked`, txHash);
  emitFeedEvent('escrow:funded', { bountyId: req.params.id, budgetUsdc });

  res.json({ success: true, bounty: stmts.getBountyById.get(req.params.id) });
});

// POST /api/bounties/:id/claim — Agent accepts a funded bounty
app.post('/api/bounties/:id/claim', (req, res) => {
  const { agentId, callerWallet } = req.body;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });

  const agent = stmts.getAgentById.get(agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  // Auth: caller must own the agent
  if (callerWallet && agent.owner_wallet.toLowerCase() !== callerWallet.toLowerCase()) {
    return res.status(403).json({ error: 'Only the agent owner can claim bounties' });
  }
  if (!checkRateLimit(agentId, 'escrow_claim')) return res.status(429).json({ error: 'Rate limit exceeded' });

  const bounty = stmts.getBountyById.get(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (bounty.status !== 'open' || !['funded', 'none'].includes(bounty.escrow_status)) {
    return res.status(409).json({ error: 'Bounty is not available for claiming' });
  }
  if (agent.reputation_score < (bounty.min_reputation || 0)) {
    return res.status(403).json({ error: `Agent needs reputation >= ${bounty.min_reputation}` });
  }

  const now = new Date().toISOString();
  // Reset expiry from claim time (agent gets full 72h to deliver)
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  stmts.claimBountyEscrow.run({ provider_agent_id: agentId, provider_wallet: agent.turnkey_address || agent.owner_wallet, claimed_at: now, updated_at: now, id: req.params.id });
  db.prepare('UPDATE bounties SET expires_at = ? WHERE id = ?').run(expiresAt, req.params.id);
  logEscrowEvent(req.params.id, 'claimed', agent.owner_wallet, 'agent', `Claimed by ${agent.agent_name}`, '');

  createNotification({ wallet: bounty.creator_wallet, type: 'system', title: 'Agent Claimed Bounty', message: `${agent.agent_name} accepted your bounty "${bounty.title}".`, from: agent.owner_wallet });
  emitFeedEvent('escrow:claimed', { bountyId: req.params.id, agentId, agentName: agent.agent_name });

  res.json({ success: true, bounty: stmts.getBountyById.get(req.params.id) });
});

// POST /api/bounties/:id/deliver — Agent submits deliverable
app.post('/api/bounties/:id/deliver', (req, res) => {
  const { agentId, content, proofHash, callerWallet } = req.body;
  if (!agentId || !content) return res.status(400).json({ error: 'agentId and content required' });

  // Size limit: max 1MB deliverable
  if (content.length > 1024 * 1024) return res.status(400).json({ error: 'Deliverable too large (max 1MB)' });
  if (!checkRateLimit(agentId, 'escrow_deliver')) return res.status(429).json({ error: 'Rate limit exceeded' });

  const bounty = stmts.getBountyById.get(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (bounty.provider_agent_id !== agentId) return res.status(403).json({ error: 'Only the assigned agent can submit' });
  if (!['claimed', 'submitted'].includes(bounty.escrow_status)) return res.status(409).json({ error: `Cannot submit in state: ${bounty.escrow_status}` });

  // Auth: verify agent ownership
  const agent = stmts.getAgentById.get(agentId);
  if (callerWallet && agent && agent.owner_wallet.toLowerCase() !== callerWallet.toLowerCase()) {
    return res.status(403).json({ error: 'Only the agent owner can submit deliverables' });
  }

  const hash = proofHash || ('0x' + createHash('sha256').update(content).digest('hex'));
  const now = new Date().toISOString();
  stmts.submitBountyDeliverable.run({ deliverable_hash: hash, deliverable_content: content, submitted_at: now, updated_at: now, id: req.params.id });
  logEscrowEvent(req.params.id, 'submitted', bounty.provider_wallet, 'agent', `Deliverable submitted (hash: ${hash.slice(0, 16)}...)`, '');

  createNotification({ wallet: bounty.creator_wallet, type: 'system', title: 'Deliverable Submitted', message: `Agent submitted work for "${bounty.title}". Review it now.`, from: bounty.provider_wallet });
  emitFeedEvent('escrow:submitted', { bountyId: req.params.id, deliverableHash: hash });

  res.json({ success: true, bounty: stmts.getBountyById.get(req.params.id) });
});

// POST /api/bounties/:id/review — Client approves or rejects deliverable
app.post('/api/bounties/:id/review', (req, res) => {
  const { clientWallet, decision, reason } = req.body;
  if (!clientWallet || !decision) return res.status(400).json({ error: 'clientWallet and decision (approved/rejected) required' });
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'decision must be approved or rejected' });
  if (!checkRateLimit(clientWallet, 'escrow_review')) return res.status(429).json({ error: 'Rate limit exceeded' });

  const bounty = stmts.getBountyById.get(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (bounty.creator_wallet.toLowerCase() !== clientWallet.toLowerCase()) return res.status(403).json({ error: 'Only bounty creator can review' });
  if (bounty.escrow_status !== 'submitted') return res.status(409).json({ error: 'No deliverable to review' });

  const now = new Date().toISOString();

  if (decision === 'approved') {
    stmts.clientReviewBounty.run({ client_decision: 'approved', client_decision_at: now, escrow_status: 'client_approved', updated_at: now, id: req.params.id });
    logEscrowEvent(req.params.id, 'client_approved', clientWallet, 'human', reason || 'Client approved deliverable', '');
    createNotification({ agentId: bounty.provider_agent_id, type: 'system', title: 'Client Approved', message: `Client approved your deliverable for "${bounty.title}". Awaiting platform verification.`, from: clientWallet });
  } else {
    // Rejection — allow 1 revision
    if ((bounty.revision_count || 0) >= 1) {
      // Already revised once — escalate to platform
      stmts.clientReviewBounty.run({ client_decision: 'rejected', client_decision_at: now, escrow_status: 'disputed', updated_at: now, id: req.params.id });
      logEscrowEvent(req.params.id, 'disputed', clientWallet, 'human', `Client rejected after revision: ${reason || 'No reason'}`, '');
      createNotification({ agentId: bounty.provider_agent_id, type: 'system', title: 'Escalated to Platform', message: `Client rejected your revision for "${bounty.title}". Platform will decide.`, from: clientWallet });
    } else {
      stmts.incrementBountyRevision.run({ updated_at: now, id: req.params.id });
      logEscrowEvent(req.params.id, 'client_rejected', clientWallet, 'human', `Revision requested: ${reason || 'No reason'}`, '');
      createNotification({ agentId: bounty.provider_agent_id, type: 'system', title: 'Revision Requested', message: `Client requested revision for "${bounty.title}": ${reason || 'No details'}`, from: clientWallet });
    }
  }

  emitFeedEvent('escrow:reviewed', { bountyId: req.params.id, decision });
  res.json({ success: true, bounty: stmts.getBountyById.get(req.params.id) });
});

// POST /api/bounties/:id/platform-verify — Platform owner verifies (Stage 1)
app.post('/api/bounties/:id/platform-verify', (req, res) => {
  const { verifierWallet, decision, reasoning } = req.body;
  if (!verifierWallet || !decision) return res.status(400).json({ error: 'verifierWallet and decision required' });
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'decision must be approved or rejected' });

  // Auth: Only platform owner can verify in Stage 1
  if (verifierWallet.toLowerCase() !== PLATFORM_OWNER_WALLET) {
    return res.status(403).json({ error: 'Only the platform owner can verify escrow in Stage 1' });
  }
  if (!checkRateLimit(verifierWallet, 'escrow_verify')) return res.status(429).json({ error: 'Rate limit exceeded' });

  const bounty = stmts.getBountyById.get(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (!['client_approved', 'disputed'].includes(bounty.escrow_status)) {
    return res.status(409).json({ error: `Cannot verify in state: ${bounty.escrow_status}` });
  }

  const now = new Date().toISOString();
  const reasoningHash = reasoning ? ('0x' + createHash('sha256').update(reasoning).digest('hex')) : '';

  // Atomic transaction: verify + release/refund
  const verifyAndExecute = db.transaction(() => {
    // Re-check state inside transaction to prevent race conditions
    const fresh = stmts.getBountyById.get(req.params.id);
    if (!['client_approved', 'disputed'].includes(fresh.escrow_status)) {
      throw new Error(`Race condition: bounty now in state ${fresh.escrow_status}`);
    }

    // Record verification decision (audit trail)
    const vId = `vd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    stmts.insertVerificationDecision.run({ id: vId, bounty_id: req.params.id, verifier_wallet: verifierWallet, verifier_type: 'platform', decision, reasoning: reasoning || '', reasoning_hash: reasoningHash, stage: 1, tx_hash: '', created_at: now });

    if (decision === 'approved') {
      stmts.verifyBountyEscrow.run({ verifier_wallet: verifierWallet, verifier_decision: 'approved', verifier_reason: reasoning || '', escrow_status: 'verified', updated_at: now, id: req.params.id });
      logEscrowEvent(req.params.id, 'verified', verifierWallet, 'platform', 'Platform approved — ready for release', '');

      const releaseTx = `release-${Date.now()}`;
      stmts.releaseBountyEscrow.run({ release_tx_hash: releaseTx, released_at: now, updated_at: now, id: req.params.id });
      logEscrowEvent(req.params.id, 'released', verifierWallet, 'platform', `${bounty.escrow_budget_usdc} USDC released to agent`, releaseTx);

      if (bounty.provider_agent_id) {
        db.prepare('UPDATE agents SET reputation_score = MIN(100, reputation_score + 15), total_earned_usdc = total_earned_usdc + ? WHERE id = ?').run(bounty.escrow_budget_usdc || 0, bounty.provider_agent_id);
      }
    } else {
      stmts.verifyBountyEscrow.run({ verifier_wallet: verifierWallet, verifier_decision: 'rejected', verifier_reason: reasoning || '', escrow_status: 'refunded', updated_at: now, id: req.params.id });
      stmts.refundBountyEscrow.run({ updated_at: now, id: req.params.id });
      logEscrowEvent(req.params.id, 'refunded', verifierWallet, 'platform', `Platform rejected: ${reasoning || 'No reason'}. USDC refunded.`, '');

      if (bounty.provider_agent_id) {
        db.prepare('UPDATE agents SET reputation_score = MAX(0, reputation_score - 10) WHERE id = ?').run(bounty.provider_agent_id);
      }
    }
  });

  try {
    verifyAndExecute();
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }

  // Notifications outside transaction (non-critical)
  if (decision === 'approved') {
    if (bounty.provider_agent_id) {
      createNotification({ agentId: bounty.provider_agent_id, type: 'send', title: 'Escrow Released', message: `${bounty.escrow_budget_usdc} USDC released for "${bounty.title}". Rep +15.`, from: 'BARD System' });
    }
    createNotification({ wallet: bounty.creator_wallet, type: 'system', title: 'Bounty Completed', message: `"${bounty.title}" verified and USDC released to agent.`, from: 'BARD System' });
  } else {
    if (bounty.provider_agent_id) {
      createNotification({ agentId: bounty.provider_agent_id, type: 'system', title: 'Deliverable Rejected', message: `Platform rejected your work for "${bounty.title}". Rep -10.`, from: 'BARD System' });
    }
    createNotification({ wallet: bounty.creator_wallet, type: 'send', title: 'Escrow Refunded', message: `${bounty.escrow_budget_usdc} USDC refunded for "${bounty.title}".`, from: 'BARD System' });
  }

  emitFeedEvent('escrow:verified', { bountyId: req.params.id, decision });
  res.json({ success: true, bounty: stmts.getBountyById.get(req.params.id) });
});

// GET /api/bounties/:id/events — Escrow event audit trail
app.get('/api/bounties/:id/events', (req, res) => {
  const events = stmts.getEscrowEvents.all(req.params.id);
  res.json({ events });
});

// GET /api/bounties/:id/escrow — Full escrow status
app.get('/api/bounties/:id/escrow', (req, res) => {
  const bounty = stmts.getBountyById.get(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  const events = stmts.getEscrowEvents.all(req.params.id);
  const decisions = stmts.getVerificationDecisions.all(req.params.id);
  res.json({ bounty, events, decisions });
});

// ══════════════════════════════════════════════════════
// ── Marketplace & Skill Registry ──
// ══════════════════════════════════════════════════════

// GET /api/marketplace — Browse available skills
app.get('/api/marketplace', (req, res) => {
  const category = req.query.category;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const skills = category
    ? stmts.searchSkillsByCategory.all(category, limit)
    : stmts.searchSkills.all(limit);
  const openBounties = stmts.getMarketplaceBounties.all(limit);
  res.json({ skills, openBounties });
});

// GET /api/marketplace/search — Search skills by keyword
app.get('/api/marketplace/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const category = req.query.category;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  let skills = category
    ? stmts.searchSkillsByCategory.all(category, limit)
    : stmts.searchSkills.all(limit);
  if (q) {
    skills = skills.filter(s =>
      s.skill_name.toLowerCase().includes(q) ||
      (s.description || '').toLowerCase().includes(q) ||
      (s.keywords || '').toLowerCase().includes(q) ||
      (s.agent_name || '').toLowerCase().includes(q)
    );
  }
  res.json({ skills });
});

// POST /api/agents/:id/skills — Register a new skill
app.post('/api/agents/:id/skills', (req, res) => {
  const { skillName, category, description, keywords, hourlyRateUsdc, fixedRateUsdc, callerWallet } = req.body;
  if (!skillName) return res.status(400).json({ error: 'skillName required' });
  if (!checkRateLimit(req.params.id, 'skill_register')) return res.status(429).json({ error: 'Rate limit exceeded' });

  const agent = stmts.getAgentById.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  // Auth: caller must own the agent
  if (callerWallet && agent.owner_wallet.toLowerCase() !== callerWallet.toLowerCase()) {
    return res.status(403).json({ error: 'Only the agent owner can register skills' });
  }

  const validCategories = ['research', 'code', 'data', 'content', 'verification', 'execution', 'general'];
  const cat = validCategories.includes(category) ? category : 'general';

  const id = `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  stmts.insertAgentSkill.run({
    id, agent_id: req.params.id, skill_name: skillName, category: cat,
    description: description || '', keywords: JSON.stringify(keywords || []),
    hourly_rate_usdc: hourlyRateUsdc || 0, fixed_rate_usdc: fixedRateUsdc || 0,
    status: 'active', created_at: new Date().toISOString(),
  });

  res.json({ success: true, skill: stmts.getSkillById.get(id) });
});

// GET /api/agents/:id/skills — List agent's skills
app.get('/api/agents/:id/skills', (req, res) => {
  const status = req.query.status || 'active';
  const skills = stmts.getAgentSkills.all(req.params.id, status);
  res.json({ skills });
});

// PUT /api/agents/:id/skills/:skillId — Update skill
app.put('/api/agents/:id/skills/:skillId', (req, res) => {
  const skill = stmts.getSkillById.get(req.params.skillId);
  if (!skill) return res.status(404).json({ error: 'Skill not found' });
  if (skill.agent_id !== req.params.id) return res.status(403).json({ error: 'Not your skill' });

  const { skillName, category, description, keywords, hourlyRateUsdc, fixedRateUsdc, status } = req.body;
  stmts.updateAgentSkill.run({
    skill_name: skillName || skill.skill_name, category: category || skill.category,
    description: description !== undefined ? description : skill.description,
    keywords: keywords ? JSON.stringify(keywords) : skill.keywords,
    hourly_rate_usdc: hourlyRateUsdc !== undefined ? hourlyRateUsdc : skill.hourly_rate_usdc,
    fixed_rate_usdc: fixedRateUsdc !== undefined ? fixedRateUsdc : skill.fixed_rate_usdc,
    status: status || skill.status, id: req.params.skillId,
  });

  res.json({ success: true, skill: stmts.getSkillById.get(req.params.skillId) });
});

// DELETE /api/agents/:id/skills/:skillId — Remove skill
app.delete('/api/agents/:id/skills/:skillId', (req, res) => {
  const result = stmts.deleteAgentSkill.run(req.params.skillId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Skill not found or not yours' });
  res.json({ success: true });
});

// GET /api/agents/:id/work-history — Completed escrow jobs
app.get('/api/agents/:id/work-history', (req, res) => {
  const completed = db.prepare("SELECT id, title, escrow_budget_usdc, escrow_status, released_at, creator_wallet, bounty_type FROM bounties WHERE provider_agent_id = ? AND escrow_status IN ('released', 'refunded') ORDER BY released_at DESC LIMIT 50").all(req.params.id);
  const stats = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN escrow_status = 'released' THEN 1 ELSE 0 END) as completed, SUM(CASE WHEN escrow_status = 'released' THEN escrow_budget_usdc ELSE 0 END) as total_earned FROM bounties WHERE provider_agent_id = ?").get(req.params.id);
  res.json({ workHistory: completed, stats });
});

// GET /api/verification/log — Public verification audit trail
app.get('/api/verification/log', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const decisions = db.prepare('SELECT vd.*, b.title as bounty_title, b.escrow_budget_usdc FROM verification_decisions vd LEFT JOIN bounties b ON vd.bounty_id = b.id ORDER BY vd.created_at DESC LIMIT ?').all(limit);
  res.json({ decisions });
});

// GET /api/verification/stats — Platform verification statistics
app.get('/api/verification/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM verification_decisions').get();
  const approved = db.prepare("SELECT COUNT(*) as c FROM verification_decisions WHERE decision = 'approved'").get();
  const rejected = db.prepare("SELECT COUNT(*) as c FROM verification_decisions WHERE decision = 'rejected'").get();
  const byStage = db.prepare('SELECT stage, COUNT(*) as c FROM verification_decisions GROUP BY stage').all();
  res.json({ total: total.c, approved: approved.c, rejected: rejected.c, byStage });
});

// ══════════════════════════════════════════════════════
// ── Agent Authentication (Challenge-Sign-Verify) ──
// ══════════════════════════════════════════════════════

// POST /api/auth/challenge — Step 1: Get a challenge to sign
app.post('/api/auth/challenge', (req, res) => {
  const { agentId } = req.body;

  // Validate agent exists if provided
  let agent = null;
  if (agentId) {
    agent = stmts.getAgentById.get(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
  }

  const nonce = randomBytes(32).toString('hex');
  const challengeId = `challenge-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const scope = 'agent:full';
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min
  const message = `BARD Agent Authentication\n\nChallenge: ${nonce}\nScope: ${scope}\nAgent: ${agentId || 'any'}\nExpires: ${expiresAt}`;

  stmts.insertChallenge.run({
    id: challengeId, agent_id: agentId || '',
    nonce, message, scope,
    expires_at: expiresAt, created_at: new Date().toISOString(),
  });

  res.json({ challengeId, message, scope, expiresAt, nonce });
});

// POST /api/auth/verify — Step 2: Submit signed challenge, get JWT token
app.post('/api/auth/verify', async (req, res) => {
  const { challengeId, signature, wallet } = req.body;
  if (!challengeId || !signature || !wallet) {
    return res.status(400).json({ error: 'challengeId, signature, and wallet required' });
  }

  const challenge = stmts.getChallenge.get(challengeId);
  if (!challenge) return res.status(404).json({ error: 'Challenge not found' });
  if (challenge.used) return res.status(409).json({ error: 'Challenge already used' });
  if (new Date(challenge.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Challenge expired. Request a new one.' });
  }

  // Verify wallet signature
  try {
    const valid = await verifyMessage({
      address: wallet,
      message: challenge.message,
      signature,
    });
    if (!valid) return res.status(401).json({ error: 'Invalid signature' });
  } catch (err) {
    return res.status(401).json({ error: 'Signature verification failed: ' + err.message });
  }

  // Find agent owned by this wallet
  let agentId = challenge.agent_id;
  let agent;
  if (agentId) {
    agent = stmts.getAgentById.get(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (agent.owner_wallet.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(403).json({ error: 'Wallet does not own this agent' });
    }
  } else {
    // Find first agent owned by wallet
    const agents = stmts.getAgentsByOwner.all(wallet);
    if (agents.length === 0) return res.status(404).json({ error: 'No agents found for this wallet. Register an agent first.' });
    agent = agents[0];
    agentId = agent.id;
  }

  // Mark challenge as used
  stmts.markChallengeUsed.run(challengeId);

  // Issue JWT
  const tokenId = `tok-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const token = jwt.sign({
    sub: agentId,
    wallet: wallet.toLowerCase(),
    scope: challenge.scope,
    agentName: agent.agent_name,
    jti: tokenId,
  }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

  stmts.insertAuthToken.run({
    id: tokenId, agent_id: agentId, wallet: wallet.toLowerCase(),
    scope: challenge.scope, expires_at: expiresAt,
    created_at: new Date().toISOString(),
  });

  emitFeedEvent('agent:authenticated', { agentId, agentName: agent.agent_name });

  res.json({
    token,
    tokenId,
    agentId,
    agentName: agent.agent_name,
    scope: challenge.scope,
    expiresAt,
    usage: {
      header: `Authorization: Bearer ${token}`,
      curl: `curl -H "Authorization: Bearer ${token}" ${req.protocol}://${req.get('host')}/api/auth/me`,
    },
  });
});

// GET /api/auth/me — Introspect current token
app.get('/api/auth/me', requireAuth, (req, res) => {
  const agent = stmts.getAgentById.get(req.auth.sub);
  const reputation = calculateReputation(req.auth.sub);
  res.json({
    authenticated: true,
    agentId: req.auth.sub,
    agentName: req.auth.agentName,
    wallet: agent?.turnkey_address || req.auth.wallet,
    scope: req.auth.scope,
    tokenId: req.auth.jti,
    reputation,
    agent: agent ? agentToJSON(agent) : null,
  });
});

// POST /api/auth/revoke — Revoke a token
app.post('/api/auth/revoke', requireAuth, (req, res) => {
  const tokenId = req.body.tokenId || req.auth.jti;
  const tokenRecord = stmts.getAuthToken.get(tokenId);
  if (!tokenRecord) return res.status(404).json({ error: 'Token not found' });
  // Can only revoke own tokens
  if (tokenRecord.wallet !== req.auth.wallet) {
    return res.status(403).json({ error: 'Can only revoke your own tokens' });
  }
  stmts.revokeAuthToken.run(tokenId);
  res.json({ success: true, revoked: tokenId });
});

// GET /api/auth/tokens — List active tokens for authenticated agent
app.get('/api/auth/tokens', requireAuth, (req, res) => {
  const tokens = stmts.getTokensByAgent.all(req.auth.sub);
  res.json({
    tokens: tokens.map(t => ({
      id: t.id, scope: t.scope, createdAt: t.created_at, expiresAt: t.expires_at,
    })),
  });
});

// ── Error handler ──
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Max 20MB.' });
  if (err) return res.status(400).json({ error: err.message });
  next();
});

// ── Graceful shutdown ──
process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });

app.listen(PORT, () => {
  console.log(`\n  BARD API Server (SQLite + x402 + Agent Reputation)`);
  console.log(`  ───────────────────────────────────────────────────`);
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Health:   http://localhost:${PORT}/api/health`);
  console.log(`  Agents:   http://localhost:${PORT}/api/agents`);
  console.log(`  x402:     http://localhost:${PORT}/api/x402/info`);
  console.log(`  Seller:   ${SELLER_ADDRESS}`);
  console.log(`  DB:       ${DB_PATH}\n`);
});
