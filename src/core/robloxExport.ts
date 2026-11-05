import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackChild } from './blender.ts';
import { BLENDER_SCRIPTS, findBlender } from './config.ts';

/** What the Roblox export wrote (blender/kiln_roblox.py export): one baked image atlas per material. */
export interface RobloxManifest {
  version: number;
  /** Whether one-colour materials were left untextured (the `plain` option). */
  plain?: boolean;
  /** Studs per scene unit (1 for a project in studs). */
  studs_per_unit?: number;
  /** Unique meshes: the objects under one entry share that mesh in the .blend (upload once, clone). */
  meshes?: Record<string, { objects: string[]; tris: number }>;
  /** kiln.role tags: object → "drivable" | "ground" | "barrier" | "decor". */
  roles?: Record<string, string>;
  /** Unseen collision shapes (role "collider") kept in the .blend, and what each stands in for. */
  colliders?: Array<{ name: string; stands_for: string | null }>;
  /** Pieces from other projects: name → the project and the version/fingerprint it was brought in at. */
  pieces?: Record<string, { project: string; version: number; fingerprint: string; tris: number; placements: number; stale: boolean }>;
  /** Where each piece stands: a 4x4 row-major world matrix in scene units, Blender axes (Z up). Not in the .blend as geometry. */
  placements?: Array<{ name: string; piece: string; project: string; matrix: number[][]; role?: string }>;
  mirrored_placements?: string[];
  /** Baked images Roblox moderation would remove (a QR code): don't upload these maps as they are. */
  content_problems?: Array<{ material: string; map: string; problem: string }>;
  /** Points for the game's code (kiln.marker). */
  markers?: Array<{ name: string; role: string; matrix: number[][] }>;
  /** Lines for the game's code: road centre lines (kiln.path, kiln.track). */
  paths?: Array<{ name: string; role: string; points: number[][]; width: number | null; closed: boolean }>;
  /** The baked copy of the scene: final meshes on unique UVs, plain image-textured materials, the rig and clips. */
  blend: string;
  units: string;
  /** The scene version it was made from. */
  source_version: number | null;
  /** The fingerprint of the scene it was made from (what "current" is judged by). */
  source_fingerprint?: string | null;
  /** The UV layer the atlases use. */
  uv: string;
  ao: boolean;
  materials: Array<{
    name: string;
    /** Untextured: colour the part with `color` (and use `roblox_material` when set). `maps` is empty. */
    plain?: boolean;
    /** One of Roblox's own materials (Enum.Material name), from kiln.roblox.surface. */
    roblox_material?: string | null;
    /** "#rrggbb" of a plain material. */
    color?: string | null;
    size: number;
    /** PNG paths: color always; normal, roughness, metalness and emissive when the material has them. */
    maps: Record<string, string>;
    roughness: number | null;
    metallic: number | null;
    emissive_strength: number;
    emissive_tint: string | null;
    transparency: number;
    area: number;
    texels_per_unit: number;
    atlas_use: number;
    tris: number;
    objects: number;
  }>;
  objects: number;
  tris: number;
  joints: number;
  clips: Array<{ name: string; length: number | null; loop: boolean | null; speed: number | null }>;
  device: string;
  seconds: number;
}

export interface RobloxExportOptions {
  units: 'm' | 'studs';
  sourceVersion: number;
  /** Largest atlas, in pixels (Roblox keeps at most 1024). */
  maxSize?: number;
  /** Texels per scene unit to aim for. */
  density?: number;
  /** Bake ambient occlusion into the colour (default true). */
  ao?: boolean;
  /** Leave one-colour materials untextured (the manifest gives their colour). */
  plain?: boolean;
}

const MARK = '@@KILN ';
const TIMEOUT_MS = 15 * 60_000;

/**
 * Bakes a copy of `sceneFile` into its Roblox form in `outDir` (roblox.blend, roblox.json, one PNG set
 * per material). Runs in its own Blender, so the project's live Blender and its scene are untouched.
 */
export function robloxExport(sceneFile: string, outDir: string, opts: RobloxExportOptions): Promise<{ ok: boolean; manifest?: RobloxManifest; error?: string }> {
  const exe = findBlender();
  if (!exe) return Promise.resolve({ ok: false, error: 'Blender was not found' });
  if (!existsSync(sceneFile)) return Promise.resolve({ ok: false, error: 'The project has no saved scene yet' });
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const work = join(outDir, '_work.blend');
  const optionsFile = join(outDir, '_options.json');
  copyFileSync(sceneFile, work);
  writeFileSync(
    optionsFile,
    JSON.stringify({ out: outDir, name: 'roblox', units: opts.units, source_version: opts.sourceVersion, max_size: Math.max(64, Math.min(1024, Math.round(opts.maxSize ?? 1024))), plain: opts.plain !== false, density: opts.density ?? null, ao: opts.ao !== false }),
    'utf8',
  );
  return new Promise((done) => {
    const proc = spawn(exe, ['-b', '--factory-startup', '-noaudio', work, '--python', join(BLENDER_SCRIPTS, 'roblox_export.py'), '--', optionsFile], { windowsHide: true });
    trackChild(proc);
    let out = '';
    let settled = false;
    const finish = (r: { ok: boolean; manifest?: RobloxManifest; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const f of [work, `${work}1`, optionsFile]) rmSync(f, { force: true });
      done(r);
    };
    const timer = setTimeout(() => {
      proc.kill();
      finish({ ok: false, error: 'The Roblox export timed out' });
    }, TIMEOUT_MS);
    proc.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      if (out.length > 4_000_000) out = out.slice(-2_000_000);
    });
    proc.stderr.on('data', () => undefined);
    proc.on('error', (e) => finish({ ok: false, error: `Blender could not start: ${e.message}` }));
    proc.on('close', () => {
      const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith(MARK));
      if (!line) return finish({ ok: false, error: `The Roblox export stopped without a result.${out.trim() ? ` ${out.trim().slice(-400)}` : ''}` });
      try {
        const r = JSON.parse(line.slice(MARK.length)) as { ok: boolean; manifest?: RobloxManifest; error?: string };
        finish(r.ok && r.manifest ? { ok: true, manifest: r.manifest } : { ok: false, error: r.error ?? 'The Roblox export failed' });
      } catch (e) {
        finish({ ok: false, error: `The Roblox export's result could not be read: ${(e as Error).message}` });
      }
    });
  });
}

/** The manifest of the last export in `outDir`, if there is one. */
export function readRobloxManifest(outDir: string): RobloxManifest | null {
  try {
    return JSON.parse(readFileSync(join(outDir, 'roblox.json'), 'utf8')) as RobloxManifest;
  } catch {
    return null;
  }
}
