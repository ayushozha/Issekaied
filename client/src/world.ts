import { Scene } from '@babylonjs/core/scene';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import { ImportMeshAsync, LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Species, Vec3 } from '../../shared/protocol';
import worldJson from '../../shared/world.json';

export interface Obstacle { id: string; x: number; z: number; width: number; depth: number; height: number }
export interface EnemySpawn { id: string; name: string; species: Species; level: number; position: Vec3 }
export interface Landmark { id: string; position: Vec3; radius: number }
export interface Zone { id: string; name: string; position: Vec3 }
export interface AdventureDef {
  safeSpawnRadius: number;
  aggroRadius: number;
  leashRadius: number;
  shrine: Landmark;
  portal: Landmark;
  sigilEnemyIds: string[];
  bossId: string;
  zones: Zone[];
}
export interface WorldDef {
  version: number;
  name: string;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  spawn: Vec3;
  playerRadius: number;
  walkSpeed: number;
  sprintSpeed: number;
  obstacles: Obstacle[];
  enemySpawns: EnemySpawn[];
  adventure: AdventureDef;
}

/** Shared world definition (coordinator-owned). The server collides against the same boxes. */
export const WORLD = worldJson as unknown as WorldDef;

export const KENNEY = '/environment-kits/kenney-graveyard/Models/GLB%20format/';
const HAUNTED_HOUSE = '/environments/babylon/haunted_house.glb';

/** Push a circle of `radius` out of every shared obstacle and clamp to bounds. Mutates `pos`. */
export function resolveCollisions(pos: Vector3, radius: number): void {
  for (const o of WORLD.obstacles) {
    const hw = o.width / 2 + radius;
    const hd = o.depth / 2 + radius;
    const dx = pos.x - o.x;
    const dz = pos.z - o.z;
    if (Math.abs(dx) >= hw || Math.abs(dz) >= hd) continue;
    const px = hw - Math.abs(dx);
    const pz = hd - Math.abs(dz);
    if (px < pz) pos.x += Math.sign(dx || 1) * px;
    else pos.z += Math.sign(dz || 1) * pz;
  }
  const b = WORLD.bounds;
  pos.x = Math.min(b.maxX - radius, Math.max(b.minX + radius, pos.x));
  pos.z = Math.min(b.maxZ - radius, Math.max(b.minZ + radius, pos.z));
}

/** Soft radial sprite used by every particle system (no external image needed). */
export function softParticleTexture(scene: Scene): DynamicTexture {
  const tex = new DynamicTexture('soft-particle', 64, scene, false);
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

export function flatMaterial(scene: Scene, name: string, diffuse: Color3, emissive = Color3.Black(), alpha = 1): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = diffuse;
  m.specularColor = Color3.Black();
  m.emissiveColor = emissive;
  m.alpha = alpha;
  return m;
}

/**
 * Visual half-extent of the authored map. Rendering (ground, perimeter, mist) covers at least ±64 so the
 * expanded map reads correctly before/after WORLD.bounds grows; collision still clamps to WORLD.bounds.
 */
export const VISUAL_HALF = 64;
const visualBounds = () => {
  const b = WORLD.bounds;
  return { minX: Math.min(b.minX, -VISUAL_HALF), maxX: Math.max(b.maxX, VISUAL_HALF), minZ: Math.min(b.minZ, -VISUAL_HALF), maxZ: Math.max(b.maxZ, VISUAL_HALF) };
};

const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const insideObstacle = (x: number, z: number, margin: number) =>
  WORLD.obstacles.some((o) => Math.abs(x - o.x) < o.width / 2 + margin && Math.abs(z - o.z) < o.depth / 2 + margin);

/** Loads a Kenney kit GLB into a reusable container; returns null on failure (caller keeps fallback). */
export async function loadKit(scene: Scene, file: string): Promise<AssetContainer | null> {
  try {
    return await LoadAssetContainerAsync(KENNEY + file, scene);
  } catch (err) {
    console.warn('[world] kit model failed', file, err);
    return null;
  }
}

/**
 * Instantiates a container under a fresh holder node. The glTF `__root__` carries Babylon's
 * handedness transform, so we never touch it directly: position/rotation/scale go on the holder.
 */
export function placeKit(container: AssetContainer, name: string, pos: Vector3, yaw = 0, scale = 1, cloneMaterials = false): TransformNode {
  const holder = new TransformNode(name, container.scene);
  const entries = container.instantiateModelsToScene((n) => `${name}:${n}`, cloneMaterials, { doNotInstantiate: cloneMaterials });
  for (const root of entries.rootNodes) root.parent = holder;
  holder.position.copyFrom(pos);
  holder.rotation.y = yaw;
  holder.scaling.setAll(scale);
  return holder;
}

/** World-space size of a node hierarchy at its current transform. */
export function hierarchySize(node: TransformNode): { min: Vector3; max: Vector3; size: Vector3 } {
  const { min, max } = node.getHierarchyBoundingVectors(true);
  return { min, max, size: max.subtract(min) };
}

/** Uniformly scales `holder` so its footprint fits `width`×`depth` and its base sits on y=0 at (x, z). */
export function fitFootprint(holder: TransformNode, x: number, z: number, width: number, depth: number): number {
  holder.scaling.setAll(1);
  holder.position.set(0, 0, 0);
  const { min, max, size } = hierarchySize(holder);
  const s = Math.min(width / Math.max(size.x, 0.01), depth / Math.max(size.z, 0.01));
  holder.scaling.setAll(s);
  holder.position.set(x - (s * (min.x + max.x)) / 2, -min.y * s, z - (s * (min.z + max.z)) / 2);
  return s;
}

