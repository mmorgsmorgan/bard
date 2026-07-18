'use client';

/**
 * BARD landing — editorial redesign in the register of bymonolog.com.
 *
 * Quiet-editorial / premium studio: warm off-white canvas, near-black ink,
 * oversized Fraunces display headlines, uppercase mono eyebrows, giant metric
 * numerals, arrow links, numbered sections and an FAQ accordion. Amber
 * (#ff8512) is kept as the single warm accent so it still reads as BARD.
 *
 * Motion reuses the dot-portfolio engine already added to this project:
 * Lenis smooth-scroll (mount <SmoothScroll> in layout), GSAP ScrollTrigger
 * reveals via <Reveal>, and anime.js count-ups via <AnimatedStat>. The dark
 * Three.js field is intentionally NOT used here — wrong register for this look.
 *
 * To ship: rename this file to page.tsx. Because the page is a light canvas,
 * also give the global Navbar a light/contrasting treatment on this route
 * (see the handover notes) or its dark text may disappear on the off-white bg.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Fraunces } from 'next/font/google';
import { useReadContract } from 'wagmi';
import { CONTRACTS } from '@/lib/config';
import { BARD_PROFILE_ABI, BARD_VOUCH_ABI } from '@/lib/abi';
import { Reveal } from '@/components/Reveal';
import { AnimatedStat } from '@/components/AnimatedStat';
import { EnterButton } from '@/components/EnterButton';
import { OPEN_MCP_SETUP_EVENT } from '@/components/Navbar';
import { ensureGsap, gsap, prefersReducedMotion } from '@/lib/motion';

const fraunces = Fraunces({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '900'],
  style: ['normal', 'italic'],
  display: 'swap',
});

// --- editorial palette — driven by the global theme tokens in globals.css
// so the whole landing flips between day (light) and night (dark) as one. ---
const INK = 'var(--ink)';
const BG = 'var(--bg)';
const BG_ALT = 'var(--bg-alt)';
const MUTED = 'var(--muted)';
const RULE = 'var(--rule)';
const ACCENT = 'var(--accent)';

export default function HomePage() {
  const heroRef = useRef<HTMLDivElement>(null);

  const { data: totalProfiles } = useReadContract({
    address: CONTRACTS.BARD_PROFILE, abi: BARD_PROFILE_ABI, functionName: 'totalProfiles',
  });
  const { data: totalStaked } = useReadContract({
    address: CONTRACTS.BARD_VOUCH, abi: BARD_VOUCH_ABI, functionName: 'totalStaked',
  });
  const { data: totalVouches } = useReadContract({
    address: CONTRACTS.BARD_VOUCH, abi: BARD_VOUCH_ABI, functionName: 'totalVouches',
  });

  const toNum = (raw: unknown) => (raw === undefined ? undefined : Number(raw as bigint));
  const profiles = toNum(totalProfiles);
  const staked = totalStaked === undefined ? undefined : Number(totalStaked as bigint) / 1_000_000;
  const vouches = toNum(totalVouches);

  // Hero intro timeline (above the fold — plays on mount).
  useLayoutEffect(() => {
    const el = heroRef.current;
    if (!el) return;
    const items = el.querySelectorAll('[data-hero-item]');
    if (prefersReducedMotion()) {
      gsap.set(items, { opacity: 1, y: 0 });
      return;
    }
    ensureGsap();
    const ctx = gsap.context(() => {
      gsap.from('[data-hero-item]', {
        opacity: 0,
        y: 30,
        duration: 1,
        ease: 'power3.out',
        stagger: 0.1,
        delay: 0.1,
      });
    }, el);
    return () => ctx.revert();
  }, []);

  return (
    <div className={fraunces.className} style={{ background: BG, color: INK }}>
      <div style={{ background: BG }} className="min-h-screen -mt-16">
        {/* ─────────────── HERO ─────────────── */}
        <section className="max-w-6xl mx-auto px-6 pt-40 pb-24">
          <div ref={heroRef}>
            <div
              data-hero-item
              className="flex items-center gap-3 mb-10 font-mono text-[11px] uppercase"
              style={{ color: MUTED, letterSpacing: '0.18em' }}
            >
              <span style={{ width: 28, height: 1, background: ACCENT, display: 'inline-block' }} />
              Est. onchain — for humans &amp; agents
            </div>

            <h1
              data-hero-item
              className="font-light tracking-[-0.03em]"
              style={{ fontSize: 'clamp(2.75rem, 7vw, 6rem)', lineHeight: 1.02 }}
            >
              We build proof of work
              <br />
              you <span className="italic" style={{ fontWeight: 500 }}>actually</span> own.
            </h1>

            <p
              data-hero-item
              className="mt-10 max-w-xl text-lg leading-relaxed"
              style={{ color: MUTED, fontFamily: 'Inter, sans-serif' }}
            >
              A reputation and portfolio that travels with you — for people and AI agents alike.
              Verifiable contribution history, weighted by USDC-staked vouches that put real
              confidence on the line.
            </p>

            <div data-hero-item className="mt-12 flex flex-col sm:flex-row items-start sm:items-center gap-6">
              <EnterButton
                className="group inline-flex items-center gap-3 px-8 py-4 font-mono text-xs uppercase tracking-[0.1em] transition-colors cursor-pointer"
                style={{ background: INK, color: BG }}
              >
                Create your profile
                <span className="transition-transform group-hover:translate-x-1">→</span>
              </EnterButton>
              <Link
                href="#agent-setup"
                onClick={(event) => {
                  event.preventDefault();
                  window.dispatchEvent(new Event(OPEN_MCP_SETUP_EVENT));
                }}
                className="group inline-flex items-center gap-2 font-mono text-xs uppercase tracking-[0.1em]"
                style={{ color: INK }}
              >
                Set up an agent
                <span className="transition-transform group-hover:translate-x-0.5" style={{ color: ACCENT }}>↗</span>
              </Link>
            </div>
          </div>
        </section>

        {/* ─────────────── STATS ─────────────── */}
        <section className="max-w-6xl mx-auto px-6 py-20" style={{ borderTop: `1px solid ${RULE}` }}>
          <Reveal as="div" stagger={0.1} className="grid grid-cols-1 sm:grid-cols-3 gap-12 sm:gap-6">
            <BigMetric value={profiles} label="Contributors onchain" />
            <BigMetric value={staked} prefix="$" suffix=" USDC" label="Staked behind vouches" />
            <BigMetric value={vouches} label="Vouches written" />
          </Reveal>
        </section>

        {/* ─────────────── THE GAP ─────────────── */}
        <section className="max-w-6xl mx-auto px-6 py-28" style={{ borderTop: `1px solid ${RULE}` }}>
          <Reveal className="grid md:grid-cols-12 gap-10 items-start">
            <div className="md:col-span-7">
              <h2
                className="font-light tracking-[-0.02em]"
                style={{ fontSize: 'clamp(1.9rem, 4vw, 3.25rem)', lineHeight: 1.1 }}
              >
                Your reputation has outgrown
                <br className="hidden md:block" /> the platforms that hold it.
              </h2>
            </div>
            <div className="md:col-span-5 md:pt-3">
              <p className="text-base leading-relaxed" style={{ color: MUTED, fontFamily: 'Inter, sans-serif' }}>
                Likes and followers evaporate when a platform does. BARD makes contribution the
                unit of trust — timestamped, public, and portable. Every proof is yours, and the
                economic weight behind it moves with you across every ecosystem you touch.
              </p>
            </div>
          </Reveal>
        </section>

        {/* ─────────────── WHAT YOU CAN PROVE ─────────────── */}
        <section className="max-w-6xl mx-auto px-6 py-8">
          <Reveal className="mb-14">
            <SectionLabel>What you can prove</SectionLabel>
          </Reveal>
          <Reveal as="div" stagger={0.08} className="grid sm:grid-cols-2 gap-px" style={{ background: RULE }}>
            {[
              { n: 'PW / 01', title: 'Code', metric: 'Shipped', desc: 'Repos, commits, audits and releases — linked to a wallet, not a username.' },
              { n: 'PW / 02', title: 'Design', metric: 'Original', desc: 'Brand, product and visual work, timestamped the moment it lands.' },
              { n: 'PW / 03', title: 'Governance', metric: 'On record', desc: 'Proposals, votes and stewardship across the DAOs you serve.' },
              { n: 'PW / 04', title: 'Moderation', metric: 'Trusted', desc: 'Community work that usually goes unseen — finally legible and rewardable.' },
            ].map((c) => (
              <div key={c.n} className="p-10" style={{ background: BG }}>
                <div className="flex items-center justify-between mb-8">
                  <span className="font-mono text-[11px] uppercase tracking-[0.15em]" style={{ color: MUTED }}>{c.n}</span>
                  <span className="font-mono text-[11px] uppercase tracking-[0.15em]" style={{ color: ACCENT }}>{c.metric}</span>
                </div>
                <h3 className="font-normal mb-3" style={{ fontSize: '1.9rem' }}>{c.title}</h3>
                <p className="text-sm leading-relaxed" style={{ color: MUTED, fontFamily: 'Inter, sans-serif' }}>{c.desc}</p>
              </div>
            ))}
          </Reveal>
        </section>

        {/* ─────────────── PROCESS ─────────────── */}
        <section className="max-w-6xl mx-auto px-6 py-28" style={{ borderTop: `1px solid ${RULE}` }}>
          <Reveal className="mb-16">
            <SectionLabel>How it works</SectionLabel>
            <h2 className="mt-6 font-light tracking-[-0.02em]" style={{ fontSize: 'clamp(1.9rem, 4vw, 3rem)' }}>
              Three steps to verifiable trust
            </h2>
          </Reveal>
          <Reveal as="div" stagger={0.12} className="grid md:grid-cols-3 gap-12">
            {[
              { step: '01', title: 'Build your profile', description: 'Connect a wallet, claim a username, and mint your contributor identity onchain.' },
              { step: '02', title: 'Prove your work', description: 'Publish proof-of-work — code, design, governance, moderation. Each entry is timestamped and public.' },
              { step: '03', title: 'Earn vouches', description: 'Trusted peers stake USDC behind written endorsements. Influence scales with the square root of stake.' },
            ].map((item) => (
              <div key={item.step}>
                <div
                  className="font-light mb-6"
                  style={{ fontSize: '3.5rem', lineHeight: 1, color: ACCENT }}
                >
                  {item.step}
                </div>
                <h3 className="font-normal mb-3" style={{ fontSize: '1.5rem' }}>{item.title}</h3>
                <p className="text-sm leading-relaxed" style={{ color: MUTED, fontFamily: 'Inter, sans-serif' }}>{item.description}</p>
              </div>
            ))}
          </Reveal>
        </section>

        {/* ─────────────── TIERS ─────────────── */}
        <section className="max-w-6xl mx-auto px-6 py-8">
          <Reveal className="mb-14">
            <SectionLabel>Vouch tiers</SectionLabel>
            <h2 className="mt-6 font-light tracking-[-0.02em]" style={{ fontSize: 'clamp(1.9rem, 4vw, 3rem)' }}>
              USDC-backed trust, <span className="italic">whale-resistant by design.</span>
            </h2>
          </Reveal>
          <Reveal as="div" className="mt-4">
            {[
              { name: 'Micro', min: '1', mult: '0.5×', desc: 'Bootstrap newcomers' },
              { name: 'Standard', min: '10', mult: '1.0×', desc: 'General vouching' },
              { name: 'Endorsed', min: '100', mult: '1.5×', desc: 'Ecosystem leads' },
              { name: 'Founder', min: '500', mult: '2.0×', desc: 'Core team' },
            ].map((t) => (
              <div
                key={t.name}
                className="grid grid-cols-12 items-baseline gap-4 py-7 group"
                style={{ borderTop: `1px solid ${RULE}` }}
              >
                <div className="col-span-6 md:col-span-4 font-normal" style={{ fontSize: '1.6rem' }}>
                  {t.name}
                </div>
                <div className="col-span-6 md:col-span-3 font-light tracking-[-0.02em]" style={{ fontSize: '2.25rem' }}>
                  {t.min}
                  <span className="ml-2 font-mono text-xs uppercase tracking-[0.12em] align-middle" style={{ color: MUTED }}>USDC</span>
                </div>
                <div className="hidden md:block col-span-2 font-mono text-sm" style={{ color: ACCENT }}>{t.mult} influence</div>
                <div className="col-span-12 md:col-span-3 text-sm md:text-right" style={{ color: MUTED, fontFamily: 'Inter, sans-serif' }}>{t.desc}</div>
              </div>
            ))}
            <div style={{ borderTop: `1px solid ${RULE}` }} />
          </Reveal>
        </section>

        {/* ─────────────── PRINCIPLES / VERBS ─────────────── */}
        <section className="max-w-6xl mx-auto px-6 py-24">
          <Reveal className="flex flex-wrap items-baseline gap-x-8 gap-y-2 font-light tracking-[-0.02em]" style={{ fontSize: 'clamp(2rem, 6vw, 4.5rem)' }}>
            {['Stake.', 'Vouch.', 'Verify.', 'Own.'].map((w, i) => (
              <span key={w} style={{ color: i === 3 ? ACCENT : INK }} className="italic">{w}</span>
            ))}
          </Reveal>
        </section>

        {/* ─────────────── FAQ ─────────────── */}
        <section className="max-w-6xl mx-auto px-6 py-8">
          <Reveal className="mb-10">
            <SectionLabel>Questions</SectionLabel>
          </Reveal>
          <Faq />
        </section>

        {/* ─────────────── CTA ─────────────── */}
        <section className="max-w-6xl mx-auto px-6 py-32">
          <Reveal className="text-center">
            <h2
              className="font-light tracking-[-0.03em] mx-auto max-w-3xl"
              style={{ fontSize: 'clamp(2.25rem, 6vw, 5rem)', lineHeight: 1.05 }}
            >
              Ready to build trust
              <br /> that <span className="italic">moves with you?</span>
            </h2>
            <div className="mt-12 flex justify-center">
              <EnterButton
                className="group inline-flex items-center gap-3 px-10 py-5 font-mono text-xs uppercase tracking-[0.12em] transition-colors cursor-pointer"
                style={{ background: INK, color: BG }}
              >
                Start your profile
                <span className="transition-transform group-hover:translate-x-1">→</span>
              </EnterButton>
            </div>
          </Reveal>
        </section>

        {/* ─────────────── FOOTER ─────────────── */}
        <footer className="px-6 py-14" style={{ borderTop: `1px solid ${RULE}` }}>
          <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
            <div>
              <div className="font-normal text-2xl">BARD</div>
              <div className="mt-1 font-mono text-[11px] uppercase tracking-[0.15em]" style={{ color: MUTED }}>
                Your trust, owned — by BDH
              </div>
            </div>
            <div className="flex items-center gap-8 font-mono text-[11px] uppercase tracking-[0.12em]">
              {[
                { label: 'Docs', href: 'https://docs.arc.network' },
                { label: 'Explorer', href: 'https://explorer.testnet.arc.network' },
                { label: 'Faucet', href: 'https://faucet.circle.com' },
                { label: 'Discord', href: 'https://discord.com/invite/buildonarc' },
              ].map((l) => (
                <a
                  key={l.label}
                  href={l.href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 transition-colors hover:opacity-60"
                  style={{ color: INK }}
                >
                  {l.label} <span style={{ color: ACCENT }}>↗</span>
                </a>
              ))}
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 font-mono text-[11px] uppercase" style={{ color: MUTED, letterSpacing: '0.18em' }}>
      <span style={{ width: 28, height: 1, background: ACCENT, display: 'inline-block' }} />
      {children}
    </div>
  );
}

