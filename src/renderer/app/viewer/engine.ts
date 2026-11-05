import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { ViewHelper } from 'three/addons/helpers/ViewHelper.js';
import { Animator, type AnimState } from './animator.ts';
import { robloxLook, type RobloxLook } from '../../../shared/roblox.ts';
import type { ClipsFile, RobloxLighting } from '../../../shared/types.ts';

export interface EngineEvents {
  onLoading(loading: boolean): void;
  onLoaded(): void;
  onSelect(name: string | null): void;
  onHover(hover: { name: string; x: number; y: number } | null): void;
  onError(message: string): void;
  /** Animation playback state (about 15 times a second while it changes), or null without clips. */
  onAnim?(state: AnimState | null): void;
}

/** "roblox": lit like a Roblox place, showing only what Roblox can show (see shared/roblox.ts). */
export type Lighting = 'studio' | 'scene' | 'roblox';

export interface WorldInfo {
  color: string;
  strength: number;
}

const GRID_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}`;

const GRID_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform float uCell;
uniform float uFade;
uniform float uStrength;
uniform vec3 uCenter;
uniform vec3 uColor;
varying vec3 vWorld;
float line(vec2 p, float size) {
  vec2 c = p / size;
  vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
  return 1.0 - min(min(g.x, g.y), 1.0);
}
void main() {
  #include <logdepthbuf_fragment>
  float d = length(vWorld.xz - uCenter.xz);
  float fade = 1.0 - smoothstep(uFade * 0.25, uFade, d);
  float minor = line(vWorld.xz, uCell) * 0.22;
  float major = line(vWorld.xz, uCell * 10.0) * 0.5;
  float ax = 1.0 - min(abs(vWorld.z) / fwidth(vWorld.z), 1.0);
  float ay = 1.0 - min(abs(vWorld.x) / fwidth(vWorld.x), 1.0);
  vec3 col = uColor;
  col = mix(col, vec3(0.93, 0.33, 0.38), ax);
  col = mix(col, vec3(0.50, 0.80, 0.36), ay * (1.0 - ax));
  float a = max(max(minor, major), max(ax, ay) * 0.75) * fade * uStrength;
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, a);
}`;

const ease = (t: number) => 1 - Math.pow(1 - t, 3);

// Caps very bright pixels (a flame, a bulb) before the bloom, keeping their hue. Past about 4× white
// the tone mapping shows no difference, but the bloom grows with brightness: uncapped, one torch
// spread an orange veil over the whole scene.
/**
 * Glow levels. The washed-out look came from the bloom's widest blur levels (the last factors), which
 * spread a bright source over the whole view; they are now small or zero, the glow stays close to
 * its source, and only pixels well above white glow at all. "roblox" approximates Studio's default
 * Bloom (Intensity 1, Size 24, Threshold 2): only really bright surfaces (Neon) glow.
 */
const GLOW = {
  off: null,
  subtle: { strength: 0.16, radius: 0.08, threshold: 1.9, clamp: 2.0, factors: [1.0, 0.45, 0.15, 0.03, 0.0] },
  normal: { strength: 0.26, radius: 0.12, threshold: 1.6, clamp: 2.5, factors: [1.0, 0.6, 0.28, 0.08, 0.0] },
  strong: { strength: 0.42, radius: 0.2, threshold: 1.3, clamp: 3.5, factors: [1.0, 0.75, 0.45, 0.2, 0.06] },
  roblox: { strength: 0.32, radius: 0.16, threshold: 2.0, clamp: 3.0, factors: [1.0, 0.7, 0.4, 0.15, 0.03] },
} as const;

const CLAMP_SHADER = {
  uniforms: { tDiffuse: { value: null }, uMax: { value: 4.0 } },
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uMax;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  float m = max(max(c.r, c.g), c.b);
  if (m > uMax) c.rgb *= uMax / m;
  gl_FragColor = c;
}`,
};

// Roblox's ColorCorrection effect, applied to the finished (display) image.
const GRADE_SHADER = {
  uniforms: { tDiffuse: { value: null }, uBrightness: { value: 0 }, uContrast: { value: 0 }, uSaturation: { value: 0 }, uTint: { value: new THREE.Vector3(1, 1, 1) } },
  vertexShader: CLAMP_SHADER.vertexShader,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform vec3 uTint;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  vec3 v = c.rgb + uBrightness;
  v = (v - 0.5) * (1.0 + uContrast) + 0.5;
  v = mix(vec3(dot(v, vec3(0.299, 0.587, 0.114))), v, 1.0 + uSaturation) * uTint;
  gl_FragColor = vec4(clamp(v, 0.0, 1.0), c.a);
}`,
};

type GlowLevel = { strength: number; radius: number; threshold: number; clamp: number; factors: readonly number[] };
type PlainProps = { clearcoat: number; sheen: number; transmission: number; opacity: number; transparent: boolean; depthWrite: boolean; side: THREE.Side; roughness: number };

// Studio light levels, measured against gray swatches: with Neutral tone mapping, faces toward the
// key show the material's own color and faces away from it are about 10–25% darker. (The room
// environment alone at 1.0 renders surfaces at roughly twice their color: keep it low.)
const STUDIO = { env: 0.3, hemi: 0.2, key: 2.5, rim: 0.5 };

/**
 * The live scene: loads each glTF export and keeps the camera steady across updates. Draws only
 * when something changes (orbiting, loading, animation, hover), so an idle tab costs nothing.
 */
