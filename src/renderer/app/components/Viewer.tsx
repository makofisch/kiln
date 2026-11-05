import { useEffect, useRef, useState } from 'react';
import { Engine, viewer, type Lighting } from '../viewer/engine.ts';
import { actions, getState, notify, useStore } from '../store.ts';
import { Icon } from '../../common/Icon.tsx';
import { PixelMark } from '../../common/PixelMark.tsx';
import { formatTokens } from '../lib/text.ts';
import { describeLighting } from '../../../shared/roblox.ts';
import { isRoblox, type ClipsFile, type Todo } from '../../../shared/types.ts';
import { AnimatePanel } from './AnimatePanel.tsx';

function ToolButton({ icon, label, active, disabled, onClick }: { icon: string; label: string; active?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button className={`tool-btn${active ? ' on' : ''}`} onClick={onClick} disabled={disabled} aria-label={label} data-tip={label}>
      <Icon name={icon} size={17} />
    </button>
  );
}

function Plan({ todos }: { todos: Todo[] }) {
  const [open, setOpen] = useState(true);
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="glass plan">
      <button className="plan-head" onClick={() => setOpen(!open)}>
        <Icon name="plan" size={15} />
        <span>Plan</span>
        <span className="plan-count">
          {done}/{todos.length}
        </span>
        <div className="plan-bar">
          <div style={{ width: `${(done / todos.length) * 100}%` }} />
        </div>
        <Icon name="chevron" size={14} className={`chev${open ? ' open' : ''}`} />
      </button>
      {open && (
        <ul className="plan-list">
          {todos.map((t, i) => (
            <li key={i} className={`todo ${t.status}`} style={{ animationDelay: `${i * 30}ms` }}>
              <span className="todo-mark">{t.status === 'completed' ? <Icon name="check" size={12} /> : null}</span>
              <span className="todo-text">{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Outliner({ onPick }: { onPick: (name: string) => void }) {
  const summary = useStore((s) => s.scene.summary);
  const selected = useStore((s) => s.selected);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const list = summary?.list ?? [];
  if (!list.length) return null;
  const shown = filter ? list.filter((o) => o.name.toLowerCase().includes(filter.toLowerCase())) : list;
  return (
    <div className={`glass outliner${open ? ' open' : ''}`}>
      <button className="outliner-head" onClick={() => setOpen(!open)}>
        <Icon name="layers" size={15} />
        <span>Outliner</span>
        <span className="muted">{summary!.objects}</span>
        <Icon name="chevron" size={14} className={`chev${open ? ' open' : ''}`} />
      </button>
      {open && (
        <>
          {list.length > 8 && <input className="outliner-filter" placeholder="Filter objects…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
          <ul className="outliner-list">
            {shown.map((o) => (
              <li key={o.name}>
                <button className={`outliner-row${selected === o.name ? ' sel' : ''}${o.hidden ? ' hidden' : ''}`} onClick={() => onPick(o.name)}>
                  <Icon name={o.type === 'MESH' ? 'cube' : o.type === 'LIGHT' ? 'bulb' : 'spark'} size={13} />
                  <span className="name">{o.name}</span>
                  {o.tris ? <span className="muted">{formatTokens(o.tris)}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function DownloadMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const formats: Array<[string, string]> = [
    ['glb', 'glTF binary (.glb)'],
    ['fbx', 'FBX (.fbx)'],
    ['obj', 'Wavefront (.obj)'],
    ['stl', 'STL for printing (.stl)'],
    ['blend', 'Blender file (.blend)'],
  ];
  return (
    <div className="menu-wrap" ref={ref}>
      <ToolButton icon="download" label="Download the scene" active={open} onClick={() => setOpen(!open)} />
      {open && (
        <div className="menu glass">
          {formats.map(([f, label]) => (
            <button
              key={f}
              className="menu-item"
              onClick={() => {
                actions.download(f);
                setOpen(false);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ['Orbit · pan · zoom', 'Left drag · right drag · wheel'],
  ['Select an object', 'Click · Esc clears'],
  ['Frame the subject or selection', 'F · double-click'],
  ['Front · right · top · 3/4 view', '1 · 3 · 7 · 0'],
  ['Wireframe · clay · grid · turntable', 'W · C · G · T'],
  ['Scene or studio lighting', 'L'],
  ['Roblox preview: lit like the game', 'R'],
  ['New tab · close · detach', 'Ctrl+Shift+N · Ctrl+W · Ctrl+Shift+D'],
];

export function Viewer() {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const scene = useStore((s) => s.scene);
  const selected = useStore((s) => s.selected);
  const todos = useStore((s) => s.todos);
  const running = useStore((s) => s.running);
  const blender = useStore((s) => s.blender);
  const units = useStore((s) => s.project?.units ?? 'm');
  const project = useStore((s) => s.project);
  const roblox = isRoblox(project);
  const placeLight = project?.lighting ?? null;
  const lock = useStore((s) => s.lock);
  const [loading, setLoading] = useState(false);
  const [pulse, setPulse] = useState(0);
  const viewerSettings = useStore((s) => s.app?.settings.viewer);
  const [modes, setModes] = useState(() => ({ wireframe: false, clay: false, grid: getState().app?.settings.viewer.grid ?? true, autoRotate: false }));
  const [lighting, setLighting] = useState<Lighting>('studio');
  const [hasLights, setHasLights] = useState(false);
  const [hover, setHover] = useState<{ name: string; x: number; y: number } | null>(null);
  const [help, setHelp] = useState(false);
  const [animCollapsed, setAnimCollapsed] = useState(false);

  useEffect(() => {
    let thumbTimer: ReturnType<typeof setTimeout> | null = null;
    let thumbVersion = -1;
    const e = new Engine(host.current!, {
      onLoading: setLoading,
      onLoaded: () => {
        setPulse((p) => p + 1);
        setHasLights(e.hasSceneLights);
        setLighting(e.lighting);
        // A thumbnail for the start page's recent projects, once the scene settles.
        if (thumbTimer) clearTimeout(thumbTimer);
        thumbTimer = setTimeout(() => {
          const v = getState().scene.version;
          if (v === thumbVersion || !e.hasModel) return;
          thumbVersion = v;
          void actions.thumb(e.snapshot(420, 0.8));
        }, 1800);
      },
      onSelect: (name) => actions.select(name),
      onHover: setHover,
      onError: (m) => notify('error', m),
      onAnim: (s) => actions.setAnim(s),
    });
    engine.current = e;
    viewer.current = e;
    return () => {
      if (thumbTimer) clearTimeout(thumbTimer);
      viewer.current = null;
      e.dispose();
    };
  }, []);

  useEffect(() => {
    void engine.current?.load(scene.glb, scene.summary?.world ?? null);
  }, [scene.glb]);

  // The rig's clips, sampled by Kiln: the viewer plays them on the model (the same data Roblox gets).
  const clipsUrl = scene.clips ?? null;
  useEffect(() => {
    let live = true;
    if (!clipsUrl) {
      actions.setClipsFile(null);
      engine.current?.setClips(null);
      return;
    }
    void fetch(clipsUrl)
      .then((r) => (r.ok ? (r.json() as Promise<ClipsFile>) : null))
      .then((data) => {
        if (!live) return;
        actions.setClipsFile(data);
        engine.current?.setClips(data, getState().scene.summary?.rig?.current ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [clipsUrl]);
  // Follow the clip the copilot (or the Animate panel) chose to show.
  const shownClip = scene.summary?.rig?.current ?? null;
  useEffect(() => {
    if (shownClip && getState().anim?.clip !== shownClip) engine.current?.anim({ play: shownClip });
  }, [shownClip]);

  useEffect(() => {
    engine.current?.setSelected(selected);
  }, [selected, pulse]);

  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    e.modes = { ...modes };
    e.applyModes();
  }, [modes]);

  // Settings → Viewer: brightness, glow and lighting apply live.
  useEffect(() => {
    const e = engine.current;
    if (!e || !viewerSettings) return;
    e.applySettings(viewerSettings);
    setLighting(e.lighting);
  }, [viewerSettings?.exposure, viewerSettings?.bloom, viewerSettings?.glow, viewerSettings?.lighting]);
  // A Roblox project is previewed under its game's lighting (R switches it on for any project).
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    e.setRoblox(placeLight, roblox);
    setLighting(e.lighting);
  }, [roblox, JSON.stringify(placeLight)]);
  const gridDefault = viewerSettings?.grid;
  useEffect(() => {
    if (gridDefault !== undefined) setModes((m) => ({ ...m, grid: gridDefault }));
  }, [gridDefault]);

  const toggle = (k: keyof typeof modes) => setModes((m) => ({ ...m, [k]: !m[k] }));
  const switchLighting = () => {
    const next: Lighting = lighting === 'scene' ? 'studio' : 'scene';
    engine.current?.setLighting(next);
    setLighting(next);
  };
  const switchRoblox = () => {
    const next: Lighting = lighting === 'roblox' ? (hasLights && viewerSettings?.lighting !== 'studio' ? 'scene' : 'studio') : 'roblox';
    engine.current?.setLighting(next);
    setLighting(next);
  };

  // Blender-style keys in the viewer (not while typing).
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement;
      const typing = t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || (t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes((t as HTMLInputElement).type));
      // Not while typing, and not behind the settings or a full-size image.
      if (typing || ev.ctrlKey || ev.metaKey || ev.altKey || document.querySelector('.settings, .lightbox')) return;
      const e = engine.current;
      const k = ev.key.toLowerCase();
      if (k === 'f') {
        if (selected) e?.frameByName(selected);
        else e?.frame();
      } else if (k === 'escape') {
        actions.select(null);
        setHelp(false);
      } else if (k === 'w') toggle('wireframe');
      else if (k === 'c') toggle('clay');
      else if (k === 'g') toggle('grid');
      else if (k === 't') toggle('autoRotate');
      else if (k === 'l' && hasLights) switchLighting();
      else if (k === 'r') switchRoblox();
      else if (k === '1') e?.view('front');
      else if (k === '3') e?.view('right');
      else if (k === '7') e?.view('top');
      else if (k === '0') e?.view('iso');
      else if (k === '?') setHelp((h) => !h);
      else return;
      ev.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const summary = scene.summary;
  const empty = !summary || summary.objects === 0;
  const booting = blender.status === 'starting' || blender.status === 'restarting';

  return (
    <section className={`stage${lighting === 'scene' && hasLights ? ' scene-lit' : ''}${summary?.rig ? ' has-anim' : ''}${animCollapsed ? ' anim-collapsed' : ''}`}>
      <div className="stage-canvas" ref={host} />
      <div key={pulse} className={`stage-sweep${pulse ? ' go' : ''}`} />

      <div className="stage-top-left">
        <div className="glass scene-badge">
          <div className="scene-title">
            <span className={`live-dot${running ? ' busy' : ''}`} />
            Scene
            <span key={scene.version} className="version">
              v{scene.version}
            </span>
            {(loading || running) && <PixelMark size={16} working />}
            {lighting === 'roblox' && (
              <span className="rbx-tag" title={`Lit like the Roblox game: ${describeLighting(placeLight)}. Coat, subsurface and see-through are off, as Roblox can't show them. Press R for Kiln's own light.`}>
                Roblox light
              </span>
            )}
          </div>
          {!empty && (
            <div className="scene-stats">
              <span>
                <b>{summary!.objects}</b> objects
              </span>
              <span>
                <b>{formatTokens(summary!.tris)}</b> tris
              </span>
              {summary!.bounds && <span className="dims">{summary!.bounds.size.map((v) => (v < 10 ? v.toFixed(2) : v.toFixed(1))).join(' × ')} {units === 'studs' ? 'studs' : 'm'}</span>}
            </div>
          )}
        </div>
        <Plan todos={todos} />
      </div>

      <div className="glass toolbar">
        <ToolButton icon="focus" label="Frame the subject · F" onClick={() => engine.current?.frame()} />
        {hasLights && (
          <ToolButton icon={lighting === 'scene' ? 'bulb' : 'sun'} label={lighting === 'scene' ? 'The scene’s own lighting · L' : 'Studio lighting · L'} active={lighting === 'scene'} onClick={switchLighting} />
        )}
        <ToolButton
          icon="globe"
          label={lighting === 'roblox' ? `Roblox preview: lit like the game (${describeLighting(placeLight)}), showing only what Roblox can show · R` : 'Roblox preview: see the model as a Roblox game lights it · R'}
          active={lighting === 'roblox'}
          onClick={switchRoblox}
        />
        <ToolButton icon="wire" label="Wireframe · W" active={modes.wireframe} onClick={() => toggle('wireframe')} />
        <ToolButton icon="clay" label="Clay: ignore materials · C" active={modes.clay} onClick={() => toggle('clay')} />
        <ToolButton icon="grid" label="Grid and shadows · G" active={modes.grid} onClick={() => toggle('grid')} />
        <ToolButton icon="orbit" label="Turntable · T" active={modes.autoRotate} onClick={() => toggle('autoRotate')} />
        <span className="tool-sep" />
        <ToolButton icon="undo" label={lock ? `${lock.by} is building this model` : 'Undo the last change'} disabled={!scene.canUndo || running || !!lock} onClick={() => void actions.undo()} />
        <DownloadMenu />
        <ToolButton icon="keyboard" label="Shortcuts · ?" active={help} onClick={() => setHelp(!help)} />
      </div>

      {hover && hover.name !== selected && (
        <div className="hover-tag" style={{ left: hover.x + 14, top: hover.y + 16 }}>
          {hover.name}
        </div>
      )}

      {help && (
        <div className="glass shortcuts" onClick={() => setHelp(false)}>
          <div className="shortcuts-title">Viewer shortcuts</div>
          {SHORTCUTS.map(([a, b]) => (
            <div key={a} className="shortcut-row">
              <span>{a}</span>
              <kbd>{b}</kbd>
            </div>
          ))}
        </div>
      )}

      <Outliner
        onPick={(name) => {
          actions.select(name);
          engine.current?.frameByName(name);
        }}
      />

      {selected && (
        <div className="glass selection-chip">
          <Icon name="target" size={14} />
          <span>{selected}</span>
          <button onClick={() => engine.current?.frameByName(selected)} title="Frame it (F)">
            <Icon name="focus" size={14} />
          </button>
          <button onClick={() => actions.select(null)} title="Deselect (Esc)">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      {summary?.rig && <AnimatePanel collapsed={animCollapsed} onCollapse={setAnimCollapsed} />}

      {empty && !booting && blender.status !== 'missing' && (
        <div className="stage-empty">
          <div className="stage-empty-title">An empty scene</div>
          <div className="stage-empty-sub">Describe something and the copilot builds it here, live.</div>
        </div>
      )}
      {(booting || blender.status === 'missing' || blender.status === 'failed') && (
        <div className={`glass stage-status ${blender.status}`}>
          {booting && <PixelMark size={18} working />}
          {blender.status === 'missing' || blender.status === 'failed' ? <Icon name="alert" size={15} /> : null}
          <span>
            {blender.status === 'starting' && 'Warming up Blender…'}
            {blender.status === 'restarting' && (blender.detail ?? 'Restarting Blender…')}
            {(blender.status === 'missing' || blender.status === 'failed') && (blender.detail ?? 'Blender is unavailable')}
          </span>
        </div>
      )}
    </section>
  );
}