export interface WorldBuild { report: (text: string) => void }
export interface WorldHandles {
  /** Brightens the echo portal ring when the authoritative adventure state says it is open. */
  setPortalReady(ready: boolean): void;
}

/** Builds the night courtyard: fog, lights, ground, shared obstacles (with fallbacks), shrine, portal, props and mist. */
export function buildWorld(scene: Scene, { report }: WorldBuild): WorldHandles {
  const fog = new Color3(0.035, 0.05, 0.09);
  scene.clearColor = new Color4(fog.r, fog.g, fog.b, 1);
  scene.ambientColor = new Color3(0.08, 0.1, 0.16);
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.026;
  scene.fogColor = fog;

  const moon = new HemisphericLight('moonlight', new Vector3(-0.3, 1, 0.4), scene);
  moon.diffuse = new Color3(0.42, 0.5, 0.72);
  moon.groundColor = new Color3(0.05, 0.06, 0.1);
  moon.specular = Color3.Black();
  moon.intensity = 0.75;

  // Moon disc, exempt from fog so it reads through the haze.
  const moonDisc = MeshBuilder.CreateSphere('moon', { diameter: 9, segments: 12 }, scene);
  moonDisc.position.set(-60, 55, 130);
  const moonMat = flatMaterial(scene, 'moon-mat', Color3.Black(), new Color3(0.72, 0.78, 0.9));
  moonMat.fogEnabled = false;
  moonMat.disableLighting = true;
  moonDisc.material = moonMat;

  // Ground, plaza and a worn path from spawn to the chapel steps.
  const b = visualBounds();
  const ground = MeshBuilder.CreateGround('ground', { width: b.maxX - b.minX + 40, height: b.maxZ - b.minZ + 40 }, scene);
  ground.material = flatMaterial(scene, 'ground-mat', new Color3(0.07, 0.1, 0.075));
  const stone = flatMaterial(scene, 'stone-mat', new Color3(0.16, 0.17, 0.19));
  const plaza = MeshBuilder.CreateDisc('plaza', { radius: 7.5, tessellation: 40 }, scene);
  plaza.rotation.x = Math.PI / 2;
  plaza.position.set(0, 0.02, -6);
  plaza.material = stone;
  for (const [z0, z1] of [[-24, -8], [-4, 6]] as const) {
    const path = MeshBuilder.CreateBox(`path-${z0}`, { width: 3, height: 0.04, depth: z1 - z0 }, scene);
    path.position.set(0, 0.015, (z0 + z1) / 2);
    path.material = stone;
  }

  // Shared obstacles: visible procedural fallbacks first, real models swap in when loaded.
  const darkStone = flatMaterial(scene, 'dark-stone', new Color3(0.12, 0.12, 0.15));
  const window = flatMaterial(scene, 'window-glow', Color3.Black(), new Color3(0.45, 0.6, 0.95));
  const fallbacks = new Map<string, TransformNode>();
  for (const o of WORLD.obstacles) {
    const holder = new TransformNode(`${o.id}-fallback`, scene);
    if (o.id === 'fountain') {
      buildFountain(scene, holder, o);
      continue; // the fountain is procedural by design
    }
    const box = MeshBuilder.CreateBox(`${o.id}-box`, { width: o.width, height: o.height, depth: o.depth }, scene);
    box.position.y = o.height / 2;
    box.material = darkStone;
    box.parent = holder;
    if (o.id === 'chapel') {
      const spire = MeshBuilder.CreateCylinder('chapel-spire', { diameterTop: 0, diameterBottom: 4, height: 5, tessellation: 6 }, scene);
      spire.position.y = o.height + 2.5;
      spire.material = darkStone;
      spire.parent = holder;
      for (const wx of [-3.5, 0, 3.5]) {
        const w = MeshBuilder.CreatePlane(`chapel-window-${wx}`, { width: 1.2, height: 2.4 }, scene);
        w.position.set(wx, 5, -o.depth / 2 - 0.02);
        w.rotation.y = Math.PI;
        w.material = window;
        w.parent = holder;
      }
    }
    holder.position.set(o.x, 0, o.z);
    fallbacks.set(o.id, holder);
  }

  // Lamp posts with two real point lights near the fountain; the others glow via emissive only.
  const lampMat = flatMaterial(scene, 'lamp-glow', Color3.Black(), new Color3(1, 0.72, 0.35));
  const lampSpots: Array<[number, number, boolean]> = [[-3.2, -11, true], [3.2, -11, true], [-3.2, -20, false], [3.2, -20, false]];
  for (const [x, z, lit] of lampSpots) {
    const bulb = MeshBuilder.CreateSphere(`lamp-bulb-${x}-${z}`, { diameter: 0.35, segments: 8 }, scene);
    bulb.position.set(x, 2.3, z);
    bulb.material = lampMat;
    if (lit) {
      const light = new PointLight(`lamp-${x}-${z}`, new Vector3(x, 2.3, z), scene);
      light.diffuse = new Color3(1, 0.7, 0.4);
      light.specular = Color3.Black();
      light.intensity = 0.7; // calm, steady lantern pools
      light.range = 14;
    }
  }

  buildMist(scene);
  buildAuthoredZones(scene);
  const portal = buildShrineAndPortal(scene);
  void loadChapel(scene, fallbacks.get('chapel'), report);
  void dressCourtyard(scene, fallbacks, lampSpots);
  return portal;
}

