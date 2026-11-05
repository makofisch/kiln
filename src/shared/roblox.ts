// How a Roblox place lights a model, as numbers both previews are built from: the live viewer
// (renderer/app/viewer/engine.ts) and Blender's pretty renders (blender/kiln_roblox.py, which holds the
// same formulas: keep the two in step). Colours going in are Roblox Color3 values (sRGB 0–1); colours
// coming out are linear RGB.
import type { RobloxLighting } from './types.ts';

type Rgb = [number, number, number];

/** A new Roblox place (the Baseplate template). */
export const DEFAULT_LIGHTING = {
  brightness: 3,
  ambient: [0.275, 0.275, 0.275],
  outdoorAmbient: [0.275, 0.275, 0.275],
  clockTime: 14.5,
  latitude: 0,
  envDiffuse: 1,
  envSpecular: 1,
  exposure: 0,
  atmosphere: { density: 0.3, offset: 0.25, haze: 0, glare: 0, color: [0.78, 0.78, 0.78], decay: [0.416, 0.439, 0.49] },
  bloom: { intensity: 1, size: 24, threshold: 2 },
  colorCorrection: null as null | { brightness?: number; contrast?: number; saturation?: number; tint?: number[] },
};

export interface RobloxLook {
  /** The sun's (or at night the moon's) height above the horizon, radians. */
  elevation: number;
  night: boolean;
  sunColor: Rgb;
  /** Irradiance: a white surface facing the sun shows sunStrength / π. */
  sunStrength: number;
  /** Flat ambient light added everywhere (OutdoorAmbient). */
  ambient: Rgb;
  zenith: Rgb;
  horizon: Rgb;
  ground: Rgb;
  /** ExposureCompensation, in stops. */
  exposure: number;
  /** 0–1 */
  haze: number;
  fogColor: Rgb;
  /** Per stud. */
  fogDensity: number;
  bloom: { intensity: number; size: number; threshold: number } | null;
  colorCorrection: { brightness: number; contrast: number; saturation: number; tint: Rgb } | null;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const rgb = (v: unknown, d: number[]): Rgb => (Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? [v[0], v[1], v[2]] : [d[0]!, d[1]!, d[2]!]) as Rgb;
const s2l = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((Math.max(c, 0) + 0.055) / 1.055, 2.4));
const lin = (c: Rgb): Rgb => [s2l(c[0]), s2l(c[1]), s2l(c[2])];
const lerp = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul = (a: Rgb, k: number): Rgb => [a[0] * k, a[1] * k, a[2] * k];
const smooth = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

/** What another app sent as a place's lighting, reduced to the known fields with sane values. */
export function cleanLighting(v: unknown): RobloxLighting | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const out: RobloxLighting = {};
  const n = (k: string, lo: number, hi: number) => (typeof o[k] === 'number' && Number.isFinite(o[k] as number) ? Math.max(lo, Math.min(hi, o[k] as number)) : undefined);
  const c = (x: unknown) => (Array.isArray(x) && x.length >= 3 && x.slice(0, 3).every((y) => typeof y === 'number' && Number.isFinite(y)) ? x.slice(0, 3).map((y) => Math.max(0, Math.min(1, y as number))) : undefined);
  const sub = <T extends object>(x: unknown, f: (s: Record<string, unknown>) => T): T | null | undefined => (x === null ? null : x && typeof x === 'object' ? f(x as Record<string, unknown>) : undefined);
  const set = <K extends keyof RobloxLighting>(k: K, val: RobloxLighting[K] | undefined) => {
    if (val !== undefined) out[k] = val;
  };
  set('brightness', n('brightness', 0, 10));
  set('ambient', c(o.ambient));
  set('outdoorAmbient', c(o.outdoorAmbient));
  set('clockTime', n('clockTime', 0, 24));
  set('latitude', n('latitude', -90, 90));
  set('envDiffuse', n('envDiffuse', 0, 1));
  set('envSpecular', n('envSpecular', 0, 1));
  set('exposure', n('exposure', -5, 5));
  const pick = (s: Record<string, unknown>, keys: string[], lo: number, hi: number) => Object.fromEntries(keys.filter((k) => typeof s[k] === 'number' && Number.isFinite(s[k] as number)).map((k) => [k, Math.max(lo, Math.min(hi, s[k] as number))]));
  set('atmosphere', sub(o.atmosphere, (s) => ({ ...pick(s, ['density', 'offset', 'glare'], 0, 10), ...pick(s, ['haze'], 0, 10), ...(c(s.color) ? { color: c(s.color) } : {}), ...(c(s.decay) ? { decay: c(s.decay) } : {}) })));
  set('bloom', sub(o.bloom, (s) => ({ ...pick(s, ['intensity', 'threshold'], 0, 10), ...pick(s, ['size'], 0, 56) })));
  set('colorCorrection', sub(o.colorCorrection, (s) => ({ ...pick(s, ['brightness', 'contrast', 'saturation'], -1, 1), ...(c(s.tint) ? { tint: c(s.tint) } : {}) })));
  return out;
}

