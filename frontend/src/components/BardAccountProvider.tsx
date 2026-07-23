'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLogin, usePrivy, useWallets } from '@privy-io/react-auth';
import { API_URL, arcTestnet } from '@/lib/config';

const SESSION_KEY = 'bard_human_session';
const LOGIN_CONTEXT_KEY = 'bard_privy_login_context';

type WalletType = 'managed' | 'external';

interface LoginContext {
  loginMethod: string;
  loginWallet?: string;
}

export interface ExternalTransaction {
  to: `0x${string}`;
  data?: `0x${string}`;
  value?: `0x${string}`;
  chainId?: number;
}

interface BardAccount {
  id: string;
  email: string | null;
  emailVerified: boolean;
  loginWallet: string | null;
  wallet: {
    address: `0x${string}`;
    type: WalletType;
    provider: string;
    canExportPrivateKey: boolean;
  };
  legacyManagedWallet: {
    address: `0x${string}`;
    provider: string;
    canExportPrivateKey: boolean;
  } | null;
  createdAt: string;
}

interface BardSessionResponse {
  token: string;
  account: BardAccount;
  error?: string;
  code?: string;
}

type BardAccountStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface BardAccountContextValue {
  account: BardAccount | null;
  address: `0x${string}` | undefined;
  isConnected: boolean;
  authReady: boolean;
  status: BardAccountStatus;
  token: string | null;
  error: string | null;
  login: () => void;
  logout: () => Promise<void>;
  refreshAccount: () => Promise<void>;
  authFetch: (path: string, init?: RequestInit) => Promise<Response>;
  sendTransaction: (transaction: ExternalTransaction) => Promise<`0x${string}`>;
}

const BardAccountContext = createContext<BardAccountContextValue | null>(null);

function storedToken() {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(SESSION_KEY);
}

function storedLoginContext(): LoginContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.sessionStorage.getItem(LOGIN_CONTEXT_KEY);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

async function getPrivyAccessToken(
  getAccessToken: () => Promise<string | null>
): Promise<string> {
  let lastError: unknown = null;
  for (const delayMs of [0, 250, 750]) {
    if (delayMs > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    }
    try {
      const accessToken = await getAccessToken();
      if (accessToken) return accessToken;
    } catch (cause) {
      lastError = cause;
    }
  }
  throw Object.assign(
    new Error(
      lastError instanceof Error
        ? lastError.message
        : 'Privy did not return an access token'
    ),
    { code: 'privy_token_unavailable' }
  );
}

async function responseJson<T>(response: Response): Promise<Partial<T>> {
  try {
    return await response.json() as Partial<T>;
  } catch {
    return {};
  }
}

