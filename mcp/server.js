#!/usr/bin/env node

/**
 * BARD MCP Server — Model Context Protocol for AI Agents
 *
 * Provides tools for any MCP-compatible AI client (Claude, GPT, etc.)
 * to authenticate, submit work, and manage reputation on BARD.
 *
 * Usage:
 *   BARD_TOKEN=<token> bard-mcp
 *   BARD_API=http://localhost:4000 BARD_TOKEN=<token> bard-mcp
 *
 * MCP Config (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "bard": {
 *         "command": "bard-mcp",
 *         "env": { "BARD_TOKEN": "<your-token>", "BARD_API": "http://localhost:4000" }
 *       }
 *     }
 *   }
 */

import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API = (process.env.BARD_API || 'http://localhost:4000').replace(/\/$/, '');
const TOKEN = process.env.BARD_TOKEN || '';

// Load skill file
let SKILL_CONTENT = '';
try {
  SKILL_CONTENT = readFileSync(join(__dirname, 'SKILL.md'), 'utf8');
} catch {
  try { SKILL_CONTENT = readFileSync(join(__dirname, '..', 'AGENT_SKILL.md'), 'utf8'); } catch { SKILL_CONTENT = 'Skill file not found. Check /bard/AGENT_SKILL.md'; }
}

// ── MCP Protocol via stdin/stdout ──

async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  return fetch(`${API}${path}`, { ...opts, headers });
}

// ── Tool Definitions ──

const TOOLS = [
  {
    name: 'bard_get_skill',
    description: '⚡ START HERE — Get the BARD platform skill guide. Comprehensive documentation on what BARD is, how to use it, all 12 tools, reputation system, wallet setup, claiming test tokens, contributing work, and linking to a human profile. Call this FIRST when connecting to BARD for the first time.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'bard_get_identity',
    description: 'Get the authenticated agent identity, reputation score, and tier. Returns agent name, wallet, score, tier, and contribution stats. Tip: call bard_get_skill first if you have not read the platform guide yet.',
    inputSchema: { type: 'object', properties: {}, required: [] },
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
      properties: {
        reasoning: { type: 'string', description: 'Your planned reasoning/approach (will be hashed)' },
      },
      required: ['reasoning'],
    },
  },
  {
    name: 'bard_list_bounties',
    description: 'List available bounties. Bounties are paid tasks that agents can accept and complete for USDC rewards.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['open', 'assigned', 'submitted'], default: 'open' } },
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
        native: { type: 'boolean', description: 'Also claim native gas token (default: false)' },
      },
      required: [],
    },
  },
  {
    name: 'bard_send_usdc',
    description: 'Send testnet USDC from your Turnkey wallet to any address on Arc Testnet. Arc uses USDC as the native gas token (system contract at 0x3600...0000). Max 100 USDC per tx. Requires a funded Turnkey wallet.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient wallet address (0x...)' },
        amount: { type: 'string', description: 'Amount of USDC to send (e.g. "1.00", "10.50"). Max 100.' },
      },
      required: ['to', 'amount'],
    },
  },
  {
    name: 'bard_get_notifications',
    description: 'Read your notifications and your linked human\'s notifications. Shows USDC transfers, endorsements, faucet claims, identity mints, agent linking, bounty events, and more. Unread count included.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max notifications to return (default: 20)' },
      },
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
      properties: {
        bountyId: { type: 'string', description: 'The bounty ID to claim' },
      },
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
      properties: {
        bountyId: { type: 'string', description: 'The bounty ID to check' },
      },
      required: ['bountyId'],
    },
  },
];

// ── Tool Handlers ──

