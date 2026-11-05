// Kiln's one Claude login (0.9): how a turn's login is chosen from a brief's `account` field, and the environment
// Claude Code gets for it. No model calls, no real logins. Run: node scripts/test-login.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'kiln-login-'));
process.env.KILN_DATA_DIR = join(root, 'data');
process.env.KILN_PROJECTS_DIR = join(root, 'projects');
// A host session's own Claude variables must never reach a turn.
process.env.ANTHROPIC_API_KEY = 'sk-ant-host-session-key-0000000000';
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'host-session-token';
process.env.CLAUDE_CONFIG_DIR = join(root, 'host-config');
// A home of its own: this PC's real Claude login stays out of reach.
const HOME = join(root, 'home');
mkdirSync(HOME, { recursive: true });
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
const { LoginStatus, copySession, legacySessionHome, loginEnv, parseAccount, pcConfigDir, publicLogin, resolveLogin, sameLogin } = await import('../src/core/login.ts');
const { holdSecret, redact, releaseSecret } = await import('../src/core/secrets.ts');

let failed = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};
const hostless = (env: Record<string, string>) => env.CLAUDE_CODE_OAUTH_TOKEN === undefined && env.ANTHROPIC_API_KEY !== process.env.ANTHROPIC_API_KEY;

// No field (and messages typed in Kiln): this PC's own login.
let p = parseAccount(undefined);
check('no account field: nothing asked', p.account === null && !p.error);
let l = resolveLogin(p.account, 'Shuriken');
let env = loginEnv(l);
check('no field: this PC’s login', l.kind === 'pc' && l.configDir === null && l.home === pcConfigDir() && !l.problem, l.why);
check('no field: no CLAUDE_CONFIG_DIR, no API key, nothing of the host session', env.CLAUDE_CONFIG_DIR === undefined && env.ANTHROPIC_API_KEY === undefined && hostless(env));
l = resolveLogin(null, null);
check('typed in Kiln: this PC’s login, and it says so', l.kind === 'pc' && /typed in Kiln/.test(l.why), l.why);

// pc
p = parseAccount({ kind: 'pc' });
l = resolveLogin(p.account, 'Shuriken');
env = loginEnv(l);
check('pc: this PC’s login, because the brief asked', l.kind === 'pc' && /asked for this PC/.test(l.why) && env.CLAUDE_CONFIG_DIR === undefined && env.ANTHROPIC_API_KEY === undefined && hostless(env), l.why);

