import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, session, shell, Tray, utilityProcess, WebContentsView, type UtilityProcess } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_TABS, type MenuItem, type ShellState, type TabInfo } from '../shared/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const DEV = !app.isPackaged;
const STRIP = 42;
const BG = '#0a0b0e';

app.setName('Kiln');
// KILN_DATA_DIR / KILN_PROJECTS_DIR / KILN_LEGACY_WORKSPACE isolate test runs from real data.
app.setPath('userData', process.env.KILN_DATA_DIR ?? join(app.getPath('appData'), 'Kiln'));
app.setAppUserModelId('com.kiln.app');
nativeTheme.themeSource = 'dark';
Menu.setApplicationMenu(null);

const smokeIdx = process.argv.indexOf('--smoke');
const SMOKE = smokeIdx >= 0 ? process.argv[smokeIdx + 1] ?? join(app.getPath('temp'), 'kiln-smoke') : null;

// --background: started by another app (Shuriken Studio) to use Kiln without a window. Kiln lives in the
// tray; opening Kiln normally shows its windows. A second start while Kiln runs just hands over to it.
const BACKGROUND = process.argv.includes('--background');

// A second start hands its arguments to the running Kiln (its 'second-instance' event) and exits at
// once: app.quit() would still run the startup below (a second core rewriting runtime.json) and save an
// empty window session over the real one on its way out.
const VERSION = app.getVersion();
const PRIMARY = !!SMOKE || app.requestSingleInstanceLock({ version: VERSION, exe: app.isPackaged ? process.execPath : '' });

/** 1 when version a is newer than b, -1 when older, 0 when the same. */
function cmpVersion(a: string, b: string): number {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  return 0;
}

interface RunningKiln {
  version: string;
  port: number;
  token: string;
  exe: string;
}

/** The Kiln that holds the lock, from its runtime.json. */
function runningKiln(): RunningKiln | null {
  try {
    const r = JSON.parse(readFileSync(join(app.getPath('userData'), 'runtime.json'), 'utf8')) as Partial<RunningKiln>;
    return typeof r.version === 'string' && typeof r.port === 'number' && typeof r.token === 'string' ? { version: r.version, port: r.port, token: r.token, exe: String(r.exe ?? '') } : null;
  } catch {
    return null;
  }
}

// A Kiln from 0.8 on steps aside for a newer one by itself (see 'second-instance'). An older one can't:
// this start asks whether to close it (takeover, once the app is ready).
const OLD = !PRIMARY ? runningKiln() : null;
const TAKEOVER = !!OLD && app.isPackaged && !BACKGROUND && cmpVersion(VERSION, OLD.version) > 0 && cmpVersion(OLD.version, '0.8.0') < 0 && /\\Kiln\.exe$/i.test(OLD.exe) && OLD.exe.toLowerCase() !== process.execPath.toLowerCase();
if (!PRIMARY && !TAKEOVER) app.exit(0);

async function working(port: number, token: string): Promise<number> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/projects`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000) });
    const body = (await r.json()) as unknown;
    const list = Array.isArray(body) ? body : ((body as { projects?: unknown[] })?.projects ?? []);
    return (list as Array<{ working?: boolean }>).filter((p) => p?.working).length;
  } catch {
    return 0;
  }
}

async function takeover(old: RunningKiln) {
  const busy = await working(old.port, old.token);
  // KILN_TAKEOVER=switch|keep answers for the user (tests).
  const preset = process.env.KILN_TAKEOVER === 'switch' ? 0 : process.env.KILN_TAKEOVER === 'keep' ? 1 : null;
  const { response } = preset !== null ? { response: preset } : await dialog.showMessageBox({
    type: 'question',
    title: 'Kiln',
    message: `Kiln ${old.version} is already running.`,
    detail: `This is Kiln ${VERSION}. Switching closes ${old.version} and opens this one; your projects and open tabs carry over.${busy ? `\n\n${busy === 1 ? 'A project is' : `${busy} projects are`} mid-build in ${old.version}: switching stops ${busy === 1 ? 'it' : 'them'}.` : ''}`,
    buttons: [`Switch to ${VERSION}`, `Keep ${old.version}`],
    defaultId: busy ? 1 : 0,
    cancelId: 1,
  });
  if (response !== 0) return app.exit(0);
  // Every process of the old Kiln, with what it started (its Blenders).
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${old.exe.replace(/'/g, "''")}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`;
  await new Promise<void>((done) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20_000 }, () => done()));
  await new Promise((r) => setTimeout(r, 800));
  app.relaunch();
  app.exit(0);
}

// --- paths ------------------------------------------------------------------------------------------
const appRoot = app.getAppPath();
const resources = DEV ? appRoot : process.resourcesPath;
const DATA = app.getPath('userData');
const LOGS = join(DATA, 'logs');
const PROJECTS = process.env.KILN_PROJECTS_DIR ?? join(app.getPath('documents'), 'Kiln');
const SESSION_FILE = join(DATA, 'window-session.json');

