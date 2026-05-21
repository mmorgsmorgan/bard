import Image from 'next/image';

export function BardLogo({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <div className={className} style={{ width: size, height: size, flexShrink: 0, position: 'relative' }}>
      <Image
        src="/bard-logo.png"
        alt="BARD Logo"
        fill
        sizes={`${size}px`}
        className="object-contain"
        priority
      />
    </div>
  );
}

export function BardLogoBg({ className = '' }: { className?: string }) {
  return (
    <div className={className}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/bard-logo.png"
        alt=""
        className="w-full h-full object-contain"
      />
    </div>
  );
}
