// Contracts shared by the Kiln core, the Electron main process and the UI.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** The Effort setting: one level for every message, or "auto": Kiln picks per request from its complexity (shared/effort.ts). */
export type EffortSetting = Effort | 'auto';
export const EFFORT_SETTINGS: EffortSetting[] = ['auto', ...EFFORTS];
export const MAX_TABS = 10;

export interface TextBlock {
  kind: 'text';
  text: string;
}

export interface ThinkingBlock {
  kind: 'thinking';
  text: string;
  done?: boolean;
}

export interface TaskInfo {
  type?: string;
  description?: string;
  status?: 'running' | 'completed' | 'failed' | 'stopped';
  tokens?: number;
  toolUses?: number;
  lastTool?: string;
  summary?: string;
}

export interface ToolBlock {
  kind: 'tool';
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: 'running' | 'ok' | 'error';
  output?: string;
  /** URL of an image the tool produced (renders). */
  image?: string;
  /** Every image the tool produced, when there are several (motion views). */
  images?: string[];
  /** The subagent (Agent tool call) this call belongs to. */
  parent?: string | null;
  /** When the copilot began writing the call. */
  startedAt: number;
  /** When the call was fully written and started to run (the rest, up to endedAt, is the tool's own time). */
  ranAt?: number;
  endedAt?: number;
  task?: TaskInfo;
}

export interface ErrorBlock {
  kind: 'error';
  text: string;
}

/** A note from Kiln itself in the transcript (the login a turn runs on, feedback saved…). */
export interface NoteBlock {
  kind: 'note';
  text: string;
}

export type Block = TextBlock | ThinkingBlock | ToolBlock | ErrorBlock | NoteBlock;

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  durationMs: number;
  turns: number;
  costUsd: number;
  /** The label of the Claude login the turn ran on. */
  account?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  blocks: Block[];
  images?: string[];
  createdAt: number;
  done?: boolean;
  usage?: TurnUsage;
  /** The user's rating of this reply. */
  rating?: 'up' | 'down';
  /** Another app's assistant that sent this message for the user (e.g. "Shuriken animation copilot"). */
  from?: string;
  /** For a message from another app: what kind of brief it is. */
  kind?: BriefKind;
  /** The effort the turn ran at, when Kiln or another app chose it (not the user's fixed setting). */
  effort?: Effort;
  /** When Kiln picked the effort: what decided it ("new build, detailed, named subject"). */
  effortWhy?: string;
}

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface SceneObjectInfo {
  name: string;
  type: string;
  location: number[];
  dimensions: number[];
  rotation_deg?: number[];
  scale?: number[];
  tris?: number;
  materials?: string[];
  modifiers?: string[];
  parent?: string;
  collection?: string;
  hidden?: boolean;
  /** A placement of this piece (kiln.place): an instance of another project's model. */
  piece?: string;
  /** What the part is in the game (kiln.role, kiln.marker). */
  role?: string;
  /** A named part the game's code moves or finds (kiln.part). */
  part?: string;
}

export interface MaterialInfo {
  name: string;
  color?: string | null;
  metallic?: number;
  roughness?: number;
  emission?: number;
  image_texture?: boolean;
  procedural_texture?: boolean;
}

export interface SceneSummary {
  objects: number;
  tris: number;
  verts: number;
  list: SceneObjectInfo[];
  truncated: boolean;
  materials: MaterialInfo[];
  collections: string[];
  animated: boolean;
  bounds?: { min: number[]; max: number[]; size: number[] };
  frames?: number[];
  /** The world background (sky) color and strength, for the viewer's scene lighting. */
  world?: { color: string; strength: number } | null;
  /** How many lights the scene has. */
  lights?: number;
  /** The rig and its animation clips, when the scene has a Kiln rig. */
  rig?: RigSummary;
  /** Pieces from other projects placed in this scene (kiln.place): instances, counted in `tris`. */
  placed?: { pieces: number; placements: number; tris: number };
}

/** One animation clip on the rig (see blender/kiln_anim.py). */
export interface ClipInfo {
  name: string;
  /** [first frame, last frame] at 30 fps. */
  frames: number[];
  /** Seconds. */
  length: number;
  loop: boolean;
  in_place: boolean;
  /** Units per second the feet travel (movement clips): the game moves the model this fast. */
  speed: number | null;
  /** Degrees per second a turning gait turns (positive: to the model's left): the game turns the model this fast. */
  turn?: number;
  priority: string;
  /** The generator that made it ("gait", "idle", "attack", "hit", "death"), if any. */
  generator: string | null;
  markers: number;
  /** Changes whenever the clip's keys or settings change. */
  fp?: string;
}

