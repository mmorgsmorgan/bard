'use client';

/**
 * SIWE (Sign-In With Ethereum) client hook.
 *
 * Pairs with backend/siwe-auth.js. On sign-in it:
 *   1. fetches a one-time nonce for the connected address,
 *   2. builds the canonical EIP-4361 message (must match the backend's
 *      buildSiweMessage exactly),
 *   3. asks the wallet to personal_sign it (viem useSignMessage),
 *   4. POSTs { address, message, signature } to /auth/verify,
 *   5. stores the returned session JWT in localStorage.
 *
 * The token is optional plumbing — existing per-action signatures still work.
 * Use `getSessionToken()` to attach `Authorization: Bearer <token>` to any
 * backend request you want to gate on a proven wallet session.
 */

import { useCallback, useState } from 'react';
import { useAccount, useSignMessage } from 'wagmi';
import { API_URL, arcTestnet } from './config';

const TOKEN_KEY = 'bard-siwe-token';

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function clearSessionToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

// Mirror of backend buildSiweMessage — keep in lockstep.
function buildSiweMessage(opts: {
  domain: string;
  address: string;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
}) {
  return [
    `${opts.domain} wants you to sign in with your Ethereum account:`,
    opts.address,
    '',
    'Sign in to BARD — proof of work you actually own.',
    '',
    `URI: ${opts.uri}`,
    'Version: 1',
    `Chain ID: ${opts.chainId}`,
    `Nonce: ${opts.nonce}`,
    `Issued At: ${opts.issuedAt}`,
  ].join('\n');
}

export function useSiwe() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = useCallback(async (): Promise<string | null> => {
    if (!isConnected || !address) {
      setError('wallet not connected');
      return null;
    }
    setSigningIn(true);
    setError(null);
    try {
      const addr = address.toLowerCase();

      // 1) nonce
      const nres = await fetch(`${API_URL}/auth/nonce?address=${addr}`);
      const { nonce } = await nres.json();
      if (!nonce) throw new Error('no nonce issued');

      // 2) message
      const message = buildSiweMessage({
        domain: window.location.host,
        address: addr,
        uri: window.location.origin,
        chainId: arcTestnet.id,
        nonce,
        issuedAt: new Date().toISOString(),
      });

      // 3) sign
      const signature = await signMessageAsync({ message });

      // 4) verify
      const vres = await fetch(`${API_URL}/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr, message, signature, nonce }),
      });
      const data = await vres.json();
      if (!vres.ok || !data.token) {
        throw new Error(data.error || 'verification failed');
      }

      // 5) store
      try {
        localStorage.setItem(TOKEN_KEY, data.token);
      } catch {
        /* ignore */
      }
      return data.token as string;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      return null;
    } finally {
      setSigningIn(false);
    }
  }, [address, isConnected, signMessageAsync]);

  return { signIn, signingIn, error, getSessionToken, clearSessionToken };
}
