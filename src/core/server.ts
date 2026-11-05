import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { LoginStatus, parseAccount } from './login.ts';
import { BRIDGE, DATA_DIR, DEV, LOGS_DIR, PROJECTS_DIR, RENDERER_SRC, VERSION, VITE_CONFIG, WEB_DIR, findBlender } from './config.ts';
import type { Upload } from './copilot.ts';
import { killAllBlenders } from './blender.ts';
import { logCore, writeAtomic } from './fsx.ts';
import { BlenderPool } from './pool.ts';
import { helperReference } from './prompts.ts';
import { Projects } from './projects.ts';
import { acceptWebSocket, type Sink } from './ws.ts';
import { classify, watchdog } from './watchdog.ts';
import { importLegacy, importLegacySessions } from './legacy.ts';
import { MEMORY_FILE, facts, onMemoryChange, setFacts } from './memory.ts';
import { cleanLighting, describeLighting } from '../shared/roblox.ts';
import { gpuLoad } from './workspace.ts';
import { listStyles, readStyle, saveStyle, styleId } from './styles.ts';
import type { BriefSpec } from '../shared/types.ts';
import { ACCENTS, BRIEF_KINDS, DEFAULT_SETTINGS, EFFORTS, EFFORT_SETTINGS, GLOWS, isRoblox, type BriefKind, type EffortSetting, type Glow, type AppInfo, type Effort, type ImageUpload, type MemoryState, type ServerEvent, type Settings } from '../shared/types.ts';

// --- settings -----------------------------------------------------------------------------------
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

/** Applies a (partial) settings patch, keeping only valid values. */
function mergeSettings(base: Settings, patch: Record<string, unknown>): Settings {
  const out: Settings = { ...base, viewer: { ...base.viewer }, ui: { ...base.ui } };
  if (EFFORT_SETTINGS.includes(patch.effort as EffortSetting)) out.effort = patch.effort as EffortSetting;
  if (typeof patch.memory === 'boolean') out.memory = patch.memory;
  if (typeof patch.subagents === 'boolean') out.subagents = patch.subagents;
  if (typeof patch.research === 'boolean') out.research = patch.research;
  const v = (patch.viewer ?? {}) as Record<string, unknown>;
  if (v.lighting === 'auto' || v.lighting === 'studio') out.viewer.lighting = v.lighting;
  if (typeof v.exposure === 'number' && Number.isFinite(v.exposure)) out.viewer.exposure = Math.min(1.6, Math.max(0.5, v.exposure));
  if (typeof v.bloom === 'boolean') {
    out.viewer.bloom = v.bloom;
    // An older settings file with glow switched off.
    if (!v.bloom && v.glow === undefined) out.viewer.glow = 'off';
  }
  if (GLOWS.includes(v.glow as Glow)) {
    out.viewer.glow = v.glow as Glow;
    out.viewer.bloom = v.glow !== 'off';
  }
  if (typeof v.grid === 'boolean') out.viewer.grid = v.grid;
  const u = (patch.ui ?? {}) as Record<string, unknown>;
  if (ACCENTS.includes(u.accent as Settings['ui']['accent'])) out.ui.accent = u.accent as Settings['ui']['accent'];
  if (u.textSize === 'small' || u.textSize === 'normal' || u.textSize === 'large') out.ui.textSize = u.textSize;
  if (typeof u.reduceMotion === 'boolean') out.ui.reduceMotion = u.reduceMotion;
  if (typeof u.suggestions === 'boolean') out.ui.suggestions = u.suggestions;
  return out;
}

let settings: Settings = DEFAULT_SETTINGS;
try {
  settings = mergeSettings(DEFAULT_SETTINGS, JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Record<string, unknown>);
} catch {
  /* defaults */
}

const memoryState = (): MemoryState => ({ enabled: settings.memory, facts: facts(), file: MEMORY_FILE });

// --- core services --------------------------------------------------------------------------------
const appClients = new Set<Sink>();
/** App-level events go to every window: the tab strips and each project tab. */
function broadcast(e: ServerEvent) {
  const data = JSON.stringify(e);
  for (const c of appClients) c.send(data);
  projects.each((p) => p.emit(e));
}

/** This PC's Claude login, for Settings (each turn's login comes from its brief: see resolveLogin). */
const login = new LoginStatus();
let BLENDER = findBlender();
const pool = new BlenderPool(BLENDER, BRIDGE);
const projects = new Projects({ pool, login, settings: () => settings, broadcast });
login.onChange = (s) => broadcast({ type: 'login', login: s });
// The copilot saved something: show it in Settings. Running sessions pick it up when they restart.
onMemoryChange(() => broadcast({ type: 'memory', memory: memoryState() }));

// No Blender yet: keep looking, so installing one needs no restart. It counts once its folder has stopped growing
// (a blender.exe mid-install doesn't run yet).
if (!BLENDER) {
  let seen = '';
  const looking = setInterval(() => {
    try {
      const exe = findBlender();
      const now = exe ? `${exe}|${readdirSync(dirname(exe)).length}` : '';
      if (!exe || now !== seen) return void (seen = now);
      clearInterval(looking);
      BLENDER = exe;
      pool.found(exe);
      projects.each((p) => p.blenderFound(exe));
      broadcast({ type: 'app', app: appInfo() });
    } catch {
      /* a folder in the middle of changing: next time */
    }
  }, 5000);
  looking.unref();
}

