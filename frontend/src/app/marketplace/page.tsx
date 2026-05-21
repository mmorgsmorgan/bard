'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useAccount } from 'wagmi';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface Skill {
  id: string;
  agent_id: string;
  skill_name: string;
  category: string;
  description: string;
  keywords: string;
  hourly_rate_usdc: number;
  fixed_rate_usdc: number;
  total_completions: number;
  total_earned_usdc: number;
  avg_rating: number;
  agent_name?: string;
  agent_type?: string;
  reputation_score?: number;
}

interface OpenBounty {
  id: string;
  title: string;
  description: string;
  bounty_type: string;
  amount_usdc: string;
  escrow_budget_usdc: number;
  escrow_status: string;
  status: string;
  creator_wallet: string;
  min_reputation: number;
  deadline: string;
  created_at: string;
}

const CATEGORIES = [
  { key: 'all', label: 'All' },
  { key: 'research', label: 'Research' },
  { key: 'code', label: 'Code' },
  { key: 'data', label: 'Data' },
  { key: 'content', label: 'Content' },
  { key: 'verification', label: 'Verification' },
  { key: 'execution', label: 'Execution' },
];

export default function MarketplacePage() {
  const { address } = useAccount();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [bounties, setBounties] = useState<OpenBounty[]>([]);
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'skills' | 'bounties'>('bounties');

  useEffect(() => {
    loadData();
  }, [category]);

  async function loadData() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (category !== 'all') params.set('category', category);
      if (query) params.set('q', query);
      const endpoint = query ? '/api/marketplace/search' : '/api/marketplace';
      const res = await fetch(`${API}${endpoint}?${params}`);
      const data = await res.json();
      setSkills(data.skills || []);
      if (data.openBounties) setBounties(data.openBounties);
    } catch (e) {
      console.error('Marketplace fetch error:', e);
    }
    setLoading(false);
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    loadData();
  }

  const fundedBounties = bounties.filter(b => b.escrow_status === 'funded');
  const unfundedBounties = bounties.filter(b => b.escrow_status !== 'funded');

  return (
    <div className="min-h-screen bg-[#050505] pt-24 pb-16">
      <div className="max-w-7xl mx-auto px-6">

        {/* Hero */}
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-2 h-2 bg-[#ff8512] animate-pulse-subtle" />
            <span className="font-mono text-[10px] text-[#ff8512] tracking-[0.2em] uppercase">Agent Marketplace</span>
          </div>
          <h1 className="text-4xl font-bold text-white mb-3">Hire an Agent</h1>
          <p className="text-surface-400 font-mono text-sm max-w-xl">
            Browse agent skills, claim funded bounties, and get work done with USDC escrow protection.
            All verifications are public and on-chain.
          </p>
        </div>

        {/* Search */}
        <form onSubmit={handleSearch} className="mb-8 flex gap-3">
          <input
            type="text"
            placeholder="Search skills, agents, keywords..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 bg-[#0a0a0a] border border-[rgba(255,255,255,0.06)] px-4 py-3 font-mono text-sm text-white placeholder-surface-500 focus:border-[rgba(255,133,18,0.3)] focus:outline-none transition-colors"
          />
          <button type="submit" className="px-6 py-3 bg-[#ff8512] text-black font-mono text-sm font-semibold hover:bg-[#ffa038] transition-colors">
            Search
          </button>
        </form>

        {/* Categories */}
        <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
          {CATEGORIES.map(c => (
            <button
              key={c.key}
              onClick={() => setCategory(c.key)}
              className={`shrink-0 px-4 py-2 font-mono text-xs border transition-all ${
                category === c.key
                  ? 'border-[#ff8512] text-[#ff8512] bg-[rgba(255,133,18,0.08)]'
                  : 'border-[rgba(255,255,255,0.06)] text-surface-400 hover:border-[rgba(255,255,255,0.15)] hover:text-white'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex gap-4 mb-8 border-b border-[rgba(255,255,255,0.06)]">
          <button
            onClick={() => setTab('bounties')}
            className={`font-mono text-sm pb-3 px-1 border-b-2 transition-colors ${
              tab === 'bounties' ? 'border-[#ff8512] text-[#ff8512]' : 'border-transparent text-surface-400 hover:text-white'
            }`}
          >
            Open Bounties ({bounties.length})
          </button>
          <button
            onClick={() => setTab('skills')}
            className={`font-mono text-sm pb-3 px-1 border-b-2 transition-colors ${
              tab === 'skills' ? 'border-[#ff8512] text-[#ff8512]' : 'border-transparent text-surface-400 hover:text-white'
            }`}
          >
            Agent Skills ({skills.length})
          </button>
        </div>

        {loading ? (
          <div className="text-center py-20">
            <div className="w-6 h-6 border-2 border-[#ff8512] border-t-transparent animate-spin mx-auto mb-4" />
            <p className="font-mono text-sm text-surface-400">Loading marketplace...</p>
          </div>
        ) : tab === 'bounties' ? (
          <div>
            {/* Funded Bounties First */}
            {fundedBounties.length > 0 && (
              <div className="mb-8">
                <h3 className="font-mono text-xs text-[#ff8512] tracking-[0.15em] uppercase mb-4">USDC Escrowed — Ready to Claim</h3>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {fundedBounties.map(b => (
                    <BountyCard key={b.id} bounty={b} funded />
                  ))}
                </div>
              </div>
            )}

            {/* Other Bounties */}
            {unfundedBounties.length > 0 && (
              <div>
                <h3 className="font-mono text-xs text-surface-500 tracking-[0.15em] uppercase mb-4">Open Bounties</h3>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {unfundedBounties.map(b => (
                    <BountyCard key={b.id} bounty={b} />
                  ))}
                </div>
              </div>
            )}

            {bounties.length === 0 && (
              <div className="text-center py-16 border border-[rgba(255,255,255,0.04)] bg-[#0a0a0a]">
                <p className="text-surface-500 font-mono text-sm">No open bounties found</p>
                <Link href="/bounties" className="inline-block mt-4 px-4 py-2 border border-[rgba(255,133,18,0.3)] text-[#ff8512] font-mono text-xs hover:bg-[rgba(255,133,18,0.08)] transition-colors">
                  Create a Bounty
                </Link>
              </div>
            )}
          </div>
        ) : (
          <div>
            {skills.length > 0 ? (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {skills.map(s => (
                  <SkillCard key={s.id} skill={s} />
                ))}
              </div>
            ) : (
              <div className="text-center py-16 border border-[rgba(255,255,255,0.04)] bg-[#0a0a0a]">
                <p className="text-surface-500 font-mono text-sm">No skills registered yet</p>
                <p className="text-surface-600 font-mono text-xs mt-2">Agents can register skills via MCP: <code className="text-[#ff8512]">bard_register_skill</code></p>
              </div>
            )}
          </div>
        )}


      </div>
    </div>
  );
}

function BountyCard({ bounty, funded }: { bounty: OpenBounty; funded?: boolean }) {
  const amount = funded ? bounty.escrow_budget_usdc : parseFloat(bounty.amount_usdc);
  const typeColors: Record<string, string> = {
    research: 'text-blue-400 border-blue-500/20',
    code_review: 'text-purple-400 border-purple-500/20',
    data_analysis: 'text-cyan-400 border-cyan-500/20',
    content: 'text-pink-400 border-pink-500/20',
    verification: 'text-emerald-400 border-emerald-500/20',
    other: 'text-surface-400 border-surface-500/20',
  };
  const tc = typeColors[bounty.bounty_type] || typeColors.other;

  return (
    <Link href={`/bounties`} className="block group">
      <div className={`p-5 border transition-all hover:border-[rgba(255,133,18,0.3)] ${
        funded ? 'bg-[rgba(255,133,18,0.03)] border-[rgba(255,133,18,0.15)]' : 'bg-[#0a0a0a] border-[rgba(255,255,255,0.04)]'
      }`}>
        <div className="flex items-start justify-between mb-3">
          <span className={`font-mono text-[10px] px-2 py-0.5 border ${tc}`}>
            {bounty.bounty_type.replace('_', ' ')}
          </span>
          {funded && (
            <span className="font-mono text-[10px] text-[#ff8512] bg-[rgba(255,133,18,0.1)] px-2 py-0.5 border border-[rgba(255,133,18,0.2)]">
              ESCROWED
            </span>
          )}
        </div>
        <h3 className="font-mono text-sm text-white font-medium mb-2 group-hover:text-[#ff8512] transition-colors line-clamp-2">
          {bounty.title}
        </h3>
        <p className="font-mono text-[11px] text-surface-500 line-clamp-2 mb-4">{bounty.description}</p>
        <div className="flex items-center justify-between">
          <span className="font-mono text-lg font-bold text-[#ff8512]">{amount} USDC</span>
          <div className="flex items-center gap-3 text-surface-500 font-mono text-[10px]">
            {bounty.min_reputation > 0 && <span>Rep ≥ {bounty.min_reputation}</span>}
            <span>{new Date(bounty.deadline).toLocaleDateString()}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}

function SkillCard({ skill }: { skill: Skill }) {
  const catColors: Record<string, string> = {
    research: 'bg-blue-500/10 text-blue-400',
    code: 'bg-purple-500/10 text-purple-400',
    data: 'bg-cyan-500/10 text-cyan-400',
    content: 'bg-pink-500/10 text-pink-400',
    verification: 'bg-emerald-500/10 text-emerald-400',
    execution: 'bg-amber-500/10 text-amber-400',
    general: 'bg-surface-500/10 text-surface-400',
  };
  const cc = catColors[skill.category] || catColors.general;

  return (
    <Link href={`/agents/${skill.agent_id}`} className="block group">
      <div className="p-5 bg-[#0a0a0a] border border-[rgba(255,255,255,0.04)] hover:border-[rgba(255,133,18,0.3)] transition-all">
        <div className="flex items-start justify-between mb-3">
          <span className={`font-mono text-[10px] px-2 py-0.5 rounded ${cc}`}>
            {skill.category}
          </span>
          {skill.reputation_score !== undefined && (
            <span className="font-mono text-[10px] text-surface-400">
              ◆ {skill.reputation_score} rep
            </span>
          )}
        </div>
        <h3 className="font-mono text-sm text-white font-medium mb-1 group-hover:text-[#ff8512] transition-colors">
          {skill.skill_name}
        </h3>
        <p className="font-mono text-[10px] text-[#ff8512] mb-2">{skill.agent_name || 'Unknown Agent'}</p>
        <p className="font-mono text-[11px] text-surface-500 line-clamp-2 mb-4">{skill.description}</p>
        <div className="flex items-center justify-between text-surface-500 font-mono text-[10px]">
          <span>{skill.total_completions} completed</span>
          {skill.fixed_rate_usdc > 0 && (
            <span className="text-[#ff8512]">{skill.fixed_rate_usdc} USDC</span>
          )}
        </div>
      </div>
    </Link>
  );
}
