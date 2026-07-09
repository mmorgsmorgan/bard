'use client';

/**
 * SiweProvider — app-wide wallet-session state, layered on top of the useSiwe() hook.
 *
 * Design intent (matches backend/siwe-auth.js): the SIWE session is OPTIONAL
 * plumbing. It does NOT gate the app — AuthGate still governs access by wallet +
 * profile. This provider just tracks whether the connected wallet has proven a
 * session (signed in), so gated backend reads can attach `Authorization: Bearer`.
 *
 * Behaviour:
 *  - On mount / wallet change, validates any stored token against /auth/me and,
 *    critically, checks it belongs to the CURRENTLY connected address. A token
 *    for a different wallet (wallet switch) is treated as signed-out.
 *  - Exposes signIn() (triggers the wallet signature) and signOut().
 *  - Never blocks rendering.
 */

import { createContext, useContext, useCallback, useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { API_URL } from '@/lib/config';
import { useSiwe, getSessionToken, clearSessionToken } from '@/lib/siwe';

type SiweStatus = 'idle' | 'checking' | 'signed-out' | 'signed-in' | 'signing';

interface SiweContextValue {
  status: SiweStatus;
  sessionAddress: string | null;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => void;
}

const SiweContext = createContext<SiweContextValue | null>(null);

export function SiweProvider({ children }: { children: React.ReactNode }) {
  const { address, isConnected } = useAccount();
  const { signIn: doSignIn, signingIn, error: signError } = useSiwe();
  const [status, setStatus] = useState<SiweStatus>('idle');
  const [sessionAddress, setSessionAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Validate a stored token whenever the connected wallet changes.
  useEffect(() => {
    let cancelled = false;

    if (!isConnected || !address) {
      setStatus('idle');
      setSessionAddress(null);
      return;
    }

    const token = getSessionToken();
    if (!token) {
      setStatus('signed-out');
      setSessionAddress(null);
      return;
    }

    setStatus('checking');
    fetch(`${API_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        // Token must be valid AND belong to the connected wallet.
        if (data?.address && data.address.toLowerCase() === address.toLowerCase()) {
          setSessionAddress(data.address.toLowerCase());
          setStatus('signed-in');
        } else {
          // Stale/mismatched token (e.g. wallet switch) — drop it.
          clearSessionToken();
          setSessionAddress(null);
          setStatus('signed-out');
        }
      })
      .catch(() => {
        if (cancelled) return;
        // Network/validation failure — treat as signed-out but keep the token
        // (backend may just be unreachable; don't destroy a possibly-valid session).
        setStatus('signed-out');
        setSessionAddress(null);
      });

    return () => {
      cancelled = true;
    };
  }, [isConnected, address]);

  const signIn = useCallback(async () => {
    setError(null);
    const token = await doSignIn();
    if (token && address) {
      setSessionAddress(address.toLowerCase());
      setStatus('signed-in');
    } else {
      setStatus('signed-out');
      setError(signError || 'sign-in failed');
    }
  }, [doSignIn, address, signError]);

  const signOut = useCallback(() => {
    clearSessionToken();
    setSessionAddress(null);
    setStatus(isConnected ? 'signed-out' : 'idle');
    setError(null);
  }, [isConnected]);

  const effectiveStatus: SiweStatus = signingIn ? 'signing' : status;

  return (
    <SiweContext.Provider
      value={{ status: effectiveStatus, sessionAddress, error, signIn, signOut }}
    >
      {children}
    </SiweContext.Provider>
  );
}

export function useSiweSession(): SiweContextValue {
  const ctx = useContext(SiweContext);
  if (!ctx) {
    throw new Error('useSiweSession must be used within <SiweProvider>');
  }
  return ctx;
}
