import { readFileSync } from 'node:fs';
import { gather, type ReferenceRequest } from './research.ts';
import { ANIMATION_GUIDE } from './animGuide.ts';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ExecResult, RobloxCheck, SceneIssues, Workspace, ZFight } from './workspace.ts';
import type { RobloxLighting, SceneSummary } from '../shared/types.ts';

export const SERVER_NAME = 'blender';
export const BLENDER_TOOLS = ['run_python', 'scene_info', 'render_view', 'check_scene', 'render_motion', 'check_motion'].map((t) => `mcp__${SERVER_NAME}__${t}`);
export const KILN_TOOLS = ['report_feedback', 'remember', 'plan', 'reference_images', 'animation_guide', 'style_sheet'].map((t) => `mcp__kiln__${t}`);
/** The research phase: Claude Code's web tools plus Kiln's reference_images (only when Settings → Reference research is on). */
export const RESEARCH_TOOLS = ['WebSearch', 'WebFetch', 'mcp__kiln__reference_images'];
/** Kiln's own plan tool (Claude Code's built-in TodoWrite was switched off in newer versions). */
export const PLAN_TOOL = 'mcp__kiln__plan';
const VIEWS = ['iso', 'iso_back', 'hero', 'front', 'back', 'left', 'right', 'top', 'bottom', 'plan'] as const;

const fmt = (n: number) => n.toLocaleString('en-US');

function totals(s: SceneSummary | null, unit = 'm'): string {
  if (!s) return '';
  const b = s.bounds ? `, bounds ${s.bounds.size.map((v) => v.toFixed(2)).join(' × ')} ${unit}` : '';
  return `Scene: ${s.objects} objects, ${fmt(s.tris)} triangles${b}.`;
}

function listNames(label: string, names: string[]): string {
  if (!names.length) return '';
  const shown = names.slice(0, 25).join(', ');
  return `${label}: ${shown}${names.length > 25 ? ` (+${names.length - 25} more)` : ''}`;
}

/** A distance in the project's units: studs as studs, metres in millimetres. */
export function fmtGap(v: number | undefined, units: 'm' | 'studs' = 'm'): string {
  if (v === undefined) return '?';
  return units === 'studs' ? `${v.toFixed(3)} studs` : `${(v * 1000).toFixed(1)} mm`;
}

/** One z-fighting pair as a line: where, how close, how far apart it must be. */
export function describeZFight(z: ZFight, units: 'm' | 'studs' = 'm'): string {
  const where = z.inside ? `inside ${z.a}` : `${z.a} / ${z.b}`;
  const how = z.kind === 'layer' ? `${fmtGap(z.sep, units)} apart` : 'flush';
  return `${where} (${how}, needs ${fmtGap(z.gap, units)})`;
}

/** Plain-language findings of the automatic surface check. */
export function formatIssues(i: SceneIssues | null, heading = 'Check'): string {
  if (!i) return '';
  const units = i.zfight_rule?.units ?? 'm';
  const parts: string[] = [];
  if (i.zfight_pairs) parts.push(`${i.zfight_pairs} pair(s) of surfaces that will flicker in the game (z-fighting: overlapping, facing the same way, flush or closer than the safe gap of ${fmtGap(i.zfight_rule?.gap, units)}): ${i.zfight.slice(0, 6).map((z) => describeZFight(z, units)).join(', ')}`);
  if (i.floating.length) parts.push(`not touching anything and above the ground: ${i.floating.map((f) => `${f.object} (${f.gap_below_m} m up)`).join(', ')}`);
  if (i.below_ground?.length) parts.push(`entirely below the ground (fine if intended): ${i.below_ground.map((b) => `${b.object} (top at ${b.top_z} m)`).join(', ')}`);
  if (i.moved?.length) parts.push(`fixed: ${i.moved.map((m) => `${m.object} ${m.action ?? (m.by_mm !== undefined ? `moved ${m.by_mm} mm` : 'moved')}`).join(', ')}`);
  if (!parts.length) return `${heading}: no z-fighting or floating parts.`;
  return `${heading}: ${parts.join('; ')}.${i.zfight_pairs ? ' Fix every z-fighting pair before you finish: merge the parts, inset or extrude the detail into the surface, or move the layers at least the gap apart (check_scene with fix: true does the last).' : ''}${i.floating.length ? ' Ignore floating parts that are meant to hover.' : ''}`;
}

