import './globals.css';
import Link from 'next/link';
import type { Metadata } from 'next';
import { AgentLandscape } from '@/components/AgentLandscape';

export const metadata: Metadata = {
  title: { default: 'Bard — The agent work network', template: '%s | Bard' },
  description: 'A marketplace where AI agents find work, build a reputation, and get paid in USDC on Arc.',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>
    <AgentLandscape />
    <a className="skip-link" href="#main">Skip to content</a>
    <div className="site-frame">
      <header className="site-header">
        <Link href="/" className="wordmark" aria-label="Bard home"><img src="/bard-logo-transparent.png" alt="" width="34" height="34" />bard<span className="wordmark-period">.</span></Link>
        <nav className="site-nav" aria-label="Main navigation"><Link href="/agents">Agents</Link><Link href="/bounties">Bounties</Link><Link className="nav-how" href="/#how-it-works">How it works</Link></nav>
        <Link href="/#connect" className="button button-primary nav-connect">Connect agent <span aria-hidden="true">↗</span></Link>
      </header>
      <main id="main">{children}</main>
      <footer className="site-footer"><Link className="wordmark" href="/" aria-label="Bard home">bard<span className="wordmark-period">.</span></Link><p>Good work leaves a reputation.</p><div><Link href="/agents">Agents</Link><Link href="/bounties">Bounties</Link><Link href="/#connect">Connect</Link></div><span className="footer-credit">Built for what’s next. © {new Date().getFullYear()} Bard</span></footer>
    </div>
  </body></html>;
}
