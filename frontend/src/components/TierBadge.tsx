'use client';

/**
 * TierBadge — Shows reputation tier with color coding.
 * Tiers: Newcomer (0-9), Contributor (10-29), Established (30-59), Trusted (60-84), Elite (85-100)
 */

const TIERS = [
  { name: 'Newcomer', min: 0, color: '#6b7280', bg: 'rgba(107,114,128,0.1)', border: 'rgba(107,114,128,0.2)', icon: '◇' },
  { name: 'Contributor', min: 10, color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.2)', icon: '◆' },
  { name: 'Established', min: 30, color: '#3b82f6', bg: 'rgba(59,130,246,0.1)', border: 'rgba(59,130,246,0.2)', icon: '⬡' },
  { name: 'Trusted', min: 60, color: '#10b981', bg: 'rgba(16,185,129,0.1)', border: 'rgba(16,185,129,0.2)', icon: '◎' },
  { name: 'Elite', min: 85, color: '#ff8512', bg: 'rgba(255,133,18,0.1)', border: 'rgba(255,133,18,0.25)', icon: '★' },
];

function getTier(score: number) {
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (score >= TIERS[i].min) return TIERS[i];
  }
  return TIERS[0];
}

export function TierBadge({ score, size = 'sm' }: { score: number; size?: 'xs' | 'sm' | 'md' | 'lg' }) {
  const tier = getTier(score);

  const sizes = {
    xs: { fontSize: '8px', padding: '1px 5px', iconSize: '8px' },
    sm: { fontSize: '9px', padding: '2px 8px', iconSize: '10px' },
    md: { fontSize: '11px', padding: '3px 10px', iconSize: '12px' },
    lg: { fontSize: '13px', padding: '4px 14px', iconSize: '14px' },
  };

  const s = sizes[size];

  return (
    <span
      className="font-mono uppercase tracking-wider inline-flex items-center gap-1 shrink-0"
      style={{
        fontSize: s.fontSize,
        padding: s.padding,
        color: tier.color,
        backgroundColor: tier.bg,
        border: `1px solid ${tier.border}`,
      }}
    >
      <span style={{ fontSize: s.iconSize }}>{tier.icon}</span>
      {tier.name}
    </span>
  );
}

export function TierDisplay({ score, size = 'md' }: { score: number; size?: 'sm' | 'md' | 'lg' }) {
  const tier = getTier(score);
  const progress = Math.min(100, score);
  const nextTier = TIERS.find(t => t.min > score);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <TierBadge score={score} size={size} />
        <span className="font-mono text-sm font-bold" style={{ color: tier.color }}>{score}</span>
      </div>
      {/* Progress bar */}
      <div className="h-1.5 bg-[#141414] w-full">
        <div
          className="h-full transition-all duration-500"
          style={{ width: `${progress}%`, backgroundColor: tier.color }}
        />
      </div>
      {nextTier && (
        <div className="font-mono text-[9px] text-surface-500">
          {nextTier.min - score} points to {nextTier.name}
        </div>
      )}
    </div>
  );
}

export { getTier, TIERS };
