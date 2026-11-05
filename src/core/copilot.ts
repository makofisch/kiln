import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { MODEL } from './config.ts';
import { logCore, writeAtomic } from './fsx.ts';
import { CRITIC_PROMPT, MODELER_PROMPT, RESEARCHER_PROMPT, systemPrompt } from './prompts.ts';
import { BLENDER_TOOLS, KILN_TOOLS, PLAN_TOOL, RESEARCH_TOOLS, SERVER_NAME, blenderServer, describeZFight, fmtGap, kilnServer, type FeedbackReport } from './tools.ts';
import { memoryPrompt, remember } from './memory.ts';
import { claudeExecutable, copySession, legacySessionHome, loginEnv, publicLogin, resolveLogin, sameLogin, type Login, type LoginStatus } from './login.ts';
import { holdSecret, redact, releaseSecret } from './secrets.ts';
import type { Journal } from './journal.ts';
import { classify as watchdogClassify, watchdog } from './watchdog.ts';
import type { SceneIssues, Workspace } from './workspace.ts';
import { pickEffort, type EffortPick } from '../shared/effort.ts';
import { describeLighting } from '../shared/roblox.ts';
import type { BriefSpec, FitReport, ModelFacts, StyleSheet } from '../shared/types.ts';
import { EFFORTS, type AccountRequest, type Block, type BriefKind, type ChatMessage, type Delivery, type Effort, type EffortSetting, type RobloxLighting, type SceneSummary, type ServerEvent, type Settings, type Suggestion, type Todo, type ToolBlock, type TurnInfo } from '../shared/types.ts';

/** A push-driven async iterable: the copilot's user messages, fed to one long-lived SDK session. */
class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(v: T) {
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }

  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

export interface Upload {
  url: string;
  mediaType: string;
  data: string;
}

export interface CopilotHost {
  projectId: string;
  dir: string;
  ws: Workspace;
  /** This PC's Claude login as Settings shows it: usage, and the login of the latest turn. */
  login: LoginStatus;
  journal: Journal;
  settings: () => Settings;
  title: () => string;
  /** The project has no real name yet (ask the copilot for one). */
  needsTitle: () => boolean;
  /** The project's scene units and the app it belongs to (Shuriken models are in studs). */
  units: () => { units: 'm' | 'studs'; linked: string | null };
  /** Set when the project is built for Roblox: the game's lighting, if the other app sent it. */
  roblox: () => { lighting: RobloxLighting | null } | null;
  emit: (e: ServerEvent) => void;
  onTitle: (title: string) => void;
  onRunning: (running: boolean) => void;
  /** The game's style sheet this project follows: its id, and the sheet once someone has saved one. */
  style: () => { id: string; sheet: StyleSheet | null } | null;
  /** Saves the sheet the copilot proposes (under the project's style id) → what to tell the copilot. */
  saveStyle: (sheet: Record<string, unknown>) => string;
}

/** A message waiting for the running turn to end (POST chat with mode "queue"). */
interface Queued {
  id: string;
  text: string;
  uploads: Upload[];
  selected: string | null;
  view: string | null;
  from: string | null;
  brief: Brief;
}

/** What a brief from another app carries besides its text. */
export interface Brief {
  kind?: BriefKind | null;
  effort?: Effort | null;
  spec?: BriefSpec | null;
  /** A quick build: one pass and a look, no research, no pretty renders, no polishing. */
  quick?: boolean;
  /** The reply id to use (a queued message was promised one). */
  presetId?: string;
  /** The Claude login the turn runs on (POST chat `account`, bearer-authenticated calls only): see resolveLogin. */
  account?: AccountRequest | null;
}

/** The brief's requirements against what was built. */
export function checkSpec(spec: BriefSpec | undefined, d: Delivery): Array<{ name: string; ok: boolean; detail: string }> {
  const out: Array<{ name: string; ok: boolean; detail: string }> = [];
  const n = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
  const k = (v: number) => v.toLocaleString('en-US');
  if (spec?.tris) {
    // Per model: a set of ten street props with "4,000 each" is not 4,000 in all.
    const models = (d.models ?? []).filter((m) => m.tris > 0);
    if (models.length > 1) {
      const over = models.filter((m) => m.tris > spec.tris!);
      const top = models.reduce((a, b) => (b.tris > a.tris ? b : a));
      out.push({ name: 'tris', ok: !over.length, detail: over.length ? `over ${k(spec.tris)} per model: ${over.map((m) => `${m.name} ${k(m.tris)}`).join(', ')}` : `${models.length} models, each within ${k(spec.tris)} (largest ${top.name} ${k(top.tris)})` });
    } else out.push({ name: 'tris', ok: d.tris <= spec.tris, detail: `${k(d.tris)} triangles, budget ${k(spec.tris)}` });
  }
  if (spec?.tris_total) out.push({ name: 'tris_total', ok: d.tris <= spec.tris_total, detail: `${k(d.tris)} triangles in all, budget ${k(spec.tris_total)}` });
  if (spec?.size && d.size) {
    const axes = ['x', 'y', 'z'];
    const off = spec.size.map((t, i) => (t ? Math.abs(d.size![i]! - t) / t : 0));
    out.push({ name: 'size', ok: off.every((o) => o <= 0.2), detail: `${d.size.map(n).join(' × ')} ${d.units}, asked ${spec.size.map((t, i) => (t ? n(t) : `any ${axes[i]}`)).join(' × ')} (within 20%)` });
  }
  if (spec?.height && d.size) out.push({ name: 'height', ok: Math.abs(d.size[2]! - spec.height) / spec.height <= 0.15, detail: `${n(d.size[2]!)} ${d.units} tall, asked ${n(spec.height)} (within 15%)` });
  if (spec?.ground && d.models) {
    const tol = (m: ModelFacts) => Math.max(0.05, 0.01 * m.size[2]!);
    const bad = d.models.filter((m) => Math.abs(m.ground_gap) > tol(m));
    out.push({ name: 'ground', ok: !bad.length, detail: bad.length ? bad.map((m) => `${m.name} is ${n(Math.abs(m.ground_gap))} ${m.ground_gap > 0 ? 'above' : 'below'} the ground`).join('; ') : 'every model stands on z = 0' });
  }
  if (spec?.sockets?.length && d.models) {
    const have = new Set(d.models.flatMap((m) => m.sockets.map((s) => s.name)));
    const missing = spec.sockets.filter((s) => !have.has(s));
    out.push({ name: 'sockets', ok: !missing.length, detail: missing.length ? `missing: ${missing.join(', ')}` : `all present: ${spec.sockets.join(', ')}` });
  }
  if (spec?.parts?.length && d.models) {
    const have = new Set(d.models.flatMap((m) => (m.parts ?? []).map((p) => p.name)));
    const missing = spec.parts.filter((p) => !have.has(p));
    out.push({ name: 'parts', ok: !missing.length, detail: missing.length ? `not marked as named parts: ${missing.join(', ')}` : `all present: ${spec.parts.join(', ')}` });
  }
  if (d.fit) out.push({ name: 'fit', ok: d.fit.ok, detail: d.fit.summary });
  return out;
}

interface Persisted {
  sessionId: string | null;
  /** The Claude Code folder the session's transcript is in (0.9). */
  sessionHome?: string | null;
  /** Before 0.9: the account the session ran on ('pc', or an id from Kiln's old list of accounts). Read only. */
  sessionAccount?: string | null;
  /** The session's running usage totals as last reported: a resumed session reports from there, not from zero. `account`: its folder. */
  sessionTotals?: { id: string; account: string; input: number; output: number; cacheRead: number; cost: number };
  messages: ChatMessage[];
  todos: Todo[];
  suggestions: Array<Suggestion | string>;
}

const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch']);
const ALLOWED = new Set([...BLENDER_TOOLS, ...KILN_TOOLS, 'Agent', 'Task', ...WEB_TOOLS]);
const RESEARCH = new Set(RESEARCH_TOOLS);
/**
 * Auto-approved without a permission check. Subagent calls go through canUseTool so they can be kept in
 * the foreground, and so do the web tools: only the researcher subagent, which has no Blender tools, reads the web.
 */