function claudeExe(): string {
  try {
    const dir = dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`));
    const exe = join(dir, 'claude.exe').replace(`app.asar${'\\'}`, `app.asar.unpacked${'\\'}`);
    return existsSync(exe) ? exe : '';
  } catch {
    return '';
  }
}

/**
 * Where a Kiln 0.1 scene lives, to import it once into Documents\Kiln. Only when KILN_LEGACY_WORKSPACE
 * names the folder: Kiln never goes looking for one next to itself.
 */
function legacyWorkspace(): string {
  return process.env.KILN_LEGACY_WORKSPACE ?? '';
}

// --- core -------------------------------------------------------------------------------------------
const TOKEN = randomBytes(24).toString('hex');
let core: UtilityProcess | null = null;
let corePort = 0;
let quitting = false;
let coreRestarts: number[] = [];
let importedProject: string | null = null;

function coreLog(text: string) {
  try {
    mkdirSync(LOGS, { recursive: true });
    appendFileSync(join(LOGS, 'core.log'), `${new Date().toISOString()} [app] ${text}\n`);
  } catch {
    /* ignore */
  }
}

function startCore(): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = utilityProcess.fork(join(here, 'core.js'), [], {
      serviceName: 'Kiln core',
      stdio: DEV ? 'inherit' : 'pipe',
      env: {
        ...process.env,
        KILN_TOKEN: TOKEN,
        KILN_DATA_DIR: DATA,
        KILN_PROJECTS_DIR: PROJECTS,
        KILN_WEB_DIR: DEV ? join(appRoot, 'out', 'renderer') : join(process.resourcesPath, 'renderer'),
        KILN_BLENDER_SCRIPTS: join(resources, 'blender'),
        KILN_SOURCE_ROOT: appRoot,
        KILN_VERSION: app.getVersion(),
        KILN_DEV: DEV && !process.env.KILN_PROD_UI ? '1' : '0',
        KILN_CLAUDE_EXE: claudeExe(),
        KILN_LEGACY_WORKSPACE: legacyWorkspace(),
        KILN_EXE: app.isPackaged ? process.execPath : '',
      },
    });
    core = proc;
    let ready = false;
    proc.stdout?.on('data', () => undefined);
    proc.stderr?.on('data', (d: Buffer) => coreLog(d.toString('utf8').trimEnd().slice(-4000)));
    const timer = setTimeout(() => reject(new Error('The Kiln core did not start within 30 s')), 30_000);
    proc.on('message', (m: { type?: string; port?: number; imported?: string | null; active?: boolean }) => {
      if (m?.type === 'external') {
        externalActive = !!m.active;
        if (externalActive && !windows.size) ensureTray();
        tray?.setToolTip(externalActive ? 'Kiln (in use by Shuriken Studio)' : 'Kiln');
        trayIdle();
        return;
      }
      if (m?.type === 'ready' && m.port) {
        ready = true;
        clearTimeout(timer);
        corePort = m.port;
        if (m.imported) importedProject = m.imported;
        resolve(m.port);
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (core !== proc || quitting) return;
      core = null;
      coreLog(`the core stopped (exit code ${code})${ready ? '' : ' while starting'}`);
      if (!ready) return reject(new Error(`The Kiln core stopped while starting (exit code ${code}). See %APPDATA%\\Kiln\\logs\\core.log.`));
      const now = Date.now();
      coreRestarts = [...coreRestarts.filter((t) => now - t < 60_000), now];
      if (coreRestarts.length > 3) {
        dialog.showErrorBox('Kiln', `The Kiln core keeps stopping (exit code ${code}). See %APPDATA%\\Kiln\\logs\\core.log.`);
        app.quit();
        return;
      }
      startCore()
        .then(async () => {
          await authorize();
          for (const w of windows.values()) {
            w.win.webContents.once('did-finish-load', () => notice(w, 'Kiln restarted its engine after a problem. A build that was running has stopped; your projects are as last saved.'));
            w.reloadAll();
          }
        })
        .catch((e: Error) => {
          dialog.showErrorBox('Kiln', e.message);
          app.quit();
        });
    });
  });
}

async function authorize() {
  await session.defaultSession.cookies.set({ url: `http://127.0.0.1:${corePort}`, name: 'kiln', value: TOKEN, httpOnly: true, sameSite: 'strict' });
}

const url = (path: string) => `http://127.0.0.1:${corePort}${path}`;

/** Whether a URL is one of Kiln's own pages (the exact origin: a prefix match would let "127.0.0.1:1234.example" through). */
function ours(target: string): boolean {
  try {
    return new URL(target).origin === `http://127.0.0.1:${corePort}`;
  } catch {
    return false;
  }
}

/** A project id as Kiln makes them: a folder name, never a path. */
const safeId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(id) && !id.includes('..');

// --- tabs and windows -------------------------------------------------------------------------------
let tabSeq = 0;

class Tab {
  readonly id = `t${Date.now().toString(36)}${(tabSeq++).toString(36)}`;
  projectId: string | null;
  view: WebContentsView | null = null;
  owner: KilnWindow;

  constructor(owner: KilnWindow, projectId: string | null) {
    this.owner = owner;
    this.projectId = projectId;
  }

  /** Creates the view the first time the tab is shown (restored tabs load lazily). */
  ensureView(): WebContentsView {
    if (this.view) return this.view;
    const v = new WebContentsView({
      webPreferences: { preload: join(here, 'preload-tab.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: true, spellcheck: false },
    });
    v.setBackgroundColor(BG);
    this.view = v;
    wireShortcuts(v.webContents, () => this.owner);
    v.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:\/\//.test(target) && !ours(target)) void shell.openExternal(target);
      return { action: 'deny' };
    });
    v.webContents.on('will-navigate', (e, target) => {
      if (!ours(target)) e.preventDefault();
    });
    void v.webContents.loadURL(this.src());
    return v;
  }

  src() {
    return url(this.projectId ? `/?project=${encodeURIComponent(this.projectId)}` : '/');
  }

  info(): TabInfo {
    return { id: this.id, projectId: this.projectId };
  }

  destroy() {
    if (!this.view) return;
    this.owner.win.contentView.removeChildView(this.view);
    this.view.webContents.close();
    this.view = null;
  }
}

const windows = new Map<number, KilnWindow>();
const allTabs = () => [...windows.values()].flatMap((w) => w.tabs);

class KilnWindow {
  readonly win: BrowserWindow;
  tabs: Tab[] = [];
  activeId: string | null = null;
  working = false;

  constructor(bounds?: { x?: number; y?: number; width: number; height: number }, maximized = false) {
    this.win = new BrowserWindow({
      width: bounds?.width ?? 1560,
      height: bounds?.height ?? 960,
      x: bounds?.x,
      y: bounds?.y,
      minWidth: 900,
      minHeight: 560,
      show: false,
      backgroundColor: BG,
      title: 'Kiln',
      icon: DEV ? join(appRoot, 'build', 'icon.ico') : undefined,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0b0c10', symbolColor: '#c3c7d2', height: STRIP },
      webPreferences: { preload: join(here, 'preload-shell.cjs'), sandbox: true, contextIsolation: true, spellcheck: false },
    });
    windows.set(this.win.id, this);
    trayIdle();
    wireShortcuts(this.win.webContents, () => this);
    // The tab strip stays the tab strip: a file dropped on it, or a link, must not replace it.
    this.win.webContents.on('will-navigate', (e, target) => {
      if (!ours(target) || !new URL(target).pathname.startsWith('/shell.html')) e.preventDefault();
    });
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.once('ready-to-show', () => {
      if (maximized) this.win.maximize();
      this.win.show();
    });
    const relayout = () => this.layout();
    this.win.on('resize', relayout);
    this.win.on('maximize', () => {
      relayout();
      this.push();
    });
    this.win.on('unmaximize', () => {
      relayout();
      this.push();
    });
    this.win.on('focus', () => {
      this.win.flashFrame(false);
      this.active()?.view?.webContents.focus();
    });
    // Saved while this window still counts: once the last one is gone there is nothing left to save,
    // and an empty session would forget every open tab.
    this.win.on('close', () => {
      if (!quitting) saveSession();
    });
    this.win.on('closed', () => {
      for (const t of this.tabs) t.view?.webContents.close();
      windows.delete(this.win.id);
      if (!quitting && windows.size) saveSession();
      trayIdle();
    });
    void this.win.loadURL(url('/shell.html'));
  }

  active(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeId);
  }

  layout() {
    const [w, h] = this.win.getContentSize();
    const t = this.active();
    for (const tab of this.tabs) {
      if (!tab.view) continue;
      const on = tab === t;
      tab.view.setVisible(on);
      if (on) tab.view.setBounds({ x: 0, y: STRIP, width: w!, height: Math.max(0, h! - STRIP) });
    }
  }

  push() {
    const s: ShellState = { windowId: this.win.id, tabs: this.tabs.map((t) => t.info()), activeId: this.activeId, totalTabs: allTabs().length, maximized: this.win.isMaximized() };
    if (!this.win.isDestroyed()) this.win.webContents.send('shell:state', s);
  }

  add(tab: Tab, index = this.tabs.length, activate = true) {
    tab.owner = this;
    this.tabs.splice(Math.max(0, Math.min(index, this.tabs.length)), 0, tab);
    if (tab.view) this.win.contentView.addChildView(tab.view);
    if (activate) this.activate(tab.id);
    else this.push();
  }

  activate(id: string) {
    const t = this.tabs.find((x) => x.id === id);
    if (!t) return;
    this.activeId = id;
    if (!t.view) this.win.contentView.addChildView(t.ensureView());
    this.layout();
    t.view!.webContents.focus();
    this.push();
    pushAll();
  }

  /** Takes a tab out of this window (for another window), keeping its live view. */
  take(id: string): Tab | null {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return null;
    const [t] = this.tabs.splice(i, 1);
    if (t!.view) this.win.contentView.removeChildView(t!.view);
    if (this.activeId === id) this.activeId = this.tabs[Math.min(i, this.tabs.length - 1)]?.id ?? null;
    if (!this.tabs.length) this.win.close();
    else if (this.activeId) this.activate(this.activeId);
    return t!;
  }

  close(id: string) {
    const t = this.take(id);
    t?.destroy();
    pushAll();
    saveSession();
  }

  reloadAll() {
    void this.win.loadURL(url('/shell.html'));
    for (const t of this.tabs) void t.view?.webContents.loadURL(t.src());
  }

  /** The tab strip in screen coordinates. */
  stripRect() {
    const b = this.win.getContentBounds();
    return { x: b.x, y: b.y, width: b.width, height: STRIP };
  }
}

