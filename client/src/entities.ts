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
import { flatMaterial, softParticleTexture } from './world';

/**
 * Haunts are 2D sprites on camera-facing vertical planes (billboard around world Y), cut from the
 * generated atlas. They are not rigged 3D characters. The authoritative transform lives on `root`
 * (server position); the plane is a child and only ever changes how the haunt is drawn.
 */
const HAUNTS_ATLAS = '/generated/ghosts/haunts-atlas.png';
const MONSTERS_ATLAS = '/generated/ghosts/monsters-atlas.png'; // three equal transparent columns: goblin, orc, beast
const BOSS_PORTRAIT = '/generated/ghosts/raksha-boss.png'; // 1024x1536 RGBA full-figure portrait, only for the canonical boss
/** Internal sprite key for the canonical boss; `spriteKeyFor` keeps reporting the public family `raksha`. */
const BOSS_KEY = 'raksha-boss';
const ALPHA_CUTOFF = 16 / 255; // drops the generator's alpha-1 dust, keeps spectral wisps for blending
/**
 * `spectral` haunts drift (teal wisp trails in the atlas, no feet) and read slightly translucent; grounded
 * monsters stand on their feet with no hover. `shadow` is the foot-contact disc width relative to the plane.
 */
interface SpriteDef { atlas: string; crop: [number, number, number, number]; height: number; maxWidth: number; base: number; spectral: boolean; shadow: number }
/** Normalized image rects (left, top, right, bottom), top-left origin. Haunt crops from assets/generated/PROVENANCE.md. */
const SPRITES: Record<string, SpriteDef> = {
  // Reaper in tattered charcoal cloth with a brass lantern: tall and thin.
  morrow: { atlas: HAUNTS_ATLAS, crop: [0.121212, 0.070175, 0.416268, 0.475279], height: 1.95, maxWidth: 1.4, base: 0.25, spectral: true, shadow: 0.55 },
  // Ghoul hiding in a treasure chest: squat, crouched, hugs the ground.
  nix: { atlas: HAUNTS_ATLAS, crop: [0.608453, 0.119617, 0.91866, 0.463317], height: 1.1, maxWidth: 1.3, base: 0.03, spectral: true, shadow: 0.8 },
  // Moth spirit: wide bone-ribbed wings, long trailing veils; hovers highest.
  vesper: { atlas: HAUNTS_ATLAS, crop: [0.100478, 0.555024, 0.437799, 0.927432], height: 1.9, maxWidth: 1.9, base: 0.5, spectral: true, shadow: 0.45 },
  // Raksha is the boss: armoured in bone plate and bells, broad-shouldered, towers over the others.
  raksha: { atlas: HAUNTS_ATLAS, crop: [0.582935, 0.554226, 0.942584, 0.924242], height: 2.2, maxWidth: 2.0, base: 0.12, spectral: true, shadow: 0.7 },
  // Goblin: small, hunched under its pack, lantern-staff taller than itself.
  goblin: { atlas: MONSTERS_ATLAS, crop: [0, 0, 1 / 3, 1], height: 1.2, maxWidth: 1.25, base: 0, spectral: false, shadow: 0.6 },
  // Orc: solid, planted stance with tower shield; the biggest grounded body.
  orc: { atlas: MONSTERS_ATLAS, crop: [1 / 3, 0, 2 / 3, 1], height: 2.0, maxWidth: 1.7, base: 0, spectral: false, shadow: 0.75 },
  // Beast: antlered quadruped, wide and low.
  beast: { atlas: MONSTERS_ATLAS, crop: [2 / 3, 0, 1, 1], height: 1.6, maxWidth: 1.7, base: 0.02, spectral: false, shadow: 0.85 },
  // The one true Raksha: horned, bone-armoured demon standing on clawed feet, ~2.7 m. Generic rakshasa
  // clones keep the atlas family above; if this portrait fails to load the boss falls back to it too.
  [BOSS_KEY]: { atlas: BOSS_PORTRAIT, crop: [0, 0, 1, 1], height: 2.7, maxWidth: 2.2, base: 0, spectral: false, shadow: 0.55 },
};
/** Every enemy draws from an approved atlas: valid baseId first, canonical id, then id-prefix/species alias. */
const SPRITE_ALIAS: Record<string, string> = { morrow: 'morrow', nix: 'nix', vesper: 'vesper', raksha: 'raksha', ghost: 'morrow', ghoul: 'nix', goblin: 'goblin', orc: 'orc', rakshasa: 'raksha', beast: 'beast' };
export function spriteKeyFor(e: EnemyState): string {
  const base = (e as { baseId?: string }).baseId;
  if (base && SPRITES[base]) return base;
  if (SPRITES[e.id]) return e.id;
  return SPRITE_ALIAS[e.id.split('-')[0]] ?? SPRITE_ALIAS[e.species] ?? 'morrow';
}
const LABEL_MIN_DISTANCE = 3;
const LABEL_MAX_DISTANCE = 28;
const SHADOW_MAX_DISTANCE = 32;
// Artwork is shown slightly under full white with a candle-warm bias so it sits in the crimson/gold scene
// instead of popping like a lit cut-out; the atlas teal still reads because the shift is small.
const SPRITE_EMISSIVE = new Color3(0.82, 0.78, 0.74);
// Hit feedback: a quiet ember tint on the struck sprite only, never a white flare.
const HIT_EMISSIVE = new Color3(1.0, 0.68, 0.46);
const SPECTRAL_ALPHA = 0.94;
const RETURNING_ALPHA = 0.42;

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
    ctx.fillStyle = 'rgba(10, 7, 9, 0.74)';
    ctx.fillRect(8, 8, 368, 80);
    ctx.strokeStyle = 'rgba(168, 132, 72, 0.5)'; // worn brass edge

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
  /** Foot-contact disc on the ground under the root; shares one cached material, faded via visibility. */
  shadow: Mesh | null;
  label: Label;
  target: Vector3;
  state: EnemyState;
  key: string;
  height: number;
  base: number;
  phase: number;
  hitTimer: number;
  /** Current and goal opacity for the soft banish/return fade (1 hunting, dim returning, 0 banished). */
  alpha: number;
  alphaGoal: number;
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
  private readonly shadowMat: StandardMaterial;
  private targetId: string | null = null;
  private readonly atlases = new Map<string, { tex: Texture; state: 'loading' | 'ready' | 'failed' }>();

  constructor(private readonly scene: Scene, private readonly glow: GlowLayer | null = null) {
    this.bodyGlow = flatMaterial(scene, 'hunter-lantern-mat', Color3.Black(), new Color3(1, 0.75, 0.4));
    // One soft black disc material for every enemy's foot shadow (texture built once, never per enemy).
    this.shadowMat = flatMaterial(scene, 'enemy-shadow-mat', Color3.Black(), Color3.Black(), 0.5);
    this.shadowMat.diffuseTexture = softParticleTexture(scene);
    this.shadowMat.useAlphaFromDiffuseTexture = true;
    this.shadowMat.disableLighting = true;
    this.shadowMat.disableDepthWrite = true;
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
    const kFade = 1 - Math.exp(-dt * 6);
    for (const v of this.enemies.values()) {
      Vector3.LerpToRef(v.root.position, v.target, k, v.root.position);
      // Soft fade between hunting / returning / banished; the root is only switched off once invisible.
      if (Math.abs(v.alphaGoal - v.alpha) > 0.004) {
        v.alpha += (v.alphaGoal - v.alpha) * kFade;
        if (v.spriteMat) v.spriteMat.alpha = v.alpha;
        if (v.shadow) v.shadow.visibility = v.alpha;
      } else if (v.alphaGoal === 0 && v.root.isEnabled()) {
        v.root.setEnabled(false);
      }
      if (eye) {
        const d = Vector3.Distance(eye, v.root.position);
        v.label.plane.setEnabled(v.alphaGoal > 0 && d > LABEL_MIN_DISTANCE && d < LABEL_MAX_DISTANCE);
        v.shadow?.setEnabled(d < SHADOW_MAX_DISTANCE);
      }
      v.phase += dt;
      // Sprites sit on the ground plane, independent of the server's centre y. Only spectral haunts drift.
      const hover = SPRITES[v.key]?.spectral === false ? 0 : Math.sin(v.phase * 0.9) * 0.05;
      v.visual.position.y = -v.root.position.y + v.base + hover;
      if (v.shadow) v.shadow.position.y = -v.root.position.y + 0.03;
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

  private ensureAtlas(url: string): void {
    if (this.atlases.has(url)) return;
    const entry = { tex: null as unknown as Texture, state: 'loading' as 'loading' | 'ready' | 'failed' };
    this.atlases.set(url, entry);
    entry.tex = new Texture(
      url,
      this.scene,
      false,
      true,
      Texture.TRILINEAR_SAMPLINGMODE,
      () => {
        entry.state = 'ready';
        for (const v of this.enemies.values()) if (SPRITES[v.key]?.atlas === url) this.buildSprite(v);
      },
      (message) => {
        entry.state = 'failed';
        console.warn('[entities] atlas failed', url, message);
        if (url === BOSS_PORTRAIT) {
          // Boss portrait missing: drop the canonical boss back onto its atlas family, never a bare marker.
          for (const v of this.enemies.values()) if (v.key === BOSS_KEY) this.useLegacyBoss(v);
          return;
        }
        this.onAssetIssue?.('Some enemy artwork failed to load; those enemies are shown as plain markers.');
      },
    );
  }

  private useLegacyBoss(view: EnemyView): void {
    const def = SPRITES.raksha;
    view.key = 'raksha';
    view.base = def.base;
    this.ensureAtlas(def.atlas);
    if (this.atlases.get(def.atlas)?.state === 'ready') this.buildSprite(view);
  }

  private createEnemy(e: EnemyState): EnemyView {
    const root = new TransformNode(`enemy-${e.id}`, this.scene);
    root.position.set(e.position[0], e.position[1], e.position[2]);
    const visual = new TransformNode(`enemy-${e.id}-visual`, this.scene);
    visual.parent = root;
    // Only the canonical boss id gets the portrait; its atlas is shared by every boss build (one load).
    const bossPortrait = e.id === 'raksha' && this.atlases.get(BOSS_PORTRAIT)?.state !== 'failed';
    const key = bossPortrait ? BOSS_KEY : spriteKeyFor(e);
    const def = SPRITES[key];
    // Plain spectral marker until the atlas is ready (or if it never is). Not a stand-in character.
    const marker = MeshBuilder.CreateSphere(`enemy-${e.id}-marker`, { diameter: 0.5, segments: 10 }, this.scene);
    marker.position.y = 1.1;
    marker.material = flatMaterial(this.scene, `enemy-${e.id}-marker-mat`, new Color3(0.2, 0.35, 0.4), new Color3(0.25, 0.5, 0.5), 0.45);
    marker.parent = visual;
    marker.isPickable = false;
    this.glow?.addExcludedMesh(marker);
    const label = new Label(this.scene, visual, 1.75, 1.3, this.glow);
    const view: EnemyView = { root, visual, marker, sprite: null, spriteMat: null, shadow: null, label, target: root.position.clone(), state: e, key, height: 1.5, base: def?.base ?? 0.1, phase: Math.random() * 6, hitTimer: 0, alpha: 1, alphaGoal: 1 };
    this.enemies.set(e.id, view);
    if (def) {
      this.ensureAtlas(def.atlas);
      if (this.atlases.get(def.atlas)?.state === 'ready') this.buildSprite(view);
    }
    return view;
  }

  private buildSprite(view: EnemyView): void {
    const def = SPRITES[view.key];
    const entry = def ? this.atlases.get(def.atlas) : undefined;
    if (!def || !entry || entry.state !== 'ready' || view.sprite || view.root.isDisposed()) return;
    const [l, t, r, b] = def.crop;
    // Plane aspect from the loaded image's real pixel size times the crop; never assume a square atlas.
    const size = entry.tex.getBaseSize();
    const aspect = size.width > 0 && size.height > 0 ? (size.width * (r - l)) / (size.height * (b - t)) : (r - l) / (b - t);
    let height = def.height;
    let width = height * aspect;
    if (width > def.maxWidth) {
      width = def.maxWidth;
      height = width / aspect;
    }
    // Same URL resolves to the one cached atlas; only the UV window differs per enemy.
    const tex = new Texture(def.atlas, this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
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
    // Flat foot-contact disc so the billboard reads as standing on (or drifting just above) the ground.
    const shadow = MeshBuilder.CreateDisc(`enemy-${view.state.id}-shadow`, { radius: 0.5, tessellation: 20 }, this.scene);
    shadow.rotation.x = Math.PI / 2;
    shadow.scaling.set(width * def.shadow, width * def.shadow * 0.6, 1);
    shadow.parent = view.root;
    shadow.isPickable = false;
    shadow.material = this.shadowMat;
    shadow.visibility = def.spectral ? 0.7 : 1;
    this.glow?.addExcludedMesh(shadow);
    view.sprite = plane;
    view.spriteMat = mat;
    view.shadow = shadow;
    view.height = height;
    view.label.plane.position.y = height + 0.35;
    view.marker?.dispose();
    view.marker = null;
    // Start at the goal opacity so a freshly built sprite does not fade in from nowhere mid-fight.
    view.alpha = view.alphaGoal;
    mat.alpha = view.alpha;
    shadow.visibility = view.alpha;
    this.styleEnemy(view);
  }

  private styleEnemy(view: EnemyView): void {
    const e = view.state;
    const full = SPRITES[view.key]?.spectral ? SPECTRAL_ALPHA : 1;
    view.alphaGoal = e.state === 'banished' ? 0 : e.state === 'returning' ? RETURNING_ALPHA : full;
    // Visible states re-enable immediately; the banished fade-out switches the root off from update().
    // Without a sprite there is nothing to fade, so the marker toggles instantly as before.
    if (view.alphaGoal > 0) view.root.setEnabled(true);
    else if (!view.sprite) view.root.setEnabled(false);
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
    v.root.dispose(); // disposes the shadow disc with it; its material is shared and kept
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
