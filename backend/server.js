import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { createHash, createHmac, timingSafeEqual, randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';
import { formatUnits, verifyMessage, createPublicClient, http, parseUnits } from 'viem';
import { isTurnkeyEnabled, mintERC8004Identity, getOrCreateAgentWallet, auditTurnkeyOrphans, deleteStrandedWallets, signMessageWithAgentWallet } from './turnkey-wallet.js';
import { pool, query, initSchema, stmts } from './db.js';
import { isR2Enabled, uploadToR2, deleteFromR2, generateFilename } from './r2-storage.js';
import {
  ACHSWAP_ADAPTER,
  NATIVE_TOKEN,
  MAX_UINT256,
  ADAPTER_ABI,
  ERC20_ABI,
  resolveToken,
  achswapCall,
} from './achswap.js';
import { withMemo, MemoIds, ARC_MEMO_ADDRESS } from './arc-memo.js';
import { createSiweRouter } from './siwe-auth.js';
import { createHumanAuthRouter, requireHumanSession } from './human-auth.js';
import {
  buildHumanProfileTransactions,
  buildHumanProofTransaction,
  buildHumanUsdcTransfer,
  buildHumanVouchTransactions,
  createHumanVouch,
  createOrUpdateHumanProfile,
  fundManagedEscrow,
  humanWalletBalance,
  prepareHumanProfileTransaction,
  prepareHumanUsdcTransfer,
  prepareHumanVouchTransactions,
  sendHumanUsdc,
  submitHumanProof,
  validateExternalTransactionDetails,
} from './human-wallet-service.js';
import * as onchainEscrow from './escrow-service.js';
import { computeReputationScore } from './reputation-score.js';

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

// ── On-chain escrow gate ──
// When ON, eligible agent↔agent proposal bounties fund into the ERC-8183 escrow
// contract instead of the custodial platform wallet (escrow-service.js drives the
// whole lifecycle). Default OFF so merging this changes nothing until it's flipped.
// Eligibility ALSO requires both creator and provider to be Turnkey-signable
// wallets in the platform org (see resolveTurnkeyWallet) — the server signs every
// creator/provider leg, so a human/MetaMask creator can't use the on-chain path.
const ONCHAIN_ESCROW = process.env.ONCHAIN_ESCROW === '1' || process.env.ONCHAIN_ESCROW === 'true';

// ── Swarms API configuration ──
// DORMANT: the swarm feature is on hold. It stays code-complete but every
// entry point is gated behind SWARMS_ENABLED (default false) and returns 503.
// This neutralizes the known executeSwarm scope bug, the webhook, and the
// unauthenticated status endpoint until the feature is revisited. Flip
// SWARMS_ENABLED=true to re-enable.
const SWARMS_ENABLED = process.env.SWARMS_ENABLED === 'true';
const SWARMS_DISABLED_MSG = 'Swarm feature is temporarily disabled';
const SWARMS_API_KEY = process.env.SWARMS_API_KEY || '';
const SWARMS_PLATFORM_MARKUP_PCT = parseFloat(process.env.SWARMS_PLATFORM_MARKUP_PCT || '20');
const SWARMS_API_BASE = 'https://api.swarms.world';
const SWARMS_WEBHOOK_SECRET = process.env.SWARMS_WEBHOOK_SECRET || '';

// Express middleware: reject any swarm route while the feature is dormant.
function requireSwarmsEnabled(req, res, next) {
  if (!SWARMS_ENABLED) {
    return res.status(503).json({ error: SWARMS_DISABLED_MSG, hint: 'swarms_disabled' });
  }
  next();
}

function requireSwarmsWebhookSecret(_req, res, next) {
  if (!SWARMS_WEBHOOK_SECRET) {
    return res.status(503).json({
      error: 'Swarm webhook is unavailable because SWARMS_WEBHOOK_SECRET is not configured',
    });
  }
  next();
}

// ── Registration stake hook (Sybil resistance, deferred) ──
// When > 0, agent registration for a real wallet would additionally require a
// refundable USDC stake. Wired as a constant now; enforcement is future work.
const REGISTRATION_STAKE = parseFloat(process.env.REGISTRATION_STAKE || '0');

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
    nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
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
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Mcp-Session-Id',
    'Accept',
    'X-Privy-Token',
    'X-Elevated-Token',
  ],
}));
const captureRawBody = (req, _res, buffer) => {
  req.rawBody = Buffer.from(buffer);
};
app.use(express.json({ limit: '10mb', verify: captureRawBody }));
app.use(express.urlencoded({ extended: true, limit: '10mb', verify: captureRawBody }));

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
  'dex_swap': { max: 10, window: 3600 },       // 10 swaps per hour per agent
  'dex_swap_daily_usdc': { max: 500, window: 86400 }, // 500 USDC equivalent per 24h per agent (counter incremented by USDC units, see checkRateLimitN)
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

// Same as checkRateLimit but increments by N (e.g. USDC amount) per call instead
// of 1. Rejects if (current count + N) would exceed the configured max. Used by
// the dex_swap_daily_usdc cap where each call burns "amountIn USDC" of budget.
async function checkRateLimitN(key, action, n) {
  const limits = RATE_LIMITS[action];
  if (!limits) return true;
  if (n <= 0) return true;
  const fullKey = `${key}:${action}`;
  const now = Math.floor(Date.now() / 1000);
  const row = (await pool.query('SELECT count, window_start FROM rate_limits WHERE key = $1', [fullKey])).rows[0];
  if (!row || (now - row.window_start) > limits.window) {
    if (n > limits.max) return false;
    await pool.query(
      `INSERT INTO rate_limits (key, count, window_start) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET count = EXCLUDED.count, window_start = EXCLUDED.window_start`,
      [fullKey, n, now]
    );
    return true;
  }
  if (row.count + n > limits.max) return false;
  await pool.query('UPDATE rate_limits SET count = count + $1 WHERE key = $2', [n, fullKey]);
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
async function checkEscrowExpiry({ onlyBountyId = null } = {}) {
  const summary = { refunded: [], failed: [], skipped: [] };
  try {
    const now = new Date().toISOString();
    const query = onlyBountyId
      ? { text: "SELECT id, title, escrow_budget_usdc, creator_wallet, provider_agent_id, escrow_status, escrow_mode, onchain_job_id FROM bounties WHERE id = $1 AND expires_at IS NOT NULL AND expires_at < $2 AND escrow_status IN ('funded', 'claimed', 'submitted')", values: [onlyBountyId, now] }
      : { text: "SELECT id, title, escrow_budget_usdc, creator_wallet, provider_agent_id, escrow_status, escrow_mode, onchain_job_id FROM bounties WHERE expires_at IS NOT NULL AND expires_at < $1 AND escrow_status IN ('funded', 'claimed', 'submitted')", values: [now] };
    const { rows: expired } = await pool.query(query.text, query.values);

    // Without a signing provider we can't actually move USDC. Skip the
    // refund loop (but NOT the DB-only sweeps below) rather than lie in the
    // DB (the old behavior was to flip escrow_status to 'refunded' even
    // though the platform wallet still held the funds). Gate on
    // walletSigningReady(), not isTurnkeyEnabled() — prod runs Turnkey-free
    // (WALLET_PROVIDER=local/hybrid) and the old gate skipped refunds forever.
    let refundable = expired;
    if (expired.length > 0 && !walletSigningReady()) {
      console.warn(`  Escrow expiry: ${expired.length} bounty(ies) past expires_at, but no wallet provider is configured. Skipping auto-refund.`);
      for (const b of expired) summary.skipped.push({ id: b.id, reason: 'wallet_provider_disabled' });
      refundable = [];
    }

    for (const b of refundable) {
      // Move USDC FIRST. If the transfer throws, leave the row in its
      // current state so the next sweep retries. This is the same
      // ordering as the rejection refund at the verify endpoint
      // (transferUSDCFromPlatform → DB update), which is critical: a
      // DB-only flip with a failed transfer would strand the creator's
      // funds on the platform wallet forever.
      const amount = parseFloat(b.escrow_budget_usdc);
      let refundTx;
      try {
        if (b.escrow_mode === 'onchain' && b.onchain_job_id) {
          // On-chain: claimRefund (+ refundFee) returns the escrowed budget to the
          // client on-chain. Anyone can call it once the job's expiredAt passes.
          console.log(`[Escrow Expiry] On-chain refund for bounty ${b.id} (job ${b.onchain_job_id}, was ${b.escrow_status})...`);
          const { txs } = await onchainEscrow.refundExpired({ jobId: b.onchain_job_id });
          refundTx = txs.claimRefund;
        } else {
          console.log(`[Escrow Expiry] Refunding ${amount} USDC to ${b.creator_wallet} for bounty ${b.id} (was ${b.escrow_status})...`);
          refundTx = await transferUSDCFromPlatform(b.creator_wallet, amount, {
            memoId: MemoIds.JobRefundExp,
            memoData: {
              bountyId: b.id,
              creatorWallet: b.creator_wallet,
              amountUsd: amount,
              cause: 'expired',
              previousStatus: b.escrow_status,
            },
          });
        }
      } catch (err) {
        console.error(`  Escrow expiry refund failed for ${b.id}: ${err.message}. Will retry next tick.`);
        summary.failed.push({ id: b.id, error: err.message });
        continue;
      }

      try {
        await pool.query(
          "UPDATE bounties SET escrow_status = 'refunded', status = 'expired', updated_at = $1 WHERE id = $2",
          [now, b.id]
        );
        const evtId = `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await pool.query(
          `INSERT INTO escrow_events (id, bounty_id, event_type, actor_wallet, actor_type, details, tx_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [evtId, b.id, 'expired', '', 'system', `Escrow expired. ${amount} USDC auto-refunded to creator.`, refundTx, now]
        );
        console.log(`  Escrow expired: ${b.id} (${amount} USDC refunded, tx: ${refundTx})`);
        summary.refunded.push({ id: b.id, amount, tx: refundTx, creatorWallet: b.creator_wallet });

        await createNotification({
          wallet: b.creator_wallet,
          type: 'send',
          title: 'Escrow Auto-Refunded',
          message: `"${b.title}" expired before completion. ${amount} USDC refunded to your wallet.`,
          from: 'BARD System',
          amount,
        }).catch(() => {});

        if (b.provider_agent_id) {
          await createNotification({
            agentId: b.provider_agent_id,
            type: 'system',
            title: 'Bounty Expired',
            message: `"${b.title}" expired before verification. Escrow returned to the creator.`,
            from: 'BARD System',
          }).catch(() => {});
        }
      } catch (err) {
        // DB write failed AFTER on-chain transfer — log loudly so an
        // operator can reconcile. The funds already moved; the row will
        // look stale until manually fixed.
        console.error(`  Escrow expiry DB update failed for ${b.id} AFTER refund tx ${refundTx}: ${err.message}. MANUAL RECONCILIATION REQUIRED.`);
      }
    }

    // Auto-revert stuck proposal_selected bounties (creator never funded within 24h of accept).
    // Skip when onlyBountyId is set — that path is for one-shot refund testing/ops.
    if (onlyBountyId) return summary;
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

    // Expire stale claimable bounties past their deadline (dogfood F6).
    // Only open/proposal_open with NO active escrow — pure DB flip, no funds
    // move, so it's safe regardless of wallet-provider availability. Funded
    // escrows are handled by the refund sweep above via expires_at.
    const { rows: staleOpen } = await pool.query(
      `SELECT id, title, creator_wallet, selection_mode FROM bounties
       WHERE status IN ('open', 'proposal_open')
         AND escrow_status NOT IN ('funded', 'claimed', 'submitted')
         AND deadline ~ '^\\d{4}-\\d{2}-\\d{2}' AND deadline::timestamptz < NOW()`
    );
    for (const b of staleOpen) {
      try {
        await pool.query(
          "UPDATE bounties SET status = 'expired', updated_at = $1 WHERE id = $2",
          [now, b.id]
        );
        if (b.selection_mode === 'proposal') {
          const proposals = await stmts.getProposalsByBounty(b.id);
          for (const p of proposals) {
            if (p.status === 'pending') {
              await stmts.rejectProposal({ id: p.id, rejected_at: now, rejection_reason: 'Bounty deadline passed' });
              await createNotification({
                agentId: p.proposer_agent_id,
                type: 'system',
                title: 'Bounty Expired',
                message: `"${b.title}" expired before a proposal was accepted. Your proposal is no longer active.`,
                from: 'BARD System',
              }).catch(() => {});
            }
          }
        }
        await logEscrowEvent(b.id, 'expired', '', 'system', 'Deadline passed with no active escrow — bounty auto-expired.', '');
        console.log(`  Stale bounty expired: ${b.id} ("${b.title}", deadline passed)`);
      } catch (err) {
        console.error(`  Stale bounty expire error for ${b.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Escrow expiry sweep error:', err.message);
  }
  return summary;
}

// ── Daily Turnkey orphan-wallet audit ──
// Read-only sweep. If anything is adoptable or stranded, log it and POST
// a summary to ORPHAN_AUDIT_WEBHOOK (Slack/Discord-compatible JSON) when set.
// Operator still has to run audit-turnkey-orphans.mjs --apply / --cleanup-stranded
// to actually reconcile — this just surfaces drift before it piles up.
async function runOrphanAudit() {
  if (!isTurnkeyEnabled()) return;
  try {
    const result = await auditTurnkeyOrphans(pool);
    if (result?.error) {
      console.error('Orphan audit error:', result.error);
      return;
    }
    const { summary } = result;
    const drift = (summary.adoptable || 0) + (summary.stranded || 0);
    if (drift === 0) {
      console.log(`  Orphan audit: clean (${summary.ok} ok, ${summary.totalAgentWallets} agent wallets, ${summary.platformWallets} platform)`);
      return;
    }
    console.warn(`  Orphan audit: drift detected — adoptable=${summary.adoptable}, stranded=${summary.stranded}, ok=${summary.ok}`);
    const webhook = process.env.ORPHAN_AUDIT_WEBHOOK;
    if (webhook) {
      const text = `BARD orphan-wallet drift: adoptable=${summary.adoptable}, stranded=${summary.stranded} (ok=${summary.ok}). Run \`audit-turnkey-orphans.mjs --execute --apply\` and/or \`--cleanup-stranded\`.`;
      try {
        await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, summary }),
        });
      } catch (err) {
        console.error('  Orphan audit webhook post failed:', err.message);
      }
    }
  } catch (err) {
    console.error('Orphan audit sweep error:', err.message);
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

  const [agent, bountyResult, verifierResult] = await Promise.all([
    stmts.getAgentById(agentId),
    pool.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE status = 'completed'
             AND escrow_status = 'released'
             AND verifier_decision = 'approved'
         ) AS completed,
         COUNT(*) FILTER (WHERE verifier_decision = 'rejected') AS rejected
       FROM bounties
       WHERE provider_agent_id = $1`,
      [agentId],
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE result = 'approved') AS approvals
       FROM agent_verifications
       WHERE verifier_agent_id = $1`,
      [agentId],
    ),
  ]);
  const completedBounties = Number(bountyResult.rows[0]?.completed || 0);
  const rejectedBounties = Number(bountyResult.rows[0]?.rejected || 0);
  const verificationApprovals = Number(verifierResult.rows[0]?.approvals || 0);
  const ageInDays = agent ? (Date.now() - new Date(agent.created_at).getTime()) / (1000 * 60 * 60 * 24) : 0;
  const timeDecay = Math.max(0, Math.floor(ageInDays * 0.1));

  const score = computeReputationScore({
    verified,
    pending,
    rejected,
    totalEndorsements,
    completedBounties,
    rejectedBounties,
    verificationApprovals,
    timeDecay,
  });

  const { tier, level } = getTier(score);
  await stmts.updateAgentReputation(score, contributions.length, totalEndorsements, agentId);
  return {
    score,
    tier,
    level,
    totalContributions: contributions.length,
    totalEndorsements,
    verified,
    pending,
    rejected,
    completedBounties,
    rejectedBounties,
    verificationApprovals,
  };
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
const MCP_INTERNAL_SECRET = process.env.MCP_INTERNAL_SECRET || '';
const PLATFORM_OPERATOR_SECRET = process.env.PLATFORM_OPERATOR_SECRET || '';
const mcpOnlySetting = String(process.env.MCP_ONLY_AGENT_API || '').toLowerCase();
const MCP_ONLY_AGENT_API = mcpOnlySetting
  ? !['0', 'false'].includes(mcpOnlySetting)
  : process.env.NODE_ENV === 'production';
const usedMcpNonces = new Map();

// Require JWT_SECRET in production
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET must be set in production for security');
  process.exit(1);
}
// Loud warning when running on the derived dev secret — it is computed from the
// PUBLIC SELLER_ADDRESS, so any token signed with it is forgeable. Local dev only.
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET is not set — using an INSECURE secret derived from the public SELLER_ADDRESS. Tokens are forgeable. Set JWT_SECRET for anything beyond local dev.');
}
if (process.env.NODE_ENV === 'production' && MCP_ONLY_AGENT_API && !MCP_INTERNAL_SECRET) {
  console.error('FATAL: MCP_ONLY_AGENT_API requires MCP_INTERNAL_SECRET in production');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && SWARMS_ENABLED && !SWARMS_WEBHOOK_SECRET) {
  console.error('FATAL: SWARMS_ENABLED requires SWARMS_WEBHOOK_SECRET in production');
  process.exit(1);
}

// ── SIWE wallet sessions (Sign-In With Ethereum, EIP-4361) ──
// Additive: mounts /auth/nonce, /auth/verify, /auth/me. Reuses JWT_SECRET so
// wallet sessions share the same bearer scheme as agent tokens.
app.use(createSiweRouter({ jwtSecret: JWT_SECRET }));
app.use('/api/human', createHumanAuthRouter({ jwtSecret: JWT_SECRET }));
const requireHuman = requireHumanSession(JWT_SECRET);

function requestHasValidMcpProof(req, token) {
  if (!MCP_INTERNAL_SECRET || !token) return false;
  const timestamp = String(req.headers['x-bard-mcp-timestamp'] || '');
  const nonce = String(req.headers['x-bard-mcp-nonce'] || '').toLowerCase();
  const suppliedBodyHash = String(req.headers['x-bard-mcp-body-sha256'] || '').toLowerCase();
  const signature = String(req.headers['x-bard-mcp-signature'] || '').toLowerCase();
  if (
    !/^\d{13}$/.test(timestamp) ||
    !/^[0-9a-f]{32}$/.test(nonce) ||
    !/^[0-9a-f]{64}$/.test(suppliedBodyHash) ||
    !/^[0-9a-f]{64}$/.test(signature)
  ) return false;
  if (Math.abs(Date.now() - Number(timestamp)) > 90_000) return false;

  const now = Date.now();
  for (const [seenNonce, seenAt] of usedMcpNonces) {
    if (now - seenAt > 90_000) usedMcpNonces.delete(seenNonce);
  }
  if (usedMcpNonces.has(nonce)) return false;

  const declaredBody = Number(req.headers['content-length'] || 0) > 0 ||
    Boolean(req.headers['transfer-encoding']);
  if (declaredBody && !Buffer.isBuffer(req.rawBody)) return false;
  const bodyHash = createHash('sha256').update(req.rawBody || Buffer.alloc(0)).digest('hex');
  if (bodyHash !== suppliedBodyHash) return false;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const payload = `${timestamp}\n${nonce}\n${req.method.toUpperCase()}\n${req.originalUrl}\n${tokenHash}\n${bodyHash}`;
  const expected = createHmac('sha256', MCP_INTERNAL_SECRET).update(payload).digest('hex');
  const valid = timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  if (valid) usedMcpNonces.set(nonce, now);
  return valid;
}

function requestHasOperatorSecret(req) {
  if (!PLATFORM_OPERATOR_SECRET) return false;
  const supplied = Buffer.from(String(req.headers['x-bard-operator-secret'] || ''));
  const expected = Buffer.from(PLATFORM_OPERATOR_SECRET);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function requireTrustedServiceOrOperator(req, res, next) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (requestHasValidMcpProof(req, token) || requestHasOperatorSecret(req)) return next();
  return res.status(403).json({
    error: 'This operation requires BARD MCP or platform operator authentication',
    hint: 'use_mcp',
  });
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
    const humanDelegated = decoded.kind === 'human-agent-session';
    const mcpVerified = requestHasValidMcpProof(req, token);
    if (MCP_ONLY_AGENT_API && !humanDelegated && !mcpVerified) {
      return res.status(403).json({
        error: 'Authenticated agent actions are MCP-only. Use the BARD MCP server and bard_* tools.',
        hint: 'use_mcp',
        mcpUrl: process.env.MCP_URL || 'https://mcp-production-8d2e.up.railway.app/mcp',
      });
    }
    req.auth = decoded;
    req.authTransport = humanDelegated ? 'human-delegation' : (mcpVerified ? 'mcp' : 'direct');
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireOwnAgent(req, res, next) {
  if (req.auth.agentId !== req.params.id) {
    return res.status(403).json({ error: 'You can only manage your own agent' });
  }
  next();
}

// ══════════════════════════════════════════════════════
// ── Real agent attestations (verifiable proof of work) ──
// Agents attest to contributions and verifications by signing a canonical,
// deterministic message with their own key. Previously the "signature" was
// random bytes; now it is a real EIP-191 signature that anyone can recover.
// ══════════════════════════════════════════════════════

// Deterministic messages — MUST be reproducible byte-for-byte to verify.
function canonicalContributionMessage({ agentId, type, proofHash }) {
  return `BARD contribution attestation\nagent:${agentId}\ntype:${type}\nproof:${proofHash}`;
}
function canonicalVerificationMessage({ verifierAgentId, contributionId, result }) {
  return `BARD verification attestation\nverifier:${verifierAgentId}\ncontribution:${contributionId}\nresult:${result}`;
}

/**
 * Produce a REAL signature for an agent's attestation, or verify a client-supplied one.
 *
 * - If `providedSignature` is given (manual-key agents that signed client-side),
 *   recover/verify it against the agent's known address; reject if it doesn't match.
 * - Otherwise, if Turnkey is enabled, sign the message with the agent's Turnkey wallet.
 * - Otherwise throw — we no longer accept unverifiable/placeholder signatures.
 *
 * Returns { signature, signer } where `signer` is the attesting address.
 */
async function attestAgentMessage({ agent, message, providedSignature }) {
  const knownAddress = agent.turnkey_address || agent.owner_wallet;

  if (providedSignature) {
    if (!knownAddress || !/^0x[0-9a-fA-F]{40}$/.test(knownAddress)) {
      throw new Error('Agent has no known signing address to verify against');
    }
    let valid = false;
    try {
      valid = await verifyMessage({ address: knownAddress, message, signature: providedSignature });
    } catch {
      valid = false;
    }
    if (!valid) throw new Error('Invalid signature — does not match agent address');
    return { signature: providedSignature, signer: knownAddress.toLowerCase() };
  }

  if (!walletSigningReady()) {
    throw new Error('Signature required: no wallet provider is configured and no client signature was provided');
  }
  const { signature, address } = await signMessageWithAgentWallet(pool, agent.id, agent.agent_name, message);
  return { signature, signer: address.toLowerCase() };
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

app.post('/api/profiles', (_req, res) => {
  res.status(410).json({
    error: 'Profile writes require an authenticated BARD human session',
    hint: 'Use POST /api/human/profile',
  });
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
// ── Human wallet actions ──
// ══════════════════════════════════════════════════════

function humanUsesExternalWallet(req) {
  return req.human.wallet_type === 'external';
}

function externalTransactionPayload(transaction) {
  return {
    to: transaction.to,
    data: transaction.data || '0x',
    value: `0x${BigInt(transaction.value || 0n).toString(16)}`,
    chainId: 5042002,
  };
}

async function verifyExactExternalTransaction(
  txHash,
  expectedFrom,
  expectedTo,
  acceptedData
) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '')) {
    return { valid: false, error: 'Valid transaction hash required' };
  }
  const receipt = await onchainEscrow.withArcRpcRetry(
    () => arcTestnetClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 }),
    { label: `external transaction ${txHash} receipt` },
  );
  const transaction = await onchainEscrow.withArcRpcRetry(
    () => arcTestnetClient.getTransaction({ hash: txHash }),
    { label: `external transaction ${txHash} details` },
  );
  const validation = validateExternalTransactionDetails({
    receipt,
    transaction,
    expectedFrom,
    expectedTo,
    acceptedData,
  });
  return validation.valid
    ? { valid: true, receipt, transaction }
    : validation;
}