const AUTO_ALLOWED = [...ALLOWED].filter((t) => !SUBAGENT_TOOLS.has(t) && !WEB_TOOLS.has(t));
const IDLE_CLOSE_MS = 10 * 60_000;
/** Claude refused the login itself: a revoked or wrong token, an invalid key, a key without credits. */
const AUTH_RE = /(oauth token (has )?(expired|been revoked)|invalid[ _-](api|x-api|bearer)[ _-]?(key|token)|invalid bearer token|authentication_error|authentication[ _]failed|credit balance is too low|not logged in|please run \/login)/i;
/** What to do when Claude refuses a turn's login. */
function loginFix(l: Login): string {
  if (l.kind === 'api-key') return 'Check the API key the brief sent (and that its account has credits).';
  if (l.kind === 'folder') return `Sign in to that login again: in the app that owns it, or with claude /login with CLAUDE_CONFIG_DIR set to ${l.configDir}.`;
  return 'Sign in to Claude Code on this PC: run claude /login in a terminal, then send again.';
}
const LIMIT_RE = /(usage limit|rate.?limit|hit your (session|weekly|usage|daily|5-hour) limit|limit (reached|exceeded)|out of (extra )?usage|resets \d{1,2}(:\d{2})?\s*(am|pm))/i;
let idCounter = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(idCounter++).toString(36)}`;

/** How another app's brief is framed for the copilot, by kind. */
const BRIEF: Record<BriefKind, string> = {
  new: 'a new build. Research first only when its subject is a specific existing thing whose exact look matters and that you cannot picture precisely (a named creature, character or vehicle from a film or game; a particular real species, machine or landmark). An everyday object (a drink can, a crate, a chair, a tree) needs no research and no reference images, even when the brief mentions brands or shows as a style comparison ("Red Bull style", "like a Saturday-morning anime"): a comparison tells you the flavour, it is not a subject to look up.',
  rework: 'a rework of this model: keep what the brief does not ask to change (the joint and clip names the game already uses). Research only if it asks you to match a specific existing subject you cannot picture precisely.',
  fix: 'a fix: change what is needed and nothing else. Attached images show how the model looks in the game; judge from them what is wrong.',
  animate: 'animation work on this rig: call mcp__kiln__animation_guide first, use its generators and checks, and keep the model and the clip names the game already uses.',
};

/**
 * The effort a turn runs at.
 * - The user's own message: their Effort setting, a fixed level or "auto" (picked from the request's complexity).
 * - A brief from another app: the effort the app chose, or else the one picked from the brief's complexity;
 *   sized to the job (a small still prop is a medium job) and never "low".
 * `why` is set when Kiln picked the level.
 */
export function turnEffort(setting: EffortSetting, from: string | null, asked: Effort | null, pick: EffortPick): { effort: Effort; why?: string } {
  if (!from) return setting === 'auto' ? { effort: pick.effort, why: pick.why } : { effort: setting };
  // A brief never runs at "low"; above that the job decides (a small prop is a medium job).
  // What the app asks for is what it gets (it knows the job's class); Kiln's own pick never goes to "low".
  const floor = (e: Effort): Effort => (EFFORTS.indexOf(e) < EFFORTS.indexOf('medium') ? 'medium' : e);
  return asked ? { effort: asked } : { effort: floor(pick.effort), why: pick.why };
}

/** {clip: fingerprint} of the scene's clips. */
function clipMap(s: SceneSummary | null): Map<string, string> {
  return new Map((s?.rig?.clips ?? []).map((c) => [c.name, c.fp ?? '']));
}

/** Best-effort value of a string field in JSON that is still streaming in. */
function partialField(json: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(json);
  if (!m) return null;
  let out = '';
  for (let i = m.index + m[0].length; i < json.length; i++) {
    const c = json[i]!;
    if (c === '"') break;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = json[i + 1];
    if (n === undefined) break;
    i++;
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '\r';
    else if (n === 'u') {
      const hex = json.slice(i + 1, i + 5);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else out += n;
  }
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

/** "Label :: the full request" (or just a request, which then doubles as its label). */
function parseSuggestion(line: string): Suggestion | null {
  const x = line.trim().replace(/^[-•*\d.)\s]+/, '');
  if (!x) return null;
  const i = x.indexOf('::');
  const label = (i >= 0 ? x.slice(0, i) : x).trim().replace(/[.]$/, '');
  const prompt = (i >= 0 ? x.slice(i + 2) : x).trim();
  if (label.length < 2 || label.length > 60 || !prompt) return null;
  return { label, prompt: prompt.slice(0, 600) };
}

/** Old chats stored plain strings. */
export const asSuggestion = (s: Suggestion | string): Suggestion => (typeof s === 'string' ? { label: s, prompt: s } : s);

/** Pulls the hidden <title> and <next> block out of a reply. */
export function extractTrailer(text: string): { text: string; title: string | null; suggestions: Suggestion[] } {
  let title: string | null = null;
  let suggestions: Suggestion[] = [];
  let out = text.replace(/<title>([\s\S]*?)<\/title>/i, (_, t: string) => {
    title = t.trim().replace(/["'`*_#]/g, '').slice(0, 40) || null;
    return '';
  });
  out = out.replace(/<next>([\s\S]*?)(<\/next>|$)/i, (_, s: string) => {
    const lines = s.includes('\n') ? s.split(/\r?\n/) : s.split('|');
    suggestions = lines
      .map(parseSuggestion)
      .filter((x): x is Suggestion => !!x)
      .slice(0, 4);
    return '';
  });
  return { text: out.trimEnd(), title, suggestions };
}

/**
 * The copilot of one project: a Claude Agent SDK session (Opus 5.5 on the turn's Claude login) fed by
 * the chat, with the Blender tools, a todo list and two subagents. It turns the SDK's
 * message stream into the transcript the UI renders, logs everything to the journal, and tells the
 * watchdog when something goes wrong.
 */
export class Copilot {
  messages: ChatMessage[] = [];
  running = false;
  todos: Todo[] = [];
  suggestions: Suggestion[] = [];
  private readonly h: CopilotHost;
  private readonly file: string;
  private sessionId: string | null = null;
  /** The Claude Code folder holding the session's transcript (it moves along when a turn runs on another login). */
  private sessionHome: string | null = null;
  private q: Query | null = null;
  private input: AsyncQueue<SDKUserMessage> | null = null;
  private queryEffort: Effort | null = null;
  /** The login the open session runs on (a turn on another login reopens it). */
  private queryLogin: Login | null = null;
  /** The login of the last turn, to say so in the chat when the next one runs on another. */
  private lastLoginKey: string | null = null;
  private current: ChatMessage | null = null;
  private turn: { login: Login; zfightChecked: boolean; startVersion: number; authHit: boolean; effort: Effort; started: number; tools: number; toolErrors: number; limitHit: boolean; retried: boolean; userText: string; content: SDKUserMessage['message']['content']; planned: boolean; interjections: number } | null = null;
  /** Messages sent with mode "queue" while a turn ran: each starts as its own turn when the one before ends. */
  private queue: Queued[] = [];
  private streamIndex = new Map<number, number>();
  private streamed = new Set<string>();
  private partial = new Map<string, { json: string; at: number }>();
  private notes: string[] = [];
  /** The open SDK session's running totals: it reports usage since it started, a turn is the difference. */
  private sessionTotals = { input: 0, output: 0, cacheRead: 0, cost: 0 };
  /** sessionTotals with the session and the login folder they belong to, kept in chat.json for the next resume. */
  private savedTotals: Persisted['sessionTotals'] | null = null;
  /** Turns other apps started (POST chat with `from`), for GET /turns/:id and the "turn" event. */
  private turns = new Map<string, TurnInfo>();
  private clipsBefore: Map<string, string> = new Map();
  private stderr: string[] = [];
  private interrupted = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastTurnEnd = 0;
  private stale = false;
  /** The last z-fighting check and the scene version it saw. */
  private lastZ: { fp: string; issues: SceneIssues } | null = null;