/** The look of a place's lighting (see RobloxLook); missing values are a new place's defaults. */
export function robloxLook(l?: RobloxLighting | null): RobloxLook {
  const D = DEFAULT_LIGHTING;
  const hour = ((num(l?.clockTime, D.clockTime) - 12) * 15 * Math.PI) / 180;
  const lat = (num(l?.latitude, D.latitude) * Math.PI) / 180;
  const sinE = Math.cos(lat) * Math.cos(hour); // the sun's height at the equinox
  const night = sinE <= 0;
  const elevation = Math.asin(Math.max(0.02, Math.min(1, Math.abs(sinE))));
  const k = smooth((elevation * 180) / Math.PI / 20); // 0 at the horizon, 1 from 20° up
  const b = num(l?.brightness, D.brightness);
  const sunColor: Rgb = night ? [0.55, 0.65, 1] : lerp([1, 0.62, 0.36], [1, 0.96, 0.9], k);
  const sunStrength = night ? 0.12 * b : 1.05 * b * (0.25 + 0.75 * k);
  const day = night ? 0.04 : 0.35 + 0.65 * k;
  const atmo = l?.atmosphere === null ? null : { ...D.atmosphere, ...(l?.atmosphere ?? {}) };
  const haze = Math.max(0, Math.min(1, num(atmo?.haze, 0) / 2.5));
  const density = num(atmo?.density, 0);
  const atmoColor = lin(rgb(atmo?.color, D.atmosphere.color));
  const es = num(l?.envSpecular, D.envSpecular);
  const zenith = mul([0.12, 0.22, 0.48], day * es);
  const horizon = mul(lerp([0.55, 0.62, 0.72], mul(atmoColor, 0.9 + 0.5 * haze), 0.35 + 0.65 * haze), day * es);
  const ground = mul([0.1, 0.095, 0.09], day * es);
  const ambient = lin(rgb(l?.outdoorAmbient, D.outdoorAmbient));
  const bl = l?.bloom === null ? null : { ...D.bloom, ...(l?.bloom ?? {}) };
  const cc = l?.colorCorrection;
  return {
    elevation,
    night,
    sunColor,
    sunStrength,
    ambient,
    zenith,
    horizon,
    ground,
    exposure: num(l?.exposure, 0),
    haze,
    fogColor: lerp(horizon, ambient, 0.25),
    fogDensity: 0.0016 * density * (1 + 1.5 * haze),
    bloom: bl ? { intensity: num(bl.intensity, 1), size: num(bl.size, 24), threshold: num(bl.threshold, 2) } : null,
    colorCorrection: cc ? { brightness: num(cc.brightness, 0), contrast: num(cc.contrast, 0), saturation: num(cc.saturation, 0), tint: rgb(cc.tint, [1, 1, 1]) } : null,
  };
}

/** One line about a place's lighting, for people and the copilot. */
export function describeLighting(l?: RobloxLighting | null): string {
  const lk = robloxLook(l);
  const deg = Math.round((lk.elevation * 180) / Math.PI);
  const sun = lk.night ? 'night (moonlight)' : deg < 20 ? `a low warm sun (${deg}° up)` : `sun ${deg}° up`;
  const oa = rgb(l?.outdoorAmbient, DEFAULT_LIGHTING.outdoorAmbient);
  const amb = (oa[0] + oa[1] + oa[2]) / 3;
  const haze = l?.atmosphere === null ? 0 : num(l?.atmosphere?.haze, 0);
  const bits = [`brightness ${num(l?.brightness, DEFAULT_LIGHTING.brightness).toFixed(1)}`, sun, `${amb > 0.42 ? 'bright' : amb > 0.2 ? 'moderate' : 'dim'} ambient light`, `${haze > 1.2 ? 'heavy' : haze > 0.3 ? 'some' : 'no'} haze`];
  if (num(l?.envSpecular, 1) >= 0.7) bits.push('full sky reflections');
  return bits.join(', ');
}
