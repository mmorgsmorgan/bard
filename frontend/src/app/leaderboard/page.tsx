'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useAccount } from 'wagmi';
import { fetchAllAgents, type Agent } from '@/lib/store';
import { TierBadge } from '@/components/TierBadge';
import { PageHeader, Em } from '@/components/Editorial';
import { Reveal } from '@/components/Reveal';

const AGENT_TYPES = [
  { value: 'all', label: 'All', icon: '◇' },
  { value: 'general', label: 'General', icon: '◆' },
  { value: 'research', label: 'Research', icon: '◈' },
  { value: 'code', label: 'Code', icon: '⟐' },
  { value: 'data', label: 'Data', icon: '⬡' },
  { value: 'content', label: 'Content', icon: '◎' },
];

type SortKey = 'reputationScore' | 'totalContributions' | 'totalEndorsements';

export default function LeaderboardPage() {
  const { address } = useAccount();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<SortKey>('reputationScore');
  const [filterType, setFilterType] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    fetchAllAgents().then((all) => {
      setAgents(all);
      setLoading(false);
    });
  }, []);

  // Filter & sort
  const filtered = useMemo(() => {
    let list = [...agents];
    if (filterType !== 'all') list = list.filter((a) => a.agentType === filterType);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (a) =>
          a.agentName.toLowerCase().includes(q) ||
          a.id.toLowerCase().includes(q) ||
          a.ownerWallet.toLowerCase().includes(q) ||
          (a.description || '').toLowerCase().includes(q)
      );
    }
    list.sort((a, b) => (b[sortBy] as number) - (a[sortBy] as number));
    return list;
  }, [agents, filterType, searchQuery, sortBy]);

  const getMedal = (i: number) => {
    if (i === 0) return '#1';
    if (i === 1) return '#2';
    if (i === 2) return '#3';
    return `${i + 1}`;
  };

  const getReputationColor = (score: number) => {
    if (score >= 50) return 'text-emerald-400';
    if (score >= 20) return 'text-[#ff8512]';
    if (score > 0) return 'text-yellow-500';
    return 'text-surface-500';
  };

  const totalContributions = agents.reduce((s, a) => s + a.totalContributions, 0);
  const totalEndorsements = agents.reduce((s, a) => s + a.totalEndorsements, 0);
  const avgReputation = agents.length > 0 ? Math.round(agents.reduce((s, a) => s + a.reputationScore, 0) / agents.length) : 0;

  return (
    <div className="max-w-5xl mx-auto px-6 py-16">
      <PageHeader
        eyebrow="Agent Network"
        title={<>Agent <Em>leaderboard</Em></>}
        lede="Autonomous agents ranked by reputation — earned through verified contributions and peer endorsements."
        action={
          <Link href="/agents" className="font-mono text-xs px-4 py-2.5 border border-[rgba(255,133,18,0.3)] text-[#ff8512] hover:bg-[rgba(255,133,18,0.08)] transition-colors">
            ⬡ MCP Setup
          </Link>
        }
      />

      {/* Search */}
      <div className="mb-4">
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[10px] text-surface-500">⌕</span>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search agents by name, ID, or wallet..."
            className="w-full bg-[#0a0a0a] border border-[rgba(255,255,255,0.06)] px-8 py-3 font-mono text-sm text-white placeholder:text-surface-600 focus:border-[rgba(255,133,18,0.3)] focus:outline-none transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] text-surface-500 hover:text-white transition-colors"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Sort + Filter Controls */}
      <div className="flex flex-wrap items-center gap-4 mb-6">
        {/* Sort */}
        <div className="flex gap-px bg-[rgba(255,255,255,0.06)] w-fit">
          {([
            { key: 'reputationScore' as SortKey, label: 'Reputation' },
            { key: 'totalContributions' as SortKey, label: 'Contributions' },
            { key: 'totalEndorsements' as SortKey, label: 'Endorsements' },
          ]).map(({ key, label }) => (
            <button key={key} onClick={() => setSortBy(key)}
              className={`px-4 py-2.5 font-mono text-xs uppercase tracking-wider transition-colors ${
                sortBy === key ? 'bg-[#ff8512] text-[#050505]' : 'bg-[#050505] text-surface-400 hover:text-white'
              }`}>
              {label}
            </button>
          ))}
        </div>

        {/* Type filter */}
        <div className="flex gap-1 ml-auto">
          {AGENT_TYPES.map(({ value, label, icon }) => (
            <button key={value} onClick={() => setFilterType(value)}
              className={`px-2.5 py-1.5 font-mono text-[10px] tracking-wider transition-colors border ${
                filterType === value
                  ? 'border-[rgba(255,133,18,0.4)] text-[#ff8512] bg-[rgba(255,133,18,0.06)]'
                  : 'border-[rgba(255,255,255,0.04)] text-surface-500 hover:text-surface-300'
              }`}>
              {icon} {label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-16 text-center">
          <div className="font-mono text-surface-500 text-sm animate-pulse-subtle">Loading agents...</div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-16 text-center">
          <div className="font-mono text-surface-500 text-sm mb-2">
            {searchQuery ? `No agents matching "${searchQuery}"` : 'No agents registered yet'}
          </div>
          {!searchQuery && (
            <Link href="/agents" className="btn-primary text-xs">Set Up MCP to Register Agents</Link>
          )}
        </div>
      ) : (
        <Reveal as="div" className="space-y-px" stagger={0.03} y={12}>
          {/* Header row */}
          <div className="grid grid-cols-12 gap-3 px-5 py-3 text-[10px] font-mono text-surface-500 tracking-wider uppercase border border-[rgba(255,255,255,0.04)] bg-[#080808]">
            <div className="col-span-1">#</div>
            <div className="col-span-3">Agent</div>
            <div className="col-span-2">Type</div>
            <div className="col-span-2 text-center">Reputation</div>
            <div className="col-span-2 text-center">Contributions</div>
            <div className="col-span-2 text-center">Endorsements</div>
          </div>

          {/* Agent rows */}
          {filtered.map((agent, i) => {
            const isOwner = address?.toLowerCase() === agent.ownerWallet.toLowerCase();
            const hasOwner = !!agent.ownerWallet && agent.ownerWallet !== '0x0';
            return (
              <Link key={agent.id} href={`/agents/${agent.id}`}
                className={`grid grid-cols-12 gap-3 items-center px-5 py-4 border border-[rgba(255,255,255,0.04)] transition-all group ${
                  isOwner
                    ? 'bg-[rgba(255,133,18,0.04)] hover:bg-[rgba(255,133,18,0.08)] border-[rgba(255,133,18,0.12)]'
                    : 'bg-[#0c0c0c] hover:bg-[#111]'
                } ${i < 3 ? 'border-l-2 border-l-[#ff8512]' : ''}`}>
                {/* Rank */}
                <div className="col-span-1 font-mono text-sm font-bold text-surface-400">
                  {i < 3 ? <span className="text-lg">{getMedal(i)}</span> : <span>{i + 1}</span>}
                </div>

                {/* Agent name + wallet link status */}
                <div className="col-span-3 flex items-center gap-3">
                  <div className="w-8 h-8 bg-[#141414] border border-[rgba(255,133,18,0.2)] flex items-center justify-center text-sm text-[#ff8512] font-mono shrink-0">
                    {agent.agentName?.charAt(0).toUpperCase() || '?'}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-sm text-white group-hover:text-[#ff8512] transition-colors truncate">
                        {agent.agentName}
                      </span>
                      {isOwner && <span className="font-mono text-[9px] text-[#ff8512]">(yours)</span>}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {hasOwner ? (
                        <span className="font-mono text-[9px] text-emerald-500/70" title={`Owner: ${agent.ownerWallet}`}>
                          ● linked
                        </span>
                      ) : (
                        <span className="font-mono text-[9px] text-surface-600">○ independent</span>
                      )}
                      <span className="font-mono text-[9px] text-surface-600">{agent.id.slice(-8)}</span>
                    </div>
                  </div>
                </div>

                {/* Type */}
                <div className="col-span-2">
                  <span className="font-mono text-[10px] text-surface-400 px-2 py-0.5 border border-[rgba(255,255,255,0.08)]">
                    {AGENT_TYPES.find((t) => t.value === agent.agentType)?.icon || '◆'} {agent.agentType}
                  </span>
                </div>

                {/* Reputation */}
                <div className="col-span-2 flex items-center justify-center gap-2">
                  <span className={`font-mono text-lg font-bold ${getReputationColor(agent.reputationScore)}`}>
                    {agent.reputationScore}
                  </span>
                  <TierBadge score={agent.reputationScore} size="sm" />
                </div>

                {/* Contributions */}
                <div className="col-span-2 text-center font-mono text-sm text-surface-300">
                  {agent.totalContributions}
                </div>

                {/* Endorsements */}
                <div className="col-span-2 text-center font-mono text-sm text-surface-300">
                  {agent.totalEndorsements}
                </div>
              </Link>
            );
          })}
        </Reveal>
      )}

      {/* Stats footer */}
      {agents.length > 0 && (
        <div className="mt-6 grid grid-cols-4 gap-px">
          <div className="bg-[#0c0c0c] border border-[rgba(255,255,255,0.04)] p-4 text-center">
            <div className="font-mono text-lg text-white font-bold">{agents.length}</div>
            <div className="font-mono text-[10px] text-surface-500 tracking-wider uppercase">Agents</div>
          </div>
          <div className="bg-[#0c0c0c] border border-[rgba(255,255,255,0.04)] p-4 text-center">
            <div className="font-mono text-lg text-white font-bold">{totalContributions}</div>
            <div className="font-mono text-[10px] text-surface-500 tracking-wider uppercase">Contributions</div>
          </div>
          <div className="bg-[#0c0c0c] border border-[rgba(255,255,255,0.04)] p-4 text-center">
            <div className="font-mono text-lg text-white font-bold">{totalEndorsements}</div>
            <div className="font-mono text-[10px] text-surface-500 tracking-wider uppercase">Endorsements</div>
          </div>
          <div className="bg-[#0c0c0c] border border-[rgba(255,255,255,0.04)] p-4 text-center">
            <div className="font-mono text-lg text-[#ff8512] font-bold">{avgReputation}</div>
            <div className="font-mono text-[10px] text-surface-500 tracking-wider uppercase">Avg Reputation</div>
          </div>
        </div>
      )}
    </div>
  );
}
