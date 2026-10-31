import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Material } from '@babylonjs/core/Materials/material';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import type { GlowLayer } from '@babylonjs/core/Layers/glowLayer';
import type { EnemyState, GhostStrategy, PlayerState, RoomSnapshot } from '../../shared/protocol';
import { CHANNELS } from './powers';
import { flatMaterial } from './world';

/**
 * Haunts are 2D sprites on camera-facing vertical planes (billboard around world Y), cut from the
 * generated atlas. They are not rigged 3D characters. The authoritative transform lives on `root`
 * (server position); the plane is a child and only ever changes how the haunt is drawn.
 */
const ATLAS_URL = '/generated/ghosts/haunts-atlas.png';
const ALPHA_CUTOFF = 16 / 255; // drops the generator's alpha-1 dust, keeps spectral wisps for blending
interface SpriteDef { crop: [number, number, number, number]; height: number; maxWidth: number; base: number }
/** Tight crops from assets/generated/PROVENANCE.md: normalized image rect (left, top, right, bottom), top-left origin. */
const SPRITES: Record<string, SpriteDef> = {
  morrow: { crop: [0.121212, 0.070175, 0.416268, 0.475279], height: 1.95, maxWidth: 1.4, base: 0.25 },
  nix: { crop: [0.608453, 0.119617, 0.91866, 0.463317], height: 1.25, maxWidth: 1.4, base: 0.05 },
  vesper: { crop: [0.100478, 0.555024, 0.437799, 0.927432], height: 1.75, maxWidth: 1.6, base: 0.45 }, // wings may exceed 1.4
  raksha: { crop: [0.582935, 0.554226, 0.942584, 0.924242], height: 1.55, maxWidth: 1.4, base: 0.1 },
};
const LABEL_MIN_DISTANCE = 3;
const LABEL_MAX_DISTANCE = 28;
const SPRITE_EMISSIVE = new Color3(0.88, 0.88, 0.9);
const HIT_EMISSIVE = new Color3(1.15, 1.05, 0.95);

/** Minimum cosine between aim and the direction to a haunt for it to count as targeted. */
export const aimThreshold = (dist: number): number => (dist < 6 ? 0.93 : 0.985);

export const STRATEGY_COLOR: Record<GhostStrategy, string> = {
  chase: '#f0a58a',
  flank: '#f0c87a',
  keep_distance: '#9fd6e8',
  ambush: '#c7b2ee',
};

/** Compact, non-glowing nameplate: dark card, warm text. */
class Label {
  readonly plane: Mesh;
  private readonly tex: DynamicTexture;
  private last = '';

  constructor(scene: Scene, parent: TransformNode, y: number, width: number, glow: GlowLayer | null) {
    this.tex = new DynamicTexture('label', { width: 384, height: 96 }, scene, false);
    this.tex.hasAlpha = true;
    this.plane = MeshBuilder.CreatePlane('label', { width, height: width / 4 }, scene);
    this.plane.billboardMode = TransformNode.BILLBOARDMODE_ALL;
    this.plane.parent = parent;
    this.plane.position.y = y;
    this.plane.isPickable = false;
    const mat = new StandardMaterial('label-mat', scene);
    mat.diffuseTexture = this.tex;
    mat.emissiveColor = new Color3(0.8, 0.8, 0.8);
    mat.disableLighting = true;
    mat.useAlphaFromDiffuseTexture = true;
    mat.backFaceCulling = false;
    this.plane.material = mat;
    glow?.addExcludedMesh(this.plane);
  }

