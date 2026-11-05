import { useSyncExternalStore } from 'react';
import { openLive } from '../common/live.ts';
import type { ClipsFile, KilnHost } from '../../shared/types.ts';
import type { AnimState } from './viewer/animator.ts';
import type { AppInfo, ChatMessage, EffortSetting, ImageUpload, ProjectMeta, ProjectState, ServerEvent, Settings, TabApi, UiSettings, ViewerSettings } from '../../shared/types.ts';

declare global {
  interface Window {
    kilnTab?: TabApi;
  }
}

export const tabApi = window.kilnTab;

/** Kiln's UI hosted inside another app (?embed=shuriken): no tab strip, the host's buttons. */
export const EMBED = new URLSearchParams(location.search).get('embed');
let testDock: 'docked' | 'undocked' = 'docked';
export const kilnHost: KilnHost | null =
  (window as unknown as { kilnHost?: KilnHost }).kilnHost ??
  // Development only (?embed=test): a stand-in host to see the embedded UI without Shuriken.
  (import.meta.env.DEV && EMBED === 'test'
    ? { app: 'shuriken', useModel: async () => ({ ok: true }), dockState: () => testDock, toggleDock: () => void (testDock = testDock === 'docked' ? 'undocked' : 'docked') }
    : null);
const embedQuery = EMBED ? `embed=${encodeURIComponent(EMBED)}` : '';

