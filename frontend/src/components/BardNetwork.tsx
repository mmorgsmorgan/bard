'use client';

/**
 * Ambient Three.js "reputation network" — drifting amber nodes with links
 * drawn between nearby nodes. Reads as an agent/contributor graph rather than
 * generic particles.
 *
 * - Three is imported lazily inside the effect so it never runs during SSR.
 * - Pauses the rAF loop when the tab is hidden (visibilitychange).
 * - Under prefers-reduced-motion it renders a single static frame.
 * - Pointer position applies a gentle parallax to the whole field.
 *
 * Drop it in as a fixed, low-opacity, pointer-events-none background layer.
 */

import { useEffect, useRef } from 'react';
import { prefersReducedMotion } from '@/lib/motion';

const ACCENT = 0xff8512; // bard-500
const NODE_COUNT = 90;
const LINK_DIST = 2.4; // world units — nodes closer than this get a link
const FIELD = 9; // half-extent of the node cloud

export function BardNetwork({ className = '' }: { className?: string }) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let disposed = false;
    let cleanup: (() => void) | null = null;

    import('three').then((THREE) => {
      if (disposed || !mount) return;

      const reduce = prefersReducedMotion();
      const width = mount.clientWidth;
      const height = mount.clientHeight;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 100);
      camera.position.z = 14;

      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(width, height);
      renderer.setClearColor(0x000000, 0);
      mount.appendChild(renderer.domElement);

      const group = new THREE.Group();
      scene.add(group);

      // --- nodes ---
      const positions = new Float32Array(NODE_COUNT * 3);
      const velocities = new Float32Array(NODE_COUNT * 3);
      for (let i = 0; i < NODE_COUNT; i++) {
        positions[i * 3] = (Math.random() - 0.5) * FIELD * 2;
        positions[i * 3 + 1] = (Math.random() - 0.5) * FIELD * 2;
        positions[i * 3 + 2] = (Math.random() - 0.5) * FIELD;
        velocities[i * 3] = (Math.random() - 0.5) * 0.006;
        velocities[i * 3 + 1] = (Math.random() - 0.5) * 0.006;
        velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.006;
      }

      const nodeGeo = new THREE.BufferGeometry();
      nodeGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const nodeMat = new THREE.PointsMaterial({
        color: ACCENT,
        size: 0.09,
        transparent: true,
        opacity: 0.9,
        sizeAttenuation: true,
      });
      const points = new THREE.Points(nodeGeo, nodeMat);
      group.add(points);

      // --- links (pre-allocated, capped) ---
      const maxLinks = NODE_COUNT * 6;
      const linkPositions = new Float32Array(maxLinks * 2 * 3);
      const linkGeo = new THREE.BufferGeometry();
      linkGeo.setAttribute('position', new THREE.BufferAttribute(linkPositions, 3));
      const linkMat = new THREE.LineBasicMaterial({
        color: ACCENT,
        transparent: true,
        opacity: 0.14,
      });
      const links = new THREE.LineSegments(linkGeo, linkMat);
      group.add(links);

      const rebuildLinks = () => {
        let n = 0;
        for (let i = 0; i < NODE_COUNT; i++) {
          const ax = positions[i * 3];
          const ay = positions[i * 3 + 1];
          const az = positions[i * 3 + 2];
          for (let j = i + 1; j < NODE_COUNT; j++) {
            const dx = ax - positions[j * 3];
            const dy = ay - positions[j * 3 + 1];
            const dz = az - positions[j * 3 + 2];
            if (dx * dx + dy * dy + dz * dz < LINK_DIST * LINK_DIST) {
              if (n + 6 > linkPositions.length) break;
              linkPositions[n++] = ax;
              linkPositions[n++] = ay;
              linkPositions[n++] = az;
              linkPositions[n++] = positions[j * 3];
              linkPositions[n++] = positions[j * 3 + 1];
              linkPositions[n++] = positions[j * 3 + 2];
            }
          }
        }
        linkGeo.setDrawRange(0, n / 3);
        linkGeo.attributes.position.needsUpdate = true;
      };

      // --- pointer parallax ---
      const target = { x: 0, y: 0 };
      const onPointer = (e: PointerEvent) => {
        target.x = (e.clientX / window.innerWidth - 0.5) * 0.6;
        target.y = (e.clientY / window.innerHeight - 0.5) * 0.6;
      };
      window.addEventListener('pointermove', onPointer);

      const onResize = () => {
        const w = mount.clientWidth;
        const h = mount.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      };
      window.addEventListener('resize', onResize);

      let raf = 0;
      let running = true;
      const tick = () => {
        if (!running) return;
        if (!reduce) {
          for (let i = 0; i < NODE_COUNT * 3; i++) {
            positions[i] += velocities[i];
          }
          // soft wrap inside the field box
          for (let i = 0; i < NODE_COUNT; i++) {
            for (let a = 0; a < 3; a++) {
              const idx = i * 3 + a;
              const bound = a === 2 ? FIELD / 2 : FIELD;
              if (positions[idx] > bound || positions[idx] < -bound) velocities[idx] *= -1;
            }
          }
          nodeGeo.attributes.position.needsUpdate = true;
          rebuildLinks();

          group.rotation.y += (target.x - group.rotation.y) * 0.03;
          group.rotation.x += (-target.y - group.rotation.x) * 0.03;
          group.rotation.z += 0.0006;
        }
        renderer.render(scene, camera);
        raf = requestAnimationFrame(tick);
      };

      rebuildLinks();
      renderer.render(scene, camera);
      if (!reduce) raf = requestAnimationFrame(tick);

      const onVisibility = () => {
        if (document.hidden) {
          running = false;
          cancelAnimationFrame(raf);
        } else if (!reduce) {
          running = true;
          raf = requestAnimationFrame(tick);
        }
      };
      document.addEventListener('visibilitychange', onVisibility);

      cleanup = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener('pointermove', onPointer);
        window.removeEventListener('resize', onResize);
        document.removeEventListener('visibilitychange', onVisibility);
        nodeGeo.dispose();
        nodeMat.dispose();
        linkGeo.dispose();
        linkMat.dispose();
        renderer.dispose();
        if (renderer.domElement.parentNode === mount) {
          mount.removeChild(renderer.domElement);
        }
      };
    });

    return () => {
      disposed = true;
      if (cleanup) cleanup();
    };
  }, []);

  return <div ref={mountRef} className={className} aria-hidden="true" />;
}
