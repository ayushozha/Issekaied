import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import type { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { PowerId } from '../../shared/protocol';
import { CHANNELS } from './powers';
import { softParticleTexture } from './world';

const EYE_TO_FEET = 1.6;

interface BurstOptions { size?: number; speed?: number; life?: number; gravity?: number; spread?: number }

/**
 * Visual-only spell, hit, banish and return effects. Nothing here changes game state; the server
 * reports hits and banishments, the client just makes them legible.
 */
export class EffectsLayer {
  private readonly soft: DynamicTexture;

  constructor(private readonly scene: Scene) {
    this.soft = softParticleTexture(scene);
  }

  /** Plays the channel's invocation from `origin` (eye position) along unit `aim`. */
  cast(power: PowerId, origin: Vector3, aim: Vector3, caster: TransformNode | null): void {
    switch (power) {
      case 'ganesha':
        return this.ganesha(origin, caster);
      case 'hanuman':
        return this.hanuman(origin, aim);
      case 'shiva':
        return this.shiva(origin);
      case 'vishnu':
        return this.vishnu(origin, aim, caster);
    }
  }

  hit(power: PowerId | undefined, at: Vector3): void {
    const color = power ? CHANNELS[power].accent : '#ffffff';
    this.burst(at, color, 36, { size: 0.22, speed: 3.2, life: 0.55 });
  }

  banish(at: Vector3): void {
    this.burst(at, '#fff6d8', 140, { size: 0.3, speed: 5.5, life: 1.3, gravity: 2.5, spread: 1.2 });
    this.ring(at.add(new Vector3(0, -1, 0)), '#fff1b8', 0.9, 14, 0.8);
  }

  returned(at: Vector3): void {
    this.burst(at, '#b48cff', 90, { size: 0.35, speed: 1.6, life: 1.6, gravity: 0.6, spread: 1.5 });
    this.ring(at.add(new Vector3(0, -1, 0)), '#7a4cff', 0.8, 8, 0.6);
  }

  // ---- channels -------------------------------------------------------------------------------

  /** Golden protective shockwave: a ring races outward from the caster's feet and a shell lingers. */
  private ganesha(origin: Vector3, caster: TransformNode | null): void {
    const feet = origin.add(new Vector3(0, -EYE_TO_FEET + 0.1, 0));
    this.ring(feet, CHANNELS.ganesha.color, 0.9, 18, 0.95);
    this.burst(feet.add(new Vector3(0, 0.6, 0)), CHANNELS.ganesha.accent, 70, { size: 0.28, speed: 3, life: 1.1, gravity: 1.8, spread: 2.5 });
    if (!caster) return;
    const shell = MeshBuilder.CreateSphere('ganesha-shell', { diameter: 2.3, segments: 16 }, this.scene);
    const mat = this.glowMat('ganesha-shell-mat', CHANNELS.ganesha.color, 0.2);
    shell.material = mat;
    shell.parent = caster;
    shell.position.y = -0.6;
    this.timed(2.4, (t) => {
      mat.alpha = 0.2 * (1 - t) * (0.7 + 0.3 * Math.sin(t * 30));
    }, () => {
      mat.dispose();
      shell.dispose();
    });
  }

  /** Saffron wind strike: a gust rushes along the aim with streaking particles. */
  private hanuman(origin: Vector3, aim: Vector3): void {
    const start = origin.add(aim.scale(0.8)).add(new Vector3(0, -0.3, 0));
    const ps = this.system('hanuman-gust', 320);
    ps.emitter = start.clone();
    ps.createPointEmitter(aim.scale(2), aim.scale(7).add(new Vector3(0.6, 0.6, 0.6)));
    this.colorize(ps, CHANNELS.hanuman.color, CHANNELS.hanuman.accent);
    ps.minSize = 0.25;
    ps.maxSize = 0.6;
    ps.minLifeTime = 0.25;
    ps.maxLifeTime = 0.45;
    ps.emitRate = 420;
    ps.minEmitPower = 1;
    ps.maxEmitPower = 2;
    ps.start();
    const retireGust = () => this.retire(ps, ps.maxLifeTime + 0.3);

    const gust = new TransformNode('hanuman-gust-node', this.scene);
    gust.position.copyFrom(start);
    gust.lookAt(start.add(aim));
    const cone = MeshBuilder.CreateCylinder('hanuman-cone', { diameterTop: 0.3, diameterBottom: 2.4, height: 3.2, tessellation: 20 }, this.scene);
    cone.rotation.x = -Math.PI / 2;
    cone.position.z = 1.6;
    const mat = this.glowMat('hanuman-cone-mat', CHANNELS.hanuman.color, 0.28);
    cone.material = mat;
    cone.parent = gust;
    const speed = 26;
    this.timed(0.45, (t, dt) => {
      const step = aim.scale(speed * dt);
      (ps.emitter as Vector3).addInPlace(step);
      gust.position.addInPlace(step);
      cone.scaling.set(1 + t * 0.8, 1 + t * 0.8, 1 + t * 0.4);
      mat.alpha = 0.28 * (1 - t);
    }, () => {
      retireGust();
      mat.dispose();
      cone.dispose();
      gust.dispose();
    });
  }

  /** Icy slowing pulse: a translucent sphere swells from the caster and frost settles on the ground. */
  private shiva(origin: Vector3): void {
    const center = origin.add(new Vector3(0, -0.6, 0));
    const pulse = MeshBuilder.CreateSphere('shiva-pulse', { diameter: 1, segments: 20 }, this.scene);
    pulse.position.copyFrom(center);
    const mat = this.glowMat('shiva-pulse-mat', CHANNELS.shiva.color, 0.35);
    pulse.material = mat;
    this.timed(0.75, (t) => {
      pulse.scaling.setAll(1 + t * 13);
      mat.alpha = 0.35 * (1 - t);
    }, () => {
      mat.dispose();
      pulse.dispose();
    });
    const frost = MeshBuilder.CreateDisc('shiva-frost', { radius: 1, tessellation: 40 }, this.scene);
    frost.rotation.x = Math.PI / 2;
    frost.position.set(center.x, 0.04, center.z);
    const fmat = this.glowMat('shiva-frost-mat', CHANNELS.shiva.accent, 0.45);
    frost.material = fmat;
    this.timed(2.4, (t) => {
      frost.scaling.setAll(1 + Math.min(1, t * 4) * 5.5);
      fmat.alpha = 0.45 * (1 - t);
    }, () => {
      fmat.dispose();
      frost.dispose();
    });
    this.burst(center, CHANNELS.shiva.accent, 90, { size: 0.2, speed: 3.5, life: 1.3, gravity: -2.5, spread: 1.5 });
  }

  /** Blue-gold returning chakra: a spinning disc flies out along the aim and returns to the caster. */
  private vishnu(origin: Vector3, aim: Vector3, caster: TransformNode | null): void {
    const node = new TransformNode('vishnu-chakra', this.scene);
    node.position.copyFrom(origin).addInPlace(aim.scale(0.9)).addInPlace(new Vector3(0, -0.25, 0));
    const rim = MeshBuilder.CreateTorus('vishnu-rim', { diameter: 0.9, thickness: 0.08, tessellation: 40 }, this.scene);
    rim.material = this.glowMat('vishnu-rim-mat', CHANNELS.vishnu.accent, 1);
    rim.parent = node;
    const disc = MeshBuilder.CreateDisc('vishnu-disc', { radius: 0.4, tessellation: 24 }, this.scene);
    disc.rotation.x = Math.PI / 2;
    const dmat = this.glowMat('vishnu-disc-mat', CHANNELS.vishnu.color, 0.75);
    disc.material = dmat;
    disc.parent = node;
    const trail = this.system('vishnu-trail', 240);
    trail.emitter = node as unknown as Mesh;
    trail.createSphereEmitter(0.35);
    this.colorize(trail, CHANNELS.vishnu.color, CHANNELS.vishnu.accent);
    trail.minSize = 0.12;
    trail.maxSize = 0.28;
    trail.minLifeTime = 0.3;
    trail.maxLifeTime = 0.55;
    trail.emitRate = 160;
    trail.minEmitPower = 0.2;
    trail.maxEmitPower = 0.6;
    trail.start();

    const reach = 18;
    const out = origin.add(aim.scale(reach));
    const start = node.position.clone();
    this.timed(1.6, (t) => {
      node.rotation.y += 0.45;
      if (t < 0.5) {
        const u = easeOut(t / 0.5);
        Vector3.LerpToRef(start, out, u, node.position);
      } else {
        const home = (caster?.getAbsolutePosition() ?? origin).add(new Vector3(0, -0.25, 0));
        const u = easeIn((t - 0.5) / 0.5);
        Vector3.LerpToRef(out, home, u, node.position);
        dmat.alpha = 0.75 * (1 - Math.max(0, (u - 0.8) / 0.2));
      }
    }, () => {
      this.retire(trail, trail.maxLifeTime + 0.3);
      rim.material?.dispose();
      dmat.dispose();
      node.dispose();
    });
  }

  // ---- primitives -----------------------------------------------------------------------------

  private ring(at: Vector3, color: string, seconds: number, radius: number, alpha: number): void {
    const ring = MeshBuilder.CreateTorus('fx-ring', { diameter: 1, thickness: 0.16, tessellation: 48 }, this.scene);
    ring.position.copyFrom(at);
    const mat = this.glowMat('fx-ring-mat', color, alpha);
    ring.material = mat;
    this.timed(seconds, (t) => {
      const u = easeOut(t);
      ring.scaling.set(1 + u * radius * 2, 1, 1 + u * radius * 2);
      ring.position.y = at.y + u * 0.3;
      mat.alpha = alpha * (1 - t);
    }, () => {
      mat.dispose();
      ring.dispose();
    });
  }

  private burst(at: Vector3, color: string, count: number, o: BurstOptions): void {
    const { size = 0.25, speed = 4, life = 0.8, gravity = 0, spread = 1 } = o;
    const ps = this.system('fx-burst', count);
    ps.emitter = at.clone();
    ps.createSphereEmitter(0.25 * spread);
    this.colorize(ps, color, '#ffffff');
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
    window.setTimeout(() => ps.dispose(false), afterSeconds * 1000);
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

  /** Runs `tick(t, dt)` every frame for `seconds`, then `done()`. t is normalized 0..1. */
  private timed(seconds: number, tick: (t: number, dt: number) => void, done: () => void): void {
    let elapsed = 0;
    const obs = this.scene.onBeforeRenderObservable.add(() => {
      const dt = this.scene.getEngine().getDeltaTime() / 1000;
      elapsed += dt;
      const t = Math.min(1, elapsed / seconds);
      tick(t, dt);
      if (t >= 1) {
        this.scene.onBeforeRenderObservable.remove(obs);
        done();
      }
    });
  }
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const easeIn = (t: number) => t * t;
