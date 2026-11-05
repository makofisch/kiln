import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Paths come from the Electron main process (env) when Kiln runs as a desktop app; the fallbacks
// let the core run on its own (`node src/core/entry.ts`) during development.
const here = dirname(fileURLToPath(import.meta.url));
export const SOURCE_ROOT = resolve(process.env.KILN_SOURCE_ROOT ?? resolve(here, '..', '..'));

const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
export const DATA_DIR = resolve(process.env.KILN_DATA_DIR ?? join(appData, 'Kiln'));
export const PROJECTS_DIR = resolve(process.env.KILN_PROJECTS_DIR ?? join(homedir(), 'Documents', 'Kiln'));
export const LOGS_DIR = join(DATA_DIR, 'logs');
export const BLENDER_SCRIPTS = resolve(process.env.KILN_BLENDER_SCRIPTS ?? join(SOURCE_ROOT, 'blender'));
export const BRIDGE = join(BLENDER_SCRIPTS, 'bridge.py');
export const WEB_DIR = resolve(process.env.KILN_WEB_DIR ?? join(SOURCE_ROOT, 'out', 'renderer'));
export const RENDERER_SRC = join(SOURCE_ROOT, 'src', 'renderer');
export const VITE_CONFIG = join(SOURCE_ROOT, 'vite.config.ts');
export const DEV = process.env.KILN_DEV === '1';
export const VERSION = process.env.KILN_VERSION ?? readVersion();
/** The copilot's model. KILN_MODEL overrides it (model comparisons on a dev core). */
export const MODEL = process.env.KILN_MODEL || 'claude-opus-5-5';
/** Set by the desktop shell; standalone runs get a fixed one printed at startup. */
export const TOKEN = process.env.KILN_TOKEN ?? '';
export const PORT = Number(process.env.KILN_PORT ?? 0);
/** Path to Claude Code when it can't be resolved from node_modules (packaged app: outside app.asar). */
export const CLAUDE_EXE = process.env.KILN_CLAUDE_EXE || null;

for (const d of [DATA_DIR, PROJECTS_DIR, LOGS_DIR]) mkdirSync(d, { recursive: true });

function readVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(SOURCE_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

interface FileConfig {
  blender?: string;
}

/** Optional %APPDATA%\Kiln\kiln.config.json: { "blender": "D:/Apps/Blender/blender.exe" }. */
function fileConfig(): FileConfig {
  for (const f of [join(DATA_DIR, 'kiln.config.json'), join(SOURCE_ROOT, 'kiln.config.json')]) {
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as FileConfig;
    } catch {
      /* next */
    }
  }
  return {};
}

const versionOf = (p: string) => (/(\d+)\.(\d+)(?:\.(\d+))?/.exec(p) ?? []).slice(1, 4).map((n) => Number(n ?? 0));

/** blender.exe from KILN_BLENDER / kiln.config.json, else the newest one found in the usual places. */
export function findBlender(): string | null {
  const explicit = process.env.KILN_BLENDER ?? fileConfig().blender;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const roots = [
    join(homedir(), 'Desktop', 'Blender'),
    join(process.env.LOCALAPPDATA ?? '', 'Kiln', 'blender'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Blender Foundation'),
  ];
  const found: string[] = [];
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    const direct = join(root, 'blender.exe');
    if (existsSync(direct)) found.push(direct);
    for (const d of readdirSync(root)) {
      const exe = join(root, d, 'blender.exe');
      if (existsSync(exe)) found.push(exe);
    }
  }
  const steam = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe';
  if (existsSync(steam)) found.push(steam);
  found.sort((a, b) => {
    const [x, y] = [versionOf(a), versionOf(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
  return found[0] ?? null;
}
