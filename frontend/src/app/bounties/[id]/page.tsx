'use client';

import { useEffect, useState, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { useBardAccount } from '@/components/BardAccountProvider';
import {
  fetchBountyById,
  fetchBountyProposals,
  fetchAgentsByOwner,
  submitBountyProposal,
  updateBountyProposal,
  withdrawBountyProposal,
  acceptHumanBountyProposal,
  cancelHumanBounty,
  fundHumanBounty,
  rejectHumanBountyProposal,
  reviewHumanBounty,
  requestHumanBountyVerification,
  type Bounty,
  type BountyProposal,
  type Agent,
} from '@/lib/store';
import { useAgentToken } from '@/lib/useAgentToken';
import { MessageThread } from '@/components/MessageThread';
import { TierBadge } from '@/components/TierBadge';
import { Headline } from '@/components/Editorial';
import { EscrowPanel } from '@/components/EscrowPanel';

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  assigned: 'Assigned',
  submitted: 'Submitted',
  verified: 'Verified',
  completed: 'Completed',
  cancelled: 'Cancelled',
  expired: 'Expired',
  disputed: 'Disputed',
  proposal_open: 'Accepting Proposals',
  proposal_selected: 'Awaiting Funding',
};

export default function BountyDetailPage() {
  const params = useParams<{ id: string }>();
  const bountyId = params.id;
  const { address, isConnected, authFetch, sendTransaction } = useBardAccount();
  const { getToken, busy: tokenBusy, error: tokenError } = useAgentToken();

  const [bounty, setBounty] = useState<Bounty | null>(null);
  const [proposals, setProposals] = useState<BountyProposal[]>([]);
  const [isCreator, setIsCreator] = useState(false);
  const [myAgents, setMyAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [openThreadFor, setOpenThreadFor] = useState<string | null>(null);

  // Proposal form (for non-creators with agents)
  const [showForm, setShowForm] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [form, setForm] = useState({ plan: '', proposedPriceUsdc: 1, estimatedHours: 1 });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [editingProposalId, setEditingProposalId] = useState<string | null>(null);

  // Creator action state
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [reviewReason, setReviewReason] = useState('');

  async function loadAll() {
    setLoading(true);
    const b = await fetchBountyById(bountyId);
    setBounty(b);
    if (b) {
      const [{ proposals, isCreator }, agents] = await Promise.all([
        fetchBountyProposals(bountyId, authFetch),
        address ? fetchAgentsByOwner(address) : Promise.resolve([]),
      ]);
      setProposals(proposals);
      setIsCreator(isCreator);
      setMyAgents(agents);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bountyId, address]);

  // Find current user's existing proposal (if any)
  const myProposal = useMemo(() => {
    if (!address) return null;
    return proposals.find(p => p.proposerWallet.toLowerCase() === address.toLowerCase()) || null;
  }, [proposals, address]);

  // Eligible agents for proposing (not the bounty creator + meets min reputation)
  const eligibleAgents = useMemo(() => {
    if (isCreator || !bounty) return [];
    return myAgents.filter(a => (a.reputationScore || 0) >= (bounty.minReputation || 0));
  }, [myAgents, isCreator, bounty]);

  // ── Actions ─────────────────────────────────────────────

  async function handleSubmitProposal() {
    if (!bounty || !selectedAgentId) return;
    setSubmitError(null);
    setSubmitting(true);
    const token = await getToken(selectedAgentId);
    if (!token) {
      setSubmitError('Could not authenticate the selected agent.');
      setSubmitting(false);
      return;
    }
    if (editingProposalId) {
      const res = await updateBountyProposal(bounty.id, editingProposalId, token, form);
      if (res.error) {
        setSubmitError(res.error);
      } else {
        setShowForm(false);
        setEditingProposalId(null);
        await loadAll();
      }
    } else {
      const res = await submitBountyProposal(bounty.id, token, form);
      if (res.error) {
        setSubmitError(res.error);
      } else {
        setShowForm(false);
        await loadAll();
      }
    }
    setSubmitting(false);
  }

  async function handleEditProposal(p: BountyProposal) {
    setEditingProposalId(p.id);
    setSelectedAgentId(p.proposerAgentId);
    setForm({
      plan: p.plan,
      proposedPriceUsdc: p.proposedPriceUsdc,
      estimatedHours: p.estimatedHours,
    });
    setShowForm(true);
  }

  async function handleWithdraw(p: BountyProposal) {
    if (!confirm('Withdraw your proposal?')) return;
    const token = await getToken(p.proposerAgentId);
    if (!token) return;
    setActionBusy(true);
    const ok = await withdrawBountyProposal(p.bountyId, p.id, token);
    if (ok) await loadAll();
    setActionBusy(false);
  }

  async function handleAccept(p: BountyProposal) {
    if (!address) return;
    if (!confirm(`Accept and fund this proposal at ${p.proposedPriceUsdc} USDC? All other proposals will be auto-rejected.`)) return;
    setActionError(null);
    setActionBusy(true);
    const selection = await acceptHumanBountyProposal(authFetch, p.bountyId, p.id);
    if (selection.error) {
      setActionError(selection.error);
    } else {
      const funding = await fundHumanBounty(authFetch, sendTransaction, p.bountyId);
      if (funding.error) {
        setActionError(
          funding.txHash
            ? `${funding.error} Transaction: ${funding.txHash}`
            : `Proposal selected, but funding failed: ${funding.error}`
        );
      }
      await loadAll();
    }
    setActionBusy(false);
  }

  async function handleFund() {
    if (!bounty) return;
    setActionError(null);
    setActionBusy(true);
    const result = await fundHumanBounty(authFetch, sendTransaction, bounty.id);
    if (result.error) {
      setActionError(
        result.txHash
          ? `${result.error} Transaction: ${result.txHash}`
          : result.error
      );
    }
    await loadAll();
    setActionBusy(false);
  }

  async function handleCancel() {
    if (!bounty) return;
    const willRefund = bounty.status === 'open' && bounty.escrowStatus === 'funded';
    const confirmed = confirm(
      willRefund
        ? `Cancel this bounty and refund ${bounty.amountUsdc} USDC to the funding wallet?`
        : 'Cancel this bounty? Any active proposals will be rejected.'
    );
    if (!confirmed) return;
    setActionError(null);
    setActionBusy(true);
    const result = await cancelHumanBounty(authFetch, bounty.id);
    if (result.ok) {
      setBounty(current => current ? {
        ...current,
        status: 'cancelled',
        escrowStatus: result.refunded ? 'refunded' : current.escrowStatus,
      } : current);
      await loadAll();
    } else {
      setActionError(result.error || 'Bounty cancellation failed');
    }
    setActionBusy(false);
  }

  async function handleReject(p: BountyProposal) {
    if (!address) return;
    const reason = prompt('Reason for rejection (shown to proposer, optional):') || '';
    setActionError(null);
    setActionBusy(true);
    const result = await rejectHumanBountyProposal(authFetch, p.bountyId, p.id, reason);
    if (result.ok) await loadAll();
    else setActionError(result.error || 'Proposal rejection failed');
    setActionBusy(false);
  }

  async function handleDeliverableReview(decision: 'approved' | 'rejected') {
    if (!bounty) return;
    if (decision === 'rejected' && !reviewReason.trim()) {
      setActionError('Explain what must change before requesting a revision.');
      return;
    }
    if (
      decision === 'approved'
      && !confirm(`Approve this work and release ${bounty.escrowBudgetUsdc || bounty.amountUsdc} USDC to the agent?`)
    ) {
      return;
    }

    setActionError(null);
    setActionMessage(null);
    setActionBusy(true);
    const result = await reviewHumanBounty(
      authFetch,
      bounty.id,
      decision,
      reviewReason.trim()
    );
    if (result.error) {
      setActionError(result.error);
    } else {
      setReviewReason('');
      if (result.pending) {
        setActionMessage(`Payment was broadcast and is confirming${result.txHash ? `: ${result.txHash}` : '.'}`);
      } else if (decision === 'approved') {
        setActionMessage('Work approved. Escrow payment was released to the agent.');
      } else if (bounty.revisionCount >= 1) {
        setActionMessage('The revised work was rejected and escalated for dispute resolution.');
      } else {
        setActionMessage('Revision requested. The agent can submit an updated proof package.');
      }
      await loadAll();
    }
    setActionBusy(false);
  }

  async function handleIndependentReview() {
    if (!bounty) return;
    setActionError(null);
    setActionMessage(null);
    setActionBusy(true);
    const result = await requestHumanBountyVerification(
      authFetch,
      bounty.id,
      reviewReason.trim()
    );
    if (result.error) {
      setActionError(result.error);
    } else {
      setActionMessage('Independent review requested. Escrow remains locked until the verifier decides.');
      if (result.bounty) setBounty(result.bounty);
      else await loadAll();
    }
    setActionBusy(false);
  }

  // ── Render ──────────────────────────────────────────────

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-16">
        <div className="font-mono text-xs text-surface-500">Loading bounty…</div>
      </div>
    );
  }

  if (!bounty) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-16">
        <div className="font-mono text-xs text-red-400">Bounty not found.</div>
        <a href="/bounties" className="btn-primary text-xs mt-4 inline-block">← Back to Bounties</a>
      </div>
    );
  }

  const pendingProposals = proposals.filter(p => p.status === 'pending');
  const acceptedProposal = proposals.find(p => p.status === 'accepted');
  const isProposalMode = bounty.selectionMode === 'proposal';

  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      <a href="/bounties" className="font-mono text-[10px] text-surface-500 hover:text-white">← All Bounties</a>

      {/* Bounty header */}
      <div className="mt-4 mb-8">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex-1">
            <div className="font-mono text-[10px] text-surface-500 uppercase tracking-wider mb-2">
              {bounty.bountyType.replace('_', ' ')} · {bounty.selectionMode === 'proposal' ? 'Proposal Mode' : 'First-Come Mode'}
            </div>
            <Headline size="2.25rem" className="mb-2">{bounty.title}</Headline>
            <p className="text-surface-400 text-sm whitespace-pre-wrap">{bounty.description}</p>
          </div>
          <div className="shrink-0 text-right">
            <div className="font-mono text-3xl font-bold text-[#ff8512]">${bounty.amountUsdc}</div>
            <div className="font-mono text-[9px] text-surface-500">USDC</div>
            <div className="mt-3 inline-block px-2 py-1 border border-[rgba(255,255,255,0.08)] font-mono text-[10px]">
              {STATUS_LABEL[bounty.status] || bounty.status}
            </div>
            {isCreator && ['open', 'proposal_open', 'proposal_selected'].includes(bounty.status) && (
              <button
                onClick={handleCancel}
                disabled={actionBusy}
                className="mt-2 block ml-auto font-mono text-[10px] px-2 py-1 border border-red-500/30 text-red-400 hover:bg-red-500/10 disabled:opacity-40"
              >
                {bounty.status === 'open' && bounty.escrowStatus === 'funded'
                  ? 'Cancel & Refund'
                  : 'Cancel Bounty'}
              </button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-4 text-[10px] font-mono text-surface-500">
          <div>Deadline: {new Date(bounty.deadline).toLocaleString()}</div>
          {bounty.proposalDeadline && (
            <div>Proposal Deadline: {new Date(bounty.proposalDeadline).toLocaleString()}</div>
          )}
          {bounty.minReputation > 0 && (
            <div>Min Reputation: {bounty.minReputation}</div>
          )}
          <div>Creator: {bounty.creatorWallet.slice(0, 8)}…{bounty.creatorWallet.slice(-6)}</div>
        </div>
      </div>

      {actionError && (
        <div className="mb-4 p-3 border border-red-500/30 bg-red-500/5 font-mono text-xs text-red-400">{actionError}</div>
      )}
      {actionMessage && (
        <div className="mb-4 p-3 border border-emerald-500/30 bg-emerald-500/5 font-mono text-xs text-emerald-400">{actionMessage}</div>
      )}

      {/* On-chain escrow status (renders only when contract-escrowed) */}
      <EscrowPanel bountyId={bounty.id} />

      <AcceptanceCriteriaPanel bounty={bounty} />

      {isCreator && bounty.deliverableContent && (
        <HumanReviewPanel
          bounty={bounty}
          reviewReason={reviewReason}
          setReviewReason={setReviewReason}
          actionBusy={actionBusy}
          onReview={handleDeliverableReview}
          onRequestVerification={handleIndependentReview}
        />
      )}

      {!isProposalMode && (
        <div className="border border-[rgba(255,255,255,0.08)] bg-[#0a0a0a] p-6">
          <div className="font-mono text-[10px] text-surface-500 uppercase tracking-wider mb-2">First-Come Mode</div>
          <p className="text-sm text-surface-300">
            {bounty.escrowStatus === 'funded'
              ? `${bounty.escrowBudgetUsdc || bounty.amountUsdc} USDC is funded in escrow. The first eligible agent to claim can begin work.`
              : 'This bounty is not funded and cannot be claimed.'}
          </p>
        </div>
      )}

      {/* ──── Proposal mode views ──── */}
      {isProposalMode && (
        <>
          {/* AGENT (non-creator) view */}
          {!isCreator && (
            <div className="space-y-6">
              {/* Existing proposal (if any) */}
              {myProposal && (
                <div className="border border-[rgba(255,255,255,0.08)] bg-[#0a0a0a] p-6">
                  <div className="font-mono text-[10px] text-surface-500 uppercase tracking-wider mb-3">Your Proposal</div>
                  <ProposalCard p={myProposal} compact />
                  {myProposal.status === 'pending' && bounty.status === 'proposal_open' && (
                    <div className="mt-4 flex gap-2">
                      <button onClick={() => handleEditProposal(myProposal)} className="btn-primary text-xs">Edit</button>
                      <button onClick={() => handleWithdraw(myProposal)} disabled={actionBusy}
                        className="font-mono text-xs px-3 py-1.5 border border-red-500/30 text-red-400 hover:bg-red-500/10">
                        Withdraw
                      </button>
                    </div>
                  )}
                  {/* Message thread for proposer */}
                  {address && (
                    <div className="mt-6">
                      <MessageThread
                        bountyId={bounty.id}
                        proposalId={myProposal.id}
                        currentWallet={address}
                        counterpartyLabel="Creator"
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Submit form (if eligible and no existing or editing) */}
              {isConnected && bounty.status === 'proposal_open' && (!myProposal || editingProposalId) && (
                <div className="border border-[rgba(255,255,255,0.08)] bg-[#0a0a0a] p-6">
                  <div className="font-mono text-[10px] text-surface-500 uppercase tracking-wider mb-3">
                    {editingProposalId ? 'Update Proposal' : 'Submit Proposal'}
                  </div>
                  {eligibleAgents.length === 0 ? (
                    <div className="font-mono text-xs text-surface-500">
                      No eligible agents under this wallet. {bounty.minReputation > 0 && `Min reputation: ${bounty.minReputation}.`}
                    </div>
                  ) : !showForm ? (
                    <button onClick={() => { setShowForm(true); setSelectedAgentId(eligibleAgents[0].id); }}
                      className="btn-primary text-xs">+ Pitch this Bounty</button>
                  ) : (
                    <div className="space-y-4">
                      <div>
                        <label className="font-mono text-[10px] text-surface-500 uppercase tracking-wider block mb-1.5">Submit As</label>
                        <select value={selectedAgentId} onChange={e => setSelectedAgentId(e.target.value)}
                          disabled={Boolean(editingProposalId)}
                          className="input-field w-full font-mono text-sm">
                          {eligibleAgents.map(a => (
                            <option key={a.id} value={a.id}>{a.agentName} (rep {a.reputationScore})</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="font-mono text-[10px] text-surface-500 uppercase tracking-wider block mb-1.5">Your Plan (10-8000 chars)</label>
                        <textarea value={form.plan} onChange={e => setForm(p => ({ ...p, plan: e.target.value }))}
                          rows={6} maxLength={8000}
                          placeholder="Describe your approach, deliverables, and any relevant past experience…"
                          className="input-field w-full font-mono text-sm" />
                        <div className="font-mono text-[9px] text-surface-500 text-right mt-0.5">{form.plan.length}/8000</div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="font-mono text-[10px] text-surface-500 uppercase tracking-wider block mb-1.5">Price (USDC)</label>
                          <input type="number" min={1} step={0.5} value={form.proposedPriceUsdc}
                            onChange={e => setForm(p => ({ ...p, proposedPriceUsdc: parseFloat(e.target.value) || 1 }))}
                            className="input-field w-full font-mono text-sm" />
                        </div>
                        <div>
                          <label className="font-mono text-[10px] text-surface-500 uppercase tracking-wider block mb-1.5">Estimated Hours</label>
                          <input type="number" min={0} value={form.estimatedHours}
                            onChange={e => setForm(p => ({ ...p, estimatedHours: parseInt(e.target.value) || 0 }))}
                            className="input-field w-full font-mono text-sm" />
                        </div>
                      </div>
                      {(submitError || tokenError) && (
                        <div className="font-mono text-xs text-red-400">{submitError || tokenError}</div>
                      )}
                      <div className="flex gap-2">
                        <button onClick={handleSubmitProposal}
                          disabled={submitting || tokenBusy || form.plan.length < 10}
                          className="btn-primary text-xs disabled:opacity-40">
                          {tokenBusy ? 'Authenticating...' : submitting ? 'Submitting...' : (editingProposalId ? 'Update Proposal' : 'Submit Proposal')}
                        </button>
                        <button onClick={() => { setShowForm(false); setEditingProposalId(null); setSubmitError(null); }}
                          className="font-mono text-xs px-3 py-1.5 border border-[rgba(255,255,255,0.1)] text-surface-300">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {!isConnected && (
                <div className="border border-[rgba(255,255,255,0.08)] bg-[#0a0a0a] p-6">
                  <div className="font-mono text-xs text-surface-400">Connect wallet to submit a proposal.</div>
                </div>
              )}
            </div>
          )}

          {/* CREATOR view */}
          {isCreator && (
            <div className="space-y-6">
              {bounty.status === 'proposal_selected' && acceptedProposal && (
                <div className="border border-amber-500/30 bg-amber-500/5 p-6">
                  <div className="font-mono text-[10px] text-amber-400 uppercase tracking-wider mb-2">Awaiting Funding</div>
                  <p className="text-sm text-surface-300 mb-3">
                    You accepted {acceptedProposal.agentName || 'an agent'}'s proposal at <strong className="text-amber-400">${bounty.amountUsdc} USDC</strong>.
                    Fund the accepted price from your BARD wallet to assign the agent.
                  </p>
                  <button
                    onClick={handleFund}
                    disabled={actionBusy}
                    className="btn-primary text-xs disabled:opacity-40"
                  >
                    {actionBusy ? 'Funding...' : `Fund ${bounty.amountUsdc} USDC`}
                  </button>
                </div>
              )}

              <div className="border border-[rgba(255,255,255,0.08)] bg-[#0a0a0a] p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="font-mono text-[10px] text-surface-500 uppercase tracking-wider">
                    Proposals ({proposals.length})
                  </div>
                  <button onClick={loadAll} className="font-mono text-[10px] text-surface-500 hover:text-white">Refresh</button>
                </div>
                {proposals.length === 0 ? (
                  <div className="font-mono text-xs text-surface-500 py-8 text-center">
                    No proposals yet. Share the bounty link to attract agents.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {proposals.map(p => (
                      <div key={p.id} className={`border p-4 ${
                        p.status === 'accepted' ? 'border-emerald-500/30 bg-emerald-500/5' :
                        p.status === 'rejected' ? 'border-red-500/20 bg-red-500/5 opacity-60' :
                        p.status === 'withdrawn' ? 'border-[rgba(255,255,255,0.08)] opacity-50' :
                        'border-[rgba(255,255,255,0.08)] bg-[#0c0c0c]'
                      }`}>
                        <ProposalCard p={p} />
                        {p.status === 'pending' && bounty.status === 'proposal_open' && (
                          <div className="mt-3 flex gap-2 items-center">
                            <button onClick={() => handleAccept(p)} disabled={actionBusy}
                              className="btn-primary text-xs disabled:opacity-40">
                              Accept & Fund ${p.proposedPriceUsdc}
                            </button>
                            <button onClick={() => handleReject(p)} disabled={actionBusy}
                              className="font-mono text-xs px-3 py-1.5 border border-red-500/30 text-red-400 hover:bg-red-500/10">
                              Reject
                            </button>
                            <button onClick={() => setOpenThreadFor(openThreadFor === p.id ? null : p.id)}
                              className="font-mono text-xs px-3 py-1.5 border border-[rgba(255,255,255,0.1)] text-surface-300 hover:bg-surface-500/10">
                              {openThreadFor === p.id ? 'Hide Thread' : 'Open Thread'}
                            </button>
                          </div>
                        )}
                        {/* Inline thread per proposal */}
                        {openThreadFor === p.id && address && (
                          <div className="mt-4">
                            <MessageThread
                              bountyId={bounty.id}
                              proposalId={p.id}
                              currentWallet={address}
                              counterpartyLabel={p.agentName || p.proposerWallet.slice(0, 8) + '…'}
                            />
                          </div>
                        )}
                        {p.status === 'accepted' && address && (
                          <div className="mt-4">
                            <MessageThread
                              bountyId={bounty.id}
                              proposalId={p.id}
                              currentWallet={address}
                              counterpartyLabel={`${p.agentName} (selected)`}
                            />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AcceptanceCriteriaPanel({ bounty }: { bounty: Bounty }) {
  const criteria = bounty.acceptanceCriteria.length > 0
    ? bounty.acceptanceCriteria
    : [{ id: 'criterion-1', text: bounty.description || bounty.title }];

  return (
    <div className="border border-[rgba(255,255,255,0.08)] bg-[#0a0a0a] p-6 mb-6">
      <div className="font-mono text-[10px] text-surface-500 uppercase tracking-wider mb-4">
        Acceptance Contract
      </div>
      <div className="space-y-2">
        {criteria.map((criterion, index) => (
          <div key={criterion.id} className="flex items-start gap-3 border border-[rgba(255,255,255,0.05)] bg-[#080808] p-3">
            <span className="w-5 h-5 shrink-0 border border-[#ff8512]/30 text-[#ff8512] font-mono text-[9px] flex items-center justify-center">
              {index + 1}
            </span>
            <p className="text-sm text-surface-300">{criterion.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function HumanReviewPanel({
  bounty,
  reviewReason,
  setReviewReason,
  actionBusy,
  onReview,
  onRequestVerification,
}: {
  bounty: Bounty;
  reviewReason: string;
  setReviewReason: (value: string) => void;
  actionBusy: boolean;
  onReview: (decision: 'approved' | 'rejected') => void;
  onRequestVerification: () => void;
}) {
  const criteria = bounty.acceptanceCriteria.length > 0
    ? bounty.acceptanceCriteria
    : [{ id: 'criterion-1', text: bounty.description || bounty.title }];
  const report = bounty.verificationReport;
  const isReviewable = bounty.escrowStatus === 'submitted';
  const isReleased = bounty.escrowStatus === 'released';
  const isDisputed = bounty.escrowStatus === 'disputed';

  return (
    <section className="mb-8 border border-[#ff8512]/30 bg-[linear-gradient(135deg,rgba(255,133,18,0.07),rgba(10,10,10,0.96)_38%)]">
      <div className="p-6 border-b border-[rgba(255,255,255,0.07)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="font-mono text-[10px] text-[#ff8512] uppercase tracking-[0.18em] mb-2">Work Review</div>
            <h2 className="text-xl font-bold text-white">Inspect the proof before releasing payment</h2>
            {bounty.submittedAt && (
              <p className="font-mono text-[9px] text-surface-500 mt-2">
                Submitted {new Date(bounty.submittedAt).toLocaleString()} · Revision {bounty.revisionCount}
              </p>
            )}
          </div>
          <div className={`px-3 py-2 border font-mono text-[10px] ${
            report?.status === 'ready_for_human_review'
              ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400'
              : 'border-amber-500/30 bg-amber-500/5 text-amber-400'
          }`}>
            {report?.status === 'ready_for_human_review' ? 'PACKAGE COMPLETE' : 'CHECK EVIDENCE'}
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {report?.checks && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-[rgba(255,255,255,0.06)]">
            <CheckMetric
              label="Criteria"
              value={`${report.checks.criteriaCovered}/${report.checks.criteriaTotal}`}
              ok={report.checks.allCriteriaCovered}
            />
            <CheckMetric
              label="Test Steps"
              value={report.checks.instructionsProvided ? 'Provided' : 'Missing'}
              ok={report.checks.instructionsProvided}
            />
            <CheckMetric
              label="Artifacts"
              value={String(report.checks.artifactCount)}
              ok={report.checks.artifactCount > 0}
            />
            <CheckMetric
              label="Link Format"
              value={report.checks.invalidLinks === 0 ? 'Valid' : `${report.checks.invalidLinks} invalid`}
              ok={report.checks.invalidLinks === 0}
            />
          </div>
        )}

        <ReviewBlock label="Agent Summary">
          <p className="text-sm text-surface-200 whitespace-pre-wrap">
            {bounty.deliverableSummary || 'The agent did not provide a separate summary. Review the full deliverable below.'}
          </p>
        </ReviewBlock>

        <ReviewBlock label="Criteria Evidence">
          <div className="space-y-3">
            {criteria.map((criterion, index) => {
              const evidence = bounty.deliverableEvidence.filter(item => item.criterionId === criterion.id);
              const covered = evidence.some(item => item.proof || item.links.length > 0);
              return (
                <div key={criterion.id} className={`border p-4 ${
                  covered ? 'border-emerald-500/20 bg-emerald-500/[0.03]' : 'border-amber-500/25 bg-amber-500/[0.03]'
                }`}>
                  <div className="flex items-start gap-3">
                    <span className={`font-mono text-xs ${covered ? 'text-emerald-400' : 'text-amber-400'}`}>
                      {covered ? 'PASS' : 'OPEN'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-white">{index + 1}. {criterion.text}</div>
                      {evidence.length === 0 ? (
                        <p className="font-mono text-[10px] text-amber-400/80 mt-2">
                          No criterion-specific evidence was provided.
                        </p>
                      ) : evidence.map((item, evidenceIndex) => (
                        <div key={evidenceIndex} className="mt-3 border-l-2 border-emerald-500/20 pl-3">
                          <p className="text-xs text-surface-300 whitespace-pre-wrap">{item.proof}</p>
                          <EvidenceLinks links={item.links} />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </ReviewBlock>

        {bounty.deliverableArtifacts.length > 0 && (
          <ReviewBlock label="Artifacts">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {bounty.deliverableArtifacts.map((artifact, index) => (
                isSafeExternalUrl(artifact.url) ? (
                  <a
                    key={`${artifact.url}-${index}`}
                    href={artifact.url}
                    target="_blank"
                    rel="noreferrer"
                    className="border border-[rgba(255,255,255,0.08)] bg-[#080808] p-3 hover:border-[#ff8512]/40 transition-colors"
                  >
                    <div className="font-mono text-[9px] text-surface-500 uppercase">{artifact.type || 'link'}</div>
                    <div className="text-sm text-[#ff8512] mt-1 break-words">{artifact.label || artifact.url} ↗</div>
                  </a>
                ) : (
                  <div key={`${artifact.url}-${index}`} className="border border-red-500/20 bg-red-500/5 p-3">
                    <div className="font-mono text-[9px] text-red-400">INVALID ARTIFACT URL</div>
                    <div className="font-mono text-[10px] text-surface-500 mt-1 break-all">{artifact.url}</div>
                  </div>
                )
              ))}
            </div>
          </ReviewBlock>
        )}

        <ReviewBlock label="How To Verify">
          <p className="text-sm text-surface-300 whitespace-pre-wrap">
            {bounty.deliverableInstructions || 'No verification instructions were provided. Ask the agent for exact steps if the result is not self-evident.'}
          </p>
        </ReviewBlock>

        <details className="border border-[rgba(255,255,255,0.07)] bg-[#080808]">
          <summary className="cursor-pointer px-4 py-3 font-mono text-[10px] text-surface-400 uppercase tracking-wider">
            Full Deliverable
          </summary>
          <div className="border-t border-[rgba(255,255,255,0.06)] p-4">
            <pre className="font-mono text-xs leading-6 text-surface-300 whitespace-pre-wrap break-words max-h-[520px] overflow-auto">
              {bounty.deliverableContent}
            </pre>
            {bounty.deliverableHash && (
              <div className="font-mono text-[9px] text-surface-500 mt-4 break-all">
                Proof hash: {bounty.deliverableHash}
              </div>
            )}
          </div>
        </details>

        {isReviewable && (
          <div className="border-t border-[rgba(255,255,255,0.08)] pt-6">
            <label className="font-mono text-[10px] text-surface-500 uppercase tracking-wider block mb-2">
              Review Note
            </label>
            <textarea
              value={reviewReason}
              onChange={event => setReviewReason(event.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Optional for approval. Required when requesting changes; identify the criterion that failed and what must be corrected."
              className="input-field w-full font-mono text-xs resize-y"
            />
            <div className="flex flex-col sm:flex-row gap-2 mt-3">
              <button
                onClick={() => onReview('approved')}
                disabled={actionBusy}
                className="btn-primary text-xs disabled:opacity-40"
              >
                {actionBusy ? 'Processing...' : `Approve & Release ${bounty.escrowBudgetUsdc || bounty.amountUsdc} USDC`}
              </button>
              <button
                onClick={() => onReview('rejected')}
                disabled={actionBusy || !reviewReason.trim()}
                className="font-mono text-xs px-4 py-2 border border-red-500/30 text-red-400 hover:bg-red-500/10 disabled:opacity-40"
              >
                {bounty.revisionCount >= 1 ? 'Reject Revision & Open Dispute' : 'Request Revision'}
              </button>
              <button
                onClick={onRequestVerification}
                disabled={actionBusy || Boolean(bounty.verificationRequestedAt)}
                className="font-mono text-xs px-4 py-2 border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 disabled:opacity-40"
              >
                {bounty.verificationRequestedAt ? 'Independent Review Requested' : 'Request Independent Review'}
              </button>
            </div>
            {bounty.verificationRequestedAt && (
              <p className="font-mono text-[9px] text-cyan-400/80 mt-2">
                Requested {new Date(bounty.verificationRequestedAt).toLocaleString()}. Escrow remains locked.
              </p>
            )}
          </div>
        )}

        {isReleased && (
          <div className="border border-emerald-500/30 bg-emerald-500/5 p-4 font-mono text-xs text-emerald-400">
            Approved and paid{bounty.releaseTxHash ? ` · ${bounty.releaseTxHash}` : ''}
          </div>
        )}
        {isDisputed && (
          <div className="border border-red-500/30 bg-red-500/5 p-4 font-mono text-xs text-red-400">
            The revised submission is disputed. Escrow remains locked until platform arbitration.
          </div>
        )}
      </div>
    </section>
  );
}

function ReviewBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="font-mono text-[10px] text-surface-500 uppercase tracking-wider mb-2">{label}</div>
      {children}
    </div>
  );
}

function CheckMetric({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="bg-[#080808] p-3">
      <div className="font-mono text-[9px] text-surface-500 uppercase">{label}</div>
      <div className={`font-mono text-xs mt-1 ${ok ? 'text-emerald-400' : 'text-amber-400'}`}>{value}</div>
    </div>
  );
}

function EvidenceLinks({ links }: { links: string[] }) {
  const safeLinks = links.filter(isSafeExternalUrl);
  if (safeLinks.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {safeLinks.map(link => (
        <a
          key={link}
          href={link}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[10px] text-cyan-400 hover:underline break-all"
        >
          Open evidence ↗
        </a>
      ))}
    </div>
  );
}

function isSafeExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

// ── Inline proposal card ───────────────────────────────────

function ProposalCard({ p, compact }: { p: BountyProposal; compact?: boolean }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <div className="font-bold text-white text-sm">{p.agentName || 'Unknown Agent'}</div>
          {p.reputationScore !== undefined && <TierBadge score={p.reputationScore} size="xs" />}
          <span className="font-mono text-[10px] text-surface-500">{p.agentType}</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="font-mono text-lg font-bold text-[#ff8512]">${p.proposedPriceUsdc}</div>
            <div className="font-mono text-[9px] text-surface-500">{p.estimatedHours}h estimate</div>
          </div>
          <div className={`font-mono text-[10px] px-2 py-0.5 border ${
            p.status === 'accepted' ? 'border-emerald-500/40 text-emerald-400' :
            p.status === 'rejected' ? 'border-red-500/30 text-red-400' :
            p.status === 'withdrawn' ? 'border-[rgba(255,255,255,0.15)] text-surface-500' :
            'border-cyan-500/30 text-cyan-400'
          }`}>
            {p.status}
          </div>
        </div>
      </div>
      {!compact && p.rejectionReason && (
        <div className="font-mono text-[10px] text-red-400/70 mb-2">Reason: {p.rejectionReason}</div>
      )}
      <div className="text-sm text-surface-300 whitespace-pre-wrap break-words border-l-2 border-[rgba(255,255,255,0.06)] pl-3 mt-2">
        {p.plan}
      </div>
      {p.portfolioRefs && p.portfolioRefs.length > 0 && (
        <div className="mt-2 font-mono text-[10px] text-surface-500">
          Portfolio refs: {p.portfolioRefs.join(', ')}
        </div>
      )}
      <div className="font-mono text-[9px] text-surface-500 mt-2">
        Submitted {new Date(p.createdAt).toLocaleString()}
      </div>
    </div>
  );
}
