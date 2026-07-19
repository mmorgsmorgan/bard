'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { API_URL } from '@/lib/config';

const SESSION_KEY = 'bard_human_session';

interface BardManagedAccount {
  id: string;
  email: string | null;
  emailVerified: boolean;
  loginWallet: string | null;
  wallet: {
    address: `0x${string}`;
    provider: string;
    canExportPrivateKey: boolean;
  };
  createdAt: string;
}

type BardAccountStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface BardAccountContextValue {
  account: BardManagedAccount | null;
  address: `0x${string}` | undefined;
  isConnected: boolean;
  status: BardAccountStatus;
  token: string | null;
  error: string | null;
  login: () => void;
  logout: () => Promise<void>;
  authFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

const BardAccountContext = createContext<BardAccountContextValue | null>(null);

function storedToken() {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(SESSION_KEY);
}

export function BardAccountProvider({ children }: { children: React.ReactNode }) {
  const {
    ready,
    authenticated,
    login: privyLogin,
    logout: privyLogout,
    getAccessToken,
  } = usePrivy();
  const [account, setAccount] = useState<BardManagedAccount | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<BardAccountStatus>('connecting');
  const [error, setError] = useState<string | null>(null);

  const clearSession = useCallback(() => {
    window.localStorage.removeItem(SESSION_KEY);
    setAccount(null);
    setToken(null);
  }, []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;

    if (!authenticated) {
      clearSession();
      setStatus('disconnected');
      setError(null);
      return;
    }

    setStatus('connecting');
    setError(null);
    getAccessToken()
      .then(async (privyToken) => {
        if (!privyToken) throw new Error('Privy did not return an access token');
        const response = await fetch(`${API_URL}/api/human/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ privyToken }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'BARD account provisioning failed');
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        window.localStorage.setItem(SESSION_KEY, data.token);
        setToken(data.token);
        setAccount(data.account);
        setStatus('connected');
      })
      .catch((cause) => {
        if (cancelled) return;
        clearSession();
        setStatus('error');
        setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [ready, authenticated, getAccessToken, clearSession]);

  const login = useCallback(() => {
    setStatus('connecting');
    setError(null);
    privyLogin();
  }, [privyLogin]);

  const logout = useCallback(async () => {
    clearSession();
    setStatus('disconnected');
    await privyLogout();
  }, [clearSession, privyLogout]);

  const authFetch = useCallback(async (path: string, init: RequestInit = {}) => {
    const activeToken = token || storedToken();
    if (!activeToken) throw new Error('BARD login required');
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${activeToken}`);
    return fetch(path.startsWith('http') ? path : `${API_URL}${path}`, {
      ...init,
      headers,
    });
  }, [token]);

  const value = useMemo<BardAccountContextValue>(() => ({
    account,
    address: account?.wallet.address,
    isConnected: status === 'connected' && Boolean(account?.wallet.address),
    status,
    token,
    error,
    login,
    logout,
    authFetch,
  }), [account, status, token, error, login, logout, authFetch]);

  return (
    <BardAccountContext.Provider value={value}>
      {children}
    </BardAccountContext.Provider>
  );
}

export function useBardAccount(): BardAccountContextValue {
  const context = useContext(BardAccountContext);
  if (!context) throw new Error('useBardAccount must be used within BardAccountProvider');
  return context;
}

export function getBardSessionToken(): string | null {
  return storedToken();
}
