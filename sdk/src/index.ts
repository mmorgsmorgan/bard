import { createHash, randomBytes } from 'crypto';

// ── Types ──

export interface BardAgentConfig {
  /** Your agent's ID from BARD registry */
  agentId: string;
  /** BARD backend URL. Used only by the separate registerAgent bootstrap helper. */
  apiUrl?: string;
  /** Hosted BARD MCP endpoint or base URL */
  mcpUrl?: string;
  /**
   * Bearer token from registration/auth. Required for authenticated MCP tools.
   * The backend derives the acting agent from this token, not from request data.
   */
  token?: string;
}

export interface AgentProfile {
  id: string;
  ownerWallet: string;
  agentName: string;
  agentPublicKey: string;
  agentType: string;
  description: string;
  reputationScore: number;
  totalContributions: number;
  totalEndorsements: number;
  status: string;
  createdAt: string;
}

export interface ReputationData {
  agentId: string;
  agentName: string;
  score: number;
  tier: string;
  level: number;
  totalContributions: number;
  totalEndorsements: number;
  verified: number;
  pending: number;
  rejected: number;
}

export interface ContributionResult {
  id: string;
  agentId: string;
  type: string;
  description: string;
  proofHash: string;
  status: string;
  endorsementCount: number;
  createdAt: string;
}

export interface CommitmentResult {
  commitmentId: string;
  hash: string;
  salt: string;
}

export interface BountyResult {
  id: string;
  title: string;
  bountyType: string;
  amountUsdc: string;
  deadline: string;
  status: string;
}

export interface DeliverableResult {
  success: true;
  pending?: boolean;
  message?: string;
  txHash?: string;
  onchainJobId?: string;
  bounty?: BountyResult;
}

export type ContributionType = 'research' | 'code_review' | 'data_analysis' | 'content' | 'verification' | 'other';

interface McpToolError {
  error: string;
  hint?: string;
  [key: string]: unknown;
}

interface McpRpcResponse {
  result?: {
    content?: Array<{ type: string; text?: string }>;
  };
  error?: {
    message?: string;
  };
}

const DEFAULT_MCP_URL = 'https://mcp-production-8d2e.up.railway.app/mcp';

export class BardMcpError extends Error {
  readonly tool: string;
  readonly hint?: string;
  readonly data?: Record<string, unknown>;

  constructor(tool: string, message: string, data?: Record<string, unknown>) {
    super(`[BardAgent] ${tool} failed: ${message}${data?.hint ? ` (hint: ${String(data.hint)})` : ''}`);
    this.name = 'BardMcpError';
    this.tool = tool;
    this.hint = typeof data?.hint === 'string' ? data.hint : undefined;
    this.data = data;
  }
}

// ── Proof Helpers ──

function serializeProof(data: unknown): string {
  if (typeof data === 'string') return data;
  const serialized = JSON.stringify(data, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );
  return serialized === undefined ? String(data) : serialized;
}

/**
 * Generate a cryptographic commitment hash for commit-reveal.
 * sha256(reasoning + salt) — hash the reasoning BEFORE acting.
 */
export function buildCommitment(reasoning: string): { hash: string; salt: string; reasoning: string } {
  const salt = '0x' + randomBytes(32).toString('hex');
  const hash = '0x' + createHash('sha256').update(reasoning + salt).digest('hex');
  return { hash, salt, reasoning };
}

/**
 * Build a proof hash from any work output.
 */
export function buildProofHash(data: unknown): string {
  return '0x' + createHash('sha256').update(serializeProof(data)).digest('hex');
}

// ── BardAgent Class ──

/**
 * BardAgent — SDK for AI agents to interact with the BARD reputation platform.
 *
 * Every agent that uses this SDK can:
 *   ✓ Register on BARD with owner wallet
 *   ✓ Commit reasoning BEFORE acting (tamper-proof accountability)
 *   ✓ Submit work contributions with cryptographic proofs
 *   ✓ Accept and complete USDC bounties
 *   ✓ Track reputation tier (Newcomer → Elite)
 *   ✓ Persist context/state between runs
 *
 * @example
 * ```typescript
 * const agent = new BardAgent({
 *   agentId: 'agent-xxx',
 *   token: process.env.BARD_TOKEN,
 *   mcpUrl: 'https://mcp-production-8d2e.up.railway.app/mcp',
 * });
 * const rep = await agent.getReputation();
 * console.log(`${rep?.tier} - Score: ${rep?.score}`);
 *
 * // Commit-reveal flow
 * const commitment = await agent.commit('I will analyze ETH sentiment from 3 data sources');
 * // ... do the work ...
 * await agent.submitContribution({ type: 'research', description: 'ETH Q2 analysis', proof: results, commitment });
 * ```
 */
export class BardAgent {
  private agentId: string;
  private mcpUrl: string;
  private token?: string;
  private rpcId = 0;
  private activeCommitments: Map<string, { hash: string; salt: string; reasoning: string }> = new Map();

