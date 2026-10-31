import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
import type { Material } from '@babylonjs/core/Materials/material';
import type { EnemyState, GhostStrategy, PlayerState, RoomSnapshot, Species } from '../../shared/protocol';
import { CHANNELS } from './powers';
import { flatMaterial, hierarchySize, loadKit, placeKit } from './world';

const MODEL_FOR_SPECIES: Record<Species, string> = {
  ghost: 'character-ghost.glb',
  ghoul: 'character-zombie.glb',
  goblin: 'character-skeleton.glb',
  orc: 'character-keeper.glb',
  beast: 'character-skeleton.glb',
  rakshasa: 'character-vampire.glb',
};
const TINT_FOR_SPECIES: Record<Species, string> = {
  ghost: '#8fd0ff',
  ghoul: '#7fe08a',
  goblin: '#b7e05a',
  orc: '#d4a05a',
  beast: '#e0c070',
  rakshasa: '#ff5a6a',
};
const HOVERING: ReadonlySet<Species> = new Set(['ghost']);
const LABEL_MIN_DISTANCE = 3;
/** Minimum cosine between aim and the direction to a haunt for it to count as targeted. */
export const aimThreshold = (dist: number): number => (dist < 6 ? 0.93 : 0.985);

export const STRATEGY_COLOR: Record<GhostStrategy, string> = {
  chase: '#ff8a7a',
  flank: '#ffc66b',
  keep_distance: '#7fd7ff',
  ambush: '#c89bff',
};

class Label {
  readonly plane: Mesh;
  private readonly tex: DynamicTexture;
  private last = '';

  constructor(scene: Scene, parent: TransformNode, y: number, width = 2.6) {
    this.tex = new DynamicTexture('label', { width: 512, height: 160 }, scene, false);
    this.tex.hasAlpha = true;
    this.plane = MeshBuilder.CreatePlane('label', { width, height: width * (160 / 512) }, scene);
    this.plane.billboardMode = TransformNode.BILLBOARDMODE_ALL;
    this.plane.parent = parent;
    this.plane.position.y = y;
    this.plane.isPickable = false;
    const mat = new StandardMaterial('label-mat', scene);
    mat.diffuseTexture = this.tex;
    mat.emissiveColor = Color3.White();
    mat.disableLighting = true;
    mat.useAlphaFromDiffuseTexture = true;
    mat.backFaceCulling = false;
    this.plane.material = mat;
  }

  draw(title: string, sub: string, subColor: string, hp: number | null): void {
    const key = `${title}|${sub}|${subColor}|${hp === null ? '' : Math.round(hp * 100)}`;
    if (key === this.last) return;
    this.last = key;
    const ctx = this.tex.getContext() as unknown as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 512, 160);
    ctx.fillStyle = 'rgba(4, 8, 18, 0.55)';
    ctx.fillRect(16, 10, 480, 140);
    ctx.font = '600 44px Georgia, serif';
    ctx.fillStyle = '#f1f4fb';
    ctx.textAlign = 'center';
    ctx.fillText(title, 256, 62);
    ctx.font = '28px system-ui, sans-serif';
    ctx.fillStyle = subColor;
    ctx.fillText(sub, 256, 100);
    if (hp !== null) {
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(56, 118, 400, 14);
      ctx.fillStyle = hp > 0.5 ? '#9ee0ff' : hp > 0.25 ? '#ffc66b' : '#ff6b6b';
      ctx.fillRect(56, 118, 400 * Math.max(0, Math.min(1, hp)), 14);
    }
    this.tex.update();
  }

  dispose(): void {
    this.plane.material?.dispose();
    this.tex.dispose();
    this.plane.dispose();
  }
}

interface EnemyView {
  root: TransformNode;
  visual: TransformNode;
  fallback: Mesh | null;
  model: TransformNode | null;
  mats: Material[];
  label: Label;
  target: Vector3;
  targetYaw: number;
  state: EnemyState;
  height: number;
  phase: number;
}

interface PlayerView {
  root: TransformNode;
  body: Mesh;
  label: Label;
  target: Vector3;
  targetYaw: number;
  state: PlayerState;
}

/** Renders and interpolates everything the server owns: other hunters and the haunts. */
export class EntityLayer {
  private readonly enemies = new Map<string, EnemyView>();
  private readonly players = new Map<string, PlayerView>();
  private readonly kits = new Map<string, Promise<AssetContainer | null>>();
  private readonly playerMat = new Map<string, StandardMaterial>();
  private readonly bodyGlow: StandardMaterial;

  constructor(private readonly scene: Scene) {
    this.bodyGlow = flatMaterial(scene, 'hunter-lantern-mat', Color3.Black(), new Color3(1, 0.75, 0.4));
  }

