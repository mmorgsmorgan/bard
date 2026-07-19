'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { BardLogo } from '@/components/BardLogo';
import { useBardAccount } from '@/components/BardAccountProvider';
import { fetchProfileByUsername, type StoredProfile } from '@/lib/store';
import { Headline } from '@/components/Editorial';

type WalletBalance = {
  address: string;
  balanceUsdc: string;
  nativeGasBalanceWei: string;
  explorer: string;
};

export default function SendPage() {
  const searchParams = useSearchParams();
  const prefillTo = searchParams.get('to') || '';

  const { address, isConnected, status, login, authFetch } = useBardAccount();
  const [recipient, setRecipient] = useState(prefillTo);
  const [recipientProfile, setRecipientProfile] = useState<StoredProfile | null>(null);
  const [resolving, setResolving] = useState(false);
  const [walletBalance, setWalletBalance] = useState<WalletBalance | null>(null);
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<'input' | 'confirm' | 'sending' | 'done' | 'error'>('input');
  const [error, setError] = useState('');
  const [txHash, setTxHash] = useState('');
  const [explorer, setExplorer] = useState('');

  useEffect(() => {
    const clean = recipient.replace('@', '');
    if (clean.length < 3) {
      setRecipientProfile(null);
      setResolving(false);
      return;
    }
    let cancelled = false;
    setResolving(true);
    const timer = window.setTimeout(() => {
      fetchProfileByUsername(clean)
        .then((profile) => {
          if (!cancelled) setRecipientProfile(profile);
        })
        .finally(() => {
          if (!cancelled) setResolving(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [recipient]);

  useEffect(() => {
    if (!isConnected) {
      setWalletBalance(null);
      return;
    }
    let cancelled = false;
    authFetch('/api/human/wallet')
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load wallet balance');
        if (!cancelled) setWalletBalance(data);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [isConnected, authFetch]);

  const resolvedWallet = recipientProfile?.wallet || null;
  const cleanUsername = recipient.replace('@', '');
  const amountNum = parseFloat(amount) || 0;
  const balanceNum = Number(walletBalance?.balanceUsdc || 0);
  const isSending = step === 'sending';
  const canSend = Boolean(
    resolvedWallet &&
    address &&
    resolvedWallet.toLowerCase() !== address.toLowerCase() &&
    amountNum > 0 &&
    amountNum <= balanceNum &&
    !isSending
  );

  async function handleSend() {
    if (!resolvedWallet || !amount) return;
    setStep('sending');
    setError('');
    try {
      const response = await authFetch('/api/human/send-usdc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: resolvedWallet, amount }),
      });
      const data = await response.json() as {
        txHash?: string;
        explorer?: string;
        error?: string;
      };
      if (!response.ok || !data.txHash) {
        throw new Error(data.error || 'Transfer failed');
      }
      setTxHash(data.txHash);
      setExplorer(data.explorer || '');
      setStep('done');
      const balanceResponse = await authFetch('/api/human/wallet');
      if (balanceResponse.ok) {
        setWalletBalance(await balanceResponse.json());
      }
    } catch (cause) {
      setStep('error');
      setError(cause instanceof Error ? cause.message.slice(0, 180) : 'Transfer failed');
    }
  }

  function reset() {
    setStep('input');
    setRecipient('');
    setAmount('');
    setError('');
    setTxHash('');
    setExplorer('');
  }

  if (status === 'connecting') {
    return <div className="min-h-screen" />;
  }

  if (!isConnected) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-10 max-w-md w-full text-center">
          <BardLogo size={48} className="mx-auto mb-4" />
          <p className="text-surface-400 font-mono text-sm mb-5">Sign in to send from your BARD-managed wallet</p>
          <button onClick={login} className="btn-primary w-full text-xs py-3">Continue with email or wallet</button>
        </div>
      </div>
    );
  }

  // ── Done state ──
  if (step === 'done') {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-10 max-w-md w-full text-center animate-fade-in">
          <div className="w-12 h-12 bg-[#ff8512] flex items-center justify-center mx-auto mb-6 text-[#050505] font-mono font-bold text-lg">✓</div>
          <h2 className="text-2xl font-bold text-white mb-3">Sent!</h2>
          <p className="text-surface-400 text-sm mb-2">{amount} USDC → @{cleanUsername}</p>
          {txHash && (
            <a href={explorer || `https://testnet.arcscan.app/tx/${txHash}`} target="_blank" rel="noreferrer"
              className="font-mono text-xs text-surface-500 hover:text-[#ff8512] underline mb-8 block">
              View transaction ↗
            </a>
          )}
          <button onClick={reset} className="btn-primary w-full text-xs py-3">Send More</button>
        </div>
      </div>
    );
  }

  // ── Error state ──
  if (step === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-10 max-w-md w-full text-center animate-fade-in">
          <div className="w-12 h-12 bg-red-500/20 border border-red-500/30 flex items-center justify-center mx-auto mb-6 text-red-400 font-mono font-bold text-lg">✗</div>
          <h2 className="text-xl font-bold text-white mb-3">Transfer Failed</h2>
          <p className="text-surface-400 text-xs mb-6 font-mono break-all">{error}</p>
          <button onClick={() => setStep('input')} className="btn-primary w-full text-xs py-3">Try Again</button>
        </div>
      </div>
    );
  }

  // ── Sending state ──
  if (step === 'sending') {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="auth-gate-card border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-10 max-w-md w-full text-center animate-fade-in">
          <div className="w-12 h-12 border border-[#ff8512] flex items-center justify-center mx-auto mb-6 animate-pulse">
            <div className="w-3 h-3 bg-[#ff8512]" />
          </div>
          <h2 className="text-xl font-bold text-white mb-3 font-mono">
            Sending...
          </h2>
          <p className="text-surface-400 text-sm">{amount} USDC → @{cleanUsername}</p>
        </div>
      </div>
    );
  }

  // ── Confirm state ──
  if (step === 'confirm') {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-10 max-w-md w-full animate-fade-in">
          <h2 className="text-xl font-bold text-white mb-6 text-center">Confirm Transfer</h2>

          <div className="border border-[rgba(255,255,255,0.06)] bg-[#050505] p-5 mb-6">
            <div className="flex items-center justify-between mb-4">
              <span className="label-mono">To</span>
              <span className="font-mono text-sm text-[#ff8512]">@{cleanUsername}</span>
            </div>
            <div className="flex items-center justify-between mb-4">
              <span className="label-mono">Wallet</span>
              <span className="font-mono text-xs text-surface-400">{resolvedWallet?.slice(0, 8)}...{resolvedWallet?.slice(-6)}</span>
            </div>
            {recipientProfile?.displayName && (
              <div className="flex items-center justify-between mb-4">
                <span className="label-mono">Name</span>
                <span className="text-sm text-white">{recipientProfile.displayName}</span>
              </div>
            )}
            <div className="h-px bg-[rgba(255,255,255,0.06)] my-4" />
            <div className="flex items-center justify-between">
              <span className="label-mono">Amount</span>
              <span className="font-mono text-lg text-white font-bold">{amount} <span className="text-surface-500 text-sm">USDC</span></span>
            </div>
          </div>

          <div className="flex gap-3">
            <button onClick={() => setStep('input')} className="btn-secondary flex-1 text-xs py-3">Back</button>
            <button onClick={handleSend} className="btn-primary flex-1 text-xs py-3">Send USDC</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Input state ──
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-8 max-w-md w-full animate-fade-in">
        <div className="flex items-center gap-3 mb-8">
          <BardLogo size={28} />
          <Headline size="1.6rem">Send USDC</Headline>
        </div>

        {/* Recipient */}
        <span className="label-mono block mb-2">Recipient</span>
        <input
          type="text"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
          placeholder="username"
          className="input-field font-mono mb-2"
          maxLength={32}
        />
        {recipient.length >= 3 && resolving && (
          <p className="text-surface-500 font-mono text-xs mb-4">Resolving...</p>
        )}
        {recipient.length >= 3 && !resolving && resolvedWallet && (
          <div className="flex items-center gap-2 mb-4">
            <div className="w-1.5 h-1.5 bg-emerald-500" />
            <span className="font-mono text-xs text-emerald-500">
              {resolvedWallet.slice(0, 6)}...{resolvedWallet.slice(-4)}
            </span>
            {recipientProfile?.displayName && (
              <span className="text-xs text-surface-400">· {recipientProfile.displayName}</span>
            )}
          </div>
        )}
        {recipient.length >= 3 && !resolving && !resolvedWallet && (
          <p className="text-red-400 font-mono text-xs mb-4">Profile not found</p>
        )}

        {/* Amount */}
        <span className="label-mono block mb-2 mt-4">Amount (USDC)</span>
        <div className="relative mb-2">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="input-field font-mono"
            min="0"
            step="0.01"
          />
        </div>
        <div className="flex items-center justify-between mb-6">
          <span className="text-xs text-surface-500 font-mono">
            Balance: {balanceNum.toFixed(2)} USDC
          </span>
          {balanceNum > 0 && (
            <button
              onClick={() => setAmount(balanceNum.toFixed(6).replace(/\.?0+$/, ''))}
              className="text-xs text-[#ff8512] font-mono hover:underline"
            >
              MAX
            </button>
          )}
        </div>

        {amountNum > balanceNum && amountNum > 0 && (
          <p className="text-red-400 font-mono text-xs mb-4">Insufficient balance</p>
        )}

        <button
          onClick={() => setStep('confirm')}
          disabled={!canSend}
          className="btn-primary w-full text-xs py-3.5"
        >
          Review Transfer
        </button>
      </div>
    </div>
  );
}
