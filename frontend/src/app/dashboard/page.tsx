'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { GitHubIcon, DiscordIcon, FarcasterIcon, XIcon } from '@/components/SocialIcons';
import { useReadContract } from 'wagmi';
import { formatUnits } from 'viem';
import { CONTRACTS } from '@/lib/config';
import { BARD_PROFILE_ABI } from '@/lib/abi';
import { fetchProfileByWallet, fetchProofsByWallet, fetchPortfolioByWallet, fetchNotificationsByWallet } from '@/lib/store';
import { PageHeader, Em } from '@/components/Editorial';
import { useBardAccount } from '@/components/BardAccountProvider';
import type { StoredProfile, StoredProof, PortfolioItem, Notification } from '@/lib/store';

type ManagedWalletBalance = {
  address: string;
  balanceUsdc: string;
  nativeGasBalanceWei: string;
  explorer: string;
};

export default function DashboardPage() {
  const { account, address, isConnected, status, login, authFetch } = useBardAccount();
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  const [proofs, setProofs] = useState<StoredProof[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioItem[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [walletBalance, setWalletBalance] = useState<ManagedWalletBalance | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [showKeyExport, setShowKeyExport] = useState(false);
  const [exportStage, setExportStage] = useState<'request' | 'code' | 'revealed'>('request');
  const [exportCode, setExportCode] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [exportError, setExportError] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);

  // On-chain data
  const { data: onChainProfile } = useReadContract({
    address: CONTRACTS.BARD_PROFILE,
    abi: BARD_PROFILE_ABI,
    functionName: 'getProfile',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const hasOnChain = onChainProfile && Array.isArray(onChainProfile) &&
    onChainProfile[0] !== '0x0000000000000000000000000000000000000000';

  useEffect(() => {
    if (!address || !isConnected) {
      setLoading(false);
      setWalletBalance(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    Promise.all([
      fetchProfileByWallet(address),
      fetchProofsByWallet(address),
      fetchPortfolioByWallet(address),
      fetchNotificationsByWallet(address),
      authFetch('/api/human/wallet').then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load managed wallet');
        return data as ManagedWalletBalance;
      }),
    ])
      .then(([p, pr, po, n, wallet]) => {
        if (cancelled) return;
        setProfile(p);
        setProofs(pr);
        setPortfolio(po);
        setNotifications(n);
        setWalletBalance(wallet);
      })
      .catch((cause) => {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address, isConnected, authFetch]);

  useEffect(() => {
    if (!showKeyExport) return;
    const root = document.documentElement;
    const body = document.body;
    const rootOverflow = root.style.overflow;
    const bodyOverflow = body.style.overflow;
    root.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    return () => {
      root.style.overflow = rootOverflow;
      body.style.overflow = bodyOverflow;
    };
  }, [showKeyExport]);

  useEffect(() => {
    setShowKeyExport(false);
    setExportStage('request');
    setExportCode('');
    setPrivateKey('');
    setExportError('');
    setExportBusy(false);
    setKeyCopied(false);
  }, [address]);

  function closeKeyExport() {
    setShowKeyExport(false);
    setExportStage('request');
    setExportCode('');
    setPrivateKey('');
    setExportError('');
    setExportBusy(false);
    setKeyCopied(false);
  }

  async function requestKeyExport() {
    setExportBusy(true);
    setExportError('');
    try {
      const response = await authFetch('/api/human/wallet/export-key/request', {
        method: 'POST',
      });
      const data = await response.json() as { sent?: boolean; devCode?: string; error?: string };
      if (!response.ok || !data.sent) {
        throw new Error(data.error || 'Could not send security code');
      }
      setExportCode(data.devCode || '');
      setExportStage('code');
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : 'Could not send security code');
    } finally {
      setExportBusy(false);
    }
  }

  async function verifyAndExportKey() {
    if (!/^\d{6}$/.test(exportCode)) {
      setExportError('Enter the 6-digit security code');
      return;
    }
    setExportBusy(true);
    setExportError('');
    try {
      const verifyResponse = await authFetch('/api/human/wallet/export-key/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: exportCode }),
      });
      const verifyData = await verifyResponse.json() as {
        elevatedToken?: string;
        error?: string;
      };
      if (!verifyResponse.ok || !verifyData.elevatedToken) {
        throw new Error(verifyData.error || 'Security-code verification failed');
      }

      const exportResponse = await authFetch('/api/human/wallet/export-key', {
        method: 'POST',
        headers: { 'X-Elevated-Token': verifyData.elevatedToken },
      });
      const exportData = await exportResponse.json() as {
        privateKey?: string;
        error?: string;
      };
      if (!exportResponse.ok || !exportData.privateKey) {
        throw new Error(exportData.error || 'Private-key export failed');
      }
      setPrivateKey(exportData.privateKey);
      setExportStage('revealed');
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : 'Private-key export failed');
    } finally {
      setExportBusy(false);
    }
  }

  async function copyPrivateKey() {
    if (!privateKey) return;
    try {
      await navigator.clipboard.writeText(privateKey);
      setKeyCopied(true);
      window.setTimeout(() => setKeyCopied(false), 2000);
    } catch {
      setExportError('Clipboard access was blocked. Select the key and copy it manually.');
    }
  }

  const validatedProofs = proofs.filter((p) => p.status === 'validated').length;
  const trustScore = Math.min(100, validatedProofs * 15 + proofs.length * 5 + portfolio.length * 3);
  const unread = notifications.filter((n) => !n.read).length;

  if (status === 'connecting') {
    return <div className="min-h-[80vh]" />;
  }

  if (!isConnected) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-24 text-center">
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-16 animate-fade-in">
          <div className="font-mono text-2xl text-surface-600 mb-6">⬡</div>
          <h1 className="text-xl font-bold text-white mb-3">Sign in to BARD</h1>
          <p className="text-surface-400 text-sm mb-5">Access your profile and BARD-managed wallet.</p>
          <button onClick={login} className="btn-primary text-xs px-6 py-3">Continue with email or wallet</button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-24 text-center">
        <div className="font-mono text-surface-500 animate-pulse-subtle text-sm">Loading dashboard...</div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-16">
      <PageHeader
        eyebrow="Dashboard"
        title={profile ? <>Welcome, <Em>{profile.displayName || profile.username}</Em></> : <>Your <Em>dashboard</Em></>}
        lede="Overview of your BARD profile, contributions, and trust metrics."
      />

      {loadError && (
        <div className="border border-red-900/30 bg-red-900/10 p-4 mb-6 font-mono text-xs text-red-400">
          {loadError}
        </div>
      )}

      {/* Status Banner */}
      {!hasOnChain && !profile && (
        <div className="border border-[rgba(255,133,18,0.3)] bg-[rgba(255,133,18,0.05)] p-5 mb-6 flex items-center justify-between">
          <div>
            <div className="font-mono text-sm text-[#ff8512] font-bold mb-1">Profile Not Created</div>
            <div className="text-surface-400 text-xs">Register your profile on Arc to start building trust.</div>
          </div>
          <Link href="/profile" className="btn-primary text-xs shrink-0">Create Profile</Link>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px mb-6">
        {[
          { label: 'Trust Score', value: trustScore, color: trustScore >= 40 ? 'text-[#ff8512]' : 'text-surface-400' },
          { label: 'Proofs', value: proofs.length, sub: validatedProofs > 0 ? `${validatedProofs} validated` : undefined },
          { label: 'Portfolio', value: portfolio.length },
          { label: 'Unread', value: unread, color: unread > 0 ? 'text-[#ff8512]' : 'text-surface-500' },
        ].map(({ label, value, color, sub }) => (
          <div key={label} className="bg-[#0c0c0c] border border-[rgba(255,255,255,0.04)] p-5 text-center">
            <div className={`font-mono text-2xl font-bold ${color || 'text-white'}`}>{value}</div>
            <div className="font-mono text-[10px] text-surface-500 tracking-wider uppercase mt-1">{label}</div>
            {sub && <div className="font-mono text-[9px] text-emerald-500 mt-0.5">✓ {sub}</div>}
          </div>
        ))}
      </div>

      {/* Wallet Info */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-px mb-6">
        <div className="bg-[#0c0c0c] border border-[rgba(255,255,255,0.04)] p-5">
          <div className="font-mono text-[10px] text-surface-500 tracking-wider uppercase mb-3">Wallet</div>
          <div className="font-mono text-sm text-surface-300 break-all">{address}</div>
          <div className="flex gap-4 mt-3">
            <div>
              <span className="font-mono text-[10px] text-surface-500">USDC</span>
              <span className="font-mono text-sm text-white ml-2">
                {Number(walletBalance?.balanceUsdc || 0).toFixed(2)}
              </span>
            </div>
            <div>
              <span className="font-mono text-[10px] text-surface-500">GAS USDC</span>
              <span className="font-mono text-sm text-white ml-2">
                {walletBalance ? Number(formatUnits(BigInt(walletBalance.nativeGasBalanceWei), 6)).toFixed(4) : '0.0000'}
              </span>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-[rgba(255,255,255,0.04)]">
            {account?.wallet.canExportPrivateKey ? (
              <button
                type="button"
                onClick={() => setShowKeyExport(true)}
                className="btn-secondary text-xs px-4 py-2"
              >
                Export private key
              </button>
            ) : (
              <p className="font-mono text-[10px] text-surface-600">
                Private-key export requires a verified email and a local BARD wallet.
              </p>
            )}
          </div>
        </div>
        <div className="bg-[#0c0c0c] border border-[rgba(255,255,255,0.04)] p-5">
          <div className="font-mono text-[10px] text-surface-500 tracking-wider uppercase mb-3">On-Chain Status</div>
          {hasOnChain ? (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-emerald-500" />
              <span className="font-mono text-sm text-emerald-400">Registered on Arc</span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-surface-600" />
              <span className="font-mono text-sm text-surface-500">Not registered</span>
            </div>
          )}
          {profile && (
            <div className="mt-2 font-mono text-[10px] text-surface-500">
              @{profile.username} · {profile.profileType} · {profile.ecosystems.join(', ') || 'no ecosystems'}
            </div>
          )}
          {profile && (
            <div className="flex gap-2 mt-3">
              {profile.farcaster && <span className="font-mono text-[9px] text-surface-400 px-1.5 py-0.5 border border-[rgba(255,255,255,0.06)] flex items-center gap-1"><FarcasterIcon className="w-2.5 h-2.5" /> {profile.farcaster}</span>}
              {profile.github && <span className="font-mono text-[9px] text-surface-400 px-1.5 py-0.5 border border-[rgba(255,255,255,0.06)] flex items-center gap-1"><GitHubIcon className="w-2.5 h-2.5" /> {profile.github}</span>}
              {profile.x && <span className="font-mono text-[9px] text-surface-400 px-1.5 py-0.5 border border-[rgba(255,255,255,0.06)] flex items-center gap-1"><XIcon className="w-2.5 h-2.5" /> {profile.x}</span>}
              {profile.discord && <span className="font-mono text-[9px] text-surface-400 px-1.5 py-0.5 border border-[rgba(255,255,255,0.06)] flex items-center gap-1"><DiscordIcon className="w-2.5 h-2.5" /> {profile.discord}</span>}
            </div>
          )}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px mb-6">
        {[
          { href: '/profile', label: 'Edit Profile', icon: '→' },
          { href: '/send', label: 'Send USDC', icon: '↗' },
          { href: '/leaderboard', label: 'Leaderboard', icon: '◆' },
          { href: profile ? `/u/${profile.username}` : '/profile', label: 'Public Profile', icon: '◎' },
        ].map(({ href, label, icon }) => (
          <Link key={label} href={href}
            className="bg-[#0c0c0c] border border-[rgba(255,255,255,0.04)] p-4 text-center hover:border-[rgba(255,133,18,0.3)] hover:bg-[rgba(255,133,18,0.02)] transition-all group">
            <div className="font-mono text-lg text-surface-500 group-hover:text-[#ff8512] transition-colors mb-1">{icon}</div>
            <div className="font-mono text-xs text-surface-400 group-hover:text-white transition-colors">{label}</div>
          </Link>
        ))}
      </div>

      {/* Recent Notifications */}
      <div className="bg-[#0c0c0c] border border-[rgba(255,255,255,0.04)] p-5">
        <div className="font-mono text-[10px] text-surface-500 tracking-wider uppercase mb-4">Recent Activity</div>
        {notifications.length === 0 ? (
          <div className="font-mono text-xs text-surface-500 text-center py-4">No activity yet</div>
        ) : (
          <div className="space-y-2">
            {notifications.slice(0, 5).map((n) => (
              <div key={n.id} className={`flex items-center gap-3 py-2 px-3 border-l-2 ${n.read ? 'border-l-transparent' : 'border-l-[#ff8512]'}`}>
                <span className="font-mono text-[10px] text-surface-500 shrink-0">
                  {new Date(n.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
                <span className="font-mono text-xs text-surface-300 truncate">{n.title || n.message}</span>
                {n.amount && <span className="font-mono text-[10px] text-[#ff8512] shrink-0">{n.amount} USDC</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {showKeyExport && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center p-4"
          role="presentation"
          onMouseDown={closeKeyExport}
        >
          <div className="absolute inset-0 bg-black/75" aria-hidden />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="key-export-title"
            data-lenis-prevent
            className="relative z-10 w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain border p-6 sm:p-8"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--rule)', boxShadow: 'var(--shadow)' }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-6 mb-6">
              <div>
                <h2 id="key-export-title" className="text-xl font-semibold text-white">
                  Export private key
                </h2>
                <p className="font-mono text-[10px] text-surface-500 mt-1">
                  BARD wallet {address?.slice(0, 8)}...{address?.slice(-6)}
                </p>
              </div>
              <button
                type="button"
                onClick={closeKeyExport}
                aria-label="Close private-key export"
                className="w-8 h-8 border border-[rgba(255,255,255,0.08)] text-surface-500 hover:text-white"
              >
                ×
              </button>
            </div>

            {exportStage === 'request' && (
              <>
                <div className="border border-red-900/30 bg-red-900/10 p-4 mb-6">
                  <p className="text-sm text-red-300 leading-relaxed">
                    Anyone with this key can control the wallet and move its funds. BARD cannot revoke or recover an exported key.
                  </p>
                </div>
                <p className="text-sm text-surface-400 mb-6">
                  A one-time security code will be sent to <span className="font-mono text-surface-200">{account?.email}</span>.
                </p>
                {exportError && <p className="font-mono text-xs text-red-400 mb-4">{exportError}</p>}
                <div className="flex gap-3">
                  <button type="button" onClick={closeKeyExport} className="btn-secondary flex-1 text-xs">Cancel</button>
                  <button type="button" onClick={requestKeyExport} disabled={exportBusy} className="btn-primary flex-1 text-xs">
                    {exportBusy ? 'Sending...' : 'Send security code'}
                  </button>
                </div>
              </>
            )}

            {exportStage === 'code' && (
              <>
                <p className="text-sm text-surface-400 mb-5">
                  Enter the six-digit code sent to <span className="font-mono text-surface-200">{account?.email}</span>.
                </p>
                <input
                  value={exportCode}
                  onChange={(event) => setExportCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  aria-label="Security code"
                  className="input-field font-mono text-center text-xl mb-4"
                />
                {exportError && <p className="font-mono text-xs text-red-400 mb-4">{exportError}</p>}
                <div className="flex gap-3">
                  <button type="button" onClick={closeKeyExport} className="btn-secondary flex-1 text-xs">Cancel</button>
                  <button
                    type="button"
                    onClick={verifyAndExportKey}
                    disabled={exportBusy || exportCode.length !== 6}
                    className="btn-primary flex-1 text-xs"
                  >
                    {exportBusy ? 'Verifying...' : 'Verify and reveal'}
                  </button>
                </div>
              </>
            )}

            {exportStage === 'revealed' && (
              <>
                <div className="border border-red-900/30 bg-red-900/10 p-4 mb-5">
                  <p className="text-sm text-red-300">
                    Store this key securely. Close this dialog when finished; BARD will not show it again without a new email verification.
                  </p>
                </div>
                <div className="border border-[rgba(255,255,255,0.08)] bg-[#050505] p-4 mb-5">
                  <div className="font-mono text-xs text-white break-all select-all">{privateKey}</div>
                </div>
                <div className="flex gap-3">
                  <button type="button" onClick={copyPrivateKey} className="btn-secondary flex-1 text-xs">
                    {keyCopied ? 'Copied' : 'Copy key'}
                  </button>
                  <button type="button" onClick={closeKeyExport} className="btn-primary flex-1 text-xs">Done</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
