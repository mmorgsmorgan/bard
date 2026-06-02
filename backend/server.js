import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { createHash, randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';
import { formatUnits, verifyMessage, createPublicClient, http, parseUnits } from 'viem';
import { isTurnkeyEnabled, mintERC8004Identity, getOrCreateAgentWallet } from './turnkey-wallet.js';
import { pool, query, initSchema, stmts } from './db.js';
import { isR2Enabled, uploadToR2, deleteFromR2, generateFilename } from './r2-storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;

// Railway/Vercel sit behind a proxy that sets X-Forwarded-Proto.
// Without this, req.protocol returns 'http' and upload URLs get saved as
// http://... which Vercel blocks as mixed content.
app.set('trust proxy', 1);

// ── Seller wallet (receives USDC nanopayments) ──
const SELLER_ADDRESS = process.env.SELLER_ADDRESS || '0xb93E4681a57e2bF801e223E13Ba3b1b3c042e28a';

// ── Platform owner wallet (Stage 1 escrow verifier) ──
const PLATFORM_OWNER_WALLET = (process.env.PLATFORM_OWNER_WALLET || SELLER_ADDRESS).toLowerCase();

// ── Swarms API configuration ──
const SWARMS_API_KEY = process.env.SWARMS_API_KEY || '';
const SWARMS_PLATFORM_MARKUP_PCT = parseFloat(process.env.SWARMS_PLATFORM_MARKUP_PCT || '20');
const SWARMS_API_BASE = 'https://api.swarms.world';
const SWARMS_WEBHOOK_SECRET = process.env.SWARMS_WEBHOOK_SECRET || '';

// ── Arc Testnet RPC for transaction verification ──
const ARC_TESTNET_RPC = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
// Arc Testnet exposes USDC as a system contract; the ERC-20 interface lives at
// 0x3600...0000 (6 decimals). The previous default (0x036C...) was Base Sepolia's
// USDC and would silently fail with "contract function returned no data" on Arc.
const USDC_CONTRACT_ADDRESS = process.env.USDC_CONTRACT_ADDRESS || '0x3600000000000000000000000000000000000000';

// Create viem public client for Arc Testnet
const arcTestnetClient = createPublicClient({
  chain: {
    id: 5042002,
    name: 'Arc Testnet',
    network: 'arc-testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
      default: { http: [ARC_TESTNET_RPC] },
      public: { http: [ARC_TESTNET_RPC] }
    }
  },
  transport: http(ARC_TESTNET_RPC)
});

// ── CORS ──
const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// ── Security headers (helmet) ──
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https:", "wss:"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    }
  },
  crossOriginEmbedderPolicy: false, // Allow R2 cross-origin loads
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow R2 image loads
}));

