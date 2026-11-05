import { useId } from 'react';
import { MARK, MARK_COLORS, markPath } from '../../shared/brand.ts';

/**
 * The Kiln mark. `working` animates it: the three faces light up in turn (reads as a slow spin)
 * and the fire at its core pulses. It is the app's "busy" indicator everywhere.
 */
export function KilnMark({ size = 20, working = false, glow = false, className = '' }: { size?: number; working?: boolean; glow?: boolean; className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={`kiln-mark${working ? ' working' : ''}${glow ? ' glow' : ''} ${className}`} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={`kt${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={MARK_COLORS.topFrom} />
          <stop offset="1" stopColor={MARK_COLORS.topTo} />
        </linearGradient>
      </defs>
      <path className="km-left" d={markPath(MARK.left)} fill={MARK_COLORS.left} />
      <path className="km-right" d={markPath(MARK.right)} fill={MARK_COLORS.right} />
      <path className="km-top" d={markPath(MARK.top)} fill={`url(#kt${id})`} />
      <path className="km-core" d={markPath(MARK.core)} fill={MARK_COLORS.core} />
    </svg>
  );
}
