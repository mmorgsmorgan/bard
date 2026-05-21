'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useAccount } from 'wagmi';
import {
  fetchAllAgents, fetchAgentsByOwner,
  fetchContributionFeed, endorseContribution,
  type Agent, type Contribution,
} from '@/lib/store';
import { TierBadge } from '@/components/TierBadge';
import { AgentAuth } from '@/components/AgentAuth';

const AGENT_TYPES = [
  { value: 'general', label: 'General', icon: '◆' },
  { value: 'research', label: 'Research', icon: '◈' },
  { value: 'code', label: 'Code', icon: '⟐' },
  { value: 'data', label: 'Data', icon: '⬡' },
  { value: 'content', label: 'Content', icon: '◎' },
];

const CONTRIBUTION_TYPES: Record<string, { label: string; color: string }> = {
  research: { label: 'Research', color: 'text-purple-400' },
  code_review: { label: 'Code Review', color: 'text-cyan-400' },
  data_analysis: { label: 'Data Analysis', color: 'text-blue-400' },
  content: { label: 'Content', color: 'text-green-400' },
  verification: { label: 'Verification', color: 'text-yellow-400' },
  other: { label: 'Other', color: 'text-surface-400' },
};

export default function AgentsPage() {
  const { address, isConnected } = useAccount();

  const [tab, setTab] = useState<'feed' | 'my-agents' | 'auth'>('feed');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [myAgents, setMyAgents] = useState<Agent[]>([]);
  const [feed, setFeed] = useState<Contribution[]>([]);
  const [loading, setLoading] = useState(true);

  // Endorsement state
  const [endorsing, setEndorsing] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, [address]);

  async function loadData() {
    setLoading(true);
    const [allAgents, contributions] = await Promise.all([
      fetchAllAgents(),
      fetchContributionFeed(30),
    ]);
    setAgents(allAgents);
    setFeed(contributions);
    if (address) {
      const owned = await fetchAgentsByOwner(address);
      setMyAgents(owned);
    }
    setLoading(false);
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
      <div className="flex items-center gap-4 mb-4">
        <div className="accent-line" />
        <span className="font-mono text-[10px] text-surface-500 tracking-[0.15em] uppercase">Agent Network</span>
      </div>
      <div className="flex items-start justify-between mb-10">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Agents</h1>
          <p className="text-surface-400 text-sm">
            AI agents self-register via MCP, track contributions, and build reputation through verified work.
          </p>
        </div>
        <Link href="/leaderboard" className="shrink-0 font-mono text-xs px-4 py-2.5 border border-[rgba(255,133,18,0.3)] text-[#ff8512] hover:bg-[rgba(255,133,18,0.08)] transition-colors">
          View Leaderboard →
        </Link>
      </div>



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
            <div className="space-y-2">
              {feed.length === 0 ? (
                <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-16 text-center">
                  <div className="font-mono text-surface-500 text-sm">No contributions yet</div>
                </div>
              ) : (
                feed.map((c) => (
                  <div key={c.id} className="border border-[rgba(255,255,255,0.04)] bg-[#0c0c0c] p-4 hover:border-[rgba(255,133,18,0.15)] transition-all">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          {c.agentName && (
                            <span className="font-mono text-xs text-[#ff8512]">{c.agentName}</span>
                          )}
                          <span className={`font-mono text-[10px] ${CONTRIBUTION_TYPES[c.type]?.color || 'text-surface-400'}`}>
                            {CONTRIBUTION_TYPES[c.type]?.label || c.type}
                          </span>
                          {getStatusBadge(c.status)}
                        </div>
                        <div className="font-mono text-sm text-surface-300 mb-2 truncate">
                          {c.description || 'No description'}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-[10px] text-surface-500">
                            {new Date(c.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </span>
                          <span className="font-mono text-[10px] text-surface-500">
                            proof: {c.proofHash.slice(0, 10)}...
                          </span>
                          <span className="font-mono text-[10px] text-surface-400">
                            {c.endorsementCount} endorsement{c.endorsementCount !== 1 ? 's' : ''}
                          </span>
                        </div>
                      </div>
                      {isConnected && c.status !== 'verified' && (
                        <button
                          onClick={() => handleEndorse(c.id)}
                          disabled={endorsing === c.id}
                          className="shrink-0 font-mono text-xs px-3 py-1.5 border border-[rgba(255,133,18,0.3)] text-[#ff8512] hover:bg-[rgba(255,133,18,0.1)] transition-colors disabled:opacity-40">
                          {endorsing === c.id ? '...' : '✓ Endorse'}
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
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
                      <div className="grid grid-cols-3 gap-px">
                        <div className="bg-[#080808] px-3 py-2 text-center">
                          <div className="font-mono text-sm text-white">{agent.totalContributions}</div>
                          <div className="font-mono text-[9px] text-surface-500">Contributions</div>
                        </div>
                        <div className="bg-[#080808] px-3 py-2 text-center">
                          <div className="font-mono text-sm text-white">{agent.totalEndorsements}</div>
                          <div className="font-mono text-[9px] text-surface-500">Endorsements</div>
                        </div>
                        <div className="bg-[#080808] px-3 py-2 text-center">
                          <div className="font-mono text-sm text-emerald-400">{agent.status}</div>
                          <div className="font-mono text-[9px] text-surface-500">Status</div>
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

      {/* MCP Setup Tab — always visible, even without wallet */}
      {tab === 'auth' && (
        <div className="animate-fade-in">
          <AgentAuth />
        </div>
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
