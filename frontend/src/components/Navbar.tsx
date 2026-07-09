'use client';

import Link from 'next/link';
import { useState, useRef, useEffect } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useDisconnect } from 'wagmi';
import { BardLogo } from './BardLogo';
import { NotificationBell } from './NotificationBell';
import { useTheme, type ThemeMode } from './ThemeProvider';
import { useHasProfile } from '@/lib/useHasProfile';
import { SiweStatus } from './SiweStatus';

const NAV_LINKS = [
  { href: '/explore', label: 'Explore' },
  { href: '/agents', label: 'Agents' },
  { href: '/bounties', label: 'Bounties' },
  { href: '/marketplace', label: 'Marketplace' },
  { href: '/leaderboard', label: 'Leaderboard' },
];

function ThemeToggle() {
  const { mode, cycle } = useTheme();
  const label: Record<ThemeMode, string> = { light: 'Day', dark: 'Night', auto: 'Auto' };
  const icon: Record<ThemeMode, string> = { light: '☀', dark: '☾', auto: '◐' };
  return (
    <button
      onClick={cycle}
      title={`Theme: ${label[mode]} — click to change`}
      aria-label={`Theme: ${label[mode]}`}
      className="flex items-center gap-1.5 border px-2.5 py-1.5 font-mono text-[11px] tracking-wide transition-colors"
      style={{ borderColor: 'var(--rule)', color: 'var(--muted)' }}
    >
      <span aria-hidden style={{ color: 'var(--accent)' }}>{icon[mode]}</span>
      <span className="hidden sm:inline uppercase">{label[mode]}</span>
    </button>
  );
}

export function Navbar() {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const { hasProfile } = useHasProfile();
  const [showDropdown, setShowDropdown] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Nav links are only meaningful once the user has an account — hide them
  // until a profile exists (i.e. on the landing / pre-signup).
  const showLinks = isConnected && hasProfile;

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50 backdrop-blur-sm px-4 sm:px-6 py-3"
      style={{
        background: 'color-mix(in srgb, var(--bg) 88%, transparent)',
        borderBottom: '1px solid var(--rule)',
      }}
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between relative">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2.5 group shrink-0">
          <BardLogo size={26} className="group-hover:opacity-80 transition-opacity" style={{ color: 'var(--accent)' }} />
          <span
            className="font-display text-lg font-semibold tracking-tight"
            style={{ color: 'var(--ink)' }}
          >
            BARD
          </span>
        </Link>

        {/* Center nav — desktop (only once the user has a profile) */}
        <div className="hidden md:flex items-center justify-center absolute left-1/2 -translate-x-1/2 gap-7">
          {showLinks && NAV_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="font-mono text-[13px] transition-colors hover:opacity-100"
              style={{ color: 'var(--muted)' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--ink)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--muted)')}
            >
              {l.label}
            </Link>
          ))}
        </div>

        {/* Right cluster */}
        <div className="flex items-center gap-2 sm:gap-3">
          <div
            className="hidden lg:flex items-center gap-2 px-3 py-1.5 border"
            style={{ borderColor: 'var(--rule)' }}
          >
            <span className="w-1.5 h-1.5 animate-pulse-subtle" style={{ background: 'var(--accent)' }} />
            <span className="font-mono text-[10px] tracking-wider uppercase" style={{ color: 'var(--muted)' }}>
              Arc Testnet
            </span>
          </div>

          <ThemeToggle />

          <SiweStatus />

          {isConnected ? (
            <div className="flex items-center gap-2">
              <NotificationBell />
              <div className="relative" ref={dropdownRef}>
                <button
                  onClick={() => setShowDropdown(!showDropdown)}
                  className="flex items-center gap-2 border px-3 sm:px-4 py-2 transition-colors"
                  style={{ borderColor: 'var(--rule)' }}
                >
                  <span className="w-2 h-2" style={{ background: 'var(--accent)' }} />
                  <span className="font-mono text-[13px] hidden sm:inline" style={{ color: 'var(--ink-soft)' }}>
                    {address?.slice(0, 6)}...{address?.slice(-4)}
                  </span>
                  <svg
                    className={`w-3 h-3 transition-transform ${showDropdown ? 'rotate-180' : ''}`}
                    style={{ color: 'var(--muted)' }}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor"
                  >
                    <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showDropdown && (
                  <div
                    className="absolute right-0 mt-1 w-48 p-1 animate-fade-in z-50"
                    style={{ background: 'var(--bg-card)', border: '1px solid var(--rule)', boxShadow: 'var(--shadow)' }}
                  >
                    {[
                      { href: '/profile', label: 'Profile' },
                      { href: '/send', label: 'Send' },
                      { href: '/dashboard', label: 'Dashboard' },
                    ].map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setShowDropdown(false)}
                        className="flex items-center gap-3 w-full px-3 py-2.5 font-mono text-[13px] transition-colors"
                        style={{ color: 'var(--ink-soft)' }}
                      >
                        <span className="text-[10px]" style={{ color: 'var(--accent)' }}>→</span> {item.label}
                      </Link>
                    ))}
                    <div className="h-px my-1" style={{ background: 'var(--rule)' }} />
                    <button
                      onClick={() => { disconnect(); setShowDropdown(false); }}
                      className="flex items-center gap-3 w-full px-3 py-2.5 font-mono text-[13px] transition-colors"
                      style={{ color: 'var(--faint)' }}
                    >
                      <span className="text-[10px]">×</span> Disconnect
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <ConnectButton.Custom>
              {({ openConnectModal, mounted }) => (
                <button onClick={openConnectModal} disabled={!mounted} className="btn-primary text-xs py-2.5 px-4 sm:px-5">
                  Connect
                </button>
              )}
            </ConnectButton.Custom>
          )}

          {/* Mobile menu button — only when there are links to show */}
          {showLinks && (
            <button
              className="md:hidden flex items-center justify-center w-9 h-9 border"
              style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
              onClick={() => setMobileOpen((v) => !v)}
              aria-label="Menu"
            >
              <span className="font-mono text-sm">{mobileOpen ? '×' : '≡'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Mobile menu */}
      {showLinks && mobileOpen && (
        <div
          className="md:hidden mt-3 pt-3 flex flex-col gap-1 animate-fade-in"
          style={{ borderTop: '1px solid var(--rule)' }}
        >
          {NAV_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setMobileOpen(false)}
              className="font-mono text-sm py-2.5 px-1 transition-colors"
              style={{ color: 'var(--muted)' }}
            >
              {l.label}
            </Link>
          ))}
        </div>
      )}
    </nav>
  );
}
