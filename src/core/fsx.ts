import { appendFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOGS_DIR } from './config.ts';
import { redact } from './secrets.ts';

/** Writes a state file whole or not at all: a crash mid-write leaves the old file, not half of a new one. */
export function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, 'utf8');
  try {
    renameSync(tmp, file);
  } catch {
    // Another program has the file open (Windows): fall back to writing in place.
    writeFileSync(file, data, 'utf8');
  }
}

/** The core's own log (logs\core.log): crashes, restarts and failed background work. A packaged app has no console. */
export function logCore(text: string): void {
  const line = `${new Date().toISOString()} ${redact(text).replace(/\s+$/, '')}\n`;
  try {
    appendFileSync(join(LOGS_DIR, 'core.log'), line, 'utf8');
  } catch {
    /* the log is best-effort */
  }
  if (process.stderr.writable) process.stderr.write(line);
}

/** Bytes under a folder (0 when it is missing). */
export function folderBytes(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    try {
      const s = statSync(join(dir, name));
      total += s.isDirectory() ? folderBytes(join(dir, name)) : s.size;
    } catch {
      /* removed meanwhile */
    }
  }
  return total;
}