function appInfo(): AppInfo {
  return { version: VERSION, settings, memory: memoryState(), blender: { path: BLENDER }, login: login.state(), projects: projects.list(), dataDir: DATA_DIR, projectsDir: PROJECTS_DIR };
}

// --- helpers --------------------------------------------------------------------------------------
/** A brief's requirements as data (POST chat `spec`): what is kept, the rest is dropped. */
function cleanSpec(raw: unknown): BriefSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: BriefSpec = {};
  const pos = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (pos(r.tris) && (r.tris as number) >= 10) out.tris = Math.round(Math.min(r.tris as number, 5_000_000));
  if (pos(r.tris_total) && (r.tris_total as number) >= 10) out.tris_total = Math.round(Math.min(r.tris_total as number, 20_000_000));
  if (Array.isArray(r.size) && r.size.length === 3 && r.size.some(pos)) out.size = r.size.map((v) => (pos(v) ? (v as number) : null));
  if (pos(r.height)) out.height = r.height as number;
  if (r.ground === true) out.ground = true;
  if (Array.isArray(r.sockets)) {
    const names = r.sockets.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim().replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40)).slice(0, 24);
    if (names.length) out.sockets = names;
  }
  if (Array.isArray(r.parts)) {
    const names = r.parts.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim().replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40)).slice(0, 40);
    if (names.length) out.parts = names;
  }
  return Object.keys(out).length ? out : null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.glb': 'model/gltf-binary',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 40 * 1024 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolveBody(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {});
      } catch {
        reject(Object.assign(new Error('The request body is not valid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendFile(res: ServerResponse, base: string, rel: string, extraHeaders: Record<string, string> = {}) {
  const file = resolve(base, normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(resolve(base) + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': statSync(file).size, ...extraHeaders });
  createReadStream(file).pipe(res);
}

let uploadCount = 0;
function saveUploads(dir: string, id: string, images: ImageUpload[] | undefined): Upload[] {
  const out: Upload[] = [];
  for (const img of (images ?? []).slice(0, 6)) {
    const m = /^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/.exec(img.dataUrl);
    if (!m) continue;
    const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
    const name = `upload-${Date.now().toString(36)}-${uploadCount++}.${ext}`;
    writeFileSync(join(dir, 'uploads', name), Buffer.from(m[3]!, 'base64'));
    out.push({ url: `/files/${id}/uploads/${name}`, mediaType: m[1]!, data: m[3]! });
  }
  return out;
}

/** Server-Sent Events, for other local apps (Kiln's own windows use the WebSocket: see ws.ts). */
function sse(res: ServerResponse, first: ServerEvent): Sink {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify(first)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  res.on('close', () => clearInterval(ping));
  return {
    send: (data) => void res.write(`data: ${data}\n\n`),
    close: () => res.end(),
    onClose: (fn) => void res.on('close', fn),
  };
}

/** Subscribes a connection to the app's events, or to one project's (which include the app's). */
function subscribe(sink: Sink, projectId: string | null): boolean {
  if (!projectId) {
    appClients.add(sink);
    sink.onClose(() => appClients.delete(sink));
    return true;
  }
  if (!projects.exists(projectId)) return false;
  const p = projects.get(projectId)!;
  sink.send(JSON.stringify({ type: 'state', state: p.state() } satisfies ServerEvent));
  projects.attach(p, sink);
  sink.onClose(() => projects.detach(p, sink));
  return true;
}

// --- auth -----------------------------------------------------------------------------------------
// Only Kiln's own windows (a SameSite=Strict cookie set through /auth) and local apps that read the
// token from runtime.json (Authorization: Bearer) may use the API. Other Host headers are refused, so
// web pages can't reach it through DNS rebinding.
const TOKEN = process.env.KILN_TOKEN || randomBytes(24).toString('hex');
// Blender and Claude Code are started from this process: they (and Python the model writes) don't get the API token.
delete process.env.KILN_TOKEN;
let port = 0;

/** A number from a request, kept inside a range (text, NaN or nothing gives the default). */
function num(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

// Another app using Kiln (Shuriken Studio): its API calls (bearer token) and the Kiln views it hosts
// (embed=…). While it does, the desktop app stays in the tray when its own windows close.
let externalAt = 0;
let embedViews = 0;
let externalWas = false;
let onExternal: (active: boolean) => void = () => {};
export function watchExternal(fn: (active: boolean) => void) {
  onExternal = fn;
  setInterval(checkExternal, 30_000).unref();
}
function checkExternal() {
  const active = embedViews > 0 || Date.now() - externalAt < 10 * 60_000;
  if (active !== externalWas) {
    externalWas = active;
    onExternal(active);
  }
}

function tokenOk(given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The call came from another local app with the token (not one of Kiln's own windows, which use the cookie). */
function viaBearer(req: IncomingMessage): boolean {
  return tokenOk(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]);
}

function authorized(req: IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (tokenOk(bearer)) {
    externalAt = Date.now();
    if (!externalWas) checkExternal();
    return true;
  }
  const cookie = /(?:^|;\s*)kiln=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  return tokenOk(cookie);
}

// --- routes ---------------------------------------------------------------------------------------
async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/auth') {
    if (!tokenOk(url.searchParams.get('t') ?? undefined)) return (res.writeHead(403).end('Forbidden'), true);
    const next = url.searchParams.get('next') ?? '/';
    res.writeHead(302, { 'set-cookie': `kiln=${TOKEN}; Path=/; HttpOnly; SameSite=Strict`, location: next.startsWith('/') && !next.startsWith('//') ? next : '/' });
    res.end();
    return true;
  }
  if (!authorized(req)) {
    res.writeHead(401).end('Kiln: unauthorized');
    return true;
  }
  if (method === 'POST' && !(req.headers['content-type'] ?? '').startsWith('application/json')) return (json(res, 415, { error: 'JSON only' }), true);

  // App level
  if (path === '/api/v1/events' && method === 'GET') {
    subscribe(sse(res, { type: 'app', app: appInfo() }), null);
    return true;
  }
  if (path === '/api/v1/app' && method === 'GET') return (json(res, 200, appInfo()), true);
  if (path === '/api/v1/projects' && method === 'GET') {
    // Every project, newest first, from the cached list (no folder walk): ?limit= (default 200, at most 5000), ?q= filters by title or id.
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit')) || 200));
    const all = projects.list(Infinity);
    const hits = q ? all.filter((p) => p.title.toLowerCase().includes(q) || p.id.includes(q)) : all;
    return (json(res, 200, { total: all.length, matched: hits.length, projects: hits.slice(0, limit) }), true);
  }
  if (path === '/api/v1/projects' && method === 'POST') {
    const body = await readBody(req);
    const linked = body.linked && typeof body.linked === 'object' ? (body.linked as { app?: unknown; model?: unknown; project?: unknown }) : null;
    const meta = projects.create(String(body.text ?? ''), {
      title: typeof body.title === 'string' ? body.title : undefined,
      units: body.units === 'studs' ? 'studs' : undefined,
      linked: linked ? { app: String(linked.app ?? 'app'), model: String(linked.model ?? ''), ...(linked.project ? { project: String(linked.project) } : {}) } : undefined,
      target: body.target === 'roblox' ? 'roblox' : body.target === null ? null : undefined,
      lighting: cleanLighting(body.lighting),
    });
    return (json(res, 200, meta), true);
  }
  if (path === '/api/v1/settings' && method === 'POST') {
    const body = await readBody(req);
    const before = settings;
    settings = mergeSettings(settings, body);
    writeAtomic(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    broadcast({ type: 'settings', settings });
    if (before.memory !== settings.memory) broadcast({ type: 'memory', memory: memoryState() });
    if (before.memory !== settings.memory || before.subagents !== settings.subagents || before.research !== settings.research) projects.each((p) => p.copilot.instructionsChanged());
    return (json(res, 200, settings), true);
  }
  if (path === '/api/v1/memory' && method === 'GET') return (json(res, 200, memoryState()), true);
  if (path === '/api/v1/memory' && method === 'POST') {
    // The whole list from Settings (edits, removals, additions): sessions restart with it.
    const body = await readBody(req);
    if (!Array.isArray(body.facts)) return (json(res, 400, { error: 'facts must be a list' }), true);
    setFacts(body.facts.map(String));
    projects.each((p) => p.copilot.instructionsChanged());
    return (json(res, 200, memoryState()), true);
  }
  if (path === '/api/v1/login' && method === 'GET') return (json(res, 200, login.state()), true);
  if (path === '/api/v1/login/check' && method === 'POST') {
    // Settings' "Check again": asks Claude Code who is signed in on this PC (no model call). Signing in itself
    // happens in Claude Code (claude /login), never inside Kiln.
    await login.check();
    return (json(res, 200, login.state()), true);
  }
  if (path === '/api/v1/helpers' && method === 'GET') {
    // The kiln helper library as the copilot knows it, for other apps (instead of probing signatures through /python).
    return (json(res, 200, { version: VERSION, text: helperReference() }), true);
  }
  if (path === '/api/v1/load' && method === 'GET') {
    // How busy Kiln is, for an app that paces its own queue of builds: turns running, and the GPU gate.
    const list = projects.list(1000);
    return (json(res, 200, { turns: list.filter((x) => x.working).length, open: list.filter((x) => x.open).length, gpu: gpuLoad() }), true);
  }
  if (path === '/api/v1/styles' && method === 'GET') return (json(res, 200, { styles: listStyles() }), true);
  const styleRoute = /^\/api\/v1\/styles\/([^/]+)$/.exec(path);
  if (styleRoute) {
    // A game's style sheet: the shared look its models follow (a brief names it with `style`).
    const sid = styleId(decodeURIComponent(styleRoute[1]!));
    if (!sid) return (json(res, 400, { error: 'A style id is letters, digits, dot, dash or underscore' }), true);
    if (method === 'GET') {
      const sheet = readStyle(sid);
      return (sheet ? json(res, 200, sheet) : json(res, 404, { error: 'No such style sheet yet: the first build that names it proposes one' }), true);
    }
    if (method === 'POST') {
      const body = await readBody(req);
      return (json(res, 200, saveStyle(sid, (body.sheet as Record<string, unknown>) ?? body)), true);
    }
  }
  if (path === '/api/v1/storage' && method === 'GET') return (json(res, 200, { dir: PROJECTS_DIR, projects: await projects.storage() }), true);
  if (path === '/api/v1/storage' && method === 'POST') {
    // Free space in closed projects: old undo steps, old viewer files, older Roblox bakes, week-old trash.
    const body = await readBody(req);
    const freed = projects.tidy(num(body.keep, 3, 1, 30));
    return (json(res, 200, { freed, projects: await projects.storage() }), true);
  }
  if (path === '/api/v1/feedback' && method === 'POST') {
    // /feedback typed in any chat: straight to the watchdog, no model call.
    const body = await readBody(req);
    const text = String(body.text ?? '').trim();
    if (!text) return (json(res, 400, { error: 'empty' }), true);
    const project = String(body.project ?? '');
    const p = project ? projects.peek(project) : undefined;
    const c = classify(text);
    watchdog.record({ kind: 'note', severity: c && c.kind !== 'praise' && c.kind !== 'wish' ? Math.max(2, c.severity) as 2 | 3 : 2, source: 'user', project: project || 'app', projectTitle: p?.meta.title ?? '', text, signals: c?.signals, context: p?.copilot.lastAssistantText.slice(0, 300), conversation: `${project || 'app'}.md` });
    p?.journal.event('feedback note', { text });
    return (json(res, 200, { ok: true }), true);
  }

  // Project level: /api/v1/projects/:id/...
  const pm = /^\/api\/v1\/projects\/([a-z0-9-]+)\/([a-z]+)(?:\/([A-Za-z0-9_.%-]+))?$/i.exec(path);
  if (pm) {
    const [, id, action, rawArg] = pm as unknown as [string, string, string, string | undefined];
    const arg = rawArg !== undefined ? decodeURIComponent(rawArg) : undefined;
    if (!projects.exists(id)) return (json(res, 404, { error: 'No such project' }), true);
    if (action === 'delete' && method === 'POST') {
      // To Documents\Kiln\.trash: recoverable for a week. Windows showing it go back to their start page;
      // `stop: true` stops a running copilot first (Kiln's own Delete always asks for that).
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      const r = await projects.trash(id, { stop: body.stop === true });
      return (json(res, r.ok ? 200 : 409, r), true);
    }
    if (action === 'close' && method === 'POST') return (json(res, 200, { closed: projects.closeIdle(id), open: projects.isOpen(id) }), true);
    if (action === 'events' && method === 'GET') {
      subscribe(sse(res, { type: 'app', app: appInfo() }), id);
      return true;
    }
    if (action === 'target' && method === 'POST') {
      // Where the model ends up ("roblox" or null) and the game's lighting. A closed project stays closed.
      const body = await readBody(req);
      const target = body.target === 'roblox' ? 'roblox' : body.target === null ? null : undefined;
      const lighting = body.lighting === null ? null : (cleanLighting(body.lighting) ?? undefined);
      const open = projects.peek(id);
      if (open) open.setTarget(target, lighting);
      else {
        const meta = projects.readMeta(id)!;
        projects.writeMeta({ ...meta, ...(target !== undefined ? { target } : {}), ...(lighting !== undefined ? { lighting } : {}), updatedAt: new Date().toISOString() }, !!(meta as { named?: boolean }).named);
        projects.changed();
      }
      const meta = projects.peek(id)?.meta ?? projects.readMeta(id)!;
      return (json(res, 200, { ...meta, roblox: isRoblox(meta), lightingSummary: isRoblox(meta) ? describeLighting(meta.lighting) : null }), true);
    }
    if (action === 'anim' && method === 'GET') {
      // For apps that poll (Shuriken's clip sync): the rig's clips from memory. A closed project stays
      // closed and no Blender call is made (GET /scene opens the project and rescans it).
      if (!projects.isOpen(id)) return (json(res, 200, { open: false }), true);
      const q = projects.get(id)!;
      const sum = q.ws.summaryNow;
      return (json(res, 200, { open: true, working: q.copilot.running, version: q.ws.version, anim: sum?.rig?.anim ?? null, clips: sum?.rig?.clips ?? [], current: sum?.rig?.current ?? null, clipsUrl: q.ws.state().clips ?? null }), true);
    }
    const p = projects.get(id)!;
    p.lastApi = Date.now();
    if (action === 'state' && method === 'GET') return (json(res, 200, p.state()), true);
    if (action === 'diagnose' && method === 'GET') return (json(res, 200, await p.copilot.diagnose()), true);
    if (action === 'lock' && method === 'POST') {
      const body = await readBody(req);
      p.setLock(String(body.by ?? 'Another app'), num(body.seconds, 90, 0, 600));
      return (json(res, 200, { lock: p.lock }), true);
    }
    if ((action === 'chat' || action === 'undo') && method === 'POST' && p.lock && req.headers.authorization === undefined) {
      // Kiln's own windows wait while another app builds the model; that app itself (bearer token) goes on.
      return (json(res, 409, { error: `${p.lock.by} is building this model right now. Try again when it's done.` }), true);
    }
    if (action === 'chat' && method === 'POST') {
      const body = (await readBody(req)) as { text?: string; images?: ImageUpload[]; selected?: string | null; view?: { camera?: number[]; target?: number[]; center?: string | null }; from?: string; kind?: string; effort?: string; mode?: string; spec?: unknown; style?: unknown; account?: unknown };
      const text = (body.text ?? '').trim();
      if (!text && !body.images?.length) return (json(res, 400, { error: 'Empty message' }), true);
      // `account`: the Claude login this turn runs on ({ kind: 'pc' | 'folder' | 'api-key', dir?, apiKey? }), taken only
      // from another app's bearer-authenticated call. An API key stays in memory for its turn (see secrets.ts).
      const acct: ReturnType<typeof parseAccount> = viaBearer(req) ? parseAccount(body.account) : { account: null };
      if (acct.error) return (json(res, 400, { error: acct.error }), true);
      if (p.blender.status === 'missing') return (json(res, 503, { error: p.blender.detail }), true);
      await p.ready;
      const from = typeof body.from === 'string' && body.from.trim() ? body.from.trim().slice(0, 80) : null;
      // A brief from another app: its kind sets the framing. The effort is the one it asks for, or (none, or
      // "auto") the one Kiln picks from the size of the job; never "low".
      const kind = from && BRIEF_KINDS.includes(body.kind as BriefKind) ? (body.kind as BriefKind) : null;
      const effort = from && EFFORTS.includes(body.effort as Effort) ? (body.effort as Effort) : null;
      const brief = { kind, effort, spec: cleanSpec(body.spec), quick: (body as { quick?: unknown }).quick === true, account: acct.account };
      // The game's style sheet this project follows from now on.
      const style = styleId(body.style);
      if (style && style !== p.meta.style) p.update({ style });
      const uploads = saveUploads(p.dir, id, body.images);
      const start = () => p.copilot.send(text || '(see image)', uploads, body.selected ?? null, viewNote(body.view), from, brief);
      // While a turn runs, a message is taken into it ("interject", the default), held for after it
      // ("queue"), or stops it and takes its place ("replace"). It is never refused.
      let mode: 'new' | 'interject' | 'queue' | 'replace' = 'new';
      let turnId: string;
      if (p.copilot.running) {
        const asked = body.mode === 'queue' || body.mode === 'replace' ? body.mode : 'interject';
        try {
          if (asked === 'interject') {
            turnId = p.copilot.interject(text || '(see image)', uploads, from);
            mode = 'interject';
          } else if (asked === 'queue') {
            turnId = p.copilot.enqueue(text || '(see image)', uploads, body.selected ?? null, viewNote(body.view), from, brief);
            mode = 'queue';
          } else {
            await p.copilot.stop();
            for (let i = 0; i < 100 && p.copilot.running; i++) await new Promise((r) => setTimeout(r, 200));
            if (p.copilot.running) return (json(res, 409, { error: 'The running turn did not stop in time. Try again.' }), true);
            turnId = start();
            mode = 'replace';
          }
        } catch {
          // The turn ended between the check and the call: an ordinary new turn, then.
          if (p.copilot.running) return (json(res, 409, { error: 'The copilot is still working' }), true);
          turnId = start();
        }
      } else turnId = start();
      const turn = p.copilot.turnInfo(turnId);
      return (json(res, 200, { ok: true, turnId, effort: turn?.effort ?? null, effortWhy: turn?.effortWhy ?? null, mode, account: turn?.account ?? null }), true);
    }
    if (action === 'parts' && method === 'GET') {
      // Each top-level model (origin, size, triangles, materials, sockets) and how the sockets fit.
      await p.ready;
      const r = await p.ws.parts();
      return (r.ok ? json(res, 200, { models: r.models, fit: r.fit ?? null }) : json(res, 500, { error: r.error }), true);
    }
    if (action === 'turns' && method === 'GET' && arg) {
      const t = p.copilot.turnInfo(arg);
      return (t ? json(res, 200, t) : json(res, 404, { error: 'No such turn' }), true);
    }
    if (action === 'rig' && method === 'GET') {
      await p.ready;
      const r = await p.ws.rig();
      return (r.ok ? json(res, 200, { info: r.info, clips: r.clips, check: r.check }) : json(res, 500, { error: r.error }), true);
    }
    if (action === 'clips' && method === 'GET') {
      await p.ready;
      const r = await p.ws.rig();
      return (r.ok ? json(res, 200, r.clips) : json(res, 500, { error: r.error }), true);
    }
    if (action === 'clips' && method === 'POST') {
      // The Animate panel (and other apps): make, change, check or remove clips without the copilot.
      const body = (await readBody(req)) as { action?: string; generator?: string; name?: string; params?: Record<string, unknown>; to?: string; settings?: Record<string, unknown> };
      await p.ready;
      const name = arg ?? (typeof body.name === 'string' ? body.name : '');
      if (body.action === 'check') {
        const r = await p.ws.animCheck(name);
        return (r.ok ? json(res, 200, r.report) : json(res, 400, { error: r.error }), true);
      }
      if (p.copilot.running) return (json(res, 409, { error: 'Wait for the copilot to finish, or stop it first' }), true);
      if (p.lock && req.headers.authorization === undefined) return (json(res, 409, { error: `${p.lock.by} is building this model right now.` }), true);
      const py = (v: unknown) => `json.loads(${JSON.stringify(JSON.stringify(v ?? null))})`;
      const gens = ['gait', 'idle', 'attack', 'hit', 'death'];
      let code: string;
      let note: string;
      switch (body.action) {
        case 'generate':
          if (!gens.includes(String(body.generator))) return (json(res, 400, { error: 'Unknown generator' }), true);
          code = `print(kiln.anim.${body.generator}(name=${py(name)}, **(${py(body.params ?? {})} or {})))\nkiln.anim.use(${py(name)})`;
          note = `the user made clip "${name}" with kiln.anim.${body.generator} in the Animate panel (params ${JSON.stringify(body.params ?? {})}).`;
          break;
        case 'regenerate':
          code = `print(kiln.anim.regenerate(${py(name)}, **(${py(body.params ?? {})} or {})))\nkiln.anim.use(${py(name)})`;
          note = `the user changed clip "${name}" in the Animate panel (regenerated with ${JSON.stringify(body.params ?? {})}).`;
          break;
        case 'settings':
          code = `print(kiln.anim.settings(${py(name)}, **(${py(body.settings ?? {})} or {})))`;
          note = `the user changed clip "${name}"'s settings in the Animate panel: ${JSON.stringify(body.settings ?? {})}.`;
          break;
        case 'rename':
          code = `print(kiln.anim.rename(${py(name)}, ${py(body.to)}))`;
          note = `the user renamed clip "${name}" to "${body.to}" in the Animate panel.`;
          break;
        case 'delete':
          code = `kiln.anim.delete(${py(name)})`;
          note = `the user deleted clip "${name}" in the Animate panel.`;
          break;
        case 'use':
          code = `kiln.anim.use(${py(name)})`;
          note = '';
          break;
        default:
          return (json(res, 400, { error: 'Unknown action' }), true);
      }
      const r = await p.ws.exec(`import json\n${code}`, 120_000);
      if (r.ok && note) p.copilot.note(note);
      return (json(res, r.ok ? 200 : 400, { ok: r.ok, error: r.error, output: r.output.trim().slice(0, 2000), version: r.version }), true);
    }
    if (action === 'stop' && method === 'POST') return (await p.copilot.stop(), json(res, 200, { ok: true }), true);
    if (action === 'undo' && method === 'POST') {
      if (p.copilot.running) return (json(res, 409, { error: 'Wait for the copilot to finish, or stop it first' }), true);
      await p.ready;
      const recent = p.copilot.msSinceTurn < 5 * 60_000;
      const ok = await p.ws.undo();
      if (ok) {
        p.copilot.note(`the user pressed Undo: the scene went back to version ${p.ws.version}. Your last change is gone; check scene_info before building on it.`);
        p.journal.event('undo', { text: `back to version ${p.ws.version}` });
        if (recent) p.copilot.signal('Undo pressed right after the copilot changed the scene', 2, ['undo-after-turn']);
      }
      return (json(res, 200, { ok }), true);
    }
    if (action === 'rename' && method === 'POST') {
      const body = await readBody(req);
      p.rename(String(body.title ?? ''));
      return (json(res, 200, p.meta), true);
    }
    if (action === 'rate' && method === 'POST') {
      const body = await readBody(req);
      p.copilot.rate(String(body.message), body.rating === 'down' ? 'down' : 'up', String(body.note ?? '').slice(0, 1000));
      return (json(res, 200, { ok: true }), true);
    }
    if (action === 'thumb' && method === 'POST') {
      const body = await readBody(req, 4 * 1024 * 1024);
      const m = /^data:image\/jpeg;base64,(.+)$/.exec(String(body.dataUrl ?? ''));
      if (m) {
        writeFileSync(join(p.dir, 'thumb.jpg'), Buffer.from(m[1]!, 'base64'));
        p.update({ thumb: `/files/${id}/thumb.jpg?v=${Date.now()}` });
      }
      return (json(res, 200, { ok: !!m }), true);
    }
    if (action === 'export' && method === 'GET' && arg && ['glb', 'fbx', 'obj', 'stl', 'blend'].includes(arg)) {
      await p.ready;
      const file = await p.ws.exportFile(arg as 'glb');
      if (!file) return (json(res, 500, { error: 'Export failed' }), true);
      const name = `${p.meta.title.replace(/[^\w -]/g, '').trim() || 'kiln-scene'}.${arg}`;
      sendFile(res, join(p.dir, 'exports'), `kiln-scene.${arg}`, { 'content-disposition': `attachment; filename="${name}"` });
      return true;
    }
    // For other local apps (a future Shuriken link): run Python / read the scene directly.
    if (action === 'python' && method === 'POST') {
      const body = await readBody(req);
      await p.ready;
      const code = String(body.code ?? '');
      const r = await p.ws.exec(code, num(body.timeout_s, 120, 5, 600) * 1000, body.undo_on_error === true);
      p.journal.event('python via API', { text: `${code.slice(0, 200)}${code.length > 200 ? ` … (${code.length} chars)` : ''} → ${r.ok ? 'ok' : `failed: ${(r.error ?? '').slice(0, 200)}`}, ${r.ms} ms${r.changed ? `, version ${r.version}` : ''}` });
      return (json(res, 200, r), true);
    }
    if (action === 'scene' && method === 'GET') {
      await p.ready;
      const r = await p.ws.scene();
      return (json(res, r.ok ? 200 : 500, r), true);
    }
    // More for other local apps (Shuriken Studio models in Kiln projects): see docs/INTEGRATION.md.
    if (action === 'render' && method === 'POST') {
      const body = await readBody(req);
      await p.ready;
      const r = await p.ws.render({
        views: Array.isArray(body.views) ? body.views.map(String) : undefined,
        quality: body.quality === 'pretty' ? 'pretty' : 'fast',
        size: typeof body.size === 'number' ? body.size : undefined,
        focus: Array.isArray(body.focus) ? body.focus.map(String) : undefined,
        isolate: body.isolate === true,
        frames: Array.isArray(body.frames) ? body.frames.map(Number) : undefined,
        figure: !!body.figure,
        figureHeight: typeof body.figure_height === 'number' ? body.figure_height : p.meta.units === 'studs' ? 5.2 : undefined,
        // Pretty renders of a Roblox project are lit like the game unless the caller asks for the scene's own lights.
        lighting: body.lighting === 'scene' ? 'scene' : body.lighting === 'roblox' || isRoblox(p.meta) ? 'roblox' : 'scene',
        robloxLighting: p.meta.lighting ?? null,
      });
      return (json(res, r.ok ? 200 : 500, r), true);
    }
    if (action === 'roblox' && method === 'GET') {
      // What Roblox would lose (materials, budgets), the game's lighting, and the last baked export.
      await p.ready;
      const check = await p.ws.robloxCheck(p.meta.lighting ?? null);
      const last = p.ws.robloxLast();
      return (json(res, 200, { target: isRoblox(p.meta) ? 'roblox' : null, lighting: p.meta.lighting ?? null, lightingSummary: describeLighting(p.meta.lighting), check, export: last?.manifest ?? null, current: last?.current ?? false, version: p.ws.version }), true);
    }
    if (action === 'roblox' && method === 'POST') {
      // The Roblox copy of the scene: one-colour materials plain (the default), the rest baked into one image atlas each.
      const body = await readBody(req);
      if (p.copilot.running) return (json(res, 409, { error: 'The copilot is working on this project: export when it is done' }), true);
      await p.ready;
      const r = await p.ws.robloxExport({
        units: p.meta.units ?? 'm',
        maxSize: typeof body.max_size === 'number' ? body.max_size : undefined,
        density: typeof body.density === 'number' ? body.density : undefined,
        ao: body.ao !== false,
        plain: body.plain !== false,
        force: !!body.force,
      });
      p.journal.event('roblox export', { text: r.ok ? `${r.manifest!.materials.length} materials, ${r.manifest!.seconds}s${r.cached ? ' (already made)' : ''}` : `failed: ${r.error}` });
      return (json(res, r.ok ? 200 : 500, r), true);
    }
    if (action === 'check' && method === 'POST') {
      const body = await readBody(req);
      await p.ready;
      return (json(res, 200, await p.ws.check(!!body.fix)), true);
    }
    if (action === 'import' && method === 'POST') {
      const body = await readBody(req);
      if (p.copilot.running) return (json(res, 409, { error: 'The copilot is working on this project' }), true);
      await p.ready;
      const r = await p.ws.importBlend(String(body.path ?? ''));
      return (json(res, r.ok ? 200 : 500, r), true);
    }
    if (action === 'ext' && method === 'POST') {
      const body = await readBody(req);
      await p.ready;
      const r = await p.ws.ext(String(body.dir ?? ''), String(body.module ?? ''), String(body.func ?? 'run'), (body.args as Record<string, unknown>) ?? {}, num(body.timeout_s, 120, 5, 600) * 1000);
      return (json(res, r.ok ? 200 : 500, r), true);
    }
    if (action === 'file' && method === 'GET') {
      // Where this project's scene lives (another local app copies it into its own project).
      return (json(res, 200, { scene: p.ws.sceneFile, version: p.ws.version }), true);
    }
    return (json(res, 404, { error: 'Unknown project action' }), true);
  }

  const f = /^\/files\/([a-z0-9-]+)\/(glb\/|renders\/|uploads\/|anim\/)?([^/]+)$/i.exec(path);
  if (f && method === 'GET') {
    const [, id, sub, file] = f as unknown as [string, string, string | undefined, string];
    if (!projects.exists(id)) return (res.writeHead(404).end(), true);
    if (!sub && file !== 'thumb.jpg') return (res.writeHead(404).end(), true);
    sendFile(res, join(PROJECTS_DIR, id, sub ?? ''), decodeURIComponent(file), { 'cache-control': sub ? 'public, max-age=31536000, immutable' : 'no-cache' });
    return true;
  }
  return false;
}

/** Where the user is looking, in Blender coordinates, as a line for the copilot. */
function viewNote(v?: { camera?: number[]; target?: number[]; center?: string | null }): string | null {
  const ok = (a?: number[]) => Array.isArray(a) && a.length === 3 && a.every((n) => Number.isFinite(n));
  if (!v || !ok(v.camera) || !ok(v.target)) return null;
  const f = (a: number[]) => `(${a.map((n) => n.toFixed(2)).join(', ')})`;
  const center = typeof v.center === 'string' && v.center ? `, with "${v.center.slice(0, 80)}" in the middle of the view` : '';
  return `the user's viewer camera is at ${f(v.camera!)} looking at ${f(v.target!)}${center} (Blender coordinates, meters, Z up).`;
}

// --- server ---------------------------------------------------------------------------------------
type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

export async function startServer(): Promise<{ server: Server; port: number; token: string; imported: string | null; stop: () => void }> {
  const server = createServer();
  let vite: Middleware | null = null;
  if (DEV) {
    const { createServer: createVite } = await import('vite');
    const v = await createVite({ configFile: VITE_CONFIG, root: RENDERER_SRC, server: { middlewareMode: true, hmr: { server } }, appType: 'mpa' });
    vite = v.middlewares as unknown as Middleware;
  }
  // Live updates for Kiln's windows: ws://…/api/v1/ws[?project=<id>]. Other upgrades (Vite's HMR in
  // development) are left to their own handlers.
  server.on('upgrade', (req, socket) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/api/v1/ws') {
      // Development leaves other upgrades to Vite's hot reload; a built app has nothing else to offer.
      if (!DEV) socket.destroy();
      return;
    }
    if (!authorized(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    const sink = acceptWebSocket(req, socket);
    if (!sink) return;
    if (url.searchParams.get('embed')) {
      embedViews++;
      checkExternal();
      sink.onClose(() => {
        embedViews--;
        checkExternal();
      });
    }
    try {
      sink.send(JSON.stringify({ type: 'app', app: appInfo() } satisfies ServerEvent));
      if (!subscribe(sink, url.searchParams.get('project'))) sink.close();
    } catch (e) {
      logCore(`live connection failed: ${(e as Error).message}`);
      sink.close();
    }
  });
  server.on('request', (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    route(req, res, url)
      .then((handled) => {
        if (handled) return;
        if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'No such endpoint' });
        if (vite) return vite(req, res, () => res.writeHead(404).end());
        const rel = url.pathname === '/' ? 'index.html' : url.pathname;
        if (existsSync(join(WEB_DIR, rel)) && statSync(join(WEB_DIR, rel)).isFile()) return sendFile(res, WEB_DIR, rel, rel.startsWith('/assets/') ? { 'cache-control': 'public, max-age=31536000, immutable' } : {});
        return sendFile(res, WEB_DIR, 'index.html');
      })
      .catch((e: Error & { status?: number }) => {
        if (!e.status) logCore(`${req.method} ${url.pathname} failed: ${e.stack ?? e.message}`);
        if (!res.headersSent) json(res, e.status ?? 500, { error: e.message });
        else res.end();
      });
  });
  const wanted = Number(process.env.KILN_PORT ?? 0);
  await new Promise<void>((ok) => server.listen(wanted, '127.0.0.1', ok));
  port = (server.address() as { port: number }).port;
  // How other local apps (e.g. Shuriken Studio) find Kiln: see docs/INTEGRATION.md.
  writeAtomic(join(DATA_DIR, 'runtime.json'), JSON.stringify({ app: 'kiln', version: VERSION, port, token: TOKEN, pid: process.pid, api: `http://127.0.0.1:${port}/api/v1`, exe: process.env.KILN_EXE || null, embed: `http://127.0.0.1:${port}/auth?t=${TOKEN}&next=/?embed=app`, startedAt: new Date().toISOString() }, null, 2));
  pool.warm();
  // Who is signed in on this PC (no model call), and again whenever its login file changes.
  setTimeout(() => void login.check(), 4000).unref();
  login.watch();
  // Space left behind by projects nobody has touched for a few days (they keep their last five undo steps).
  setTimeout(() => {
    try {
      const freed = projects.tidy(5, 3);
      if (freed > 50e6) logCore(`tidied ${(freed / 1e6).toFixed(0)} MB from idle projects`);
    } catch (e) {
      logCore(`tidy failed: ${(e as Error).message}`);
    }
  }, 20_000).unref();
  let imported: string | null = null;
  try {
    imported = importLegacy(projects);
  } catch (e) {
    console.error(`Importing the Kiln 0.1 workspace failed: ${(e as Error).message}`);
  }
  // Older conversations (Kiln 0.1 sessions) into the logs, in the background: never slows startup.
  setTimeout(() => {
    try {
      const n = importLegacySessions();
      if (n) console.log(`Imported ${n} Kiln 0.1 conversation(s) into the logs`);
    } catch (e) {
      console.error(`Importing Kiln 0.1 conversations failed: ${(e as Error).message}`);
    }
  }, 2500).unref();
  return {
    server,
    port,
    token: TOKEN,
    imported,
    stop: () => {
      projects.closeAll();
      pool.stop();
      killAllBlenders();
      // Nothing answers on this port any more: other apps must not find a stale address.
      rmSync(join(DATA_DIR, 'runtime.json'), { force: true });
    },
  };
}

export { LOGS_DIR };
