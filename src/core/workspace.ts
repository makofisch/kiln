import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { BlenderBridge, BridgeReply } from './blender.ts';
import { logCore, writeAtomic } from './fsx.ts';
import { readRobloxManifest, robloxExport, type RobloxManifest } from './robloxExport.ts';
import type { RobloxLighting, SceneState, SceneSummary } from '../shared/types.ts';

const KEEP_HISTORY = 30;
/** Undo history is also capped by size (big scenes were filling the disk), keeping at least a few steps. */
const HISTORY_BYTES = 200 * 1024 * 1024;
const MIN_HISTORY = 5;
const KEEP_GLB = 2;
const KEEP_RENDERS = 60;

/** Two surfaces that will z-fight (blender/checks.py find_zfight). b == a and inside: two layers inside one mesh. */
export interface ZFight {
  a: string;
  b: string;
  faces: number;
  where: number[];
  inside?: boolean;
  /** How far apart they are (scene units; 0 when flush) and how far apart they must be. */
  sep?: number;
  gap?: number;
  kind?: 'flush' | 'layer';
  front?: string;
}

/** The safe distance between overlapping layers in this project (scene units). */
export interface ZFightRule {
  gap: number;
  per_width: number;
  cap: number;
  flush: number;
  units: 'm' | 'studs';
  roblox: boolean;
}

export interface SceneIssues {
  zfight: ZFight[];
  zfight_pairs: number;
  zfight_rule?: ZFightRule;
  zfight_truncated?: boolean;
  floating: Array<{ object: string; gap_below_m: number }>;
  below_ground?: Array<{ object: string; top_z: number }>;
  moved?: Array<{ object: string; action?: string; from?: string; inside?: boolean; by?: number; by_mm?: number; direction?: number[] }>;
  faces_checked?: number;
}

// GPU work across every project. A pretty (Eevee) render or a Roblox bake takes about 1 GB of video memory
// while it runs (measured on an 8 GB RTX 4060: +1.0 to +1.1 GB at the peak, about 50 MB kept afterwards).
// Twelve at once froze that machine; eight just survived. Three at a time leave room for the viewer, for
// Roblox Studio and for bigger renders, and a build waits only seconds for its turn: builds spend their
// time in the model, not in renders. KILN_GPU_SLOTS overrides it.
const GPU_SLOTS = Math.max(1, Math.min(16, Number(process.env.KILN_GPU_SLOTS) || 3));
let gpuBusy = 0;
let gpuWaitedMs = 0;
const gpuWaiting: Array<() => void> = [];

/** Runs GPU-heavy work when a slot is free. */
export async function withGpu<T>(work: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  while (gpuBusy >= GPU_SLOTS) await new Promise<void>((r) => gpuWaiting.push(r));
  gpuWaitedMs += Date.now() - t0;
  gpuBusy++;
  try {
    return await work();
  } finally {
    gpuBusy--;
    gpuWaiting.shift()?.();
  }
}

/** How loaded the GPU gate is: for callers that pace their own queue. */
export function gpuLoad(): { slots: number; busy: number; waiting: number; waitedMs: number } {
  return { slots: GPU_SLOTS, busy: gpuBusy, waiting: gpuWaiting.length, waitedMs: gpuWaitedMs };
}

/** What Roblox would lose or refuse (see blender/kiln_roblox.py check). */
export interface RobloxCheck {
  ok: boolean;
  error?: string;
  problems: string[];
  notes: string[];
  summary: string;
  materials: number;
  tris: number;
  parts: number;
  /** Unique meshes (objects that share one are uploaded once). */
  meshes?: number;
  joints: number;
  /** Map data in the scene: pieces from other projects and how many placements, markers, paths, roles and colliders. */
  layout?: {
    pieces: Record<string, { project: string; version: number; fingerprint: string; tris: number; placements: number; stale: boolean }>;
    placements: number;
    markers: number;
    paths: number;
    roles: number;
    colliders: number;
  } | null;
  /** One line about the game's lighting. */
  lighting: string;
}

