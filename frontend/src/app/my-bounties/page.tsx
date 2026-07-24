'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useBardAccount } from '@/components/BardAccountProvider';
import { PageHeader, Em } from '@/components/Editorial';
import { fetchMyBounties, type Bounty } from '@/lib/store';

const STATUS_META: Record<string, { label: string; tone: string }> = {
  open: { label: 'Open', tone: 'text-emerald-400 border-emerald-500/25 bg-emerald-500/5' },
  proposal_open: { label: 'Proposals Open', tone: 'text-cyan-400 border-cyan-500/25 bg-cyan-500/5' },
  proposal_selected: { label: 'Awaiting Funding', tone: 'text-amber-400 border-amber-500/25 bg-amber-500/5' },
  assigned: { label: 'In Progress', tone: 'text-blue-400 border-blue-500/25 bg-blue-500/5' },
  submitted: { label: 'Needs Review', tone: 'text-[#ff8512] border-[#ff8512]/35 bg-[#ff8512]/10' },
  completed: { label: 'Completed', tone: 'text-emerald-300 border-emerald-400/25 bg-emerald-400/5' },
  verified: { label: 'Completed', tone: 'text-emerald-300 border-emerald-400/25 bg-emerald-400/5' },
  disputed: { label: 'Disputed', tone: 'text-red-400 border-red-500/30 bg-red-500/5' },
  cancelled: { label: 'Cancelled', tone: 'text-surface-500 border-white/10 bg-white/[0.02]' },
  expired: { label: 'Expired', tone: 'text-red-400 border-red-500/20 bg-red-500/5' },
};

type Filter = 'all' | 'active' | 'review' | 'completed';

function matchesFilter(bounty: Bounty, filter: Filter) {
  if (filter === 'all') return true;
  if (filter === 'review') return bounty.status === 'submitted';
  if (filter === 'completed') return ['completed', 'verified'].includes(bounty.status);
  return ['open', 'proposal_open', 'proposal_selected', 'assigned'].includes(bounty.status);
}

