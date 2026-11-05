// Packages Kiln as a Windows app: Versions\Kiln <version>\Kiln.exe, and a Desktop shortcut to it.
// `--no-install` (npm run dist -- --no-install) only packages: no Desktop shortcut, no install.json.
// `--installer` also makes the release's installer, dist\Kiln Setup <version>.exe, from the same build. Kiln doesn't
// update itself: people download each new version fresh.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAll } from './build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (!existsSync(join(root, 'build', 'icon.ico'))) execFileSync(process.execPath, [join(root, 'scripts', 'make-icon.mjs')], { stdio: 'inherit' });
await buildAll();

rmSync(join(root, 'dist', 'win-unpacked'), { recursive: true, force: true });
const targets = process.argv.includes('--installer') ? ['dir', 'nsis'] : ['dir'];
execFileSync(process.execPath, [join(root, 'node_modules', 'electron-builder', 'cli.js'), '--win', ...targets, '--publish', 'never'], { cwd: root, stdio: 'inherit' });

const target = join(root, 'Versions', `Kiln ${version}`);
const exe = join(target, 'Kiln.exe');
if (existsSync(target)) {
  // Releasing over a Kiln that is running would delete half of it and leave the rest locked.
  const q = `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${exe.replace(/'/g, "''")}' }).Count`;
  const running = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', q], { encoding: 'utf8' }).trim()) || 0;
  if (running) {
    console.error(`\nKiln ${version} is running from ${target}.\nQuit it (tray icon → Quit Kiln) or raise the version in package.json, then release again. Nothing was changed.`);
    process.exit(1);
  }
  // Moved aside first: if anything in it is still held open, the move fails and nothing is lost.
  const aside = `${target}.old-${Date.now()}`;
  renameSync(target, aside);
  rmSync(aside, { recursive: true, force: true });
}
cpSync(join(root, 'dist', 'win-unpacked'), target, { recursive: true });

if (process.argv.includes('--no-install')) {
  console.log(`\nKiln ${version} → ${exe}\n(--no-install: no Desktop shortcut, install.json left as it was)`);
  process.exit(0);
}

const lnk = join(homedir(), 'Desktop', 'Kiln.lnk');
const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}');$s.TargetPath='${exe.replace(/'/g, "''")}';$s.WorkingDirectory='${target.replace(/'/g, "''")}';$s.IconLocation='${exe.replace(/'/g, "''")},0';$s.Description='Kiln: headless Blender with an AI copilot';$s.Save()`;
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' });
// Other apps (Shuriken Studio) start the Kiln named in install.json: point it at this release now, not
// only once this version has run (an older Kiln that is still the one running would never let it).
if (!process.env.KILN_DATA_DIR) {
  const data = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Kiln');
  try {
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'install.json'), JSON.stringify({ app: 'kiln', version, exe, background: '--background', updatedAt: new Date().toISOString() }, null, 2));
  } catch (e) {
    console.warn(`install.json was not updated: ${e.message}`);
  }
}
console.log(`\nKiln ${version} → ${exe}\nDesktop shortcut: ${lnk}`);
