import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { BlenderInfo, BlenderStatus } from '../shared/types.ts';

export interface BridgeReply {
  id?: number;
  ok: boolean;
  error?: string | null;
  ms?: number;
  [key: string]: unknown;
}

const MARK = '@@KILN ';

/** Every Blender this core started and hasn't seen exit (bridges and one-off jobs), so quitting leaves none behind. */
const children = new Set<ChildProcess>();
export function trackChild(proc: ChildProcess): void {
  children.add(proc);
  proc.once('exit', () => children.delete(proc));
}
export function killAllBlenders(): void {
  for (const p of children) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
  children.clear();
}

/**
 * One long-lived headless Blender running blender/bridge.py. Requests are JSON lines on stdin and
 * run one at a time (Blender is single-threaded); replies are marked lines on stdout. A request that
 * hangs, or a crash, restarts Blender and reopens the last saved scene.
 */
export class BlenderBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, (r: BridgeReply) => void>();
  private chain: Promise<unknown> = Promise.resolve();
  private starting: Promise<void> | null = null;
  private recent: string[] = [];
  private crashes: number[] = [];
  private stopping = false;
  /** Blender is up and its scene is loaded (set after the restore, cleared when the process goes). */
  private ready = false;
  /** The file the last (re)start loaded: a path, null for an empty scene, undefined before the first start. */
  restored: string | null | undefined = undefined;
  /** Processes stopped on purpose (a timed-out call), so their exit isn't treated as a crash. */
  private killed = new WeakSet<ChildProcessWithoutNullStreams>();
  info: BlenderInfo;
  private exe: string | null;
  private readonly bridgeScript: string;
  /** The scene file to open after a (re)start, or null for an empty scene. Set by the project that owns it. */
  restorePath: () => string | null = () => null;
  onInfo: (info: BlenderInfo) => void = () => undefined;

  constructor(exe: string | null, bridgeScript: string) {
    this.exe = exe;
    this.bridgeScript = bridgeScript;
    this.info = exe
      ? { status: 'starting', version: null, detail: exe }
      : { status: 'missing', version: null, detail: 'blender.exe not found. Set "blender" in kiln.config.json or the KILN_BLENDER variable.' };
  }

  /** Blender was installed after this bridge was made. */
  found(exe: string) {
    this.exe = exe;
    this.setStatus('starting', exe);
  }

  private setStatus(status: BlenderStatus, detail: string | null = this.info.detail) {
    this.info = { ...this.info, status, detail };
    this.onInfo(this.info);
  }

  /** Starts Blender (once; concurrent callers share the start). */
  start(): Promise<void> {
    if (!this.exe) return Promise.reject(new Error(this.info.detail ?? 'Blender is missing'));
    if (this.stopping) return Promise.reject(new Error('This project is closing'));
    // Not "a process exists": a restarted Blender is only usable once it has reloaded the scene.
    if (this.proc && this.ready) return Promise.resolve();
    if (!this.starting) this.starting = this.launch().finally(() => (this.starting = null));
    return this.starting;
  }

  private launch(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.setStatus(this.info.status === 'restarting' ? 'restarting' : 'starting');
      const proc = spawn(this.exe!, ['-b', '--factory-startup', '-noaudio', '--python', this.bridgeScript], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      });
      this.proc = proc;
      this.ready = false;
      trackChild(proc);
      proc.stdin.on('error', () => undefined); // a write after Blender went away is reported by the pending call
      this.buf = '';
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`Blender did not start within 60 s. ${this.recent.slice(-8).join(' | ')}`));
      }, 60_000);
      let ready = false;
      this.onReady = async (msg) => {
        ready = true;
        clearTimeout(timer);
        this.info = { ...this.info, version: String(msg.version ?? '') };
        try {
          const path = this.restorePath();
          const r = path ? await this.send({ op: 'open', path }, 60_000) : await this.send({ op: 'new' }, 60_000);
          if (!r.ok) throw new Error(r.error ?? 'could not load the scene');
          this.restored = path;
          this.ready = true;
          this.setStatus('ready', null);
          resolve();
        } catch (e) {
          reject(e as Error);
        }
      };
      proc.stdout.on('data', (d: Buffer) => this.onData(d.toString('utf8')));
      proc.stderr.on('data', (d: Buffer) => this.remember(d.toString('utf8')));
      proc.on('error', (e) => {
        clearTimeout(timer);
        this.proc = null;
        this.setStatus('failed', `Could not run Blender: ${e.message}`);
        reject(e);
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (this.proc === proc) {
          this.proc = null;
          this.ready = false;
        }
        for (const [, done] of this.pending) done({ ok: false, error: `Blender stopped (exit code ${code}). ${this.recent.slice(-4).join(' | ')}` });
        this.pending.clear();
        if (!ready) reject(new Error(`Blender exited during startup (code ${code}). ${this.recent.slice(-8).join(' | ')}`));
        if (!this.stopping && ready && !this.killed.has(proc)) this.onCrash();
      });
    });
  }

  private onReady: (msg: Record<string, unknown>) => void = () => undefined;

  private onCrash() {
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < 60_000), now];
    if (this.crashes.length > 3) {
      this.setStatus('failed', 'Blender crashed repeatedly; restart Kiln.');
      return;
    }
    this.setStatus('restarting', 'Blender stopped unexpectedly; reopening the last saved scene');
    this.start().catch((e: Error) => this.setStatus('failed', e.message));
  }

  private remember(text: string) {
    for (const l of text.split(/\r?\n/)) if (l.trim()) this.recent.push(l.trim());
    if (this.recent.length > 60) this.recent = this.recent.slice(-60);
  }

  private onData(text: string) {
    this.buf += text;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const k = line.indexOf(MARK);
      if (k < 0) {
        this.remember(line);
        continue;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line.slice(k + MARK.length)) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (msg.event === 'ready') this.onReady(msg);
      else if (typeof msg.id === 'number') {
        const done = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        done?.(msg as BridgeReply);
      }
    }
  }

  /** Writes one request and waits for its reply (no queueing: callers go through call()). */
  private send(req: Record<string, unknown>, timeoutMs: number): Promise<BridgeReply> {
    const proc = this.proc;
    if (!proc) return Promise.resolve({ ok: false, error: 'Blender is not running' });
    const id = this.nextId++;
    return new Promise<BridgeReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `timeout`, timedOut: true });
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      proc.stdin.write(`${JSON.stringify({ ...req, id })}\n`);
    });
  }

  /** Runs one request after the ones before it. A timeout restarts Blender from the last save. */
  call(op: string, payload: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<BridgeReply> {
    const run = async (): Promise<BridgeReply> => {
      if (this.stopping) return { ok: false, error: 'This project is closing' };
      try {
        await this.start();
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      this.setStatus('busy');
      const r = await this.send({ op, ...payload }, timeoutMs);
      if (r.timedOut) {
        if (this.proc) {
          this.killed.add(this.proc);
          this.proc.kill();
          this.proc = null;
          this.ready = false;
        }
        this.info = { ...this.info, status: 'restarting' };
        try {
          await this.start();
        } catch (e) {
          this.setStatus('failed', (e as Error).message);
        }
        return { ok: false, timedOut: true, error: `Timed out after ${Math.round(timeoutMs / 1000)} s. Blender was restarted and the scene reloaded from the last saved state (the unfinished call's changes are gone).` };
      }
      if (this.proc) this.setStatus('ready', null);
      return r;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  get alive(): boolean {
    return !!this.proc || !!this.starting;
  }

  /** The process stop() ended, until it has really exited (Windows keeps its files locked until then). */
  private ending: ChildProcessWithoutNullStreams | null = null;

  /** Resolves once the Blender stop() ended has exited (at most `ms`): its files are free to move then. */
  exited(ms = 5000): Promise<void> {
    const p = this.ending;
    if (!p || p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      p.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /** Ends this Blender now. (It used to wait for Blender to read the end of its input, which a busy or hung one never does.) */
  stop() {
    this.stopping = true;
    const p = this.proc;
    this.proc = null;
    this.ready = false;
    if (!p) return;
    this.ending = p;
    this.killed.add(p);
    try {
      p.stdin.end();
    } catch {
      /* already gone */
    }
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
}