function pushAll() {
  for (const w of windows.values()) w.push();
}

function notice(w: KilnWindow, text: string) {
  w.win.webContents.send('shell:notice', text);
}

function newTab(w: KilnWindow, projectId: string | null = null): Tab | null {
  if (allTabs().length >= MAX_TABS) {
    notice(w, `Kiln keeps at most ${MAX_TABS} projects open at once. Close a tab first.`);
    return null;
  }
  const t = new Tab(w, projectId);
  w.add(t);
  saveSession();
  return t;
}

function focusedWindow(): KilnWindow | undefined {
  const f = BrowserWindow.getFocusedWindow();
  return (f && windows.get(f.id)) ?? [...windows.values()].pop();
}

/** A new window at a screen point holding `tab`. */
function detach(tab: Tab, at?: { x: number; y: number }) {
  const src = tab.owner;
  if (src.tabs.length === 1 && at) {
    const b = src.win.getBounds();
    src.win.setPosition(Math.round(at.x - 120), Math.round(at.y - 16));
    return b;
  }
  const size = src.win.getSize();
  const w = new KilnWindow({ width: size[0]!, height: size[1]!, x: at ? Math.round(at.x - 120) : undefined, y: at ? Math.round(at.y - 16) : undefined });
  const t = src.take(tab.id);
  if (t) w.win.webContents.once('did-finish-load', () => w.add(t));
  saveSession();
  return null;
}

