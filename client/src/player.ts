import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import type { Vec3 } from '../../shared/protocol';
import { WORLD, resolveCollisions } from './world';

const LOOK_SPEED = 0.0022;
const MAX_PITCH = 1.45;

interface Predicted { seq: number; x: number; z: number }

/**
 * First-person controller with client-side prediction. Movement is integrated locally against the
 * shared obstacle boxes and reconciled against the server's acked position; the server stays
 * authoritative for the real position, HP and hits.
 */
export class LocalPlayer {
  readonly camera: FreeCamera;
  readonly pos: Vector3;
  yaw = 0;
  pitch = 0;
  locked = false;
  onAttack: (() => void) | null = null;
  onLockChange: ((locked: boolean) => void) | null = null;
  private readonly keys = new Set<string>();
  private readonly lantern: PointLight;
  private readonly history: Predicted[] = [];
  private bobPhase = 0;
  private speed = 0;

  constructor(scene: Scene, private readonly canvas: HTMLCanvasElement) {
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
    this.lantern.intensity = 0.65;
    this.lantern.range = 11;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.keys.clear();
      this.onLockChange?.(this.locked);
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw += e.movementX * LOOK_SPEED;
      this.pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, this.pitch + e.movementY * LOOK_SPEED));
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0 && this.locked) this.onAttack?.();
    });
  }

  /** Pointer lock is only ever requested from a user gesture (the Enter button or a canvas click). */
  requestLock(): void {
    if (document.pointerLockElement !== this.canvas) this.canvas.requestPointerLock();
  }

  get sprinting(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  /** World-space move vector (length ≤ 1) built from WASD relative to the current yaw. */
  moveInput(): { x: number; z: number } {
    if (!this.locked) return { x: 0, z: 0 };
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
    this.speed += (target - this.speed) * Math.min(1, dt * 12);
    this.pos.x += move.x * this.speed * dt;
    this.pos.z += move.z * this.speed * dt;
    resolveCollisions(this.pos, WORLD.playerRadius);

    this.bobPhase += dt * (this.speed > 0.3 ? this.speed * 1.9 : 0);
    const bob = Math.sin(this.bobPhase) * 0.035 * Math.min(1, this.speed / WORLD.walkSpeed);
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
  }
}
