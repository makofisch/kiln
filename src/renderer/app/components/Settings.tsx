import { useEffect, useRef, useState, type ReactNode } from 'react';
import { actions, notify, useStore, type StorageRow } from '../store.ts';
import { Icon } from '../../common/Icon.tsx';
import { KilnMark } from '../../common/KilnMark.tsx';
import { ACCENT_COLORS } from '../../common/theme.ts';
import { ACCENTS, EFFORT_SETTINGS, type EffortSetting, type UsageWindow } from '../../../shared/types.ts';

// Settings, shown over the tab: opened from the Kiln logo in the tab strip, the login chip, or Ctrl+,.

const SECTIONS = [
  { id: 'general', label: 'General', icon: 'sliders' },
  { id: 'memory', label: 'Memory', icon: 'brain' },
  { id: 'accounts', label: 'Claude login', icon: 'user' },
  { id: 'viewer', label: 'Viewer', icon: 'cube' },
  { id: 'appearance', label: 'Appearance', icon: 'palette' },
  { id: 'data', label: 'Data & logs', icon: 'folder' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard' },
  { id: 'about', label: 'About', icon: 'info' },
] as const;

const EFFORT_NOTES: Record<EffortSetting, string> = {
  auto: 'Picked per request (default)',
  low: 'Fastest',
  medium: 'Quick edits',
  high: 'Balanced',
  xhigh: 'Complex builds, more careful',
  max: 'Best quality, slowest',
};

function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button className={`switch${on ? ' on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <span className="knob" />
    </button>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  const i = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div className="segmented" style={{ ['--n' as string]: options.length, ['--i' as string]: i }}>
      <span className="seg-thumb" />
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Row({ title, note, children, stack }: { title: string; note?: ReactNode; children?: ReactNode; stack?: boolean }) {
  return (
    <div className={`set-row${stack ? ' stack' : ''}`}>
      <div className="set-text">
        <div className="set-title">{title}</div>
        {note && <div className="set-note">{note}</div>}
      </div>
      {children && <div className="set-control">{children}</div>}
    </div>
  );
}

// --- sections ------------------------------------------------------------------------------------

function General() {
  const s = useStore((st) => st.app?.settings);
  if (!s) return null;
  return (
    <>
      <Row title="Effort" note="How hard the copilot thinks: the lever between speed and quality. Auto picks a level for each request from what it asks for (a question, an edit, a detailed rigged creature). Also in the message box." stack>
        <div className="effort-grid">
          {EFFORT_SETTINGS.map((e) => (
            <button key={e} className={`effort-card${e === s.effort ? ' on' : ''}`} onClick={() => actions.updateSettings({ effort: e })}>
              <span className="effort-name">{e}</span>
              <span className="effort-note">{EFFORT_NOTES[e]}</span>
            </button>
          ))}
        </div>
      </Row>
      <Row title="Subagents" note="On big builds the copilot may start helpers (modelers building parts in parallel, a critic reviewing). Faster on large jobs, but they spend extra usage. Off: it always works alone.">
        <Switch label="Subagents" on={s.subagents} onChange={(v) => actions.updateSettings({ subagents: v })} />
      </Row>
      <Row title="Reference research" note="When you ask for something specific (a creature from a film, a real animal, vehicle or landmark, “like X”), the copilot may first spend a few seconds searching the web and looking at reference images. It decides when that helps and skips it for generic requests. Off: it builds from memory.">
        <Switch label="Reference research" on={s.research} onChange={(v) => actions.updateSettings({ research: v })} />
      </Row>
      <Row title="Suggestion bubbles" note="Ideas above the message box: starters on a new project, the copilot’s follow-ups after each reply.">
        <Switch label="Suggestion bubbles" on={s.ui.suggestions} onChange={(v) => actions.updateSettings({ ui: { suggestions: v } })} />
      </Row>
      <Row title="Project names" note="New projects are named by the copilot after its first build, from what the model actually is. Rename one any time by clicking its name in the chat header." />
    </>
  );
}

function MemoryFact({ text, onSave, onDelete }: { text: string; onSave: (t: string) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) ref.current?.select();
  }, [editing]);
  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== text) onSave(draft.trim());
    else setDraft(text);
  };
  return (
    <li className={`fact${editing ? ' editing' : ''}`}>
      {editing ? (
        <input
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(text);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button className="fact-text" onClick={() => setEditing(true)} title="Click to edit">
          {text}
        </button>
      )}
      <button className="fact-btn" onClick={() => setEditing(true)} aria-label="Edit" title="Edit">
        <Icon name="pencil" size={13} />
      </button>
      <button className="fact-btn danger" onClick={onDelete} aria-label="Remove" title="Remove">
        <Icon name="trash" size={13} />
      </button>
    </li>
  );
}

function Memory() {
  const memory = useStore((s) => s.app?.memory);
  const enabled = useStore((s) => s.app?.settings.memory ?? true);
  const [adding, setAdding] = useState('');
  if (!memory) return null;
  const facts = memory.facts;
  const save = (list: string[]) => void actions.setMemory(list);
  return (
    <>
      <Row
        title="Remember me across projects"
        note="The copilot saves lasting preferences it notices (what you like, what bothers you) and every project’s copilot starts with them. Turned off, it neither reads nor saves anything."
      >
        <Switch label="Memory" on={enabled} onChange={(v) => actions.updateSettings({ memory: v })} />
      </Row>
      <div className={`memory-box${enabled ? '' : ' off'}`}>
        <div className="memory-head">
          <span>
            {facts.length ? `${facts.length} thing${facts.length === 1 ? '' : 's'} remembered` : 'Nothing remembered yet'}
            {!enabled && facts.length ? ' · not used while memory is off' : ''}
          </span>
          {facts.length > 0 && (
            <button className="link-btn danger" onClick={() => confirm('Forget everything the copilot remembers about you?') && save([])}>
              Forget all
            </button>
          )}
        </div>
        <ul className="facts">
          {facts.map((f, i) => (
            <MemoryFact key={`${i}:${f}`} text={f} onSave={(t) => save(facts.map((x, j) => (j === i ? t : x)))} onDelete={() => save(facts.filter((_, j) => j !== i))} />
          ))}
        </ul>
        <form
          className="fact-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (!adding.trim()) return;
            save([...facts, adding.trim()]);
            setAdding('');
          }}
        >
          <input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Add something for the copilot to know, e.g. “I export to Roblox, keep parts under 10k triangles”" />
          <button type="submit" disabled={!adding.trim()}>
            <Icon name="plus" size={14} />
          </button>
        </form>
        <div className="set-note small">Changes apply to each project’s next message. The list is also a plain file: {memory.file}</div>
      </div>
    </>
  );
}

function usageName(key: string) {
  if (key === 'five_hour') return '5-hour';
  if (key === 'seven_day') return 'Weekly';
  if (key.startsWith('seven_day_')) return `Weekly · ${key.slice(10).replace(/_/g, ' ')}`;
  return key.replace(/_/g, ' ');
}

function resets(u: UsageWindow) {
  if (!u.resetsAt) return '';
  const ms = u.resetsAt - Date.now();
  if (ms <= 0) return 'reset';
  if (ms < 3600_000) return `resets in ${Math.ceil(ms / 60_000)} min`;
  if (ms < 86400_000) return `resets in ${Math.round(ms / 3600_000)} h`;
  return `resets ${new Date(u.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

/**
 * Settings → Claude login. Kiln has one login, the same as Shuriken's: a build Shuriken asks for runs on the login
 * it sends with the brief, and everything typed here on this PC's Claude Code login. Signing in happens in Claude
 * Code itself (claude /login), never inside Kiln.
 */
function ClaudeLogin() {
  const login = useStore((s) => s.app?.login);
  const [checking, setChecking] = useState(false);
  if (!login) return null;
  const pc = login.pc;
  const windows = Object.entries(pc.usage).filter(([, u]) => u.utilization !== null);
  const check = async () => {
    setChecking(true);
    await actions.checkLogin();
    setChecking(false);
  };
  return (
    <>
      <Row title="Claude login: the same as Shuriken’s (this PC’s login)" note="A model Shuriken asks for is built on the Claude login Shuriken sends with it. Anything you type here runs on this PC’s Claude Code login." />
      <div className="acct-list">
        <div className={`acct-card active${pc.signedIn ? '' : ' signed-out'}`}>
          <div className="acct-top">
            <span className="acct-avatar">
              <Icon name="user" size={16} />
            </span>
            <div className="acct-id">
              <span className="acct-label static">This PC’s Claude login</span>
              <div className="acct-sub">{pc.signedIn ? [pc.email ?? 'Signed in', pc.plan].filter(Boolean).join(' · ') : 'Not signed in'}</div>
            </div>
            <span className={`acct-badge${pc.signedIn ? '' : ' off'}`}>{pc.signedIn ? 'Signed in' : 'Signed out'}</span>
          </div>
          {!pc.signedIn && (
            <div className="acct-warn">
              Sign in through Claude Code: run <code>claude /login</code> in a terminal, then press Check again.
            </div>
          )}
          {windows.length > 0 ? (
            <div className="usage-list">
              {windows.map(([k, u]) => {
                const pct = Math.round((u.utilization ?? 0) * 100);
                return (
                  <div key={k} className={`usage ${u.status === 'rejected' ? 'bad' : pct >= 80 ? 'warn' : 'ok'}`}>
                    <span className="usage-name">{usageName(k)}</span>
                    <span className="usage-bar">
                      <span style={{ width: `${Math.min(100, pct)}%` }} />
                    </span>
                    <span className="usage-pct">{pct}%</span>
                    <span className="usage-reset">{resets(u)}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            pc.signedIn && <div className="set-note small">Usage shows after the first message on this login.</div>
          )}
        </div>
      </div>
      {login.last && (
        <div className="set-note small acct-why">
          Latest turn ({new Date(login.last.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}): {login.last.label}, because {login.last.why}.
        </div>
      )}
      <div className="btn-row">
        <button className="btn ghost" disabled={checking} onClick={() => void check()}>
          <Icon name="refresh" size={14} /> {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
      <div className="set-note small">Kiln has no sign-in of its own and never sees your password. Claude Code keeps this login in {pc.dir}.</div>
    </>
  );
}

function Viewer() {
  const v = useStore((s) => s.app?.settings.viewer);
  if (!v) return null;
  return (
    <>
      <Row title="Lighting" note="Auto uses a scene’s own lights and sky when it has them (night scenes, lamps); Studio always shows neutral, even light. L toggles it in the viewer.">
        <Segmented
          value={v.lighting}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'studio', label: 'Studio' },
          ]}
          onChange={(x) => actions.updateSettings({ viewer: { lighting: x } })}
        />
      </Row>
      <Row title="Brightness" note="Exposure of the live viewer. Renders and exports are not affected.">
        <div className="slider-wrap">
          <input type="range" min={0.5} max={1.6} step={0.05} value={v.exposure} onChange={(e) => actions.updateSettings({ viewer: { exposure: Number(e.target.value) } })} />
          <span className="slider-val">{v.exposure.toFixed(2)}×</span>
          {Math.abs(v.exposure - 1) > 0.001 && (
            <button className="link-btn" onClick={() => actions.updateSettings({ viewer: { exposure: 1 } })}>
              Reset
            </button>
          )}
        </div>
      </Row>
      <Row title="Glow" note="The halo around emissive materials (lamps, screens, neon) in the viewer. Roblox-like approximates Studio's default Bloom, where only really bright (Neon) surfaces glow.">
        <Segmented
          value={v.glow ?? (v.bloom ? 'normal' : 'off')}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'subtle', label: 'Subtle' },
            { value: 'normal', label: 'Normal' },
            { value: 'strong', label: 'Strong' },
            { value: 'roblox', label: 'Roblox' },
          ]}
          onChange={(x) => actions.updateSettings({ viewer: { glow: x, bloom: x !== 'off' } })}
        />
      </Row>
      <Row title="Grid and shadows" note="Shown when a project opens. G toggles it in the viewer.">
        <Switch label="Grid" on={v.grid} onChange={(x) => actions.updateSettings({ viewer: { grid: x } })} />
      </Row>
    </>
  );
}

function Appearance() {
  const ui = useStore((s) => s.app?.settings.ui);
  if (!ui) return null;
  return (
    <>
      <Row title="Accent color" note="Highlights, buttons and selections. The Kiln mark keeps its colors.">
        <div className="swatches">
          {ACCENTS.map((a) => (
            <button key={a} className={`swatch${ui.accent === a ? ' on' : ''}`} style={{ ['--sw' as string]: ACCENT_COLORS[a].a, ['--sw2' as string]: ACCENT_COLORS[a].b }} onClick={() => actions.updateSettings({ ui: { accent: a } })} title={ACCENT_COLORS[a].name} aria-label={ACCENT_COLORS[a].name} />
          ))}
        </div>
      </Row>
      <Row title="Chat text size">
        <Segmented
          value={ui.textSize}
          options={[
            { value: 'small', label: 'Small' },
            { value: 'normal', label: 'Normal' },
            { value: 'large', label: 'Large' },
          ]}
          onChange={(x) => actions.updateSettings({ ui: { textSize: x } })}
        />
      </Row>
      <Row title="Reduce motion" note="Turns off interface animations. The working indicators stay, without movement.">
        <Switch label="Reduce motion" on={ui.reduceMotion} onChange={(x) => actions.updateSettings({ ui: { reduceMotion: x } })} />
      </Row>
    </>
  );
}

function Data() {
  const app = useStore((s) => s.app);
  if (!app) return null;
  const items: Array<{ id: 'projects' | 'logs' | 'watchdog' | 'data'; title: string; note: string }> = [
    { id: 'projects', title: 'Projects', note: app.projectsDir },
    { id: 'logs', title: 'Conversation logs', note: 'Every chat, complete, as JSONL and readable Markdown' },
    { id: 'watchdog', title: 'Watchdog report', note: 'Complaints, bugs, wishes and trouble, gathered from your chats' },
    { id: 'data', title: 'Kiln data folder', note: app.dataDir },
  ];
  return (
    <div className="open-list">
      {items.map((i) => (
        <button key={i.id} className="open-item" onClick={() => actions.openPath(i.id)}>
          <Icon name="folder" size={16} />
          <span className="open-text">
            <span className="set-title">{i.title}</span>
            <span className="set-note">{i.note}</span>
          </span>
          <Icon name="arrowUpRight" size={14} />
        </button>
      ))}
      <Storage />
    </div>
  );
}

const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

/** What the projects take on disk: free old undo steps, or move a project to the trash. */
function Storage() {
  const [rows, setRows] = useState<StorageRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  useEffect(() => {
    void actions.storage().then(setRows, () => setRows([]));
  }, []);
  if (!rows) return <div className="set-note small">Measuring the projects…</div>;
  const total = rows.reduce((n, r) => n + r.bytes, 0);
  const undo = rows.reduce((n, r) => n + r.history + r.viewer, 0);
  const tidy = async () => {
    setBusy(true);
    try {
      const r = await actions.tidyStorage();
      setRows(r.projects);
      notify('info', r.freed > 0 ? `Freed ${size(r.freed)}.` : 'Nothing to free: closed projects are already tidy.');
    } catch (e) {
      notify('error', (e as Error).message);
    }
    setBusy(false);
  };
  // Open projects can be deleted too (Kiln 0.8 greyed them out, including every model Shuriken had open): windows
  // showing one go back to their start page, a working copilot is stopped. The current tab's project included.
  const remove = async (r: StorageRow) => {
    if (await actions.confirmDelete(r)) setRows((list) => (list ?? []).filter((x) => x.id !== r.id));
  };
  return (
    <div className="storage">
      <div className="storage-head">
        <div className="set-text">
          <div className="set-title">Storage</div>
          <div className="set-note">
            {rows.length} projects, {size(total)}. Undo steps and viewer files: {size(undo)}.
          </div>
        </div>
        <button className="btn small" disabled={busy} onClick={() => void tidy()} title="In closed projects: keeps the last 3 undo steps and the newest viewer file, removes older Roblox bakes">
          {busy ? 'Freeing…' : 'Free up space'}
        </button>
      </div>
      {(all ? rows : rows.slice(0, 8)).map((r) => (
        <div key={r.id} className="storage-row">
          <span className="storage-name" title={r.id}>
            {r.title}
          </span>
          <span className="set-note small">{size(r.bytes)}</span>
          <button className="btn small ghost danger" title={r.working ? 'Move this project to the trash (its copilot stops)' : 'Move this project to the trash (kept for a week)'} onClick={() => void remove(r)}>
            Delete
          </button>
        </div>
      ))}
      {rows.length > 8 && (
        <button className="btn small ghost" onClick={() => setAll((a) => !a)}>
          {all ? 'Show the biggest only' : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}

const KEYS: Array<[string, string]> = [
  ['New tab', 'Ctrl+Shift+N · Ctrl+T'],
  ['Close tab', 'Ctrl+W'],
  ['Next / previous tab', 'Ctrl+Tab · Ctrl+Shift+Tab'],
  ['Go to tab 1–9', 'Ctrl+1…9'],
  ['Move tab to its own window', 'Ctrl+Shift+D · drag it off the strip'],
  ['Settings', 'Ctrl+,'],
  ['Send · new line', 'Enter · Shift+Enter'],
  ['Frame the subject or selection', 'F · double-click'],
  ['Front · right · top · 3/4 view', '1 · 3 · 7 · 0'],
  ['Wireframe · clay · grid · turntable', 'W · C · G · T'],
  ['Scene or studio lighting', 'L'],
  ['Deselect · close', 'Esc'],
];

function Shortcuts() {
  return (
    <div className="keys">
      {KEYS.map(([a, b]) => (
        <div key={a} className="key-row">
          <span>{a}</span>
          <kbd>{b}</kbd>
        </div>
      ))}
    </div>
  );
}

function About() {
  const app = useStore((s) => s.app);
  const blender = useStore((s) => s.blender);
  return (
    <div className="about">
      <KilnMark size={44} glow />
      <div>
        <div className="about-name">Kiln {app?.version}</div>
        <div className="set-note">Headless Blender with an Opus 5.5 copilot, on your own Claude subscription.</div>
      </div>
      <div className="about-facts">
        <Row title="Blender" note={blender.version ? `${blender.version} · ${app?.blender.path ?? ''}` : (app?.blender.path ?? 'Not found')} />
        <Row title="Model" note="claude-opus-5-5 (modeler and critic subagents use the same model)" />
      </div>
    </div>
  );
}

// --- the panel -----------------------------------------------------------------------------------

export function SettingsPanel() {
  const section = useStore((s) => s.settingsSection);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (!section) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement).closest('input')) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (!section) return null;
  const close = () => {
    setClosing(true);
    setTimeout(() => {
      setClosing(false);
      actions.closeSettings();
    }, 160);
  };
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const body: Record<string, ReactNode> = {
    general: <General />,
    memory: <Memory />,
    accounts: <ClaudeLogin />,
    viewer: <Viewer />,
    appearance: <Appearance />,
    data: <Data />,
    shortcuts: <Shortcuts />,
    about: <About />,
  };
  return (
    <div className={`settings-scrim${closing ? ' closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="settings" role="dialog" aria-label="Settings">
        <nav className="settings-nav">
          <div className="settings-brand">
            <KilnMark size={18} />
            Settings
          </div>
          {SECTIONS.map((s) => (
            <button key={s.id} className={`nav-item${s.id === current.id ? ' on' : ''}`} onClick={() => actions.openSettings(s.id)}>
              <Icon name={s.icon} size={15} />
              {s.label}
            </button>
          ))}
        </nav>
        <section className="settings-body" key={current.id}>
          <header className="settings-head">
            <h2>{current.label}</h2>
            <button className="settings-close" onClick={close} aria-label="Close settings" title="Close (Esc)">
              <Icon name="x" size={16} />
            </button>
          </header>
          <div className="settings-content">{body[current.id]}</div>
        </section>
      </div>
    </div>
  );
}