export interface RigSummary {
  joints: number;
  clips: ClipInfo[];
  /** The clip the rig is showing. */
  current: string | null;
  /** Changes whenever any clip or the rig changes. */
  anim: string;
  error?: string;
}

/** Every clip sampled for the viewer (kiln_anim.export_json). Rotations/offsets are Blender world-aligned. */
export interface ClipsFile {
  version: number;
  fps: number;
  units: string;
  forward: number[];
  joints: Array<{ name: string; parent: string | null; head: number[] }>;
  clips: Array<ClipInfo & { samples: number; markers: Array<{ name: string; frame: number; time: number }>; tracks: Record<string, number[]> }>;
}

/** What another app asks for with a brief (POST chat with `kind`): it sets the framing and the effort floor. */
export type BriefKind = 'new' | 'rework' | 'fix' | 'animate';
export const BRIEF_KINDS: BriefKind[] = ['new', 'rework', 'fix', 'animate'];

/** The facts of the model after a turn, for the app that asked (read them instead of prescribing them). */
/** A game's shared look, referenced by every brief of that game (POST chat `style`). */
export interface StyleSheet {
  id: string;
  title?: string;
  /** '#rrggbb' colours. */
  palette: string[];
  materials: Array<{ name: string; color: string; roughness?: number; metallic?: number; roblox_material?: string | null; emission?: string | null; use?: string }>;
  /** Edge bevel radius in the game's units. */
  bevel?: number;
  /** Texels per unit for textured parts. */
  texel_density?: number;
  /** Triangle budgets by class, e.g. { hero: 12000, prop: 3000, dressing: 600 }. */
  budgets?: Record<string, number>;
  /** How worn things are: "clean", "worn", "battered", or a phrase. */
  wear?: string;
  notes?: string;
  units?: 'm' | 'studs';
  /** The project whose copilot proposed it. */
  from?: string;
  updatedAt?: string;
}

/** Requirements a brief states as data; each is checked when the turn ends (Delivery.checks). */
export interface BriefSpec {
  /** Most triangles each top-level model may have (the whole result when it is one model). */
  tris?: number;
  /** Most triangles the whole result may have, all models together. */
  tris_total?: number;
  /** Target size [x, y, z] in the project's units (null for an axis that doesn't matter), within 20%. */
  size?: Array<number | null>;
  /** Target height (z), within 15%. */
  height?: number;
  /** Every model's lowest point is on the ground (z = 0). */
  ground?: boolean;
  /** Socket names that must exist (on any model). */
  sockets?: string[];
  /** Named parts the game's code needs (kiln.part): each must exist as its own object. */
  parts?: string[];
}

/** One top-level model in the scene (blender/kiln_parts.py models()). */
export interface ModelFacts {
  name: string;
  /** Its meshes. */
  objects: string[];
  origin: number[];
  origin_at: string;
  min: number[];
  max: number[];
  size: number[];
  /** How far its lowest point is above z = 0 (negative: sunk). */
  ground_gap: number;
  tris: number;
  materials: Array<{ name: string; color: string | null; roblox_material: string | null }>;
  /** Pieces the game's code moves or finds by name (kiln.part): each stays its own object through the export. */
  parts?: Array<{ name: string; object: string; parent?: string | null; objects: string[]; pivot: number[] }>;
  /** In the model's own space (relative to its origin). */
  sockets: Array<{ name: string; mates: string[]; position: number[]; facing: number[]; matrix: number[][] }>;
  rigged: boolean;
}

export interface FitReport {
  ok: boolean;
  summary: string;
  pairs: Array<{ parent: string; socket: string; child: string; mate: string; ok: boolean; gap: number | null; buried: number | null; problem: string | null }>;
  unpaired: string[];
}

/** Where a running turn is (GET turns/:id while `state` is "running"). */
export interface TurnProgress {
  /** Steps of the copilot's plan, when it has made one this turn. */
  steps: { done: number; total: number } | null;
  /** The step in progress. */
  current: string | null;
  /** The tool call running right now, e.g. "run_python: Build the hull". */
  tool: string | null;
  /** Tool calls finished so far. */
  tools: number;
  /** URL of the newest render the copilot made this turn. */
  lastRender: string | null;
  elapsedMs: number;
  /** A rough guess from the plan (elapsed per finished step); null until a step is done. */
  etaMs: number | null;
  /** Messages taken in while it worked. */
  interjections: number;
}

