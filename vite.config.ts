import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r('./src/renderer'),
  base: '/',
  plugins: [react()],
  build: {
    outDir: r('./out/renderer'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: { input: { index: r('./src/renderer/index.html'), shell: r('./src/renderer/shell.html') } },
  },
});
