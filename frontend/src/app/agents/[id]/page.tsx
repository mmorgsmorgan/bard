'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useAccount } from 'wagmi';
import {
  fetchAgentById, fetchContributionsByAgent, endorseContribution,
  fetchAgentsByOwner, agentVerifyContribution, fetchVerificationStats,
  type Agent, type Contribution, type ReputationData, type VerificationStats,
} from '@/lib/store';
import { TierBadge } from '@/components/TierBadge';

const CONTRIBUTION_TYPES: Record<string, { label: string; color: string }> = {
  research: { label: 'Research', color: 'text-purple-400 border-purple-500/20' },
  code_review: { label: 'Code Review', color: 'text-cyan-400 border-cyan-500/20' },
  data_analysis: { label: 'Data Analysis', color: 'text-blue-400 border-blue-500/20' },
  content: { label: 'Content', color: 'text-green-400 border-green-500/20' },
  verification: { label: 'Verification', color: 'text-yellow-400 border-yellow-500/20' },
  other: { label: 'Other', color: 'text-surface-400 border-surface-500/20' },
};

const AGENT_TYPES: Record<string, { label: string; icon: string }> = {
  general: { label: 'General', icon: '◆' },
  research: { label: 'Research', icon: '◈' },
  code: { label: 'Code', icon: '⟐' },
  data: { label: 'Data', icon: '⬡' },
  content: { label: 'Content', icon: '◎' },
};

const AVAIL_COLORS: Record<string, string> = {
  available: 'bg-emerald-400',
  busy: 'bg-yellow-400',
  offline: 'bg-surface-500',
  dormant: 'bg-red-400',
};

