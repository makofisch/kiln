import { useEffect, useRef } from 'react';
import { MARK, MARK_COLORS } from '../../shared/brand.ts';
import { reducedMotion } from './theme.ts';

/**
 * The Kiln mark drawn as pixels. `working`: the cube turns into pixels that each drop a little,
 * in a slow wave across the cube, hang for a moment, spring back into place, and drop again.
 * `intro`: the pixels settle in from just above, once. Otherwise it is still.
 */

type Pt = [number, number];
type Mode = 'working' | 'intro' | 'still';

interface Seed {
  hx: number; // home, in cells
  hy: number;
  color: string;
  bright: string;
  delay: number; // when this pixel starts its drop within the cycle (s)
  drop: number; // how far it falls (cells)
  sway: number;
}

interface Pixel extends Seed {
  x: number;
  y: number;
  moving: boolean;
}

const hexToRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i]! - v) * t));
const css = (c: number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;
const TOP_A = hexToRgb(MARK_COLORS.topFrom);
const TOP_B = hexToRgb(MARK_COLORS.topTo);

function inside(poly: Pt[], x: number, y: number) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]!;
    const [bx, by] = poly[(i + 1) % poly.length]!;
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c !== 0) {
      if (!sign) sign = Math.sign(c);
      else if (Math.sign(c) !== sign) return false;
    }
  }
  return true;
}

// A small deterministic random, so every instance of a size animates the same way.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const cache = new Map<number, Seed[]>();

function build(g: number): Seed[] {
  const hit = cache.get(g);
  if (hit) return hit;
  const r = rng(7 + g);
  const out: Seed[] = [];
  for (let row = 0; row < g; row++) {
    for (let c = 0; c < g; c++) {
      // Supersample the cell (4×4) in the mark's 32×32 space and keep the face covering most of it,
      // so faces and the seams between them stay crisp at small sizes.
      const hits = { core: 0, top: 0, left: 0, right: 0 };
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const x = ((c + (sx + 0.5) / 4) / g) * 32;
          const y = ((row + (sy + 0.5) / 4) / g) * 32;
          if (inside(MARK.core, x, y)) hits.core++;
          else if (inside(MARK.top, x, y)) hits.top++;
          else if (inside(MARK.left, x, y)) hits.left++;
          else if (inside(MARK.right, x, y)) hits.right++;
        }
      }
      const [face, n] = (Object.entries(hits) as Array<[keyof typeof hits, number]>).sort((a, b) => b[1] - a[1])[0]!;
      if (n < 6) continue;
      const cy = ((row + 0.5) / g) * 32;
      let color =
        face === 'core' && hits.core >= 4
          ? hexToRgb(MARK_COLORS.core)
          : face === 'left'
            ? hexToRgb(MARK_COLORS.left)
            : face === 'right'
              ? hexToRgb(MARK_COLORS.right)
              : mix(TOP_A, TOP_B, Math.min(1, Math.max(0, (cy - 4) / 11)));
      // A touch of per-pixel shade variation: reads as pixel art rather than a flat fill.
      const v = (r() - 0.5) * 0.12;
      color = v > 0 ? mix(color, [255, 255, 255], v) : mix(color, [0, 0, 0], -v);
      out.push({
        hx: c,
        hy: row,
        color: css(color),
        bright: css(mix(color, [255, 240, 214], 0.3)),
        // A wave that rolls across the cube (left to right, lower rows a beat earlier).
        delay: (c / g) * 0.47 + ((g - row) / g) * 0.14 + r() * 0.07,
        drop: g * (0.08 + r() * 0.12),
        sway: (r() - 0.5) * 0.5,
      });
    }
  }
  cache.set(g, out);
  return out;
}

// Brisk on purpose: it should feel like fast work. The cube stays pixelated while working and a new
// wave rolls through every CYCLE seconds.
const CYCLE = 1.5;
const PIXELATE_AT = 0.12;
const WAVE_AT = 0.16;
const FALL = 0.2;
const HANG = 0.06;
const RISE = 0.36;
const GAP = 0.14;