  /** Latest known state for every enemy (used for targeting and event positions). */
  get enemyStates(): EnemyState[] {
    return [...this.enemies.values()].map((v) => v.state);
  }

  positionOf(id: string): Vector3 | null {
    return this.enemies.get(id)?.root.position ?? this.players.get(id)?.root.position ?? null;
  }

  nodeOf(id: string): TransformNode | null {
    return this.enemies.get(id)?.root ?? this.players.get(id)?.root ?? null;
  }

  enemyState(id: string): EnemyState | undefined {
    return this.enemies.get(id)?.state;
  }

  /** Picks the haunt nearest the aim ray inside a narrow cone; this only drives the HUD/prediction. */
  pickTarget(origin: Vector3, aim: Vector3): EnemyState | null {
    let best: EnemyState | null = null;
    let bestScore = -Infinity;
    for (const v of this.enemies.values()) {
      if (v.state.state === 'banished') continue;
      const to = v.root.position.subtract(origin);
      const dist = to.length();
      if (dist < 0.5 || dist > 45) continue;
      const cos = Vector3.Dot(to.scale(1 / dist), aim);
      if (cos < aimThreshold(dist)) continue;
      const score = cos - dist * 0.002;
      if (score > bestScore) {
        bestScore = score;
        best = v.state;
      }
    }
    return best;
  }

