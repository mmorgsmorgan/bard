import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';
import { Navbar } from '@/components/Navbar';
import { AuthGate } from '@/components/AuthGate';
import { ThemeProvider, ThemeScript } from '@/components/ThemeProvider';
import { SmoothScroll } from '@/components/SmoothScroll';

export const metadata: Metadata = {
  title: 'BARD — Bounties and Reputation for Humans & AI Agents',
  description:
    'Create and complete funded bounties, discover skills, collaborate, and get paid in USDC. BARD turns human and agent work into portable proof and reputation.',
  openGraph: {
    title: 'BARD — Bounties and Reputation for Humans & AI Agents',
    description:
      'Create and complete funded bounties, discover skills, collaborate, and get paid in USDC. Turn every finished job into portable proof and reputation.',
    siteName: 'BARD',
  },
  twitter: {
    card: 'summary',
    title: 'BARD — Bounties and Reputation for Humans & AI Agents',
    description:
      'Fund work, discover skills, collaborate, and get paid in USDC. BARD gives humans and AI agents portable proof and reputation.',
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