const easeOutBack = (t: number) => {
  const c1 = 1.7;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

export function PixelMark({ size = 28, working = false, intro = false, className = '', grid }: { size?: number; working?: boolean; intro?: boolean; className?: string; grid?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef<Mode>(working ? 'working' : intro ? 'intro' : 'still');
  modeRef.current = working ? 'working' : modeRef.current === 'intro' && intro ? 'intro' : 'still';

  useEffect(() => {
    const canvas = ref.current!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const ctx = canvas.getContext('2d')!;
    const g = grid ?? (size >= 64 ? 22 : size >= 36 ? 16 : Math.max(8, Math.floor(size / 2)));
    const seeds = build(g);
    // The cube sits a little high in the square, leaving room below for the drop.
    const cell = (size * dpr) / (g * 1.1);
    const ox = (size * dpr - g * cell) / 2;
    const maxDrop = g * 0.2;
    const px: Pixel[] = seeds.map((s) => ({ ...s, x: s.hx, y: s.hy, moving: false }));
    let raf = 0;
    let start = performance.now();
    let settleFrom: { t: number; pos: Array<[number, number]> } | null = null;
    let introDone = modeRef.current !== 'intro';

    const draw = (gap: number, glow: boolean) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const s = cell * (1 - gap);
      const off = (cell - s) / 2;
      for (const p of px) {
        const fallen = Math.max(0, p.y - p.hy);
        ctx.globalAlpha = 1 - 0.4 * Math.min(1, fallen / maxDrop);
        ctx.fillStyle = glow && p.moving ? p.bright : p.color;
        ctx.fillRect(ox + p.x * cell + off, p.y * cell + off, s, s);
      }
      ctx.globalAlpha = 1;
    };

    const frame = (now: number) => {
      const mode = modeRef.current;
      const t = (now - start) / 1000;
      if (mode === 'working' && reducedMotion()) {
        for (const p of px) {
          p.x = p.hx;
          p.y = p.hy;
          p.moving = false;
        }
        draw(0, false);
        raf = 0;
        return;
      }
      if (mode === 'working') {
        settleFrom = null;
        const c = t < WAVE_AT ? t : WAVE_AT + ((t - WAVE_AT) % CYCLE);
        const gap = Math.min(1, t / PIXELATE_AT) * GAP;
        for (const p of px) {
          const u = c - WAVE_AT - p.delay;
          if (u <= 0 || u >= FALL + HANG + RISE) {
            p.x = p.hx;
            p.y = p.hy;
            p.moving = false;
          } else if (u < FALL) {
            const k = u / FALL;
            p.y = p.hy + p.drop * k * k; // accelerating, like a short fall
            p.x = p.hx + Math.sin(k * Math.PI * 0.5) * p.sway * 0.4;
            p.moving = true;
          } else if (u < FALL + HANG) {
            p.y = p.hy + p.drop;
            p.x = p.hx + p.sway * 0.4;
            p.moving = false;
          } else {
            const e = easeOutBack((u - FALL - HANG) / RISE);
            p.y = p.hy + p.drop * (1 - e);
            p.x = p.hx + p.sway * 0.4 * (1 - e);
            p.moving = true;
          }
        }
        draw(gap, true);
        raf = requestAnimationFrame(frame);
        return;
      }
      if (mode === 'intro' && !introDone) {
        let done = true;
        for (const p of px) {
          const k = clamp01((t - p.delay * 0.6) / 0.55);
          if (k < 1) done = false;
          const e = easeOutBack(k);
          p.y = p.hy - maxDrop * 1.5 * (1 - e);
          p.x = p.hx;
          p.moving = k > 0 && k < 1;
        }
        draw(done ? 0 : GAP, false);
        if (done) introDone = true;
        raf = requestAnimationFrame(frame);
        return;
      }
      // Still: glide any displaced pixels home and close the gaps, then stop drawing.
      if (!settleFrom) settleFrom = { t: now, pos: px.map((p) => [p.x, p.y]) };
      const k = clamp01((now - settleFrom.t) / 380);
      const e = easeOutBack(k);
      px.forEach((p, i) => {
        const [x0, y0] = settleFrom!.pos[i]!;
        p.x = x0 + (p.hx - x0) * e;
        p.y = y0 + (p.hy - y0) * e;
        p.moving = false;
      });
      draw(GAP * (1 - k), false);
      raf = k < 1 ? requestAnimationFrame(frame) : 0;
    };

    const kick = () => {
      if (!raf) {
        start = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    kick();
    const poll = setInterval(() => {
      if (!raf && modeRef.current === 'working') kick();
    }, 200);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(poll);
    };
  }, [size, grid]);

  return <canvas ref={ref} className={`pixel-mark${working ? ' working' : ''} ${className}`} style={{ width: size, height: size }} aria-hidden="true" />;
}
