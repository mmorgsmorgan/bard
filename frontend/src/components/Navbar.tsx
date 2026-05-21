'use client';

import Link from 'next/link';
import { useState, useRef, useEffect } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useDisconnect } from 'wagmi';
import { BardLogo } from './BardLogo';
import { NotificationBell } from './NotificationBell';

export function Navbar() {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

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
    <nav className="fixed top-0 left-0 right-0 z-50 bg-[#050505]/90 backdrop-blur-sm border-b border-[rgba(255,255,255,0.06)] px-6 py-3">
      <div className="max-w-7xl mx-auto flex items-center justify-between relative">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2.5 group">
          <BardLogo size={28} className="text-[#ff8512] group-hover:text-[#ffa038] transition-colors" />
          <span className="font-mono text-sm font-semibold text-white tracking-wide">BARD</span>
        </Link>

        {/* Navigation */}
        <div className="hidden md:flex items-center justify-center absolute left-1/2 -translate-x-1/2 gap-6">
          <Link href="/explore" className="font-mono text-sm text-surface-400 hover:text-white transition-colors">Explore</Link>
          <Link href="/agents" className="font-mono text-sm text-surface-400 hover:text-white transition-colors">Agents</Link>
          <Link href="/bounties" className="font-mono text-sm text-surface-400 hover:text-white transition-colors">Bounties</Link>
          <Link href="/marketplace" className="font-mono text-sm text-surface-400 hover:text-[#ff8512] transition-colors">Marketplace</Link>
          <Link href="/leaderboard" className="font-mono text-sm text-surface-400 hover:text-white transition-colors">Leaderboard</Link>
        </div>

        {/* Wallet */}
        <div className="flex items-center gap-4">
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 border border-[rgba(255,255,255,0.06)]">
            <div className="w-1.5 h-1.5 bg-[#ff8512] animate-pulse-subtle" />
            <span className="font-mono text-[10px] text-surface-400 tracking-wider uppercase">Arc Testnet</span>
          </div>

          {isConnected ? (
            <div className="flex items-center gap-2">
              <NotificationBell />
              <div className="relative" ref={dropdownRef}>
                <button onClick={() => setShowDropdown(!showDropdown)}
                  className="flex items-center gap-2 border border-[rgba(255,255,255,0.06)] px-4 py-2 hover:border-[rgba(255,133,18,0.3)] transition-colors">
                  <div className="w-2 h-2 bg-[#ff8512]" />
                  <span className="font-mono text-sm text-surface-300">{address?.slice(0, 6)}...{address?.slice(-4)}</span>
                  <svg className={`w-3 h-3 text-surface-400 transition-transform ${showDropdown ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              {showDropdown && (
                <div className="absolute right-0 mt-1 w-48 bg-[#0c0c0c] border border-[rgba(255,255,255,0.06)] p-1 animate-fade-in z-50">
                  <Link href="/profile" onClick={() => setShowDropdown(false)}
                    className="flex items-center gap-3 w-full px-3 py-2.5 font-mono text-sm text-surface-300 hover:text-[#ff8512] hover:bg-[#141414] transition-colors">
                    <span className="text-[10px]">→</span> Profile
                  </Link>
                  <Link href="/send" onClick={() => setShowDropdown(false)}
                    className="flex items-center gap-3 w-full px-3 py-2.5 font-mono text-sm text-surface-300 hover:text-[#ff8512] hover:bg-[#141414] transition-colors">
                    <span className="text-[10px]">→</span> Send
                  </Link>
                  <Link href="/dashboard" onClick={() => setShowDropdown(false)}
                    className="flex items-center gap-3 w-full px-3 py-2.5 font-mono text-sm text-surface-300 hover:text-[#ff8512] hover:bg-[#141414] transition-colors">
                    <span className="text-[10px]">→</span> Dashboard
                  </Link>
                  <div className="h-px bg-[rgba(255,255,255,0.06)] my-1" />
                  <button onClick={() => { disconnect(); setShowDropdown(false); }}
                    className="flex items-center gap-3 w-full px-3 py-2.5 font-mono text-sm text-surface-500 hover:text-red-400 hover:bg-[#141414] transition-colors">
                    <span className="text-[10px]">×</span> Disconnect
                  </button>
                </div>
              )}
              </div>
            </div>
          ) : (
            <ConnectButton.Custom>
              {({ openConnectModal, mounted }) => (
                <button onClick={openConnectModal} disabled={!mounted} className="btn-primary text-xs py-2.5 px-5">Connect</button>
              )}
            </ConnectButton.Custom>
          )}
        </div>
      </div>
    </nav>
  );
}