/** Gate shrine (altar, steady candles) and the echo portal ring, at the shared adventure positions. */
function buildShrineAndPortal(scene: Scene): WorldHandles {
  const { shrine, portal } = WORLD.adventure;
  const stone = flatMaterial(scene, 'shrine-stone', new Color3(0.2, 0.19, 0.2));
  const altar = MeshBuilder.CreateBox('shrine-altar', { width: 1.6, height: 0.9, depth: 0.8 }, scene);
  altar.position.set(shrine.position[0], 0.45, shrine.position[2] + 1.2);
  altar.material = stone;
  const plinth = MeshBuilder.CreateBox('shrine-plinth', { width: 2.4, height: 0.2, depth: 1.6 }, scene);
  plinth.position.set(shrine.position[0], 0.1, shrine.position[2] + 1.2);
  plinth.material = stone;
  const wax = flatMaterial(scene, 'candle-wax', new Color3(0.85, 0.8, 0.68));
  const flame = flatMaterial(scene, 'candle-flame', Color3.Black(), new Color3(1, 0.72, 0.32));
  for (const [dx, h] of [[-0.5, 0.28], [-0.15, 0.2], [0.25, 0.32], [0.55, 0.18]] as const) {
    const candle = MeshBuilder.CreateCylinder(`candle-${dx}`, { diameter: 0.08, height: h, tessellation: 8 }, scene);
    candle.position.set(shrine.position[0] + dx, 0.9 + h / 2, shrine.position[2] + 1.1);
    candle.material = wax;
    const tip = MeshBuilder.CreateSphere(`candle-flame-${dx}`, { diameter: 0.06, segments: 6 }, scene);
    tip.position.set(shrine.position[0] + dx, 0.9 + h + 0.04, shrine.position[2] + 1.1);
    tip.material = flame; // steady: no flicker, no exposure changes
  }
  const bell = MeshBuilder.CreateCylinder('shrine-bell', { diameterTop: 0.18, diameterBottom: 0.42, height: 0.42, tessellation: 12 }, scene);
  bell.position.set(shrine.position[0], 1.25, shrine.position[2] + 1.35);
  bell.material = flatMaterial(scene, 'shrine-bell-mat', new Color3(0.45, 0.36, 0.18), new Color3(0.08, 0.06, 0.02));

  const ring = MeshBuilder.CreateTorus('echo-portal', { diameter: portal.radius * 1.6, thickness: 0.12, tessellation: 48 }, scene);
  ring.rotation.x = Math.PI / 2; // standing ring
  ring.position.set(portal.position[0], 1.7, portal.position[2]);
  const ringMat = flatMaterial(scene, 'echo-portal-mat', new Color3(0.05, 0.1, 0.1), new Color3(0.12, 0.3, 0.28), 0.9);
  ring.material = ringMat;
  const veil = MeshBuilder.CreateDisc('echo-portal-veil', { radius: portal.radius * 0.72, tessellation: 40 }, scene);
  veil.rotation.x = Math.PI / 2;
  veil.position.copyFrom(ring.position);
  const veilMat = flatMaterial(scene, 'echo-portal-veil-mat', Color3.Black(), new Color3(0.2, 0.5, 0.45), 0.12);
  veilMat.disableLighting = true;
  veilMat.backFaceCulling = false;
  veil.material = veilMat;
  return {
    setPortalReady(ready: boolean) {
      ringMat.emissiveColor = ready ? new Color3(0.35, 0.85, 0.75) : new Color3(0.12, 0.3, 0.28);
      veilMat.alpha = ready ? 0.35 : 0.12;
    },
  };
}

function buildFountain(scene: Scene, holder: TransformNode, o: Obstacle): void {
  const stone = flatMaterial(scene, 'fountain-stone', new Color3(0.2, 0.21, 0.24));
  const basin = MeshBuilder.CreateCylinder('fountain-basin', { diameter: o.width, height: o.height, tessellation: 28 }, scene);
  basin.position.y = o.height / 2;
  basin.material = stone;
  basin.parent = holder;
  const water = MeshBuilder.CreateDisc('fountain-water', { radius: o.width / 2 - 0.3, tessellation: 28 }, scene);
  water.rotation.x = Math.PI / 2; // disc normal points up (Babylon planes face -Z by default)
  water.position.y = o.height - 0.1;
  water.material = flatMaterial(scene, 'fountain-water-mat', new Color3(0.05, 0.1, 0.2), new Color3(0.18, 0.35, 0.6), 0.85);
  water.parent = holder;
  const pillar = MeshBuilder.CreateCylinder('fountain-pillar', { diameter: 0.6, height: 2.2, tessellation: 12 }, scene);
  pillar.position.y = o.height + 0.6;
  pillar.material = stone;
  pillar.parent = holder;
  holder.position.set(o.x, 0, o.z);

  const spray = new ParticleSystem('fountain-spray', 160, scene);
  spray.particleTexture = softParticleTexture(scene);
  spray.emitter = new Vector3(o.x, o.height + 1.7, o.z);
  spray.createConeEmitter(0.15, 0.5);
  spray.color1 = new Color4(0.5, 0.75, 1, 0.5);
  spray.color2 = new Color4(0.7, 0.9, 1, 0.35);
  spray.colorDead = new Color4(0.3, 0.5, 0.9, 0);
  spray.minSize = 0.08;
  spray.maxSize = 0.2;
  spray.minLifeTime = 0.9;
  spray.maxLifeTime = 1.3;
  spray.emitRate = 90;
  spray.minEmitPower = 2.2;
  spray.maxEmitPower = 3.2;
  spray.gravity = new Vector3(0, -6, 0);
  spray.updateSpeed = 1 / 60;
  spray.blendMode = ParticleSystem.BLENDMODE_ADD;
  spray.start();
}

