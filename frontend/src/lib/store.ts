'use client';

/**
 * Backend-backed store for BARD platform data.
 * All data persists on the backend server — works across browsers/devices.
 */

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

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
  status: 'open' | 'assigned' | 'submitted' | 'verified' | 'expired' | 'cancelled';
  createdAt: string;
  updatedAt: string;
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

export async function saveProfileAsync(profile: StoredProfile): Promise<void> {
  try {
    await fetch(`${API}/api/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    });
    _profileCache[profile.wallet.toLowerCase()] = profile;
    _profileCache[`u:${profile.username}`] = profile;
  } catch (e) { console.error('saveProfile error:', e); }
}

// Synchronous wrapper — saves in background, updates cache immediately
export function saveProfile(profile: StoredProfile): void {
  _profileCache[profile.wallet.toLowerCase()] = profile;
  _profileCache[`u:${profile.username}`] = profile;
  saveProfileAsync(profile);
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

export async function saveProofAsync(proof: StoredProof): Promise<void> {
  try {
    await fetch(`${API}/api/proofs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proof),
    });
    const key = proof.contributor.toLowerCase();
    if (!_proofCache[key]) _proofCache[key] = [];
    _proofCache[key].push(proof);
  } catch (e) { console.error('saveProof error:', e); }
}

export function saveProof(proof: StoredProof): void {
  const key = proof.contributor.toLowerCase();
  if (!_proofCache[key]) _proofCache[key] = [];
  _proofCache[key].push(proof);
  saveProofAsync(proof);
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

export async function savePortfolioItemAsync(item: PortfolioItem): Promise<void> {
  try {
    await fetch(`${API}/api/portfolio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    });
    const key = item.wallet.toLowerCase();
    if (!_portfolioCache[key]) _portfolioCache[key] = [];
    _portfolioCache[key].push(item);
  } catch (e) { console.error('savePortfolioItem error:', e); }
}

export function savePortfolioItem(item: PortfolioItem): void {
  const key = item.wallet.toLowerCase();
  if (!_portfolioCache[key]) _portfolioCache[key] = [];
  _portfolioCache[key].push(item);
  savePortfolioItemAsync(item);
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

export async function deletePortfolioItemAsync(id: string): Promise<void> {
  try {
    await fetch(`${API}/api/portfolio/${id}`, { method: 'DELETE' });
    // Remove from all caches
    for (const key of Object.keys(_portfolioCache)) {
      _portfolioCache[key] = _portfolioCache[key].filter(p => p.id !== id);
    }
  } catch (e) { console.error('deletePortfolioItem error:', e); }
}

export function deletePortfolioItem(id: string): void {
  for (const key of Object.keys(_portfolioCache)) {
    _portfolioCache[key] = _portfolioCache[key].filter(p => p.id !== id);
  }
  deletePortfolioItemAsync(id);
}

export async function reorderPortfolioItems(wallet: string, orderedIds: string[]): Promise<void> {
  try {
    await fetch(`${API}/api/portfolio/reorder`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet, orderedIds }),
    });
  } catch (e) { console.error('reorderPortfolioItems error:', e); }
}

// ══════════════════════════════════════════════════════
// ── Notifications ──
// ══════════════════════════════════════════════════════

export async function addNotificationAsync(notif: Omit<Notification, 'id' | 'read' | 'createdAt'>): Promise<void> {
  try {
    await fetch(`${API}/api/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notif),
    });
  } catch (e) { console.error('addNotification error:', e); }
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
  addNotificationAsync(notif);
}

export async function fetchNotificationsByWallet(wallet: string): Promise<Notification[]> {
  try {
    const res = await fetch(`${API}/api/notifications/${wallet}`);
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

export async function markNotificationReadAsync(id: string): Promise<void> {
  try {
    await fetch(`${API}/api/notifications/${id}/read`, { method: 'PUT' });
  } catch (e) { console.error('markNotificationRead error:', e); }
}

export function markNotificationRead(id: string): void {
  // Update all caches
  for (const key of Object.keys(_notifCache)) {
    _notifCache[key] = _notifCache[key].map(n => n.id === id ? { ...n, read: true } : n);
  }
  markNotificationReadAsync(id);
}

export async function markAllNotificationsReadAsync(wallet: string): Promise<void> {
  try {
    await fetch(`${API}/api/notifications/${wallet}/read-all`, { method: 'PUT' });
    if (_notifCache[wallet.toLowerCase()]) {
      _notifCache[wallet.toLowerCase()] = _notifCache[wallet.toLowerCase()].map(n => ({ ...n, read: true }));
    }
  } catch (e) { console.error('markAllNotificationsRead error:', e); }
}

export function markAllNotificationsRead(wallet: string): void {
  if (_notifCache[wallet.toLowerCase()]) {
    _notifCache[wallet.toLowerCase()] = _notifCache[wallet.toLowerCase()].map(n => ({ ...n, read: true }));
  }
  markAllNotificationsReadAsync(wallet);
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
  endorserWallet: string;
  endorserType?: string;
  comment?: string;
  signature?: string;
}): Promise<{ success: boolean; endorsementCount: number; reputation: ReputationData | null }> {
  try {
    const res = await fetch(`${API}/api/contributions/${contributionId}/endorse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!res.ok) return { success: false, endorsementCount: 0, reputation: null };
    return { success: true, endorsementCount: json.endorsementCount || 0, reputation: json.reputation || null };
  } catch { return { success: false, endorsementCount: 0, reputation: null }; }
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
    createdAt: (row.created_at || row.createdAt) as string,
    updatedAt: (row.updated_at || row.updatedAt) as string,
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
