// Development: rebuilds main/core/preloads on change and restarts Electron; the UI hot-reloads
// through Vite (served by the core).
import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { targets } from './build.mjs';

const require = createRequire(import.meta.url);
const electron = require('electron');
let child = null;
let timer = null;

function restart() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (child) {
      child.removeAllListeners('exit');
      child.kill();
    }
    child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env } });
    child.on('exit', (code) => process.exit(code ?? 0));
  }, 150);
}

const restartPlugin = { name: 'restart', setup: (b) => b.onEnd((r) => !r.errors.length && restart()) };
for (const t of targets) {
  const ctx = await context({ ...t, plugins: [restartPlugin] });
  await ctx.watch();
}