export class Engine {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private clamp: ShaderPass;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.01, 5000);
  private controls: OrbitControls;
  private gizmo: ViewHelper;
  private loader = new GLTFLoader();
  private model: THREE.Object3D | null = null;
  private byName = new Map<string, THREE.Object3D>();
  private nameOf = new Map<THREE.Object3D, string>();
  private originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private clayMat = new THREE.MeshStandardMaterial({ color: 0xc4c1bb, roughness: 0.62, metalness: 0 });
  private studio: THREE.Group = new THREE.Group();
  private key: THREE.DirectionalLight;
  private ambient = new THREE.HemisphereLight(0x8899bb, 0x1a1712, 0);
  private studioEnv: THREE.Texture;
  private backdrop: THREE.Texture;
  private sceneLights: THREE.Light[] = [];
  // The Roblox preview: a sun and sky from the place's Lighting, materials reduced to what Roblox shows.
  private rbx: THREE.Group = new THREE.Group();
  private rbxSun = new THREE.DirectionalLight(0xffffff, 3);
  /** A baseplate (Roblox's dark stone grey): the ground the game would put under the model. */
  private rbxFloor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x635f62, roughness: 0.9, metalness: 0 }));
  private rbxLook: RobloxLook = robloxLook(null);
  private rbxEnv: THREE.Texture | null = null;
  private rbxSky: THREE.Texture | null = null;
  private robloxProject = false;
  private plain = new Map<THREE.Material, PlainProps>();
  private grade: ShaderPass;
  private userGlow: keyof typeof GLOW = 'normal';
  private userExposure = 1;
  private envCenter = new THREE.Vector3();
  private world: WorldInfo | null = null;
  private shadowFloor: THREE.Mesh;
  private grid: THREE.Mesh;
  private gridUniforms: Record<string, THREE.IUniform>;
  private placeholder: THREE.LineSegments;
  private highlight: THREE.Group = new THREE.Group();
  private hoverFx: THREE.Group = new THREE.Group();
  private hovered: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private animator: Animator | null = null;
  private clipsData: ClipsFile | null = null;
  private animPrefs = { clip: null as string | null, speed: 1, loop: true, playing: true, skeleton: false, trails: false };
  private animSent = 0;
  private clock = new THREE.Clock();
  private fly: { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; t0: number; ms: number } | null = null;
  private radius = 0;
  private envRadius = 3;
  private loadToken = 0;
  private raf = 0;
  private dirty = 2;
  private resizeObs: ResizeObserver;
  private down = { x: 0, y: 0, t: 0, buttons: 0 };
  private hoverTimer = 0;
  private host: HTMLElement;
  private events: EngineEvents;
  modes = { wireframe: false, clay: false, grid: true, autoRotate: false };
  lighting: Lighting = 'studio';
  /** Scene lighting chosen automatically (the scene has its own lights), until the user picks. */
  lightingAuto = true;

  constructor(host: HTMLElement, events: EngineEvents) {
    this.host = host;
    this.events = events;
    // Logarithmic depth keeps near-coplanar surfaces (a plate 1 mm off a panel) from shimmering.
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    // Khronos PBR Neutral keeps base colors true (a #808080 material reads as #808080 where it is
    // lit); AgX lifted shadows and washed colors out, which made scenes look overexposed.
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    // Shadows are redrawn when something that casts them changed (see invalidate), not on every camera move.
    r.shadowMap.autoUpdate = false;
    r.setClearColor(0x000000, 0);
    host.appendChild(r.domElement);
    this.renderer = r;

    const pmrem = new THREE.PMREMGenerator(r);
    this.studioEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.studioEnv;
    this.scene.environmentIntensity = STUDIO.env;
    pmrem.dispose();
    // An opaque backdrop (bloom and transparent canvases don't mix): the stage's soft radial gradient.
    const bg = document.createElement('canvas');
    bg.width = 512;
    bg.height = 320;
    const g2 = bg.getContext('2d')!;
    const grad = g2.createRadialGradient(256, 134, 10, 256, 134, 360);
    grad.addColorStop(0, '#1b1f28');
    grad.addColorStop(0.55, '#111319');
    grad.addColorStop(1, '#0b0c10');
    g2.fillStyle = grad;
    g2.fillRect(0, 0, 512, 320);
    this.backdrop = new THREE.CanvasTexture(bg);
    this.backdrop.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = this.backdrop;

    // Studio lighting: soft sky, a slightly warm key with shadows, a cool rim. Calibrated so lit faces
    // show a material's own color and the sides fall off naturally (see STUDIO).
    this.studio.add(new THREE.HemisphereLight(0xe4ebff, 0x201a14, STUDIO.hemi));
    this.key = new THREE.DirectionalLight(0xfff5ea, STUDIO.key);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    this.key.shadow.radius = 5;
    this.studio.add(this.key, this.key.target);
    const rim = new THREE.DirectionalLight(0xbcd2ff, STUDIO.rim);
    rim.position.set(-6, 4, -8);
    this.studio.add(rim);
    this.scene.add(this.studio, this.ambient);
    this.rbxSun.castShadow = true;
    this.rbxSun.shadow.mapSize.set(2048, 2048);
    this.rbxSun.shadow.bias = -0.0004;
    this.rbxSun.shadow.normalBias = 0.02;
    this.rbxSun.shadow.radius = 3;
    this.rbxFloor.rotation.x = -Math.PI / 2;
    this.rbxFloor.receiveShadow = true;
    this.rbx.add(this.rbxSun, this.rbxSun.target, this.rbxFloor);
    this.rbx.visible = false;
    this.scene.add(this.rbx);

    this.shadowFloor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.32 }));
    this.shadowFloor.rotation.x = -Math.PI / 2;
    this.shadowFloor.receiveShadow = true;
    this.scene.add(this.shadowFloor);

    this.gridUniforms = { uCell: { value: 1 }, uFade: { value: 60 }, uStrength: { value: 1 }, uCenter: { value: new THREE.Vector3() }, uColor: { value: new THREE.Color(0x9aa0b4) } };
    this.grid = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000),
      new THREE.ShaderMaterial({ vertexShader: GRID_VERT, fragmentShader: GRID_FRAG, uniforms: this.gridUniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.grid.rotation.x = -Math.PI / 2;
    this.grid.position.y = 0.0005;
    this.grid.renderOrder = -1;
    this.scene.add(this.grid);

    const ico = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.1, 1));
    this.placeholder = new THREE.LineSegments(ico, new THREE.LineBasicMaterial({ color: 0xff8a3d, transparent: true, opacity: 0.22 }));
    this.placeholder.position.y = 1.4;
    this.scene.add(this.placeholder, this.highlight, this.hoverFx);

    // Post: a multisampled HDR pass, bloom for glowing materials only, then tone mapping.
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { samples: 4, type: THREE.HalfFloatType });
    this.composer = new EffectComposer(r, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.clamp = new ShaderPass(CLAMP_SHADER);
    this.composer.addPass(this.clamp);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.26, 0.12, 1.6);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GRADE_SHADER);
    this.grade.enabled = false;
    this.composer.addPass(this.grade);

    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotateSpeed = 0.8;
    this.controls.addEventListener('start', () => {
      this.fly = null;
      this.setHover(null);
    });
    this.controls.addEventListener('change', () => this.invalidate(2, false));
    this.camera.position.set(5.5, 4.2, 6.5);
    this.controls.target.set(0, 1, 0);

    this.gizmo = new ViewHelper(this.camera, r.domElement);
    // Labelled in Blender's terms (Z up): the viewer's +Y is Blender's +Z, its +Z is Blender's -Y.
    this.gizmo.setLabels('X', 'Z', '-Y');
    this.fitEnvironment(3);

    const el = r.domElement;
    el.addEventListener('pointerdown', (e) => (this.down = { x: e.clientX, y: e.clientY, t: performance.now(), buttons: e.buttons }));
    el.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 5 || performance.now() - this.down.t > 400) return;
      if (this.gizmo.handleClick(e)) {
        this.invalidate();
        return;
      }
      this.pick(e);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      cancelAnimationFrame(this.hoverTimer);
      this.hoverTimer = requestAnimationFrame(() => this.hover(e));
    });
    el.addEventListener('pointerleave', () => this.setHover(null));
    el.addEventListener('dblclick', () => this.frame());

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);
    this.resize();
    this.loop();
  }

  /** Asks for a redraw. shadows: false when only the camera moved (the shadow maps are still right). */
  invalidate(frames = 2, shadows = true) {
    this.dirty = Math.max(this.dirty, frames);
    if (shadows) this.shadowsDirty = true;
  }

  private shadowsDirty = true;
  private idleAt = 0;

  private resize() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.composer.setSize(w, h);
    this.bloom.resolution.set(size.x, size.y);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = this.clock.getDelta();
    let busy = false;
    if (this.fly) {
      const t = Math.min(1, (performance.now() - this.fly.t0) / this.fly.ms);
      const k = ease(t);
      this.camera.position.lerpVectors(this.fly.from[0], this.fly.to[0], k);
      this.controls.target.lerpVectors(this.fly.from[1], this.fly.to[1], k);
      if (t >= 1) this.fly = null;
      busy = true;
    }
    let moving = false;
    if (!this.model) {
      this.placeholder.rotation.y += dt * 0.25;
      // The empty stage turns slowly: 20 frames a second is plenty (it used to redraw at the display's full rate).
      const now = performance.now();
      if (now - this.idleAt > 48) {
        this.idleAt = now;
        busy = true;
      }
    }
    if (this.mixer) {
      this.mixer.update(dt);
      busy = moving = true;
    }
    if (this.animator) {
      const st = this.animator.state();
      if (st.playing || st.blending) {
        this.animator.update(dt);
        busy = moving = true;
      }
      const now = performance.now();
      if (now - this.animSent > 66 && (st.playing || st.blending)) {
        this.animSent = now;
        this.events.onAnim?.(this.animator.state());
      }
    }
    if (this.gizmo.animating) {
      this.gizmo.update(dt);
      busy = true;
    }
    this.controls.autoRotate = this.modes.autoRotate;
    if (this.controls.update() || this.modes.autoRotate) busy = true;
    if (!busy && this.dirty <= 0) return;
    this.dirty--;
    if (this.shadowsDirty || moving) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowsDirty = false;
    }
    (this.gridUniforms.uCenter!.value as THREE.Vector3).copy(this.controls.target);
    this.gizmo.center.copy(this.controls.target);
    this.composer.render();
    this.renderer.autoClear = false;
    this.gizmo.render(this.renderer);
    this.renderer.autoClear = true;
  };

  /** Scales the floor, grid, shadow camera and clipping planes to the model. */
  private fitEnvironment(radius: number, center = new THREE.Vector3(0, 0, 0)) {
    const r = Math.max(radius, 0.05);
    const cell = Math.pow(10, Math.floor(Math.log10(r * 1.2)) - 1);
    this.gridUniforms.uCell!.value = Math.max(cell, 0.01);
    this.envRadius = r;
    this.envCenter.copy(center);
    this.gridUniforms.uFade!.value = r * (this.lighting === 'scene' && this.sceneLights.length ? 3.5 : 9);
    // The Roblox sun: at the place's time of day, from the model's front right (Blender -Y is the viewer's +Z).
    const ce = Math.cos(this.rbxLook.elevation);
    this.rbxSun.position.set(center.x + r * 4 * 0.55 * ce, center.y + r * 4 * Math.sin(this.rbxLook.elevation), center.z + r * 4 * 0.835 * ce);
    this.rbxSun.target.position.copy(center);
    this.rbxFloor.scale.set(r * 300, r * 300, 1);
    this.rbxFloor.position.set(center.x, -0.0015 * r, center.z);
    const rs = this.rbxSun.shadow.camera;
    rs.left = rs.bottom = -r * 1.8;
    rs.right = rs.top = r * 1.8;
    rs.near = r * 0.1;
    rs.far = r * 12;
    rs.updateProjectionMatrix();
    this.shadowFloor.scale.set(r * 12, r * 12, 1);
    this.shadowFloor.position.set(center.x, 0, center.z);
    this.key.position.set(center.x + r * 2.2, center.y + r * 3.2, center.z + r * 1.6);
    this.key.target.position.copy(center);
    const sc = this.key.shadow.camera;
    sc.left = sc.bottom = -r * 1.6;
    sc.right = sc.top = r * 1.6;
    sc.near = r * 0.1;
    sc.far = r * 10;
    sc.updateProjectionMatrix();
    this.camera.near = Math.max(r / 300, 0.002);
    this.camera.far = r * 400;
    this.camera.updateProjectionMatrix();
    this.controls.maxDistance = r * 60;
  }

  private bounds(obj: THREE.Object3D): THREE.Box3 {
    return new THREE.Box3().setFromObject(obj, true);
  }

  /**
   * The part of the scene worth framing: objects clustered around the middle, without backdrops
   * (a 240 m ocean, a sky dome, a moon far away) that would shrink the subject to a speck.
   */
  private subjectBox(root: THREE.Object3D): THREE.Box3 {
    const items: Array<{ box: THREE.Box3; center: THREE.Vector3; size: number }> = [];
    for (const o of this.byName.values()) {
      let hasMesh = false;
      o.traverse((c) => {
        if ((c as THREE.Mesh).isMesh) hasMesh = true;
      });
      if (!hasMesh) continue;
      const box = this.bounds(o);
      if (box.isEmpty()) continue;
      items.push({ box, center: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()).length() });
    }
    if (items.length < 3) return this.bounds(root);
    const sizes = items.map((i) => i.size).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)]!;
    const q = (axis: 'x' | 'y' | 'z', p: number) => {
      const v = items.map((i) => i.center[axis]).sort((a, b) => a - b);
      return v[Math.min(v.length - 1, Math.floor(p * v.length))]!;
    };
    const core = new THREE.Box3(new THREE.Vector3(q('x', 0.1), q('y', 0.1), q('z', 0.1)), new THREE.Vector3(q('x', 0.9), q('y', 0.9), q('z', 0.9)));
    const coreSize = Math.max(core.getSize(new THREE.Vector3()).length(), median * 2);
    core.expandByScalar(coreSize * 0.35);
    const out = new THREE.Box3();
    for (const i of items) {
      const backdrop = i.size > Math.max(coreSize * 2.5, median * 12);
      if (!backdrop && core.containsPoint(i.center)) out.union(i.box);
    }
    return out.isEmpty() ? this.bounds(root) : out;
  }

  /** Flies the camera to show `obj` (default: the scene's subject). */
  frame(obj: THREE.Object3D | null = null, animate = true) {
    const root = this.model;
    if (!root) return;
    const box = obj ? this.bounds(obj) : this.subjectBox(root);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect));
    const dist = (sphere.radius / Math.sin(fit / 2)) * 1.05;
    let dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (!Number.isFinite(dir.x) || dir.lengthSq() < 0.5) dir = new THREE.Vector3(1, 0.75, 1.2).normalize();
    if (dir.y < 0.12) dir.y = 0.35;
    dir.normalize();
    const to: [THREE.Vector3, THREE.Vector3] = [sphere.center.clone().add(dir.multiplyScalar(dist)), sphere.center.clone()];
    if (!animate) {
      this.camera.position.copy(to[0]);
      this.controls.target.copy(to[1]);
      this.invalidate();
      return;
    }
    this.fly = { from: [this.camera.position.clone(), this.controls.target.clone()], to, t0: performance.now(), ms: 700 };
  }

  frameByName(name: string) {
    const obj = this.byName.get(name);
    if (obj) this.frame(obj);
  }

  /** Blender-style views: front (1), right (3), top (7), and back to 3/4. */
  view(which: 'front' | 'right' | 'top' | 'iso') {
    if (!this.model) return;
    const t = this.controls.target.clone();
    const dist = this.camera.position.distanceTo(t);
    const dirs = { front: new THREE.Vector3(0, 0.02, 1), right: new THREE.Vector3(1, 0.02, 0), top: new THREE.Vector3(0, 1, 0.001), iso: new THREE.Vector3(1, 0.75, 1.2) };
    const to = t.clone().add(dirs[which].normalize().multiplyScalar(dist));
    this.fly = { from: [this.camera.position.clone(), t.clone()], to: [to, t], t0: performance.now(), ms: 550 };
  }

  async load(url: string | null, world: WorldInfo | null = null) {
    const token = ++this.loadToken;
    this.world = world;
    if (!url) {
      this.setModel(null, null);
      return;
    }
    this.events.onLoading(true);
    let gltf: GLTF;
    try {
      gltf = await this.loader.loadAsync(url);
    } catch (e) {
      if (token === this.loadToken) {
        this.events.onLoading(false);
        this.events.onError(`Could not load the scene: ${(e as Error).message}`);
      }
      return;
    }
    if (token !== this.loadToken) return;
    this.setModel(gltf.scene, gltf);
    this.events.onLoading(false);
    this.events.onLoaded();
  }

  private setModel(root: THREE.Object3D | null, gltf: GLTF | null) {
    const hadModel = !!this.model;
    if (this.model) {
      this.scene.remove(this.model);
      // Everything the old model put on the GPU: geometry, materials, their textures, bone textures and
      // its lights' shadow maps. Dropping the object frees none of it, and a model reloads on every change.
      const freed = new Set<unknown>();
      const free = (mat: THREE.Material) => {
        if (freed.has(mat)) return;
        freed.add(mat);
        for (const v of Object.values(mat as unknown as Record<string, unknown>)) {
          const t = v as THREE.Texture | null;
          if (t && t.isTexture && !freed.has(t)) {
            freed.add(t);
            t.dispose();
          }
        }
        mat.dispose();
      };
      this.model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          const mats = this.originals.get(m) ?? m.material;
          for (const mat of Array.isArray(mats) ? mats : [mats]) free(mat);
          (m as unknown as THREE.SkinnedMesh).skeleton?.dispose();
        }
        const l = o as THREE.Light;
        if (l.isLight) (l as THREE.DirectionalLight).shadow?.dispose();
      });
    }
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.animator?.dispose();
    this.animator = null;
    this.model = root;
    this.byName.clear();
    this.nameOf.clear();
    this.originals.clear();
    this.plain.clear();
    this.sceneLights = [];
    this.hovered = null;
    this.clearFx(this.hoverFx);
    this.placeholder.visible = !root;
    this.invalidate();
    if (!root || !gltf) {
      this.clearFx(this.highlight);
      this.fitEnvironment(3);
      this.applyLighting();
      if (hadModel) {
        this.radius = 0;
        this.fly = { from: [this.camera.position.clone(), this.controls.target.clone()], to: [new THREE.Vector3(5.5, 4.2, 6.5), new THREE.Vector3(0, 1, 0)], t0: performance.now(), ms: 700 };
      }
      return;
    }
    const nodes = (gltf.parser.json as { nodes?: Array<{ name?: string }> }).nodes ?? [];
    root.traverse((o) => {
      const assoc = gltf.parser.associations.get(o) as { nodes?: number } | undefined;
      if (assoc?.nodes !== undefined) {
        const name = nodes[assoc.nodes]?.name ?? o.name;
        this.byName.set(name, o);
        this.nameOf.set(o, name);
      }
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
        this.originals.set(m, m.material);
      }
      const l = o as THREE.Light;
      if (l.isLight) this.sceneLights.push(l);
    });
    this.castLightShadows();
    this.scene.add(root);
    if (this.lightingAuto) this.lighting = this.autoLighting();
    this.applyModes();
    if (gltf.animations.length) {
      this.mixer = new THREE.AnimationMixer(root);
      for (const clip of gltf.animations) this.mixer.clipAction(clip).play();
    }
    this.buildAnimator();
    const subject = this.subjectBox(root);
    const sphere = subject.getBoundingSphere(new THREE.Sphere());
    this.fitEnvironment(sphere.radius, sphere.center);
    for (const l of this.sceneLights) {
      const d = l as THREE.DirectionalLight;
      if (!l.castShadow || !d.shadow) continue;
      const sc = d.shadow.camera as THREE.OrthographicCamera & THREE.PerspectiveCamera;
      if (d.isDirectionalLight) {
        sc.left = sc.bottom = -sphere.radius * 1.6;
        sc.right = sc.top = sphere.radius * 1.6;
        sc.far = sphere.radius * 20;
      } else {
        sc.near = Math.max(0.01, sphere.radius * 0.005);
        sc.far = sphere.radius * 8;
      }
      sc.updateProjectionMatrix();
    }
    // Keep the user's camera across updates unless the model changed size a lot.
    const ratio = this.radius ? sphere.radius / this.radius : 0;
    if (!hadModel || ratio > 1.8 || ratio < 0.35) this.frame(null, hadModel);
    this.radius = sphere.radius;
  }

  /**
   * The scene's lights cast shadows like in Blender: a lamp inside its shade or a torch light inside
   * its flame mesh is mostly blocked there, and without shadows it lit whole walls. Point lights cost
   * six shadow passes each, so only the strongest few get them.
   */
  private castLightShadows() {
    const ranked = [...this.sceneLights].sort((a, b) => b.intensity - a.intensity);
    let local = 0;
    for (const l of ranked) {
      const s = (l as THREE.DirectionalLight).shadow;
      if (!s) continue;
      if ((l as THREE.DirectionalLight).isDirectionalLight) {
        l.castShadow = true;
        s.mapSize.set(2048, 2048);
        s.bias = -0.0004;
        s.normalBias = 0.02;
      } else {
        l.castShadow = local < 4;
        local++;
        const point = (l as THREE.PointLight).isPointLight;
        s.mapSize.set(point ? 512 : 1024, point ? 512 : 1024);
        s.bias = -0.002;
        s.normalBias = 0.03;
        s.radius = 3;
      }
    }
  }

  /** What the viewer shows when the user hasn't picked: the game's light in a Roblox project, else the scene's own lights, else the studio. */
  private autoLighting(): Lighting {
    if (this.preferStudio) return 'studio';
    if (this.robloxProject) return 'roblox';
    return this.sceneLights.length ? 'scene' : 'studio';
  }

  /** The Roblox preview's lighting (a place's Lighting, or a new place's defaults), and whether this project is built for Roblox. */
  setRoblox(lighting: RobloxLighting | null, project: boolean) {
    this.rbxLook = robloxLook(lighting);
    const lk = this.rbxLook;
    // An equirectangular sky, wide enough for the reflection probe made from it (its cube faces are width / 4).
    const w = 512;
    const h = 256;
    const data = new Uint16Array(w * h * 4);
    const mix = (a: number[], b: number[], t: number) => a.map((x, i) => x + (b[i]! - x) * t);
    const stops: Array<[number, number[]]> = [[0, lk.ground], [0.49, lk.ground], [0.505, lk.horizon], [0.66, mix(lk.horizon, lk.zenith, 0.6)], [1, lk.zenith]];
    for (let j = 0; j < h; j++) {
      const t = (Math.sin(((j + 0.5) / h - 0.5) * Math.PI) + 1) / 2;
      let k = 0;
      while (k < stops.length - 2 && t > stops[k + 1]![0]) k++;
      const [t0, c0] = stops[k]!;
      const [t1, c1] = stops[k + 1]!;
      const c = mix(c0, c1, Math.max(0, Math.min(1, (t - t0) / Math.max(1e-6, t1 - t0))));
      // The flat ambient light (OutdoorAmbient) is part of the sky the model sees.
      const texel = [THREE.DataUtils.toHalfFloat(c[0]! + lk.ambient[0]), THREE.DataUtils.toHalfFloat(c[1]! + lk.ambient[1]), THREE.DataUtils.toHalfFloat(c[2]! + lk.ambient[2]), THREE.DataUtils.toHalfFloat(1)];
      for (let i = 0; i < w; i++) data.set(texel, (j * w + i) * 4);
    }
    const sky = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
    sky.mapping = THREE.EquirectangularReflectionMapping;
    sky.colorSpace = THREE.LinearSRGBColorSpace;
    sky.magFilter = sky.minFilter = THREE.LinearFilter;
    sky.needsUpdate = true;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromEquirectangular(sky).texture;
    pmrem.dispose();
    this.rbxEnv?.dispose();
    this.rbxSky?.dispose();
    this.rbxEnv = env;
    this.rbxSky = sky;
    this.rbxSun.color.setRGB(lk.sunColor[0], lk.sunColor[1], lk.sunColor[2], THREE.LinearSRGBColorSpace);
    this.rbxSun.intensity = lk.sunStrength;
    this.robloxProject = project;
    if (this.lightingAuto) this.lighting = this.autoLighting();
    this.fitEnvironment(this.envRadius, this.envCenter);
    this.applyModes();
  }

  /** Roblox shows plain PBR: no coat (it reads as a little extra gloss), sheen, transmission or alpha, and one-sided faces. */
  private robloxMaterials(on: boolean) {
    for (const original of this.originals.values()) {
      for (const mat of Array.isArray(original) ? original : [original]) {
        const m = mat as THREE.MeshPhysicalMaterial;
        if (!m.isMeshStandardMaterial) continue;
        const saved = this.plain.get(m);
        if (on && !saved) {
          const coat = m.isMeshPhysicalMaterial ? m.clearcoat : 0;
          this.plain.set(m, { clearcoat: coat, sheen: m.isMeshPhysicalMaterial ? m.sheen : 0, transmission: m.isMeshPhysicalMaterial ? m.transmission : 0, opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite, side: m.side, roughness: m.roughness });
          if (m.isMeshPhysicalMaterial) {
            m.clearcoat = 0;
            m.sheen = 0;
            m.transmission = 0;
          }
          m.roughness *= 1 - 0.3 * Math.min(1, coat);
          m.opacity = 1;
          m.transparent = false;
          m.depthWrite = true;
          m.side = THREE.FrontSide;
          m.needsUpdate = true;
        } else if (!on && saved) {
          if (m.isMeshPhysicalMaterial) {
            m.clearcoat = saved.clearcoat;
            m.sheen = saved.sheen;
            m.transmission = saved.transmission;
          }
          m.roughness = saved.roughness;
          m.opacity = saved.opacity;
          m.transparent = saved.transparent;
          m.depthWrite = saved.depthWrite;
          m.side = saved.side;
          m.needsUpdate = true;
          this.plain.delete(m);
        }
      }
    }
  }

  /** Studio lighting (neutral, readable), the scene's own lights and world (night scenes, moods), or a Roblox place's light. */
  applyLighting() {
    const roblox = this.lighting === 'roblox' && !!this.rbxEnv;
    const sceneMode = this.lighting === 'scene' && this.sceneLights.length > 0;
    this.studio.visible = !sceneMode && !roblox;
    this.rbx.visible = roblox;
    for (const l of this.sceneLights) l.visible = sceneMode;
    // Roblox's tone curve is filmic (ACES-like); Kiln's own views keep colours true with Neutral.
    this.renderer.toneMapping = roblox ? THREE.ACESFilmicToneMapping : THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = this.userExposure * (roblox ? Math.pow(2, this.rbxLook.exposure) : 1);
    this.robloxMaterials(roblox);
    const cc = roblox ? this.rbxLook.colorCorrection : null;
    this.grade.enabled = !!cc;
    if (cc) {
      const u = this.grade.uniforms;
      u['uBrightness']!.value = cc.brightness;
      u['uContrast']!.value = cc.contrast;
      u['uSaturation']!.value = cc.saturation;
      (u['uTint']!.value as THREE.Vector3).set(cc.tint[0], cc.tint[1], cc.tint[2]);
    }
    const bloom = this.rbxLook.bloom;
    this.applyGlow(
      roblox
        ? bloom && bloom.intensity > 0.01 && this.userGlow !== 'off'
          ? { ...GLOW.roblox, strength: Math.min(0.7, GLOW.roblox.strength * bloom.intensity), radius: Math.min(0.4, (GLOW.roblox.radius * bloom.size) / 24), threshold: Math.max(0.8, bloom.threshold) }
          : null
        : this.userGlow in GLOW
          ? GLOW[this.userGlow]
          : GLOW.normal,
    );
    if (roblox) {
      this.scene.environment = this.rbxEnv;
      this.scene.environmentIntensity = 1;
      this.ambient.intensity = 0;
      this.scene.background = this.rbxSky;
      this.gridUniforms.uStrength!.value = 0.4;
      this.gridUniforms.uFade!.value = this.envRadius * 6;
    } else if (sceneMode) {
      const color = new THREE.Color(this.world?.color ?? '#20242c');
      const strength = Math.max(0.05, Math.min(3, this.world?.strength ?? 0.5));
      // Blender's world lights everything with its color × strength; a hemisphere light needs π times
      // that to match (three.js divides by π). A faint studio environment keeps metals readable.
      this.scene.environment = this.studioEnv;
      this.scene.environmentIntensity = 0.06 * strength;
      this.ambient.color.copy(color);
      this.ambient.groundColor.copy(color).multiplyScalar(0.3);
      this.ambient.intensity = Math.PI * 0.8 * strength;
      this.scene.background = this.sky(this.world?.color ?? '#20242c', strength);
      this.gridUniforms.uStrength!.value = 0.22;
      this.gridUniforms.uFade!.value = this.envRadius * 3.5;
    } else {
      this.scene.environment = this.studioEnv;
      this.scene.environmentIntensity = STUDIO.env;
      this.ambient.intensity = 0;
      this.scene.background = this.backdrop;
      this.gridUniforms.uStrength!.value = 1;
      this.gridUniforms.uFade!.value = this.envRadius * 9;
    }
    this.invalidate();
  }

  private skyCache: { key: string; tex: THREE.Texture } | null = null;

  /** A sky from the world color: deeper overhead, lighter toward the horizon, a soft vignette. */
  private sky(hex: string, strength: number): THREE.Texture {
    const key = `${hex}:${strength.toFixed(2)}`;
    if (this.skyCache?.key === key) return this.skyCache.tex;
    this.skyCache?.tex.dispose();
    const base = new THREE.Color(hex);
    const lift = Math.min(1, 0.55 + strength * 0.35);
    const at = (k: number, toward: THREE.Color, t: number) => '#' + base.clone().multiplyScalar(k * lift).lerp(toward, t).getHexString();
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 256;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, at(0.62, new THREE.Color('#05060a'), 0.25));
    grad.addColorStop(0.58, at(1.0, new THREE.Color('#ffffff'), 0.16));
    grad.addColorStop(0.72, at(0.85, new THREE.Color('#ffffff'), 0.06));
    grad.addColorStop(1, at(0.34, new THREE.Color('#05060a'), 0.4));
    g.fillStyle = grad;
    g.fillRect(0, 0, 16, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.skyCache = { key, tex };
    return tex;
  }

  setLighting(l: Lighting) {
    this.lighting = l;
    this.lightingAuto = false;
    this.applyModes();
  }

  /** Settings → Viewer: brightness, glow, and whether scenes may use their own lights. */
  applySettings(v: { lighting: 'auto' | 'studio'; exposure: number; bloom: boolean; glow?: keyof typeof GLOW }) {
    this.userExposure = v.exposure;
    this.userGlow = v.glow ?? (v.bloom ? 'normal' : 'off');
    const was = this.preferStudio;
    this.preferStudio = v.lighting === 'studio';
    // Only a change of the lighting setting moves the lighting: brightness and glow leave the
    // light picked with L or R alone.
    if (this.preferStudio && !was) {
      this.lightingAuto = false;
      this.lighting = 'studio';
    } else if (!this.preferStudio && was) {
      this.lightingAuto = true;
      this.lighting = this.autoLighting();
    }
    this.applyModes();
  }

  private preferStudio = false;

  /** The glow level the user chose in Settings (the Roblox preview uses the place's Bloom instead). */
  setGlow(level: keyof typeof GLOW) {
    this.userGlow = level;
    this.applyLighting();
  }

  private applyGlow(g: GlowLevel | null) {
    this.bloom.enabled = !!g;
    if (g) {
      this.bloom.strength = g.strength;
      this.bloom.radius = g.radius;
      this.bloom.threshold = g.threshold;
      const u = (this.bloom as unknown as { compositeMaterial: THREE.ShaderMaterial }).compositeMaterial.uniforms;
      u['bloomFactors']!.value = [...g.factors];
      this.clamp.uniforms['uMax']!.value = g.clamp;
    }
    this.invalidate();
  }

  get hasSceneLights(): boolean {
    return this.sceneLights.length > 0;
  }

  applyModes() {
    this.grid.visible = this.modes.grid;
    this.shadowFloor.visible = this.modes.grid && this.lighting === 'studio';
    this.rbxFloor.visible = this.modes.grid;
    for (const [mesh, original] of this.originals) {
      mesh.material = this.modes.clay ? this.clayMat : original;
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        (mat as THREE.MeshStandardMaterial).wireframe = this.modes.wireframe;
      }
    }
    this.applyLighting();
  }

  private objectAt(clientX: number, clientY: number): THREE.Object3D | null {
    if (!this.model) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObject(this.model, true).find((h) => (h.object as THREE.Mesh).isMesh && h.object.visible);
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && !this.nameOf.has(o)) o = o.parent;
    return o;
  }

  private pick(e: PointerEvent) {
    const o = this.objectAt(e.clientX, e.clientY);
    this.events.onSelect(o ? this.nameOf.get(o)! : null);
  }

  private hover(e: PointerEvent) {
    if (!this.model || this.fly) return;
    const o = this.objectAt(e.clientX, e.clientY);
    if (o !== this.hovered) this.setHover(o);
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.events.onHover(o ? { name: this.nameOf.get(o)!, x: e.clientX - rect.left, y: e.clientY - rect.top } : null);
  }

  private setHover(o: THREE.Object3D | null) {
    this.hovered = o;
    this.clearFx(this.hoverFx);
    if (!o) {
      this.events.onHover(null);
      this.invalidate();
      return;
    }
    this.outline(o, this.hoverFx, 0xffffff, 0.35, 150_000);
    this.invalidate();
  }

  private clearFx(group: THREE.Group) {
    for (const c of [...group.children]) {
      group.remove(c);
      const l = c as THREE.LineSegments;
      l.geometry?.dispose();
      (l.material as THREE.Material)?.dispose();
    }
  }

  private outline(obj: THREE.Object3D, group: THREE.Group, color: number, opacity: number, budget: number) {
    obj.updateWorldMatrix(true, true);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false });
    let verts = 0;
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || verts > budget) return;
      verts += m.geometry.attributes.position?.count ?? 0;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30), mat);
      edges.applyMatrix4(m.matrixWorld);
      edges.renderOrder = 10;
      group.add(edges);
    });
  }

  /** Outlines the named object (edges + bounding box) in the accent color. */
  setSelected(name: string | null) {
    this.clearFx(this.highlight);
    const obj = name ? this.byName.get(name) : null;
    this.invalidate();
    if (!obj) return;
    this.outline(obj, this.highlight, 0xff8a3d, 0.85, 400_000);
    const box = new THREE.Box3Helper(this.bounds(obj), new THREE.Color(0xff8a3d));
    (box.material as THREE.LineBasicMaterial).transparent = true;
    (box.material as THREE.LineBasicMaterial).opacity = 0.35;
    this.highlight.add(box);
  }

  /** A JPEG of the current view (thumbnails, "attach my view"). */
  snapshot(width = 480, quality = 0.82): string {
    // The canvas may be stale if the tab was hidden while its size changed.
    const src = this.renderer.domElement;
    if (src.clientWidth > 1 && Math.abs(src.width - src.clientWidth * this.renderer.getPixelRatio()) > 2) this.resize();
    // A tab in the background draws no frames: the camera move to a model that grew never ran, and the
    // lights' shadow maps were never drawn (so everything they light came out black). Catch up here.
    if (this.fly) {
      this.camera.position.copy(this.fly.to[0]);
      this.controls.target.copy(this.fly.to[1]);
      this.fly = null;
    }
    this.controls.update();
    (this.gridUniforms.uCenter!.value as THREE.Vector3).copy(this.controls.target);
    this.renderer.shadowMap.needsUpdate = true;
    this.shadowsDirty = false;
    this.composer.render();
    const w = Math.min(width, src.width);
    const h = Math.round((src.height / src.width) * w);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(w / 2, h * 0.42, 0, w / 2, h * 0.42, Math.max(w, h) * 0.7);
    g.addColorStop(0, '#1b1f28');
    g.addColorStop(1, '#0b0c10');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    return c.toDataURL('image/jpeg', quality);
  }

  /** Where the user is looking, in Blender coordinates (Z up), and what is in the middle of the view. */
  viewInfo(): { camera: number[]; target: number[]; center: string | null } | null {
    if (!this.model) return null;
    const toBlender = (v: THREE.Vector3) => [v.x, -v.z, v.y].map((n) => Math.round(n * 100) / 100);
    const rect = this.renderer.domElement.getBoundingClientRect();
    const o = this.objectAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { camera: toBlender(this.camera.position), target: toBlender(this.controls.target), center: o ? this.nameOf.get(o)! : null };
  }

  get hasModel(): boolean {
    return !!this.model;
  }

  // --- animation clips ----------------------------------------------------------------------------------

  /** The rig's clips (sampled by Kiln), played on the loaded model. null: no clips. */
  setClips(data: ClipsFile | null, show: string | null = null) {
    this.clipsData = data;
    if (show) this.animPrefs.clip = show;
    this.buildAnimator();
  }

  private buildAnimator() {
    this.animator?.dispose();
    this.animator = null;
    const data = this.clipsData;
    if (!data || !this.model || !data.clips.length) {
      this.events.onAnim?.(null);
      return;
    }
    const a = new Animator(this.model, data, this.scene);
    this.animator = a;
    a.onChange = () => {
      this.invalidate();
      this.events.onAnim?.(a.state());
    };
    const p = this.animPrefs;
    a.speed = p.speed;
    a.loop = p.loop;
    a.playing = p.playing;
    const name = p.clip && a.clipNames.includes(p.clip) ? p.clip : a.clipNames[0]!;
    a.play(name);
    if (p.skeleton) a.setSkeleton(true);
    if (p.trails) a.setTrails(true);
    this.invalidate();
    this.events.onAnim?.(a.state());
  }

  get hasClips(): boolean {
    return !!this.animator;
  }

  /** Playback controls for the Animate panel. */
  anim(cmd: { play?: string; blend?: { to: string; fade: number }; playing?: boolean; seek?: number; speed?: number; loop?: boolean; skeleton?: boolean; trails?: boolean }) {
    const a = this.animator;
    const p = this.animPrefs;
    if (cmd.play !== undefined) p.clip = cmd.play;
    if (cmd.speed !== undefined) p.speed = cmd.speed;
    if (cmd.loop !== undefined) p.loop = cmd.loop;
    if (cmd.playing !== undefined) p.playing = cmd.playing;
    if (cmd.skeleton !== undefined) p.skeleton = cmd.skeleton;
    if (cmd.trails !== undefined) p.trails = cmd.trails;
    if (!a) return;
    if (cmd.speed !== undefined) a.setSpeed(cmd.speed);
    if (cmd.loop !== undefined) a.setLoop(cmd.loop);
    if (cmd.play !== undefined) a.play(cmd.play);
    if (cmd.blend) {
      p.clip = cmd.blend.to;
      a.blendTo(cmd.blend.to, cmd.blend.fade);
    }
    if (cmd.playing !== undefined) a.setPlaying(cmd.playing);
    if (cmd.seek !== undefined) {
      a.seek(cmd.seek);
      a.update(0);
    }
    if (cmd.skeleton !== undefined) a.setSkeleton(cmd.skeleton);
    if (cmd.trails !== undefined) a.setTrails(cmd.trails);
    this.invalidate();
    this.events.onAnim?.(a.state());
  }

  dispose() {
    this.setModel(null, null);
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.controls.dispose();
    this.gizmo.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/** The page's viewer (one per tab), for the composer's "attach my view" and view context. */
export const viewer: { current: Engine | null } = { current: null };
// Development hook: inspect the viewer from the console (never in a built app).
if (import.meta.env.DEV) (window as unknown as { __viewer: unknown }).__viewer = viewer;
