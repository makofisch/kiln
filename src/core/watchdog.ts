import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOGS_DIR, VERSION } from './config.ts';
import { redact } from './secrets.ts';

export type FindingKind = 'complaint' | 'bug' | 'wish' | 'praise' | 'rating' | 'signal' | 'note';

export interface Finding {
  id: string;
  t: string;
  v: string;
  kind: FindingKind;
  /** 1 = minor, 3 = serious */
  severity: 1 | 2 | 3;
  source: 'heuristic' | 'copilot' | 'user' | 'system';
  project: string;
  projectTitle: string;
  text: string;
  /** What the copilot had just said / done, for context. */
  context?: string;
  signals?: string[];
  conversation: string;
}

const FILE = join(LOGS_DIR, 'watchdog.jsonl');
const REPORT = join(LOGS_DIR, 'WATCHDOG.md');

// Heuristics for what the user says. Cheap, instant, no model call; the copilot's own
// report_feedback tool catches what these miss.
const RULES: Array<{ kind: FindingKind; weight: number; re: RegExp; tag: string }> = [
  { kind: 'complaint', weight: 2, tag: 'not-working', re: /\b(does ?n[o']?t|did ?n[o']?t|is ?n[o']?t|won'?t|can'?t|not) (work|working|look(ing)? right|right|what i (asked|wanted|meant)|show(ing)?|load(ing)?|appear(ing)?)\b/i },
  { kind: 'complaint', weight: 2, tag: 'negative', re: /\b(wrong|broken|ugly|terrible|awful|horrible|bad|worse|useless|annoying|frustrat\w*|confus\w*|messy|janky|weird|off)\b/i },
  { kind: 'complaint', weight: 1, tag: 'why', re: /\bwhy (did|does|is|are|would|can'?t|won'?t|isn'?t)\b/i },
  { kind: 'complaint', weight: 2, tag: 'repeat', re: /\b(still (not|does ?n[o']?t|is ?n[o']?t|broken|wrong|happening|there|the same|looks)|i (said|asked|told you)|like i said|as i said)\b/i },
  { kind: 'complaint', weight: 1, tag: 'again', re: /\b(again|once more)\b/i },
  { kind: 'complaint', weight: 1, tag: 'correction', re: /^(no|nope|not that|that'?s not|wait)\b/i },
  { kind: 'complaint', weight: 1, tag: 'emphasis', re: /(\?\?|!!|\b[A-Z]{4,}\b)/ },
  // App trouble only: "hanging lanterns", "a stuck door" or "a slow river" in a brief are not bugs.
  { kind: 'bug', weight: 3, tag: 'bug', re: /\b(bug|crash(ed|es|ing)?|froze|freezes|freezing|glitch(es|ed|y|ing)?|lagg(y|ing)|error|(kiln|app|it|viewer|chat|tab|window|blender) (hangs|hung|is stuck|got stuck|is (so |too |really )?slow|keeps? (crashing|freezing|lagging)))\b/i },
  { kind: 'wish', weight: 2, tag: 'wish', re: /\b(i wish|it would be (nice|great|cool|good)|would love|should (be able|have|let|support)|please add|can (you|kiln|it) (add|support|let me)|feature request|i want (kiln|the app|it) to)\b/i },
  { kind: 'praise', weight: 2, tag: 'praise', re: /\b(love (it|this|that)|awesome|amazing|perfect|great (job|work)|nice( work| job)?|nicely done|well done|good job|impressive|wow|beautiful|lovely|looks (great|good|amazing|awesome)|exactly (it|right|what))\b/i },
];

const APP_WORDS = /\b(kiln|app|ui|viewer|window|tab|button|chat|render|screen|interface|slow|lag|speed|crash)\b/i;

/** A build request ("Model a treehouse…", a suggestion bubble's brief): not feedback on its own. */
const BRIEF = /^(model|build|create|make|design|carve|add|give|set up|upgrade|show me|grow|light up|weather|hide|turn|place|put)\b/i;

export function classify(text: string): { kind: FindingKind; severity: 1 | 2 | 3; signals: string[] } | null {
  const score: Partial<Record<FindingKind, number>> = {};
  const tags: string[] = [];
  for (const r of RULES) {
    if (r.re.test(text)) {
      score[r.kind] = (score[r.kind] ?? 0) + r.weight;
      tags.push(r.tag);
    }
  }
  const neg = (score.complaint ?? 0) + (score.bug ?? 0);
  if (BRIEF.test(text.trim()) && neg < 4 && !score.wish && !score.praise) return null;
  const best = (Object.entries(score) as Array<[FindingKind, number]>).sort((a, b) => b[1] - a[1])[0];
  if (!best) return null;
  if (best[0] === 'complaint' && best[1] < 2) return null;
  if (APP_WORDS.test(text)) tags.push('about-app');
  const kind = (score.bug ?? 0) >= 3 ? 'bug' : best[0];
  const severity: 1 | 2 | 3 = neg >= 5 ? 3 : neg >= 3 ? 2 : 1;
  return { kind, severity, signals: tags };
}

/**
 * Watches conversations for what the user thinks of Kiln and the copilot: complaints, bugs, wishes
 * and praise (heuristics + the copilot's own reports + ratings + /feedback), and trouble signals
 * (errors, Stop, Undo right after a change, timeouts, slow turns, usage limits). Everything lands
 * in logs/watchdog.jsonl, summarized in logs/WATCHDOG.md.
 */
export class Watchdog {
  private seq = 0;

  record(f: Omit<Finding, 'id' | 't' | 'v'> & { t?: string }): Finding {
    const full: Finding = { id: `w${Date.now().toString(36)}${(this.seq++).toString(36)}`, v: VERSION, ...f, t: f.t ?? new Date().toISOString() };
    try {
      appendFileSync(FILE, `${redact(JSON.stringify(full))}\n`, 'utf8');
      this.report();
    } catch {
      /* never break the app */
    }
    return full;
  }

  /** Rewrites WATCHDOG.md from the log: what needs attention first. */
  private report() {
    let all: Finding[] = [];
    try {
      all = readFileSync(FILE, 'utf8')
        .trim()
        .split('\n')
        .slice(-2000)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as Finding];
          } catch {
            return []; // one damaged line must not stop the report for good
          }
        });
    } catch {
      return;
    }
    const recent = [...all].reverse();
    const section = (title: string, items: Finding[], limit = 60) =>
      items.length
        ? `\n## ${title} (${items.length})\n\n${items
            .slice(0, limit)
            .map((f) => {
              const when = new Date(f.t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
              const sev = f.severity === 3 ? '🔴' : f.severity === 2 ? '🟠' : '🟡';
              const ctx = f.context ? `\n  - context: ${f.context.replace(/\s+/g, ' ').slice(0, 240)}` : '';
              const sig = f.signals?.length ? ` · ${f.signals.join(', ')}` : '';
              return `- ${sev} **${when}** · ${f.projectTitle || f.project} · _${f.source}${sig}_\n  - ${f.text.replace(/\s+/g, ' ').slice(0, 600)}${ctx}\n  - log: \`logs/conversations/${f.conversation}\``;
            })
            .join('\n')}\n`
        : '';
    const attention = recent.filter((f) => f.kind === 'complaint' || f.kind === 'bug' || (f.kind === 'rating' && f.severity > 1) || (f.kind === 'signal' && f.severity >= 2) || f.kind === 'note');
    const md = `# Kiln watchdog

What you said about Kiln and its copilot, and where things went wrong. Newest first.
Sources: your messages (heuristics), the copilot's own reports, 👍/👎 ratings, \`/feedback\` notes, and system signals.
Full conversations: \`logs/conversations/<project>.jsonl\` (complete) and \`.md\` (readable).

Updated ${new Date().toLocaleString()} · ${all.length} findings in total.
${section('Needs attention', attention)}${section('Wishes', recent.filter((f) => f.kind === 'wish'))}${section('What worked', recent.filter((f) => f.kind === 'praise' || (f.kind === 'rating' && f.severity === 1)), 30)}${section('Minor signals', recent.filter((f) => f.kind === 'signal' && f.severity < 2), 40)}`;
    writeFileSync(REPORT, md, 'utf8');
  }
}

export const watchdog = new Watchdog();
