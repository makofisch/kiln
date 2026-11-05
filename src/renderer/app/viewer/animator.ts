import * as THREE from 'three';
import type { ClipsFile } from '../../../shared/types.ts';

export interface AnimState {
  clip: string | null;
  playing: boolean;
  /** Seconds into the clip. */
  time: number;
  duration: number;
  speed: number;
  loop: boolean;
  /** The clip being blended to, during a crossfade preview. */
  blending: string | null;
}

// Blender (Z up) to glTF/three (Y up): (x, y, z) -> (x, z, -y).
const toThree = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y);

/**
 * Kiln's clips on the loaded model. Each clip is rebuilt from the same sampled data other apps get
 * (Shuriken turns it into Roblox animations), as a three.js AnimationClip on the rig's bones, so the
 * viewer plays exactly what exports. Skinned meshes deform on the GPU; rigid parts ride their bones.
 */
export class Animator {
  readonly mixer: THREE.AnimationMixer;
  private clips = new Map<string, THREE.AnimationClip>();
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private currentName: string | null = null;
  private blendName: string | null = null;
  /** The crossfade in progress: the clip being left and how much of the fade remains (in clip time). */
  private fade: { from: THREE.AnimationAction; left: number } | null = null;
  /** Called when playback changes by itself (a one-shot clip reached its end). */
  onChange: (() => void) | null = null;
  private bones = new Map<string, THREE.Object3D>();
  private parentOf = new Map<string, string | null>();
  private root: THREE.Object3D;
  private overlay = new THREE.Group();
  private skeleton: THREE.LineSegments | null = null;
  private joints: THREE.Points | null = null;
  private trailGroup: THREE.Group | null = null;
  readonly data: ClipsFile;
  speed = 1;
  loop = true;
  playing = true;
  showSkeleton = false;
  showTrails = false;

