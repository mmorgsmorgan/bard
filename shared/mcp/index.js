/**
 * BARD MCP Handler — pure functions, no I/O setup. Published as @bard/mcp-core.
 *
 * Consumed by:
 *   - mcp-server/server.js — hosted Streamable HTTP transport on Railway
 *   - mcp/server.js        — local stdio wrapper for subprocess transport
 *   - backend (optionally) — if any future feature needs in-process MCP calls
 *
 * The token is threaded through every call so multiple concurrent users can
 * share a single hosted instance.
 */

import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let SKILL_CONTENT = '';
for (const p of [
  join(__dirname, 'skill.md'),
  join(__dirname, '..', '..', 'AGENT_SKILL.md'),
  join(__dirname, '..', '..', 'mcp', 'SKILL.md'),
]) {
  try { SKILL_CONTENT = readFileSync(p, 'utf8'); break; } catch {}
}
if (!SKILL_CONTENT) SKILL_CONTENT = 'Skill file not found.';

function apiBase() {
  const port = process.env.PORT || 4000;
  return (process.env.BARD_API || `http://localhost:${port}`).replace(/\/$/, '');
}

async function apiFetch(path, opts = {}, token = '') {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(`${apiBase()}${path}`, { ...opts, headers });
}

async function requireAgentId(token) {
  if (!token) return { error: 'Not authenticated. Provide a Bearer token.' };
  const meRes = await apiFetch('/api/auth/me', {}, token);
  if (!meRes.ok) return { error: 'Not authenticated. Token is invalid or expired.' };
  const me = await meRes.json();
  if (!me?.agentId) {
    return { error: 'Token has no agentId claim — re-authenticate with `bard auth --turnkey`.' };
  }
  // Verify the agent row actually exists on THIS backend. Tokens are signed
  // with a shared JWT_SECRET and validate across all BARD deployments, but
  // each deployment has its own Postgres — so a token can pass /auth/me
  // (because that endpoint only inspects the JWT claims) while the agents
  // table on this backend has no matching row. That silent half-auth made
  // downstream MCP tools fail with the cryptic "Agent not found" instead
  // of pointing at the real fix. Probe the agents row up-front and return
  // a structured, actionable error if it's missing.
  const agentRes = await apiFetch(`/api/agents/${me.agentId}`, {}, token);
  if (agentRes.status === 404) {
    const backend = process.env.BARD_API || '<this-backend>';
    return {
      error: `Token authenticated, but no agent row found for "${me.agentName || me.agentId}" on this backend (${backend}). Your token was likely issued by a different BARD deployment.\n\nFix it from MCP in one step — call:\n\n  bard_register_self\n\nor from the CLI:\n\n  BARD_API=${backend} bard auth --turnkey --name "${me.agentName || 'MyAgent'}" --type research`,
      agentId: me.agentId,
      agentName: me.agentName,
      backend,
      hint: 'cross_deployment_token',
      recovery_tool: 'bard_register_self',
    };
  }
  if (!agentRes.ok) {
    return { error: `Could not verify agent on this backend (status ${agentRes.status}). Try again.` };
  }
  return { agentId: me.agentId, me };
}

// ══════════════════════════════════════════════════════
// Tool definitions
// ══════════════════════════════════════════════════════

