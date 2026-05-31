'use client';

import { useState, useEffect, useRef } from 'react';
import { fetchBountyMessages, sendBountyMessage, type BountyMessage } from '@/lib/store';

interface MessageThreadProps {
  bountyId: string;
  proposalId: string;
  currentWallet: string;
  currentAgentId?: string;
  /** Short label for the counterparty, e.g. agent name or "Creator" */
  counterpartyLabel?: string;
  /** Poll interval in ms (default 5000); pass 0 to disable polling */
  pollMs?: number;
}

export function MessageThread({
  bountyId,
  proposalId,
  currentWallet,
  currentAgentId,
  counterpartyLabel,
  pollMs = 5000,
}: MessageThreadProps) {
  const [messages, setMessages] = useState<BountyMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const me = (currentWallet || '').toLowerCase();

  async function load() {
    const { messages } = await fetchBountyMessages(bountyId, proposalId, currentWallet);
    setMessages(messages);
  }

  useEffect(() => {
    load();
    if (pollMs > 0) {
      const id = setInterval(load, pollMs);
      return () => clearInterval(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bountyId, proposalId, currentWallet, pollMs]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  async function handleSend() {
    if (!draft.trim()) return;
    if (draft.length > 4000) {
      setError('Message must be 4000 characters or less');
      return;
    }
    setSending(true);
    setError(null);
    const ok = await sendBountyMessage(bountyId, {
      proposalId,
      message: draft.trim(),
      callerWallet: currentWallet,
      callerAgentId: currentAgentId,
    });
    if (ok) {
      setDraft('');
      await load();
    } else {
      setError('Failed to send message');
    }
    setSending(false);
  }

  return (
    <div className="flex flex-col h-full border border-[rgba(255,255,255,0.08)] bg-[#0a0a0a]">
      <div className="px-4 py-3 border-b border-[rgba(255,255,255,0.06)] flex items-center justify-between">
        <div>
          <div className="font-mono text-[10px] text-surface-500 uppercase tracking-wider">Thread</div>
          {counterpartyLabel && (
            <div className="font-mono text-xs text-white mt-0.5">{counterpartyLabel}</div>
          )}
        </div>
        <button onClick={load} className="font-mono text-[10px] text-surface-500 hover:text-white">Refresh</button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[200px] max-h-[400px]">
        {messages.length === 0 && (
          <div className="text-center text-surface-500 font-mono text-xs py-8">
            No messages yet — start the conversation.
          </div>
        )}
        {messages.map((m) => {
          const fromMe = (m.fromWallet || '').toLowerCase() === me;
          return (
            <div key={m.id} className={`flex ${fromMe ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] px-3 py-2 ${
                fromMe
                  ? 'bg-[rgba(255,133,18,0.1)] border border-[rgba(255,133,18,0.25)]'
                  : 'bg-[#0c0c0c] border border-[rgba(255,255,255,0.08)]'
              }`}>
                <div className="font-mono text-[9px] text-surface-500 uppercase tracking-wider mb-1">
                  {fromMe ? 'You' : (m.fromAgentName || `${(m.fromWallet || '').slice(0, 6)}…${(m.fromWallet || '').slice(-4)}`)}
                  <span className="ml-2 opacity-60 normal-case">{new Date(m.createdAt).toLocaleString()}</span>
                </div>
                <div className="text-sm text-white whitespace-pre-wrap break-words">{m.message}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="p-3 border-t border-[rgba(255,255,255,0.06)]">
        {error && <div className="text-red-400 font-mono text-[10px] mb-2">{error}</div>}
        <div className="flex gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Type your message… (Cmd/Ctrl+Enter to send)"
            rows={2}
            maxLength={4000}
            className="input-field flex-1 font-mono text-sm resize-none"
          />
          <button
            onClick={handleSend}
            disabled={sending || !draft.trim()}
            className="btn-primary text-xs px-4 disabled:opacity-40 self-end"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
        <div className="font-mono text-[9px] text-surface-500 mt-1 text-right">
          {draft.length}/4000
        </div>
      </div>
    </div>
  );
}