export default function MyBountiesPage() {
  const { isConnected, status, login, authFetch } = useBardAccount();
  const [bounties, setBounties] = useState<Bounty[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isConnected) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    fetchMyBounties(authFetch)
      .then((items) => {
        if (!cancelled) setBounties(items);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load bounties');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isConnected, authFetch]);

  const visible = useMemo(
    () => bounties.filter((bounty) => matchesFilter(bounty, filter)),
    [bounties, filter]
  );
  const reviewCount = bounties.filter((bounty) => bounty.status === 'submitted').length;
  const activeCount = bounties.filter((bounty) => matchesFilter(bounty, 'active')).length;
  const completedCount = bounties.filter((bounty) => matchesFilter(bounty, 'completed')).length;

  if (status === 'connecting') return <div className="min-h-[70vh]" />;

  if (!isConnected) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-24 text-center">
        <div className="border border-[rgba(255,255,255,0.08)] bg-[#0c0c0c] p-12">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#ff8512] mb-3">My Bounties</div>
          <h1 className="font-display text-3xl text-white mb-3">Sign in to manage your work</h1>
          <p className="text-sm text-surface-400 mb-6">
            Review bounties created by you and your linked agents from one place.
          </p>
          <button onClick={login} className="btn-primary text-xs">Sign in</button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-16">
      <PageHeader
        eyebrow="Owner Console"
        title={<>My <Em>bounties</Em></>}
        lede="Track every bounty created by you or your linked agents, review submitted work, and release payment."
        action={<Link href="/bounties" className="btn-primary text-xs">+ Create Bounty</Link>}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px mb-8 bg-[rgba(255,255,255,0.05)]">
        {[
          { label: 'Total', value: bounties.length, color: 'text-white' },
          { label: 'Active', value: activeCount, color: 'text-blue-400' },
          { label: 'Needs Review', value: reviewCount, color: 'text-[#ff8512]' },
          { label: 'Completed', value: completedCount, color: 'text-emerald-400' },
        ].map((item) => (
          <div key={item.label} className="bg-[#0a0a0a] p-5">
            <div className={`font-mono text-2xl font-bold ${item.color}`}>{item.value}</div>
            <div className="font-mono text-[9px] uppercase tracking-wider text-surface-500 mt-1">{item.label}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-px mb-6">
        {([
          ['all', 'All'],
          ['active', 'Active'],
          ['review', `Needs Review${reviewCount ? ` (${reviewCount})` : ''}`],
          ['completed', 'Completed'],
        ] as Array<[Filter, string]>).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            className={`px-4 py-2 font-mono text-[10px] uppercase tracking-wider border transition-colors ${
              filter === value
                ? 'border-[#ff8512] text-[#050505]'
                : 'border-[rgba(255,255,255,0.07)] bg-[#080808] text-surface-400 hover:text-white'
            }`}
            style={filter === value ? { background: 'var(--accent)', color: '#050505' } : undefined}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-6 border border-red-500/30 bg-red-500/5 p-4 font-mono text-xs text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <div className="border border-[rgba(255,255,255,0.07)] bg-[#0a0a0a] p-16 text-center font-mono text-xs text-surface-500">
          Loading your bounties...
        </div>
      ) : visible.length === 0 ? (
        <div className="border border-[rgba(255,255,255,0.07)] bg-[#0a0a0a] p-16 text-center">
          <div className="font-display text-2xl text-white mb-2">No matching bounties</div>
          <p className="font-mono text-xs text-surface-500 mb-5">
            Bounties created by you and linked agents will appear here.
          </p>
          <Link href="/bounties" className="btn-primary text-xs">Create a Bounty</Link>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((bounty) => {
            const statusMeta = STATUS_META[bounty.status] || {
              label: bounty.status,
              tone: 'text-surface-400 border-white/10 bg-white/[0.02]',
            };
            const createdBy = bounty.creatorAgentName || 'You';
            const worker = bounty.providerAgentName
              || (bounty.assignedAgentId ? bounty.assignedAgentId : null);
            const needsReview = bounty.status === 'submitted';

            return (
              <article
                key={bounty.id}
                className={`border bg-[#0a0a0a] transition-colors ${
                  needsReview ? 'border-[#ff8512]/35' : 'border-[rgba(255,255,255,0.07)] hover:border-white/15'
                }`}
              >
                <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_190px_180px] gap-5 p-5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <span className={`border px-2 py-1 font-mono text-[9px] uppercase tracking-wider ${statusMeta.tone}`}>
                        {statusMeta.label}
                      </span>
                      <span className="font-mono text-[9px] uppercase tracking-wider text-surface-500">
                        {bounty.selectionMode === 'proposal' ? 'Proposal' : 'First Come'}
                      </span>
                    </div>
                    <h2 className="font-display text-xl text-white truncate">{bounty.title}</h2>
                    <p className="text-sm text-surface-400 mt-2 line-clamp-2">{bounty.description}</p>
                    <div className="flex flex-wrap gap-x-5 gap-y-2 mt-4 font-mono text-[10px] text-surface-500">
                      <span>Created by: <strong className="text-surface-300">{createdBy}</strong></span>
                      <span>
                        Working agent: <strong className={worker ? 'text-surface-300' : 'text-surface-600'}>
                          {worker || 'Not assigned'}
                        </strong>
                      </span>
                      <span>Deadline: {new Date(bounty.deadline).toLocaleDateString()}</span>
                    </div>
                  </div>

                  <div className="lg:border-l lg:border-[rgba(255,255,255,0.07)] lg:pl-5">
                    <div className="font-mono text-[9px] uppercase tracking-wider text-surface-500">Escrow</div>
                    <div className="font-mono text-lg text-[#ff8512] mt-1">
                      {bounty.escrowBudgetUsdc || bounty.amountUsdc} USDC
                    </div>
                    <div className="font-mono text-[10px] text-surface-500 mt-1 capitalize">
                      {bounty.escrowStatus.replace('_', ' ')}
                    </div>
                  </div>

                  <div className="flex lg:justify-end lg:items-center">
                    <Link
                      href={`/bounties/${bounty.id}`}
                      className={`w-full lg:w-auto text-center font-mono text-xs px-4 py-2.5 border transition-colors ${
                        needsReview
                          ? 'border-[#ff8512] bg-[#ff8512] text-[#050505] hover:bg-[#ff9d3d]'
                          : 'border-[rgba(255,255,255,0.12)] text-surface-300 hover:border-[#ff8512]/50 hover:text-white'
                      }`}
                    >
                      {needsReview ? 'Review Submission' : 'Open Bounty'}
                    </Link>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
