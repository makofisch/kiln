import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_EXE, DATA_DIR } from './config.ts';
import { writeAtomic } from './fsx.ts';
import type { AccountRequest, LoginState, TurnLogin, UsageWindow } from '../shared/types.ts';

// Kiln has one Claude login, and by default it is Shuriken's: a brief from Shuriken may say which login its turn
// runs on (POST chat `account`), and everything else runs on this PC's own Claude Code login. Kiln keeps no list
// of accounts, never switches between them and has no sign-in of its own: people sign in with Claude Code itself
// (`claude /login`). See "Claude login" in docs/INTEGRATION.md.

const require = createRequire(import.meta.url);
const FILE = join(DATA_DIR, 'login.json');

/** The environment for Claude Code: the chosen login, none of a host session's Claude variables. */
export function cleanEnv(configDir?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(CLAUDE|ANTHROPIC|MCP_|OTEL_)/i.test(k)) continue;
    env[k] = v;
  }
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'kiln';
  return env;
}

/** Claude Code shipped with the Agent SDK (outside app.asar when packaged). */
export function claudeExecutable(): string | null {
  if (CLAUDE_EXE && existsSync(CLAUDE_EXE)) return CLAUDE_EXE;
  try {
    const dir = dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`));
    const exe = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    const unpacked = exe.replace(`app.asar${process.platform === 'win32' ? '\\' : '/'}`, `app.asar.unpacked${process.platform === 'win32' ? '\\' : '/'}`);
    if (existsSync(unpacked)) return unpacked;
    return existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

/** Claude Code's folder for this PC's own login (its default, used when CLAUDE_CONFIG_DIR is not set). */
export const pcConfigDir = () => join(homedir(), '.claude');
const credentials = (dir: string) => join(dir, '.credentials.json');
const hasLogin = (dir: string) => existsSync(credentials(dir));

/** The login a turn runs on: what the chat and the API show (TurnLogin), plus what running it takes. In memory only. */
export interface Login extends TurnLogin {
  /** CLAUDE_CONFIG_DIR for the turn, or null for Claude Code's default folder (this PC's login, an API key). */
  configDir: string | null;
  /** The folder Claude Code keeps this turn's session transcripts in. */
  home: string;
  /** 'api-key' only: the key, for this turn's environment. */
  apiKey?: string;
  /** The turn can't run on it: what to tell the user instead (no session is started). */
  problem?: string;
}

/** A brief's `account` field: `{ kind: 'pc' | 'folder' | 'api-key', dir?, apiKey? }`. Errors never repeat the key. */
export function parseAccount(raw: unknown): { account: AccountRequest | null; error?: string } {
  if (raw === undefined || raw === null) return { account: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { account: null, error: 'account must be an object: { kind: "pc" | "folder" | "api-key", dir?, apiKey? }' };
  const r = raw as Record<string, unknown>;
  if (r.kind === 'pc') return { account: { kind: 'pc' } };
  if (r.kind === 'folder') {
    const dir = typeof r.dir === 'string' ? r.dir.trim() : '';
    if (!dir || dir.length > 1024 || !isAbsolute(dir)) return { account: null, error: 'account.dir must be the absolute path of a Claude Code config folder' };
    return { account: { kind: 'folder', dir: resolve(dir) } };
  }
  if (r.kind === 'api-key') {
    const key = typeof r.apiKey === 'string' ? r.apiKey.trim() : '';
    if (!key || key.length > 512 || /\s/.test(key)) return { account: null, error: 'account.apiKey is missing or is not a valid API key' };
    return { account: { kind: 'api-key', apiKey: key } };
  }
  return { account: null, error: 'account.kind must be "pc", "folder" or "api-key"' };
}

/**
 * The login for a turn. A brief's `account` decides (Shuriken sends the login its own runs use); with none, and for
 * messages typed in Kiln, it is this PC's own Claude Code login. `from` names the app that sent the brief.
 */
export function resolveLogin(req: AccountRequest | null, from: string | null = null): Login {
  const app = from ?? 'The other app';
  if (req?.kind === 'folder' && req.dir) {
    const dir = req.dir;
    const login: Login = { kind: 'folder', dir, configDir: dir, home: dir, label: `${app}'s login (${basename(dir)})`, why: 'the brief asked for this login folder' };
    if (!existsSync(dir)) login.problem = `The Claude login folder the brief asked for doesn't exist: ${dir}`;
    // On Windows Claude Code keeps its login in the folder's .credentials.json.
    else if (process.platform === 'win32' && !hasLogin(dir)) login.problem = `The Claude login folder the brief asked for has no login in it: ${dir}. Sign in there first (claude /login with CLAUDE_CONFIG_DIR set to that folder).`;
    return login;
  }
  if (req?.kind === 'api-key' && req.apiKey) {
    return { kind: 'api-key', configDir: null, home: pcConfigDir(), apiKey: req.apiKey, label: `${app}'s API key`, why: 'the brief sent an API key (kept in memory for this turn only)' };
  }
  const why = req?.kind === 'pc' ? "the brief asked for this PC's login" : from ? "the brief named no login: this PC's own" : "typed in Kiln: this PC's own login";
  return { kind: 'pc', configDir: null, home: pcConfigDir(), label: "This PC's Claude login", why };
}

