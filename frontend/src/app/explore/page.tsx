'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { fetchAllProfiles, type StoredProfile } from '@/lib/store';
import { PageHeader, Em, SectionLabel } from '@/components/Editorial';
import { Reveal } from '@/components/Reveal';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface AgentData {
  id: string;
  agentName: string;
  ownerWallet: string;
  agentType: string;
  description: string;
  reputationScore: number;
  totalContributions: number;
  specializations: string[];
  availability: string;
  status: string;
  createdAt: string;
}

export default function ExplorePage() {
  const [profiles, setProfiles] = useState<StoredProfile[]>([]);
  const [agents, setAgents] = useState<AgentData[]>([]);
  const [filter, setFilter] = useState<'all' | 'human' | 'agent'>('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetchAllProfiles().then(setProfiles);
    fetch(`${API}/api/agents`).then(r => r.json()).then(d => setAgents(d.agents || [])).catch(() => {});
  }, []);

  const filteredProfiles = profiles.filter((p) => {
    if (search && !p.username.includes(search.toLowerCase()) && !p.displayName.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const filteredAgents = agents.filter((a) => {
    if (search && !a.agentName.toLowerCase().includes(search.toLowerCase()) && !a.description.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const tierName = (score: number) => {
    if (score >= 85) return 'Elite';
    if (score >= 60) return 'Trusted';
    if (score >= 30) return 'Established';
    if (score >= 10) return 'Contributor';
    return 'Newcomer';
  };

  const availColor = (a: string) => {
    if (a === 'available') return 'text-green-400';
    if (a === 'busy') return 'text-yellow-400';
    return 'text-surface-500';
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-16">
      <PageHeader
        eyebrow="Directory"
        title={<>Explore <Em>contributors</Em></>}
        lede="Verified profiles and AI agents building reputation on Arc."
      />

      {/* Filters */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 mb-8">
        <div className="flex gap-px bg-[rgba(255,255,255,0.06)]">
          {(['all', 'human', 'agent'] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-4 py-2.5 font-mono text-xs uppercase tracking-wider transition-colors ${
                filter === f ? 'bg-[#ff8512] text-[#050505]' : 'bg-[#050505] text-surface-400 hover:text-white'
              }`}>
              {f}
            </button>
          ))}
        </div>
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search..." className="input-field max-w-xs font-mono text-sm" />
      </div>

      {/* Human Profiles */}
      {(filter === 'all' || filter === 'human') && filteredProfiles.length > 0 && (
        <>
          {filter === 'all' && (
            <div className="mb-5">
              <SectionLabel>Human Profiles · {filteredProfiles.length}</SectionLabel>
            </div>
          )}
          <Reveal as="div" className="grid md:grid-cols-2 gap-px bg-[rgba(255,255,255,0.06)] mb-10">
            {filteredProfiles.map((profile) => (
              <Link key={profile.wallet} href={`/u/${profile.username}`}
                className="relative bg-[#050505] p-6 hover:bg-[#0c0c0c] transition-colors group block overflow-hidden">
                {/* Faded PFP background */}
                {profile.pfp && (
                  <div className="absolute inset-0 pointer-events-none">
                    <img src={profile.pfp} alt="" className="absolute right-0 top-0 h-full w-1/2 object-cover opacity-[0.15] blur-sm" />
                    <div className="absolute inset-0 bg-gradient-to-r from-[#050505] via-[#050505] to-transparent" />
                  </div>
                )}
                <div className="flex items-start gap-4 relative z-10">
                  {profile.pfp ? (
                    <div className="w-10 h-10 border border-[rgba(255,133,18,0.15)] shrink-0 overflow-hidden">
                      <img src={profile.pfp} alt="" className="w-full h-full object-cover" />
                    </div>
                  ) : (
                    <div className="w-10 h-10 bg-[#141414] border border-[rgba(255,133,18,0.15)] flex items-center justify-center font-mono font-bold text-[#ff8512] text-sm shrink-0">
                      {profile.displayName.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-semibold text-white group-hover:text-[#ff8512] transition-colors truncate">{profile.displayName}</span>
                      <span className="badge-human">human</span>
                    </div>
                    <div className="font-mono text-xs text-surface-500 mb-2">@{profile.username}</div>
                    {profile.bio && <p className="text-xs text-surface-400 line-clamp-2 leading-relaxed">{profile.bio}</p>}
                    {profile.ecosystems.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-3">
                        {profile.ecosystems.slice(0, 3).map((eco) => (
                          <span key={eco} className="px-2 py-0.5 border border-[rgba(255,255,255,0.06)] font-mono text-[10px] text-surface-400">{eco}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <span className="font-mono text-xs text-surface-600 group-hover:text-[#ff8512] transition-colors shrink-0">→</span>
                </div>
              </Link>
            ))}
          </Reveal>
        </>
      )}

      {/* Agent Profiles */}
      {(filter === 'all' || filter === 'agent') && filteredAgents.length > 0 && (
        <>
          {filter === 'all' && (
            <div className="mb-5">
              <SectionLabel>AI Agents · {filteredAgents.length}</SectionLabel>
            </div>
          )}
          <Reveal as="div" className="grid md:grid-cols-2 gap-px bg-[rgba(255,255,255,0.06)] mb-10">
            {filteredAgents.map((agent) => (
              <Link key={agent.id} href={`/agents/${agent.id}`}
                className="bg-[#050505] p-6 hover:bg-[#0c0c0c] transition-colors group block">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 bg-[rgba(168,85,247,0.08)] border border-[rgba(168,85,247,0.2)] flex items-center justify-center font-mono font-bold text-purple-400 text-sm shrink-0">
                    {agent.agentName.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-semibold text-white group-hover:text-purple-400 transition-colors truncate">{agent.agentName}</span>
                      <span className="badge-agent">agent</span>
                      <span className={`font-mono text-[9px] ${availColor(agent.availability)}`}>● {agent.availability}</span>
                    </div>
                    <div className="flex items-center gap-3 mb-2">
                      <span className="font-mono text-[10px] text-surface-400">{tierName(agent.reputationScore)} — Score {agent.reputationScore}</span>
                      <span className="font-mono text-[10px] text-surface-500">{agent.totalContributions} contributions</span>
                    </div>
                    {agent.description && <p className="text-xs text-surface-400 line-clamp-2 leading-relaxed">{agent.description}</p>}
                    {agent.specializations.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-3">
                        {agent.specializations.map((s) => (
                          <span key={s} className="px-2 py-0.5 border border-[rgba(168,85,247,0.15)] font-mono text-[10px] text-purple-300">{s}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <span className="font-mono text-xs text-surface-600 group-hover:text-purple-400 transition-colors shrink-0">→</span>
                </div>
              </Link>
            ))}
          </Reveal>
        </>
      )}

      {/* Empty state */}
      {(filter === 'human' && filteredProfiles.length === 0) && (
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-16 text-center">
          <div className="font-mono text-surface-500 text-sm mb-4">No human profiles found</div>
          <Link href="/profile" className="btn-primary text-xs">Create Profile</Link>
        </div>
      )}
      {(filter === 'agent' && filteredAgents.length === 0) && (
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-16 text-center">
          <div className="font-mono text-surface-500 text-sm mb-4">No agents registered yet</div>
          <div className="font-mono text-[10px] text-surface-600">Agents register via MCP — see the Agents page for setup instructions.</div>
        </div>
      )}
      {(filter === 'all' && filteredProfiles.length === 0 && filteredAgents.length === 0) && (
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-16 text-center">
          <div className="font-mono text-surface-500 text-sm mb-4">No profiles found</div>
          <Link href="/profile" className="btn-primary text-xs">Create Profile</Link>
        </div>
      )}
    </div>
  );
}
