import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOGS_DIR, VERSION } from './config.ts';
import { redact } from './secrets.ts';

const CONVERSATIONS = join(LOGS_DIR, 'conversations');
mkdirSync(CONVERSATIONS, { recursive: true });

const time = (at?: string | null) => at ?? new Date().toISOString();
const clock = (at?: string | null) => (at ? new Date(at) : new Date()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const excerpt = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Every conversation with the copilot, kept forever: an append-only JSONL file per project (the
 * complete record) and a Markdown mirror that reads like a chat. Kept in %APPDATA%\Kiln\logs, apart
 * from the project, so deleting or resetting a project never loses its history.
 */
export class Journal {
  readonly jsonl: string;
  private readonly md: string;
  private readonly projectId: string;
  private readonly title: () => string;
  /** Replaying an old conversation: stamp entries with their original time. */
  at: string | null = null;

  constructor(projectId: string, title: () => string) {
    this.projectId = projectId;
    this.title = title;
    this.jsonl = join(CONVERSATIONS, `${projectId}.jsonl`);
    this.md = join(CONVERSATIONS, `${projectId}.md`);
    if (!existsSync(this.md)) writeFileSync(this.md, `# Kiln conversation: ${projectId}\n\n`, 'utf8');
  }

  private write(type: string, data: Record<string, unknown>) {
    try {
      // Never a brief's API key: a turn's login is written as its label, and anything key-shaped is redacted.
      appendFileSync(this.jsonl, `${redact(JSON.stringify({ t: time(this.at), v: VERSION, project: this.projectId, title: this.title(), type, ...data }))}\n`, 'utf8');
    } catch {
      /* logging must never break the app */
    }
  }

  private md_(text: string) {
    try {
      appendFileSync(this.md, redact(text), 'utf8');
    } catch {
      /* ignore */
    }
  }

  /** A message to the copilot: the user's own, or a brief another app's assistant sent for them (`from`). */
  user(text: string, extra: { images: number; selected: string | null; notes: string[]; account: string; effort: string; from?: string | null; kind?: string | null }) {
    this.write('user', { text, ...extra });
    const meta = [extra.selected ? `selected: ${extra.selected}` : '', extra.images ? `${extra.images} image(s)` : '', `${extra.account} · ${extra.effort}`].filter(Boolean).join(' · ');
    const who = extra.from ? `${extra.from} (${extra.kind ? `${extra.kind} brief` : 'another app'})` : 'You';
    this.md_(`\n---\n\n### ${who} · ${clock(this.at)}  \n<sub>${meta}</sub>\n\n${text}\n`);
  }

  assistant(text: string, extra: { usage?: unknown; error?: string | null; suggestions?: string[]; tools: number; ms: number }) {
    this.write('assistant', { text, ...extra });
    const err = extra.error ? `\n> **Error:** ${extra.error}\n` : '';
    const sug = extra.suggestions?.length ? `\n<sub>suggested: ${extra.suggestions.join(' · ')}</sub>\n` : '';
    this.md_(`\n### Kiln · ${clock(this.at)} · ${(extra.ms / 1000).toFixed(0)} s · ${extra.tools} tool calls\n\n${text || '_(no text)_'}\n${err}${sug}`);
  }

  /** ms: how long the tool ran; writeMs: how long the copilot took to write the call before it. */
  tool(e: { name: string; description?: string; status: string; ms: number; writeMs?: number; error?: string; parent?: string | null }) {
    this.write('tool', e);
    const label = e.description ? `${e.name} — ${e.description}` : e.name;
    this.md_(`- ${e.status === 'ok' ? '✓' : '✗'} \`${label}\` ${(e.ms / 1000).toFixed(1)} s${e.parent ? ' (subagent)' : ''}${e.error ? ` — ${excerpt(e.error.replace(/\s+/g, ' '), 200)}` : ''}\n`);
  }

  event(kind: string, detail: Record<string, unknown> = {}) {
    this.write('event', { kind, ...detail });
    this.md_(`\n> _${clock(this.at)} · ${kind}${detail.text ? `: ${String(detail.text)}` : ''}_\n`);
  }

  /** The last few exchanges, for watchdog context. */
  tail(lines = 6): Array<{ type: string; text?: string }> {
    try {
      const all = readFileSync(this.jsonl, 'utf8').trim().split('\n');
      return all
        .slice(-60)
        .map((l) => JSON.parse(l) as { type: string; text?: string })
        .filter((e) => e.type === 'user' || e.type === 'assistant')
        .slice(-lines);
    } catch {
      return [];
    }
  }
}