export interface Delivery {
  /** Each top-level model: origin, size, triangles, materials, sockets (variants are separate models). */
  models?: ModelFacts[];
  /** How the declared socket pairings fit, when the scene has any. */
  fit?: FitReport | null;
  /** The brief's requirements (POST chat `spec`), each checked. */
  checks?: Array<{ name: string; ok: boolean; detail: string }>;
  /** Overall size [x, y, z] in the project's units. */
  size: number[] | null;
  units: 'm' | 'studs';
  objects: number;
  tris: number;
  joints: number;
  clips: Array<{ name: string; length: number; loop: boolean; in_place: boolean; speed: number | null; turn?: number; priority: string; markers: Array<{ name: string; time: number }> }>;
  /** URLs of the images the copilot rendered during the turn. */
  renders: string[];
}

/** How a copilot turn ended, for apps that sent it (POST chat with `from`). */
export interface TurnInfo {
  projectId: string;
  turnId: string;
  /** "queued": sent with mode "queue" while another turn ran; it starts when that one ends. */
  state: 'queued' | 'running' | 'done' | 'failed' | 'stopped';
  /** While running: where it is. */
  progress?: TurnProgress;
  /** The requirements the brief stated. */
  spec?: BriefSpec;
  /** The game's style sheet this turn followed (or was asked to propose). */
  style?: string;
  reply: string;
  /** Clips added or changed during the turn. */
  clips: string[];
  from?: string;
  kind?: BriefKind;
  /** The effort the turn ran at. */
  effort?: Effort;
  /** When Kiln picked the effort itself: what decided it. */
  effortWhy?: string;
  /** The Claude login the turn runs on, and why that one (0.9). */
  account?: TurnLogin;
  /** Set when the turn ends. */
  delivery?: Delivery;
}

export interface SceneState {
  version: number;
  /** Changes whenever the saved scene does (version numbers repeat after an Undo; this doesn't). */
  fingerprint?: string | null;
  /** URL of the current glTF export, or null for an empty scene. */
  glb: string | null;
  summary: SceneSummary | null;
  canUndo: boolean;
  /** URL of every clip sampled for the viewer (ClipsFile), when the scene has a rig with clips. */
  clips?: string | null;
}

export type BlenderStatus = 'missing' | 'starting' | 'ready' | 'busy' | 'restarting' | 'failed';

export interface BlenderInfo {
  status: BlenderStatus;
  version: string | null;
  detail: string | null;
}

export interface UsageWindow {
  /** 0–1 */
  utilization: number | null;
  /** epoch ms */
  resetsAt: number | null;
  status: 'allowed' | 'allowed_warning' | 'rejected';
  at: number;
}

/**
 * How a turn signs in to Claude (0.9). Kiln has one login, and by default it follows Shuriken:
 * - 'pc': this PC's own Claude Code login (no CLAUDE_CONFIG_DIR: Claude Code's default folder, ~/.claude);
 * - 'folder': a Claude Code config folder another app signed in (CLAUDE_CONFIG_DIR = dir);
 * - 'api-key': an API key another app sent with its brief (ANTHROPIC_API_KEY), held in memory for that turn only.
 */
export type LoginKind = 'pc' | 'folder' | 'api-key';

/** A brief's `account` (POST chat over the bearer-authenticated API): the login its turn runs on. */
export interface AccountRequest {
  kind: LoginKind;
  /** 'folder': the Claude Code config folder (an absolute path). */
  dir?: string;
  /** 'api-key': the key. Never written to disk, logs or errors; dropped when the turn ends. */
  apiKey?: string;
}

/** The login a turn runs on, as the chat, the API and the logs show it: never the key itself. */
export interface TurnLogin {
  kind: LoginKind;
  /** 'folder': the folder. */
  dir?: string;
  /** "This PC's Claude login", "Shuriken's login (acct_1)", "Shuriken's API key". */
  label: string;
  /** Why this login: "the brief asked for this login folder", "typed in Kiln: this PC's login", … */
  why: string;
}

/** Kiln's Claude login, for Settings and the tab strip. */
export interface LoginState {
  /** This PC's own Claude Code login: what Kiln uses unless a brief from another app sends a login with it. */
  pc: {
    /** Claude Code has a login on this PC (checked without a model call). */
    signedIn: boolean;
    email: string | null;
    plan: string | null;
    /** Claude Code's folder for this login. */
    dir: string;
    checkedAt: number | null;
    /** Usage windows from the rate-limit events of turns on this login. */
    usage: Record<string, UsageWindow>;
  };
  /** The login the latest turn (any project) started on, and when. */
  last: (TurnLogin & { at: number }) | null;
}