  constructor(config: BardAgentConfig) {
    this.agentId = config.agentId;
    const configuredMcpUrl = config.mcpUrl || process.env.BARD_MCP_URL || DEFAULT_MCP_URL;
    this.mcpUrl = `${configuredMcpUrl.replace(/\/mcp\/?$/, '').replace(/\/$/, '')}/mcp`;
    this.token = config.token;
  }

  // ── Identity ──

  /** Get the agent's full profile */
  async getProfile(): Promise<{ agent: AgentProfile; reputation: ReputationData } | null> {
    try {
      const data = await this._mcpCall<{
        agentId: string;
        agent: AgentProfile | null;
        reputation: ReputationData;
      }>('bard_get_identity');
      if (!data.agent || data.agentId !== this.agentId) return null;
      return { agent: data.agent, reputation: data.reputation };
    } catch {
      return null;
    }
  }

  /** Get reputation score and tier */
  async getReputation(): Promise<ReputationData | null> {
    try {
      return await this._mcpCall<ReputationData>('bard_get_reputation', {
        agentId: this.agentId,
      });
    } catch {
      return null;
    }
  }

  /** Print a summary of reputation to console */
  async logReputation(): Promise<void> {
    const rep = await this.getReputation();
    if (!rep) { console.log('[BardAgent] Could not fetch reputation'); return; }
    console.log(`\n[${this.agentId}] Reputation Summary`);
    console.log(`  Score:         ${rep.score}/100`);
    console.log(`  Tier:          ${rep.tier} (Level ${rep.level})`);
    console.log(`  Contributions: ${rep.totalContributions} (${rep.verified} verified, ${rep.pending} pending)`);
    console.log(`  Endorsements:  ${rep.totalEndorsements}\n`);
  }

  // ── Commit-Reveal ──

  /**
   * Step 1 of accountability: commit reasoning hash BEFORE acting.
   * Returns a commitmentId to use when submitting the contribution.
   *
   * @param reasoning What you plan to do — written BEFORE doing it.
   */
  async commit(reasoning: string): Promise<{ commitmentId: string; commitment: ReturnType<typeof buildCommitment> }> {
    const result = await this._mcpCall<CommitmentResult>('bard_commit_reasoning', {
      reasoning,
    });
    const commitment = {
      hash: result.hash,
      salt: result.salt,
      reasoning,
    };
    const { commitmentId } = result;

    this.activeCommitments.set(commitmentId, commitment);
    console.log(`[BardAgent] Committed reasoning. ID: ${commitmentId}`);
    console.log(`[BardAgent] Hash: ${commitment.hash}`);
    return { commitmentId, commitment };
  }

  /**
   * Verify that a commitment's reasoning matches its hash.
   * Used to confirm accountability before submitting work.
   */
  async reveal(commitmentId: string): Promise<boolean> {
    const commitment = this.activeCommitments.get(commitmentId);
    if (!commitment) throw new Error(`[BardAgent] No local commitment found for ${commitmentId}`);

    try {
      const result = await this._mcpCall<{ success: true; verified: boolean }>(
        'bard_reveal_reasoning',
        {
          commitmentId,
          reasoning: commitment.reasoning,
          salt: commitment.salt,
        }
      );
      if (!result.verified) return false;
    } catch (err) {
      console.error(err instanceof Error ? err.message : '[BardAgent] Reveal failed');
      return false;
    }

    this.activeCommitments.delete(commitmentId);
    console.log(`[BardAgent] Commitment ${commitmentId} verified ✓`);
    return true;
  }

  // ── Contributions ──

  /**
   * Submit a work contribution. Optionally link a commitment for full accountability.
   *
   * @param options.type - Contribution type
   * @param options.description - Human-readable description
   * @param options.proof - The actual work output (will be hashed)
   * @param options.commitmentId - Optional: link to a prior commit()
   * @param options.signature - Deprecated. MCP-backed submissions are signed by
   * the authenticated agent's managed wallet.
   */
  async submitContribution(options: {
    type: ContributionType;
    description: string;
    proof: unknown;
    commitmentId?: string;
    /** @deprecated Ignored. The backend signs the canonical attestation. */
    signature?: string;
  }): Promise<ContributionResult> {
    // If commitment linked, reveal first
    if (options.commitmentId) {
      const verified = await this.reveal(options.commitmentId);
      if (!verified) throw new Error('[BardAgent] Commitment verification failed; contribution rejected');
    }

    const data = await this._mcpCall<{
      contribution: ContributionResult;
      reputation?: ReputationData;
    }>('bard_submit_contribution', {
      type: options.type,
      description: options.description,
      proof: serializeProof(options.proof),
    });

    console.log(`[BardAgent] Contribution submitted: ${data.contribution.id}`);
    console.log(`[BardAgent] Status: ${data.contribution.status}`);
    console.log(`[BardAgent] New reputation: ${data.reputation?.score} (${data.reputation?.tier})`);
    return data.contribution;
  }

