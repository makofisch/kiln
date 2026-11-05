import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { writeAtomic } from './fsx.ts';

// What the copilot has learned about the user, across projects and sessions. A plain Markdown list
// the user can read and edit (in Settings, or by hand): %APPDATA%\Kiln\memory.md. Each project's
// copilot session gets the list in its instructions when the session starts; with memory turned
// off in Settings it gets nothing and has no remember tool.
export const MEMORY_FILE = join(DATA_DIR, 'memory.md');
const MAX = 40;

/** Called after the list changes (the copilot remembered something, or the user edited it). */
let changed: () => void = () => {};
export function onMemoryChange(fn: () => void) {
  changed = fn;
}

export function facts(): string[] {
  try {
    return readFileSync(MEMORY_FILE, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function write(list: string[]) {
  writeAtomic(MEMORY_FILE, `# What Kiln's copilot knows about you\n\nEdit or delete lines freely (or use Settings → Memory); new sessions read this list.\n\n${list.map((x) => `- ${x}`).join('\n')}\n`);
}

const clean = (f: string) => f.trim().replace(/\s+/g, ' ').slice(0, 300);

export function remember(fact: string): string {
  const f = clean(fact);
  const all = facts();
  const low = f.toLowerCase();
  if (all.some((x) => x.toLowerCase() === low || x.toLowerCase().includes(low))) return 'Already known.';
  write([...all, f].slice(-MAX));
  changed();
  return 'Saved for future sessions.';
}

/** Replaces the whole list (Settings: edit, remove, add, reorder). */
export function setFacts(list: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const f = clean(String(raw));
    if (!f || seen.has(f.toLowerCase())) continue;
    seen.add(f.toLowerCase());
    out.push(f);
  }
  write(out.slice(-MAX));
  changed();
}

/** The memory as a system-prompt section (empty when there is nothing yet). */
export function memoryPrompt(): string {
  const all = facts();
  return all.length ? `\n\nWhat you know about this user from earlier sessions (keep honoring it; save new lasting preferences with remember):\n${all.map((x) => `- ${x}`).join('\n')}` : '';
}
