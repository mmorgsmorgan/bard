'use client';

/**
 * Scroll-reveal wrapper — the dot-portfolio's [data-reveal] pattern in React.
 *
 * Direct children fade + rise into place as the block scrolls into view, with
 * an optional stagger. All animation lives inside a gsap.context scoped to this
 * element, so unmount cleans up its ScrollTriggers automatically.
 *
 * Under prefers-reduced-motion children are shown immediately (no transform).
 */

import { useLayoutEffect, useRef } from 'react';
import { ensureGsap, gsap, prefersReducedMotion } from '@/lib/motion';

type RevealProps = {
  children: React.ReactNode;
  className?: string;
  /** seconds between each child's start */
  stagger?: number;
  /** initial downward offset in px */
  y?: number;
  as?: 'div' | 'section' | 'ul';
  style?: React.CSSProperties;
};

export function Reveal({
  children,
  className = '',
  stagger = 0.08,
  y = 18,
  as = 'div',
  style,
}: RevealProps) {
  const ref = useRef<HTMLElement>(null);
  const Tag = as as React.ElementType;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (prefersReducedMotion()) {
      gsap.set(el.children, { opacity: 1, y: 0 });
      return;
    }

    ensureGsap();
    const ctx = gsap.context(() => {
      gsap.from(el.children, {
        opacity: 0,
        y,
        duration: 0.6,
        ease: 'power2.out',
        stagger,
        scrollTrigger: {
          trigger: el,
          start: 'top 82%',
          once: true,
        },
      });
    }, el);

    return () => ctx.revert();
  }, [stagger, y]);

  return (
    <Tag ref={ref} className={className} style={style}>
      {children}
    </Tag>
  );
}
