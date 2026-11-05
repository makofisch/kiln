// End-to-end smoke test of a dev core on throwaway data: deleting projects (closed, open in a window, opened through
// the API), the brief's `account` field (one Claude login: this PC's, a login folder, an API key), and the z-fighting
// check through the bridge. The core gets a home of its own, so this PC's real Claude login is out of its reach and no
// model call can be made: turns end at once ("not signed in", a missing folder, a fake API key Claude refuses).
// Run: node scripts/smoke-core.mjs   (KILN_BLENDER=<blender.exe> when Blender isn't under Desktop\Blender)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'kiln-smoke-'));
const DATA = join(root, 'data');
const PROJECTS = join(root, 'projects');
const HOME = join(root, 'home');
for (const d of [DATA, PROJECTS, HOME]) mkdirSync(d, { recursive: true });

/** The newest blender.exe under Desktop\Blender (the core can't look there: its home is a temp folder). */
function blender() {
  if (process.env.KILN_BLENDER) return process.env.KILN_BLENDER;
  const dir = join(homedir(), 'Desktop', 'Blender');
  const found = existsSync(dir) ? readdirSync(dir).map((d) => join(dir, d, 'blender.exe')).filter((f) => existsSync(f)) : [];
  return found.sort().at(-1) ?? '';
}

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const token = 'smoke-test-token-0123456789abcdef';
// A made-up key in the shape of a real one: Claude refuses it, and it must never reach the disk or the logs.
const FAKE_KEY = `sk-ant-api03-SMOKE${'x'.repeat(24)}${Date.now().toString(36)}AA`;
const core = spawn(process.execPath, [join(repo, 'src', 'core', 'entry.ts')], {
  cwd: repo,
  // A home of its own: the PC's real Claude login (~/.claude) is out of reach, so nothing can make a model call.
  env: { ...process.env, USERPROFILE: HOME, HOME, KILN_BLENDER: blender(), KILN_DATA_DIR: DATA, KILN_PROJECTS_DIR: PROJECTS, KILN_TOKEN: token, KILN_PORT: '0', KILN_NO_WARM: '1', KILN_LEGACY_WORKSPACE: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let log = '';
core.stdout.on('data', (d) => (log += d));
core.stderr.on('data', (d) => (log += d));

let port = 0;
for (let i = 0; i < 100 && !port; i++) {
  await sleep(200);
  try {
    port = JSON.parse(readFileSync(join(DATA, 'runtime.json'), 'utf8')).port;
  } catch {
    /* not yet */
  }
}
if (!port) {
  console.log(log);
  throw new Error('the core did not start');
}
const base = `http://127.0.0.1:${port}/api/v1`;
const auth = { authorization: `Bearer ${token}` };
const api = async (method, path, body, headers = auth) => {
  const r = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
/** Waits for a turn to end (and its delivery to be filled in). */
const settle = async (project, turnId, ms = 90_000) => {
  let turn = null;
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
    turn = (await api('GET', `/projects/${project}/turns/${turnId}`)).body;
    if (turn?.state && turn.state !== 'running' && turn.state !== 'queued' && turn.delivery) break;
    await sleep(300);
  }
  return turn;
};
const lastError = async (project) =>
  ((await api('GET', `/projects/${project}/state`)).body.messages.at(-1)?.blocks ?? [])
    .filter((b) => b.kind === 'error')
    .map((b) => b.text)
    .join('\n');

/** Every file under a folder that contains the text. */
function filesWith(dir, text) {
  const hits = [];
  const walk = (d) => {
    let names = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const f = join(d, n);
      let s;
      try {
        s = statSync(f);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(f);
      else if (s.size < 64 * 1024 * 1024) {
        try {
          if (readFileSync(f).includes(text)) hits.push(f);
        } catch {
          /* locked */
        }
      }
    }
  };
  walk(dir);
  return hits;
}

try {
  const app = await api('GET', '/app');
  check('GET /app answers with one login and no account list', app.status === 200 && !!app.body.login?.pc && app.body.accounts === undefined, JSON.stringify(app.body.login));
  check("this PC's login shows as signed out (the core's home has none)", app.body.login?.pc?.signedIn === false);
  const accountsGone = await api('POST', '/accounts/add', {});
  check('the old account endpoints are gone', accountsGone.status === 404, `${accountsGone.status}`);

  const make = async (title) => (await api('POST', '/projects', { title, units: 'studs', target: 'roblox' })).body.id;
  const [A, B, C, D] = [await make('Smoke Window'), await make('Smoke Api'), await make('Smoke Closed'), await make('Smoke Zfight')];
  check('four projects made', !!(A && B && C && D));

  // A: open in a "window" (the live connection Kiln's tabs use), then deleted.
  const events = [];
  let closed = false;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?project=${A}`, { headers: auth });
  ws.onmessage = (m) => events.push(JSON.parse(m.data).type);
  ws.onclose = () => (closed = true);
  for (let i = 0; i < 50 && !events.includes('state'); i++) await sleep(100);
  check('A is open in a window', events.includes('state'));
  let r = await api('POST', `/projects/${A}/delete`, { stop: true });
  for (let i = 0; i < 30 && !closed; i++) await sleep(100);
  check('A deletes while a window shows it', r.status === 200 && r.body.ok, JSON.stringify(r.body));
  check('the window was told (deleted event) and its connection closed', events.includes('deleted') && closed, events.join(','));

  // B: opened through the API (its Blender running), then deleted.
  r = await api('GET', `/projects/${B}/state`);
  check('B opened through the API', r.status === 200);
  for (let i = 0; i < 120; i++) {
    const s = await api('GET', `/projects/${B}/state`);
    if (s.body?.blender?.status === 'ready') break;
    await sleep(500);
  }
  r = await api('POST', `/projects/${B}/delete`, {});
  check('B deletes while open through the API (Blender running)', r.status === 200 && r.body.ok, JSON.stringify(r.body));

  r = await api('POST', `/projects/${C}/delete`, {});
  check('C (closed) deletes', r.status === 200 && r.body.ok);
  r = await api('POST', `/projects/${C}/delete`, {});
  check('deleting it again: 404', r.status === 404);

  const trash = readdirSync(join(PROJECTS, '.trash'));
  check('A, B and C are in the trash folder', [A, B, C].every((id) => trash.some((t) => t.startsWith(`${id}-`))) && ![A, B, C].some((id) => existsSync(join(PROJECTS, id))), trash.join(', '));
  const list = await api('GET', '/projects');
  check('GET /projects lists only D', list.body.total === 1 && list.body.projects[0]?.id === D, `${list.body.total}`);

  // D: z-fighting through the bridge (studs, Roblox).
  r = await api('POST', `/projects/${D}/python`, {
    code: [
      'import bmesh',
      'def box(n, s, l):',
      '    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)',
      '    for v in bm.verts: v.co.x *= s[0]; v.co.y *= s[1]; v.co.z *= s[2]',
      '    me = bpy.data.meshes.new(n); bm.to_mesh(me); bm.free()',
      '    o = bpy.data.objects.new(n, me); o.location = l; bpy.context.scene.collection.objects.link(o); return o',
      'box("Wall", (10, 1, 10), (0, 0, 5))',
      'box("Sign", (3, 0.2, 2), (0, -0.5 + 0.1 - 0.006, 5))',
      'print(kiln.zfight_rule())',
      'print(kiln.game_ready())',
    ].join('\n'),
  });
  check('python ran; its automatic check reports the sign', r.status === 200 && r.body.ok && r.body.issues?.zfight_pairs === 1, `${r.body?.error ?? ''} ${JSON.stringify(r.body?.issues?.zfight?.[0] ?? null)}`);
  check('the project’s rule is the Roblox one in studs (0.02)', /0\.02, 0\.004, 0\.1/.test(r.body.output ?? ''), (r.body.output ?? '').split('\n')[0]);
  check('kiln.game_ready lists the z-fighting', /Z-FIGHTING/.test(r.body.output ?? ''));
  r = await api('POST', `/projects/${D}/check`, { fix: true });
  check('check with fix: true leaves none', r.status === 200 && r.body.zfight_pairs === 0 && r.body.moved?.length === 1, JSON.stringify(r.body.moved));

  // The brief's `account` field: one login per turn, never a list, never switching.
  r = await api('POST', `/projects/${D}/chat`, { text: 'Add a door.', from: 'Shuriken', account: { kind: 'bogus' } });
  check('an account of an unknown kind is refused (400)', r.status === 400 && /account\.kind/.test(r.body?.error ?? ''), JSON.stringify(r.body));
  r = await api('POST', `/projects/${D}/chat`, { text: 'Add a door.', from: 'Shuriken', account: { kind: 'api-key' } });
  check('an api-key account without a key is refused (400)', r.status === 400 && /apiKey/.test(r.body?.error ?? ''), JSON.stringify(r.body));

  const missing = join(root, 'no-such-login');
  r = await api('POST', `/projects/${D}/chat`, { text: 'Add a door.', from: 'Shuriken', kind: 'fix', account: { kind: 'folder', dir: missing } });
  check('a brief naming a login folder runs on it and says why', r.status === 200 && r.body.account?.kind === 'folder' && r.body.account?.dir === missing && /login folder/.test(r.body.account?.why ?? ''), JSON.stringify(r.body.account));
  let turn = await settle(D, r.body.turnId);
  check('a missing login folder fails the turn at once (no model call)', turn?.state === 'failed', `${turn?.state}`);
  check('the chat says the folder does not exist', /doesn't exist/.test(await lastError(D)), (await lastError(D)).slice(0, 160));

  r = await api('POST', `/projects/${D}/chat`, { text: 'Add a window.', from: 'Shuriken', kind: 'fix' });
  check('a brief without an account runs on this PC’s login', r.status === 200 && r.body.account?.kind === 'pc' && /no login/.test(r.body.account?.why ?? ''), JSON.stringify(r.body.account));
  turn = await settle(D, r.body.turnId);
  const pcErr = await lastError(D);
  check('not signed in on this PC: the turn fails and says to run claude /login', turn?.state === 'failed' && /claude \/login/.test(pcErr), `${turn?.state}: ${pcErr.slice(0, 200)}`);

  r = await api('POST', `/projects/${D}/chat`, { text: 'Add a chimney.', from: 'Shuriken', kind: 'fix', account: { kind: 'api-key', apiKey: FAKE_KEY } });
  check('a brief with an API key runs on it; the reply never carries the key', r.status === 200 && r.body.account?.kind === 'api-key' && !JSON.stringify(r.body).includes(FAKE_KEY), JSON.stringify(r.body.account));
  turn = await settle(D, r.body.turnId, 120_000);
  const keyErr = await lastError(D);
  check('Claude refuses the made-up key: the turn fails and says to check it', turn?.state === 'failed' && /API key/.test(keyErr), `${turn?.state}: ${keyErr.slice(0, 240)}`);
  check('GET turns/:id never carries the key', !JSON.stringify(turn).includes(FAKE_KEY));

  // Kiln's own windows (cookie, no bearer token) can't pick a login: the field is ignored there.
  const signIn = await fetch(`http://127.0.0.1:${port}/auth?t=${token}&next=/`, { redirect: 'manual' });
  const cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0];
  r = await api('POST', `/projects/${D}/chat`, { text: 'Make it red.', account: { kind: 'bogus' } }, { cookie });
  check('a message from a Kiln window ignores `account` and runs on this PC’s login', r.status === 200 && r.body.account?.kind === 'pc' && /typed in Kiln/.test(r.body.account?.why ?? ''), JSON.stringify(r.body));
  await settle(D, r.body.turnId);

  const t0 = Date.now();
  const storage = await api('GET', '/storage');
  check('GET /storage answers with sizes', storage.status === 200 && storage.body.projects.length === 1 && storage.body.projects[0].bytes > 0, `${Date.now() - t0} ms`);

  // The key was only ever in memory: not in Kiln's data (logs, conversations, chat.json), the projects, or the home
  // Claude Code ran in.
  await sleep(2000);
  const leaks = filesWith(root, FAKE_KEY);
  check('the API key is written nowhere on disk', leaks.length === 0, leaks.join(', '));
  check("the API key is not in the core's output", !log.includes(FAKE_KEY));
  const convo = readdirSync(join(DATA, 'logs', 'conversations')).find((f) => f.endsWith('.jsonl') && f.startsWith(D));
  const jsonl = convo ? readFileSync(join(DATA, 'logs', 'conversations', convo), 'utf8') : '';
  check('the conversation log records the API-key brief by its label only', /Shuriken's API key/.test(jsonl) && !jsonl.includes('apiKey'), convo ?? 'no log');
} finally {
  core.kill();
  await sleep(1500);
  rmSync(root, { recursive: true, force: true });
  if (failed) console.log(`\n--- core log ---\n${log.slice(-3000)}`);
}
console.log(failed ? `\n${failed} FAILED` : '\nall smoke checks passed');
process.exit(failed ? 1 : 0);
