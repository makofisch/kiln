import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { actions, EMBED, kilnHost, notify, tabApi, useStore } from '../store.ts';
import { viewer } from '../viewer/engine.ts';
import { AssistantMessage, UserMessage, WorkingBar } from './Blocks.tsx';
import { Icon } from '../../common/Icon.tsx';
import { PixelMark } from '../../common/PixelMark.tsx';
import { pickEffort, type EffortPick } from '../../../shared/effort.ts';
import { EFFORT_SETTINGS, type EffortSetting, type ImageUpload, type Suggestion } from '../../../shared/types.ts';
import { GENERIC, selectionIdeas, starterIdeas, surprise } from '../lib/ideas.ts';


// --- suggestion bubbles ------------------------------------------------------------------------------
// Each bubble shows a short label; clicking puts its fuller request in the message box to send or edit.

export function Suggestions({ onPick, fresh }: { onPick: (text: string) => void; fresh?: boolean }) {
  const suggestions = useStore((s) => s.suggestions);
  const selected = useStore((s) => s.selected);
  const running = useStore((s) => s.running);
  const hasMessages = useStore((s) => s.messages.length > 0);
  const enabled = useStore((s) => s.app?.settings.ui.suggestions ?? true);
  const [ideas, setIdeas] = useState(() => starterIdeas(5));
  const [spin, setSpin] = useState(0);
  let items: Suggestion[];
  let kind: 'ideas' | 'next' | 'selection';
  if (selected) {
    items = selectionIdeas(selected);
    kind = 'selection';
  } else if (suggestions.length) {
    items = suggestions;
    kind = 'next';
  } else if (fresh || !hasMessages) {
    items = ideas;
    kind = 'ideas';
  } else {
    items = GENERIC;
    kind = 'next';
  }
  if (!enabled) return null;
  if (running) return <div className="suggestions idle" />;
  const reroll = () => {
    setIdeas(starterIdeas(5, ideas.map((i) => i.label)));
    setSpin((n) => n + 1);
  };
  return (
    <div className={`suggestions ${kind}`} key={`${kind}:${items.map((i) => i.label).join('|')}`}>
      {items.map((s, i) => (
        <button key={s.label} className="sugg" style={{ animationDelay: `${i * 45}ms` }} onClick={() => onPick(s.prompt)} title={s.prompt}>
          {kind === 'selection' ? <Icon name="target" size={12} /> : kind === 'next' ? <Icon name="spark" size={12} /> : null}
          {s.label}
        </button>
      ))}
      {kind === 'ideas' && (
        <>
          <button className="sugg surprise" style={{ animationDelay: `${items.length * 45}ms` }} onClick={() => onPick(surprise().prompt)} title="A random idea with a random style">
            <Icon name="dice" size={12} />
            Surprise me
          </button>
          <button className="bubble-shuffle" onClick={reroll} title="Other ideas" aria-label="Other ideas">
            <span key={spin} className="shuffle-icon">
              <Icon name="shuffle" size={13} />
            </span>
          </button>
        </>
      )}
    </div>
  );
}

// --- composer ------------------------------------------------------------------------------------------

const SLASH = [
  { cmd: '/feedback', note: 'A note for Kiln’s local feedback log (not sent to the copilot)' },
  { cmd: '/bug', note: 'Report something broken' },
  { cmd: '/idea', note: 'Suggest an improvement' },
];

/**
 * A reference video as one sheet of timed frames (decoded by the browser, on the GPU): the copilot reads
 * motion timing from it (a stride, a strike, a landing). Up to 16 frames over the first 12 seconds.
 */
async function videoSheet(file: File): Promise<ImageUpload | null> {
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = url;
    await new Promise<void>((ok, bad) => {
      v.onloadeddata = () => ok();
      v.onerror = () => bad(new Error('unreadable video'));
    });
    const span = Math.min(v.duration || 0, 12);
    if (!span) return null;
    const n = span < 2 ? 8 : span < 5 ? 12 : 16;
    const cols = 4;
    const rows = Math.ceil(n / cols);
    const w = 320;
    const h = Math.round((w * (v.videoHeight || 9)) / (v.videoWidth || 16));
    const c = document.createElement('canvas');
    c.width = cols * w;
    c.height = rows * (h + 18);
    const g = c.getContext('2d')!;
    g.fillStyle = '#121418';
    g.fillRect(0, 0, c.width, c.height);
    g.font = '600 13px monospace';
    for (let i = 0; i < n; i++) {
      const t = (span * i) / (n - 1);
      v.currentTime = Math.min(t, (v.duration || span) - 0.001);
      await new Promise<void>((ok) => {
        v.onseeked = () => ok();
      });
      const x = (i % cols) * w;
      const y = Math.floor(i / cols) * (h + 18);
      g.drawImage(v, x, y + 18, w, h);
      g.fillStyle = '#ffb454';
      g.fillText(`${t.toFixed(2)} s`, x + 6, y + 13);
    }
    notify('info', `${file.name}: ${n} frames over ${span.toFixed(1)} s attached as one timed sheet.`);
    return { name: `${file.name.replace(/\.[^.]+$/, '')}-frames.jpg`, dataUrl: c.toDataURL('image/jpeg', 0.85) };
  } catch (e) {
    notify('warn', `${file.name}: ${(e as Error).message}`);
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function readImage(file: File): Promise<ImageUpload | null> {
  if (file.type.startsWith('video/')) return videoSheet(file);
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return Promise.resolve(null);
  if (file.size > 8 * 1024 * 1024) {
    notify('warn', `${file.name} is over 8 MB; skipped.`);
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, dataUrl: r.result as string });
    r.onerror = () => resolve(null);
    r.readAsDataURL(file);
  });
}