export default function AgentDetailPage() {
  const params = useParams();
  const agentId = params.id as string;
  const { address, isConnected } = useAccount();

  const [agent, setAgent] = useState<Agent | null>(null);
  const [reputation, setReputation] = useState<ReputationData | null>(null);
  const [contributions, setContributions] = useState<Contribution[]>([]);
  const [loading, setLoading] = useState(true);
  const [endorsing, setEndorsing] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [agentVerifying, setAgentVerifying] = useState<string | null>(null);
  const [skills, setSkills] = useState<any[]>([]);
  const [workHistory, setWorkHistory] = useState<any[]>([]);
  const [workStats, setWorkStats] = useState<any>(null);
  const [verifStats, setVerifStats] = useState<VerificationStats | null>(null);
  const [myAgents, setMyAgents] = useState<Agent[]>([]);

  useEffect(() => {
    if (!agentId) return;
    setLoading(true);
    const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    (async () => {
      const [{ agent: a, reputation: r }, contribs, vStats] = await Promise.all([
        fetchAgentById(agentId),
        fetchContributionsByAgent(agentId),
        fetchVerificationStats(agentId),
      ]);
      setAgent(a);
      setReputation(r);
      setContributions(contribs);
      setVerifStats(vStats);

      if (address) {
        const owned = await fetchAgentsByOwner(address);
        setMyAgents(owned);
      }

      try {
        const [skillsRes, historyRes] = await Promise.all([
          fetch(`${API}/api/agents/${agentId}/skills`).then(r => r.json()),
          fetch(`${API}/api/agents/${agentId}/work-history`).then(r => r.json()),
        ]);
        setSkills(skillsRes.skills || []);
        setWorkHistory(historyRes.workHistory || []);
        setWorkStats(historyRes.stats || null);
      } catch {}
      setLoading(false);
    })();
  }, [agentId, address]);

  async function handleEndorse(contributionId: string) {
    if (!address) return;
    setEndorsing(contributionId);
    const result = await endorseContribution(contributionId, {
      endorserWallet: address,
      endorserType: 'human',
      comment: 'Endorsed via BARD UI',
    });
    if (result.success) {
      setContributions((prev) =>
        prev.map((c) =>
          c.id === contributionId
            ? { ...c, endorsementCount: result.endorsementCount, status: result.endorsementCount >= 3 ? 'verified' : c.status }
            : c
        )
      );
      setReputation(result.reputation);
    }
    setEndorsing(null);
  }

  async function handleVerify(contributionId: string) {
    if (!address) return;
    setVerifying(contributionId);
    try {
      const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
      const res = await fetch(`${API}/api/contributions/${contributionId}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: address }),
      });
      const data = await res.json();
      if (res.ok) {
        setContributions((prev) =>
          prev.map((c) =>
            c.id === contributionId
              ? { ...c, status: data.status === 'verified' ? 'verified' as const : c.status, endorsementCount: c.endorsementCount + 1 }
              : c
          )
        );
        if (data.reputation) setReputation(data.reputation);
      }
    } catch (e) {
      console.error('Verify error:', e);
    }
    setVerifying(null);
  }

  const verifierAgent = myAgents.find(a => a.reputationScore >= 30);

  async function handleAgentVerify(contributionId: string, result: 'approved' | 'rejected') {
    if (!verifierAgent || verifierAgent.id === agentId) return;
    setAgentVerifying(contributionId);
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
        setContributions(prev => prev.map(c =>
          c.id === contributionId ? {
            ...c,
            approvals: res.approvals,
            rejections: res.rejections,
            status: res.autoAction === 'verified' ? 'verified' : res.autoAction === 'rejected' ? 'rejected' : c.status,
          } : c
        ));
      }
    } catch (e) {
      console.error('Agent verify error:', e);
    }
    setAgentVerifying(null);
  }

  const getReputationColor = (score: number) => {
    if (score >= 50) return 'text-emerald-400';
    if (score >= 20) return 'text-[#ff8512]';
    if (score > 0) return 'text-yellow-500';
    return 'text-surface-500';
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-24 text-center">
        <div className="font-mono text-surface-500 animate-pulse-subtle text-sm">Loading agent...</div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-24 text-center">
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-16">
          <div className="font-mono text-surface-500 text-sm mb-4">Agent not found</div>
          <Link href="/leaderboard" className="btn-primary text-xs">Back to Leaderboard</Link>
        </div>
      </div>
    );
  }

  const isOwner = address?.toLowerCase() === agent.ownerWallet.toLowerCase();
  const hasOwner = !!agent.ownerWallet && agent.ownerWallet !== '0x0';
  const typeInfo = AGENT_TYPES[agent.agentType] || AGENT_TYPES.general;
  const verifiedContributions = contributions.filter(c => c.status === 'verified');
  const canAgentVerify = !!verifierAgent && verifierAgent.id !== agentId;

  return (
    <div className="max-w-5xl mx-auto px-6 py-16">
      {/* Breadcrumb */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Link href="/leaderboard" className="font-mono text-[10px] text-surface-500 hover:text-[#ff8512] transition-colors">← Leaderboard</Link>
          <span className="text-surface-600">/</span>
          <span className="font-mono text-[10px] text-surface-400">{agent.agentName}</span>
        </div>
        <Link href={`/agents/${agentId}/analytics`} className="font-mono text-[10px] text-[#ff8512] hover:text-white border border-[rgba(255,133,18,0.3)] px-3 py-1.5 transition-colors hover:border-[rgba(255,133,18,0.6)]">
          Analytics →
        </Link>
      </div>

      {/* Agent Identity Card */}
      <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-6 mb-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-5">
            <div className="w-16 h-16 bg-[#141414] border-2 border-[rgba(255,133,18,0.3)] flex items-center justify-center text-3xl text-[#ff8512]">
              {typeInfo.icon}
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white">{agent.agentName}</h1>
              <div className="flex flex-wrap items-center gap-3 mt-1.5">
                <span className="font-mono text-[10px] text-surface-400 px-2 py-0.5 border border-[rgba(255,255,255,0.08)]">
                  {typeInfo.icon} {typeInfo.label}
                </span>
                <span className={`font-mono text-[10px] ${agent.status === 'active' ? 'text-emerald-400' : 'text-red-400'}`}>
                  ● {agent.status}
                </span>
                {agent.availability && (
                  <span className="font-mono text-[10px] text-surface-400 flex items-center gap-1">
                    <span className={`w-1.5 h-1.5 rounded-full ${AVAIL_COLORS[agent.availability] || 'bg-surface-500'}`} />
                    {agent.availability}
                  </span>
                )}
                <span className="font-mono text-[10px] text-surface-600">{agent.id}</span>
              </div>
              {/* Specializations */}
              {agent.specializations?.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {agent.specializations.map((s: string) => (
                    <span key={s} className="px-1.5 py-0.5 border border-purple-500/20 font-mono text-[9px] text-purple-300 bg-purple-500/5">
                      {s.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className={`font-mono text-4xl font-bold ${getReputationColor(agent.reputationScore)}`}>{agent.reputationScore}</div>
            <div className="flex items-center justify-end gap-2 mt-1">
              <TierBadge score={agent.reputationScore} size="sm" />
              <span className="font-mono text-[10px] text-surface-500 tracking-wider uppercase">Reputation</span>
            </div>
          </div>
        </div>
        {agent.description && (
          <div className="mt-4 font-mono text-sm text-surface-400 border-t border-[rgba(255,255,255,0.04)] pt-4">
            {agent.description}
          </div>
        )}
      </div>

      {/* Owner Link Status */}
      <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-4 mb-4">
        <div className="font-mono text-[10px] text-surface-500 tracking-wider uppercase mb-3">Owner Connection</div>
        {hasOwner ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 bg-emerald-500 animate-pulse-subtle" />
              <span className="font-mono text-xs text-emerald-400">Verified Owner</span>
              <span className="font-mono text-[10px] text-surface-500">
                {agent.ownerWallet.slice(0, 8)}...{agent.ownerWallet.slice(-4)}
              </span>
              {isOwner && <span className="font-mono text-[9px] px-1.5 py-0.5 bg-[rgba(255,133,18,0.1)] text-[#ff8512] border border-[rgba(255,133,18,0.2)]">YOU</span>}
            </div>
            <span className="font-mono text-[9px] text-surface-600">
              Connected via verification code
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 bg-surface-600" />
            <span className="font-mono text-xs text-surface-500">Independent — No human owner linked</span>
          </div>
        )}
      </div>

      {/* Turnkey Wallet */}
      {(agent as any).turnkeyAddress && (
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-4 mb-4">
          <div className="font-mono text-[10px] text-surface-500 tracking-wider uppercase mb-2">Turnkey Wallet</div>
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 bg-cyan-500" />
            <span className="font-mono text-xs text-cyan-400">Provisioned</span>
            <span className="font-mono text-[10px] text-surface-400 break-all">{(agent as any).turnkeyAddress}</span>
          </div>
        </div>
      )}

      {/* ERC-8004 Identity */}
      {(agent as any).erc8004TxHash && (
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-4 mb-4">
          <div className="font-mono text-[10px] text-surface-500 tracking-wider uppercase mb-2">ERC-8004 Identity</div>
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 bg-emerald-500" />
            <span className="font-mono text-xs text-emerald-400">Minted</span>
            <span className="font-mono text-[10px] text-surface-400 break-all">{(agent as any).erc8004TxHash}</span>
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-px mb-4">
        {[
          { label: 'Contributions', value: reputation?.totalContributions || 0 },
          { label: 'Verified', value: reputation?.verified || 0, color: 'text-emerald-400' },
          { label: 'Pending', value: reputation?.pending || 0, color: 'text-yellow-500' },
          { label: 'Endorsements', value: reputation?.totalEndorsements || 0 },
          { label: 'Score', value: reputation?.score || 0, color: getReputationColor(reputation?.score || 0) },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-[#0c0c0c] border border-[rgba(255,255,255,0.04)] p-4 text-center">
            <div className={`font-mono text-xl font-bold ${color || 'text-white'}`}>{value}</div>
            <div className="font-mono text-[9px] text-surface-500 tracking-wider uppercase mt-1">{label}</div>
          </div>
        ))}
      </div>

      {/* Verification Stats (Phase 2) */}
      {verifStats && verifStats.total > 0 && (
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-5 mb-4">
          <div className="font-mono text-xs text-surface-500 tracking-wider uppercase mb-4">Verification Activity</div>
          <div className="grid grid-cols-4 gap-px">
            <div className="bg-[#080808] px-3 py-2 text-center">
              <div className="font-mono text-lg text-white font-bold">{verifStats.total}</div>
              <div className="font-mono text-[9px] text-surface-500">Total Reviews</div>
            </div>
            <div className="bg-[#080808] px-3 py-2 text-center">
              <div className="font-mono text-lg text-emerald-400 font-bold">{verifStats.approved}</div>
              <div className="font-mono text-[9px] text-surface-500">Approved</div>
            </div>
            <div className="bg-[#080808] px-3 py-2 text-center">
              <div className="font-mono text-lg text-red-400 font-bold">{verifStats.rejected}</div>
              <div className="font-mono text-[9px] text-surface-500">Rejected</div>
            </div>
            <div className="bg-[#080808] px-3 py-2 text-center">
              <div className="font-mono text-lg text-[#ff8512] font-bold">{verifStats.accuracy}%</div>
              <div className="font-mono text-[9px] text-surface-500">Accuracy</div>
            </div>
          </div>
        </div>
      )}

      {/* Marketplace Skills */}
      {skills.length > 0 && (
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-5 mb-4">
          <div className="font-mono text-xs text-surface-500 tracking-wider uppercase mb-4">Marketplace Skills</div>
          <div className="grid gap-3 md:grid-cols-2">
            {skills.map((s: any) => {
              const catColors: Record<string, string> = {
                research: 'text-blue-400 border-blue-500/20', code: 'text-purple-400 border-purple-500/20',
                data: 'text-cyan-400 border-cyan-500/20', content: 'text-pink-400 border-pink-500/20',
                verification: 'text-emerald-400 border-emerald-500/20', execution: 'text-amber-400 border-amber-500/20',
                general: 'text-surface-400 border-surface-500/20',
              };
              return (
                <div key={s.id} className="p-3 border border-[rgba(255,255,255,0.04)] bg-[#0a0a0a]">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-mono text-sm text-white font-medium">{s.skill_name}</span>
                    <span className={`font-mono text-[9px] px-1.5 py-0.5 border ${catColors[s.category] || catColors.general}`}>{s.category}</span>
                  </div>
                  <p className="font-mono text-[10px] text-surface-400 mb-2">{s.description}</p>
                  <div className="flex items-center gap-3 font-mono text-[9px] text-surface-500">
                    <span>{s.total_completions} done</span>
                    {s.fixed_rate_usdc > 0 && <span className="text-[#ff8512]">{s.fixed_rate_usdc} USDC</span>}
                    {s.total_earned_usdc > 0 && <span>{s.total_earned_usdc} earned</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Escrow Work History */}
      {(workHistory.length > 0 || (workStats && workStats.total > 0)) && (
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-5 mb-4">
          <div className="font-mono text-xs text-surface-500 tracking-wider uppercase mb-4">Escrow Work History</div>
          {workStats && (
            <div className="grid grid-cols-3 gap-px mb-4">
              <div className="bg-[#0a0a0a] border border-[rgba(255,255,255,0.04)] p-3 text-center">
                <div className="font-mono text-lg font-bold text-white">{workStats.total || 0}</div>
                <div className="font-mono text-[9px] text-surface-500 uppercase">Total Jobs</div>
              </div>
              <div className="bg-[#0a0a0a] border border-[rgba(255,255,255,0.04)] p-3 text-center">
                <div className="font-mono text-lg font-bold text-emerald-400">{workStats.completed || 0}</div>
                <div className="font-mono text-[9px] text-surface-500 uppercase">Completed</div>
              </div>
              <div className="bg-[#0a0a0a] border border-[rgba(255,255,255,0.04)] p-3 text-center">
                <div className="font-mono text-lg font-bold text-[#ff8512]">{(workStats.total_earned || 0).toFixed(2)}</div>
                <div className="font-mono text-[9px] text-surface-500 uppercase">USDC Earned</div>
              </div>
            </div>
          )}
          {workHistory.map((w: any) => (
            <div key={w.id} className="flex items-center justify-between py-2 border-b border-[rgba(255,255,255,0.03)] last:border-0">
              <div>
                <span className="font-mono text-xs text-white">{w.title}</span>
                <span className={`ml-2 font-mono text-[9px] px-1.5 py-0.5 ${w.escrow_status === 'released' ? 'text-emerald-400 bg-emerald-500/10' : 'text-red-400 bg-red-500/10'}`}>
                  {w.escrow_status}
                </span>
              </div>
              <div className="flex items-center gap-3 font-mono text-[10px] text-surface-500">
                {w.escrow_budget_usdc > 0 && <span className="text-[#ff8512]">{w.escrow_budget_usdc} USDC</span>}
                {w.released_at && <span>{new Date(w.released_at).toLocaleDateString()}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Verified Portfolio */}
      {verifiedContributions.length > 0 && (
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-5 mb-4">
          <div className="font-mono text-xs text-surface-500 tracking-wider uppercase mb-4">
            Verified Portfolio ({verifiedContributions.length})
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {verifiedContributions.map(c => {
              const typeInfo = CONTRIBUTION_TYPES[c.type] || CONTRIBUTION_TYPES.other;
              return (
                <div key={c.id} className="p-3 border border-emerald-500/10 bg-[#0a0a0a]">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`font-mono text-[10px] px-1.5 py-0.5 border ${typeInfo.color}`}>{typeInfo.label}</span>
                    <span className="font-mono text-[9px] text-emerald-400">✓ VERIFIED</span>
                    {(c.approvals || 0) >= 2 && (
                      <span className="font-mono text-[9px] px-1.5 py-0.5 bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">AUTO</span>
                    )}
                  </div>
                  <div className="font-mono text-sm text-surface-300 mb-1.5 line-clamp-2">{c.description || 'No description'}</div>
                  <div className="flex items-center gap-3 font-mono text-[9px] text-surface-500">
                    <span>{new Date(c.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                    <span>proof: {c.proofHash.slice(0, 10)}...</span>
                    <span>{c.endorsementCount} endorsement{c.endorsementCount !== 1 ? 's' : ''}</span>
                    {(c.approvals || 0) > 0 && <span className="text-emerald-400">{c.approvals} approvals</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Contribution Timeline */}
      <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-5">
        <div className="font-mono text-xs text-surface-500 tracking-wider uppercase mb-4">
          Contribution Timeline ({contributions.length})
        </div>
        {contributions.length === 0 ? (
          <div className="font-mono text-xs text-surface-500 text-center py-8">No contributions yet</div>
        ) : (
          <div className="space-y-2">
            {contributions.map((c) => {
              const typeInfo = CONTRIBUTION_TYPES[c.type] || CONTRIBUTION_TYPES.other;
              return (
                <div key={c.id} className="flex items-start gap-4 py-3 border-b border-[rgba(255,255,255,0.03)] last:border-0">
                  {/* Timeline dot */}
                  <div className="flex flex-col items-center shrink-0 pt-1">
                    <div className={`w-2 h-2 ${c.status === 'verified' ? 'bg-emerald-500' : c.status === 'rejected' ? 'bg-red-500' : 'bg-yellow-500'}`} />
                  </div>
                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className={`font-mono text-[10px] px-1.5 py-0.5 border ${typeInfo.color}`}>
                        {typeInfo.label}
                      </span>
                      {c.status === 'verified' && <span className="font-mono text-[9px] text-emerald-400">✓ VERIFIED</span>}
                      {c.status === 'pending' && <span className="font-mono text-[9px] text-yellow-500">⧖ PENDING</span>}
                      {c.status === 'rejected' && <span className="font-mono text-[9px] text-red-400">✕ REJECTED</span>}
                      {c.status === 'verified' && (c.approvals || 0) >= 2 && (
                        <span className="font-mono text-[9px] px-1.5 py-0.5 bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">AUTO-VERIFIED</span>
                      )}
                    </div>
                    <div className="font-mono text-sm text-surface-300 mb-1">{c.description || 'No description'}</div>
                    <div className="flex items-center gap-3 text-[10px] text-surface-500 font-mono flex-wrap">
                      <span>{new Date(c.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                      <span>proof: {c.proofHash.slice(0, 12)}...</span>
                      <span>{c.endorsementCount} endorsement{c.endorsementCount !== 1 ? 's' : ''}</span>
                      {((c.approvals || 0) > 0 || (c.rejections || 0) > 0) && (
                        <>
                          <span className="text-emerald-400">{c.approvals} approved</span>
                          {(c.rejections || 0) > 0 && <span className="text-red-400">{c.rejections} rejected</span>}
                        </>
                      )}
                    </div>
                  </div>
                  {/* Action buttons */}
                  <div className="flex gap-1.5 shrink-0">
                    {isConnected && c.status === 'pending' && isOwner && (
                      <button onClick={() => handleVerify(c.id)} disabled={verifying === c.id}
                        className="font-mono text-[10px] px-3 py-1.5 border border-[rgba(255,133,18,0.3)] text-[#ff8512] hover:bg-[rgba(255,133,18,0.1)] transition-colors disabled:opacity-40">
                        {verifying === c.id ? '...' : '✓ Endorse'}
                      </button>
                    )}
                    {isConnected && c.status === 'pending' && !isOwner && (
                      <button onClick={() => handleEndorse(c.id)} disabled={endorsing === c.id}
                        className="font-mono text-[10px] px-2 py-1 border border-[rgba(255,133,18,0.3)] text-[#ff8512] hover:bg-[rgba(255,133,18,0.1)] transition-colors disabled:opacity-40">
                        {endorsing === c.id ? '...' : '✓ Endorse'}
                      </button>
                    )}
                    {isConnected && c.status === 'pending' && canAgentVerify && (
                      <>
                        <button onClick={() => handleAgentVerify(c.id, 'approved')} disabled={agentVerifying === c.id}
                          className="font-mono text-[10px] px-2 py-1 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-40">
                          {agentVerifying === c.id ? '...' : '⬡ Approve'}
                        </button>
                        <button onClick={() => handleAgentVerify(c.id, 'rejected')} disabled={agentVerifying === c.id}
                          className="font-mono text-[10px] px-2 py-1 border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40">
                          ✕
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Agent Public Key */}
      <div className="mt-4 border border-[rgba(255,255,255,0.04)] bg-[#080808] p-4">
        <div className="font-mono text-[10px] text-surface-500 tracking-wider uppercase mb-2">Agent Public Key</div>
        <div className="font-mono text-xs text-surface-400 break-all">{agent.agentPublicKey}</div>
      </div>
    </div>
  );
}
