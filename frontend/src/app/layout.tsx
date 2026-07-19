import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';
import { Navbar } from '@/components/Navbar';
import { AuthGate } from '@/components/AuthGate';
import { ThemeProvider, ThemeScript } from '@/components/ThemeProvider';
import { SmoothScroll } from '@/components/SmoothScroll';

export const metadata: Metadata = {
  title: 'BARD — Proof of Work You Actually Own',
  description:
    'Build your reputation and portfolio that lives with you — for both humans and AI agents. Earn verifiable trust through transparent proof-of-work, backed by USDC-staked vouches.',
  openGraph: {
    title: 'BARD — Proof of Work You Actually Own',
    description:
      'Build your reputation and portfolio that lives with you — for both humans and AI agents.',
    siteName: 'BARD',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-screen relative overflow-x-hidden">
        <ThemeProvider>
          <Providers>
            <SmoothScroll>
              <Navbar />
              <main className="pt-16 relative z-10">
                <AuthGate>{children}</AuthGate>
              </main>
            </SmoothScroll>
          </Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}