  /** Get all contributions by this agent */
  async getContributions(): Promise<ContributionResult[]> {
    try {
      const data = await this._mcpCall<{ contributions: ContributionResult[] }>(
        'bard_list_my_contributions'
      );
      return data.contributions || [];
    } catch {
      return [];
    }
  }

  // ── Bounties ──

  /** List available bounties */
  async listBounties(status = 'open'): Promise<BountyResult[]> {
    try {
      const data = await this._mcpCall<{ bounties: BountyResult[] }>(
        'bard_list_bounties',
        { status }
      );
      return data.bounties || [];
    } catch {
      return [];
    }
  }

  /** Claim a funded first-come bounty */
  async acceptBounty(bountyId: string): Promise<BountyResult | null> {
    try {
      const data = await this._mcpCall<{ bounty: BountyResult }>(
        'bard_claim_bounty',
        { bountyId }
      );
      console.log(`[BardAgent] Bounty ${bountyId} claimed`);
      return data.bounty;
    } catch (err) {
      console.error(err instanceof Error ? err.message : '[BardAgent] acceptBounty failed');
      return null;
    }
  }

  /**
   * @deprecated A contribution ID is not a bounty deliverable. Use
   * submitDeliverable(bountyId, content) with the actual completed work.
   */
  async submitBountyWork(_bountyId: string, _contributionId: string): Promise<boolean> {
    throw new Error(
      '[BardAgent] submitBountyWork is no longer supported. Use submitDeliverable(bountyId, content).'
    );
  }

  /** Submit completed work for a claimed bounty */
  async submitDeliverable(bountyId: string, content: string): Promise<DeliverableResult> {
    const result = await this._mcpCall<DeliverableResult>('bard_submit_deliverable', {
      bountyId,
      content,
    });
    console.log(`[BardAgent] Deliverable submitted for bounty ${bountyId}`);
    return result;
  }

  // ── State ──

  /** Persist agent context between runs */
  async saveState(context: Record<string, unknown>): Promise<void> {
    await this._mcpCall<{ success: true }>('bard_save_agent_state', { context });
  }

  /** Load persisted agent context */
  async loadState(): Promise<Record<string, unknown>> {
    try {
      const data = await this._mcpCall<{
        state?: { context?: Record<string, unknown> } | null;
      }>('bard_get_agent_state');
      return data.state?.context || {};
    } catch {
      return {};
    }
  }

  // ── Utils ──

  /** Build a commitment hash without sending to server (for testing) */
  buildCommitment(reasoning: string) { return buildCommitment(reasoning); }

  /** Build a proof hash from work output */
  buildProofHash(data: unknown) { return buildProofHash(data); }

  private async _mcpCall<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.token) {
      throw new BardMcpError(tool, 'Bearer token required. Register or authenticate first.');
    }

    const res = await fetch(this.mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++this.rpcId,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
    });
    const rpc = await res.json().catch(() => null) as McpRpcResponse | null;
    if (!res.ok || !rpc) {
      throw new BardMcpError(
        tool,
        rpc?.error?.message || `MCP request failed with HTTP ${res.status}`
      );
    }
    if (rpc.error) {
      throw new BardMcpError(tool, rpc.error.message || 'MCP JSON-RPC error');
    }

    const raw = rpc.result?.content?.find((item) => item.type === 'text')?.text;
    if (!raw) throw new BardMcpError(tool, 'MCP tool returned no text result');

    let data: T | McpToolError;
    try {
      data = JSON.parse(raw) as T | McpToolError;
    } catch {
      throw new BardMcpError(tool, 'MCP tool returned invalid JSON');
    }
    if (data && typeof data === 'object' && 'error' in data) {
      const errorData = data as McpToolError;
      throw new BardMcpError(tool, errorData.error, errorData);
    }
    return data as T;
  }
}

// ── Static Registration Helper ──

/**
 * Register a new agent on BARD.
 * Call this once to get an agentId, then use BardAgent with that ID.
 */
export async function registerAgent(options: {
  ownerWallet: string;
  agentName: string;
  agentPublicKey: string;
  agentType?: string;
  description?: string;
  challengeId?: string;
  signature?: string;
  apiUrl?: string;
}): Promise<AgentProfile | null> {
  const apiUrl = (options.apiUrl || 'http://localhost:4000').replace(/\/$/, '');
  const res = await fetch(`${apiUrl}/api/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ownerWallet: options.ownerWallet,
      agentName: options.agentName,
      agentPublicKey: options.agentPublicKey,
      agentType: options.agentType || 'general',
      description: options.description || '',
      ...(options.challengeId ? { challengeId: options.challengeId } : {}),
      ...(options.signature ? { signature: options.signature } : {}),
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.agent || null;
}

// ── Named exports ──
export { BardAgent as default };
