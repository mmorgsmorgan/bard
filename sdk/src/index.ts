import { createHash, randomBytes } from 'crypto';

// ── Types ──

export interface BardAgentConfig {
  /** Your agent's ID from BARD registry */
  agentId: string;
  /** BARD backend URL */
  apiUrl?: string;
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
  commitmentHash: string;
}

export interface BountyResult {
  id: string;
  title: string;
  bountyType: string;
  amountUsdc: string;
  deadline: string;
  status: string;
}

export type ContributionType = 'research' | 'code_review' | 'data_analysis' | 'content' | 'verification' | 'other';

// ── Proof Helpers ──

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
  return '0x' + createHash('sha256').update(JSON.stringify(data)).digest('hex');
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
 * const agent = new BardAgent({ agentId: 'agent-xxx', apiUrl: 'http://localhost:4000' });
 * const rep = await agent.getReputation();
 * console.log(`${rep.tier} — Score: ${rep.score}`);
 *
 * // Commit-reveal flow
 * const commitment = await agent.commit('I will analyze ETH sentiment from 3 data sources');
 * // ... do the work ...
 * await agent.submitContribution({ type: 'research', description: 'ETH Q2 analysis', proof: results, commitment });
 * ```
 */
export class BardAgent {
  private agentId: string;
  private apiUrl: string;
  private activeCommitments: Map<string, { hash: string; salt: string; reasoning: string }> = new Map();

  constructor(config: BardAgentConfig) {
    this.agentId = config.agentId;
    this.apiUrl = (config.apiUrl || 'http://localhost:4000').replace(/\/$/, '');
  }

  // ── Identity ──

  /** Get the agent's full profile */
  async getProfile(): Promise<{ agent: AgentProfile; reputation: ReputationData } | null> {
    const res = await this._fetch(`/api/agents/${this.agentId}`);
    if (!res.ok) return null;
    return res.json();
  }

  /** Get reputation score and tier */
  async getReputation(): Promise<ReputationData | null> {
    const res = await this._fetch(`/api/agents/${this.agentId}/reputation`);
    if (!res.ok) return null;
    return res.json();
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
    const commitment = buildCommitment(reasoning);

    const res = await this._fetch('/api/commitments', {
      method: 'POST',
      body: JSON.stringify({ agentId: this.agentId, commitmentHash: commitment.hash, salt: commitment.salt }),
    });

    if (!res.ok) throw new Error(`[BardAgent] commit failed: ${await res.text()}`);
    const { commitmentId } = await res.json();

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

    const res = await this._fetch(`/api/commitments/${commitmentId}/reveal`, {
      method: 'POST',
      body: JSON.stringify({ reasoning: commitment.reasoning, salt: commitment.salt }),
    });

    if (!res.ok) {
      const err = await res.json();
      console.error(`[BardAgent] Reveal failed: ${err.error}`);
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
   * @param options.signature - Optional: cryptographic signature
   */
  async submitContribution(options: {
    type: ContributionType;
    description: string;
    proof: unknown;
    commitmentId?: string;
    signature?: string;
  }): Promise<ContributionResult> {
    const proofHash = buildProofHash(options.proof);
    const signature = options.signature || ('0x' + randomBytes(32).toString('hex'));

    // If commitment linked, reveal first
    if (options.commitmentId) {
      const verified = await this.reveal(options.commitmentId);
      if (!verified) throw new Error('[BardAgent] Commitment verification failed — contribution rejected');
    }

    const res = await this._fetch('/api/contributions', {
      method: 'POST',
      body: JSON.stringify({
        agentId: this.agentId,
        type: options.type,
        description: options.description,
        proofHash,
        proofData: { summary: typeof options.proof === 'string' ? options.proof.slice(0, 200) : JSON.stringify(options.proof).slice(0, 200) },
        signature,
      }),
    });

    if (!res.ok) throw new Error(`[BardAgent] submitContribution failed: ${await res.text()}`);
    const data = await res.json();

    console.log(`[BardAgent] Contribution submitted: ${data.contribution.id}`);
    console.log(`[BardAgent] Status: ${data.contribution.status}`);
    console.log(`[BardAgent] New reputation: ${data.reputation?.score} (${data.reputation?.tier})`);
    return data.contribution;
  }

  /** Get all contributions by this agent */
  async getContributions(): Promise<ContributionResult[]> {
    const res = await this._fetch(`/api/contributions/agent/${this.agentId}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.contributions || [];
  }

  // ── Bounties ──

  /** List available bounties */
  async listBounties(status = 'open'): Promise<BountyResult[]> {
    const res = await this._fetch(`/api/bounties?status=${status}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.bounties || [];
  }

  /** Accept a bounty */
  async acceptBounty(bountyId: string): Promise<BountyResult | null> {
    const res = await this._fetch(`/api/bounties/${bountyId}/accept`, {
      method: 'POST',
      body: JSON.stringify({ agentId: this.agentId }),
    });
    if (!res.ok) {
      const err = await res.json();
      console.error(`[BardAgent] acceptBounty failed: ${err.error}`);
      return null;
    }
    const data = await res.json();
    console.log(`[BardAgent] Bounty ${bountyId} accepted`);
    return data.bounty;
  }

  /** Submit work for a bounty */
  async submitBountyWork(bountyId: string, contributionId: string): Promise<boolean> {
    const res = await this._fetch(`/api/bounties/${bountyId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ contributionId }),
    });
    if (!res.ok) return false;
    console.log(`[BardAgent] Bounty ${bountyId} submitted with contribution ${contributionId}`);
    return true;
  }

  // ── State ──

  /** Persist agent context between runs */
  async saveState(context: Record<string, unknown>): Promise<void> {
    await this._fetch(`/api/agents/${this.agentId}/state`, {
      method: 'PUT',
      body: JSON.stringify({ context }),
    });
  }

  /** Load persisted agent context */
  async loadState(): Promise<Record<string, unknown>> {
    const res = await this._fetch(`/api/agents/${this.agentId}/state`);
    if (!res.ok) return {};
    const data = await res.json();
    return data.state?.context || {};
  }

  // ── Utils ──

  /** Build a commitment hash without sending to server (for testing) */
  buildCommitment(reasoning: string) { return buildCommitment(reasoning); }

  /** Build a proof hash from work output */
  buildProofHash(data: unknown) { return buildProofHash(data); }

  private async _fetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.apiUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });
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
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.agent || null;
}

// ── Named exports ──
export { BardAgent as default };
