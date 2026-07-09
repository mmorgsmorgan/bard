'use client';

/**
 * Persistent Lenis smooth-scroll, wired to the GSAP ticker.
 *
 * Mirrors the dot-portfolio's initLenis(): one Lenis instance drives rAF via
 * gsap.ticker (lagSmoothing off) and pushes ScrollTrigger.update() on scroll,
 * so scroll-linked animations stay in sync with the eased scroll position.
 *
 * Under prefers-reduced-motion we skip Lenis entirely and fall back to native
 * scrolling — no smoothing, no rAF loop.
 */

import { useEffect } from 'react';
import type Lenis from 'lenis';
import { ensureGsap, gsap, ScrollTrigger, prefersReducedMotion } from '@/lib/motion';

export function SmoothScroll({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (prefersReducedMotion()) return;

    ensureGsap();

    let lenis: Lenis | null = null;
    let cancelled = false;

    // Dynamic import keeps Lenis out of the SSR/first-load critical path.
    import('lenis').then(({ default: LenisCtor }) => {
      if (cancelled) return;

      lenis = new LenisCtor({ lerp: 0.1, smoothWheel: true });
      lenis.on('scroll', ScrollTrigger.update);

      const raf = (time: number) => lenis?.raf(time * 1000);
      gsap.ticker.add(raf);
      gsap.ticker.lagSmoothing(0);

      // Store the ticker callback so cleanup can detach the exact reference.
      (lenis as Lenis & { _rafCb?: (t: number) => void })._rafCb = raf;
    });

    return () => {
      cancelled = true;
      if (lenis) {
        const raf = (lenis as Lenis & { _rafCb?: (t: number) => void })._rafCb;
        if (raf) gsap.ticker.remove(raf);
        lenis.destroy();
        lenis = null;
      }
    };
  }, []);

  return <>{children}</>;
}
