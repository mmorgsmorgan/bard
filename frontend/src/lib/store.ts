'use client';

/**
 * Backend-backed store for BARD platform data.
 * All data persists on the backend server — works across browsers/devices.
 */

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;
type WalletTransaction = {
  to: `0x${string}`;
  data?: `0x${string}`;
  value?: `0x${string}`;
  chainId?: number;
};
type SendTransaction = (transaction: WalletTransaction) => Promise<`0x${string}`>;

function isUserRejectedTransaction(error: unknown): boolean {
  const value = error as {
    code?: number | string;
    message?: string;
    cause?: { code?: number | string; message?: string };
  };
  const code = value?.code ?? value?.cause?.code;
  const message = `${value?.message || ''} ${value?.cause?.message || ''}`.toLowerCase();
  return (
    code === 4001 ||
    code === 'ACTION_REJECTED' ||
    message.includes('user rejected') ||
    message.includes('user denied')
  );
}

// ── Types ──

export interface StoredProfile {
  wallet: string;
  username: string;
  displayName: string;
  bio: string;
  profileType: 'human' | 'agent';
  ecosystems: string[];
  farcaster?: string;
  github?: string;
  x?: string;
  discord?: string;
  linkedin?: string;
  pfp?: string;
  createdAt: string;
}

export interface StoredProof {
  id: string;
  title: string;
  ecosystem: string;
  contributionType: string;
  description: string;
  externalLinks: string[];
  contributor: string;
  status: 'unvalidated' | 'validated' | 'rejected' | 'pending';
  timestamp: string;
  evidenceLink?: string;
  proofFileURI?: string;
}

export interface PortfolioItem {
  id: string;
  wallet: string;
  title: string;
  description: string;
  category: 'design' | 'code' | 'art' | 'video' | 'writing' | 'other';
  imageDataURI?: string;     // backend URL for portfolio media
  externalLink?: string;
  githubRepo?: string;
  tags: string[];
  createdAt: string;
  order: number;
}

export interface Notification {
  id: string;
  wallet: string;
  type: 'send' | 'vouch' | 'system';
  title: string;
  message: string;
  from?: string;
  amount?: string;
  read: boolean;
  createdAt: string;
}

export interface Agent {
  id: string;
  ownerWallet: string;
  agentName: string;
  agentPublicKey: string;
  agentType: 'general' | 'research' | 'code' | 'data' | 'content';
  description: string;
  reputationScore: number;
  totalContributions: number;
  totalEndorsements: number;
  status: 'active' | 'suspended';
  specializations: string[];
  hourlyRateUsdc: number;
  availability: string;
  totalEarnedUsdc: number;
  successRate: number;
  createdAt: string;
}

export interface Contribution {
  id: string;
  agentId: string;
  type: 'research' | 'code_review' | 'data_analysis' | 'content' | 'verification' | 'other';
  description: string;
  proofHash: string;
  proofData: Record<string, unknown>;
  signature: string;
  status: 'pending' | 'verified' | 'rejected';
  endorsementCount: number;
  approvals?: number;
  rejections?: number;
  agentName?: string;
  ownerWallet?: string;
  createdAt: string;
}

export interface Endorsement {
  id: string;
  contributionId: string;
  endorserWallet: string;
  endorserType: 'human' | 'agent';
  comment: string;
  signature: string;
  contributionType?: string;
  contributionDesc?: string;
  agentName?: string;
  createdAt: string;
}

export interface ReputationData {
  score: number;
  tier: string;
  level: number;
  totalContributions: number;
  totalEndorsements: number;
  verified: number;
  pending: number;
  rejected: number;
}

