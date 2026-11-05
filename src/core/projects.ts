import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { folderBytes, logCore, writeAtomic } from './fsx.ts';
import type { LoginStatus } from './login.ts';
import type { BlenderBridge } from './blender.ts';
import { PROJECTS_DIR } from './config.ts';
import { Copilot } from './copilot.ts';
import { Journal } from './journal.ts';
import { readStyle, saveStyle } from './styles.ts';
import type { BlenderPool } from './pool.ts';
import { Workspace } from './workspace.ts';
import type { Sink } from './ws.ts';
import { isRoblox, type BlenderInfo, type ProjectMeta, type ProjectState, type ProjectSummary, type RobloxLighting, type SceneState, type ServerEvent, type Settings } from '../shared/types.ts';

const UNTITLED = 'Untitled';
/** What a new project is called until the copilot names it after its first build. */
export const NEW_PROJECT = 'New project';
const CLOSE_AFTER_MS = 20_000;
const API_IDLE_MS = 5 * 60_000;
const META_TTL_MS = 5 * 60_000;
const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'on', 'in', 'for', 'to', 'me', 'my', 'some', 'please', 'can', 'you', 'could', 'would', 'i', 'want', 'like', 'make', 'build', 'create', 'model', 'design', 'generate', 'give', 'do', 'let', "let's", 'lets', 'us', 'simple', 'quick', 'small', 'nice', 'need', "i'd", 'im', "i'm", 'we', 'our', 'it', 'is', 'that', 'this', 'very', 'really', 'complex', 'detailed', 'new', 'hey', 'hi', 'now', 'just', 'something', 'one', 'at', 'from', 'by', 'into', 'about', 'will', 'be', 'get', 'try']);

/** "Build a stylized low-poly lighthouse on a rocky outcrop" → "Stylized Low-poly Lighthouse". */
export function titleFrom(text: string): string {
  const words = text
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const kept: string[] = [];
  for (const w of words) {
    if (STOP_WORDS.has(w.toLowerCase())) {
      if (kept.length >= 2) break;
      continue;
    }
    kept.push(w);
    if (kept.length >= 3) break;
  }
  const t = kept.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ').slice(0, 32).trim();
  return t || UNTITLED;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 28) || 'project';

export interface ProjectsHost {
  pool: BlenderPool;
  /** This PC's Claude login (Settings): its usage and the login of the latest turn. */
  login: LoginStatus;
  settings: () => Settings;
  /** Sends an app-level event to every connected window. */
  broadcast: (e: ServerEvent) => void;
}

/** One open project: its Blender, scene files, copilot, journal and the windows watching it. */
export class Project {
  meta: ProjectMeta;
  readonly dir: string;
  readonly ws: Workspace;
  readonly bridge: BlenderBridge;
  readonly copilot: Copilot;
  readonly journal: Journal;
  readonly clients = new Set<Sink>();
  blender: BlenderInfo;
  scene: SceneState = { version: 0, glb: null, summary: null, canUndo: false };
  closeTimer: NodeJS.Timeout | null = null;
  /** Last use through the API by another app (projects nobody watches close after a while). */
  lastApi = 0;
  private lockState: { by: string; until: number } | null = null;
  private lockTimer: NodeJS.Timeout | null = null;

  /** Another app is building this model (seconds 0 = done). Chat and undo wait until it expires. */
  setLock(by: string, seconds: number) {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = null;
    this.lockState = seconds > 0 ? { by: by.slice(0, 40) || 'Another app', until: Date.now() + seconds * 1000 } : null;
    if (this.lockState) this.lockTimer = setTimeout(() => this.setLock('', 0), seconds * 1000 + 50);
    this.emit({ type: 'lock', lock: this.lock });
  }

  get lock(): { by: string; until: number } | null {
    return this.lockState && this.lockState.until > Date.now() ? this.lockState : null;
  }
  ready: Promise<void>;
  titled: boolean;
  private readonly manager: Projects;