function buildMist(scene: Scene): void {
  const soft = softParticleTexture(scene);
  const b = visualBounds();
  const mist = new ParticleSystem('ground-mist', 360, scene);
  mist.particleTexture = soft;
  mist.emitter = new Vector3(0, 0.4, 0);
  mist.createBoxEmitter(new Vector3(-0.35, 0, -0.2), new Vector3(0.35, 0.06, 0.2), new Vector3(b.minX, 0, b.minZ), new Vector3(b.maxX, 0.7, b.maxZ));
  // Alpha-blended, not the additive default: additive mist stacks to white near the camera.
  mist.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  mist.color1 = new Color4(0.5, 0.6, 0.8, 0.09);
  mist.color2 = new Color4(0.35, 0.45, 0.68, 0.06);
  mist.colorDead = new Color4(0.3, 0.4, 0.6, 0);
  mist.minSize = 5;
  mist.maxSize = 11;
  mist.minLifeTime = 9;
  mist.maxLifeTime = 16;
  mist.emitRate = 18;
  mist.minEmitPower = 0.15;
  mist.maxEmitPower = 0.4;
  mist.updateSpeed = 1 / 60;
  mist.preWarmCycles = 500;
  mist.preWarmStepOffset = 4;
  mist.start();

  const motes = new ParticleSystem('spirit-motes', 120, scene);
  motes.particleTexture = soft;
  motes.emitter = new Vector3(0, 1.5, 0);
  motes.createBoxEmitter(new Vector3(-0.2, 0.1, -0.2), new Vector3(0.2, 0.4, 0.2), new Vector3(b.minX, 0.3, b.minZ), new Vector3(b.maxX, 3, b.maxZ));
  motes.color1 = new Color4(0.6, 0.8, 1, 0.9);
  motes.color2 = new Color4(0.8, 0.9, 1, 0.6);
  motes.colorDead = new Color4(0.5, 0.7, 1, 0);
  motes.minSize = 0.05;
  motes.maxSize = 0.14;
  motes.minLifeTime = 4;
  motes.maxLifeTime = 8;
  motes.emitRate = 14;
  motes.updateSpeed = 1 / 60;
  motes.blendMode = ParticleSystem.BLENDMODE_ADD;
  motes.preWarmCycles = 300;
  motes.preWarmStepOffset = 4;
  motes.start();
}

async function loadChapel(scene: Scene, fallback: TransformNode | undefined, report: (t: string) => void): Promise<void> {
  const o = WORLD.obstacles.find((x) => x.id === 'chapel');
  if (!o) return;
  report('Loading haunted house (38 MB)…');
  try {
    const result = await ImportMeshAsync(HAUNTED_HOUSE, scene, {
      onProgress: (ev) => {
        if (ev.lengthComputable) report(`Loading haunted house… ${Math.round((100 * ev.loaded) / ev.total)}%`);
      },
    });
    const holder = new TransformNode('chapel', scene);
    for (const m of result.meshes) if (!m.parent) m.parent = holder;
    fitFootprint(holder, o.x, o.z, o.width, o.depth);
    for (const m of result.meshes) m.freezeWorldMatrix();
    fallback?.dispose();
    report('');
  } catch (err) {
    console.warn('[world] haunted house failed; keeping procedural chapel', err);
    report('Haunted house model unavailable — using procedural chapel.');
  }
}

