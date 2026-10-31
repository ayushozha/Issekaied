import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Observer } from '@babylonjs/core/Misc/observable';
import type { PowerId } from '../../shared/protocol';
import { CHANNELS } from './powers';
import { softParticleTexture } from './world';

const EYE_TO_FEET = 1.6;
/** Ground decals sit just above the plaza/path tops (path top is y≈0.035). */
const DECAL_Y = 0.06;
/** Concurrency caps: extra Q cinematics degrade to a compact burst instead of stacking geometry. */
const MAX_CINEMATICS = 4;
const MAX_PRIMARY_BOLTS = 6;
/** Q cinematics land a few metres ahead when no target is supplied, never at the camera. */
const DEFAULT_REACH = 6;
const MIN_PORTRAIT_DISTANCE = 3;
/**
 * Camera safety. Points closer than CAMERA_SUPPRESS (m) to the active camera never emit particles or
 * rings (self-hit events arrive at the eye position, distance 0). Between that and CAMERA_NEAR a
 * burst is downgraded to a few small, low-alpha, standard-blended motes that cannot whitewash.
 */
const CAMERA_SUPPRESS = 1.2;
const CAMERA_NEAR = 3;

/**
 * Camera-local rest pose of the first-person viewmodel (x right, y up, z forward). The hand sits in
 * the lower right; the trident leans forward and outward so its head stays mid-right, below the HUD,
 * and the centre of the view stays clear. The lantern hangs small in the lower left.
 */
const VM_REST_POS = new Vector3(0.5, -0.4, 0.66);
const VM_REST_ROT = new Vector3(0.1, -0.1, 0.08);
const VM_WEAPON_REST_ROT = new Vector3(0.62, 0.05, -0.2);
const VM_LANTERN_POS = new Vector3(-0.46, -0.28, 0.72); // whole cage and flame stay above the bottom edge
const VM_LANTERN_ROT = new Vector3(0.05, 0.3, 0.06);
const VM_LANTERN_SCALE = 0.82;

interface Viewmodel {
  root: TransformNode;
  weapon: TransformNode;
  lantern: TransformNode;
  arc: Mesh;
  arcMat: StandardMaterial;
  mats: StandardMaterial[];
  meshes: Mesh[];
}

interface BurstOptions { size?: number; speed?: number; life?: number; gravity?: number; spread?: number }

/**
 * Visual-only spell, hit, banish and return effects. Nothing here changes game state; the server
 * reports hits and banishments, the client just makes them legible.
 *
 * Presentation rules: everything is world-local and bounded (size, opacity, particle count,
 * lifetime). No screen flashes, strobe, camera shake or exposure changes. Reduced motion (OS
 * preference by default, overridable via setReducedMotion) swaps travel/spin/expansion for static
 * glyphs that fade in and out.
 */
export class EffectsLayer {
  private readonly soft: DynamicTexture;
  private readonly glyphs = new Map<PowerId, DynamicTexture>();
  private readonly portraits = new Map<PowerId, Texture>();
  private readonly portraitFailed = new Set<PowerId>();
  private vignette: DynamicTexture | null = null;
  private primaryMat: StandardMaterial | null = null;
  /** Finishers of every running effect; run on dispose so nothing outlives the layer. */
  private readonly active = new Set<() => void>();
  private readonly timers = new Set<number>();
  private cinematics = 0;
  private primaryBolts = 0;
  private stopPortrait: (() => void) | null = null;
  private reducedOverride: boolean | null = null;
  private readonly motionQuery: MediaQueryList | null;
  private disposed = false;
  private vm: Viewmodel | null = null;
  private vmFinish: (() => void) | null = null;
  private vmIdle: Observer<Scene> | null = null;
  private vmClock = 0;

  constructor(private readonly scene: Scene, private readonly glow: { addExcludedMesh(mesh: Mesh): void } | null = null) {
    this.soft = softParticleTexture(scene);
    this.motionQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    scene.onDisposeObservable.addOnce(() => this.dispose());
    // One bounded idle observer: builds the viewmodel once a camera exists, shows it only while the
    // hunter actually holds the pointer lock (never on the title/menu view), and adds a quiet sway.
    this.vmIdle = scene.onBeforeRenderObservable.add(() => {
      if (this.disposed) return;
      const vm = this.viewmodel();
      if (!vm) return;
      const inPlay = typeof document !== 'undefined' && document.pointerLockElement !== null;
      if (vm.root.isEnabled() !== inPlay) {
        vm.root.setEnabled(inPlay);
        vm.lantern.setEnabled(inPlay);
      }
      if (!inPlay || this.reducedMotion) return;
      this.vmClock += Math.min(0.1, scene.getEngine().getDeltaTime() / 1000);
      const k = this.vmClock;
      if (!this.vmFinish) vm.root.position.y = VM_REST_POS.y + 0.006 * Math.sin(k * 1.6); // breathing, only at rest
      vm.lantern.rotation.z = VM_LANTERN_ROT.z + 0.035 * Math.sin(k * 1.1);
    });
  }

  /** Additive: force reduced motion on/off; pass null to follow the OS/browser preference again. */
  setReducedMotion(reduced: boolean | null): void {
    this.reducedOverride = reduced;
  }

  get reducedMotion(): boolean {
    return this.reducedOverride ?? this.motionQuery?.matches ?? false;
  }

