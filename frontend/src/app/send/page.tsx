'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt, useBalance } from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import { CONTRACTS } from '@/lib/config';
import { BARD_PROFILE_ABI, ERC20_ABI } from '@/lib/abi';
import { BardLogo } from '@/components/BardLogo';
import { addNotification, getProfileByWallet } from '@/lib/store';

type ProfileData = {
  wallet: `0x${string}`;
  username: string;
  metadataURI: string;
  profileType: number;
  createdAt: bigint;
  exists: boolean;
};

export default function SendPage() {
  const searchParams = useSearchParams();
  const prefillTo = searchParams.get('to') || '';

  const { address, isConnected } = useAccount();
  const [recipient, setRecipient] = useState(prefillTo);
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<'input' | 'confirm' | 'sending' | 'done' | 'error'>('input');
  const [error, setError] = useState('');

  // Resolve username to wallet
  const { data: recipientProfile, isLoading: resolving } = useReadContract({
    address: CONTRACTS.BARD_PROFILE,
    abi: BARD_PROFILE_ABI,
    functionName: 'getProfileByUsername',
    args: [recipient.replace('@', '')],
    query: { enabled: recipient.length >= 3 },
  }) as { data: ProfileData | undefined; isLoading: boolean };

  // Get USDC balance
  const { data: usdcBalance } = useBalance({
    address,
    token: CONTRACTS.USDC,
  });

  // Native balance (gas)
  const { data: nativeBalance } = useBalance({ address });

  // Send tx
  const { writeContract, data: txHash, error: txError, isPending } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  // Parse metadata for display name
  const [recipientMeta, setRecipientMeta] = useState<{ displayName?: string; profileType?: string }>({});
  useEffect(() => {
    if (recipientProfile?.metadataURI) {
      try {
        const uri = recipientProfile.metadataURI;
        if (uri.startsWith('data:application/json,')) {
          const json = JSON.parse(decodeURIComponent(uri.replace('data:application/json,', '')));
          setRecipientMeta({ displayName: json.display_name || json.username, profileType: json.profile_type });
        }
      } catch { /* ignore */ }
    }
  }, [recipientProfile]);

  // Track tx state
  useEffect(() => {
    if (isPending || confirming) setStep('sending');
    if (isSuccess) {
      setStep('done');
      // Look up sender's username
      const senderProfile = address ? getProfileByWallet(address) : null;
      const senderName = senderProfile?.username ? `@${senderProfile.username}` : `${address?.slice(0, 6)}...${address?.slice(-4)}`;
      // Notify recipient
      if (resolvedWallet) {
        addNotification({
          wallet: resolvedWallet,
          type: 'send',
          title: 'USDC Received',
          message: `${amount} USDC from ${senderName}`,
          from: address || '',
          amount,
        });
      }
      // Notify sender
      if (address) {
        addNotification({
          wallet: address,
          type: 'send',
          title: 'USDC Sent',
          message: `${amount} USDC to @${cleanUsername}`,
          from: address,
          amount,
        });
      }
    }
    if (txError) { setStep('error'); setError(txError.message.slice(0, 120)); }
  }, [isPending, confirming, isSuccess, txError]);

  const resolvedWallet = recipientProfile?.exists ? recipientProfile.wallet : null;
  const cleanUsername = recipient.replace('@', '');
  const amountNum = parseFloat(amount) || 0;
  const balanceNum = usdcBalance ? parseFloat(formatUnits(usdcBalance.value, usdcBalance.decimals)) : 0;
  const canSend = resolvedWallet && amountNum > 0 && amountNum <= balanceNum && !isPending;

  function handleSend() {
    if (!resolvedWallet || !amount) return;
    writeContract({
      address: CONTRACTS.USDC,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [resolvedWallet, parseUnits(amount, 6)],
    });
  }

  function reset() {
    setStep('input');
    setRecipient('');
    setAmount('');
    setError('');
  }

  if (!isConnected) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-10 max-w-md w-full text-center">
          <BardLogo size={48} className="mx-auto mb-4" />
          <p className="text-surface-400 font-mono text-sm">Connect your wallet to send USDC</p>
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
            <a href={`https://explorer.testnet.arc.network/tx/${txHash}`} target="_blank" rel="noreferrer"
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
            {confirming ? 'Confirming...' : 'Sending...'}
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
            {recipientMeta.displayName && (
              <div className="flex items-center justify-between mb-4">
                <span className="label-mono">Name</span>
                <span className="text-sm text-white">{recipientMeta.displayName}</span>
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
          <h1 className="text-xl font-bold text-white">Send USDC</h1>
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
            {recipientMeta.displayName && (
              <span className="text-xs text-surface-400">· {recipientMeta.displayName}</span>
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
              onClick={() => setAmount(balanceNum.toFixed(2))}
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