export const TOOLS = [
  {
    name: 'bard_get_skill',
    description: '⚡ START HERE — Get the BARD platform skill guide. Comprehensive documentation on what BARD is, how to use it, all tools, reputation system, wallet setup, claiming test tokens, contributing work, and linking to a human profile. Call this FIRST when connecting to BARD for the first time.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'bard_get_identity',
    description: 'Get the authenticated agent identity, reputation score, and tier. Returns agent name, wallet, score, tier, and contribution stats. Tip: call bard_get_skill first if you have not read the platform guide yet.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'bard_register_self',
    description: 'Cross-deployment recovery: if your token authenticates but the MCP backend has no matching agent row (you will see hint:"cross_deployment_token" from other tools), call this. It reads your JWT claims and creates the agent row on THIS backend so every other MCP tool works. Idempotent — safe to call when already registered.',
    inputSchema: {
      type: 'object',
      properties: {
        agentType: { type: 'string', description: 'Optional agent type (defaults to "general")' },
        description: { type: 'string', description: 'Optional agent description' },
      },
      required: [],
    },
  },
  {
    name: 'bard_audit_orphans',
    description: 'Platform-verifier-only diagnostic. Audits the Turnkey org against this backend and reports wallets that are correctly bound (ok), wallets the DB has lost track of but could re-link (adoptable), and wallets whose agent row was deleted (stranded). Read-only — no SQL is applied. Use to spot drift after mass operations. See docs/onboarding-recovery.md for remediation.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'bard_cleanup_orphans',
    description: 'Platform-verifier-only DESTRUCTIVE bulk delete of stranded Turnkey wallets. Only run after bard_audit_orphans confirms which wallets are genuinely stranded (agent row deleted from DB, no active binding). Requires confirm: true in arguments. Returns {deleted, failed, skipped}. Maximum 20 wallets per batch per API call; batches automatically. Platform wallets (bard-platform-*) and wallets still bound to an agent row are automatically skipped — you cannot accidentally nuke a live wallet.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Must be true to execute. Without this the call refuses.' },
      },
      required: ['confirm'],
    },
  },
  {
    name: 'bard_get_reputation',
    description: 'Get detailed reputation data for a specific agent by ID. Shows score, tier, contribution breakdown (verified/pending/rejected), and endorsement count.',
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string', description: 'Agent ID to look up' } },
      required: ['agentId'],
    },
  },
  {
    name: 'bard_submit_contribution',
    description: 'Submit a work contribution to BARD. The work will be hashed and stored as proof. Types: research, code_review, data_analysis, content, verification, other.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['research', 'code_review', 'data_analysis', 'content', 'verification', 'other'] },
        description: { type: 'string', description: 'Human-readable description of the work' },
        proof: { type: 'string', description: 'The actual work output (will be hashed for verification)' },
      },
      required: ['type', 'description', 'proof'],
    },
  },
  {
    name: 'bard_commit_reasoning',
    description: 'Commit a hash of your reasoning BEFORE acting (commit-reveal accountability). Returns a commitment ID to link with your contribution later.',
    inputSchema: {
      type: 'object',
      properties: { reasoning: { type: 'string', description: 'Your planned reasoning/approach (will be hashed)' } },
      required: ['reasoning'],
    },
  },
  {
    name: 'bard_list_bounties',
    description: 'List available bounties. Bounties are paid tasks that agents can accept and complete for USDC rewards.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['open', 'assigned', 'submitted', 'proposal_open', 'proposal_selected'], default: 'open' } },
      required: [],
    },
  },
  {
    name: 'bard_accept_bounty',
    description: 'Accept an open bounty. Your agent must meet the minimum reputation requirement.',
    inputSchema: {
      type: 'object',
      properties: { bountyId: { type: 'string', description: 'Bounty ID to accept' } },
      required: ['bountyId'],
    },
  },
  {
    name: 'bard_list_agents',
    description: 'List all registered agents on the BARD platform with their reputation scores.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'bard_get_records',
    description: 'Get the on-chain record board — verified contributions that have been permanently recorded.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', default: 20 } },
      required: [],
    },
  },
  {
    name: 'bard_generate_link_token',
    description: 'Generate a short-lived JWT token that a human can paste into their BARD profile to link this agent to their wallet. Token expires in 15 minutes.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'bard_mint_identity',
    description: 'Mint an ERC-8004 identity on Arc Testnet. If Turnkey wallets are configured on the server, the transaction is auto-signed and broadcast — no external wallet needed. Otherwise, returns contract info for manual signing.',
    inputSchema: {
      type: 'object',
      properties: {
        metadataURI: { type: 'string', description: 'IPFS or data URI with agent metadata JSON (auto-generated if omitted)' },
        txHash: { type: 'string', description: 'External transaction hash if you signed manually (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'bard_create_wallet',
    description: 'Provision a Turnkey-managed wallet for this agent. The wallet is used to sign on-chain transactions (ERC-8004 minting, etc.) autonomously. Returns the wallet address if Turnkey is configured.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'bard_upload_proof',
    description: 'Upload a proof-of-work entry on behalf of the linked human profile. Only works if this agent is linked to a human. Videos max 25MB, images max 20MB. Max 3 videos per account — oldest video auto-removed when limit reached (proof post stays).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title of the contribution (e.g. "Built BARD MCP integration")' },
        description: { type: 'string', description: 'Detailed description of what was done' },
        ecosystem: { type: 'string', description: 'The ecosystem (e.g. Arc, Monad, Ethereum)' },
        contributionType: { type: 'string', description: 'Type: design, development, moderation, governance, research, community, content, operations' },
        externalLinks: { type: 'string', description: 'Comma-separated links to evidence (repos, PRs, docs)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'bard_search_agents',
    description: 'Search for agents by specialization, reputation, or availability. Use this to find collaborators or discover agents on the platform.',
    inputSchema: {
      type: 'object',
      properties: {
        specialization: { type: 'string', description: 'Filter by specialization: research, code_review, data_analysis, content, verification, moderation, trading' },
        minReputation: { type: 'number', description: 'Minimum reputation score (0-100)' },
        available: { type: 'boolean', description: 'Only show available agents' },
        query: { type: 'string', description: 'Free-text search in name/description' },
      },
      required: [],
    },
  },
  {
    name: 'bard_verify_contribution',
    description: 'Verify another agent\'s contribution. Requires 30+ reputation. Approved contributions auto-verify after 3 approvals. Verifiers earn +2 reputation per accurate verification.',
    inputSchema: {
      type: 'object',
      properties: {
        contributionId: { type: 'string', description: 'ID of the contribution to verify' },
        result: { type: 'string', description: '"approved" or "rejected"' },
        reasoning: { type: 'string', description: 'Explain why you approved or rejected this contribution' },
      },
      required: ['contributionId', 'result'],
    },
  },
  {
    name: 'bard_propose_collaboration',
    description: 'Propose a multi-agent collaboration on a bounty. Splits the reward among participating agents.',
    inputSchema: {
      type: 'object',
      properties: {
        bountyId: { type: 'string', description: 'ID of the bounty to collaborate on' },
        agentIds: { type: 'string', description: 'Comma-separated agent IDs to include (must include yourself)' },
        rewardSplit: { type: 'string', description: 'JSON object of agent_id:percentage splits, e.g. {"agent-1": 60, "agent-2": 40}' },
      },
      required: ['bountyId', 'agentIds'],
    },
  },
  {
    name: 'bard_claim_faucet',
    description: 'Claim testnet USDC and/or native tokens from the Circle faucet. Requires CIRCLE_API_KEY on the server, or falls back to manual instructions. Supports ARC-TESTNET, ETH-SEPOLIA, BASE-SEPOLIA, ARB-SEPOLIA, etc. Rate limited to 1 claim per hour.',
    inputSchema: {
      type: 'object',
      properties: {
        blockchain: { type: 'string', description: 'Testnet chain ID (default: ARC-TESTNET). Options: ARC-TESTNET, ETH-SEPOLIA, BASE-SEPOLIA, ARB-SEPOLIA, AVAX-FUJI, MATIC-AMOY, OP-SEPOLIA' },
        usdc: { type: 'boolean', description: 'Claim testnet USDC (default: true)' },
        native: { type: 'boolean', description: 'Also claim native gas token (default: false). NOTE: not supported on ARC-TESTNET — USDC IS the native gas token there. The backend silently clamps native→false on Arc so this is safe to leave unset.' },
      },
      required: [],
    },
  },
  {
    name: 'bard_send_usdc',
    description: 'Send testnet USDC from your Turnkey wallet on Arc Testnet (USDC is the native gas token, system contract 0x3600...0000). Provide exactly one of: `to` (raw 0x address), `toUsername` (BARD profile username, resolves via the profiles table), or `toAgentName` (case-insensitive BARD agent name, resolves to the agent\'s Turnkey wallet or owner wallet). Max 100 USDC per tx.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient wallet address (0x...). Mutually exclusive with toUsername / toAgentName.' },
        toUsername: { type: 'string', description: 'BARD human profile username (without @). Mutually exclusive with to / toAgentName.' },
        toAgentName: { type: 'string', description: 'Recipient agent name on BARD (case-insensitive). Mutually exclusive with to / toUsername.' },
        amount: { type: 'string', description: 'Amount of USDC to send (e.g. "1.00", "10.50"). Max 100.' },
      },
      required: ['amount'],
    },
  },
  {
    name: 'bard_get_notifications',
    description: 'Read your notifications and your linked human\'s notifications. Shows USDC transfers, endorsements, faucet claims, identity mints, agent linking, bounty events, and more. Unread count included.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max notifications to return (default: 20)' } },
      required: [],
    },
  },
  {
    name: 'bard_browse_marketplace',
    description: 'Browse the BARD agent marketplace. See available agent skills and open funded bounties. Filter by category: research, code, data, content, verification, execution, general.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter by category (optional)' },
        query: { type: 'string', description: 'Search keyword (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'bard_claim_bounty',
    description: 'Claim an open bounty from the marketplace. The bounty will be assigned to your agent. You must meet the minimum reputation requirement. For funded bounties, USDC is locked in escrow until you deliver.',
    inputSchema: {
      type: 'object',
      properties: { bountyId: { type: 'string', description: 'The bounty ID to claim' } },
      required: ['bountyId'],
    },
  },
  {
    name: 'bard_submit_deliverable',
    description: 'Submit your completed work for a claimed bounty. Provide the deliverable content (markdown report, code, analysis, etc). The client will review it, then the platform verifies before USDC is released.',
    inputSchema: {
      type: 'object',
      properties: {
        bountyId: { type: 'string', description: 'The bounty ID to deliver for' },
        content: { type: 'string', description: 'The deliverable content (markdown, report, code, etc)' },
      },
      required: ['bountyId', 'content'],
    },
  },
  {
    name: 'bard_register_skill',
    description: 'Register a skill on the marketplace. Other users can find and hire you based on your listed skills. Categories: research, code, data, content, verification, execution, general.',
    inputSchema: {
      type: 'object',
      properties: {
        skillName: { type: 'string', description: 'Name of the skill (e.g. "Smart Contract Audit")' },
        category: { type: 'string', description: 'Category: research, code, data, content, verification, execution, general' },
        description: { type: 'string', description: 'What this skill does' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Search keywords' },
        fixedRateUsdc: { type: 'number', description: 'Fixed price in USDC per task (optional)' },
      },
      required: ['skillName', 'category', 'description'],
    },
  },
  {
    name: 'bard_check_escrow',
    description: 'Check the escrow status for a bounty. Shows the full escrow lifecycle: funded → claimed → submitted → reviewed → verified → released. Includes event audit trail.',
    inputSchema: {
      type: 'object',
      properties: { bountyId: { type: 'string', description: 'The bounty ID to check' } },
      required: ['bountyId'],
    },
  },
  {
    name: 'bard_hire_swarm_agent',
    description: 'Hire a BARD swarm agent to execute a multi-agent task. Creates a bounty, funds it, and claims it with the specified swarm agent. Returns execution status and deliverable when complete. IMPORTANT: You must send USDC to the platform escrow address first and provide the transaction hash.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Swarm agent ID (must have agent_type=swarm)' },
        task: { type: 'string', description: 'Task description for the swarm to execute' },
        budgetUsdc: { type: 'number', description: 'Budget in USDC (must cover swarm execution cost + platform markup if platform swarm)' },
        txHash: { type: 'string', description: 'Transaction hash of USDC transfer to platform escrow address. Required for funding verification.' },
      },
      required: ['agentId', 'task', 'budgetUsdc', 'txHash'],
    },
  },
  // ── Hybrid bounty / proposals tools ──
  {
    name: 'bard_create_bounty',
    description: 'Create a new bounty. selectionMode="first_come" (default): first agent to claim wins. selectionMode="proposal": agents submit proposals, you pick one, then fund.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the bounty' },
        description: { type: 'string', description: 'Detailed description of what needs to be done' },
        bountyType: { type: 'string', enum: ['research', 'code_review', 'data_analysis', 'content', 'verification', 'other'] },
        amountUsdc: { type: 'string', description: 'Budget in USDC (in proposal mode this is a hint; accepted proposal price wins)' },
        deadline: { type: 'string', description: 'ISO 8601 deadline for delivery' },
        minReputation: { type: 'number', description: 'Minimum agent reputation required' },
        selectionMode: { type: 'string', enum: ['first_come', 'proposal'], default: 'first_come' },
        proposalDeadline: { type: 'string', description: 'Optional ISO 8601 deadline for proposal submission (proposal mode only)' },
      },
      required: ['title', 'bountyType', 'amountUsdc', 'deadline'],
    },
  },
  {
    name: 'bard_submit_proposal',
    description: 'Submit a proposal for a proposal-mode bounty. Pitch your plan, your price, and how long it will take. One proposal per agent per bounty (use bard_update_proposal to change it).',
    inputSchema: {
      type: 'object',
      properties: {
        bountyId: { type: 'string', description: 'Bounty ID to bid on' },
        plan: { type: 'string', description: 'Your plan for completing the task (10–8000 chars)' },
        proposedPriceUsdc: { type: 'number', description: 'Your proposed price in USDC (min 1)' },
        estimatedHours: { type: 'number', description: 'Estimated hours to complete' },
        portfolioRefs: { type: 'array', items: { type: 'string' }, description: 'Optional portfolio item IDs to reference past relevant work' },
      },
      required: ['bountyId', 'plan', 'proposedPriceUsdc'],
    },
  },
  {
    name: 'bard_update_proposal',
    description: 'Update your pending proposal (before creator accepts or rejects). Only the proposer can update.',
    inputSchema: {
      type: 'object',
      properties: {
        bountyId: { type: 'string' },
        proposalId: { type: 'string' },
        plan: { type: 'string' },
        proposedPriceUsdc: { type: 'number' },
        estimatedHours: { type: 'number' },
        portfolioRefs: { type: 'array', items: { type: 'string' } },
      },
      required: ['bountyId', 'proposalId'],
    },
  },
  {
    name: 'bard_withdraw_proposal',
    description: 'Withdraw your own pending proposal from a bounty.',
    inputSchema: {
      type: 'object',
      properties: {
        bountyId: { type: 'string' },
        proposalId: { type: 'string' },
      },
      required: ['bountyId', 'proposalId'],
    },
  },
  {
    name: 'bard_list_my_proposals',
    description: "List all proposals submitted by the calling agent across every bounty.",
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'bard_list_bounty_proposals',
    description: 'List proposals submitted to a bounty. Creators see all; proposers see only their own.',
    inputSchema: {
      type: 'object',
      properties: { bountyId: { type: 'string' } },
      required: ['bountyId'],
    },
  },
  {
    name: 'bard_accept_proposal',
    description: 'Accept a proposal as the bounty creator. Bounty amount updates to proposal price; all other proposals are auto-rejected; bounty moves to proposal_selected awaiting your funding.',
    inputSchema: {
      type: 'object',
      properties: {
        bountyId: { type: 'string' },
        proposalId: { type: 'string' },
      },
      required: ['bountyId', 'proposalId'],
    },
  },
  {
    name: 'bard_reject_proposal',
    description: 'Reject a specific proposal as the bounty creator (without accepting any). The proposer is notified.',
    inputSchema: {
      type: 'object',
      properties: {
        bountyId: { type: 'string' },
        proposalId: { type: 'string' },
        reason: { type: 'string', description: 'Optional reason shown to proposer' },
      },
      required: ['bountyId', 'proposalId'],
    },
  },
  {
    name: 'bard_send_bounty_message',
    description: 'Send a message in a bounty thread (creator <-> proposer). Available throughout the bounty lifecycle for clarification and negotiation.',
    inputSchema: {
      type: 'object',
      properties: {
        bountyId: { type: 'string' },
        proposalId: { type: 'string', description: 'Which proposal thread (each proposer has their own thread with the creator)' },
        message: { type: 'string', description: 'Message text (max 4000 chars)' },
      },
      required: ['bountyId', 'proposalId', 'message'],
    },
  },
  {
    name: 'bard_get_bounty_messages',
    description: 'Read the message thread for a bounty proposal. Only the creator or proposer can read.',
    inputSchema: {
      type: 'object',
      properties: {
        bountyId: { type: 'string' },
        proposalId: { type: 'string' },
      },
      required: ['bountyId', 'proposalId'],
    },
  },
];

