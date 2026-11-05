import type { Accent, UiSettings } from '../../shared/types.ts';

// Appearance settings, applied the same way in the tab strip and in every tab.

export const ACCENT_COLORS: Record<Accent, { name: string; a: string; b: string; rgb: string; rgb2: string }> = {
  ember: { name: 'Ember', a: '#ff7a2f', b: '#ffb454', rgb: '255, 122, 47', rgb2: '255, 180, 84' },
  violet: { name: 'Violet', a: '#9a7bff', b: '#c9b8ff', rgb: '154, 123, 255', rgb2: '201, 184, 255' },
  ocean: { name: 'Ocean', a: '#3a9cff', b: '#86c8ff', rgb: '58, 156, 255', rgb2: '134, 200, 255' },
  jade: { name: 'Jade', a: '#27c485', b: '#86e6bd', rgb: '39, 196, 133', rgb2: '134, 230, 189' },
  rose: { name: 'Rose', a: '#ff5c8d', b: '#ffa6c1', rgb: '255, 92, 141', rgb2: '255, 166, 193' },
};

const ZOOM = { small: '0.93', normal: '1', large: '1.1' } as const;

export function applyUi(ui: UiSettings | undefined) {
  if (!ui) return;
  const root = document.documentElement;
  const c = ACCENT_COLORS[ui.accent] ?? ACCENT_COLORS.ember;
  root.style.setProperty('--accent', c.a);
  root.style.setProperty('--accent-2', c.b);
  root.style.setProperty('--accent-soft', `rgba(${c.rgb}, 0.14)`);
  root.style.setProperty('--accent-glow', `rgba(${c.rgb}, 0.38)`);
  root.style.setProperty('--accent-rgb', c.rgb);
  root.style.setProperty('--accent-2-rgb', c.rgb2);
  root.style.setProperty('--chat-zoom', ZOOM[ui.textSize] ?? '1');
  if (ui.reduceMotion) root.dataset.reduceMotion = '1';
  else delete root.dataset.reduceMotion;
}

export const reducedMotion = () => document.documentElement.dataset.reduceMotion === '1';