// Measured on real builds: medium took 1–5 min, max 10–14 min for the same kind of request.
const EFFORT_NOTES: Record<EffortSetting, string> = {
  auto: 'Picked per request: quick for edits, deepest for detailed builds',
  low: 'Fastest',
  medium: 'Quick builds and edits',
  high: 'Balanced: more care',
  xhigh: 'Careful: complex builds, hero assets',
  max: 'Deepest thinking, best quality, slowest',
};

/** `pick`: with Auto on, the level the draft in the message box would run at. */
function EffortPill({ pick }: { pick: EffortPick | null }) {
  const effort = useStore((s) => s.app?.settings.effort ?? 'auto');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="effort-wrap" ref={ref}>
      <button
        className={`effort-pill${open ? ' on' : ''}`}
        onClick={() => setOpen(!open)}
        title={effort === 'auto' ? (pick ? `Auto effort: this request would run at ${pick.effort} (${pick.why}). Click to choose a level yourself.` : 'Auto effort: Kiln picks a level for each request from what it asks for') : 'Speed or quality: how hard the copilot thinks'}
      >
        <span className="model">Opus 5.5</span>
        <span className="lvl">
          {effort}
          {effort === 'auto' && pick ? ` · ${pick.effort}` : ''}
        </span>
      </button>
      {open && (
        <div className="menu glass up">
          <div className="menu-title">Effort: speed ↔ quality</div>
          {EFFORT_SETTINGS.map((e) => (
            <button
              key={e}
              className={`menu-item effort${e === effort ? ' sel' : ''}`}
              onClick={() => {
                void actions.setEffort(e);
                setOpen(false);
              }}
            >
              <span className="effort-name">{e}</span>
              <span className="effort-note">{EFFORT_NOTES[e]}</span>
              {e === effort && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Composer({ draft, setDraft, autoFocus, big }: { draft: string; setDraft: (s: string) => void; autoFocus?: boolean; big?: boolean }) {
  const running = useStore((s) => s.running);
  const selected = useStore((s) => s.selected);
  const blender = useStore((s) => s.blender);
  const inProject = useStore((s) => !!s.projectId);
  const [images, setImages] = useState<ImageUpload[]>([]);
  const [drag, setDrag] = useState(false);
  const [sending, setSending] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft]);

  // Re-fit when the width changes (window resize, chat splitter), not only when typing.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w) return;
      w = el.clientWidth;
      el.style.height = '0px';
      el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const focus = () => ta.current?.focus();
    window.addEventListener('kiln:focus-composer', focus);
    return () => window.removeEventListener('kiln:focus-composer', focus);
  }, []);

  const addFiles = async (files: FileList | File[]) => {
    const read = (await Promise.all([...files].map(readImage))).filter((x): x is ImageUpload => !!x);
    if (read.length) setImages((cur) => [...cur, ...read].slice(0, 6));
  };

  const attachView = () => {
    const v = viewer.current;
    if (!v?.hasModel) return notify('info', 'The scene is empty: nothing to capture yet.');
    setImages((cur) => [...cur, { name: 'my-view.jpg', dataUrl: v.snapshot(1024, 0.85) }].slice(0, 6));
  };

  const isNote = /^\/(feedback|bug|idea|note)\b/i.test(draft.trim());
  const slash = /^\/[a-z]*$/i.test(draft) ? SLASH.filter((c) => c.cmd.startsWith(draft.toLowerCase())) : [];
  const lock = useStore((s) => s.lock);
  const fiveHour = useStore((s) => {
    return s.app?.login.pc.usage.five_hour?.utilization ?? null;
  });
  // While the copilot works a message is still sent: it takes it in at its next step (no waiting, nothing thrown away).
  const canSend = (draft.trim() || images.length) && (!lock || isNote) && !sending && blender.status !== 'missing';
  // With Auto effort: what this draft would run at (the same rules the core applies when it is sent).
  const autoOn = useStore((s) => (s.app?.settings.effort ?? 'auto') === 'auto');
  const sceneEmpty = useStore((s) => (s.scene.summary?.objects ?? 0) === 0);
  const autoPick = autoOn && !isNote && !running && draft.trim().length > 2 ? pickEffort({ text: draft, images: images.length, sceneEmpty }) : null;
  const send = async () => {
    if (!canSend) return;
    setSending(true);
    const ok = await actions.send(draft.trim(), isNote ? [] : images, viewer.current?.viewInfo() ?? null);
    setSending(false);
    if (ok) {
      setDraft('');
      if (!isNote) setImages([]);
    }
  };

  return (
    <div
      className={`composer${drag ? ' drag' : ''}${running ? ' running' : ''}${big ? ' big' : ''}${isNote ? ' note' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        void addFiles(e.dataTransfer.files);
      }}
    >
      {(images.length > 0 || selected) && (
        <div className="composer-attachments">
          {selected && (
            <span className="chip selection" title="The copilot is told this object is selected">
              <Icon name="target" size={13} />
              {selected}
              <button onClick={() => actions.select(null)} aria-label="Deselect">
                <Icon name="x" size={12} />
              </button>
            </span>
          )}
          {images.map((img, i) => (
            <span key={i} className="thumb">
              <img src={img.dataUrl} alt={img.name} />
              <button onClick={() => setImages(images.filter((_, j) => j !== i))} aria-label="Remove image">
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {fiveHour !== null && fiveHour >= 0.9 && !running && !isNote && (
        <div className="usage-warn">
          <Icon name="alert" size={13} />
          <span>
            Your 5-hour usage is at {Math.round(fiveHour * 100)}%.
          </span>
        </div>
      )}
      {lock && !isNote && (
        <div className="lock-banner">
          <PixelMark size={16} working />
          <span>{lock.by} is building this model. Chat and undo resume when it's done.</span>
        </div>
      )}
      {slash.length > 0 && (
        <div className="slash-menu">
          {slash.map((c) => (
            <button
              key={c.cmd}
              onMouseDown={(e) => {
                e.preventDefault();
                setDraft(`${c.cmd} `);
                ta.current?.focus();
              }}
            >
              <span className="slash-cmd">{c.cmd}</span>
              <span className="slash-note">{c.note}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        value={draft}
        autoFocus={autoFocus}
        placeholder={running ? 'Working… add or change something and it takes it in as it goes' : selected ? `Ask about ${selected}, or anything else…` : big ? 'Describe an object or a scene…' : 'Describe what to build or change…'}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.key === 'Tab' || e.key === 'Enter') && slash.length === 1 && draft.trim() !== slash[0]!.cmd) {
            e.preventDefault();
            setDraft(`${slash[0]!.cmd} `);
            return;
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.length) {
            e.preventDefault();
            void addFiles(files);
          }
        }}
        rows={1}
      />
      <div className="composer-row">
        <button className="icon-btn" onClick={() => fileInput.current?.click()} title="Attach reference images (or paste / drop them)">
          <Icon name="paperclip" size={17} />
        </button>
        {inProject && (
          <button className="icon-btn" onClick={attachView} title="Attach what you see in the viewer">
            <Icon name="camera" size={17} />
          </button>
        )}
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime" multiple hidden onChange={(e) => e.target.files && void addFiles(e.target.files)} />
        <span className="composer-hint">{isNote ? 'Saved to the watchdog log, not sent to the copilot' : 'Type / for feedback commands'}</span>
        <EffortPill pick={autoPick} />
        {running && !isNote && !draft.trim() && !images.length ? (
          <button className="send stop" onClick={() => void actions.stop()} title="Stop">
            <Icon name="stop" size={14} />
          </button>
        ) : (
          <button className="send" onClick={() => void send()} disabled={!canSend} title={isNote ? 'Save note' : running ? 'Send now: the copilot takes it in while it works' : 'Send'}>
            {sending ? <PixelMark size={18} working /> : <Icon name={isNote ? 'check' : 'send'} size={17} />}
          </button>
        )}
      </div>
      {drag && <div className="drop-hint">Drop reference images</div>}
    </div>
  );
}

/** Buttons of the app hosting Kiln (Shuriken): use this model there, dock/undock, settings. */
export function HostButtons({ start }: { start?: boolean }) {
  const project = useStore((s) => s.project);
  const [dock, setDock] = useState(() => kilnHost?.dockState() ?? 'docked');
  if (!EMBED) return null;
  const hostName = kilnHost?.app === 'shuriken' ? 'Shuriken' : (kilnHost?.app ?? 'the host app');
  return (
    <div className="host-buttons">
      {!start && project && kilnHost && (
        <button className="host-use" onClick={() => void actions.useInHost()} title={`Add this model to your ${hostName} project (as Roblox parts)`}>
          <Icon name="arrowUpRight" size={13} />
          Use in {hostName}
        </button>
      )}
      {!start && project && typeof kilnHost?.sendToStudio === 'function' && (
        <button className="host-use" onClick={() => void actions.sendToStudio('model')} title="Import this model into Roblox Studio, placed where Studio's camera looks (through Shuriken)">
          <Icon name="arrowUpRight" size={13} />
          To Studio
        </button>
      )}
      {kilnHost && (
        <button
          className="icon-btn sm"
          title={dock === 'docked' ? 'Undock: move Kiln to its own window' : `Dock back into ${hostName}`}
          onClick={() => {
            const host = kilnHost!;
            host.toggleDock();
            setTimeout(() => setDock(host.dockState()), 150);
          }}
        >
          <Icon name={dock === 'docked' ? 'arrowUpRight' : 'layers'} size={15} />
        </button>
      )}
      <button className="icon-btn sm" title="Kiln settings (Ctrl+,)" onClick={() => actions.openSettings()}>
        <Icon name="gear" size={15} />
      </button>
    </div>
  );
}

// --- chat panel ----------------------------------------------------------------------------------------

function ProjectHeader() {
  const project = useStore((s) => s.project);
  const blender = useStore((s) => s.blender);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  if (!project) return <div className="chat-head" />;
  const back = EMBED ? (
    <button className="icon-btn sm embed-back" title="All projects" onClick={() => actions.home()}>
      <Icon name="chevron" size={15} />
    </button>
  ) : null;
  const label: Record<string, string> = { missing: 'Blender not found', starting: 'Starting Blender', ready: 'Blender', busy: 'Blender working', restarting: 'Restarting Blender', failed: 'Blender failed' };
  return (
    <div className={`chat-head${EMBED ? ' embedded' : ''}`}>
      {back}
      {editing ? (
        <form
          className="title-edit"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) void actions.rename(title.trim());
            setEditing(false);
          }}
        >
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => setEditing(false)} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)} maxLength={40} />
        </form>
      ) : (
        <button
          key={project.title}
          className={`project-title${project.title === 'New project' ? ' unnamed' : ''}`}
          title={project.title === 'New project' ? 'Named by the copilot after its first build · click to name it yourself' : 'Rename'}
          onClick={() => {
            setTitle(project.title === 'New project' ? '' : project.title);
            setEditing(true);
          }}
        >
          {project.title}
          <Icon name="pencil" size={13} />
        </button>
      )}
      <span className={`blender-dot ${blender.status}`} title={blender.detail ?? ''}>
        <span />
        {label[blender.status]}
        {blender.version && <em>{blender.version.replace(/\s*LTS/, '')}</em>}
      </span>
      <HostButtons />
      {tabApi && (
        <button className="icon-btn sm" title="Show the project folder" onClick={() => tabApi?.openPath('project', project.id)}>
          <Icon name="folder" size={15} />
        </button>
      )}
    </div>
  );
}

export function Chat() {
  const messages = useStore((s) => s.messages);
  const running = useStore((s) => s.running);
  const [draft, setDraft] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // A first message that made the project but could not be sent: back into the box, not lost.
  const unsent = useStore((s) => s.unsent);
  useEffect(() => {
    if (!unsent) return;
    setDraft((d) => d || unsent);
    actions.takeUnsent();
  }, [unsent]);
  const editMessage = useCallback((t: string) => {
    setDraft(t);
    window.dispatchEvent(new Event('kiln:focus-composer'));
  }, []);

  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <aside className="chat">
      <ProjectHeader />
      <div
        className="chat-scroll"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="messages">
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <UserMessage key={m.id} m={m} onEdit={editMessage} />
            ) : (
              <AssistantMessage key={m.id} m={m} live={running && i === messages.length - 1} />
            ),
          )}
        </div>
        {running && <WorkingBar m={[...messages].reverse().find((m) => m.role === 'assistant')} onStop={() => void actions.stop()} />}
      </div>
      <Suggestions
        onPick={(t) => {
          setDraft(t);
          window.dispatchEvent(new Event('kiln:focus-composer'));
        }}
      />
      <Composer draft={draft} setDraft={setDraft} />
    </aside>
  );
}
