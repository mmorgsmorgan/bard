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
import { useBardAccount } from './BardAccountProvider';
import { useHasProfile } from '@/lib/useHasProfile';

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
  const { isConnected, status, login } = useBardAccount();
  const { hasProfile, resolved } = useHasProfile();
  // Set when the user clicks while disconnected — we then route once connected.
  const [awaitingConnect, setAwaitingConnect] = useState(false);
  const routedRef = useRef(false);

  const branch = () => {
    router.push(hasProfile ? '/explore' : '/profile');
  };

  // After a click-to-connect, route as soon as the profile signals resolve.
  useEffect(() => {
    if (!awaitingConnect || !isConnected || routedRef.current) return;
    if (!resolved) return;
    routedRef.current = true;
    branch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingConnect, isConnected, resolved, hasProfile]);

  return (
    <button
      className={className}
      style={style}
      disabled={status === 'connecting'}
      onClick={() => {
        if (!isConnected) {
          routedRef.current = false;
          setAwaitingConnect(true);
          login();
        } else {
          branch();
        }
      }}
    >
      {children}
    </button>
  );
}
