import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { GlowLayer } from '@babylonjs/core/Layers/glowLayer';
import type { CombatAction, Vec3 } from '../../shared/protocol';
import { WORLD, loadKit, placeKit, resolveCollisions } from './world';

const LOOK_SPEED = 0.0022;
const MAX_PITCH = 1.45;
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight']);

const isTypingTarget = (t: EventTarget | null): boolean =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t instanceof HTMLButtonElement;

interface Predicted { seq: number; x: number; z: number }

/**
 * First-person controller with deliberate input: movement only from keys actually held while the
 * pointer is locked and gameplay is enabled; every action is one discrete press. Prediction runs
 * against the shared obstacle boxes and reconciles to the server's acked position; the server stays
 * authoritative for the real position, HP and hits.
 */
export class LocalPlayer {
  readonly camera: FreeCamera;
  readonly pos: Vector3;
  yaw = 0;
  pitch = 0;
  locked = false;
  /** Gameplay gate set by the session: alive, connected, not paused. Nothing moves while false. */
  inputEnabled = false;
  sensitivity = 1;
  reduceMotion = true;
  onAction: ((action: CombatAction) => void) | null = null;
  onInteract: (() => void) | null = null;
  onLockChange: ((locked: boolean) => void) | null = null;
  onLockError: ((reason: string) => void) | null = null;
  /** Window blur or document hidden: held input is already cleared; the session decides how to resume. */
  onFocusLost: (() => void) | null = null;
  /** Hold-V push-to-talk for The Source (true on press, false on release); never from a text field. */
  onHoldTalk: ((held: boolean) => void) | null = null;
  private readonly keys = new Set<string>();
  private readonly lantern: PointLight;
  private readonly history: Predicted[] = [];
  private bobPhase = 0;
  private speed = 0;

