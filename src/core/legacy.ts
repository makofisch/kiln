import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LOGS_DIR, PROJECTS_DIR } from './config.ts';
import { Journal } from './journal.ts';
import { titleFrom, type Projects } from './projects.ts';
import { classify, watchdog } from './watchdog.ts';
import type { ChatMessage } from '../shared/types.ts';


interface SessionLine {
  type?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
}

type ContentBlock = { type: string; text?: string; name?: string; id?: string; input?: { description?: string }; tool_use_id?: string; is_error?: boolean; content?: unknown };

const SELF_FEEDBACK = /\b(creator|make you better|improve (you|yourself)|your capabilit|if you could (say|change|ask)|what would you (say|want|change|need)|what do you need)\b/i;

/**
 * Every Kiln 0.1 conversation, rebuilt from Claude Code's own session transcripts (0.1's "New"
 * button cleared the chat, but the transcripts stayed). Each becomes logs/conversations/kiln01-*.
 * Safe to run on every start: only new or grown sessions are (re)imported.
 */
export function importLegacySessions(): number {
  const dir = process.env.KILN_LEGACY_WORKSPACE;
  if (!dir) return 0;
  const root = join(homedir(), '.claude', 'projects', sessionDir(dir));
  if (!existsSync(root)) return 0;
  const markerFile = join(LOGS_DIR, 'conversations', '.kiln01-imported.json');
  let marker: Record<string, { bytes: number; users: number }> = {};
  try {
    marker = JSON.parse(readFileSync(markerFile, 'utf8')) as typeof marker;
  } catch {
    /* first import */
  }
  let imported = 0;
  for (const f of readdirSync(root).filter((x) => x.endsWith('.jsonl'))) {
    const id = f.slice(0, -6);
    const bytes = statSync(join(root, f)).size;
    if (marker[id]?.bytes === bytes) continue;
    const lines = readFileSync(join(root, f), 'utf8')
      .split('\n')
      .map((l) => {
        try {
          return JSON.parse(l) as SessionLine;
        } catch {
          return null;
        }
      })
      .filter((l): l is SessionLine => !!l && (l.type === 'user' || l.type === 'assistant') && !!l.message);
    const userText = (l: SessionLine): string | null => {
      const c = l.message!.content;
      if (typeof c === 'string') return c;
      if (!Array.isArray(c)) return null;
      const texts = (c as ContentBlock[]).filter((b) => b.type === 'text').map((b) => b.text ?? '');
      return texts.length ? texts.join('\n') : null;
    };
    const firstUser = lines.find((l) => l.type === 'user' && !l.isSidechain && userText(l));
    if (!firstUser) continue;
    const convId = `kiln01-${(firstUser.timestamp ?? '').slice(0, 10)}-${id.slice(0, 8)}`;
    const cleanUser = (t: string) => t.replace(/^\[Kiln:[^\]]*\]\s*/gm, '').trim();
    const title = titleFrom(cleanUser(userText(firstUser)!));
    for (const ext of ['jsonl', 'md']) rmSync(join(LOGS_DIR, 'conversations', `${convId}.${ext}`), { force: true });
    const journal = new Journal(convId, () => `${title} (Kiln 0.1)`);
    journal.at = firstUser.timestamp ?? null;
    journal.event('imported from a Kiln 0.1 Claude session', { text: id });

    let turn: { start: string; texts: string[]; tools: Map<string, { name: string; description?: string; at: string; ok?: boolean }>; last: string } | null = null;
    let users = 0;
    let lastAssistant = '';
    let askedForFeedback = false;
    const already = marker[id]?.users ?? 0;
    const flush = () => {
      if (!turn) return;
      for (const t of turn.tools.values()) {
        journal.at = t.at;
        journal.tool({ name: t.name.replace(/^mcp__\w+__/, ''), description: t.description, status: t.ok === false ? 'error' : 'ok', ms: 0 });
      }
      journal.at = turn.last;
      const text = turn.texts.join('\n\n').trim();
      journal.assistant(text, { tools: turn.tools.size, ms: Date.parse(turn.last) - Date.parse(turn.start) || 0 });
      if (askedForFeedback && text && users > already) {
        watchdog.record({ t: turn.last, kind: 'wish', severity: 2, source: 'copilot', project: convId, projectTitle: `${title} (Kiln 0.1)`, text: `The copilot's own suggestions for Kiln: ${text.slice(0, 2500)}`, signals: ['self-report', 'kiln-0.1'], conversation: `${convId}.md` });
      }
      askedForFeedback = false;
      lastAssistant = text || lastAssistant;
      turn = null;
    };
    for (const l of lines) {
      const at = l.timestamp ?? journal.at ?? new Date().toISOString();
      if (l.type === 'user') {
        const c = l.message!.content;
        const blocks = Array.isArray(c) ? (c as ContentBlock[]) : [];
        for (const b of blocks) if (b.type === 'tool_result' && b.tool_use_id && turn?.tools.has(b.tool_use_id)) turn.tools.get(b.tool_use_id)!.ok = !b.is_error;
        const text = l.isSidechain ? null : userText(l);
        if (text === null || /^\[Image: source:/.test(text)) continue;
        flush();
        users++;
        const clean = cleanUser(text);
        journal.at = at;
        journal.user(clean, { images: blocks.filter((b) => b.type === 'image').length, selected: /selected in the viewer/.test(text) ? (/"([^"]+)" selected/.exec(text)?.[1] ?? null) : null, notes: ['kiln-0.1'], account: 'pc', effort: '?' });
        if (users > already) {
          const cls = classify(clean);
          if (cls) watchdog.record({ t: at, kind: cls.kind, severity: cls.severity, source: 'heuristic', project: convId, projectTitle: `${title} (Kiln 0.1)`, text: clean, signals: [...cls.signals, 'kiln-0.1'], context: lastAssistant.slice(0, 300), conversation: `${convId}.md` });
        }
        askedForFeedback = SELF_FEEDBACK.test(clean);
        turn = { start: at, texts: [], tools: new Map(), last: at };
      } else if (l.type === 'assistant' && turn) {
        turn.last = at;
        const blocks = Array.isArray(l.message!.content) ? (l.message!.content as ContentBlock[]) : [];
        for (const b of blocks) {
          if (b.type === 'text' && b.text && !l.isSidechain) turn.texts.push(b.text);
          if (b.type === 'tool_use' && b.id && b.name) turn.tools.set(b.id, { name: `${l.isSidechain ? 'subagent:' : ''}${b.name}`, description: b.input?.description, at });
        }
      }
    }
    flush();
    marker[id] = { bytes, users };
    imported++;
  }
  if (imported) writeFileSync(markerFile, JSON.stringify(marker, null, 2));
  return imported;
}

/** Claude Code keeps sessions under projects/<cwd with every non-alphanumeric character as '-'>. */
const sessionDir = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

function findSession(root: string, sessionId: string, preferred: string): string | null {
  const direct = join(root, preferred, `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root)) {
    const f = join(root, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

/**
 * Kiln 0.1 kept one scene in <app>/workspace. On first run of 0.2 it becomes a project in
 * Documents\Kiln: scene, history and renders are copied, the chat keeps its Claude session (so the
 * copilot remembers it), and the conversation is written to the logs and read by the watchdog.
 */
export function importLegacy(projects: Projects): string | null {
  const dir = process.env.KILN_LEGACY_WORKSPACE;
  if (!dir || !existsSync(join(dir, 'chat.json')) || existsSync(join(dir, '.imported'))) return null;
  let chat: { sessionId?: string | null; messages?: ChatMessage[]; todos?: unknown[] };
  try {
    chat = JSON.parse(readFileSync(join(dir, 'chat.json'), 'utf8')) as typeof chat;
  } catch {
    return null;
  }
  const messages = chat.messages ?? [];
  if (!messages.length && !existsSync(join(dir, 'scene.blend'))) return null;
  const firstUser = messages.find((m) => m.role === 'user')?.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join(' ') ?? 'Imported scene';
  const meta = projects.create(firstUser);
  const target = join(PROJECTS_DIR, meta.id);
  for (const sub of ['history', 'renders', 'uploads', 'archive']) {
    if (existsSync(join(dir, sub))) cpSync(join(dir, sub), join(target, sub), { recursive: true });
  }
  if (existsSync(join(dir, 'scene.blend'))) copyFileSync(join(dir, 'scene.blend'), join(target, 'scene.blend'));

  // File links in the transcript now live under the project.
  const moved = JSON.parse(JSON.stringify(messages).replace(/\/files\/(renders|uploads|glb)\//g, `/files/${meta.id}/$1/`)) as ChatMessage[];
  let sessionId = chat.sessionId ?? null;
  if (sessionId) {
    const root = join(homedir(), '.claude', 'projects');
    const src = findSession(root, sessionId, sessionDir(dir));
    if (src) {
      mkdirSync(join(root, sessionDir(target)), { recursive: true });
      copyFileSync(src, join(root, sessionDir(target), `${sessionId}.jsonl`));
    } else sessionId = null;
  }
  writeFileSync(join(target, 'chat.json'), JSON.stringify({ sessionId, sessionAccount: 'pc', messages: moved, todos: chat.todos ?? [], suggestions: [] }), 'utf8');

  // The conversation into the logs, and the user's words past the watchdog.
  const journal = new Journal(meta.id, () => meta.title);
  journal.event('imported from Kiln 0.1', { text: dir });
  let lastAssistant = '';
  for (const m of moved) {
    const text = m.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('\n').trim();
    if (m.role === 'user') {
      journal.user(text, { images: m.images?.length ?? 0, selected: null, notes: ['imported'], account: 'pc', effort: '?' });
      const c = classify(text);
      if (c) watchdog.record({ kind: c.kind, severity: c.severity, source: 'heuristic', project: meta.id, projectTitle: meta.title, text, signals: [...c.signals, 'imported'], context: lastAssistant.slice(0, 300), conversation: `${meta.id}.md` });
    } else {
      const tools = m.blocks.filter((b) => b.kind === 'tool').length;
      journal.assistant(text, { usage: m.usage, error: m.blocks.find((b) => b.kind === 'error')?.kind === 'error' ? (m.blocks.find((b) => b.kind === 'error') as { text: string }).text : null, tools, ms: m.usage?.durationMs ?? 0 });
      lastAssistant = text;
    }
  }
  writeFileSync(join(dir, '.imported'), `Imported into ${target} on ${new Date().toISOString()}\n`);
  projects.changed();
  return meta.id;
}
