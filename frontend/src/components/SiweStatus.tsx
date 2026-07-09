'use client';

/**
 * SiweStatus — a compact navbar control for the optional wallet session.
 *
 * Only renders when a wallet is connected. Shows:
 *  - signed-out  → "Sign in" button (triggers SIWE signature)
 *  - signing/checking → a spinner label
 *  - signed-in   → a small verified pill; click to sign out
 *
 * This is intentionally quiet — the SIWE session is optional (existing per-action
 * signatures still work), so it never demands attention or blocks anything.
 */

import { useAccount } from 'wagmi';
import { useSiweSession } from './SiweProvider';

export function SiweStatus() {
  const { isConnected } = useAccount();
  const { status, signIn, signOut, error } = useSiweSession();

  if (!isConnected) return null;

  if (status === 'signed-in') {
    return (
      <button
        onClick={signOut}
        title="Wallet session active — click to sign out"
        className="group flex items-center gap-1.5 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors"
        style={{ color: 'var(--accent)', border: '1px solid var(--rule)' }}
      >
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: 'var(--accent)' }}
        />
        <span className="group-hover:hidden">Verified</span>
        <span className="hidden group-hover:inline">Sign out</span>
      </button>
    );
  }

  if (status === 'signing' || status === 'checking') {
    return (
      <span
        className="flex items-center gap-1.5 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider"
        style={{ color: 'var(--muted)' }}
      >
        <span
          className="inline-block w-3 h-3 border rounded-full animate-spin"
          style={{ borderColor: 'var(--muted)', borderTopColor: 'transparent' }}
        />
        {status === 'signing' ? 'Sign…' : 'Check…'}
      </span>
    );
  }

  // signed-out (or idle-with-wallet): offer sign-in
  return (
    <button
      onClick={signIn}
      title={error ? `Sign-in failed: ${error}` : 'Prove wallet ownership for a secure session'}
      className="px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors hover:opacity-80"
      style={{
        color: 'var(--muted)',
        border: `1px solid ${error ? 'var(--accent)' : 'var(--rule)'}`,
      }}
    >
      Sign in
    </button>
  );
}
