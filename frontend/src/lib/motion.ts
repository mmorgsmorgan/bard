'use client';

/**
 * Shared motion helpers for the BARD frontend.
 *
 * Same engine as the dot-portfolio: GSAP + ScrollTrigger driven off a single
 * Lenis instance. Registers ScrollTrigger exactly once and centralises the
 * reduced-motion check so every animated component honours it.
 */

import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/dist/ScrollTrigger';

let registered = false;

/** Register ScrollTrigger a single time (safe to call from any component). */
export function ensureGsap() {
  if (registered) return;
  gsap.registerPlugin(ScrollTrigger);
  registered = true;
}

/** True when the user has asked the OS to reduce motion, or during SSR. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export { gsap, ScrollTrigger };