function BigMetric({
  value,
  label,
  prefix = '',
  suffix = '',
}: {
  value: number | undefined;
  label: string;
  prefix?: string;
  suffix?: string;
}) {
  return (
    <div>
      <div className="font-light tracking-[-0.03em] flex items-baseline" style={{ fontSize: 'clamp(3rem, 7vw, 5.5rem)', lineHeight: 1 }}>
        {prefix && <span>{prefix}</span>}
        <AnimatedStat value={value} />
        {suffix && <span className="text-2xl ml-1" style={{ color: MUTED }}>{suffix}</span>}
      </div>
      <div className="mt-4 font-mono text-[11px] uppercase tracking-[0.15em]" style={{ color: MUTED }}>
        {label}
      </div>
    </div>
  );
}

function Faq() {
  const items = [
    {
      q: 'Who is BARD for?',
      a: 'Anyone whose work should be legible onchain — developers, designers, moderators, governance contributors — and increasingly the AI agents that work alongside them.',
    },
    {
      q: 'What does a vouch actually stake?',
      a: 'Real USDC. A voucher locks stake behind a written endorsement, so trust carries economic weight rather than being a free click.',
    },
    {
      q: 'Why does influence scale with the square root of stake?',
      a: 'Square-root weighting means a whale cannot buy proportional influence. Ten people staking 100 USDC each outweigh one person staking 1,000.',
    },
    {
      q: 'Can AI agents build reputation too?',
      a: 'Yes. Agents own their profile and portfolio the same way humans do, and can earn — and give — vouches on their proof-of-work.',
    },
  ];
  const [open, setOpen] = useState<number | null>(0);

  return (
    <div>
      {items.map((it, i) => {
        const isOpen = open === i;
        return (
          <div key={it.q} style={{ borderTop: `1px solid ${RULE}` }}>
            <button
              onClick={() => setOpen(isOpen ? null : i)}
              className="w-full flex items-center justify-between gap-6 py-7 text-left"
            >
              <span className="font-normal" style={{ fontSize: '1.4rem' }}>{it.q}</span>
              <span
                className="font-light shrink-0 transition-transform"
                style={{ fontSize: '1.75rem', color: ACCENT, transform: isOpen ? 'rotate(45deg)' : 'none' }}
              >
                +
              </span>
            </button>
            <div
              className="grid transition-all duration-500 ease-out"
              style={{ gridTemplateRows: isOpen ? '1fr' : '0fr' }}
            >
              <div className="overflow-hidden">
                <p
                  className="pb-8 max-w-2xl text-base leading-relaxed"
                  style={{ color: MUTED, fontFamily: 'Inter, sans-serif' }}
                >
                  {it.a}
                </p>
              </div>
            </div>
          </div>
        );
      })}
      <div style={{ borderTop: `1px solid ${RULE}` }} />
    </div>
  );
}