export interface Notice {
  id: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface StorageRow {
  id: string;
  title: string;
  updatedAt: string;
  open: boolean;
  working?: boolean;
  linked?: boolean;
  bytes: number;
  history: number;
  viewer: number;
  renders: number;
}

export interface UiState extends Omit<ProjectState, 'project'> {
  app: AppInfo | null;
  projectId: string | null;
  project: ProjectMeta | null;
  connected: boolean;
  loaded: boolean;
  selected: string | null;
  notices: Notice[];
  lightbox: string | null;
  /** The open settings section, or null when the settings are closed. */
  settingsSection: string | null;
  /** Animation playback in the viewer (null: the scene has no clips). */
  anim: AnimState | null;
  /** The rig's clips as sampled for the viewer. */
  clipsFile: ClipsFile | null;
  /** A message that could not be sent after its project was made: the composer takes it back. */
  unsent: string | null;
}

const emptyProject: Omit<ProjectState, 'project'> = {
  messages: [],
  running: false,
  scene: { version: 0, glb: null, summary: null, canUndo: false },
  blender: { status: 'starting', version: null, detail: null },
  todos: [],
  suggestions: [],
  lock: null,
};

let state: UiState = {
  ...emptyProject,
  app: null,
  projectId: new URLSearchParams(location.search).get('project'),
  project: null,
  connected: false,
  loaded: false,
  selected: null,
  notices: [],
  lightbox: null,
  settingsSection: null,
  anim: null,
  clipsFile: null,
  unsent: null,
};

const listeners = new Set<() => void>();
function set(patch: Partial<UiState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useStore<T>(select: (s: UiState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(state),
  );
}

export const getState = () => state;

let noticeId = 0;
export function notify(level: Notice['level'], text: string) {
  const n = { id: ++noticeId, level, text };
  set({ notices: [...state.notices, n].slice(-4) });
  setTimeout(() => set({ notices: state.notices.filter((x) => x.id !== n.id) }), level === 'error' ? 9000 : 5000);
}

function upsert(message: ChatMessage) {
  const i = state.messages.findIndex((m) => m.id === message.id);
  const messages = [...state.messages];
  if (i >= 0) messages[i] = message;
  else messages.push(message);
  set({ messages });
}

function apply(e: ServerEvent) {
  switch (e.type) {
    case 'app':
      set({ app: e.app, loaded: state.projectId ? state.loaded : true });
      break;
    case 'state':
      set({ ...e.state, project: e.state.project, loaded: true, selected: null });
      break;
    case 'message':
      upsert(e.message);
      break;
    case 'delta': {
      const m = state.messages.find((x) => x.id === e.id);
      const b = m?.blocks[e.index];
      if (!m || !b || (b.kind !== 'text' && b.kind !== 'thinking')) break;
      const blocks = [...m.blocks];
      blocks[e.index] = { ...b, text: b.text + e.text };
      upsert({ ...m, blocks });
      break;
    }
    case 'running':
      set({ running: e.running });
      break;
    case 'scene': {
      // The list is cut short in big scenes: an object missing from it may well still exist.
      const names = new Set(e.scene.summary?.list.map((o) => o.name) ?? []);
      const gone = !!state.selected && !names.has(state.selected) && !e.scene.summary?.truncated;
      set({ scene: e.scene, selected: gone ? null : state.selected });
      break;
    }
    case 'blender':
      set({ blender: e.blender });
      break;
    case 'lock':
      set({ lock: e.lock });
      break;
    case 'todos':
      set({ todos: e.todos });
      break;
    case 'suggestions':
      set({ suggestions: e.suggestions });
      break;
    case 'project':
      set({ project: e.project });
      break;
    case 'projects':
      if (state.app) set({ app: { ...state.app, projects: e.projects } });
      break;
    case 'login':
      if (state.app) set({ app: { ...state.app, login: e.login } });
      break;
    case 'settings':
      // Keep local edits that are still on their way to the core (a dragged slider).
      if (state.app && !pendingSettings) set({ app: { ...state.app, settings: e.settings } });
      break;
    case 'memory':
      if (state.app) set({ app: { ...state.app, memory: e.memory } });
      break;
    case 'notice':
      notify(e.level, e.text);
      break;
    case 'deleted':
      if (state.app) set({ app: { ...state.app, projects: state.app.projects.filter((p) => p.id !== e.projectId) } });
      // The project this tab shows is gone: back to the start page (its live connection is closing).
      if (state.projectId === e.projectId) {
        actions.home();
        notify('info', `${e.title} moved to the trash (the projects folder's .trash, kept for a week).`);
      }
      break;
  }
}

let stopLive: (() => void) | null = null;

/** Listens to the app (start page) or to one project (and the app). Reconnects on its own. */
// Development hook: simulate server events from the console (never in a built app).
if (import.meta.env.DEV)
  (window as unknown as { __kiln: unknown }).__kiln = {
    apply: (e: ServerEvent) => apply(e),
    getState,
    get actions() {
      return actions;
    },
  };

export function connect() {
  stopLive?.();
  stopLive = openLive(state.projectId, {
    onEvent: apply,
    onOpen: () => set({ connected: true }),
    onDown: () => set({ connected: false }),
  });
}

async function post<T = Record<string, unknown>>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
}

// Settings changes apply here at once and reach the core shortly after (sliders send one update).
type SettingsPatch = Partial<Omit<Settings, 'viewer' | 'ui'>> & { viewer?: Partial<ViewerSettings>; ui?: Partial<UiSettings> };
let pendingSettings: SettingsPatch | null = null;
let settingsTimer: ReturnType<typeof setTimeout> | null = null;

function mergePatch(a: SettingsPatch, b: SettingsPatch): SettingsPatch {
  return { ...a, ...b, viewer: { ...a.viewer, ...b.viewer }, ui: { ...a.ui, ...b.ui } };
}

const pp = (action: string) => `/api/v1/projects/${encodeURIComponent(state.projectId ?? '')}/${action}`;

/** Shows a project in this tab (the start page becomes the project view). */
function showProject(id: string) {
  history.replaceState(null, '', `/?${embedQuery ? `${embedQuery}&` : ''}project=${encodeURIComponent(id)}`);
  set({ ...emptyProject, projectId: id, project: null, loaded: false, selected: null, anim: null, clipsFile: null });
  tabApi?.setProject(id);
  connect();
}

export interface ViewInfo {
  camera: number[];
  target: number[];
  center: string | null;
}

export const actions = {
  async send(text: string, images: ImageUpload[], view: ViewInfo | null) {
    const t = text.trim();
    // Feedback notes go straight to the local watchdog log: no model call.
    const fb = /^\/(feedback|bug|idea|note)\b\s*([\s\S]*)$/i.exec(t);
    if (fb) {
      if (!fb[2]!.trim()) {
        notify('info', 'Type your note after /feedback, e.g. "/feedback the viewer flickers".');
        return false;
      }
      try {
        await post('/api/v1/feedback', { text: `${fb[1]!.toLowerCase()}: ${fb[2]!.trim()}`, project: state.projectId });
        notify('info', 'Saved to Kiln’s local feedback log (Settings → Data & logs). Nothing was sent to the copilot.');
        return true;
      } catch (e) {
        notify('error', (e as Error).message);
        return false;
      }
    }
    let made = false;
    try {
      if (!state.projectId) {
        const meta = await post<ProjectMeta>('/api/v1/projects', { text: t || 'Reference image' });
        showProject(meta.id);
        made = true;
      }
      await post(pp('chat'), { text: t, images, selected: state.selected, view });
      return true;
    } catch (e) {
      notify('error', (e as Error).message);
      // The start page (and the draft typed there) is gone once the project exists: hand the text on.
      if (made && t) set({ unsent: t });
      return false;
    }
  },
  async open(id: string) {
    const r = tabApi ? await tabApi.openProject(id) : 'ok';
    if (r === 'ok') showProject(id);
  },
  stop: () => post(pp('stop')).catch((e: Error) => notify('error', e.message)),
  /** Back to the project list (embedded Kiln has no tab strip to open another). */
  home() {
    history.replaceState(null, '', `/${embedQuery ? `?${embedQuery}` : ''}`);
    set({ ...emptyProject, projectId: null, project: null, loaded: true, selected: null, anim: null, clipsFile: null });
    tabApi?.setProject(null);
    connect();
  },
  setAnim(anim: AnimState | null) {
    set({ anim });
  },
  setClipsFile(clipsFile: ClipsFile | null) {
    set({ clipsFile });
  },
  /** Make, change, check or remove a clip without the copilot (the Animate panel). */
  async clip<T = Record<string, unknown>>(name: string, body: Record<string, unknown>): Promise<T | null> {
    try {
      return await post<T>(pp(`clips/${encodeURIComponent(name)}`), body);
    } catch (e) {
      notify('error', (e as Error).message);
      return null;
    }
  },
  /** The rig, its clips (with generator settings) and the rig check. */
  async rig(): Promise<{ info: { joints: Array<{ name: string; parent: string | null; kind: string; limits: unknown }>; legs: Array<{ joints: string[] }> }; clips: Array<Record<string, unknown>>; check: { ok: boolean; issues: string[] } } | null> {
    try {
      const r = await fetch(pp('rig'));
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  },
  /** Shuriken: put the model or a clip into Roblox Studio. */
  async sendToStudio(kind: 'model' | 'animation', clip?: string): Promise<boolean> {
    const p = state.project;
    if (!p || typeof kilnHost?.sendToStudio !== 'function') return false;
    try {
      const r = await kilnHost.sendToStudio({ kind, projectId: p.id, name: p.title, ...(clip ? { clip } : {}) });
      if (r.ok) notify('info', r.note ?? (kind === 'animation' ? `${clip} is in Roblox Studio.` : `${p.title} is in Roblox Studio.`));
      else notify('error', r.error ?? 'Roblox Studio did not take it.');
      return r.ok;
    } catch (e) {
      notify('error', (e as Error).message);
      return false;
    }
  },
  async useInHost() {
    const p = state.project;
    if (!kilnHost || !p) return;
    notify('info', `Sending ${p.title} to ${kilnHost.app === 'shuriken' ? 'Shuriken Studio' : kilnHost.app}…`);
    try {
      const r = await kilnHost.useModel(p.id, p.title);
      if (r.ok) notify('info', `${p.title} is now a model in your ${kilnHost.app === 'shuriken' ? 'Shuriken' : kilnHost.app} project.`);
      else notify('error', r.error ?? 'It could not be added.');
    } catch (e) {
      notify('error', (e as Error).message);
    }
  },
  async undo() {
    try {
      const r = await post<{ ok?: boolean }>(pp('undo'));
      if (!r.ok) notify('info', 'Nothing to undo.');
    } catch (e) {
      notify('error', (e as Error).message);
    }
  },
  rename: (title: string) => post(pp('rename'), { title }).catch((e: Error) => notify('error', e.message)),
  rate: (message: string, rating: 'up' | 'down', note = '') => post(pp('rate'), { message, rating, note }).catch((e: Error) => notify('error', e.message)),
  thumb: (dataUrl: string) => post(pp('thumb'), { dataUrl }).catch(() => undefined),
  setEffort: (effort: EffortSetting) => actions.updateSettings({ effort }),
  updateSettings(patch: SettingsPatch) {
    const app = state.app;
    if (!app) return;
    const cur = app.settings;
    set({ app: { ...app, settings: { ...cur, ...patch, viewer: { ...cur.viewer, ...patch.viewer }, ui: { ...cur.ui, ...patch.ui } } as Settings } });
    pendingSettings = mergePatch(pendingSettings ?? {}, patch);
    if (settingsTimer) clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => {
      const body = pendingSettings;
      pendingSettings = null;
      settingsTimer = null;
      post('/api/v1/settings', body).catch((e: Error) => notify('error', e.message));
    }, 180);
  },
  async setMemory(facts: string[]) {
    try {
      const memory = await post<AppInfo['memory']>('/api/v1/memory', { facts });
      if (state.app) set({ app: { ...state.app, memory } });
    } catch (e) {
      notify('error', (e as Error).message);
    }
  },
  /** Settings' "Check again": asks Claude Code who is signed in on this PC (no model call). */
  async checkLogin() {
    try {
      const login = await post<AppInfo['login']>('/api/v1/login/check');
      if (state.app) set({ app: { ...state.app, login } });
    } catch (e) {
      notify('error', (e as Error).message);
    }
  },
  openSettings: (section?: string | null) => set({ settingsSection: section || state.settingsSection || 'general' }),
  closeSettings: () => set({ settingsSection: null }),
  openPath: (which: 'logs' | 'watchdog' | 'projects' | 'data') => {
    if (tabApi) tabApi.openPath(which);
    else notify('info', 'Folders open from the desktop app.');
  },
  select: (name: string | null) => set({ selected: name }),
  takeUnsent: () => set({ unsent: null }),
  /** What each project takes on disk, biggest first. */
  async storage(): Promise<StorageRow[]> {
    const res = await fetch('/api/v1/storage');
    const data = (await res.json().catch(() => ({}))) as { projects?: StorageRow[] };
    return data.projects ?? [];
  },
  /** Frees old undo steps and viewer files in closed projects → bytes freed and the new list. */
  tidyStorage: () => post<{ freed: number; projects: StorageRow[] }>('/api/v1/storage', { keep: 3 }),
  /** Moves a project to Documents\Kiln\.trash (kept there for a week); a running copilot is stopped first. */
  deleteProject: (id: string) => post<{ ok: boolean; error?: string }>(`/api/v1/projects/${encodeURIComponent(id)}/delete`, { stop: true }),
  /**
   * Asks, then deletes a project: whatever shows it goes back to its start page. False when the user said no or it
   * failed (the reason is shown).
   */
  async confirmDelete(p: { id: string; title: string; working?: boolean; open?: boolean; linked?: unknown }): Promise<boolean> {
    const extra = [p.working ? 'Its copilot is working: that stops.' : '', p.linked ? 'Shuriken Studio uses this model: it makes a new one next time it needs it.' : ''].filter(Boolean).join(' ');
    const ask = [`Delete “${p.title}”?`, 'It moves to the trash in the projects folder (.trash) and is removed for good after a week.', extra].filter(Boolean).join('\n\n');
    if (!window.confirm(ask)) return false;
    // The tab showing it says so itself (the 'deleted' event); elsewhere, say it here.
    const shownHere = state.projectId === p.id;
    try {
      const r = await actions.deleteProject(p.id);
      if (!r.ok) throw new Error(r.error ?? 'It could not be deleted.');
      if (!shownHere) notify('info', `${p.title} moved to the trash (kept for a week).`);
      return true;
    } catch (e) {
      notify('error', `${p.title} was not deleted: ${(e as Error).message}`);
      return false;
    }
  },
  /** Every project (newest first), filtered by title: the start page's full list. */
  async listProjects(q = '', limit = 300): Promise<{ total: number; matched: number; projects: AppInfo['projects'] }> {
    const res = await fetch(`/api/v1/projects?limit=${limit}&q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(`${res.status}`);
    return (await res.json()) as { total: number; matched: number; projects: AppInfo['projects'] };
  },
  lightbox: (url: string | null) => set({ lightbox: url }),
  download(format: string) {
    const a = document.createElement('a');
    a.href = pp(`export/${format}`);
    a.click();
  },
};

// The Kiln logo in the tab strip (or Ctrl+,) opens the settings over this tab.
tabApi?.onSettings((section) => actions.openSettings(section));
// The tab strip's menu: "Delete project…".
tabApi?.onDeleteProject?.(() => {
  const p = state.project;
  if (p) void actions.confirmDelete({ id: p.id, title: p.title, working: state.running, linked: p.linked });
});