// folder
const folder = join(root, 'shuriken-login');
mkdirSync(folder, { recursive: true });
writeFileSync(join(folder, '.credentials.json'), '{}');
p = parseAccount({ kind: 'folder', dir: folder });
l = resolveLogin(p.account, 'Shuriken');
env = loginEnv(l);
check('folder: CLAUDE_CONFIG_DIR is the folder, no API key', l.kind === 'folder' && env.CLAUDE_CONFIG_DIR === folder && env.ANTHROPIC_API_KEY === undefined && hostless(env) && !l.problem, JSON.stringify(publicLogin(l)));
check('folder: sessions live in the folder; the label names it', l.home === folder && /Shuriken's login \(shuriken-login\)/.test(l.label), l.label);
check('folder: a relative path is refused', !!parseAccount({ kind: 'folder', dir: 'relative\\folder' }).error);
check('folder: no dir is refused', !!parseAccount({ kind: 'folder' }).error);
l = resolveLogin(parseAccount({ kind: 'folder', dir: join(root, 'missing') }).account, 'Shuriken');
check('folder: a missing folder is a problem before any call', /doesn't exist/.test(l.problem ?? ''), l.problem);
if (process.platform === 'win32') {
  const empty = join(root, 'empty-login');
  mkdirSync(empty);
  l = resolveLogin(parseAccount({ kind: 'folder', dir: empty }).account, 'Shuriken');
  check('folder: one with no login in it is a problem before any call', /no login in it/.test(l.problem ?? ''), l.problem);
}

// api-key
const KEY = 'sk-ant-api03-TEST-0123456789abcdefghijklmnop';
p = parseAccount({ kind: 'api-key', apiKey: KEY });
l = resolveLogin(p.account, 'Shuriken');
env = loginEnv(l);
check('api-key: ANTHROPIC_API_KEY is the brief’s key, no CLAUDE_CONFIG_DIR', l.kind === 'api-key' && env.ANTHROPIC_API_KEY === KEY && env.CLAUDE_CONFIG_DIR === undefined && env.CLAUDE_CODE_OAUTH_TOKEN === undefined);
check('api-key: what the chat, the API and the logs see has no key', !JSON.stringify(publicLogin(l)).includes(KEY) && !l.label.includes(KEY) && !l.why.includes(KEY), JSON.stringify(publicLogin(l)));
check('api-key: an empty key is refused', !!parseAccount({ kind: 'api-key', apiKey: '  ' }).error);
const bad = parseAccount({ kind: 'api-key', apiKey: `${KEY} with spaces` });
check('api-key: a refusal never repeats the key', !!bad.error && !bad.error.includes(KEY), bad.error);
check('an unknown kind is refused', !!parseAccount({ kind: 'oauth-token', email: 'someone@example.com' }).error);
check('a non-object is refused', !!parseAccount('pc').error);

// One session per login: another login reopens it.
const pc = resolveLogin(null, null);
check('same login: two turns on this PC’s login share a session', sameLogin(pc, resolveLogin({ kind: 'pc' }, 'Shuriken')));
check('another login: this PC’s and a folder don’t', !sameLogin(pc, resolveLogin({ kind: 'folder', dir: folder }, 'Shuriken')));
check('another login: two API keys don’t', !sameLogin(resolveLogin({ kind: 'api-key', apiKey: KEY }, 'S'), resolveLogin({ kind: 'api-key', apiKey: `${KEY}x` }, 'S')));

// A held key is redacted wherever Kiln writes; it is forgotten when its turn ends.
holdSecret('custom-secret-value-123');
check('a held key is redacted', redact('error: custom-secret-value-123 refused') === 'error: [API key] refused');
releaseSecret('custom-secret-value-123');
check('anything shaped like an Anthropic key is redacted too', !redact(`stderr: ${KEY}`).includes(KEY));

// A conversation goes along to another login folder.
const from = join(root, 'from');
mkdirSync(join(from, 'projects', 'C--proj'), { recursive: true });
writeFileSync(join(from, 'projects', 'C--proj', 'sess1.jsonl'), '{}\n');
check('a session is copied to another login folder', copySession('sess1', from, folder));
check('a missing session is not', !copySession('nope', from, folder));

// Conversations saved by Kiln 0.8 named an account id: they go on from that account's folder.
writeFileSync(join(root, 'data', 'accounts.json'), JSON.stringify({ accounts: [{ id: 'pc', dir: '' }, { id: 'acct1', dir: from }] }));
check('an old session on this PC’s login', legacySessionHome('pc') === pcConfigDir());
check('an old session on one of Kiln 0.8’s accounts', legacySessionHome('acct1') === from);
check('an unknown old account: none', legacySessionHome('acct-gone') === null);

// What Settings shows: this PC's login, the latest turn's login, usage from this PC's turns only.
const status = new LoginStatus();
check('no login file: signed out', status.state().pc.signedIn === false && status.state().pc.dir === pcConfigDir());
mkdirSync(pcConfigDir(), { recursive: true });
writeFileSync(join(pcConfigDir(), '.credentials.json'), '{}');
check('a login file: signed in until checked', status.state().pc.signedIn === true);
await status.check();
check('Claude Code finds no login in it: signed out after the check', status.state().pc.signedIn === false && status.state().pc.email === null, JSON.stringify(status.state().pc));
const keyed = resolveLogin({ kind: 'api-key', apiKey: KEY }, 'Shuriken');
status.noteTurn(keyed);
check('the latest turn’s login is shown, never its key', status.state().last?.kind === 'api-key' && !JSON.stringify(status.state()).includes(KEY), JSON.stringify(status.state().last));
status.recordUsage(keyed, { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5 });
check('usage on another login is not shown as this PC’s', Object.keys(status.state().pc.usage).length === 0);
status.recordUsage(resolveLogin(null), { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 85 });
check('usage on this PC’s login is', status.state().pc.usage.five_hour?.utilization === 0.85);

rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nall login cases passed');
process.exit(failed ? 1 : 0);
