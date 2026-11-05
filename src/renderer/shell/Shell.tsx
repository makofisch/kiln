import { useEffect, useMemo, useRef, useState } from 'react';
import { KilnMark } from '../common/KilnMark.tsx';
import { LiveMark } from '../common/LiveMark.tsx';
import { Icon } from '../common/Icon.tsx';
import { applyUi } from '../common/theme.ts';
import { openLive } from '../common/live.ts';
import { MAX_TABS, type AppInfo, type LoginState, type MenuItem, type ProjectSummary, type ServerEvent, type ShellApi, type ShellState } from '../../shared/types.ts';

declare global {
  interface Window {
    kilnShell?: ShellApi;
  }
}

const api = window.kilnShell;

async function post(path: string, body: unknown = {}) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.ok;
}

type Usage = LoginState['pc']['usage'];

/** The busiest usage window of the login: what to show on the chip. */
function headline(usage: Usage): { label: string; util: number | null; status: string } {
  const entries = Object.entries(usage).filter(([, u]) => u.utilization !== null);
  if (!entries.length) return { label: '', util: null, status: 'allowed' };
  const [key, u] = entries.sort((x, y) => (y[1].utilization ?? 0) - (x[1].utilization ?? 0))[0]!;
  return { label: key === 'five_hour' ? '5h' : key.startsWith('seven_day') ? 'week' : key.replace(/_/g, ' '), util: u.utilization, status: u.status };
}

function usageLine(usage: Usage): string {
  return Object.entries(usage)
    .filter(([, u]) => u.utilization !== null)
    .map(([k, u]) => `${k === 'five_hour' ? '5h' : k.startsWith('seven_day') ? 'week' : k} ${Math.round((u.utilization ?? 0) * 100)}%`)
    .join(' · ');
}

/** This PC's Claude login at a glance (signed in, usage); a click opens Settings → Claude login. */
function LoginChip({ login }: { login: LoginState | null }) {
  if (!login) return null;
  const pc = login.pc;
  const h = headline(pc.usage);
  const level = !pc.signedIn || h.status === 'rejected' ? 'bad' : (h.util ?? 0) >= 0.8 ? 'warn' : 'ok';
  const who = pc.signedIn ? (pc.email ?? 'signed in') : 'not signed in (run claude /login in a terminal)';
  const usage = usageLine(pc.usage);
  return (
    <button className={`strip-chip account ${level}`} onClick={() => api?.openSettings('accounts')} title={`Claude login: the same as Shuriken's (this PC's login)
${who}${usage ? ` · ${usage}` : ''}
Click for details`}>
      <span className="acct-dot" />
      <span className="acct-name">{pc.signedIn ? 'Claude' : 'Not signed in'}</span>
      {pc.signedIn && h.util !== null && (
        <>
          <span className="acct-window">{h.label}</span>
          <span className="acct-meter">
            <span style={{ width: `${Math.min(100, h.util * 100)}%` }} />
          </span>
          <span className="acct-pct">{Math.round(h.util * 100)}%</span>
        </>
      )}
    </button>
  );
}

interface Drag {
  id: string;
  startX: number;
  startY: number;
  dx: number;
  index: number;
  active: boolean;
  /** The window's only tab: dragging it carries the whole window. */
  single: boolean;
}