app.use(cors({
  origin: (origin, callback) => {
    const allowed = [...DEFAULT_ALLOWED_ORIGINS, ...ALLOWED_ORIGINS];
    if (!origin || allowed.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked origin: ${origin}`));
  },
  allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Accept'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ══════════════════════════════════════════════════════
// ── MCP redirect → standalone MCP service ──
// ══════════════════════════════════════════════════════
// MCP now runs as its own Railway service. Old clients pointed at
// `<backend>/mcp` get a 308 so they auto-rewrite to the new host. Set
// MCP_URL on this service (Railway env) to the MCP service's public URL.

const MCP_URL = (process.env.MCP_URL || '').replace(/\/$/, '');

app.all('/mcp', (req, res) => {
  if (!MCP_URL) {
    return res.status(503).json({
      error: 'MCP service not configured. Set MCP_URL env var on the backend.',
    });
  }
  res.redirect(308, `${MCP_URL}/mcp`);
});

// ── Static file serving ──
// ── Static file serving ──
// On Railway, uploads MUST land on a mounted volume to survive redeploys.
// Set UPLOADS_DIR=/data/uploads and attach a volume at /data, OR move uploads
// to object storage (R2/S3) — see the deployment notes in .env.example.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
try {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
} catch (err) {
  console.error(`  ✗ Could not create uploads directory at ${UPLOADS_DIR}:`, err.message);
  console.error('    Hint: on Railway, mount a volume at /data and set UPLOADS_DIR=/data/uploads.');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && !UPLOADS_DIR.startsWith('/data') && !process.env.UPLOADS_BUCKET) {
  console.warn(`  ! WARNING: UPLOADS_DIR=${UPLOADS_DIR} is inside the ephemeral container filesystem.`);
  console.warn('    Uploaded files will be WIPED on every Railway redeploy.');
  console.warn('    Fix: attach a Railway volume at /data and set UPLOADS_DIR=/data/uploads.');
}
app.use('/uploads', express.static(UPLOADS_DIR));

// ══════════════════════════════════════════════════════
// ── Database (Postgres via ./db.js) ──
// ══════════════════════════════════════════════════════
//
// Schema/prepared statements live in ./db.js. Bootstrap happens in the async
// startup IIFE at the bottom of this file, before app.listen().

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
  'auth_challenge': { max: 10, window: 60 },  // 10 challenges per minute per IP
  'auth_verify': { max: 10, window: 60 },     // 10 verify attempts per minute per IP
  'bounty_propose': { max: 5, window: 3600 },  // 5 proposals per hour per agent
  'bounty_message': { max: 60, window: 3600 }, // 60 messages per hour per wallet
};

async function checkRateLimit(key, action) {
  const limits = RATE_LIMITS[action];
  if (!limits) return true;
  const fullKey = `${key}:${action}`;
  const now = Math.floor(Date.now() / 1000);
  const row = (await pool.query('SELECT count, window_start FROM rate_limits WHERE key = $1', [fullKey])).rows[0];
  if (!row || (now - row.window_start) > limits.window) {
    await pool.query(
      `INSERT INTO rate_limits (key, count, window_start) VALUES ($1, 1, $2)
       ON CONFLICT (key) DO UPDATE SET count = 1, window_start = EXCLUDED.window_start`,
      [fullKey, now]
    );
    return true;
  }
  if (row.count >= limits.max) return false;
  await pool.query('UPDATE rate_limits SET count = count + 1 WHERE key = $1', [fullKey]);
  return true;
}

// ── Reputation Decay (runs every hour) ──
async function runReputationDecay() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - (30 * 24 * 3600);
    const oneWeekSeconds = 7 * 24 * 3600;

    const { rows: inactiveAgents } = await pool.query(
      "SELECT id, reputation_score, last_active_at FROM agents WHERE status = 'active' AND reputation_score > 0 AND last_active_at IS NOT NULL AND last_active_at < $1",
      [thirtyDaysAgo]
    );

    let decayed = 0;
    for (const agent of inactiveAgents) {
      const weeksInactive = Math.floor((now - agent.last_active_at - 30 * 24 * 3600) / oneWeekSeconds);
      if (weeksInactive > 0) {
        const decay = Math.min(weeksInactive * 5, agent.reputation_score);
        if (decay > 0) {
          await pool.query(
            'UPDATE agents SET reputation_score = GREATEST(0, reputation_score - $1) WHERE id = $2',
            [decay, agent.id]
          );
          decayed++;
        }
      }
    }
    if (decayed > 0) console.log(`  Reputation decay: ${decayed} agents affected`);
  } catch (err) {
    console.error('Reputation decay error:', err.message);
  }
}

// ── Escrow Expiry Check ──
async function checkEscrowExpiry() {
  try {
    const now = new Date().toISOString();
    const { rows: expired } = await pool.query(
      "SELECT id, title, escrow_budget_usdc, creator_wallet, provider_agent_id, escrow_status FROM bounties WHERE expires_at IS NOT NULL AND expires_at < $1 AND escrow_status IN ('funded', 'claimed', 'submitted')",
      [now]
    );
    for (const b of expired) {
      try {
        await pool.query(
          "UPDATE bounties SET escrow_status = 'refunded', status = 'expired', updated_at = $1 WHERE id = $2",
          [now, b.id]
        );
        const evtId = `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await pool.query(
          `INSERT INTO escrow_events (id, bounty_id, event_type, actor_wallet, actor_type, details, tx_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [evtId, b.id, 'expired', '', 'system', `Escrow expired. ${b.escrow_budget_usdc} USDC auto-refunded.`, '', now]
        );
        console.log(`  Escrow expired: ${b.id} (${b.escrow_budget_usdc} USDC refunded)`);
      } catch (err) {
        console.error(`  Escrow expiry error for ${b.id}:`, err.message);
      }
    }

    // Auto-revert stuck proposal_selected bounties (creator never funded within 24h of accept)
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { rows: stuck } = await pool.query(
      `SELECT b.id, b.title, b.creator_wallet, b.selected_proposal_id, p.proposer_agent_id, p.accepted_at
       FROM bounties b
       LEFT JOIN bounty_proposals p ON b.selected_proposal_id = p.id
       WHERE b.status = 'proposal_selected' AND b.escrow_status = 'none' AND p.accepted_at < $1`,
      [cutoff]
    );
    for (const b of stuck) {
      try {
        await pool.query(
          "UPDATE bounties SET status = 'proposal_open', selected_proposal_id = NULL, updated_at = $1 WHERE id = $2",
          [now, b.id]
        );
        // Re-open the previously accepted proposal so the agent can update or others can compete
        if (b.selected_proposal_id) {
          await pool.query(
            "UPDATE bounty_proposals SET status = 'pending', accepted_at = NULL, updated_at = $1 WHERE id = $2",
            [now, b.selected_proposal_id]
          );
        }
        await createNotification({ wallet: b.creator_wallet, type: 'system', title: 'Selection Reset', message: `"${b.title}" reverted to proposals open — you didn't fund within 24h of accepting.`, from: 'BARD System' });
        if (b.proposer_agent_id) {
          await createNotification({ agentId: b.proposer_agent_id, type: 'system', title: 'Selection Reset', message: `Your accepted proposal for "${b.title}" reverted because the creator didn't fund within 24h.`, from: 'BARD System' });
        }
        console.log(`  Proposal selection reverted: ${b.id} (unfunded after 24h)`);
      } catch (err) {
        console.error(`  Proposal revert error for ${b.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Escrow expiry sweep error:', err.message);
  }
}

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
    githubRepo: row.github_repo || undefined,
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
async function createNotification({ wallet, agentId, type, title, message, from, amount }) {
  const id = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const targets = new Set();

  // Direct wallet target
  if (wallet) targets.add(wallet.toLowerCase());

  // Agent target — notify via owner_wallet
  if (agentId) {
    const agent = await stmts.getAgentById(agentId);
    if (agent?.owner_wallet) targets.add(agent.owner_wallet.toLowerCase());
  }

  for (const target of targets) {
    try {
      await stmts.insertNotification({
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

async function contributionWithVerifications(row) {
  const json = contributionToJSON(row);
  if (!json) return null;
  const counts = (await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN result='approved' THEN 1 ELSE 0 END),0) as approvals,
            COALESCE(SUM(CASE WHEN result='rejected' THEN 1 ELSE 0 END),0) as rejections
     FROM agent_verifications WHERE contribution_id = $1`, [row.id]
  )).rows[0];
  json.approvals = Number(counts?.approvals || 0);
  json.rejections = Number(counts?.rejections || 0);
  return json;
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
async function calculateReputation(agentId) {
  const contributions = await stmts.getContributionsByAgent(agentId);
  const verified = contributions.filter(c => c.status === 'verified').length;
  const pending = contributions.filter(c => c.status === 'pending').length;
  const rejected = contributions.filter(c => c.status === 'rejected').length;
  let totalEndorsements = 0;
  for (const c of contributions) {
    totalEndorsements += c.endorsement_count || 0;
  }

  const agent = await stmts.getAgentById(agentId);
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
  await stmts.updateAgentReputation(score, contributions.length, totalEndorsements, agentId);
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

// Require JWT_SECRET in production
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET must be set in production for security');
  process.exit(1);
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header required. Use: Bearer <token>' });
  }
  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Check if token is revoked
    const tokenRecord = await stmts.getAuthToken(decoded.jti);
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

// Helper: log payment to Postgres
async function logPayment(req, endpoint) {
  if (req.payment) {
    const { payer, amount, network, transaction } = req.payment;
    const formattedAmount = formatUnits(BigInt(amount), 6);
    console.log(`  Payment: ${formattedAmount} USDC from ${payer.slice(0, 8)}... on ${network}`);
    try {
      await stmts.insertPayment({
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

// Use memory storage when R2 is enabled, disk storage otherwise
const storage = isR2Enabled
  ? multer.memoryStorage()
  : multer.diskStorage({
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

app.get('/api/health', async (req, res) => {
  try {
    const profileCount = (await pool.query('SELECT COUNT(*) as count FROM profiles')).rows[0].count;
    const paymentStats = await stmts.getPaymentStats();

    // Check platform wallet balance (non-blocking, optional)
    let walletBalance = null;
    try {
      const balance = await getPlatformWalletBalance();
      walletBalance = { balance_usdc: balance.toFixed(2), status: balance > 100 ? 'ok' : 'low' };
    } catch (err) {
      walletBalance = { error: 'Balance check unavailable' };
    }

    res.json({
      status: 'ok', uptime: process.uptime(), profiles: Number(profileCount), db: 'postgres',
      x402: !!gateway, sellerAddress: SELLER_ADDRESS,
      payments: { total: Number(paymentStats.total_payments), volumeUSDC: Number(paymentStats.total_amount) },
      storage: isR2Enabled ? 'r2' : 'local',
      r2Bucket: isR2Enabled ? process.env.R2_BUCKET_NAME : null,
      turnkey: isTurnkeyEnabled(),
      platformWallet: walletBalance,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// GET /api/storage/stats — Storage usage metrics
app.get('/api/storage/stats', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const stats = await stmts.getStorageStats(days);

    res.json({
      period_days: days,
      total_operations: parseInt(stats.total_operations) || 0,
      successful_operations: parseInt(stats.successful_operations) || 0,
      failed_operations: parseInt(stats.failed_operations) || 0,
      uploads: parseInt(stats.uploads) || 0,
      deletes: parseInt(stats.deletes) || 0,
      total_bytes_uploaded: parseInt(stats.total_bytes_uploaded) || 0,
      total_mb_uploaded: ((parseInt(stats.total_bytes_uploaded) || 0) / (1024 * 1024)).toFixed(2),
      r2_operations: parseInt(stats.r2_operations) || 0,
      local_operations: parseInt(stats.local_operations) || 0,
      success_rate: stats.total_operations > 0
        ? ((stats.successful_operations / stats.total_operations) * 100).toFixed(1)
        : '0.0'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/platform/wallet/balance — Platform escrow wallet balance and obligations
app.get('/api/platform/wallet/balance', async (req, res) => {
  try {
    // Get on-chain balance
    const balance = await getPlatformWalletBalance();

    // Calculate pending obligations (funded but not yet released/refunded)
    const obligationsResult = await pool.query(
      `SELECT
        COALESCE(SUM(escrow_budget_usdc), 0) as total_obligations,
        COUNT(*) as obligation_count
      FROM bounties
      WHERE escrow_status IN ('funded', 'claimed', 'submitted', 'client_approved', 'disputed')`
    );

    const obligations = obligationsResult.rows[0];
    const totalObligations = parseFloat(obligations.total_obligations) || 0;
    const obligationCount = parseInt(obligations.obligation_count) || 0;
    const availableBalance = balance - totalObligations;

    // Determine health status
    let status = 'healthy';
    let warning = null;
    if (availableBalance < 0) {
      status = 'critical';
      warning = 'Platform wallet does NOT have enough USDC to cover all obligations!';
    } else if (availableBalance < 100) {
      status = 'low';
      warning = 'Platform wallet balance is running low. Consider refunding.';
    } else if (availableBalance < 500) {
      status = 'warning';
      warning = 'Platform wallet balance is below recommended threshold.';
    }

    res.json({
      address: SELLER_ADDRESS,
      network: 'Arc Testnet',
      balance_usdc: balance.toFixed(2),
      pending_obligations_usdc: totalObligations.toFixed(2),
      pending_obligation_count: obligationCount,
      available_balance_usdc: availableBalance.toFixed(2),
      status,
      warning,
      explorer_url: `https://testnet.arcscan.app/address/${SELLER_ADDRESS}`
    });
  } catch (err) {
    console.error('Platform wallet balance check failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/platform/wallet/transfers — Recent platform wallet transfers
app.get('/api/platform/wallet/transfers', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    // Get recent escrow events with transaction hashes
    const { rows: transfers } = await pool.query(
      `SELECT id, bounty_id, event_type, actor_wallet, details, tx_hash, created_at
       FROM escrow_events
       WHERE event_type IN ('released', 'refunded', 'platform_fee') AND tx_hash != ''
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    res.json({
      transfers,
      count: transfers.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// ── Routes: x402 Premium Endpoints ──
// ══════════════════════════════════════════════════════

// Premium: Full trust analytics for a contributor
if (gateway) {
  app.get('/api/premium/trust-report/:wallet', gateway.require('$0.01'), async (req, res) => {
    await logPayment(req, '/api/premium/trust-report');
    const wallet = req.params.wallet;
    const profile = profileToJSON(await stmts.getProfileByWallet(wallet));
    const proofs = (await stmts.getProofsByWallet(wallet)).map(proofToJSON);
    const portfolio = (await stmts.getPortfolioByWallet(wallet)).map(portfolioToJSON);

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
  app.get('/api/premium/leaderboard', gateway.require('$0.01'), async (req, res) => {
    await logPayment(req, '/api/premium/leaderboard');
    const rows = await stmts.getAllProfiles();
    const profiles = [];
    for (const row of rows) {
      const p = profileToJSON(row);
      const proofs = await stmts.getProofsByWallet(row.wallet);
      const portfolio = await stmts.getPortfolioByWallet(row.wallet);
      const validatedProofs = proofs.filter(pr => pr.status === 'validated').length;
      profiles.push({
        ...p,
        stats: {
          proofs: proofs.length,
          validatedProofs,
          portfolioItems: portfolio.length,
          trustScore: Math.min(100, (validatedProofs * 15) + (proofs.length * 5) + (portfolio.length * 3)),
        },
      });
    }

    profiles.sort((a, b) => b.stats.trustScore - a.stats.trustScore);
    res.json({ leaderboard: profiles, total: profiles.length, paid_by: req.payment?.payer });
  });

  // Premium: Export full profile data as JSON
  app.get('/api/premium/export/:wallet', gateway.require('$0.005'), async (req, res) => {
    await logPayment(req, '/api/premium/export');
    const wallet = req.params.wallet;
    const profile = profileToJSON(await stmts.getProfileByWallet(wallet));
    const proofs = (await stmts.getProofsByWallet(wallet)).map(proofToJSON);
    const portfolio = (await stmts.getPortfolioByWallet(wallet)).map(portfolioToJSON);
    const notifications = (await stmts.getNotificationsByWallet(wallet)).map(notifToJSON);

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

app.post('/api/profiles', async (req, res) => {
  const p = req.body;
  if (!p.wallet || !p.username) return res.status(400).json({ error: 'wallet and username required' });
  try {
    await stmts.upsertProfile({
      wallet: p.wallet, username: p.username,
      display_name: p.displayName || '', bio: p.bio || '',
      profile_type: p.profileType || 'human',
      ecosystems: JSON.stringify(p.ecosystems || []),
      farcaster: p.farcaster || '', github: p.github || '',
      x: p.x || '', discord: p.discord || '', linkedin: p.linkedin || '',
      pfp: p.pfp || '',
      created_at: p.createdAt || new Date().toISOString(),
    });
    const saved = await stmts.getProfileByWallet(p.wallet);
    res.json({ success: true, profile: profileToJSON(saved) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/profiles/wallet/:wallet', async (req, res) => {
  const row = await stmts.getProfileByWallet(req.params.wallet);
  res.json({ profile: profileToJSON(row) });
});

app.get('/api/profiles/username/:username', async (req, res) => {
  const row = await stmts.getProfileByUsername(req.params.username);
  res.json({ profile: profileToJSON(row) });
});

app.get('/api/profiles', async (req, res) => {
  const rows = await stmts.getAllProfiles();
  res.json({ profiles: rows.map(profileToJSON) });
});

// ══════════════════════════════════════════════════════
// ── Routes: Proofs ──
// ══════════════════════════════════════════════════════

app.post('/api/proofs', async (req, res) => {
  const p = req.body;
  if (!p.id || !p.contributor) return res.status(400).json({ error: 'id and contributor required' });
  try {
    await stmts.insertProof({
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

app.get('/api/proofs/:wallet', async (req, res) => {
  const rows = await stmts.getProofsByWallet(req.params.wallet);
  res.json({ proofs: rows.map(proofToJSON) });
});

// ══════════════════════════════════════════════════════
// ── Routes: Portfolio ──
// ══════════════════════════════════════════════════════

app.post('/api/portfolio', async (req, res) => {
  const p = req.body;
  if (!p.id || !p.wallet) return res.status(400).json({ error: 'id and wallet required' });
  try {
    await stmts.insertPortfolio({
      id: p.id, wallet: p.wallet, title: p.title || '',
      description: p.description || '', category: p.category || 'other',
      image_url: p.imageDataURI || '', external_link: p.externalLink || '',
      github_repo: p.githubRepo || '',
      tags: JSON.stringify(p.tags || []),
      created_at: p.createdAt || new Date().toISOString(),
      sort_order: p.order || 0,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/portfolio/:wallet', async (req, res) => {
  const rows = await stmts.getPortfolioByWallet(req.params.wallet);
  res.json({ portfolio: rows.map(portfolioToJSON) });
});

app.delete('/api/portfolio/:id', async (req, res) => {
  const result = await stmts.deletePortfolio(req.params.id);
  res.json({ success: true, deleted: result.changes > 0 });
});

app.put('/api/portfolio/reorder', async (req, res) => {
  const { wallet, orderedIds } = req.body;
  if (!wallet || !orderedIds) return res.status(400).json({ error: 'wallet and orderedIds required' });
  // Sequential reorder. (SQLite version used db.transaction() to batch these —
  // Postgres equivalent would require a pool.connect() + BEGIN/COMMIT block.
  // The previous batched version had no atomicity requirement either, so we
  // keep this sequential and treat the call as best-effort.)
  for (let i = 0; i < orderedIds.length; i++) {
    await stmts.updatePortfolioOrder(i, orderedIds[i]);
  }
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════
// ── Routes: Notifications ──
// ══════════════════════════════════════════════════════

app.post('/api/notifications', async (req, res) => {
  const n = req.body;
  if (!n.wallet) return res.status(400).json({ error: 'wallet required' });
  const id = n.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await stmts.insertNotification({
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

app.get('/api/notifications/:wallet', async (req, res) => {
  const rows = await stmts.getNotificationsByWallet(req.params.wallet);
  res.json({ notifications: rows.map(notifToJSON) });
});

app.put('/api/notifications/:id/read', async (req, res) => {
  await stmts.markRead(req.params.id);
  res.json({ success: true });
});

app.put('/api/notifications/:wallet/read-all', async (req, res) => {
  await stmts.markAllRead(req.params.wallet);
  res.json({ success: true });
});

// ── Agent Notifications ──
// Agents can read notifications addressed to their owner wallet (which includes cross-entity notifs).
app.get('/api/agents/:id/notifications', requireAuth, async (req, res) => {
  try {
    if (req.auth.agentId !== req.params.id) {
      return res.status(403).json({ error: 'Can only read your own notifications' });
    }
    const agent = await stmts.getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const wallets = new Set();
    if (agent.owner_wallet) wallets.add(agent.owner_wallet.toLowerCase());

    let allNotifs = [];
    for (const w of wallets) {
      const rows = await stmts.getNotificationsByWallet(w);
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

app.post('/api/upload/portfolio', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    let url, filename;

    if (isR2Enabled) {
      try {
        // Upload to R2
        filename = generateFilename(req.file.originalname, req.body.wallet);
        url = await uploadToR2(req.file.buffer, filename, req.file.mimetype, 'portfolio', req.body.wallet);
      } catch (r2Error) {
        console.error('R2 upload failed, falling back to local storage:', r2Error.message);
        // Fallback to local disk storage
        const wallet = (req.body.wallet || 'unknown').toLowerCase().slice(0, 12);
        const ext = path.extname(req.file.originalname) || '.png';
        filename = `${wallet}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
        const dir = path.join(UPLOADS_DIR, 'portfolio');
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, filename);
        fs.writeFileSync(filePath, req.file.buffer);
        url = `${req.protocol}://${req.get('host')}/uploads/portfolio/${filename}`;
      }
    } else {
      // Local disk storage
      filename = req.file.filename;
      url = `${req.protocol}://${req.get('host')}/uploads/portfolio/${filename}`;
    }

    res.json({ success: true, url, filename, size: req.file.size, mimetype: req.file.mimetype });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Multi-file portfolio upload
app.post('/api/upload/portfolio/batch', upload.array('files', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  try {
    const results = [];
    const errors = [];

    for (const file of req.files) {
      try {
        let url, filename;

        if (isR2Enabled) {
          try {
            // Upload to R2
            filename = generateFilename(file.originalname, req.body.wallet);
            url = await uploadToR2(file.buffer, filename, file.mimetype, 'portfolio');
          } catch (r2Error) {
            console.error('R2 upload failed, falling back to local storage:', r2Error.message);
            // Fallback to local disk storage
            const wallet = (req.body.wallet || 'unknown').toLowerCase().slice(0, 12);
            const ext = path.extname(file.originalname) || '.png';
            filename = `${wallet}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
            const dir = path.join(UPLOADS_DIR, 'portfolio');
            fs.mkdirSync(dir, { recursive: true });
            const filePath = path.join(dir, filename);
            fs.writeFileSync(filePath, file.buffer);
            url = `${req.protocol}://${req.get('host')}/uploads/portfolio/${filename}`;
          }
        } else {
          // Local disk storage
          filename = file.filename;
          url = `${req.protocol}://${req.get('host')}/uploads/portfolio/${filename}`;
        }

        results.push({
          success: true,
          url,
          filename,
          originalName: file.originalname,
          size: file.size,
          mimetype: file.mimetype
        });
      } catch (fileError) {
        errors.push({
          filename: file.originalname,
          error: fileError.message
        });
      }
    }

    res.json({
      success: true,
      uploaded: results.length,
      failed: errors.length,
      results,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/upload/pfp', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    let url, filename;

    if (isR2Enabled) {
      try {
        // Upload to R2
        filename = generateFilename(req.file.originalname, req.body.wallet);
        url = await uploadToR2(req.file.buffer, filename, req.file.mimetype, 'pfp');
      } catch (r2Error) {
        console.error('R2 upload failed, falling back to local storage:', r2Error.message);
        // Fallback to local disk storage
        const wallet = (req.body.wallet || 'unknown').toLowerCase().slice(0, 12);
        const ext = path.extname(req.file.originalname) || '.png';
        filename = `${wallet}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
        const dir = path.join(UPLOADS_DIR, 'pfp');
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, filename);
        fs.writeFileSync(filePath, req.file.buffer);
        url = `${req.protocol}://${req.get('host')}/uploads/pfp/${filename}`;
      }
    } else {
      // Local disk storage
      filename = req.file.filename;
      url = `${req.protocol}://${req.get('host')}/uploads/pfp/${filename}`;
    }

    res.json({ success: true, url, filename, size: req.file.size, mimetype: req.file.mimetype });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/upload/proof', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const wallet = (req.body.wallet || '').toLowerCase();
  const isVideo = req.file.mimetype.startsWith('video/');

  // Enforce 3-video limit per account
  let deletedOldest = null;
  if (isVideo && wallet) {
    const MAX_VIDEOS = 3;
    const { rows: walletVideos } = await pool.query(
      "SELECT id, file_url, timestamp FROM proofs WHERE LOWER(contributor) = $1 AND file_url != '' AND (file_url LIKE '%.mp4' OR file_url LIKE '%.webm' OR file_url LIKE '%.mov' OR file_url LIKE '%.avi' OR file_url LIKE '%.mkv') ORDER BY timestamp ASC",
      [wallet]
    );

    if (walletVideos.length >= MAX_VIDEOS) {
      // Delete the oldest video file
      const oldest = walletVideos[0];
      if (oldest.file_url) {
        try {
          if (isR2Enabled) {
            // Extract R2 key from URL
            const urlObj = new URL(oldest.file_url);
            const key = urlObj.pathname.substring(1); // Remove leading /
            await deleteFromR2(key);
          } else {
            // Delete from local disk
            const filename = oldest.file_url.split('/').pop();
            const filePath = path.join(UPLOADS_DIR, 'portfolio', filename);
            fs.unlinkSync(filePath);
          }
        } catch (err) {
          console.error('Failed to delete old video:', err);
        }
        // Clear the file_url but keep the proof post
        await pool.query("UPDATE proofs SET file_url = '' WHERE id = $1", [oldest.id]);
        deletedOldest = { proofId: oldest.id, removedFile: oldest.file_url };
      }
    }
  }

  try {
    let url, filename;

    if (isR2Enabled) {
      try {
        // Upload to R2
        filename = generateFilename(req.file.originalname, wallet);
        url = await uploadToR2(req.file.buffer, filename, req.file.mimetype, 'portfolio');
      } catch (r2Error) {
        console.error('R2 upload failed, falling back to local storage:', r2Error.message);
        // Fallback to local disk storage
        const walletPrefix = (wallet || 'unknown').toLowerCase().slice(0, 12);
        const ext = path.extname(req.file.originalname) || '.png';
        filename = `${walletPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
        const dir = path.join(UPLOADS_DIR, 'portfolio');
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, filename);
        fs.writeFileSync(filePath, req.file.buffer);
        url = `${req.protocol}://${req.get('host')}/uploads/portfolio/${filename}`;
      }
    } else {
      // Local disk storage
      filename = req.file.filename;
      url = `${req.protocol}://${req.get('host')}/uploads/portfolio/${filename}`;
    }

    res.json({ success: true, url, filename, size: req.file.size, mimetype: req.file.mimetype, deletedOldest });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Agent proxy: upload proof on behalf of linked human
app.post('/api/agents/:id/upload-proof', requireAuth, upload.single('file'), async (req, res) => {
  try {
    // Verify the calling agent
    if (req.auth.agentId !== req.params.id) {
      return res.status(403).json({ error: 'You can only upload proofs for your own agent.' });
    }

    const agent = await stmts.getAgentById(req.params.id);
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
        if (!isR2Enabled) {
          try { fs.unlinkSync(req.file.path); } catch {}
        }
        return res.status(400).json({ error: 'Video must be under 25MB' });
      }

      // Enforce 3-video limit for the human's account
      const humanWallet = agent.owner_wallet.toLowerCase();
      if (req.file.mimetype.startsWith('video/')) {
        const { rows: walletVideos } = await pool.query(
          "SELECT id, file_url FROM proofs WHERE LOWER(contributor) = $1 AND file_url != '' AND (file_url LIKE '%.mp4' OR file_url LIKE '%.webm' OR file_url LIKE '%.mov' OR file_url LIKE '%.avi' OR file_url LIKE '%.mkv') ORDER BY timestamp ASC",
          [humanWallet]
        );
        if (walletVideos.length >= 3) {
          const oldest = walletVideos[0];
          if (oldest.file_url) {
            try {
              if (isR2Enabled) {
                const urlObj = new URL(oldest.file_url);
                const key = urlObj.pathname.substring(1);
                await deleteFromR2(key);
              } else {
                const filename = oldest.file_url.split('/').pop();
                fs.unlinkSync(path.join(UPLOADS_DIR, 'portfolio', filename));
              }
            } catch {}
            await pool.query("UPDATE proofs SET file_url = '' WHERE id = $1", [oldest.id]);
          }
        }

        // Also enforce 3-video limit per agent (submitted_by)
        const { rows: agentVideos } = await pool.query(
          "SELECT id, file_url FROM proofs WHERE submitted_by = $1 AND file_url != '' AND (file_url LIKE '%.mp4' OR file_url LIKE '%.webm' OR file_url LIKE '%.mov' OR file_url LIKE '%.avi' OR file_url LIKE '%.mkv') ORDER BY timestamp ASC",
          [agent.id]
        );
        if (agentVideos.length >= 3) {
          const oldest = agentVideos[0];
          if (oldest.file_url) {
            try {
              if (isR2Enabled) {
                const urlObj = new URL(oldest.file_url);
                const key = urlObj.pathname.substring(1);
                await deleteFromR2(key);
              } else {
                const filename = oldest.file_url.split('/').pop();
                fs.unlinkSync(path.join(UPLOADS_DIR, 'portfolio', filename));
              }
            } catch {}
            await pool.query("UPDATE proofs SET file_url = '' WHERE id = $1", [oldest.id]);
          }
        }
      }

      // Upload file
      if (isR2Enabled) {
        const filename = generateFilename(req.file.originalname, humanWallet);
        fileUrl = await uploadToR2(req.file.buffer, filename, req.file.mimetype, 'portfolio');
      } else {
        fileUrl = `${req.protocol}://${req.get('host')}/uploads/portfolio/${req.file.filename}`;
      }
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

    // Store in proofs table. file_url and submitted_by columns now exist in the
    // initial schema (see db.js), so the previous try/catch + ALTER TABLE fallback
    // is no longer needed.
    await pool.query(
      `INSERT INTO proofs (id, title, ecosystem, contribution_type, description, external_links, file_url, contributor, submitted_by, status, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'unvalidated', $10)`,
      [proof.id, proof.title, proof.ecosystem, proof.contributionType, proof.description, proof.externalLinks,
       proof.fileUrl || '', proof.wallet, proof.submittedBy, proof.createdAt]
    );

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

app.delete('/api/files/:type/:filename', async (req, res) => {
  const { type, filename } = req.params;
  if (!['portfolio', 'pfp'].includes(type)) return res.status(400).json({ error: 'Invalid type' });

  try {
    if (isR2Enabled) {
      // Delete from R2
      const key = `${type}/${filename}`;
      await deleteFromR2(key);
      res.json({ success: true });
    } else {
      // Delete from local disk
      const filePath = path.join(UPLOADS_DIR, type, filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'File not found' });
      }
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// ── Swarm Execution Helpers ──
// ══════════════════════════════════════════════════════

function encryptApiKey(plaintext) {
  const key = scryptSync(process.env.JWT_SECRET || 'default-secret', 'salt', 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag().toString('base64');
  return JSON.stringify({ encrypted, iv: iv.toString('base64'), authTag });
}

function decryptApiKey(ciphertext) {
  const { encrypted, iv, authTag } = JSON.parse(ciphertext);
  const key = scryptSync(process.env.JWT_SECRET || 'default-secret', 'salt', 32);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  let decrypted = decipher.update(encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

async function executeSwarm(agent, task, bountyId) {
  const executionId = `swarm-exec-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();

  try {
    // Parse swarm config
    const swarmConfig = JSON.parse(agent.swarm_config || '{}');
    const { swarm_type, agents: swarmAgents, user_swarms_api_key_encrypted } = swarmConfig;

    if (!swarm_type || !swarmAgents) {
      throw new Error('Invalid swarm_config: missing swarm_type or agents');
    }

    // Determine API key
    let apiKey;
    if (agent.is_platform_owned === 1) {
      apiKey = SWARMS_API_KEY;
      if (!apiKey) throw new Error('Platform SWARMS_API_KEY not configured');
    } else {
      if (!user_swarms_api_key_encrypted) throw new Error('User swarm missing API key');
      apiKey = decryptApiKey(user_swarms_api_key_encrypted);
    }

    // Create execution record
    await pool.query(
      `INSERT INTO swarm_executions (id, bounty_id, agent_id, swarm_type, task, status, started_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [executionId, bountyId, agent.id, swarm_type, task, 'running', now, now]
    );

    // Call Swarms API with correct endpoint and format (5 minute timeout)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000); // 5 minutes

    try {
      const response = await fetch(`${SWARMS_API_BASE}/v1/swarm/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey
        },
        body: JSON.stringify({
          name: agent.agent_name,
          description: agent.description || 'BARD swarm execution',
          task: task,
          swarm_type: swarm_type,
          agents: swarmAgents.map(a => ({
            agent_name: a.role,
            system_prompt: a.system_prompt,
            model_name: a.model,
            description: `${a.role} agent`,
            role: 'worker'
          })),
          max_loops: 1,
          stream: false
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Swarms API error: ${response.status} ${errorText}`);
      }
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError.name === 'AbortError') {
        throw new Error('Swarm execution timed out after 5 minutes');
      }
      throw fetchError;
    }

    const result = await response.json();
    const deliverable = result.output || result.completion || JSON.stringify(result);

    // Extract cost from response (default to $1.00 if not provided)
    const swarmsCostUsd = result.total_cost || result.cost_usd || 1.00;
    const platformMarkupUsd = agent.is_platform_owned === 1
      ? swarmsCostUsd * (SWARMS_PLATFORM_MARKUP_PCT / 100)
      : 0;
    const totalChargedUsd = swarmsCostUsd + platformMarkupUsd;

    // Update execution record
    await pool.query(
      `UPDATE swarm_executions
       SET status = $1, swarms_api_response = $2, swarms_cost_usd = $3,
           platform_markup_usd = $4, total_charged_usd = $5, completed_at = $6
       WHERE id = $7`,
      ['completed', JSON.stringify(result), swarmsCostUsd, platformMarkupUsd, totalChargedUsd, now, executionId]
    );

    return {
      executionId,
      deliverable,
      status: 'completed',
      costs: { swarmsCostUsd, platformMarkupUsd, totalChargedUsd }
    };

  } catch (error) {
    // Mark execution as failed
    await pool.query(
      `UPDATE swarm_executions SET status = $1, swarms_api_response = $2, completed_at = $3 WHERE id = $4`,
      ['failed', JSON.stringify({ error: error.message }), now, executionId]
    );

    throw error;
  }
}

// ══════════════════════════════════════════════════════
// ── Routes: Agent Reputation System ──
// ══════════════════════════════════════════════════════

// Register a new agent (owner signs with wallet)
app.post('/api/agents/register', async (req, res) => {
  const { ownerWallet, agentName, agentPublicKey, agentType, description, swarmConfig } = req.body;
  if (!ownerWallet || !agentName || !agentPublicKey) {
    return res.status(400).json({ error: 'ownerWallet, agentName, and agentPublicKey required' });
  }
  const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const insertData = {
      id, owner_wallet: ownerWallet, agent_name: agentName,
      agent_public_key: agentPublicKey, agent_type: agentType || 'general',
      description: description || '', created_at: new Date().toISOString(),
    };

    // If swarm config provided, encrypt the BYOK API key before storage
    if (swarmConfig) {
      try {
        const parsed = typeof swarmConfig === 'string' ? JSON.parse(swarmConfig) : swarmConfig;

        // Encrypt the user's Swarms API key if present
        if (parsed.user_swarms_api_key) {
          parsed.user_swarms_api_key_encrypted = encryptApiKey(parsed.user_swarms_api_key);
          delete parsed.user_swarms_api_key; // Never store plaintext
        }

        insertData.swarm_config = JSON.stringify(parsed);
        insertData.is_platform_owned = 0; // User-owned swarm
      } catch (err) {
        return res.status(400).json({ error: `Invalid swarmConfig: ${err.message}` });
      }
    }

    await stmts.insertAgent(insertData);

    // Initialize agent state
    await stmts.upsertAgentState({
      agent_id: id, context: JSON.stringify({ initialized: true }),
      updated_at: new Date().toISOString(),
    });
    const saved = await stmts.getAgentById(id);
    emitFeedEvent('agent:registered', agentToJSON(saved));
    await createNotification({ wallet: ownerWallet, type: 'system', title: 'Agent Registered', message: `${agentName} has been registered on BARD.`, from: 'BARD System' });

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

    await stmts.insertAuthToken({
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
app.get('/api/agents/owner/:wallet', async (req, res) => {
  const agents = await stmts.getAgentsByOwner(req.params.wallet);
  res.json({ agents: agents.map(agentToJSON) });
});

// Search agents (marketplace) — must be before :id
app.get('/api/agents/search', async (req, res) => {
  const { q, specialization, min_reputation, availability } = req.query;
  let sql = "SELECT * FROM agents WHERE status = 'active'";
  const params = [];
  let i = 1;

  if (q) { sql += ` AND (agent_name LIKE $${i} OR description LIKE $${i + 1})`; params.push(`%${q}%`, `%${q}%`); i += 2; }
  if (specialization) { sql += ` AND specializations LIKE $${i}`; params.push(`%${specialization}%`); i++; }
  if (min_reputation) { sql += ` AND reputation_score >= $${i}`; params.push(parseInt(min_reputation)); i++; }
  if (availability) { sql += ` AND availability = $${i}`; params.push(availability); i++; }

  sql += ' ORDER BY reputation_score DESC LIMIT 50';
  const { rows: agents } = await pool.query(sql, params);
  res.json({ agents: agents.map(agentToJSON), count: agents.length });
});

// Featured agents — must be before :id
app.get('/api/agents/featured', async (req, res) => {
  const { rows: agents } = await pool.query(
    "SELECT * FROM agents WHERE status = 'active' AND reputation_score > 0 ORDER BY reputation_score DESC, total_contributions DESC LIMIT 10"
  );
  res.json({ agents: agents.map(agentToJSON) });
});

// Get agent by ID
app.get('/api/agents/:id', async (req, res) => {
  const agent = await stmts.getAgentById(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const reputation = await calculateReputation(req.params.id);

  // Add performance analytics for swarm agents
  let performance = null;
  if (agent.agent_type === 'swarm') {
    const { rows: executions } = await pool.query(
      `SELECT
        COUNT(*) as total_executions,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_executions,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_executions,
        AVG(CASE WHEN status = 'completed' THEN swarms_cost_usd END) as avg_cost_usd,
        AVG(CASE WHEN status = 'completed' THEN total_charged_usd END) as avg_total_charged_usd,
        AVG(CASE WHEN status = 'completed' AND completed_at IS NOT NULL AND started_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (completed_at::timestamp - started_at::timestamp)) END) as avg_completion_time_seconds
      FROM swarm_executions
      WHERE agent_id = $1`,
      [req.params.id]
    );

    const stats = executions[0];
    const totalExecs = parseInt(stats.total_executions) || 0;
    const completedExecs = parseInt(stats.completed_executions) || 0;

    performance = {
      total_executions: totalExecs,
      completed_executions: completedExecs,
      failed_executions: parseInt(stats.failed_executions) || 0,
      success_rate: totalExecs > 0 ? (completedExecs / totalExecs * 100).toFixed(1) : '0.0',
      avg_cost_usd: stats.avg_cost_usd ? parseFloat(stats.avg_cost_usd).toFixed(2) : '0.00',
      avg_total_charged_usd: stats.avg_total_charged_usd ? parseFloat(stats.avg_total_charged_usd).toFixed(2) : '0.00',
      avg_completion_time_seconds: stats.avg_completion_time_seconds ? Math.round(stats.avg_completion_time_seconds) : 0,
      avg_completion_time_minutes: stats.avg_completion_time_seconds ? (stats.avg_completion_time_seconds / 60).toFixed(1) : '0.0'
    };
  }

  res.json({ agent: agentToJSON(agent), reputation, performance });
});

// Get all active agents (leaderboard)
app.get('/api/agents', async (req, res) => {
  const { status, specialization, min_reputation, availability, sort } = req.query;
  let sql = 'SELECT * FROM agents WHERE 1=1';
  const params = [];
  let i = 1;

  if (status) { sql += ` AND status = $${i}`; params.push(status); i++; }
  else { sql += " AND status = 'active'"; }

  if (availability) { sql += ` AND availability = $${i}`; params.push(availability); i++; }
  if (min_reputation) { sql += ` AND reputation_score >= $${i}`; params.push(parseInt(min_reputation)); i++; }
  if (specialization) {
    sql += ` AND specializations LIKE $${i}`;
    params.push(`%${specialization}%`);
    i++;
  }

  if (sort === 'reputation') sql += ' ORDER BY reputation_score DESC';
  else if (sort === 'earned') sql += ' ORDER BY total_earned_usdc DESC';
  else if (sort === 'recent') sql += ' ORDER BY created_at DESC';
  else sql += ' ORDER BY reputation_score DESC';

  const { rows: agents } = await pool.query(sql, params);
  res.json({ agents: agents.map(agentToJSON) });
});

// Update agent specializations
app.patch('/api/agents/:id/specializations', async (req, res) => {
  const { specializations } = req.body;
  if (!Array.isArray(specializations)) return res.status(400).json({ error: 'specializations must be an array' });
  const valid = ['research', 'code_review', 'data_analysis', 'content', 'verification', 'moderation', 'trading', 'other'];
  const filtered = specializations.filter(s => valid.includes(s));
  await pool.query('UPDATE agents SET specializations = $1 WHERE id = $2', [JSON.stringify(filtered), req.params.id]);
  res.json({ specializations: filtered });
});

// Update agent availability
app.patch('/api/agents/:id/availability', async (req, res) => {
  const { availability } = req.body;
  const valid = ['available', 'busy', 'offline', 'dormant'];
  if (!valid.includes(availability)) return res.status(400).json({ error: `Must be: ${valid.join(', ')}` });
  await pool.query('UPDATE agents SET availability = $1 WHERE id = $2', [availability, req.params.id]);
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
app.post('/api/agents/:id/generate-link-token', requireAuth, async (req, res) => {
  // Only the authenticated agent can generate its own link token
  if (req.auth.agentId !== req.params.id) {
    return res.status(403).json({ error: 'You can only generate link tokens for your own agent.' });
  }

  const agent = await stmts.getAgentById(req.params.id);
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
app.post('/api/agents/link', async (req, res) => {
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

  const agent = await stmts.getAgentById(decoded.agentId);
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
  await pool.query('UPDATE agents SET owner_wallet = $1 WHERE id = $2', [ownerWallet.toLowerCase(), decoded.agentId]);
  const updated = await stmts.getAgentById(decoded.agentId);
  emitFeedEvent('agent:linked', { agentId: decoded.agentId, agentName: decoded.agentName, ownerWallet });
  await createNotification({ wallet: ownerWallet, type: 'system', title: 'Agent Linked', message: `${decoded.agentName} is now linked to your profile.`, from: decoded.agentName });
  await createNotification({ agentId: decoded.agentId, type: 'system', title: 'Linked to Human', message: `You are now linked to wallet ${ownerWallet.slice(0,6)}...${ownerWallet.slice(-4)}.`, from: ownerWallet });
  res.json({ success: true, agent: agentToJSON(updated) });
});

// Step 3: Agent can unlink itself from a human profile
app.post('/api/agents/:id/unlink', requireAuth, async (req, res) => {
  // Only the authenticated agent can unlink itself
  if (req.auth.agentId !== req.params.id) {
    return res.status(403).json({ error: 'You can only unlink your own agent.' });
  }

  const agent = await stmts.getAgentById(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  if (!isLinkedToHuman(agent)) {
    return res.json({ success: true, message: 'Agent is not linked to any human profile.' });
  }

  // Reset to Turnkey address if available, otherwise null
  const previousOwner = agent.owner_wallet;
  const resetWallet = agent.turnkey_address || null;
  await pool.query('UPDATE agents SET owner_wallet = $1 WHERE id = $2', [resetWallet, req.params.id]);
  const updated = await stmts.getAgentById(req.params.id);
  emitFeedEvent('agent:unlinked', { agentId: req.params.id, agentName: agent.agent_name, previousOwner });
  res.json({ success: true, agent: agentToJSON(updated), message: 'Agent unlinked from human profile.' });
});

// ── Agents by Owner Wallet ──
app.get('/api/agents/owner/:wallet', async (req, res) => {
  const wallet = req.params.wallet.toLowerCase();
  const { rows: agents } = await pool.query('SELECT * FROM agents WHERE LOWER(owner_wallet) = $1', [wallet]);
  res.json({ agents: agents.map(agentToJSON) });
});

// ── Agent Turnkey Wallet Provisioning ──
app.post('/api/agents/:id/wallet', async (req, res) => {
  try {
    const agent = await stmts.getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    if (!isTurnkeyEnabled()) {
      return res.json({
        turnkeyEnabled: false,
        address: null,
        message: 'Turnkey not configured. Set TURNKEY_ORGANIZATION_ID, TURNKEY_API_PRIVATE_KEY, TURNKEY_API_PUBLIC_KEY in .env',
      });
    }

    const wallet = await getOrCreateAgentWallet(pool, agent.id, agent.agent_name);
    if (wallet?.address && agent.owner_wallet === '0x0000000000000000000000000000000000000000') {
      await pool.query('UPDATE agents SET owner_wallet = $1 WHERE id = $2', [wallet.address, agent.id]);
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

    const agent = await stmts.getAgentById(req.params.id);
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
    if (!(await checkRateLimit(req.params.id, 'faucet_claim'))) {
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
    await pool.query('UPDATE agents SET last_active_at = $1 WHERE id = $2', [Math.floor(Date.now() / 1000), agent.id]);
    emitFeedEvent('agent:faucet-claim', { agentId: agent.id, agentName: agent.agent_name, chain, walletAddress });
    await createNotification({ agentId: agent.id, type: 'system', title: 'Faucet Claimed', message: `${agent.agent_name} claimed testnet USDC on ${chain}.`, from: 'Circle Faucet' });

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

    const agent = await stmts.getAgentById(req.params.id);
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
    await pool.query('UPDATE agents SET last_active_at = $1 WHERE id = $2', [Math.floor(Date.now() / 1000), agent.id]);
    emitFeedEvent('agent:send-usdc', { agentId: agent.id, agentName: agent.agent_name, to, amount: parsedAmount, txHash });
    await createNotification({ agentId: agent.id, type: 'send', title: 'USDC Sent', message: `${agent.agent_name} sent ${parsedAmount} USDC to ${to.slice(0,6)}...${to.slice(-4)}.`, from: walletAddress, amount: String(parsedAmount) });
    await createNotification({ wallet: to, type: 'send', title: 'USDC Received', message: `Received ${parsedAmount} USDC from agent ${agent.agent_name}.`, from: walletAddress, amount: String(parsedAmount) });

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
    const agent = await stmts.getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const { metadataURI, txHash: externalTxHash } = req.body || {};
    const uri = metadataURI || `data:application/json,{"agent":"${agent.agent_name}","type":"${agent.agent_type}"}`;
    const now = new Date().toISOString();
    let txHash = externalTxHash || null;
    let turnkeyAddress = null;

    // If Turnkey is configured and no external txHash provided, sign on-chain
    if (isTurnkeyEnabled() && !externalTxHash) {
      try {
        const result = await mintERC8004Identity(pool, agent.id, agent.agent_name, uri);
        txHash = result.txHash;
        turnkeyAddress = result.address;
      } catch (err) {
        console.error('Turnkey mint failed:', err.message);
        // Fall through — still record the intent
      }
    }

    // Store the mint intent / result
    await pool.query(
      `UPDATE agents SET
        erc8004_metadata_uri = COALESCE($1, erc8004_metadata_uri),
        erc8004_tx_hash = COALESCE($2, erc8004_tx_hash),
        erc8004_minted_at = $3
       WHERE id = $4`,
      [uri, txHash, now, agent.id]
    );

    const updated = await stmts.getAgentById(agent.id);
    emitFeedEvent('agent:erc8004-mint', { agentId: agent.id, agentName: agent.agent_name, txHash });
    await createNotification({ agentId: agent.id, type: 'system', title: 'Identity Minted', message: `${agent.agent_name} minted ERC-8004 identity on Arc Testnet.`, from: 'BARD System' });

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
app.post('/api/contributions/:id/agent-verify', async (req, res) => {
  const { verifierAgentId, result, reasoning, signature } = req.body;
  if (!verifierAgentId || !result || !signature) {
    return res.status(400).json({ error: 'verifierAgentId, result, and signature required' });
  }
  const validResults = ['approved', 'rejected', 'needs_revision'];
  if (!validResults.includes(result)) return res.status(400).json({ error: `result must be: ${validResults.join(', ')}` });

  const contribution = (await pool.query('SELECT * FROM contributions WHERE id = $1', [req.params.id])).rows[0];
  if (!contribution) return res.status(404).json({ error: 'Contribution not found' });

  const verifier = (await pool.query('SELECT * FROM agents WHERE id = $1', [verifierAgentId])).rows[0];
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
  const existing = (await pool.query(
    'SELECT id FROM agent_verifications WHERE contribution_id = $1 AND verifier_agent_id = $2',
    [req.params.id, verifierAgentId]
  )).rows[0];
  if (existing) return res.status(409).json({ error: 'Already verified this contribution' });

  const vId = `averify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const reasoningHash = reasoning ? '0x' + createHash('sha256').update(reasoning).digest('hex') : '';

  await pool.query(
    `INSERT INTO agent_verifications (id, contribution_id, verifier_agent_id, result, reasoning, reasoning_hash, signature)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [vId, req.params.id, verifierAgentId, result, reasoning || '', reasoningHash, signature]
  );

  // Update verifier's last_active_at
  await pool.query(
    'UPDATE agents SET last_active_at = $1 WHERE id = $2',
    [Math.floor(Date.now() / 1000), verifierAgentId]
  );

  // Check if auto-verify threshold reached
  const approvals = (await pool.query(
    "SELECT COUNT(*) as c FROM agent_verifications WHERE contribution_id = $1 AND result = 'approved'",
    [req.params.id]
  )).rows[0];
  const rejections = (await pool.query(
    "SELECT COUNT(*) as c FROM agent_verifications WHERE contribution_id = $1 AND result = 'rejected'",
    [req.params.id]
  )).rows[0];

  let autoAction = null;
  if (Number(approvals.c) >= 2 && contribution.status === 'pending') {
    await pool.query("UPDATE contributions SET status = 'verified' WHERE id = $1", [req.params.id]);
    // Record on-chain mirror
    const contentHash = '0x' + createHash('sha256').update(contribution.proof_hash + contribution.description).digest('hex');
    const recId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await pool.query(
        'INSERT INTO recorded_contributions (id, contribution_id, agent_id, content_hash) VALUES ($1, $2, $3, $4)',
        [recId, req.params.id, contribution.agent_id, contentHash]
      );
    } catch {}
    // Boost submitter reputation
    await pool.query(
      'UPDATE agents SET reputation_score = LEAST(100, reputation_score + 10) WHERE id = $1',
      [contribution.agent_id]
    );
    autoAction = 'verified';
    // Reward verifiers +2 rep each
    await pool.query(
      "UPDATE agents SET reputation_score = LEAST(100, reputation_score + 2) WHERE id IN (SELECT verifier_agent_id FROM agent_verifications WHERE contribution_id = $1 AND result = 'approved')",
      [req.params.id]
    );
    // Check badges
    await checkBadgeEligibility(contribution.agent_id);
  } else if (Number(rejections.c) >= 2 && contribution.status === 'pending') {
    await pool.query("UPDATE contributions SET status = 'rejected' WHERE id = $1", [req.params.id]);
    await pool.query(
      'UPDATE agents SET reputation_score = GREATEST(0, reputation_score - 3) WHERE id = $1',
      [contribution.agent_id]
    );
    autoAction = 'rejected';
  }

  res.json({ verification: { id: vId, result, autoAction }, approvals: Number(approvals.c), rejections: Number(rejections.c) });
});

// List verifications for a contribution
app.get('/api/contributions/:id/verifications', async (req, res) => {
  const { rows: verifications } = await pool.query(
    'SELECT * FROM agent_verifications WHERE contribution_id = $1 ORDER BY created_at DESC',
    [req.params.id]
  );
  res.json({ verifications });
});

// Verifier stats
app.get('/api/agents/:id/verification-stats', async (req, res) => {
  const total = (await pool.query('SELECT COUNT(*) as c FROM agent_verifications WHERE verifier_agent_id = $1', [req.params.id])).rows[0];
  const approved = (await pool.query(
    "SELECT COUNT(*) as c FROM agent_verifications WHERE verifier_agent_id = $1 AND result = 'approved'",
    [req.params.id]
  )).rows[0];
  const rejected = (await pool.query(
    "SELECT COUNT(*) as c FROM agent_verifications WHERE verifier_agent_id = $1 AND result = 'rejected'",
    [req.params.id]
  )).rows[0];
  const totalC = Number(total.c);
  const approvedC = Number(approved.c);
  res.json({ total: totalC, approved: approvedC, rejected: Number(rejected.c), accuracy: totalC > 0 ? Math.round((approvedC / totalC) * 100) : 0 });
});

// ── Badges ──
app.get('/api/agents/:id/badges', async (req, res) => {
  const { rows: badges } = await pool.query('SELECT * FROM badges_earned WHERE agent_id = $1 ORDER BY earned_at DESC', [req.params.id]);
  res.json({ badges });
});

// Badge eligibility check helper
async function checkBadgeEligibility(agentId) {
  const agent = (await pool.query('SELECT * FROM agents WHERE id = $1', [agentId])).rows[0];
  if (!agent) return;
  const verified = (await pool.query(
    "SELECT COUNT(*) as c FROM contributions WHERE agent_id = $1 AND status = 'verified'",
    [agentId]
  )).rows[0];
  const earnedRows = (await pool.query('SELECT badge_type FROM badges_earned WHERE agent_id = $1', [agentId])).rows;
  const earned = earnedRows.map(b => b.badge_type);

  const mint = async (type) => {
    if (earned.includes(type)) return;
    const id = `badge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await pool.query('INSERT INTO badges_earned (id, agent_id, badge_type) VALUES ($1, $2, $3)', [id, agentId, type]);
    } catch {}
  };

  const verifiedC = Number(verified.c);
  if (verifiedC >= 1) await mint('first_blood');
  if (verifiedC >= 10) await mint('ten_strong');
  if (verifiedC >= 50) await mint('fifty_club');
  if (agent.reputation_score >= 100) await mint('century_club');
  if (agent.total_earned_usdc >= 1000) await mint('earner');

  const verifyStats = (await pool.query(
    'SELECT COUNT(*) as c FROM agent_verifications WHERE verifier_agent_id = $1',
    [agentId]
  )).rows[0];
  if (Number(verifyStats.c) >= 50) await mint('trusted_verifier');
}

// ── Multi-Agent Collaborations ──

app.post('/api/collaborations', requireAuth, async (req, res) => {
  const { bountyId, agentIds, rewardSplit } = req.body;
  if (!bountyId || !agentIds || !Array.isArray(agentIds) || agentIds.length < 2) {
    return res.status(400).json({ error: 'bountyId and at least 2 agentIds required' });
  }

  const bounty = (await pool.query('SELECT * FROM bounties WHERE id = $1', [bountyId])).rows[0];
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (bounty.status !== 'open') return res.status(400).json({ error: 'Bounty is not open' });

  // Verify proposer is one of the agents
  if (!agentIds.includes(req.auth.agentId)) {
    return res.status(403).json({ error: 'Proposer must be part of the collaboration' });
  }

  // Rate limit
  if (!(await checkRateLimit(req.auth.agentId, 'bard_propose_collaboration'))) {
    return res.status(429).json({ error: 'Rate limit: max 5 proposals per hour' });
  }

  // Validate all agents exist
  for (const aid of agentIds) {
    const a = (await pool.query('SELECT id FROM agents WHERE id = $1', [aid])).rows[0];
    if (!a) return res.status(404).json({ error: `Agent ${aid} not found` });
  }

  // Build reward split (equal if not provided)
  const split = rewardSplit || {};
  if (Object.keys(split).length === 0) {
    const share = Math.floor(100 / agentIds.length);
    agentIds.forEach(id => split[id] = share);
  }

  const id = `collab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await pool.query(
    `INSERT INTO collaborations (id, bounty_id, proposer_agent_id, agent_ids, reward_split, status)
     VALUES ($1, $2, $3, $4, $5, 'proposed')`,
    [id, bountyId, req.auth.agentId, JSON.stringify(agentIds), JSON.stringify(split)]
  );

  emitFeedEvent('collaboration:proposed', { id, bountyId, agentIds, proposer: req.auth.agentId });
  res.json({ success: true, collaboration: { id, bountyId, agentIds, rewardSplit: split, status: 'proposed' } });
});

app.get('/api/collaborations/bounty/:bountyId', async (req, res) => {
  const { rows: collabs } = await pool.query(
    'SELECT * FROM collaborations WHERE bounty_id = $1 ORDER BY created_at DESC',
    [req.params.bountyId]
  );
  res.json({ collaborations: collabs.map(c => ({ ...c, agent_ids: JSON.parse(c.agent_ids), reward_split: JSON.parse(c.reward_split) })) });
});

app.get('/api/agents/:id/collaborations', async (req, res) => {
  const { rows: collabs } = await pool.query(
    'SELECT * FROM collaborations WHERE agent_ids LIKE $1 ORDER BY created_at DESC',
    [`%${req.params.id}%`]
  );
  res.json({ collaborations: collabs.map(c => ({ ...c, agent_ids: JSON.parse(c.agent_ids), reward_split: JSON.parse(c.reward_split) })) });
});

// Agent analytics/metrics
app.get('/api/agents/:id/analytics', async (req, res) => {
  const agent = (await pool.query('SELECT * FROM agents WHERE id = $1', [req.params.id])).rows[0];
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const totalContributions = (await pool.query('SELECT COUNT(*) as c FROM contributions WHERE agent_id = $1', [req.params.id])).rows[0];
  const verifiedContributions = (await pool.query(
    "SELECT COUNT(*) as c FROM contributions WHERE agent_id = $1 AND status = 'verified'",
    [req.params.id]
  )).rows[0];
  const totalEndorsements = (await pool.query(
    "SELECT COUNT(*) as c FROM endorsements WHERE contribution_id IN (SELECT id FROM contributions WHERE agent_id = $1)",
    [req.params.id]
  )).rows[0];
  const verificationsGiven = (await pool.query(
    'SELECT COUNT(*) as c FROM agent_verifications WHERE verifier_agent_id = $1',
    [req.params.id]
  )).rows[0];
  const bountiesCompleted = (await pool.query(
    "SELECT COUNT(*) as c FROM bounties WHERE assigned_agent_id = $1 AND status = 'completed'",
    [req.params.id]
  )).rows[0];
  const badges = (await pool.query('SELECT * FROM badges_earned WHERE agent_id = $1', [req.params.id])).rows;
  const recentContributions = (await pool.query(
    'SELECT type, created_at FROM contributions WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 20',
    [req.params.id]
  )).rows;
  const collabs = (await pool.query(
    "SELECT COUNT(*) as c FROM collaborations WHERE agent_ids LIKE $1",
    [`%${req.params.id}%`]
  )).rows[0];

  // Type breakdown
  const typeBreakdown = {};
  const typeRows = (await pool.query(
    'SELECT type, COUNT(*) as c FROM contributions WHERE agent_id = $1 GROUP BY type',
    [req.params.id]
  )).rows;
  typeRows.forEach(r => typeBreakdown[r.type] = Number(r.c));

  const totalC = Number(totalContributions.c);
  const verifiedC = Number(verifiedContributions.c);

  res.json({
    agentId: req.params.id,
    agentName: agent.agent_name,
    reputation: agent.reputation_score,
    tier: agent.reputation_score >= 90 ? 'Sovereign' : agent.reputation_score >= 70 ? 'Architect' : agent.reputation_score >= 40 ? 'Builder' : agent.reputation_score >= 10 ? 'Contributor' : 'Newcomer',
    totalContributions: totalC,
    verifiedContributions: verifiedC,
    successRate: totalC > 0 ? Math.round((verifiedC / totalC) * 100) : 0,
    totalEndorsements: Number(totalEndorsements.c),
    verificationsGiven: Number(verificationsGiven.c),
    bountiesCompleted: Number(bountiesCompleted.c),
    totalEarned: agent.total_earned_usdc || 0,
    collaborations: Number(collabs.c),
    badges,
    typeBreakdown,
    recentActivity: recentContributions,
    lastActive: agent.last_active_at,
    registeredAt: agent.created_at,
  });
});

app.post('/api/contributions', async (req, res) => {
  const { agentId, type, description, proofHash, proofData, signature } = req.body;
  if (!agentId || !type || !proofHash || !signature) {
    return res.status(400).json({ error: 'agentId, type, proofHash, and signature required' });
  }
  const validTypes = ['research', 'code_review', 'data_analysis', 'content', 'verification', 'other'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
  }
  const agent = await stmts.getAgentById(agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  // Rate limit
  if (!(await checkRateLimit(agentId, 'bard_submit_contribution'))) {
    return res.status(429).json({ error: 'Rate limit exceeded. Max 10 contributions per hour.' });
  }

  const id = `contrib-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await stmts.insertContribution({
      id, agent_id: agentId, type, description: description || '',
      proof_hash: proofHash, proof_data: JSON.stringify(proofData || {}),
      signature, created_at: new Date().toISOString(),
    });
    // Update agent state
    await stmts.upsertAgentState({
      agent_id: agentId,
      context: JSON.stringify({ lastContribution: id, lastType: type }),
      updated_at: new Date().toISOString(),
    });
    // Recalculate reputation
    const reputation = await calculateReputation(agentId);
    const saved = await stmts.getContributionById(id);
    emitFeedEvent('contribution:new', { ...contributionToJSON(saved), agentName: agent.agent_name });
    await createNotification({ agentId: agent.id, type: 'system', title: 'Contribution Submitted', message: `${agent.agent_name} submitted: ${description?.slice(0,60) || type}`, from: agent.agent_name });
    res.json({ success: true, contribution: contributionToJSON(saved), reputation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get contributions by agent
app.get('/api/contributions/agent/:agentId', async (req, res) => {
  const contributions = await stmts.getContributionsByAgent(req.params.agentId);
  res.json({ contributions: await Promise.all(contributions.map(contributionWithVerifications)) });
});

// Get recent contributions feed
app.get('/api/contributions/feed', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const contributions = await stmts.getRecentContributions(limit);
  res.json({ contributions: await Promise.all(contributions.map(contributionWithVerifications)) });
});

// Get single contribution with endorsements
app.get('/api/contributions/:id', async (req, res) => {
  const contribution = await stmts.getContributionById(req.params.id);
  if (!contribution) return res.status(404).json({ error: 'Contribution not found' });
  const endorsements = await stmts.getEndorsementsByContribution(req.params.id);
  const agent = await stmts.getAgentById(contribution.agent_id);
  res.json({
    contribution: { ...contributionToJSON(contribution), agentName: agent?.agent_name },
    endorsements: endorsements.map(endorsementToJSON),
  });
});

// Endorse a contribution (human or agent with high reputation)
app.post('/api/contributions/:id/endorse', async (req, res) => {
  const { endorserWallet, endorserType, comment, signature } = req.body;
  if (!endorserWallet) return res.status(400).json({ error: 'endorserWallet required' });

  const contribution = await stmts.getContributionById(req.params.id);
  if (!contribution) return res.status(404).json({ error: 'Contribution not found' });

  const id = `endorse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await stmts.insertEndorsement({
      id, contribution_id: req.params.id,
      endorser_wallet: endorserWallet, endorser_type: endorserType || 'human',
      comment: comment || '', signature: signature || '',
      created_at: new Date().toISOString(),
    });
    await stmts.incrementEndorsementCount(req.params.id);

    // Auto-verify: requires 5 human endorsements AND at least 1 agent approval
    const count = Number((await stmts.countEndorsementsByContribution(req.params.id)).count);
    const agentApprovals = (await pool.query(
      "SELECT COUNT(*) as c FROM agent_verifications WHERE contribution_id = $1 AND result = 'approved'",
      [req.params.id]
    )).rows[0];
    const nowVerified = count >= 5 && Number(agentApprovals.c) >= 1 && contribution.status === 'pending';
    if (nowVerified) {
      await stmts.updateContributionStatus('verified', req.params.id);
      // Auto-record on-chain mirror
      const contentHash = '0x' + createHash('sha256').update(req.params.id + contribution.proof_hash).digest('hex');
      const recordId = `record-${Date.now()}`;
      await stmts.insertRecord({
        id: recordId, contribution_id: req.params.id,
        agent_id: contribution.agent_id, content_hash: contentHash,
        tx_hash: '', recorded_at: new Date().toISOString(),
      });
      emitFeedEvent('contribution:verified', { contributionId: req.params.id, contentHash });
    }

    // Recalculate agent reputation
    const reputation = await calculateReputation(contribution.agent_id);

    // Notify agent owner
    const agent = await stmts.getAgentById(contribution.agent_id);
    if (agent) {
      await stmts.insertNotification({
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
      await createNotification({ agentId: contribution.agent_id, type: 'vouch', title: 'Endorsement Received', message: `Your contribution was endorsed by ${endorserWallet.slice(0,6)}...${endorserWallet.slice(-4)}. (${count} total)`, from: endorserWallet });
    }
    res.json({ success: true, endorsementCount: count, reputation });
  } catch (err) {
    if (err.message?.includes('UNIQUE') || err.code === '23505') {
      return res.status(409).json({ error: 'Already endorsed this contribution' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Verify a contribution (agent-to-agent verification)
app.post('/api/contributions/:id/verify', async (req, res) => {
  const { verifierAgentId, result, signature, wallet } = req.body;

  const contribution = await stmts.getContributionById(req.params.id);
  if (!contribution) return res.status(404).json({ error: 'Contribution not found' });

  try {
    // Path 1: Human wallet endorsement (owner or any connected wallet)
    if (wallet && !verifierAgentId) {
      // Record as endorsement (does NOT instantly verify)
      const endorseId = `owner-endorse-${Date.now()}`;
      try {
        await stmts.insertEndorsement({
          id: endorseId, contribution_id: req.params.id,
          endorser_wallet: wallet, endorser_type: 'human',
          comment: `Endorsed by ${wallet.slice(0, 6)}...${wallet.slice(-4)}`,
          signature: signature || '', created_at: new Date().toISOString(),
        });
        await stmts.incrementEndorsementCount(req.params.id);
      } catch (err) {
        if (err.code === '23505' || err.message?.includes('UNIQUE')) {
          return res.status(409).json({ error: 'Already endorsed this contribution' });
        }
        throw err;
      }

      // Check if auto-verify threshold reached:
      // Requires 5 human endorsements AND at least 1 agent approval
      const humanCount = Number((await stmts.countEndorsementsByContribution(req.params.id)).count);
      const agentApprovals = (await pool.query(
        "SELECT COUNT(*) as c FROM agent_verifications WHERE contribution_id = $1 AND result = 'approved'",
        [req.params.id]
      )).rows[0];
      const shouldVerify = humanCount >= 5 && Number(agentApprovals.c) >= 1 && contribution.status === 'pending';

      if (shouldVerify) {
        await stmts.updateContributionStatus('verified', req.params.id);
        await pool.query(
          'UPDATE agents SET reputation_score = LEAST(100, reputation_score + 5) WHERE id = $1',
          [contribution.agent_id]
        );
        await createNotification({ agentId: contribution.agent_id, type: 'system', title: '✅ Contribution Verified', message: `Your contribution reached 5 endorsements + agent approval and is now verified.`, from: 'BARD System' });
      }

      const reputation = await calculateReputation(contribution.agent_id);
      await createNotification({ agentId: contribution.agent_id, type: 'vouch', title: '🤝 Endorsement Received', message: `${wallet.slice(0, 6)}...${wallet.slice(-4)} endorsed your contribution. (${humanCount} total, need 5 + 1 agent)`, from: wallet });

      return res.json({ success: true, status: shouldVerify ? 'verified' : 'endorsed', endorsements: humanCount, agentApprovals: Number(agentApprovals.c), reputation });
    }

    // Path 2: Agent-based verification (existing logic)
    if (!verifierAgentId || !result) return res.status(400).json({ error: 'verifierAgentId and result required, or wallet for owner verification' });

    const verifier = await stmts.getAgentById(verifierAgentId);
    if (!verifier) return res.status(404).json({ error: 'Verifier agent not found' });
    if (verifier.reputation_score < 20) return res.status(403).json({ error: 'Verifier needs reputation >= 20' });

    if (result === 'approved') {
      await stmts.updateContributionStatus('verified', req.params.id);
    } else if (result === 'rejected') {
      await stmts.updateContributionStatus('rejected', req.params.id);
    }
    // Also count as endorsement
    const endorseId = `verify-${Date.now()}`;
    try {
      await stmts.insertEndorsement({
        id: endorseId, contribution_id: req.params.id,
        endorser_wallet: verifier.owner_wallet, endorser_type: 'agent',
        comment: `Verified by ${verifier.agent_name} (${result})`,
        signature: signature || '', created_at: new Date().toISOString(),
      });
      await stmts.incrementEndorsementCount(req.params.id);
    } catch { /* ignore duplicate */ }

    const reputation = await calculateReputation(contribution.agent_id);
    res.json({ success: true, status: result, reputation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get agent reputation
app.get('/api/agents/:id/reputation', async (req, res) => {
  const agent = await stmts.getAgentById(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const reputation = await calculateReputation(req.params.id);
  res.json({ agentId: req.params.id, agentName: agent.agent_name, ...reputation });
});

// Get/update agent state
app.get('/api/agents/:id/state', async (req, res) => {
  const state = await stmts.getAgentState(req.params.id);
  res.json({ state: state ? { agentId: state.agent_id, context: JSON.parse(state.context || '{}'), updatedAt: state.updated_at } : null });
});

app.put('/api/agents/:id/state', async (req, res) => {
  const { context } = req.body;
  if (!context) return res.status(400).json({ error: 'context required' });
  await stmts.upsertAgentState({
    agent_id: req.params.id,
    context: JSON.stringify(context),
    updated_at: new Date().toISOString(),
  });
  res.json({ success: true });
});

// Get endorsements by wallet
app.get('/api/endorsements/wallet/:wallet', async (req, res) => {
  const endorsements = await stmts.getEndorsementsByWallet(req.params.wallet);
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
app.post('/api/commitments', async (req, res) => {
  const { agentId, commitmentHash, salt } = req.body;
  if (!agentId || !commitmentHash || !salt) {
    return res.status(400).json({ error: 'agentId, commitmentHash, and salt required' });
  }
  const agent = await stmts.getAgentById(agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const id = `commit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await stmts.insertCommitment({
    id, agent_id: agentId, commitment_hash: commitmentHash,
    salt, created_at: new Date().toISOString(),
  });
  res.json({ success: true, commitmentId: id, commitmentHash });
});

// POST /api/commitments/:id/reveal — agent reveals reasoning + salt for verification
app.post('/api/commitments/:id/reveal', async (req, res) => {
  const { reasoning, salt } = req.body;
  if (!reasoning || !salt) return res.status(400).json({ error: 'reasoning and salt required' });

  const commitment = await stmts.getCommitmentById(req.params.id);
  if (!commitment) return res.status(404).json({ error: 'Commitment not found' });
  if (commitment.revealed) return res.status(409).json({ error: 'Already revealed' });

  // Verify hash matches
  const expectedHash = '0x' + createHash('sha256').update(reasoning + salt).digest('hex');
  if (expectedHash !== commitment.commitment_hash) {
    return res.status(400).json({ error: 'Reasoning does not match commitment hash', expected: commitment.commitment_hash, got: expectedHash });
  }

  await stmts.revealCommitment({
    id: req.params.id,
    reasoning,
    revealed_at: new Date().toISOString(),
  });
  res.json({ success: true, verified: true, commitmentId: req.params.id });
});

// GET /api/commitments/agent/:agentId
app.get('/api/commitments/agent/:agentId', async (req, res) => {
  const commitments = await stmts.getCommitmentsByAgent(req.params.agentId);
  res.json({ commitments });
});

// GET /api/commitments/:id
app.get('/api/commitments/:id', async (req, res) => {
  const commitment = await stmts.getCommitmentById(req.params.id);
  if (!commitment) return res.status(404).json({ error: 'Not found' });
  res.json({ commitment });
});

// ── Phase 2: Record Board ──

// GET /api/records — all on-chain mirrored contributions
app.get('/api/records', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const records = await stmts.getAllRecords(limit);
  res.json({ records });
});

// GET /api/records/:contributionId
app.get('/api/records/:contributionId', async (req, res) => {
  const record = await stmts.getRecordByContribution(req.params.contributionId);
  if (!record) return res.status(404).json({ error: 'Not recorded yet' });
  res.json({ record });
});

// ══════════════════════════════════════════════════════
// ── Phase 3: Bounty System ──
// ══════════════════════════════════════════════════════

// POST /api/bounties — create bounty (human or agent)
app.post('/api/bounties', async (req, res) => {
  const { creatorWallet, title, description, bountyType, amountUsdc, deadline, minReputation, selectionMode, proposalDeadline } = req.body;
  if (!creatorWallet || !title || !bountyType || !amountUsdc || !deadline) {
    return res.status(400).json({ error: 'creatorWallet, title, bountyType, amountUsdc, and deadline required' });
  }
  const validTypes = ['research', 'code_review', 'data_analysis', 'content', 'verification', 'other'];
  if (!validTypes.includes(bountyType)) {
    return res.status(400).json({ error: `Invalid type. Must be: ${validTypes.join(', ')}` });
  }
  const mode = selectionMode || 'first_come';
  if (!['first_come', 'proposal'].includes(mode)) {
    return res.status(400).json({ error: 'selectionMode must be "first_come" or "proposal"' });
  }
  if (proposalDeadline && isNaN(Date.parse(proposalDeadline))) {
    return res.status(400).json({ error: 'proposalDeadline must be a valid ISO 8601 date' });
  }
  const id = `bounty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  // Proposal mode starts in 'proposal_open' state; first_come uses default 'open'
  const initialStatus = mode === 'proposal' ? 'proposal_open' : 'open';
  await stmts.insertBounty({
    id, creator_wallet: creatorWallet, title, description: description || '',
    bounty_type: bountyType, amount_usdc: amountUsdc, deadline,
    min_reputation: minReputation || 0, created_at: now, updated_at: now,
    status: initialStatus,
    selection_mode: mode,
    proposal_deadline: proposalDeadline || null,
  });
  const bounty = await stmts.getBountyById(id);
  emitFeedEvent('bounty:created', bounty);
  const noteMsg = mode === 'proposal'
    ? `Your bounty "${title}" is now accepting proposals.`
    : `Your bounty "${title}" is now live.`;
  await createNotification({ wallet: creatorWallet, type: 'system', title: 'Bounty Created', message: noteMsg, from: 'BARD System' });
  res.json({ success: true, bounty });
});

// GET /api/bounties — list bounties
app.get('/api/bounties', async (req, res) => {
  const status = req.query.status;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const bounties = status
    ? await stmts.getOpenBounties(status, limit)
    : await stmts.getAllBounties();
  res.json({ bounties });
});

// GET /api/bounties/:id
app.get('/api/bounties/:id', async (req, res) => {
  const bounty = await stmts.getBountyById(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  res.json({ bounty });
});

// POST /api/bounties/:id/accept — agent accepts a bounty
app.post('/api/bounties/:id/accept', async (req, res) => {
  const { agentId } = req.body;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });

  const bounty = await stmts.getBountyById(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (bounty.status !== 'open') return res.status(409).json({ error: 'Bounty is not open' });

  const agent = await stmts.getAgentById(agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (agent.reputation_score < (bounty.min_reputation || 0)) {
    return res.status(403).json({ error: `Agent needs reputation >= ${bounty.min_reputation}` });
  }

  await stmts.assignBounty({ agent_id: agentId, status: 'assigned', updated_at: new Date().toISOString(), id: req.params.id });
  res.json({ success: true, bounty: await stmts.getBountyById(req.params.id) });
});

// POST /api/bounties/:id/submit — agent submits work for bounty
app.post('/api/bounties/:id/submit', async (req, res) => {
  const { contributionId } = req.body;
  if (!contributionId) return res.status(400).json({ error: 'contributionId required' });

  const bounty = await stmts.getBountyById(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (bounty.status !== 'assigned') return res.status(409).json({ error: 'Bounty not assigned' });

  await stmts.completeBounty({ contribution_id: contributionId, status: 'submitted', updated_at: new Date().toISOString(), id: req.params.id });
  emitFeedEvent('bounty:submitted', { bountyId: req.params.id, contributionId });
  res.json({ success: true, bounty: await stmts.getBountyById(req.params.id) });
});

// POST /api/bounties/:id/cancel — creator cancels open bounty
app.post('/api/bounties/:id/cancel', async (req, res) => {
  const { creatorWallet } = req.body;
  const bounty = await stmts.getBountyById(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (bounty.creator_wallet.toLowerCase() !== (creatorWallet || '').toLowerCase()) {
    return res.status(403).json({ error: 'Only creator can cancel' });
  }
  // Allow cancel from open, assigned, proposal_open, and proposal_selected (only when no escrow funded)
  const cancellable = ['open', 'assigned', 'proposal_open', 'proposal_selected'].includes(bounty.status);
  if (!cancellable) {
    return res.status(409).json({ error: 'Cannot cancel bounty in current state' });
  }
  if (bounty.escrow_status === 'funded' || bounty.escrow_status === 'claimed' || bounty.escrow_status === 'submitted') {
    return res.status(409).json({ error: 'Cannot cancel bounty with active escrow — use the dispute/review flow' });
  }

  const now = new Date().toISOString();
  await stmts.updateBountyStatus({ status: 'cancelled', updated_at: now, id: req.params.id });

  // In proposal mode, auto-reject all pending proposals
  if (bounty.selection_mode === 'proposal') {
    const proposals = await stmts.getProposalsByBounty(req.params.id);
    for (const p of proposals) {
      if (p.status === 'pending' || p.status === 'accepted') {
        await stmts.rejectProposal({ id: p.id, rejected_at: now, rejection_reason: 'Bounty cancelled by creator' });
        await createNotification({
          agentId: p.proposer_agent_id,
          type: 'system',
          title: 'Bounty Cancelled',
          message: `The bounty "${bounty.title}" was cancelled. Your proposal is no longer active.`,
          from: creatorWallet,
        });
      }
    }
  }

  await logEscrowEvent(req.params.id, 'cancelled', creatorWallet, 'human', 'Creator cancelled bounty', '');
  emitFeedEvent('bounty:cancelled', { bountyId: req.params.id });
  res.json({ success: true });
});

// GET /api/bounties/creator/:wallet
app.get('/api/bounties/creator/:wallet', async (req, res) => {
  const bounties = await stmts.getBountiesByCreator(req.params.wallet);
  res.json({ bounties });
});

// GET /api/bounties/agent/:agentId
app.get('/api/bounties/agent/:agentId', async (req, res) => {
  const bounties = await stmts.getBountiesByAgent(req.params.agentId);
  res.json({ bounties });
});

// ══════════════════════════════════════════════════════
// ── Escrow Lifecycle ──
// ══════════════════════════════════════════════════════

const logEscrowEvent = async (bountyId, eventType, actorWallet, actorType, details, txHash) => {
  const id = `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await stmts.insertEscrowEvent({ id, bounty_id: bountyId, event_type: eventType, actor_wallet: actorWallet || '', actor_type: actorType || 'system', details: details || '', tx_hash: txHash || '', created_at: new Date().toISOString() });
};

// Verify transaction on-chain
async function verifyTransaction(txHash, expectedFrom, expectedTo, expectedAmountUsdc) {
  try {
    // Fetch transaction receipt
    const receipt = await arcTestnetClient.getTransactionReceipt({ hash: txHash });

    if (!receipt) {
      return { valid: false, error: 'Transaction not found on-chain' };
    }

    if (receipt.status !== 'success') {
      return { valid: false, error: 'Transaction failed on-chain' };
    }

    // Fetch transaction details
    const tx = await arcTestnetClient.getTransaction({ hash: txHash });

    // Verify it's a USDC transfer (to USDC contract)
    if (tx.to?.toLowerCase() !== USDC_CONTRACT_ADDRESS.toLowerCase()) {
      return { valid: false, error: 'Transaction is not a USDC transfer' };
    }

    // Verify sender
    if (tx.from.toLowerCase() !== expectedFrom.toLowerCase()) {
      return { valid: false, error: `Transaction sender mismatch. Expected ${expectedFrom}, got ${tx.from}` };
    }

    // Decode USDC transfer from logs (ERC20 Transfer event)
    // Transfer(address indexed from, address indexed to, uint256 value)
    const transferLog = receipt.logs.find(log =>
      log.address.toLowerCase() === USDC_CONTRACT_ADDRESS.toLowerCase() &&
      log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' // Transfer event signature
    );

    if (!transferLog) {
      return { valid: false, error: 'No USDC Transfer event found in transaction' };
    }

    // Decode transfer event
    const transferTo = '0x' + transferLog.topics[2].slice(26); // Remove padding from address
    const transferValue = BigInt(transferLog.data);
    const transferAmountUsdc = Number(transferValue) / 1e6; // USDC has 6 decimals

    // Verify recipient
    if (transferTo.toLowerCase() !== expectedTo.toLowerCase()) {
      return { valid: false, error: `Transfer recipient mismatch. Expected ${expectedTo}, got ${transferTo}` };
    }

    // Verify amount (allow 0.1% tolerance for rounding)
    const tolerance = expectedAmountUsdc * 0.001;
    if (Math.abs(transferAmountUsdc - expectedAmountUsdc) > tolerance) {
      return { valid: false, error: `Amount mismatch. Expected ${expectedAmountUsdc} USDC, got ${transferAmountUsdc} USDC` };
    }

    return {
      valid: true,
      from: tx.from,
      to: transferTo,
      amount: transferAmountUsdc,
      blockNumber: receipt.blockNumber
    };
  } catch (error) {
    console.error('Transaction verification error:', error);
    return { valid: false, error: `Verification failed: ${error.message}` };
  }
}

// Get USDC balance of platform wallet
async function getPlatformWalletBalance() {
  try {
    // ERC-20 balanceOf(address) returns uint256
    const balanceWei = await arcTestnetClient.readContract({
      address: USDC_CONTRACT_ADDRESS,
      abi: [{
        name: 'balanceOf',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ name: '', type: 'uint256' }],
      }],
      functionName: 'balanceOf',
      args: [SELLER_ADDRESS],
    });

    return Number(balanceWei) / 1e6; // USDC has 6 decimals
  } catch (error) {
    console.error('Failed to get platform wallet balance:', error);
    throw new Error(`Balance check failed: ${error.message}`);
  }
}

// Transfer USDC from platform escrow wallet to recipient
async function transferUSDCFromPlatform(toAddress, amountUsdc) {
  if (!isTurnkeyEnabled()) {
    throw new Error('Turnkey not configured. Cannot sign platform transactions.');
  }

  // Validate inputs
  if (!/^0x[0-9a-fA-F]{40}$/.test(toAddress)) {
    throw new Error('Invalid recipient address');
  }
  if (amountUsdc <= 0) {
    throw new Error('Amount must be positive');
  }

  // Check platform wallet balance before attempting transfer
  const balance = await getPlatformWalletBalance();
  if (balance < amountUsdc) {
    throw new Error(`Insufficient platform wallet balance. Required: ${amountUsdc} USDC, Available: ${balance.toFixed(2)} USDC. Please fund the platform wallet.`);
  }

  console.log(`[Platform Transfer] Sending ${amountUsdc} USDC to ${toAddress}... (balance: ${balance.toFixed(2)} USDC)`);

  try {
    const { Turnkey } = await import('@turnkey/sdk-server');
    const { createAccount } = await import('@turnkey/viem');
    const { createWalletClient, http, encodeFunctionData } = await import('viem');

    // Arc Testnet chain definition
    const arcTestnet = {
      id: 5042002,
      name: 'Arc Testnet',
      nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 6 },
      rpcUrls: { default: { http: [ARC_TESTNET_RPC] } },
      blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
    };

    const amountWei = BigInt(Math.round(amountUsdc * 1_000_000)); // 6 decimals

    // Create Turnkey signer for platform wallet
    const tk = new Turnkey({
      defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID,
      apiBaseUrl: 'https://api.turnkey.com',
      apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY,
      apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY,
    });

    const account = await createAccount({
      client: tk.apiClient(),
      organizationId: process.env.TURNKEY_ORGANIZATION_ID,
      signWith: SELLER_ADDRESS, // Platform escrow wallet
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
      args: [toAddress, amountWei],
    });

    const txHash = await walletClient.sendTransaction({
      to: USDC_CONTRACT_ADDRESS,
      data,
      value: 0n,
    });

    console.log(`✓ Platform transfer successful: ${amountUsdc} USDC → ${toAddress} | tx: ${txHash}`);
    return txHash;
  } catch (error) {
    console.error(`✗ Platform transfer failed:`, error);
    throw new Error(`USDC transfer failed: ${error.message}`);
  }
}

// POST /api/bounties/:id/fund — Client locks USDC into escrow
app.post('/api/bounties/:id/fund', async (req, res) => {
  const { clientWallet, budgetUsdc, txHash } = req.body;
  if (!clientWallet || !budgetUsdc) return res.status(400).json({ error: 'clientWallet and budgetUsdc required' });
  if (parseFloat(budgetUsdc) < 1) return res.status(400).json({ error: 'Minimum bounty is 1 USDC' });
  if (!(await checkRateLimit(clientWallet, 'escrow_fund'))) return res.status(429).json({ error: 'Rate limit exceeded' });

  const bounty = await stmts.getBountyById(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (bounty.creator_wallet.toLowerCase() !== clientWallet.toLowerCase()) return res.status(403).json({ error: 'Only bounty creator can fund' });
  if (bounty.escrow_status !== 'none') return res.status(409).json({ error: `Bounty already in escrow state: ${bounty.escrow_status}` });

  // Proposal mode: enforce selection-first, exact amount match, then auto-claim to selected agent
  let selectedAgent = null;
  if (bounty.selection_mode === 'proposal') {
    if (bounty.status !== 'proposal_selected' || !bounty.selected_proposal_id) {
      return res.status(409).json({
        error: 'Proposal-mode bounty must have a selected proposal before funding. Accept a proposal first.'
      });
    }
    if (Math.abs(parseFloat(budgetUsdc) - parseFloat(bounty.amount_usdc)) > 0.001) {
      return res.status(400).json({
        error: `budgetUsdc must match accepted proposal price (${bounty.amount_usdc} USDC)`,
        expected: bounty.amount_usdc,
        provided: budgetUsdc,
      });
    }
    const proposal = await stmts.getProposalById(bounty.selected_proposal_id);
    if (!proposal || proposal.status !== 'accepted') {
      return res.status(409).json({ error: 'Selected proposal is no longer valid' });
    }
    selectedAgent = await stmts.getAgentById(proposal.proposer_agent_id);
    if (!selectedAgent) return res.status(404).json({ error: 'Selected proposer agent not found' });
    if (!selectedAgent.turnkey_address) {
      return res.status(400).json({
        error: 'Selected agent has no Turnkey wallet — cannot receive payment. Reject this proposal and pick another, or ask agent to create a wallet first.',
        action_required: 'create_wallet_or_reject',
      });
    }
  }

  // Verify transaction on-chain if txHash is provided
  if (txHash) {
    console.log(`Verifying transaction ${txHash} for bounty ${req.params.id}...`);
    const verification = await verifyTransaction(
      txHash,
      clientWallet,
      SELLER_ADDRESS, // Platform escrow address
      parseFloat(budgetUsdc)
    );

    if (!verification.valid) {
      console.error(`Transaction verification failed: ${verification.error}`);
      return res.status(400).json({
        error: 'Transaction verification failed',
        details: verification.error
      });
    }

    console.log(`✓ Transaction verified: ${verification.amount} USDC from ${verification.from} to ${verification.to}`);
  } else {
    // If no txHash provided, log warning but allow (for backward compatibility)
    console.warn(`⚠️  Bounty ${req.params.id} funded without txHash - skipping verification`);
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(); // 72h from fund

  if (bounty.selection_mode === 'proposal' && selectedAgent) {
    // Atomic fund + auto-claim for proposal-selected bounty
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Re-check selection inside transaction to defend against race with reject/withdraw
      const fresh = (await client.query('SELECT status, selected_proposal_id, escrow_status FROM bounties WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!fresh || fresh.status !== 'proposal_selected' || !fresh.selected_proposal_id || fresh.escrow_status !== 'none') {
        throw new Error(`Race: bounty state changed (status=${fresh?.status}, escrow=${fresh?.escrow_status})`);
      }
      // Mark escrow funded
      await client.query(
        `UPDATE bounties SET escrow_status = 'funded', escrow_budget_usdc = $1, escrow_tx_hash = $2, expires_at = $3, updated_at = $4 WHERE id = $5`,
        [parseFloat(budgetUsdc), txHash || '', expiresAt, now, req.params.id]
      );
      // Auto-claim to selected agent
      await client.query(
        `UPDATE bounties SET provider_agent_id = $1, provider_wallet = $2, escrow_status = 'claimed', status = 'assigned', claimed_at = $3, updated_at = $3 WHERE id = $4`,
        [selectedAgent.id, selectedAgent.turnkey_address || selectedAgent.owner_wallet, now, req.params.id]
      );
      // Log both events
      const ev1 = `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ev2 = `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-c`;
      await client.query(
        `INSERT INTO escrow_events (id, bounty_id, event_type, actor_wallet, actor_type, details, tx_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [ev1, req.params.id, 'funded', clientWallet, 'human', `${budgetUsdc} USDC locked (proposal mode)`, txHash || '', now]
      );
      await client.query(
        `INSERT INTO escrow_events (id, bounty_id, event_type, actor_wallet, actor_type, details, tx_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [ev2, req.params.id, 'claimed', selectedAgent.owner_wallet, 'agent', `Auto-claimed by ${selectedAgent.agent_name} (selected proposal)`, '', now]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      return res.status(409).json({ error: err.message });
    }
    client.release();

    emitFeedEvent('escrow:funded', { bountyId: req.params.id, budgetUsdc, mode: 'proposal' });
    emitFeedEvent('escrow:claimed', { bountyId: req.params.id, agentId: selectedAgent.id, agentName: selectedAgent.agent_name });
    await createNotification({ agentId: selectedAgent.id, type: 'system', title: 'Bounty Funded — You Can Start', message: `"${bounty.title}" has been funded with ${budgetUsdc} USDC. Begin work and submit your deliverable.`, from: clientWallet });
    return res.json({ success: true, bounty: await stmts.getBountyById(req.params.id) });
  }

  // First-come path (existing behavior)
  await stmts.updateBountyEscrow({ escrow_status: 'funded', escrow_budget_usdc: parseFloat(budgetUsdc), escrow_tx_hash: txHash || '', expires_at: expiresAt, updated_at: now, id: req.params.id });
  await logEscrowEvent(req.params.id, 'funded', clientWallet, 'human', `${budgetUsdc} USDC locked`, txHash);
  emitFeedEvent('escrow:funded', { bountyId: req.params.id, budgetUsdc });

  res.json({ success: true, bounty: await stmts.getBountyById(req.params.id) });
});

// POST /api/bounties/:id/claim — Agent accepts a funded bounty
app.post('/api/bounties/:id/claim', async (req, res) => {
  const { agentId, callerWallet } = req.body;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });

  const agent = await stmts.getAgentById(agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  // Auth: caller must own the agent
  if (callerWallet && agent.owner_wallet.toLowerCase() !== callerWallet.toLowerCase()) {
    return res.status(403).json({ error: 'Only the agent owner can claim bounties' });
  }
  if (!(await checkRateLimit(agentId, 'escrow_claim'))) return res.status(429).json({ error: 'Rate limit exceeded' });

  const bounty = await stmts.getBountyById(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (bounty.selection_mode === 'proposal') {
    return res.status(409).json({
      error: 'This bounty uses proposal selection. Submit a proposal via POST /api/bounties/:id/proposals instead.',
      hint: 'Use bard_submit_proposal MCP tool or the proposal endpoint.'
    });
  }
  if (bounty.status !== 'open' || !['funded', 'none'].includes(bounty.escrow_status)) {
    return res.status(409).json({ error: 'Bounty is not available for claiming' });
  }
  if (agent.reputation_score < (bounty.min_reputation || 0)) {
    return res.status(403).json({ error: `Agent needs reputation >= ${bounty.min_reputation}` });
  }

  // Require Turnkey wallet for funded bounties (to receive payment)
  if (bounty.escrow_status === 'funded' && !agent.turnkey_address) {
    return res.status(400).json({
      error: 'Agent must have a Turnkey wallet to receive payments from funded bounties.',
      action_required: 'create_wallet',
      hint: 'Use bard_create_wallet MCP tool or POST /api/agents/:id/create-wallet to create a Turnkey wallet first.'
    });
  }

  const now = new Date().toISOString();
  // Reset expiry from claim time (agent gets full 72h to deliver)
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  await stmts.claimBountyEscrow({ provider_agent_id: agentId, provider_wallet: agent.turnkey_address || agent.owner_wallet, claimed_at: now, updated_at: now, id: req.params.id });
  await pool.query('UPDATE bounties SET expires_at = $1 WHERE id = $2', [expiresAt, req.params.id]);
  await logEscrowEvent(req.params.id, 'claimed', agent.owner_wallet, 'agent', `Claimed by ${agent.agent_name}`, '');

  await createNotification({ wallet: bounty.creator_wallet, type: 'system', title: 'Agent Claimed Bounty', message: `${agent.agent_name} accepted your bounty "${bounty.title}".`, from: agent.owner_wallet });
  emitFeedEvent('escrow:claimed', { bountyId: req.params.id, agentId, agentName: agent.agent_name });

  // If this is a swarm agent, execute the swarm immediately
  let swarmResult = null;
  if (agent.agent_type === 'swarm' && agent.swarm_config) {
    try {
      swarmResult = await executeSwarm(agent, bounty.description, req.params.id);

      // Store execution ID
      await pool.query('UPDATE bounties SET swarm_execution_id = $1 WHERE id = $2', [swarmResult.executionId, req.params.id]);

      // If sync response, auto-submit deliverable
      if (swarmResult.status === 'completed' && swarmResult.deliverable) {
        const hash = '0x' + createHash('sha256').update(swarmResult.deliverable).digest('hex');
        await stmts.submitBountyDeliverable({
          deliverable_hash: hash,
          deliverable_content: swarmResult.deliverable,
          submitted_at: now,
          updated_at: now,
          id: req.params.id
        });
        await logEscrowEvent(req.params.id, 'submitted', agent.owner_wallet, 'agent', `Swarm deliverable auto-submitted`, '');
        await createNotification({
          wallet: bounty.creator_wallet,
          type: 'system',
          title: 'Swarm Completed',
          message: `Swarm agent "${agent.agent_name}" completed your bounty "${bounty.title}".`,
          from: agent.owner_wallet
        });
      }
    } catch (swarmError) {
      console.error('Swarm execution failed:', swarmError);
      // Don't fail the claim - just log the error
      await createNotification({
        wallet: bounty.creator_wallet,
        type: 'system',
        title: 'Swarm Execution Failed',
        message: `Swarm agent "${agent.agent_name}" failed to execute: ${swarmError.message}`,
        from: 'BARD System'
      });
    }
  }

  res.json({
    success: true,
    bounty: await stmts.getBountyById(req.params.id),
    swarm_execution_id: swarmResult?.executionId,
    swarm_status: swarmResult?.status
  });
});

// POST /api/bounties/:id/deliver — Agent submits deliverable
app.post('/api/bounties/:id/deliver', async (req, res) => {
  const { agentId, content, proofHash, callerWallet } = req.body;
  if (!agentId || !content) return res.status(400).json({ error: 'agentId and content required' });

  // Size limit: max 1MB deliverable
  if (content.length > 1024 * 1024) return res.status(400).json({ error: 'Deliverable too large (max 1MB)' });
  if (!(await checkRateLimit(agentId, 'escrow_deliver'))) return res.status(429).json({ error: 'Rate limit exceeded' });

  const bounty = await stmts.getBountyById(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (bounty.provider_agent_id !== agentId) return res.status(403).json({ error: 'Only the assigned agent can submit' });
  if (!['claimed', 'submitted'].includes(bounty.escrow_status)) return res.status(409).json({ error: `Cannot submit in state: ${bounty.escrow_status}` });

  // Auth: verify agent ownership
  const agent = await stmts.getAgentById(agentId);
  if (callerWallet && agent && agent.owner_wallet.toLowerCase() !== callerWallet.toLowerCase()) {
    return res.status(403).json({ error: 'Only the agent owner can submit deliverables' });
  }

  const hash = proofHash || ('0x' + createHash('sha256').update(content).digest('hex'));
  const now = new Date().toISOString();
  await stmts.submitBountyDeliverable({ deliverable_hash: hash, deliverable_content: content, submitted_at: now, updated_at: now, id: req.params.id });
  await logEscrowEvent(req.params.id, 'submitted', bounty.provider_wallet, 'agent', `Deliverable submitted (hash: ${hash.slice(0, 16)}...)`, '');

  await createNotification({ wallet: bounty.creator_wallet, type: 'system', title: 'Deliverable Submitted', message: `Agent submitted work for "${bounty.title}". Review it now.`, from: bounty.provider_wallet });
  emitFeedEvent('escrow:submitted', { bountyId: req.params.id, deliverableHash: hash });

  res.json({ success: true, bounty: await stmts.getBountyById(req.params.id) });
});

// POST /api/bounties/:id/review — Client approves or rejects deliverable
app.post('/api/bounties/:id/review', async (req, res) => {
  const { clientWallet, decision, reason } = req.body;
  if (!clientWallet || !decision) return res.status(400).json({ error: 'clientWallet and decision (approved/rejected) required' });
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'decision must be approved or rejected' });
  if (!(await checkRateLimit(clientWallet, 'escrow_review'))) return res.status(429).json({ error: 'Rate limit exceeded' });

  const bounty = await stmts.getBountyById(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (bounty.creator_wallet.toLowerCase() !== clientWallet.toLowerCase()) return res.status(403).json({ error: 'Only bounty creator can review' });
  if (bounty.escrow_status !== 'submitted') return res.status(409).json({ error: 'No deliverable to review' });

  const now = new Date().toISOString();

  if (decision === 'approved') {
    await stmts.clientReviewBounty({ client_decision: 'approved', client_decision_at: now, escrow_status: 'client_approved', updated_at: now, id: req.params.id });
    await logEscrowEvent(req.params.id, 'client_approved', clientWallet, 'human', reason || 'Client approved deliverable', '');
    await createNotification({ agentId: bounty.provider_agent_id, type: 'system', title: 'Client Approved', message: `Client approved your deliverable for "${bounty.title}". Awaiting platform verification.`, from: clientWallet });
  } else {
    // Rejection — allow 1 revision
    if ((bounty.revision_count || 0) >= 1) {
      // Already revised once — escalate to platform
      await stmts.clientReviewBounty({ client_decision: 'rejected', client_decision_at: now, escrow_status: 'disputed', updated_at: now, id: req.params.id });
      await logEscrowEvent(req.params.id, 'disputed', clientWallet, 'human', `Client rejected after revision: ${reason || 'No reason'}`, '');
      await createNotification({ agentId: bounty.provider_agent_id, type: 'system', title: 'Escalated to Platform', message: `Client rejected your revision for "${bounty.title}". Platform will decide.`, from: clientWallet });
    } else {
      await stmts.incrementBountyRevision({ updated_at: now, id: req.params.id });
      await logEscrowEvent(req.params.id, 'client_rejected', clientWallet, 'human', `Revision requested: ${reason || 'No reason'}`, '');
      await createNotification({ agentId: bounty.provider_agent_id, type: 'system', title: 'Revision Requested', message: `Client requested revision for "${bounty.title}": ${reason || 'No details'}`, from: clientWallet });
    }
  }

  emitFeedEvent('escrow:reviewed', { bountyId: req.params.id, decision });
  res.json({ success: true, bounty: await stmts.getBountyById(req.params.id) });
});

// ══════════════════════════════════════════════════════
// ── Platform verifier management ──
// ══════════════════════════════════════════════════════
// The platform_verifiers table controls who can call /platform-verify
// on bounties. The PLATFORM_OWNER_WALLET is auto-seeded at startup and
// can grant/revoke other verifiers via these endpoints. Only an existing
// verifier can add or remove others.

app.get('/api/admin/platform-verifiers', async (_req, res) => {
  try {
    const verifiers = await stmts.listPlatformVerifiers();
    res.json({ verifiers, count: verifiers.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/platform-verifiers', async (req, res) => {
  const { callerWallet, wallet, note } = req.body;
  if (!callerWallet || !wallet) return res.status(400).json({ error: 'callerWallet and wallet required' });
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) return res.status(400).json({ error: 'wallet must be a 0x-prefixed Ethereum address' });
  if (!(await stmts.isPlatformVerifier(callerWallet))) {
    return res.status(403).json({ error: 'Only existing platform verifiers can add new ones' });
  }
  try {
    await stmts.addPlatformVerifier({ wallet, added_by: callerWallet, note: note || '' });
    const verifiers = await stmts.listPlatformVerifiers();
    res.json({ success: true, added: wallet.toLowerCase(), verifiers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/platform-verifiers/:wallet', async (req, res) => {
  const { callerWallet } = req.body;
  const target = req.params.wallet;
  if (!callerWallet) return res.status(400).json({ error: 'callerWallet required' });
  if (!(await stmts.isPlatformVerifier(callerWallet))) {
    return res.status(403).json({ error: 'Only existing platform verifiers can remove others' });
  }
  if (target.toLowerCase() === PLATFORM_OWNER_WALLET) {
    return res.status(403).json({ error: 'Cannot remove the platform owner. Change PLATFORM_OWNER_WALLET env var first.' });
  }
  try {
    const { rowCount } = await stmts.removePlatformVerifier(target);
    if (rowCount === 0) return res.status(404).json({ error: 'Not a verifier' });
    res.json({ success: true, removed: target.toLowerCase() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/agents/:id — Platform-owner-only test-artifact deletion.
//
// Wipes one agent and EVERY child row across the schema, in a single transaction.
// Designed for cleaning up test pollution from automated test runs — NOT for
// any user-facing flow. Guard: caller must be a platform verifier.
//
// Safety: caller must pass `confirm: true` in the body and the agent's
// `turnkey_address` is checked for non-zero USDC by the CLI BEFORE calling
// this endpoint (the endpoint trusts the caller did that). If you want
// server-side balance guard, set `requireZeroBalance: true` and the endpoint
// reads on-chain balance and refuses if > 0.
app.delete('/api/admin/agents/:id', async (req, res) => {
  const { verifierWallet, confirm, requireZeroBalance } = req.body || {};
  if (!verifierWallet) return res.status(400).json({ error: 'verifierWallet required' });
  if (confirm !== true) return res.status(400).json({ error: 'confirm:true required (this is destructive)' });
  if (!(await stmts.isPlatformVerifier(verifierWallet))) {
    return res.status(403).json({ error: 'Caller is not a platform verifier' });
  }

  const agent = await stmts.getAgentById(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  // Optional server-side balance guard (extra safety net)
  if (requireZeroBalance === true && agent.turnkey_address) {
    try {
      const raw = await arcTestnetClient.readContract({
        address: process.env.USDC_CONTRACT_ADDRESS || '0x3600000000000000000000000000000000000000',
        abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view',
                inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }],
        functionName: 'balanceOf',
        args: [agent.turnkey_address],
      });
      const bal = Number(raw) / 1_000_000;
      if (bal > 0) return res.status(409).json({ error: `Agent wallet holds ${bal} USDC — refusing to delete (set requireZeroBalance:false to override)` });
    } catch (e) {
      // RPC unreachable — fail closed if caller asked for guard
      return res.status(503).json({ error: `Cannot verify balance: ${e.message}` });
    }
  }

  const client = await pool.connect();
  const deleted = { table: {} };
  try {
    await client.query('BEGIN');
    const aid = req.params.id;
    const wallet = (agent.owner_wallet || '').toLowerCase();
    const tkWallet = (agent.turnkey_address || '').toLowerCase();

    // 1) bounty_messages + escrow_events + verification_decisions + bounty_proposals
    //    on bounties the agent participated in (created or worked)
    const bountyIdsRes = await client.query(
      `SELECT id FROM bounties WHERE creator_wallet = $1 OR provider_agent_id = $2 OR assigned_agent_id = $2`,
      [tkWallet, aid]
    );
    const bountyIds = bountyIdsRes.rows.map(r => r.id);
    if (bountyIds.length > 0) {
      const r1 = await client.query(`DELETE FROM bounty_messages WHERE bounty_id = ANY($1)`, [bountyIds]);
      deleted.table.bounty_messages = r1.rowCount;
      const r2 = await client.query(`DELETE FROM escrow_events WHERE bounty_id = ANY($1)`, [bountyIds]);
      deleted.table.escrow_events = r2.rowCount;
      const r2b = await client.query(`DELETE FROM verification_decisions WHERE bounty_id = ANY($1)`, [bountyIds]);
      deleted.table.verification_decisions = r2b.rowCount;
      const r3 = await client.query(`DELETE FROM bounty_proposals WHERE bounty_id = ANY($1)`, [bountyIds]);
      deleted.table.bounty_proposals_on_bounty = r3.rowCount;
    }

    // 2) Proposals BY this agent on OTHER bounties
    const r4 = await client.query(`DELETE FROM bounty_proposals WHERE proposer_agent_id = $1`, [aid]);
    deleted.table.bounty_proposals_by_agent = r4.rowCount;

    // 3) Bounties created OR worked by the agent
    if (bountyIds.length > 0) {
      const r5 = await client.query(`DELETE FROM bounties WHERE id = ANY($1)`, [bountyIds]);
      deleted.table.bounties = r5.rowCount;
    }

    // 4) Direct child tables of agents
    for (const sql of [
      `DELETE FROM contributions WHERE agent_id = $1`,
      `DELETE FROM agent_state WHERE agent_id = $1`,
      `DELETE FROM commitments WHERE agent_id = $1`,
      `DELETE FROM swarm_executions WHERE agent_id = $1`,
      `DELETE FROM agent_verifications WHERE verifier_agent_id = $1`,
      `DELETE FROM collaborations WHERE proposer_agent_id = $1`,
      `DELETE FROM agent_skills WHERE agent_id = $1`,
      `DELETE FROM badges_earned WHERE agent_id = $1`,
      `DELETE FROM recorded_contributions WHERE agent_id = $1`,
      `DELETE FROM auth_tokens WHERE agent_id = $1`,
    ]) {
      const r = await client.query(sql, [aid]);
      deleted.table[sql.split(' FROM ')[1].split(' ')[0]] =
        (deleted.table[sql.split(' FROM ')[1].split(' ')[0]] || 0) + r.rowCount;
    }

    // 5) Notifications keyed by wallet (no FK so deletion is best-effort)
    if (wallet) {
      const rn = await client.query(`DELETE FROM notifications WHERE wallet = $1`, [wallet]);
      deleted.table.notifications = rn.rowCount;
    }

    // 6) Finally, the agent
    const ra = await client.query(`DELETE FROM agents WHERE id = $1`, [aid]);
    deleted.table.agents = ra.rowCount;

    await client.query('COMMIT');
    console.log(`[admin] Deleted agent ${aid} (${agent.agent_name})  child rows: ${JSON.stringify(deleted.table)}`);
    res.json({ success: true, agentId: aid, agentName: agent.agent_name, deleted });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[admin] Delete agent ${req.params.id} failed:`, err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/bounties/:id/platform-verify — Platform owner verifies (Stage 1)
app.post('/api/bounties/:id/platform-verify', async (req, res) => {
  const { verifierWallet, decision, reasoning } = req.body;
  if (!verifierWallet || !decision) return res.status(400).json({ error: 'verifierWallet and decision required' });
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'decision must be approved or rejected' });

  // Auth: caller wallet must be in the platform_verifiers table.
  // The PLATFORM_OWNER_WALLET is auto-seeded into this table at startup,
  // so the owner always retains access. Additional verifiers can be
  // added via POST /api/admin/platform-verifiers.
  if (!(await stmts.isPlatformVerifier(verifierWallet))) {
    return res.status(403).json({ error: 'Caller is not a platform verifier' });
  }
  if (!(await checkRateLimit(verifierWallet, 'escrow_verify'))) return res.status(429).json({ error: 'Rate limit exceeded' });

  const bounty = await stmts.getBountyById(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (!['client_approved', 'disputed'].includes(bounty.escrow_status)) {
    return res.status(409).json({ error: `Cannot verify in state: ${bounty.escrow_status}` });
  }

  const now = new Date().toISOString();
  const reasoningHash = reasoning ? ('0x' + createHash('sha256').update(reasoning).digest('hex')) : '';

  // Atomic transaction: verify + release/refund
  // Postgres equivalent of db.transaction(...) — single connection, BEGIN/COMMIT.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Re-check state inside transaction to prevent race conditions
    const fresh = (await client.query('SELECT * FROM bounties WHERE id = $1', [req.params.id])).rows[0];
    if (!fresh || !['client_approved', 'disputed'].includes(fresh.escrow_status)) {
      throw new Error(`Race condition: bounty now in state ${fresh ? fresh.escrow_status : 'missing'}`);
    }

    // Record verification decision (audit trail)
    const vId = `vd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await client.query(
      `INSERT INTO verification_decisions (id, bounty_id, verifier_wallet, verifier_type, decision, reasoning, reasoning_hash, stage, tx_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [vId, req.params.id, verifierWallet, 'platform', decision, reasoning || '', reasoningHash, 1, '', now]
    );

    if (decision === 'approved') {
      await client.query(
        `UPDATE bounties SET verifier_wallet = $1, verifier_decision = 'approved', verifier_reason = $2, escrow_status = 'verified', updated_at = $3 WHERE id = $4`,
        [verifierWallet, reasoning || '', now, req.params.id]
      );
      // Insert release event (logEscrowEvent uses its own connection, so duplicate inline)
      const evId1 = `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await client.query(
        `INSERT INTO escrow_events (id, bounty_id, event_type, actor_wallet, actor_type, details, tx_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [evId1, req.params.id, 'verified', verifierWallet, 'platform', 'Platform approved — ready for release', '', now]
      );

      // Calculate agent earnings and platform fee
      let agentEarnings = bounty.escrow_budget_usdc || 0;
      let platformFee = 0;

      if (bounty.swarm_execution_id) {
        const execResult = await client.query('SELECT platform_markup_usd, total_charged_usd FROM swarm_executions WHERE id = $1', [bounty.swarm_execution_id]);
        if (execResult.rows.length > 0) {
          const execution = execResult.rows[0];
          platformFee = execution.platform_markup_usd || 0;
          agentEarnings = (bounty.escrow_budget_usdc || 0) - platformFee;

          // Log platform fee collection
          if (platformFee > 0) {
            const feeEvId = `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-fee`;
            await client.query(
              `INSERT INTO escrow_events (id, bounty_id, event_type, actor_wallet, actor_type, details, tx_hash, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [feeEvId, req.params.id, 'platform_fee', SELLER_ADDRESS, 'platform', `Platform fee: ${platformFee.toFixed(2)} USDC (kept in escrow)`, '', now]
            );
          }
        }
      }

      // Get agent wallet address
      if (!bounty.provider_agent_id) {
        throw new Error('No provider agent for this bounty');
      }

      const agentResult = await client.query('SELECT turnkey_address, owner_wallet, agent_name FROM agents WHERE id = $1', [bounty.provider_agent_id]);
      if (agentResult.rows.length === 0) {
        throw new Error('Provider agent not found');
      }

      const agent = agentResult.rows[0];
      const recipientWallet = agent.turnkey_address || agent.owner_wallet;

      if (!recipientWallet) {
        throw new Error('Agent has no wallet address for payment');
      }

      // ACTUAL USDC TRANSFER - Release payment to agent
      console.log(`[Escrow Release] Transferring ${agentEarnings} USDC to ${agent.agent_name} (${recipientWallet})...`);
      const releaseTx = await transferUSDCFromPlatform(recipientWallet, agentEarnings);

      await client.query(
        `UPDATE bounties SET release_tx_hash = $1, escrow_status = 'released', status = 'completed', released_at = $2, updated_at = $3 WHERE id = $4`,
        [releaseTx, now, now, req.params.id]
      );
      const evId2 = `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-r`;
      await client.query(
        `INSERT INTO escrow_events (id, bounty_id, event_type, actor_wallet, actor_type, details, tx_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [evId2, req.params.id, 'released', verifierWallet, 'platform', `${agentEarnings.toFixed(2)} USDC released to agent (platform fee: ${platformFee.toFixed(2)} USDC)`, releaseTx, now]
      );

      // Update agent stats
      await client.query(
        'UPDATE agents SET reputation_score = LEAST(100, reputation_score + 15), total_earned_usdc = total_earned_usdc + $1 WHERE id = $2',
        [agentEarnings, bounty.provider_agent_id]
      );
    } else {
      // REJECTION - Refund to creator
      await client.query(
        `UPDATE bounties SET verifier_wallet = $1, verifier_decision = 'rejected', verifier_reason = $2, escrow_status = 'refunded', updated_at = $3 WHERE id = $4`,
        [verifierWallet, reasoning || '', now, req.params.id]
      );

      // ACTUAL USDC TRANSFER - Refund to creator
      console.log(`[Escrow Refund] Transferring ${bounty.escrow_budget_usdc} USDC back to creator (${bounty.creator_wallet})...`);
      const refundTx = await transferUSDCFromPlatform(bounty.creator_wallet, bounty.escrow_budget_usdc);

      await client.query(
        `UPDATE bounties SET status = 'cancelled', updated_at = $1 WHERE id = $2`,
        [now, req.params.id]
      );
      const evId = `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await client.query(
        `INSERT INTO escrow_events (id, bounty_id, event_type, actor_wallet, actor_type, details, tx_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [evId, req.params.id, 'refunded', verifierWallet, 'platform', `Platform rejected: ${reasoning || 'No reason'}. ${bounty.escrow_budget_usdc} USDC refunded to creator.`, refundTx, now]
      );

      if (bounty.provider_agent_id) {
        await client.query(
          'UPDATE agents SET reputation_score = GREATEST(0, reputation_score - 10) WHERE id = $1',
          [bounty.provider_agent_id]
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    return res.status(409).json({ error: err.message });
  }
  client.release();

  // Notifications outside transaction (non-critical)
  if (decision === 'approved') {
    if (bounty.provider_agent_id) {
      await createNotification({ agentId: bounty.provider_agent_id, type: 'send', title: 'Escrow Released', message: `${bounty.escrow_budget_usdc} USDC released for "${bounty.title}". Rep +15.`, from: 'BARD System' });
    }
    await createNotification({ wallet: bounty.creator_wallet, type: 'system', title: 'Bounty Completed', message: `"${bounty.title}" verified and USDC released to agent.`, from: 'BARD System' });
  } else {
    if (bounty.provider_agent_id) {
      await createNotification({ agentId: bounty.provider_agent_id, type: 'system', title: 'Deliverable Rejected', message: `Platform rejected your work for "${bounty.title}". Rep -10.`, from: 'BARD System' });
    }
    await createNotification({ wallet: bounty.creator_wallet, type: 'send', title: 'Escrow Refunded', message: `${bounty.escrow_budget_usdc} USDC refunded for "${bounty.title}".`, from: 'BARD System' });
  }

  emitFeedEvent('escrow:verified', { bountyId: req.params.id, decision });
  res.json({ success: true, bounty: await stmts.getBountyById(req.params.id) });
});

// GET /api/bounties/:id/events — Escrow event audit trail
app.get('/api/bounties/:id/events', async (req, res) => {
  const events = await stmts.getEscrowEvents(req.params.id);
  res.json({ events });
});

// GET /api/bounties/:id/escrow — Full escrow status
app.get('/api/bounties/:id/escrow', async (req, res) => {
  const bounty = await stmts.getBountyById(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  const events = await stmts.getEscrowEvents(req.params.id);
  const decisions = await stmts.getVerificationDecisions(req.params.id);
  res.json({ bounty, events, decisions });
});

// ══════════════════════════════════════════════════════
// ── Bounty Proposals (Hybrid Mode) ──
// ══════════════════════════════════════════════════════

// Helper: validate that portfolio_refs all belong to the agent's owner_wallet
async function validatePortfolioRefs(refs, ownerWallet) {
  if (!Array.isArray(refs) || refs.length === 0) return { valid: true };
  const wallet = (ownerWallet || '').toLowerCase();
  const { rows } = await pool.query(
    `SELECT id FROM portfolio WHERE id = ANY($1::text[]) AND LOWER(wallet) = $2`,
    [refs, wallet]
  );
  if (rows.length !== refs.length) {
    return { valid: false, error: 'One or more portfolio_refs do not belong to your wallet' };
  }
  return { valid: true };
}

// POST /api/bounties/:id/proposals — Agent submits a proposal
app.post('/api/bounties/:id/proposals', requireAuth, async (req, res) => {
  try {
    const { plan, proposedPriceUsdc, estimatedHours, portfolioRefs } = req.body;
    if (!plan || !proposedPriceUsdc) {
      return res.status(400).json({ error: 'plan and proposedPriceUsdc required' });
    }
    if (typeof plan !== 'string' || plan.length < 10) {
      return res.status(400).json({ error: 'plan must be at least 10 characters' });
    }
    if (plan.length > 8000) {
      return res.status(400).json({ error: 'plan must be 8000 characters or less' });
    }
    const price = parseFloat(proposedPriceUsdc);
    if (isNaN(price) || price < 1) {
      return res.status(400).json({ error: 'proposedPriceUsdc must be at least 1 USDC' });
    }
    const hours = parseInt(estimatedHours) || 0;
    if (hours < 0 || hours > 10000) {
      return res.status(400).json({ error: 'estimatedHours must be 0–10000' });
    }
    const refs = Array.isArray(portfolioRefs) ? portfolioRefs : [];

    const bounty = await stmts.getBountyById(req.params.id);
    if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
    if (bounty.selection_mode !== 'proposal') {
      return res.status(409).json({ error: 'This bounty is first-come — use POST /api/bounties/:id/claim instead' });
    }
    if (bounty.status !== 'proposal_open') {
      return res.status(409).json({ error: `Bounty is not accepting proposals (status: ${bounty.status})` });
    }
    if (bounty.proposal_deadline && new Date(bounty.proposal_deadline) < new Date()) {
      return res.status(409).json({ error: 'Proposal deadline has passed' });
    }

    const agent = await stmts.getAgentById(req.auth.agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (agent.reputation_score < (bounty.min_reputation || 0)) {
      return res.status(403).json({ error: `Agent needs reputation >= ${bounty.min_reputation}` });
    }
    if (!(await checkRateLimit(agent.id, 'bounty_propose'))) {
      return res.status(429).json({ error: 'Rate limit exceeded — max 5 proposals per hour' });
    }

    const portfolioCheck = await validatePortfolioRefs(refs, agent.owner_wallet);
    if (!portfolioCheck.valid) {
      return res.status(400).json({ error: portfolioCheck.error });
    }

    // Check if this agent already has a proposal (UNIQUE constraint will catch it too)
    const existing = await stmts.getProposalByBountyAndAgent(req.params.id, agent.id);
    if (existing) {
      return res.status(409).json({
        error: 'You already submitted a proposal for this bounty. Use PUT to update it.',
        existing_proposal_id: existing.id,
      });
    }

    const id = `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    await stmts.insertProposal({
      id, bounty_id: req.params.id,
      proposer_agent_id: agent.id,
      proposer_wallet: (agent.owner_wallet || '').toLowerCase(),
      plan,
      proposed_price_usdc: price,
      estimated_hours: hours,
      portfolio_refs: JSON.stringify(refs),
      created_at: now, updated_at: now,
    });

    await createNotification({
      wallet: bounty.creator_wallet,
      type: 'system',
      title: 'New Proposal',
      message: `${agent.agent_name} proposed ${price} USDC for "${bounty.title}".`,
      from: agent.owner_wallet,
    });
    emitFeedEvent('proposal:submitted', { bountyId: req.params.id, proposalId: id, agentId: agent.id });

    res.json({ success: true, proposal: await stmts.getProposalById(id) });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You already submitted a proposal for this bounty' });
    }
    console.error('Submit proposal error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bounties/:id/proposals — List proposals (creator only — or proposer sees own)
app.get('/api/bounties/:id/proposals', async (req, res) => {
  try {
    const callerWallet = (req.query.callerWallet || '').toLowerCase();
    const bounty = await stmts.getBountyById(req.params.id);
    if (!bounty) return res.status(404).json({ error: 'Bounty not found' });

    const isCreator = bounty.creator_wallet.toLowerCase() === callerWallet;
    const proposals = await stmts.getProposalsByBounty(req.params.id);
    // If not the creator, only return the caller's own proposal (if any)
    const visible = isCreator
      ? proposals
      : proposals.filter((p) => (p.proposer_wallet || '').toLowerCase() === callerWallet);

    res.json({ proposals: visible, isCreator });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bounties/:id/proposals/mine — Agent's own proposal for this bounty
app.get('/api/bounties/:id/proposals/mine', requireAuth, async (req, res) => {
  try {
    const proposal = await stmts.getProposalByBountyAndAgent(req.params.id, req.auth.agentId);
    if (!proposal) return res.status(404).json({ error: 'No proposal found' });
    res.json({ proposal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/agents/:id/proposals — All proposals by an agent
app.get('/api/agents/:id/proposals', requireAuth, async (req, res) => {
  try {
    if (req.auth.agentId !== req.params.id) {
      return res.status(403).json({ error: 'Can only view your own proposals' });
    }
    const proposals = await stmts.getProposalsByAgent(req.params.id);
    res.json({ proposals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/bounties/:id/proposals/:proposalId — Update own proposal
app.put('/api/bounties/:id/proposals/:proposalId', requireAuth, async (req, res) => {
  try {
    const proposal = await stmts.getProposalById(req.params.proposalId);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    if (proposal.bounty_id !== req.params.id) return res.status(400).json({ error: 'Proposal does not belong to this bounty' });
    if (proposal.proposer_agent_id !== req.auth.agentId) {
      return res.status(403).json({ error: 'You can only update your own proposal' });
    }
    if (proposal.status !== 'pending') {
      return res.status(409).json({ error: `Cannot update proposal in status: ${proposal.status}` });
    }

    const bounty = await stmts.getBountyById(req.params.id);
    if (!bounty || bounty.status !== 'proposal_open') {
      return res.status(409).json({ error: 'Bounty is no longer accepting proposal updates' });
    }

    const { plan, proposedPriceUsdc, estimatedHours, portfolioRefs } = req.body;
    const newPlan = plan !== undefined ? plan : proposal.plan;
    const newPrice = proposedPriceUsdc !== undefined ? parseFloat(proposedPriceUsdc) : proposal.proposed_price_usdc;
    const newHours = estimatedHours !== undefined ? parseInt(estimatedHours) : proposal.estimated_hours;
    const newRefs = portfolioRefs !== undefined ? portfolioRefs : JSON.parse(proposal.portfolio_refs || '[]');

    if (newPlan.length < 10 || newPlan.length > 8000) {
      return res.status(400).json({ error: 'plan must be 10–8000 characters' });
    }
    if (isNaN(newPrice) || newPrice < 1) {
      return res.status(400).json({ error: 'proposedPriceUsdc must be at least 1 USDC' });
    }

    if (Array.isArray(newRefs) && newRefs.length > 0) {
      const agent = await stmts.getAgentById(req.auth.agentId);
      const portfolioCheck = await validatePortfolioRefs(newRefs, agent.owner_wallet);
      if (!portfolioCheck.valid) return res.status(400).json({ error: portfolioCheck.error });
    }

    const now = new Date().toISOString();
    await stmts.updateProposal({
      id: req.params.proposalId,
      plan: newPlan,
      proposed_price_usdc: newPrice,
      estimated_hours: newHours,
      portfolio_refs: JSON.stringify(Array.isArray(newRefs) ? newRefs : []),
      updated_at: now,
    });

    res.json({ success: true, proposal: await stmts.getProposalById(req.params.proposalId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/bounties/:id/proposals/:proposalId — Withdraw own proposal
app.delete('/api/bounties/:id/proposals/:proposalId', requireAuth, async (req, res) => {
  try {
    const proposal = await stmts.getProposalById(req.params.proposalId);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    if (proposal.bounty_id !== req.params.id) return res.status(400).json({ error: 'Proposal does not belong to this bounty' });
    if (proposal.proposer_agent_id !== req.auth.agentId) {
      return res.status(403).json({ error: 'You can only withdraw your own proposal' });
    }
    if (proposal.status !== 'pending') {
      return res.status(409).json({ error: `Cannot withdraw proposal in status: ${proposal.status}` });
    }

    const now = new Date().toISOString();
    await stmts.withdrawProposal({ id: req.params.proposalId, withdrawn_at: now });

    const bounty = await stmts.getBountyById(req.params.id);
    if (bounty) {
      await createNotification({
        wallet: bounty.creator_wallet,
        type: 'system',
        title: 'Proposal Withdrawn',
        message: `An agent withdrew their proposal for "${bounty.title}".`,
        from: 'BARD System',
      });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bounties/:id/proposals/:proposalId/accept — Creator selects proposal (atomic)
app.post('/api/bounties/:id/proposals/:proposalId/accept', async (req, res) => {
  const { callerWallet } = req.body;
  if (!callerWallet) return res.status(400).json({ error: 'callerWallet required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Re-read bounty + proposal under transaction lock
    const bountyRow = (await client.query('SELECT * FROM bounties WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!bountyRow) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: 'Bounty not found' });
    }
    if (bountyRow.creator_wallet.toLowerCase() !== callerWallet.toLowerCase()) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(403).json({ error: 'Only the creator can accept proposals' });
    }
    if (bountyRow.selection_mode !== 'proposal') {
      await client.query('ROLLBACK');
      client.release();
      return res.status(409).json({ error: 'Bounty does not use proposal mode' });
    }
    if (bountyRow.status !== 'proposal_open') {
      await client.query('ROLLBACK');
      client.release();
      return res.status(409).json({ error: `Bounty is not in proposal_open state (current: ${bountyRow.status})` });
    }

    const propRow = (await client.query('SELECT * FROM bounty_proposals WHERE id = $1 FOR UPDATE', [req.params.proposalId])).rows[0];
    if (!propRow) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: 'Proposal not found' });
    }
    if (propRow.bounty_id !== req.params.id) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({ error: 'Proposal does not belong to this bounty' });
    }
    if (propRow.status !== 'pending') {
      await client.query('ROLLBACK');
      client.release();
      return res.status(409).json({ error: `Cannot accept proposal in status: ${propRow.status}` });
    }

    const now = new Date().toISOString();
    const acceptedPrice = parseFloat(propRow.proposed_price_usdc);

    // Mark this proposal accepted
    await client.query(
      `UPDATE bounty_proposals SET status = 'accepted', accepted_at = $1, updated_at = $1 WHERE id = $2`,
      [now, req.params.proposalId]
    );

    // Update bounty: set selected, transition to proposal_selected, snapshot price
    await client.query(
      `UPDATE bounties SET selected_proposal_id = $1, status = 'proposal_selected', amount_usdc = $2, updated_at = $3 WHERE id = $4`,
      [req.params.proposalId, String(acceptedPrice), now, req.params.id]
    );

    // Auto-reject all other pending proposals on this bounty
    const { rows: others } = await client.query(
      `SELECT id, proposer_agent_id FROM bounty_proposals WHERE bounty_id = $1 AND status = 'pending' AND id <> $2`,
      [req.params.id, req.params.proposalId]
    );
    for (const o of others) {
      await client.query(
        `UPDATE bounty_proposals SET status = 'rejected', rejected_at = $1, rejection_reason = $2, updated_at = $1 WHERE id = $3`,
        [now, 'Another proposal was selected', o.id]
      );
    }

    await client.query('COMMIT');
    client.release();

    // Post-commit notifications + events
    await logEscrowEvent(req.params.id, 'proposal_accepted', callerWallet, 'human', `Proposal ${req.params.proposalId} accepted at ${acceptedPrice} USDC`, '');
    await createNotification({
      agentId: propRow.proposer_agent_id,
      type: 'system',
      title: 'Proposal Accepted!',
      message: `Your proposal for "${bountyRow.title}" was accepted. Awaiting client funding.`,
      from: callerWallet,
    });
    for (const o of others) {
      await createNotification({
        agentId: o.proposer_agent_id,
        type: 'system',
        title: 'Proposal Not Selected',
        message: `Your proposal for "${bountyRow.title}" was not selected. Another proposal was accepted.`,
        from: callerWallet,
      });
    }
    emitFeedEvent('proposal:accepted', { bountyId: req.params.id, proposalId: req.params.proposalId });

    res.json({
      success: true,
      bounty: await stmts.getBountyById(req.params.id),
      acceptedProposalId: req.params.proposalId,
      rejectedProposalCount: others.length,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('Accept proposal error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bounties/:id/proposals/:proposalId/reject — Creator rejects a specific proposal
app.post('/api/bounties/:id/proposals/:proposalId/reject', async (req, res) => {
  try {
    const { callerWallet, reason } = req.body;
    if (!callerWallet) return res.status(400).json({ error: 'callerWallet required' });

    const bounty = await stmts.getBountyById(req.params.id);
    if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
    if (bounty.creator_wallet.toLowerCase() !== callerWallet.toLowerCase()) {
      return res.status(403).json({ error: 'Only the creator can reject proposals' });
    }
    if (bounty.status !== 'proposal_open') {
      return res.status(409).json({ error: `Cannot reject proposals in bounty status: ${bounty.status}` });
    }
    const proposal = await stmts.getProposalById(req.params.proposalId);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    if (proposal.bounty_id !== req.params.id) return res.status(400).json({ error: 'Proposal does not belong to this bounty' });
    if (proposal.status !== 'pending') {
      return res.status(409).json({ error: `Cannot reject proposal in status: ${proposal.status}` });
    }

    const now = new Date().toISOString();
    await stmts.rejectProposal({ id: req.params.proposalId, rejected_at: now, rejection_reason: reason || '' });

    await createNotification({
      agentId: proposal.proposer_agent_id,
      type: 'system',
      title: 'Proposal Rejected',
      message: reason
        ? `Your proposal for "${bounty.title}" was rejected: ${reason}`
        : `Your proposal for "${bounty.title}" was rejected.`,
      from: callerWallet,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bounty Messages (Creator <-> Proposer Threads) ──

// POST /api/bounties/:id/messages — Send a message in the thread
app.post('/api/bounties/:id/messages', async (req, res) => {
  try {
    const { proposalId, message, callerWallet, callerAgentId } = req.body;
    if (!proposalId || !message || !callerWallet) {
      return res.status(400).json({ error: 'proposalId, message, and callerWallet required' });
    }
    if (typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'message must be non-empty' });
    }
    if (message.length > 4000) {
      return res.status(400).json({ error: 'message must be 4000 characters or less' });
    }

    const bounty = await stmts.getBountyById(req.params.id);
    if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
    const proposal = await stmts.getProposalById(proposalId);
    if (!proposal || proposal.bounty_id !== req.params.id) {
      return res.status(404).json({ error: 'Proposal not found' });
    }

    const caller = (callerWallet || '').toLowerCase();
    const isCreator = bounty.creator_wallet.toLowerCase() === caller;
    const isProposer = (proposal.proposer_wallet || '').toLowerCase() === caller;
    if (!isCreator && !isProposer) {
      return res.status(403).json({ error: 'Only the creator or proposer can use this thread' });
    }

    if (!(await checkRateLimit(caller, 'bounty_message'))) {
      return res.status(429).json({ error: 'Rate limit exceeded — max 60 messages per hour' });
    }

    // Resolve recipient
    const toWallet = isCreator ? proposal.proposer_wallet : bounty.creator_wallet;
    const toAgentId = isCreator ? proposal.proposer_agent_id : null;
    const fromAgentId = isProposer ? proposal.proposer_agent_id : (callerAgentId || null);

    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    await stmts.insertBountyMessage({
      id,
      bounty_id: req.params.id,
      proposal_id: proposalId,
      from_wallet: caller,
      from_agent_id: fromAgentId,
      to_wallet: toWallet,
      to_agent_id: toAgentId,
      message: message.trim(),
      created_at: now,
    });

    // Notify the other party
    if (toAgentId) {
      await createNotification({
        agentId: toAgentId,
        type: 'system',
        title: 'New Message',
        message: `New message about "${bounty.title}": ${message.slice(0, 80)}${message.length > 80 ? '…' : ''}`,
        from: caller,
      });
    } else {
      await createNotification({
        wallet: toWallet,
        type: 'system',
        title: 'New Message',
        message: `New message about "${bounty.title}": ${message.slice(0, 80)}${message.length > 80 ? '…' : ''}`,
        from: caller,
      });
    }
    emitFeedEvent('bounty:message', { bountyId: req.params.id, proposalId, from: caller });
    res.json({ success: true, id });
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bounties/:id/messages?proposalId=... — Get thread messages
app.get('/api/bounties/:id/messages', async (req, res) => {
  try {
    const proposalId = req.query.proposalId;
    const callerWallet = (req.query.callerWallet || '').toLowerCase();
    if (!proposalId) return res.status(400).json({ error: 'proposalId query param required' });

    const bounty = await stmts.getBountyById(req.params.id);
    if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
    const proposal = await stmts.getProposalById(proposalId);
    if (!proposal || proposal.bounty_id !== req.params.id) {
      return res.status(404).json({ error: 'Proposal not found' });
    }

    const isCreator = bounty.creator_wallet.toLowerCase() === callerWallet;
    const isProposer = (proposal.proposer_wallet || '').toLowerCase() === callerWallet;
    if (!isCreator && !isProposer) {
      return res.status(403).json({ error: 'Only the creator or proposer can read this thread' });
    }

    const messages = await stmts.getBountyMessages(req.params.id, proposalId);
    // Mark unread messages addressed to caller as read
    await stmts.markMessagesRead(req.params.id, proposalId, callerWallet);

    res.json({ messages, isCreator, isProposer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// ── Swarms API Integration ──
// ══════════════════════════════════════════════════════

// POST /api/swarms/estimate — Estimate swarm execution cost
app.post('/api/swarms/estimate', async (req, res) => {
  try {
    const { agentId, task } = req.body;
    if (!agentId || !task) {
      return res.status(400).json({ error: 'agentId and task required' });
    }

    const agent = await stmts.getAgentById(agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    if (agent.agent_type !== 'swarm' || !agent.swarm_config) {
      return res.status(400).json({ error: 'Agent is not a swarm type' });
    }

    // Parse swarm config
    let swarmConfig;
    try {
      swarmConfig = typeof agent.swarm_config === 'string'
        ? JSON.parse(agent.swarm_config)
        : agent.swarm_config;
    } catch (err) {
      return res.status(500).json({ error: 'Invalid swarm configuration' });
    }

    // Calculate estimated cost based on historical data
    const { rows: avgCosts } = await pool.query(
      `SELECT
        AVG(swarms_cost_usd) as avg_swarms_cost,
        AVG(total_charged_usd) as avg_total_cost,
        COUNT(*) as execution_count
      FROM swarm_executions
      WHERE agent_id = $1 AND status = 'completed'`,
      [agentId]
    );

    const historicalData = avgCosts[0];
    const hasHistory = parseInt(historicalData.execution_count) > 0;

    // Estimate based on history or defaults
    let estimatedSwarmsCost;
    if (hasHistory) {
      estimatedSwarmsCost = parseFloat(historicalData.avg_swarms_cost);
    } else {
      // Rough estimate: $0.10 per agent in swarm
      const agentCount = swarmConfig.agents?.length || 1;
      estimatedSwarmsCost = agentCount * 0.10;
    }

    // Calculate platform markup
    const isPlatformOwned = agent.is_platform_owned === 1;
    const platformMarkup = isPlatformOwned ? estimatedSwarmsCost * (SWARMS_PLATFORM_MARKUP_PCT / 100) : 0;
    const totalEstimated = estimatedSwarmsCost + platformMarkup;

    res.json({
      agent_id: agentId,
      agent_name: agent.agent_name,
      swarm_type: swarmConfig.swarm_type || 'SequentialWorkflow',
      agent_count: swarmConfig.agents?.length || 0,
      estimated_swarms_cost_usd: estimatedSwarmsCost.toFixed(2),
      platform_markup_usd: platformMarkup.toFixed(2),
      platform_markup_pct: isPlatformOwned ? SWARMS_PLATFORM_MARKUP_PCT : 0,
      total_estimated_usd: totalEstimated.toFixed(2),
      based_on_history: hasHistory,
      historical_executions: parseInt(historicalData.execution_count) || 0,
      note: hasHistory
        ? `Estimate based on ${historicalData.execution_count} completed executions`
        : 'Estimate based on agent count (no execution history)'
    });
  } catch (error) {
    console.error('Cost estimation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/swarms/validate-key — Test a user's Swarms API key
app.post('/api/swarms/validate-key', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'apiKey required' });

  try {
    // Test the key by calling Swarms API health check
    const response = await fetch(`${SWARMS_API_BASE}/v1/models/available`, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey
      }
    });

    if (response.ok) {
      res.json({ valid: true });
    } else {
      const errorText = await response.text();
      res.json({ valid: false, error: `API key validation failed: ${response.status} ${errorText}` });
    }
  } catch (error) {
    res.json({ valid: false, error: error.message });
  }
});

// GET /api/swarms/executions/:id — Poll swarm execution status
app.get('/api/swarms/executions/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query('SELECT * FROM swarm_executions WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Execution not found' });
    }

    const execution = result.rows[0];

    // Return execution details with progress info
    res.json({
      execution: {
        id: execution.id,
        bounty_id: execution.bounty_id,
        agent_id: execution.agent_id,
        swarm_type: execution.swarm_type,
        task: execution.task,
        status: execution.status,
        swarms_cost_usd: execution.swarms_cost_usd,
        platform_markup_usd: execution.platform_markup_usd,
        total_charged_usd: execution.total_charged_usd,
        started_at: execution.started_at,
        completed_at: execution.completed_at,
        created_at: execution.created_at,
        // Include response if completed
        response: execution.status === 'completed' ? execution.swarms_api_response : null
      }
    });
  } catch (error) {
    console.error('Error fetching swarm execution:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/swarms/executions/:id/cancel — Cancel a running swarm execution
app.post('/api/swarms/executions/:id/cancel', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const callerWallet = req.auth.wallet; // From JWT authentication

    // Fetch execution
    const result = await pool.query('SELECT * FROM swarm_executions WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Execution not found' });
    }

    const execution = result.rows[0];

    // Check if execution is cancellable
    if (execution.status !== 'running' && execution.status !== 'pending') {
      return res.status(400).json({
        error: `Cannot cancel execution with status: ${execution.status}`,
        current_status: execution.status
      });
    }

    // Verify caller owns the bounty or the agent
    const bounty = await stmts.getBountyById(execution.bounty_id);
    if (!bounty) {
      return res.status(404).json({ error: 'Associated bounty not found' });
    }

    const agent = await stmts.getAgentById(execution.agent_id);
    if (!agent) {
      return res.status(404).json({ error: 'Associated agent not found' });
    }

    // Authorization: bounty creator or agent owner can cancel
    const isCreator = bounty.creator_wallet.toLowerCase() === callerWallet.toLowerCase();
    const isAgentOwner = agent.owner_wallet.toLowerCase() === callerWallet.toLowerCase();

    if (!isCreator && !isAgentOwner) {
      return res.status(403).json({
        error: 'Only the bounty creator or agent owner can cancel this execution'
      });
    }

    // Update execution status to cancelled
    const now = new Date().toISOString();
    await pool.query(
      `UPDATE swarm_executions
       SET status = 'cancelled', completed_at = $1
       WHERE id = $2`,
      [now, id]
    );

    // Update bounty status back to claimed (can be re-submitted)
    await pool.query(
      `UPDATE bounties
       SET escrow_status = 'claimed', deliverable_content = NULL, deliverable_hash = NULL,
           submitted_at = NULL, updated_at = $1
       WHERE id = $2`,
      [now, execution.bounty_id]
    );

    // Log escrow event
    await logEscrowEvent(
      execution.bounty_id,
      'execution_cancelled',
      callerWallet || '',
      'human',
      `Swarm execution ${id} cancelled by ${isCreator ? 'client' : 'agent owner'}`,
      ''
    );

    res.json({
      success: true,
      message: 'Swarm execution cancelled',
      execution_id: id,
      bounty_id: execution.bounty_id,
      cancelled_by: isCreator ? 'bounty_creator' : 'agent_owner'
    });
  } catch (error) {
    console.error('Error cancelling swarm execution:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/swarms/webhook — Receive async execution results from Swarms API
app.post('/api/swarms/webhook', async (req, res) => {
  try {
    // Verify webhook signature if secret is configured
    if (SWARMS_WEBHOOK_SECRET) {
      const signature = req.headers['x-swarms-signature'] || req.headers['x-webhook-signature'];

      if (!signature) {
        console.error('Webhook signature missing');
        return res.status(401).json({ error: 'Webhook signature required' });
      }

      // Verify HMAC-SHA256 signature
      const payload = JSON.stringify(req.body);
      const expectedSignature = createHash('sha256')
        .update(SWARMS_WEBHOOK_SECRET + payload)
        .digest('hex');

      // Support both "sha256=..." and raw hex formats
      const providedSignature = signature.startsWith('sha256=')
        ? signature.slice(7)
        : signature;

      if (providedSignature !== expectedSignature) {
        console.error('Webhook signature verification failed');
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    } else {
      // Log warning if webhook secret is not configured
      console.warn('⚠️  SWARMS_WEBHOOK_SECRET not set - webhook endpoint is unprotected');
    }

    const { execution_id, status, result, cost_usd } = req.body;

    if (!execution_id) {
      return res.status(400).json({ error: 'execution_id required' });
    }

    // Find the execution record
    const execResult = await pool.query('SELECT * FROM swarm_executions WHERE id = $1', [execution_id]);
    if (execResult.rows.length === 0) {
      return res.status(404).json({ error: 'Execution not found' });
    }

    const execution = execResult.rows[0];
    const now = new Date().toISOString();

    // Calculate costs
    const swarmsCostUsd = cost_usd || 0;
    const agentResult = await pool.query('SELECT is_platform_owned FROM agents WHERE id = $1', [execution.agent_id]);
    const isPlatformOwned = agentResult.rows[0]?.is_platform_owned === 1;
    const platformMarkupUsd = isPlatformOwned ? swarmsCostUsd * (SWARMS_PLATFORM_MARKUP_PCT / 100) : 0;
    const totalChargedUsd = swarmsCostUsd + platformMarkupUsd;

    // Update execution record
    await pool.query(
      `UPDATE swarm_executions
       SET status = $1, swarms_api_response = $2, swarms_cost_usd = $3,
           platform_markup_usd = $4, total_charged_usd = $5, completed_at = $6
       WHERE id = $7`,
      [status, JSON.stringify(req.body), swarmsCostUsd, platformMarkupUsd, totalChargedUsd, now, execution_id]
    );

    // If completed, update bounty with deliverable
    if (status === 'completed' && result) {
      const deliverable = typeof result === 'string' ? result : JSON.stringify(result);
      const hash = '0x' + createHash('sha256').update(deliverable).digest('hex');

      await pool.query(
        `UPDATE bounties SET deliverable_content = $1, deliverable_hash = $2,
         escrow_status = 'submitted', submitted_at = $3, updated_at = $4
         WHERE id = $5`,
        [deliverable, hash, now, now, execution.bounty_id]
      );

      await logEscrowEvent(execution.bounty_id, 'submitted', '', 'agent', 'Swarm webhook: deliverable submitted', '');

      // Notify client
      const bountyResult = await pool.query('SELECT creator_wallet, title FROM bounties WHERE id = $1', [execution.bounty_id]);
      if (bountyResult.rows.length > 0) {
        const bounty = bountyResult.rows[0];
        await createNotification({
          wallet: bounty.creator_wallet,
          type: 'system',
          title: 'Swarm Completed',
          message: `Swarm execution completed for "${bounty.title}". Review the deliverable.`,
          from: 'BARD System'
        });
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════
// ── Marketplace & Skill Registry ──
// ══════════════════════════════════════════════════════

// GET /api/marketplace — Browse available skills
app.get('/api/marketplace', async (req, res) => {
  const category = req.query.category;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const skills = category
    ? await stmts.searchSkillsByCategory(category, limit)
    : await stmts.searchSkills(limit);
  const openBounties = await stmts.getMarketplaceBounties(limit);
  res.json({ skills, openBounties });
});

// GET /api/marketplace/search — Search skills by keyword
app.get('/api/marketplace/search', async (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const category = req.query.category;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  let skills = category
    ? await stmts.searchSkillsByCategory(category, limit)
    : await stmts.searchSkills(limit);
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
app.post('/api/agents/:id/skills', async (req, res) => {
  const { skillName, category, description, keywords, hourlyRateUsdc, fixedRateUsdc, callerWallet } = req.body;
  if (!skillName) return res.status(400).json({ error: 'skillName required' });
  if (!(await checkRateLimit(req.params.id, 'skill_register'))) return res.status(429).json({ error: 'Rate limit exceeded' });

  const agent = await stmts.getAgentById(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  // Auth: caller must own the agent
  if (callerWallet && agent.owner_wallet.toLowerCase() !== callerWallet.toLowerCase()) {
    return res.status(403).json({ error: 'Only the agent owner can register skills' });
  }

  const validCategories = ['research', 'code', 'data', 'content', 'verification', 'execution', 'general'];
  const cat = validCategories.includes(category) ? category : 'general';

  const id = `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await stmts.insertAgentSkill({
    id, agent_id: req.params.id, skill_name: skillName, category: cat,
    description: description || '', keywords: JSON.stringify(keywords || []),
    hourly_rate_usdc: hourlyRateUsdc || 0, fixed_rate_usdc: fixedRateUsdc || 0,
    status: 'active', created_at: new Date().toISOString(),
  });

  res.json({ success: true, skill: await stmts.getSkillById(id) });
});

// GET /api/agents/:id/skills — List agent's skills
app.get('/api/agents/:id/skills', async (req, res) => {
  const status = req.query.status || 'active';
  const skills = await stmts.getAgentSkills(req.params.id, status);
  res.json({ skills });
});

// PUT /api/agents/:id/skills/:skillId — Update skill
app.put('/api/agents/:id/skills/:skillId', async (req, res) => {
  const skill = await stmts.getSkillById(req.params.skillId);
  if (!skill) return res.status(404).json({ error: 'Skill not found' });
  if (skill.agent_id !== req.params.id) return res.status(403).json({ error: 'Not your skill' });

  const { skillName, category, description, keywords, hourlyRateUsdc, fixedRateUsdc, status } = req.body;
  await stmts.updateAgentSkill({
    skill_name: skillName || skill.skill_name, category: category || skill.category,
    description: description !== undefined ? description : skill.description,
    keywords: keywords ? JSON.stringify(keywords) : skill.keywords,
    hourly_rate_usdc: hourlyRateUsdc !== undefined ? hourlyRateUsdc : skill.hourly_rate_usdc,
    fixed_rate_usdc: fixedRateUsdc !== undefined ? fixedRateUsdc : skill.fixed_rate_usdc,
    status: status || skill.status, id: req.params.skillId,
  });

  res.json({ success: true, skill: await stmts.getSkillById(req.params.skillId) });
});

// DELETE /api/agents/:id/skills/:skillId — Remove skill
app.delete('/api/agents/:id/skills/:skillId', async (req, res) => {
  const result = await stmts.deleteAgentSkill(req.params.skillId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Skill not found or not yours' });
  res.json({ success: true });
});

// GET /api/agents/:id/work-history — Completed escrow jobs
app.get('/api/agents/:id/work-history', async (req, res) => {
  const { rows: completed } = await pool.query(
    "SELECT id, title, escrow_budget_usdc, escrow_status, released_at, creator_wallet, bounty_type FROM bounties WHERE provider_agent_id = $1 AND escrow_status IN ('released', 'refunded') ORDER BY released_at DESC LIMIT 50",
    [req.params.id]
  );
  const stats = (await pool.query(
    "SELECT COUNT(*) as total, SUM(CASE WHEN escrow_status = 'released' THEN 1 ELSE 0 END) as completed, SUM(CASE WHEN escrow_status = 'released' THEN escrow_budget_usdc ELSE 0 END) as total_earned FROM bounties WHERE provider_agent_id = $1",
    [req.params.id]
  )).rows[0];
  res.json({ workHistory: completed, stats });
});

// GET /api/verification/log — Public verification audit trail
app.get('/api/verification/log', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const { rows: decisions } = await pool.query(
    'SELECT vd.*, b.title as bounty_title, b.escrow_budget_usdc FROM verification_decisions vd LEFT JOIN bounties b ON vd.bounty_id = b.id ORDER BY vd.created_at DESC LIMIT $1',
    [limit]
  );
  res.json({ decisions });
});

// GET /api/verification/stats — Platform verification statistics
app.get('/api/verification/stats', async (req, res) => {
  const total = (await pool.query('SELECT COUNT(*) as c FROM verification_decisions')).rows[0];
  const approved = (await pool.query("SELECT COUNT(*) as c FROM verification_decisions WHERE decision = 'approved'")).rows[0];
  const rejected = (await pool.query("SELECT COUNT(*) as c FROM verification_decisions WHERE decision = 'rejected'")).rows[0];
  const byStage = (await pool.query('SELECT stage, COUNT(*) as c FROM verification_decisions GROUP BY stage')).rows;
  res.json({ total: Number(total.c), approved: Number(approved.c), rejected: Number(rejected.c), byStage });
});

// ══════════════════════════════════════════════════════
// ── Agent Authentication (Challenge-Sign-Verify) ──
// ══════════════════════════════════════════════════════

// POST /api/auth/challenge — Step 1: Get a challenge to sign
app.post('/api/auth/challenge', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!(await checkRateLimit(ip, 'auth_challenge'))) {
    return res.status(429).json({ error: 'Too many challenge requests. Please try again later.' });
  }

  const { agentId } = req.body;

  // Validate agent exists if provided
  let agent = null;
  if (agentId) {
    agent = await stmts.getAgentById(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
  }

  const nonce = randomBytes(32).toString('hex');
  const challengeId = `challenge-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const scope = 'agent:full';
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min
  const message = `BARD Agent Authentication\n\nChallenge: ${nonce}\nScope: ${scope}\nAgent: ${agentId || 'any'}\nExpires: ${expiresAt}`;

  await stmts.insertChallenge({
    id: challengeId, agent_id: agentId || '',
    nonce, message, scope,
    expires_at: expiresAt, created_at: new Date().toISOString(),
  });

  res.json({ challengeId, message, scope, expiresAt, nonce });
});

// POST /api/auth/verify — Step 2: Submit signed challenge, get JWT token
app.post('/api/auth/verify', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!(await checkRateLimit(ip, 'auth_verify'))) {
    return res.status(429).json({ error: 'Too many verification attempts. Please try again later.' });
  }

  const { challengeId, signature, wallet } = req.body;
  if (!challengeId || !signature || !wallet) {
    return res.status(400).json({ error: 'challengeId, signature, and wallet required' });
  }

  const challenge = await stmts.getChallenge(challengeId);
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
    agent = await stmts.getAgentById(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (agent.owner_wallet.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(403).json({ error: 'Wallet does not own this agent' });
    }
  } else {
    // Find first agent owned by wallet
    const agents = await stmts.getAgentsByOwner(wallet);
    if (agents.length === 0) return res.status(404).json({ error: 'No agents found for this wallet. Register an agent first.' });
    agent = agents[0];
    agentId = agent.id;
  }

  // Mark challenge as used
  await stmts.markChallengeUsed(challengeId);

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

  await stmts.insertAuthToken({
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
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const agent = await stmts.getAgentById(req.auth.sub);
  const reputation = await calculateReputation(req.auth.sub);
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
app.post('/api/auth/revoke', requireAuth, async (req, res) => {
  const tokenId = req.body.tokenId || req.auth.jti;
  const tokenRecord = await stmts.getAuthToken(tokenId);
  if (!tokenRecord) return res.status(404).json({ error: 'Token not found' });
  // Can only revoke own tokens
  if (tokenRecord.wallet !== req.auth.wallet) {
    return res.status(403).json({ error: 'Can only revoke your own tokens' });
  }
  await stmts.revokeAuthToken(tokenId);
  res.json({ success: true, revoked: tokenId });
});

// GET /api/auth/tokens — List active tokens for authenticated agent
app.get('/api/auth/tokens', requireAuth, async (req, res) => {
  const tokens = await stmts.getTokensByAgent(req.auth.sub);
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
process.on('SIGINT', async () => { try { await pool.end(); } catch {} process.exit(0); });
process.on('SIGTERM', async () => { try { await pool.end(); } catch {} process.exit(0); });

// ══════════════════════════════════════════════════════
// ── Startup ──
// ══════════════════════════════════════════════════════
(async () => {
  try {
    const { ping } = await import('./db.js');
    await ping();
    console.log('  ✓ Postgres connected');
  } catch (err) {
    console.error('  ✗ Cannot reach Postgres. Is DATABASE_URL set and the DB reachable?');
    console.error('    Error:', err.message);
    if (!process.env.DATABASE_URL) {
      console.error('    Tip: On Railway, attach the Postgres plugin to this service.');
      console.error('         Locally, run `docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=bard \\');
      console.error('                       -e POSTGRES_DB=bard --name bard-pg postgres:16`');
      console.error('         and set DATABASE_URL=postgres://postgres:bard@localhost:5432/bard');
    }
    process.exit(1);
  }

  try {
    await initSchema();
    console.log('  ✓ Schema verified');

    // Bootstrap: ensure PLATFORM_OWNER_WALLET is always a verifier.
    try {
      await stmts.addPlatformVerifier({
        wallet: PLATFORM_OWNER_WALLET,
        added_by: PLATFORM_OWNER_WALLET,
        note: 'Auto-seeded platform owner',
      });
      const verifiers = await stmts.listPlatformVerifiers();
      console.log(`  ✓ Platform verifiers: ${verifiers.length} (owner + ${verifiers.length - 1} delegated)`);
    } catch (err) {
      console.error('  ! Could not seed platform verifier:', err.message);
    }
  } catch (err) {
    console.error('Fatal: schema init failed:', err.message);
    process.exit(1);
  }

  // Background tasks — start AFTER schema bootstrap so they don't race
  // against missing tables on first deploy.
  runReputationDecay();
  setInterval(runReputationDecay, 60 * 60 * 1000);
  checkEscrowExpiry();
  setInterval(checkEscrowExpiry, 60 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`\n  BARD API Server (Postgres + x402 + Agent Reputation)`);
    console.log(`  ───────────────────────────────────────────────────`);
    console.log(`  Local:    http://localhost:${PORT}`);
    console.log(`  Health:   http://localhost:${PORT}/api/health`);
    console.log(`  Agents:   http://localhost:${PORT}/api/agents`);
    console.log(`  x402:     http://localhost:${PORT}/api/x402/info`);
    console.log(`  Seller:   ${SELLER_ADDRESS}`);
    console.log(`  DB:       Postgres (DATABASE_URL)\n`);
  });
})();