  constructor(scene: Scene, private readonly canvas: HTMLCanvasElement, glow: GlowLayer | null = null) {
    this.pos = Vector3.FromArray(WORLD.spawn);
    this.camera = new FreeCamera('hunter-camera', this.pos.clone(), scene);
    this.camera.minZ = 0.1;
    this.camera.maxZ = 400;
    this.camera.fov = 1.05;
    this.camera.inputs.clear();
    scene.activeCamera = this.camera;

    this.lantern = new PointLight('hunter-lantern', this.pos.clone(), scene);
    this.lantern.diffuse = new Color3(1, 0.78, 0.5);
    this.lantern.specular = Color3.Black();
    this.lantern.intensity = 0.55;
    this.lantern.range = 10;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.code === 'KeyV' && !isTypingTarget(e.target)) {
        this.onHoldTalk?.(true);
        return;
      }
      if (!this.locked) {
        // Mouse free (e.g. after a fall the lock is released): one deliberate E may still reach the session,
        // which only honours it for the return-after-fall path. Never while a field or control has focus.
        if (e.code === 'KeyE' && !isTypingTarget(e.target)) this.onInteract?.();
        return; // everything else belongs to the menus whenever the mouse is free
      }
      switch (e.code) {
        case 'KeyQ':
          e.preventDefault();
          this.onAction?.('incantation');
          return;
        case 'KeyR':
          e.preventDefault();
          this.onAction?.('heal');
          return;
        case 'KeyE':
          e.preventDefault();
          this.onInteract?.();
          return;
      }
      if (MOVE_KEYS.has(e.code)) this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyV') this.onHoldTalk?.(false);
    });
    window.addEventListener('blur', () => {
      this.clearHeld();
      this.onHoldTalk?.(false);
      this.onFocusLost?.();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      this.clearHeld();
      this.onHoldTalk?.(false);
      this.onFocusLost?.();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.clearHeld();
      this.onLockChange?.(this.locked);
    });
    document.addEventListener('pointerlockerror', () => this.onLockError?.('the browser refused to lock the mouse'));
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const k = LOOK_SPEED * this.sensitivity;
      this.yaw += e.movementX * k;
      this.pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, this.pitch + e.movementY * k));
    });
    // One discrete action per press; holding a button never repeats.
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.onAction?.('primary');
      else if (e.button === 2) this.onAction?.('secondary');
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // only the game canvas

    void this.attachViewmodel(scene, glow);
  }

  /** Drops every held key and any residual speed: blur, pause, defeat, disconnect, teardown. */
  clearHeld(): void {
    this.keys.clear();
    this.speed = 0;
  }

  /**
   * Pointer lock is only ever requested from a user gesture (Enter, Resume, Return to Bellgrave).
   * Failures surface through `onLockError` so the UI can offer a retry.
   */
  requestLock(): void {
    if (document.pointerLockElement === this.canvas) return;
    try {
      const result = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      result?.catch?.((err: unknown) => this.onLockError?.(err instanceof Error ? err.message : String(err)));
    } catch (err) {
      this.onLockError?.(err instanceof Error ? err.message : String(err));
    }
  }

  releaseLock(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  get sprinting(): boolean {
    return this.inputEnabled && (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'));
  }

  /** World-space move vector (length ≤ 1) from WASD actually held, relative to the current yaw. */
  moveInput(): { x: number; z: number } {
    if (!this.locked || !this.inputEnabled) return { x: 0, z: 0 };
    const fwd = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const side = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    if (!fwd && !side) return { x: 0, z: 0 };
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    const x = fwd * s + side * c;
    const z = fwd * c - side * s;
    const len = Math.hypot(x, z) || 1;
    return { x: x / len, z: z / len };
  }

  /** Unit aim vector from the camera (yaw 0 faces +Z, positive pitch looks down in Babylon). */
  aim(): Vec3 {
    const cp = Math.cos(this.pitch);
    return [cp * Math.sin(this.yaw), -Math.sin(this.pitch), cp * Math.cos(this.yaw)];
  }

  /** Remember where prediction put us when input `seq` was sent. */
  record(seq: number): void {
    this.history.push({ seq, x: this.pos.x, z: this.pos.z });
    if (this.history.length > 120) this.history.shift();
  }

  update(dt: number): void {
    const move = this.moveInput();
    const target = move.x || move.z ? (this.sprinting ? WORLD.sprintSpeed : WORLD.walkSpeed) : 0;
    this.speed = this.inputEnabled ? this.speed + (target - this.speed) * Math.min(1, dt * 12) : 0;
    this.pos.x += move.x * this.speed * dt;
    this.pos.z += move.z * this.speed * dt;
    resolveCollisions(this.pos, WORLD.playerRadius);

    this.bobPhase += dt * (this.speed > 0.3 ? this.speed * 1.9 : 0);
    const bob = this.reduceMotion ? 0 : Math.sin(this.bobPhase) * 0.035 * Math.min(1, this.speed / WORLD.walkSpeed);
    this.camera.position.set(this.pos.x, this.pos.y + bob, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    this.lantern.position.set(this.pos.x, this.pos.y - 0.4, this.pos.z);
  }

  /** Server reconciliation: compare the acked prediction with the authoritative position and correct. */
  reconcile(serverPos: Vec3, ackSeq: number): void {
    let idx = -1;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].seq <= ackSeq) {
        idx = i;
        break;
      }
    }
    const ref = idx >= 0 ? this.history[idx] : { seq: 0, x: this.pos.x, z: this.pos.z };
    if (idx >= 0) this.history.splice(0, idx + 1);
    const ex = serverPos[0] - ref.x;
    const ez = serverPos[2] - ref.z;
    const err = Math.hypot(ex, ez);
    if (err > 3) {
      this.pos.set(serverPos[0], serverPos[1], serverPos[2]);
      this.history.length = 0;
    } else if (err > 0.01) {
      const k = idx >= 0 ? 0.6 : 0.15;
      this.pos.x += ex * k;
      this.pos.z += ez * k;
    }
    this.pos.y = serverPos[1];
  }

  teleport(p: Vec3): void {
    this.pos.set(p[0], p[1], p[2]);
    this.history.length = 0;
    this.speed = 0;
  }

  /** Small hand lantern in the lower right of the view (Kenney CC0 prop); purely cosmetic, skipped on failure. */
  private async attachViewmodel(scene: Scene, glow: GlowLayer | null): Promise<void> {
    const kit = await loadKit(scene, 'lantern-candle.glb');
    if (!kit) return;
    const holder = placeKit(kit, 'viewmodel-lantern', Vector3.Zero(), -0.4, 0.45);
    holder.parent = this.camera;
    holder.position.set(0.42, -0.36, 0.95);
    for (const m of holder.getChildMeshes()) {
      m.isPickable = false;
      if (m instanceof Mesh) glow?.addExcludedMesh(m);
    }
  }
}