export function Shell() {
  const [state, setState] = useState<ShellState | null>(null);
  const [app, setApp] = useState<AppInfo | null>(null);
  const [projects, setProjects] = useState<Record<string, ProjectSummary>>({});
  const [login, setLogin] = useState<LoginState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api?.onState(setState);
    api?.onNotice((t) => {
      setNotice(t);
      setTimeout(() => setNotice(null), 4500);
    });
    const stop = openLive(null, {
      onEvent: (e: ServerEvent) => {
        if (e.type === 'app') {
          setApp(e.app);
          applyUi(e.app.settings.ui);
          setLogin(e.app.login);
          setProjects(Object.fromEntries(e.app.projects.map((p) => [p.id, p])));
        } else if (e.type === 'projects') setProjects(Object.fromEntries(e.projects.map((p) => [p.id, p])));
        else if (e.type === 'login') setLogin(e.login);
        else if (e.type === 'settings') applyUi(e.settings.ui);
      },
    });
    return stop;
  }, []);

  // Test hook for the smoke test: show a project as working without a model call.
  useEffect(() => {
    (window as unknown as { __kilnShellSim: unknown }).__kilnShellSim = (id: string, working: boolean) =>
      setProjects((p) => (p[id] ? { ...p, [id]: { ...p[id]!, working } } : p));
  }, []);

  const titleOf = (pid: string | null) => (pid ? projects[pid]?.title ?? 'Project' : 'New project');
  const activeTab = state?.tabs.find((t) => t.id === state.activeId);
  useEffect(() => {
    api?.setTitle(activeTab ? (activeTab.projectId ? titleOf(activeTab.projectId) : '') : '');
  });

  const titles = useMemo(() => Object.fromEntries(Object.values(projects).map((p) => [p.id, p.title])), [projects]);
  const anyWorking = !!state?.tabs.some((t) => t.projectId && projects[t.projectId]?.working);

  const appMenu = async () => {
    const choice = await api?.popup([
      { id: 'settings', label: 'Settings…', sublabel: 'Ctrl+,' },
      { id: 'new', label: 'New tab', sublabel: 'Ctrl+Shift+N' },
      { type: 'separator' },
      { id: 'projects', label: 'Open projects folder' },
      { id: 'logs', label: 'Open conversation logs' },
      { id: 'watchdog', label: 'Open watchdog report' },
      { id: 'data', label: 'Open Kiln data folder' },
      { type: 'separator' },
      { id: 'about', label: `Kiln ${app?.version ?? ''}`, enabled: false },
    ]);
    if (choice === 'settings') api?.openSettings();
    else if (choice === 'new') api?.newTab();
    else if (choice === 'projects' || choice === 'logs' || choice === 'watchdog' || choice === 'data') api?.openPath(choice);
  };

  // Keep the taskbar's progress indicator in step with the projects in this window.
  useEffect(() => {
    api?.setWorking(anyWorking);
  }, [anyWorking]);

  // --- dragging by the tabs: the main process moves the window (or a torn-off tab's new window)
  // with the cursor; here we only show the reorder inside the strip.
  const onPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.tab-close')) return;
    // Capture on the strip, not the chip: a torn-off tab's chip leaves this window mid-drag.
    tabsRef.current?.setPointerCapture(e.pointerId);
    const index = state?.tabs.findIndex((t) => t.id === id) ?? 0;
    setDrag({ id, startX: e.clientX, startY: e.clientY, dx: 0, index, active: false, single: (state?.tabs.length ?? 0) <= 1 });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    let active = drag.active;
    if (!active && Math.hypot(dx, dy) > 4) {
      active = true;
      api?.dragStart(drag.id);
    }
    let index = drag.index;
    if (active && !drag.single) {
      const chips = [...(tabsRef.current?.querySelectorAll<HTMLElement>('.tab') ?? [])];
      index = chips.filter((c) => c.dataset.id !== drag.id && c.getBoundingClientRect().left + c.offsetWidth / 2 < e.clientX).length;
    }
    setDrag({ ...drag, dx, index, active });
  };
  const onPointerUp = () => {
    if (!drag) return;
    if (drag.active) api?.dragEnd(drag.index);
    else api?.activate(drag.id);
    setDrag(null);
  };

  const tabs = state?.tabs ?? [];
  const atCap = (state?.totalTabs ?? 0) >= MAX_TABS;

  return (
    <div className={`strip${state?.maximized ? ' max' : ''}`}>
      <button
        className="brand"
        onClick={() => api?.openSettings()}
        onContextMenu={(e) => {
          e.preventDefault();
          void appMenu();
        }}
        title="Settings (Ctrl+,) · right-click for quick actions"
      >
        <KilnMark size={20} glow />
        <span className="brand-gear">
          <Icon name="gear" size={9} />
        </span>
      </button>
      <div className="tabs" ref={tabsRef} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        {tabs.map((t, i) => {
          const p = t.projectId ? projects[t.projectId] : undefined;
          const dragging = drag?.active && !drag.single && drag.id === t.id;
          const shift =
            drag?.active && !drag.single && drag.id !== t.id
              ? (() => {
                  const from = tabs.findIndex((x) => x.id === drag.id);
                  if (from < 0) return 0;
                  if (from < i && drag.index >= i) return -1;
                  if (from > i && drag.index <= i) return 1;
                  return 0;
                })()
              : 0;
          return (
            <div
              key={t.id}
              data-id={t.id}
              className={`tab${t.id === state?.activeId ? ' active' : ''}${dragging ? ' dragging' : ''}${p?.working ? ' working' : ''}`}
              style={dragging ? { transform: `translateX(${drag!.dx}px)` } : shift ? { transform: `translateX(${shift * 100}%)` } : undefined}
              onPointerDown={(e) => onPointerDown(e, t.id)}
              onDoubleClick={(e) => !(e.target as HTMLElement).closest('.tab-close') && api?.toggleMaximize()}
              onAuxClick={(e) => e.button === 1 && api?.close(t.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                api?.tabMenu(t.id, titles);
              }}
              title={`${titleOf(t.projectId)}${p?.working ? ' · working' : ''}`}
            >
              <WorkIcon working={!!p?.working} />
              <span className="tab-title">{titleOf(t.projectId)}</span>
              <button className="tab-close" onClick={() => api?.close(t.id)} aria-label="Close tab">
                <Icon name="x" size={12} />
              </button>
            </div>
          );
        })}
        <button className="new-tab" onClick={() => api?.newTab()} disabled={atCap} title={atCap ? `${MAX_TABS} projects are open` : 'New tab (Ctrl+Shift+N)'}>
          <Icon name="plus" size={15} />
        </button>
      </div>
      <div className="drag-fill">{notice && <span className="strip-notice">{notice}</span>}</div>
      <LoginChip login={login} />
      <div className="caption-space" />
    </div>
  );
}

/** A tab's icon: the still mark, turning into the falling-pixel animation while its project works. */
function WorkIcon({ working }: { working: boolean }) {
  return (
    <span className="tab-icon">
      <LiveMark size={16} working={working} />
    </span>
  );
}