export function BardAccountProvider({ children }: { children: React.ReactNode }) {
  const {
    ready,
    authenticated,
    logout: privyLogout,
    getAccessToken,
  } = usePrivy();
  const { wallets } = useWallets();
  const [loginContext, setLoginContext] = useState<LoginContext | null>(null);
  const [account, setAccount] = useState<BardAccount | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<BardAccountStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const pendingLoginRef = useRef(false);
  const { login: privyLogin } = useLogin({
    onComplete: (_user, _isNewUser, _wasAlreadyAuthenticated, loginMethod, loginAccount) => {
      pendingLoginRef.current = false;
      const context: LoginContext = {
        loginMethod: loginMethod || '',
      };
      if (
        loginMethod === 'siwe' &&
        loginAccount?.type === 'wallet' &&
        'address' in loginAccount
      ) {
        context.loginWallet = String(loginAccount.address).toLowerCase();
      }
      window.sessionStorage.setItem(LOGIN_CONTEXT_KEY, JSON.stringify(context));
      setLoginContext(context);
    },
    onError: (cause) => {
      pendingLoginRef.current = false;
      setStatus('error');
      setError(`Sign-in failed: ${String(cause)}`);
    },
  });

  const clearBardSession = useCallback(() => {
    window.localStorage.removeItem(SESSION_KEY);
    setAccount(null);
    setToken(null);
  }, []);

  const clearSession = useCallback(() => {
    clearBardSession();
    window.sessionStorage.removeItem(LOGIN_CONTEXT_KEY);
    setLoginContext(null);
  }, [clearBardSession]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;

    if (!authenticated) {
      // Privy can briefly report signed-out while restoring its persisted
      // session. Keep the BARD token so a later authenticated render can
      // validate or renew it instead of forcing the user to start over.
      setAccount(null);
      setToken(null);
      setStatus('disconnected');
      setError(null);
      return;
    }

    setStatus('connecting');
    setError(null);
    Promise.resolve()
      .then(async (): Promise<BardSessionResponse> => {
        const context = loginContext || storedLoginContext();
        const privyToken = await getPrivyAccessToken(getAccessToken);
        const previousToken = storedToken();
        if (!context) {
          if (previousToken) {
            try {
              const sessionResponse = await fetch(`${API_URL}/api/human/me`, {
                headers: {
                  Authorization: `Bearer ${previousToken}`,
                  'X-Privy-Token': privyToken,
                },
              });
              if (sessionResponse.ok) {
                const sessionData = await responseJson<BardSessionResponse>(sessionResponse);
                if (!sessionData.account) {
                  throw new Error('BARD returned an invalid session response');
                }
                return { token: previousToken, account: sessionData.account };
              }
            } catch {
              // The restore endpoint below can still renew the BARD session.
            }
          }

          const restoreResponse = await fetch(`${API_URL}/api/human/session/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ privyToken }),
          });
          const restoreData = await responseJson<BardSessionResponse>(restoreResponse);
          if (!restoreResponse.ok) {
            throw Object.assign(
              new Error(
                String(restoreData.error || 'Could not restore the BARD session')
              ),
              {
                code: restoreData.code,
                status: restoreResponse.status,
              }
            );
          }
          if (!restoreData.token || !restoreData.account) {
            throw new Error('BARD returned an invalid session restore response');
          }
          return {
            token: restoreData.token,
            account: restoreData.account,
          };
        }

        const response = await fetch(`${API_URL}/api/human/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            privyToken,
            loginMethod: context?.loginMethod,
            loginWallet: context?.loginWallet,
          }),
        });
        const data = await responseJson<BardSessionResponse>(response);
        if (!response.ok) {
          throw Object.assign(
            new Error(String(data.error || 'BARD account provisioning failed')),
            { code: data.code }
          );
        }
        if (!data.token || !data.account) {
          throw new Error('BARD returned an invalid account response');
        }
        return {
          token: data.token,
          account: data.account,
        };
      })
      .then((data) => {
        if (cancelled) return;
        pendingLoginRef.current = false;
        window.localStorage.setItem(SESSION_KEY, data.token);
        window.sessionStorage.removeItem(LOGIN_CONTEXT_KEY);
        setToken(data.token);
        setAccount(data.account);
        setStatus('connected');
      })
      .catch(async (cause) => {
        if (cancelled) return;
        pendingLoginRef.current = false;
        const code = (cause as { code?: string })?.code;
        const resetPrivySession =
          code === 'account_login_method_mismatch' ||
          code === 'external_wallet_not_linked' ||
          code === 'email_login_mismatch' ||
          code === 'wallet_login_mismatch';
        if (resetPrivySession) {
          clearBardSession();
          await privyLogout().catch(() => {});
        } else {
          // Keep the persisted BARD token on transient failures. It may still
          // be valid and can be retried on the next Privy/session refresh.
          setAccount(null);
          setToken(null);
        }
        if (cancelled) return;
        setStatus('error');
        setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [
    ready,
    authenticated,
    getAccessToken,
    privyLogout,
    clearBardSession,
    loginContext,
  ]);

  const startPrivyLogin = useCallback(() => {
    pendingLoginRef.current = false;
    setStatus('connecting');
    setError(null);
    privyLogin();
  }, [privyLogin]);

  useEffect(() => {
    if (!ready || !pendingLoginRef.current) return;
    if (authenticated) {
      pendingLoginRef.current = false;
      return;
    }
    startPrivyLogin();
  }, [ready, authenticated, startPrivyLogin]);

  const restartPrivyLogin = useCallback(() => {
    pendingLoginRef.current = false;
    setStatus('connecting');
    setError(null);
    void privyLogout()
      .then(() => {
        clearSession();
        setStatus('connecting');
        privyLogin();
      })
      .catch((cause) => {
        setStatus('error');
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [clearSession, privyLogin, privyLogout]);

  const login = useCallback(() => {
    setError(null);
    if (!ready) {
      pendingLoginRef.current = true;
      return;
    }
    if (authenticated && !account) {
      if (status === 'connecting') return;
      restartPrivyLogin();
      return;
    }
    startPrivyLogin();
  }, [
    ready,
    authenticated,
    account,
    status,
    restartPrivyLogin,
    startPrivyLogin,
  ]);

  const logout = useCallback(async () => {
    pendingLoginRef.current = false;
    clearSession();
    setStatus('disconnected');
    await privyLogout();
  }, [clearSession, privyLogout]);

  const refreshAccount = useCallback(async () => {
    const privyToken = await getAccessToken();
    if (!privyToken) throw new Error('Privy did not return an access token');
    const activeToken = token || storedToken();
    if (!activeToken) throw new Error('BARD login required');
    const response = await fetch(`${API_URL}/api/human/me`, {
      headers: {
        Authorization: `Bearer ${activeToken}`,
        'X-Privy-Token': privyToken,
      },
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Could not refresh the BARD account');
    }
    setAccount(data.account);
    setStatus('connected');
    setError(null);
  }, [getAccessToken, token]);

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

  const sendTransaction = useCallback(async (transaction: ExternalTransaction) => {
    if (account?.wallet.type !== 'external') {
      throw new Error('This action does not require a browser wallet signature');
    }
    const expectedAddress = account.wallet.address.toLowerCase();
    const wallet = wallets.find(
      (candidate) =>
        candidate.type === 'ethereum' &&
        candidate.address.toLowerCase() === expectedAddress &&
        candidate.walletClientType !== 'privy'
    );
    if (!wallet) {
      throw new Error('Reconnect the external wallet used for this BARD account');
    }
    await wallet.switchChain(transaction.chainId || arcTestnet.id);
    const provider = await wallet.getEthereumProvider();
    const hash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{
        from: account.wallet.address,
        to: transaction.to,
        data: transaction.data || '0x',
        value: transaction.value || '0x0',
      }],
    });
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new Error('The connected wallet did not return a transaction hash');
    }
    return hash as `0x${string}`;
  }, [account, wallets]);

  const value = useMemo<BardAccountContextValue>(() => ({
    account,
    address: account?.wallet.address,
    isConnected: status === 'connected' && Boolean(account?.wallet.address),
    authReady: ready,
    status,
    token,
    error,
    login,
    logout,
    refreshAccount,
    authFetch,
    sendTransaction,
  }), [account, ready, status, token, error, login, logout, refreshAccount, authFetch, sendTransaction]);

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
