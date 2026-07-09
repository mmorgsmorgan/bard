'use client';

/**
 * Shared editorial primitives — the design language established on the landing page,
 * extracted so every interior page uses the SAME eyebrow / headline / rule rhythm.
 * Palette is theme-driven via CSS vars (flips day/night as one unit).
 */

import { Fraunces } from 'next/font/google';
import type { ReactNode, CSSProperties } from 'react';

const fraunces = Fraunces({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  style: ['normal', 'italic'],
  display: 'swap',
});

const MUTED = 'var(--muted)';
const ACCENT = 'var(--accent)';
const RULE = 'var(--rule)';

/** Uppercase mono eyebrow with a short amber rule — the section marker. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex items-center gap-3 font-mono text-[11px] uppercase"
      style={{ color: MUTED, letterSpacing: '0.18em' }}
    >
      <span style={{ width: 28, height: 1, background: ACCENT, display: 'inline-block' }} />
      {children}
    </div>
  );
}

/** Fraunces serif display headline. `italicWord` renders an emphasised italic span. */
export function Headline({
  children,
  size = 'clamp(2rem, 4.5vw, 3.5rem)',
  className = '',
  style,
}: {
  children: ReactNode;
  size?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <h1
      className={`${fraunces.className} font-light tracking-[-0.02em] ${className}`}
      style={{ fontSize: size, lineHeight: 1.05, ...style }}
    >
      {children}
    </h1>
  );
}

/** Italic emphasis word inside a Headline. */
export function Em({ children }: { children: ReactNode }) {
  return <span className={fraunces.className} style={{ fontStyle: 'italic' }}>{children}</span>;
}

/** Standard editorial page header: eyebrow + serif headline + muted lede. */
export function PageHeader({
  eyebrow,
  title,
  lede,
  action,
}: {
  eyebrow: string;
  title: ReactNode;
  lede?: string;
  action?: ReactNode;
}) {
  return (
    <header className="mb-12" style={{ borderBottom: `1px solid ${RULE}`, paddingBottom: '2rem' }}>
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div className="max-w-2xl">
          <SectionLabel>{eyebrow}</SectionLabel>
          <Headline className="mt-5">{title}</Headline>
          {lede && (
            <p className="mt-4 text-[0.95rem] leading-relaxed" style={{ color: MUTED }}>
              {lede}
            </p>
          )}
        </div>
        {action && <div className="shrink-0 pt-2">{action}</div>}
      </div>
    </header>
  );
}

export { fraunces };
