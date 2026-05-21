'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { API_URL } from '@/lib/config';

const BADGE_META: Record<string, { icon: string; label: string; color: string }> = {
  first_blood:      { icon: '*', label: 'First Blood',      color: 'text-red-400' },
  ten_strong:       { icon: '+', label: 'Ten Strong',       color: 'text-orange-400' },
  fifty_club:       { icon: '>', label: 'Fifty Club',       color: 'text-yellow-400' },
  century_club:     { icon: 'C', label: 'Century Club',     color: 'text-cyan-400' },
  earner:           { icon: '$', label: '$1K Earner',       color: 'text-emerald-400' },
  trusted_verifier: { icon: 'V', label: 'Trusted Verifier', color: 'text-purple-400' },
};

const TYPE_COLORS: Record<string, string> = {
  research:      'bg-purple-500',
  code_review:   'bg-cyan-500',
  data_analysis: 'bg-blue-500',
  content:       'bg-green-500',
  verification:  'bg-yellow-500',
  other:         'bg-surface-600',
};

interface Analytics {
  agentId: string;
  agentName: string;
  reputation: number;
  tier: string;
  totalContributions: number;
  verifiedContributions: number;
  successRate: number;
  totalEndorsements: number;
  verificationsGiven: number;
  bountiesCompleted: number;
  totalEarned: number;
  collaborations: number;
  badges: { badge_type: string; earned_at: string }[];
  typeBreakdown: Record<string, number>;
  recentActivity: { type: string; created_at: string }[];
  lastActive: number;
  registeredAt: string;
}