export interface ExecResult {
  issues: SceneIssues | null;
  ok: boolean;
  error: string | null;
  output: string;
  added: string[];
  removed: string[];
  summary: SceneSummary | null;
  changed: boolean;
  version: number;
  ms: number;
  /** The script failed and the scene was put back as it was before the call (undo_on_error). */
  rolledBack?: boolean;
  /** The automatic clash check didn't run (the scene is over its triangle limit). */
  checkSkipped?: boolean;
}

/**
 * The scene on disk: scene.blend (the live state), history/ snapshots (undo), glb/ exports the
 * viewer loads, renders/ and exports/. Every change the copilot makes is saved, snapshotted and
 * exported, so the viewer and a restarted Blender always see the latest good state.
 */
export class Workspace {
  readonly dir: string;
  /** URL prefix the files of this project are served under, e.g. /files/<projectId>. */
  private readonly urlBase: string;
  private readonly bridge: BlenderBridge;
  private readonly onScene: (s: SceneState) => void;
  private fingerprint: string | null = null;
  /** The project's units (the Roblox check measures part sizes in studs). */
  units: 'm' | 'studs' = 'm';
  /** The model goes into a Roblox game (the z-fighting check's safe gap follows it). */
  roblox = false;
  /** Called as soon as a version is on disk (the viewer's files follow a moment later). */
  onSaved: ((version: number, fingerprint: string | null) => void) | null = null;
  private summary: SceneSummary | null = null;
  private glb: string | null = null;
  private clipsUrl: string | null = null;
  private animFp: string | null = null;
  version = 0;
  private renderCount = 0;

  constructor(dir: string, urlBase: string, bridge: BlenderBridge, onScene: (s: SceneState) => void) {
    this.dir = dir;
    this.urlBase = urlBase;
    this.bridge = bridge;
    this.onScene = onScene;
    for (const d of ['history', 'glb', 'renders', 'uploads', 'exports', 'archive', 'anim']) mkdirSync(join(dir, d), { recursive: true });
    const snaps = this.snapshots();
    this.version = snaps.length ? Number(/v(\d+)/.exec(snaps[snaps.length - 1]!)?.[1] ?? 0) : 0;
    // Numbered after the highest file, not the file count: names must not repeat once old renders are pruned.
    this.renderCount = readdirSync(join(dir, 'renders')).reduce((m, f) => Math.max(m, Number(/-(\d{6})/.exec(f)?.[1] ?? 0)), 0);
  }