  /**
   * Q incantation only. Plays the channel's cinematic from `origin` (eye/body position) along unit
   * `aim`. `follow` (optional) is the caster node for shells/returning chakra. `target` (optional,
   * additive) places the deity glyph and spectral portrait at the struck enemy; otherwise they land
   * a few metres along the aim.
   */
  cast(power: PowerId, origin: Vector3, aim: Vector3, follow?: TransformNode | null, target?: Vector3 | null): void {
    if (this.disposed) return;
    const o = origin.clone();
    const a = safeAim(aim);
    const anchor = this.anchorFor(o, a, target ?? null);
    const caster = follow ?? null;
    if (this.cinematics >= MAX_CINEMATICS) {
      // Too many simultaneous incantations: keep it legible but compact.
      this.burst(anchor.add(new Vector3(0, 1, 0)), CHANNELS[power].color, 18, { size: 0.2, speed: 1.6, life: 0.8, spread: 1.2 });
      return;
    }
    if (!caster) this.viewmodelIncant(CHANNELS[power].color); // our own Q: hand raises in the channel colour
    this.cinematics++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.cinematics--;
      }
    };
    this.portrait(power, anchor);
    switch (power) {
      case 'ganesha':
        return this.ganesha(o, anchor, caster, release);
      case 'hanuman':
        return this.hanuman(o, a, anchor, release);
      case 'shiva':
        return this.shiva(anchor, release);
      case 'vishnu':
        return this.vishnu(o, a, anchor, caster, release);
    }
  }

  /**
   * Additive: calm feedback for the ordinary click attack (not an incantation). A small pale mote
   * travels to `target` (or a short way along the aim) and settles in a tiny burst.
   */
  primary(origin: Vector3, aim: Vector3, target?: Vector3 | null): void {
    if (this.disposed) return;
    this.viewmodelSwing(); // local first-person weapon arc + recoil (viewmodel only; camera never moves)
    const a = safeAim(aim);
    const start = origin.add(a.scale(0.7)).add(new Vector3(0, -0.15, 0));
    const end = target ? target.clone() : origin.add(a.scale(10));
    const color = '#cfe0ff';
    if (this.reducedMotion || this.primaryBolts >= MAX_PRIMARY_BOLTS) {
      this.burst(end, color, 8, { size: 0.14, speed: 0.8, life: 0.45 });
      return;
    }
    this.primaryBolts++;
    const bolt = MeshBuilder.CreateSphere('fx-primary', { diameter: 0.12, segments: 6 }, this.scene);
    bolt.isPickable = false;
    bolt.material = this.primaryMaterial(color);
    bolt.position.copyFrom(start);
    const seconds = Math.min(0.3, Math.max(0.08, Vector3.Distance(start, end) / 40));
    this.timed(seconds, (t) => {
      Vector3.LerpToRef(start, end, easeOut(t), bolt.position);
    }, () => {
      bolt.dispose();
      this.primaryBolts--;
      if (!this.disposed) this.burst(end, color, 12, { size: 0.14, speed: 1.4, life: 0.4 });
    });
  }

  hit(power: PowerId | undefined, at: Vector3): void {
    if (this.disposed) return;
    if (this.cameraDistance(at) < CAMERA_NEAR) {
      // Self-hit (or a hit on top of the viewer): no cloud at the eye. HUD health is the main signal;
      // this is only a faint ember ring around the viewer's feet, below the line of sight.
      this.ring(new Vector3(at.x, Math.max(DECAL_Y + 0.02, at.y - EYE_TO_FEET), at.z), '#d9826a', 0.5, 0.7, 0.28);
      return;
    }
    const color = power ? CHANNELS[power].accent : '#ffffff';
    const calm = this.reducedMotion;
    this.burst(at, color, calm ? 18 : 36, { size: 0.22, speed: calm ? 1.4 : 3.2, life: 0.55 });
  }

  banish(at: Vector3): void {
    const calm = this.reducedMotion;
    this.burst(at, '#fff6d8', calm ? 36 : 80, { size: 0.28, speed: calm ? 1.8 : 4.5, life: 1.2, gravity: 2.5, spread: 1.1 });
    this.ring(at.add(new Vector3(0, -1, 0)), '#fff1b8', 0.9, 6, 0.7);
  }

  returned(at: Vector3): void {
    const calm = this.reducedMotion;
    this.burst(at, '#b48cff', calm ? 30 : 60, { size: 0.3, speed: calm ? 0.8 : 1.6, life: 1.6, gravity: 0.6, spread: 1.3 });
    this.ring(at.add(new Vector3(0, -1, 0)), '#7a4cff', 0.8, 4, 0.5);
  }

  /** Ward (RMB, authoritative): a small ring at the caster's feet; the HUD chip carries the duration. */
  ward(feet: Vector3, color = '#9fd4ff'): void {
    // Our own ward (feet ~1.6 m below the eye): raise the first-person weapon into a guard.
    if (this.cameraDistance(feet) < CAMERA_NEAR) this.viewmodelBlock(color);
    this.ring(feet, color, 0.9, 1.6, 0.65);
  }

  /** Accepted recovery (R, authoritative): a soft upward drift of pale gold motes at the caster. */
  heal(feet: Vector3): void {
    const calm = this.reducedMotion;
    if (this.cameraDistance(feet) < CAMERA_NEAR) {
      // Our own recovery: a soft gold ring at the feet; burst() downgrades the motes to dim, non-rising ones.
      this.ring(feet, '#ffe9a8', 1.0, 0.9, 0.35);
      this.burst(feet.add(new Vector3(0, 0.15, 0)), '#ffe9a8', 10, { size: 0.1, speed: 0.4, life: 0.6, spread: 1 });
      return;
    }
    this.burst(feet.add(new Vector3(0, 0.4, 0)), '#ffe9a8', calm ? 20 : 40, { size: 0.16, speed: calm ? 0.6 : 1.2, life: 1.4, gravity: 1.2, spread: 1.2 });
  }

  /** Stops every running effect and releases per-effect resources. Called automatically on scene disposal. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    for (const finish of [...this.active]) finish();
    this.active.clear();
    if (this.vmIdle) this.scene.onBeforeRenderObservable.remove(this.vmIdle);
    this.vmIdle = null;
    this.disposeViewmodel();
  }

  // ---- first-person viewmodel ------------------------------------------------------------------

  /**
   * One bounded camera-attached cosmetic rig: leather-gloved hand on a dark iron trident with brass
   * fittings (lower right), a small ornate lantern (lower left) and a swing arc. Built lazily once a
   * camera exists, rebuilt if the camera changes. ~40 small primitive meshes, 7 materials, no lights.
   */
  private viewmodel(): Viewmodel | null {
    const cam = this.scene.activeCamera;
    if (!cam || this.disposed) return null;
    if (this.vm && this.vm.root.parent === cam && !this.vm.root.isDisposed()) return this.vm;
    this.disposeViewmodel();
    const s = this.scene;
    const root = new TransformNode('fx-viewmodel', s);
    root.parent = cam;
    root.position.copyFrom(VM_REST_POS);
    root.rotation.copyFrom(VM_REST_ROT);
    const mat = (name: string, diffuse: Color3, emissive: Color3, specular: Color3, power = 48) => {
      const m = new StandardMaterial(name, s);
      m.diffuseColor = diffuse;
      m.emissiveColor = emissive; // low: lit by the moon and the hand lantern, readable, never glowing
      m.specularColor = specular;
      m.specularPower = power;
      m.fogEnabled = false;
      return m;
    };
    // Dark leather and cloth: the hunter's own lantern light sits close, so diffuse must stay deep or it reads light brown.
    const leather = mat('fx-vm-leather', new Color3(0.085, 0.055, 0.04), new Color3(0.025, 0.016, 0.01), new Color3(0.07, 0.055, 0.045), 20);
    const cloth = mat('fx-vm-cloth', new Color3(0.12, 0.09, 0.065), new Color3(0.025, 0.018, 0.012), new Color3(0.03, 0.025, 0.02), 12);
    const iron = mat('fx-vm-iron', new Color3(0.17, 0.165, 0.17), new Color3(0.035, 0.035, 0.04), new Color3(0.35, 0.35, 0.38), 64);
    const brass = mat('fx-vm-brass', new Color3(0.58, 0.42, 0.17), new Color3(0.12, 0.08, 0.025), new Color3(0.6, 0.48, 0.28), 72);
    const glass = mat('fx-vm-glass', new Color3(0.6, 0.45, 0.3), new Color3(0.28, 0.16, 0.06), new Color3(0.3, 0.25, 0.2), 32);
    glass.alpha = 0.38;
    glass.backFaceCulling = false;
    const flame = mat('fx-vm-flame', Color3.Black(), new Color3(0.95, 0.56, 0.22), Color3.Black());
    flame.disableLighting = true; // restrained warm flame: a small emissive bead, no bloom (excluded from glow)
    const meshes: Mesh[] = [];
    const add = (m: Mesh, material: StandardMaterial, parent: TransformNode) => {
      m.material = material;
      m.parent = parent;
      m.isPickable = false;
      m.renderingGroupId = 1; // drawn after the world (depth cleared) so it never clips into walls
      this.glow?.addExcludedMesh(m);
      meshes.push(m);
      return m;
    };
    const cyl = (name: string, dTop: number, dBot: number, h: number, tess: number, material: StandardMaterial, parent: TransformNode, x: number, y: number, z: number) => {
      const m = add(MeshBuilder.CreateCylinder(name, { diameterTop: dTop, diameterBottom: dBot, height: h, tessellation: tess }, s), material, parent);
      m.position.set(x, y, z);
      return m;
    };
    const ring = (name: string, d: number, thick: number, material: StandardMaterial, parent: TransformNode, x: number, y: number, z: number) => {
      const m = add(MeshBuilder.CreateTorus(name, { diameter: d, thickness: thick, tessellation: 16 }, s), material, parent);
      m.position.set(x, y, z);
      return m;
    };
    const stud = (parent: TransformNode, x: number, y: number, z: number, d = 0.012) => {
      const m = add(MeshBuilder.CreateSphere('fx-vm-stud', { diameter: d, segments: 6 }, s), brass, parent);
      m.position.set(x, y, z);
      return m;
    };

    // ---- gloved hand: forearm cuff with seams/straps/studs, palm, curled fingers and a thumb over the grip
    const sleeve = cyl('fx-vm-sleeve', 0.1, 0.14, 0.34, 12, cloth, root, 0.02, -0.09, -0.18);
    sleeve.rotation.x = Math.PI / 2 - 0.4;
    const cuff = cyl('fx-vm-cuff', 0.125, 0.15, 0.13, 12, leather, root, 0.01, -0.035, -0.06);
    cuff.rotation.x = Math.PI / 2 - 0.4;
    const strapA = ring('fx-vm-strap', 0.14, 0.012, leather, root, 0.01, -0.02, -0.03);
    strapA.rotation.x = Math.PI / 2 - 0.4;
    const strapB = ring('fx-vm-strap', 0.15, 0.012, leather, root, 0.015, -0.055, -0.1);
    strapB.rotation.x = Math.PI / 2 - 0.4;
    const seam = ring('fx-vm-seam', 0.147, 0.005, brass, root, 0.012, -0.038, -0.065);
    seam.rotation.x = Math.PI / 2 - 0.4;
    stud(root, 0.055, 0.0, -0.025);
    stud(root, -0.04, 0.012, -0.03);
    stud(root, 0.062, -0.04, -0.095);
    const palm = add(MeshBuilder.CreateBox('fx-vm-palm', { width: 0.085, height: 0.06, depth: 0.11 }, s), leather, root);
    palm.position.set(0, 0.012, 0.02);
    palm.rotation.set(-0.15, 0, 0.1);
    for (let i = 0; i < 4; i++) {
      // Fingers curl around the shaft: a knuckle segment angled forward, a fingertip segment folded under.
      const kx = -0.034 + i * 0.023;
      const knuckle = add(MeshBuilder.CreateCapsule('fx-vm-finger', { height: 0.05, radius: 0.0095, tessellation: 6, subdivisions: 1 }, s), leather, root);
      knuckle.position.set(kx, 0.035, 0.075);
      knuckle.rotation.set(1.15, 0, 0);
      const tip = add(MeshBuilder.CreateCapsule('fx-vm-fingertip', { height: 0.04, radius: 0.0085, tessellation: 6, subdivisions: 1 }, s), leather, root);
      tip.position.set(kx, 0.012, 0.095);
      tip.rotation.set(2.3, 0, 0);
    }
    const thumb = add(MeshBuilder.CreateCapsule('fx-vm-thumb', { height: 0.06, radius: 0.011, tessellation: 6, subdivisions: 1 }, s), leather, root);
    thumb.position.set(-0.05, 0.03, 0.045);
    thumb.rotation.set(0.5, -0.4, 1.2);

    // ---- trident: dark iron shaft with a leather-wrapped grip, brass collars, a compact three-prong head
    const weapon = new TransformNode('fx-vm-weapon', s);
    weapon.parent = root;
    weapon.position.set(0, 0.03, 0.06);
    weapon.rotation.copyFrom(VM_WEAPON_REST_ROT);
    cyl('fx-vm-shaft', 0.02, 0.022, 0.62, 10, iron, weapon, 0, 0.14, 0);
    cyl('fx-vm-grip', 0.028, 0.028, 0.14, 10, leather, weapon, 0, 0.0, 0);
    for (const y of [-0.05, -0.02, 0.01, 0.04]) ring('fx-vm-wrap', 0.03, 0.004, leather, weapon, 0, y, 0);
    ring('fx-vm-collar', 0.03, 0.007, brass, weapon, 0, 0.08, 0);
    ring('fx-vm-collar', 0.03, 0.007, brass, weapon, 0, -0.08, 0);
    cyl('fx-vm-ferrule', 0.0, 0.024, 0.05, 8, brass, weapon, 0, -0.14, 0);
    const headBase = cyl('fx-vm-headbase', 0.026, 0.02, 0.04, 8, brass, weapon, 0, 0.46, 0);
    headBase.rotation.set(0, 0, 0);
    ring('fx-vm-headband', 0.028, 0.005, iron, weapon, 0, 0.44, 0);
    const bar = add(MeshBuilder.CreateBox('fx-vm-guard', { width: 0.13, height: 0.016, depth: 0.014 }, s), brass, weapon);
    bar.position.y = 0.485;
    const prong = (x: number, h: number, tilt: number) => {
      const p = cyl('fx-vm-prong', 0, 0.018, h, 6, iron, weapon, x, 0.49 + h / 2 - 0.004, 0);
      p.rotation.z = tilt;
      const tipGlint = cyl('fx-vm-prongtip', 0, 0.009, 0.03, 6, brass, weapon, x - Math.sin(tilt) * (h - 0.012), 0.49 + h - 0.012, 0);
      tipGlint.rotation.z = tilt;
    };
    prong(0, 0.17, 0);
    prong(-0.052, 0.12, 0.2);
    prong(0.052, 0.12, -0.2);
    stud(weapon, -0.045, 0.485, 0.009, 0.01);
    stud(weapon, 0.045, 0.485, 0.009, 0.01);

    // ---- lantern (lower left): iron cage with brass panels and rings, warm glass, a small steady flame
    const lantern = new TransformNode('fx-vm-lantern', s);
    lantern.parent = cam;
    lantern.position.copyFrom(VM_LANTERN_POS);
    lantern.rotation.copyFrom(VM_LANTERN_ROT);
    lantern.scaling.setAll(VM_LANTERN_SCALE);
    cyl('fx-vm-lbase', 0.1, 0.085, 0.018, 10, iron, lantern, 0, -0.085, 0);
    cyl('fx-vm-lfoot', 0.06, 0.07, 0.012, 8, brass, lantern, 0, -0.098, 0);
    cyl('fx-vm-lglass', 0.07, 0.07, 0.13, 10, glass, lantern, 0, -0.01, 0);
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + Math.PI / 4;
      cyl('fx-vm-lbar', 0.007, 0.007, 0.15, 6, iron, lantern, Math.cos(a) * 0.04, -0.01, Math.sin(a) * 0.04);
    }
    ring('fx-vm-lring', 0.088, 0.006, brass, lantern, 0, -0.058, 0);
    ring('fx-vm-lring', 0.088, 0.006, brass, lantern, 0, 0.045, 0);
    const panel = add(MeshBuilder.CreateBox('fx-vm-lpanel', { width: 0.03, height: 0.05, depth: 0.004 }, s), brass, lantern);
    panel.position.set(0, -0.012, -0.043); // engraved-looking brass plate facing the viewer
    const panelB = add(MeshBuilder.CreateBox('fx-vm-lpanel', { width: 0.004, height: 0.05, depth: 0.03 }, s), brass, lantern);
    panelB.position.set(0.043, -0.012, 0);
    cyl('fx-vm-lcap', 0.035, 0.1, 0.035, 10, iron, lantern, 0, 0.075, 0);
    cyl('fx-vm-lchimney', 0.02, 0.03, 0.03, 8, brass, lantern, 0, 0.105, 0);
    const handle = ring('fx-vm-lhandle', 0.06, 0.006, iron, lantern, 0, 0.145, 0);
    handle.rotation.x = Math.PI / 2;
    stud(lantern, 0, 0.122, 0, 0.014);
    const wick = cyl('fx-vm-lwick', 0.012, 0.016, 0.02, 6, brass, lantern, 0, -0.06, 0);
    void wick;
    const ember = add(MeshBuilder.CreateSphere('fx-vm-flame', { diameter: 0.024, segments: 6 }, s), flame, lantern);
    ember.position.set(0, -0.035, 0);
    ember.scaling.set(1, 1.5, 1);
    // The hunter's hand holding the lantern: a small dark cuff set back, a palm and visible curled fingers on the handle.
    const lcuff = cyl('fx-vm-lcuff', 0.07, 0.085, 0.09, 12, leather, lantern, -0.06, 0.21, -0.12);
    lcuff.rotation.set(Math.PI / 2 - 0.6, 0, 0.35);
    const lstrap = ring('fx-vm-lstrap', 0.082, 0.008, leather, lantern, -0.062, 0.215, -0.125);
    lstrap.rotation.set(Math.PI / 2 - 0.6, 0, 0.35);
    stud(lantern, -0.04, 0.215, -0.09, 0.009);
    const lpalm = add(MeshBuilder.CreateBox('fx-vm-lpalm', { width: 0.06, height: 0.04, depth: 0.065 }, s), leather, lantern);
    lpalm.position.set(-0.025, 0.17, -0.05);
    lpalm.rotation.set(0.3, 0.2, 0.2);
    for (let i = 0; i < 3; i++) {
      const f = add(MeshBuilder.CreateCapsule('fx-vm-lfinger', { height: 0.04, radius: 0.008, tessellation: 6, subdivisions: 1 }, s), leather, lantern);
      f.position.set(-0.03 + i * 0.02, 0.152, -0.015);
      f.rotation.set(1.9, 0, 0);
    }

    // ---- swing arc: a thin crescent fan in front of the hand, alpha-blended (never additive whitewash)
    const arcMat = new StandardMaterial('fx-vm-arc', s);
    arcMat.emissiveColor = Color3.FromHexString('#ffd88a');
    arcMat.diffuseColor = Color3.Black();
    arcMat.specularColor = Color3.Black();
    arcMat.disableLighting = true;
    arcMat.backFaceCulling = false;
    arcMat.fogEnabled = false;
    arcMat.alpha = 0;
    const arc = add(MeshBuilder.CreateDisc('fx-vm-arcmesh', { radius: 0.5, arc: 0.3, tessellation: 40 }, s), arcMat, root);
    arc.position.set(-0.3, 0.1, 0.35);
    arc.rotation.set(Math.PI / 2 - 0.25, 0, 0);
    arc.isVisible = false;
    this.vm = { root, weapon, lantern, arc, arcMat, mats: [leather, cloth, iron, brass, glass, flame, arcMat], meshes };
    const inPlay = typeof document !== 'undefined' && document.pointerLockElement !== null;
    root.setEnabled(inPlay);
    lantern.setEnabled(inPlay);
    return this.vm;
  }

  /** Ends any running viewmodel animation (which resets transforms), then starts `tick` for `seconds`. */
  private animateViewmodel(seconds: number, tick: (vm: Viewmodel, t: number) => void): void {
    const vm = this.viewmodel();
    if (!vm) return;
    this.vmFinish?.();
    const reset = () => {
      vm.root.position.copyFrom(VM_REST_POS);
      vm.root.rotation.copyFrom(VM_REST_ROT);
      vm.weapon.rotation.copyFrom(VM_WEAPON_REST_ROT);
      vm.arc.isVisible = false;
      vm.arcMat.alpha = 0;
    };
    let finish: (() => void) | null = null;
    finish = this.timed(seconds, (t) => {
      if (vm.root.isDisposed()) return;
      reset();
      tick(vm, t);
    }, () => {
      if (!vm.root.isDisposed()) reset();
      if (this.vmFinish === finish) this.vmFinish = null;
    });
    this.vmFinish = finish;
  }

  /** LMB: wind-up, right-to-left slash with a fading arc, small local recoil; 0.38 s, returns to rest. */
  private viewmodelSwing(): void {
    const calm = this.reducedMotion;
    this.animateViewmodel(calm ? 0.3 : 0.38, (vm, t) => {
      if (calm) {
        vm.root.position.z += -0.04 * Math.sin(Math.PI * t); // gentle nudge, no sweep
        return;
      }
      // 0..0.2 wind-up right, 0.2..0.55 slash across, 0.55..1 settle home.
      const wind = smoothstep(0, 0.2, t) * (1 - smoothstep(0.2, 0.4, t));
      const slash = smoothstep(0.18, 0.55, t) * (1 - smoothstep(0.6, 1, t));
      vm.root.rotation.z += 0.5 * wind - 1.1 * slash;
      vm.root.rotation.y += 0.35 * wind - 0.55 * slash;
      vm.root.position.x += 0.06 * wind - 0.26 * slash;
      vm.root.position.y += 0.04 * wind - 0.03 * slash;
      vm.weapon.rotation.x += 0.9 * slash;
      // Local recoil just after impact (viewmodel only).
      const kick = smoothstep(0.45, 0.55, t) * (1 - smoothstep(0.55, 0.85, t));
      vm.root.position.z -= 0.07 * kick;
      vm.arc.isVisible = slash > 0.05;
      vm.arc.rotation.y = -0.9 + 1.4 * smoothstep(0.18, 0.6, t);
      vm.arcMat.alpha = 0.32 * envelope(Math.min(1, Math.max(0, (t - 0.18) / 0.5)), 0.2, 0.6);
    });
  }

  /** RMB ward: staff swings horizontal across the view as a guard, a faint ward-coloured arc behind it. */
  private viewmodelBlock(color: string): void {
    const calm = this.reducedMotion;
    this.animateViewmodel(0.45, (vm, t) => {
      const up = calm ? envelope(t, 0.3, 0.4) : envelope(t, 0.25, 0.35);
      vm.root.position.x -= 0.24 * up;
      vm.root.position.y += 0.1 * up;
      vm.root.position.z += 0.05 * up;
      vm.weapon.rotation.z += (Math.PI / 2 - 0.15) * up; // staff crosswise
      vm.weapon.rotation.x -= 0.4 * up; // level the leaning shaft into a guard
      vm.root.rotation.z -= 0.25 * up;
      if (!calm) vm.root.position.z -= 0.035 * smoothstep(0.25, 0.32, t) * (1 - smoothstep(0.32, 0.6, t)); // braced impact
      vm.arc.isVisible = up > 0.05;
      vm.arc.rotation.y = -0.5;
      vm.arcMat.emissiveColor = Color3.FromHexString(color);
      vm.arcMat.alpha = 0.22 * up;
    });
  }

  /** Q: the hand lifts the staff overhead in the channel colour (incantation only, ≤0.9 s). */
  private viewmodelIncant(color: string): void {
    const calm = this.reducedMotion;
    this.animateViewmodel(0.9, (vm, t) => {
      const up = envelope(t, 0.25, 0.4);
      vm.root.position.y += (calm ? 0.04 : 0.12) * up;
      vm.root.position.x -= 0.12 * up;
      vm.root.rotation.x -= 0.35 * up;
      vm.arc.isVisible = up > 0.05;
      vm.arc.rotation.y = 0.2 + (calm ? 0 : t * 1.2);
      vm.arcMat.emissiveColor = Color3.FromHexString(color);
      vm.arcMat.alpha = 0.18 * up;
    });
  }

  private disposeViewmodel(): void {
    this.vmFinish?.();
    this.vmFinish = null;
    const vm = this.vm;
    if (!vm) return;
    this.vm = null;
    for (const m of vm.meshes) m.dispose();
    for (const m of vm.mats) m.dispose();
    vm.weapon.dispose();
    vm.lantern.dispose();
    vm.root.dispose();
  }

  // ---- channels -------------------------------------------------------------------------------

  /** Golden lotus mandala at the target, a protective shell around the caster and rising motes. */
  private ganesha(origin: Vector3, anchor: Vector3, caster: TransformNode | null, release: () => void): void {
    const c = CHANNELS.ganesha;
    const calm = this.reducedMotion;
    this.decal('ganesha', anchor, 2.4, calm ? 1.8 : 1.9, 0.55, calm ? 0 : 0.5, calm ? 1 : 0.6, release);
    const feet = origin.add(new Vector3(0, -EYE_TO_FEET + 0.1, 0));
    this.ring(feet, c.color, 0.8, 2.2, 0.45);
    this.burst(anchor.add(new Vector3(0, 0.5, 0)), c.accent, calm ? 14 : 28, { size: 0.2, speed: calm ? 0.6 : 1.2, life: 1.4, gravity: 1.4, spread: 1.8 });

    // Protective shell. Around another hunter: a faint sphere. Around ourselves (no follow node) a
    // low golden band at the feet, so the camera is never inside pale geometry.
    const mat = this.glowMat('ganesha-shell-mat', c.color, 0);
    let shell: Mesh;
    if (caster && this.cameraDistance(caster.getAbsolutePosition()) < CAMERA_NEAR) caster = null; // viewer inside: use the band
    if (caster) {
      shell = MeshBuilder.CreateSphere('ganesha-shell', { diameter: 2.2, segments: 16 }, this.scene);
      shell.parent = caster;
      shell.position.y = -0.6;
    } else {
      shell = MeshBuilder.CreateCylinder('ganesha-band', { diameter: 2, height: 0.55, tessellation: 32, cap: 0 }, this.scene);
      shell.position.set(feet.x, 0.3, feet.z);
    }
    shell.isPickable = false;
    shell.material = mat;
    const peak = caster ? 0.14 : 0.2;
    this.timed(1.9, (t) => {
      mat.alpha = caster?.isDisposed() ? 0 : peak * envelope(t, 0.15, 0.5);
    }, () => {
      mat.dispose();
      shell.dispose();
    });
  }

  /** Saffron wind spiral: two motes corkscrew to the target, a spiral glyph whirls there. */
  private hanuman(origin: Vector3, aim: Vector3, anchor: Vector3, release: () => void): void {
    const c = CHANNELS.hanuman;
    const calm = this.reducedMotion;
    this.decal('hanuman', anchor, 1.9, calm ? 1.8 : 1.5, 0.5, calm ? 0 : Math.PI * 1.5, calm ? 1 : 0.5, release);
    const end = anchor.add(new Vector3(0, 1, 0));
    if (calm) {
      this.burst(end, c.accent, 14, { size: 0.2, speed: 0.8, life: 0.9, spread: 1.4 });
      return;
    }
    const start = origin.add(aim.scale(2.2)).add(new Vector3(0, -0.35, 0));
    const axis = end.subtract(start);
    const side = Vector3.Cross(axis.normalizeToNew(), Vector3.Up());
    if (side.lengthSquared() < 1e-4) side.set(1, 0, 0);
    side.normalize();
    const up = Vector3.Cross(side, axis.normalizeToNew()).normalize();
    const strands = [0, Math.PI].map((phase) => {
      const ps = this.system('hanuman-spiral', 140);
      ps.emitter = start.clone();
      ps.createSphereEmitter(0.06);
      this.colorize(ps, c.color, c.accent);
      ps.minSize = 0.1;
      ps.maxSize = 0.26;
      ps.minLifeTime = 0.25;
      ps.maxLifeTime = 0.45;
      ps.emitRate = 220;
      ps.minEmitPower = 0.1;
      ps.maxEmitPower = 0.4;
      ps.start();
      return { ps, phase };
    });
    const turns = 2.5;
    const radius = 0.45;
    this.timed(0.55, (t) => {
      const u = easeOut(t);
      const ang = u * turns * Math.PI * 2;
      for (const s of strands) {
        const p = s.ps.emitter as Vector3;
        p.copyFrom(start).addInPlace(axis.scale(u));
        p.addInPlace(side.scale(Math.cos(ang + s.phase) * radius * (1 - u * 0.5)));
        p.addInPlace(up.scale(Math.sin(ang + s.phase) * radius * (1 - u * 0.5)));
        s.ps.emitRate = this.cameraDistance(p) < CAMERA_NEAR ? 0 : 220;
      }
    }, () => {
      for (const s of strands) this.retire(s.ps, s.ps.maxLifeTime + 0.3);
      if (!this.disposed) this.burst(end, c.accent, 24, { size: 0.2, speed: 1.8, life: 0.7, spread: 1.2 });
    });
  }

  /** Icy trident rune and freezing ring at the target, with slow settling frost. */
  private shiva(anchor: Vector3, release: () => void): void {
    const c = CHANNELS.shiva;
    const calm = this.reducedMotion;
    this.decal('shiva', anchor, 2.2, 1.9, 0.6, calm ? 0 : 0.25, calm ? 1 : 0.7, release);
    this.ring(new Vector3(anchor.x, DECAL_Y + 0.02, anchor.z), c.color, 1.1, 2.6, 0.5);
    this.burst(anchor.add(new Vector3(0, 1.2, 0)), c.accent, calm ? 18 : 36, { size: 0.14, speed: calm ? 0.5 : 1.2, life: 1.4, gravity: -1.2, spread: 1.6 });
  }

  /** Blue-gold returning chakra: a spinning wheel flies to the target and returns to the caster. */
  private vishnu(origin: Vector3, aim: Vector3, anchor: Vector3, caster: TransformNode | null, release: () => void): void {
    const c = CHANNELS.vishnu;
    const calm = this.reducedMotion;
    const out = anchor.add(new Vector3(0, 1.1, 0));
    if (calm) {
      // Static wheel hovering at the target plus its ground glyph; no spin or travel.
      this.decal('vishnu', anchor, 1.8, 1.8, 0.45, 0, 1, release);
      const wheel = this.chakraWheel(out);
      wheel.node.lookAt(origin);
      this.timed(1.6, (t) => {
        wheel.setAlpha(envelope(t, 0.2, 0.45) * this.nearFade(out));
      }, () => wheel.dispose());
      return;
    }
    const wheel = this.chakraWheel(origin.add(aim.scale(2.2)).add(new Vector3(0, -0.35, 0)));
    const node = wheel.node;
    const trail = this.system('vishnu-trail', 160);
    trail.emitter = node as unknown as Mesh;
    trail.createSphereEmitter(0.3);
    this.colorize(trail, c.color, c.accent);
    trail.minSize = 0.1;
    trail.maxSize = 0.24;
    trail.minLifeTime = 0.3;
    trail.maxLifeTime = 0.5;
    trail.emitRate = 120;
    trail.minEmitPower = 0.2;
    trail.maxEmitPower = 0.5;
    trail.start();

    const start = node.position.clone();
    let turned = false;
    this.timed(1.6, (t, dt) => {
      node.rotation.z += 9 * dt; // smooth, frame-rate independent spin around the wheel's axis
      if (t < 0.5) {
        Vector3.LerpToRef(start, out, easeOut(t / 0.5), node.position);
        wheel.setAlpha(Math.min(1, t / 0.08) * this.nearFade(node.position));
      } else {
        if (!turned) {
          turned = true;
          this.decal('vishnu', anchor, 1.8, 1.4, 0.45, 0.6, 0.5, release);
        }
        const home = caster && !caster.isDisposed() ? caster.getAbsolutePosition().add(new Vector3(0, -0.25, 0)) : origin.add(aim.scale(0.8)).add(new Vector3(0, -0.5, 0));
        const u = easeIn((t - 0.5) / 0.5);
        Vector3.LerpToRef(out, home, u, node.position);
        wheel.setAlpha((1 - smoothstep(0.55, 1, u)) * this.nearFade(node.position)); // gone before it reaches the camera
      }
      trail.emitRate = this.cameraDistance(node.position) < CAMERA_NEAR ? 0 : 120;
      // Wheel faces the direction of flight.
      node.rotation.y = Math.atan2(aim.x, aim.z);
    }, () => {
      if (!turned) release();
      this.retire(trail, trail.maxLifeTime + 0.3);
      wheel.dispose();
    });
  }

  // ---- composite pieces -----------------------------------------------------------------------

  /** Brief spectral portrait from the channel's generated art, hovering above the target. One at a time. */
  private portrait(power: PowerId, anchor: Vector3): void {
    if (this.portraitFailed.has(power)) return;
    if (this.cameraDistance(anchor.add(new Vector3(0, 2.5, 0))) < CAMERA_NEAR) return;
    this.stopPortrait?.();
    const tex = this.portraitTexture(power);
    const plane = MeshBuilder.CreatePlane('fx-portrait', { size: 1.5 }, this.scene);
    plane.isPickable = false;
    plane.billboardMode = TransformNode.BILLBOARDMODE_Y;
    const base = anchor.add(new Vector3(0, 2.5, 0));
    plane.position.copyFrom(base);
    const mat = new StandardMaterial('fx-portrait-mat', this.scene);
    mat.diffuseTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.opacityTexture = this.vignetteTexture();
    mat.diffuseColor = Color3.White();
    mat.emissiveColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.alphaMode = Constants.ALPHA_ADD; // spectral: dark areas vanish, never brightens past the art
    mat.alpha = 0;
    plane.material = mat;
    const calm = this.reducedMotion;
    const peak = 0.4;
    let finish: (() => void) | null = null;
    finish = this.timed(1.9, (t) => {
      mat.alpha = peak * envelope(t, 0.18, 0.45);
      if (!calm) plane.position.y = base.y + easeOut(t) * 0.3;
    }, () => {
      mat.dispose(); // keeps the shared portrait/vignette textures
      plane.dispose();
      if (this.stopPortrait === finish) this.stopPortrait = null;
    });
    this.stopPortrait = finish;
  }

  /** A deity glyph painted on the ground at `anchor`, fading in/out with optional slow spin/growth. */
  private decal(power: PowerId, anchor: Vector3, radius: number, seconds: number, peak: number, spin: number, startScale: number, release?: () => void): void {
    const ground = MeshBuilder.CreateGround('fx-glyph', { width: radius * 2, height: radius * 2 }, this.scene);
    ground.isPickable = false;
    ground.position.set(anchor.x, DECAL_Y, anchor.z);
    const mat = new StandardMaterial('fx-glyph-mat', this.scene);
    mat.diffuseTexture = this.glyphTexture(power);
    mat.useAlphaFromDiffuseTexture = true;
    mat.diffuseColor = Color3.White();
    mat.specularColor = Color3.Black();
    mat.disableLighting = true;
    mat.alphaMode = Constants.ALPHA_ADD;
    mat.zOffset = -2;
    mat.alpha = 0;
    ground.material = mat;
    const yaw0 = Math.random() * Math.PI * 2;
    this.timed(seconds, (t) => {
      mat.alpha = peak * envelope(t, 0.15, 0.45);
      ground.rotation.y = yaw0 + spin * easeOut(t);
      ground.scaling.setAll(startScale + (1 - startScale) * easeOut(Math.min(1, t * 2.5)));
    }, () => {
      mat.dispose();
      ground.dispose();
      release?.();
    });
  }

  private chakraWheel(at: Vector3): { node: TransformNode; setAlpha(a: number): void; dispose(): void } {
    const c = CHANNELS.vishnu;
    const node = new TransformNode('vishnu-chakra', this.scene);
    node.position.copyFrom(at);
    const rim = MeshBuilder.CreateTorus('vishnu-rim', { diameter: 0.9, thickness: 0.07, tessellation: 40 }, this.scene);
    rim.rotation.x = Math.PI / 2; // wheel stands upright, facing along local Z
    rim.isPickable = false;
    const rimMat = this.glowMat('vishnu-rim-mat', c.accent, 0);
    rim.material = rimMat;
    rim.parent = node;
    const face = MeshBuilder.CreatePlane('vishnu-face', { size: 0.86 }, this.scene);
    face.isPickable = false;
    const faceMat = new StandardMaterial('vishnu-face-mat', this.scene);
    faceMat.diffuseTexture = this.glyphTexture('vishnu');
    faceMat.useAlphaFromDiffuseTexture = true;
    faceMat.diffuseColor = Color3.White();
    faceMat.specularColor = Color3.Black();
    faceMat.disableLighting = true;
    faceMat.backFaceCulling = false;
    faceMat.alphaMode = Constants.ALPHA_ADD;
    faceMat.alpha = 0;
    face.material = faceMat;
    face.parent = node;
    return {
      node,
      setAlpha(a: number) {
        rimMat.alpha = 0.9 * a;
        faceMat.alpha = 0.85 * a;
      },
      dispose() {
        rimMat.dispose();
        faceMat.dispose();
        node.dispose(); // disposes rim and face with it
      },
    };
  }

  // ---- shared textures ------------------------------------------------------------------------

  private portraitTexture(power: PowerId): Texture {
    let tex = this.portraits.get(power);
    if (!tex) {
      tex = new Texture(CHANNELS[power].portrait, this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE, null, () => {
        this.portraitFailed.add(power);
        console.warn('[effects] portrait unavailable', power);
      });
      tex.hasAlpha = true;
      this.portraits.set(power, tex);
    }
    return tex;
  }

  private vignetteTexture(): DynamicTexture {
    if (this.vignette) return this.vignette;
    const tex = new DynamicTexture('fx-vignette', 128, this.scene, false);
    const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
    const g = ctx.createRadialGradient(64, 60, 10, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.7)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    tex.hasAlpha = true;
    tex.update();
    this.vignette = tex;
    return tex;
  }

  /** Canvas-drawn, respectful abstract motifs (lotus, wind spiral, trident rune, chakra), cached per channel. */
  private glyphTexture(power: PowerId): DynamicTexture {
    const cached = this.glyphs.get(power);
    if (cached) return cached;
    const S = 256;
    const tex = new DynamicTexture(`fx-glyph-${power}`, S, this.scene, true);
    const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
    const c = CHANNELS[power];
    ctx.clearRect(0, 0, S, S);
    ctx.translate(S / 2, S / 2);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = c.color;
    ctx.fillStyle = c.color;
    const circle = (r: number, w: number, style = c.color) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    };
    switch (power) {
      case 'ganesha': {
        circle(120, 3);
        circle(112, 1.5, c.accent);
        const petals = (n: number, len: number, wid: number, rot: number, style: string) => {
          ctx.strokeStyle = style;
          ctx.lineWidth = 3;
          for (let i = 0; i < n; i++) {
            ctx.save();
            ctx.rotate(rot + (i * Math.PI * 2) / n);
            ctx.beginPath();
            ctx.moveTo(0, -18);
            ctx.quadraticCurveTo(wid, -len * 0.55, 0, -len);
            ctx.quadraticCurveTo(-wid, -len * 0.55, 0, -18);
            ctx.stroke();
            ctx.restore();
          }
        };
        petals(12, 104, 26, Math.PI / 12, c.color);
        petals(8, 72, 22, 0, c.accent);
        circle(18, 3, c.accent);
        for (let i = 0; i < 24; i++) {
          const ang = (i * Math.PI * 2) / 24;
          ctx.beginPath();
          ctx.arc(Math.cos(ang) * 116, Math.sin(ang) * 116, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'hanuman': {
        ctx.lineWidth = 6;
        for (let arm = 0; arm < 3; arm++) {
          ctx.strokeStyle = arm === 1 ? c.accent : c.color;
          ctx.beginPath();
          for (let i = 0; i <= 60; i++) {
            const k = i / 60;
            const r = 10 + k * 108;
            const ang = arm * ((Math.PI * 2) / 3) + k * Math.PI * 2.2;
            const x = Math.cos(ang) * r;
            const y = Math.sin(ang) * r;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        circle(12, 4, c.accent);
        break;
      }
      case 'shiva': {
        circle(120, 3);
        circle(98, 2, c.accent);
        // A ring of small ticks between the circles, like a quiet frost rune.
        ctx.lineWidth = 3;
        for (let i = 0; i < 24; i++) {
          const ang = (i * Math.PI * 2) / 24;
          const r0 = i % 2 ? 103 : 101;
          ctx.beginPath();
          ctx.moveTo(Math.cos(ang) * r0, Math.sin(ang) * r0);
          ctx.lineTo(Math.cos(ang) * 115, Math.sin(ang) * 115);
          ctx.stroke();
        }
        // Trident: shaft, centre prong and two curved side prongs.
        ctx.strokeStyle = c.accent;
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(0, 80);
        ctx.lineTo(0, -78);
        ctx.moveTo(-40, -70);
        ctx.quadraticCurveTo(-42, -20, 0, -14);
        ctx.quadraticCurveTo(42, -20, 40, -70);
        ctx.stroke();
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(-10, -86);
        ctx.lineTo(0, -98);
        ctx.lineTo(10, -86);
        ctx.stroke();
        // Small crescent beside the trident.
        ctx.strokeStyle = c.color;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(-56, 40, 18, Math.PI * 0.35, Math.PI * 1.65);
        ctx.stroke();
        break;
      }
      case 'vishnu': {
        circle(118, 8, c.accent);
        circle(100, 3, c.color);
        circle(22, 6, c.accent);
        ctx.strokeStyle = c.color;
        ctx.lineWidth = 5;
        for (let i = 0; i < 12; i++) {
          const ang = (i * Math.PI * 2) / 12;
          ctx.beginPath();
          ctx.moveTo(Math.cos(ang) * 26, Math.sin(ang) * 26);
          ctx.lineTo(Math.cos(ang) * 98, Math.sin(ang) * 98);
          ctx.stroke();
        }
        ctx.fillStyle = c.accent;
        for (let i = 0; i < 16; i++) {
          const ang = (i * Math.PI * 2) / 16;
          ctx.save();
          ctx.rotate(ang);
          ctx.beginPath();
          ctx.moveTo(-6, -120);
          ctx.lineTo(0, -128);
          ctx.lineTo(6, -120);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
        break;
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    tex.hasAlpha = true;
    tex.update();
    this.glyphs.set(power, tex);
    return tex;
  }

  private primaryMaterial(color: string): StandardMaterial {
    if (!this.primaryMat) this.primaryMat = this.glowMat('fx-primary-mat', color, 0.85); // shared, never disposed per bolt
    return this.primaryMat;
  }

  // ---- primitives -----------------------------------------------------------------------------

  /** Where a Q cinematic lands: the target if known, else DEFAULT_REACH along the flat aim; on the ground. */
  private anchorFor(origin: Vector3, aim: Vector3, target: Vector3 | null): Vector3 {
    const flat = new Vector3(aim.x, 0, aim.z);
    if (flat.lengthSquared() < 1e-4) flat.set(0, 0, 1);
    flat.normalize();
    let p = target ? target.clone() : origin.add(flat.scale(DEFAULT_REACH));
    const d = new Vector3(p.x - origin.x, 0, p.z - origin.z);
    if (d.length() < MIN_PORTRAIT_DISTANCE) p = origin.add(flat.scale(MIN_PORTRAIT_DISTANCE));
    return new Vector3(p.x, 0, p.z);
  }

  private ring(at: Vector3, color: string, seconds: number, radius: number, alpha: number): void {
    if (this.disposed) return;
    // Skip a ring centred on the viewer close to eye height (e.g. banish/return at the camera), or one
    // whose expansion would sweep through eye level. Feet rings (≥1.5 m below the eye) are allowed.
    const cam = this.scene.activeCamera?.globalPosition;
    if (cam) {
      const dy = Math.abs(cam.y - at.y);
      const dxz = Math.hypot(cam.x - at.x, cam.z - at.z);
      if ((dy < 1.2 && dxz < 1.5) || (dy < 0.6 && dxz < 1 + radius * 2 + 0.5)) return;
    }
    const anchor = at.clone();
    const calm = this.reducedMotion;
    const ring = MeshBuilder.CreateTorus('fx-ring', { diameter: 1, thickness: 0.16, tessellation: 48 }, this.scene);
    ring.isPickable = false;
    ring.position.copyFrom(anchor);
    const mat = this.glowMat('fx-ring-mat', color, alpha);
    ring.material = mat;
    if (calm) {
      // Reduced motion: the ring appears at a modest fixed size and simply fades.
      const s = 1 + radius;
      ring.scaling.set(s, 1, s);
    }
    this.timed(seconds, (t) => {
      if (!calm) {
        const u = easeOut(t);
        ring.scaling.set(1 + u * radius * 2, 1, 1 + u * radius * 2);
        ring.position.y = anchor.y + u * 0.3;
      }
      mat.alpha = alpha * (calm ? envelope(t, 0.2, 0.6) : 1 - t);
    }, () => {
      mat.dispose();
      ring.dispose();
    });
  }

  private burst(at: Vector3, color: string, count: number, o: BurstOptions): void {
    if (this.disposed) return;
    let { size = 0.25, speed = 4, life = 0.8, gravity = 0, spread = 1 } = o;
    const d = this.cameraDistance(at);
    if (d < CAMERA_SUPPRESS) return; // never emit at/inside the camera
    const near = d < CAMERA_NEAR;
    if (near) {
      // Compact, dim, non-additive, and nothing that drifts up into the eye.
      count = Math.min(count, 10);
      size = Math.min(size, 0.1);
      speed = Math.min(speed, 0.6);
      life = Math.min(life, 0.6);
      gravity = Math.min(gravity, 0);
      spread = Math.min(spread, 0.6);
    }
    const ps = this.system('fx-burst', count);
    ps.emitter = at.clone();
    ps.createSphereEmitter(0.25 * spread);
    this.colorize(ps, color, near ? color : '#ffffff');
    if (near) {
      ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
      ps.color1.a = 0.35;
      ps.color2.a = 0.3;
    }
    ps.minSize = size * 0.6;
    ps.maxSize = size * 1.4;
    ps.minLifeTime = life * 0.55;
    ps.maxLifeTime = life;
    ps.minEmitPower = speed * 0.45;
    ps.maxEmitPower = speed;
    ps.gravity = new Vector3(0, gravity, 0);
    ps.emitRate = 0;
    ps.manualEmitCount = count; // one-shot: emits `count` on the next frame, then nothing
    ps.start();
    this.retire(ps, life + 0.3, false);
  }

  /** Distance from the active camera; Infinity when there is no camera (headless/offscreen). */
  private cameraDistance(p: Vector3): number {
    const cam = this.scene.activeCamera;
    return cam ? Vector3.Distance(cam.globalPosition, p) : Infinity;
  }

  /** 0 at/inside CAMERA_SUPPRESS, 1 beyond CAMERA_NEAR: fades bright geometry that approaches the eye. */
  private nearFade(p: Vector3): number {
    return smoothstep(CAMERA_SUPPRESS, CAMERA_NEAR, this.cameraDistance(p));
  }

  private system(name: string, capacity: number): ParticleSystem {
    const ps = new ParticleSystem(name, capacity, this.scene);
    ps.particleTexture = this.soft;
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.updateSpeed = 1 / 60; // makes lifetimes and emit powers read as seconds and m/s
    return ps;
  }

  /**
   * Bounded cleanup for finite systems: optionally stop emitting now, then dispose once the longest
   * particle has expired. `dispose(false)` keeps the shared sprite texture alive; Babylon's default
   * (and its disposeOnStop path) would dispose that texture with the first system.
   */
  private retire(ps: ParticleSystem, afterSeconds: number, stopNow = true): void {
    if (stopNow) ps.stop();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(id);
      this.timers.delete(id);
      this.active.delete(finish);
      ps.dispose(false);
    };
    const id = window.setTimeout(finish, afterSeconds * 1000);
    this.timers.add(id);
    this.active.add(finish);
  }

  private colorize(ps: ParticleSystem, main: string, accent: string): void {
    const a = Color3.FromHexString(main);
    const b = Color3.FromHexString(accent);
    ps.color1 = new Color4(a.r, a.g, a.b, 1);
    ps.color2 = new Color4(b.r, b.g, b.b, 0.9);
    ps.colorDead = new Color4(a.r, a.g, a.b, 0);
  }

  private glowMat(name: string, hex: string, alpha: number): StandardMaterial {
    const m = new StandardMaterial(name, this.scene);
    m.emissiveColor = Color3.FromHexString(hex);
    m.diffuseColor = Color3.Black();
    m.specularColor = Color3.Black();
    m.disableLighting = true;
    m.backFaceCulling = false;
    m.alpha = alpha;
    return m;
  }

  /**
   * Runs `tick(t, dt)` every frame for `seconds`, then `done()`. t is normalized 0..1. Returns a
   * finisher that ends the effect early (idempotent); the layer runs all finishers on dispose.
   */
  private timed(seconds: number, tick: (t: number, dt: number) => void, done: () => void): () => void {
    let elapsed = 0;
    let finished = false;
    let obs: Observer<Scene> | null = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (obs) this.scene.onBeforeRenderObservable.remove(obs);
      this.active.delete(finish);
      done();
    };
    if (this.disposed) {
      finished = true;
      done();
      return finish;
    }
    this.active.add(finish);
    obs = this.scene.onBeforeRenderObservable.add(() => {
      const dt = Math.min(0.1, this.scene.getEngine().getDeltaTime() / 1000); // no jumps after tab switches
      elapsed += dt;
      const t = Math.min(1, elapsed / seconds);
      tick(t, dt);
      if (t >= 1) finish();
    });
    return finish;
  }
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const easeIn = (t: number) => t * t;
const smoothstep = (a: number, b: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};
/** Smooth fade in over [0, rise], hold, smooth fade out over the final `fall` fraction. */
const envelope = (t: number, rise: number, fall: number) =>
  smoothstep(0, rise, t) * (1 - smoothstep(1 - fall, 1, t));
const safeAim = (aim: Vector3): Vector3 => {
  const a = aim.clone();
  return a.lengthSquared() < 1e-6 ? new Vector3(0, 0, 1) : a.normalize();
};
