'use client';

import { useEffect, useState } from 'react';

// On-chain escrow status panel. Reads the enriched GET /api/bounties/:id/escrow
// (which returns an `onchain` block for contract-escrowed bounties) and renders a
// compact, verifiable view: job id, ArcScan tx links, platform fee, and lifecycle
// status. Renders nothing for custodial/unfunded bounties.

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

type OnchainEscrow = {
  mode: 'onchain';
  jobId: string;
  status: string;
  budgetUsdc: number;
  feeBps: number;
  platformFeeUsdc: number;
  contract: string | null;
  fundTx: string | null;
  releaseTx: string | null;
  explorer: { contract: string | null; fund: string | null; release: string | null };
};

const STATUS_STYLE: Record<string, string> = {
  funded: 'border-cyan-500/30 text-cyan-400',
  claimed: 'border-cyan-500/30 text-cyan-400',
  submitted: 'border-amber-500/30 text-amber-400',
  released: 'border-emerald-500/40 text-emerald-400',
  refunded: 'border-red-500/30 text-red-400',
  expired: 'border-red-500/30 text-red-400',
};

function short(h: string) {
  return `${h.slice(0, 10)}…${h.slice(-8)}`;
}

export function EscrowPanel({ bountyId }: { bountyId: string }) {
  const [onchain, setOnchain] = useState<OnchainEscrow | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API}/api/bounties/${bountyId}/escrow`);
        const data = await res.json();
        if (!cancelled) setOnchain(res.ok ? data.onchain || null : null);
      } catch {
        if (!cancelled) setOnchain(null);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [bountyId]);

  if (!loaded || !onchain) return null;

  const statusPill = STATUS_STYLE[onchain.status] || 'border-[rgba(255,255,255,0.15)] text-surface-400';

  return (
    <div className="border border-[rgba(255,255,255,0.08)] bg-[#0a0a0a] p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="font-mono text-[10px] text-surface-500 uppercase tracking-wider">On-Chain Escrow</div>
          <span className="font-mono text-[9px] px-2 py-0.5 border border-[#ff8512]/40 text-[#ff8512]">ERC-8183</span>
        </div>
        <span className={`font-mono text-[10px] px-2 py-0.5 border ${statusPill}`}>{onchain.status}</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
        <Field label="Job ID">
          {onchain.explorer.contract ? (
            <a href={onchain.explorer.contract} target="_blank" rel="noreferrer"
              className="text-[#ff8512] hover:underline">#{onchain.jobId}</a>
          ) : <span className="text-white">#{onchain.jobId}</span>}
        </Field>
        <Field label="Budget"><span className="text-white">${onchain.budgetUsdc} USDC</span></Field>
        <Field label={`Platform Fee (${(onchain.feeBps / 100).toFixed(2)}%)`}>
          <span className="text-white">{onchain.platformFeeUsdc > 0 ? `$${onchain.platformFeeUsdc} USDC` : 'None'}</span>
        </Field>
        <Field label="Custody"><span className="text-surface-300">In contract</span></Field>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-[10px] text-surface-500">
        {onchain.explorer.fund && (
          <a href={onchain.explorer.fund} target="_blank" rel="noreferrer" className="hover:text-white">
            Fund tx: <span className="text-cyan-400">{short(onchain.fundTx!)}</span> ↗
          </a>
        )}
        {onchain.explorer.release && (
          <a href={onchain.explorer.release} target="_blank" rel="noreferrer" className="hover:text-white">
            Release tx: <span className="text-emerald-400">{short(onchain.releaseTx!)}</span> ↗
          </a>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="font-mono text-[9px] text-surface-500 uppercase tracking-wider mb-1">{label}</div>
      <div className="font-mono text-sm">{children}</div>
    </div>
  );
}