async function claimHumanTransaction(req, txHash, action) {
  const result = await pool.query(
    `INSERT INTO human_tx_confirmations (tx_hash, action, human_id)
     VALUES (LOWER($1), $2, $3)
     ON CONFLICT (tx_hash, action) DO NOTHING
     RETURNING tx_hash`,
    [txHash, action, req.human.id]
  );
  return result.rowCount > 0;
}

async function persistExternalProofConfirmation(req, txHash, proof) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO human_tx_confirmations
         (tx_hash, action, human_id, resource_id)
       VALUES (LOWER($1), 'proof', $2, $3)
       ON CONFLICT (tx_hash, action) DO NOTHING
       RETURNING human_id, resource_id`,
      [txHash, req.human.id, proof.id]
    );
    const confirmation = inserted.rows[0] || (await client.query(
      `SELECT human_id, resource_id
         FROM human_tx_confirmations
        WHERE tx_hash = LOWER($1) AND action = 'proof'
        FOR UPDATE`,
      [txHash]
    )).rows[0];
    if (!confirmation || confirmation.human_id !== req.human.id) {
      throw Object.assign(
        new Error('This proof transaction is already assigned to another account'),
        { status: 409 }
      );
    }
    if (confirmation.resource_id && confirmation.resource_id !== proof.id) {
      throw Object.assign(
        new Error('This proof transaction is already assigned to another proof'),
        { status: 409 }
      );
    }
    if (!confirmation.resource_id) {
      await client.query(
        `UPDATE human_tx_confirmations
            SET resource_id = $1
          WHERE tx_hash = LOWER($2) AND action = 'proof'`,
        [proof.id, txHash]
      );
    }
    await client.query(
      `INSERT INTO proofs
         (id, title, ecosystem, contribution_type, description, external_links,
          contributor, status, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [
        proof.id,
        proof.title,
        proof.ecosystem,
        proof.contribution_type,
        proof.description,
        proof.external_links,
        proof.contributor,
        proof.status,
        proof.timestamp,
      ]
    );
    await client.query('COMMIT');
    return inserted.rowCount > 0;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

app.get('/api/human/wallet', requireHuman, async (req, res) => {
  try {
    res.json({
      ...(await humanWalletBalance(req.human.wallet_address)),
      type: req.human.wallet_type === 'external' ? 'external' : 'managed',
    });
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message });
  }
});

app.post('/api/human/profile', requireHuman, async (req, res) => {
  const wallet = req.human.wallet_address;
  const {
    username,
    displayName = '',
    bio = '',
    profileType = 'human',
    ecosystems = [],
    farcaster = '',
    github = '',
    x = '',
    discord = '',
    linkedin = '',
    pfp = '',
    txHash = '',
  } = req.body || {};
  if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(username || '') || username.includes('--')) {
    return res.status(400).json({ error: 'Username must be 3-32 lowercase letters, numbers, or single hyphens' });
  }
  const profileKind = profileType === 'agent' ? 'agent' : 'human';
  const metadata = {
    username,
    display_name: displayName,
    profile_type: profileKind,
    bio,
    ecosystems: Array.isArray(ecosystems) ? ecosystems : [],
    wallet,
    farcaster: farcaster || undefined,
    github: github || undefined,
    x: x || undefined,
    discord: discord || undefined,
    linkedin: linkedin || undefined,
    created_at: new Date().toISOString(),
  };
  const metadataURI = `data:application/json,${encodeURIComponent(JSON.stringify(metadata))}`;

  try {
    const usernameOwner = await stmts.getProfileByUsername(username);
    if (usernameOwner && usernameOwner.wallet.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(409).json({ error: 'Username is already taken' });
    }
    const profileTransaction = {
      username,
      metadataURI,
      profileType: profileKind === 'agent' ? 1 : 0,
    };
    let confirmedTxHash = '';
    if (humanUsesExternalWallet(req)) {
      const expected = buildHumanProfileTransactions(profileTransaction);
      if (!txHash) {
        const prepared = await prepareHumanProfileTransaction(wallet, profileTransaction);
        return res.status(202).json({
          signatureRequired: true,
          walletType: 'external',
          transaction: externalTransactionPayload(prepared.transaction),
        });
      }
      const verification = await verifyExactExternalTransaction(
        txHash,
        wallet,
        expected.create.to,
        [expected.create.data, expected.update.data]
      );
      if (!verification.valid) {
        return res.status(409).json({ error: verification.error, txHash });
      }
      confirmedTxHash = txHash.toLowerCase();
    } else {
      const chain = await createOrUpdateHumanProfile(wallet, profileTransaction);
      confirmedTxHash = chain.txHash;
    }
    const now = new Date().toISOString();
    await stmts.upsertProfile({
      wallet,
      username,
      display_name: displayName,
      bio,
      profile_type: profileKind,
      ecosystems: JSON.stringify(Array.isArray(ecosystems) ? ecosystems : []),
      farcaster,
      github,
      x,
      discord,
      linkedin,
      pfp,
      created_at: now,
    });
    if (humanUsesExternalWallet(req)) {
      await claimHumanTransaction(req, confirmedTxHash, 'profile');
    }
    const saved = await stmts.getProfileByWallet(wallet);
    res.json({
      success: true,
      profile: profileToJSON(saved),
      txHash: confirmedTxHash,
      explorer: `https://testnet.arcscan.app/tx/${confirmedTxHash}`,
    });
  } catch (error) {
    res.status(error.status || 502).json({
      error: error.message,
      code: error.code,
      txHash: error.txHash,
      gasTopUpTxHash: error.gasTopUpTxHash,
    });
  }
});

app.post('/api/human/send-usdc', requireHuman, async (req, res) => {
  try {
    const { to, amount, txHash = '' } = req.body || {};
    let confirmedTxHash = '';
    let firstConfirmation = true;
    if (humanUsesExternalWallet(req)) {
      const transaction = buildHumanUsdcTransfer(to, amount);
      if (!txHash) {
        await prepareHumanUsdcTransfer(req.human.wallet_address, to, amount);
        return res.status(202).json({
          signatureRequired: true,
          walletType: 'external',
          transaction: externalTransactionPayload(transaction),
        });
      }
      const verification = await verifyExactExternalTransaction(
        txHash,
        req.human.wallet_address,
        transaction.to,
        transaction.data
      );
      if (!verification.valid) {
        return res.status(409).json({ error: verification.error, txHash });
      }
      confirmedTxHash = txHash.toLowerCase();
      firstConfirmation = await claimHumanTransaction(req, confirmedTxHash, 'send-usdc');
    } else {
      const result = await sendHumanUsdc(req.human.wallet_address, to, amount);
      confirmedTxHash = result.txHash;
    }
    if (firstConfirmation) {
      await createNotification({
        wallet: req.human.wallet_address,
        type: 'send',
        title: 'USDC Sent',
        message: `${amount} USDC sent to ${to}`,
        from: req.human.wallet_address,
        amount: String(amount),
      });
      await createNotification({
        wallet: to,
        type: 'send',
        title: 'USDC Received',
        message: `${amount} USDC received from ${req.human.wallet_address}`,
        from: req.human.wallet_address,
        amount: String(amount),
      });
    }
    res.json({
      success: true,
      txHash: confirmedTxHash,
      explorer: `https://testnet.arcscan.app/tx/${confirmedTxHash}`,
    });
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message, txHash: error.txHash });
  }
});

app.post('/api/human/proofs', requireHuman, async (req, res) => {
  try {
    const wallet = req.human.wallet_address;
    const {
      id = `proof-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      description = '',
      ecosystem = '',
      contributionType = 'other',
      externalLinks = [],
      fileUrl = '',
      txHash = '',
    } = req.body || {};
    const links = Array.isArray(externalLinks) ? externalLinks.filter(Boolean) : [];
    if (fileUrl) links.push(fileUrl);
    const proofTransaction = {
      title,
      description,
      ecosystem,
      contributionType,
      externalLink: links[0] || '',
    };
    let confirmedTxHash = '';
    let alreadyConfirmed = false;
    if (humanUsesExternalWallet(req)) {
      const transaction = buildHumanProofTransaction(proofTransaction);
      if (!txHash) {
        return res.status(202).json({
          signatureRequired: true,
          walletType: 'external',
          transaction: externalTransactionPayload(transaction),
        });
      }
      const verification = await verifyExactExternalTransaction(
        txHash,
        wallet,
        transaction.to,
        transaction.data
      );
      if (!verification.valid) {
        return res.status(409).json({ error: verification.error, txHash });
      }
      confirmedTxHash = txHash.toLowerCase();
    } else {
      const chain = await submitHumanProof(wallet, proofTransaction);
      confirmedTxHash = chain.txHash;
    }
    const timestamp = new Date().toISOString();
    const proof = {
      id,
      title,
      ecosystem,
      contribution_type: contributionType,
      description,
      external_links: JSON.stringify(links),
      contributor: wallet,
      status: 'unvalidated',
      timestamp,
    };
    if (humanUsesExternalWallet(req)) {
      alreadyConfirmed = !await persistExternalProofConfirmation(
        req,
        confirmedTxHash,
        proof
      );
    } else {
      await stmts.insertProof(proof);
    }
    res.json({
      success: true,
      alreadyConfirmed,
      proof: proofToJSON(await stmts.getProofById?.(id) || {
        id, title, ecosystem, contribution_type: contributionType, description,
        external_links: JSON.stringify(links), contributor: wallet,
        status: 'unvalidated', timestamp,
      }),
      txHash: confirmedTxHash,
      explorer: `https://testnet.arcscan.app/tx/${confirmedTxHash}`,
    });
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message, txHash: error.txHash });
  }
});

app.post('/api/human/vouches', requireHuman, async (req, res) => {
  try {
    const input = req.body || {};
    let result;
    let firstConfirmation = true;
    if (humanUsesExternalWallet(req)) {
      const transactions = buildHumanVouchTransactions(input);
      const approveTxHash = String(input.approveTxHash || '');
      const vouchTxHash = String(input.vouchTxHash || '');
      if (!approveTxHash) {
        await prepareHumanVouchTransactions(req.human.wallet_address, input);
        return res.status(202).json({
          signatureRequired: true,
          walletType: 'external',
          stage: 'approve',
          transaction: externalTransactionPayload(transactions.approve),
        });
      }
      const approval = await verifyExactExternalTransaction(
        approveTxHash,
        req.human.wallet_address,
        transactions.approve.to,
        transactions.approve.data
      );
      if (!approval.valid) {
        return res.status(409).json({
          error: approval.error,
          txHash: approveTxHash,
          stage: 'approve',
        });
      }
      if (!vouchTxHash) {
        return res.status(202).json({
          signatureRequired: true,
          walletType: 'external',
          stage: 'vouch',
          approveTxHash: approveTxHash.toLowerCase(),
          transaction: externalTransactionPayload(transactions.vouch),
        });
      }
      const vouch = await verifyExactExternalTransaction(
        vouchTxHash,
        req.human.wallet_address,
        transactions.vouch.to,
        transactions.vouch.data
      );
      if (!vouch.valid) {
        return res.status(409).json({
          error: vouch.error,
          txHash: vouchTxHash,
          stage: 'vouch',
        });
      }
      firstConfirmation = await claimHumanTransaction(
        req,
        vouchTxHash.toLowerCase(),
        'vouch'
      );
      result = {
        approveTxHash: approveTxHash.toLowerCase(),
        txHash: vouchTxHash.toLowerCase(),
      };
    } else {
      result = await createHumanVouch(req.human.wallet_address, input);
    }
    if (firstConfirmation) {
      await createNotification({
        wallet: input.contributorWallet,
        type: 'vouch',
        title: 'New Vouch Received',
        message: `${input.amount} USDC vouch received`,
        from: req.human.wallet_address,
        amount: String(input.amount || ''),
      });
    }
    res.json({
      success: true,
      ...result,
      explorer: `https://testnet.arcscan.app/tx/${result.txHash}`,
    });
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message, txHash: error.txHash });
  }
});

