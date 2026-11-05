import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../common/Icon.tsx';
import { LiveMark } from '../../common/LiveMark.tsx';
import { PixelMark } from '../../common/PixelMark.tsx';
import { actions, notify } from '../store.ts';
import { formatDuration, formatTokens, highlightPython, renderMarkdown, stripTrailer } from '../lib/text.ts';
import type { Block, ChatMessage, ThinkingBlock, ToolBlock } from '../../../shared/types.ts';

const SUBAGENT = new Set(['Agent', 'Task']);

function useNow(active: boolean, every = 500) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [active, every]);
  return now;
}

function copy(text: string, what = 'Copied') {
  void navigator.clipboard.writeText(text).then(
    () => notify('info', what),
    () => notify('error', 'Could not copy'),
  );
}

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className={`md${streaming ? ' streaming' : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const btn = (e.target as HTMLElement).closest('.code-copy');
        const code = btn?.parentElement?.querySelector('code');
        if (code) copy(code.textContent ?? '', 'Code copied');
      }}
    />
  );
});

function Thinking({ block, live }: { block: ThinkingBlock; live: boolean }) {
  const [open, setOpen] = useState(false);
  const active = live && !block.done;
  if (!block.text.trim() && !active) return null;
  return (
    <div className={`thinking${open ? ' open' : ''}`}>
      <button className="thinking-head" onClick={() => setOpen(!open)}>
        <Icon name="brain" size={14} />
        <span className={active ? 'shimmer-text' : ''}>{active ? 'Thinking' : 'Thought'}</span>
        {block.text.trim() && <Icon name="chevron" size={13} className={`chev${open ? ' open' : ''}`} />}
      </button>
      {open && block.text.trim() && <div className="thinking-body">{block.text}</div>}
    </div>
  );
}

export function toolTitle(b: ToolBlock): { icon: string; label: string; detail?: string } {
  const i = b.input as Record<string, unknown>;
  switch (b.name) {
    case 'mcp__blender__run_python':
      return { icon: 'code', label: (i.description as string) || 'Running Python', detail: 'python' };
    case 'mcp__blender__render_view': {
      const views = (i.views as string[] | undefined) ?? ['iso'];
      const frames = i.frames as number[] | undefined;
      return { icon: 'eye', label: 'Looked at the scene', detail: `${frames?.length ? `${frames.length} frames · ` : ''}${views.join(', ')} · ${(i.quality as string) ?? 'fast'}` };
    }
    case 'mcp__blender__scene_info':
      return { icon: 'list', label: 'Inspected the scene' };
    case 'mcp__blender__check_scene':
      return { icon: 'target', label: i.fix ? 'Checked and fixed overlaps' : 'Checked the scene' };
    case 'mcp__kiln__report_feedback':
      return { icon: 'alert', label: 'Noted your feedback in Kiln’s feedback log' };
    case 'mcp__kiln__remember':
      return { icon: 'brain', label: `Remembered: ${(i.fact as string) ?? ''}` };
    case 'mcp__kiln__plan':
    case 'TodoWrite':
      return { icon: 'plan', label: 'Updated the plan' };
    case 'mcp__blender__render_motion': {
      const views = (i.views as string[] | undefined) ?? ['strip', 'graph'];
      return { icon: 'film', label: 'Watched the motion', detail: `${(i.clip as string) ?? 'current clip'} · ${views.join(', ')}` };
    }
    case 'mcp__blender__check_motion':
      return { icon: 'target', label: 'Checked the motion', detail: (i.clip as string) ?? '' };
    case 'mcp__kiln__animation_guide':
      return { icon: 'bone', label: 'Read the rigging and animation guide' };
    case 'mcp__kiln__reference_images': {
      const pages = (i.pages as string[] | undefined) ?? [];
      const host = (u: string) => {
        try {
          return new URL(u).host.replace(/^www\./, '');
        } catch {
          return u;
        }
      };
      return { icon: 'image', label: 'Looked at reference images', detail: [(i.query as string) ?? '', ...pages.map(host)].filter(Boolean).join(' · ') };
    }
    case 'WebSearch':
      return { icon: 'search', label: 'Searched the web', detail: (i.query as string) ?? '' };
    case 'WebFetch': {
      let host = '';
      try {
        host = new URL(i.url as string).host.replace(/^www\./, '');
      } catch {
        /* no url yet while streaming */
      }
      return { icon: 'globe', label: 'Read a web page', detail: host };
    }
    default:
      return { icon: 'spark', label: b.name.replace(/^mcp__\w+__/, '') };
  }
}

function Elapsed({ b }: { b: ToolBlock }) {
  const now = useNow(b.status === 'running');
  const ms = (b.endedAt ?? now) - b.startedAt;
  return <span className="tool-time">{formatDuration(Math.max(0, ms))}</span>;
}

function StatusMark({ status }: { status: ToolBlock['status'] }) {
  if (status === 'running') return <span className="run-dot" />;
  if (status === 'ok') return <Icon name="check" size={13} className="ok" />;
  return <Icon name="x" size={13} className="err" />;
}

/** One step in the timeline: a tool call, expandable to its code and output. */
function Step({ b, compact }: { b: ToolBlock; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const t = toolTitle(b);
  const code = typeof b.input.code === 'string' ? (b.input.code as string) : null;
  const streamingCode = !!b.input._streaming && b.status === 'running';
  const expandable = !!(code || b.output);
  return (
    <div className={`step ${b.status}${compact ? ' compact' : ''}${open ? ' open' : ''}`}>
      <span className="step-dot">
        <Icon name={t.icon} size={12} />
      </span>
      <div className="step-main">
        <button className="step-head" onClick={() => expandable && setOpen(!open)} disabled={!expandable}>
          <span className="step-label">{t.label}</span>
          {t.detail && <span className="step-detail">{t.detail}</span>}
          <span className="tool-meta">
            <Elapsed b={b} />
            <StatusMark status={b.status} />
          </span>
        </button>
        {streamingCode && code && !open && !compact && (
          <pre className="code live">
            <code dangerouslySetInnerHTML={{ __html: highlightPython(code.split('\n').slice(-5).join('\n')) }} />
          </pre>
        )}
        {open && (
          <div className="tool-body">
            {code && (
              <div className="code-wrap">
                <button className="code-copy" onClick={() => copy(code, 'Code copied')} title="Copy">
                  <Icon name="copy" size={13} />
                </button>
                <pre className="code">
                  <code dangerouslySetInnerHTML={{ __html: highlightPython(code) }} />
                </pre>
              </div>
            )}
            {b.output && <pre className={`tool-output${b.status === 'error' ? ' err' : ''}`}>{b.output}</pre>}
          </div>
        )}
      </div>
    </div>
  );
}

function TaskCard({ b, steps }: { b: ToolBlock; steps: ToolBlock[] }) {
  const [open, setOpen] = useState(false);
  const i = b.input as { description?: string; subagent_type?: string; prompt?: string };
  const kind = b.task?.type ?? i.subagent_type ?? 'agent';
  const running = b.status === 'running';
  const shown = running ? steps.slice(-4) : open ? steps : [];
  return (
    <div className={`task ${b.status}`}>
      <div className="task-glow" />
      <button className="task-head" onClick={() => setOpen(!open)}>
        <span className="task-avatar">{running ? <PixelMark size={20} working /> : <Icon name="bot" size={15} />}</span>
        <span className="task-title">
          <span className="task-kind">{kind}</span>
          <span className="task-desc">{i.description ?? b.task?.description ?? 'Helper'}</span>
        </span>
        <span className="tool-meta">
          <Elapsed b={b} />
          <StatusMark status={b.status} />
        </span>
      </button>
      <div className="task-stats">
        {b.task?.toolUses !== undefined && <span>{b.task.toolUses} steps</span>}
        {b.task?.tokens !== undefined && <span>{formatTokens(b.task.tokens)} tokens</span>}
        {running && b.task?.lastTool && <span className="shimmer-text">{b.task.lastTool.replace(/^mcp__\w+__/, '')}</span>}
        {!running && steps.length > 0 && <span className="task-toggle">{open ? 'Hide steps' : 'Show steps'}</span>}
      </div>
      {shown.length > 0 && (
        <div className="task-children steps">
          {running && steps.length > shown.length && <div className="task-more">+{steps.length - shown.length} earlier steps</div>}
          {shown.map((c) => (
            <Step key={c.id} b={c} compact />
          ))}
        </div>
      )}
      {open && (
        <div className="tool-body">
          {i.prompt && (
            <>
              <div className="body-label">Brief</div>
              <div className="task-brief">{i.prompt}</div>
            </>
          )}
          {b.output && (
            <>
              <div className="body-label">Report</div>
              <Markdown text={b.output} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A run of tool calls as a timeline. Live: the latest steps, earlier ones folded. Done: folded into
 * one line ("6 steps · 42 s") that opens the timeline. Renders stay visible as thumbnails either way.
 */
function StepGroup({ steps, live, subs }: { steps: ToolBlock[]; live: boolean; subs: Map<string, ToolBlock[]> }) {
  const running = steps.some((s) => s.status === 'running');
  const [open, setOpen] = useState(false);
  const errors = steps.filter((s) => s.status === 'error').length;
  const renders = steps.flatMap((s) => (s.images?.length ? s.images.map((img, k) => ({ id: `${s.id}-${k}`, image: img })) : s.image ? [{ id: s.id, image: s.image }] : []));
  const first = steps[0]!.startedAt;
  const last = Math.max(...steps.map((s) => s.endedAt ?? s.startedAt));
  const folded = !open && !(live && running) && steps.length > 2;
  const visible = live && running && !open ? steps.slice(-4) : steps;
  return (
    <div className={`step-group${folded ? ' folded' : ''}`}>
      {folded ? (
        <button className="group-summary" onClick={() => setOpen(true)}>
          <span className={`group-mark${errors ? ' warn' : ''}`}>
            <Icon name={errors ? 'alert' : 'check'} size={12} />
          </span>
          <span className="group-count">
            {steps.length} steps{errors ? ` · ${errors} retried` : ''} · {formatDuration(Math.max(0, last - first))}
          </span>
          <span className="group-labels">{steps.map((s) => toolTitle(s).label).slice(0, 3).join(' · ')}</span>
          <Icon name="chevron" size={13} className="chev" />
        </button>
      ) : (
        <div className="steps">
          {live && running && steps.length > visible.length && (
            <button className="task-more" onClick={() => setOpen(true)}>
              +{steps.length - visible.length} earlier steps
            </button>
          )}
          {visible.map((b) => (SUBAGENT.has(b.name) ? <TaskCard key={b.id} b={b} steps={subs.get(b.id) ?? []} /> : <Step key={b.id} b={b} />))}
          {open && steps.length > 2 && (
            <button className="group-collapse" onClick={() => setOpen(false)}>
              Fold steps
            </button>
          )}
        </div>
      )}
      {renders.length > 0 && (
        <div className="render-strip">
          {renders.map((r) => (
            <button key={r.id} className="render-thumb" onClick={() => actions.lightbox(r.image!)} title="Open the render">
              <img src={r.image} alt="Render" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ErrorCard({ text }: { text: string }) {
  return (
    <div className="error-card">
      <Icon name="alert" size={15} />
      <span>{text}</span>
    </div>
  );
}

type Segment = { kind: 'block'; block: Block; index: number } | { kind: 'steps'; steps: ToolBlock[]; key: string };

/** Consecutive tool calls (and subagents) become one timeline between the copilot's words. */
function segments(blocks: Block[]): Segment[] {
  const out: Segment[] = [];
  blocks.forEach((b, index) => {
    if (b.kind === 'tool' && b.parent) return;
    if (b.kind === 'tool') {
      const prev = out[out.length - 1];
      if (prev?.kind === 'steps') prev.steps.push(b);
      else out.push({ kind: 'steps', steps: [b], key: b.id });
      return;
    }
    if (b.kind === 'thinking' && !b.text.trim()) return;
    out.push({ kind: 'block', block: b, index });
  });
  return out;
}

export const AssistantMessage = memo(function AssistantMessage({ m, live }: { m: ChatMessage; live: boolean }) {
  const children = new Map<string, ToolBlock[]>();
  for (const b of m.blocks) if (b.kind === 'tool' && b.parent) children.set(b.parent, [...(children.get(b.parent) ?? []), b]);
  const working = live && !m.done;
  const segs = segments(m.blocks);
  const lastText = m.blocks.map((b, i) => (b.kind === 'text' ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  const text = m.blocks
    .map((b) => (b.kind === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n\n');
  return (
    <div className={`msg assistant${working ? ' live' : ''}`}>
      <div className="msg-avatar">
        <LiveMark size={24} working={working} glow={working} />
      </div>
      <div className="msg-body">
        {segs.map((s) => {
          if (s.kind === 'steps') return <StepGroup key={s.key} steps={s.steps} live={working} subs={children} />;
          const b = s.block;
          if (b.kind === 'text') {
            const t = working ? stripTrailer(b.text) : b.text;
            return t.trim() ? <Markdown key={s.index} text={t} streaming={working && s.index === lastText} /> : null;
          }
          if (b.kind === 'note') return <div key={s.index} className="note-pill">{b.text}</div>;
          if (b.kind === 'thinking') return <Thinking key={s.index} block={b} live={working} />;
          if (b.kind === 'error') return <ErrorCard key={s.index} text={b.text} />;
          return null;
        })}
        {m.done && <TurnFooter m={m} text={text} />}
      </div>
    </div>
  );
});

function TurnFooter({ m, text }: { m: ChatMessage; text: string }) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const rate = (r: 'up' | 'down', n = '') => {
    void actions.rate(m.id, r, n);
    setAsking(false);
  };
  return (
    <div className="turn-foot">
      <span className="msg-actions">
        {text && (
          <button onClick={() => copy(text, 'Reply copied')} title="Copy the reply">
            <Icon name="copy" size={14} />
          </button>
        )}
        <button className={m.rating === 'up' ? 'on' : ''} onClick={() => rate('up')} title="Good reply">
          <Icon name="thumbUp" size={14} />
        </button>
        <button className={m.rating === 'down' ? 'on' : ''} onClick={() => (m.rating === 'down' ? undefined : setAsking(true))} title="Something was off: note it in Kiln's feedback log">
          <Icon name="thumbDown" size={14} />
        </button>
      </span>
      {m.usage && (
        <span className="turn-usage">
          {formatDuration(m.usage.durationMs)} · {formatTokens(m.usage.inputTokens)} in · {formatTokens(m.usage.outputTokens)} out
          {m.usage.account ? ` · ${m.usage.account}` : ''}
        </span>
      )}
      {asking && (
        <form
          className="rate-note"
          onSubmit={(e) => {
            e.preventDefault();
            rate('down', note.trim());
          }}
        >
          <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What went wrong? (optional, goes to the watchdog log)" onKeyDown={(e) => e.key === 'Escape' && setAsking(false)} />
          <button type="submit">Send</button>
        </form>
      )}
    </div>
  );
}

export const UserMessage = memo(function UserMessage({ m, onEdit }: { m: ChatMessage; onEdit?: (text: string) => void }) {
  const text = m.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('');
  return (
    <div className="msg user">
      <div className="user-col">
        {m.from && (
          <div className="via-tag" title={`A brief sent for you by another app's assistant: Kiln's copilot decides how to build it.${m.effortWhy ? ` Effort picked by Kiln: ${m.effortWhy}.` : m.effort ? ' Effort chosen by the app.' : ''}`}>
            <Icon name="arrowUpRight" size={11} />
            via {m.from}
            {m.kind ? ` · ${{ new: 'new build', rework: 'rework', fix: 'fix', animate: 'animation' }[m.kind]}` : ''}
            {m.effort ? ` · ${m.effort} effort${m.effortWhy ? ' (auto)' : ''}` : ''}
          </div>
        )}
        {!m.from && m.effort && m.effortWhy && (
          <div className="via-tag" title={`Auto effort picked ${m.effort} for this request: ${m.effortWhy}. Pick a fixed level in the message box to override.`}>
            {m.effort} effort · {m.effortWhy}
          </div>
        )}
        <div className="bubble">
          {m.images && m.images.length > 0 && (
            <div className="bubble-images">
              {m.images.map((src) => (
                <button key={src} onClick={() => actions.lightbox(src)}>
                  <img src={src} alt="Reference" />
                </button>
              ))}
            </div>
          )}
          {text !== '(see image)' && <div className="bubble-text">{text}</div>}
        </div>
        <span className="msg-actions user-actions">
          <button onClick={() => copy(text)} title="Copy">
            <Icon name="copy" size={13} />
          </button>
          {onEdit && (
            <button onClick={() => onEdit(text)} title="Edit and send again">
              <Icon name="pencil" size={13} />
            </button>
          )}
        </span>
      </div>
    </div>
  );
});

/** The copilot at work: the falling-pixel mark, what it is doing right now, and for how long. */
export function WorkingBar({ m, onStop }: { m: ChatMessage | undefined; onStop: () => void }) {
  const now = useNow(true, 1000);
  const started = useRef(Date.now());
  const since = m?.createdAt ?? started.current;
  let activity = 'Getting started';
  let detail = '';
  if (m) {
    const tools = m.blocks.filter((b): b is ToolBlock => b.kind === 'tool');
    const run = [...tools].reverse().find((t) => t.status === 'running' && !t.parent);
    const sub = run && SUBAGENT.has(run.name) ? run : null;
    const last = m.blocks[m.blocks.length - 1];
    if (sub) {
      activity = `${sub.task?.type ?? 'Helper'}: ${(sub.input.description as string) ?? 'working'}`;
      detail = sub.task?.lastTool ? sub.task.lastTool.replace(/^mcp__\w+__/, '') : '';
    } else if (run) {
      activity = toolTitle(run).label;
      detail = run.name === 'mcp__blender__run_python' && run.input._streaming ? 'writing the code' : run.name === 'mcp__blender__run_python' ? 'running in Blender' : '';
    } else if (last?.kind === 'thinking' && !last.done) activity = 'Thinking';
    else if (last?.kind === 'text') activity = 'Writing';
    else if (tools.length) activity = 'Deciding the next step';
    const steps = tools.filter((t) => !t.parent).length;
    if (steps) detail = [detail, `${steps} step${steps === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  }
  return (
    <div className="working-bar">
      <PixelMark size={34} working />
      <div className="wb-text">
        <span className="wb-activity shimmer-text">{activity}…</span>
        <span className="wb-detail">
          {detail ? `${detail} · ` : ''}
          {formatDuration(Math.max(0, now - since))}
        </span>
      </div>
      <button className="wb-stop" onClick={onStop} title="Stop (the copilot finishes the current step first)">
        <Icon name="stop" size={12} />
        Stop
      </button>
    </div>
  );
}