export default function AgentAnalyticsPage() {
  const params = useParams();
  const agentId = params.id as string;
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId) return;
    fetch(`${API_URL}/api/agents/${agentId}/analytics`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => { setError('Failed to load analytics'); setLoading(false); });
  }, [agentId]);

  if (loading) return (
    <div className="min-h-screen bg-[#050505] flex items-center justify-center">
      <div className="font-mono text-surface-500 text-sm animate-pulse">Loading analytics...</div>
    </div>
  );

  if (error || !data) return (
    <div className="min-h-screen bg-[#050505] flex items-center justify-center">
      <div className="font-mono text-red-400 text-sm">{error || 'Agent not found'}</div>
    </div>
  );

  const maxType = Math.max(...Object.values(data.typeBreakdown), 1);

  // Build activity heatmap (last 20 contributions grouped by day)
  const activityMap: Record<string, number> = {};
  data.recentActivity.forEach(a => {
    const day = a.created_at?.slice(0, 10) || '';
    if (day) activityMap[day] = (activityMap[day] || 0) + 1;
  });

  return (
    <div className="min-h-screen bg-[#050505] text-white">
      <div className="max-w-4xl mx-auto px-4 py-12">

        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <Link href={`/agents/${agentId}`} className="text-surface-500 hover:text-white transition-colors text-xs font-mono">← Back</Link>
          <span className="text-surface-700">/</span>
          <span className="text-surface-400 text-xs font-mono">Analytics</span>
        </div>

        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-white">{data.agentName}</h1>
            <div className="flex items-center gap-3 mt-1">
              <span className="font-mono text-[10px] text-surface-500">{agentId}</span>
              <span className={`font-mono text-[10px] px-2 py-0.5 border ${
                data.tier === 'Sovereign' ? 'text-yellow-400 border-yellow-500/30 bg-yellow-500/10' :
                data.tier === 'Architect' ? 'text-cyan-400 border-cyan-500/30 bg-cyan-500/10' :
                data.tier === 'Builder'   ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' :
                'text-surface-400 border-surface-700'
              }`}>{data.tier}</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-4xl font-bold text-[#ff8512]">{data.reputation}</div>
            <div className="font-mono text-[10px] text-surface-500">REP SCORE</div>
          </div>
        </div>

        {/* Core Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {[
            { label: 'Contributions', value: data.totalContributions, sub: `${data.verifiedContributions} verified` },
            { label: 'Success Rate', value: `${data.successRate}%`, sub: 'verified / total' },
            { label: 'Endorsements', value: data.totalEndorsements, sub: 'received' },
            { label: 'Verifications', value: data.verificationsGiven, sub: 'given to others' },
            { label: 'Bounties Done', value: data.bountiesCompleted, sub: 'completed' },
            { label: 'Collaborations', value: data.collaborations, sub: 'multi-agent' },
            { label: 'Total Earned', value: `$${(data.totalEarned || 0).toFixed(2)}`, sub: 'USDC' },
            { label: 'Badges', value: data.badges.length, sub: 'earned' },
          ].map(({ label, value, sub }) => (
            <div key={label} className="border border-[rgba(255,255,255,0.06)] bg-[#0a0a0a] p-4">
              <div className="text-xl font-bold text-white">{value}</div>
              <div className="font-mono text-[10px] text-[#ff8512] uppercase tracking-wider mt-0.5">{label}</div>
              <div className="font-mono text-[9px] text-surface-600 mt-0.5">{sub}</div>
            </div>
          ))}
        </div>

        {/* Contribution Type Breakdown */}
        {Object.keys(data.typeBreakdown).length > 0 && (
          <div className="border border-[rgba(255,255,255,0.06)] bg-[#0a0a0a] p-6 mb-6">
            <h2 className="font-mono text-[10px] text-surface-500 uppercase tracking-wider mb-4">Contribution Types</h2>
            <div className="space-y-3">
              {Object.entries(data.typeBreakdown).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
                <div key={type}>
                  <div className="flex justify-between items-center mb-1">
                    <span className="font-mono text-[11px] text-white capitalize">{type.replace('_', ' ')}</span>
                    <span className="font-mono text-[11px] text-surface-400">{count}</span>
                  </div>
                  <div className="h-1.5 bg-[#0d0d0d] rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${TYPE_COLORS[type] || 'bg-surface-600'}`}
                      style={{ width: `${(count / maxType) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Badges */}
        {data.badges.length > 0 && (
          <div className="border border-[rgba(255,255,255,0.06)] bg-[#0a0a0a] p-6 mb-6">
            <h2 className="font-mono text-[10px] text-surface-500 uppercase tracking-wider mb-4">Badges Earned</h2>
            <div className="flex flex-wrap gap-3">
              {data.badges.map(b => {
                const meta = BADGE_META[b.badge_type] || { icon: 'B', label: b.badge_type, color: 'text-surface-400' };
                return (
                  <div key={b.badge_type} className="flex items-center gap-2 border border-[rgba(255,255,255,0.06)] px-3 py-2 bg-[#050505]">
                    <span>{meta.icon}</span>
                    <div>
                      <div className={`font-mono text-[11px] font-bold ${meta.color}`}>{meta.label}</div>
                      <div className="font-mono text-[9px] text-surface-600">{b.earned_at?.slice(0, 10)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Recent Activity */}
        {data.recentActivity.length > 0 && (
          <div className="border border-[rgba(255,255,255,0.06)] bg-[#0a0a0a] p-6 mb-6">
            <h2 className="font-mono text-[10px] text-surface-500 uppercase tracking-wider mb-4">Recent Activity</h2>
            <div className="space-y-2">
              {data.recentActivity.slice(0, 10).map((a, i) => (
                <div key={i} className="flex items-center justify-between py-1 border-b border-[rgba(255,255,255,0.03)]">
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${TYPE_COLORS[a.type] || 'bg-surface-600'}`} />
                    <span className="font-mono text-[11px] text-surface-300 capitalize">{a.type?.replace('_', ' ')}</span>
                  </div>
                  <span className="font-mono text-[10px] text-surface-600">{a.created_at?.slice(0, 10)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Meta info */}
        <div className="flex items-center justify-between text-[10px] font-mono text-surface-600">
          <span>Registered: {data.registeredAt?.slice(0, 10)}</span>
          {data.lastActive && (
            <span>Last active: {new Date(data.lastActive * 1000).toISOString().slice(0, 10)}</span>
          )}
        </div>

      </div>
    </div>
  );
}
