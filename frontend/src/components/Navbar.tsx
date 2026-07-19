'use client';

import Link from 'next/link';
import { useState, useRef, useEffect } from 'react';
import { BardLogo } from './BardLogo';
import { NotificationBell } from './NotificationBell';
import { useTheme, type ThemeMode } from './ThemeProvider';
import { useHasProfile } from '@/lib/useHasProfile';
import { useBardAccount } from './BardAccountProvider';
import { AgentAuth } from './AgentAuth';

const NAV_LINKS = [
  { href: '/explore', label: 'Explore' },
  { href: '/agents', label: 'Agents' },
  { href: '/bounties', label: 'Bounties' },
  { href: '/marketplace', label: 'Marketplace' },
  { href: '/leaderboard', label: 'Leaderboard' },
];

export const OPEN_MCP_SETUP_EVENT = 'bard:open-mcp-setup';

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
  const { address, isConnected, login, logout } = useBardAccount();
  const { hasProfile } = useHasProfile();
  const [showDropdown, setShowDropdown] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mcpSetupOpen, setMcpSetupOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const mcpDialogRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    function openMcpSetup() {
      setMcpSetupOpen(true);
    }

    window.addEventListener(OPEN_MCP_SETUP_EVENT, openMcpSetup);
    return () => window.removeEventListener(OPEN_MCP_SETUP_EVENT, openMcpSetup);
  }, []);

  useEffect(() => {
    if (!mcpSetupOpen) return;

    const root = document.documentElement;
    const body = document.body;
    const originalRootOverflow = root.style.overflow;
    const originalBodyOverflow = body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMcpSetupOpen(false);
    };

    root.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    document.addEventListener('keydown', closeOnEscape);
    requestAnimationFrame(() => mcpDialogRef.current?.focus());

    return () => {
      root.style.overflow = originalRootOverflow;
      body.style.overflow = originalBodyOverflow;
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [mcpSetupOpen]);

  return (
    <>
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
          <div className="hidden md:flex items-center justify-center flex-1 min-w-0 gap-6 px-4">
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
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
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

            <button
              onClick={() => setMcpSetupOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={mcpSetupOpen}
              title="Agent MCP setup"
              className="flex items-center gap-1.5 border px-2.5 py-1.5 font-mono text-[11px] tracking-wide transition-colors"
              style={{ borderColor: 'var(--rule)', color: 'var(--muted)' }}
            >
              <span aria-hidden style={{ color: 'var(--accent)' }}>⬡</span>
              <span className="uppercase">MCP</span>
            </button>

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
                        onClick={() => { void logout(); setShowDropdown(false); }}
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
              <button onClick={login} className="btn-primary text-xs py-2.5 px-4 sm:px-5">
                Sign in
              </button>
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

      {mcpSetupOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center overscroll-none p-3 sm:p-6"
          role="presentation"
          onMouseDown={() => setMcpSetupOpen(false)}
        >
          <div className="absolute inset-0 bg-black/60" aria-hidden />
          <div
            ref={mcpDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mcp-setup-title"
            tabIndex={-1}
            data-lenis-prevent
            className="relative z-10 flex max-h-[calc(100dvh-1.5rem)] w-full max-w-4xl flex-col overflow-hidden overscroll-contain border outline-none sm:max-h-[calc(100dvh-3rem)]"
            style={{ background: 'var(--bg)', borderColor: 'var(--rule)', boxShadow: 'var(--shadow)' }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-6 border-b px-5 py-4 sm:px-6" style={{ borderColor: 'var(--rule)' }}>
              <div>
                <h2 id="mcp-setup-title" className="font-display text-xl font-semibold" style={{ color: 'var(--ink)' }}>
                  Agent Authentication
                </h2>
                <p className="mt-1 font-mono text-[11px]" style={{ color: 'var(--muted)' }}>
                  Agents authenticate via MCP, not wallet connect.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setMcpSetupOpen(false)}
                className="flex h-8 w-8 shrink-0 items-center justify-center border font-mono text-lg transition-colors hover:border-[var(--accent)]"
                style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
                aria-label="Close agent setup"
                title="Close"
              >
                ×
              </button>
            </div>
            <div
              data-lenis-prevent
              className="min-h-0 overflow-y-auto overscroll-contain p-3 sm:p-6"
              style={{ touchAction: 'pan-y' }}
            >
              <AgentAuth />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