function windowAt(x: number, y: number, except?: KilnWindow): KilnWindow | undefined {
  return [...windows.values()].find((w) => {
    if (w === except) return false;
    const b = w.win.getBounds();
    return !w.win.isMinimized() && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
  });
}

// --- dragging by the tabs ---------------------------------------------------------------------------
// A tab drag moves windows, like a browser: a window's only tab carries the whole window; with more
// tabs, a sideways drag reorders (in the strip) and pulling a tab off the strip tears it into its own
// window, which follows the cursor until the drop. Dropped on another window's tabs, it docks there.
interface TabDrag {
  tabId: string;
  src: KilnWindow;
  mode: 'tab' | 'window';
  moving: KilnWindow | null;
  offset: { x: number; y: number };
  timer: NodeJS.Timeout;
  started: number;
}
let tabDrag: TabDrag | null = null;

function endDrag() {
  if (!tabDrag) return;
  clearInterval(tabDrag.timer);
  const d = tabDrag;
  tabDrag = null;
  return d;
}

function dragTick() {
  const d = tabDrag;
  if (!d) return;
  if (Date.now() - d.started > 60_000) return void endDrag();
  const cur = screen.getCursorScreenPoint();
  if (d.mode === 'tab') {
    const r = d.src.stripRect();
    const off = cur.y > r.y + r.height + 26 || cur.y < r.y - 26 || cur.x < r.x - 40 || cur.x > r.x + r.width + 40;
    if (!off) return;
    const tab = d.src.tabs.find((t) => t.id === d.tabId);
    if (!tab) return void endDrag();
    const [width, height] = d.src.win.getSize();
    const offset = { x: 140, y: 20 };
    const nw = new KilnWindow({ width: width!, height: height!, x: cur.x - offset.x, y: cur.y - offset.y });
    const t = d.src.take(tab.id);
    if (t) nw.win.webContents.once('did-finish-load', () => nw.add(t));
    d.mode = 'window';
    d.moving = nw;
    d.offset = offset;
    pushAll();
    return;
  }
  const m = d.moving;
  if (!m || m.win.isDestroyed()) return void endDrag();
  m.win.setPosition(Math.round(cur.x - d.offset.x), Math.round(cur.y - d.offset.y));
}

ipcMain.on('shell:drag-start', (e, tabId: string) => {
  const w = winOf(e);
  if (!w || tabDrag) return;
  const cur = screen.getCursorScreenPoint();
  let offset = { x: 0, y: 0 };
  if (w.tabs.length === 1) {
    const b = w.win.getBounds();
    if (w.win.isMaximized()) {
      // Pulling a maximized window restores it under the cursor at the same relative spot.
      const rel = (cur.x - b.x) / b.width;
      w.win.unmaximize();
      const nb = w.win.getBounds();
      offset = { x: Math.round(nb.width * rel), y: cur.y - b.y };
    } else offset = { x: cur.x - b.x, y: cur.y - b.y };
  }
  tabDrag = { tabId, src: w, mode: w.tabs.length === 1 ? 'window' : 'tab', moving: w.tabs.length === 1 ? w : null, offset, timer: setInterval(dragTick, 12), started: Date.now() };
});

