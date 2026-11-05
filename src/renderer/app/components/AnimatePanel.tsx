import { useCallback, useEffect, useRef, useState } from 'react';
import { viewer } from '../viewer/engine.ts';
import { actions, getState, kilnHost, useStore } from '../store.ts';
import { Icon } from '../../common/Icon.tsx';
import type { ClipInfo } from '../../../shared/types.ts';
import './animate.css';

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

type Gen = 'gait' | 'idle' | 'attack' | 'hit' | 'death';
const NEW_CLIPS: Array<{ label: string; name: string; generator: Gen; params: Record<string, unknown>; legs?: boolean; group: string }> = [
  { group: 'Move', label: 'Walk', name: 'Walk', generator: 'gait', params: { style: 'walk' }, legs: true },
  { group: 'Move', label: 'Run', name: 'Run', generator: 'gait', params: { style: 'run' }, legs: true },
  { group: 'Move', label: 'Trot (4 legs)', name: 'Trot', generator: 'gait', params: { style: 'trot' }, legs: true },
  { group: 'Move', label: 'Sneak', name: 'Sneak', generator: 'gait', params: { style: 'sneak' }, legs: true },
  { group: 'Idle', label: 'Idle (breathing, looking)', name: 'Idle', generator: 'idle', params: {} },
  { group: 'Attack', label: 'Lunge', name: 'Attack', generator: 'attack', params: { kind: 'lunge' } },
  { group: 'Attack', label: 'Bite', name: 'Bite', generator: 'attack', params: { kind: 'bite' } },
  { group: 'Attack', label: 'Tail sting', name: 'Sting', generator: 'attack', params: { kind: 'sting' } },
  { group: 'Attack', label: 'Front-leg slam', name: 'Slam', generator: 'attack', params: { kind: 'slam' }, legs: true },
  { group: 'React', label: 'Hit reaction', name: 'Hit', generator: 'hit', params: {} },
  { group: 'React', label: 'Death', name: 'Death', generator: 'death', params: {} },
];

interface Slider {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Shown as a percentage of the value. */
  pct?: boolean;
  /** Sized to the creature: the range runs from a fifth to three times the clip's own value. */
  rel?: boolean;
}
const TWEAKS: Record<string, Slider[]> = {
  gait: [
    { key: 'speed', label: 'Speed', min: 0.01, max: 40, step: 0.01, rel: true },
    { key: 'cycle', label: 'Stride time (s)', min: 0.15, max: 3, step: 0.01 },
    { key: 'duty', label: 'Feet down', min: 0.25, max: 0.85, step: 0.01, pct: true },
    { key: 'step_height', label: 'Step height', min: 0, max: 5, step: 0.005, rel: true },
    { key: 'bob', label: 'Body bob', min: 0, max: 2, step: 0.001, rel: true },
    { key: 'lean', label: 'Lean (°)', min: -20, max: 30, step: 0.5 },
  ],
  idle: [
    { key: 'length', label: 'Length (s)', min: 1, max: 12, step: 0.1 },
    { key: 'breathe', label: 'Breathing', min: 0, max: 1, step: 0.001, rel: true },
    { key: 'sway', label: 'Sway (°)', min: 0, max: 8, step: 0.1 },
  ],
  attack: [
    { key: 'reach', label: 'Reach', min: 0, max: 10, step: 0.005, rel: true },
    { key: 'windup', label: 'Wind-up (s)', min: 0.05, max: 1.5, step: 0.01 },
    { key: 'strike', label: 'Strike (s)', min: 0.04, max: 0.6, step: 0.01 },
    { key: 'recover', label: 'Recovery (s)', min: 0.1, max: 2, step: 0.01 },
  ],
  hit: [
    { key: 'strength', label: 'Strength', min: 0.1, max: 3, step: 0.05 },
    { key: 'length', label: 'Length (s)', min: 0.2, max: 2, step: 0.05 },
  ],
  death: [
    { key: 'length', label: 'Length (s)', min: 0.5, max: 4, step: 0.05 },
    { key: 'side', label: 'Falls toward', min: -1, max: 1, step: 2 },
  ],
};

interface RigData {
  info: { joints: Array<{ name: string; parent: string | null; kind: string; limits: unknown }>; legs: Array<{ joints: string[] }> };
  clips: Array<Record<string, unknown>>;
  check: { ok: boolean; issues: string[] };
}

function fmt(t: number) {
  return t < 10 ? t.toFixed(2) : t.toFixed(1);
}

function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open, close]);
  return ref;
}

