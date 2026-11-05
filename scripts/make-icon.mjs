// Draws the Kiln app icon (build/icon.ico at 16–256 px, build/icon.png at 512 px) from the mark's
// geometry in src/shared/brand.ts: the glowing cube on a dark rounded square. No image libraries.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'build');
mkdirSync(OUT, { recursive: true });

// Read the geometry from brand.ts (kept in one place).
const src = readFileSync(join(root, 'src', 'shared', 'brand.ts'), 'utf8');
const face = (name) => {
  const block = new RegExp(`${name}: \\[([\\s\\S]*?)\\n  \\]`).exec(src)[1];
  return [...block.matchAll(/\[([\d.]+), ([\d.]+)\]/g)].map((m) => [Number(m[1]), Number(m[2])]);
};
const MARK = { top: face('top'), left: face('left'), right: face('right'), core: face('core') };
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const C = { topFrom: hex('#ffd88a'), topTo: hex('#ffa94d'), left: hex('#ff7a2f'), right: hex('#cf4a1c'), core: hex('#fff6df'), bg: hex('#101218'), bg2: hex('#191c24') };

function inside(poly, x, y) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c !== 0) {
      if (sign === 0) sign = Math.sign(c);
      else if (Math.sign(c) !== sign) return false;
    }
  }
  return true;
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function sample(u, v, size) {
  // Rounded-square background (u, v in 0..1).
  const r = 0.22;
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  if (Math.hypot(dx, dy) > r) return null;
  const small = size <= 32;
  // Background: a soft warm glow behind the cube.
  const d = Math.hypot(u - 0.5, v - 0.47);
  let c = mix(C.bg2, C.bg, Math.min(1, d * 1.6));
  const glow = Math.max(0, 1 - d / 0.42) ** 2 * (small ? 0.15 : 0.32);
  c = mix(c, [255, 122, 47], glow);
  // The mark, scaled to ~80% (larger at tiny sizes).
  const s = small ? 0.9 : 0.8;
  const x = ((u - 0.5) / s) * 32 + 16;
  const y = ((v - 0.5) / s) * 32 + 16.4;
  if (inside(MARK.core, x, y)) return C.core;
  if (inside(MARK.top, x, y)) return mix(C.topFrom, C.topTo, Math.min(1, Math.max(0, (y - 4) / 11)));
  if (inside(MARK.left, x, y)) return C.left;
  if (inside(MARK.right, x, y)) return C.right;
  return c;
}

function render(size) {
  const ss = 5;
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size, size);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a++;
        }
      }
      const i = (y * size + x) * 4;
      px[i] = a ? r / a : 0;
      px[i + 1] = a ? g / a : 0;
      px[i + 2] = a ? b / a : 0;
      px[i + 3] = (a / (ss * ss)) * 255;
    }
  }
  return px;
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const images = sizes.map((s) => png(s, render(s)));
writeFileSync(join(OUT, 'icon.png'), png(512, render(512)));

// ICO with PNG-compressed entries.
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const dir = images.map((img, i) => {
  const e = Buffer.alloc(16);
  const s = sizes[i];
  e[0] = s >= 256 ? 0 : s;
  e[1] = s >= 256 ? 0 : s;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(img.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += img.length;
  return e;
});
writeFileSync(join(OUT, 'icon.ico'), Buffer.concat([header, ...dir, ...images]));
console.log(`build/icon.ico (${sizes.join(', ')} px) and build/icon.png`);
