'use client';

/**
 * useHasProfile — single source of truth for "does the connected wallet have a
 * BARD profile yet". Checks both on-chain (getProfile) and the backend store,
 * mirroring AuthGate/EnterButton so all three never disagree.
 *
 * Returns:
 *   hasProfile: boolean         — true once either signal confirms a profile
 *   resolved:   boolean         — both checks have settled
 */

import { useEffect, useState } from 'react';
import { useAccount, useReadContract } from 'wagmi';
import { CONTRACTS } from './config';
import { BARD_PROFILE_ABI } from './abi';
import { fetchProfileByWallet, getProfileByWallet } from './store';

export function useHasProfile() {
  const { address, isConnected } = useAccount();
  const [backendHasProfile, setBackendHasProfile] = useState<boolean | null>(null);
  const [backendResolved, setBackendResolved] = useState(false);

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
      setBackendResolved(false);
      return;
    }
    setBackendResolved(false);
    fetchProfileByWallet(address)
      .then((p) => !cancelled && setBackendHasProfile(!!p))
      .catch(() => !cancelled && setBackendHasProfile(!!getProfileByWallet(address)))
      .finally(() => !cancelled && setBackendResolved(true));
    return () => {
      cancelled = true;
    };
  }, [isConnected, address]);

  const hasProfile = !!hasOnChain || backendHasProfile === true;
  const resolved = isConnected ? !chainLoading && backendResolved : true;

  return { hasProfile, resolved, isConnected };
}