export interface Bounty {
  id: string;
  creatorWallet: string;
  title: string;
  description: string;
  bountyType: string;
  amountUsdc: string;
  deadline: string;
  minReputation: number;
  assignedAgentId?: string;
  contributionId?: string;
  status: 'open' | 'assigned' | 'submitted' | 'verified' | 'completed' | 'expired' | 'cancelled' | 'proposal_open' | 'proposal_selected';
  selectionMode: 'first_come' | 'proposal';
  escrowStatus: 'none' | 'funding' | 'funded' | 'claimed' | 'submitted' | 'client_approved' | 'released' | 'refunding' | 'refunded' | 'disputed';
  escrowBudgetUsdc: number;
  escrowTxHash?: string;
  refundTxHash?: string;
  selectedProposalId?: string;
  proposalDeadline?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BountyProposal {
  id: string;
  bountyId: string;
  proposerAgentId: string;
  proposerWallet: string;
  plan: string;
  proposedPriceUsdc: number;
  estimatedHours: number;
  portfolioRefs: string[];
  status: 'pending' | 'withdrawn' | 'accepted' | 'rejected';
  withdrawnAt?: string;
  acceptedAt?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  createdAt: string;
  updatedAt: string;
  // Joined fields from agents
  agentName?: string;
  reputationScore?: number;
  totalEarnedUsdc?: number;
  agentType?: string;
}

export interface BountyMessage {
  id: string;
  bountyId: string;
  proposalId?: string;
  fromWallet: string;
  fromAgentId?: string;
  fromAgentName?: string;
  toWallet: string;
  toAgentId?: string;
  toAgentName?: string;
  message: string;
  read: boolean;
  createdAt: string;
}

export interface Commitment {
  id: string;
  agentId: string;
  commitmentHash: string;
  salt: string;
  revealed: boolean;
  reasoning?: string;
  createdAt: string;
  revealedAt?: string;
}

export interface FeedEvent {
  type: 'contribution:new' | 'contribution:verified' | 'endorsement:new' | 'bounty:created' | 'bounty:submitted' | 'agent:registered';
  data: Record<string, unknown>;
  timestamp: string;
}

// ── In-memory cache (for synchronous access) ──
// Populated by async fetches, used by synchronous getters as fallback

let _profileCache: Record<string, StoredProfile> = {};
let _proofCache: Record<string, StoredProof[]> = {};
let _portfolioCache: Record<string, PortfolioItem[]> = {};
let _notifCache: Record<string, Notification[]> = {};

// ══════════════════════════════════════════════════════
// ── Profiles ──
// ══════════════════════════════════════════════════════

export async function saveProfileAsync(authFetch: AuthFetch, profile: StoredProfile): Promise<void> {
  try {
    await authFetch('/api/human/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: profile.username,
        displayName: profile.displayName,
        bio: profile.bio,
        profileType: profile.profileType,
        ecosystems: profile.ecosystems,
        farcaster: profile.farcaster,
        github: profile.github,
        x: profile.x,
        discord: profile.discord,
        linkedin: profile.linkedin,
        pfp: profile.pfp,
      }),
    });
    _profileCache[profile.wallet.toLowerCase()] = profile;
    _profileCache[`u:${profile.username}`] = profile;
  } catch (e) { console.error('saveProfile error:', e); }
}

// Synchronous wrapper — saves in background, updates cache immediately
export function saveProfile(authFetch: AuthFetch, profile: StoredProfile): void {
  _profileCache[profile.wallet.toLowerCase()] = profile;
  _profileCache[`u:${profile.username}`] = profile;
  saveProfileAsync(authFetch, profile);
}

export async function fetchProfileByWallet(wallet: string): Promise<StoredProfile | null> {
  try {
    const res = await fetch(`${API}/api/profiles/wallet/${wallet}`);
    const data = await res.json();
    if (data.profile) {
      _profileCache[wallet.toLowerCase()] = data.profile;
      _profileCache[`u:${data.profile.username}`] = data.profile;
    }
    return data.profile || null;
  } catch { return _profileCache[wallet.toLowerCase()] || null; }
}

export async function fetchProfileByUsername(username: string): Promise<StoredProfile | null> {
  try {
    const res = await fetch(`${API}/api/profiles/username/${username}`);
    const data = await res.json();
    if (data.profile) {
      _profileCache[data.profile.wallet.toLowerCase()] = data.profile;
      _profileCache[`u:${username}`] = data.profile;
    }
    return data.profile || null;
  } catch { return _profileCache[`u:${username}`] || null; }
}

export async function fetchAllProfiles(): Promise<StoredProfile[]> {
  try {
    const res = await fetch(`${API}/api/profiles`);
    const data = await res.json();
    return data.profiles || [];
  } catch { return []; }
}

// Synchronous getters (use cache)
export function getProfileByWallet(wallet: string): StoredProfile | null {
  return _profileCache[wallet.toLowerCase()] || null;
}

export function getProfileByUsername(username: string): StoredProfile | null {
  return _profileCache[`u:${username}`] || null;
}

export function getAllProfilesList(): StoredProfile[] {
  return Object.entries(_profileCache)
    .filter(([key]) => !key.startsWith('u:'))
    .map(([, p]) => p);
}

// ══════════════════════════════════════════════════════
// ── Proofs ──
// ══════════════════════════════════════════════════════

export async function saveProofAsync(authFetch: AuthFetch, proof: StoredProof): Promise<void> {
  try {
    await authFetch('/api/human/proofs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: proof.id,
        title: proof.title,
        description: proof.description,
        ecosystem: proof.ecosystem,
        contributionType: proof.contributionType,
        externalLinks: proof.externalLinks,
      }),
    });
    const key = proof.contributor.toLowerCase();
    if (!_proofCache[key]) _proofCache[key] = [];
    _proofCache[key].push(proof);
  } catch (e) { console.error('saveProof error:', e); }
}

export function saveProof(authFetch: AuthFetch, proof: StoredProof): void {
  const key = proof.contributor.toLowerCase();
  if (!_proofCache[key]) _proofCache[key] = [];
  _proofCache[key].push(proof);
  saveProofAsync(authFetch, proof);
}

export async function fetchProofsByWallet(wallet: string): Promise<StoredProof[]> {
  try {
    const res = await fetch(`${API}/api/proofs/${wallet}`);
    const data = await res.json();
    _proofCache[wallet.toLowerCase()] = data.proofs || [];
    return data.proofs || [];
  } catch { return _proofCache[wallet.toLowerCase()] || []; }
}