ipcMain.on('shell:drag-end', (_e, index: number) => {
  const d = endDrag();
  if (!d) return;
  if (d.mode === 'tab') {
    const tab = d.src.tabs.find((t) => t.id === d.tabId);
    if (tab) {
      const from = d.src.tabs.indexOf(tab);
      d.src.tabs.splice(from, 1);
      d.src.tabs.splice(Math.max(0, Math.min(index, d.src.tabs.length)), 0, tab);
      d.src.push();
    }
  } else if (d.moving) {
    // Dropped over another window's tab strip: dock the tab there.
    const cur = screen.getCursorScreenPoint();
    const target = windowAt(cur.x, cur.y, d.moving);
    const r = target?.stripRect();
    if (target && r && cur.y <= r.y + r.height + 20) {
      const moving = d.moving;
      const tab = moving.tabs.find((t) => t.id === d.tabId) ?? moving.tabs[0];
      const t = tab ? moving.take(tab.id) : null;
      if (t) target.add(t);
      target.win.focus();
    }
  }
  saveSession();
});

// The Kiln logo and the login chip open the settings, shown over the window's active tab.
ipcMain.on('shell:settings', (e, section: string | null) => {
  const w = winOf(e);
  const view = w?.active()?.view;
  if (!view) return;
  view.webContents.send('tab:settings', section);
  view.webContents.focus();
});

ipcMain.on('shell:toggle-max', (e) => {
  const w = winOf(e);
  if (!w) return;
  if (w.win.isMaximized()) w.win.unmaximize();
  else w.win.maximize();
});

ipcMain.on('shell:working', (e, working: boolean) => {
  const w = winOf(e);
  if (!w || w.win.isDestroyed()) return;
  const was = w.working;
  w.working = working;
  // The taskbar shows Kiln is busy; a background window that finishes flashes its button.
  w.win.setProgressBar(working ? 2 : -1, { mode: working ? 'indeterminate' : 'none' });
  if (was && !working && !w.win.isFocused()) w.win.flashFrame(true);
});

function dropTab(tabId: string, x: number, y: number, index: number) {
  const tab = allTabs().find((t) => t.id === tabId);
  if (!tab) return;
  const src = tab.owner;
  const target = windowAt(x, y);
  if (target === src) {
    const r = src.stripRect();
    if (y <= r.y + r.height + 24) {
      // Reorder within the strip.
      const from = src.tabs.indexOf(tab);
      src.tabs.splice(from, 1);
      src.tabs.splice(Math.max(0, Math.min(index, src.tabs.length)), 0, tab);
      src.push();
    }
    return;
  }
  if (target) {
    // Dock into another window.
    const t = src.take(tab.id);
    if (t) target.add(t);
    target.win.focus();
  } else detach(tab, { x, y });
  saveSession();
}

// --- keyboard shortcuts -----------------------------------------------------------------------------
function wireShortcuts(wc: Electron.WebContents, owner: () => KilnWindow) {
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    // The key's position, not the letter it types: Ctrl+T must work on a Cyrillic or Greek layout too.
    const code = input.code;
    const key = /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : /^Digit[0-9]$/.test(code) ? code.slice(5) : code === 'Comma' ? ',' : input.key.toLowerCase();
    const w = owner();
    const handled = () => e.preventDefault();
    if (ctrl && input.shift && key === 'n') {
      newTab(w);
      return handled();
    }
    if (ctrl && !input.shift && key === 't') {
      newTab(w);
      return handled();
    }
    if (ctrl && !input.shift && key === ',') {
      const view = w.active()?.view;
      view?.webContents.send('tab:settings', null);
      view?.webContents.focus();
      return handled();
    }
    if (ctrl && !input.shift && key === 'w') {
      if (w.activeId) w.close(w.activeId);
      return handled();
    }
    if (ctrl && input.shift && key === 'd') {
      const t = w.active();
      if (t && w.tabs.length > 1) detach(t);
      return handled();
    }
    if (ctrl && key === 'tab') {
      const i = w.tabs.findIndex((t) => t.id === w.activeId);
      const next = w.tabs[(i + (input.shift ? -1 : 1) + w.tabs.length) % w.tabs.length];
      if (next) w.activate(next.id);
      return handled();
    }
    if (ctrl && /^[1-9]$/.test(key)) {
      const t = key === '9' ? w.tabs[w.tabs.length - 1] : w.tabs[Number(key) - 1];
      if (t) w.activate(t.id);
      return handled();
    }
    if (key === 'f12' && DEV) {
      wc.toggleDevTools();
      return handled();
    }
    if (ctrl && key === 'r' && DEV) {
      wc.reload();
      return handled();
    }
  });
}

// --- IPC --------------------------------------------------------------------------------------------
const winOf = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
  const bw = BrowserWindow.fromWebContents(e.sender);
  if (bw) return windows.get(bw.id);
  return allTabs().find((t) => t.view?.webContents === e.sender)?.owner;
};
const tabOf = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => allTabs().find((t) => t.view?.webContents === e.sender);