  constructor(meta: ProjectMeta, manager: Projects, host: ProjectsHost) {
    this.meta = meta;
    this.manager = manager;
    this.dir = join(PROJECTS_DIR, meta.id);
    this.titled = meta.title !== UNTITLED && meta.title !== NEW_PROJECT && !!(meta as ProjectMeta & { named?: boolean }).named;
    this.journal = new Journal(meta.id, () => this.meta.title);
    this.bridge = host.pool.acquire();
    this.blender = this.bridge.info;
    this.bridge.onInfo = (info) => {
      this.blender = info;
      this.emit({ type: 'blender', blender: info });
      if (info.status === 'restarting') this.copilot?.signal(`Blender restarted: ${info.detail ?? ''}`, 2, ['blender-restart']);
    };
    this.ws = new Workspace(this.dir, `/files/${meta.id}`, this.bridge, (s) => {
      const animBefore = this.scene?.summary?.rig?.anim ?? '';
      this.scene = s;
      this.emit({ type: 'scene', scene: s });
      if ((s.summary?.rig?.anim ?? '') !== animBefore) this.emit({ type: 'clips', clips: s.summary?.rig?.clips ?? [], url: s.clips ?? null });
      const sum = s.summary;
      const next = { objects: sum?.objects ?? 0, tris: sum?.tris ?? 0, version: s.version, fingerprint: s.fingerprint ?? null };
      // Only a change touches the project (opening one must not move it to the top of the recents).
      if (next.objects !== this.meta.objects || next.tris !== this.meta.tris || next.version !== this.meta.version || next.fingerprint !== (this.meta.fingerprint ?? null)) this.update(next);
    });
    this.ws.units = meta.units ?? 'm';
    this.ws.roblox = isRoblox(meta);
    // What another project's kiln.piece (or another app) compares against: current the moment the scene is saved.
    this.ws.onSaved = (version, fingerprint) => {
      if (version !== this.meta.version || fingerprint !== (this.meta.fingerprint ?? null)) this.update({ version, fingerprint });
    };
    this.bridge.restorePath = () => this.ws.restorePath();
    this.copilot = new Copilot({
      projectId: meta.id,
      dir: this.dir,
      ws: this.ws,
      login: host.login,
      journal: this.journal,
      settings: host.settings,
      title: () => this.meta.title,
      needsTitle: () => !this.titled,
      units: () => ({ units: this.meta.units ?? 'm', linked: this.meta.linked ? 'Shuriken Studio' : null }),
      roblox: () => (isRoblox(this.meta) ? { lighting: this.meta.lighting ?? null } : null),
      emit: (e) => this.emit(e),
      style: () => (this.meta.style ? { id: this.meta.style, sheet: readStyle(this.meta.style) } : null),
      saveStyle: (sheet) => {
        if (!this.meta.style) return 'This project belongs to no game with a style id (no brief named one), so nothing was saved. Carry on.';
        const saved = saveStyle(this.meta.style, { ...sheet, units: this.meta.units ?? 'm' }, this.meta.id);
        return `Saved as the game's style sheet "${saved.id}" (${saved.palette.length} colours, ${saved.materials.length} materials). The game's other models follow it from now on; use these material names yourself too.`;
      },
      // Named after the first build, from what the model is: not from the wording of the request, and
      // not while the scene is still empty (the copilot may only have asked a question).
      onTitle: (t) => {
        if ((this.ws.summaryNow?.objects ?? 0) > 0) this.rename(t, true);
      },
      onRunning: (running) => {
        this.manager.changed();
        // A turn that ends with no window watching (its tab was closed mid-turn) must still let the project close.
        if (!running) this.manager.idle(this);
      },
    });
    this.ready = this.load();
    // KILN_NO_WARM=1 (tests): don't start a Claude session until a message is sent. Models another app
    // builds here (Shuriken) only start one when the user chats in them.
    if (process.env.KILN_NO_WARM !== '1' && !meta.linked) this.copilot.warm();
  }

  private load(): Promise<void> {
    return this.bridge
      .start()
      .then(() => this.ws.init())
      .catch((e: Error) => this.emit({ type: 'notice', level: 'error', text: `Blender: ${e.message}` }));
  }

  /** Blender was installed after this project opened: its scene loads now. */
  blenderFound(exe: string) {
    if (this.bridge.info.status !== 'missing') return;
    this.bridge.found(exe);
    this.ready = this.load();
  }

  emit(e: ServerEvent) {
    const data = JSON.stringify(e);
    for (const c of this.clients) c.send(data);
  }

  state(): ProjectState {
    return {
      project: this.meta,
      messages: this.copilot.messages,
      running: this.copilot.running,
      scene: this.scene,
      blender: this.blender,
      todos: this.copilot.todos,
      suggestions: this.copilot.suggestions,
      lock: this.lock,
    };
  }

  update(patch: Partial<ProjectMeta>) {
    this.meta = { ...this.meta, ...patch, updatedAt: new Date().toISOString() };
    this.manager.writeMeta(this.meta, this.titled);
    this.emit({ type: 'project', project: this.meta });
    this.manager.changed();
  }

