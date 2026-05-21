'use client';

import { BardLogoBg } from './BardLogo';

export function BackgroundBard() {
  return (
    <div
      className="fixed top-1/2 -translate-y-1/2 -right-[300px] z-0 pointer-events-none select-none opacity-[0.05]"
      aria-hidden="true"
    >
      <BardLogoBg className="w-[800px] h-[800px]" />
    </div>
  );
}
