'use client';

import { useReadContract } from 'wagmi';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BardLogo } from './BardLogo';
import { useBardAccount } from './BardAccountProvider';
import { CONTRACTS } from '@/lib/config';
import { BARD_PROFILE_ABI } from '@/lib/abi';
import { fetchProfileByWallet, getProfileByWallet } from '@/lib/store';

/**
 * AuthGate — the landing page is the entry layer.
 *
 * Flow:
 *  - "/" is the ONLY fully public route. Anyone can read the landing without
 *    a wallet.
 *  - Interior routes (explore, agents, bounties, leaderboard, marketplace,
 *    dashboard, send) require a connected wallet AND a profile.
 *      · not connected        → connect prompt (routes back through connect)
 *      · connected, no profile → redirect to /profile (create it first)
 *      · connected, has profile → straight in, no friction
 *  - "/profile" always renders — it IS the creation page.
 *  - "/u/*" public profile views stay open (shareable links).
 */

// Only the landing + shareable public profiles bypass the gate.
function isFullyPublic(pathname: string): boolean {
  if (pathname === '/') return true;
  if (pathname.startsWith('/u/')) return true;
  return false;
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { isConnected, address, status, login, error } = useBardAccount();
  const pathname = usePathname();
  const router = useRouter();
  const [profileResolved, setProfileResolved] = useState(false);
  const [backendHasProfile, setBackendHasProfile] = useState<boolean | null>(null);

  // On-chain profile check.
  const { data: onChainProfile, isLoading: profileLoading } = useReadContract({
    address: CONTRACTS.BARD_PROFILE,
    abi: BARD_PROFILE_ABI,
    functionName: 'getProfile',
    args: address ? [address] : undefined,
    query: { enabled: !!address && isConnected },
  });

  const hasOnChainProfile =
    onChainProfile && Array.isArray(onChainProfile) && onChainProfile[5] === true;

  // Backend/off-chain profile check (covers profiles not yet reflected on-chain).
  useEffect(() => {
    let cancelled = false;
    if (!isConnected || !address) {
      setBackendHasProfile(null);
      setProfileResolved(false);
      return;
    }
    setProfileResolved(false);
    fetchProfileByWallet(address)
      .then((p) => {
        if (!cancelled) setBackendHasProfile(!!p);
      })
      .catch(() => {
        if (!cancelled) setBackendHasProfile(!!getProfileByWallet(address));
      })
      .finally(() => {
        if (!cancelled) setProfileResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isConnected, address]);

  const hasProfile = hasOnChainProfile || backendHasProfile === true;
  // "resolved" = both signals in: on-chain read done AND backend check done.
  const resolved = !profileLoading && profileResolved;

  // Redirect connected-but-profileless users into creation, from any gated page.
  useEffect(() => {
    if (!isConnected || !resolved) return;
    if (!hasProfile && pathname !== '/profile' && !isFullyPublic(pathname)) {
      router.replace('/profile');
    }
  }, [isConnected, resolved, hasProfile, pathname, router]);

  // ── Public landing / shareable profiles: always render ──
  if (isFullyPublic(pathname)) {
    return <>{children}</>;
  }

  // ── /profile is the creation page: always render ──
  if (pathname === '/profile') {
    return <>{children}</>;
  }

  // ── Interior route, not connected: connect prompt ──
  if (!isConnected) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div
          className="p-10 max-w-md w-full text-center animate-fade-in"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--rule)', boxShadow: 'var(--shadow)' }}
        >
          <BardLogo size={52} className="mx-auto mb-6" />
          <h2 className="text-2xl font-semibold mb-3" style={{ color: 'var(--ink)' }}>
            Connect to continue
          </h2>
          <p className="text-sm mb-8" style={{ color: 'var(--muted)' }}>
            Email sign-in creates a BARD-managed wallet. Wallet sign-in uses your connected wallet directly.
          </p>
          {error && <p className="text-xs mb-4" style={{ color: 'var(--danger)' }}>{error}</p>}
          <button
            onClick={login}
            disabled={status === 'connecting'}
            className="btn-primary w-full text-xs py-3.5"
          >
            {status === 'connecting' ? 'Signing in...' : 'Continue with email or wallet'}
          </button>
        </div>
      </div>
    );
  }

  // ── Interior route, connected, still resolving profile ──
  if (!resolved) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center animate-fade-in">
          <div
            className="w-8 h-8 border-2 rounded-full animate-spin mx-auto mb-4"
            style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }}
          />
          <p className="font-mono text-xs" style={{ color: 'var(--muted)' }}>
            Checking profile...
          </p>
        </div>
      </div>
    );
  }

  // ── Connected but no profile: redirect in-flight (useEffect above) ──
  if (!hasProfile) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center animate-fade-in">
          <div
            className="w-8 h-8 border-2 rounded-full animate-spin mx-auto mb-4"
            style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }}
          />
          <p className="font-mono text-xs" style={{ color: 'var(--muted)' }}>
            Taking you to profile setup...
          </p>
        </div>
      </div>
    );
  }

  // ── Connected + has profile: full access ──
  return <>{children}</>;
}