  /** One scene operation at a time: run + save, undo, import. (The bridge queues single calls; these are several each.) */
  private ops: Promise<unknown> = Promise.resolve();
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.ops.then(fn, fn);
    this.ops = p.catch(() => undefined);
    return p;
  }

  private pruneRenders(): void {
    try {
      const all = readdirSync(join(this.dir, 'renders')).sort((a, b) => Number(/-(\d{6})/.exec(a)?.[1] ?? 0) - Number(/-(\d{6})/.exec(b)?.[1] ?? 0));
      for (const old of all.slice(0, Math.max(0, all.length - KEEP_RENDERS))) rmSync(join(this.dir, 'renders', old), { force: true });
    } catch {
      /* best-effort */
    }
  }

  get summaryNow(): SceneSummary | null {
    return this.summary;
  }

  get scenePath() {
    return join(this.dir, 'scene.blend');
  }

  /** The file Blender reopens after a (re)start. */
  restorePath(): string | null {
    return existsSync(this.scenePath) ? this.scenePath : null;
  }

  private snapshots(): string[] {
    return readdirSync(join(this.dir, 'history'))
      .filter((f) => /^v\d+\.blend$/.test(f))
      .sort();
  }

  state(): SceneState {
    return { version: this.version, fingerprint: this.fingerprint, glb: this.glb, summary: this.summary, canUndo: this.snapshots().length > 1, clips: this.clipsUrl };
  }

  /** Loads the current scene into Blender and the viewer (startup). */
  async init(): Promise<void> {
    const restore = this.restorePath();
    // A Blender started for this project has the scene loaded already: read it instead of loading it again.
    await this.bridge.start().catch(() => undefined);
    const loaded = this.bridge.restored === restore;
    const r = loaded ? await this.bridge.call('scene', { limit: 300 }) : restore ? await this.bridge.call('open', { path: restore }) : await this.bridge.call('new');
    if (!r.ok) throw new Error(r.error ?? 'could not read the scene');
    this.fingerprint = r.fingerprint as string;
    this.summary = r.summary as SceneSummary;
    if (!this.snapshots().length) {
      await this.commit();
      await this.settled();
    } else if (!this.reuseExports()) await this.exportGlb();
    this.onScene(this.state());
  }

  /** The viewer files written for this version last time, when they are newer than the scene file. */
  private reuseExports(): boolean {
    try {
      const sceneAt = statSync(this.scenePath).mtimeMs;
      const tag = `-${this.pad(this.version)}-`;
      const empty = !this.summary || this.summary.objects === 0 || this.summary.tris === 0;
      if (!empty) {
        const glb = readdirSync(join(this.dir, 'glb')).filter((f) => f.startsWith(`scene${tag}`)).sort().pop();
        if (!glb || statSync(join(this.dir, 'glb', glb)).mtimeMs < sceneAt) return false;
        this.glb = `${this.urlBase}/glb/${glb}`;
      }
      const rig = this.summary?.rig;
      if (rig && rig.clips.length) {
        const clips = readdirSync(join(this.dir, 'anim')).filter((f) => f.startsWith(`clips${tag}`)).sort().pop();
        if (!clips || statSync(join(this.dir, 'anim', clips)).mtimeMs < sceneAt) return false;
        this.clipsUrl = `${this.urlBase}/anim/${clips}`;
        this.animFp = rig.anim;
      }
      return true;
    } catch {
      return false;
    }
  }

  private pad(n: number) {
    return String(n).padStart(6, '0');
  }

  /**
   * Saves and snapshots the current Blender state as a new version. The viewer's files (GLB, clips) are
   * written right after, without making the caller wait: the copilot gets its tool result as soon as the
   * change is safe on disk, and the viewer updates when the export lands.
   */
  private async commit(): Promise<void> {
    this.version++;
    const version = this.version;
    const save = await this.bridge.call('save', { path: this.scenePath });
    if (save.ok) {
      try {
        copyFileSync(this.scenePath, join(this.dir, 'history', `v${this.pad(version)}.blend`));
      } catch (e) {
        logCore(`snapshot v${version} of ${this.dir} failed: ${(e as Error).message}`);
      }
      this.pruneHistory();
      this.onSaved?.(version, this.fingerprint);
    }
    this.exportSoon();
  }

  private exporting: Promise<void> | null = null;
  private exportAgain = false;

  private exportSoon(): void {
    if (this.exporting) {
      this.exportAgain = true;
      return;
    }
    this.exporting = (async () => {
      do {
        this.exportAgain = false;
        await this.exportGlb();
        this.onScene(this.state());
      } while (this.exportAgain);
    })()
      .catch((e: Error) => logCore(`viewer export of ${this.dir} failed: ${e.message}`))
      .finally(() => {
        this.exporting = null;
      });
  }

  /** Resolves once the viewer's files match the saved scene. */
  settled(): Promise<void> {
    return this.exporting ?? Promise.resolve();
  }

  private pruneHistory(): void {
    const snaps = this.snapshots();
    let drop = Math.max(0, snaps.length - KEEP_HISTORY);
    let total = 0;
    const sizes = snaps.map((f) => {
      try {
        return statSync(join(this.dir, 'history', f)).size;
      } catch {
        return 0;
      }
    });
    for (let i = snaps.length - 1; i >= 0; i--) {
      total += sizes[i]!;
      if (total > HISTORY_BYTES && snaps.length - i > MIN_HISTORY) {
        drop = Math.max(drop, i + 1);
        break;
      }
    }
    for (const old of snaps.slice(0, drop)) rmSync(join(this.dir, 'history', old), { force: true });
  }

  /** Every clip sampled to JSON for the viewer, when the rig's animation changed. */
  private async exportClips(): Promise<void> {
    const rig = this.summary?.rig;
    if (!rig || !rig.clips.length) {
      this.clipsUrl = null;
      this.animFp = null;
      return;
    }
    if (rig.anim === this.animFp && this.clipsUrl) return;
    const name = `clips-${this.pad(this.version)}-${Date.now().toString(36)}.json`;
    try {
      const r = await this.bridge.call('clips_export', { path: join(this.dir, 'anim', name) }, 180_000);
      if (!r.ok) {
        console.error(`Clip export failed: ${r.error}`);
        return;
      }
      this.clipsUrl = `${this.urlBase}/anim/${name}`;
      this.animFp = rig.anim;
      const all = readdirSync(join(this.dir, 'anim')).filter((f) => f.startsWith('clips-')).sort();
      for (const old of all.slice(0, -3)) rmSync(join(this.dir, 'anim', old), { force: true });
    } catch (e) {
      console.error(`Clip export failed: ${(e as Error).message}`);
    }
  }

  /** A clip as images for the copilot (see bridge op_motion). */
  async motion(opts: { clip?: string; views?: string[]; view?: string; count?: number }): Promise<{ ok: boolean; error?: string; clip?: string; images?: Array<{ view: string; file: string; url: string }>; notes?: string[] }> {
    this.renderCount++;
    const base = join(this.dir, 'renders', `motion-${this.pad(this.renderCount)}`);
    const r = await this.bridge.call('motion', { clip: opts.clip, views: opts.views, view: opts.view, count: opts.count, base }, 240_000);
    if (!r.ok) return { ok: false, error: (r.error as string) ?? 'could not show the motion' };
    const images = (r.images as Array<{ view: string; path: string }>).map((i) => ({ view: i.view, file: i.path, url: `${this.urlBase}/renders/${basename(i.path)}` }));
    return { ok: true, clip: r.clip as string, images, notes: (r.notes as string[]) ?? [] };
  }

  /** kiln.anim.check on a clip (read only). */
  async animCheck(clip: string): Promise<BridgeReply> {
    return this.bridge.call('anim_check', { clip }, 120_000);
  }

  /** The rig, its clips and the rig check (read only). */
  async rig(): Promise<BridgeReply> {
    return this.bridge.call('rig', {}, 60_000);
  }

  /** Each top-level model (origin, size, triangles, materials, sockets) and how the sockets fit (read only). */
  parts(): Promise<BridgeReply> {
    return this.locked(() => this.bridge.call('parts', { project_dir: this.dir }, 120_000));
  }

  private async exportGlb(): Promise<void> {
    await this.exportClips();
    if (!this.summary || this.summary.objects === 0 || this.summary.tris === 0) {
      this.glb = null;
      return;
    }
    const name = `scene-${this.pad(this.version)}-${Date.now().toString(36)}.glb`;
    // Blender's glTF exporter appends ".glb" to paths without it, so the temp name must end in .glb.
    const tmp = join(this.dir, 'glb', `partial-${name}`);
    try {
      // A long export must not count as a hang (a timeout restarts Blender and loses the Python session).
      const r = await this.bridge.call('export', { format: 'glb', path: tmp, viewer: true }, 600_000);
      if (!r.ok) {
        rmSync(tmp, { force: true });
        logCore(`GLB export of ${this.dir} failed: ${r.error}`);
        return;
      }
      renameSync(tmp, join(this.dir, 'glb', name));
      this.glb = `${this.urlBase}/glb/${name}`;
      const all = readdirSync(join(this.dir, 'glb')).filter((f) => f.startsWith('scene-')).sort();
      for (const old of all.slice(0, -KEEP_GLB)) rmSync(join(this.dir, 'glb', old), { force: true });
    } catch (e) {
      console.error(`GLB export failed: ${(e as Error).message}`);
    }
  }

  /**
   * Runs copilot Python in Blender; commits a new version when the scene changed. undoOnError: a script
   * that fails part-way is thrown away (the scene is reloaded from the last version) instead of kept.
   */
  exec(code: string, timeoutMs: number, undoOnError = false): Promise<ExecResult> {
    return this.locked(() => this.execNow(code, timeoutMs, undoOnError));
  }

  private async execNow(code: string, timeoutMs: number, undoOnError: boolean): Promise<ExecResult> {
    const t0 = Date.now();
    const r = await this.bridge.call('exec', { code, check: true, previous: this.fingerprint, project_dir: this.dir, units: this.units, roblox: this.roblox }, timeoutMs);
    let changed = false;
    let rolledBack = false;
    if (r.timedOut) {
      await this.refresh();
    } else if (!r.ok && undoOnError && r.fingerprint && r.fingerprint !== this.fingerprint && existsSync(this.scenePath)) {
      const back = await this.bridge.call('open', { path: this.scenePath, keep: true });
      if (back.ok) {
        this.fingerprint = back.fingerprint as string;
        this.summary = back.summary as SceneSummary;
        rolledBack = true;
      }
    } else if (r.fingerprint && r.fingerprint !== this.fingerprint) {
      this.fingerprint = r.fingerprint as string;
      this.summary = r.summary as SceneSummary;
      try {
        await this.commit();
      } catch (e) {
        logCore(`Saving version ${this.version} failed: ${(e as Error).message}`);
      }
      changed = true;
    }
    if (rolledBack) return { issues: null, ok: false, error: (r.error as string | null) ?? null, output: (r.output as string) ?? '', added: [], removed: [], summary: this.summary, changed: false, version: this.version, ms: Date.now() - t0, rolledBack };
    return {
      issues: (r.issues as SceneIssues | null) ?? null,
      ok: r.ok,
      error: (r.error as string | null) ?? null,
      output: (r.output as string) ?? '',
      added: (r.added as string[]) ?? [],
      removed: (r.removed as string[]) ?? [],
      summary: (r.summary as SceneSummary) ?? this.summary,
      changed,
      version: this.version,
      ms: Date.now() - t0,
      checkSkipped: r.check_skipped === true,
    };
  }

  /** Re-reads the scene after Blender reloaded it (timeouts, undo, reset). */
  private async refresh(): Promise<void> {
    const s = await this.bridge.call('scene');
    if (s.ok) {
      this.fingerprint = s.fingerprint as string;
      this.summary = s.summary as SceneSummary;
    }
  }

  /** Scene check (z-fighting, floating, below ground); `fix` moves z-fighting layers apart and commits when something moved. */
  check(fix: boolean): Promise<SceneIssues & { ok: boolean; error?: string }> {
    return this.locked(async () => {
      const r = await this.bridge.call('check', { fix, units: this.units, roblox: this.roblox }, 120_000);
      if (r.ok && r.fingerprint && r.fingerprint !== this.fingerprint) {
        this.fingerprint = r.fingerprint as string;
        this.summary = r.summary as SceneSummary;
        await this.commit();
      }
      return r as unknown as SceneIssues & { ok: boolean; error?: string };
    });
  }

  async scene(): Promise<BridgeReply> {
    return this.bridge.call('scene', { limit: 300 });
  }

  /** lighting "roblox" (pretty renders): lit like a Roblox place (robloxLighting, or a new place's defaults), showing only what Roblox can show. */
  async render(opts: { views?: string[]; quality?: string; size?: number; focus?: string[]; isolate?: boolean; frames?: number[]; figure?: boolean; figureHeight?: number; lighting?: 'scene' | 'roblox'; robloxLighting?: RobloxLighting | null }): Promise<{ ok: boolean; error?: string; file?: string; url?: string; views?: string[]; lighting?: string; figure?: string; unknownFocus?: string[] }> {
    this.renderCount++;
    const name = `render-${this.pad(this.renderCount)}.png`;
    const file = join(this.dir, 'renders', name);
    const timeout = opts.quality === 'pretty' ? 300_000 : 120_000;
    const call = (work: () => Promise<BridgeReply>) => (opts.quality === 'pretty' ? withGpu(work) : work());
    const r = await call(() => this.bridge.call(
      'render',
      { path: file, views: opts.views, quality: opts.quality, size: opts.size, focus: opts.focus, isolate: opts.isolate, frames: opts.frames, figure: opts.figure, figure_height: opts.figureHeight, lighting: opts.lighting, roblox_lighting: opts.robloxLighting ?? undefined },
      timeout,
    ));
    if (!r.ok) return { ok: false, error: (r.error as string) ?? 'render failed' };
    if (this.renderCount % 20 === 0) this.pruneRenders();
    return { ok: true, file, url: `${this.urlBase}/renders/${name}`, views: r.views as string[], lighting: r.lighting as string, figure: (r.figure as string) ?? undefined, unknownFocus: (r.unknown_focus as string[] | undefined) ?? undefined };
  }

  private robloxRun: Promise<{ ok: boolean; manifest?: RobloxManifest; error?: string }> | null = null;

  private robloxDirs(): string[] {
    return readdirSync(join(this.dir, 'exports'))
      .filter((f) => /^roblox-v\d+$/.test(f))
      .sort();
  }

  /** The newest Roblox export, and whether it was made from the scene as it is now. */
  robloxLast(): { manifest: RobloxManifest; current: boolean } | null {
    const dirs = this.robloxDirs();
    for (let i = dirs.length - 1; i >= 0; i--) {
      const manifest = readRobloxManifest(join(this.dir, 'exports', dirs[i]!));
      // "Current" means made from this exact scene: version numbers repeat after an Undo.
      if (manifest) return { manifest, current: !!this.fingerprint && manifest.source_fingerprint === this.fingerprint };
    }
    return null;
  }

  /**
   * The baked Roblox copy of the scene (blender/kiln_roblox.py export): one image atlas per material with
   * ambient occlusion in the colour. Made in a separate Blender from the saved scene, so this project's
   * Blender stays free; an export of the current version is reused unless `force`.
   */
  async robloxExport(opts: { units: 'm' | 'studs'; maxSize?: number; density?: number; ao?: boolean; plain?: boolean; force?: boolean }): Promise<{ ok: boolean; manifest?: RobloxManifest; error?: string; cached?: boolean }> {
    if (this.robloxRun) return this.robloxRun;
    const last = this.robloxLast();
    if (last?.current && !opts.force && !!last.manifest.plain === (opts.plain !== false)) return { ok: true, manifest: last.manifest, cached: true };
    if (!this.summary || this.summary.objects === 0 || this.summary.tris === 0) return { ok: false, error: 'The scene is empty' };
    const version = this.version;
    const fingerprint = this.fingerprint;
    const out = join(this.dir, 'exports', `roblox-v${this.pad(version)}`);
    this.robloxRun = withGpu(() => robloxExport(this.scenePath, out, { units: opts.units, sourceVersion: version, maxSize: opts.maxSize, density: opts.density, ao: opts.ao, plain: opts.plain }))
      .then((r) => {
        if (r.ok && r.manifest) {
          r.manifest.source_fingerprint = fingerprint;
          writeAtomic(join(out, 'roblox.json'), JSON.stringify(r.manifest, null, 1));
          for (const old of this.robloxDirs().filter((d) => d !== `roblox-v${this.pad(version)}`).slice(0, -1)) rmSync(join(this.dir, 'exports', old), { recursive: true, force: true });
        }
        return r;
      })
      .finally(() => {
        this.robloxRun = null;
      });
    return this.robloxRun;
  }

  /** What in the scene won't survive the trip to Roblox (read only). */
  async robloxCheck(lighting?: RobloxLighting | null): Promise<RobloxCheck> {
    const r = await this.bridge.call('roblox_check', { roblox_lighting: lighting ?? undefined, units: this.units, project_dir: this.dir }, 120_000);
    return r as unknown as RobloxCheck;
  }

  /** Reference images (downloaded files) on one contact sheet in renders/, for the copilot and the chat. */
  async refSheet(paths: string[], stamp: string): Promise<{ ok: boolean; error?: string; file?: string; url?: string; used?: number[] }> {
    const name = `refs-${stamp}.jpg`;
    const file = join(this.dir, 'renders', name);
    const r = await this.bridge.call('refsheet', { paths, path: file }, 60_000);
    if (!r.ok) return { ok: false, error: (r.error as string) ?? 'could not make the sheet' };
    return { ok: true, file, url: `${this.urlBase}/renders/${name}`, used: r.used as number[] };
  }

  /** The project's folder for downloaded reference images. */
  get refsDir(): string {
    return join(this.dir, 'refs');
  }

  /** Replaces the scene with a .blend file (another app's saved model), as a new version. */
  importBlend(path: string): Promise<{ ok: boolean; error?: string }> {
    return this.locked(async () => {
      const r = await this.bridge.call('open', { path });
      if (!r.ok) return { ok: false, error: r.error ?? 'could not open the file' };
      this.fingerprint = r.fingerprint as string;
      this.summary = r.summary as SceneSummary;
      await this.commit();
      await this.settled();
      return { ok: true };
    });
  }

  /** Runs a function from a Python module in another app's folder inside this scene's Blender
   *  (Shuriken's Roblox export); a change it makes is saved like any other. */
  ext(dir: string, module: string, func: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<BridgeReply> {
    return this.locked(async () => {
      const r = await this.bridge.call('ext', { dir, module, func, args }, timeoutMs);
      if (r.ok && r.fingerprint && r.fingerprint !== this.fingerprint) {
        this.fingerprint = r.fingerprint as string;
        this.summary = r.summary as SceneSummary;
        await this.commit();
      }
      return r;
    });
  }

  get sceneFile(): string {
    return this.scenePath;
  }

  /** Steps back to the previous snapshot. */
  undo(): Promise<boolean> {
    return this.locked(() => this.undoNow());
  }

  private async undoNow(): Promise<boolean> {
    await this.settled();
    const snaps = this.snapshots();
    if (snaps.length < 2) return false;
    const prev = join(this.dir, 'history', snaps[snaps.length - 2]!);
    const r = await this.bridge.call('open', { path: prev, keep: true });
    if (!r.ok) return false;
    rmSync(join(this.dir, 'history', snaps[snaps.length - 1]!), { force: true });
    copyFileSync(prev, this.scenePath);
    this.fingerprint = r.fingerprint as string;
    this.summary = r.summary as SceneSummary;
    this.version = Number(/v(\d+)/.exec(snaps[snaps.length - 2]!)?.[1] ?? this.version);
    await this.exportGlb();
    this.onScene(this.state());
    return true;
  }

  /** Archives the current scene and starts an empty one. */
  async reset(): Promise<void> {
    if (existsSync(this.scenePath) && this.summary && this.summary.objects > 0) {
      renameSync(this.scenePath, join(this.dir, 'archive', `scene-${new Date().toISOString().replace(/[:.]/g, '-')}.blend`));
    }
    for (const f of this.snapshots()) rmSync(join(this.dir, 'history', f), { force: true });
    const r = await this.bridge.call('new');
    this.fingerprint = (r.fingerprint as string) ?? null;
    this.summary = (r.summary as SceneSummary) ?? null;
    this.version = 0;
    await this.commit();
    this.onScene(this.state());
  }

  /** Writes the scene in a download format; returns the file path. */
  async exportFile(format: 'glb' | 'fbx' | 'obj' | 'stl' | 'blend'): Promise<string | null> {
    const file = join(this.dir, 'exports', `kiln-scene.${format}`);
    const r = await this.bridge.call('export', { format, path: file });
    return r.ok ? file : null;
  }
}