// A logged-in human can operate an agent linked to their managed wallet without
// exposing or browser-signing with that wallet's private key.
app.post('/api/human/agents/:id/token', requireHuman, async (req, res) => {
  const agent = await stmts.getAgentById(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (agent.owner_wallet?.toLowerCase() !== req.human.wallet_address.toLowerCase()) {
    return res.status(403).json({ error: 'Agent is not linked to this BARD account' });
  }
  const tokenId = `tok-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const token = jwt.sign({
    sub: agent.id,
    agentId: agent.id,
    kind: 'human-agent-session',
    wallet: agent.owner_wallet.toLowerCase(),
    scope: 'agent:human-delegated',
    agentName: agent.agent_name,
    jti: tokenId,
  }, JWT_SECRET, { expiresIn: '15m' });
  await stmts.insertAuthToken({
    id: tokenId,
    agent_id: agent.id,
    wallet: agent.owner_wallet.toLowerCase(),
    scope: 'agent:human-delegated',
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
  });
  res.json({ token, agentId: agent.id, agentName: agent.agent_name, expiresAt });
});

// ══════════════════════════════════════════════════════
// ── Routes: Proofs ──
// ══════════════════════════════════════════════════════

app.post('/api/proofs', (_req, res) => {
  res.status(410).json({
    error: 'Proof writes require an authenticated BARD human or agent session',
    hint: 'Use POST /api/human/proofs or bard_submit_contribution',
  });
});

app.get('/api/proofs/:wallet', async (req, res) => {
  const rows = await stmts.getProofsByWallet(req.params.wallet);
  res.json({ proofs: rows.map(proofToJSON) });
});

// ══════════════════════════════════════════════════════
// ── Routes: Portfolio ──
// ══════════════════════════════════════════════════════

app.post('/api/human/portfolio', requireHuman, async (req, res) => {
  const p = req.body || {};
  const wallet = req.human.wallet_address;
  if (!p.id) return res.status(400).json({ error: 'id required' });
  try {
    await stmts.insertPortfolio({
      id: p.id, wallet, title: p.title || '',
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

app.delete('/api/human/portfolio/:id', requireHuman, async (req, res) => {
  const item = (await pool.query(
    'SELECT wallet FROM portfolio WHERE id = $1',
    [req.params.id]
  )).rows[0];
  if (!item) return res.status(404).json({ error: 'Portfolio item not found' });
  if (item.wallet.toLowerCase() !== req.human.wallet_address.toLowerCase()) {
    return res.status(403).json({ error: 'You can only delete your own portfolio items' });
  }
  const result = await stmts.deletePortfolio(req.params.id);
  res.json({ success: true, deleted: result.changes > 0 });
});

app.put('/api/human/portfolio/reorder', requireHuman, async (req, res) => {
  const { orderedIds } = req.body || {};
  if (!Array.isArray(orderedIds)) {
    return res.status(400).json({ error: 'orderedIds must be an array' });
  }
  if (orderedIds.length > 0) {
    const owned = await pool.query(
      'SELECT id FROM portfolio WHERE wallet = $1 AND id = ANY($2::text[])',
      [req.human.wallet_address, orderedIds]
    );
    if (owned.rows.length !== new Set(orderedIds).size) {
      return res.status(403).json({ error: 'Portfolio order contains an item you do not own' });
    }
  }
  // Sequential reorder. (SQLite version used db.transaction() to batch these —
  // Postgres equivalent would require a pool.connect() + BEGIN/COMMIT block.
  // The previous batched version had no atomicity requirement either, so we
  // keep this sequential and treat the call as best-effort.)
  for (let i = 0; i < orderedIds.length; i++) {
    await stmts.updatePortfolioOrder(i, orderedIds[i]);
  }
  res.json({ success: true });
});

app.post('/api/portfolio', (_req, res) => {
  res.status(410).json({
    error: 'Portfolio writes require an authenticated BARD human session',
    hint: 'Use POST /api/human/portfolio',
  });
});

app.delete('/api/portfolio/:id', (_req, res) => {
  res.status(410).json({
    error: 'Portfolio writes require an authenticated BARD human session',
    hint: 'Use DELETE /api/human/portfolio/:id',
  });
});

app.put('/api/portfolio/reorder', (_req, res) => {
  res.status(410).json({
    error: 'Portfolio writes require an authenticated BARD human session',
    hint: 'Use PUT /api/human/portfolio/reorder',
  });
});

// ══════════════════════════════════════════════════════
// ── Routes: Notifications ──
// ══════════════════════════════════════════════════════

app.post('/api/notifications', (_req, res) => {
  res.status(410).json({
    error: 'Notifications are created by authenticated BARD workflows',
  });
});

app.get('/api/human/notifications', requireHuman, async (req, res) => {
  const rows = await stmts.getNotificationsByWallet(req.human.wallet_address);
  res.json({ notifications: rows.map(notifToJSON) });
});

app.put('/api/human/notifications/:id/read', requireHuman, async (req, res) => {
  const notification = (await pool.query(
    'SELECT wallet FROM notifications WHERE id = $1',
    [req.params.id]
  )).rows[0];
  if (!notification) return res.status(404).json({ error: 'Notification not found' });
  if (notification.wallet.toLowerCase() !== req.human.wallet_address.toLowerCase()) {
    return res.status(403).json({ error: 'You can only update your own notifications' });
  }
  await stmts.markRead(req.params.id);
  res.json({ success: true });
});

app.put('/api/human/notifications/read-all', requireHuman, async (req, res) => {
  await stmts.markAllRead(req.human.wallet_address);
  res.json({ success: true });
});

app.get('/api/notifications/:wallet', (_req, res) => {
  res.status(410).json({
    error: 'Notification reads require an authenticated BARD account',
    hint: 'Use GET /api/human/notifications or bard_get_notifications',
  });
});

app.put('/api/notifications/:id/read', (_req, res) => {
  res.status(410).json({
    error: 'Notification updates require an authenticated BARD human session',
    hint: 'Use PUT /api/human/notifications/:id/read',
  });
});

app.put('/api/notifications/:wallet/read-all', (_req, res) => {
  res.status(410).json({
    error: 'Notification updates require an authenticated BARD human session',
    hint: 'Use PUT /api/human/notifications/read-all',
  });
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

app.post('/api/upload/portfolio', requireHuman, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    let url, filename;
    const wallet = req.human.wallet_address;

    if (isR2Enabled) {
      try {
        // Upload to R2
        filename = generateFilename(req.file.originalname, wallet);
        url = await uploadToR2(req.file.buffer, filename, req.file.mimetype, 'portfolio', wallet);
      } catch (r2Error) {
        console.error('R2 upload failed, falling back to local storage:', r2Error.message);
        // Fallback to local disk storage
        const walletPrefix = wallet.toLowerCase().slice(0, 12);
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

    res.json({ success: true, url, filename, size: req.file.size, mimetype: req.file.mimetype });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Multi-file portfolio upload
app.post('/api/upload/portfolio/batch', requireHuman, upload.array('files', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  try {
    const results = [];
    const errors = [];
    const wallet = req.human.wallet_address;

    for (const file of req.files) {
      try {
        let url, filename;

        if (isR2Enabled) {
          try {
            // Upload to R2
            filename = generateFilename(file.originalname, wallet);
            url = await uploadToR2(file.buffer, filename, file.mimetype, 'portfolio', wallet);
          } catch (r2Error) {
            console.error('R2 upload failed, falling back to local storage:', r2Error.message);
            // Fallback to local disk storage
            const walletPrefix = wallet.toLowerCase().slice(0, 12);
            const ext = path.extname(file.originalname) || '.png';
            filename = `${walletPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
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

app.post('/api/upload/pfp', requireHuman, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    let url, filename;
    const wallet = req.human.wallet_address;

    if (isR2Enabled) {
      try {
        // Upload to R2
        filename = generateFilename(req.file.originalname, wallet);
        url = await uploadToR2(req.file.buffer, filename, req.file.mimetype, 'pfp', wallet);
      } catch (r2Error) {
        console.error('R2 upload failed, falling back to local storage:', r2Error.message);
        // Fallback to local disk storage
        const walletPrefix = wallet.toLowerCase().slice(0, 12);
        const ext = path.extname(req.file.originalname) || '.png';
        filename = `${walletPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
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

app.post('/api/upload/proof', requireHuman, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const wallet = req.human.wallet_address.toLowerCase();
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

app.get('/api/files/:wallet', requireHuman, (req, res) => {
  if (req.params.wallet.toLowerCase() !== req.human.wallet_address.toLowerCase()) {
    return res.status(403).json({ error: 'You can only list your own files' });
  }
  const wallet = req.human.wallet_address.toLowerCase().slice(0, 12);
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

app.delete('/api/files/:type/:filename', requireHuman, async (req, res) => {
  const { type, filename } = req.params;
  if (!['portfolio', 'pfp'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  if (path.basename(filename) !== filename) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const walletPrefix = req.human.wallet_address.toLowerCase().slice(0, 12);
  if (!filename.toLowerCase().startsWith(`${walletPrefix}-`)) {
    return res.status(403).json({ error: 'You can only delete your own files' });
  }

  try {
    if (isR2Enabled) {
      // Delete from R2
      const key = `${type}/${filename}`;
      await deleteFromR2(key, req.human.wallet_address);
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

// BYOK secret-at-rest encryption. Uses a dedicated ENCRYPTION_KEY (falls back to
// JWT_SECRET with a warning), a PER-RECORD random salt (static salt defeats
// scrypt), and no insecure 'default-secret' fallback.
function encryptionSecret() {
  const secret = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) throw new Error('No ENCRYPTION_KEY or JWT_SECRET configured for at-rest encryption');
  return secret;
}

function encryptApiKey(plaintext) {
  const salt = randomBytes(16);
  const key = scryptSync(encryptionSecret(), salt, 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag().toString('base64');
  return JSON.stringify({ encrypted, iv: iv.toString('base64'), authTag, salt: salt.toString('base64') });
}

function decryptApiKey(ciphertext) {
  const { encrypted, iv, authTag, salt } = JSON.parse(ciphertext);
  // Back-compat: legacy records were encrypted with the static 'salt' string.
  const saltBuf = salt ? Buffer.from(salt, 'base64') : Buffer.from('salt');
  const key = scryptSync(encryptionSecret(), saltBuf, 32);
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
// POST /api/agents/register-from-token — Cross-deployment recovery.
//
// When a JWT issued by one BARD deployment lands on another that doesn't
// have the agent row, every MCP tool fails with "Agent not found" (caught
// up-front by the tightened requireAgentId). This endpoint is the recovery
// path: validate the bearer token, read its claims (sub/agentName/wallet),
// and insert a matching agent row IF one doesn't exist for that id yet.
// Idempotent — calling twice returns the existing row.
//
// Auth: the Bearer token itself is the auth. We trust JWT_SECRET — any
// token that verifies was issued by us (whichever deployment shares the
// secret).
app.post('/api/agents/register-from-token', requireAuth, async (req, res) => {
  const auth = req.headers.authorization || '';
  const tokenStr = auth.replace(/^Bearer\s+/i, '');
  if (!tokenStr) return res.status(401).json({ error: 'Bearer token required in Authorization header' });

  let claims;
  try {
    claims = jwt.verify(tokenStr, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: `Invalid or expired token: ${err.message}` });
  }

  const agentId = claims.sub;
  const agentName = claims.agentName;
  const wallet = (claims.wallet || '').toLowerCase();
  if (!agentId || !agentName) {
    return res.status(400).json({ error: 'Token has no sub/agentName claim — re-auth and retry' });
  }

  // Idempotent: if the row already exists on THIS backend, just return it
  const existing = await stmts.getAgentById(agentId);
  if (existing) {
    return res.json({
      success: true,
      created: false,
      message: `Agent ${agentName} already exists on this backend`,
      agent: existing,
    });
  }

  // Name collision against a *different* agent already on this backend
  const nameCollision = await stmts.getAgentByName(agentName);
  if (nameCollision) {
    return res.status(409).json({
      error: `Cannot import agent "${agentName}" — another agent already owns that name on this backend.`,
    });
  }

  // Allow optional refinement of fields via body (agentType, description),
  // but the identity (id/name/wallet) comes from the JWT only.
  const agentType = (req.body?.agentType) || 'general';
  const description = (req.body?.description) || `Recovered from cross-deployment token`;

  try {
    await stmts.insertAgent({
      id: agentId,
      owner_wallet: wallet,
      agent_name: agentName,
      agent_public_key: wallet, // best-effort; full Turnkey wallet provisioning is a separate step
      agent_type: agentType,
      description,
      created_at: new Date().toISOString(),
    });
    const agent = await stmts.getAgentById(agentId);
    console.log(`[register-from-token] Created agent ${agentId} (${agentName}) from JWT claims`);
    return res.json({
      success: true,
      created: true,
      message: `Agent ${agentName} registered on this backend from your JWT claims. Run bard_create_wallet next to provision a Turnkey wallet here.`,
      agent,
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: `Cannot import agent "${agentName}" — another agent already owns that name on this backend.`,
      });
    }
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/agents/register', async (req, res) => {
  const { ownerWallet, agentName, agentPublicKey, agentType, description, swarmConfig, challengeId, signature } = req.body;
  if (!ownerWallet || !agentName || !agentPublicKey) {
    return res.status(400).json({ error: 'ownerWallet, agentName, and agentPublicKey required' });
  }

  // ── Sybil / impersonation gate ──
  // A real (non-zero) ownerWallet must be proven under the caller's control before
  // we mint a 7-day token bound to it — otherwise anyone could register an agent
  // "owned" by someone else's wallet. The Turnkey onboarding path registers with
  // the zero address (no wallet yet) and is exempt: its identity becomes the
  // platform-provisioned Turnkey wallet, which an attacker cannot forge.
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
  const claimsRealWallet = ownerWallet.toLowerCase() !== ZERO_ADDR;
  if (claimsRealWallet) {
    if (!challengeId || !signature) {
      return res.status(401).json({
        error: 'Registering with a real ownerWallet requires proof of control. POST /api/auth/challenge, sign the message, then include { challengeId, signature }.',
        hint: 'ownership_proof_required',
      });
    }
    const challenge = await stmts.getChallenge(challengeId);
    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });
    if (challenge.used) return res.status(409).json({ error: 'Challenge already used' });
    if (new Date(challenge.expires_at) < new Date()) return res.status(410).json({ error: 'Challenge expired. Request a new one.' });
    let ok = false;
    try {
      ok = await verifyMessage({ address: ownerWallet, message: challenge.message, signature });
    } catch { ok = false; }
    if (!ok) return res.status(401).json({ error: 'Signature does not prove control of ownerWallet' });
    await stmts.markChallengeUsed(challengeId);
    // REGISTRATION_STAKE hook: when > 0, additionally require an on-chain stake
    // before issuing a token (deferred — see plan). Currently informational only.
  }

  const nameCollision = await stmts.getAgentByName(agentName);
  if (nameCollision) {
    return res.status(409).json({ error: `Agent name "${agentName}" is taken — pick another.` });
  }

  const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const insertData = {
      id, owner_wallet: ownerWallet.toLowerCase(), agent_name: agentName,
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
      kind: 'agent',
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
    if (err.code === '23505') {
      return res.status(409).json({ error: `Agent name "${agentName}" is taken — pick another.` });
    }
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
app.patch('/api/agents/:id/specializations', requireAuth, requireOwnAgent, async (req, res) => {
  const { specializations } = req.body;
  if (!Array.isArray(specializations)) return res.status(400).json({ error: 'specializations must be an array' });
  const valid = ['research', 'code_review', 'data_analysis', 'content', 'verification', 'moderation', 'trading', 'other'];
  const filtered = specializations.filter(s => valid.includes(s));
  await pool.query('UPDATE agents SET specializations = $1 WHERE id = $2', [JSON.stringify(filtered), req.params.id]);
  res.json({ specializations: filtered });
});

// Update agent availability
app.patch('/api/agents/:id/availability', requireAuth, requireOwnAgent, async (req, res) => {
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

// Step 2: Authenticated human pastes the link token to claim the agent.
app.post('/api/human/agents/link', requireHuman, async (req, res) => {
  const linkToken = req.body?.linkToken;
  const ownerWallet = req.human.wallet_address;
  if (!linkToken) return res.status(400).json({ error: 'linkToken required' });

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

app.post('/api/agents/link', (_req, res) => {
  res.status(410).json({
    error: 'Agent linking now requires an authenticated BARD human session.',
    hint: 'Use POST /api/human/agents/link from the BARD frontend.',
  });
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

// ── Agent Turnkey Wallet Provisioning ──
app.post('/api/agents/:id/wallet', requireAuth, async (req, res) => {
  try {
    if (req.auth.agentId !== req.params.id) {
      return res.status(403).json({ error: 'Can only provision your own agent wallet' });
    }
    const agent = await stmts.getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    if (!walletSigningReady()) {
      return res.json({
        turnkeyEnabled: false,
        address: null,
        message: 'No wallet provider configured. Set WALLET_PROVIDER=local + WALLET_MASTER_KEY (self-hosted), or Turnkey API keys.',
      });
    }

    const wallet = await getOrCreateAgentWallet(pool, agent.id, agent.agent_name);
    // wallet can be: { walletId, address }, null (turnkey disabled), or { error, detail }
    if (wallet?.error) {
      // Turnkey API call failed — bubble the actual error up to the caller
      // instead of silently returning address:null (which the MCP wrapper
      // used to misreport as 'Turnkey not configured').
      return res.status(502).json({
        turnkeyEnabled: true,
        address: null,
        error: wallet.error,
        detail: wallet.detail,
        code: wallet.code,
      });
    }
    if (wallet?.address && agent.owner_wallet === '0x0000000000000000000000000000000000000000') {
      await pool.query('UPDATE agents SET owner_wallet = $1 WHERE id = $2', [wallet.address.toLowerCase(), agent.id]);
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

// GET /api/agents/:id/wallet-balance — Authenticated agent wallet balance
app.get('/api/agents/:id/wallet-balance', requireAuth, async (req, res) => {
  try {
    if (req.auth.agentId !== req.params.id) {
      return res.status(403).json({ error: 'Can only read your own agent wallet balance' });
    }
    const agent = await stmts.getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const walletAddress = agent.turnkey_address || agent.owner_wallet;
    if (!walletAddress || walletAddress === '0x0000000000000000000000000000000000000000') {
      return res.status(400).json({
        error: 'Agent has no managed wallet. Use bard_create_wallet first.',
        hint: 'wallet_missing',
      });
    }

    const [usdcRaw, nativeRaw] = await Promise.all([
      onchainEscrow.usdcBalance(walletAddress),
      onchainEscrow.nativeBalance(walletAddress),
    ]);

    res.json({
      agentId: agent.id,
      agentName: agent.agent_name,
      wallet: walletAddress,
      network: 'Arc Testnet',
      chainId: 5042002,
      balanceUsdc: formatUnits(usdcRaw, 6),
      nativeGasBalance: formatUnits(nativeRaw, 18),
      nativeGasBalanceWei: nativeRaw.toString(),
      token: USDC_CONTRACT_ADDRESS,
      explorer: `https://testnet.arcscan.app/address/${walletAddress}`,
    });
  } catch (err) {
    console.error('Agent wallet balance error:', err);
    res.status(502).json({ error: 'Wallet balance unavailable', details: err.message });
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

    // Arc Testnet quirk: USDC IS the native gas token. Circle's faucet rejects
    // `native:true` on ARC-TESTNET with 400 "native token is not supported".
    // Silently clamp to false so well-meaning agents that follow the generic
    // bard_claim_faucet description still succeed.
    let effectiveNative = native === true;
    if (chain === 'ARC-TESTNET' && effectiveNative) {
      console.log(`[Faucet] clamping native→false on ARC-TESTNET (agent ${agent.id})`);
      effectiveNative = false;
    }

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
        native: effectiveNative,
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
      native: effectiveNative,
      nativeClampedReason: (chain === 'ARC-TESTNET' && native === true) ? 'USDC is the native gas token on ARC-TESTNET — Circle does not support a separate native claim. Forced native:false.' : undefined,
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

    const { to: rawTo, toUsername, toAgentName, amount } = req.body;
    if (!amount) {
      return res.status(400).json({ error: 'Missing required field: amount (USDC string e.g. "1.00")' });
    }
    const recipientFields = [rawTo, toUsername, toAgentName].filter(Boolean);
    if (recipientFields.length === 0) {
      return res.status(400).json({ error: 'Missing recipient: provide one of `to` (0x address), `toUsername` (BARD profile username), or `toAgentName` (BARD agent name)' });
    }
    if (recipientFields.length > 1) {
      return res.status(400).json({ error: 'Provide only one of: `to`, `toUsername`, or `toAgentName`' });
    }

    // Resolve the recipient. Profiles.username is UNIQUE; agents.agent_name is
    // UNIQUE(LOWER(...)) as of the 2026-06-16 migration. Agents resolve to
    // their Turnkey wallet, falling back to owner_wallet.
    let resolvedTo;
    let resolvedAgent = null;
    if (toUsername) {
      const profile = await stmts.getProfileByUsername(toUsername);
      if (!profile || !profile.wallet) {
        return res.status(404).json({ error: `No BARD profile registered for username "${toUsername}"`, hint: 'profile_not_found' });
      }
      resolvedTo = profile.wallet.toLowerCase();
    } else if (toAgentName) {
      resolvedAgent = await stmts.getAgentByName(toAgentName);
      if (!resolvedAgent) {
        return res.status(404).json({ error: `No agent found with name "${toAgentName}"`, hint: 'agent_not_found' });
      }
      resolvedTo = resolvedAgent.turnkey_address || resolvedAgent.owner_wallet;
      if (!resolvedTo) {
        return res.status(400).json({ error: `Agent "${toAgentName}" has no payout wallet on file` });
      }
    } else {
      if (!/^0x[0-9a-fA-F]{40}$/.test(rawTo)) {
        return res.status(400).json({ error: 'Invalid recipient address' });
      }
      resolvedTo = rawTo;
    }

    // Parse amount (USDC has 6 decimals via ERC-20 interface)
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }
    if (parsedAmount > 100) {
      return res.status(400).json({ error: 'Max transfer: 100 USDC per transaction (testnet safety cap)' });
    }

    // Sign+send through the wallet provider (WALLET_PROVIDER=local|hybrid → self-hosted
    // keystore; turnkey → Turnkey) — the same abstraction the escrow engine uses, so
    // self-hosted agent wallets can transfer without Turnkey. Native gas (USDC on Arc)
    // is topped up from the platform wallet first.
    if (!walletSigningReady()) {
      return res.status(400).json({ error: 'No wallet provider configured. Cannot sign transactions.' });
    }
    const { encodeFunctionData } = await import('viem');

    const ARC_USDC = '0x3600000000000000000000000000000000000000';
    const amountWei = BigInt(Math.round(parsedAmount * 1_000_000)); // 6 decimals

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
      args: [resolvedTo, amountWei],
    });

    // Wrap with Arc Memo so the agent-initiated transfer carries reconciliation
    // context (which agent sent, to which BARD profile if any, amount).
    const wrapped = withMemo(
      { to: ARC_USDC, data },
      {
        memoId: MemoIds.PayoutAgent,
        memoData: {
          agentId: agent.id,
          agentName: agent.agent_name,
          fromWallet: walletAddress,
          toWallet: resolvedTo,
          toUsername: toUsername || null,
          amountUsd: parsedAmount,
        },
      },
    );

    // sendAs estimates and provisions the exact Arc gas requirement.
    const { txHash } = await onchainEscrow.sendAs(walletAddress, wrapped, `send-usdc:${agent.agent_name}`);

    const displayRecipient = toUsername
      ? `@${toUsername}`
      : resolvedAgent
        ? `${resolvedAgent.agent_name} (${resolvedTo.slice(0,6)}...${resolvedTo.slice(-4)})`
        : `${resolvedTo.slice(0,6)}...${resolvedTo.slice(-4)}`;
    console.log(`[Send USDC] ${agent.agent_name}: ${parsedAmount} USDC → ${displayRecipient} [memo:agent] | tx: ${txHash}`);

    // Update agent's last active
    await pool.query('UPDATE agents SET last_active_at = $1 WHERE id = $2', [Math.floor(Date.now() / 1000), agent.id]);
    emitFeedEvent('agent:send-usdc', {
      agentId: agent.id,
      agentName: agent.agent_name,
      to: resolvedTo,
      toUsername: toUsername || null,
      toAgentName: resolvedAgent?.agent_name || null,
      toAgentId: resolvedAgent?.id || null,
      amount: parsedAmount,
      txHash,
    });
    await createNotification({ agentId: agent.id, type: 'send', title: 'USDC Sent', message: `${agent.agent_name} sent ${parsedAmount} USDC to ${displayRecipient}.`, from: walletAddress, amount: String(parsedAmount) });
    await createNotification({ wallet: resolvedTo, type: 'send', title: 'USDC Received', message: `Received ${parsedAmount} USDC from agent ${agent.agent_name}.`, from: walletAddress, amount: String(parsedAmount) });

    res.json({
      success: true,
      from: walletAddress,
      to: resolvedTo,
      toUsername: toUsername || null,
      toAgentName: resolvedAgent?.agent_name || null,
      toAgentId: resolvedAgent?.id || null,
      amount: parsedAmount,
      token: ARC_USDC,
      chain: 'Arc Testnet',
      txHash,
      explorer: `https://testnet.arcscan.app/tx/${txHash}`,
    });
  } catch (err) {
    console.error('Send USDC error:', err);
    if (err.txHash) {
      return res.status(202).json({
        success: true,
        pending: true,
        txHash: err.txHash,
        explorer: `https://testnet.arcscan.app/tx/${err.txHash}`,
        message: 'Transaction was broadcast, but Arc RPC confirmation is pending. Check the transaction before retrying.',
        details: err.message,
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// ── Achswap DEX (Arc Testnet) ──
// Agents trade via the AchSwapAdapter contract directly, signed by their
// Turnkey wallet. Read tools (quote, token holders, tx history, token info)
// proxy Achswap's MCP — no key required for those. See backend/achswap.js for
// the function signatures and constants.
// ══════════════════════════════════════════════════════

// Module-level caches. quoteCache lets /dex/swap re-use a fresh quote within
// 60s instead of forcing the agent to round-trip. tokenInfoCache spares us a
// network hop for repeated symbol/decimals lookups.
const quoteCache = new Map();        // key = `${agentId}|${tokenIn}|${tokenOut}|${amountIn}` → { quote, ts }
const tokenInfoCache = new Map();    // key = address → { info, ts }
const QUOTE_TTL_MS = 60_000;
const TOKEN_INFO_TTL_MS = 60 * 60 * 1000;

// Look up the USDC-equivalent value of `amountIn` of `tokenIn` so we can enforce
// per-tx and per-day caps in stable units. tokenIn === NATIVE_TOKEN is treated
// as 1:1 USDC (it IS USDC on Arc).
async function priceInUsdc(tokenIn, amountIn) {
  if (tokenIn === NATIVE_TOKEN || tokenIn.toLowerCase() === NATIVE_TOKEN) {
    // amountIn is in 18-decimal native USDC units; return USDC integer.
    return Number(BigInt(amountIn) / 10n ** 18n);
  }
  try {
    const q = await achswapCall('quote_adapter', {
      token_in: tokenIn,
      token_out: NATIVE_TOKEN,
      amount_in: String(amountIn),
    });
    if (!q.expected_out) return null;
    return Number(BigInt(q.expected_out) / 10n ** 18n);
  } catch {
    return null;
  }
}

// POST /api/agents/:id/dex/quote — read-only proxy.
app.post('/api/agents/:id/dex/quote', requireAuth, async (req, res) => {
  try {
    if (req.auth.agentId !== req.params.id) {
      return res.status(403).json({ error: 'Can only quote from your own agent context' });
    }
    const { tokenIn, tokenOut, amountIn } = req.body || {};
    if (!tokenIn || !tokenOut || !amountIn) {
      return res.status(400).json({ error: 'Required: tokenIn, tokenOut, amountIn (decimal-aware integer string)' });
    }
    const inAddr = resolveToken(tokenIn);
    const outAddr = resolveToken(tokenOut);
    if (inAddr === outAddr) return res.status(400).json({ error: 'tokenIn and tokenOut must differ' });

    const quote = await achswapCall('quote_adapter', {
      token_in: inAddr,
      token_out: outAddr,
      amount_in: String(amountIn),
    });
    if (!quote.route_data || !quote.expected_out) {
      return res.status(502).json({ error: 'Achswap returned an empty route — likely no liquidity for this pair' });
    }
    // Cache for use by /dex/swap.
    const cacheKey = `${req.auth.agentId}|${inAddr}|${outAddr}|${amountIn}`;
    quoteCache.set(cacheKey, { quote, ts: Date.now() });

    res.json({
      success: true,
      tokenIn: inAddr,
      tokenOut: outAddr,
      amountIn: String(amountIn),
      expectedOut: quote.expected_out,
      expectedOutFormatted: quote.expected_out_formatted,
      route: quote.route,
      routeData: quote.route_data,
    });
  } catch (err) {
    console.error('Dex quote error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agents/:id/dex/swap — signs and broadcasts.
app.post('/api/agents/:id/dex/swap', requireAuth, async (req, res) => {
  try {
    if (req.auth.agentId !== req.params.id) {
      return res.status(403).json({ error: 'Can only swap from your own agent wallet' });
    }
    const agent = await stmts.getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const walletAddress = agent.turnkey_address;
    if (!walletAddress) {
      return res.status(400).json({ error: 'Agent has no Turnkey wallet. Use bard_create_wallet first.' });
    }

    const { tokenIn, tokenOut, amountIn, slippageBps } = req.body || {};
    if (!tokenIn || !tokenOut || !amountIn) {
      return res.status(400).json({ error: 'Required: tokenIn, tokenOut, amountIn' });
    }
    const slippage = Number.isFinite(slippageBps) ? Number(slippageBps) : 100;
    if (slippage < 0 || slippage > 500) {
      return res.status(400).json({ error: 'slippageBps must be 0–500 (max 5%)' });
    }
    const inAddr = resolveToken(tokenIn);
    const outAddr = resolveToken(tokenOut);
    if (inAddr === outAddr) return res.status(400).json({ error: 'tokenIn and tokenOut must differ' });

    // Per-tx cap: 50 USDC equivalent.
    const usdcValue = await priceInUsdc(inAddr, amountIn);
    if (usdcValue === null) {
      return res.status(400).json({ error: 'Could not price tokenIn in USDC — pair has no liquidity' });
    }
    if (usdcValue > 50) {
      return res.status(400).json({ error: `Per-tx cap: 50 USDC equivalent (got ~${usdcValue} USDC)` });
    }

    // Rate limit: 10/hr per agent.
    if (!(await checkRateLimit(req.params.id, 'dex_swap'))) {
      return res.status(429).json({ error: 'Swap rate limit: 10 per hour per agent' });
    }
    // Daily budget: 500 USDC equivalent rolling 24h.
    if (!(await checkRateLimitN(req.params.id, 'dex_swap_daily_usdc', Math.max(1, usdcValue)))) {
      return res.status(429).json({ error: 'Daily swap budget exhausted: 500 USDC equivalent per 24h per agent' });
    }

    // Fetch or reuse cached quote.
    const cacheKey = `${req.auth.agentId}|${inAddr}|${outAddr}|${amountIn}`;
    const cached = quoteCache.get(cacheKey);
    let quote;
    if (cached && Date.now() - cached.ts < QUOTE_TTL_MS) {
      quote = cached.quote;
    } else {
      quote = await achswapCall('quote_adapter', {
        token_in: inAddr,
        token_out: outAddr,
        amount_in: String(amountIn),
      });
      quoteCache.set(cacheKey, { quote, ts: Date.now() });
    }
    if (!quote.route_data || !quote.expected_out) {
      return res.status(502).json({ error: 'Achswap returned an empty route — no liquidity' });
    }
    const expectedOut = BigInt(quote.expected_out);
    const minOut = (expectedOut * BigInt(10000 - slippage)) / 10000n;
    const routeData = quote.route_data;

    // Sign+send via the wallet provider (self-hosted/hybrid = no Turnkey), the same
    // abstraction as /send-usdc and escrow. sendAs estimates and provisions gas for
    // each leg, waits for its receipt, and throws on revert.
    if (!walletSigningReady()) {
      return res.status(400).json({ error: 'No wallet provider configured. Cannot sign transactions.' });
    }
    const { encodeFunctionData, decodeEventLog } = await import('viem');

    // ERC-20 input → ensure adapter allowance.
    let approveTxHash = null;
    if (inAddr !== NATIVE_TOKEN) {
      const allowance = await arcTestnetClient.readContract({
        address: inAddr,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [walletAddress, ACHSWAP_ADAPTER],
      });
      if (BigInt(allowance) < BigInt(amountIn)) {
        const approveData = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [ACHSWAP_ADAPTER, MAX_UINT256],
        });
        // sendAs waits for the approve receipt before returning, preserving the
        // approve-before-swap ordering.
        ({ txHash: approveTxHash } = await onchainEscrow.sendAs(walletAddress, { to: inAddr, data: approveData }, `swap-approve:${agent.agent_name}`));
        console.log(`[Swap] ${agent.agent_name}: approved adapter to spend ${inAddr} | tx ${approveTxHash}`);
      }
    }

    // Build + send the swap (native-token input carries value).
    const swapData = encodeFunctionData({
      abi: ADAPTER_ABI,
      functionName: 'swap',
      args: [inAddr, outAddr, BigInt(amountIn), minOut, walletAddress, routeData],
    });
    const { txHash: swapTxHash, receipt } = await onchainEscrow.sendAs(
      walletAddress,
      { to: ACHSWAP_ADAPTER, data: swapData, value: inAddr === NATIVE_TOKEN ? BigInt(amountIn) : 0n },
      `swap:${agent.agent_name}`,
    );

    // Parse actualOut from a Transfer event whose `to` is the agent's wallet.
    let actualOut = null;
    for (const log of receipt.logs || []) {
      // Native-out swaps emit no ERC-20 Transfer; skip.
      if (outAddr === NATIVE_TOKEN) break;
      if (log.address.toLowerCase() !== outAddr.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: ERC20_ABI, data: log.data, topics: log.topics });
        if (decoded.eventName === 'Transfer' &&
            decoded.args.to.toLowerCase() === walletAddress.toLowerCase()) {
          actualOut = String(decoded.args.value);
        }
      } catch { /* not a Transfer log */ }
    }

    console.log(`[Swap] ${agent.agent_name}: ${amountIn} ${inAddr.slice(0,6)} → ${actualOut || '?'} ${outAddr.slice(0,6)} | tx ${swapTxHash}`);

    await pool.query('UPDATE agents SET last_active_at = $1 WHERE id = $2', [Math.floor(Date.now() / 1000), agent.id]);
    emitFeedEvent('agent:dex-swap', {
      agentId: agent.id,
      agentName: agent.agent_name,
      tokenIn: inAddr,
      tokenOut: outAddr,
      amountIn: String(amountIn),
      actualOut,
      route: quote.route,
      txHash: swapTxHash,
    });
    await createNotification({
      agentId: agent.id,
      type: 'swap',
      title: 'DEX Swap',
      message: `${agent.agent_name} swapped ${amountIn} ${tokenIn} → ${actualOut || '?'} ${tokenOut}.`,
      from: walletAddress,
      amount: String(amountIn),
    });

    res.json({
      success: true,
      from: walletAddress,
      tokenIn: inAddr,
      tokenOut: outAddr,
      amountIn: String(amountIn),
      minOut: String(minOut),
      actualOut,
      slippageBps: slippage,
      route: quote.route,
      approveTxHash,
      swapTxHash,
      explorer: `https://testnet.arcscan.app/tx/${swapTxHash}`,
    });
  } catch (err) {
    console.error('Dex swap error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agents/:id/dex/token-holders — proxy.
app.post('/api/agents/:id/dex/token-holders', requireAuth, async (req, res) => {
  try {
    if (req.auth.agentId !== req.params.id) return res.status(403).json({ error: 'Wrong agent context' });
    const { tokenAddress, limit } = req.body || {};
    if (!tokenAddress) return res.status(400).json({ error: 'tokenAddress required' });
    const addr = resolveToken(tokenAddress);
    const data = await achswapCall('get_token_holders', { token_address: addr, limit: limit || 25 });
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agents/:id/dex/tx-history — proxy.
app.post('/api/agents/:id/dex/tx-history', requireAuth, async (req, res) => {
  try {
    if (req.auth.agentId !== req.params.id) return res.status(403).json({ error: 'Wrong agent context' });
    const agent = await stmts.getAgentById(req.params.id);
    const { address, limit } = req.body || {};
    const target = address || agent?.turnkey_address;
    if (!target) return res.status(400).json({ error: 'address required (or agent must have a Turnkey wallet)' });
    const data = await achswapCall('get_transaction_history', { address: target, limit: limit || 10 });
    res.json({ success: true, address: target, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agents/:id/dex/token-info — direct ERC-20 reads, 1h cache.
// (Achswap's get_token_info MCP tool requires X-Private-Key which BARD agents
// don't have, so we just hit the contract directly.)
app.post('/api/agents/:id/dex/token-info', requireAuth, async (req, res) => {
  try {
    if (req.auth.agentId !== req.params.id) return res.status(403).json({ error: 'Wrong agent context' });
    const { tokenAddress } = req.body || {};
    if (!tokenAddress) return res.status(400).json({ error: 'tokenAddress required' });
    const addr = resolveToken(tokenAddress);

    // Native USDC sentinel: hard-coded answer (Arc Testnet convention).
    if (addr === NATIVE_TOKEN) {
      return res.json({ success: true, cached: false, address: addr,
                        symbol: 'USDC', name: 'USD Coin (native)', decimals: 18 });
    }

    const cached = tokenInfoCache.get(addr);
    if (cached && Date.now() - cached.ts < TOKEN_INFO_TTL_MS) {
      return res.json({ success: true, cached: true, ...cached.info });
    }
    const [symbol, decimals, name] = await Promise.all([
      arcTestnetClient.readContract({ address: addr, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => null),
      arcTestnetClient.readContract({ address: addr, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => null),
      arcTestnetClient.readContract({ address: addr, abi: ERC20_ABI, functionName: 'name' }).catch(() => null),
    ]);
    if (symbol === null && decimals === null) {
      return res.status(404).json({ error: `No ERC-20 contract at ${addr} (or it doesn't implement symbol/decimals)` });
    }
    const info = { address: addr, symbol, decimals: decimals !== null ? Number(decimals) : null, name };
    tokenInfoCache.set(addr, { info, ts: Date.now() });
    res.json({ success: true, cached: false, ...info });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Agent ERC-8004 Identity Mint (agent-side) ──
// Agent calls this to mint ERC-8004 identity via Turnkey wallet.
// If Turnkey is configured, it signs and sends the tx on-chain.
// Otherwise, it records the intent for external signing.
app.post('/api/agents/:id/mint-identity', requireAuth, async (req, res) => {
  try {
    if (req.auth.agentId !== req.params.id) {
      return res.status(403).json({ error: 'Can only mint identity for your own agent' });
    }
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
app.post('/api/contributions/:id/agent-verify', requireAuth, async (req, res) => {
  // Verifier is the authenticated agent — never trust a body-supplied id.
  const verifierAgentId = req.auth.agentId;
  const { result, reasoning, signature: clientSignature } = req.body;
  if (!result) {
    return res.status(400).json({ error: 'result required' });
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

  // Real attestation over (verifier, contribution, result).
  let signature, signerAddress;
  try {
    const message = canonicalVerificationMessage({ verifierAgentId, contributionId: req.params.id, result });
    const att = await attestAgentMessage({ agent: verifier, message, providedSignature: clientSignature });
    signature = att.signature;
    signerAddress = att.signer;
  } catch (sigErr) {
    return res.status(400).json({ error: `Attestation failed: ${sigErr.message}`, hint: 'signature_required' });
  }

  const vId = `averify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const reasoningHash = reasoning ? '0x' + createHash('sha256').update(reasoning).digest('hex') : '';

  await pool.query(
    `INSERT INTO agent_verifications (id, contribution_id, verifier_agent_id, result, reasoning, reasoning_hash, signature, signer_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [vId, req.params.id, verifierAgentId, result, reasoning || '', reasoningHash, signature, signerAddress]
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

app.post('/api/contributions', requireAuth, async (req, res) => {
  // Actor is the authenticated agent — never trust a body-supplied agentId.
  const agentId = req.auth.agentId;
  const { type, description, proofHash, proofData, signature: clientSignature } = req.body;
  if (!type || !proofHash) {
    return res.status(400).json({ error: 'type and proofHash required' });
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

  // Real attestation: the agent signs a canonical message over (agent, type, proofHash).
  // Turnkey agents are signed server-side; manual-key agents may pass their own signature.
  let signature, signer_address;
  try {
    const message = canonicalContributionMessage({ agentId, type, proofHash });
    const att = await attestAgentMessage({ agent, message, providedSignature: clientSignature });
    signature = att.signature;
    signer_address = att.signer;
  } catch (sigErr) {
    return res.status(400).json({ error: `Attestation failed: ${sigErr.message}`, hint: 'signature_required' });
  }

  const id = `contrib-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await stmts.insertContribution({
      id, agent_id: agentId, type, description: description || '',
      proof_hash: proofHash, proof_data: JSON.stringify(proofData || {}),
      signature, signer_address, created_at: new Date().toISOString(),
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

async function recordHumanContributionEndorsement({ contributionId, wallet, comment }) {
  const contribution = await stmts.getContributionById(contributionId);
  if (!contribution) {
    throw Object.assign(new Error('Contribution not found'), { status: 404 });
  }
  if (contribution.status !== 'pending') {
    throw Object.assign(
      new Error(`Cannot endorse a ${contribution.status} contribution`),
      { status: 409 }
    );
  }

  const endorserWallet = wallet.toLowerCase();
  const id = `endorse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await stmts.insertEndorsement({
      id,
      contribution_id: contributionId,
      endorser_wallet: endorserWallet,
      endorser_type: 'human',
      comment: String(comment || '').slice(0, 500),
      signature: '',
      created_at: new Date().toISOString(),
    });
    await stmts.incrementEndorsementCount(contributionId);

    // Auto-verify: requires 5 human endorsements AND at least 1 agent approval
    const humanCount = Number((await pool.query(
      `SELECT COUNT(*) AS count
         FROM endorsements
        WHERE contribution_id = $1 AND endorser_type = 'human'`,
      [contributionId]
    )).rows[0].count);
    const agentApprovals = (await pool.query(
      "SELECT COUNT(*) as c FROM agent_verifications WHERE contribution_id = $1 AND result = 'approved'",
      [contributionId]
    )).rows[0];
    const nowVerified = humanCount >= 5 && Number(agentApprovals.c) >= 1;
    if (nowVerified) {
      const transitioned = await pool.query(
        "UPDATE contributions SET status = 'verified' WHERE id = $1 AND status = 'pending' RETURNING id",
        [contributionId]
      );
      if (transitioned.rows[0]) {
        // Auto-record on-chain mirror
        const contentHash = '0x' + createHash('sha256').update(contributionId + contribution.proof_hash).digest('hex');
        const recordId = `record-${Date.now()}`;
        await stmts.insertRecord({
          id: recordId,
          contribution_id: contributionId,
          agent_id: contribution.agent_id,
          content_hash: contentHash,
          tx_hash: '',
          recorded_at: new Date().toISOString(),
        });
        emitFeedEvent('contribution:verified', { contributionId, contentHash });
      }
    }

    // Recalculate agent reputation
    const reputation = await calculateReputation(contribution.agent_id);
    const saved = await stmts.getContributionById(contributionId);

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
    emitFeedEvent('endorsement:new', { contributionId, endorserWallet, endorsementCount: humanCount });
    // Notify the contribution owner they got endorsed
    if (contribution.agent_id) {
      await createNotification({ agentId: contribution.agent_id, type: 'vouch', title: 'Endorsement Received', message: `Your contribution was endorsed by ${endorserWallet.slice(0,6)}...${endorserWallet.slice(-4)}. (${humanCount} total)`, from: endorserWallet });
    }
    return {
      success: true,
      endorsementCount: humanCount,
      agentApprovals: Number(agentApprovals.c),
      status: saved?.status || contribution.status,
      reputation,
    };
  } catch (err) {
    if (err.message?.includes('UNIQUE') || err.code === '23505') {
      throw Object.assign(new Error('Already endorsed this contribution'), { status: 409 });
    }
    throw err;
  }
}

// Human endorsements are bound to the authenticated BARD account's managed
// wallet. Body-supplied wallet addresses are intentionally ignored.
app.post('/api/contributions/:id/endorse', requireHuman, async (req, res) => {
  try {
    res.json(await recordHumanContributionEndorsement({
      contributionId: req.params.id,
      wallet: req.human.wallet_address,
      comment: req.body?.comment,
    }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Legacy human endorsement alias. Agent verification exclusively uses the
// authenticated /agent-verify endpoint and its 2-of-N consensus rules.
app.post('/api/contributions/:id/verify', requireHuman, async (req, res) => {
  try {
    const result = await recordHumanContributionEndorsement({
      contributionId: req.params.id,
      wallet: req.human.wallet_address,
      comment: req.body?.comment,
    });
    res.json({
      ...result,
      endorsements: result.endorsementCount,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
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
app.get('/api/agents/:id/state', requireAuth, requireOwnAgent, async (req, res) => {
  const state = await stmts.getAgentState(req.params.id);
  res.json({ state: state ? { agentId: state.agent_id, context: JSON.parse(state.context || '{}'), updatedAt: state.updated_at } : null });
});

app.put('/api/agents/:id/state', requireAuth, requireOwnAgent, async (req, res) => {
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
app.post('/api/commitments', requireAuth, async (req, res) => {
  const agentId = req.auth.agentId;
  const { commitmentHash, salt } = req.body;
  if (!commitmentHash || !salt) {
    return res.status(400).json({ error: 'commitmentHash and salt required' });
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
app.post('/api/commitments/:id/reveal', requireAuth, async (req, res) => {
  const { reasoning, salt } = req.body;
  if (!reasoning || !salt) return res.status(400).json({ error: 'reasoning and salt required' });

  const commitment = await stmts.getCommitmentById(req.params.id);
  if (!commitment) return res.status(404).json({ error: 'Commitment not found' });
  if (commitment.agent_id !== req.auth.agentId) {
    return res.status(403).json({ error: 'You can only reveal your own commitments' });
  }
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

// POST /api/bounties — authenticated agent creates a bounty from its managed wallet.
// First-come funding is money-first: the listing is not published until the USDC
// transfer confirms. Proposal bounties remain unfunded until a proposal is selected.
app.post('/api/bounties', requireAuth, async (req, res) => {
  let bounty = null;
  try {
    const creator = await stmts.getAgentById(req.auth.agentId);
    if (!creator) return res.status(404).json({ error: 'Agent not found' });
    if (!creator.turnkey_address) {
      return res.status(409).json({
        error: 'Create a managed wallet before posting a bounty.',
        action_required: 'create_wallet',
      });
    }

    const input = normalizeBountyInput(req.body);
    const creatorWallet = creator.turnkey_address;
    bounty = await insertManagedBounty(
      creatorWallet,
      input,
      input.selectionMode === 'proposal' ? 'proposal_open' : 'funding',
      input.selectionMode === 'proposal' ? 'none' : 'funding'
    );

    if (input.selectionMode === 'proposal') {
      emitFeedEvent('bounty:created', bounty);
      await createNotification({
        agentId: creator.id,
        type: 'system',
        title: 'Bounty Created',
        message: `Your bounty "${input.title}" is now accepting proposals.`,
        from: 'BARD System',
      });
      return res.json({ success: true, funded: false, bounty });
    }

    const transfer = await fundManagedEscrow(
      creatorWallet,
      SELLER_ADDRESS,
      input.amountUsdc
    );
    let fundedBounty;
    try {
      fundedBounty = await finalizeCustodialBountyFunding({
        bounty,
        creatorWallet,
        amountUsdc: input.amountUsdc,
        txHash: transfer.txHash,
        actorType: 'agent',
      });
    } catch (error) {
      if (!error.txHash) error.txHash = transfer.txHash;
      throw error;
    }

    emitFeedEvent('bounty:created', fundedBounty);
    emitFeedEvent('escrow:funded', {
      bountyId: fundedBounty.id,
      budgetUsdc: input.amountUsdc,
      mode: 'custodial',
    });
    await createNotification({
      agentId: creator.id,
      type: 'system',
      title: 'Bounty Funded',
      message: `Your bounty "${input.title}" is live with ${input.amountUsdc} USDC in escrow.`,
      from: 'BARD System',
      amount: String(input.amountUsdc),
    });
    return res.json({
      success: true,
      funded: true,
      txHash: transfer.txHash,
      explorer: `https://testnet.arcscan.app/tx/${transfer.txHash}`,
      bounty: fundedBounty,
    });
  } catch (error) {
    if (bounty && bounty.status === 'funding' && !error.txHash) {
      await pool.query(
        `DELETE FROM bounties
          WHERE id = $1 AND status = 'funding' AND escrow_status IN ('none', 'funding')`,
        [bounty.id]
      ).catch(() => {});
    }
    return res.status(error.status || 502).json({
      error: error.message,
      bountyId: bounty?.id || null,
      txHash: error.txHash || null,
      recoverable: Boolean(error.txHash),
    });
  }
});

// GET /api/bounties — list bounties
app.get('/api/bounties', async (req, res) => {
  const status = req.query.status;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  // `status` accepts a single value ("open") OR a comma-separated list
  // ("open,proposal_open") so the CLI/MCP can list every claimable bounty
  // in one round-trip. Before, only the first state was queryable, which
  // hid every proposal-mode bounty from `bard bounties` / similar tools.
  let bounties;
  if (status && status.includes(',')) {
    const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
    bounties = await stmts.getOpenBountiesIn(statuses, limit);
  } else if (status) {
    bounties = await stmts.getOpenBounties(status, limit);
  } else {
    bounties = await stmts.getAllBounties();
  }
  res.json({ bounties });
});

// GET /api/bounties/:id
app.get('/api/bounties/:id', async (req, res) => {
  const bounty = await stmts.getBountyById(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  res.json({ bounty });
});

// Legacy metadata-only assignment is disabled. Agents must authenticate and claim
// through the escrow route, which requires confirmed funding.
app.post('/api/bounties/:id/accept', (_req, res) => {
  res.status(410).json({
    error: 'This endpoint has been replaced by POST /api/bounties/:id/claim',
    hint: 'Authenticate as the agent and claim a funded bounty.',
  });
});

// Legacy metadata-only submission is disabled. Deliverables must pass through
// the authenticated escrow workflow.
app.post('/api/bounties/:id/submit', (_req, res) => {
  res.status(410).json({
    error: 'This endpoint has been replaced by POST /api/bounties/:id/deliver',
    hint: 'Use bard_submit_deliverable through BARD MCP.',
  });
});

// POST /api/bounties/:id/cancel — authenticated agent creator cancels before work.
// Funded first-come bounties are refunded because no provider has claimed them yet.
app.post('/api/bounties/:id/cancel', requireAuth, async (req, res) => {
  try {
    const creator = await stmts.getAgentById(req.auth.agentId);
    if (!creator) return res.status(404).json({ error: 'Agent not found' });
    const bounty = await stmts.getBountyById(req.params.id);
    if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
    if (!agentControlsBounty(creator, bounty)) {
      return res.status(403).json({ error: 'Only the bounty creator can cancel it' });
    }

    if (
      (bounty.status === 'open' && ['funded', 'refunding'].includes(bounty.escrow_status)) ||
      (bounty.status === 'cancelled' && bounty.escrow_status === 'refunded')
    ) {
      const result = await refundUnclaimedCustodialBounty({
        bounty,
        creatorWallet: creator.turnkey_address || bounty.creator_wallet,
        actorType: 'agent',
        suppliedTxHash: req.body?.txHash,
      });
      return res.json({ success: true, ...result });
    }

    const result = await cancelUnfundedBounty({
      bountyId: bounty.id,
      creatorWallet: bounty.creator_wallet,
      actorType: 'agent',
    });
    return res.json({ success: true, refunded: result.refunded });
  } catch (error) {
    return res.status(error.status || 502).json({
      error: error.message,
      txHash: error.txHash || null,
      recoverable: Boolean(error.recoverable || error.txHash),
    });
  }
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

async function runBestEffort(label, operation) {
  try {
    return await operation();
  } catch (error) {
    console.warn(`[Noncritical] ${label} failed: ${error.message}`);
    return null;
  }
}

async function recordBountyFundingTransaction(db, {
  txHash,
  bountyId,
  funderWallet,
  amountUsdc,
}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '')) {
    throw Object.assign(new Error('Valid funding transaction hash required'), { status: 400 });
  }
  const normalizedHash = txHash.toLowerCase();
  const legacyUse = (await db.query(
    `SELECT id
       FROM bounties
      WHERE LOWER(COALESCE(escrow_tx_hash, '')) = $1 AND id <> $2
      LIMIT 1`,
    [normalizedHash, bountyId]
  )).rows[0];
  if (legacyUse) {
    throw Object.assign(
      new Error(`Funding transaction is already assigned to bounty ${legacyUse.id}`),
      { status: 409 }
    );
  }

  const inserted = await db.query(
    `INSERT INTO bounty_funding_transactions
       (tx_hash, bounty_id, funder_wallet, amount_usdc, created_at)
     VALUES ($1, $2, LOWER($3), $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING bounty_id`,
    [normalizedHash, bountyId, funderWallet, amountUsdc, new Date().toISOString()]
  );
  if (inserted.rows[0]) return;

  const [existingByHash, existingByBounty] = await Promise.all([
    db.query(
      'SELECT bounty_id FROM bounty_funding_transactions WHERE tx_hash = $1',
      [normalizedHash]
    ),
    db.query(
      'SELECT tx_hash FROM bounty_funding_transactions WHERE bounty_id = $1',
      [bountyId]
    ),
  ]);
  const existing = existingByHash.rows[0];
  if (existing?.bounty_id === bountyId) return;
  if (existing) {
    throw Object.assign(
      new Error(`Funding transaction is already assigned to bounty ${existing.bounty_id}`),
      { status: 409 }
    );
  }
  if (existingByBounty.rows[0]) {
    throw Object.assign(
      new Error(`Bounty is already assigned funding transaction ${existingByBounty.rows[0].tx_hash}`),
      { status: 409 }
    );
  }
  throw Object.assign(new Error('Funding transaction reservation failed'), { status: 409 });
}

async function recordBountyRefundTransaction(db, {
  txHash,
  bountyId,
  recipientWallet,
  amountUsdc,
}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '')) {
    throw Object.assign(new Error('Valid refund transaction hash required'), { status: 400 });
  }
  const normalizedHash = txHash.toLowerCase();
  const conflictingUse = (await db.query(
    `SELECT bounty_id, 'funding' AS use_type
       FROM bounty_funding_transactions
      WHERE tx_hash = $1
      UNION ALL
     SELECT id AS bounty_id, 'release' AS use_type
       FROM bounties
      WHERE LOWER(COALESCE(release_tx_hash, '')) = $1
      LIMIT 1`,
    [normalizedHash]
  )).rows[0];
  if (conflictingUse) {
    throw Object.assign(
      new Error(
        `Transaction is already assigned as ${conflictingUse.use_type} for bounty ${conflictingUse.bounty_id}`
      ),
      { status: 409 }
    );
  }

  const inserted = await db.query(
    `INSERT INTO bounty_refund_transactions
       (tx_hash, bounty_id, recipient_wallet, amount_usdc, created_at)
     VALUES ($1, $2, LOWER($3), $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING bounty_id`,
    [normalizedHash, bountyId, recipientWallet, amountUsdc, new Date().toISOString()]
  );
  if (inserted.rows[0]) return;

  const [existingByHash, existingByBounty] = await Promise.all([
    db.query(
      'SELECT bounty_id FROM bounty_refund_transactions WHERE tx_hash = $1',
      [normalizedHash]
    ),
    db.query(
      'SELECT tx_hash FROM bounty_refund_transactions WHERE bounty_id = $1',
      [bountyId]
    ),
  ]);
  const existing = existingByHash.rows[0];
  if (existing?.bounty_id === bountyId) return;
  if (existing) {
    throw Object.assign(
      new Error(`Refund transaction is already assigned to bounty ${existing.bounty_id}`),
      { status: 409 }
    );
  }
  if (existingByBounty.rows[0]) {
    throw Object.assign(
      new Error(`Bounty is already assigned refund transaction ${existingByBounty.rows[0].tx_hash}`),
      { status: 409 }
    );
  }
  throw Object.assign(new Error('Refund transaction reservation failed'), { status: 409 });
}

const BOUNTY_TYPES = ['research', 'code_review', 'data_analysis', 'content', 'verification', 'other'];

function normalizeBountyInput(body = {}) {
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  const bountyType = String(body.bountyType || '');
  const selectionMode = body.selectionMode === 'proposal' ? 'proposal' : 'first_come';
  const amountUsdc = Number(body.amountUsdc);
  const deadlineMs = Date.parse(body.deadline);
  const proposalDeadlineMs = body.proposalDeadline ? Date.parse(body.proposalDeadline) : null;
  const minReputation = Math.max(0, Math.min(100, Number.parseInt(body.minReputation, 10) || 0));

  if (!title || title.length > 200) {
    throw Object.assign(new Error('Bounty title must be 1-200 characters'), { status: 400 });
  }
  if (description.length > 10_000) {
    throw Object.assign(new Error('Bounty description must be 10,000 characters or less'), { status: 400 });
  }
  if (!BOUNTY_TYPES.includes(bountyType)) {
    throw Object.assign(new Error(`Invalid bounty type. Must be: ${BOUNTY_TYPES.join(', ')}`), { status: 400 });
  }
  if (!Number.isFinite(amountUsdc) || amountUsdc < 1 || amountUsdc > 10_000) {
    throw Object.assign(new Error('Bounty amount must be between 1 and 10,000 USDC'), { status: 400 });
  }
  if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) {
    throw Object.assign(new Error('Bounty deadline must be in the future'), { status: 400 });
  }
  if (proposalDeadlineMs !== null) {
    if (!Number.isFinite(proposalDeadlineMs) || proposalDeadlineMs <= Date.now()) {
      throw Object.assign(new Error('Proposal deadline must be in the future'), { status: 400 });
    }
    if (proposalDeadlineMs >= deadlineMs) {
      throw Object.assign(new Error('Proposal deadline must be before the bounty deadline'), { status: 400 });
    }
  }

  return {
    title,
    description,
    bountyType,
    amountUsdc,
    deadline: new Date(deadlineMs).toISOString(),
    minReputation,
    selectionMode,
    proposalDeadline: selectionMode === 'proposal' && proposalDeadlineMs !== null
      ? new Date(proposalDeadlineMs).toISOString()
      : null,
  };
}

async function insertManagedBounty(wallet, input, status, escrowStatus = 'none') {
  const id = `bounty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  await stmts.insertBounty({
    id,
    creator_wallet: wallet,
    title: input.title,
    description: input.description,
    bounty_type: input.bountyType,
    amount_usdc: String(input.amountUsdc),
    deadline: input.deadline,
    min_reputation: input.minReputation,
    created_at: now,
    updated_at: now,
    status,
    selection_mode: input.selectionMode,
    proposal_deadline: input.proposalDeadline,
    escrow_status: escrowStatus,
  });
  return stmts.getBountyById(id);
}

async function finalizeCustodialBountyFunding({
  bounty,
  creatorWallet,
  amountUsdc,
  txHash,
  selectedAgent = null,
  actorType = 'human',
}) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fresh = (await client.query(
      'SELECT * FROM bounties WHERE id = $1 FOR UPDATE',
      [bounty.id]
    )).rows[0];
    if (!fresh || fresh.escrow_status !== 'funding') {
      throw Object.assign(
        new Error(`Bounty funding reservation was lost (state: ${fresh?.escrow_status || 'missing'})`),
        { status: 409 }
      );
    }
    await recordBountyFundingTransaction(client, {
      txHash,
      bountyId: bounty.id,
      funderWallet: creatorWallet,
      amountUsdc,
    });

    if (fresh.selection_mode === 'proposal') {
      if (
        fresh.status !== 'proposal_selected' ||
        !fresh.selected_proposal_id ||
        !selectedAgent
      ) {
        throw Object.assign(new Error('Selected proposal is no longer fundable'), { status: 409 });
      }
      if (!selectedAgent.turnkey_address) {
        throw Object.assign(new Error('Selected agent has no managed payment wallet'), { status: 409 });
      }
      const providerWallet = selectedAgent.turnkey_address;
      await client.query(
        `UPDATE bounties
            SET escrow_mode = 'custodial',
                escrow_status = 'claimed',
                status = 'assigned',
                escrow_budget_usdc = $1,
                escrow_tx_hash = $2,
                provider_agent_id = $3,
                provider_wallet = $4,
                expires_at = $5,
                claimed_at = $6,
                updated_at = $6
          WHERE id = $7`,
        [amountUsdc, txHash, selectedAgent.id, providerWallet, expiresAt, now, bounty.id]
      );
      await client.query(
        `INSERT INTO escrow_events
           (id, bounty_id, event_type, actor_wallet, actor_type, details, tx_hash, created_at)
         VALUES ($1, $2, 'claimed', $3, 'agent', $4, '', $5)`,
        [
          `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-c`,
          bounty.id,
          selectedAgent.turnkey_address,
          `Auto-claimed by ${selectedAgent.agent_name} after proposal funding`,
          now,
        ]
      );
    } else {
      await client.query(
        `UPDATE bounties
            SET status = 'open',
                escrow_mode = 'custodial',
                escrow_status = 'funded',
                escrow_budget_usdc = $1,
                escrow_tx_hash = $2,
                expires_at = $3,
                updated_at = $4
          WHERE id = $5`,
        [amountUsdc, txHash, expiresAt, now, bounty.id]
      );
    }

    await client.query(
      `INSERT INTO escrow_events
         (id, bounty_id, event_type, actor_wallet, actor_type, details, tx_hash, created_at)
       VALUES ($1, $2, 'funded', $3, $4, $5, $6, $7)`,
      [
        `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        bounty.id,
        creatorWallet,
        actorType,
        `${amountUsdc} USDC transferred to BARD escrow`,
        txHash,
        now,
      ]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return stmts.getBountyById(bounty.id);
}

async function getSelectedProposalAgent(bounty) {
  if (bounty.selection_mode !== 'proposal') return null;
  const proposal = await stmts.getProposalById(bounty.selected_proposal_id);
  if (!proposal || proposal.status !== 'accepted') {
    throw Object.assign(new Error('Selected proposal is no longer valid'), { status: 409 });
  }
  const selectedAgent = await stmts.getAgentById(proposal.proposer_agent_id);
  if (!selectedAgent) {
    throw Object.assign(new Error('Selected proposer agent not found'), { status: 404 });
  }
  if (!selectedAgent.turnkey_address) {
    throw Object.assign(
      new Error('Selected agent has no managed payment wallet'),
      { status: 409 }
    );
  }
  return selectedAgent;
}

async function reserveBountyFunding(bountyId) {
  const reserved = await pool.query(
    `UPDATE bounties
        SET escrow_status = 'funding', updated_at = $1
      WHERE id = $2
        AND escrow_status = 'none'
        AND (
          (selection_mode = 'proposal' AND status = 'proposal_selected')
          OR
          (selection_mode <> 'proposal' AND status = 'open')
        )
      RETURNING *`,
    [new Date().toISOString(), bountyId]
  );
  if (!reserved.rows[0]) {
    throw Object.assign(
      new Error('Bounty funding is already in progress or the bounty is no longer fundable'),
      { status: 409 }
    );
  }
  return reserved.rows[0];
}

async function transferAndFundCustodialBounty(bounty, creatorWallet, actorType = 'human') {
  if (bounty.creator_wallet.toLowerCase() !== creatorWallet.toLowerCase()) {
    throw Object.assign(new Error('Only the bounty creator can fund it'), { status: 403 });
  }
  if (bounty.escrow_status !== 'none') {
    throw Object.assign(
      new Error(`Bounty is already in escrow state: ${bounty.escrow_status}`),
      { status: 409 }
    );
  }
  if (bounty.selection_mode === 'proposal' && (
    bounty.status !== 'proposal_selected' ||
    !bounty.selected_proposal_id
  )) {
    throw Object.assign(new Error('Select a proposal before funding this bounty'), { status: 409 });
  }
  if (bounty.selection_mode !== 'proposal' && bounty.status !== 'open') {
    throw Object.assign(new Error(`Bounty cannot be funded in status: ${bounty.status}`), { status: 409 });
  }

  const selectedAgent = await getSelectedProposalAgent(bounty);
  await reserveBountyFunding(bounty.id);

  const amountUsdc = Number(bounty.amount_usdc);
  let transfer = null;
  try {
    transfer = await fundManagedEscrow(creatorWallet, SELLER_ADDRESS, amountUsdc);
    const fundedBounty = await finalizeCustodialBountyFunding({
      bounty,
      creatorWallet,
      amountUsdc,
      txHash: transfer.txHash,
      selectedAgent,
      actorType,
    });
    return { bounty: fundedBounty, txHash: transfer.txHash, selectedAgent };
  } catch (error) {
    if (transfer?.txHash && !error.txHash) error.txHash = transfer.txHash;
    if (!error.txHash) {
      await pool.query(
        `UPDATE bounties
            SET escrow_status = 'none', updated_at = $1
          WHERE id = $2 AND escrow_status = 'funding'`,
        [new Date().toISOString(), bounty.id]
      ).catch(() => {});
    }
    throw error;
  }
}

async function prepareExternalBountyFunding(bounty, creatorWallet) {
  if (bounty.creator_wallet.toLowerCase() !== creatorWallet.toLowerCase()) {
    throw Object.assign(new Error('Only the bounty creator can fund it'), { status: 403 });
  }
  if (bounty.escrow_status !== 'none') {
    throw Object.assign(
      new Error(`Bounty is already in escrow state: ${bounty.escrow_status}`),
      { status: 409 }
    );
  }
  if (bounty.selection_mode === 'proposal' && (
    bounty.status !== 'proposal_selected' ||
    !bounty.selected_proposal_id
  )) {
    throw Object.assign(new Error('Select a proposal before funding this bounty'), { status: 409 });
  }
  if (bounty.selection_mode !== 'proposal' && bounty.status !== 'open') {
    throw Object.assign(new Error(`Bounty cannot be funded in status: ${bounty.status}`), { status: 409 });
  }

  await getSelectedProposalAgent(bounty);
  await reserveBountyFunding(bounty.id);
  try {
    return await prepareHumanUsdcTransfer(
      creatorWallet,
      SELLER_ADDRESS,
      Number(bounty.amount_usdc),
      { maxAmount: 10_000 }
    );
  } catch (error) {
    await pool.query(
      `UPDATE bounties
          SET escrow_status = 'none', updated_at = $1
        WHERE id = $2 AND escrow_status = 'funding'`,
      [new Date().toISOString(), bounty.id]
    ).catch(() => {});
    throw error;
  }
}

function agentControlsBounty(agent, bounty) {
  const creator = (bounty.creator_wallet || '').toLowerCase();
  return [agent?.turnkey_address, agent?.owner_wallet]
    .filter(Boolean)
    .some((wallet) => wallet.toLowerCase() === creator);
}

async function cancelUnfundedBounty({
  bountyId,
  creatorWallet,
  actorType,
}) {
  const client = await pool.connect();
  let bounty;
  let rejected = [];
  try {
    await client.query('BEGIN');
    bounty = (await client.query(
      'SELECT * FROM bounties WHERE id = $1 FOR UPDATE',
      [bountyId]
    )).rows[0];
    if (!bounty) {
      throw Object.assign(new Error('Bounty not found'), { status: 404 });
    }
    if (bounty.creator_wallet.toLowerCase() !== creatorWallet.toLowerCase()) {
      throw Object.assign(new Error('Only the bounty creator can cancel it'), { status: 403 });
    }
    if (!['open', 'proposal_open', 'proposal_selected'].includes(bounty.status)) {
      throw Object.assign(
        new Error('Cannot cancel a bounty after an agent has started work'),
        { status: 409 }
      );
    }
    if (bounty.escrow_status !== 'none') {
      throw Object.assign(
        new Error(`Cannot cancel bounty in escrow state: ${bounty.escrow_status}`),
        { status: 409 }
      );
    }

    const now = new Date().toISOString();
    await client.query(
      `UPDATE bounties SET status = 'cancelled', updated_at = $1 WHERE id = $2`,
      [now, bountyId]
    );
    ({ rows: rejected } = await client.query(
      `UPDATE bounty_proposals
          SET status = 'rejected',
              rejected_at = $1,
              rejection_reason = 'Bounty cancelled by creator',
              updated_at = $1
        WHERE bounty_id = $2 AND status IN ('pending', 'accepted')
        RETURNING proposer_agent_id`,
      [now, bountyId]
    ));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  await runBestEffort(
    `cancel event for bounty ${bountyId}`,
    () => logEscrowEvent(
      bountyId,
      'cancelled',
      creatorWallet,
      actorType,
      'Creator cancelled bounty before work started',
      ''
    )
  );
  for (const proposal of rejected) {
    await runBestEffort(
      `cancel notification for proposal agent ${proposal.proposer_agent_id}`,
      () => createNotification({
        agentId: proposal.proposer_agent_id,
        type: 'system',
        title: 'Bounty Cancelled',
        message: `The bounty "${bounty.title}" was cancelled. Your proposal is no longer active.`,
        from: creatorWallet,
      })
    );
  }
  try {
    emitFeedEvent('bounty:cancelled', { bountyId, refunded: false });
  } catch (error) {
    console.warn(`[Noncritical] cancel feed event for bounty ${bountyId} failed: ${error.message}`);
  }
  return { bounty, refunded: false };
}

async function getCustodialRefundDetails(bounty, creatorWallet) {
  const funding = (await pool.query(
    'SELECT funder_wallet FROM bounty_funding_transactions WHERE bounty_id = $1',
    [bounty.id]
  )).rows[0];
  const refundWallet = funding?.funder_wallet || creatorWallet;
  const amountUsdc = Number(bounty.escrow_budget_usdc || bounty.amount_usdc);
  if (!/^0x[0-9a-fA-F]{40}$/.test(refundWallet || '')) {
    throw Object.assign(new Error('Recorded funding wallet is invalid'), { status: 409 });
  }
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
    throw Object.assign(new Error('Recorded escrow amount is invalid'), { status: 409 });
  }
  return { refundWallet, amountUsdc };
}

async function finalizeCustodialBountyRefund({
  bountyId,
  creatorWallet,
  actorType,
  refundWallet,
  amountUsdc,
  txHash,
}) {
  const client = await pool.connect();
  let finalizedBounty;
  let alreadyFinalized = false;
  try {
    await client.query('BEGIN');
    const fresh = (await client.query(
      'SELECT * FROM bounties WHERE id = $1 FOR UPDATE',
      [bountyId]
    )).rows[0];
    if (!fresh) {
      throw Object.assign(new Error('Bounty not found'), { status: 404 });
    }

    const recordedRefund = (await client.query(
      'SELECT * FROM bounty_refund_transactions WHERE bounty_id = $1',
      [bountyId]
    )).rows[0];
    if (fresh.status === 'cancelled' && fresh.escrow_status === 'refunded') {
      const recordedHash = recordedRefund?.tx_hash || fresh.refund_tx_hash;
      if (recordedHash?.toLowerCase() !== txHash.toLowerCase()) {
        throw Object.assign(
          new Error(`Bounty was already refunded by transaction ${recordedHash || 'unknown'}`),
          { status: 409 }
        );
      }
      finalizedBounty = fresh;
      alreadyFinalized = true;
      await client.query('COMMIT');
    } else {
      if (fresh.status !== 'open' || fresh.escrow_status !== 'refunding') {
        throw Object.assign(
          new Error(`Bounty refund cannot be finalized from ${fresh.status}/${fresh.escrow_status}`),
          { status: 409 }
        );
      }

      await recordBountyRefundTransaction(client, {
        txHash,
        bountyId,
        recipientWallet: refundWallet,
        amountUsdc,
      });
      const now = new Date().toISOString();
      finalizedBounty = (await client.query(
        `UPDATE bounties
            SET refund_tx_hash = $1,
                escrow_status = 'refunded',
                status = 'cancelled',
                updated_at = $2
          WHERE id = $3 AND status = 'open' AND escrow_status = 'refunding'
          RETURNING *`,
        [txHash.toLowerCase(), now, bountyId]
      )).rows[0];
      if (!finalizedBounty) {
        throw Object.assign(new Error('Bounty refund reservation was lost'), { status: 409 });
      }
      await client.query(
        `INSERT INTO escrow_events
           (id, bounty_id, event_type, actor_wallet, actor_type, details, tx_hash, created_at)
         VALUES ($1, $2, 'refunded', $3, $4, $5, $6, $7)`,
        [
          `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          bountyId,
          creatorWallet,
          actorType,
          `${amountUsdc} USDC refunded after creator cancellation`,
          txHash.toLowerCase(),
          now,
        ]
      );
      await client.query('COMMIT');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  if (!alreadyFinalized) {
    await runBestEffort(
      `refund notification for bounty ${bountyId}`,
      () => createNotification({
        wallet: refundWallet,
        type: 'send',
        title: 'Bounty Refunded',
        message: `${amountUsdc} USDC was returned after the bounty was cancelled.`,
        from: 'BARD System',
        amount: String(amountUsdc),
      })
    );
    try {
      emitFeedEvent('bounty:cancelled', { bountyId, refunded: true });
    } catch (error) {
      console.warn(`[Noncritical] refund feed event for bounty ${bountyId} failed: ${error.message}`);
    }
  }

  return {
    bounty: finalizedBounty,
    refunded: true,
    reconciled: alreadyFinalized,
    txHash: txHash.toLowerCase(),
    refundWallet,
  };
}

async function refundUnclaimedCustodialBounty({
  bounty,
  creatorWallet,
  actorType,
  suppliedTxHash = '',
}) {
  const current = await stmts.getBountyById(bounty.id);
  if (!current) {
    throw Object.assign(new Error('Bounty not found'), { status: 404 });
  }
  if (
    !(
      current.status === 'open' &&
      ['funded', 'refunding'].includes(current.escrow_status)
    ) &&
    !(current.status === 'cancelled' && current.escrow_status === 'refunded')
  ) {
    throw Object.assign(
      new Error('Only a funded, unclaimed first-come bounty can be refunded'),
      { status: 409 }
    );
  }
  if (current.escrow_mode === 'onchain') {
    throw Object.assign(
      new Error('On-chain bounty cancellation requires the escrow dispute flow'),
      { status: 409 }
    );
  }

  const { refundWallet, amountUsdc } = await getCustodialRefundDetails(
    current,
    creatorWallet
  );
  const recordedRefund = (await pool.query(
    'SELECT tx_hash FROM bounty_refund_transactions WHERE bounty_id = $1',
    [current.id]
  )).rows[0];
  let refundTxHash = String(
    suppliedTxHash || current.refund_tx_hash || recordedRefund?.tx_hash || ''
  );

  if (current.status === 'cancelled' && current.escrow_status === 'refunded') {
    if (!refundTxHash) {
      throw Object.assign(new Error('Refunded bounty is missing its transaction record'), {
        status: 409,
      });
    }
    return finalizeCustodialBountyRefund({
      bountyId: current.id,
      creatorWallet,
      actorType,
      refundWallet,
      amountUsdc,
      txHash: refundTxHash,
    });
  }

  const startedInRefunding = current.escrow_status === 'refunding';
  if (!startedInRefunding) {
    const reserved = await pool.query(
      `UPDATE bounties
          SET escrow_status = 'refunding', updated_at = $1
        WHERE id = $2 AND status = 'open' AND escrow_status = 'funded'
        RETURNING *`,
      [new Date().toISOString(), current.id]
    );
    if (!reserved.rows[0]) {
      throw Object.assign(new Error('Bounty refund is already in progress'), { status: 409 });
    }
  }

  if (refundTxHash) {
    const verification = await verifyTransaction(
      refundTxHash,
      SELLER_ADDRESS,
      refundWallet,
      amountUsdc,
      { allowWrappedCall: true }
    );
    if (!verification.valid) {
      if (!startedInRefunding) {
        await pool.query(
          `UPDATE bounties
              SET escrow_status = 'funded', refund_tx_hash = NULL, updated_at = $1
            WHERE id = $2 AND status = 'open' AND escrow_status = 'refunding'`,
          [new Date().toISOString(), current.id]
        ).catch(() => {});
      }
      throw Object.assign(
        new Error(`Refund transaction is not confirmed or does not match this bounty: ${verification.error}`),
        {
          status: 409,
          txHash: refundTxHash,
          recoverable: startedInRefunding,
        }
      );
    }
    return finalizeCustodialBountyRefund({
      bountyId: current.id,
      creatorWallet,
      actorType,
      refundWallet,
      amountUsdc,
      txHash: refundTxHash,
    });
  }

  if (startedInRefunding) {
    throw Object.assign(
      new Error('Refund is awaiting transaction reconciliation. Retry with the original txHash.'),
      { status: 409, recoverable: true }
    );
  }

  try {
    refundTxHash = await transferUSDCFromPlatform(refundWallet, amountUsdc, {
      memoId: MemoIds.PayoutRefund,
      memoData: `creator-cancel:${bounty.id}`,
    });
    return await finalizeCustodialBountyRefund({
      bountyId: current.id,
      creatorWallet,
      actorType,
      refundWallet,
      amountUsdc,
      txHash: refundTxHash,
    });
  } catch (error) {
    if (refundTxHash && !error.txHash) error.txHash = refundTxHash;
    if (error.txHash) {
      error.status = error.status || 409;
      error.recoverable = true;
      await pool.query(
        `UPDATE bounties
            SET refund_tx_hash = $1, updated_at = $2
          WHERE id = $3 AND status = 'open' AND escrow_status = 'refunding'`,
        [error.txHash.toLowerCase(), new Date().toISOString(), current.id]
      ).catch(() => {});
    } else {
      await pool.query(
        `UPDATE bounties
            SET escrow_status = 'funded', updated_at = $1
          WHERE id = $2 AND status = 'open' AND escrow_status = 'refunding'`,
        [new Date().toISOString(), current.id]
      ).catch(() => {});
    }
    throw error;
  }
}

// Managed humans create and operate bounties through their BARD wallet. First-come
// bounties transfer funds before becoming visible; proposal bounties fund only after
// the creator selects a proposal and therefore knows the final price.
app.post('/api/human/bounties', requireHuman, async (req, res) => {
  let bounty = null;
  let externalRecoveryTxHash = '';
  try {
    const input = normalizeBountyInput(req.body);
    const creatorWallet = req.human.wallet_address;
    if (
      humanUsesExternalWallet(req) &&
      input.selectionMode !== 'proposal'
    ) {
      const transaction = buildHumanUsdcTransfer(
        SELLER_ADDRESS,
        input.amountUsdc,
        { maxAmount: 10_000 }
      );
      const suppliedTxHash = String(req.body?.txHash || '');
      if (suppliedTxHash) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(suppliedTxHash)) {
          return res.status(400).json({ error: 'Valid funding txHash required' });
        }
        externalRecoveryTxHash = suppliedTxHash;
        const existingFunding = (await pool.query(
          `SELECT b.*
             FROM bounty_funding_transactions f
             JOIN bounties b ON b.id = f.bounty_id
            WHERE LOWER(f.tx_hash) = LOWER($1)
            LIMIT 1`,
          [suppliedTxHash]
        )).rows[0];
        if (existingFunding) {
          return res.json({
            success: true,
            funded: true,
            txHash: suppliedTxHash.toLowerCase(),
            explorer: `https://testnet.arcscan.app/tx/${suppliedTxHash}`,
            bounty: existingFunding,
          });
        }
      } else {
        await prepareHumanUsdcTransfer(
          creatorWallet,
          SELLER_ADDRESS,
          input.amountUsdc,
          { maxAmount: 10_000 }
        );
        bounty = await insertManagedBounty(creatorWallet, input, 'funding', 'funding');
        return res.status(202).json({
          signatureRequired: true,
          walletType: 'external',
          bountyId: bounty.id,
          transaction: externalTransactionPayload(transaction),
        });
      }

      bounty = await insertManagedBounty(creatorWallet, input, 'funding', 'funding');
      return res.status(409).json({
        error: 'Funding transaction requires reconciliation against the reserved bounty',
        recoverable: true,
        bountyId: bounty.id,
        txHash: suppliedTxHash.toLowerCase(),
      });
    }

    bounty = await insertManagedBounty(
      creatorWallet,
      input,
      input.selectionMode === 'proposal' ? 'proposal_open' : 'funding',
      input.selectionMode === 'proposal' ? 'none' : 'funding'
    );

    if (input.selectionMode === 'proposal') {
      emitFeedEvent('bounty:created', bounty);
      await createNotification({
        wallet: creatorWallet,
        type: 'system',
        title: 'Bounty Created',
        message: `Your bounty "${input.title}" is now accepting proposals.`,
        from: 'BARD System',
      });
      return res.json({ success: true, funded: false, bounty });
    }

    const transfer = await fundManagedEscrow(creatorWallet, SELLER_ADDRESS, input.amountUsdc);
    let fundedBounty;
    try {
      fundedBounty = await finalizeCustodialBountyFunding({
        bounty,
        creatorWallet,
        amountUsdc: input.amountUsdc,
        txHash: transfer.txHash,
      });
    } catch (error) {
      if (!error.txHash) error.txHash = transfer.txHash;
      throw error;
    }

    emitFeedEvent('bounty:created', fundedBounty);
    emitFeedEvent('escrow:funded', {
      bountyId: fundedBounty.id,
      budgetUsdc: input.amountUsdc,
      mode: 'custodial',
    });
    await createNotification({
      wallet: creatorWallet,
      type: 'system',
      title: 'Bounty Funded',
      message: `Your bounty "${input.title}" is live with ${input.amountUsdc} USDC in escrow.`,
      from: 'BARD System',
      amount: String(input.amountUsdc),
    });
    return res.json({
      success: true,
      funded: true,
      txHash: transfer.txHash,
      explorer: `https://testnet.arcscan.app/tx/${transfer.txHash}`,
      bounty: fundedBounty,
    });
  } catch (error) {
    if (externalRecoveryTxHash && !error.txHash) {
      error.txHash = externalRecoveryTxHash;
    }
    if (bounty && bounty.status === 'funding' && !error.txHash) {
      await pool.query(
        `DELETE FROM bounties
          WHERE id = $1 AND status = 'funding' AND escrow_status IN ('none', 'funding')`,
        [bounty.id]
      ).catch(() => {});
    }
    return res.status(error.status || 502).json({
      error: error.message,
      bountyId: bounty?.id || null,
      txHash: error.txHash || null,
      recoverable: Boolean(error.txHash),
    });
  }
});

app.post('/api/human/bounties/:id/fund', requireHuman, async (req, res) => {
  try {
    const bounty = await stmts.getBountyById(req.params.id);
    if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
    if (humanUsesExternalWallet(req)) {
      const transaction = await prepareExternalBountyFunding(
        bounty,
        req.human.wallet_address
      );
      return res.status(202).json({
        signatureRequired: true,
        walletType: 'external',
        bountyId: bounty.id,
        transaction: externalTransactionPayload(transaction),
      });
    }
    const result = await transferAndFundCustodialBounty(bounty, req.human.wallet_address);
    emitFeedEvent('escrow:funded', {
      bountyId: bounty.id,
      budgetUsdc: bounty.amount_usdc,
      mode: 'custodial',
    });
    if (result.selectedAgent) {
      emitFeedEvent('escrow:claimed', {
        bountyId: bounty.id,
        agentId: result.selectedAgent.id,
        agentName: result.selectedAgent.agent_name,
      });
      await createNotification({
        agentId: result.selectedAgent.id,
        type: 'system',
        title: 'Bounty Funded - You Can Start',
        message: `"${bounty.title}" is funded with ${bounty.amount_usdc} USDC. Begin work and submit your deliverable.`,
        from: req.human.wallet_address,
      });
    }
    return res.json({
      success: true,
      txHash: result.txHash,
      explorer: `https://testnet.arcscan.app/tx/${result.txHash}`,
      bounty: result.bounty,
    });
  } catch (error) {
    return res.status(error.status || 502).json({
      error: error.message,
      txHash: error.txHash || null,
      recoverable: Boolean(error.txHash),
    });
  }
});

app.post('/api/human/bounties/:id/fund/abort', requireHuman, async (req, res) => {
  try {
    const bounty = await stmts.getBountyById(req.params.id);
    if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
    if (bounty.creator_wallet.toLowerCase() !== req.human.wallet_address.toLowerCase()) {
      return res.status(403).json({ error: 'Only the bounty creator can abort funding' });
    }
    const recorded = (await pool.query(
      'SELECT 1 FROM bounty_funding_transactions WHERE bounty_id = $1 LIMIT 1',
      [bounty.id]
    )).rows[0];
    if (recorded) {
      return res.status(409).json({ error: 'Funding is already confirmed and cannot be aborted' });
    }
    // The server cannot prove that the browser did not broadcast the prepared
    // transaction before calling abort. Keep the hidden reservation so a late
    // transaction hash can always be reconciled instead of orphaning funds.
    res.json({
      success: true,
      retained: bounty.escrow_status === 'funding',
      message: 'Funding reservation retained for safe retry or reconciliation',
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post('/api/human/bounties/:id/fund/reconcile', requireHuman, async (req, res) => {
  try {
    const txHash = String(req.body?.txHash || '');
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return res.status(400).json({ error: 'Valid funding txHash required' });
    }
    const bounty = await stmts.getBountyById(req.params.id);
    if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
    const creatorWallet = req.human.wallet_address;
    if (bounty.creator_wallet.toLowerCase() !== creatorWallet.toLowerCase()) {
      return res.status(403).json({ error: 'Only the bounty creator can reconcile funding' });
    }
    if (bounty.escrow_status !== 'funding') {
      return res.status(409).json({
        error: `Bounty is not awaiting funding reconciliation (state: ${bounty.escrow_status})`,
      });
    }

    const amountUsdc = Number(bounty.amount_usdc);
    const expectedTransaction = buildHumanUsdcTransfer(
      SELLER_ADDRESS,
      amountUsdc,
      { maxAmount: 10_000 }
    );
    const verification = await verifyExactExternalTransaction(
      txHash,
      creatorWallet,
      expectedTransaction.to,
      expectedTransaction.data
    );
    if (!verification.valid) {
      return res.status(409).json({
        error: 'Funding transaction is not confirmed yet',
        details: verification.error,
        txHash,
      });
    }

    let selectedAgent = null;
    if (bounty.selection_mode === 'proposal') {
      const proposal = await stmts.getProposalById(bounty.selected_proposal_id);
      if (!proposal || proposal.status !== 'accepted') {
        return res.status(409).json({ error: 'Selected proposal is no longer valid' });
      }
      selectedAgent = await stmts.getAgentById(proposal.proposer_agent_id);
      if (!selectedAgent) return res.status(404).json({ error: 'Selected proposer agent not found' });
    }

    const fundedBounty = await finalizeCustodialBountyFunding({
      bounty,
      creatorWallet,
      amountUsdc,
      txHash,
      selectedAgent,
    });
    if (bounty.selection_mode !== 'proposal') {
      emitFeedEvent('bounty:created', fundedBounty);
      await createNotification({
        wallet: creatorWallet,
        type: 'system',
        title: 'Bounty Funded',
        message: `Your bounty "${bounty.title}" is live with ${amountUsdc} USDC in escrow.`,
        from: 'BARD System',
        amount: String(amountUsdc),
      });
    } else if (selectedAgent) {
      emitFeedEvent('escrow:claimed', {
        bountyId: bounty.id,
        agentId: selectedAgent.id,
        agentName: selectedAgent.agent_name,
      });
      await createNotification({
        agentId: selectedAgent.id,
        type: 'system',
        title: 'Bounty Funded - You Can Start',
        message: `"${bounty.title}" is funded with ${amountUsdc} USDC. Begin work and submit your deliverable.`,
        from: creatorWallet,
      });
    }
    emitFeedEvent('escrow:funded', {
      bountyId: bounty.id,
      budgetUsdc: amountUsdc,
      mode: 'custodial',
      reconciled: true,
    });
    return res.json({ success: true, reconciled: true, txHash, bounty: fundedBounty });
  } catch (error) {
    return res.status(error.status || 502).json({
      error: error.message,
      txHash: req.body?.txHash || null,
    });
  }
});

app.post('/api/human/bounties/:id/proposals/:proposalId/accept', requireHuman, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bounty = (await client.query(
      'SELECT * FROM bounties WHERE id = $1 FOR UPDATE',
      [req.params.id]
    )).rows[0];
    if (!bounty) throw Object.assign(new Error('Bounty not found'), { status: 404 });
    if (bounty.creator_wallet.toLowerCase() !== req.human.wallet_address.toLowerCase()) {
      throw Object.assign(new Error('Only the bounty creator can accept proposals'), { status: 403 });
    }
    if (bounty.selection_mode !== 'proposal' || bounty.status !== 'proposal_open') {
      throw Object.assign(
        new Error(`Bounty is not accepting proposal selections (status: ${bounty.status})`),
        { status: 409 }
      );
    }

    const proposal = (await client.query(
      'SELECT * FROM bounty_proposals WHERE id = $1 FOR UPDATE',
      [req.params.proposalId]
    )).rows[0];
    if (!proposal) throw Object.assign(new Error('Proposal not found'), { status: 404 });
    if (proposal.bounty_id !== bounty.id) {
      throw Object.assign(new Error('Proposal does not belong to this bounty'), { status: 400 });
    }
    if (proposal.status !== 'pending') {
      throw Object.assign(
        new Error(`Cannot accept proposal in status: ${proposal.status}`),
        { status: 409 }
      );
    }

    const agent = (await client.query(
      'SELECT * FROM agents WHERE id = $1',
      [proposal.proposer_agent_id]
    )).rows[0];
    if (!agent?.turnkey_address) {
      throw Object.assign(new Error('Selected agent has no managed payment wallet'), { status: 409 });
    }

    const now = new Date().toISOString();
    const acceptedPrice = Number(proposal.proposed_price_usdc);
    await client.query(
      `UPDATE bounty_proposals
          SET status = 'accepted', accepted_at = $1, updated_at = $1
        WHERE id = $2`,
      [now, proposal.id]
    );
    const { rows: others } = await client.query(
      `UPDATE bounty_proposals
          SET status = 'rejected',
              rejected_at = $1,
              rejection_reason = 'Another proposal was selected',
              updated_at = $1
        WHERE bounty_id = $2 AND status = 'pending' AND id <> $3
        RETURNING proposer_agent_id`,
      [now, bounty.id, proposal.id]
    );
    await client.query(
      `UPDATE bounties
          SET selected_proposal_id = $1,
              status = 'proposal_selected',
              amount_usdc = $2,
              updated_at = $3
        WHERE id = $4`,
      [proposal.id, String(acceptedPrice), now, bounty.id]
    );
    await client.query('COMMIT');

    await logEscrowEvent(
      bounty.id,
      'proposal_accepted',
      req.human.wallet_address,
      'human',
      `Proposal ${proposal.id} accepted at ${acceptedPrice} USDC`,
      ''
    );
    await createNotification({
      agentId: proposal.proposer_agent_id,
      type: 'system',
      title: 'Proposal Accepted',
      message: `Your proposal for "${bounty.title}" was accepted. The creator is funding it now.`,
      from: req.human.wallet_address,
    });
    for (const other of others) {
      await createNotification({
        agentId: other.proposer_agent_id,
        type: 'system',
        title: 'Proposal Not Selected',
        message: `Your proposal for "${bounty.title}" was not selected.`,
        from: req.human.wallet_address,
      });
    }
    emitFeedEvent('proposal:accepted', { bountyId: bounty.id, proposalId: proposal.id });
    return res.json({
      success: true,
      bounty: await stmts.getBountyById(bounty.id),
      acceptedProposalId: proposal.id,
      rejectedProposalCount: others.length,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(error.status || 500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.post('/api/human/bounties/:id/proposals/:proposalId/reject', requireHuman, async (req, res) => {
  try {
    const bounty = await stmts.getBountyById(req.params.id);
    if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
    if (bounty.creator_wallet.toLowerCase() !== req.human.wallet_address.toLowerCase()) {
      return res.status(403).json({ error: 'Only the bounty creator can reject proposals' });
    }
    if (bounty.status !== 'proposal_open') {
      return res.status(409).json({ error: `Cannot reject proposals in status: ${bounty.status}` });
    }
    const proposal = await stmts.getProposalById(req.params.proposalId);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    if (proposal.bounty_id !== bounty.id) {
      return res.status(400).json({ error: 'Proposal does not belong to this bounty' });
    }
    if (proposal.status !== 'pending') {
      return res.status(409).json({ error: `Cannot reject proposal in status: ${proposal.status}` });
    }

    const reason = String(req.body?.reason || '').trim().slice(0, 1000);
    await stmts.rejectProposal({
      id: proposal.id,
      rejected_at: new Date().toISOString(),
      rejection_reason: reason,
    });
    await createNotification({
      agentId: proposal.proposer_agent_id,
      type: 'system',
      title: 'Proposal Rejected',
      message: reason
        ? `Your proposal for "${bounty.title}" was rejected: ${reason}`
        : `Your proposal for "${bounty.title}" was rejected.`,
      from: req.human.wallet_address,
    });
    return res.json({ success: true });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
});

app.post('/api/human/bounties/:id/cancel', requireHuman, async (req, res) => {
  try {
    const bounty = await stmts.getBountyById(req.params.id);
    if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
    const creatorWallet = req.human.wallet_address;
    if (bounty.creator_wallet.toLowerCase() !== creatorWallet.toLowerCase()) {
      return res.status(403).json({ error: 'Only the bounty creator can cancel it' });
    }

    if (
      (bounty.status === 'open' && ['funded', 'refunding'].includes(bounty.escrow_status)) ||
      (bounty.status === 'cancelled' && bounty.escrow_status === 'refunded')
    ) {
      const result = await refundUnclaimedCustodialBounty({
        bounty,
        creatorWallet,
        actorType: 'human',
        suppliedTxHash: req.body?.txHash,
      });
      return res.json({ success: true, ...result });
    }

    const result = await cancelUnfundedBounty({
      bountyId: bounty.id,
      creatorWallet,
      actorType: 'human',
    });
    return res.json({ success: true, refunded: result.refunded });
  } catch (error) {
    return res.status(error.status || 502).json({
      error: error.message,
      txHash: error.txHash || null,
      recoverable: Boolean(error.recoverable || error.txHash),
    });
  }
});

// ── On-chain escrow eligibility ──
// A wallet can back an on-chain escrow leg only if the platform Turnkey org can
// sign for it — i.e. it's the turnkey_address of some agent in our DB. Returns
// the checksummed address if signable, else null.
async function resolveTurnkeyWallet(address) {
  if (!address) return null;
  const { rows } = await pool.query(
    'SELECT turnkey_address FROM agents WHERE LOWER(turnkey_address) = LOWER($1) LIMIT 1',
    [address]
  );
  return rows[0]?.turnkey_address || null;
}

// Whether the server can sign on agents' behalf at all (any wallet provider).
// On-chain escrow needs server-side signing of creator/provider legs; that's
// satisfied by Turnkey OR the self-hosted local provider (WALLET_MASTER_KEY).
function walletSigningReady() {
  const mode = (process.env.WALLET_PROVIDER || 'turnkey').toLowerCase();
  if (mode === 'local') return !!process.env.WALLET_MASTER_KEY;
  if (mode === 'hybrid') return !!process.env.WALLET_MASTER_KEY || isTurnkeyEnabled();
  return isTurnkeyEnabled();
}

// Decide whether a proposal-mode bounty + its selected agent can run on-chain.
// Requires the gate ON, a signer available, the provider to hold a managed wallet,
// and the creator wallet to be server-signable (server signs the creator legs).
async function onchainEscrowEligible(bounty, selectedAgent) {
  if (!ONCHAIN_ESCROW || !walletSigningReady()) return { eligible: false };
  if (!selectedAgent?.turnkey_address) return { eligible: false, reason: 'provider has no managed wallet' };
  const creatorTk = await resolveTurnkeyWallet(bounty.creator_wallet);
  if (!creatorTk) return { eligible: false, reason: 'creator wallet is not server-signable' };
  return { eligible: true, creatorWallet: creatorTk, providerWallet: selectedAgent.turnkey_address };
}

async function fundSelectedProposalOnchain(
  bounty,
  selectedAgent,
  eligibility,
  { resumeJobId = null, fundTxHash = null } = {}
) {
  if (bounty.escrow_status === 'none') {
    await reserveBountyFunding(bounty.id);
  } else if (bounty.escrow_status !== 'funding') {
    throw Object.assign(
      new Error(`Bounty cannot resume funding in escrow state: ${bounty.escrow_status}`),
      { status: 409 }
    );
  }

  const amountUsdc = Number(bounty.amount_usdc);
  const platformFeeBps = Math.max(
    0,
    Math.min(10_000, Number.parseInt(process.env.PLATFORM_FEE_BPS || '0', 10) || 0)
  );
  const platformFeeUsdc = platformFeeBps > 0
    ? Math.floor(amountUsdc * platformFeeBps / 10_000 * 1e6) / 1e6
    : 0;

  let jobId;
  let txs;
  try {
    const fundingInput = {
      creatorWallet: eligibility.creatorWallet,
      providerWallet: eligibility.providerWallet,
      earningsUsdc: amountUsdc,
      platformFeeUsdc,
      maxFeeBps: platformFeeBps,
      evaluator: SELLER_ADDRESS,
      expirySeconds: 72 * 3600,
      description: bounty.title || 'BARD bounty',
    };
    ({ jobId, txs } = resumeJobId
      ? await onchainEscrow.resumeAndFund({
          ...fundingInput,
          jobId: resumeJobId,
          fundTxHash,
        })
      : await onchainEscrow.openAndFund(fundingInput));
  } catch (error) {
    const fundedTx = error.completedTransactions?.fund;
    const partialJobId = error.jobId || resumeJobId;
    if (partialJobId) {
      if (fundedTx) error.txHash = fundedTx;
      error.recoverable = true;
      await pool.query(
        `UPDATE bounties
            SET escrow_mode = 'onchain',
                onchain_job_id = $1,
                escrow_status = 'funding',
                updated_at = $2
          WHERE id = $3 AND status = 'proposal_selected'`,
        [String(partialJobId), new Date().toISOString(), bounty.id]
      ).catch(() => {});
      await runBestEffort(
        `partial on-chain funding event for bounty ${bounty.id}`,
        () => logEscrowEvent(
          bounty.id,
          'funding_partial',
          eligibility.creatorWallet,
          'agent',
          `On-chain job ${partialJobId} partially configured; retry funding with this job ID. Completed: ${Object.keys(error.completedTransactions || {}).join(', ') || 'createJob only'}`,
          fundedTx || ''
        )
      );
    } else {
      await pool.query(
        `UPDATE bounties
            SET escrow_status = 'none',
                escrow_mode = 'custodial',
                onchain_job_id = NULL,
                updated_at = $1
          WHERE id = $2 AND escrow_status = 'funding'`,
        [new Date().toISOString(), bounty.id]
      ).catch(() => {});
    }
    error.status = error.status || 502;
    throw error;
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fresh = (await client.query(
      'SELECT * FROM bounties WHERE id = $1 FOR UPDATE',
      [bounty.id]
    )).rows[0];
    if (
      !fresh ||
      fresh.status !== 'proposal_selected' ||
      fresh.selected_proposal_id !== bounty.selected_proposal_id ||
      fresh.escrow_status !== 'funding' ||
      (fresh.onchain_job_id && String(fresh.onchain_job_id) !== jobId.toString())
    ) {
      throw Object.assign(
        new Error(
          `Bounty state changed after on-chain funding (status=${fresh?.status || 'missing'}, escrow=${fresh?.escrow_status || 'missing'})`
        ),
        { status: 409 }
      );
    }

    await recordBountyFundingTransaction(client, {
      txHash: txs.fund,
      bountyId: bounty.id,
      funderWallet: eligibility.creatorWallet,
      amountUsdc,
    });
    await client.query(
      `UPDATE bounties
          SET escrow_mode = 'onchain',
              onchain_job_id = $1,
              escrow_status = 'claimed',
              status = 'assigned',
              escrow_budget_usdc = $2,
              escrow_tx_hash = $3,
              provider_agent_id = $4,
              provider_wallet = $5,
              expires_at = $6,
              claimed_at = $7,
              updated_at = $7
        WHERE id = $8`,
      [
        jobId.toString(),
        amountUsdc,
        txs.fund,
        selectedAgent.id,
        eligibility.providerWallet,
        expiresAt,
        now,
        bounty.id,
      ]
    );
    await client.query(
      `INSERT INTO escrow_events
         (id, bounty_id, event_type, actor_wallet, actor_type, details, tx_hash, created_at)
       VALUES
         ($1, $2, 'funded', $3, 'agent', $4, $5, $6),
         ($7, $2, 'claimed', $8, 'agent', $9, $10, $6)`,
      [
        `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        bounty.id,
        eligibility.creatorWallet,
        `${amountUsdc} USDC funded on-chain (job ${jobId})`,
        txs.fund,
        now,
        `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-c`,
        eligibility.providerWallet,
        `Provider ${selectedAgent.agent_name} assigned on-chain`,
        txs.setProvider || '',
      ]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    error.txHash = txs.fund;
    error.jobId = jobId.toString();
    error.status = error.status || 409;
    error.recoverable = true;
    await pool.query(
      `UPDATE bounties
          SET escrow_mode = 'onchain',
              onchain_job_id = $1,
              escrow_status = 'funding',
              updated_at = $2
        WHERE id = $3 AND status = 'proposal_selected'`,
      [jobId.toString(), new Date().toISOString(), bounty.id]
    ).catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  return {
    bounty: await stmts.getBountyById(bounty.id),
    txHash: txs.fund,
    txs,
    jobId: jobId.toString(),
    platformFeeUsdc,
  };
}

// Verify transaction on-chain
async function verifyTransaction(
  txHash,
  expectedFrom,
  expectedTo,
  expectedAmountUsdc,
  { allowWrappedCall = false } = {}
) {
  try {
    // Wait for normal block-inclusion latency before treating reconciliation as
    // failed. Browser wallets return the hash before Arc confirms the transfer.
    const receipt = await onchainEscrow.withArcRpcRetry(
      () => arcTestnetClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 120_000,
      }),
      { label: `transaction ${txHash} receipt` },
    );

    if (!receipt) {
      return { valid: false, error: 'Transaction not found on-chain' };
    }

    if (receipt.status !== 'success') {
      return { valid: false, error: 'Transaction failed on-chain' };
    }

    // Fetch transaction details
    const tx = await onchainEscrow.withArcRpcRetry(
      () => arcTestnetClient.getTransaction({ hash: txHash }),
      { label: `transaction ${txHash} details` },
    );

    // Funding transactions call USDC directly. Refunds may route through Arc's
    // memo contract, so those are verified by the emitted USDC Transfer event.
    if (
      !allowWrappedCall &&
      tx.to?.toLowerCase() !== USDC_CONTRACT_ADDRESS.toLowerCase()
    ) {
      return { valid: false, error: 'Transaction is not a USDC transfer' };
    }

    // Verify sender
    if (tx.from.toLowerCase() !== expectedFrom.toLowerCase()) {
      return { valid: false, error: `Transaction sender mismatch. Expected ${expectedFrom}, got ${tx.from}` };
    }

    // Decode USDC transfer from logs (ERC20 Transfer event)
    // Transfer(address indexed from, address indexed to, uint256 value)
    const expectedFromLower = expectedFrom.toLowerCase();
    const expectedToLower = expectedTo.toLowerCase();
    const expectedAmountWei = parseUnits(String(expectedAmountUsdc), 6);
    const transferLog = receipt.logs.find((log) => {
      if (
        log.address.toLowerCase() !== USDC_CONTRACT_ADDRESS.toLowerCase() ||
        log.topics[0] !== '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' ||
        !log.topics[1] ||
        !log.topics[2]
      ) {
        return false;
      }
      const transferFrom = `0x${log.topics[1].slice(26)}`.toLowerCase();
      const transferTo = `0x${log.topics[2].slice(26)}`.toLowerCase();
      const transferValue = BigInt(log.data);
      return (
        transferFrom === expectedFromLower &&
        transferTo === expectedToLower &&
        transferValue === expectedAmountWei
      );
    });

    if (!transferLog) {
      return {
        valid: false,
        error: 'No exact matching USDC Transfer event found in transaction',
      };
    }

    // Decode transfer event
    const transferFrom = '0x' + transferLog.topics[1].slice(26);
    const transferTo = '0x' + transferLog.topics[2].slice(26); // Remove padding from address
    const transferValue = BigInt(transferLog.data);
    const transferAmountUsdc = Number(transferValue) / 1e6; // USDC has 6 decimals

    return {
      valid: true,
      from: transferFrom,
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
    const balanceWei = await onchainEscrow.usdcBalance(SELLER_ADDRESS);
    return Number(balanceWei) / 1e6; // USDC has 6 decimals
  } catch (error) {
    console.error('Failed to get platform wallet balance:', error);
    throw new Error(`Balance check failed: ${error.message}`);
  }
}

// Transfer USDC from platform escrow wallet to recipient
async function transferUSDCFromPlatform(toAddress, amountUsdc, memo = null) {
  if (!walletSigningReady()) {
    throw new Error('No wallet provider configured. Cannot sign platform transactions.');
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

  const memoTag = memo?.memoId ? ` [memo:${memo.memoId.slice(0, 10)}…]` : '';
  console.log(`[Platform Transfer] Sending ${amountUsdc} USDC to ${toAddress}${memoTag}... (balance: ${balance.toFixed(2)} USDC)`);

  try {
    const { encodeFunctionData } = await import('viem');
    const amountWei = BigInt(Math.round(amountUsdc * 1_000_000)); // 6 decimals

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

    // Route through Arc Memo contract when caller passes a memo. The Memo
    // contract preserves msg.sender via the CallFrom precompile, so USDC's
    // transfer still credits the platform wallet, and an indexable
    // (memoId, memoData) trail is emitted for reconciliation.
    const tx = memo?.memoId
      ? withMemo(
          { to: USDC_CONTRACT_ADDRESS, data },
          { memoId: memo.memoId, memoData: memo.memoData ?? null },
        )
      : { to: USDC_CONTRACT_ADDRESS, data };

    // Sign+send from the platform wallet via the provider (self-hosted/hybrid = no
    // Turnkey). The platform wallet is the gas source, so no ensureGas here.
    const { txHash } = await onchainEscrow.sendAs(SELLER_ADDRESS, tx, 'platform-transfer');

    console.log(`✓ Platform transfer successful: ${amountUsdc} USDC → ${toAddress}${memoTag} | tx: ${txHash}`);
    return txHash;
  } catch (error) {
    console.error(`✗ Platform transfer failed:`, error);
    const wrapped = new Error(`USDC transfer failed: ${error.message}`);
    if (error.txHash) wrapped.txHash = error.txHash;
    if (error.code) wrapped.code = error.code;
    throw wrapped;
  }
}

// POST /api/bounties/:id/fund — authenticated agent creator funds escrow.
app.post('/api/bounties/:id/fund', requireAuth, async (req, res) => {
  {
    try {
      const creator = await stmts.getAgentById(req.auth.agentId);
      if (!creator) return res.status(404).json({ error: 'Agent not found' });
      if (!creator.turnkey_address) {
        return res.status(409).json({
          error: 'Create a managed wallet before funding a bounty.',
          action_required: 'create_wallet',
        });
      }
      if (!(await checkRateLimit(creator.id, 'escrow_fund'))) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
      }

      const bounty = await stmts.getBountyById(req.params.id);
      if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
      if (!agentControlsBounty(creator, bounty)) {
        return res.status(403).json({ error: 'Only the bounty creator can fund it' });
      }

      const amountUsdc = Number(req.body?.budgetUsdc ?? bounty.amount_usdc);
      const expectedAmount = Number(bounty.amount_usdc);
      if (!Number.isFinite(amountUsdc) || amountUsdc < 1) {
        return res.status(400).json({ error: 'Minimum bounty funding is 1 USDC' });
      }
      if (Math.abs(amountUsdc - expectedAmount) > 0.000001) {
        return res.status(400).json({
          error: `budgetUsdc must match the bounty amount (${bounty.amount_usdc} USDC)`,
          expected: bounty.amount_usdc,
          provided: req.body?.budgetUsdc,
        });
      }

      if (bounty.selection_mode === 'proposal' && (
        bounty.status !== 'proposal_selected' ||
        !bounty.selected_proposal_id
      )) {
        return res.status(409).json({
          error: 'Select a proposal before funding this bounty.',
        });
      }
      if (bounty.selection_mode !== 'proposal' && bounty.status !== 'open') {
        return res.status(409).json({
          error: `Bounty cannot be funded in status: ${bounty.status}`,
        });
      }

      const selectedAgent = await getSelectedProposalAgent(bounty);
      const suppliedTxHash = String(req.body?.txHash || '');
      const suppliedOnchainJobId = String(
        req.body?.onchainJobId || bounty.onchain_job_id || ''
      );
      const creatorWallet = creator.turnkey_address;

      let result;
      if (bounty.escrow_status === 'funding' && suppliedOnchainJobId) {
        const eligibility = selectedAgent
          ? await onchainEscrowEligible(bounty, selectedAgent)
          : { eligible: false };
        if (!eligibility.eligible) {
          return res.status(409).json({
            error: `Partial on-chain funding cannot resume: ${eligibility.reason || 'wallet signing unavailable'}`,
          });
        }
        result = await fundSelectedProposalOnchain(
          bounty,
          selectedAgent,
          eligibility,
          {
            resumeJobId: suppliedOnchainJobId,
            fundTxHash: suppliedTxHash || null,
          }
        );
      } else if (bounty.escrow_status === 'funding') {
        if (!suppliedTxHash) {
          return res.status(409).json({
            error: 'Funding is awaiting reconciliation. Retry with the original txHash or onchainJobId.',
            recoverable: true,
          });
        }
        const verification = await verifyTransaction(
          suppliedTxHash,
          creatorWallet,
          SELLER_ADDRESS,
          amountUsdc
        );
        if (!verification.valid) {
          return res.status(409).json({
            error: 'Funding transaction is not confirmed or does not match this bounty',
            details: verification.error,
            txHash: suppliedTxHash,
          });
        }
        const fundedBounty = await finalizeCustodialBountyFunding({
          bounty,
          creatorWallet,
          amountUsdc,
          txHash: suppliedTxHash,
          selectedAgent,
          actorType: 'agent',
        });
        return res.json({
          success: true,
          reconciled: true,
          txHash: suppliedTxHash,
          bounty: fundedBounty,
        });
      } else if (bounty.escrow_status !== 'none') {
        return res.status(409).json({
          error: `Bounty is already in escrow state: ${bounty.escrow_status}`,
        });
      } else {
        const eligibility = selectedAgent
          ? await onchainEscrowEligible(bounty, selectedAgent)
          : { eligible: false };
        if (suppliedOnchainJobId) {
          if (!eligibility.eligible) {
            return res.status(409).json({
              error: `Partial on-chain funding cannot resume: ${eligibility.reason || 'wallet signing unavailable'}`,
            });
          }
          result = await fundSelectedProposalOnchain(
            bounty,
            selectedAgent,
            eligibility,
            {
              resumeJobId: suppliedOnchainJobId,
              fundTxHash: suppliedTxHash || null,
            }
          );
        } else if (!suppliedTxHash && eligibility.eligible) {
          result = await fundSelectedProposalOnchain(
            bounty,
            selectedAgent,
            eligibility
          );
        } else if (suppliedTxHash) {
          const verification = await verifyTransaction(
            suppliedTxHash,
            creatorWallet,
            SELLER_ADDRESS,
            amountUsdc
          );
          if (!verification.valid) {
            return res.status(400).json({
              error: 'Funding transaction verification failed',
              details: verification.error,
            });
          }
          await reserveBountyFunding(bounty.id);
          const fundedBounty = await finalizeCustodialBountyFunding({
            bounty,
            creatorWallet,
            amountUsdc,
            txHash: suppliedTxHash,
            selectedAgent,
            actorType: 'agent',
          });
          result = { bounty: fundedBounty, txHash: suppliedTxHash, selectedAgent };
        } else {
          result = await transferAndFundCustodialBounty(
            bounty,
            creatorWallet,
            'agent'
          );
        }
      }

      emitFeedEvent('escrow:funded', {
        bountyId: bounty.id,
        budgetUsdc: amountUsdc,
        mode: result.jobId ? 'onchain' : 'custodial',
        jobId: result.jobId || undefined,
      });
      if (selectedAgent) {
        emitFeedEvent('escrow:claimed', {
          bountyId: bounty.id,
          agentId: selectedAgent.id,
          agentName: selectedAgent.agent_name,
        });
        await createNotification({
          agentId: selectedAgent.id,
          type: 'system',
          title: result.jobId ? 'Bounty Funded On-Chain - You Can Start' : 'Bounty Funded - You Can Start',
          message: `"${bounty.title}" is funded with ${amountUsdc} USDC. Begin work and submit your deliverable.`,
          from: creatorWallet,
        });
      }

      return res.json({
        success: true,
        txHash: result.txHash,
        escrow_mode: result.jobId ? 'onchain' : 'custodial',
        onchain_job_id: result.jobId || null,
        platform_fee_usdc: result.platformFeeUsdc || 0,
        tx: result.txs || undefined,
        bounty: result.bounty,
      });
    } catch (error) {
      return res.status(error.status || 502).json({
        error: error.message,
        txHash: error.txHash || null,
        onchainJobId: error.jobId || null,
        completedTransactions: error.completedTransactions || undefined,
        recoverable: Boolean(error.txHash || error.jobId),
      });
    }
  }

});

// POST /api/bounties/:id/claim — Agent accepts a funded bounty
app.post('/api/bounties/:id/claim', requireAuth, async (req, res) => {
  // Actor is the authenticated agent — no more optional/skippable callerWallet check.
  const agentId = req.auth.agentId;

  const agent = await stmts.getAgentById(agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  if (!(await checkRateLimit(agentId, 'escrow_claim'))) return res.status(429).json({ error: 'Rate limit exceeded' });

  const bounty = await stmts.getBountyById(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (bounty.selection_mode === 'proposal') {
    return res.status(409).json({
      error: 'This bounty uses proposal selection. Submit a proposal via POST /api/bounties/:id/proposals instead.',
      hint: 'Use bard_submit_proposal MCP tool or the proposal endpoint.'
    });
  }
  if (bounty.status !== 'open' || bounty.escrow_status !== 'funded') {
    return res.status(409).json({ error: 'Bounty is not funded and available for claiming' });
  }
  if (agent.reputation_score < (bounty.min_reputation || 0)) {
    return res.status(403).json({ error: `Agent needs reputation >= ${bounty.min_reputation}` });
  }
  if (agentControlsBounty(agent, bounty)) {
    return res.status(409).json({ error: 'An agent cannot claim its own bounty' });
  }

  // Require a managed payment wallet for funded bounties.
  if (!agent.turnkey_address) {
    return res.status(400).json({
      error: 'Agent must have a managed wallet to receive payment from funded bounties.',
      action_required: 'create_wallet',
      hint: 'Use bard_create_wallet or POST /api/agents/:id/create-wallet first.'
    });
  }

  const now = new Date().toISOString();
  // Reset expiry from claim time (agent gets full 72h to deliver)
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const claimed = await pool.query(
    `UPDATE bounties
        SET provider_agent_id = $1,
            provider_wallet = $2,
            escrow_status = 'claimed',
            status = 'assigned',
            claimed_at = $3,
            expires_at = $4,
            updated_at = $3
      WHERE id = $5 AND status = 'open' AND escrow_status = 'funded'
      RETURNING *`,
    [agentId, agent.turnkey_address, now, expiresAt, req.params.id]
  );
  if (!claimed.rows[0]) {
    return res.status(409).json({
      error: 'Bounty was already claimed by another agent',
    });
  }
  await logEscrowEvent(req.params.id, 'claimed', agent.owner_wallet, 'agent', `Claimed by ${agent.agent_name}`, '');

  await createNotification({ wallet: bounty.creator_wallet, type: 'system', title: 'Agent Claimed Bounty', message: `${agent.agent_name} accepted your bounty "${bounty.title}".`, from: agent.owner_wallet });
  emitFeedEvent('escrow:claimed', { bountyId: req.params.id, agentId, agentName: agent.agent_name });

  // If this is a swarm agent, execute the swarm immediately.
  // DORMANT: skip execution entirely while the swarm feature is on hold. The
  // claim still succeeds; the bounty simply isn't auto-worked by the swarm.
  let swarmResult = null;
  if (SWARMS_ENABLED && agent.agent_type === 'swarm' && agent.swarm_config) {
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
app.post('/api/bounties/:id/deliver', requireAuth, async (req, res) => {
  // Actor is the authenticated agent.
  const agentId = req.auth.agentId;
  const { content, proofHash } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });

  // Size limit: max 1MB deliverable
  if (content.length > 1024 * 1024) return res.status(400).json({ error: 'Deliverable too large (max 1MB)' });
  if (!(await checkRateLimit(agentId, 'escrow_deliver'))) return res.status(429).json({ error: 'Rate limit exceeded' });

  const bounty = await stmts.getBountyById(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (bounty.provider_agent_id !== agentId) return res.status(403).json({ error: 'Only the assigned agent can submit' });
  if (!['claimed', 'submitted'].includes(bounty.escrow_status)) return res.status(409).json({ error: `Cannot submit in state: ${bounty.escrow_status}` });

  const agent = await stmts.getAgentById(agentId);

  const hash = proofHash || ('0x' + createHash('sha256').update(content).digest('hex'));
  const now = new Date().toISOString();

  // On-chain: record the deliverable on the escrow contract (Funded → Submitted)
  // BEFORE flipping the DB, so a failed on-chain submit doesn't leave the DB ahead.
  // Only the first submission moves on-chain state; a revision re-uses the same
  // Submitted job and just refreshes the off-chain artifact below.
  let submitTx = '';
  if (bounty.escrow_mode === 'onchain' && bounty.onchain_job_id) {
    try {
      const job = await onchainEscrow.getJob(bounty.onchain_job_id);
      if (Number(job.status) === 1 /* Funded */) {
        ({ txHash: submitTx } = await onchainEscrow.submit({
          providerWallet: bounty.provider_wallet,
          jobId: bounty.onchain_job_id,
          deliverableLabel: hash,
        }));
      }
    } catch (err) {
      console.error(`[Escrow On-Chain] submit failed for job ${bounty.onchain_job_id}: ${err.message}`);
      if (err.txHash) {
        return res.status(202).json({
          success: true,
          pending: true,
          txHash: err.txHash,
          onchainJobId: String(bounty.onchain_job_id),
          message: 'Deliverable transaction was broadcast, but confirmation is pending. Retry the same deliverable later to reconcile the database.',
          details: err.message,
        });
      }
      return res.status(502).json({ error: 'On-chain deliverable submission failed', details: err.message });
    }
  }

  await stmts.submitBountyDeliverable({ deliverable_hash: hash, deliverable_content: content, submitted_at: now, updated_at: now, id: req.params.id });
  await logEscrowEvent(req.params.id, 'submitted', bounty.provider_wallet, 'agent', `Deliverable submitted (hash: ${hash.slice(0, 16)}...)${submitTx ? ` [on-chain ${submitTx}]` : ''}`, submitTx);

  await createNotification({ wallet: bounty.creator_wallet, type: 'system', title: 'Deliverable Submitted', message: `Agent submitted work for "${bounty.title}". Review it now.`, from: bounty.provider_wallet });
  emitFeedEvent('escrow:submitted', { bountyId: req.params.id, deliverableHash: hash });

  res.json({ success: true, bounty: await stmts.getBountyById(req.params.id) });
});

async function releaseAgentBountyOnCreatorApproval({
  bountyId,
  creatorAgent,
  reason,
}) {
  const creatorWallet = creatorAgent.turnkey_address || creatorAgent.owner_wallet;
  const now = new Date().toISOString();
  const client = await pool.connect();
  let bounty;
  let releaseTx = '';

  try {
    await client.query('BEGIN');
    bounty = (await client.query(
      'SELECT * FROM bounties WHERE id = $1 FOR UPDATE',
      [bountyId]
    )).rows[0];

    if (!bounty) {
      throw Object.assign(new Error('Bounty not found'), { status: 404 });
    }
    if (!agentControlsBounty(creatorAgent, bounty)) {
      throw Object.assign(
        new Error('Only the authenticated creator agent can review this bounty'),
        { status: 403 }
      );
    }
    if (bounty.escrow_status === 'released' && bounty.status === 'completed') {
      await client.query('COMMIT');
      return { bounty, reconciled: true };
    }
    if (!['submitted', 'client_approved'].includes(bounty.escrow_status)) {
      throw Object.assign(
        new Error(`No deliverable can be approved in state: ${bounty.escrow_status}`),
        { status: 409 }
      );
    }
    if (!bounty.provider_agent_id) {
      throw Object.assign(new Error('No provider agent for this bounty'), { status: 409 });
    }

    const agent = (await client.query(
      'SELECT turnkey_address, owner_wallet, agent_name FROM agents WHERE id = $1',
      [bounty.provider_agent_id]
    )).rows[0];
    if (!agent) {
      throw Object.assign(new Error('Provider agent not found'), { status: 404 });
    }
    const recipientWallet = agent.turnkey_address || agent.owner_wallet;
    if (!recipientWallet) {
      throw Object.assign(new Error('Provider agent has no payment wallet'), { status: 409 });
    }

    let agentEarnings = Number(bounty.escrow_budget_usdc || 0);
    let platformFee = 0;
    if (bounty.swarm_execution_id) {
      const execution = (await client.query(
        'SELECT platform_markup_usd FROM swarm_executions WHERE id = $1',
        [bounty.swarm_execution_id]
      )).rows[0];
      platformFee = Number(execution?.platform_markup_usd || 0);
      agentEarnings -= platformFee;
    }

    const pendingSettlement = (await client.query(
      `SELECT tx_hash FROM escrow_events
       WHERE bounty_id = $1 AND event_type = 'settlement_pending' AND tx_hash <> ''
       ORDER BY created_at DESC LIMIT 1`,
      [bountyId]
    )).rows[0]?.tx_hash || '';

    if (bounty.escrow_mode === 'onchain' && bounty.onchain_job_id) {
      const job = await onchainEscrow.getJob(bounty.onchain_job_id);
      if (Number(job.status) === 2 /* Submitted */) {
        if (pendingSettlement) {
          const pendingError = new Error(
            `Settlement transaction ${pendingSettlement} is awaiting on-chain confirmation.`
          );
          pendingError.txHash = pendingSettlement;
          throw pendingError;
        }
        const release = await onchainEscrow.release({
          jobId: bounty.onchain_job_id,
          reasonLabel: `creator-approved:${reason || 'approved'}`,
          // The platform key is the contract evaluator and executes the
          // authenticated creator's decision; no operator approval is involved.
          evaluator: SELLER_ADDRESS,
        });
        releaseTx = release.txHash;
        try {
          const settled = await onchainEscrow.decodeSettlement(release.receipt);
          if (settled.paidToProvider > 0) agentEarnings = settled.paidToProvider;
          if (settled.feePaid > 0) platformFee = settled.feePaid;
        } catch (error) {
          console.warn(`[Agent Bounty Release] settlement decode failed: ${error.message}`);
        }
      } else if (Number(job.status) === 3 /* Completed */) {
        releaseTx = bounty.release_tx_hash || pendingSettlement;
        if (!releaseTx) {
          throw Object.assign(
            new Error('On-chain bounty is completed but its release transaction is not recorded'),
            { status: 409 }
          );
        }
      } else {
        throw Object.assign(
          new Error(
            `On-chain job ${bounty.onchain_job_id} cannot be released from status ${Number(job.status)}`
          ),
          { status: 409 }
        );
      }
    } else if (pendingSettlement) {
      const verification = await verifyTransaction(
        pendingSettlement,
        SELLER_ADDRESS,
        recipientWallet,
        agentEarnings,
        { allowWrappedCall: true }
      );
      if (!verification.valid) {
        const pendingError = new Error(
          `Settlement transaction ${pendingSettlement} is not confirmed yet: ${verification.error}`
        );
        pendingError.txHash = pendingSettlement;
        throw pendingError;
      }
      releaseTx = pendingSettlement;
    } else {
      releaseTx = await transferUSDCFromPlatform(recipientWallet, agentEarnings, {
        memoId: MemoIds.PayoutAgent,
        memoData: {
          bountyId,
          agentId: bounty.provider_agent_id,
          agentName: agent.agent_name,
          agentWallet: recipientWallet,
          amountUsd: agentEarnings,
          platformFeeUsd: platformFee,
          approvedByAgentId: creatorAgent.id,
        },
      });
    }

    const decisionId = `vd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const reasoning = reason || 'Creator agent approved the deliverable';
    const reasoningHash = '0x' + createHash('sha256').update(reasoning).digest('hex');
    await client.query(
      `INSERT INTO verification_decisions
         (id, bounty_id, verifier_wallet, verifier_type, decision, reasoning, reasoning_hash, stage, tx_hash, created_at)
       VALUES ($1, $2, $3, 'creator_agent', 'approved', $4, $5, 1, $6, $7)`,
      [decisionId, bountyId, creatorWallet, reasoning, reasoningHash, releaseTx, now]
    );
    await client.query(
      `UPDATE bounties
          SET client_decision = 'approved',
              client_decision_at = COALESCE(client_decision_at, $1),
              release_tx_hash = $2,
              escrow_status = 'released',
              status = 'completed',
              released_at = $1,
              updated_at = $1
        WHERE id = $3`,
      [now, releaseTx, bountyId]
    );
    await client.query(
      `INSERT INTO escrow_events
         (id, bounty_id, event_type, actor_wallet, actor_type, details, tx_hash, created_at)
       VALUES
         ($1, $2, 'client_approved', $3, 'agent', $4, '', $5),
         ($6, $2, 'released', $3, 'agent', $7, $8, $5)`,
      [
        `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        bountyId,
        creatorWallet,
        reasoning,
        now,
        `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-r`,
        `${agentEarnings.toFixed(2)} USDC released after creator-agent approval (platform fee: ${platformFee.toFixed(2)} USDC)`,
        releaseTx,
      ]
    );
    await client.query(
      `UPDATE agents
          SET reputation_score = LEAST(100, reputation_score + 15),
              total_earned_usdc = total_earned_usdc + $1
        WHERE id = $2`,
      [agentEarnings, bounty.provider_agent_id]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (releaseTx && !error.txHash) error.txHash = releaseTx;
    if (error.txHash) {
      error.recoverable = true;
      const existing = await pool.query(
        `SELECT 1 FROM escrow_events
         WHERE bounty_id = $1 AND event_type = 'settlement_pending' AND tx_hash = $2
         LIMIT 1`,
        [bountyId, error.txHash]
      );
      if (!existing.rows[0]) {
        await logEscrowEvent(
          bountyId,
          'settlement_pending',
          creatorWallet,
          'agent',
          'Creator-approved settlement was broadcast and is awaiting confirmation',
          error.txHash
        );
      }
    }
    throw error;
  } finally {
    client.release();
  }

  await runBestEffort(
    `agent payout notification for bounty ${bountyId}`,
    () => createNotification({
      agentId: bounty.provider_agent_id,
      type: 'send',
      title: 'Bounty Paid',
      message: `${bounty.escrow_budget_usdc} USDC released for "${bounty.title}". Rep +15.`,
      from: creatorWallet,
      amount: String(bounty.escrow_budget_usdc),
    })
  );
  emitFeedEvent('escrow:released', {
    bountyId,
    approvedByAgentId: creatorAgent.id,
    releaseTxHash: releaseTx,
  });
  return { bounty: await stmts.getBountyById(bountyId), txHash: releaseTx };
}

// Authenticated agent creators approve work and trigger payment directly.
// A second rejection still escalates to the existing platform dispute route.
app.post('/api/bounties/:id/agent-review', requireAuth, async (req, res) => {
  const decision = String(req.body?.decision || '');
  const reason = String(req.body?.reason || '').trim().slice(0, 2000);
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be approved or rejected' });
  }
  if (!(await checkRateLimit(req.auth.agentId, 'escrow_review'))) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  const creatorAgent = await stmts.getAgentById(req.auth.agentId);
  if (!creatorAgent) return res.status(404).json({ error: 'Creator agent not found' });
  const bounty = await stmts.getBountyById(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (!agentControlsBounty(creatorAgent, bounty)) {
    return res.status(403).json({ error: 'Only the authenticated creator agent can review' });
  }

  if (decision === 'rejected') {
    if (bounty.escrow_status !== 'submitted') {
      return res.status(409).json({ error: 'No deliverable to reject' });
    }
    const now = new Date().toISOString();
    if ((bounty.revision_count || 0) >= 1) {
      await stmts.clientReviewBounty({
        client_decision: 'rejected',
        client_decision_at: now,
        escrow_status: 'disputed',
        updated_at: now,
        id: bounty.id,
      });
      await logEscrowEvent(
        bounty.id,
        'disputed',
        creatorAgent.turnkey_address || creatorAgent.owner_wallet,
        'agent',
        `Creator agent rejected the revision: ${reason || 'No reason'}`,
        ''
      );
      return res.json({
        success: true,
        disputed: true,
        message: 'Revision rejected and escalated for dispute resolution.',
        bounty: await stmts.getBountyById(bounty.id),
      });
    }
    await stmts.incrementBountyRevision({ updated_at: now, id: bounty.id });
    await logEscrowEvent(
      bounty.id,
      'client_rejected',
      creatorAgent.turnkey_address || creatorAgent.owner_wallet,
      'agent',
      `Creator agent requested a revision: ${reason || 'No reason'}`,
      ''
    );
    await createNotification({
      agentId: bounty.provider_agent_id,
      type: 'system',
      title: 'Revision Requested',
      message: `Revision requested for "${bounty.title}": ${reason || 'No details'}`,
      from: creatorAgent.turnkey_address || creatorAgent.owner_wallet,
    });
    return res.json({
      success: true,
      revisionRequested: true,
      message: 'Revision requested from the provider agent.',
      bounty: await stmts.getBountyById(bounty.id),
    });
  }

  try {
    const result = await releaseAgentBountyOnCreatorApproval({
      bountyId: bounty.id,
      creatorAgent,
      reason,
    });
    return res.json({
      success: true,
      paid: true,
      txHash: result.txHash || result.bounty?.release_tx_hash || null,
      message: result.reconciled
        ? 'Bounty payment was already completed.'
        : 'Deliverable approved and payment released to the provider agent.',
      bounty: result.bounty,
    });
  } catch (error) {
    if (error.txHash) {
      return res.status(202).json({
        success: true,
        pending: true,
        txHash: error.txHash,
        onchainJobId: bounty.onchain_job_id ? String(bounty.onchain_job_id) : null,
        message: 'Payment was broadcast and is awaiting confirmation. Retry this approval to reconcile it.',
        details: error.message,
      });
    }
    return res.status(error.status || 409).json({ error: error.message });
  }
});

// POST /api/human/bounties/:id/review — Authenticated human creator reviews work.
app.post('/api/human/bounties/:id/review', requireHuman, async (req, res) => {
  const clientWallet = req.human.wallet_address;
  const { decision, reason } = req.body;
  if (!decision) return res.status(400).json({ error: 'decision (approved/rejected) required' });
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

// GET /api/admin/turnkey-orphans — Read-only audit of Turnkey org vs DB.
// Platform-verifier-only. Returns three buckets (ok / adoptable / stranded)
// so verifiers can spot drift without SSH-ing into Railway. Apply-side
// reconciliation lives in backend/audit-turnkey-orphans.mjs (--apply).
app.get('/api/admin/turnkey-orphans', requireTrustedServiceOrOperator, async (req, res) => {
  const callerWallet = (req.query.callerWallet || '').toLowerCase();
  if (!callerWallet) return res.status(400).json({ error: 'callerWallet query param required' });
  if (!(await stmts.isPlatformVerifier(callerWallet))) {
    return res.status(403).json({ error: 'Caller is not a platform verifier' });
  }
  try {
    const result = await auditTurnkeyOrphans(pool);
    if (result.error) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    console.error('Turnkey audit failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/turnkey-orphans — Bulk-delete stranded Turnkey wallets.
// Platform-verifier-only. Requires confirm:true in body. First runs the
// same audit as the GET to identify genuinely stranded IDs, then batch-
// deletes via Turnkey's deleteWallets API. Returns { deleted, failed, skipped }.
app.delete('/api/admin/turnkey-orphans', requireTrustedServiceOrOperator, async (req, res) => {
  const { verifierWallet, confirm } = req.body || {};
  if (!verifierWallet) return res.status(400).json({ error: 'verifierWallet required' });
  if (confirm !== true) return res.status(400).json({ error: 'confirm:true required (this is destructive)' });
  if (!(await stmts.isPlatformVerifier(verifierWallet))) {
    return res.status(403).json({ error: 'Caller is not a platform verifier' });
  }
  try {
    const audit = await auditTurnkeyOrphans(pool);
    if (audit.error) return res.status(409).json(audit);
    if (audit.stranded.length === 0) {
      return res.json({ deleted: 0, failed: 0, message: 'No stranded wallets to delete.' });
    }
    const walletIds = audit.stranded.map(s => s.walletId);
    const result = await deleteStrandedWallets(pool, walletIds);
    if (result.error) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    console.error('Delete stranded wallets failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/platform-verifiers', requireTrustedServiceOrOperator, async (_req, res) => {
  try {
    const verifiers = await stmts.listPlatformVerifiers();
    res.json({ verifiers, count: verifiers.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/platform-verifiers', requireTrustedServiceOrOperator, async (req, res) => {
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

app.delete('/api/admin/platform-verifiers/:wallet', requireTrustedServiceOrOperator, async (req, res) => {
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

// POST /api/admin/provision-platform-wallet — mint a self-hosted (local) platform
// wallet inside the service (which has internal DB + WALLET_MASTER_KEY), optionally
// faucet it, and return its address. This is how the Turnkey-free platform wallet is
// created in an environment where the DB isn't reachable from outside. Platform-
// verifier-gated. After calling, set SELLER_ADDRESS / PLATFORM_OWNER_WALLET to the
// returned address and redeploy.
app.post('/api/admin/provision-platform-wallet', requireTrustedServiceOrOperator, async (req, res) => {
  const { callerWallet, faucet } = req.body || {};
  if (!callerWallet) return res.status(400).json({ error: 'callerWallet required' });
  if (!(await stmts.isPlatformVerifier(callerWallet))) {
    return res.status(403).json({ error: 'Only a platform verifier can provision the platform wallet' });
  }
  const mode = (process.env.WALLET_PROVIDER || 'turnkey').toLowerCase();
  if (mode !== 'local' && mode !== 'hybrid') {
    return res.status(409).json({ error: `WALLET_PROVIDER must be local|hybrid to provision a self-hosted wallet (got ${mode})` });
  }
  if (!process.env.WALLET_MASTER_KEY) {
    return res.status(409).json({ error: 'WALLET_MASTER_KEY not set — cannot create an encrypted local wallet' });
  }
  try {
    const { getWalletProvider } = await import('./wallet-provider.js');
    const provider = getWalletProvider(pool);
    // Force local creation even in hybrid mode (hybrid.createWallet already goes local).
    const wallet = await (provider.local ? provider.local.createWallet('platform') : provider.createWallet('platform'));

    let faucetResult = null;
    if (faucet && process.env.CIRCLE_API_KEY) {
      const d = await fetch('https://api.circle.com/v1/faucet/drips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CIRCLE_API_KEY}` },
        body: JSON.stringify({ address: wallet.address, blockchain: 'ARC-TESTNET', usdc: true }),
      });
      faucetResult = { status: d.status, ok: d.status === 204 || d.ok };
    }

    console.log(`[Admin] Provisioned local platform wallet ${wallet.address} (faucet: ${faucet ? faucetResult?.status : 'skipped'})`);
    return res.json({
      success: true,
      address: wallet.address,
      walletId: wallet.walletId,
      faucet: faucetResult,
      next: `Set SELLER_ADDRESS=${wallet.address} and PLATFORM_OWNER_WALLET=${wallet.address} on this service, then redeploy.`,
    });
  } catch (err) {
    console.error('[Admin] provision-platform-wallet failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/platform-send — send USDC from the platform wallet (SELLER_ADDRESS)
// to any address, signed via the configured wallet provider. Ops tool for seeding
// agent budgets or withdrawing platform funds. Platform-verifier-gated. Requires the
// platform wallet to be server-signable (local/hybrid provider or Turnkey).
app.post('/api/admin/platform-send', requireTrustedServiceOrOperator, async (req, res) => {
  const { callerWallet, to, amountUsdc } = req.body || {};
  if (!callerWallet || !to || !amountUsdc) return res.status(400).json({ error: 'callerWallet, to, amountUsdc required' });
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return res.status(400).json({ error: 'to must be a 0x address' });
  if (!(await stmts.isPlatformVerifier(callerWallet))) {
    return res.status(403).json({ error: 'Only a platform verifier can send from the platform wallet' });
  }
  try {
    const amountWei = BigInt(Math.round(parseFloat(amountUsdc) * 1e6));
    const { getWalletProvider } = await import('./wallet-provider.js');
    const signer = await getWalletProvider(pool).getSigner(SELLER_ADDRESS);
    const { encodeFunctionData } = await import('viem');
    const data = encodeFunctionData({
      abi: [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
      functionName: 'transfer',
      args: [to, amountWei],
    });
    const txHash = await signer.sendTransaction({ to: USDC_CONTRACT_ADDRESS, data, value: 0n });
    console.log(`[Admin] platform-send ${amountUsdc} USDC ${SELLER_ADDRESS} → ${to} (tx ${txHash})`);
    return res.json({ success: true, txHash, from: SELLER_ADDRESS, to, amountUsdc });
  } catch (err) {
    console.error('[Admin] platform-send failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/expiry-sweep — Run the escrow expiry sweep on demand.
//
// Same logic the hourly cron runs. Platform-verifier-gated. Returns the
// summary so operators can see which bounties refunded, failed, or were
// skipped (e.g. when Turnkey is offline). Safe to call repeatedly: the
// sweep only touches bounties whose expires_at is already in the past.
app.post('/api/admin/expiry-sweep', requireTrustedServiceOrOperator, async (req, res) => {
  const { verifierWallet } = req.body || {};
  if (!verifierWallet) return res.status(400).json({ error: 'verifierWallet required' });
  if (!(await stmts.isPlatformVerifier(verifierWallet))) {
    return res.status(403).json({ error: 'Caller is not a platform verifier' });
  }
  try {
    const summary = await checkEscrowExpiry();
    res.json({ success: true, ...summary });
  } catch (err) {
    console.error('Manual expiry sweep failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/bounties/:id/force-expire — Force a bounty's expires_at
// into the past and run the expiry sweep on just that row.
//
// Platform-verifier-gated. Used by the live expiry test and as an operator
// escape hatch when a bounty is stuck (e.g. claimed agent went silent and
// the creator wants their USDC back before the natural 72h expiry).
// Bounty must currently be in funded/claimed/submitted escrow state.
app.post('/api/admin/bounties/:id/force-expire', requireTrustedServiceOrOperator, async (req, res) => {
  const { verifierWallet } = req.body || {};
  if (!verifierWallet) return res.status(400).json({ error: 'verifierWallet required' });
  if (!(await stmts.isPlatformVerifier(verifierWallet))) {
    return res.status(403).json({ error: 'Caller is not a platform verifier' });
  }
  const bounty = await stmts.getBountyById(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (!['funded', 'claimed', 'submitted'].includes(bounty.escrow_status)) {
    return res.status(409).json({ error: `Cannot force-expire in escrow state: ${bounty.escrow_status}` });
  }
  try {
    const past = new Date(Date.now() - 60_000).toISOString();
    await pool.query('UPDATE bounties SET expires_at = $1, updated_at = $1 WHERE id = $2', [past, req.params.id]);
    const summary = await checkEscrowExpiry({ onlyBountyId: req.params.id });
    res.json({ success: true, bounty: await stmts.getBountyById(req.params.id), ...summary });
  } catch (err) {
    console.error(`Force-expire failed for ${req.params.id}:`, err);
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
app.delete('/api/admin/agents/:id', requireTrustedServiceOrOperator, async (req, res) => {
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
app.post('/api/bounties/:id/platform-verify', requireTrustedServiceOrOperator, async (req, res) => {
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

      // ACTUAL USDC TRANSFER - Release payment to agent.
      // On-chain: `complete` releases the escrowed budget to the provider + the fee
      // to the recipient atomically on-chain (no custodial transfer). decodeSettlement
      // reads the real released amounts from the receipt (gas-independent proof).
      let releaseTx;
      if (bounty.escrow_mode === 'onchain' && bounty.onchain_job_id) {
        console.log(`[Escrow On-Chain Release] Completing job ${bounty.onchain_job_id} → releasing to ${agent.agent_name} (${recipientWallet})...`);
        const job = await onchainEscrow.getJob(bounty.onchain_job_id);
        const pendingSettlement = (await client.query(
          `SELECT tx_hash FROM escrow_events
           WHERE bounty_id = $1 AND event_type = 'settlement_pending' AND tx_hash <> ''
           ORDER BY created_at DESC LIMIT 1`,
          [req.params.id],
        )).rows[0]?.tx_hash || '';
        if (Number(job.status) === 2 /* Submitted */) {
          if (pendingSettlement) {
            const pendingError = new Error(`Settlement transaction ${pendingSettlement} is still pending on-chain confirmation.`);
            pendingError.txHash = pendingSettlement;
            throw pendingError;
          }
          const { txHash, receipt } = await onchainEscrow.release({ jobId: bounty.onchain_job_id, reasonLabel: 'approved', evaluator: SELLER_ADDRESS });
          releaseTx = txHash;
          try {
            const settled = await onchainEscrow.decodeSettlement(receipt);
            if (settled.paidToProvider > 0) agentEarnings = settled.paidToProvider;
            if (settled.feePaid > 0) platformFee = settled.feePaid;
            console.log(`[Escrow On-Chain Release] settled: ${agentEarnings} USDC → provider, ${platformFee} USDC fee (tx ${releaseTx})`);
          } catch (e) { console.warn(`[Escrow On-Chain Release] decodeSettlement failed: ${e.message}`); }
        } else if (Number(job.status) === 3 /* Completed */) {
          releaseTx = bounty.release_tx_hash || pendingSettlement;
          const feeBps = Math.max(0, Math.min(10000, parseInt(process.env.PLATFORM_FEE_BPS || '0', 10) || 0));
          platformFee = Math.floor(agentEarnings * feeBps / 10000 * 1e6) / 1e6;
          console.warn(`[Escrow On-Chain Release] job ${bounty.onchain_job_id} already completed on-chain; reconciling database state.`);
        } else {
          throw new Error(`On-chain job ${bounty.onchain_job_id} cannot be released from status ${Number(job.status)}`);
        }
      } else {
        console.log(`[Escrow Release] Transferring ${agentEarnings} USDC to ${agent.agent_name} (${recipientWallet})...`);
        releaseTx = await transferUSDCFromPlatform(recipientWallet, agentEarnings, {
          memoId: MemoIds.PayoutAgent,
          memoData: {
            bountyId: req.params.id,
            agentId: bounty.provider_agent_id,
            agentName: agent.agent_name,
            agentWallet: recipientWallet,
            amountUsd: agentEarnings,
            platformFeeUsd: platformFee,
            verifier: verifierWallet,
          },
        });
      }

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

      // ACTUAL USDC TRANSFER - Refund to creator.
      // On-chain: `reject` returns the escrowed budget (and any fee) to the client
      // on-chain — no custodial transfer.
      let refundTx;
      if (bounty.escrow_mode === 'onchain' && bounty.onchain_job_id) {
        console.log(`[Escrow On-Chain Refund] Rejecting job ${bounty.onchain_job_id} → refunding creator ${bounty.creator_wallet}...`);
        const job = await onchainEscrow.getJob(bounty.onchain_job_id);
        const pendingSettlement = (await client.query(
          `SELECT tx_hash FROM escrow_events
           WHERE bounty_id = $1 AND event_type = 'settlement_pending' AND tx_hash <> ''
           ORDER BY created_at DESC LIMIT 1`,
          [req.params.id],
        )).rows[0]?.tx_hash || '';
        if (Number(job.status) === 2 /* Submitted */) {
          if (pendingSettlement) {
            const pendingError = new Error(`Settlement transaction ${pendingSettlement} is still pending on-chain confirmation.`);
            pendingError.txHash = pendingSettlement;
            throw pendingError;
          }
          ({ txHash: refundTx } = await onchainEscrow.reject({ jobId: bounty.onchain_job_id, reasonLabel: 'rejected', evaluator: SELLER_ADDRESS }));
        } else if (Number(job.status) === 4 /* Rejected */) {
          refundTx = pendingSettlement;
          console.warn(`[Escrow On-Chain Refund] job ${bounty.onchain_job_id} already rejected on-chain; reconciling database state.`);
        } else {
          throw new Error(`On-chain job ${bounty.onchain_job_id} cannot be rejected from status ${Number(job.status)}`);
        }
      } else {
        console.log(`[Escrow Refund] Transferring ${bounty.escrow_budget_usdc} USDC back to creator (${bounty.creator_wallet})...`);
        refundTx = await transferUSDCFromPlatform(bounty.creator_wallet, bounty.escrow_budget_usdc, {
          memoId: MemoIds.PayoutRefund,
          memoData: {
            bountyId: req.params.id,
            creatorWallet: bounty.creator_wallet,
            amountUsd: parseFloat(bounty.escrow_budget_usdc),
            cause: 'verifier_rejected',
            verifier: verifierWallet,
            reasoning: reasoning || '',
          },
        });
      }

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
    if (err.txHash) {
      const existing = await pool.query(
        `SELECT 1 FROM escrow_events
         WHERE bounty_id = $1 AND event_type = 'settlement_pending' AND tx_hash = $2
         LIMIT 1`,
        [req.params.id, err.txHash],
      );
      if (existing.rows.length === 0) {
        await logEscrowEvent(
          req.params.id,
          'settlement_pending',
          verifierWallet,
          'platform',
          'Settlement transaction broadcast; awaiting Arc RPC confirmation',
          err.txHash,
        );
      }
      return res.status(202).json({
        success: true,
        pending: true,
        txHash: err.txHash,
        onchainJobId: bounty.onchain_job_id ? String(bounty.onchain_job_id) : null,
        message: 'Platform settlement was broadcast, but confirmation is pending. Retry the same verification later to reconcile database state.',
        details: err.message,
      });
    }
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

// Build a client-friendly on-chain escrow summary (null for custodial/unfunded
// bounties). Gives the frontend + MCP job id, ArcScan links, and the platform fee
// without them having to know the contract layout. Fee is the configured rate
// applied to the funded budget (display estimate; the exact fee is settled on-chain
// at release and recorded in the escrow_events trail).
const ARC_EXPLORER = 'https://testnet.arcscan.app';
function onchainEscrowSummary(bounty) {
  if (!bounty || bounty.escrow_mode !== 'onchain' || !bounty.onchain_job_id) return null;
  const feeBps = Math.max(0, Math.min(10000, parseInt(process.env.PLATFORM_FEE_BPS || '0', 10) || 0));
  const budget = parseFloat(bounty.escrow_budget_usdc || bounty.amount_usdc || 0) || 0;
  const platformFeeUsdc = feeBps > 0 ? Math.floor(budget * feeBps / 10000 * 1e6) / 1e6 : 0;
  const contract = process.env.AGENTIC_COMMERCE_ADDRESS || null;
  const tx = (h) => (h ? `${ARC_EXPLORER}/tx/${h}` : null);
  return {
    mode: 'onchain',
    jobId: String(bounty.onchain_job_id),
    status: bounty.escrow_status,
    budgetUsdc: budget,
    feeBps,
    platformFeeUsdc,
    contract,
    fundTx: bounty.escrow_tx_hash || null,
    releaseTx: bounty.release_tx_hash || null,
    explorer: {
      contract: contract ? `${ARC_EXPLORER}/address/${contract}` : null,
      fund: tx(bounty.escrow_tx_hash),
      release: tx(bounty.release_tx_hash),
    },
  };
}

// GET /api/bounties/:id/escrow — Full escrow status
app.get('/api/bounties/:id/escrow', async (req, res) => {
  const bounty = await stmts.getBountyById(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  const events = await stmts.getEscrowEvents(req.params.id);
  const decisions = await stmts.getVerificationDecisions(req.params.id);
  res.json({ bounty, events, decisions, onchain: onchainEscrowSummary(bounty) });
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
    if (agentControlsBounty(agent, bounty)) {
      return res.status(409).json({ error: 'An agent cannot submit a proposal to its own bounty' });
    }
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

// GET /api/bounties/:id/proposals — Authenticated agent view.
app.get('/api/bounties/:id/proposals', requireAuth, async (req, res) => {
  try {
    const bounty = await stmts.getBountyById(req.params.id);
    if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
    const agent = await stmts.getAgentById(req.auth.agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const proposals = await stmts.getProposalsByBounty(req.params.id);
    const isCreator = agentControlsBounty(agent, bounty);
    const visible = isCreator
      ? proposals
      : proposals.filter((p) => p.proposer_agent_id === agent.id);

    res.json({ proposals: visible, isCreator });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/human/bounties/:id/proposals — Authenticated human view.
app.get('/api/human/bounties/:id/proposals', requireHuman, async (req, res) => {
  try {
    const callerWallet = req.human.wallet_address.toLowerCase();
    const bounty = await stmts.getBountyById(req.params.id);
    if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
    const proposals = await stmts.getProposalsByBounty(req.params.id);
    const isCreator = bounty.creator_wallet.toLowerCase() === callerWallet;
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
app.post('/api/bounties/:id/proposals/:proposalId/accept', requireAuth, async (req, res) => {
  const creator = await stmts.getAgentById(req.auth.agentId);
  if (!creator) return res.status(404).json({ error: 'Agent not found' });
  const callerWallet = creator.turnkey_address;
  if (!callerWallet) {
    return res.status(409).json({
      error: 'Create a managed wallet before accepting a proposal.',
      action_required: 'create_wallet',
    });
  }

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
    if (!agentControlsBounty(creator, bountyRow)) {
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
    const selectedAgent = (await client.query(
      'SELECT id, turnkey_address FROM agents WHERE id = $1',
      [propRow.proposer_agent_id]
    )).rows[0];
    if (!selectedAgent?.turnkey_address) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(409).json({
        error: 'Selected agent has no managed payment wallet',
        action_required: 'create_wallet_or_reject',
      });
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
    await logEscrowEvent(req.params.id, 'proposal_accepted', callerWallet, 'agent', `Proposal ${req.params.proposalId} accepted at ${acceptedPrice} USDC`, '');
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
app.post('/api/bounties/:id/proposals/:proposalId/reject', requireAuth, async (req, res) => {
  try {
    const { reason } = req.body;
    const creator = await stmts.getAgentById(req.auth.agentId);
    if (!creator) return res.status(404).json({ error: 'Agent not found' });
    const callerWallet = creator.turnkey_address;
    if (!callerWallet) {
      return res.status(409).json({
        error: 'Create a managed wallet before rejecting proposals.',
        action_required: 'create_wallet',
      });
    }

    const bounty = await stmts.getBountyById(req.params.id);
    if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
    if (!agentControlsBounty(creator, bounty)) {
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

async function sendBountyMessage(req, res, actor) {
  try {
    const { proposalId, message } = req.body;
    if (!proposalId || !message) {
      return res.status(400).json({ error: 'proposalId and message required' });
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

    const actorWallets = actor.wallets.map((wallet) => wallet.toLowerCase());
    const isCreator = actorWallets.includes(bounty.creator_wallet.toLowerCase());
    const isProposer = actor.agentId
      ? proposal.proposer_agent_id === actor.agentId
      : actorWallets.includes((proposal.proposer_wallet || '').toLowerCase());
    if (!isCreator && !isProposer) {
      return res.status(403).json({ error: 'Only the creator or proposer can use this thread' });
    }

    const caller = isCreator
      ? bounty.creator_wallet.toLowerCase()
      : (proposal.proposer_wallet || actorWallets[0]).toLowerCase();
    if (!(await checkRateLimit(actor.agentId || caller, 'bounty_message'))) {
      return res.status(429).json({ error: 'Rate limit exceeded — max 60 messages per hour' });
    }

    // Resolve recipient
    const toWallet = isCreator ? proposal.proposer_wallet : bounty.creator_wallet;
    const toAgentId = isCreator ? proposal.proposer_agent_id : null;
    const fromAgentId = actor.agentId || (isProposer ? proposal.proposer_agent_id : null);

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
}

// POST /api/bounties/:id/messages — Autonomous/delegated agent thread message.
app.post('/api/bounties/:id/messages', requireAuth, async (req, res) => {
  const agent = await stmts.getAgentById(req.auth.agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  return sendBountyMessage(req, res, {
    agentId: agent.id,
    wallets: [agent.turnkey_address, agent.owner_wallet].filter(Boolean),
  });
});

// POST /api/human/bounties/:id/messages — Authenticated human thread message.
app.post('/api/human/bounties/:id/messages', requireHuman, async (req, res) => (
  sendBountyMessage(req, res, {
    agentId: null,
    wallets: [req.human.wallet_address],
  })
));

async function getBountyMessages(req, res, actor) {
  try {
    const proposalId = req.query.proposalId;
    if (!proposalId) return res.status(400).json({ error: 'proposalId query param required' });

    const bounty = await stmts.getBountyById(req.params.id);
    if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
    const proposal = await stmts.getProposalById(proposalId);
    if (!proposal || proposal.bounty_id !== req.params.id) {
      return res.status(404).json({ error: 'Proposal not found' });
    }

    const actorWallets = actor.wallets.map((wallet) => wallet.toLowerCase());
    const isCreator = actorWallets.includes(bounty.creator_wallet.toLowerCase());
    const isProposer = actor.agentId
      ? proposal.proposer_agent_id === actor.agentId
      : actorWallets.includes((proposal.proposer_wallet || '').toLowerCase());
    if (!isCreator && !isProposer) {
      return res.status(403).json({ error: 'Only the creator or proposer can read this thread' });
    }

    const messages = await stmts.getBountyMessages(req.params.id, proposalId);
    const callerWallet = isCreator
      ? bounty.creator_wallet
      : proposal.proposer_wallet;
    // Mark unread messages addressed to caller as read
    await stmts.markMessagesRead(req.params.id, proposalId, callerWallet);

    res.json({ messages, isCreator, isProposer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/bounties/:id/messages?proposalId=... — Authenticated agent thread.
app.get('/api/bounties/:id/messages', requireAuth, async (req, res) => {
  const agent = await stmts.getAgentById(req.auth.agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  return getBountyMessages(req, res, {
    agentId: agent.id,
    wallets: [agent.turnkey_address, agent.owner_wallet].filter(Boolean),
  });
});

// GET /api/human/bounties/:id/messages?proposalId=... — Authenticated human thread.
app.get('/api/human/bounties/:id/messages', requireHuman, async (req, res) => (
  getBountyMessages(req, res, {
    agentId: null,
    wallets: [req.human.wallet_address],
  })
));

// ══════════════════════════════════════════════════════
// ── Swarms API Integration ──
// ══════════════════════════════════════════════════════

// POST /api/swarms/estimate — Estimate swarm execution cost
app.post('/api/swarms/estimate', requireSwarmsEnabled, requireAuth, async (req, res) => {
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
app.post('/api/swarms/validate-key', requireSwarmsEnabled, requireHuman, async (req, res) => {
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
app.get('/api/swarms/executions/:id', requireSwarmsEnabled, requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query('SELECT * FROM swarm_executions WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Execution not found' });
    }

    const execution = result.rows[0];
    const caller = await stmts.getAgentById(req.auth.agentId);
    const bounty = await stmts.getBountyById(execution.bounty_id);
    if (!caller || !bounty) {
      return res.status(404).json({ error: 'Execution owner context not found' });
    }
    if (caller.id !== execution.agent_id && !agentControlsBounty(caller, bounty)) {
      return res.status(403).json({ error: 'You cannot view this swarm execution' });
    }

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
app.post('/api/swarms/executions/:id/cancel', requireSwarmsEnabled, requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

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

    const caller = await stmts.getAgentById(req.auth.agentId);
    if (!caller) return res.status(404).json({ error: 'Calling agent not found' });

    // Authorization: the executing swarm agent or the bounty creator agent.
    const isCreator = agentControlsBounty(caller, bounty);
    const isExecutionAgent = caller.id === execution.agent_id;
    if (!isCreator && !isExecutionAgent) {
      return res.status(403).json({
        error: 'Only the bounty creator or executing swarm agent can cancel this execution'
      });
    }
    const callerWallet = caller.turnkey_address || caller.owner_wallet || '';

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
      'agent',
      `Swarm execution ${id} cancelled by ${isCreator ? 'bounty creator' : 'executing agent'}`,
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
app.post('/api/swarms/webhook', requireSwarmsEnabled, requireSwarmsWebhookSecret, async (req, res) => {
  try {
    const signature = String(
      req.headers['x-swarms-signature'] || req.headers['x-webhook-signature'] || ''
    );
    if (!signature) {
      console.error('Webhook signature missing');
      return res.status(401).json({ error: 'Webhook signature required' });
    }

    // Verify HMAC over the exact request bytes. Re-serializing req.body can
    // change whitespace or key ordering and reject a legitimate webhook.
    const payload = req.rawBody || Buffer.alloc(0);
    const expectedSignature = createHmac('sha256', SWARMS_WEBHOOK_SECRET)
      .update(payload)
      .digest('hex');
    const providedSignature = signature.startsWith('sha256=')
      ? signature.slice(7)
      : signature;
    if (!/^[0-9a-fA-F]{64}$/.test(providedSignature)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
    const expBuf = Buffer.from(expectedSignature, 'hex');
    const providedBuf = Buffer.from(providedSignature, 'hex');
    if (!timingSafeEqual(expBuf, providedBuf)) {
      console.error('Webhook signature verification failed');
      return res.status(401).json({ error: 'Invalid webhook signature' });
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
app.post('/api/agents/:id/skills', requireAuth, requireOwnAgent, async (req, res) => {
  const { skillName, category, description, keywords, hourlyRateUsdc, fixedRateUsdc } = req.body;
  if (!skillName) return res.status(400).json({ error: 'skillName required' });
  if (!(await checkRateLimit(req.params.id, 'skill_register'))) return res.status(429).json({ error: 'Rate limit exceeded' });

  const agent = await stmts.getAgentById(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

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
app.put('/api/agents/:id/skills/:skillId', requireAuth, requireOwnAgent, async (req, res) => {
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
app.delete('/api/agents/:id/skills/:skillId', requireAuth, requireOwnAgent, async (req, res) => {
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
    kind: 'agent',
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
  runOrphanAudit();
  setInterval(runOrphanAudit, 24 * 60 * 60 * 1000);

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
