'use client';

/**
 * Count-up stat using anime.js (v4). Animates from 0 to `value` the first time
 * the element scrolls into view. If the on-chain value is still loading when
 * the element appears, it shows a placeholder and counts up once the value
 * resolves.
 *
 * Under prefers-reduced-motion it snaps straight to the final formatted value.
 */

import { useEffect, useRef, useState } from 'react';
import { animate } from 'animejs';
import { prefersReducedMotion } from '@/lib/motion';

type Props = {
  value: number | undefined;
  format?: (n: number) => string;
  placeholder?: string;
  className?: string;
  duration?: number;
};

export function AnimatedStat({
  value,
  format = (n) => Math.round(n).toLocaleString(),
  placeholder = '—',
  className = '',
  duration = 1400,
}: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const played = useRef(false);

  // Fire once the element enters the viewport.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { threshold: 0.4 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Count up when both visible and value is known.
  useEffect(() => {
    const el = ref.current;
    if (!el || !visible || value === undefined || played.current) return;
    played.current = true;

    if (prefersReducedMotion()) {
      el.textContent = format(value);
      return;
    }

    const state = { n: 0 };
    animate(state, {
      n: value,
      duration,
      ease: 'outExpo',
      onUpdate: () => {
        el.textContent = format(state.n);
      },
    });
  }, [visible, value, format, duration]);

  return (
    <span ref={ref} className={className}>
      {value === undefined ? placeholder : format(0)}
    </span>
  );
}
