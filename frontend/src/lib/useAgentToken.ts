'use client';

import { useState, useCallback } from 'react';
import { useAccount, useSignMessage } from 'wagmi';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

// Cache one token per wallet+agentId in memory (cleared on tab close)
const cache = new Map<string, { token: string; agentId: string; expiresAt: number }>();

interface UseAgentTokenResult {
  /** Acquire (or reuse) a JWT for the given agent. Returns the token. */
  getToken: (agentId: string) => Promise<string | null>;
  busy: boolean;
  error: string | null;
}

/**
 * React hook that obtains a short-lived JWT for an agent by signing a wallet challenge.
 * The token is cached in memory for the session (cleared when tab closes).
 *
 * Usage:
 *   const { getToken, busy, error } = useAgentToken();
 *   const token = await getToken(agentId);
 *   // Use token in API calls that require requireAuth
 */
export function useAgentToken(): UseAgentTokenResult {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getToken = useCallback(async (agentId: string): Promise<string | null> => {
    if (!address) {
      setError('Connect your wallet first');
      return null;
    }
    const cacheKey = `${address.toLowerCase()}::${agentId}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.token;
    }

    setBusy(true);
    setError(null);
    try {
      // 1. Request challenge
      const chRes = await fetch(`${API}/api/auth/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      });
      const chJson = await chRes.json();
      if (!chRes.ok) throw new Error(chJson.error || 'Failed to fetch challenge');

      // 2. Sign challenge message
      const signature = await signMessageAsync({ message: chJson.message });

      // 3. Verify and receive token
      const vRes = await fetch(`${API}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeId: chJson.challengeId,
          signature,
          wallet: address,
        }),
      });
      const vJson = await vRes.json();
      if (!vRes.ok) throw new Error(vJson.error || 'Verification failed');

      const token = vJson.token;
      const expiresAt = vJson.expiresAt ? new Date(vJson.expiresAt).getTime() : Date.now() + 7 * 24 * 60 * 60 * 1000;
      cache.set(cacheKey, { token, agentId, expiresAt });
      return token;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, [address, signMessageAsync]);

  return { getToken, busy, error };
}