async function dressCourtyard(scene: Scene, fallbacks: Map<string, TransformNode>, lampSpots: Array<[number, number, boolean]>): Promise<void> {
  const rand = seeded(1031);
  const names = ['crypt-large', 'iron-fence', 'iron-fence-border-column', 'iron-fence-border-gate', 'pillar-obelisk', 'column-large', 'stone-wall-damaged', 'fire-basket', 'altar-stone', 'pine-fall-crooked', 'trunk', 'lantern-candle', 'pumpkin-tall-carved', 'gravestone-cross-large', 'gravestone-decorative', 'grave-border', 'gravestone-cross', 'gravestone-round', 'gravestone-wide', 'gravestone-bevel', 'gravestone-broken', 'cross-wood', 'pine-crooked', 'pine', 'pine-fall', 'lightpost-single', 'bench', 'urn-round', 'pumpkin', 'pumpkin-carved'] as const;
  const kits = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await loadKit(scene, `${n}.glb`)]))) as Record<(typeof names)[number], AssetContainer | null>;

  // Crypts: fit the Kenney crypt to the shared obstacle footprint, then retire the box.
  if (kits['crypt-large']) {
    for (const o of WORLD.obstacles.filter((x) => x.id.startsWith('crypt'))) {
      const holder = placeKit(kits['crypt-large'], o.id, Vector3.Zero(), o.x < 0 ? Math.PI / 2 : -Math.PI / 2);
      fitFootprint(holder, o.x, o.z, o.width, o.depth);
      fallbacks.get(o.id)?.dispose();
    }
  }

  // Perimeter fence with corner columns.
  const fence = kits['iron-fence'];
  if (fence) {
    const probe = placeKit(fence, 'fence-probe', Vector3.Zero());
    const span = Math.max(hierarchySize(probe).size.x, 0.5);
    probe.dispose();
    const b = visualBounds(); // visual perimeter (±64); collision still clamps to WORLD.bounds
    const scale = 1;
    const step = span * scale;
    for (let x = b.minX + step / 2; x < b.maxX; x += step) {
      placeKit(fence, 'fence-n', new Vector3(x, 0, b.maxZ), 0, scale);
      placeKit(fence, 'fence-s', new Vector3(x, 0, b.minZ), 0, scale);
    }
    for (let z = b.minZ + step / 2; z < b.maxZ; z += step) {
      placeKit(fence, 'fence-e', new Vector3(b.maxX, 0, z), Math.PI / 2, scale);
      placeKit(fence, 'fence-w', new Vector3(b.minX, 0, z), Math.PI / 2, scale);
    }
    const column = kits['iron-fence-border-column'];
    if (column) for (const [x, z] of [[b.minX, b.minZ], [b.minX, b.maxZ], [b.maxX, b.minZ], [b.maxX, b.maxZ]]) placeKit(column, 'fence-corner', new Vector3(x, 0, z));
  }

  // Graveyard rows flanking the approach, skipping anything inside an obstacle.
  const stones = (['gravestone-cross', 'gravestone-round', 'gravestone-wide', 'gravestone-bevel', 'gravestone-broken', 'cross-wood'] as const).map((n) => kits[n]).filter((k): k is AssetContainer => !!k);
  if (stones.length) {
    for (const z of [-27, -22, -17, 20, 25]) {
      for (let x = -28; x <= 28; x += 3.2) {
        if (Math.abs(x) < 7 || insideObstacle(x, z, 1.5) || rand() < 0.2) continue;
        const kit = stones[Math.floor(rand() * stones.length)];
        placeKit(kit, 'grave', new Vector3(x + (rand() - 0.5) * 1.2, 0, z + (rand() - 0.5) * 1.2), (rand() - 0.5) * 0.5, 1.1);
      }
    }
  }

  // Trees along the edges and behind the chapel.
  const trees = (['pine-crooked', 'pine', 'pine-fall'] as const).map((n) => kits[n]).filter((k): k is AssetContainer => !!k);
  if (trees.length) {
    const spots: Array<[number, number]> = [[-27, 27], [27, 28], [-29, 2], [29, -6], [-9, 28], [9, 28], [-25, -29], [26, -28], [-20, 24], [22, 22]];
    for (const [x, z] of spots) {
      const kit = trees[Math.floor(rand() * trees.length)];
      placeKit(kit, 'tree', new Vector3(x, 0, z), rand() * Math.PI * 2, 2.2 + rand() * 0.8);
    }
  }

  dressAuthoredZones(kits, rand, stones, trees);

  if (kits['lightpost-single']) for (const [x, z] of lampSpots) placeKit(kits['lightpost-single'], 'lamppost', new Vector3(x, 0, z), x < 0 ? Math.PI / 2 : -Math.PI / 2, 1.6);
  if (kits.bench) for (const [x, z, yaw] of [[-5.5, -3, Math.PI / 2], [5.5, -3, -Math.PI / 2]] as const) placeKit(kits.bench, 'bench', new Vector3(x, 0, z), yaw, 1.2);
  if (kits['urn-round']) for (const [x, z] of [[-2.2, 4.5], [2.2, 4.5]]) placeKit(kits['urn-round'], 'urn', new Vector3(x, 0, z), 0, 1.3);
  // Two small pumpkins beside the gate shrine only.
  const shrine = WORLD.adventure.shrine.position;
  if (kits.pumpkin) placeKit(kits.pumpkin, 'pumpkin', new Vector3(shrine[0] - 1.5, 0, shrine[2] + 0.6), 0.4, 0.9);
  if (kits['pumpkin-carved']) placeKit(kits['pumpkin-carved'], 'pumpkin-carved', new Vector3(shrine[0] + 1.6, 0, shrine[2] + 0.5), -0.6, 0.9);
}

// ---- authored map (visual only) ------------------------------------------------------------------

/**
 * Hand-authored zone layout for the expanded Bellgrave (visual ±64). Nothing here collides or is
 * pickable: larger structures are proposed as shared colliders in the orchestration report, not added
 * client-side. Core obstacles, shrine, portal and enemy spawns are untouched.
 */
export const AUTHORED_ZONES = {
  safeGate: { x: 0, z: -23 },
  pumpkinGraveyard: { x: -35, z: -5, bigPumpkin: { x: -43, z: -7, diameter: 6 } },
  ruinedChapel: { x: 0, z: 11, arcadeX: 19, arcadeZ: [8, 32] as const, backWallZ: 38 },
  easternAltar: { x: 21, z: -8, runeRadius: 7.5, obeliskRadius: 10.5, altar: { x: 30, z: -8 } },
} as const;

/** Walkable worn-earth routes between zones (polyline points; kept clear of decoration). */
export const AUTHORED_ROUTES: Array<Array<[number, number]>> = [
  [[-2, -21], [-12, -17], [-24, -12], [-35, -5]], // Gate → Pumpkin Graveyard (lantern breadcrumbs)
  [[-35, -5], [-30, 6], [-20, 17], [-8, 22]], // Graveyard → Ruined Chapel courtyard
  [[8, 22], [20, 16], [25, 4], [21, -8]], // Chapel → Eastern Altar
  [[2, -21], [12, -15], [21, -8]], // Gate → Eastern Altar (short way)
  [[21, -8], [22, -19]], // Altar → Echo Portal
];