/** What other apps, the chat and the logs may see of a login: never the key. */
export function publicLogin(l: Login): TurnLogin {
  return { kind: l.kind, ...(l.kind === 'folder' && l.dir ? { dir: l.dir } : {}), label: l.label, why: l.why };
}

/** The child's environment for a login: the process's own (minus a host session's Claude variables) and the login. */
export function loginEnv(l: Login): Record<string, string> {
  return { ...cleanEnv(l.configDir ?? undefined), ...(l.kind === 'api-key' && l.apiKey ? { ANTHROPIC_API_KEY: l.apiKey } : {}) };
}

/** Two turns on the same login can share an open session. */
export function sameLogin(a: Login, b: Login): boolean {
  return a.kind === b.kind && (a.configDir ?? '').toLowerCase() === (b.configDir ?? '').toLowerCase() && (a.apiKey ?? '') === (b.apiKey ?? '');
}

/**
 * The folder holding a conversation saved by an earlier Kiln: chat.json's `sessionAccount` was an account id then
 * ('pc', or one of the accounts Kiln 0.8 listed). Lets those conversations go on.
 */
export function legacySessionHome(id: string | null | undefined): string | null {
  if (!id) return null;
  if (id === 'pc') return pcConfigDir();
  try {
    const old = JSON.parse(readFileSync(join(DATA_DIR, 'accounts.json'), 'utf8')) as { accounts?: Array<{ id?: string; dir?: string }> };
    const a = old.accounts?.find((x) => x.id === id);
    if (a) return a.dir || pcConfigDir();
  } catch {
    /* no list from an earlier Kiln */
  }
  const own = join(DATA_DIR, 'accounts', id);
  return existsSync(own) ? own : null;
}

/**
 * Makes a conversation resumable under another login folder by copying its transcript (Claude Code keeps sessions
 * per config folder): a project can be built from Shuriken on its login and then chatted with here on this PC's.
 */
export function copySession(sessionId: string, fromHome: string, toHome: string): boolean {
  if (fromHome.toLowerCase() === toHome.toLowerCase()) return true;
  const src = join(fromHome, 'projects');
  if (!existsSync(src)) return false;
  for (const d of readdirSync(src)) {
    const f = join(src, d, `${sessionId}.jsonl`);
    if (!existsSync(f)) continue;
    const destDir = join(toHome, 'projects', d);
    mkdirSync(destDir, { recursive: true });
    copyFileSync(f, join(destDir, `${sessionId}.jsonl`));
    return true;
  }
  return false;
}

interface Stored {
  email: string | null;
  plan: string | null;
  /** What the last check said, and when (the login file's time then). */
  signedIn: boolean | null;
  checkedAt: number | null;
  loginAt: number | null;
  usage: Record<string, UsageWindow>;
}

/**
 * This PC's Claude login as Settings shows it: signed in or not, who, and the usage Kiln's turns on it have seen.
 * Kiln never reads credentials: it checks that a login exists and asks Claude Code who is signed in (no model call).
 */
export class LoginStatus {
  private data: Stored;
  private last: LoginState['last'] = null;
  private exe = claudeExecutable();
  private checking: Promise<void> | null = null;
  onChange: (s: LoginState) => void = () => undefined;

  constructor() {
    this.data = this.load();
  }

