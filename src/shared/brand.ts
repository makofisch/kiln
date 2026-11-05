// The Kiln mark: an isometric cube (the model) whose top face is a kiln opening with a glowing core.
// Coordinates in a 32×32 box. Used by the UI (KilnMark) and the app icon generator.

type Pt = [number, number];

export const MARK: Record<'top' | 'left' | 'right' | 'core', Pt[]> = {
  top: [
    [16, 4.25],
    [25.5, 9.75],
    [16, 15.25],
    [6.5, 9.75],
  ],
  left: [
    [5.85, 10.9],
    [15.35, 16.4],
    [15.35, 27.4],
    [5.85, 21.9],
  ],
  right: [
    [26.15, 10.9],
    [16.65, 16.4],
    [16.65, 27.4],
    [26.15, 21.9],
  ],
  core: [
    [16, 7.35],
    [20.15, 9.75],
    [16, 12.15],
    [11.85, 9.75],
  ],
};

export const MARK_COLORS = {
  topFrom: '#ffd88a',
  topTo: '#ffa94d',
  left: '#ff7a2f',
  right: '#cf4a1c',
  core: '#fff6df',
  glow: '#ff8a3d',
};

export const markPath = (pts: Pt[]) => `M${pts.map((p) => p.join(' ')).join('L')}Z`;
