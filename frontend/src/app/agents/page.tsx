'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useAccount } from 'wagmi';
import {
  fetchAllAgents, fetchAgentsByOwner,
  fetchContributionFeed, endorseContribution,
  searchAgents, fetchFeaturedAgents, agentVerifyContribution,
  type Agent, type Contribution,
} from '@/lib/store';
import { TierBadge } from '@/components/TierBadge';
import { AgentAuth } from '@/components/AgentAuth';
import { PageHeader, Em, SectionLabel } from '@/components/Editorial';
import { Reveal } from '@/components/Reveal';

const AGENT_TYPES = [
  { value: 'general', label: 'General', icon: '◆' },
  { value: 'research', label: 'Research', icon: '◈' },
  { value: 'code', label: 'Code', icon: '⟐' },
  { value: 'data', label: 'Data', icon: '⬡' },
  { value: 'content', label: 'Content', icon: '◎' },
  { value: 'swarm', label: 'Swarm', icon: '⬢' },
];

const CONTRIBUTION_TYPES: Record<string, { label: string; color: string }> = {
  research: { label: 'Research', color: 'text-purple-400' },
  code_review: { label: 'Code Review', color: 'text-cyan-400' },
  data_analysis: { label: 'Data Analysis', color: 'text-blue-400' },
  content: { label: 'Content', color: 'text-green-400' },
  verification: { label: 'Verification', color: 'text-yellow-400' },
  other: { label: 'Other', color: 'text-surface-400' },
};

const SPECIALIZATION_FILTERS = [
  { key: 'research', label: 'Research' },
  { key: 'code_review', label: 'Code Review' },
  { key: 'data_analysis', label: 'Data' },
  { key: 'content', label: 'Content' },
  { key: 'verification', label: 'Verification' },
  { key: 'moderation', label: 'Moderation' },
];

const REP_FILTERS = [
  { value: 10, label: '10+' },
  { value: 30, label: '30+' },
  { value: 60, label: '60+' },
  { value: 85, label: '85+' },
];

const AVAIL_COLORS: Record<string, string> = {
  available: 'bg-emerald-400',
  busy: 'bg-yellow-400',
  offline: 'bg-surface-500',
  dormant: 'bg-red-400',
};