  applySnapshot(snap: RoomSnapshot, selfId: string | null): void {
    const seenEnemies = new Set<string>();
    for (const e of snap.enemies) {
      seenEnemies.add(e.id);
      const view = this.enemies.get(e.id) ?? this.createEnemy(e);
      view.state = e;
      view.target.set(e.position[0], e.position[1], e.position[2]);
      view.targetYaw = e.yaw;
      this.styleEnemy(view);
    }
    for (const [id, v] of this.enemies) if (!seenEnemies.has(id)) this.disposeEnemy(id, v);

    const seenPlayers = new Set<string>();
    for (const p of snap.players) {
      if (p.id === selfId) continue;
      seenPlayers.add(p.id);
      const view = this.players.get(p.id) ?? this.createPlayer(p);
      view.state = p;
      view.target.set(p.position[0], p.position[1], p.position[2]);
      view.targetYaw = p.yaw;
      view.body.material = this.materialForPower(p.power);
      view.label.draw(p.name, CHANNELS[p.power]?.deity ?? '', CHANNELS[p.power]?.color ?? '#fff', p.hp / 100);
      view.root.setEnabled(p.hp > 0);
    }
    for (const [id, v] of this.players) {
      if (!seenPlayers.has(id)) {
        v.label.dispose();
        v.root.dispose();
        this.players.delete(id);
      }
    }
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-dt * 10);
    const eye = this.scene.activeCamera?.globalPosition ?? null;
    for (const v of this.enemies.values()) {
      Vector3.LerpToRef(v.root.position, v.target, k, v.root.position);
      v.root.rotation.y = lerpAngle(v.root.rotation.y, v.targetYaw, k);
      // Nameplates are unreadable at melee range and would otherwise fill the view; the HUD target line covers it.
      if (eye) v.label.plane.setEnabled(Vector3.Distance(eye, v.root.position) > LABEL_MIN_DISTANCE);
      v.phase += dt;
      const hover = HOVERING.has(v.state.species) ? 0.35 + Math.sin(v.phase * 1.7) * 0.15 : 0;
      v.visual.position.y = -v.root.position.y + hover;
      if (v.state.state === 'returning') {
        const a = 0.25 + 0.2 * Math.sin(v.phase * 6);
        for (const m of v.mats) m.alpha = a;
      }
    }
    for (const v of this.players.values()) {
      Vector3.LerpToRef(v.root.position, v.target, k, v.root.position);
      v.root.rotation.y = lerpAngle(v.root.rotation.y, v.targetYaw, k);
    }
  }

  private createEnemy(e: EnemyState): EnemyView {
    const root = new TransformNode(`enemy-${e.id}`, this.scene);
    root.position.set(e.position[0], e.position[1], e.position[2]);
    const visual = new TransformNode(`enemy-${e.id}-visual`, this.scene);
    visual.parent = root;
    const height = 1.5 + e.level * 0.08;
    const tint = Color3.FromHexString(TINT_FOR_SPECIES[e.species] ?? '#ffffff');
    const fallback = MeshBuilder.CreateCapsule(`enemy-${e.id}-fallback`, { height, radius: 0.38, tessellation: 12 }, this.scene);
    fallback.position.y = height / 2;
    fallback.material = flatMaterial(this.scene, `enemy-${e.id}-fallback-mat`, tint.scale(0.3), tint.scale(0.6), 0.7);
    fallback.parent = visual;
    const label = new Label(this.scene, root, height - e.position[1] + 0.9, 2.2);
    const view: EnemyView = { root, visual, fallback, model: null, mats: [fallback.material], label, target: root.position.clone(), targetYaw: e.yaw, state: e, height, phase: Math.random() * 6 };
    this.enemies.set(e.id, view);
    void this.attachModel(view, e.species, tint);
    return view;
  }

  private async attachModel(view: EnemyView, species: Species, tint: Color3): Promise<void> {
    const file = MODEL_FOR_SPECIES[species];
    if (!this.kits.has(file)) this.kits.set(file, loadKit(this.scene, file));
    const kit = await this.kits.get(file);
    if (!kit || view.root.isDisposed()) return;
    const holder = placeKit(kit, `enemy-${view.state.id}-model`, Vector3.Zero(), 0, 1, true);
    const { min, size } = hierarchySize(holder);
    const s = view.height / Math.max(size.y, 0.01);
    holder.scaling.setAll(s);
    holder.position.y = -min.y * s;
    holder.parent = view.visual;
    const mats: Material[] = [];
    for (const m of holder.getChildMeshes()) {
      m.isPickable = false;
      const mat = m.material;
      if (!mat) continue;
      if (mat instanceof PBRMaterial) {
        mat.emissiveColor = tint.scale(0.35);
        mat.unlit = false;
      } else if (mat instanceof StandardMaterial) {
        mat.emissiveColor = tint.scale(0.35);
      }
      mats.push(mat);
    }
    // Kenney characters ship an 'idle' clip; the entries' animation groups are already retargeted.
    for (const g of this.scene.animationGroups) {
      if (g.name.startsWith(`enemy-${view.state.id}-model:`) && g.name.endsWith('idle')) g.start(true, 1);
    }
    view.fallback?.dispose();
    view.fallback = null;
    view.model = holder;
    view.mats = mats;
    this.styleEnemy(view);
  }

  private styleEnemy(view: EnemyView): void {
    const e = view.state;
    const visible = e.state !== 'banished';
    view.root.setEnabled(visible);
    const baseAlpha = HOVERING.has(e.species) ? 0.82 : 1;
    if (e.state === 'hunting') for (const m of view.mats) m.alpha = view.model ? baseAlpha : 0.7;
    const grudge = e.memory.banishments ? ` · grudge ${e.memory.banishments}` : '';
    view.label.draw(`${e.name}  ·  Lv ${e.level}`, `${e.species} · ${e.strategy.replace('_', ' ')}${grudge}`, STRATEGY_COLOR[e.strategy] ?? '#ccc', e.maxHp ? e.hp / e.maxHp : null);
  }

  /** Removes every server-owned view (return to title). In-flight model loads notice the disposed root. */
  clear(): void {
    for (const [id, v] of this.enemies) this.disposeEnemy(id, v);
    for (const [id, v] of this.players) {
      v.label.dispose();
      v.root.dispose();
      this.players.delete(id);
    }
  }

  private disposeEnemy(id: string, v: EnemyView): void {
    v.label.dispose();
    v.root.dispose();
    this.enemies.delete(id);
  }

  private createPlayer(p: PlayerState): PlayerView {
    const root = new TransformNode(`player-${p.id}`, this.scene);
    root.position.set(p.position[0], p.position[1], p.position[2]);
    const body = MeshBuilder.CreateCapsule(`player-${p.id}-body`, { height: 1.7, radius: 0.33, tessellation: 12 }, this.scene);
    body.position.y = -0.85; // server position is eye height
    body.parent = root;
    body.isPickable = false;
    const lantern = MeshBuilder.CreateSphere(`player-${p.id}-lantern`, { diameter: 0.22, segments: 6 }, this.scene);
    lantern.position.set(0.35, -0.5, 0.3);
    lantern.material = this.bodyGlow;
    lantern.parent = root;
    const label = new Label(this.scene, root, 0.75, 2.2);
    const view: PlayerView = { root, body, label, target: root.position.clone(), targetYaw: p.yaw, state: p };
    this.players.set(p.id, view);
    return view;
  }

  private materialForPower(power: PlayerState['power']): StandardMaterial {
    const ch = CHANNELS[power] ?? CHANNELS.ganesha;
    let mat = this.playerMat.get(ch.id);
    if (!mat) {
      const c = Color3.FromHexString(ch.color);
      mat = flatMaterial(this.scene, `hunter-${ch.id}`, c.scale(0.25).add(new Color3(0.08, 0.08, 0.1)), c.scale(0.12));
      this.playerMat.set(ch.id, mat);
    }
    return mat;
  }
}

function lerpAngle(a: number, b: number, k: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}