  /** Where the model ends up (see ProjectMeta.target) and the game's lighting; the copilot's instructions follow. */
  setTarget(target: 'roblox' | null | undefined, lighting: RobloxLighting | null | undefined) {
    const before = isRoblox(this.meta);
    const patch: Partial<ProjectMeta> = {};
    if (target !== undefined) patch.target = target;
    if (lighting !== undefined) patch.lighting = lighting;
    this.update(patch);
    this.ws.roblox = isRoblox(this.meta);
    if (before !== isRoblox(this.meta)) this.copilot.instructionsChanged();
  }

  rename(title: string, fromCopilot = false) {
    const t = title.trim().slice(0, 40);
    if (!t) return;
    if (fromCopilot && this.titled) return;
    this.titled = true;
    this.update({ title: t });
  }

  close() {
    this.copilot.dispose();
    this.bridge.stop();
  }
}

/**
 * Projects on disk (Documents\Kiln\<id>\) and the ones open in a tab. A project opens when a
 * window subscribes to it and closes a little after its last window goes away.
 */
export class Projects {
  private open = new Map<string, Project>();
  private readonly host: ProjectsHost;
  private changeTimer: NodeJS.Timeout | null = null;
  /**
   * Each project folder's project.json as last read. list() read every one of them each time: ~170 ms of a blocked
   * core with 1,100 projects, for every GET /app (Shuriken's health check, every few seconds per window) and every
   * change broadcast. With many builds running the core stopped answering in time, and Shuriken took Kiln for gone.
   * A folder is read again once this core wrote it, or after META_TTL_MS (spread out, so they don't expire at once).
   */
  private metas = new Map<string, { meta: ProjectMeta | null; at: number }>();
  /** Projects being moved to the trash: nothing may open them meanwhile (a window reconnecting, an API call). */
  private deleting = new Set<string>();
  /** Folder sizes for the storage view, by project and the updatedAt they were measured at. */
  private sizes = new Map<string, { at: string; bytes: number; history: number; viewer: number; renders: number }>();

  constructor(host: ProjectsHost) {
    this.host = host;
    // Projects opened only through the API (Shuriken's models) close when idle, like watched ones do.
    setInterval(() => {
      for (const p of [...this.open.values()]) {
        if (p.clients.size || p.copilot.running || !p.lastApi || Date.now() - p.lastApi < API_IDLE_MS) continue;
        p.close();
        this.open.delete(p.meta.id);
        this.changed();
      }
    }, 60_000).unref();
  }

  private metaFile(id: string) {
    return join(PROJECTS_DIR, id, 'project.json');
  }

  writeMeta(meta: ProjectMeta, named: boolean) {
    try {
      writeAtomic(this.metaFile(meta.id), JSON.stringify({ ...meta, named }, null, 2));
    } catch {
      /* folder removed */
    }
    this.metas.delete(meta.id);
  }

  private cachedMeta(id: string): ProjectMeta | null {
    const hit = this.metas.get(id);
    if (hit && Date.now() - hit.at < META_TTL_MS) return hit.meta;
    const meta = this.readMeta(id);
    this.metas.set(id, { meta, at: Date.now() - (hit ? 0 : Math.random() * META_TTL_MS * 0.5) });
    return meta;
  }

  readMeta(id: string): ProjectMeta | null {
    try {
      const m = JSON.parse(readFileSync(this.metaFile(id), 'utf8')) as ProjectMeta;
      // Any folder can hold a project.json: only one shaped like Kiln's counts.
      if (!m || typeof m !== 'object' || typeof m.title !== 'string' || typeof m.updatedAt !== 'string') return null;
      const thumb = existsSync(join(PROJECTS_DIR, id, 'thumb.jpg')) ? `/files/${id}/thumb.jpg?v=${Date.parse(m.updatedAt) || 0}` : null;
      return { ...m, id, thumb };
    } catch {
      return null;
    }
  }