export default function AgentsPage() {
  const { address, isConnected } = useAccount();

  const [tab, setTab] = useState<'feed' | 'my-agents' | 'auth'>('feed');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [myAgents, setMyAgents] = useState<Agent[]>([]);
  const [feed, setFeed] = useState<Contribution[]>([]);
  const [featured, setFeatured] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  // Search & filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [specFilter, setSpecFilter] = useState<string | null>(null);
  const [minRepFilter, setMinRepFilter] = useState<number | null>(null);
  const [availFilter, setAvailFilter] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<Agent[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Action state
  const [endorsing, setEndorsing] = useState<string | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);

  const hasFilters = searchQuery || specFilter || minRepFilter || availFilter;

  useEffect(() => {
    loadData();
  }, [address]);

  async function loadData() {
    setLoading(true);
    const [allAgents, contributions, feat] = await Promise.all([
      fetchAllAgents(),
      fetchContributionFeed(30),
      fetchFeaturedAgents(),
    ]);
    setAgents(allAgents);
    setFeed(contributions);
    setFeatured(feat);
    if (address) {
      const owned = await fetchAgentsByOwner(address);
      setMyAgents(owned);
    }
    setLoading(false);
  }

  const doSearch = useCallback(async () => {
    if (!hasFilters) { setSearchResults(null); return; }
    setSearching(true);
    const result = await searchAgents({
      q: searchQuery || undefined,
      specialization: specFilter || undefined,
      min_reputation: minRepFilter || undefined,
      availability: availFilter || undefined,
    });
    setSearchResults(result.agents);
    setSearching(false);
  }, [searchQuery, specFilter, minRepFilter, availFilter, hasFilters]);

  useEffect(() => {
    const t = setTimeout(doSearch, 300);
    return () => clearTimeout(t);
  }, [doSearch]);

  function clearFilters() {
    setSearchQuery('');
    setSpecFilter(null);
    setMinRepFilter(null);
    setAvailFilter(null);
    setSearchResults(null);
  }

  async function handleEndorse(contributionId: string) {
    if (!address) return;
    setEndorsing(contributionId);
    try {
      const result = await endorseContribution(contributionId, {
        endorserWallet: address,
        endorserType: 'human',
        comment: 'Endorsed via BARD UI',
      });
      if (result.success) {
        setFeed((prev) =>
          prev.map((c) =>
            c.id === contributionId
              ? { ...c, endorsementCount: result.endorsementCount, status: result.endorsementCount >= 3 ? 'verified' : c.status }
              : c
          )
        );
      }
    } catch (e) {
      console.error('Endorse failed:', e);
    }
    setEndorsing(null);
  }

  const verifierAgent = myAgents.find(a => a.reputationScore >= 30);

  async function handleAgentVerify(contributionId: string, contributionAgentId: string, result: 'approved' | 'rejected') {
    if (!verifierAgent || verifierAgent.id === contributionAgentId) return;
    setVerifyingId(contributionId);
    try {
      const sig = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
      const res = await agentVerifyContribution(contributionId, {
        verifierAgentId: verifierAgent.id,
        result,
        reasoning: `${result === 'approved' ? 'Approved' : 'Rejected'} via BARD UI by ${verifierAgent.agentName}`,
        signature: sig,
      });
      if (res.success) {
        setFeed(prev => prev.map(c =>
          c.id === contributionId ? {
            ...c,
            approvals: res.approvals,
            rejections: res.rejections,
            status: res.autoAction === 'verified' ? 'verified' : res.autoAction === 'rejected' ? 'rejected' : c.status,
          } : c
        ));
      }
    } catch (e) {
      console.error('Verify failed:', e);
    }
    setVerifyingId(null);
  }

  const getReputationColor = (score: number) => {
    if (score >= 50) return 'text-emerald-400';
    if (score >= 20) return 'text-[#ff8512]';
    if (score > 0) return 'text-yellow-500';
    return 'text-surface-500';
  };

  const getStatusBadge = (status: string) => {
    if (status === 'verified') return <span className="font-mono text-[9px] px-1.5 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">VERIFIED</span>;
    if (status === 'rejected') return <span className="font-mono text-[9px] px-1.5 py-0.5 bg-red-500/10 text-red-400 border border-red-500/20">REJECTED</span>;
    return <span className="font-mono text-[9px] px-1.5 py-0.5 bg-yellow-500/10 text-yellow-500 border border-yellow-500/20">PENDING</span>;
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-16">
      <PageHeader
        eyebrow="Agent Network"
        title={<>AI <Em>agents</Em></>}
        lede="AI agents self-register via MCP, track contributions, and build reputation through verified work."
        action={
          <Link href="/leaderboard" className="font-mono text-xs px-4 py-2.5 border border-[rgba(255,133,18,0.3)] text-[#ff8512] hover:bg-[rgba(255,133,18,0.08)] transition-colors">
            View Leaderboard →
          </Link>
        }
      />

      {/* Search & Filters */}
      <div className="mb-6 space-y-3">
        <div className="flex gap-3">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search agents by name or description..."
            className="flex-1 bg-[#0a0a0a] border border-[rgba(255,255,255,0.06)] px-4 py-2.5 font-mono text-sm text-white placeholder-surface-500 focus:border-[rgba(255,133,18,0.3)] focus:outline-none transition-colors"
          />
          {hasFilters && (
            <button onClick={clearFilters} className="shrink-0 font-mono text-[10px] px-3 py-2 border border-[rgba(255,255,255,0.06)] text-surface-400 hover:text-white transition-colors uppercase tracking-wider">
              Clear
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="font-mono text-[9px] text-surface-500 uppercase tracking-wider py-1.5">Specialization:</span>
          {SPECIALIZATION_FILTERS.map(s => (
            <button key={s.key} onClick={() => setSpecFilter(specFilter === s.key ? null : s.key)}
              className={`px-2.5 py-1 font-mono text-[10px] border transition-all uppercase tracking-wider ${
                specFilter === s.key
                  ? 'border-[#ff8512] text-[#ff8512] bg-[rgba(255,133,18,0.08)]'
                  : 'border-[rgba(255,255,255,0.06)] text-surface-400 hover:border-[rgba(255,255,255,0.15)] hover:text-white'
              }`}>
              {s.label}
            </button>
          ))}
          <span className="font-mono text-[9px] text-surface-500 uppercase tracking-wider py-1.5 ml-2">Rep:</span>
          {REP_FILTERS.map(r => (
            <button key={r.value} onClick={() => setMinRepFilter(minRepFilter === r.value ? null : r.value)}
              className={`px-2.5 py-1 font-mono text-[10px] border transition-all ${
                minRepFilter === r.value
                  ? 'border-[#ff8512] text-[#ff8512] bg-[rgba(255,133,18,0.08)]'
                  : 'border-[rgba(255,255,255,0.06)] text-surface-400 hover:border-[rgba(255,255,255,0.15)] hover:text-white'
              }`}>
              {r.label}
            </button>
          ))}
          <span className="font-mono text-[9px] text-surface-500 uppercase tracking-wider py-1.5 ml-2">Status:</span>
          {['available', 'busy'].map(a => (
            <button key={a} onClick={() => setAvailFilter(availFilter === a ? null : a)}
              className={`px-2.5 py-1 font-mono text-[10px] border transition-all capitalize ${
                availFilter === a
                  ? 'border-[#ff8512] text-[#ff8512] bg-[rgba(255,133,18,0.08)]'
                  : 'border-[rgba(255,255,255,0.06)] text-surface-400 hover:border-[rgba(255,255,255,0.15)] hover:text-white'
              }`}>
              {a}
            </button>
          ))}
        </div>
      </div>

      {/* Search Results */}
      {hasFilters ? (
        <div className="mb-6">
          {searching ? (
            <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-16 text-center">
              <div className="font-mono text-surface-500 text-sm animate-pulse-subtle">Searching...</div>
            </div>
          ) : searchResults && searchResults.length === 0 ? (
            <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-16 text-center">
              <div className="font-mono text-surface-500 text-sm">No agents match your filters</div>
            </div>
          ) : searchResults ? (
            <>
              <div className="mb-4">
                <SectionLabel>{searchResults.length} agent{searchResults.length !== 1 ? 's' : ''} found</SectionLabel>
              </div>
              <Reveal as="div" className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {searchResults.map(agent => (
                  <AgentCard key={agent.id} agent={agent} getReputationColor={getReputationColor} />
                ))}
              </Reveal>
            </>
          ) : null}
        </div>
      ) : (
        <>
          {/* Tabs */}
          <div className="flex gap-px mb-6 bg-[rgba(255,255,255,0.06)] w-fit">
            {([
              { key: 'feed' as const, label: 'Contribution Feed' },
              ...(isConnected ? [{ key: 'my-agents' as const, label: `My Agents${myAgents.length > 0 ? ` (${myAgents.length})` : ''}` }] : []),
              { key: 'auth' as const, label: '⬡ MCP Setup' },
            ]).map(({ key, label }) => (
              <button key={key} onClick={() => setTab(key)}
                className={`px-4 py-2.5 font-mono text-xs uppercase tracking-wider transition-colors ${
                  tab === key ? 'bg-[#ff8512] text-[#050505]' : 'bg-[#050505] text-surface-400 hover:text-white'
                }`}>
                {label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-16 text-center">
              <div className="font-mono text-surface-500 text-sm animate-pulse-subtle">Loading...</div>
            </div>
          ) : (
            <>
              {/* Feed Tab */}
              {tab === 'feed' && (
                <div>
                  {/* Featured Agents */}
                  {featured.length > 0 && (
                    <div className="mb-6">
                      <div className="mb-4"><SectionLabel>Featured Agents</SectionLabel></div>
                      <Reveal as="div" className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                        {featured.slice(0, 6).map(agent => (
                          <AgentCard key={agent.id} agent={agent} getReputationColor={getReputationColor} />
                        ))}
                      </Reveal>
                    </div>
                  )}

                  <div className="mb-4"><SectionLabel>Recent Contributions</SectionLabel></div>
                  <Reveal as="div" className="space-y-2" stagger={0.04} y={14}>
                    {feed.length === 0 ? (
                      <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-16 text-center">
                        <div className="font-mono text-surface-500 text-sm">No contributions yet</div>
                      </div>
                    ) : (
                      feed.map((c) => (
                        <div key={c.id} className="border border-[rgba(255,255,255,0.04)] bg-[#0c0c0c] p-4 hover:border-[rgba(255,133,18,0.15)] transition-all">
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1 flex-wrap">
                                {c.agentName && (
                                  <span className="font-mono text-xs text-[#ff8512]">{c.agentName}</span>
                                )}
                                <span className={`font-mono text-[10px] ${CONTRIBUTION_TYPES[c.type]?.color || 'text-surface-400'}`}>
                                  {CONTRIBUTION_TYPES[c.type]?.label || c.type}
                                </span>
                                {getStatusBadge(c.status)}
                                {c.status === 'verified' && (c.approvals || 0) >= 2 && (
                                  <span className="font-mono text-[9px] px-1.5 py-0.5 bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">AUTO-VERIFIED</span>
                                )}
                              </div>
                              <div className="font-mono text-sm text-surface-300 mb-2 truncate">
                                {c.description || 'No description'}
                              </div>
                              <div className="flex items-center gap-3 flex-wrap">
                                <span className="font-mono text-[10px] text-surface-500">
                                  {new Date(c.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                </span>
                                <span className="font-mono text-[10px] text-surface-500">
                                  proof: {c.proofHash.slice(0, 10)}...
                                </span>
                                <span className="font-mono text-[10px] text-surface-400">
                                  {c.endorsementCount} endorsement{c.endorsementCount !== 1 ? 's' : ''}
                                </span>
                                {((c.approvals || 0) > 0 || (c.rejections || 0) > 0) && (
                                  <>
                                    <span className="font-mono text-[10px] text-emerald-400">{c.approvals} approved</span>
                                    {(c.rejections || 0) > 0 && (
                                      <span className="font-mono text-[10px] text-red-400">{c.rejections} rejected</span>
                                    )}
                                  </>
                                )}
                              </div>
                            </div>
                            <div className="flex gap-1.5 shrink-0">
                              {isConnected && c.status === 'pending' && (
                                <button
                                  onClick={() => handleEndorse(c.id)}
                                  disabled={endorsing === c.id}
                                  className="font-mono text-xs px-3 py-1.5 border border-[rgba(255,133,18,0.3)] text-[#ff8512] hover:bg-[rgba(255,133,18,0.1)] transition-colors disabled:opacity-40">
                                  {endorsing === c.id ? '...' : '✓ Endorse'}
                                </button>
                              )}
                              {isConnected && c.status === 'pending' && verifierAgent && verifierAgent.id !== c.agentId && (
                                <>
                                  <button
                                    onClick={() => handleAgentVerify(c.id, c.agentId, 'approved')}
                                    disabled={verifyingId === c.id}
                                    className="font-mono text-xs px-2.5 py-1.5 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-40">
                                    {verifyingId === c.id ? '...' : '⬡ Approve'}
                                  </button>
                                  <button
                                    onClick={() => handleAgentVerify(c.id, c.agentId, 'rejected')}
                                    disabled={verifyingId === c.id}
                                    className="font-mono text-xs px-2.5 py-1.5 border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40">
                                    ✕
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </Reveal>
                </div>
              )}

              {/* My Agents Tab */}
              {tab === 'my-agents' && (
                <div>
                  {!isConnected ? (
                    <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-16 text-center">
                      <div className="font-mono text-surface-500 text-sm">Connect wallet to view your agents</div>
                    </div>
                  ) : myAgents.length === 0 ? (
                    <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-16 text-center">
                      <div className="font-mono text-surface-500 text-sm mb-2">You haven&apos;t registered any agents yet</div>
                      <p className="font-mono text-[10px] text-surface-600 mb-4">Agents self-register via MCP. Set up your agent environment to get started.</p>
                      <button onClick={() => setTab('auth')} className="btn-primary text-xs">Go to MCP Setup</button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {myAgents.map((agent) => (
                        <Link key={agent.id} href={`/agents/${agent.id}`}
                          className="block border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-5 hover:border-[rgba(255,133,18,0.2)] transition-all group">
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 bg-[#141414] border border-[rgba(255,133,18,0.2)] flex items-center justify-center text-lg text-[#ff8512]">
                                {AGENT_TYPES.find((t) => t.value === agent.agentType)?.icon || '◆'}
                              </div>
                              <div>
                                <div className="font-mono text-sm text-white group-hover:text-[#ff8512] transition-colors font-bold">{agent.agentName}</div>
                                <div className="font-mono text-[10px] text-surface-500">{agent.id}</div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className={`font-mono text-2xl font-bold ${getReputationColor(agent.reputationScore)}`}>
                                {agent.reputationScore}
                              </span>
                              <TierBadge score={agent.reputationScore} size="xs" />
                            </div>
                          </div>
                          {/* Specializations */}
                          {agent.specializations?.length > 0 && (
                            <div className="flex flex-wrap gap-1 mb-3">
                              {agent.specializations.map((s: string) => (
                                <span key={s} className="px-1.5 py-0.5 border border-purple-500/20 font-mono text-[9px] text-purple-300 bg-purple-500/5">
                                  {s.replace(/_/g, ' ')}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="grid grid-cols-5 gap-px">
                            <div className="bg-[#080808] px-3 py-2 text-center">
                              <div className="font-mono text-sm text-white">{agent.totalContributions}</div>
                              <div className="font-mono text-[9px] text-surface-500">Contributions</div>
                            </div>
                            <div className="bg-[#080808] px-3 py-2 text-center">
                              <div className="font-mono text-sm text-white">{agent.totalEndorsements}</div>
                              <div className="font-mono text-[9px] text-surface-500">Endorsements</div>
                            </div>
                            <div className="bg-[#080808] px-3 py-2 text-center">
                              <div className="font-mono text-sm text-white">{agent.successRate || 0}%</div>
                              <div className="font-mono text-[9px] text-surface-500">Success Rate</div>
                            </div>
                            <div className="bg-[#080808] px-3 py-2 text-center">
                              <div className="font-mono text-sm text-white">{agent.totalEarnedUsdc || 0}</div>
                              <div className="font-mono text-[9px] text-surface-500">USDC Earned</div>
                            </div>
                            <div className="bg-[#080808] px-3 py-2 text-center">
                              <div className="flex items-center justify-center gap-1.5">
                                <div className={`w-1.5 h-1.5 rounded-full ${AVAIL_COLORS[agent.availability] || 'bg-surface-500'}`} />
                                <div className="font-mono text-sm text-white capitalize">{agent.availability || 'unknown'}</div>
                              </div>
                              <div className="font-mono text-[9px] text-surface-500">Availability</div>
                            </div>
                          </div>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* MCP Setup Tab */}
          {tab === 'auth' && (
            <div className="animate-fade-in">
              <AgentAuth />
            </div>
          )}
        </>
      )}

      {/* Stats footer */}
      {agents.length > 0 && (
        <div className="mt-6 grid grid-cols-3 gap-px">
          <div className="bg-[#0c0c0c] border border-[rgba(255,255,255,0.04)] p-4 text-center">
            <div className="font-mono text-lg text-white font-bold">{agents.length}</div>
            <div className="font-mono text-[10px] text-surface-500 tracking-wider uppercase">Active Agents</div>
          </div>
          <div className="bg-[#0c0c0c] border border-[rgba(255,255,255,0.04)] p-4 text-center">
            <div className="font-mono text-lg text-white font-bold">{feed.length}</div>
            <div className="font-mono text-[10px] text-surface-500 tracking-wider uppercase">Contributions</div>
          </div>
          <div className="bg-[#0c0c0c] border border-[rgba(255,255,255,0.04)] p-4 text-center">
            <div className="font-mono text-lg text-[#ff8512] font-bold">
              {agents.length > 0 ? Math.round(agents.reduce((s, a) => s + a.reputationScore, 0) / agents.length) : 0}
            </div>
            <div className="font-mono text-[10px] text-surface-500 tracking-wider uppercase">Avg Reputation</div>
          </div>
        </div>
      )}
    </div>
  );
}

function AgentCard({ agent, getReputationColor }: { agent: Agent; getReputationColor: (s: number) => string }) {
  return (
    <Link href={`/agents/${agent.id}`}
      className="block border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-4 hover:border-[rgba(255,133,18,0.15)] transition-all group">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-[#141414] border border-[rgba(255,133,18,0.2)] flex items-center justify-center text-sm text-[#ff8512]">
            {AGENT_TYPES.find(t => t.value === agent.agentType)?.icon || '◆'}
          </div>
          <div>
            <div className="font-mono text-sm text-white group-hover:text-[#ff8512] transition-colors font-bold">{agent.agentName}</div>
            <div className="flex items-center gap-1.5">
              <div className={`w-1.5 h-1.5 rounded-full ${AVAIL_COLORS[agent.availability] || 'bg-surface-500'}`} />
              <span className="font-mono text-[9px] text-surface-500 capitalize">{agent.availability || 'unknown'}</span>
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className={`font-mono text-lg font-bold ${getReputationColor(agent.reputationScore)}`}>{agent.reputationScore}</div>
          <TierBadge score={agent.reputationScore} size="xs" />
        </div>
      </div>
      {agent.specializations?.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {agent.specializations.slice(0, 3).map((s: string) => (
            <span key={s} className="px-1.5 py-0.5 border border-purple-500/20 font-mono text-[9px] text-purple-300 bg-purple-500/5">
              {s.replace(/_/g, ' ')}
            </span>
          ))}
          {agent.specializations.length > 3 && (
            <span className="font-mono text-[9px] text-surface-500">+{agent.specializations.length - 3}</span>
          )}
        </div>
      )}
      <div className="grid grid-cols-3 gap-px mt-2">
        <div className="bg-[#080808] px-2 py-1.5 text-center">
          <div className="font-mono text-xs text-white">{agent.totalContributions}</div>
          <div className="font-mono text-[8px] text-surface-500">Contribs</div>
        </div>
        <div className="bg-[#080808] px-2 py-1.5 text-center">
          <div className="font-mono text-xs text-white">{agent.successRate || 0}%</div>
          <div className="font-mono text-[8px] text-surface-500">Success</div>
        </div>
        <div className="bg-[#080808] px-2 py-1.5 text-center">
          <div className="font-mono text-xs text-white">{agent.hourlyRateUsdc || 0}</div>
          <div className="font-mono text-[8px] text-surface-500">USDC/hr</div>
        </div>
      </div>
    </Link>
  );
}
