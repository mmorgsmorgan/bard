'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export function LinkedAgentStatus({ ownerWallet }: { ownerWallet: string }) {
  const [agents, setAgents] = useState<{ id: string; agentName: string; reputationScore: number; status: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ownerWallet) { setLoading(false); return; }
    fetch(`${API}/api/agents/owner/${ownerWallet}`)
      .then(r => r.json())
      .then(d => setAgents(d.agents || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [ownerWallet]);

  if (loading) return null;

  if (agents.length === 0) {
    return (
      <div className="border border-[rgba(168,85,247,0.12)] bg-[rgba(168,85,247,0.02)] p-4 mt-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="font-mono text-xs text-purple-400">⬡</span>
          <span className="font-mono text-[10px] text-surface-400 uppercase tracking-wider">No Linked Agents</span>
        </div>
        <p className="font-mono text-[10px] text-surface-500 leading-relaxed">
          Link an AI agent to your profile to enable ERC-8004 identity minting.
          Go to <Link href="/agents" className="text-[#ff8512] hover:underline">Agents → MCP Setup</Link> to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="border border-[rgba(168,85,247,0.15)] bg-[rgba(168,85,247,0.03)] p-4 mt-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="font-mono text-xs text-purple-400">⬡</span>
        <span className="font-mono text-[10px] text-white uppercase tracking-wider">
          Linked Agent{agents.length > 1 ? 's' : ''} ({agents.length})
        </span>
      </div>
      <div className="space-y-2">
        {agents.map(a => (
          <Link
            key={a.id}
            href={`/agents/${a.id}`}
            className="flex items-center justify-between p-3 bg-[rgba(168,85,247,0.04)] border border-[rgba(168,85,247,0.1)] hover:border-[rgba(168,85,247,0.3)] hover:bg-[rgba(168,85,247,0.08)] transition-all cursor-pointer group"
          >
            <div className="flex items-center gap-3">
              <span className="w-7 h-7 flex items-center justify-center bg-[rgba(168,85,247,0.1)] border border-[rgba(168,85,247,0.2)] font-mono text-purple-400 text-[10px] font-bold group-hover:bg-[rgba(168,85,247,0.2)] transition-colors">
                {a.agentName?.charAt(0)?.toUpperCase() || '?'}
              </span>
              <div>
                <div className="font-mono text-xs text-white group-hover:text-purple-300 transition-colors">{a.agentName}</div>
                <div className="font-mono text-[9px] text-surface-500">{a.id}</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[9px] text-purple-400">rep: {a.reputationScore}</span>
                <span className="font-mono text-[9px] text-green-400">● {a.status}</span>
              </div>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-surface-600 group-hover:text-purple-400 transition-colors">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </div>
          </Link>
        ))}
      </div>
      <p className="font-mono text-[9px] text-surface-500 mt-2">
        Agents mint ERC-8004 identity on your behalf via MCP.
      </p>
    </div>
  );
}
