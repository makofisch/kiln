// A game's style sheet: the shared look every model of one game follows (palette, materials, bevel,
// budgets). Briefs name it by id; the first project of a game proposes it, the rest follow it.
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { writeAtomic } from './fsx.ts';
import type { StyleSheet } from '../shared/types.ts';

const DIR = join(DATA_DIR, 'styles');
const HEX = /^#[0-9a-fA-F]{6}$/;

/** A style id as a file name: letters, digits, dot, dash, underscore. */
export function styleId(id: unknown): string | null {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id) && !id.includes('..') ? id : null;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined);

/** Keeps what a sheet may hold and drops the rest (it comes from the copilot or from another app). */
export function cleanStyle(id: string, raw: Record<string, unknown>, from?: string): StyleSheet {
  const materials = (Array.isArray(raw.materials) ? raw.materials : [])
    .map((m) => m as Record<string, unknown>)
    .filter((m) => m && typeof m.name === 'string' && typeof m.color === 'string' && HEX.test(m.color))
    .slice(0, 24)
    .map((m) => ({
      name: (m.name as string).replace(/[^A-Za-z0-9_ ]/g, '_').trim().slice(0, 40),
      color: m.color as string,
      ...(num(m.roughness, 0, 1) !== undefined ? { roughness: num(m.roughness, 0, 1) } : {}),
      ...(num(m.metallic, 0, 1) !== undefined ? { metallic: num(m.metallic, 0, 1) } : {}),
      ...(str(m.roblox_material, 30) ? { roblox_material: str(m.roblox_material, 30) } : {}),
      ...(typeof m.emission === 'string' && HEX.test(m.emission) ? { emission: m.emission } : {}),
      ...(str(m.use, 120) ? { use: str(m.use, 120) } : {}),
    }));
  const budgets: Record<string, number> = {};
  // The copilot's tool sends a list of { class, tris }; an app may send the map itself.
  if (Array.isArray(raw.budgets)) raw = { ...raw, budgets: Object.fromEntries((raw.budgets as Array<{ class?: unknown; tris?: unknown }>).filter((b) => b && typeof b.class === 'string').map((b) => [b.class as string, b.tris])) };
  if (raw.budgets && typeof raw.budgets === 'object') {
    for (const [k, v] of Object.entries(raw.budgets as Record<string, unknown>).slice(0, 12)) {
      const n = num(v, 50, 500_000);
      if (n !== undefined) budgets[k.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 30)] = Math.round(n);
    }
  }
  return {
    id,
    ...(str(raw.title, 80) ? { title: str(raw.title, 80) } : {}),
    palette: (Array.isArray(raw.palette) ? raw.palette : []).filter((c): c is string => typeof c === 'string' && HEX.test(c)).slice(0, 16),
    materials,
    ...(num(raw.bevel, 0, 10) !== undefined ? { bevel: num(raw.bevel, 0, 10) } : {}),
    ...(num(raw.texel_density, 1, 4096) !== undefined ? { texel_density: num(raw.texel_density, 1, 4096) } : {}),
    ...(Object.keys(budgets).length ? { budgets } : {}),
    ...(str(raw.wear, 80) ? { wear: str(raw.wear, 80) } : {}),
    ...(str(raw.notes, 1200) ? { notes: str(raw.notes, 1200) } : {}),
    ...(raw.units === 'studs' || raw.units === 'm' ? { units: raw.units } : {}),
    ...(from ? { from } : {}),
    updatedAt: new Date().toISOString(),
  };
}

export function readStyle(id: string): StyleSheet | null {
  if (!styleId(id)) return null;
  try {
    const s = JSON.parse(readFileSync(join(DIR, `${id}.json`), 'utf8')) as StyleSheet;
    return s && typeof s === 'object' && Array.isArray(s.materials) ? s : null;
  } catch {
    return null;
  }
}

export function saveStyle(id: string, raw: Record<string, unknown>, from?: string): StyleSheet {
  const sheet = cleanStyle(id, raw, from);
  mkdirSync(DIR, { recursive: true });
  writeAtomic(join(DIR, `${id}.json`), JSON.stringify(sheet, null, 1));
  return sheet;
}

export function listStyles(): Array<{ id: string; title?: string; materials: number; updatedAt?: string }> {
  try {
    return readdirSync(DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readStyle(f.slice(0, -5)))
      .filter((s): s is StyleSheet => !!s)
      .map((s) => ({ id: s.id, title: s.title, materials: s.materials.length, updatedAt: s.updatedAt }));
  } catch {
    return [];
  }
}
