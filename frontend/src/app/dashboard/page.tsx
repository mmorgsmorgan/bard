'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { GitHubIcon, DiscordIcon, FarcasterIcon, XIcon } from '@/components/SocialIcons';
import { useAccount, useReadContract, useBalance } from 'wagmi';
import { formatUnits } from 'viem';
import { CONTRACTS } from '@/lib/config';
import { BARD_PROFILE_ABI } from '@/lib/abi';
import { fetchProfileByWallet, fetchProofsByWallet, fetchPortfolioByWallet, fetchNotificationsByWallet } from '@/lib/store';
import { PageHeader, Em } from '@/components/Editorial';
import type { StoredProfile, StoredProof, PortfolioItem, Notification } from '@/lib/store';

export default function DashboardPage() {
  const { address, isConnected, status } = useAccount();
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  const [proofs, setProofs] = useState<StoredProof[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioItem[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  // On-chain data
  const { data: onChainProfile } = useReadContract({
    address: CONTRACTS.BARD_PROFILE,
    abi: BARD_PROFILE_ABI,
    functionName: 'getProfile',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const { data: usdcBalance } = useBalance({
    address,
    token: CONTRACTS.USDC,
  });

  const { data: nativeBalance } = useBalance({ address });

  const hasOnChain = onChainProfile && Array.isArray(onChainProfile) &&
    onChainProfile[0] !== '0x0000000000000000000000000000000000000000';

  useEffect(() => {
    if (!address) return;
    setLoading(true);
    Promise.all([
      fetchProfileByWallet(address),
      fetchProofsByWallet(address),
      fetchPortfolioByWallet(address),
      fetchNotificationsByWallet(address),
    ]).then(([p, pr, po, n]) => {
      setProfile(p);
      setProofs(pr);
      setPortfolio(po);
      setNotifications(n);
      setLoading(false);
    });
  }, [address]);

  const validatedProofs = proofs.filter((p) => p.status === 'validated').length;
  const trustScore = Math.min(100, validatedProofs * 15 + proofs.length * 5 + portfolio.length * 3);
  const unread = notifications.filter((n) => !n.read).length;

  if (status === 'connecting' || status === 'reconnecting') {
    return <div className="min-h-[80vh]" />;
  }

  if (!isConnected) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-24 text-center">
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-16 animate-fade-in">
          <div className="font-mono text-2xl text-surface-600 mb-6">⬡</div>
          <h1 className="text-xl font-bold text-white mb-3">Connect Wallet</h1>
          <p className="text-surface-400 text-sm">Connect your wallet to view your dashboard.</p>
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
                {usdcBalance ? Number(formatUnits(usdcBalance.value, usdcBalance.decimals)).toFixed(2) : '0.00'}
              </span>
            </div>
            <div>
              <span className="font-mono text-[10px] text-surface-500">ETH</span>
              <span className="font-mono text-sm text-white ml-2">
                {nativeBalance ? Number(formatUnits(nativeBalance.value, 18)).toFixed(4) : '0.0000'}
              </span>
            </div>
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
    </div>
  );
}
