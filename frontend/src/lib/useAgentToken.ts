'use client';

import { useState, useCallback } from 'react';
import { useBardAccount } from '@/components/BardAccountProvider';

// Cache one token per wallet+agentId in memory (cleared on tab close)
const cache = new Map<string, { token: string; agentId: string; expiresAt: number }>();

interface UseAgentTokenResult {
  /** Acquire (or reuse) a JWT for the given agent. Returns the token. */
  getToken: (agentId: string) => Promise<string | null>;
  busy: boolean;
  error: string | null;
}

/**
 * React hook that obtains a short-lived JWT for an agent linked to the logged-in
 * human's BARD-managed wallet.
 * The token is cached in memory for the session (cleared when tab closes).
 *
 * Usage:
 *   const { getToken, busy, error } = useAgentToken();
 *   const token = await getToken(agentId);
 *   // Use token in API calls that require requireAuth
 */
export function useAgentToken(): UseAgentTokenResult {
  const { address, authFetch } = useBardAccount();
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
      const response = await authFetch(`/api/human/agents/${encodeURIComponent(agentId)}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Agent authentication failed');

      const token = json.token;
      const expiresAt = json.expiresAt
        ? new Date(json.expiresAt).getTime()
        : Date.now() + 7 * 24 * 60 * 60 * 1000;
      cache.set(cacheKey, { token, agentId, expiresAt });
      return token;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, [address, authFetch]);

  return { getToken, busy, error };
}
