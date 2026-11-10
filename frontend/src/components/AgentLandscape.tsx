'use client';

import { useEffect, useRef, useState } from 'react';
import { createCanvasLandscape, createWebGLLandscape } from '@/lib/particle-landscape';

/** One persistent, decorative surface shared by every public page. */
export function AgentLandscape() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const renderer = fallback ? createCanvasLandscape(canvas) : createWebGLLandscape(canvas);
    if (!renderer) {
      // A canvas cannot switch context types: the new key supplies a fresh one.
      if (!fallback) setFallback(true);
      return;
    }

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const interval = 1000 / renderer.fps;
    let frame = 0;
    let elapsed = 0;
    let previousTime = 0;
    let previousPaint = 0;
    let currentWidth = 0;
    let currentHeight = 0;
    let currentRatio = 0;

    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const animate = (now: number) => {
      if (document.hidden || motion.matches) { stop(); return; }
      elapsed += Math.min(now - previousTime, 100) / 1000;
      previousTime = now;
      const sincePaint = now - previousPaint;
      if (sincePaint >= interval - .5) {
        renderer.draw(elapsed);
        previousPaint = now - (sincePaint >= interval ? sincePaint % interval : 0);
      }
      frame = requestAnimationFrame(animate);
    };
    const resume = () => {
      stop();
      if (document.hidden) return;
      renderer.draw(elapsed);
      if (!motion.matches) {
        previousTime = previousPaint = performance.now();
        frame = requestAnimationFrame(animate);
      }
    };
    const resize = () => {
      const { width, height } = canvas.getBoundingClientRect();
      if (!width || !height) return;
      // Bound both high-DPI memory and the cost of full-viewport compositing.
      const ratio = Math.min(window.devicePixelRatio || 1, fallback ? 1.5 : 2, Math.sqrt(3_200_000 / (width * height)));
      if (width === currentWidth && height === currentHeight && ratio === currentRatio) return;
      currentWidth = width;
      currentHeight = height;
      currentRatio = ratio;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      renderer.resize(width, height, ratio);
      if (!document.hidden) renderer.draw(elapsed);
    };
    const contextLost = (event: Event) => {
      event.preventDefault();
      stop();
      setFallback(true);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    window.addEventListener('resize', resize, { passive: true });
    document.addEventListener('visibilitychange', resume);
    motion.addEventListener('change', resume);
    canvas.addEventListener('webglcontextlost', contextLost);
    resize();
    resume();

    return () => {
      stop();
      observer.disconnect();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', resume);
      motion.removeEventListener('change', resume);
      canvas.removeEventListener('webglcontextlost', contextLost);
      renderer.dispose();
    };
  }, [fallback]);

  return <div className="site-background" aria-hidden="true">
    <canvas key={fallback ? 'canvas' : 'webgl'} ref={ref} className="agent-landscape" />
  </div>;
}
