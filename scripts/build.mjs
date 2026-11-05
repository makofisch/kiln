// Builds Kiln: the Electron main process, the core, the preloads (esbuild) and the UI (Vite).
// `node scripts/build.mjs --no-ui` skips the UI (dev uses Vite's dev server instead).
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const common = { bundle: true, platform: 'node', target: 'node22', packages: 'external', sourcemap: 'linked', logLevel: 'warning', absWorkingDir: root };

export const targets = [
  { entryPoints: ['src/main/index.ts'], outfile: 'out/main.js', format: 'esm' },
  { entryPoints: ['src/core/entry.ts'], outfile: 'out/core.js', format: 'esm' },
  { entryPoints: ['src/preload/shell.ts'], outfile: 'out/preload-shell.cjs', format: 'cjs' },
  { entryPoints: ['src/preload/tab.ts'], outfile: 'out/preload-tab.cjs', format: 'cjs' },
].map((t) => ({ ...common, ...t }));

export async function buildAll({ ui = true } = {}) {
  const t0 = Date.now();
  await Promise.all(targets.map((t) => build(t)));
  if (ui) await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn' });
  console.log(`Built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildAll({ ui: !process.argv.includes('--no-ui') });
}