const routeDistance = (x: number, z: number): number => {
  let best = Infinity;
  for (const route of AUTHORED_ROUTES) {
    for (let i = 0; i + 1 < route.length; i++) {
      const [ax, az] = route[i];
      const [bx, bz] = route[i + 1];
      const dx = bx - ax, dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
      best = Math.min(best, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
    }
  }
  return best;
};

/** Optional outer-haunt layout from shared/world.json (backend-authoritative). */
interface OuterEnemiesDef { count: number; rings: number[] }

/**
 * Home positions of every enemy (4 core + outer haunts), mirroring the backend's ring
 * formula exactly. Used ONLY for decoration clearance; no entities are spawned here.
 */
const ENEMY_HOMES: Array<[number, number]> = (() => {
  const homes: Array<[number, number]> = WORLD.enemySpawns.map(e => [e.position[0], e.position[2]]);
  const outer = (WORLD as unknown as { outerEnemies?: OuterEnemiesDef }).outerEnemies;
  if (!outer || !(outer.count > 0) || !Array.isArray(outer.rings) || outer.rings.length === 0) return homes;
  const perRing = Math.ceil(outer.count / outer.rings.length);
  for (let i = 1; i <= outer.count; i++) {
    const ring = Math.floor((i - 1) / perRing);
    const slot = (i - 1) % perRing;
    const radius = outer.rings[ring] ?? outer.rings[outer.rings.length - 1];
    const angle = (slot / perRing) * Math.PI * 2 + ring * (Math.PI / perRing);
    homes.push([Math.round(Math.cos(angle) * radius * 10) / 10, Math.round(Math.sin(angle) * radius * 10) / 10]);
  }
  return homes;
})();

/** Keeps decoration off routes, core obstacles, landmarks and every enemy home (core + outer, radius 3.5). */
const clearSpot = (x: number, z: number, margin = 1.6): boolean => {
  if (routeDistance(x, z) < margin + 1.2) return false;
  if (insideObstacle(x, z, margin)) return false;
  const { shrine, portal } = WORLD.adventure;
  for (const l of [shrine, portal]) if (Math.hypot(x - l.position[0], z - l.position[2]) < l.radius + margin + 1) return false;
  for (const [hx, hz] of ENEMY_HOMES) if (Math.hypot(x - hx, z - hz) < 3.5) return false;
  if (Math.hypot(x - WORLD.spawn[0], z - WORLD.spawn[2]) < WORLD.adventure.safeSpawnRadius) return false;
  return true;
};

const freezeStatic = (m: Mesh) => {
  m.isPickable = false;
  m.computeWorldMatrix(true);
  m.freezeWorldMatrix();
};

/** Procedural focal structures (no downloads): routes, chapel ruins, big pumpkin, altar arena. */
function buildAuthoredZones(scene: Scene): void {
  const Z = AUTHORED_ZONES;
  // Worn-earth routes: one source box, instanced per segment.
  const earth = flatMaterial(scene, 'route-earth', new Color3(0.13, 0.11, 0.09));
  const seg = MeshBuilder.CreateBox('route-src', { width: 2.6, height: 0.03, depth: 1 }, scene);
  seg.material = earth;
  seg.isVisible = false;
  for (const route of AUTHORED_ROUTES) {
    for (let i = 0; i + 1 < route.length; i++) {
      const [ax, az] = route[i];
      const [bx, bz] = route[i + 1];
      const inst = seg.createInstance(`route-${ax}-${az}`);
      inst.position.set((ax + bx) / 2, 0.012, (az + bz) / 2);
      inst.rotation.y = Math.atan2(bx - ax, bz - az);
      inst.scaling.z = Math.hypot(bx - ax, bz - az) + 2;
      freezeStatic(inst as unknown as Mesh);
    }
  }

  // Ruined chapel courtyard: broken gothic arcade, back wall with crimson lancet windows.
  const ruin = flatMaterial(scene, 'ruin-stone', new Color3(0.14, 0.13, 0.15), new Color3(0.015, 0.01, 0.015));
  const crimson = flatMaterial(scene, 'ruin-window', Color3.Black(), new Color3(0.75, 0.08, 0.06));
  crimson.backFaceCulling = false;
  const pillarSrc = MeshBuilder.CreateBox('ruin-pillar-src', { width: 1.1, height: 1, depth: 1.1 }, scene);
  pillarSrc.material = ruin;
  pillarSrc.isVisible = false;
  const archSrc = MeshBuilder.CreateTorus('ruin-arch-src', { diameter: 5, thickness: 0.7, tessellation: 24 }, scene);
  archSrc.material = ruin;
  archSrc.isVisible = false;
  const rand = seeded(2027);
  const C = Z.ruinedChapel;
  for (const side of [-1, 1]) {
    const x = side * C.arcadeX;
    for (let z = C.arcadeZ[0], k = 0; z <= C.arcadeZ[1]; z += 6, k++) {
      const broken = (k + (side > 0 ? 1 : 0)) % 3 === 2;
      const h = broken ? 2.5 + rand() * 2 : 7.5;
      const p = pillarSrc.createInstance(`ruin-pillar-${side}-${z}`);
      p.scaling.y = h;
      p.position.set(x, h / 2, z);
      freezeStatic(p as unknown as Mesh);
      if (!broken && z + 6 <= C.arcadeZ[1] && (k + 1 + (side > 0 ? 1 : 0)) % 3 !== 2) {
        const a = archSrc.createInstance(`ruin-arch-${side}-${z}`);
        a.rotation.set(0, Math.PI / 2, Math.PI / 2); // standing arch spanning along Z
        a.scaling.set(1, 1, 1.2);
        a.position.set(x, 7.5, z + 3);
        freezeStatic(a as unknown as Mesh);
      }
    }
  }
  // Back wall: segments with gaps (broken), tall lancet windows lit crimson from behind.
  const wallSrc = MeshBuilder.CreateBox('ruin-wall-src', { width: 1, height: 1, depth: 1.2 }, scene);
  wallSrc.material = ruin;
  wallSrc.isVisible = false;
  const lancet = MeshBuilder.CreatePlane('ruin-lancet-src', { width: 1.4, height: 4.2 }, scene);
  lancet.material = crimson;
  lancet.isVisible = false;
  const rose = MeshBuilder.CreateDisc('ruin-rose', { radius: 2.4, tessellation: 24 }, scene);
  rose.material = crimson;
  rose.position.set(0, 12.5, C.backWallZ - 0.65);
  freezeStatic(rose);
  for (let x = -22; x <= 22; x += 4) {
    const gap = Math.abs(x) === 14; // collapsed sections the eye reads through
    const h = gap ? 2 : Math.abs(x) < 7 ? 15 : 10 - (Math.abs(x) % 8) * 0.4;
    const w = wallSrc.createInstance(`ruin-wall-${x}`);
    w.scaling.set(4, h, 1);
    w.position.set(x, h / 2, C.backWallZ);
    freezeStatic(w as unknown as Mesh);
    if (!gap && h > 8 && Math.abs(x) >= 4) {
      const win = lancet.createInstance(`ruin-lancet-${x}`);
      win.position.set(x, 5.2, C.backWallZ - 0.62);
      freezeStatic(win as unknown as Mesh);
    }
  }

  // Pumpkin graveyard focal: a giant carved pumpkin facing the gate route (east).
  const P = Z.pumpkinGraveyard.bigPumpkin;
  const pumpkinMat = flatMaterial(scene, 'big-pumpkin', new Color3(0.75, 0.32, 0.05), new Color3(0.2, 0.07, 0));
  const carve = flatMaterial(scene, 'big-pumpkin-carve', Color3.Black(), new Color3(1, 0.62, 0.18));
  carve.backFaceCulling = false;
  const big = new TransformNode('big-pumpkin', scene);
  big.position.set(P.x, 0, P.z);
  big.rotation.y = -Math.PI / 2; // local -Z (face) toward +X
  for (let i = 0; i < 8; i++) {
    const lobe = MeshBuilder.CreateSphere(`big-pumpkin-lobe-${i}`, { diameter: P.diameter * 0.62, segments: 12 }, scene);
    const a = (i / 8) * Math.PI * 2;
    lobe.scaling.set(0.8, 1, 0.8);
    lobe.position.set(Math.cos(a) * P.diameter * 0.2, P.diameter * 0.32, Math.sin(a) * P.diameter * 0.2);
    lobe.material = pumpkinMat;
    lobe.parent = big;
  }
  const stem = MeshBuilder.CreateCylinder('big-pumpkin-stem', { diameterTop: 0.3, diameterBottom: 0.6, height: 1.2, tessellation: 6 }, scene);
  stem.position.y = P.diameter * 0.66;
  stem.rotation.z = 0.25;
  stem.material = flatMaterial(scene, 'big-pumpkin-stem-mat', new Color3(0.18, 0.2, 0.08));
  stem.parent = big;
  // Carved face from triangles/planes (no earcut dependency), standing on local -Z.
  const faceZ = -P.diameter * 0.41;
  const feature = (m: Mesh, x: number, y: number, rotZ: number) => {
    m.position.set(x, P.diameter * 0.32 + y, faceZ);
    m.rotation.z = rotZ;
    m.material = carve;
    m.parent = big;
  };
  feature(MeshBuilder.CreateDisc('big-pumpkin-eye-l', { radius: 0.55, tessellation: 3 }, scene), -0.8, 0.8, Math.PI / 2);
  feature(MeshBuilder.CreateDisc('big-pumpkin-eye-r', { radius: 0.55, tessellation: 3 }, scene), 0.8, 0.8, Math.PI / 2);
  feature(MeshBuilder.CreateDisc('big-pumpkin-nose', { radius: 0.25, tessellation: 3 }, scene), 0, 0.15, Math.PI / 2);
  feature(MeshBuilder.CreatePlane('big-pumpkin-mouth', { width: 2.4, height: 0.45 }, scene), 0, -0.6, 0);
  for (const x of [-0.7, 0, 0.7]) feature(MeshBuilder.CreateDisc(`big-pumpkin-tooth-${x}`, { radius: 0.22, tessellation: 3 }, scene), x, -0.95, -Math.PI / 2);
  big.computeWorldMatrix(true);
  for (const m of big.getChildMeshes(false)) freezeStatic(m as Mesh);

  // Eastern altar arena: gold rune rings on the floor, tall obelisks with crimson banners.
  const E = Z.easternAltar;
  const gold = flatMaterial(scene, 'altar-gold', new Color3(0.35, 0.25, 0.06), new Color3(0.55, 0.36, 0.08));
  for (const [r, th] of [[E.runeRadius, 0.18], [E.runeRadius - 2.2, 0.1]] as const) {
    const ring = MeshBuilder.CreateTorus(`altar-rune-${r}`, { diameter: r * 2, thickness: th, tessellation: 64 }, scene);
    ring.scaling.y = 0.15;
    ring.position.set(E.x, 0.03, E.z);
    ring.material = gold;
    freezeStatic(ring);
  }
  const obelisk = MeshBuilder.CreateCylinder('altar-obelisk-src', { diameterTop: 0.25, diameterBottom: 1.1, height: 7, tessellation: 4 }, scene);
  obelisk.material = ruin;
  obelisk.isVisible = false;
  const banner = MeshBuilder.CreatePlane('altar-banner-src', { width: 0.9, height: 3 }, scene);
  banner.material = flatMaterial(scene, 'altar-banner', new Color3(0.4, 0.04, 0.04), new Color3(0.28, 0.02, 0.02));
  (banner.material as StandardMaterial).backFaceCulling = false;
  banner.isVisible = false;
  const cap = MeshBuilder.CreateSphere('altar-cap-src', { diameter: 0.45, segments: 6 }, scene);
  cap.material = gold;
  cap.isVisible = false;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const x = E.x + Math.cos(a) * E.obeliskRadius;
    const z = E.z + Math.sin(a) * E.obeliskRadius;
    if (routeDistance(x, z) < 2.5 || Math.hypot(x - 22, z + 22) < 5) continue; // keep entrances and portal clear
    const o = obelisk.createInstance(`altar-obelisk-${i}`);
    o.position.set(x, 3.5, z);
    o.rotation.y = Math.PI / 4;
    freezeStatic(o as unknown as Mesh);
    const c = cap.createInstance(`altar-cap-${i}`);
    c.position.set(x, 7.2, z);
    freezeStatic(c as unknown as Mesh);
    const b = banner.createInstance(`altar-banner-${i}`);
    b.position.set(x - Math.cos(a) * 0.6, 3.8, z - Math.sin(a) * 0.6);
    b.rotation.y = Math.atan2(E.x - x, E.z - z);
    freezeStatic(b as unknown as Mesh);
  }
}