export function getProofsByWallet(wallet: string): StoredProof[] {
  return _proofCache[wallet.toLowerCase()] || [];
}

// ══════════════════════════════════════════════════════
// ── Portfolio ──
// ══════════════════════════════════════════════════════

export async function savePortfolioItemAsync(authFetch: AuthFetch, item: PortfolioItem): Promise<void> {
  try {
    await authFetch('/api/human/portfolio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    });
    const key = item.wallet.toLowerCase();
    if (!_portfolioCache[key]) _portfolioCache[key] = [];
    _portfolioCache[key].push(item);
  } catch (e) { console.error('savePortfolioItem error:', e); }
}

export function savePortfolioItem(authFetch: AuthFetch, item: PortfolioItem): void {
  const key = item.wallet.toLowerCase();
  if (!_portfolioCache[key]) _portfolioCache[key] = [];
  _portfolioCache[key].push(item);
  savePortfolioItemAsync(authFetch, item);
}

export async function fetchPortfolioByWallet(wallet: string): Promise<PortfolioItem[]> {
  try {
    const res = await fetch(`${API}/api/portfolio/${wallet}`);
    const data = await res.json();
    _portfolioCache[wallet.toLowerCase()] = data.portfolio || [];
    return data.portfolio || [];
  } catch { return _portfolioCache[wallet.toLowerCase()] || []; }
}

export function getPortfolioByWallet(wallet: string): PortfolioItem[] {
  return _portfolioCache[wallet.toLowerCase()] || [];
}

export async function deletePortfolioItemAsync(authFetch: AuthFetch, id: string): Promise<void> {
  try {
    await authFetch(`/api/human/portfolio/${id}`, { method: 'DELETE' });
    // Remove from all caches
    for (const key of Object.keys(_portfolioCache)) {
      _portfolioCache[key] = _portfolioCache[key].filter(p => p.id !== id);
    }
  } catch (e) { console.error('deletePortfolioItem error:', e); }
}

export function deletePortfolioItem(authFetch: AuthFetch, id: string): void {
  for (const key of Object.keys(_portfolioCache)) {
    _portfolioCache[key] = _portfolioCache[key].filter(p => p.id !== id);
  }
  deletePortfolioItemAsync(authFetch, id);
}

export async function reorderPortfolioItems(
  authFetch: AuthFetch,
  wallet: string,
  orderedIds: string[]
): Promise<void> {
  try {
    await authFetch('/api/human/portfolio/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet, orderedIds }),
    });
  } catch (e) { console.error('reorderPortfolioItems error:', e); }
}

// ══════════════════════════════════════════════════════
// ── Notifications ──
// ══════════════════════════════════════════════════════

export async function addNotificationAsync(
  _notif: Omit<Notification, 'id' | 'read' | 'createdAt'>
): Promise<void> {
  throw new Error('Notifications are created by authenticated BARD workflows');
}

export function addNotification(notif: Omit<Notification, 'id' | 'read' | 'createdAt'>): void {
  // Optimistic cache update
  const cached = _notifCache[notif.wallet.toLowerCase()] || [];
  cached.unshift({
    ...notif,
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    read: false,
    createdAt: new Date().toISOString(),
  });
  _notifCache[notif.wallet.toLowerCase()] = cached;
  void addNotificationAsync(notif).catch((error) => {
    console.error('addNotification error:', error);
  });
}

export async function fetchNotificationsByWallet(
  wallet: string,
  authFetch: AuthFetch
): Promise<Notification[]> {
  try {
    const res = await authFetch('/api/human/notifications');
    const data = await res.json();
    _notifCache[wallet.toLowerCase()] = data.notifications || [];
    return data.notifications || [];
  } catch { return _notifCache[wallet.toLowerCase()] || []; }
}

export function getNotificationsByWallet(wallet: string): Notification[] {
  return _notifCache[wallet.toLowerCase()] || [];
}

export function getUnreadCount(wallet: string): number {
  return getNotificationsByWallet(wallet).filter(n => !n.read).length;
}

export async function markNotificationReadAsync(authFetch: AuthFetch, id: string): Promise<void> {
  try {
    await authFetch(`/api/human/notifications/${id}/read`, { method: 'PUT' });
  } catch (e) { console.error('markNotificationRead error:', e); }
}

export function markNotificationRead(authFetch: AuthFetch, id: string): void {
  // Update all caches
  for (const key of Object.keys(_notifCache)) {
    _notifCache[key] = _notifCache[key].map(n => n.id === id ? { ...n, read: true } : n);
  }
  markNotificationReadAsync(authFetch, id);
}

export async function markAllNotificationsReadAsync(
  authFetch: AuthFetch,
  wallet: string
): Promise<void> {
  try {
    await authFetch('/api/human/notifications/read-all', { method: 'PUT' });
    if (_notifCache[wallet.toLowerCase()]) {
      _notifCache[wallet.toLowerCase()] = _notifCache[wallet.toLowerCase()].map(n => ({ ...n, read: true }));
    }
  } catch (e) { console.error('markAllNotificationsRead error:', e); }
}

