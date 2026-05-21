'use client';

import { useAccount, useReadContract } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BardLogo } from './BardLogo';
import { CONTRACTS } from '@/lib/config';
import { BARD_PROFILE_ABI } from '@/lib/abi';
import { getProfileByWallet } from '@/lib/store';

/**
 * AuthGate wraps the app content.
 * - Public routes (/, /explore, /u/*) bypass the wallet-connect gate.
 * - When connected but NO profile exists, auto-redirects to /profile
 *   from ANY page (including public routes) for immediate registration.
 */

const PUBLIC_ROUTES = ['/', '/explore', '/agents', '/bounties', '/leaderboard'];

function isPublicRoute(pathname: string): boolean {
  if (PUBLIC_ROUTES.includes(pathname)) return true;
  if (pathname.startsWith('/u/')) return true;
  return false;
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { isConnected, address } = useAccount();
  const pathname = usePathname();
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  // Check on-chain profile
  const { data: onChainProfile, isLoading: profileLoading } = useReadContract({
    address: CONTRACTS.BARD_PROFILE,
    abi: BARD_PROFILE_ABI,
    functionName: 'getProfile',
    args: address ? [address] : undefined,
    query: { enabled: !!address && isConnected },
  });

  const hasOnChainProfile = onChainProfile && Array.isArray(onChainProfile) && onChainProfile[5] === true;
  const hasLocalProfile = address ? !!getProfileByWallet(address) : false;
  const hasProfile = hasOnChainProfile || hasLocalProfile;

  // Auto-redirect to /profile when connected but no profile (only from private pages)
  useEffect(() => {
    if (!isConnected || profileLoading) return;
    setChecked(true);

    if (!hasProfile && pathname !== '/profile' && !isPublicRoute(pathname)) {
      router.replace('/profile');
    }
  }, [isConnected, hasProfile, profileLoading, pathname, router]);

  // Public routes — show content if not connected (no wallet-connect gate)
  if (isPublicRoute(pathname) && !isConnected) {
    return <>{children}</>;
  }

  // Public routes — connected user, show content (redirect handled by useEffect above)
  if (isPublicRoute(pathname) && isConnected) {
    return <>{children}</>;
  }

  // /profile always renders (it IS the registration page)
  if (pathname === '/profile') {
    return <>{children}</>;
  }

  // Not connected on private route — show connect prompt
  if (!isConnected) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="auth-gate-card border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-10 max-w-md w-full text-center animate-fade-in">
          <BardLogo size={56} className="mx-auto mb-6" />
          <h2 className="text-2xl font-bold text-white mb-3">Connect to Continue</h2>
          <p className="text-surface-400 text-sm mb-8">
            Connect your wallet to access BARD
          </p>
          <ConnectButton.Custom>
            {({ openConnectModal, mounted }) => (
              <button
                onClick={openConnectModal}
                disabled={!mounted}
                className="btn-primary w-full text-xs py-3.5"
              >
                Connect Wallet
              </button>
            )}
          </ConnectButton.Custom>
        </div>
      </div>
    );
  }

  // Connected but still loading profile check
  if (profileLoading && !checked) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center animate-fade-in">
          <div className="w-8 h-8 border-2 border-[#ff8512] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-surface-500 font-mono text-xs">Checking profile...</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
