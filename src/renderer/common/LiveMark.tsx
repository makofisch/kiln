import { useEffect, useState } from 'react';
import { KilnMark } from './KilnMark.tsx';
import { PixelMark } from './PixelMark.tsx';

/**
 * The Kiln mark that comes alive while something works: the crisp mark when idle, turning into the
 * falling-pixel animation while `working` (and settling back before it turns crisp again).
 */
export function LiveMark({ size = 22, working, glow = false }: { size?: number; working: boolean; glow?: boolean }) {
  const [pixels, setPixels] = useState(working);
  useEffect(() => {
    if (working) {
      setPixels(true);
      return;
    }
    const t = setTimeout(() => setPixels(false), 650);
    return () => clearTimeout(t);
  }, [working]);
  return <span className="live-mark" style={{ width: size, height: size }}>{pixels ? <PixelMark size={size} working={working} /> : <KilnMark size={size * 0.94} glow={glow} />}</span>;
}