  private load(): Stored {
    const d: Stored = { email: null, plan: null, signedIn: null, checkedAt: null, loginAt: null, usage: {} };
    try {
      return { ...d, ...(JSON.parse(readFileSync(FILE, 'utf8')) as Partial<Stored>) };
    } catch {
      return d;
    }
  }

  private save() {
    try {
      writeAtomic(FILE, JSON.stringify(this.data, null, 2));
    } catch {
      /* best effort: it is read again next time */
    }
    this.onChange(this.state());
  }

  /** When this PC's login file last changed (null: there is none). */
  private loginAt(): number | null {
    try {
      return statSync(credentials(pcConfigDir())).mtimeMs;
    } catch {
      return null;
    }
  }

  state(): LoginState {
    const dir = pcConfigDir();
    const at = this.loginAt();
    // The last check, when it looked at this very login file; else whether there is one. (Elsewhere than on Windows
    // the login may live in the system's keychain: then only the check can tell.)
    const checked = at !== null && this.data.loginAt === at && this.data.signedIn !== null;
    const signedIn = checked ? this.data.signedIn === true : at !== null || (process.platform !== 'win32' && this.data.signedIn === true);
    return { pc: { signedIn, email: signedIn ? this.data.email : null, plan: signedIn ? this.data.plan : null, dir, checkedAt: this.data.checkedAt, usage: this.data.usage }, last: this.last };
  }

  /** The login a turn just started on (shown in Settings). */
  noteTurn(l: Login) {
    this.last = { ...publicLogin(l), at: Date.now() };
    this.onChange(this.state());
  }

  /** Records a rate-limit event from a turn; only this PC's login has its usage shown. */
  recordUsage(l: Login, info: { status: UsageWindow['status']; rateLimitType?: string; utilization?: number; resetsAt?: number }) {
    if (l.kind !== 'pc') return;
    const resetsAt = info.resetsAt ? (info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt) : null;
    const utilization = info.utilization === undefined ? null : info.utilization > 1 ? info.utilization / 100 : info.utilization;
    this.data.usage[info.rateLimitType ?? 'unknown'] = { utilization, resetsAt, status: info.status, at: Date.now() };
    this.save();
  }

  /** Asks Claude Code who is signed in on this PC (no model call). */
  check(): Promise<void> {
    this.checking ??= this.checkNow().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async checkNow(): Promise<void> {
    const at = this.loginAt();
    if (at === null && process.platform === 'win32') {
      if (this.data.loginAt !== null || this.data.email) {
        this.data = { ...this.data, email: null, plan: null, signedIn: false, loginAt: null, checkedAt: Date.now(), usage: {} };
        this.save();
      }
      return;
    }
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    async function* idle(): AsyncGenerator<SDKUserMessage> {
      await gate;
    }
    const abort = new AbortController();
    const q = query({
      prompt: idle(),
      options: { abortController: abort, settingSources: [], strictMcpConfig: true, tools: [], persistSession: false, env: cleanEnv(), ...(this.exe ? { pathToClaudeCodeExecutable: this.exe } : {}) },
    });
    try {
      const init = await Promise.race([q.initializationResult(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 45_000))]);
      const acct = init.account ?? {};
      // With no login Claude Code still answers, with "none" as both sources.
      const signedIn = !!(acct.email || (acct.tokenSource && acct.tokenSource !== 'none') || (acct.apiKeySource && acct.apiKeySource !== 'none'));
      const changed = acct.email !== undefined && (acct.email ?? null) !== this.data.email;
      this.data = { ...this.data, email: acct.email ?? null, plan: acct.subscriptionType ?? null, signedIn, checkedAt: Date.now(), loginAt: at, usage: changed ? {} : this.data.usage };
      this.save();
    } catch {
      // Nothing learned; the next change of the login file asks again.
      this.data.loginAt = at;
      this.data.signedIn = null;
    } finally {
      release();
      try {
        q.close();
      } catch {
        abort.abort();
      }
    }
  }

  /** Checks again when this PC's login changed (someone ran `claude /login` or logged out): a file time, no call. */
  watch(everyMs = 30_000) {
    setInterval(() => {
      if (this.loginAt() !== this.data.loginAt) void this.check();
    }, everyMs).unref();
  }
}
