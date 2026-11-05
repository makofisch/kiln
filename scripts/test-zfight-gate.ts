// The copilot's z-fighting gate, with a fake session (no Claude Code process, no model, no Blender):
// a turn that changed the scene and ends with z-fighting is sent back once to fix it, in the same turn; the next
// result ends the turn, and the delivery carries a "zfight" check. Run: node scripts/test-zfight-gate.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'kiln-gate-'));
process.env.KILN_DATA_DIR = join(root, 'data');
process.env.KILN_PROJECTS_DIR = join(root, 'projects');
const { Copilot } = await import('../src/core/copilot.ts');

let failed = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const issues = (n: number) => ({
  ok: true,
  zfight: Array.from({ length: n }, (_, i) => ({ a: 'Wall', b: `Sign${i}`, faces: 4, where: [0, 0, 0], inside: false, sep: 0.004, gap: 0.02, kind: 'layer' as const })),
  zfight_pairs: n,
  zfight_rule: { gap: 0.02, per_width: 0.004, cap: 0.1, flush: 0.002, units: 'studs' as const, roblox: true },
  floating: [],
});
let pairs = 2;
let checks = 0;
const ws = {
  version: 3,
  summaryNow: { objects: 2, tris: 24, bounds: { size: [10, 1, 10] }, rig: null, list: [] },
  state: () => ({ version: ws.version, fingerprint: `fp${ws.version}`, glb: null, summary: null, canUndo: true }),
  check: async () => {
    checks++;
    return issues(pairs);
  },
  parts: async () => ({ ok: false }),
  rig: async () => ({ ok: false }),
};
const events: Array<{ type: string }> = [];
const noop = new Proxy({}, { get: () => () => undefined });
const login = { kind: 'pc', configDir: null, home: join(root, 'claude'), label: "This PC's Claude login", why: 'test' };
const host = {
  projectId: 'gate-test',
  dir: join(root, 'projects'),
  ws,
  login: { noteTurn: () => undefined, recordUsage: () => undefined },
  journal: noop,
  settings: () => ({ effort: 'high', memory: false, subagents: false, research: false }),
  title: () => 'Gate test',
  needsTitle: () => false,
  units: () => ({ units: 'studs', linked: 'Shuriken Studio' }),
  roblox: () => ({ lighting: null }),
  emit: (e: { type: string }) => events.push(e),
  onTitle: () => undefined,
  onRunning: () => undefined,
  style: () => null,
  saveStyle: () => '',
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const c = new Copilot(host as any) as any;

// A turn as send() leaves it, minus the SDK session: the pushed messages are collected instead.
const pushed: Array<{ message: { content: string } }> = [];
const reply = { id: 'a1', role: 'assistant', blocks: [{ kind: 'text', text: ['Built the wall and the signs.', '<next>', 'More signs :: Add two more signs.', '</next>'].join('\n') }], createdAt: Date.now() };
c.messages.push({ id: 'u1', role: 'user', blocks: [{ kind: 'text', text: 'Make a wall with signs' }], createdAt: Date.now() }, reply);
c.current = reply;
c.running = true;
c.input = { push: (m: { message: { content: string } }) => pushed.push(m), close: () => undefined };
const turn0 = { login, zfightChecked: false, startVersion: 1, authHit: false, effort: 'high', started: Date.now(), tools: 3, toolErrors: 0, limitHit: false, retried: false, userText: 'Make a wall with signs', content: [], planned: false, interjections: 0 };
c.turn = { ...turn0 };
c.turns.set('a1', { projectId: 'gate-test', turnId: 'a1', state: 'running', reply: '', clips: [] });
const result = { type: 'result', subtype: 'success', is_error: false, result: 'done', modelUsage: {}, num_turns: 1, total_cost_usd: 0 };

c.handle(result);
await sleep(50);
check('a result with z-fighting left does not end the turn', c.running === true && c.current === reply);
check('the copilot is sent back once, in the same turn, with the pairs', pushed.length === 1 && /z-fighting check found 2 pair/.test(pushed[0]!.message.content) && /Wall \/ Sign0 \(0\.004 studs apart, needs 0\.020 studs\)/.test(pushed[0]!.message.content));
check('the chat shows a note', reply.blocks.some((b) => b.kind === 'note' && /flicker/.test((b as { text: string }).text)));
check('the first reply’s hidden follow-ups are taken out (no raw <next> in the chat)', !/<next>/.test((reply.blocks[0] as { text: string }).text) && /Built the wall/.test((reply.blocks[0] as { text: string }).text));

// The copilot fixed it: the scene changed again and the check is clean.
pairs = 0;
ws.version = 4;
c.handle(result);
await sleep(80);
check('the next result ends the turn (no second round)', c.running === false && pushed.length === 1);
const info = c.turns.get('a1');
const z = info?.delivery?.checks?.find((x: { name: string }) => x.name === 'zfight');
check('the delivery carries a passing zfight check', info?.state === 'done' && z?.ok === true, JSON.stringify(z));

// A turn that changed nothing ends at once, without a check.
const before = checks;
const reply2 = { id: 'a2', role: 'assistant', blocks: [], createdAt: Date.now() };
c.messages.push(reply2);
c.current = reply2;
c.running = true;
c.turn = { ...turn0, startVersion: ws.version };
c.handle(result);
await sleep(30);
check('a turn that did not change the scene ends at once, no check', c.running === false && checks === before);

// Z-fighting the copilot could not fix: the turn still ends after one round, and the delivery says it failed.
pairs = 1;
ws.version = 6;
const reply3 = { id: 'a3', role: 'assistant', blocks: [], createdAt: Date.now() };
c.messages.push(reply3);
c.current = reply3;
c.running = true;
c.turn = { ...turn0, startVersion: 5 };
c.turns.set('a3', { projectId: 'gate-test', turnId: 'a3', state: 'running', reply: '', clips: [] });
c.handle(result);
await sleep(30);
ws.version = 7;
c.handle(result);
await sleep(80);
const z3 = c.turns.get('a3')?.delivery?.checks?.find((x: { name: string }) => x.name === 'zfight');
check('left unfixed: the turn ends after one round and the zfight check fails', c.running === false && z3?.ok === false, JSON.stringify(z3));

c.dispose();
rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nall gate cases passed');
process.exit(failed ? 1 : 0);