export function markAllNotificationsRead(authFetch: AuthFetch, wallet: string): void {
  if (_notifCache[wallet.toLowerCase()]) {
    _notifCache[wallet.toLowerCase()] = _notifCache[wallet.toLowerCase()].map(n => ({ ...n, read: true }));
  }
  markAllNotificationsReadAsync(authFetch, wallet);
}

// ══════════════════════════════════════════════════════
// ── Agents ──
// ══════════════════════════════════════════════════════

export async function registerAgent(data: {
  ownerWallet: string;
  agentName: string;
  agentPublicKey: string;
  agentType?: string;
  description?: string;
}): Promise<Agent | null> {
  try {
    const res = await fetch(`${API}/api/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    return json.agent || null;
  } catch (e) { console.error('registerAgent error:', e); return null; }
}

export async function fetchAgentById(id: string): Promise<{ agent: Agent | null; reputation: ReputationData | null }> {
  try {
    const res = await fetch(`${API}/api/agents/${id}`);
    const json = await res.json();
    return { agent: json.agent || null, reputation: json.reputation || null };
  } catch { return { agent: null, reputation: null }; }
}

export async function fetchAgentsByOwner(wallet: string): Promise<Agent[]> {
  try {
    const res = await fetch(`${API}/api/agents/owner/${wallet}`);
    const json = await res.json();
    return json.agents || [];
  } catch { return []; }
}

export async function fetchAllAgents(): Promise<Agent[]> {
  try {
    const res = await fetch(`${API}/api/agents`);
    const json = await res.json();
    return json.agents || [];
  } catch { return []; }
}

export async function fetchAgentReputation(agentId: string): Promise<ReputationData | null> {
  try {
    const res = await fetch(`${API}/api/agents/${agentId}/reputation`);
    const json = await res.json();
    return json || null;
  } catch { return null; }
}

// ══════════════════════════════════════════════════════
// ── Contributions ──
// ══════════════════════════════════════════════════════

export async function submitContribution(data: {
  agentId: string;
  type: string;
  description?: string;
  proofHash: string;
  proofData?: Record<string, unknown>;
  signature: string;
}): Promise<{ contribution: Contribution | null; reputation: ReputationData | null }> {
  try {
    const res = await fetch(`${API}/api/contributions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    return { contribution: json.contribution || null, reputation: json.reputation || null };
  } catch (e) { console.error('submitContribution error:', e); return { contribution: null, reputation: null }; }
}

export async function fetchContributionsByAgent(agentId: string): Promise<Contribution[]> {
  try {
    const res = await fetch(`${API}/api/contributions/agent/${agentId}`);
    const json = await res.json();
    return json.contributions || [];
  } catch { return []; }
}

export async function fetchContributionFeed(limit = 20): Promise<Contribution[]> {
  try {
    const res = await fetch(`${API}/api/contributions/feed?limit=${limit}`);
    const json = await res.json();
    return json.contributions || [];
  } catch { return []; }
}

export async function fetchContributionWithEndorsements(id: string): Promise<{
  contribution: Contribution | null;
  endorsements: Endorsement[];
}> {
  try {
    const res = await fetch(`${API}/api/contributions/${id}`);
    const json = await res.json();
    return { contribution: json.contribution || null, endorsements: json.endorsements || [] };
  } catch { return { contribution: null, endorsements: [] }; }
}

// ══════════════════════════════════════════════════════
// ── Endorsements ──
// ══════════════════════════════════════════════════════

export async function endorseContribution(contributionId: string, data: {
  comment?: string;
  endorserWallet?: string;
  endorserType?: string;
  signature?: string;
}, token?: string): Promise<{
  success: boolean;
  endorsementCount: number;
  agentApprovals: number;
  status?: Contribution['status'];
  reputation: ReputationData | null;
  error?: string;
}> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API}/api/contributions/${contributionId}/endorse`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!res.ok) {
      return {
        success: false,
        endorsementCount: 0,
        agentApprovals: 0,
        reputation: null,
        error: json.error || 'Endorsement failed',
      };
    }
    return {
      success: true,
      endorsementCount: json.endorsementCount || 0,
      agentApprovals: json.agentApprovals || 0,
      status: json.status,
      reputation: json.reputation || null,
    };
  } catch (cause) {
    return {
      success: false,
      endorsementCount: 0,
      agentApprovals: 0,
      reputation: null,
      error: cause instanceof Error ? cause.message : 'Endorsement failed',
    };
  }
}

export async function fetchEndorsementsByWallet(wallet: string): Promise<Endorsement[]> {
  try {
    const res = await fetch(`${API}/api/endorsements/wallet/${wallet}`);
    const json = await res.json();
    return json.endorsements || [];
  } catch { return []; }
}

// ══════════════════════════════════════════════════════
// ── Bounties ──
// ══════════════════════════════════════════════════════

function bountyFromRow(row: Record<string, unknown>): Bounty {
  return {
    id: row.id as string,
    creatorWallet: (row.creator_wallet || row.creatorWallet) as string,
    title: row.title as string,
    description: (row.description || '') as string,
    bountyType: (row.bounty_type || row.bountyType) as string,
    amountUsdc: (row.amount_usdc || row.amountUsdc) as string,
    deadline: row.deadline as string,
    minReputation: (row.min_reputation || row.minReputation || 0) as number,
    assignedAgentId: (row.assigned_agent_id || row.assignedAgentId) as string | undefined,
    contributionId: (row.contribution_id || row.contributionId) as string | undefined,
    status: row.status as Bounty['status'],
    selectionMode: ((row.selection_mode || row.selectionMode) as Bounty['selectionMode']) || 'first_come',
    escrowStatus: ((row.escrow_status || row.escrowStatus) as Bounty['escrowStatus']) || 'none',
    escrowBudgetUsdc: Number(row.escrow_budget_usdc || row.escrowBudgetUsdc || 0),
    escrowTxHash: (row.escrow_tx_hash || row.escrowTxHash) as string | undefined,
    refundTxHash: (row.refund_tx_hash || row.refundTxHash) as string | undefined,
    selectedProposalId: (row.selected_proposal_id || row.selectedProposalId) as string | undefined,
    proposalDeadline: (row.proposal_deadline || row.proposalDeadline) as string | undefined,
    createdAt: (row.created_at || row.createdAt) as string,
    updatedAt: (row.updated_at || row.updatedAt) as string,
  };
}

function proposalFromRow(row: Record<string, unknown>): BountyProposal {
  let refs: string[] = [];
  try {
    refs = JSON.parse((row.portfolio_refs as string) || '[]');
  } catch { refs = []; }
  return {
    id: row.id as string,
    bountyId: (row.bounty_id || row.bountyId) as string,
    proposerAgentId: (row.proposer_agent_id || row.proposerAgentId) as string,
    proposerWallet: (row.proposer_wallet || row.proposerWallet) as string,
    plan: row.plan as string,
    proposedPriceUsdc: parseFloat(String(row.proposed_price_usdc ?? row.proposedPriceUsdc ?? '0')),
    estimatedHours: parseInt(String(row.estimated_hours ?? row.estimatedHours ?? '0'), 10),
    portfolioRefs: refs,
    status: (row.status as BountyProposal['status']) || 'pending',
    withdrawnAt: (row.withdrawn_at || row.withdrawnAt) as string | undefined,
    acceptedAt: (row.accepted_at || row.acceptedAt) as string | undefined,
    rejectedAt: (row.rejected_at || row.rejectedAt) as string | undefined,
    rejectionReason: (row.rejection_reason || row.rejectionReason) as string | undefined,
    createdAt: (row.created_at || row.createdAt) as string,
    updatedAt: (row.updated_at || row.updatedAt) as string,
    agentName: row.agent_name as string | undefined,
    reputationScore: row.reputation_score ? Number(row.reputation_score) : undefined,
    totalEarnedUsdc: row.total_earned_usdc ? Number(row.total_earned_usdc) : undefined,
    agentType: row.agent_type as string | undefined,
  };
}

function messageFromRow(row: Record<string, unknown>): BountyMessage {
  return {
    id: row.id as string,
    bountyId: (row.bounty_id || row.bountyId) as string,
    proposalId: (row.proposal_id || row.proposalId) as string | undefined,
    fromWallet: (row.from_wallet || row.fromWallet) as string,
    fromAgentId: (row.from_agent_id || row.fromAgentId) as string | undefined,
    fromAgentName: (row.from_agent_name || row.fromAgentName) as string | undefined,
    toWallet: (row.to_wallet || row.toWallet) as string,
    toAgentId: (row.to_agent_id || row.toAgentId) as string | undefined,
    toAgentName: (row.to_agent_name || row.toAgentName) as string | undefined,
    message: row.message as string,
    read: Boolean(row.read),
    createdAt: (row.created_at || row.createdAt) as string,
  };
}

export async function fetchBounties(status?: string): Promise<Bounty[]> {
  try {
    const url = status ? `${API}/api/bounties?status=${status}` : `${API}/api/bounties`;
    const res = await fetch(url);
    const json = await res.json();
    return (json.bounties || []).map(bountyFromRow);
  } catch { return []; }
}

export async function fetchBountyById(id: string): Promise<Bounty | null> {
  try {
    const res = await fetch(`${API}/api/bounties/${id}`);
    const json = await res.json();
    return json.bounty ? bountyFromRow(json.bounty) : null;
  } catch { return null; }
}

export async function createBounty(data: {
  creatorWallet: string;
  title: string;
  description?: string;
  bountyType: string;
  amountUsdc: string;
  deadline: string;
  minReputation?: number;
  selectionMode?: 'first_come' | 'proposal';
  proposalDeadline?: string;
}): Promise<Bounty | null> {
  try {
    const res = await fetch(`${API}/api/bounties`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    return json.bounty ? bountyFromRow(json.bounty) : null;
  } catch (e) { console.error('createBounty error:', e); return null; }
}

async function reconcileHumanBountyFunding(
  authFetch: AuthFetch,
  bountyId: string,
  txHash: string
): Promise<{ bounty: Bounty | null; error?: string }> {
  try {
    const res = await authFetch(`/api/human/bounties/${bountyId}/fund/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash }),
    });
    const json = await res.json();
    if (!res.ok) return { bounty: null, error: json.error || 'Funding reconciliation failed' };
    return { bounty: json.bounty ? bountyFromRow(json.bounty) : null };
  } catch (error) {
    return { bounty: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function createHumanBounty(
  authFetch: AuthFetch,
  sendTransaction: SendTransaction,
  data: Omit<Parameters<typeof createBounty>[0], 'creatorWallet'>
): Promise<{ bounty: Bounty | null; txHash?: string; error?: string }> {
  let reservedBountyId = '';
  let broadcastTxHash = '';
  try {
    let res = await authFetch('/api/human/bounties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    let json = await res.json();
    if (res.status === 202 && json.signatureRequired && json.transaction) {
      reservedBountyId = String(json.bountyId || '');
      if (!reservedBountyId) {
        return { bounty: null, error: 'BARD did not return a bounty funding reservation' };
      }
      try {
        broadcastTxHash = await sendTransaction(json.transaction);
      } catch (error) {
        if (isUserRejectedTransaction(error)) {
          await authFetch(`/api/human/bounties/${reservedBountyId}/fund/abort`, {
            method: 'POST',
          }).catch(() => {});
        }
        throw error;
      }
      const reconciled = await reconcileHumanBountyFunding(
        authFetch,
        reservedBountyId,
        broadcastTxHash
      );
      return reconciled.bounty
        ? { bounty: reconciled.bounty, txHash: broadcastTxHash }
        : {
            bounty: null,
            txHash: broadcastTxHash,
            error: reconciled.error || 'Funding reconciliation failed',
          };
    }
    if (!res.ok) {
      if (json.txHash && json.bountyId) {
        const reconciled = await reconcileHumanBountyFunding(authFetch, json.bountyId, json.txHash);
        if (reconciled.bounty) {
          return { bounty: reconciled.bounty, txHash: json.txHash };
        }
      }
      return {
        bounty: null,
        txHash: json.txHash || undefined,
        error: json.error || 'Bounty creation failed',
      };
    }
    return {
      bounty: json.bounty ? bountyFromRow(json.bounty) : null,
      txHash: json.txHash || undefined,
    };
  } catch (error) {
    return {
      bounty: null,
      txHash: broadcastTxHash || undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function acceptBounty(bountyId: string, agentId: string): Promise<Bounty | null> {
  try {
    const res = await fetch(`${API}/api/bounties/${bountyId}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId }),
    });
    const json = await res.json();
    return json.bounty ? bountyFromRow(json.bounty) : null;
  } catch { return null; }
}

export async function claimFundedBounty(
  bountyId: string,
  token: string
): Promise<{ bounty: Bounty | null; error?: string }> {
  try {
    const res = await fetch(`${API}/api/bounties/${bountyId}/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });
    const json = await res.json();
    if (!res.ok) return { bounty: null, error: json.error || 'Bounty claim failed' };
    return { bounty: json.bounty ? bountyFromRow(json.bounty) : null };
  } catch (error) {
    return { bounty: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function submitBounty(bountyId: string, contributionId: string): Promise<Bounty | null> {
  try {
    const res = await fetch(`${API}/api/bounties/${bountyId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contributionId }),
    });
    const json = await res.json();
    return json.bounty ? bountyFromRow(json.bounty) : null;
  } catch { return null; }
}

export async function cancelBounty(bountyId: string, creatorWallet: string): Promise<boolean> {
  try {
    const res = await fetch(`${API}/api/bounties/${bountyId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorWallet }),
    });
    return res.ok;
  } catch { return false; }
}

export async function cancelHumanBounty(
  authFetch: AuthFetch,
  bountyId: string,
  txHash?: string
): Promise<{ ok: boolean; refunded?: boolean; txHash?: string; error?: string }> {
  try {
    const res = await authFetch(`/api/human/bounties/${bountyId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(txHash ? { txHash } : {}),
    });
    const json = await res.json();
    if (!res.ok) {
      if (!txHash && json.recoverable && json.txHash) {
        return cancelHumanBounty(authFetch, bountyId, json.txHash);
      }
      return {
        ok: false,
        txHash: json.txHash || txHash,
        error: json.error || 'Bounty cancellation failed',
      };
    }
    return {
      ok: true,
      refunded: Boolean(json.refunded),
      txHash: json.txHash || undefined,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ══════════════════════════════════════════════════════
// ── Bounty Proposals (Hybrid Mode) ──
// ══════════════════════════════════════════════════════

export async function fetchBountyProposals(
  bountyId: string,
  authFetch: AuthFetch
): Promise<{ proposals: BountyProposal[]; isCreator: boolean }> {
  try {
    const res = await authFetch(`/api/human/bounties/${bountyId}/proposals`);
    const json = await res.json();
    return {
      proposals: (json.proposals || []).map(proposalFromRow),
      isCreator: Boolean(json.isCreator),
    };
  } catch (e) { console.error('fetchBountyProposals error:', e); return { proposals: [], isCreator: false }; }
}

export async function submitBountyProposal(
  bountyId: string,
  token: string,
  data: { plan: string; proposedPriceUsdc: number; estimatedHours?: number; portfolioRefs?: string[] }
): Promise<{ proposal: BountyProposal | null; error?: string }> {
  try {
    const res = await fetch(`${API}/api/bounties/${bountyId}/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!res.ok) return { proposal: null, error: json.error };
    return { proposal: proposalFromRow(json.proposal) };
  } catch (e) { return { proposal: null, error: String(e) }; }
}

export async function updateBountyProposal(
  bountyId: string,
  proposalId: string,
  token: string,
  data: { plan?: string; proposedPriceUsdc?: number; estimatedHours?: number; portfolioRefs?: string[] }
): Promise<{ proposal: BountyProposal | null; error?: string }> {
  try {
    const res = await fetch(`${API}/api/bounties/${bountyId}/proposals/${proposalId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!res.ok) return { proposal: null, error: json.error };
    return { proposal: proposalFromRow(json.proposal) };
  } catch (e) { return { proposal: null, error: String(e) }; }
}

export async function withdrawBountyProposal(
  bountyId: string,
  proposalId: string,
  token: string
): Promise<boolean> {
  try {
    const res = await fetch(`${API}/api/bounties/${bountyId}/proposals/${proposalId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch { return false; }
}

export async function acceptBountyProposal(
  bountyId: string,
  proposalId: string,
  creatorWallet: string
): Promise<{ bounty: Bounty | null; error?: string }> {
  try {
    const res = await fetch(`${API}/api/bounties/${bountyId}/proposals/${proposalId}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callerWallet: creatorWallet }),
    });
    const json = await res.json();
    if (!res.ok) return { bounty: null, error: json.error };
    return { bounty: json.bounty ? bountyFromRow(json.bounty) : null };
  } catch (e) { return { bounty: null, error: String(e) }; }
}

export async function acceptHumanBountyProposal(
  authFetch: AuthFetch,
  bountyId: string,
  proposalId: string
): Promise<{ bounty: Bounty | null; error?: string }> {
  try {
    const res = await authFetch(
      `/api/human/bounties/${bountyId}/proposals/${proposalId}/accept`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }
    );
    const json = await res.json();
    if (!res.ok) return { bounty: null, error: json.error || 'Proposal acceptance failed' };
    return { bounty: json.bounty ? bountyFromRow(json.bounty) : null };
  } catch (error) {
    return { bounty: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function fundHumanBounty(
  authFetch: AuthFetch,
  sendTransaction: SendTransaction,
  bountyId: string
): Promise<{ bounty: Bounty | null; txHash?: string; error?: string }> {
  try {
    let res = await authFetch(`/api/human/bounties/${bountyId}/fund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    let json = await res.json();
    if (res.status === 202 && json.signatureRequired && json.transaction) {
      let txHash: string;
      try {
        txHash = await sendTransaction(json.transaction);
      } catch (error) {
        if (isUserRejectedTransaction(error)) {
          await authFetch(`/api/human/bounties/${bountyId}/fund/abort`, {
            method: 'POST',
          }).catch(() => {});
        }
        throw error;
      }
      const reconciled = await reconcileHumanBountyFunding(authFetch, bountyId, txHash);
      if (reconciled.bounty) {
        return { bounty: reconciled.bounty, txHash };
      }
      return {
        bounty: null,
        txHash,
        error: reconciled.error || 'Funding reconciliation failed',
      };
    }
    if (!res.ok) {
      if (json.txHash) {
        const reconciled = await reconcileHumanBountyFunding(authFetch, bountyId, json.txHash);
        if (reconciled.bounty) {
          return { bounty: reconciled.bounty, txHash: json.txHash };
        }
      }
      return {
        bounty: null,
        txHash: json.txHash || undefined,
        error: json.error || 'Bounty funding failed',
      };
    }
    return {
      bounty: json.bounty ? bountyFromRow(json.bounty) : null,
      txHash: json.txHash || undefined,
    };
  } catch (error) {
    return { bounty: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function rejectBountyProposal(
  bountyId: string,
  proposalId: string,
  creatorWallet: string,
  reason?: string
): Promise<boolean> {
  try {
    const res = await fetch(`${API}/api/bounties/${bountyId}/proposals/${proposalId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callerWallet: creatorWallet, reason }),
    });
    return res.ok;
  } catch { return false; }
}

export async function rejectHumanBountyProposal(
  authFetch: AuthFetch,
  bountyId: string,
  proposalId: string,
  reason?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await authFetch(
      `/api/human/bounties/${bountyId}/proposals/${proposalId}/reject`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      }
    );
    const json = await res.json();
    if (!res.ok) return { ok: false, error: json.error || 'Proposal rejection failed' };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function fetchBountyMessages(
  bountyId: string,
  proposalId: string,
  authFetch: AuthFetch
): Promise<{ messages: BountyMessage[]; isCreator: boolean; isProposer: boolean }> {
  try {
    const url = `/api/human/bounties/${bountyId}/messages?proposalId=${encodeURIComponent(proposalId)}`;
    const res = await authFetch(url);
    const json = await res.json();
    return {
      messages: (json.messages || []).map(messageFromRow),
      isCreator: Boolean(json.isCreator),
      isProposer: Boolean(json.isProposer),
    };
  } catch { return { messages: [], isCreator: false, isProposer: false }; }
}

export async function sendBountyMessage(
  authFetch: AuthFetch,
  bountyId: string,
  data: { proposalId: string; message: string }
): Promise<boolean> {
  try {
    const res = await authFetch(`/api/human/bounties/${bountyId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return res.ok;
  } catch { return false; }
}

// ══════════════════════════════════════════════════════
// ── Commitments (Phase 2: Commit-Reveal) ──
// ══════════════════════════════════════════════════════

export async function createCommitment(data: {
  agentId: string;
  commitmentHash: string;
  salt: string;
}): Promise<{ commitmentId: string; commitmentHash: string } | null> {
  try {
    const res = await fetch(`${API}/api/commitments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    return json.success ? { commitmentId: json.commitmentId, commitmentHash: json.commitmentHash } : null;
  } catch { return null; }
}

export async function revealCommitment(commitmentId: string, data: {
  reasoning: string;
  salt: string;
}): Promise<boolean> {
  try {
    const res = await fetch(`${API}/api/commitments/${commitmentId}/reveal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return res.ok;
  } catch { return false; }
}

export async function fetchCommitmentsByAgent(agentId: string): Promise<Commitment[]> {
  try {
    const res = await fetch(`${API}/api/commitments/agent/${agentId}`);
    const json = await res.json();
    return json.commitments || [];
  } catch { return []; }
}

// ══════════════════════════════════════════════════════
// ── Records (Phase 2: On-chain mirror) ──
// ══════════════════════════════════════════════════════

export async function fetchRecords(limit = 20): Promise<Record<string, unknown>[]> {
  try {
    const res = await fetch(`${API}/api/records?limit=${limit}`);
    const json = await res.json();
    return json.records || [];
  } catch { return []; }
}

export async function fetchRecordByContribution(contributionId: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${API}/api/records/${contributionId}`);
    const json = await res.json();
    return json.record || null;
  } catch { return null; }
}

// ══════════════════════════════════════════════════════
// ── SSE Live Feed Hook Helper ──
// ══════════════════════════════════════════════════════

export function createFeedStream(onEvent: (event: FeedEvent) => void): () => void {
  const source = new EventSource(`${API}/api/feed/stream`);
  source.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data) as FeedEvent;
      onEvent(event);
    } catch { /* ignore parse errors */ }
  };
  // Let EventSource auto-reconnect on transient errors (built-in behavior)
  // Only log — don't close, or reconnection is permanently killed
  source.onerror = () => console.debug('[FeedStream] connection error, will auto-reconnect');
  return () => source.close();
}

// ══════════════════════════════════════════════════════
// ── Agent Search & Marketplace (Phase 1) ──
// ══════════════════════════════════════════════════════

export async function searchAgents(params: {
  q?: string;
  specialization?: string;
  min_reputation?: number;
  availability?: string;
}): Promise<{ agents: Agent[]; count: number }> {
  try {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.specialization) qs.set('specialization', params.specialization);
    if (params.min_reputation) qs.set('min_reputation', params.min_reputation.toString());
    if (params.availability) qs.set('availability', params.availability);
    const res = await fetch(`${API}/api/agents/search?${qs.toString()}`);
    const json = await res.json();
    return { agents: json.agents || [], count: json.count || 0 };
  } catch { return { agents: [], count: 0 }; }
}

export async function fetchFeaturedAgents(): Promise<Agent[]> {
  try {
    const res = await fetch(`${API}/api/agents/featured`);
    const json = await res.json();
    return json.agents || [];
  } catch { return []; }
}

// ══════════════════════════════════════════════════════
// ── Cross-Agent Verification (Phase 2) ──
// ══════════════════════════════════════════════════════

export interface VerificationStats {
  total: number;
  approved: number;
  rejected: number;
  accuracy: number;
}

export async function agentVerifyContribution(
  contributionId: string,
  data: { verifierAgentId?: string; result: string; reasoning?: string; signature?: string },
  token?: string,
): Promise<{ success: boolean; approvals: number; rejections: number; autoAction?: string; error?: string }> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API}/api/contributions/${contributionId}/agent-verify`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!res.ok) {
      return {
        success: false,
        approvals: 0,
        rejections: 0,
        error: json.error || 'Agent verification failed',
      };
    }
    return {
      success: true,
      approvals: json.approvals || 0,
      rejections: json.rejections || 0,
      autoAction: json.verification?.autoAction || json.autoAction,
    };
  } catch (cause) {
    return {
      success: false,
      approvals: 0,
      rejections: 0,
      error: cause instanceof Error ? cause.message : 'Agent verification failed',
    };
  }
}

export async function fetchVerificationStats(agentId: string): Promise<VerificationStats | null> {
  try {
    const res = await fetch(`${API}/api/agents/${agentId}/verification-stats`);
    const json = await res.json();
    return json || null;
  } catch { return null; }
}