function formatExec(r: ExecResult, unit = 'm'): string {
  const lines = [r.ok ? `Ran in ${r.ms} ms.` : 'Failed.'];
  // The error first: it is what matters, and a long printout must not push it out of view.
  if (r.error) lines.push(`Error:\n${r.error}`);
  if (r.rolledBack) lines.push(`The scene was put back as it was before this call (version ${r.version}); nothing from the script was kept. Python variables from earlier calls were cleared: get objects again by name (bpy.data.objects["Name"]).`);
  else if (!r.ok && r.changed) lines.push(`Everything before the failing line ran and is kept as version ${r.version} (see Added). Fix and run only the rest; don't run the whole script again (that would build the parts twice). To start this step over instead, remove what it added first.`);
  else lines.push(r.changed ? `The scene changed: now version ${r.version}, shown in the viewer.` : 'No change to the scene.');
  const out = r.output.trimEnd();
  if (out.trim()) lines.push(`Output:\n${out.length > 6000 ? `${out.slice(0, 2500)}\n… (${out.length - 5000} characters left out) …\n${out.slice(-2500)}` : out}`);
  const added = listNames('Added', r.added);
  const removed = listNames('Removed', r.removed);
  if (added) lines.push(added);
  if (removed) lines.push(removed);
  lines.push(totals(r.summary, unit));
  const issues = r.issues && (r.issues.zfight_pairs || r.issues.floating.length) ? formatIssues(r.issues, 'Automatic check') : '';
  if (issues) lines.push(issues);
  if (r.checkSkipped) lines.push('The automatic clash check was skipped (the scene is over 400k triangles): call check_scene at milestones.');
  return lines.filter(Boolean).join('\n');
}

/** What Roblox would lose, as lines for the copilot. */
export function formatRoblox(r: RobloxCheck | null): string {
  if (!r || !r.ok) return '';
  const lines = [r.summary];
  for (const p of r.problems) lines.push(`- ${p}`);
  for (const n of r.notes) lines.push(`- (note) ${n}`);
  return lines.join('\n');
}

/** The project a tool call works in: its units and, for a Roblox project, the game's lighting. */
export interface ToolContext {
  studs: () => boolean;
  roblox: () => { lighting: RobloxLighting | null } | null;
}

/**
 * The scene for the copilot, compact: objects one per line instead of JSON, and when the scene is larger
 * than the list, the rest counted by name pattern (500 scattered trees are one line, not 500).
 */