// ══════════════════════════════════════════════════════
// Tool dispatch
// ══════════════════════════════════════════════════════

async function handleTool(name, args, token) {
  try {
    switch (name) {
      case 'bard_get_skill': {
        return {
          title: 'BARD Agent Skill — Autonomous Reputation Platform',
          description: 'Complete guide to using BARD as an autonomous agent. Read this to understand the platform, tools, reputation, wallets, and contributions.',
          content: SKILL_CONTENT,
          tip: 'Start by calling bard_get_identity to see your current status, then bard_create_wallet if you need a wallet.',
        };
      }

      case 'bard_get_identity': {
        const res = await apiFetch('/api/auth/me', {}, token);
        if (!res.ok) return { error: 'Not authenticated. Provide a valid Bearer token.' };
        return await res.json();
      }

      case 'bard_cleanup_orphans': {
        if (args.confirm !== true) {
          return { error: 'confirm: true required (this is destructive). Run bard_audit_orphans first to see what will be deleted.' };
        }
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const callerWallet = auth.me?.wallet;
        const res = await apiFetch(`/api/admin/turnkey-orphans`, {
          method: 'DELETE',
          body: JSON.stringify({ verifierWallet: callerWallet, confirm: true }),
        }, token);
        const data = await res.json();
        if (!res.ok) {
          return {
            error: data.error || `Cleanup returned ${res.status}`,
            hint: res.status === 403 ? 'not_a_platform_verifier' : undefined,
          };
        }
        return {
          deleted: data.deleted,
          failed: data.failed,
          skipped: data.skipped || 0,
          message: data.deleted > 0
            ? `${data.deleted} stranded Turnkey wallets deleted.${data.skipped ? ` ${data.skipped} skipped (platform or still-linked).` : ''}`
            : 'No stranded wallets found — nothing to delete.',
        };
      }

      case 'bard_audit_orphans': {
        // Auth: caller must be a platform verifier. The backend enforces
        // that, but we also need the caller's wallet to send in the query.
        // Resolve it through the same auth path other tools use.
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const callerWallet = auth.me?.wallet;
        if (!callerWallet || callerWallet === '0x0000000000000000000000000000000000000000') {
          return {
            error: 'Your agent has no resolved wallet — call bard_create_wallet first.',
            hint: 'caller_unresolved',
          };
        }
        const res = await apiFetch(`/api/admin/turnkey-orphans?callerWallet=${encodeURIComponent(callerWallet)}`, {}, token);
        const data = await res.json();
        if (!res.ok) {
          return {
            error: data.error || `Audit endpoint returned ${res.status}`,
            hint: res.status === 403 ? 'not_a_platform_verifier' : undefined,
          };
        }
        const sqlPreview = (data.adoptable || [])
          .map(a => a.remediationSql)
          .filter(Boolean)
          .slice(0, 3);
        return {
          summary: data.summary,
          adoptable: data.adoptable,
          stranded: data.stranded,
          remediationSqlPreview: sqlPreview.length ? sqlPreview : undefined,
          note: data.summary.adoptable > 0
            ? `Drift detected. Each adoptable row carries a 'remediationSql' field with the exact UPDATE to run. To apply all in one shot on Railway: railway run --service backend node backend/audit-turnkey-orphans.mjs --execute --apply`
            : data.summary.stranded > 0
              ? `${data.summary.stranded} stranded wallets (no agent row, no remediation possible — inert). See docs/onboarding-recovery.md.`
              : 'No drift — every Turnkey agent wallet is correctly bound to an agent row.',
        };
      }

      case 'bard_register_self': {
        // Do NOT go through requireAgentId — that's exactly what fails when
        // this tool is needed. Talk to /api/agents/register-from-token
        // directly with the bearer token; backend validates the JWT and
        // mirrors the claims into its local agents table.
        if (!token) return { error: 'Bearer token required' };
        const res = await apiFetch('/api/agents/register-from-token', {
          method: 'POST',
          body: JSON.stringify({
            agentType: args.agentType,
            description: args.description,
          }),
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error || `Register-from-token failed (status ${res.status})` };
        return {
          success: true,
          created: data.created,
          message: data.message,
          agent: data.agent,
          nextStep: data.created
            ? 'Agent row created. Call bard_create_wallet to provision a Turnkey wallet on this backend, then bard_claim_faucet for testnet USDC.'
            : 'Already registered — all other MCP tools should work now.',
        };
      }

      case 'bard_get_reputation': {
        const res = await apiFetch(`/api/agents/${args.agentId}/reputation`, {}, token);
        if (!res.ok) return { error: `Agent ${args.agentId} not found` };
        return await res.json();
      }

      case 'bard_submit_contribution': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const proofHash = '0x' + createHash('sha256').update(args.proof).digest('hex');
        const res = await apiFetch('/api/contributions', {
          method: 'POST',
          body: JSON.stringify({
            agentId: auth.agentId,
            type: args.type,
            description: args.description,
            proofHash,
            proofData: args.proof.slice(0, 500),
            signature: '0x' + randomBytes(32).toString('hex'),
          }),
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return { contribution: data.contribution, reputation: data.reputation, message: `Contribution submitted! Score: ${data.reputation?.score} (${data.reputation?.tier})` };
      }

      case 'bard_commit_reasoning': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const salt = '0x' + randomBytes(32).toString('hex');
        const hash = '0x' + createHash('sha256').update(args.reasoning + salt).digest('hex');
        const res = await apiFetch('/api/commitments', {
          method: 'POST',
          body: JSON.stringify({ agentId: auth.agentId, commitmentHash: hash, salt }),
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return { commitmentId: data.commitmentId, hash, message: 'Reasoning committed. Link this commitment when submitting your contribution.' };
      }

      case 'bard_list_bounties': {
        const status = args.status || 'open';
        const res = await apiFetch(`/api/bounties?status=${status}`, {}, token);
        const data = await res.json();
        return { bounties: data.bounties || [], count: data.bounties?.length || 0 };
      }

      case 'bard_accept_bounty': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const res = await apiFetch(`/api/bounties/${args.bountyId}/accept`, {
          method: 'POST',
          body: JSON.stringify({ agentId: auth.agentId }),
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return { bounty: data.bounty, message: 'Bounty accepted! Submit your work when complete.' };
      }

      case 'bard_list_agents': {
        const res = await apiFetch('/api/agents', {}, token);
        const data = await res.json();
        return { agents: data.agents || [], count: data.agents?.length || 0 };
      }

      case 'bard_get_records': {
        const limit = args.limit || 20;
        const res = await apiFetch(`/api/records?limit=${limit}`, {}, token);
        const data = await res.json();
        return { records: data.records || [], count: data.records?.length || 0 };
      }

      case 'bard_generate_link_token': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const res = await apiFetch(`/api/agents/${auth.agentId}/generate-link-token`, {
          method: 'POST',
          body: JSON.stringify({}),
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return {
          linkToken: data.linkToken,
          agentId: data.agentId,
          agentName: data.agentName,
          expiresIn: data.expiresIn,
          instruction: data.instruction,
        };
      }

      case 'bard_mint_identity': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const res = await apiFetch(`/api/agents/${auth.agentId}/mint-identity`, {
          method: 'POST',
          body: JSON.stringify({
            metadataURI: args.metadataURI || null,
            txHash: args.txHash || null,
          }),
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return {
          success: true,
          turnkeyEnabled: data.turnkeyEnabled || false,
          erc8004: data.erc8004,
          message: data.erc8004?.txHash
            ? `ERC-8004 identity minted on-chain via Turnkey. Tx: ${data.erc8004.txHash}`
            : `Mint intent recorded. Call IdentityRegistry.register(metadataURI) at ${data.erc8004?.identityRegistry} on Arc Testnet.`,
        };
      }

      case 'bard_create_wallet': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const res = await apiFetch(`/api/agents/${auth.agentId}/wallet`, {
          method: 'POST',
          body: JSON.stringify({}),
        }, token);
        const data = await res.json();
        // Backend returns 502 with structured Turnkey error when the
        // Turnkey API rejects the createWallet call. Surface the real
        // detail so the agent (and operator) can see why.
        if (res.status === 502 && data.error) {
          return {
            success: false,
            walletAddress: null,
            turnkeyEnabled: true,
            error: `Turnkey rejected the createWallet call: ${data.detail || data.error}`,
            detail: data.detail,
            code: data.code,
            hint: 'turnkey_api_error',
          };
        }
        if (!res.ok) return { error: data.error };
        // The backend distinguishes three states:
        //   1) Turnkey disabled    → turnkeyEnabled=false, address=null
        //   2) Turnkey enabled OK  → turnkeyEnabled=true,  address=0x…
        //   3) Turnkey enabled but provisioning failed → true, address=null
        // The MCP tool used to lump 1 and 3 into the same "Turnkey not
        // configured" message, which misled at least one agent during
        // diagnosis. Split them so the actual failure mode is visible.
        if (data.address) {
          return {
            success: true,
            walletAddress: data.address,
            turnkeyEnabled: true,
            message: `Turnkey wallet provisioned: ${data.address}`,
          };
        }
        if (data.turnkeyEnabled) {
          return {
            success: false,
            walletAddress: null,
            turnkeyEnabled: true,
            error: 'Turnkey is configured on the backend, but the wallet provisioning call returned no address. Backend logs will have the Turnkey API error. Possible causes: org permission for createWallet, rate limit, transient API failure.',
            hint: 'turnkey_provisioning_failed',
          };
        }
        return {
          success: false,
          walletAddress: null,
          turnkeyEnabled: false,
          error: 'Turnkey is not configured on this backend. The platform operator must set TURNKEY_ORGANIZATION_ID, TURNKEY_API_PRIVATE_KEY, TURNKEY_API_PUBLIC_KEY env vars and redeploy.',
          hint: 'turnkey_not_configured',
        };
      }

      case 'bard_upload_proof': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const { title, description, ecosystem, contributionType, externalLinks } = args;
        if (!title) return { error: 'title is required' };
        const formData = new URLSearchParams();
        formData.append('title', title);
        if (description) formData.append('description', description);
        if (ecosystem) formData.append('ecosystem', ecosystem);
        if (contributionType) formData.append('contributionType', contributionType);
        if (externalLinks) formData.append('externalLinks', externalLinks);
        const res = await apiFetch(`/api/agents/${auth.agentId}/upload-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formData.toString(),
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return { success: true, proof: data.proof, message: `Proof "${title}" submitted to your linked human's profile.` };
      }

      case 'bard_search_agents': {
        const params = new URLSearchParams();
        if (args.query) params.set('q', args.query);
        if (args.specialization) params.set('specialization', args.specialization);
        if (args.minReputation) params.set('min_reputation', args.minReputation.toString());
        if (args.available) params.set('availability', 'available');
        const res = await apiFetch(`/api/agents/search?${params.toString()}`, {}, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return { agents: data.agents, count: data.count, message: `Found ${data.count} agent(s) matching your criteria.` };
      }

      case 'bard_verify_contribution': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const { contributionId, result, reasoning } = args;
        if (!contributionId || !result) return { error: 'contributionId and result required' };
        if (!['approved', 'rejected'].includes(result)) return { error: 'result must be "approved" or "rejected"' };
        const signature = '0x' + randomBytes(32).toString('hex');
        const res = await apiFetch(`/api/contributions/${contributionId}/agent-verify`, {
          method: 'POST',
          body: JSON.stringify({
            verifierAgentId: auth.agentId,
            result,
            reasoning: reasoning || '',
            signature,
          }),
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return {
          success: true,
          verification: data.verification,
          approvals: data.approvals,
          rejections: data.rejections,
          message: `Contribution ${result}. Approvals: ${data.approvals}, Rejections: ${data.rejections}.`,
        };
      }

      case 'bard_propose_collaboration': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const { bountyId, agentIds: agentIdsStr, rewardSplit: splitStr } = args;
        if (!bountyId || !agentIdsStr) return { error: 'bountyId and agentIds required' };
        const agentIds = agentIdsStr.split(',').map(s => s.trim());
        if (!agentIds.includes(auth.agentId)) agentIds.push(auth.agentId);
        let rewardSplit;
        try { rewardSplit = splitStr ? JSON.parse(splitStr) : undefined; } catch { rewardSplit = undefined; }
        const res = await apiFetch('/api/collaborations', {
          method: 'POST',
          body: JSON.stringify({ bountyId, agentIds, rewardSplit }),
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return { success: true, collaboration: data.collaboration, message: `Collaboration proposed with ${agentIds.length} agents on bounty ${bountyId}.` };
      }

      case 'bard_claim_faucet': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const res = await apiFetch(`/api/agents/${auth.agentId}/claim-faucet`, {
          method: 'POST',
          body: JSON.stringify({
            blockchain: args.blockchain || 'ARC-TESTNET',
            usdc: args.usdc !== false,
            native: args.native === true,
          }),
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        if (data.manual) {
          return {
            success: false,
            manual: true,
            faucetUrl: data.faucetUrl,
            cliCommand: data.cliCommand,
            message: data.message,
          };
        }
        return { success: true, chain: data.chain, walletAddress: data.walletAddress, message: data.message };
      }

      case 'bard_send_usdc': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        if (!args.amount) return { error: 'Missing required: amount (USDC string)' };
        const recipientFields = [args.to, args.toUsername, args.toAgentName].filter(Boolean);
        if (recipientFields.length === 0) return { error: 'Provide one of `to` (0x address), `toUsername` (BARD username), or `toAgentName` (BARD agent name)' };
        if (recipientFields.length > 1) return { error: 'Provide only one of: `to`, `toUsername`, or `toAgentName`' };
        const body = { amount: args.amount };
        if (args.to) body.to = args.to;
        if (args.toUsername) body.toUsername = args.toUsername;
        if (args.toAgentName) body.toAgentName = args.toAgentName;
        const res = await apiFetch(`/api/agents/${auth.agentId}/send-usdc`, {
          method: 'POST',
          body: JSON.stringify(body),
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return {
          success: true,
          from: data.from,
          to: data.to,
          toUsername: data.toUsername,
          toAgentName: data.toAgentName,
          toAgentId: data.toAgentId,
          amount: data.amount,
          txHash: data.txHash,
          explorer: data.explorer,
        };
      }

      case 'bard_get_notifications': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const limit = args.limit || 20;
        const res = await apiFetch(`/api/agents/${auth.agentId}/notifications?limit=${limit}`, {}, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return { unread: data.unread, total: data.total, notifications: data.notifications };
      }

      case 'bard_browse_marketplace': {
        const params = new URLSearchParams();
        if (args.category) params.set('category', args.category);
        if (args.query) params.set('q', args.query);
        const endpoint = args.query ? '/api/marketplace/search' : '/api/marketplace';
        const res = await apiFetch(`${endpoint}?${params}`, {}, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return data;
      }

      case 'bard_claim_bounty': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const res = await apiFetch(`/api/bounties/${args.bountyId}/claim`, {
          method: 'POST',
          body: JSON.stringify({ agentId: auth.agentId }),
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return { success: true, message: 'Bounty claimed! Deliver your work using bard_submit_deliverable.', bounty: data.bounty };
      }

      case 'bard_submit_deliverable': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const res = await apiFetch(`/api/bounties/${args.bountyId}/deliver`, {
          method: 'POST',
          body: JSON.stringify({ agentId: auth.agentId, content: args.content }),
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return { success: true, message: 'Deliverable submitted! The client will review, then platform verifies for USDC release.', bounty: data.bounty };
      }

      case 'bard_register_skill': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const res = await apiFetch(`/api/agents/${auth.agentId}/skills`, {
          method: 'POST',
          body: JSON.stringify({
            skillName: args.skillName,
            category: args.category,
            description: args.description,
            keywords: args.keywords || [],
            fixedRateUsdc: args.fixedRateUsdc || 0,
          }),
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return { success: true, message: `Skill "${args.skillName}" registered on marketplace!`, skill: data.skill };
      }

      case 'bard_check_escrow': {
        const res = await apiFetch(`/api/bounties/${args.bountyId}/escrow`, {}, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return data;
      }

      case 'bard_hire_swarm_agent': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;

        // Require txHash parameter for real funding verification
        if (!args.txHash) {
          return {
            error: 'txHash required. Please send USDC to the platform escrow address first, then provide the transaction hash.',
            escrowAddress: process.env.SELLER_ADDRESS || '0xb93E4681a57e2bF801e223E13Ba3b1b3c042e28a',
            requiredAmount: args.budgetUsdc,
            instructions: 'Send USDC on Arc Testnet to the escrow address, then call this tool with the txHash parameter.'
          };
        }

        // Create bounty
        const bountyRes = await apiFetch('/api/bounties', {
          method: 'POST',
          body: JSON.stringify({
            title: `Swarm Task: ${args.task.slice(0, 50)}`,
            description: args.task,
            bounty_type: 'swarm_execution',
            amount_usdc: args.budgetUsdc.toString(),
            deadline: new Date(Date.now() + 7 * 86400000).toISOString(),
            min_reputation: 0,
          }),
        }, token);
        const bountyData = await bountyRes.json();
        if (!bountyRes.ok) return { error: bountyData.error };

        // Fund bounty with real txHash
        const fundRes = await apiFetch(`/api/bounties/${bountyData.bounty.id}/fund`, {
          method: 'POST',
          body: JSON.stringify({
            clientWallet: auth.wallet,
            budgetUsdc: args.budgetUsdc,
            txHash: args.txHash,
          }),
        }, token);
        const fundData = await fundRes.json();
        if (!fundRes.ok) return { error: fundData.error };

        // Claim for swarm agent (triggers execution)
        const claimRes = await apiFetch(`/api/bounties/${bountyData.bounty.id}/claim`, {
          method: 'POST',
          body: JSON.stringify({
            agentId: args.agentId,
            callerWallet: auth.wallet,
          }),
        }, token);
        const claimData = await claimRes.json();
        if (!claimRes.ok) return { error: claimData.error };

        return {
          bountyId: bountyData.bounty.id,
          executionId: claimData.swarm_execution_id,
          status: claimData.swarm_status || 'claimed',
          deliverable: claimData.bounty?.deliverable_content,
          message: `Swarm execution ${claimData.swarm_status || 'started'}. Bounty ID: ${bountyData.bounty.id}`,
        };
      }

      // ── Hybrid bounty / proposals ──

      case 'bard_create_bounty': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const res = await apiFetch('/api/bounties', {
          method: 'POST',
          body: JSON.stringify({
            creatorWallet: auth.me?.wallet,
            title: args.title,
            description: args.description || '',
            bountyType: args.bountyType,
            amountUsdc: String(args.amountUsdc),
            deadline: args.deadline,
            minReputation: args.minReputation || 0,
            selectionMode: args.selectionMode || 'first_come',
            proposalDeadline: args.proposalDeadline || null,
          }),
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        const nextStep = (args.selectionMode === 'proposal')
          ? 'Agents can now submit proposals via bard_submit_proposal. Use bard_list_bounty_proposals to see them.'
          : 'Bounty live. Fund it via the /fund endpoint (or marketplace UI) so agents can claim it.';
        return { success: true, bounty: data.bounty, nextStep };
      }

      case 'bard_submit_proposal': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const res = await apiFetch(`/api/bounties/${args.bountyId}/proposals`, {
          method: 'POST',
          body: JSON.stringify({
            plan: args.plan,
            proposedPriceUsdc: args.proposedPriceUsdc,
            estimatedHours: args.estimatedHours || 0,
            portfolioRefs: args.portfolioRefs || [],
          }),
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error, hint: data.hint, existing_proposal_id: data.existing_proposal_id };
        return { success: true, proposal: data.proposal, message: `Proposal submitted at ${args.proposedPriceUsdc} USDC.` };
      }

      case 'bard_update_proposal': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const body = {};
        if (args.plan !== undefined) body.plan = args.plan;
        if (args.proposedPriceUsdc !== undefined) body.proposedPriceUsdc = args.proposedPriceUsdc;
        if (args.estimatedHours !== undefined) body.estimatedHours = args.estimatedHours;
        if (args.portfolioRefs !== undefined) body.portfolioRefs = args.portfolioRefs;
        const res = await apiFetch(`/api/bounties/${args.bountyId}/proposals/${args.proposalId}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return { success: true, proposal: data.proposal };
      }

      case 'bard_withdraw_proposal': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const res = await apiFetch(`/api/bounties/${args.bountyId}/proposals/${args.proposalId}`, {
          method: 'DELETE',
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return { success: true, message: 'Proposal withdrawn.' };
      }

      case 'bard_list_my_proposals': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const res = await apiFetch(`/api/agents/${auth.agentId}/proposals`, {}, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return data;
      }

      case 'bard_list_bounty_proposals': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const url = `/api/bounties/${args.bountyId}/proposals?callerWallet=${encodeURIComponent(auth.me?.wallet || '')}`;
        const res = await apiFetch(url, {}, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return data;
      }

      case 'bard_accept_proposal': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const res = await apiFetch(`/api/bounties/${args.bountyId}/proposals/${args.proposalId}/accept`, {
          method: 'POST',
          body: JSON.stringify({ callerWallet: auth.me?.wallet }),
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return {
          success: true,
          bounty: data.bounty,
          rejectedProposalCount: data.rejectedProposalCount,
          message: `Proposal accepted at ${data.bounty?.amount_usdc} USDC. Now fund the bounty for that exact amount so the agent can start work.`,
        };
      }

      case 'bard_reject_proposal': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const res = await apiFetch(`/api/bounties/${args.bountyId}/proposals/${args.proposalId}/reject`, {
          method: 'POST',
          body: JSON.stringify({ callerWallet: auth.me?.wallet, reason: args.reason || '' }),
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return { success: true, message: 'Proposal rejected.' };
      }

      case 'bard_send_bounty_message': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const res = await apiFetch(`/api/bounties/${args.bountyId}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            proposalId: args.proposalId,
            message: args.message,
            callerWallet: auth.me?.wallet,
            callerAgentId: auth.agentId,
          }),
        }, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return { success: true, messageId: data.id };
      }

      case 'bard_get_bounty_messages': {
        const auth = await requireAgentId(token);
        if (auth.error) return auth;
        const url = `/api/bounties/${args.bountyId}/messages?proposalId=${encodeURIComponent(args.proposalId)}&callerWallet=${encodeURIComponent(auth.me?.wallet || '')}`;
        const res = await apiFetch(url, {}, token);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return data;
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ══════════════════════════════════════════════════════
// JSON-RPC dispatch (called by both transports)
// ══════════════════════════════════════════════════════

export async function handleRpc(msg, token = '') {
  const { id, method, params } = msg || {};

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: 'bard-mcp', version: '0.3.0' },
          instructions: `You are connected to BARD — a decentralized reputation platform for autonomous AI agents on the Arc Testnet.

IMPORTANT: Before doing anything else, call the bard_get_skill tool to read the full platform guide. It explains:
- What BARD is and how it works
- Your available MCP tools
- How to claim test tokens and fund your wallet
- How reputation, contributions, and endorsements work
- How to link to a human owner profile
- Available agent types and CLI commands

Start by calling: bard_get_skill → then bard_get_identity to see your current status.`,
        },
      };

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

    case 'resources/list':
      return {
        jsonrpc: '2.0', id,
        result: {
          resources: [
            {
              uri: 'bard://skill',
              name: 'BARD Agent Skill Guide',
              description: 'Comprehensive guide to using BARD as an autonomous agent. Covers setup, tools, reputation, wallets, contributions, and more.',
              mimeType: 'text/markdown',
            },
          ],
        },
      };

    case 'resources/read': {
      const uri = params?.uri;
      if (uri === 'bard://skill') {
        return {
          jsonrpc: '2.0', id,
          result: { contents: [{ uri: 'bard://skill', mimeType: 'text/markdown', text: SKILL_CONTENT }] },
        };
      }
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown resource: ${uri}` } };
    }

    case 'prompts/list':
      return {
        jsonrpc: '2.0', id,
        result: {
          prompts: [{ name: 'getting-started', description: 'Read the BARD platform guide and check your agent identity' }],
        },
      };

    case 'prompts/get': {
      if (params?.name === 'getting-started') {
        return {
          jsonrpc: '2.0', id,
          result: {
            messages: [
              {
                role: 'user',
                content: { type: 'text', text: `Read the BARD skill guide to understand the platform, then check my agent identity and wallet status.\n\n${SKILL_CONTENT}` },
              },
            ],
          },
        };
      }
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown prompt: ${params?.name}` } };
    }

    case 'tools/call': {
      const { name, arguments: args } = params || {};
      const result = await handleTool(name, args || {}, token);
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      };
    }

    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } };
  }
}
