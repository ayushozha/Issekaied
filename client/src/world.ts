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

/** Builds the night courtyard: fog, lights, ground, shared obstacles (with fallbacks), props and mist. */
export function buildWorld(scene: Scene, { report }: WorldBuild): void {
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
  const b = WORLD.bounds;
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
      light.intensity = 0.9;
      light.range = 14;
    }
  }

  buildMist(scene);
  void loadChapel(scene, fallbacks.get('chapel'), report);
  void dressCourtyard(scene, fallbacks, lampSpots);
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
  const b = WORLD.bounds;
  const mist = new ParticleSystem('ground-mist', 260, scene);
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
  mist.emitRate = 12;
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
  const names = ['crypt-large', 'iron-fence', 'iron-fence-border-column', 'gravestone-cross', 'gravestone-round', 'gravestone-wide', 'gravestone-bevel', 'gravestone-broken', 'cross-wood', 'pine-crooked', 'pine', 'pine-fall', 'lightpost-single', 'bench', 'urn-round'] as const;
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
    const b = WORLD.bounds;
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

  if (kits['lightpost-single']) for (const [x, z] of lampSpots) placeKit(kits['lightpost-single'], 'lamppost', new Vector3(x, 0, z), x < 0 ? Math.PI / 2 : -Math.PI / 2, 1.6);
  if (kits.bench) for (const [x, z, yaw] of [[-5.5, -3, Math.PI / 2], [5.5, -3, -Math.PI / 2]] as const) placeKit(kits.bench, 'bench', new Vector3(x, 0, z), yaw, 1.2);
  if (kits['urn-round']) for (const [x, z] of [[-2.2, 4.5], [2.2, 4.5]]) placeKit(kits['urn-round'], 'urn', new Vector3(x, 0, z), 0, 1.3);
}

export type { Mesh };
