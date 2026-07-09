'use client';

/**
 * EnterButton — the landing page's entry CTA.
 *
 * Behaviour matches the desired flow:
 *   - Not connected  → opens the wallet-connect modal.
 *   - Just connected → branches automatically:
 *        · has a profile → into the app (/explore)
 *        · no profile    → to /profile (create it)
 *   - Already connected on click → same branch immediately.
 *
 * Profile existence is checked both on-chain (getProfile) and via the backend
 * store, mirroring AuthGate so the two never disagree.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useReadContract } from 'wagmi';
import { CONTRACTS } from '@/lib/config';
import { BARD_PROFILE_ABI } from '@/lib/abi';
import { fetchProfileByWallet, getProfileByWallet } from '@/lib/store';

export function EnterButton({
  children,
  className = '',
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  // Set when the user clicks while disconnected — we then route once connected.
  const [awaitingConnect, setAwaitingConnect] = useState(false);
  const [backendHasProfile, setBackendHasProfile] = useState<boolean | null>(null);
  const routedRef = useRef(false);

  const { data: onChainProfile, isLoading: chainLoading } = useReadContract({
    address: CONTRACTS.BARD_PROFILE,
    abi: BARD_PROFILE_ABI,
    functionName: 'getProfile',
    args: address ? [address] : undefined,
    query: { enabled: !!address && isConnected },
  });
  const hasOnChain =
    onChainProfile && Array.isArray(onChainProfile) && onChainProfile[5] === true;

  useEffect(() => {
    let cancelled = false;
    if (!isConnected || !address) {
      setBackendHasProfile(null);
      return;
    }
    fetchProfileByWallet(address)
      .then((p) => !cancelled && setBackendHasProfile(!!p))
      .catch(() => !cancelled && setBackendHasProfile(!!getProfileByWallet(address)));
    return () => {
      cancelled = true;
    };
  }, [isConnected, address]);

  const branch = () => {
    const hasProfile = hasOnChain || backendHasProfile === true;
    router.push(hasProfile ? '/explore' : '/profile');
  };

  // After a click-to-connect, route as soon as the profile signals resolve.
  useEffect(() => {
    if (!awaitingConnect || !isConnected || routedRef.current) return;
    // Wait for both checks to settle so we branch correctly.
    if (chainLoading || backendHasProfile === null) return;
    routedRef.current = true;
    branch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingConnect, isConnected, chainLoading, backendHasProfile]);

  return (
    <ConnectButton.Custom>
      {({ openConnectModal, mounted }) => (
        <button
          className={className}
          style={style}
          disabled={!mounted}
          onClick={() => {
            if (!isConnected) {
              routedRef.current = false;
              setAwaitingConnect(true);
              openConnectModal();
            } else {
              branch();
            }
          }}
        >
          {children}
        </button>
      )}
    </ConnectButton.Custom>
  );
}