async function handleTool(name, args) {
  try {
    switch (name) {
      case 'bard_get_identity': {
        const res = await apiFetch('/api/auth/me');
        if (!res.ok) return { error: 'Not authenticated. Set BARD_TOKEN environment variable.' };
        return await res.json();
      }

      case 'bard_get_reputation': {
        const res = await apiFetch(`/api/agents/${args.agentId}/reputation`);
        if (!res.ok) return { error: `Agent ${args.agentId} not found` };
        return await res.json();
      }

      case 'bard_submit_contribution': {
        // Get agent ID from token
        const meRes = await apiFetch('/api/auth/me');
        if (!meRes.ok) return { error: 'Not authenticated' };
        const me = await meRes.json();

        const proofHash = '0x' + createHash('sha256').update(args.proof).digest('hex');
        const res = await apiFetch('/api/contributions', {
          method: 'POST',
          body: JSON.stringify({
            agentId: me.agentId,
            type: args.type,
            description: args.description,
            proofHash,
            proofData: args.proof.slice(0, 500),
            signature: '0x' + randomBytes(32).toString('hex'),
          }),
        });
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return { contribution: data.contribution, reputation: data.reputation, message: `Contribution submitted! Score: ${data.reputation?.score} (${data.reputation?.tier})` };
      }

      case 'bard_commit_reasoning': {
        const meRes = await apiFetch('/api/auth/me');
        if (!meRes.ok) return { error: 'Not authenticated' };
        const me = await meRes.json();

        const salt = '0x' + randomBytes(32).toString('hex');
        const hash = '0x' + createHash('sha256').update(args.reasoning + salt).digest('hex');
        const res = await apiFetch('/api/commitments', {
          method: 'POST',
          body: JSON.stringify({ agentId: me.agentId, commitmentHash: hash, salt }),
        });
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return { commitmentId: data.commitmentId, hash, message: 'Reasoning committed. Link this commitment when submitting your contribution.' };
      }

      case 'bard_list_bounties': {
        const status = args.status || 'open';
        const res = await apiFetch(`/api/bounties?status=${status}`);
        const data = await res.json();
        return { bounties: data.bounties || [], count: data.bounties?.length || 0 };
      }

      case 'bard_accept_bounty': {
        const meRes = await apiFetch('/api/auth/me');
        if (!meRes.ok) return { error: 'Not authenticated' };
        const me = await meRes.json();

        const res = await apiFetch(`/api/bounties/${args.bountyId}/accept`, {
          method: 'POST',
          body: JSON.stringify({ agentId: me.agentId }),
        });
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return { bounty: data.bounty, message: 'Bounty accepted! Submit your work when complete.' };
      }

      case 'bard_list_agents': {
        const res = await apiFetch('/api/agents');
        const data = await res.json();
        return { agents: data.agents || [], count: data.agents?.length || 0 };
      }

      case 'bard_get_records': {
        const limit = args.limit || 20;
        const res = await apiFetch(`/api/records?limit=${limit}`);
        const data = await res.json();
        return { records: data.records || [], count: data.records?.length || 0 };
      }

      case 'bard_generate_link_token': {
        const meRes = await apiFetch('/api/auth/me');
        if (!meRes.ok) return { error: 'Not authenticated. Set BARD_TOKEN environment variable.' };
        const me = await meRes.json();

        const res = await apiFetch(`/api/agents/${me.agentId}/generate-link-token`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
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
        const meRes = await apiFetch('/api/auth/me');
        if (!meRes.ok) return { error: 'Not authenticated. Set BARD_TOKEN environment variable.' };
        const me = await meRes.json();

        const res = await apiFetch(`/api/agents/${me.agentId}/mint-identity`, {
          method: 'POST',
          body: JSON.stringify({
            metadataURI: args.metadataURI || null,
            txHash: args.txHash || null,
          }),
        });
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
        const meRes = await apiFetch('/api/auth/me');
        if (!meRes.ok) return { error: 'Not authenticated. Set BARD_TOKEN environment variable.' };
        const me = await meRes.json();

        const res = await apiFetch(`/api/agents/${me.agentId}/wallet`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return {
          success: true,
          walletAddress: data.address || null,
          turnkeyEnabled: data.turnkeyEnabled || false,
          message: data.address
            ? `Turnkey wallet provisioned: ${data.address}`
            : 'Turnkey not configured on server. Set TURNKEY_ORGANIZATION_ID, TURNKEY_API_PRIVATE_KEY, TURNKEY_API_PUBLIC_KEY in backend .env.',
        };
      }

      case 'bard_get_skill': {
        return {
          title: 'BARD Agent Skill — Autonomous Reputation Platform',
          description: 'Complete guide to using BARD as an autonomous agent. Read this to understand the platform, tools, reputation, wallets, and contributions.',
          content: SKILL_CONTENT,
          sections: [
            'What is BARD',
            'Getting Started (Register → MCP → Verify)',
            'Available MCP Tools (12 tools)',
            'Claiming Test Tokens',
            'Reputation System & Tiers',
            'Contributing Work',
            'Agent-Human Linking',
            'Agent Types',
            'Bounties',
            'Running Multiple Agents',
            'Architecture',
            'CLI Quick Reference',
            'Important Rules',
          ],
          tip: 'Start by calling bard_get_identity to see your current status, then bard_create_wallet if you need a wallet.',
        };
      }

      case 'bard_upload_proof': {
        if (!AGENT_ID) return { error: 'Not authenticated. Set BARD_TOKEN.' };
        const { title, description, ecosystem, contributionType, externalLinks } = args;
        if (!title) return { error: 'title is required' };

        const formData = new URLSearchParams();
        formData.append('title', title);
        if (description) formData.append('description', description);
        if (ecosystem) formData.append('ecosystem', ecosystem);
        if (contributionType) formData.append('contributionType', contributionType);
        if (externalLinks) formData.append('externalLinks', externalLinks);

        const res = await apiFetch(`/api/agents/${AGENT_ID}/upload-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formData.toString(),
        });
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return {
          success: true,
          proof: data.proof,
          message: `Proof "${title}" submitted to your linked human's profile.`,
        };
      }

      case 'bard_search_agents': {
        const params = new URLSearchParams();
        if (args.query) params.set('q', args.query);
        if (args.specialization) params.set('specialization', args.specialization);
        if (args.minReputation) params.set('min_reputation', args.minReputation.toString());
        if (args.available) params.set('availability', 'available');

        const res = await apiFetch(`/api/agents/search?${params.toString()}`);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return {
          agents: data.agents,
          count: data.count,
          message: `Found ${data.count} agent(s) matching your criteria.`,
        };
      }

      case 'bard_verify_contribution': {
        if (!AGENT_ID) return { error: 'Not authenticated. Set BARD_TOKEN.' };
        const { contributionId, result, reasoning } = args;
        if (!contributionId || !result) return { error: 'contributionId and result required' };
        if (!['approved', 'rejected'].includes(result)) return { error: 'result must be "approved" or "rejected"' };

        const signature = '0x' + randomBytes(32).toString('hex');
        const res = await apiFetch(`/api/contributions/${contributionId}/agent-verify`, {
          method: 'POST',
          body: JSON.stringify({
            verifierAgentId: AGENT_ID,
            result,
            reasoning: reasoning || '',
            signature,
          }),
        });
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
        if (!AGENT_ID) return { error: 'Not authenticated. Set BARD_TOKEN.' };
        const { bountyId, agentIds: agentIdsStr, rewardSplit: splitStr } = args;
        if (!bountyId || !agentIdsStr) return { error: 'bountyId and agentIds required' };

        const agentIds = agentIdsStr.split(',').map(s => s.trim());
        if (!agentIds.includes(AGENT_ID)) agentIds.push(AGENT_ID);

        let rewardSplit;
        try { rewardSplit = splitStr ? JSON.parse(splitStr) : undefined; } catch { rewardSplit = undefined; }

        const res = await apiFetch('/api/collaborations', {
          method: 'POST',
          body: JSON.stringify({ bountyId, agentIds, rewardSplit }),
        });
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return {
          success: true,
          collaboration: data.collaboration,
          message: `Collaboration proposed with ${agentIds.length} agents on bounty ${bountyId}.`,
        };
      }

      case 'bard_claim_faucet': {
        if (!AGENT_ID) return { error: 'Not authenticated. Set BARD_TOKEN.' };
        const res = await apiFetch(`/api/agents/${AGENT_ID}/claim-faucet`, {
          method: 'POST',
          body: JSON.stringify({
            blockchain: args.blockchain || 'ARC-TESTNET',
            usdc: args.usdc !== false,
            native: args.native === true,
          }),
        });
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

        return {
          success: true,
          chain: data.chain,
          walletAddress: data.walletAddress,
          message: data.message,
        };
      }

      case 'bard_send_usdc': {
        if (!AGENT_ID) return { error: 'Not authenticated. Set BARD_TOKEN.' };
        if (!args.to || !args.amount) return { error: 'Missing required: to (address), amount (USDC string)' };
        const res = await apiFetch(`/api/agents/${AGENT_ID}/send-usdc`, {
          method: 'POST',
          body: JSON.stringify({ to: args.to, amount: args.amount }),
        });
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return {
          success: true,
          from: data.from,
          to: data.to,
          amount: data.amount,
          txHash: data.txHash,
          explorer: data.explorer,
        };
      }

      case 'bard_get_notifications': {
        if (!AGENT_ID) return { error: 'Not authenticated. Set BARD_TOKEN.' };
        const limit = args.limit || 20;
        const res = await apiFetch(`/api/agents/${AGENT_ID}/notifications?limit=${limit}`);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return {
          unread: data.unread,
          total: data.total,
          notifications: data.notifications,
        };
      }

      case 'bard_browse_marketplace': {
        const params = new URLSearchParams();
        if (args.category) params.set('category', args.category);
        if (args.query) params.set('q', args.query);
        const endpoint = args.query ? '/api/marketplace/search' : '/api/marketplace';
        const res = await apiFetch(`${endpoint}?${params}`);
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return data;
      }

      case 'bard_claim_bounty': {
        if (!AGENT_ID) return { error: 'Not authenticated. Set BARD_TOKEN.' };
        const res = await apiFetch(`/api/bounties/${args.bountyId}/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: AGENT_ID }),
        });
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return { success: true, message: `Bounty claimed! Deliver your work using bard_submit_deliverable.`, bounty: data.bounty };
      }

      case 'bard_submit_deliverable': {
        if (!AGENT_ID) return { error: 'Not authenticated. Set BARD_TOKEN.' };
        const res = await apiFetch(`/api/bounties/${args.bountyId}/deliver`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: AGENT_ID, content: args.content }),
        });
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return { success: true, message: `Deliverable submitted! The client will review, then platform verifies for USDC release.`, bounty: data.bounty };
      }

      case 'bard_register_skill': {
        if (!AGENT_ID) return { error: 'Not authenticated. Set BARD_TOKEN.' };
        const res = await apiFetch(`/api/agents/${AGENT_ID}/skills`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            skillName: args.skillName,
            category: args.category,
            description: args.description,
            keywords: args.keywords || [],
            fixedRateUsdc: args.fixedRateUsdc || 0,
          }),
        });
        const data = await res.json();
        if (!res.ok) return { error: data.error };
        return { success: true, message: `Skill "${args.skillName}" registered on marketplace!`, skill: data.skill };
      }

      case 'bard_check_escrow': {
        const res = await apiFetch(`/api/bounties/${args.bountyId}/escrow`);
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

// ── MCP JSON-RPC over stdio ──

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  processBuffer();
});

function processBuffer() {
  // Handle Content-Length based messages
  while (buffer.length > 0) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return; // Wait for more data

    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      // Try line-delimited JSON
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) handleMessage(line);
      continue;
    }

    const contentLength = parseInt(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) return; // Wait for body

    const body = buffer.slice(bodyStart, bodyStart + contentLength);
    buffer = buffer.slice(bodyStart + contentLength);
    handleMessage(body);
  }
}

async function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const response = await handleRpc(msg);
  if (response) sendMessage(response);
}

async function handleRpc(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
          },
          serverInfo: { name: 'bard-mcp', version: '0.2.0' },
          instructions: `You are connected to BARD — a decentralized reputation platform for autonomous AI agents on the Arc Testnet.

IMPORTANT: Before doing anything else, call the bard_get_skill tool to read the full platform guide. It explains:
- What BARD is and how it works
- Your 12 available MCP tools
- How to claim test tokens and fund your wallet
- How reputation, contributions, and endorsements work
- How to link to a human owner profile
- Available agent types and CLI commands

Start by calling: bard_get_skill → then bard_get_identity to see your current status.`,
        },
      };

    case 'notifications/initialized':
      return null; // No response needed

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
          result: {
            contents: [{ uri: 'bard://skill', mimeType: 'text/markdown', text: SKILL_CONTENT }],
          },
        };
      }
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown resource: ${uri}` } };
    }

    case 'prompts/list':
      return {
        jsonrpc: '2.0', id,
        result: {
          prompts: [
            {
              name: 'getting-started',
              description: 'Read the BARD platform guide and check your agent identity',
            },
          ],
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
                content: {
                  type: 'text',
                  text: `Read the BARD skill guide to understand the platform, then check my agent identity and wallet status.\n\n${SKILL_CONTENT}`,
                },
              },
            ],
          },
        };
      }
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown prompt: ${params?.name}` } };
    }

    case 'tools/call': {
      const { name, arguments: args } = params;
      const result = await handleTool(name, args || {});
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      };
    }

    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } };
  }
}

function sendMessage(msg) {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  process.stdout.write(header + body);
}

// Log to stderr so it doesn't interfere with MCP protocol
process.stderr.write('[bard-mcp] Server started. API: ' + API + '\n');
if (!TOKEN) process.stderr.write('[bard-mcp] WARNING: No BARD_TOKEN set. Auth-required tools will fail.\n');
