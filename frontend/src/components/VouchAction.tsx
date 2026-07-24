'use client';

import { useState } from 'react';
import { VOUCH_TIERS } from '@/lib/config';
import { useBardAccount } from '@/components/BardAccountProvider';

interface VouchActionProps {
  contributorAgentId: string;
  contributorName: string;
  disabledReason?: string;
}

type VouchResponse = {
  explorer?: string;
  error?: string;
  signatureRequired?: boolean;
  stage?: 'approve' | 'vouch';
  approveTxHash?: string;
  transaction?: Parameters<ReturnType<typeof useBardAccount>['sendTransaction']>[0];
};

export function VouchAction({
  contributorAgentId,
  contributorName,
  disabledReason,
}: VouchActionProps) {
  const {
    isConnected,
    authReady,
    status,
    login,
    authFetch,
    sendTransaction,
  } = useBardAccount();
  const [open, setOpen] = useState(false);
  const [tier, setTier] = useState(0);
  const [amount, setAmount] = useState('1');
  const [statement, setStatement] = useState('');
  const [ecosystem, setEcosystem] = useState('');
  const [score, setScore] = useState('80');
  const [step, setStep] = useState<'form' | 'vouching' | 'done' | 'error'>('form');
  const [error, setError] = useState('');
  const [explorer, setExplorer] = useState('');
  const [approveTxHash, setApproveTxHash] = useState('');
  const [vouchTxHash, setVouchTxHash] = useState('');

  const hasPendingVouch = Boolean(approveTxHash || vouchTxHash);

  function close() {
    setOpen(false);
    if (step !== 'vouching') setStep('form');
  }

  async function handleVouch() {
    const amountNumber = Number(amount);
    const scoreNumber = Number(score);
    if (!Number.isFinite(amountNumber) || amountNumber < VOUCH_TIERS[tier].minUSDC) {
      setStep('error');
      setError(`Tier minimum is ${VOUCH_TIERS[tier].minUSDC} USDC`);
      return;
    }
    if (!Number.isInteger(scoreNumber) || scoreNumber < 0 || scoreNumber > 100) {
      setStep('error');
      setError('Score must be an integer between 0 and 100');
      return;
    }

    setStep('vouching');
    setError('');
    const input = {
      contributorAgentId,
      amount,
      tier,
      statement,
      ecosystem,
      score: scoreNumber,
    };

    try {
      let response = await authFetch('/api/human/vouches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...input,
          ...(approveTxHash ? { approveTxHash } : {}),
          ...(vouchTxHash ? { vouchTxHash } : {}),
        }),
      });
      let data = await response.json() as VouchResponse;
      let confirmedApproveTxHash = approveTxHash;

      if (
        response.status === 202 &&
        data.signatureRequired &&
        data.stage === 'approve' &&
        data.transaction
      ) {
        confirmedApproveTxHash = await sendTransaction(data.transaction);
        setApproveTxHash(confirmedApproveTxHash);
        response = await authFetch('/api/human/vouches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...input, approveTxHash: confirmedApproveTxHash }),
        });
        data = await response.json() as VouchResponse;
      }

      if (
        response.status === 202 &&
        data.signatureRequired &&
        data.stage === 'vouch' &&
        data.transaction
      ) {
        confirmedApproveTxHash = data.approveTxHash || confirmedApproveTxHash;
        const confirmedVouchTxHash = await sendTransaction(data.transaction);
        setVouchTxHash(confirmedVouchTxHash);
        response = await authFetch('/api/human/vouches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...input,
            approveTxHash: confirmedApproveTxHash,
            vouchTxHash: confirmedVouchTxHash,
          }),
        });
        data = await response.json() as VouchResponse;
      }

      if (!response.ok) throw new Error(data.error || 'Vouch failed');
      setExplorer(data.explorer || '');
      setApproveTxHash('');
      setVouchTxHash('');
      setStep('done');
    } catch (cause) {
      setStep('error');
      setError(cause instanceof Error ? cause.message.slice(0, 180) : 'Vouch failed');
    }
  }

  if (disabledReason) {
    return (
      <div className="font-mono text-[10px] text-surface-600">
        {disabledReason}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={!authReady || status === 'connecting'}
        onClick={() => isConnected ? setOpen(true) : login()}
        className="btn-primary text-xs px-5 py-2.5 disabled:opacity-40"
      >
        {isConnected ? `Vouch for ${contributorName}` : 'Log in to vouch'}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/75" onClick={close} />
          <div className="relative z-10 w-full max-w-lg border border-[rgba(255,255,255,0.08)] bg-[#0c0c0c] p-8 animate-slide-up">
            {step === 'done' ? (
              <div className="text-center">
                <div className="mx-auto mb-6 flex h-12 w-12 items-center justify-center bg-[#ff8512] font-mono font-bold text-[#050505]">
                  &#10003;
                </div>
                <h2 className="mb-3 text-xl font-bold text-white">Vouch Confirmed</h2>
                <p className="mb-6 text-sm text-surface-400">
                  {amount} USDC is now staked for {contributorName}.
                </p>
                {explorer && (
                  <a
                    href={explorer}
                    target="_blank"
                    rel="noreferrer"
                    className="mb-6 block font-mono text-xs text-surface-500 underline hover:text-[#ff8512]"
                  >
                    View transaction ↗
                  </a>
                )}
                <button type="button" onClick={close} className="btn-primary text-xs">Close</button>
              </div>
            ) : (
              <>
                <h2 className="mb-2 text-xl font-bold text-white">Vouch for {contributorName}</h2>
                <p className="mb-6 font-mono text-[10px] text-surface-500">
                  Your USDC stake is locked on-chain for 30 days.
                </p>

                <span className="label-mono mb-3 block">Tier</span>
                <div className="mb-6 grid grid-cols-4 gap-px bg-[rgba(255,255,255,0.06)]">
                  {VOUCH_TIERS.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      disabled={hasPendingVouch}
                      onClick={() => {
                        setTier(item.id);
                        setAmount(String(item.minUSDC));
                      }}
                      className={`p-3 text-center transition-all ${tier === item.id ? 'border-b-2 border-[#ff8512] bg-[rgba(255,133,18,0.1)]' : 'bg-[#050505] hover:bg-[#111]'}`}
                    >
                      <div className="font-mono text-xs font-bold text-white">{item.name}</div>
                      <div className="font-mono text-[10px] text-surface-500">{item.minUSDC}+</div>
                    </button>
                  ))}
                </div>

                <div className="space-y-5">
                  <div>
                    <span className="label-mono mb-2 block">Stake (USDC)</span>
                    <input
                      disabled={hasPendingVouch}
                      type="number"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      min={VOUCH_TIERS[tier].minUSDC}
                      className="input-field font-mono"
                    />
                  </div>
                  <div>
                    <span className="label-mono mb-2 block">Statement</span>
                    <textarea
                      disabled={hasPendingVouch}
                      value={statement}
                      onChange={(event) => setStatement(event.target.value)}
                      placeholder="Why do you trust this agent's work?"
                      className="input-field"
                      rows={2}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <span className="label-mono mb-2 block">Ecosystem</span>
                      <input
                        disabled={hasPendingVouch}
                        value={ecosystem}
                        onChange={(event) => setEcosystem(event.target.value)}
                        placeholder="Arc"
                        className="input-field"
                      />
                    </div>
                    <div>
                      <span className="label-mono mb-2 block">Score</span>
                      <input
                        disabled={hasPendingVouch}
                        type="number"
                        value={score}
                        onChange={(event) => setScore(event.target.value)}
                        min="0"
                        max="100"
                        className="input-field font-mono"
                      />
                    </div>
                  </div>
                </div>

                {error && (
                  <div className="mt-4 border border-red-900/30 bg-red-900/20 p-3 font-mono text-xs text-red-400">
                    {error}
                  </div>
                )}
                {hasPendingVouch && (
                  <div className="mt-4 border border-[rgba(255,133,18,0.25)] bg-[rgba(255,133,18,0.05)] p-3 font-mono text-xs text-surface-400">
                    Resume the confirmed approval instead of creating another stake.
                  </div>
                )}

                <div className="mt-8 flex gap-3">
                  <button type="button" onClick={close} className="btn-secondary flex-1 text-xs">Cancel</button>
                  <button
                    type="button"
                    onClick={handleVouch}
                    disabled={!statement.trim() || !ecosystem.trim() || step === 'vouching'}
                    className="btn-primary flex-1 text-xs disabled:opacity-40"
                  >
                    {step === 'vouching' ? 'Confirming...' : hasPendingVouch ? 'Resume vouch' : `Vouch ${amount} USDC`}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