/** Kenney-kit dressing for the authored zones; every kit is optional (procedural pieces stand alone). */
function dressAuthoredZones(kits: Record<string, AssetContainer | null>, rand: () => number, stones: AssetContainer[], trees: AssetContainer[]): void {
  const put = (kit: AssetContainer | null | undefined, name: string, x: number, z: number, yaw: number, scale: number, check = true) => {
    if (!kit || (check && !clearSpot(x, z))) return;
    const h = placeKit(kit, name, new Vector3(x, 0, z), yaw, scale);
    h.computeWorldMatrix(true);
    for (const m of h.getChildMeshes(false)) {
      m.isPickable = false;
      m.freezeWorldMatrix();
    }
  };
  const Z = AUTHORED_ZONES;
  // Lantern breadcrumbs: pairs flanking the Gate → Pumpkin Graveyard route every ~5 m.
  const crumb = AUTHORED_ROUTES[0];
  for (let i = 0; i + 1 < crumb.length; i++) {
    const [ax, az] = crumb[i];
    const [bx, bz] = crumb[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const nx = -(bz - az) / len, nz = (bx - ax) / len;
    for (let d = 2; d < len; d += 5) {
      const x = ax + ((bx - ax) * d) / len, z = az + ((bz - az) * d) / len;
      const side = (Math.round(d / 5) + i) % 2 ? 1 : -1;
      put(kits['lantern-candle'], 'crumb-lantern', x + nx * 2.1 * side, z + nz * 2.1 * side, 0, 2.2, false);
    }
  }
  // Distinct grave clusters around the big pumpkin, each a small rotated grid.
  const clusters: Array<[number, number, number]> = [[-46, -18, 0.2], [-30, -16, -0.3], [-48, 6, 0.5], [-38, 10, -0.1], [-28, 2, 0.15]];
  if (stones.length) {
    for (const [cx, cz, yaw] of clusters) {
      for (let r = -1; r <= 1; r++) for (let c = -1; c <= 1; c++) {
        if (rand() < 0.2) continue;
        const lx = c * 2.4, lz = r * 2.2;
        const x = cx + lx * Math.cos(yaw) - lz * Math.sin(yaw);
        const z = cz + lx * Math.sin(yaw) + lz * Math.cos(yaw);
        put(stones[Math.floor(rand() * stones.length)], 'grave-cluster', x, z, yaw + (rand() - 0.5) * 0.3, 1.2);
      }
      put(kits['gravestone-cross-large'] ?? kits['gravestone-decorative'], 'grave-cluster-head', cx, cz - 3.6, yaw, 1.5);
    }
  }
  const P = Z.pumpkinGraveyard.bigPumpkin;
  for (const [dx, dz, s] of [[3.5, 3, 2.6], [3.2, -3.4, 2.2], [-1, 4.4, 2.4], [-1.5, -4.6, 2]] as const) put(kits['pumpkin-tall-carved'] ?? kits['pumpkin-carved'], 'big-pumpkin-court', P.x + dx, P.z + dz, rand() * 6, s);
  // Chapel courtyard: stone-wall rubble and columns between arcade pillars.
  const C = Z.ruinedChapel;
  for (const [x, z, yaw] of [[-12, 30, 0.2], [12, 31, -0.3], [-24, 22, Math.PI / 2], [24, 24, Math.PI / 2]] as const) put(kits['stone-wall-damaged'], 'ruin-rubble', x, z, yaw, 2.2);
  for (const x of [-9, 9]) put(kits['column-large'], 'ruin-column', x, C.backWallZ - 4, 0, 2);
  // Eastern altar: real altar stone east of the boss spawn, fire baskets at the rune ring.
  const E = Z.easternAltar;
  put(kits['altar-stone'], 'altar-stone', E.altar.x, E.altar.z, Math.PI / 2, 2.4);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    put(kits['fire-basket'], 'altar-brazier', E.x + Math.cos(a) * (E.runeRadius + 0.8), E.z + Math.sin(a) * (E.runeRadius + 0.8), 0, 2);
  }
  // Outer haunted walks: gnarled trees, fence-gate arches at route mouths, corner graveyard enclaves.
  const gnarled = [kits['pine-fall-crooked'], kits.trunk, ...trees].filter((k): k is AssetContainer => !!k);
  if (gnarled.length) {
    for (let i = 0; i < 44; i++) {
      const a = (i / 44) * Math.PI * 2 + rand() * 0.08;
      const r = 50 + rand() * 9;
      put(gnarled[i % gnarled.length], 'outer-tree', Math.cos(a) * r, Math.sin(a) * r, rand() * Math.PI * 2, 2 + rand() * 1.2);
    }
  }
  for (const [x, z, yaw] of [[-30, -13, 0.6], [-25, 13, -0.7], [23, 11, 0.4], [10, -16, -0.7]] as const) put(kits['iron-fence-border-gate'], 'route-gate', x, z, yaw, 1.6, false);
  if (stones.length) {
    for (const [cx, cz] of [[-50, -48], [50, -46], [-48, 48], [48, 50], [0, 52], [-56, 24], [56, -20]] as const) {
      for (let k = 0; k < 7; k++) put(stones[Math.floor(rand() * stones.length)], 'enclave-grave', cx + (k % 4) * 2.4 - 3.6, cz + Math.floor(k / 4) * 2.6, (rand() - 0.5) * 0.4, 1.1);
      put(kits['grave-border'], 'enclave-border', cx, cz - 2.4, 0, 1.6);
    }
  }
}

export type { Mesh };