  draw(title: string, sub: string, subColor: string, hp: number | null): void {
    const key = `${title}|${sub}|${subColor}|${hp === null ? '' : Math.round(hp * 100)}`;
    if (key === this.last) return;
    this.last = key;
    const ctx = this.tex.getContext() as unknown as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 384, 96);
    ctx.fillStyle = 'rgba(8, 7, 12, 0.72)';
    ctx.fillRect(8, 8, 368, 80);
    ctx.strokeStyle = 'rgba(214, 178, 96, 0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(8, 8, 368, 80);
    ctx.textAlign = 'center';
    ctx.font = '600 30px Georgia, serif';
    ctx.fillStyle = '#f1e3c4';
    ctx.fillText(title, 192, 42);
    ctx.font = '20px system-ui, sans-serif';
    ctx.fillStyle = subColor;
    ctx.fillText(sub, 192, 68);
    if (hp !== null) {
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(40, 76, 304, 6);
      ctx.fillStyle = hp > 0.5 ? '#c9a45c' : hp > 0.25 ? '#d98c4a' : '#c45a4a';
      ctx.fillRect(40, 76, 304 * Math.max(0, Math.min(1, hp)), 6);
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
  marker: Mesh | null;
  sprite: Mesh | null;
  spriteMat: StandardMaterial | null;
  label: Label;
  target: Vector3;
  state: EnemyState;
  height: number;
  base: number;
  phase: number;
  hitTimer: number;
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
  /** Called once if the atlas cannot be loaded; markers stay visible, nothing is substituted. */
  onAssetIssue: ((text: string) => void) | null = null;
  private readonly enemies = new Map<string, EnemyView>();
  private readonly players = new Map<string, PlayerView>();
  private readonly playerMat = new Map<string, StandardMaterial>();
  private readonly bodyGlow: StandardMaterial;
  private readonly ring: Mesh;
  private targetId: string | null = null;
  private atlas: Texture | null = null;
  private atlasState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';

  constructor(private readonly scene: Scene, private readonly glow: GlowLayer | null = null) {
    this.bodyGlow = flatMaterial(scene, 'hunter-lantern-mat', Color3.Black(), new Color3(1, 0.75, 0.4));
    this.ring = MeshBuilder.CreateTorus('target-ring', { diameter: 1.5, thickness: 0.05, tessellation: 40 }, scene);
    const rm = flatMaterial(scene, 'target-ring-mat', Color3.Black(), new Color3(0.85, 0.68, 0.32), 0.75);
    rm.disableLighting = true;
    this.ring.material = rm;
    this.ring.isPickable = false;
    this.ring.setEnabled(false);
    glow?.addExcludedMesh(this.ring);
  }

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

  /** Ground ring under the currently targeted haunt (null hides it). */
  setTarget(id: string | null): void {
    this.targetId = id;
  }

  /** Brief, target-local hit feedback on the sprite only. */
  flashHit(id: string): void {
    const v = this.enemies.get(id);
    if (!v?.spriteMat) return;
    v.spriteMat.emissiveColor = HIT_EMISSIVE;
    window.clearTimeout(v.hitTimer);
    v.hitTimer = window.setTimeout(() => {
      if (v.spriteMat) v.spriteMat.emissiveColor = SPRITE_EMISSIVE;
    }, 130);
  }

  applySnapshot(snap: RoomSnapshot, selfId: string | null): void {
    const seenEnemies = new Set<string>();
    for (const e of snap.enemies) {
      seenEnemies.add(e.id);
      const view = this.enemies.get(e.id) ?? this.createEnemy(e);
      view.state = e;
      view.target.set(e.position[0], e.position[1], e.position[2]);
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
      view.label.draw(p.name, CHANNELS[p.power]?.deity ?? '', '#d9cfb4', p.hp / 100);
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
    let ringPlaced = false;
    for (const v of this.enemies.values()) {
      Vector3.LerpToRef(v.root.position, v.target, k, v.root.position);
      if (eye) {
        const d = Vector3.Distance(eye, v.root.position);
        v.label.plane.setEnabled(d > LABEL_MIN_DISTANCE && d < LABEL_MAX_DISTANCE);
      }
      v.phase += dt;
      // Sprites sit on the ground plane (plus a per-haunt float), independent of the server's centre y.
      const hover = Math.sin(v.phase * 0.9) * 0.05;
      v.visual.position.y = -v.root.position.y + v.base + hover;
      if (v.state.id === this.targetId && v.state.state !== 'banished') {
        this.ring.position.set(v.root.position.x, 0.06, v.root.position.z);
        this.ring.setEnabled(true);
        ringPlaced = true;
      }
    }
    if (!ringPlaced) this.ring.setEnabled(false);
    for (const v of this.players.values()) {
      Vector3.LerpToRef(v.root.position, v.target, k, v.root.position);
      v.root.rotation.y = lerpAngle(v.root.rotation.y, v.targetYaw, k);
    }
  }

  private ensureAtlas(): void {
    if (this.atlasState !== 'idle') return;
    this.atlasState = 'loading';
    this.atlas = new Texture(
      ATLAS_URL,
      this.scene,
      false,
      true,
      Texture.TRILINEAR_SAMPLINGMODE,
      () => {
        this.atlasState = 'ready';
        for (const v of this.enemies.values()) this.buildSprite(v);
      },
      (message) => {
        this.atlasState = 'failed';
        console.warn('[entities] haunt atlas failed', message);
        this.onAssetIssue?.('Haunt artwork failed to load; haunts are shown as plain markers.');
      },
    );
  }

  private createEnemy(e: EnemyState): EnemyView {
    this.ensureAtlas();
    const root = new TransformNode(`enemy-${e.id}`, this.scene);
    root.position.set(e.position[0], e.position[1], e.position[2]);
    const visual = new TransformNode(`enemy-${e.id}-visual`, this.scene);
    visual.parent = root;
    const def = SPRITES[e.id];
    // Plain spectral marker until the atlas is ready (or if it never is). Not a stand-in character.
    const marker = MeshBuilder.CreateSphere(`enemy-${e.id}-marker`, { diameter: 0.5, segments: 10 }, this.scene);
    marker.position.y = 1.1;
    marker.material = flatMaterial(this.scene, `enemy-${e.id}-marker-mat`, new Color3(0.2, 0.35, 0.4), new Color3(0.25, 0.5, 0.5), 0.45);
    marker.parent = visual;
    marker.isPickable = false;
    this.glow?.addExcludedMesh(marker);
    const label = new Label(this.scene, visual, 1.75, 1.3, this.glow);
    const view: EnemyView = { root, visual, marker, sprite: null, spriteMat: null, label, target: root.position.clone(), state: e, height: 1.5, base: def?.base ?? 0.1, phase: Math.random() * 6, hitTimer: 0 };
    this.enemies.set(e.id, view);
    if (this.atlasState === 'ready') this.buildSprite(view);
    return view;
  }

  private buildSprite(view: EnemyView): void {
    const def = SPRITES[view.state.id];
    if (!def || view.sprite || !this.atlas || view.root.isDisposed()) return;
    const [l, t, r, b] = def.crop;
    const aspect = (r - l) / (b - t); // the atlas is square, so normalized ratio equals pixel ratio
    let height = def.height;
    let width = height * aspect;
    if (width > def.maxWidth) {
      width = def.maxWidth;
      height = width / aspect;
    }
    // Same URL resolves to the one cached atlas; only the UV window differs per haunt.
    const tex = new Texture(ATLAS_URL, this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
    tex.hasAlpha = true;
    tex.uOffset = l;
    tex.uScale = r - l;
    tex.vOffset = 1 - b; // Babylon uploads with invertY, so v runs bottom-up
    tex.vScale = b - t;
    const mat = new StandardMaterial(`enemy-${view.state.id}-sprite-mat`, this.scene);
    mat.diffuseTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.transparencyMode = Material.MATERIAL_ALPHATESTANDBLEND;
    mat.alphaCutOff = ALPHA_CUTOFF;
    mat.disableLighting = true; // the artwork carries its own restrained spectral light
    mat.emissiveColor = SPRITE_EMISSIVE;
    mat.specularColor = Color3.Black();
    mat.backFaceCulling = false;
    const plane = MeshBuilder.CreatePlane(`enemy-${view.state.id}-sprite`, { width, height }, this.scene);
    plane.billboardMode = TransformNode.BILLBOARDMODE_Y;
    plane.parent = view.visual;
    plane.position.y = height / 2;
    plane.isPickable = false;
    plane.material = mat;
    this.glow?.addExcludedMesh(plane);
    view.sprite = plane;
    view.spriteMat = mat;
    view.height = height;
    view.label.plane.position.y = height + 0.35;
    view.marker?.dispose();
    view.marker = null;
    this.styleEnemy(view);
  }

  private styleEnemy(view: EnemyView): void {
    const e = view.state;
    view.root.setEnabled(e.state !== 'banished');
    if (view.spriteMat) view.spriteMat.alpha = e.state === 'returning' ? 0.4 : 1;
    const grudge = e.memory.banishments ? ` · grudge ${e.memory.banishments}` : '';
    const mood = e.aggro ? 'hunting you' : e.strategy.replace('_', ' ');
    view.label.draw(`${e.name} · Lv ${e.level}`, `${mood}${grudge}`, e.aggro ? '#f0a58a' : STRATEGY_COLOR[e.strategy] ?? '#ccc', e.maxHp ? e.hp / e.maxHp : null);
  }

  /** Removes every server-owned view (return to title). */
  clear(): void {
    for (const [id, v] of this.enemies) this.disposeEnemy(id, v);
    for (const [id, v] of this.players) {
      v.label.dispose();
      v.root.dispose();
      this.players.delete(id);
    }
    this.targetId = null;
    this.ring.setEnabled(false);
  }

  private disposeEnemy(id: string, v: EnemyView): void {
    window.clearTimeout(v.hitTimer);
    v.label.dispose();
    v.spriteMat?.diffuseTexture?.dispose();
    v.spriteMat?.dispose();
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
    const label = new Label(this.scene, root, 0.75, 1.3, this.glow);
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
