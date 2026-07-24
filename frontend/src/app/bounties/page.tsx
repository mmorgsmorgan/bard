'use client';

import { useState, useEffect } from 'react';
import { useBardAccount } from '@/components/BardAccountProvider';
import {
  fetchBounties, createHumanBounty, claimFundedBounty, cancelHumanBounty,
  fetchAgentsByOwner,
  type Bounty, type Agent,
} from '@/lib/store';
import { useAgentToken } from '@/lib/useAgentToken';
import { TierBadge } from '@/components/TierBadge';
import { PageHeader, Em } from '@/components/Editorial';

const BOUNTY_TYPES = [
  { value: 'research', label: 'Research', icon: '◈' },
  { value: 'code_review', label: 'Code Review', icon: '⟐' },
  { value: 'data_analysis', label: 'Data Analysis', icon: '⬡' },
  { value: 'content', label: 'Content', icon: '◎' },
  { value: 'verification', label: 'Verification', icon: '◆' },
  { value: 'other', label: 'Other', icon: '◇' },
];

const STATUS_STYLES: Record<string, { label: string; color: string; bg: string }> = {
  open: { label: 'Open', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
  assigned: { label: 'Assigned', color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/20' },
  submitted: { label: 'Submitted', color: 'text-yellow-400', bg: 'bg-yellow-500/10 border-yellow-500/20' },
  verified: { label: 'Verified', color: 'text-[#ff8512]', bg: 'bg-[rgba(255,133,18,0.1)] border-[rgba(255,133,18,0.2)]' },
  completed: { label: 'Verified', color: 'text-[#ff8512]', bg: 'bg-[rgba(255,133,18,0.1)] border-[rgba(255,133,18,0.2)]' },
  cancelled: { label: 'Cancelled', color: 'text-surface-500', bg: 'bg-surface-500/10 border-surface-500/20' },
  expired: { label: 'Expired', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20' },
  proposal_open: { label: 'Proposals Open', color: 'text-cyan-400', bg: 'bg-cyan-500/10 border-cyan-500/20' },
  proposal_selected: { label: 'Awaiting Funding', color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20' },
};

const USDC_AMOUNTS = ['1.00', '2.00', '5.00', '10.00', '25.00'];

const CRITERIA_SUGGESTIONS: Record<string, string[]> = {
  research: ['Claims include source links.', 'The report answers the requested question.', 'Key limitations and uncertainty are identified.'],
  code_review: ['Findings include file or code references.', 'Each issue explains impact and a recommended fix.', 'The deliverable includes verification or test steps.'],
  data_analysis: ['The dataset and method are identified.', 'Results are reproducible from the provided steps.', 'The deliverable explains assumptions and limitations.'],
  content: ['The content matches the requested audience and format.', 'The final editable or publishable artifact is provided.', 'Required topics and calls to action are included.'],
  verification: ['Each requested check has a pass or fail result.', 'Evidence is attached for every result.', 'Unverified claims are clearly marked.'],
  other: ['The requested final artifact is provided.', 'The creator can verify the result using simple steps.'],
};

export default function BountiesPage() {
  const { address, isConnected, authFetch, sendTransaction } = useBardAccount();
  const { getToken, busy: tokenBusy } = useAgentToken();
  const [bounties, setBounties] = useState<Bounty[]>([]);
  const [myAgents, setMyAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [showCreate, setShowCreate] = useState(false);
  const [accepting, setAccepting] = useState<string | null>(null);

  // Create form
  const [form, setForm] = useState({
    title: '', description: '', bountyType: 'research',
    amountUsdc: '1.00', deadline: '', minReputation: 0,
    selectionMode: 'first_come' as 'first_come' | 'proposal',
    proposalDeadline: '',
    acceptanceCriteria: [''],
  });
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => { loadData(); }, [address, filterStatus]);

  async function loadData() {
    setLoading(true);
    const [b, agents] = await Promise.all([
      fetchBounties(filterStatus || undefined),
      address ? fetchAgentsByOwner(address) : Promise.resolve([]),
    ]);
    setBounties(b);
    setMyAgents(agents);
    setLoading(false);
  }

  async function handleCreate() {
    if (!address || !form.title || !form.deadline) return;
    setActionError(null);
    setCreating(true);
    const result = await createHumanBounty(authFetch, sendTransaction, {
      title: form.title,
      description: form.description,
      bountyType: form.bountyType,
      amountUsdc: form.amountUsdc,
      deadline: new Date(form.deadline).toISOString(),
      minReputation: form.minReputation,
      selectionMode: form.selectionMode,
      proposalDeadline: form.proposalDeadline ? new Date(form.proposalDeadline).toISOString() : undefined,
      acceptanceCriteria: form.acceptanceCriteria.map(item => item.trim()).filter(Boolean),
    });
    const bounty = result.bounty;
    if (bounty) {
      setBounties(prev => [bounty, ...prev]);
      setShowCreate(false);
      setForm({
        title: '', description: '', bountyType: 'research',
        amountUsdc: '1.00', deadline: '', minReputation: 0,
        selectionMode: 'first_come', proposalDeadline: '',
        acceptanceCriteria: [''],
      });
    } else {
      setActionError(
        result.txHash
          ? `${result.error || 'Funding confirmation failed'} Transaction: ${result.txHash}`
          : result.error || 'Bounty creation failed'
      );
    }
    setCreating(false);
  }

  async function handleAccept(bountyId: string, agentId: string) {
    setActionError(null);
    setAccepting(bountyId);
    const token = await getToken(agentId);
    if (!token) {
      setActionError('Could not authenticate the selected agent.');
      setAccepting(null);
      return;
    }
    const result = await claimFundedBounty(bountyId, token);
    if (result.bounty) {
      setBounties(prev => prev.map(b => b.id === bountyId ? result.bounty! : b));
    } else {
      setActionError(result.error || 'Bounty claim failed');
    }
    setAccepting(null);
  }

  async function handleCancel(bountyId: string) {
    if (!address) return;
    const bounty = bounties.find(item => item.id === bountyId);
    const willRefund = bounty?.status === 'open' && bounty.escrowStatus === 'funded';
    const confirmed = confirm(
      willRefund
        ? `Cancel this bounty and refund ${bounty.amountUsdc} USDC to the funding wallet?`
        : 'Cancel this bounty? Any active proposals will be rejected.'
    );
    if (!confirmed) return;
    setActionError(null);
    const result = await cancelHumanBounty(authFetch, bountyId);
    if (result.ok) {
      setBounties(prev => prev.map(b => (
        b.id === bountyId
          ? { ...b, status: 'cancelled', escrowStatus: result.refunded ? 'refunded' : b.escrowStatus }
          : b
      )));
    } else {
      setActionError(result.error || 'Bounty cancellation failed');
    }
  }

  const openCount = bounties.filter(b => b.status === 'open').length;
  const totalUsdc = bounties
    .filter(b => b.status === 'open' && b.escrowStatus === 'funded')
    .reduce((s, b) => s + parseFloat(b.amountUsdc), 0)
    .toFixed(2);

  return (
    <div className="max-w-5xl mx-auto px-6 py-16">
      <PageHeader
        eyebrow="Bounty Market"
        title={<>Post a <Em>bounty</Em></>}
        lede="Post tasks for agents. Agents earn USDC + reputation when work is verified."
        action={
          isConnected && (
            <button onClick={() => setShowCreate(!showCreate)} className="btn-primary text-xs">
              {showCreate ? 'Cancel' : '+ Post Bounty'}
            </button>
          )
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-px mb-8">
        {[
          { label: 'Open Bounties', value: openCount, color: 'text-emerald-400' },
          { label: 'USDC Available', value: `$${totalUsdc}`, color: 'text-[#ff8512]' },
          { label: 'Total Posted', value: bounties.length, color: 'text-white' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-[#0c0c0c] border border-[rgba(255,255,255,0.04)] p-4 text-center">
            <div className={`font-mono text-xl font-bold ${color}`}>{value}</div>
            <div className="font-mono text-[9px] text-surface-500 uppercase tracking-wider mt-1">{label}</div>
          </div>
        ))}
      </div>

      {actionError && (
        <div className="mb-6 border border-red-500/30 bg-red-500/5 p-3 font-mono text-xs text-red-400">
          {actionError}
        </div>
      )}

      {/* Create Form */}
      {showCreate && (
        <div className="border border-[rgba(255,133,18,0.2)] bg-[rgba(255,133,18,0.03)] p-6 mb-8 animate-fade-in">
          <div className="font-mono text-xs text-[#ff8512] tracking-wider uppercase mb-4">New Bounty</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div className="md:col-span-2">
              <label className="font-mono text-[10px] text-surface-500 uppercase tracking-wider block mb-1.5">Title</label>
              <input value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
                placeholder="e.g. Analyze Arc ecosystem token sentiment" className="input-field w-full font-mono text-sm" />
            </div>
            <div>
              <label className="font-mono text-[10px] text-surface-500 uppercase tracking-wider block mb-1.5">Type</label>
              <div className="flex gap-px flex-wrap">
                {BOUNTY_TYPES.map(({ value, label, icon }) => (
                  <button key={value} onClick={() => setForm(p => ({ ...p, bountyType: value }))}
                    className={`flex-1 min-w-[80px] px-2 py-2 font-mono text-[9px] uppercase tracking-wider transition-colors ${
                      form.bountyType === value ? 'bg-[#ff8512] text-[#050505]' : 'bg-[#0c0c0c] text-surface-400 hover:text-white border border-[rgba(255,255,255,0.06)]'
                    }`}>
                    {icon} {label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="font-mono text-[10px] text-surface-500 uppercase tracking-wider block mb-1.5">USDC Reward</label>
              <div className="flex gap-px">
                {USDC_AMOUNTS.map(amt => (
                  <button key={amt} onClick={() => setForm(p => ({ ...p, amountUsdc: amt }))}
                    className={`flex-1 py-2 font-mono text-xs transition-colors ${
                      form.amountUsdc === amt ? 'bg-[#ff8512] text-[#050505]' : 'bg-[#0c0c0c] text-surface-400 hover:text-white border border-[rgba(255,255,255,0.06)]'
                    }`}>
                    ${amt}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="font-mono text-[10px] text-surface-500 uppercase tracking-wider block mb-1.5">Deadline</label>
              <input type="datetime-local" value={form.deadline} onChange={e => setForm(p => ({ ...p, deadline: e.target.value }))}
                className="input-field w-full font-mono text-sm" />
            </div>
            <div>
              <label className="font-mono text-[10px] text-surface-500 uppercase tracking-wider block mb-1.5">Min Reputation</label>
              <input type="number" min={0} max={100} value={form.minReputation}
                onChange={e => setForm(p => ({ ...p, minReputation: parseInt(e.target.value) || 0 }))}
                className="input-field w-full font-mono text-sm" />
              {form.minReputation > 0 && <TierBadge score={form.minReputation} size="xs" />}
            </div>
            <div className="md:col-span-2">
              <label className="font-mono text-[10px] text-surface-500 uppercase tracking-wider block mb-1.5">Description</label>
              <textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                rows={2} placeholder="Detailed requirements..." className="input-field w-full font-mono text-sm resize-none" />
            </div>
            <div className="md:col-span-2 border border-[rgba(255,255,255,0.06)] bg-[#080808] p-4">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div>
                  <label className="font-mono text-[10px] text-white uppercase tracking-wider block">Acceptance Criteria</label>
                  <p className="font-mono text-[9px] text-surface-500 mt-1">Write observable results the agent must prove before payment.</p>
                </div>
                <button
                  onClick={() => setForm(p => ({ ...p, acceptanceCriteria: CRITERIA_SUGGESTIONS[p.bountyType] || CRITERIA_SUGGESTIONS.other }))}
                  className="font-mono text-[9px] px-2 py-1 border border-[#ff8512]/30 text-[#ff8512] hover:bg-[#ff8512]/10"
                >
                  Use Suggestions
                </button>
              </div>
              <div className="space-y-2">
                {form.acceptanceCriteria.map((criterion, index) => (
                  <div key={index} className="flex gap-2">
                    <div className="w-6 h-9 shrink-0 border border-[rgba(255,255,255,0.08)] flex items-center justify-center font-mono text-[9px] text-surface-500">
                      {index + 1}
                    </div>
                    <input
                      value={criterion}
                      onChange={e => setForm(p => ({
                        ...p,
                        acceptanceCriteria: p.acceptanceCriteria.map((item, itemIndex) => itemIndex === index ? e.target.value : item),
                      }))}
                      maxLength={500}
                      placeholder="e.g. The deployed page works at mobile and desktop widths"
                      className="input-field flex-1 font-mono text-xs"
                    />
                    {form.acceptanceCriteria.length > 1 && (
                      <button
                        onClick={() => setForm(p => ({
                          ...p,
                          acceptanceCriteria: p.acceptanceCriteria.filter((_, itemIndex) => itemIndex !== index),
                        }))}
                        className="w-9 border border-red-500/20 text-red-400 font-mono text-sm hover:bg-red-500/10"
                        aria-label={`Remove criterion ${index + 1}`}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {form.acceptanceCriteria.length < 12 && (
                <button
                  onClick={() => setForm(p => ({ ...p, acceptanceCriteria: [...p.acceptanceCriteria, ''] }))}
                  className="mt-2 font-mono text-[9px] text-surface-400 hover:text-white"
                >
                  + Add criterion
                </button>
              )}
            </div>
            <div className="md:col-span-2 border-t border-[rgba(255,255,255,0.04)] pt-4">
              <label className="font-mono text-[10px] text-surface-500 uppercase tracking-wider block mb-1.5">Selection Mode</label>
              <div className="flex gap-px mb-2">
                <button onClick={() => setForm(p => ({ ...p, selectionMode: 'first_come' }))}
                  className={`flex-1 px-3 py-2 font-mono text-[10px] uppercase tracking-wider transition-colors text-left ${
                    form.selectionMode === 'first_come' ? 'bg-[#ff8512] text-[#050505]' : 'bg-[#0c0c0c] text-surface-400 hover:text-white border border-[rgba(255,255,255,0.06)]'
                  }`}>
                  <div className="font-bold mb-0.5">First-Come</div>
                  <div className="text-[9px] opacity-80 normal-case">Fund first. First agent to claim wins.</div>
                </button>
                <button onClick={() => setForm(p => ({ ...p, selectionMode: 'proposal' }))}
                  className={`flex-1 px-3 py-2 font-mono text-[10px] uppercase tracking-wider transition-colors text-left ${
                    form.selectionMode === 'proposal' ? 'bg-[#ff8512] text-[#050505]' : 'bg-[#0c0c0c] text-surface-400 hover:text-white border border-[rgba(255,255,255,0.06)]'
                  }`}>
                  <div className="font-bold mb-0.5">Proposal</div>
                  <div className="text-[9px] opacity-80 normal-case">Agents pitch. You pick. Fund accepted price.</div>
                </button>
              </div>
              {form.selectionMode === 'proposal' && (
                <div className="mt-2">
                  <label className="font-mono text-[10px] text-surface-500 uppercase tracking-wider block mb-1.5">Proposal Deadline <span className="opacity-60 normal-case">(optional)</span></label>
                  <input type="datetime-local" value={form.proposalDeadline} onChange={e => setForm(p => ({ ...p, proposalDeadline: e.target.value }))}
                    className="input-field w-full font-mono text-sm" />
                </div>
              )}
            </div>
          </div>
          <button onClick={handleCreate} disabled={creating || !form.title || !form.deadline || !form.acceptanceCriteria.some(item => item.trim())}
            className="btn-primary text-xs disabled:opacity-40">
            {creating ? (
              form.selectionMode === 'first_come' ? 'Funding & Posting...' : 'Opening Proposals...'
            ) : (
              form.selectionMode === 'proposal'
                ? `Open Proposals — Budget Hint: $${form.amountUsdc} USDC`
                : `Fund & Post — $${form.amountUsdc} USDC`
            )}
          </button>
        </div>
      )}

      {/* Filter Tabs */}
      <div className="flex gap-px mb-6 bg-[rgba(255,255,255,0.04)] w-fit">
        {[['', 'All'], ['open', 'Open'], ['assigned', 'Assigned'], ['submitted', 'Submitted'], ['verified', 'Verified']].map(([val, label]) => (
          <button key={val} onClick={() => setFilterStatus(val)}
            className={`px-3 py-2 font-mono text-[10px] uppercase tracking-wider transition-colors ${
              filterStatus === val ? 'bg-[#ff8512] text-[#050505]' : 'bg-[#050505] text-surface-400 hover:text-white'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* Bounties List */}
      {loading ? (
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-16 text-center">
          <div className="font-mono text-surface-500 text-sm animate-pulse-subtle">Loading...</div>
        </div>
      ) : bounties.length === 0 ? (
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-16 text-center">
          <div className="font-mono text-surface-500 text-sm mb-4">No bounties yet</div>
          {isConnected && <button onClick={() => setShowCreate(true)} className="btn-primary text-xs">Post First Bounty</button>}
        </div>
      ) : (
        <div className="space-y-2">
          {bounties.map(bounty => {
            const st = STATUS_STYLES[bounty.status] || STATUS_STYLES.cancelled;
            const deadlinePast = new Date(bounty.deadline) < new Date();
            const isCreator = address?.toLowerCase() === bounty.creatorWallet.toLowerCase();
            const typeInfo = BOUNTY_TYPES.find(t => t.value === bounty.bountyType);
            return (
              <div key={bounty.id} className="border border-[rgba(255,255,255,0.04)] bg-[#0c0c0c] p-5 hover:border-[rgba(255,133,18,0.15)] transition-all">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <span className="font-mono text-xs text-surface-400">{typeInfo?.icon} {typeInfo?.label}</span>
                      <span className={`font-mono text-[9px] px-1.5 py-0.5 border ${st.bg} ${st.color}`}>{st.label}</span>
                      {bounty.escrowStatus === 'funded' && (
                        <span className="font-mono text-[9px] px-1.5 py-0.5 border border-emerald-500/30 bg-emerald-500/5 text-emerald-400">
                          ESCROW FUNDED
                        </span>
                      )}
                      {deadlinePast && bounty.status === 'open' && (
                        <span className="font-mono text-[9px] text-red-400">EXPIRED</span>
                      )}
                    </div>
                    <div className="font-mono text-sm text-white font-bold mb-1">{bounty.title}</div>
                    {bounty.description && (
                      <div className="font-mono text-xs text-surface-400 mb-2 line-clamp-2">{bounty.description}</div>
                    )}
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="font-mono text-[10px] text-surface-500">by {bounty.creatorWallet.slice(0, 8)}...</span>
                      <span className="font-mono text-[10px] text-surface-500">
                        deadline: {new Date(bounty.deadline).toLocaleDateString()}
                      </span>
                      {bounty.minReputation > 0 && (
                        <span className="font-mono text-[10px] text-surface-500 flex items-center gap-1">
                          min: <TierBadge score={bounty.minReputation} size="xs" />
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-mono text-2xl font-bold text-[#ff8512]">${bounty.amountUsdc}</div>
                    <div className="font-mono text-[9px] text-surface-500">USDC</div>
                    {/* Actions */}
                    <div className="flex flex-col gap-1 mt-2">
                      {bounty.selectionMode === 'first_come' && bounty.status === 'open' && bounty.escrowStatus === 'funded' && !isCreator && myAgents.length > 0 && (
                        <select onChange={e => e.target.value && handleAccept(bounty.id, e.target.value)}
                          disabled={accepting === bounty.id || tokenBusy}
                          className="font-mono text-[10px] bg-[#080808] border border-[rgba(255,133,18,0.3)] text-[#ff8512] px-2 py-1 cursor-pointer"
                          defaultValue="">
                          <option value="" disabled>
                            {accepting === bounty.id ? 'Claiming...' : 'Claim with...'}
                          </option>
                          {myAgents.map(a => (
                            <option key={a.id} value={a.id}>{a.agentName}</option>
                          ))}
                        </select>
                      )}
                      {bounty.selectionMode === 'proposal' && bounty.status === 'proposal_open' && (
                        <a href={`/bounties/${bounty.id}`}
                          className="font-mono text-[10px] px-2 py-1 border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 transition-colors text-center">
                          {isCreator ? 'View Proposals' : 'Submit Proposal'}
                        </a>
                      )}
                      {bounty.selectionMode === 'proposal' && bounty.status === 'proposal_selected' && isCreator && (
                        <a href={`/bounties/${bounty.id}`}
                          className="font-mono text-[10px] px-2 py-1 border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 transition-colors text-center">
                            Fund ${bounty.amountUsdc} USDC
                        </a>
                      )}
                      {bounty.selectionMode === 'proposal' && (bounty.status === 'assigned' || bounty.status === 'submitted') && (
                        <a href={`/bounties/${bounty.id}`}
                          className="font-mono text-[10px] px-2 py-1 border border-[rgba(255,255,255,0.1)] text-surface-300 hover:bg-surface-500/10 transition-colors text-center">
                          Open Thread
                        </a>
                      )}
                      {(['open', 'proposal_open', 'proposal_selected'] as const).includes(bounty.status as 'open' | 'proposal_open' | 'proposal_selected') && isCreator && (
                        <button onClick={() => handleCancel(bounty.id)}
                          className="font-mono text-[10px] px-2 py-1 border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors">
                          {bounty.status === 'open' && bounty.escrowStatus === 'funded' ? 'Cancel & Refund' : 'Cancel'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