ipcMain.on('shell:ready', (e) => winOf(e)?.push());
ipcMain.on('shell:new', (e) => {
  const w = winOf(e);
  if (w) newTab(w);
});
ipcMain.on('shell:activate', (e, id: string) => winOf(e)?.activate(id));
ipcMain.on('shell:close', (e, id: string) => winOf(e)?.close(id));
ipcMain.on('shell:drop', (_e, id: string, x: number, y: number, index: number) => dropTab(id, x, y, index));
ipcMain.on('shell:detach', (_e, id: string) => {
  const t = allTabs().find((x) => x.id === id);
  if (t && t.owner.tabs.length > 1) detach(t);
});
ipcMain.on('shell:title', (e, title: string) => {
  const w = winOf(e);
  if (w) w.win.setTitle(title ? `${title} · Kiln` : 'Kiln');
});
ipcMain.on('shell:tabmenu', (e, id: string, titles: Record<string, string>) => {
  const w = winOf(e);
  const t = w?.tabs.find((x) => x.id === id);
  if (!w || !t) return;
  const others = [...windows.values()].filter((x) => x !== w);
  Menu.buildFromTemplate([
    { label: 'New tab', accelerator: 'Ctrl+Shift+N', click: () => newTab(w) },
    { type: 'separator' },
    { label: 'Move to new window', accelerator: 'Ctrl+Shift+D', enabled: w.tabs.length > 1, click: () => detach(t) },
    ...others.map((o, i) => ({
      label: `Move to window ${i + 2} (${o.tabs.map((x) => titles[x.projectId ?? ''] ?? 'New project').slice(0, 3).join(', ')})`,
      click: () => {
        const moved = w.take(t.id);
        if (moved) o.add(moved);
        o.win.focus();
        saveSession();
      },
    })),
    { type: 'separator' },
    { label: 'Show project folder', enabled: safeId(t.projectId), click: () => void shell.openPath(join(PROJECTS, t.projectId!)) },
    // The tab asks (its own confirm) and deletes through the core; it then shows the start page.
    {
      label: 'Delete project…',
      enabled: safeId(t.projectId),
      click: () => {
        w.activate(t.id);
        const wc = t.ensureView().webContents;
        if (wc.isLoading()) wc.once('did-finish-load', () => wc.send('tab:delete-project'));
        else wc.send('tab:delete-project');
      },
    },
    { type: 'separator' },
    { label: 'Close tab', accelerator: 'Ctrl+W', click: () => w.close(t.id) },
    { label: 'Close other tabs', enabled: w.tabs.length > 1, click: () => w.tabs.filter((x) => x !== t).forEach((x) => w.close(x.id)) },
  ]).popup({ window: w.win });
});
ipcMain.handle('shell:popup', (e, items: MenuItem[]) => {
  const w = winOf(e);
  return new Promise<string | null>((resolve) => {
    let chosen: string | null = null;
    const menu = Menu.buildFromTemplate(
      items.map((it) =>
        it.type === 'separator'
          ? { type: 'separator' as const }
          : { label: it.label ?? '', sublabel: it.sublabel, type: it.type ?? 'normal', checked: it.checked, enabled: it.enabled !== false, click: () => (chosen = it.id ?? null) },
      ),
    );
    menu.popup({ window: w?.win, callback: () => setTimeout(() => resolve(chosen), 0) });
  });
});
ipcMain.on('app:open-path', (_e, which: string, projectId?: string) => {
  const target =
    which === 'logs' ? join(LOGS, 'conversations') : which === 'watchdog' ? join(LOGS, 'WATCHDOG.md') : which === 'projects' ? PROJECTS : which === 'project' && safeId(projectId) ? join(PROJECTS, projectId) : DATA;
  if (existsSync(target)) void shell.openPath(target);
});

ipcMain.on('tab:project', (e, projectId: string | null) => {
  const t = tabOf(e);
  if (!t) return;
  t.projectId = safeId(projectId) ? projectId : null;
  t.owner.push();
  saveSession();
});
ipcMain.handle('tab:open', (e, projectId: string) => {
  const me = tabOf(e);
  const other = allTabs().find((t) => t.projectId === projectId && t !== me);
  if (other) {
    other.owner.activate(other.id);
    other.owner.win.show();
    other.owner.win.focus();
    return 'focused';
  }
  return 'ok';
});
ipcMain.on('tab:new', (e) => {
  const w = winOf(e);
  if (w) newTab(w);
});

// --- session (windows and tabs survive a restart; tabs load when first shown) -----------------------
interface SavedSession {
  windows: Array<{ bounds: { x: number; y: number; width: number; height: number }; maximized: boolean; tabs: Array<string | null>; active: number }>;
}

function saveSession() {
  if (SMOKE || quitting || !windows.size) return;
  const s: SavedSession = {
    windows: [...windows.values()].map((w) => ({
      bounds: w.win.getNormalBounds(),
      maximized: w.win.isMaximized(),
      tabs: w.tabs.map((t) => t.projectId),
      active: Math.max(0, w.tabs.findIndex((t) => t.id === w.activeId)),
    })),
  };
  try {
    writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
  } catch {
    /* ignore */
  }
}

function onScreen(b: { x: number; y: number; width: number; height: number }) {
  return screen.getAllDisplays().some((d) => b.x < d.workArea.x + d.workArea.width - 80 && b.x + b.width > d.workArea.x + 80 && b.y >= d.workArea.y - 10 && b.y < d.workArea.y + d.workArea.height - 60);
}