  constructor(root: THREE.Object3D, data: ClipsFile, scene: THREE.Scene) {
    this.root = root;
    this.data = data;
    this.mixer = new THREE.AnimationMixer(root);
    this.mixer.addEventListener('finished', (e) => {
      if (e.action !== this.current || this.fade) return;
      this.playing = false;
      this.mixer.timeScale = 0;
      this.onChange?.();
    });
    const names = new Set(data.joints.map((j) => j.name));
    root.traverse((o) => {
      if ((o as THREE.Bone).isBone && names.has(o.name) && !this.bones.has(o.name)) this.bones.set(o.name, o);
    });
    // Rigs without skinned meshes may load their joints as plain nodes.
    if (!this.bones.size) {
      root.traverse((o) => {
        if (names.has(o.name) && !(o as THREE.Mesh).isMesh && !this.bones.has(o.name)) this.bones.set(o.name, o);
      });
    }
    for (const j of data.joints) this.parentOf.set(j.name, j.parent);
    root.updateMatrixWorld(true);
    const inv = root.matrixWorld.clone().invert();
    const restWorld = new Map<string, THREE.Matrix4>();
    const restParent = new Map<string, THREE.Matrix4>();
    for (const [n, b] of this.bones) {
      restWorld.set(n, inv.clone().multiply(b.matrixWorld));
      restParent.set(n, b.parent ? inv.clone().multiply(b.parent.matrixWorld) : new THREE.Matrix4());
    }
    const T = new THREE.Matrix4();
    const R = new THREE.Matrix4();
    const Ti = new THREE.Matrix4();
    const L = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    for (const c of data.clips) {
      const n = Math.max(1, c.samples);
      const times = Float32Array.from({ length: n }, (_, k) => k / data.fps);
      const tracks: THREE.KeyframeTrack[] = [];
      for (const [name, bone] of this.bones) {
        const W0 = restWorld.get(name)!;
        const P0inv = restParent.get(name)!.clone().invert();
        const head = new THREE.Vector3().setFromMatrixPosition(W0);
        const raw = c.tracks[name];
        const qv = new Float32Array(n * 4);
        const pv = new Float32Array(n * 3);
        let prev: THREE.Quaternion | null = null;
        for (let k = 0; k < n; k++) {
          const o = k * 7;
          const q = raw ? new THREE.Quaternion(raw[o + 1]!, raw[o + 3]!, -raw[o + 2]!, raw[o]!) : new THREE.Quaternion();
          const t = raw ? toThree(raw[o + 4]!, raw[o + 5]!, raw[o + 6]!) : new THREE.Vector3();
          // Local = parentRest^-1 * [T(head + t) * R * T(-head)] * rest
          T.makeTranslation(head.x + t.x, head.y + t.y, head.z + t.z);
          R.makeRotationFromQuaternion(q.normalize());
          Ti.makeTranslation(-head.x, -head.y, -head.z);
          L.copy(P0inv).multiply(T).multiply(R).multiply(Ti).multiply(W0);
          L.decompose(pos, quat, scl);
          if (prev && prev.dot(quat) < 0) quat.set(-quat.x, -quat.y, -quat.z, -quat.w);
          prev = quat.clone();
          quat.toArray(qv, k * 4);
          pos.toArray(pv, k * 3);
        }
        tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.uuid}.quaternion`, times, qv));
        tracks.push(new THREE.VectorKeyframeTrack(`${bone.uuid}.position`, times, pv));
      }
      const clip = new THREE.AnimationClip(c.name, n > 1 ? (n - 1) / data.fps : 0.001, tracks);
      this.clips.set(c.name, clip);
    }
    // Deformed meshes can leave their rest bounds: never cull them.
    root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false;
    });
    this.overlay.renderOrder = 999;
    scene.add(this.overlay);
  }

  get clipNames(): string[] {
    return [...this.clips.keys()];
  }

  private action(name: string): THREE.AnimationAction | null {
    const clip = this.clips.get(name);
    if (!clip) return null;
    let a = this.actions.get(name);
    if (!a) {
      a = this.mixer.clipAction(clip);
      this.actions.set(name, a);
    }
    const info = this.data.clips.find((c) => c.name === name);
    const loops = info ? info.loop && this.loop : this.loop;
    a.setLoop(loops ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    a.clampWhenFinished = true;
    return a;
  }

  play(name: string) {
    const a = this.action(name);
    if (!a) return;
    this.mixer.stopAllAction();
    a.reset().play();
    this.current = a;
    this.currentName = name;
    this.blendName = null;
    this.fade = null;
    this.mixer.timeScale = this.playing ? this.speed : 0;
    this.mixer.update(0);
    this.refreshTrails();
  }

  /** Crossfades from the current clip into another over `fade` seconds (how the game would blend them). */
  blendTo(name: string, fade: number) {
    const b = this.action(name);
    if (!b || !this.current || b === this.current) return this.play(name);
    // A fade still under way ends here: its old clip must not linger under the new one.
    if (this.fade && this.fade.from !== b) this.fade.from.stop();
    const span = Math.max(0.05, fade);
    b.reset().play();
    this.current.crossFadeTo(b, span, false);
    this.blendName = name;
    // The fade runs in clip time (it slows with the speed slider and waits while paused), so the old
    // clip is let go in update(), not by a wall-clock timer that could cut it off half-way.
    this.fade = { from: this.current, left: span };
    this.current = b;
    this.currentName = name;
    this.playing = true;
    this.mixer.timeScale = this.speed;
  }

  setPlaying(p: boolean) {
    // Play on a one-shot clip that has run out starts it again.
    if (p && this.current && !this.current.isRunning() && this.current.time >= this.current.getClip().duration - 1e-4) this.current.reset().play();
    this.playing = p;
    this.mixer.timeScale = p ? this.speed : 0;
  }

  setSpeed(s: number) {
    this.speed = s;
    if (this.playing) this.mixer.timeScale = s;
  }

  setLoop(l: boolean) {
    this.loop = l;
    if (this.currentName) {
      const t = this.current?.time ?? 0;
      this.action(this.currentName);
      if (this.current) this.current.time = t;
    }
  }

  seek(t: number) {
    if (!this.current) return;
    const d = this.current.getClip().duration;
    this.current.paused = false;
    this.current.enabled = true;
    this.current.time = Math.max(0, Math.min(d, t));
    this.mixer.update(0);
  }

  update(dt: number) {
    this.mixer.update(dt);
    if (this.fade) {
      this.fade.left -= dt * Math.abs(this.mixer.timeScale);
      if (this.fade.left <= 0) {
        if (this.fade.from !== this.current) this.fade.from.stop();
        this.current?.setEffectiveWeight(1);
        this.fade = null;
        this.blendName = null;
        this.onChange?.();
      }
    }
    if (this.showSkeleton) this.updateSkeleton();
  }

  state(): AnimState {
    const d = this.current?.getClip().duration ?? 0;
    return { clip: this.currentName, playing: this.playing, time: this.current?.time ?? 0, duration: d, speed: this.speed, loop: this.loop, blending: this.blendName };
  }

  // --- overlays ------------------------------------------------------------------------------------------

  setSkeleton(on: boolean) {
    this.showSkeleton = on;
    if (!on) {
      if (this.skeleton) this.overlay.remove(this.skeleton);
      if (this.joints) this.overlay.remove(this.joints);
      this.skeleton = null;
      this.joints = null;
      return;
    }
    const pairs = [...this.bones.keys()].filter((n) => this.parentOf.get(n) && this.bones.has(this.parentOf.get(n)!));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pairs.length * 6), 3));
    this.skeleton = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xffb35c, depthTest: false, transparent: true, opacity: 0.95 }));
    this.skeleton.userData.pairs = pairs;
    this.skeleton.renderOrder = 999;
    this.skeleton.frustumCulled = false;
    const jg = new THREE.BufferGeometry();
    jg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.bones.size * 3), 3));
    this.joints = new THREE.Points(jg, new THREE.PointsMaterial({ color: 0xffe2b8, size: 6, sizeAttenuation: false, depthTest: false, transparent: true }));
    this.joints.renderOrder = 1000;
    this.joints.frustumCulled = false;
    this.overlay.add(this.skeleton, this.joints);
    this.updateSkeleton();
  }

  private updateSkeleton() {
    if (!this.skeleton || !this.joints) return;
    this.root.updateMatrixWorld(true);
    const p = this.skeleton.geometry.getAttribute('position') as THREE.BufferAttribute;
    const pairs = this.skeleton.userData.pairs as string[];
    const a = new THREE.Vector3();
    pairs.forEach((n, i) => {
      a.setFromMatrixPosition(this.bones.get(n)!.matrixWorld);
      p.setXYZ(i * 2, a.x, a.y, a.z);
      a.setFromMatrixPosition(this.bones.get(this.parentOf.get(n)!)!.matrixWorld);
      p.setXYZ(i * 2 + 1, a.x, a.y, a.z);
    });
    p.needsUpdate = true;
    const jp = this.joints.geometry.getAttribute('position') as THREE.BufferAttribute;
    let i = 0;
    for (const b of this.bones.values()) {
      a.setFromMatrixPosition(b.matrixWorld);
      jp.setXYZ(i++, a.x, a.y, a.z);
    }
    jp.needsUpdate = true;
  }

  setTrails(on: boolean) {
    this.showTrails = on;
    this.refreshTrails();
  }

  /** Paths of the rig's end joints (feet, tail tip, head...) over the current clip. */
  private refreshTrails() {
    if (this.trailGroup) {
      this.overlay.remove(this.trailGroup);
      this.trailGroup.traverse((o) => (o as THREE.Line).geometry?.dispose());
      this.trailGroup = null;
    }
    if (!this.showTrails || !this.current) return;
    const kids = new Set([...this.parentOf.values()].filter(Boolean) as string[]);
    const ends = [...this.bones.keys()].filter((n) => !kids.has(n)).slice(0, 16);
    const d = this.current.getClip().duration;
    const saved = this.current.time;
    const steps = Math.max(8, Math.min(120, Math.round(d * 30)));
    const paths = new Map<string, number[]>(ends.map((n) => [n, []]));
    const v = new THREE.Vector3();
    for (let k = 0; k <= steps; k++) {
      this.current.time = (d * k) / steps;
      this.mixer.update(0);
      this.root.updateMatrixWorld(true);
      for (const n of ends) {
        v.setFromMatrixPosition(this.bones.get(n)!.matrixWorld);
        paths.get(n)!.push(v.x, v.y, v.z);
      }
    }
    this.current.time = saved;
    this.mixer.update(0);
    const g = new THREE.Group();
    const palette = [0xff8c33, 0x4db3ff, 0x8ce65a, 0xff667f, 0xcc99ff, 0xffd94d, 0x5ef2d9, 0xf2f2f2];
    ends.forEach((n, i) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(paths.get(n)!), 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: palette[i % palette.length], depthTest: false, transparent: true, opacity: 0.9 }));
      line.renderOrder = 998;
      line.frustumCulled = false;
      g.add(line);
    });
    this.trailGroup = g;
    this.overlay.add(g);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.overlay.parent?.remove(this.overlay);
    this.overlay.traverse((o) => {
      const l = o as THREE.Line;
      l.geometry?.dispose();
      (l.material as THREE.Material | undefined)?.dispose?.();
    });
  }
}
