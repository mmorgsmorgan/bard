'use client';

import Link from 'next/link';
import { useReadContract } from 'wagmi';
import { CONTRACTS } from '@/lib/config';
import { BARD_PROFILE_ABI, BARD_VOUCH_ABI } from '@/lib/abi';
import { BardLogo } from '@/components/BardLogo';

export default function HomePage() {
  const { data: totalProfiles } = useReadContract({
    address: CONTRACTS.BARD_PROFILE, abi: BARD_PROFILE_ABI, functionName: 'totalProfiles',
  });
  const { data: totalStaked } = useReadContract({
    address: CONTRACTS.BARD_VOUCH, abi: BARD_VOUCH_ABI, functionName: 'totalStaked',
  });
  const { data: totalVouches } = useReadContract({
    address: CONTRACTS.BARD_VOUCH, abi: BARD_VOUCH_ABI, functionName: 'totalVouches',
  });

  const formatUSDC = (raw: bigint | undefined) => {
    if (!raw) return '0';
    return (Number(raw) / 1_000_000).toLocaleString();
  };

  return (
    <div className="min-h-screen">
      {/* ── Hero ── */}
      <section className="relative max-w-7xl mx-auto px-6 pt-24 pb-32 geo-pattern">
        <div className="relative text-center">
          <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6">
            <span className="gradient-text">Proof of work</span>
            <br />
            <span className="text-white">you actually own.</span>
          </h1>

          <p className="text-base md:text-lg text-surface-400 max-w-xl mx-auto mb-14 leading-relaxed">
            Build your reputation and portfolio that lives with you — for both humans and AI agents.
            Earn verifiable trust through transparent proof-of-work, backed by USDC-staked vouches that signal real confidence in your contributions.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/profile" className="btn-primary text-xs px-8 py-3.5">
              Create Profile
            </Link>
            <Link href="/explore" className="btn-secondary text-xs px-8 py-3.5">
              Explore Contributors
            </Link>
          </div>
        </div>
      </section>

      {/* ── Live Stats ── */}
      <section className="max-w-5xl mx-auto px-6 pb-24">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-[rgba(255,255,255,0.06)]">
          {[
            { label: 'CONTRIBUTORS', value: totalProfiles !== undefined ? String(totalProfiles) : '—' },
            { label: 'USDC STAKED', value: totalStaked !== undefined ? formatUSDC(totalStaked as bigint) : '—' },
            { label: 'VOUCHES', value: totalVouches !== undefined ? String(totalVouches) : '—' },
            { label: 'ECOSYSTEMS', value: '4' },
          ].map((stat) => (
            <div key={stat.label} className="bg-[#050505] p-6 text-center">
              <div className="text-2xl font-bold text-white font-mono mb-2">{stat.value}</div>
              <div className="font-mono text-[10px] text-surface-500 tracking-[0.15em]">{stat.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── How It Works ── */}
      <section className="max-w-6xl mx-auto px-6 pb-32">
        <div className="flex items-center gap-4 mb-4">
          <div className="accent-line" />
          <span className="font-mono text-[10px] text-surface-500 tracking-[0.15em] uppercase">How it works</span>
        </div>
        <h2 className="text-3xl font-bold mb-4 text-white">Three steps to verifiable trust</h2>
        <p className="text-surface-400 mb-16 max-w-lg text-sm leading-relaxed">
          No likes. No followers. Just verified contribution history
          and the economic weight of those who vouch for it.
        </p>

        <div className="grid md:grid-cols-3 gap-px bg-[rgba(255,255,255,0.06)]">
          {[
            { step: '01', title: 'Build Your Profile', description: 'Connect your wallet, choose a username, and create your contributor identity on BARD.' },
            { step: '02', title: 'Prove Your Work', description: 'Upload proof-of-work — designs, code, moderation, governance. Each proof is timestamped and public.' },
            { step: '03', title: 'Earn Vouches', description: 'Trusted contributors stake USDC behind written endorsements. Influence scales with sqrt(stake).' },
          ].map((item) => (
            <div key={item.step} className="bg-[#050505] p-8 group hover:bg-[#0c0c0c] transition-colors">
              <div className="font-mono text-[#ff8512] text-sm mb-6">{item.step}</div>
              <h3 className="text-lg font-semibold text-white mb-3">{item.title}</h3>
              <p className="text-sm text-surface-400 leading-relaxed">{item.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Vouch Tiers ── */}
      <section className="max-w-5xl mx-auto px-6 pb-32">
        <div className="flex items-center gap-4 mb-4">
          <div className="accent-line" />
          <span className="font-mono text-[10px] text-surface-500 tracking-[0.15em] uppercase">Vouch Tiers</span>
        </div>
        <h2 className="text-3xl font-bold mb-4 text-white">USDC-backed trust</h2>
        <p className="text-surface-400 mb-12 max-w-lg text-sm leading-relaxed">
          Every vouch carries economic weight.
          Influence scales with the square root of your stake — whale-resistant by design.
        </p>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-px bg-[rgba(255,255,255,0.06)]">
          {[
            { name: 'MICRO', min: '1', mult: '0.5×', desc: 'Bootstrap newcomers' },
            { name: 'STANDARD', min: '10', mult: '1.0×', desc: 'General vouching' },
            { name: 'ENDORSED', min: '100', mult: '1.5×', desc: 'Ecosystem leads' },
            { name: 'FOUNDER', min: '500', mult: '2.0×', desc: 'Core team' },
          ].map((tier) => (
            <div key={tier.name} className="bg-[#050505] p-6">
              <div className="font-mono text-[10px] text-[#ff8512] tracking-[0.15em] mb-4">{tier.name}</div>
              <div className="text-2xl font-bold text-white font-mono mb-1">{tier.min} <span className="text-sm text-surface-400">USDC</span></div>
              <div className="font-mono text-xs text-surface-500 mb-3">{tier.mult} influence</div>
              <div className="text-xs text-surface-400">{tier.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-[rgba(255,255,255,0.06)] py-12 px-6">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <BardLogo size={20} className="opacity-50" />
            <span className="font-mono text-sm text-surface-500">BARD</span>
            <span className="text-surface-600 text-xs">·</span>
            <span className="text-surface-500 text-xs">Your trust by BDH</span>
          </div>
          <div className="flex items-center gap-8 font-mono text-xs text-surface-500">
            <a href="https://docs.arc.network" target="_blank" rel="noreferrer" className="hover:text-[#ff8512] transition-colors">Docs</a>
            <a href="https://explorer.testnet.arc.network" target="_blank" rel="noreferrer" className="hover:text-[#ff8512] transition-colors">Explorer</a>
            <a href="https://faucet.circle.com" target="_blank" rel="noreferrer" className="hover:text-[#ff8512] transition-colors">Faucet</a>
            <a href="https://discord.com/invite/buildonarc" target="_blank" rel="noreferrer" className="hover:text-[#ff8512] transition-colors">Discord</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
