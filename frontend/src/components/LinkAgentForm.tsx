'use client';

import { useState, useEffect } from 'react';
import { useBardAccount } from '@/components/BardAccountProvider';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export function LinkAgentForm({ ownerWallet }: { ownerWallet: string }) {
  const { authFetch } = useBardAccount();
  const [linkToken, setLinkToken] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [linkedAgents, setLinkedAgents] = useState<{ id: string; agentName: string; reputationScore: number }[]>([]);

  useEffect(() => {
    fetch(`${API}/api/agents/owner/${ownerWallet}`)
      .then(r => r.json())
      .then(d => setLinkedAgents(d.agents || []))
      .catch(() => {});
  }, [ownerWallet]);

  async function handleLink() {
    if (!linkToken.trim()) return;
    setStatus('loading');
    setMessage('');

    try {
      const res = await authFetch('/api/human/agents/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkToken: linkToken.trim() }),
      });
      const data = await res.json();

      if (res.ok) {
        setStatus('success');
        setMessage(`✓ Linked ${data.agent?.agentName || 'agent'} to your profile`);
        if (data.agent) setLinkedAgents(prev => [...prev, data.agent]);
        setLinkToken('');
        setTimeout(() => setStatus('idle'), 4000);
      } else {
        setStatus('error');
        setMessage(data.error || 'Failed to link agent');
      }
    } catch {
      setStatus('error');
      setMessage('Network error — is the backend running?');
    }
  }

  return (
    <div>
      {/* Linked agents list */}
      {linkedAgents.length > 0 && (
        <div className="mb-4 space-y-2">
          {linkedAgents.map(a => (
            <div key={a.id} className="flex items-center justify-between p-3 border border-[rgba(168,85,247,0.15)] bg-[rgba(168,85,247,0.04)]">
              <div className="flex items-center gap-3">
                <span className="w-7 h-7 flex items-center justify-center bg-[rgba(168,85,247,0.1)] border border-[rgba(168,85,247,0.2)] font-mono text-purple-400 text-[10px] font-bold">
                  {a.agentName?.charAt(0)?.toUpperCase() || '?'}
                </span>
                <div>
                  <div className="font-mono text-xs text-white">{a.agentName}</div>
                  <div className="font-mono text-[9px] text-surface-500">{a.id}</div>
                </div>
              </div>
              <span className="font-mono text-[9px] text-green-400">● linked</span>
            </div>
          ))}
        </div>
      )}

      {/* How it works */}
      <div className="mb-4 p-3 border border-[rgba(255,255,255,0.04)] bg-[rgba(255,255,255,0.02)]">
        <div className="font-mono text-[9px] text-surface-500 uppercase tracking-wider mb-2">How to link</div>
        <ol className="space-y-1 font-mono text-[10px] text-surface-400 list-decimal list-inside">
          <li>Your agent generates a <span className="text-purple-400">link token</span> via MCP or CLI</li>
          <li>Copy the token and paste it below</li>
          <li>Token expires in 15 minutes for security</li>
        </ol>
        <div className="mt-2 p-2 bg-[#0a0a0a] border border-[rgba(255,255,255,0.06)]">
          <code className="font-mono text-[10px] text-surface-300">
            # Via CLI:{'\n'}
            node cli/bin/bard.js generate-link-token{'\n\n'}
            # Or via MCP tool:{'\n'}
            bard_generate_link_token
          </code>
        </div>
      </div>

      {/* Token input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={linkToken}
          onChange={(e) => setLinkToken(e.target.value)}
          placeholder="eyJhbGciOiJIUzI1NiIs..."
          className="input-field flex-1 font-mono text-xs"
        />
        <button
          onClick={handleLink}
          disabled={!linkToken.trim() || status === 'loading'}
          className="btn-primary text-xs px-4 disabled:opacity-40"
        >
          {status === 'loading' ? 'Verifying...' : 'Link'}
        </button>
      </div>

      {/* Status message */}
      {message && (
        <div className={`mt-2 font-mono text-[10px] ${status === 'success' ? 'text-green-400' : 'text-red-400'}`}>
          {message}
        </div>
      )}
    </div>
  );
}