function sceneText(s: SceneSummary, list: SceneSummary['list']): string {
  const n = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
  const v3 = (a?: number[]) => (a ? a.map(n).join(' ') : '-');
  const rows = list.map((o) => {
    const bits = [`${o.name} [${o.type}]`, `at ${v3(o.location)}`, `size ${v3(o.dimensions)}`];
    if (o.rotation_deg?.some((r) => Math.abs(r) > 0.05)) bits.push(`rot ${o.rotation_deg.map((r) => r.toFixed(0)).join(' ')}`);
    if (o.scale?.some((x) => Math.abs(x - 1) > 0.001)) bits.push(`scale ${v3(o.scale)}`);
    if (o.piece) bits.push(`places piece ${o.piece}`);
    if (o.role) bits.push(`role ${o.role}`);
    if (o.part) bits.push(`part ${o.part}`);
    if (o.tris) bits.push(`${o.tris} tris`);
    if (o.materials?.length) bits.push(`mat ${o.materials.join(', ')}`);
    if (o.modifiers?.length) bits.push(`mods ${o.modifiers.join(', ')}`);
    if (o.parent) bits.push(`parent ${o.parent}`);
    if (o.collection) bits.push(`in ${o.collection}`);
    if (o.hidden) bits.push('hidden');
    return bits.join(' · ');
  });
  const rest = s.list.slice(list.length);
  const groups = new Map<string, number>();
  for (const o of rest) {
    const key = o.name.replace(/[._-]?\d+$/, '') || o.name;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const more = rest.length || s.truncated ? `\nNot listed in full: ${[...groups].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, c]) => `${k}… ×${c}`).join(', ')}${s.truncated ? ' (and more: the scene has more objects than a scan lists)' : ''}. Ask for specific ones by name in run_python.` : '';
  const mats = s.materials.map((m) => `${m.name}${m.color ? ` ${m.color}` : ''}${m.metallic ? ` metal ${m.metallic}` : ''}${m.roughness !== undefined ? ` rough ${m.roughness}` : ''}${m.emission ? ` glow ${m.emission}` : ''}${m.image_texture ? ' (image)' : m.procedural_texture ? ' (procedural)' : ''}`);
  const head = [
    s.bounds ? `Bounds min ${v3(s.bounds.min)} max ${v3(s.bounds.max)}` : '',
    s.collections.length ? `Collections: ${s.collections.join(', ')}` : '',
    s.world ? `World: ${s.world.color} strength ${s.world.strength}; lights: ${s.lights ?? 0}` : `Lights: ${s.lights ?? 0}`,
    s.rig ? `Rig: ${s.rig.joints} joints; clips: ${s.rig.clips.map((c) => c.name).join(', ') || 'none'}` : '',
  ].filter(Boolean);
  return `${head.join('\n')}\nMaterials (${mats.length}): ${mats.join('; ')}\nObjects (name [type] · location · size · …):\n${rows.join('\n')}${more}`;
}

/** The in-process MCP server that gives the copilot (and its subagents) the Blender tools. */
export function blenderServer(ws: Workspace, ctx: ToolContext = { studs: () => false, roblox: () => null }) {
  return createSdkMcpServer({
    name: SERVER_NAME,
    version: '0.8.7',
    alwaysLoad: true,
    timeout: 11 * 60_000,
    tools: [
      tool(
        'run_python',
        "Run Python inside the headless Blender (bpy, bmesh, mathutils, math, np and the kiln helpers are preloaded; variables persist between calls). Returns printed output, errors with the failing line, objects added/removed, scene totals, and an automatic check for flickering coincident surfaces and floating parts. Changes are saved as a new undoable version and shown in the user's viewer.",
        {
          description: z.string().max(90).describe('A few words shown to the user for this step, e.g. "Block out the lighthouse tower"'),
          code: z.string().min(1).describe('Python source to run'),
          timeout_s: z.number().min(5).max(600).optional().describe('Seconds before Blender is restarted from the last saved state (default 180; raise it for heavy work such as big texture bakes)'),
          undo_on_error: z.boolean().optional().describe('If the script fails part-way, put the scene back as it was before this call instead of keeping the part that ran (default false). Use it for edits that must happen whole or not at all; it clears Python variables.'),
        },
        async (args) => {
          const r = await ws.exec(args.code, (args.timeout_s ?? 180) * 1000, args.undo_on_error === true);
          return { content: [{ type: 'text', text: formatExec(r, ctx.studs() ? 'studs' : 'm') }], isError: !r.ok };
        },
      ),
      tool(
        'scene_info',
        'Describe the scene: every object with location, dimensions, rotation, triangles, materials, modifiers, parent and collection; all materials (color, metallic, roughness); collections; overall bounds.',
        { limit: z.number().int().min(1).max(300).optional().describe('Maximum objects to list in full (default 120; the rest are counted by name pattern)') },
        async (args) => {
          const r = await ws.scene();
          if (!r.ok) return { content: [{ type: 'text', text: `Could not read the scene: ${r.error}` }], isError: true };
          const s = r.summary as SceneSummary;
          const list = s.list.slice(0, args.limit ?? 120);
          return { content: [{ type: 'text', text: `${totals(s, ctx.studs() ? 'studs' : 'm')}\n${sceneText(s, list)}` }] };
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'check_scene',
        "Full scene check: z-fighting (surfaces that overlap facing the same way, flush or closer than this project's safe gap, between objects and inside one mesh: they flicker in the game), objects floating with nothing under them, objects below the ground. With fix: true, each z-fighting pair is moved to the safe gap: the smaller part's face is pushed out (a plate gets thicker, a decal lifts off) or a part behind sinks further in; duplicate faces inside a mesh are deleted; a loose part layered inside one mesh is lifted. Saved as a new version; what it could not fix is still listed. run_python already runs this check after each change on scenes under 400k triangles. In a Roblox project it also lists what Roblox would lose or refuse: shader features it cannot show, risky material values, part and joint budgets.",
        { fix: z.boolean().optional().describe('Move z-fighting layers to the safe gap (default false)') },
        async (args) => {
          const r = await ws.check(!!args.fix);
          if (!r.ok) return { content: [{ type: 'text', text: `Check failed: ${r.error}` }], isError: true };
          const rbx = ctx.roblox();
          const roblox = rbx ? formatRoblox(await ws.robloxCheck(rbx.lighting).catch(() => null)) : '';
          return { content: [{ type: 'text', text: `${formatIssues(r)}\nChecked ${fmt(r.faces_checked ?? 0)} faces${r.zfight_truncated ? ' (the z-fighting check covered only part of this very large scene)' : ''}.${roblox ? `\n${roblox}` : ''}` }] };
        },
      ),
      tool(
        'render_view',
        'Render the scene (or only the objects named in focus) framed automatically, and look at the image. Several views or animation frames come back as one contact sheet (cheaper than separate renders). quality "fast" = Workbench solid shading with material colors (~1 s); "pretty" = Eevee with the scene lights and world (a default sun if there are none) and a floor (a few seconds), for judging materials, textures and lighting. In a Roblox project "pretty" is lit like the game instead (see lighting).',
        {
          lighting: z.enum(['scene', 'roblox']).optional().describe('For "pretty": "roblox" = lit like a Roblox place (bright sky, flat ambient light, no ambient occlusion) and showing only what Roblox can show (no coat, subsurface, alpha); "scene" = the scene\'s own lights and world. Default: "roblox" in Roblox projects, else "scene"'),
          views: z.array(z.enum(VIEWS)).min(1).max(6).optional().describe('Default ["iso"]. iso/iso_back = 3/4 from above, hero = low 3/4, plus front/back/left/right/top/bottom; plan = orthographic top-down map (layouts, paths, spacing)'),
          quality: z.enum(['fast', 'pretty']).optional().describe('Default "fast"'),
          size: z.number().int().min(256).max(1400).optional().describe('Width of each view in pixels (default 768 for one view, 512 per view in a contact sheet)'),
          focus: z.array(z.string()).optional().describe('Object names to frame instead of the whole scene'),
          isolate: z.boolean().optional().describe('With focus: hide everything else, so a part inside or behind other parts can be seen (default false: the rest stays in view)'),
          frames: z.array(z.number().int()).max(6).optional().describe('Animation frames to render (each with every view, at most 6 images): check motion without playing it'),
          scale_figure: z.boolean().optional().describe('Stand a person beside the subject to judge real size (1.8 m; in studs projects a 5.2-stud Roblox character)'),
        },
        async (args) => {
          const views = args.views ?? ['iso'];
          const count = (args.frames?.length || 1) * views.length;
          const rbx = ctx.roblox();
          const lighting = args.lighting ?? (rbx ? 'roblox' : 'scene');
          const r = await ws.render({
            views,
            quality: args.quality ?? 'fast',
            size: args.size ?? (count > 1 ? 512 : 768),
            focus: args.focus,
            isolate: args.isolate,
            frames: args.frames,
            figure: args.scale_figure,
            // In studs the figure is a Roblox character (5.2 studs), not a 1.8-unit giant-slayer.
            figureHeight: ctx.studs() ? 5.2 : undefined,
            lighting,
            robloxLighting: rbx?.lighting ?? null,
          });
          if (!r.ok || !r.file) return { content: [{ type: 'text', text: `Render failed: ${r.error}` }], isError: true };
          const shown = r.views ?? views;
          const lit = `${r.lighting === 'roblox' ? ' Lit like the Roblox game, showing only what Roblox can show.' : ''}${r.figure ? ` Scale reference: ${r.figure}.` : ''}${r.unknownFocus?.length ? ` Not in the scene (focus ignored them): ${r.unknownFocus.join(', ')}.` : ''}`;
          const caption = `${shown.length > 1 ? `Images, left to right then top to bottom: ${shown.join(', ')}.` : `View: ${shown[0]}.`}${lit}`;
          return {
            content: [
              { type: 'image', data: readFileSync(r.file).toString('base64'), mimeType: 'image/png' },
              { type: 'text', text: `${caption} [image:${r.url}]` },
            ],
          };
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'render_motion',
        'See a clip move: "strip" = labelled frames across the clip, "onion" = several frames overlaid in one image (early blue to late orange: spacing, arcs, overlap), "trails" = the paths of the feet, tail tip, head and body over the clip, "graph" = foot heights, when each foot is planted (a gait diagram), the body\'s bob and the clip\'s events. Workbench renders, about a second per view.',
        {
          clip: z.string().optional().describe('The clip (default: the one the rig is showing)'),
          views: z.array(z.enum(['strip', 'onion', 'trails', 'graph'])).min(1).max(4).optional().describe('Default ["strip", "graph"]'),
          view: z.enum(['left', 'right', 'front', 'back', 'iso', 'top']).optional().describe('Camera for strip and onion (default "left": side on, best for gaits)'),
          count: z.number().int().min(2).max(12).optional().describe('Frames in the strip (default 8) or onion (default 6)'),
        },
        async (args) => {
          const r = await ws.motion(args);
          if (!r.ok || !r.images?.length) return { content: [{ type: 'text', text: `Could not show the motion: ${r.error ?? 'no images'}` }], isError: true };
          return {
            content: [
              ...r.images.map((i) => ({ type: 'image' as const, data: readFileSync(i.file).toString('base64'), mimeType: 'image/png' })),
              { type: 'text', text: `Clip ${r.clip}: ${r.images.map((i) => i.view).join(', ')} (in that order). ${(r.notes ?? []).join('; ')} ${r.images.map((i) => `[image:${i.url}]`).join(' ')}` },
            ],
          };
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'check_motion',
        'Check a clip on every frame: feet sliding while planted, parts dipping under the ground, rigid parts passing through each other, joints bent past their limits, jerks, and a seam where a loop wraps. Returns the problems with their frames.',
        { clip: z.string().describe('The clip name') },
        async (args) => {
          const r = await ws.animCheck(args.clip);
          if (!r.ok) return { content: [{ type: 'text', text: `Check failed: ${r.error}` }], isError: true };
          const rep = r.report as { summary: string; feet?: Record<string, { slide_speed: number; contact_frames: number }> };
          const feet = rep.feet ? Object.entries(rep.feet).map(([k, v]) => `${k}: planted ${v.contact_frames} frames, max slide ${v.slide_speed}/s`).join('; ') : '';
          return { content: [{ type: 'text', text: `${rep.summary}${feet ? `\nFeet: ${feet}` : ''}` }] };
        },
        { annotations: { readOnlyHint: true } },
      ),
    ],
  });
}

export interface FeedbackReport {
  kind: 'complaint' | 'bug' | 'wish' | 'praise';
  summary: string;
  user_quote?: string;
  response?: string;
}

/** Looks up reference images and shows them to the copilot as one contact sheet. */
async function referenceImages(ws: Workspace, req: ReferenceRequest) {
  if (!req.query && !req.pages?.length && !req.images?.length) return { content: [{ type: 'text' as const, text: 'Give a query, pages or images.' }], isError: true };
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const g = await gather(req, ws.refsDir, stamp);
  if (!g.files.length) {
    return { content: [{ type: 'text' as const, text: `No usable reference images found.${g.notes.length ? ` ${g.notes.join(' ')}` : ''} Try a different query (plain words: "grey wolf", "T-34 tank"), or a page about the subject found with WebSearch. Or build from what you know.` }] };
  }
  const sheet = await ws.refSheet(g.files, stamp);
  if (!sheet.ok || !sheet.file) return { content: [{ type: 'text' as const, text: `Could not make the reference sheet: ${sheet.error}` }], isError: true };
  const used = (sheet.used ?? g.files.map((_, i) => i)).map((i) => g.refs[i]!);
  const host = (u?: string) => {
    try {
      return u ? new URL(u).host.replace(/^www\./, '') : '';
    } catch {
      return '';
    }
  };
  // Titles come from web pages: keep them to plain words, so a page can't speak to the copilot through one.
  const plain = (t: string) => t.replace(/[^\p{L}\p{N} .,'()&:/-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  const lines = used.map((r, i) => `${i + 1}. ${plain(r.title ?? '') || 'image'} (${[host(r.source ?? r.url), r.license].filter(Boolean).join(', ')})`);
  return {
    content: [
      { type: 'image' as const, data: readFileSync(sheet.file).toString('base64'), mimeType: 'image/jpeg' },
      {
        type: 'text' as const,
        text: `Reference sheet, left to right then top to bottom:\n${lines.join('\n')}${g.notes.length ? `\n${g.notes.join(' ')}` : ''}\nStudy the silhouette, proportions, key features, materials and colours; results can include wrong or loosely related images, so ignore any that don't match. [image:${sheet.url}]`,
      },
    ],
  };
}

/** Kiln's own tools: feedback for the local feedback log, memory of the user's preferences, and (research on) reference images. */
export function kilnServer(onFeedback: (r: FeedbackReport) => void, onRemember: ((fact: string) => string) | null, research: Workspace | null = null, onStyle: ((sheet: Record<string, unknown>) => string) | null = null) {
  const planItem = z.object({
    content: z.string().min(1).max(160).describe('The step, e.g. "Block out the watchtower"'),
    status: z.enum(['pending', 'in_progress', 'completed']),
    activeForm: z.string().max(160).optional().describe('The step while it is in progress, e.g. "Blocking out the watchtower"'),
  });
  return createSdkMcpServer({
    name: 'kiln',
    version: '0.8.7',
    alwaysLoad: true,
    tools: [
      tool(
        'animation_guide',
        'The rigging and animation guide: how to build a model that will move (rig-first modeling), the rig and animation helpers, the generators, timing, and how to check motion. Read it once, before modeling, whenever a model will be rigged or animated.',
        {},
        async () => ({ content: [{ type: 'text', text: ANIMATION_GUIDE }] }),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'plan',
        "Your plan for this request, shown to the user as a checklist over the viewer. Send the whole list each time: at the start (all pending, the first in_progress) and whenever a step starts or finishes. Use it for anything with several parts; keep 3–8 steps.",
        { todos: z.array(planItem).min(1).max(20) },
        async () => ({ content: [{ type: 'text', text: 'Plan updated.' }] }),
      ),
      tool(
        'report_feedback',
        "Record what the user thinks about Kiln or about your work in Kiln's local feedback log: a complaint or frustration, a bug, a feature wish, or clear praise. Call it once when the user expresses one (even in passing), then carry on with their request. Not for ordinary instructions.",
        {
          kind: z.enum(['complaint', 'bug', 'wish', 'praise']),
          summary: z.string().describe('One or two sentences (under 400 characters), third person: what the user is unhappy/happy about or wants'),
          user_quote: z.string().optional().describe("The user's own words"),
          response: z.string().optional().describe('What you are doing about it, if anything'),
        },
        async (args) => {
          // Trimmed here rather than refused: a refusal costs a whole retry for a few characters.
          const cut = (s: string | undefined, n: number) => (s === undefined ? undefined : s.length > n ? `${s.slice(0, n - 1)}…` : s);
          onFeedback({ ...args, summary: cut(args.summary, 400)!, user_quote: cut(args.user_quote, 400), response: cut(args.response, 300) });
          return { content: [{ type: 'text', text: 'Recorded in the feedback log. Continue with the request.' }] };
        },
      ),
      ...(research ? [tool(
        'reference_images',
        'Look at reference images of a specific subject before modeling it, as one contact sheet (also shown to the user). query searches openly licensed photo and art libraries (Openverse, Wikimedia Commons): best for real things (animals, vehicles, buildings, objects, plants, styles). pages takes the main images of web pages the researcher subagent found (a wiki article about a film/game creature or character, a product page): best for fictional or branded subjects. images takes direct image URLs. Combine them if useful. Takes a few seconds.',
        {
          query: z.string().max(120).optional().describe('Plain search words, e.g. "grey wolf", "gothic cathedral facade", "T-34 tank"'),
          pages: z.array(z.string().url()).max(3).optional().describe('Web pages to take the main images from'),
          images: z.array(z.string().url()).max(8).optional().describe('Direct image URLs (JPEG, PNG or WebP)'),
          count: z.number().int().min(1).max(8).optional().describe('Images on the sheet (default 6)'),
        },
        async (args) => referenceImages(research, args),
        { annotations: { readOnlyHint: true } },
      )] : []),
      ...(onStyle ? [tool(
        'style_sheet',
        "Save the game's style sheet: the shared look every model of this game follows, so they match. Call it when Kiln tells you the game has no sheet yet (after this model's look is settled), or when the user or the other app asks to change the game's style. Send the whole sheet each time.",
        {
          title: z.string().optional().describe('The game or the look, e.g. "Mech Arena: battered industrial"'),
          palette: z.array(z.string().max(9)).min(2).max(16).describe("The game's colours as '#rrggbb'"),
          materials: z.array(z.object({
            name: z.string().min(1).max(40).describe('The material name every model uses, e.g. "Armor_Plate"'),
            color: z.string().max(9).describe("'#rrggbb'"),
            roughness: z.number().min(0).max(1).optional(),
            metallic: z.number().min(0).max(1).optional(),
            roblox_material: z.string().optional().describe("One of Roblox's own materials when the surface should use it (Metal, Concrete, Plastic…)"),
            emission: z.string().max(9).optional().describe("Glow colour as '#rrggbb', for lights and screens"),
            use: z.string().optional().describe('What it is for, in a few words, e.g. "main armour panels"'),
          })).min(1).max(24),
          bevel: z.number().min(0).max(10).optional().describe("Edge bevel radius in the game's units"),
          texel_density: z.number().min(1).max(4096).optional().describe('Texels per unit on textured parts'),
          budgets: z.array(z.object({ class: z.string().describe('A short class name, e.g. "hero", "prop", "dressing", "kit part"'), tris: z.number().int().min(50).max(500000) })).max(12).optional().describe('Triangle budgets by class of model'),
          wear: z.string().optional().describe('How worn things are: clean, worn, battered…'),
          notes: z.string().optional().describe('Proportions, silhouette rules, detail density: what else a model must follow to match (under 1,200 characters)'),
        },
        async (args) => ({ content: [{ type: 'text', text: onStyle(args as Record<string, unknown>) }] }),
      )] : []),
      ...(onRemember ? [tool(
        'remember',
        'Save a lasting preference or fact about this user for future sessions and projects (e.g. "likes substantial detail", "finds constant motion distracting", "prefers hiding or moving things over deleting them"). One short sentence. Not for facts about the current scene.',
        { fact: z.string().min(3).max(200) },
        async (args) => ({ content: [{ type: 'text', text: onRemember(args.fact) }] }),
      )] : []),
    ],
  });
}