/** The timeline: events, the playhead, click or drag to scrub (pauses while scrubbing). */
function Timeline({ duration, time, markers, onSeek }: { duration: number; time: number; markers: Array<{ name: string; time: number }>; onSeek: (t: number, done: boolean) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const at = (x: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (x - r.left) / r.width)) * duration;
  };
  const down = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    onSeek(at(e.clientX), false);
  };
  const frames = Math.max(1, Math.round(duration * 30));
  const ticks = frames <= 40 ? 5 : frames <= 120 ? 10 : 30;
  return (
    <div
      className="anim-timeline"
      ref={bar}
      onPointerDown={down}
      onPointerMove={(e) => e.buttons & 1 && onSeek(at(e.clientX), false)}
      onPointerUp={(e) => onSeek(at(e.clientX), true)}
    >
      {Array.from({ length: Math.floor(frames / ticks) + 1 }, (_, i) => (
        <span key={i} className="anim-tick" style={{ left: `${((i * ticks) / frames) * 100}%` }}>
          <em>{i * ticks + 1}</em>
        </span>
      ))}
      {markers.map((m, i) => (
        <span key={i} className={`anim-marker${m.name.startsWith('Step_') ? ' step' : ''}`} style={{ left: `${(m.time / Math.max(duration, 1e-6)) * 100}%` }} title={`${m.name} · ${fmt(m.time)} s`}>
          {!m.name.startsWith('Step_') && <b>{m.name}</b>}
        </span>
      ))}
      <span className="anim-playhead" style={{ left: `${(time / Math.max(duration, 1e-6)) * 100}%` }} />
    </div>
  );
}