function restore() {
  let s: SavedSession | null = null;
  try {
    s = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as SavedSession;
  } catch {
    /* first run */
  }
  const saved = (s?.windows ?? []).filter((w) => w.tabs.length);
  if (!saved.length) {
    const w = new KilnWindow();
    newTab(w, importedProject);
    return;
  }
  let count = 0;
  for (const sw of saved) {
    const w = new KilnWindow(onScreen(sw.bounds) ? sw.bounds : undefined, sw.maximized);
    for (const pid of sw.tabs) {
      if (count >= MAX_TABS) break;
      if (pid && !existsSync(join(PROJECTS, pid))) continue;
      w.add(new Tab(w, pid), w.tabs.length, false);
      count++;
    }
    if (!w.tabs.length) w.add(new Tab(w, null), 0, false);
    w.activate(w.tabs[Math.min(sw.active, w.tabs.length - 1)]!.id);
  }
}

// --- smoke test: screenshots of the real windows, no model calls --------------------------------------
async function smoke(dir: string) {
  mkdirSync(dir, { recursive: true });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const report: Record<string, unknown> = {};
  const w = new KilnWindow({ width: 1500, height: 920 });
  w.win.once('ready-to-show', () => w.win.focus());
  await new Promise<void>((r) => w.win.webContents.once('did-finish-load', () => r()));
  const first = newTab(w)!;
  const projectIds = (process.env.KILN_SMOKE_PROJECTS ?? '').split(',').filter(Boolean);
  const second = projectIds[0] ?? importedProject ? newTab(w, projectIds[0] ?? importedProject) : null;
  await wait(Number(process.env.KILN_SMOKE_WAIT ?? 6000));
  const errors: string[] = [];
  const shot = async (name: string, wc: Electron.WebContents | undefined) => {
    if (!wc) return;
    try {
      const img = await wc.capturePage();
      writeFileSync(join(dir, `${name}.png`), img.toPNG());
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  };
  await shot('1-shell', w.win.webContents);
  await shot('1-tab-active', w.active()?.view?.webContents);
  w.activate(first.id);
  await wait(1500);
  await shot('1-tab-start', first.view?.webContents);
  // Settings over the tab (opened the way the Kiln logo opens them).
  first.view?.webContents.send('tab:settings', 'memory');
  await wait(900);
  await shot('1b-settings', first.view?.webContents);
  report.settings = await first.view?.webContents.executeJavaScript("document.querySelector('.settings')?.innerText.split('\\n').slice(0, 12).join(' | ') ?? null");
  first.view?.webContents.send('tab:settings', null);
  if (second) {
    detach(second, { x: 200, y: 200 });
    await wait(4000);
    const w2 = second.owner;
    await shot('2-detached-shell', w2.win.webContents);
    await shot('2-detached-tab', second.view?.webContents);
    report.detached = { windows: windows.size, tabsInNew: w2.tabs.length, sameView: !!second.view };
    dropTab(second.id, w.stripRect().x + 300, w.stripRect().y + 10, 1);
    await wait(2500);
    await shot('3-docked-shell', w.win.webContents);
    report.docked = { windows: windows.size, tabs: w.tabs.map((t) => t.projectId) };
    // The tab's working indicator (simulated: no model call).
    w.activate(first.id);
    await w.win.webContents.executeJavaScript(`window.__kilnShellSim?.(${JSON.stringify(second.projectId)}, true)`);
    await wait(900);
    await shot('3b-working-shell', w.win.webContents);
    report.working = await w.win.webContents.executeJavaScript("document.querySelectorAll('.tab.working').length");
    await w.win.webContents.executeJavaScript(`window.__kilnShellSim?.(${JSON.stringify(second.projectId)}, false)`);
  }
  // Many projects open at once (KILN_SMOKE_MANY=1): every tab must connect and load its scene.
  if (process.env.KILN_SMOKE_MANY === '1' && projectIds.length > 1) {
    const opened = projectIds.slice(1).map((id) => newTab(w, id)).filter((t): t is Tab => !!t);
    for (const t of opened) {
      w.activate(t.id);
      await wait(3500);
    }
    await wait(2500);
    report.many = await Promise.all(
      [second, ...opened].filter((t): t is Tab => !!t).map(async (t) => ({
        project: t.projectId,
        loaded: !!t.view,
        state: t.view ? await t.view.webContents.executeJavaScript("JSON.stringify({ offline: !!document.querySelector('.offline'), badge: document.querySelector('.scene-title')?.textContent ?? null, stats: document.querySelector('.scene-stats')?.textContent ?? null })") : null,
      })),
    );
    await shot('5-many-projects-shell', w.win.webContents);
  }
  for (let i = 0; i < 12; i++) newTab(w);
  report.tabCapReached = allTabs().length;
  await wait(1500);
  report.stripTabs = await w.win.webContents.executeJavaScript("JSON.stringify([...document.querySelectorAll('.tab')].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.width)]; }))");
  report.stripTabsIn = w.tabs.length;
  await shot('4-many-tabs-shell', w.win.webContents);
  report.errors = errors;
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
  quitting = true;
  core?.postMessage({ type: 'shutdown' });
  setTimeout(() => app.exit(0), 800);
}

// --- background (tray) -------------------------------------------------------------------------------
let tray: Tray | null = null;
/** Another app (Shuriken) uses this Kiln: its API or a Kiln view it hosts. */
let externalActive = false;

let idleQuit: NodeJS.Timeout | null = null;

/** In the tray with no window and no app using Kiln: quit after a while instead of staying forever. */
function trayIdle() {
  if (idleQuit) clearTimeout(idleQuit);
  idleQuit = null;
  if (SMOKE || !tray || windows.size || externalActive) return;
  idleQuit = setTimeout(() => {
    if (!windows.size && !externalActive) app.quit();
  }, 30 * 60_000);
}

function showKiln() {
  const w = focusedWindow();
  if (!w) {
    restore();
    return;
  }
  if (w.win.isMinimized()) w.win.restore();
  w.win.show();
  w.win.focus();
}

function ensureTray() {
  if (tray || SMOKE) return;
  const iconFile = join(DEV ? join(appRoot, 'build') : process.resourcesPath, 'icon.ico');
  const img = existsSync(iconFile) ? nativeImage.createFromPath(iconFile) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip(externalActive ? 'Kiln (in use by Shuriken Studio)' : 'Kiln');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Kiln', click: () => showKiln() },
      { type: 'separator' },
      { label: 'Quit Kiln', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => showKiln());
  trayIdle();
}

/** Where this Kiln is installed, for other apps to start it (%APPDATA%\Kiln\install.json). */
function writeInstallInfo() {
  if (!app.isPackaged) return;
  try {
    // A newer Kiln that is installed stays the one other apps start, even when this older one runs.
    const cur = JSON.parse(readFileSync(join(DATA, 'install.json'), 'utf8')) as { version?: string; exe?: string };
    if (cur?.exe && cur.version && existsSync(cur.exe) && cmpVersion(cur.version, VERSION) > 0) return;
  } catch {
    /* none yet */
  }
  try {
    writeFileSync(join(DATA, 'install.json'), JSON.stringify({ app: 'kiln', version: app.getVersion(), exe: process.execPath, background: '--background', updatedAt: new Date().toISOString() }, null, 2));
  } catch {
    /* ignore */
  }
}

// --- lifecycle --------------------------------------------------------------------------------------
let started = false;
let openWhenStarted = false;
let handingOver = false;

/** A newer Kiln was started: finish what is running, then quit and start that one in this one's place. */
async function handover(exe: string) {
  if (handingOver) return;
  handingOver = true;
  if (await working(corePort, TOKEN)) {
    for (const w of windows.values()) notice(w, 'A newer Kiln is installed. It takes over when the running build finishes.');
    while (await working(corePort, TOKEN)) await new Promise((r) => setTimeout(r, 5000));
  }
  saveSession();
  const args = windows.size ? [] : ['--background'];
  app.once('will-quit', () => {
    app.releaseSingleInstanceLock();
    spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
  });
  app.quit();
}

app.on('second-instance', (_e, argv, _cwd, data) => {
  const other = data as { version?: string; exe?: string } | null;
  if (other?.version && other.exe && cmpVersion(other.version, VERSION) > 0 && /\\Kiln\.exe$/i.test(other.exe) && existsSync(other.exe)) {
    void handover(other.exe);
    return;
  }
  // Another app starting Kiln in the background while it already runs: nothing to do.
  if (argv.includes('--background')) return;
  // Started again while still starting up (a double click): open once the core is there.
  if (!started) {
    openWhenStarted = true;
    return;
  }
  const w = focusedWindow();
  if (!w) {
    restore();
    return;
  }
  if (w.win.isMinimized()) w.win.restore();
  w.win.focus();
  newTab(w);
});

app.on('window-all-closed', () => {
  if (SMOKE) return;
  // Started for another app, or one is using Kiln right now: stay in the tray instead of quitting.
  if (BACKGROUND || externalActive) {
    saveSession();
    ensureTray();
    return;
  }
  app.quit();
});

let coreDown = false;

app.on('before-quit', (e) => {
  if (!PRIMARY) return;
  saveSession();
  quitting = true;
  // The core stops its Blenders and clears runtime.json: wait for it (briefly) instead of cutting it off.
  const proc = core;
  if (!proc || coreDown) return;
  e.preventDefault();
  const done = () => {
    if (coreDown) return;
    coreDown = true;
    app.quit();
  };
  proc.once('exit', done);
  proc.postMessage({ type: 'shutdown' });
  setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* gone */
    }
    done();
  }, 2500);
});

app.whenReady().then(async () => {
  if (TAKEOVER && OLD) return void takeover(OLD);
  if (!PRIMARY) return;
  try {
    await startCore();
    await authorize();
  } catch (e) {
    dialog.showErrorBox('Kiln could not start', (e as Error).message);
    app.quit();
    return;
  }
  writeInstallInfo();
  started = true;
  if (SMOKE) void smoke(SMOKE);
  else if (BACKGROUND) {
    ensureTray();
    if (openWhenStarted) showKiln();
  } else restore();
});