  /** Recent projects, newest first. */
  list(limit = 48): ProjectSummary[] {
    const out: ProjectSummary[] = [];
    const ids = readdirSync(PROJECTS_DIR);
    if (this.metas.size > ids.length * 2) this.metas.clear();
    for (const id of ids) {
      if (!/^[a-z0-9-]+$/i.test(id)) continue;
      const m = this.open.get(id)?.meta ?? this.cachedMeta(id);
      if (!m) continue;
      const p = this.open.get(id);
      out.push({ ...m, open: !!p, working: !!p?.copilot.running });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }

  /** A new project. From the chat it waits for the copilot's name; another app (Shuriken) names it. */
  create(firstMessage: string, opts: { title?: string; units?: 'm' | 'studs'; linked?: ProjectMeta['linked']; target?: 'roblox' | null; lighting?: RobloxLighting | null } = {}): ProjectMeta {
    // The folder gets a hint from the request; the visible name waits for the copilot.
    let id = `${slug(titleFrom(opts.title || firstMessage))}-${Date.now().toString(36).slice(-5)}`;
    const title = opts.title?.trim().slice(0, 40) || NEW_PROJECT;
    while (existsSync(join(PROJECTS_DIR, id))) id += 'x';
    mkdirSync(join(PROJECTS_DIR, id), { recursive: true });
    const now = new Date().toISOString();
    const meta: ProjectMeta = {
      id, title, createdAt: now, updatedAt: now, objects: 0, tris: 0, thumb: null,
      ...(opts.units ? { units: opts.units } : {}),
      ...(opts.linked ? { linked: opts.linked } : {}),
      ...(opts.target !== undefined ? { target: opts.target } : {}),
      ...(opts.lighting ? { lighting: opts.lighting } : {}),
    };
    this.writeMeta(meta, !!opts.title);
    this.changed();
    return meta;
  }

  exists(id: string): boolean {
    return /^[a-z0-9-]+$/i.test(id) && !this.deleting.has(id) && existsSync(this.metaFile(id));
  }

  /** The open project, opening it (Blender, copilot) if needed. */
  get(id: string): Project | null {
    const have = this.open.get(id);
    if (have) return have;
    if (this.deleting.has(id)) return null;
    const meta = this.readMeta(id);
    if (!meta) return null;
    const p = new Project(meta, this, this.host);
    this.open.set(id, p);
    this.changed();
    return p;
  }

  each(fn: (p: Project) => void) {
    for (const p of this.open.values()) fn(p);
  }

  /** Closes a project nobody watches and nobody is working in (another app capping its Blenders). */
  closeIdle(id: string): boolean {
    const p = this.open.get(id);
    if (!p || p.clients.size || p.copilot.running) return false;
    p.close();
    this.open.delete(id);
    this.changed();
    return true;
  }

  isOpen(id: string): boolean {
    return this.open.has(id);
  }

  peek(id: string): Project | undefined {
    return this.open.get(id);
  }

  attach(p: Project, res: Sink) {
    if (p.closeTimer) clearTimeout(p.closeTimer);
    p.closeTimer = null;
    p.clients.add(res);
  }

  detach(p: Project, res: Sink) {
    p.clients.delete(res);
    this.idle(p);
  }

  /** Closes a project a little after nobody watches it and nothing runs in it. (API-only projects close by the idle sweep.) */
  idle(p: Project) {
    if (p.clients.size || p.copilot.running || p.lastApi || this.open.get(p.meta.id) !== p) return;
    if (p.closeTimer) clearTimeout(p.closeTimer);
    p.closeTimer = setTimeout(() => {
      p.closeTimer = null;
      if (p.clients.size || p.copilot.running || this.open.get(p.meta.id) !== p) return;
      p.close();
      this.open.delete(p.meta.id);
      this.changed();
    }, CLOSE_AFTER_MS);
  }

  // --- storage --------------------------------------------------------------------------------------

  /**
   * What each project takes on disk, largest first. Measured without blocking the core (thousands of projects took
   * it seconds, during which nothing else answered), and remembered until a project changes.
   */
  async storage(): Promise<Array<{ id: string; title: string; updatedAt: string; open: boolean; working: boolean; linked: boolean; bytes: number; history: number; viewer: number; renders: number }>> {
    const out = [];
    for (const m of this.list(Infinity)) {
      let s = this.sizes.get(m.id);
      if (!s || s.at !== m.updatedAt || m.open) {
        const dir = join(PROJECTS_DIR, m.id);
        const [bytes, history, viewer, renders] = await Promise.all([bytesUnder(dir), bytesUnder(join(dir, 'history')), bytesUnder(join(dir, 'glb')), bytesUnder(join(dir, 'renders'))]);
        s = { at: m.updatedAt, bytes, history, viewer, renders };
        this.sizes.set(m.id, s);
      }
      out.push({ id: m.id, title: m.title, updatedAt: m.updatedAt, open: m.open, working: m.working, linked: !!m.linked, bytes: s.bytes, history: s.history, viewer: s.viewer, renders: s.renders });
    }
    return out.sort((a, b) => b.bytes - a.bytes);
  }

  /**
   * Frees space in projects that aren't open: undo steps beyond the last `keep`, old viewer files and the
   * Roblox bakes of older versions, and anything in the trash for more than a week. `olderThanDays` limits
   * it to projects left alone that long (the automatic tidy at startup). Returns the bytes freed.
   */
  tidy(keep = 3, olderThanDays = 0): number {
    let freed = 0;
    const drop = (file: string) => {
      try {
        const s = statSync(file);
        freed += s.isDirectory() ? folderBytes(file) : s.size;
        rmSync(file, { recursive: true, force: true });
      } catch {
        /* gone already */
      }
    };
    for (const m of this.list(1000)) {
      if (m.open || (olderThanDays && Date.now() - Date.parse(m.updatedAt) < olderThanDays * 86_400_000)) continue;
      const dir = join(PROJECTS_DIR, m.id);
      const sorted = (sub: string, re: RegExp) => {
        try {
          return readdirSync(join(dir, sub)).filter((f) => re.test(f)).sort();
        } catch {
          return [];
        }
      };
      for (const f of sorted('history', /^v\d+\.blend$/).slice(0, -keep)) drop(join(dir, 'history', f));
      for (const f of sorted('glb', /\.glb$/).slice(0, -1)) drop(join(dir, 'glb', f));
      for (const f of sorted('exports', /^roblox-v\d+$/).slice(0, -1)) drop(join(dir, 'exports', f));
    }
    const trash = join(PROJECTS_DIR, '.trash');
    try {
      for (const f of readdirSync(trash)) if (Date.now() - statSync(join(trash, f)).mtimeMs > 7 * 86_400_000) drop(join(trash, f));
    } catch {
      /* no trash yet */
    }
    return freed;
  }

  /**
   * Moves a project to Documents\Kiln\.trash (kept a week, then removed by tidy). Open projects are closed first:
   * every window showing it goes back to its start page (a 'deleted' event), and a project another app (Shuriken)
   * opened through the API is closed like any other. A running copilot is stopped when `stop` is set, else the
   * delete is refused. Kiln 0.8 refused any project open in a tab, and its Delete was greyed out for every open
   * project (the current tab's, and each one Shuriken kept open): deleting didn't work.
   */
  async trash(id: string, opts: { stop?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
    if (this.deleting.has(id)) return { ok: false, error: 'This project is already being deleted' };
    const p = this.open.get(id);
    if (p?.copilot.running) {
      if (!opts.stop) return { ok: false, error: 'The copilot is working in this project: stop it first (or delete with stop: true)' };
      await p.copilot.stop();
      for (let i = 0; i < 100 && p.copilot.running; i++) await new Promise((r) => setTimeout(r, 200));
      if (p.copilot.running) return { ok: false, error: 'The copilot did not stop in time. Try again.' };
    }
    this.deleting.add(id);
    try {
      const title = p?.meta.title ?? this.readMeta(id)?.title ?? id;
      // Every window showing it goes back to its start page before its live connection closes.
      this.host.broadcast({ type: 'deleted', projectId: id, title });
      if (p) {
        this.open.delete(id);
        if (p.closeTimer) clearTimeout(p.closeTimer);
        p.closeTimer = null;
        for (const c of [...p.clients]) {
          try {
            c.close();
          } catch {
            /* already gone */
          }
        }
        p.clients.clear();
        p.close();
        // Windows keeps a running program's files (and its working folder) locked: wait for Blender to exit.
        await p.bridge.exited(8000);
      }
      mkdirSync(join(PROJECTS_DIR, '.trash'), { recursive: true });
      // Claude Code (which runs in the project's folder) and Blender let go a moment after they exit (EBUSY): try again.
      for (let attempt = 0; ; attempt++) {
        try {
          renameSync(join(PROJECTS_DIR, id), join(PROJECTS_DIR, '.trash', `${id}-${Date.now().toString(36)}`));
          break;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' && !existsSync(join(PROJECTS_DIR, id))) break;
          if ((code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') && attempt < 60) {
            await new Promise((r) => setTimeout(r, 250));
            continue;
          }
          logCore(`moving ${id} to the trash failed: ${(e as Error).message}`);
          return { ok: false, error: `Could not move the project: ${(e as Error).message}. Is one of its files open in another program?` };
        }
      }
      this.metas.delete(id);
      this.sizes.delete(id);
      return { ok: true };
    } finally {
      this.deleting.delete(id);
      this.changed();
    }
  }

  /** Tells every window that project titles / working states changed (debounced). */
  changed() {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.host.broadcast({ type: 'projects', projects: this.list() });
    }, 60);
  }

  closeAll() {
    for (const p of this.open.values()) p.close();
    this.open.clear();
  }
}

/** Bytes under a folder (0 when it is missing), read without blocking. */
async function bytesUnder(dir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    try {
      const s = await stat(join(dir, name));
      total += s.isDirectory() ? await bytesUnder(join(dir, name)) : s.size;
    } catch {
      /* removed meanwhile */
    }
  }
  return total;
}
