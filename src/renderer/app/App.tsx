import { useEffect, useRef, useState } from 'react';
import { Chat, Composer, HostButtons, Suggestions } from './components/Chat.tsx';
import { Viewer } from './components/Viewer.tsx';
import { SettingsPanel } from './components/Settings.tsx';
import { applyUi } from '../common/theme.ts';
import { Icon } from '../common/Icon.tsx';
import { KilnMark } from '../common/KilnMark.tsx';
import { PixelMark } from '../common/PixelMark.tsx';
import { actions, notify, useStore } from './store.ts';
import { formatTokens } from './lib/text.ts';
import type { ProjectSummary } from '../../shared/types.ts';

function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

function Recent({ projects }: { projects: ProjectSummary[] }) {
  const [all, setAll] = useState(false);
  if (!projects.length) return null;
  return (
    <section className="recent">
      <div className="recent-head">
        <Icon name="clock" size={14} />
        Recent projects
        <button className="recent-all" onClick={() => setAll((a) => !a)}>
          {all ? 'Hide the full list' : 'All projects'}
        </button>
      </div>
      {all ? (
        <AllProjects />
      ) : (
        <div className="recent-grid">
          {projects.slice(0, 12).map((p, i) => (
            <div key={p.id} className="card" style={{ animationDelay: `${120 + i * 35}ms` }}>
              <button className="card-open" onClick={() => void actions.open(p.id)}>
                <div className="card-thumb">
                  {p.thumb ? <img src={p.thumb} alt="" loading="lazy" /> : <KilnMark size={34} />}
                  {p.working && (
                    <span className="card-live">
                      <PixelMark size={14} working /> working
                    </span>
                  )}
                  {p.open && !p.working && <span className="card-live">open</span>}
                  {p.linked && <span className="card-linked">Shuriken</span>}
                </div>
                <div className="card-body">
                  <span className="card-title">{p.title}</span>
                  <span className="card-meta">
                    {ago(p.updatedAt)}
                    {p.objects ? ` · ${p.objects} objects · ${formatTokens(p.tris)} tris` : ''}
                  </span>
                </div>
              </button>
              <button className="card-del" title="Delete this project (to the trash, kept a week)" aria-label={`Delete ${p.title}`} onClick={() => void actions.confirmDelete(p)}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Every project, filterable, with delete (one or several at once). */
function AllProjects() {
  const live = useStore((s) => s.app?.projects);
  const [q, setQ] = useState('');
  const [list, setList] = useState<{ total: number; matched: number; projects: ProjectSummary[] } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(200);
  // Reload when the filter changes and whenever the app's project list does (a delete, a new build, a rename).
  useEffect(() => {
    const t = setTimeout(() => void actions.listProjects(q, limit).then(setList, () => setList({ total: 0, matched: 0, projects: [] })), 150);
    return () => clearTimeout(t);
  }, [q, limit, live]);
  if (!list) return <div className="all-note">Loading the projects…</div>;
  const toggle = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const removeMany = async () => {
    const rows = list.projects.filter((p) => picked.has(p.id));
    if (!rows.length) return;
    const working = rows.filter((p) => p.working).length;
    if (!window.confirm(`Delete ${rows.length} project${rows.length > 1 ? 's' : ''}?\n\nThey move to the trash in the projects folder (.trash) and are removed for good after a week.${working ? `\n\n${working} of them ${working > 1 ? 'are' : 'is'} working: that stops.` : ''}`)) return;
    setBusy(true);
    let failed = 0;
    for (const p of rows) {
      try {
        const r = await actions.deleteProject(p.id);
        if (!r.ok) failed++;
      } catch {
        failed++;
      }
    }
    setBusy(false);
    setPicked(new Set());
    notify(failed ? 'error' : 'info', failed ? `${rows.length - failed} deleted, ${failed} could not be (see the message on each).` : `${rows.length} project${rows.length > 1 ? 's' : ''} moved to the trash.`);
  };
  return (
    <div className="all-projects">
      <div className="all-bar">
        <input className="all-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${list.total} projects by name`} />
        <button className="btn small ghost" disabled={!list.projects.length} onClick={() => setPicked((cur) => (cur.size ? new Set() : new Set(list.projects.map((p) => p.id))))}>
          {picked.size ? 'Clear selection' : 'Select shown'}
        </button>
        <button className="btn small danger" disabled={!picked.size || busy} onClick={() => void removeMany()}>
          <Icon name="trash" size={13} /> {busy ? 'Deleting…' : `Delete${picked.size ? ` ${picked.size}` : ''}`}
        </button>
      </div>
      <div className="all-list">
        {list.projects.map((p) => (
          <div key={p.id} className={`all-row${picked.has(p.id) ? ' picked' : ''}`}>
            <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} aria-label={`Select ${p.title}`} />
            <button className="all-open" onClick={() => void actions.open(p.id)} title={p.id}>
              <span className="all-title">{p.title}</span>
              <span className="all-meta">
                {ago(p.updatedAt)}
                {p.objects ? ` · ${p.objects} objects · ${formatTokens(p.tris)} tris` : ''}
                {p.linked ? ' · Shuriken' : ''}
                {p.working ? ' · working' : p.open ? ' · open' : ''}
              </span>
            </button>
            <button className="icon-btn sm" title="Delete this project" aria-label={`Delete ${p.title}`} onClick={() => void actions.confirmDelete(p)}>
              <Icon name="trash" size={13} />
            </button>
          </div>
        ))}
        {!list.projects.length && <div className="all-note">{q ? 'No project has that in its name.' : 'No projects yet.'}</div>}
      </div>
      {list.matched > list.projects.length && (
        <button className="btn small ghost" onClick={() => setLimit((l) => l + 400)}>
          Show more ({list.matched - list.projects.length} not shown)
        </button>
      )}
    </div>
  );
}

/** The start page's mark: settles in from pixels, and plays the working animation once on hover. */
function HeroMark() {
  const [play, setPlay] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <div
      className={`hero-mark${play ? ' playing' : ''}`}
      onPointerEnter={() => {
        if (play) return;
        setPlay(true);
        timer.current = setTimeout(() => setPlay(false), 1900);
      }}
    >
      <PixelMark size={76} intro working={play} />
    </div>
  );
}

function StartPage() {
  const app = useStore((s) => s.app);
  const [draft, setDraft] = useState('');
  return (
    <div className="start">
      <div className="start-host">
        <HostButtons start />
      </div>
      <div className="start-inner">
        <div className="start-hero">
          <HeroMark />
          <h1>What should we make?</h1>
          <p>Describe an object or a scene. Kiln’s copilot models it in a headless Blender while you watch it take shape.</p>
        </div>
        <div className="start-compose">
          <Suggestions
            fresh
            onPick={(t) => {
              setDraft(t);
              window.dispatchEvent(new Event('kiln:focus-composer'));
            }}
          />
          <Composer draft={draft} setDraft={setDraft} autoFocus big />
        </div>
        <Recent projects={app?.projects ?? []} />
      </div>
    </div>
  );
}

function readWidth() {
  try {
    return Number(localStorage.getItem('kiln.chatWidth')) || 470;
  } catch {
    return 470;
  }
}

function ProjectView() {
  const [width, setWidth] = useState(readWidth);
  const dragging = useRef(false);
  // A width saved on a wide monitor must not push the viewer off a smaller window.
  const [vw, setVw] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const shown = Math.round(Math.max(Math.min(360, vw * 0.6), Math.min(vw * 0.6, width)));
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (dragging.current) setWidth(Math.max(360, Math.min(window.innerWidth * 0.6, e.clientX)));
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.classList.remove('resizing');
      try {
        localStorage.setItem('kiln.chatWidth', String(Math.round(width)));
      } catch {
        /* storage unavailable */
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [width]);
  return (
    <main className="split" style={{ gridTemplateColumns: `${shown}px 6px 1fr` }}>
      <Chat />
      <div
        className="splitter"
        onPointerDown={() => {
          dragging.current = true;
          document.body.classList.add('resizing');
        }}
      />
      <Viewer />
    </main>
  );
}

function Notices() {
  const notices = useStore((s) => s.notices);
  return (
    <div className="notices">
      {notices.map((n) => (
        <div key={n.id} className={`notice ${n.level}`}>
          <Icon name={n.level === 'info' ? 'spark' : 'alert'} size={15} />
          <span>{n.text}</span>
        </div>
      ))}
    </div>
  );
}

function Lightbox() {
  const url = useStore((s) => s.lightbox);
  useEffect(() => {
    if (!url) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && actions.lightbox(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [url]);
  if (!url) return null;
  return (
    <div className="lightbox" onClick={() => actions.lightbox(null)}>
      <img src={url} alt="" />
    </div>
  );
}

export function App() {
  const projectId = useStore((s) => s.projectId);
  const connected = useStore((s) => s.connected);
  const ui = useStore((s) => s.app?.settings.ui);
  useEffect(() => applyUi(ui), [ui]);
  // Ctrl+, in a browser (the desktop app catches it before the page does).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        actions.openSettings();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="app">
      {projectId ? <ProjectView key={projectId} /> : <StartPage />}
      {!connected && <div className="offline">Reconnecting to Kiln…</div>}
      <Notices />
      <Lightbox />
      <SettingsPanel />
    </div>
  );
}
