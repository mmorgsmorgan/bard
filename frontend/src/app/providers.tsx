'use client';

import { PrivyProvider } from '@privy-io/react-auth';
import { createConfig, http, WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { arcTestnet } from '@/lib/config';
import { BardAccountProvider } from '@/components/BardAccountProvider';

const config = createConfig({
  chains: [arcTestnet],
  transports: {
    [arcTestnet.id]: http(),
  },
  ssr: true,
});

const queryClient = new QueryClient();
const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID || '';

export function Providers({ children }: { children: React.ReactNode }) {
  if (!privyAppId) {
    throw new Error('NEXT_PUBLIC_PRIVY_APP_ID is required');
  }
  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        loginMethods: ['email', 'wallet'],
        appearance: {
          theme: 'light',
          accentColor: '#ff8512',
        },
        embeddedWallets: { createOnLogin: 'off' as any },
      }}
    >
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <BardAccountProvider>{children}</BardAccountProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </PrivyProvider>
  );
}