export type Accent = 'ember' | 'violet' | 'ocean' | 'jade' | 'rose';
export const ACCENTS: Accent[] = ['ember', 'violet', 'ocean', 'jade', 'rose'];

export type Glow = 'off' | 'subtle' | 'normal' | 'strong' | 'roblox';
export const GLOWS: Glow[] = ['off', 'subtle', 'normal', 'strong', 'roblox'];

/**
 * A Roblox place's Lighting, as Studio reports it (Color3 values as [r, g, b] in 0–1). Kiln previews a
 * Roblox project under it; anything missing falls back to a new place's defaults.
 */
export interface RobloxLighting {
  brightness?: number;
  ambient?: number[];
  outdoorAmbient?: number[];
  clockTime?: number;
  latitude?: number;
  envDiffuse?: number;
  envSpecular?: number;
  /** ExposureCompensation. */
  exposure?: number;
  atmosphere?: { density?: number; offset?: number; haze?: number; glare?: number; color?: number[]; decay?: number[] } | null;
  bloom?: { intensity?: number; size?: number; threshold?: number } | null;
  colorCorrection?: { brightness?: number; contrast?: number; saturation?: number; tint?: number[] } | null;
}

export interface ViewerSettings {
  /** 'auto' uses a scene's own lights when it has some; 'studio' always uses neutral studio light. */
  lighting: 'auto' | 'studio';
  /** Exposure multiplier (0.5–1.6). */
  exposure: number;
  /** Glow around emissive materials (kept for older settings files; `glow` decides). */
  bloom: boolean;
  /** How much emissive materials glow in the viewer. "roblox" approximates Studio's default Bloom. */
  glow: Glow;
  grid: boolean;
}

export interface UiSettings {
  accent: Accent;
  textSize: 'small' | 'normal' | 'large';
  reduceMotion: boolean;
  /** Show suggestion bubbles above the message box. */
  suggestions: boolean;
}

export interface Settings {
  effort: EffortSetting;
  /** Cross-project memory: the copilot reads and saves lasting preferences about the user. */
  memory: boolean;
  /** The copilot may start modeler/critic subagents (they spend usage; off = it works alone). */
  subagents: boolean;
  /** The copilot may do a short research phase (web search, reference images) when a request names something specific. */
  research: boolean;
  viewer: ViewerSettings;
  ui: UiSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  effort: 'auto',
  memory: true,
  subagents: true,
  research: true,
  viewer: { lighting: 'auto', exposure: 1, bloom: true, glow: 'normal', grid: true },
  ui: { accent: 'ember', textSize: 'normal', reduceMotion: false, suggestions: true },
};

/** A suggestion bubble: a short label on the button, a fuller request put in the message box. */
export interface Suggestion {
  label: string;
  prompt: string;
}

export interface MemoryState {
  enabled: boolean;
  facts: string[];
  /** Where the list lives on disk (editable by hand too). */
  file: string;
}

export interface ProjectMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  objects: number;
  tris: number;
  thumb: string | null;
  /** Scene units: meters (Kiln's own projects) or studs (models Shuriken Studio builds in Kiln). */
  units?: 'm' | 'studs';
  /** Set when another app (Shuriken Studio) made this project to build one of its models. */
  linked?: { app: string; model: string; project?: string };
  /**
   * Where the model ends up. "roblox": the copilot builds for what Roblox can show, and previews use the
   * game's lighting. Unset, projects in studs or made by Shuriken count as Roblox; null turns that off.
   */
  target?: 'roblox' | null;
  /** The Roblox place's lighting (target roblox), for the previews. */
  lighting?: RobloxLighting | null;
  /** The id of the game's style sheet this project follows (set by a brief's `style`). */
  style?: string;
  /** The saved scene's version and fingerprint: what another project's kiln.piece, or another app, compares against. */
  version?: number;
  fingerprint?: string | null;
}

/** Whether a project is built for Roblox (see ProjectMeta.target). */
export function isRoblox(m: Pick<ProjectMeta, 'target' | 'units' | 'linked'> | null | undefined): boolean {
  if (!m) return false;
  if (m.target !== undefined) return m.target === 'roblox';
  return m.units === 'studs' || /shuriken/i.test(m.linked?.app ?? '');
}

export interface ProjectSummary extends ProjectMeta {
  open: boolean;
  working: boolean;
}

/** Everything one project tab renders. */
export interface ProjectState {
  project: ProjectMeta;
  messages: ChatMessage[];
  running: boolean;
  scene: SceneState;
  blender: BlenderInfo;
  todos: Todo[];
  suggestions: Suggestion[];
  /** Another app (Shuriken) is building this model right now: chat and undo wait. */
  lock?: ProjectLock | null;
}