  constructor(host: CopilotHost) {
    this.h = host;
    this.file = join(host.dir, 'chat.json');
    this.load();
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const p = JSON.parse(readFileSync(this.file, 'utf8')) as Persisted;
      this.messages = p.messages ?? [];
      this.todos = p.todos ?? [];
      this.suggestions = (p.suggestions ?? []).map(asSuggestion);
      this.sessionId = p.sessionId ?? null;
      this.sessionHome = p.sessionHome ?? legacySessionHome(p.sessionAccount);
      this.savedTotals = p.sessionTotals ?? null;
      if (this.savedTotals && !p.sessionHome) this.savedTotals.account = legacySessionHome(this.savedTotals.account) ?? '';
      for (const m of this.messages) {
        if (m.role !== 'assistant' || m.done) continue;
        m.done = true;
        for (const b of m.blocks) if (b.kind === 'tool' && b.status === 'running') b.status = 'error';
      }
    } catch (e) {
      // Keep what couldn't be read: the next save would otherwise replace it with an empty chat.
      try {
        copyFileSync(this.file, `${this.file}.unreadable`);
      } catch {
        /* nothing to keep */
      }
      logCore(`chat of ${this.h.projectId} could not be read (${(e as Error).message}); kept as chat.json.unreadable`);
    }
  }

  private save(soon = false) {
    const write = () => {
      this.saveTimer = null;
      const p: Persisted = { sessionId: this.sessionId, sessionHome: this.sessionHome, sessionTotals: this.savedTotals ?? undefined, messages: this.messages, todos: this.todos, suggestions: this.suggestions };
      try {
        writeAtomic(this.file, redact(JSON.stringify(p)));
      } catch {
        /* the project folder may be gone */
      }
    };
    if (!soon) {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      write();
    } else if (!this.saveTimer) this.saveTimer = setTimeout(write, 1500);
  }

  /** Context for the next message (e.g. "the user undid your last change"). */
  note(text: string) {
    this.notes.push(text);
  }

  get lastAssistantText(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      if (m.role !== 'assistant') continue;
      const t = m.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join(' ').trim();
      if (t) return t;
    }
    return '';
  }

  get msSinceTurn(): number {
    return this.lastTurnEnd ? Date.now() - this.lastTurnEnd : Infinity;
  }

  private options(login: Login, effort: Effort): Options {
    const exe = claudeExecutable();
    return {
      model: MODEL,
      effort,
      thinking: { type: 'adaptive', display: 'summarized' },
      // KILN_PROMPT_EXTRA: an addendum for prompt experiments on a dev core (model comparisons).
      systemPrompt: systemPrompt({ memory: this.h.settings().memory, memories: memoryPrompt(), subagents: this.h.settings().subagents, research: this.h.settings().research, roblox: !!this.h.roblox() }) + (process.env.KILN_PROMPT_EXTRA ? `\n\n${process.env.KILN_PROMPT_EXTRA}` : ''),
      // Built-in tools: subagents, and the web tools the researcher subagent uses, each only when Settings allow them.
      tools: [...(this.h.settings().subagents || this.h.settings().research ? ['Agent'] : []), ...(this.h.settings().research ? ['WebSearch', 'WebFetch'] : [])],
      allowedTools: AUTO_ALLOWED.filter((t) => (this.h.settings().memory || !t.endsWith('__remember')) && (this.h.settings().research || !RESEARCH.has(t))),
      mcpServers: {
        [SERVER_NAME]: blenderServer(this.h.ws, { studs: () => this.h.units().units === 'studs', roblox: () => this.h.roblox() }),
        kiln: kilnServer(
          (r) => this.onFeedback(r),
          this.h.settings().memory
            ? (fact) => {
                this.h.journal.event('remembered', { text: fact });
                return remember(fact);
              }
            : null,
          this.h.settings().research ? this.h.ws : null,
          (sheet) => {
            this.h.journal.event('style sheet saved', { text: JSON.stringify(sheet).slice(0, 400) });
            return this.h.saveStyle(sheet);
          },
        ),
      },
      strictMcpConfig: true,
      settingSources: [],
      agents: {
        ...(this.h.settings().research
          ? {
              researcher: {
                description: 'Looks a named subject up on the web (a creature, vehicle or building from a film or game, a real species, machine or place) and returns what it looks like plus pages and image links that show it. It only reads; give it the subject and what you need to know.',
                prompt: RESEARCHER_PROMPT,
                tools: ['WebSearch', 'WebFetch'],
                model: 'sonnet' as const,
                background: false,
              },
            }
          : {}),
        // KILN_SUBAGENT_MODEL / _EFFORT / _EXTRA: the modeler on another model (dev-core experiments).
        modeler: {
          description: 'Builds one self-contained part of the scene in Blender from a precise brief (object and collection names, dimensions in meters, position, style, materials to reuse). Use for independent parts of a large build; several can run in parallel.',
          prompt: MODELER_PROMPT + (process.env.KILN_SUBAGENT_EXTRA ? `\n\n${process.env.KILN_SUBAGENT_EXTRA}` : ''),
          tools: BLENDER_TOOLS,
          model: process.env.KILN_SUBAGENT_MODEL || 'inherit',
          ...(process.env.KILN_SUBAGENT_EFFORT ? { effort: process.env.KILN_SUBAGENT_EFFORT as Effort } : {}),
          background: false,
        },
        critic: {
          description: 'Reviews the scene visually (renders) and numerically against a brief and returns prioritized, concrete fixes. Never edits the scene.',
          prompt: CRITIC_PROMPT,
          tools: BLENDER_TOOLS.filter((t) => !t.endsWith('run_python')),
          model: 'inherit',
          background: false,
        },
      },
      cwd: this.h.dir,
      includePartialMessages: true,
      resume: this.sessionId ?? undefined,
      // Background subagents outlived their turn and raced the copilot for the single Blender.
      // The turn's login: this PC's own, a login folder or an API key a brief sent (see resolveLogin).
      env: { ...loginEnv(login), CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
      ...(exe ? { pathToClaudeCodeExecutable: exe } : {}),
      stderr: (d) => {
        this.stderr.push(d);
        if (this.stderr.length > 40) this.stderr.shift();
      },
      canUseTool: async (name, input, opts) => {
        if (!ALLOWED.has(name)) return { behavior: 'deny', message: 'Kiln only allows its Blender and Kiln tools and subagents.' };
        if (RESEARCH.has(name) && !this.h.settings().research) return { behavior: 'deny', message: 'Reference research is turned off in Settings: build from what you know.' };
        // Web pages are read only inside a subagent (the researcher has no Blender tools), never by the agent that runs Python.
        if (WEB_TOOLS.has(name) && !(opts as { agentID?: string } | undefined)?.agentID) return { behavior: 'deny', message: 'Start the researcher subagent for web lookups (Agent with subagent_type "researcher"); it returns the facts and the links for mcp__kiln__reference_images.' };
        if (SUBAGENT_TOOLS.has(name) && !this.h.settings().subagents && (input as { subagent_type?: string }).subagent_type !== 'researcher') return { behavior: 'deny', message: 'Subagents are turned off in Settings (only the researcher is available): do this part yourself.' };
        // Subagents run in the foreground: several in one message still run in parallel, and the turn waits for them.
        if (SUBAGENT_TOOLS.has(name)) return { behavior: 'allow', updatedInput: { ...input, run_in_background: false } };
        return { behavior: 'allow', updatedInput: input };
      },
    };
  }

  /** The effort a session opens at before a message says more: the user's setting ("auto" starts at high). */
  private restingEffort(): Effort {
    const e = this.h.settings().effort;
    return e === 'auto' ? 'high' : e;
  }

  /**
   * Starts (or re-targets) the SDK session for this login and effort (default: the user's setting).
   * A change of effort alone is applied to the open session; the promise it returns resolves when the
   * session has taken it (send the message after that). Null: ready now.
   */
  private ensureQuery(login: Login, effort: Effort = this.restingEffort()): Promise<void> | null {
    if (this.q && !this.stale && this.queryLogin && sameLogin(this.queryLogin, login)) {
      if (this.queryEffort === effort) return null;
      const q = this.q;
      this.queryEffort = effort;
      return q.applyFlagSettings({ effortLevel: effort }).catch((e: Error) => {
        // The session wouldn't take it: reopen it at the new effort (the conversation resumes).
        logCore(`effort change to ${effort} in ${this.h.projectId} needed a restart: ${e.message}`);
        if (this.q !== q) return;
        this.closeQuery();
        this.openQuery(login, effort);
      });
    }
    this.closeQuery();
    this.openQuery(login, effort);
    return null;
  }

  private openQuery(login: Login, effort: Effort) {
    this.stale = false;
    // The conversation goes along to the login's folder (Claude Code keeps sessions per folder); if it can't, it starts afresh.
    if (this.sessionId && (!this.sessionHome || !copySession(this.sessionId, this.sessionHome, login.home))) this.sessionId = null;
    const input = new AsyncQueue<SDKUserMessage>();
    const q = query({ prompt: input, options: this.options(login, effort) });
    this.q = q;
    this.input = input;
    this.queryEffort = effort;
    this.queryLogin = login;
    this.sessionHome = login.home;
    // A resumed session reports usage since the conversation began (the SDK restores it), not since this
    // query opened: start from the totals it last reported, or every resume counts the whole history again.
    const t = this.savedTotals;
    this.sessionTotals = t && this.sessionId && t.id === this.sessionId && t.account.toLowerCase() === login.home.toLowerCase() ? { input: t.input, output: t.output, cacheRead: t.cacheRead, cost: t.cost } : { input: 0, output: 0, cacheRead: 0, cost: 0 };
    void this.pump(q);
  }

  /**
   * The copilot's instructions changed (memory edited or turned on/off in Settings): the next
   * message uses a fresh session process with the new instructions; the conversation is resumed.
   */
  instructionsChanged() {
    this.stale = true;
    if (!this.running && this.q) {
      this.closeQuery();
      this.warm();
    }
  }

  /** Opens the session ahead of the first message, so sending is instant (no model call). */
  warm() {
    if (this.running) return;
    try {
      // Messages typed in Kiln run on this PC's own login.
      this.ensureQuery(resolveLogin(null));
      this.armIdle();
    } catch {
      /* the first send will retry */
    }
  }

  /** Starts the session if needed and reports whether it's healthy: login, MCP tool servers. No model call. */
  async diagnose(): Promise<Record<string, unknown>> {
    // Never re-target a session in the middle of a turn: look at the one that is running.
    const login = this.running && this.turn ? this.turn.login : resolveLogin(null);
    if (!this.running) this.ensureQuery(login);
    const q = this.q;
    if (!q) return { ok: false, error: 'No copilot session is open' };
    const timeout = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out')), 45_000))]);
    try {
      const init = await timeout(q.initializationResult());
      const mcp = await timeout(q.mcpServerStatus());
      return {
        ok: mcp.every((s) => s.status === 'connected'),
        account: { ...publicLogin(login), email: init.account?.email ?? null, plan: init.account?.subscriptionType ?? null },
        mcp: mcp.map((s) => ({ name: s.name, status: s.status, tools: (s as { tools?: Array<{ name: string }> }).tools?.map((t) => t.name) })),
        agents: init.agents?.map((a) => a.name),
        sessionId: this.sessionId,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message, stderr: this.stderr.join('').slice(-800) };
    }
  }

  private armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.running) this.closeQuery();
    }, IDLE_CLOSE_MS);
    this.idleTimer.unref();
  }

  private closeQuery() {
    const q = this.q;
    this.q = null;
    this.queryLogin = null;
    this.input?.close();
    this.input = null;
    try {
      q?.close();
    } catch {
      /* already closed */
    }
  }

  /**
   * Sends a chat message; the reply streams into the transcript. Returns the turn's id (the reply message's id).
   * `from`: another app's assistant sending a brief for the user; `brief` says what kind and (optionally) the effort.
   */
  send(text: string, uploads: Upload[] = [], selected: string | null = null, view: string | null = null, from: string | null = null, brief: Brief = {}): string {
    if (this.running) throw new Error('The copilot is still working on the last message.');
    // The login: the one the brief's `account` names (another app's, e.g. Shuriken's), else this PC's own.
    const login = resolveLogin(brief.account ?? null, from);
    const loginKey = login.kind === 'folder' ? `folder:${(login.configDir ?? '').toLowerCase()}` : login.kind;
    const switched = !!this.lastLoginKey && this.lastLoginKey !== loginKey && this.messages.length > 0;
    this.lastLoginKey = loginKey;
    const signedOut = !!login.problem;
    const kind = from ? (brief.kind ?? null) : null;
    const pick = pickEffort({ text, images: uploads.length, sceneEmpty: (this.h.ws.summaryNow?.objects ?? 0) === 0, kind, tris: brief.spec?.tris ?? null });
    const { effort, why } = turnEffort(this.h.settings().effort, from, brief.effort ?? null, brief.quick && EFFORTS.indexOf(pick.effort) > EFFORTS.indexOf('medium') ? { effort: 'medium', why: `${pick.why}, quick build` } : pick);
    const ready = signedOut ? null : this.ensureQuery(login, effort);
    const user: ChatMessage = {
      id: newId('u'),
      role: 'user',
      blocks: [{ kind: 'text', text }],
      images: uploads.map((u) => u.url),
      createdAt: Date.now(),
      ...(from ? { from } : {}),
      ...(kind ? { kind } : {}),
      ...(from || why ? { effort } : {}),
      ...(why ? { effortWhy: why } : {}),
    };
    const reply: ChatMessage = { id: brief.presetId ?? newId('a'), role: 'assistant', blocks: [], createdAt: Date.now() };
    if (switched) reply.blocks.push({ kind: 'note', text: `This turn runs on ${login.label} (${login.why}).` });
    this.messages.push(user, reply);
    this.current = reply;
    this.running = true;
    this.interrupted = false;
    this.turn = { login, zfightChecked: false, startVersion: this.h.ws.version, authHit: false, effort, started: Date.now(), tools: 0, toolErrors: 0, limitHit: false, retried: false, userText: text, content: [], planned: false, interjections: 0 };
    // An API key stays in memory for this turn only, and is never written out (see secrets.ts).
    if (login.apiKey) holdSecret(login.apiKey);
    this.h.login.noteTurn(login);
    this.suggestions = [];
    this.h.emit({ type: 'message', message: user });
    this.h.emit({ type: 'message', message: reply });
    this.h.emit({ type: 'running', running: true });
    this.h.emit({ type: 'suggestions', suggestions: [] });
    this.h.onRunning(true);

    const notes = [...this.notes];
    if (from) {
      notes.push(
        `this message is a brief from ${from}, the assistant building the user's game: the user did not type it. Its goals and the constraints the game depends on (what the model is for, how it is seen, sizes, clip names, markers, speeds, budgets) are fixed. How to get there is your call: research, modeling approach, materials, rig and animation technique are yours, with Kiln's own tools and checks. If it prescribes a method or exact values (joint angles, gait parameters, frame lists, texture tweaks) and you can meet the goal better another way, do it your way and say what you changed. End with a short reply it can pass on: what you made, its size, the clips with their ground speeds and markers, and anything the game must know.`,
      );
      if (kind) notes.push(`this brief is ${BRIEF[kind]}`);
    }
    if (brief.quick) notes.push('this is a QUICK build: the user wants it in a couple of minutes and will ask for more if they want more. Build the whole thing in one run_python call, take one fast contact sheet (two or three views), fix only what is plainly wrong in one more call, and stop. No research, no reference images, no pretty renders, no plan checklist, no helper-source reading, no polishing passes, no second look after the fix unless it failed. Keep the reply to three lines. Requirements stated in the brief still hold.');
    const spec = brief.spec ?? null;
    if (spec) {
      const u0 = this.h.units().units;
      const want = [
        spec.tris ? `at most ${spec.tris.toLocaleString('en-US')} triangles per model (each top-level model has its own budget)` : '',
        spec.tris_total ? `at most ${spec.tris_total.toLocaleString('en-US')} triangles in all, every model together` : '',
        spec.size ? `overall size about ${spec.size.map((v) => (v ? String(v) : 'any')).join(' × ')} ${u0} (x × y × z, within 20%)` : '',
        spec.height ? `about ${spec.height} ${u0} tall (within 15%)` : '',
        spec.ground ? 'every model standing on the ground: its lowest point at z = 0' : '',
        spec.sockets?.length ? `sockets named ${spec.sockets.join(', ')} (kiln.socket)` : '',
        spec.parts?.length ? `named parts ${spec.parts.join(', ')}, each its own object marked with kiln.part` : '',
      ].filter(Boolean);
      if (want.length) notes.push(`hard requirements of this brief, each checked when you finish: ${want.join('; ')}. Meet them; if one truly can't be met, say which and why.`);
    }
    // The game's style sheet: followed when it exists, proposed by this build when it doesn't.
    const style = this.h.style();
    try {
      if (style?.sheet) writeAtomic(join(this.h.dir, 'style.json'), JSON.stringify(style.sheet));
      else rmSync(join(this.h.dir, 'style.json'), { force: true });
    } catch {
      /* the note below still carries the sheet */
    }
    if (style?.sheet) notes.push(`this model belongs to a game whose style sheet is "${style.id}": ${JSON.stringify({ ...style.sheet, id: undefined, updatedAt: undefined, from: undefined })}. Follow it so the game's models match: its palette, its materials by name (kiln.style_mat("<name>") makes each exactly as the sheet says; don't invent a new material where one of these fits), its bevel size, texel density, wear and triangle budgets. kiln.style() returns it.`);
    else if (style) notes.push(`this model belongs to a game that has no style sheet yet (its id will be "${style.id}"). Once this model's look is settled, save the sheet with mcp__kiln__style_sheet so the game's other models match it: the palette, the materials you used (names, colours, roughness, metalness, Roblox material hints), bevel size, texel density, wear, triangle budgets by class, and what else a model must follow.`);
    if (selected) notes.push(`the user has "${selected}" selected in the viewer.`);
    if (view) notes.push(view);
    const u = this.h.units();
    const rbx = this.h.roblox();
    if (rbx) notes.push(`this model is built for Roblox${u.linked ? ` (${u.linked} exports it)` : ''}: follow "Roblox target".${u.units === 'studs' ? ' Units are studs.' : ''} Its front (a door, a sign's face, a vehicle's nose, the side a player sees first) faces -Y, the front view. The game's lighting: ${describeLighting(rbx.lighting)}; pretty renders use it.`);
    else if (u.units === 'studs') notes.push(`this model is built for ${u.linked ?? 'another app'}: units are studs (1 unit = 1 stud ≈ 0.28 m), a default character is 5.2 studs tall, its front faces -Y.`);
    if (this.h.needsTitle()) notes.push('this project has no name yet: once the scene shows what the user asked for, name it with a <title> line.');
    this.notes = [];
    this.h.journal.user(text, { images: uploads.length, selected, notes, account: `${login.label} (${login.why})`, effort: why ? `${effort} (auto: ${why})` : effort, from, kind });
    // Complaint heuristics are for what the user types after seeing a result: not briefs from other apps, not a project's first request.
    if (!from && this.messages.filter((m) => m.role === 'user').length > 1) this.checkMessage(text);

    const prefix = notes.length ? `${notes.map((n) => `[Kiln: ${n}]`).join('\n')}\n\n` : '';
    const content = [
      ...uploads.map((u) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: u.mediaType as 'image/png', data: u.data } })),
      { type: 'text' as const, text: prefix + text },
    ];
    this.turn.content = content;
    this.clipsBefore = clipMap(this.h.ws.summaryNow);
    this.turns.set(reply.id, { projectId: this.h.projectId, turnId: reply.id, state: 'running', reply: '', clips: [], effort, ...(why ? { effortWhy: why } : {}), account: publicLogin(login), ...(from ? { from } : {}), ...(kind ? { kind } : {}), ...(spec ? { spec } : {}), ...(style ? { style: style.id } : {}) });
    if (this.turns.size > 50) this.turns.delete(this.turns.keys().next().value!);
    const push = () => {
      if (this.current === reply) this.input?.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null } as SDKUserMessage);
    };
    if (signedOut) {
      // No usable login: say so instead of starting a session that can only fail (no model call).
      this.save();
      setTimeout(() => {
        if (this.current === reply) this.endTurn(`No Claude login for this turn: ${login.problem}`);
      }, 0);
      return reply.id;
    }
    if (ready) void ready.then(push);
    else push();
    this.save();
    return reply.id;
  }

  /**
   * A message sent while a turn is running. The copilot reads it at its next tool boundary and re-plans:
   * no waiting for the turn to end, nothing thrown away. It joins the running turn (same id, one result).
   */
  interject(text: string, uploads: Upload[] = [], from: string | null = null): string {
    const cur = this.current;
    const t = this.turn;
    if (!this.running || !cur || !t || !this.input) throw new Error('No turn is running.');
    cur.blocks.push({ kind: 'note', text: `${from ?? 'You'}, while it worked: ${text}` });
    this.emitCurrent();
    t.interjections++;
    this.h.journal.user(text, { images: uploads.length, selected: null, notes: ['sent while the copilot was working: taken into the running turn'], account: t.login.label, effort: t.effort, from });
    const who = from ? `${from} (the assistant building the user's game)` : 'the user';
    const content = [
      ...uploads.map((u) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: u.mediaType as 'image/png', data: u.data } })),
      {
        type: 'text' as const,
        text: `[Kiln: ${who} sent this while you were working on the request above. It belongs to the same job: take it in now. If it changes the plan or something you have already built, update the plan and change what needs changing; if it only adds something, fit it in. Don't start over unless it asks for that. In your final reply, say what you changed because of it.]\n\n${text}`,
      },
    ];
    // "next": the session folds it in at the next tool boundary instead of holding it until the turn ends.
    this.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, priority: 'next' } as SDKUserMessage);
    this.save();
    return cur.id;
  }

  /** A message for after the running turn: it starts as its own turn when this one ends. Returns that turn's id. */
  enqueue(text: string, uploads: Upload[] = [], selected: string | null = null, view: string | null = null, from: string | null = null, brief: Brief = {}): string {
    const cur = this.current;
    if (!this.running || !cur) return this.send(text, uploads, selected, view, from, brief);
    const id = newId('a');
    this.queue.push({ id, text, uploads, selected, view, from, brief });
    const kind = from ? (brief.kind ?? null) : null;
    this.turns.set(id, { projectId: this.h.projectId, turnId: id, state: 'queued', reply: '', clips: [], ...(from ? { from } : {}), ...(kind ? { kind } : {}), ...(brief.spec ? { spec: brief.spec } : {}) });
    cur.blocks.push({ kind: 'note', text: `${from ?? 'You'}, for after this: ${text}` });
    this.emitCurrent();
    return id;
  }

  /** A turn's state and outcome; while it runs, where it is. */
  turnInfo(id: string): TurnInfo | null {
    const info = this.turns.get(id) ?? null;
    if (!info || info.state !== 'running' || this.current?.id !== id || !this.turn) return info;
    const cur = this.current;
    const t = this.turn;
    const tools = cur.blocks.filter((b): b is ToolBlock => b.kind === 'tool' && !b.parent);
    const live = [...tools].reverse().find((b) => b.status === 'running');
    const done = t.planned ? this.todos.filter((x) => x.status === 'completed').length : 0;
    const total = t.planned ? this.todos.length : 0;
    const active = t.planned ? this.todos.find((x) => x.status === 'in_progress') : undefined;
    const elapsedMs = Date.now() - t.started;
    const lastRender = [...tools].reverse().find((b) => b.image)?.image ?? null;
    return {
      ...info,
      progress: {
        steps: t.planned ? { done, total } : null,
        current: active?.activeForm ?? active?.content ?? null,
        tool: live ? `${live.name.replace(/^mcp__\w+__/, '')}${live.input.description ? `: ${String(live.input.description).slice(0, 120)}` : ''}` : null,
        tools: tools.filter((b) => b.status !== 'running').length,
        lastRender,
        elapsedMs,
        etaMs: done > 0 && total > done ? Math.round((elapsedMs / done) * (total - done)) : null,
        interjections: t.interjections,
      },
    };
  }

  async stop() {
    if (!this.running) return;
    this.interrupted = true;
    this.h.journal.event('stop pressed');
    this.signal('The user pressed Stop during a turn', 2, ['stop']);
    const stopping = this.current;
    const force = () => {
      if (this.running && this.current === stopping) {
        this.closeQuery();
        this.endTurn('Stopped.');
      }
    };
    // If the session never answers the interrupt, end the turn ourselves.
    const guard = setTimeout(force, 15_000);
    guard.unref();
    try {
      await Promise.race([this.q?.interrupt(), new Promise((r) => setTimeout(r, 10_000).unref())]);
    } catch {
      clearTimeout(guard);
      force();
    }
  }

  dispose() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.turn?.login.apiKey) {
      releaseSecret(this.turn.login.apiKey);
      this.turn.login.apiKey = undefined;
    }
    this.closeQuery();
    this.save();
  }

  /** Records a 👍/👎 on a reply. */
  rate(messageId: string, rating: 'up' | 'down', note: string) {
    const m = this.messages.find((x) => x.id === messageId);
    if (!m) return;
    m.rating = rating;
    const said = m.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join(' ').trim();
    const i = this.messages.indexOf(m);
    const asked = i > 0 ? this.messages[i - 1]!.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join(' ') : '';
    watchdog.record({
      kind: 'rating',
      severity: rating === 'down' ? 2 : 1,
      source: 'user',
      project: this.h.projectId,
      projectTitle: this.h.title(),
      text: `${rating === 'up' ? '👍' : '👎'} ${note || '(no note)'}`,
      context: `asked: ${asked.slice(0, 200)} → replied: ${said.slice(0, 300)}`,
      conversation: `${this.h.projectId}.md`,
    });
    this.h.journal.event(`rated ${rating}`, { text: note, message: messageId });
    this.h.emit({ type: 'message', message: m });
    this.save();
  }

  private onFeedback(r: FeedbackReport) {
    watchdog.record({
      kind: r.kind,
      severity: r.kind === 'bug' ? 3 : r.kind === 'complaint' ? 2 : 1,
      source: 'copilot',
      project: this.h.projectId,
      projectTitle: this.h.title(),
      text: `${r.summary}${r.user_quote ? ` — “${r.user_quote}”` : ''}${r.response ? ` (copilot: ${r.response})` : ''}`,
      context: this.lastAssistantText.slice(0, 300),
      conversation: `${this.h.projectId}.md`,
    });
    this.h.journal.event('copilot reported feedback', { text: `${r.kind}: ${r.summary}` });
  }

  private checkMessage(text: string) {
    const c = watchdogClassify(text);
    if (!c) return;
    watchdog.record({ kind: c.kind, severity: c.severity, source: 'heuristic', project: this.h.projectId, projectTitle: this.h.title(), text, signals: c.signals, context: this.lastAssistantText.slice(0, 300), conversation: `${this.h.projectId}.md` });
  }

  signal(text: string, severity: 1 | 2 | 3, signals: string[]) {
    watchdog.record({ kind: 'signal', severity, source: 'system', project: this.h.projectId, projectTitle: this.h.title(), text, signals, context: this.lastAssistantText.slice(0, 200), conversation: `${this.h.projectId}.md` });
  }

  private async pump(q: Query) {
    try {
      for await (const m of q as AsyncIterable<SDKMessage>) this.handle(m);
    } catch (e) {
      if (this.q === q && this.running) this.endTurn(`The copilot stopped: ${(e as Error).message}${this.stderrTail()}`);
    } finally {
      if (this.q === q) {
        this.q = null;
        this.input = null;
        if (this.running) this.endTurn(`The copilot's session ended unexpectedly.${this.stderrTail()}`);
      }
    }
  }

  private stderrTail() {
    const t = redact(this.stderr.join('').trim().slice(-800));
    return t ? `\n${t}` : '';
  }

  private push(block: Block): number {
    this.current!.blocks.push(block);
    return this.current!.blocks.length - 1;
  }

  private findTool(id: string): ToolBlock | undefined {
    for (let i = this.messages.length - 1; i >= 0 && i >= this.messages.length - 4; i--) {
      const b = this.messages[i]!.blocks.find((x) => x.kind === 'tool' && x.id === id);
      if (b) return b as ToolBlock;
    }
    return undefined;
  }

  private emitCurrent() {
    if (this.current) this.h.emit({ type: 'message', message: this.current });
    this.save(true);
  }

  private setTodos(input: unknown) {
    const todos = (input as { todos?: Todo[] })?.todos;
    if (!Array.isArray(todos)) return;
    this.todos = todos;
    if (this.turn) this.turn.planned = true;
    this.h.emit({ type: 'todos', todos });
  }

  private handle(m: SDKMessage) {
    const cur = this.current;
    switch (m.type) {
      case 'system': {
        const s = m as unknown as Record<string, unknown> & { subtype: string };
        if (s.subtype === 'init') {
          this.sessionId = s.session_id as string;
          this.save();
        } else if (s.subtype === 'task_started' || s.subtype === 'task_progress' || s.subtype === 'task_notification') {
          const b = s.tool_use_id ? this.findTool(s.tool_use_id as string) : undefined;
          if (!b) return;
          const usage = s.usage as { total_tokens?: number; tool_uses?: number } | undefined;
          b.task = {
            ...b.task,
            ...(s.subagent_type ? { type: s.subagent_type as string } : {}),
            ...(s.description ? { description: s.description as string } : {}),
            ...(usage ? { tokens: usage.total_tokens, toolUses: usage.tool_uses } : {}),
            ...(s.last_tool_name ? { lastTool: s.last_tool_name as string } : {}),
            ...(s.summary ? { summary: s.summary as string } : {}),
            status: s.subtype === 'task_notification' ? (s.status as 'completed') : 'running',
          };
          this.emitCurrent();
        } else if (s.subtype === 'api_retry') {
          this.h.emit({ type: 'notice', level: 'warn', text: `Claude API retry ${s.attempt}/${s.max_retries}` });
        } else if (s.subtype === 'compact_boundary') {
          this.h.emit({ type: 'notice', level: 'info', text: 'The conversation was compacted to save context.' });
        }
        return;
      }
      case 'stream_event': {
        if (!cur || m.parent_tool_use_id !== null) return;
        const ev = m.event as {
          type: string;
          index?: number;
          message?: { id?: string };
          content_block?: { type: string; id?: string; name?: string; text?: string; thinking?: string };
          delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
        };
        if (ev.type === 'message_start') {
          this.streamIndex.clear();
          if (ev.message?.id) this.streamed.add(ev.message.id);
        } else if (ev.type === 'content_block_start' && ev.content_block && ev.index !== undefined) {
          const cb = ev.content_block;
          let idx = -1;
          if (cb.type === 'text') idx = this.push({ kind: 'text', text: cb.text ?? '' });
          else if (cb.type === 'thinking') idx = this.push({ kind: 'thinking', text: cb.thinking ?? '' });
          else if (cb.type === 'tool_use' && cb.id && cb.name) {
            idx = this.push({ kind: 'tool', id: cb.id, name: cb.name, input: {}, status: 'running', parent: null, startedAt: Date.now() });
            this.partial.set(cb.id, { json: '', at: 0 });
          }
          if (idx >= 0) {
            this.streamIndex.set(ev.index, idx);
            this.emitCurrent();
          }
        } else if (ev.type === 'content_block_delta' && ev.delta && ev.index !== undefined) {
          const idx = this.streamIndex.get(ev.index);
          if (idx === undefined) return;
          const b = cur.blocks[idx]!;
          const d = ev.delta;
          if ((d.type === 'text_delta' && b.kind === 'text') || (d.type === 'thinking_delta' && b.kind === 'thinking')) {
            const t = (d.type === 'text_delta' ? d.text : d.thinking) ?? '';
            b.text += t;
            this.h.emit({ type: 'delta', id: cur.id, index: idx, text: t });
            this.save(true);
          } else if (d.type === 'input_json_delta' && b.kind === 'tool') {
            const p = this.partial.get(b.id) ?? { json: '', at: 0 };
            p.json += d.partial_json ?? '';
            this.partial.set(b.id, p);
            if (Date.now() - p.at > 120) {
              p.at = Date.now();
              const code = partialField(p.json, 'code');
              const description = partialField(p.json, 'description');
              b.input = { ...(description !== null ? { description } : {}), ...(code !== null ? { code } : {}), _streaming: true };
              this.emitCurrent();
            }
          }
        } else if (ev.type === 'content_block_stop' && ev.index !== undefined) {
          const idx = this.streamIndex.get(ev.index);
          if (idx === undefined) return;
          const b = cur.blocks[idx]!;
          if (b.kind === 'thinking') b.done = true;
          if (b.kind === 'tool') {
            const p = this.partial.get(b.id);
            try {
              b.input = p?.json ? (JSON.parse(p.json) as Record<string, unknown>) : {};
            } catch {
              /* the assistant message carries the final input */
            }
            this.partial.delete(b.id);
            b.ranAt = Date.now(); // the call is written: from here on the time is the tool's own
            if (b.name === PLAN_TOOL || b.name === 'TodoWrite') this.setTodos(b.input);
          }
          this.emitCurrent();
        }
        return;
      }
      case 'assistant': {
        if (!cur) return;
        const parent = m.parent_tool_use_id;
        const msg = m.message as { id?: string; content?: Array<{ type: string; id?: string; name?: string; input?: unknown; text?: string; thinking?: string }> };
        const streamed = !!msg.id && this.streamed.has(msg.id);
        for (const b of msg.content ?? []) {
          if (b.type === 'tool_use' && b.id && b.name) {
            const existing = this.findTool(b.id);
            if (existing) existing.input = (b.input ?? {}) as Record<string, unknown>;
            else this.push({ kind: 'tool', id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown>, status: 'running', parent, startedAt: Date.now() });
            if ((b.name === PLAN_TOOL || b.name === 'TodoWrite') && !parent) this.setTodos(b.input);
          } else if (parent) {
            if (b.type === 'text' && b.text) {
              const task = this.findTool(parent);
              if (task) task.task = { ...task.task, summary: b.text.slice(0, 400) };
            }
          } else if (!streamed) {
            if (b.type === 'text' && b.text) this.push({ kind: 'text', text: b.text });
            else if (b.type === 'thinking' && b.thinking) this.push({ kind: 'thinking', text: b.thinking, done: true });
          }
        }
        const err = (m as { error?: string }).error;
        if (err && !parent) {
          if (LIMIT_RE.test(err) || err === 'rate_limit') {
            if (this.turn) this.turn.limitHit = true;
          } else {
            if (AUTH_RE.test(err) && this.turn) this.turn.authHit = true;
            this.push({ kind: 'error', text: redact(`Claude reported: ${err}`) });
          }
        }
        this.emitCurrent();
        return;
      }
      case 'user': {
        const content = (m.message as { content?: unknown }).content;
        if (!Array.isArray(content)) return;
        let touched = false;
        for (const c of content as Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>) {
          if (c.type !== 'tool_result' || !c.tool_use_id) continue;
          const b = this.findTool(c.tool_use_id);
          if (!b) continue;
          let out = textOf(c.content);
          // Image markers count only from Kiln's own tools and only for this app's files (web text can't plant pictures in the chat).
          const own = b.name.startsWith('mcp__blender__') || b.name.startsWith('mcp__kiln__');
          const imgs = own ? [...out.matchAll(/\[image:([^\]]+)\]/g)].filter((m) => m[1]!.startsWith('/files/')) : [];
          if (imgs.length) {
            b.image = imgs[0]![1];
            if (imgs.length > 1) b.images = imgs.map((m) => m[1]!);
            for (const m of imgs) out = out.replace(m[0], '');
            out = out.trim();
          }
          b.output = out.length > 6000 ? `${out.slice(0, 6000)}…` : out;
          b.status = c.is_error ? 'error' : 'ok';
          b.endedAt = Date.now();
          if (SUBAGENT_TOOLS.has(b.name)) b.task = { ...b.task, status: c.is_error ? 'failed' : 'completed' };
          if (this.turn) {
            this.turn.tools++;
            if (c.is_error) this.turn.toolErrors++;
          }
          this.h.journal.tool({ name: b.name.replace(/^mcp__\w+__/, ''), description: (b.input.description as string) ?? undefined, status: b.status, ms: b.endedAt - (b.ranAt ?? b.startedAt), writeMs: b.ranAt ? b.ranAt - b.startedAt : 0, error: c.is_error ? out.slice(0, 1200) : undefined, parent: b.parent });
          touched = true;
        }
        if (touched) this.emitCurrent();
        return;
      }
      case 'rate_limit_event': {
        const info = m.rate_limit_info;
        const login = this.turn?.login ?? this.queryLogin;
        if (login) this.h.login.recordUsage(login, info);
        if (info.status === 'rejected' && this.turn) this.turn.limitHit = true;
        return;
      }
      case 'result': {
        if (!cur) return;
        let input = 0;
        let output = 0;
        let cacheRead = 0;
        for (const u of Object.values(m.modelUsage ?? {})) {
          input += (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
          cacheRead += u.cacheReadInputTokens ?? 0;
          output += u.outputTokens ?? 0;
        }
        const prev = cur.usage;
        // The session reports totals since it started: this turn's share is what was added since the last result.
        const was = this.sessionTotals;
        const cost = m.total_cost_usd ?? 0;
        const delta = (now: number, before: number) => (now >= before ? now - before : now);
        cur.usage = {
          inputTokens: delta(input, was.input) + (prev?.inputTokens ?? 0),
          outputTokens: delta(output, was.output) + (prev?.outputTokens ?? 0),
          cacheReadTokens: delta(cacheRead, was.cacheRead) + (prev?.cacheReadTokens ?? 0),
          durationMs: Date.now() - (this.turn?.started ?? cur.createdAt),
          turns: (m.num_turns ?? 0) + (prev?.turns ?? 0),
          costUsd: delta(cost, was.cost) + (prev?.costUsd ?? 0),
          account: this.turn?.login.label,
        };
        this.sessionTotals = { input, output, cacheRead, cost };
        if (this.sessionId && this.queryLogin) this.savedTotals = { id: this.sessionId, account: this.queryLogin.home, ...this.sessionTotals };
        let error: string | null = null;
        if (this.interrupted) error = 'Stopped.';
        else if (m.subtype !== 'success') error = (m as { errors?: string[] }).errors?.join('\n') || m.subtype;
        else if (m.is_error) error = m.result || 'Claude reported an error.';
        if (error && LIMIT_RE.test(error) && this.turn) this.turn.limitHit = true;
        // A session that can't be resumed (moved, deleted): start a fresh one and send the message again.
        if (error && /no conversation found|conversation .*not found|session .*not found/i.test(error) && this.turn && !this.turn.retried) {
          this.turn.retried = true;
          this.sessionId = null;
          this.closeQuery();
          this.ensureQuery(this.turn.login, this.turn.effort);
          this.input!.push({ type: 'user', message: { role: 'user', content: this.turn.content }, parent_tool_use_id: null } as SDKUserMessage);
          return;
        }
        // Claude refused the login itself (not signed in, a revoked token, a wrong key, no credits): say what to do.
        // A turn has one login and is never moved to another.
        if ((this.turn?.authHit || (error && AUTH_RE.test(error))) && this.turn && !this.interrupted) {
          error = `Claude refused ${this.turn.login.label} (${this.turn.login.why}). ${loginFix(this.turn.login)}${error ? `\nClaude said: ${error}` : ''}`;
        }
        if (this.turn?.limitHit && !this.interrupted) {
          const t = this.turn;
          this.signal(`Usage limit reached on ${t.login.label}`, 1, ['usage-limit']);
          error = `${t.login.label} has reached its usage limit. ${error ?? ''}`.trim();
        }
        // A message sent while it worked arrived too late for a tool boundary: the session takes it up
        // now, as part of the same reply. After a Stop or an error the backlog goes with the session process.
        if (((m as { queued_turn_count?: number }).queued_turn_count ?? 0) > 0) {
          if (!error) return;
          this.closeQuery();
        }
        // The last look before delivering: no model leaves Kiln with surfaces that z-fight.
        if (!error && !this.interrupted && this.turn && !this.turn.zfightChecked && this.h.ws.version !== this.turn.startVersion) {
          this.turn.zfightChecked = true;
          void this.zfightGate(cur);
          return;
        }
        this.endTurn(error);
        return;
      }
      default:
        return;
    }
  }

  /** The z-fighting check, once per scene version (the gate and the delivery share it). */
  private async zfight(): Promise<SceneIssues | null> {
    const fp = `${this.h.ws.version}:${this.h.ws.state().fingerprint ?? ''}`;
    if (this.lastZ && this.lastZ.fp === fp) return this.lastZ.issues;
    try {
      const r = await this.h.ws.check(false);
      if (!r.ok) return null;
      this.lastZ = { fp, issues: r };
      return r;
    } catch {
      return null;
    }
  }

  /**
   * Before a turn that changed the scene ends: if surfaces still z-fight, the copilot is sent back once to fix them
   * (in the same turn and reply), then the turn ends as usual. Nothing found: the turn ends now.
   */
  private async zfightGate(cur: ChatMessage) {
    const issues = await this.zfight();
    if (this.current !== cur || !this.running) return;
    if (!issues?.zfight_pairs || !this.input) return this.endTurn(null);
    const units = issues.zfight_rule?.units ?? this.h.units().units;
    const list = issues.zfight.slice(0, 10).map((z) => describeZFight(z, units)).join('; ');
    this.h.journal.event('z-fighting before delivery', { text: `${issues.zfight_pairs} pair(s): ${list}` });
    // The reply so far ended with its hidden trailer (follow-ups, a name): take it out now, the next reply brings its own.
    for (let i = cur.blocks.length - 1; i >= 0; i--) {
      const b = cur.blocks[i]!;
      if (b.kind !== 'text') continue;
      const x = extractTrailer(b.text);
      b.text = x.text;
      if (x.title) this.h.onTitle(x.title);
      break;
    }
    cur.blocks.push({ kind: 'note', text: `Kiln's check found ${issues.zfight_pairs} pair(s) of surfaces that would flicker (z-fighting): the copilot fixes them before finishing.` });
    this.emitCurrent();
    this.input.push({
      type: 'user',
      message: {
        role: 'user',
        content: `[Kiln: before you finish: the z-fighting check found ${issues.zfight_pairs} pair(s) of surfaces that will flicker in the game: ${list}${issues.zfight_pairs > 10 ? ', …' : ''}. Never deliver z-fighting. Fix every pair: merge the parts or delete the hidden face, inset or extrude the detail into the surface, or move the layers at least the safe gap apart (${fmtGap(issues.zfight_rule?.gap, units)}, more for wide layers; check_scene with fix: true does that). Run check_scene to confirm none is left, then end with your reply as before (same format, with the <next> block).]`,
      },
      parent_tool_use_id: null,
    } as SDKUserMessage);
  }

  /** Fills in what the model is after a turn (size, joints, clips with speeds and markers) and reports the turn. */
  private async deliver(info: TurnInfo, state: TurnInfo['state'], renders: string[]) {
    const s = this.h.ws.summaryNow;
    const delivery: Delivery = {
      size: s?.bounds?.size ?? null,
      units: this.h.units().units,
      objects: s?.objects ?? 0,
      tris: s?.tris ?? 0,
      joints: s?.rig?.joints ?? 0,
      clips: (s?.rig?.clips ?? []).map((c) => ({ name: c.name, length: c.length, loop: c.loop, in_place: c.in_place, speed: c.speed, ...(c.turn ? { turn: c.turn } : {}), priority: c.priority, markers: [] })),
      renders,
    };
    if (s?.rig?.clips.length) {
      try {
        const r = await this.h.ws.rig();
        const full = (r.ok ? r.clips : null) as Array<{ name: string; markers?: Array<{ name: string; time: number }> }> | null;
        for (const c of delivery.clips) c.markers = (full?.find((x) => x.name === c.name)?.markers ?? []).map((m) => ({ name: m.name, time: m.time }));
      } catch {
        /* Blender is busy or restarting: the clips go without their markers */
      }
    }
    try {
      const parts = await this.h.ws.parts();
      if (parts.ok) {
        delivery.models = (parts.models as ModelFacts[]) ?? [];
        delivery.fit = (parts.fit as FitReport | null) ?? null;
      }
    } catch {
      /* Blender is busy or restarting: the facts go without the per-model part */
    }
    delivery.checks = checkSpec(info.spec, delivery);
    // Z-fighting is checked on every delivery, asked or not.
    if ((s?.objects ?? 0) > 0) {
      const z = await this.zfight();
      if (z) {
        const units = z.zfight_rule?.units ?? delivery.units;
        delivery.checks.push({ name: 'zfight', ok: !z.zfight_pairs, detail: z.zfight_pairs ? `${z.zfight_pairs} pair(s) of surfaces that flicker: ${z.zfight.slice(0, 6).map((x) => describeZFight(x, units)).join('; ')}` : `no overlapping surfaces closer than ${fmtGap(z.zfight_rule?.gap, units)}${z.zfight_truncated ? ' (part of a very large scene checked)' : ''}` });
      }
    }
    info.delivery = delivery;
    info.state = state;
    this.h.emit({ type: 'turn', turn: info });
  }

  private endTurn(error: string | null) {
    if (error) error = redact(error);
    const cur = this.current;
    const t = this.turn;
    let suggestions: Suggestion[] = [];
    if (cur) {
      for (const b of cur.blocks) {
        if (b.kind === 'tool' && b.status === 'running') {
          b.status = 'error';
          b.endedAt = Date.now();
          b.output = b.output ?? (this.interrupted ? 'Stopped.' : 'Did not finish.');
        }
        if (b.kind === 'thinking') b.done = true;
      }
      // The hidden trailer: project name and follow-up suggestions.
      for (let i = cur.blocks.length - 1; i >= 0; i--) {
        const b = cur.blocks[i]!;
        if (b.kind !== 'text') continue;
        const x = extractTrailer(b.text);
        b.text = x.text;
        suggestions = x.suggestions;
        if (x.title) this.h.onTitle(x.title);
        break;
      }
      if (error) cur.blocks.push({ kind: 'error', text: error });
      cur.done = true;
      this.h.emit({ type: 'message', message: cur });
      const text = cur.blocks.map((b) => (b.kind === 'text' ? b.text : '')).filter(Boolean).join('\n\n');
      const info = this.turns.get(cur.id);
      if (info) {
        const after = clipMap(this.h.ws.summaryNow);
        info.clips = [...after.entries()].filter(([n, fp]) => this.clipsBefore.get(n) !== fp).map(([n]) => n);
        info.reply = text;
        const renders = cur.blocks.flatMap((b) => (b.kind === 'tool' ? (b.images ?? (b.image ? [b.image] : [])) : []));
        // The turn counts as running for the app that asked until the facts of the result are in.
        void this.deliver(info, this.interrupted ? 'stopped' : error ? 'failed' : 'done', renders);
      }
      this.h.journal.assistant(text, { usage: cur.usage, error, suggestions: suggestions.map((x) => x.label), tools: t?.tools ?? 0, ms: Date.now() - (t?.started ?? cur.createdAt) });
    }
    if (t && !this.interrupted) {
      const ms = Date.now() - t.started;
      if (error) this.signal(`Turn ended with an error: ${error.slice(0, 300)}`, 3, ['turn-error']);
      if (t.toolErrors >= 3) this.signal(`${t.toolErrors} of ${t.tools} tool calls failed in one turn`, 2, ['tool-errors']);
      if (ms > 5 * 60_000) this.signal(`A turn took ${(ms / 60_000).toFixed(1)} minutes`, 1, ['slow-turn']);
    }
    this.suggestions = suggestions;
    this.h.emit({ type: 'suggestions', suggestions });
    // Stop means stop: what was waiting behind this turn is dropped with it.
    const next = this.interrupted ? undefined : this.queue.shift();
    if (this.interrupted) {
      for (const q of this.queue) {
        const info = this.turns.get(q.id);
        if (info) info.state = 'stopped';
      }
      this.queue = [];
    }
    this.current = null;
    this.turn = null;
    // A brief's API key was for its turn only: Kiln forgets it, and the session process that had it closes.
    if (t?.login.apiKey) {
      releaseSecret(t.login.apiKey);
      t.login.apiKey = undefined;
      if (this.queryLogin?.kind === 'api-key') this.closeQuery();
    }
    this.running = false;
    this.interrupted = false;
    this.lastTurnEnd = Date.now();
    this.h.emit({ type: 'running', running: false });
    this.h.onRunning(false);
    this.armIdle();
    this.save();
    if (next) {
      try {
        this.send(next.text, next.uploads, next.selected, next.view, next.from, { ...next.brief, presetId: next.id });
      } catch (e) {
        const info = this.turns.get(next.id);
        if (info) info.state = 'failed';
        logCore(`a queued message could not start: ${(e as Error).message}`);
      }
    }
  }
}