function Menu({ label, icon, children, disabled, title }: { label?: string; icon: string; children: (close: () => void) => React.ReactNode; disabled?: boolean; title: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useOutside(open, close);
  return (
    <div className="anim-menu-wrap" ref={ref}>
      <button className={`anim-btn${open ? ' on' : ''}`} disabled={disabled} onClick={() => setOpen(!open)} title={title}>
        <Icon name={icon} size={14} />
        {label && <span>{label}</span>}
      </button>
      {open && <div className="anim-menu glass">{children(close)}</div>}
    </div>
  );
}

export function AnimatePanel({ collapsed, onCollapse }: { collapsed: boolean; onCollapse: (c: boolean) => void }) {
  const rig = useStore((s) => s.scene.summary?.rig ?? null);
  const anim = useStore((s) => s.anim);
  const file = useStore((s) => s.clipsFile);
  const running = useStore((s) => s.running);
  const lock = useStore((s) => s.lock);
  const [drawer, setDrawer] = useState<null | 'tweak' | 'rig' | 'check'>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rigData, setRigData] = useState<RigData | null>(null);
  const [edits, setEdits] = useState<Record<string, number | string | boolean>>({});
  const [report, setReport] = useState<{ summary: string; issues: string[] } | null>(null);
  const [fade, setFade] = useState(0.25);
  const [skeleton, setSkeleton] = useState(false);
  const [trails, setTrails] = useState(false);
  const clips = rig?.clips ?? [];
  const current = anim?.clip ?? rig?.current ?? clips[0]?.name ?? null;
  const info: ClipInfo | undefined = clips.find((c) => c.name === current);
  const fileClip = file?.clips.find((c) => c.name === current);
  const blocked = running || !!lock;
  const legs = (rigData?.info.legs.length ?? 1) > 0;

  // The rig's details (generator settings, the rig check) whenever the clips change.
  const animFp = rig?.anim;
  useEffect(() => {
    if (!rig) return;
    let live = true;
    void actions.rig().then((d) => live && setRigData(d));
    return () => {
      live = false;
    };
  }, [animFp, rig?.joints]);
  useEffect(() => setEdits({}), [current, animFp]);

  const cmd = (c: Parameters<NonNullable<typeof viewer.current>['anim']>[0]) => viewer.current?.anim(c);
  const play = (name: string) => cmd({ play: name, playing: true });

  // Space plays and pauses, arrows step a frame (when not typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || (t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes((t as HTMLInputElement).type));
      if (typing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.settings, .lightbox')) return;
      const a = getState().anim;
      if (!a) return;
      if (e.key === ' ') cmd({ playing: !a.playing });
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') cmd({ playing: false, seek: a.time + (e.key === 'ArrowRight' ? 1 : -1) / 30 });
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!rig) return null;

  const run = async (label: string, name: string, body: Record<string, unknown>) => {
    setBusy(label);
    const r = await actions.clip<{ ok: boolean; error?: string }>(name, body);
    setBusy(null);
    return r;
  };
  const clipData = rigData?.clips.find((c) => c.name === current) as { generator?: string; resolved?: Record<string, number | string>; params?: Record<string, unknown> } | undefined;
  const gen = clipData?.generator ?? info?.generator ?? null;
  const sliders = gen ? (TWEAKS[gen] ?? []) : [];
  const base = (k: string) => (clipData?.resolved?.[k] as number | undefined) ?? (clipData?.params?.[k] as number | undefined) ?? 0;
  const val = (k: string) => (edits[k] as number | undefined) ?? base(k);
  // Ranges come from the clip's saved value only, never from the value being dragged: a range that
  // grew with the slider's own value ran away to huge numbers while the mouse was held down.
  const range = (s: Slider): [number, number] => {
    const b = Math.abs(Number(base(s.key)));
    if (!s.rel) return [s.min, Math.max(s.max, b * 1.25)];
    const r = b || s.step * 10;
    return [Math.max(s.min, r * 0.2), Math.max(r * 3, s.step * 10)];
  };
  const clampTo = (s: Slider, v: number) => {
    const [lo, hi] = range(s);
    return Math.min(hi, Math.max(lo, v));
  };
  const dirty = Object.keys(edits).length > 0;
  const markers = (fileClip?.markers ?? []).map((m) => ({ name: m.name, time: m.time }));
  const canStudio = typeof kilnHost?.sendToStudio === 'function';

  if (collapsed) {
    return (
      <div className="anim-dock collapsed glass">
        <button className="anim-btn" onClick={() => onCollapse(false)} title="Show the Animate panel">
          <Icon name="play" size={14} />
          <span>Animate</span>
          <span className="muted">{clips.length ? `${clips.length} clip${clips.length > 1 ? 's' : ''}` : 'rigged'}</span>
        </button>
      </div>
    );
  }

  return (
    <div
      className="anim-dock glass"
      // A clicked button or slider gives the keyboard back: Space and the arrows stay playback keys
      // (they used to act on whatever was clicked last, or do nothing at all).
      onPointerUp={(e) => {
        const t = (e.target as HTMLElement).closest('button, input[type="range"]');
        if (t) setTimeout(() => (document.activeElement as HTMLElement | null)?.blur?.(), 0);
      }}
    >
      <div className="anim-row anim-head">
        <span className="anim-title">
          <Icon name="play" size={13} />
          Animate
          <span className="muted">
            {rig.joints} joints{blocked ? ` · ${lock ? `${lock.by} is working` : 'the copilot is working'}` : ''}
          </span>
        </span>
        <div className="anim-clips">
          {clips.map((c) => (
            <button key={c.name} className={`anim-clip${c.name === current ? ' on' : ''}`} onClick={() => play(c.name)} title={`${c.length.toFixed(2)} s${c.loop ? ' · loops' : ''}${c.speed ? ` · ${c.speed.toFixed(2)}/s` : ''}${c.generator ? ` · made by ${c.generator}` : ''}`}>
              {c.loop && <Icon name="refresh" size={11} />}
              {c.name}
            </button>
          ))}
          {!clips.length && <span className="muted anim-empty">No clips yet: add one, or ask the copilot for a walk, an attack…</span>}
        </div>
        <Menu icon="plus" label="Clip" title="Add a clip (made in about a second, no copilot)" disabled={blocked || !!busy}>
          {(close) =>
            ['Move', 'Idle', 'Attack', 'React'].map((g) => (
              <div key={g} className="anim-menu-group">
                <div className="anim-menu-label">{g}</div>
                {NEW_CLIPS.filter((n) => n.group === g && (!n.legs || legs)).map((n) => (
                  <button
                    key={n.label}
                    className="menu-item"
                    onClick={async () => {
                      close();
                      let name = n.name;
                      for (let i = 2; clips.some((c) => c.name === name); i++) name = `${n.name}_${i}`;
                      const r = await run(`Making ${name}…`, name, { action: 'generate', generator: n.generator, params: n.params });
                      if (r?.ok) setTimeout(() => play(name), 400);
                    }}
                  >
                    {n.label}
                  </button>
                ))}
              </div>
            ))
          }
        </Menu>
        <button className="anim-btn icon" onClick={() => onCollapse(true)} title="Hide the panel">
          <Icon name="chevron" size={14} className="chev open" />
        </button>
      </div>

      {current && (
        <div className="anim-row anim-transport">
          <button className="anim-btn icon" onClick={() => cmd({ seek: 0, playing: true })} title="From the start">
            <Icon name="refresh" size={14} />
          </button>
          <button className="anim-btn icon play" onClick={() => cmd({ playing: !anim?.playing })} title="Play / pause · Space">
            <Icon name={anim?.playing ? 'pause' : 'play'} size={15} />
          </button>
          <span className="anim-time">
            {fmt(anim?.time ?? 0)} / {fmt(anim?.duration ?? info?.length ?? 0)} s<span className="muted"> · F{Math.round((anim?.time ?? 0) * 30) + 1}</span>
          </span>
          <Timeline
            duration={anim?.duration ?? info?.length ?? 1}
            time={anim?.time ?? 0}
            markers={markers}
            onSeek={(t, done) => cmd({ playing: done ? (anim?.playing ?? false) : false, seek: t })}
          />
          <button className={`anim-btn${anim?.loop ? ' on' : ''}`} onClick={() => cmd({ loop: !anim?.loop })} title="Loop playback">
            <Icon name="refresh" size={13} />
          </button>
          <select className="anim-select" value={anim?.speed ?? 1} onChange={(e) => cmd({ speed: Number(e.target.value) })} title="Playback speed">
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </div>
      )}

      {current && (
        <div className="anim-row anim-tools">
          <button
            className={`anim-btn${skeleton ? ' on' : ''}`}
            onClick={() => {
              setSkeleton(!skeleton);
              cmd({ skeleton: !skeleton });
            }}
            title="Show the joints"
          >
            <Icon name="target" size={13} />
            <span>Skeleton</span>
          </button>
          <button
            className={`anim-btn${trails ? ' on' : ''}`}
            onClick={() => {
              setTrails(!trails);
              cmd({ trails: !trails });
            }}
            title="Paths of the feet, tail tip and head over the clip"
          >
            <Icon name="spark" size={13} />
            <span>Trails</span>
          </button>
          <Menu icon="layers" label="Blend" title="Preview a transition into another clip, as the game would blend them">
            {(close) => (
              <>
                <div className="anim-menu-label">Blend into… over {fade.toFixed(2)} s</div>
                <input className="anim-range" type="range" min={0.05} max={1} step={0.05} value={fade} onChange={(e) => setFade(Number(e.target.value))} />
                {clips
                  .filter((c) => c.name !== current)
                  .map((c) => (
                    <button
                      key={c.name}
                      className="menu-item"
                      onClick={() => {
                        cmd({ blend: { to: c.name, fade } });
                        close();
                      }}
                    >
                      {current} → {c.name}
                    </button>
                  ))}
              </>
            )}
          </Menu>
          <button
            className={`anim-btn${drawer === 'check' ? ' on' : ''}`}
            disabled={!!busy}
            onClick={async () => {
              if (drawer === 'check') return setDrawer(null);
              setBusy('Checking…');
              const r = await actions.clip<{ summary: string; issues: string[] }>(current, { action: 'check' });
              setBusy(null);
              if (r) {
                setReport(r);
                setDrawer('check');
              }
            }}
            title="Check every frame: sliding feet, parts in the ground or in each other, limits, jerks, loop seams"
          >
            <Icon name="check" size={13} />
            <span>Check</span>
          </button>
          <button className={`anim-btn${drawer === 'tweak' ? ' on' : ''}`} onClick={() => setDrawer(drawer === 'tweak' ? null : 'tweak')} title="Tune this clip">
            <Icon name="sliders" size={13} />
            <span>Tweak</span>
          </button>
          <button className={`anim-btn${drawer === 'rig' ? ' on' : ''}`} onClick={() => setDrawer(drawer === 'rig' ? null : 'rig')} title="The rig's joints and its check">
            <Icon name="cube" size={13} />
            <span>Rig</span>
            {rigData && !rigData.check.ok && <span className="anim-dot" />}
          </button>
          {canStudio && (
            <button
              className="anim-btn studio"
              disabled={!!busy}
              onClick={async () => {
                setBusy(`Sending ${current} to Roblox Studio…`);
                await actions.sendToStudio('animation', current);
                setBusy(null);
              }}
              title="Import this clip into Roblox Studio (through Shuriken)"
            >
              <Icon name="arrowUpRight" size={13} />
              <span>Send to Studio</span>
            </button>
          )}
          {busy && <span className="anim-busy">{busy}</span>}
          {anim?.blending && <span className="anim-busy">Blending into {anim.blending}…</span>}
        </div>
      )}

      {drawer === 'check' && report && (
        <div className="anim-drawer">
          <div className="anim-drawer-title">{report.issues.length ? `${report.issues.length} thing${report.issues.length > 1 ? 's' : ''} to fix in ${current}` : `${current}: no problems found`}</div>
          <ul className="anim-issues">
            {report.issues.map((s, i) => {
              const f = /frame (\d+)/.exec(s);
              return (
                <li key={i}>
                  {f ? (
                    <button onClick={() => cmd({ playing: false, seek: (Number(f[1]) - 1) / 30 })} title="Go to that frame">
                      {s}
                    </button>
                  ) : (
                    s
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {drawer === 'tweak' && info && (
        <div className="anim-drawer">
          <div className="anim-drawer-title">
            {current}
            <span className="muted">{gen ? ` · made by ${gen}: change a value and apply (about a second)` : ' · hand-made (ask the copilot to change it)'}</span>
          </div>
          {sliders.length > 0 && (
            <div className="anim-sliders">
              {sliders.map((s) => (
                <label key={s.key} className={`anim-slider${edits[s.key] !== undefined ? ' changed' : ''}`}>
                  <span>{s.label}</span>
                  <input type="range" min={range(s)[0]} max={range(s)[1]} step={s.step} value={clampTo(s, Number(val(s.key)))} onChange={(e) => setEdits((cur) => ({ ...cur, [s.key]: clampTo(s, Number(e.target.value)) }))} />
                  <em>{s.pct ? `${Math.round(Number(val(s.key)) * 100)}%` : Number(val(s.key)).toFixed(s.step < 0.01 ? 3 : 2)}</em>
                </label>
              ))}
              {gen === 'gait' && (
                <label className="anim-slider">
                  <span>Style</span>
                  <select className="anim-select" value={String(edits.style ?? clipData?.resolved?.style ?? 'walk')} onChange={(e) => setEdits({ ...edits, style: e.target.value, speed: undefined as unknown as number, cycle: undefined as unknown as number })}>
                    {['sneak', 'walk', 'trot', 'run'].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                  <em />
                </label>
              )}
            </div>
          )}
          <div className="anim-drawer-row">
            <label className="anim-check">
              <input type="checkbox" checked={info.loop} disabled={blocked} onChange={(e) => void run('Saving…', current!, { action: 'settings', settings: { loop: e.target.checked } })} />
              Loops
            </label>
            <label className="anim-check">
              <input type="checkbox" checked={info.in_place} disabled={blocked} onChange={(e) => void run('Saving…', current!, { action: 'settings', settings: { in_place: e.target.checked } })} />
              In place
            </label>
            <label className="anim-check">
              Priority
              <select className="anim-select" value={info.priority} disabled={blocked} onChange={(e) => void run('Saving…', current!, { action: 'settings', settings: { priority: e.target.value } })}>
                {['Idle', 'Movement', 'Action', 'Core'].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            <span className="grow" />
            <button
              className="anim-btn"
              disabled={blocked}
              onClick={() => {
                const to = window.prompt('Rename the clip (letters, digits, underscore):', current!);
                if (to && to !== current) void run('Renaming…', current!, { action: 'rename', to });
              }}
            >
              <Icon name="pencil" size={13} />
              <span>Rename</span>
            </button>
            <button
              className="anim-btn danger"
              disabled={blocked}
              onClick={() => {
                if (window.confirm(`Delete the clip ${current}? (Undo brings it back.)`)) void run('Deleting…', current!, { action: 'delete' });
              }}
            >
              <Icon name="trash" size={13} />
            </button>
            {sliders.length > 0 && (
              <>
                <button className="anim-btn" disabled={!dirty} onClick={() => setEdits({})}>
                  Reset
                </button>
                <button
                  className="anim-btn primary"
                  disabled={!dirty || blocked || !!busy}
                  onClick={async () => {
                    const params = Object.fromEntries(Object.entries(edits).filter(([, v]) => v !== undefined));
                    const r = await run(`Rebuilding ${current}…`, current!, { action: 'regenerate', params });
                    if (r?.ok) setEdits({});
                  }}
                >
                  Apply
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {drawer === 'rig' && (
        <div className="anim-drawer">
          <div className="anim-drawer-title">
            Rig · {rig.joints} joints · {rigData?.info.legs.length ?? 0} legs
            <span className="muted">{rigData?.check.ok ? ' · ready to animate' : ''}</span>
          </div>
          {rigData && !rigData.check.ok && (
            <ul className="anim-issues warn">
              {rigData.check.issues.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          )}
          <div className="anim-joints">
            {(rigData?.info.joints ?? []).map((j) => (
              <span key={j.name} className={`anim-joint ${j.kind}`} title={`${j.kind}${j.parent ? ` · under ${j.parent}` : ' · root'}${j.limits ? ` · limits ${JSON.stringify(j.limits)}` : ''}`}>
                {j.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