export interface ProjectLock {
  by: string;
  /** epoch ms */
  until: number;
}

export interface AppInfo {
  version: string;
  settings: Settings;
  memory: MemoryState;
  blender: { path: string | null };
  login: LoginState;
  projects: ProjectSummary[];
  dataDir: string;
  projectsDir: string;
}

export type ServerEvent =
  | { type: 'app'; app: AppInfo }
  | { type: 'state'; state: ProjectState }
  | { type: 'message'; message: ChatMessage }
  | { type: 'delta'; id: string; index: number; text: string }
  | { type: 'running'; running: boolean }
  | { type: 'scene'; scene: SceneState }
  | { type: 'blender'; blender: BlenderInfo }
  | { type: 'todos'; todos: Todo[] }
  | { type: 'suggestions'; suggestions: Suggestion[] }
  | { type: 'project'; project: ProjectMeta }
  | { type: 'projects'; projects: ProjectSummary[] }
  | { type: 'login'; login: LoginState }
  | { type: 'settings'; settings: Settings }
  | { type: 'memory'; memory: MemoryState }
  | { type: 'lock'; lock: ProjectLock | null }
  | { type: 'turn'; turn: TurnInfo }
  | { type: 'clips'; clips: ClipInfo[]; url: string | null }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  /** A project was moved to the trash: windows showing it go back to the start page. */
  | { type: 'deleted'; projectId: string; title: string };

export interface ImageUpload {
  name: string;
  /** data:image/...;base64,... */
  dataUrl: string;
}

// --- Electron shell (tab strip) <-> main ------------------------------------------------------

export interface TabInfo {
  id: string;
  projectId: string | null;
}

export interface ShellState {
  windowId: number;
  tabs: TabInfo[];
  activeId: string | null;
  totalTabs: number;
  maximized: boolean;
}

export interface MenuItem {
  id?: string;
  label?: string;
  type?: 'normal' | 'separator' | 'checkbox' | 'radio';
  checked?: boolean;
  enabled?: boolean;
  sublabel?: string;
}

export interface ShellApi {
  onState(cb: (s: ShellState) => void): void;
  onNotice(cb: (text: string) => void): void;
  newTab(): void;
  activate(tabId: string): void;
  close(tabId: string): void;
  /** Drag ended at a screen point: reorder, dock into another window, or detach. */
  dropTab(tabId: string, screenX: number, screenY: number, index: number): void;
  detach(tabId: string): void;
  tabMenu(tabId: string, titles: Record<string, string>): void;
  /** A native menu at the pointer; resolves with the chosen item id. */
  popup(items: MenuItem[]): Promise<string | null>;
  setTitle(title: string): void;
  openPath(which: 'logs' | 'watchdog' | 'projects' | 'data'): void;
  /** A tab drag started: the window (or a torn-off tab) follows the cursor until dragEnd. */
  dragStart(tabId: string): void;
  dragEnd(index: number): void;
  toggleMaximize(): void;
  /** Some project in this window is working (taskbar progress). */
  setWorking(working: boolean): void;
  /** Opens the settings in the active tab (optionally at a section). */
  openSettings(section?: string): void;
}

/** Provided by an app that hosts Kiln's UI (Shuriken Studio's preload for its docked Kiln view). */
export interface KilnHost {
  app: string;
  /** Use this Kiln project as a model in the host app's current project. */
  useModel(kilnProjectId: string, name: string): Promise<{ ok: boolean; error?: string }>;
  dockState(): 'docked' | 'undocked';
  toggleDock(): void;
  /** Shuriken 0.7+: import the model or one of its clips into Roblox Studio (placed and selected there). */
  sendToStudio?(req: { kind: 'model' | 'animation'; projectId: string; name: string; clip?: string }): Promise<{ ok: boolean; error?: string; placed?: unknown; note?: string }>;
}

export interface TabApi {
  /** Tell the window which project this tab shows (for titles, restore and de-duplication). */
  setProject(projectId: string | null): void;
  /** 'focused' when the project is already open in another tab (which is brought forward). */
  openProject(projectId: string): Promise<'ok' | 'focused'>;
  newTab(): void;
  openPath(which: 'logs' | 'watchdog' | 'projects' | 'data' | 'project', projectId?: string): void;
  /** The tab strip asked this tab to show the settings. */
  onSettings(cb: (section: string | null) => void): void;
  /** The tab strip's menu asked to delete the project this tab shows. */
  onDeleteProject?(cb: () => void): void;
}
