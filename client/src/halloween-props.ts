import { Scene } from '@babylonjs/core/scene';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial';
import type { Material } from '@babylonjs/core/Materials/material';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
import { WORLD, flatMaterial, hierarchySize, loadKit, softParticleTexture } from './world';

/**
 * Halloween dressing for the existing Bellgrave courtyard. Purely decorative: nothing here is
 * pickable, nothing touches WORLD/collision, and every position keeps clear of the spawn, the
 * spawn→chapel path, the shrine altar and the echo portal. Steady glows only (no flicker).
 *
 * Palette: the kit's bright toy colours are pulled toward the crimson-cathedral reference (charcoal
 * iron, aged bone, burnt-ochre pumpkins, candle wax, worn brass) through owned material clones; the
 * shared kit containers and their original materials are never touched because world.ts places the
 * same kits elsewhere.
 */

const KITS = ['character-skeleton', 'pumpkin-carved', 'pumpkin-tall-carved', 'pumpkin', 'pumpkin-tall', 'candle', 'candle-multiple', 'lantern-candle'] as const;
type KitName = (typeof KITS)[number];
type Kits = Record<KitName, AssetContainer | null>;

/** Role tint multiplied into the kit palette texture, plus a steady inner ember for carved faces. */
interface Role { tint: Color3; emissive?: Color3 }
const ROLES: Record<KitName, Role> = {
  'character-skeleton': { tint: new Color3(0.84, 0.76, 0.6) }, // aged bone
  'pumpkin-carved': { tint: new Color3(0.8, 0.64, 0.46), emissive: new Color3(0.16, 0.06, 0.01) }, // burnt ochre, candle inside
  'pumpkin-tall-carved': { tint: new Color3(0.8, 0.64, 0.46), emissive: new Color3(0.16, 0.06, 0.01) },
  pumpkin: { tint: new Color3(0.76, 0.6, 0.44) },
  'pumpkin-tall': { tint: new Color3(0.76, 0.6, 0.44) },
  candle: { tint: new Color3(0.9, 0.84, 0.7) }, // candle wax / brass
  'candle-multiple': { tint: new Color3(0.9, 0.84, 0.7) },
  'lantern-candle': { tint: new Color3(0.6, 0.56, 0.53) }, // charcoal iron; the halo keeps the flame warm
};

/** Owned, cached overrides keyed by original material and role; disposed with the dressing root. */
class Overrides {
  private readonly cache = new Map<string, Material>();

  for(original: Material, role: KitName): Material {
    const key = `${role}:${original.uniqueId}`;
    let m = this.cache.get(key);
    if (m) return m;
    if (original instanceof MultiMaterial) {
      const multi = new MultiMaterial(`halloween-${role}:${original.name}`, original.getScene());
      multi.subMaterials = original.subMaterials.map((s) => (s ? this.for(s, role) : null));
      m = multi;
    } else if (original instanceof PBRMaterial) {
      const { tint, emissive } = ROLES[role];
      const p = original.clone(`halloween-${role}:${original.name}`); // keeps the palette texture and alpha settings
      p.albedoColor = original.albedoColor.multiply(tint);
      p.metallic = 0;
      p.roughness = 0.92;
      p.specularIntensity = 0.35; // matte: no plastic highlight under the lamps
      if (emissive) p.emissiveColor = emissive;
      m = p;
    } else {
      return original; // unknown material type: leave the shared one alone rather than guess
    }
    this.cache.set(key, m);
    return m;
  }

  /** Re-points every mesh under `holder` (clones, never instances) at its owned override. */
  apply(holder: TransformNode, role: KitName): void {
    for (const mesh of holder.getChildMeshes(false)) if (mesh.material) mesh.material = this.for(mesh.material, role);
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose(false, false); // never the shared kit textures
    this.cache.clear();
  }
}

/** Like world.placeKit but always clones meshes so `overrides` can swap their materials per role. */
function placeOwned(container: AssetContainer, name: string, pos: Vector3, yaw: number, scale: number, role: KitName, overrides: Overrides): TransformNode {
  const holder = new TransformNode(name, container.scene);
  const entries = container.instantiateModelsToScene((n) => `${name}:${n}`, false, { doNotInstantiate: true });
  for (const r of entries.rootNodes) r.parent = holder;
  holder.position.copyFrom(pos);
  holder.rotation.y = yaw;
  holder.scaling.setAll(scale);
  overrides.apply(holder, role);
  return holder;
}

/** [kit, x, z, yaw, scale, glow?] — glow adds a steady warm halo (jack-o'-lanterns, candles). */
type Prop = [KitName, number, number, number, number, boolean?];

const dressed = new WeakMap<Scene, Promise<void>>();

/** Idempotent per scene: repeated calls return the same promise. Never rejects. */
export function dressHalloween(scene: Scene): Promise<void> {
  let job = dressed.get(scene);
  if (!job) {
    job = dress(scene).catch((err) => console.warn('[halloween] dressing skipped', err));
    dressed.set(scene, job);
  }
  return job;
}

async function dress(scene: Scene): Promise<void> {
  if (scene.isDisposed) return;
  const root = new TransformNode('halloween-dressing', scene);
  // Procedural pieces first: they need no downloads and show even if every GLB fails.
  const webs = buildWebs(scene, root);

  const loaded = await Promise.all(KITS.map(async (n) => [n, await loadKit(scene, `${n}.glb`)] as const));
  if (scene.isDisposed || root.isDisposed()) {
    for (const [, c] of loaded) c?.dispose();
    return;
  }
  const kits = Object.fromEntries(loaded) as Kits;

  const { shrine, portal, zones } = WORLD.adventure;
  const zone = (id: string, fallback: [number, number]): [number, number] => {
    const z = zones.find((x) => x.id === id);
    return z ? [z.position[0], z.position[2]] : fallback;
  };
  const [sx, sz] = [shrine.position[0], shrine.position[2]];
  const [px, pz] = [portal.position[0], portal.position[2]];
  const [mx, mz] = zone('morrow', [-10, -8]);
  const [nx, nz] = zone('nix', [-21, 9]);
  const [vx, vz] = zone('vesper', [11, 18]);
  const [rx, rz] = zone('raksha', [21, -8]);

  // Composed clusters. The shrine already has a small pumpkin and a carved one at ±1.5; these add
  // tall/lantern/candle variety rather than more of the same, and stay off the 3 m-wide path.
  const props: Prop[] = [
    // Gate vista, flanking the approach the spawn camera looks along.
    ['pumpkin-tall-carved', sx - 4.6, sz + 2.8, 0.3, 2.3, true],
    ['pumpkin', sx - 5.3, sz + 3.4, 1.1, 1.9],
    ['candle-multiple', sx - 4.0, sz + 3.5, 0, 2.4, true],
    ['pumpkin-carved', sx + 4.6, sz + 2.6, -0.4, 2.4, true],
    ['pumpkin-tall', sx + 5.3, sz + 3.3, 0.7, 2.0],
    ['lantern-candle', sx + 4.0, sz + 3.4, 0, 2.3, true],
    // Shrine: steady candles and a lantern just outside the existing pumpkins.
    ['candle', sx - 2.4, sz + 1.5, 0, 2.6, true],
    ['candle-multiple', sx + 2.5, sz + 1.4, 0.5, 2.4, true],
    // Echo portal: lanterns either side of the standing ring (approach is along Z).
    ['lantern-candle', px - 3.6, pz + 0.6, 0, 2.4, true],
    ['pumpkin-carved', px + 3.6, pz + 0.4, -0.8, 2.2, true],
    ['candle', px - 3.2, pz - 1.0, 0, 2.4],
    // Enemy-zone edges (about 4 m out from each zone centre, never on it).
    ['pumpkin-tall-carved', mx + 3.2, mz - 3.0, -0.6, 2.2, true], // Bell-ringer's Walk
    ['candle', mx + 3.9, mz - 2.5, 0, 2.4],
    ['pumpkin-carved', nx - 3.4, nz - 2.8, 0.9, 2.3, true], // Western Crypt
    ['lantern-candle', nx + 3.6, nz - 3.4, 0, 2.2, true],
    ['pumpkin-tall-carved', vx - 3.2, vz - 2.4, 0.4, 2.2, true], // Chapel Approach
    ['pumpkin', vx - 2.5, vz - 3.0, 0, 1.8],
    ['candle-multiple', rx + 3.5, rz + 2.4, 0.2, 2.6, true], // Eastern Altar
    ['pumpkin-tall', rx - 3.6, rz - 2.8, 1.4, 2.0],
  ];

  const overrides = new Overrides();
  root.onDisposeObservable.addOnce(() => overrides.dispose());
  const glowSpots: Vector3[] = [];
  for (const [kit, x, z, yaw, scale, glow] of props) {
    const c = kits[kit];
    if (!c) continue;
    const holder = placeOwned(c, `halloween-${kit}`, new Vector3(x, 0, z), yaw, scale, kit, overrides);
    holder.parent = root;
    settle(holder);
    if (glow) glowSpots.push(new Vector3(x, glowHeight(kit, scale), z));
  }

  // Skeletons: one slumped by the gate graves, one at the western crypt corner, one keeping vigil
  // at the eastern altar edge. Posed once from the kit's own animation and then paused (static).
  if (kits['character-skeleton']) {
    const skel = kits['character-skeleton'];
    const facing = (x: number, z: number, tx: number, tz: number) => Math.atan2(tx - x, tz - z);
    const spots: Array<[number, number, number, string]> = [
      [-8.4, sz - 2.6, facing(-8.4, sz - 2.6, 0, sz - 2.6), 'sit'],
      [-18.6, mz + 2.4, facing(-18.6, mz + 2.4, mx, mz), 'sit'],
      [rx + 4.2, rz - 3.4, facing(rx + 4.2, rz - 3.4, rx, rz), 'idle'],
      // Pumpkin Graveyard (authored west zone): two keepers slumped before the giant pumpkin.
      [-38.6, -3.2, facing(-38.6, -3.2, -43, -7), 'sit'],
      [-39.2, -11.4, facing(-39.2, -11.4, -43, -7), 'sit'],
    ];
    for (const [x, z, yaw, pose] of spots) placeSkeleton(skel, root, x, z, yaw, pose, overrides);
  }

  buildGlows(scene, root, glowSpots);
  // One steady warm pool at the gate vista (scene already has moon + two lamp lights; stay ≤4).
  const light = new PointLight('halloween-gate-glow', new Vector3(sx - 4.4, 0.9, sz + 3.0), scene);
  light.diffuse = new Color3(1, 0.55, 0.2);
  light.specular = Color3.Black();
  light.intensity = 0.35;
  light.range = 6;
  light.parent = root;
  webs.freeze();
}

/** Decorative meshes never intercept combat picks and never move: freeze their world matrices. */
function settle(holder: TransformNode): void {
  holder.computeWorldMatrix(true);
  for (const m of holder.getChildMeshes(false)) {
    m.isPickable = false;
    m.freezeWorldMatrix();
  }
}

function glowHeight(kit: KitName, scale: number): number {
  if (kit.startsWith('candle')) return 0.24 * scale;
  if (kit === 'lantern-candle') return 0.22 * scale;
  return 0.17 * scale; // pumpkin centre
}

function placeSkeleton(kit: AssetContainer, root: TransformNode, x: number, z: number, yaw: number, pose: string, overrides: Overrides): void {
  const name = `halloween-skeleton-${x.toFixed(1)}`;
  const holder = new TransformNode(name, kit.scene);
  holder.parent = root;
  // Cloned (not instanced): skinned meshes need their own skeleton for an individual pose.
  const entries = kit.instantiateModelsToScene((n) => `${name}:${n}`, false, { doNotInstantiate: true });
  for (const r of entries.rootNodes) r.parent = holder;
  const group = entries.animationGroups.find((g) => g.name.endsWith(pose)) ?? entries.animationGroups.find((g) => g.name.endsWith('static'));
  for (const g of entries.animationGroups) if (g !== group) g.dispose();
  if (group) {
    group.start(true);
    group.goToFrame(group.from + (group.to - group.from) * 0.5);
    group.pause(); // hold the pose; no ongoing animation
  }
  // Scale to ~1.5 m standing height from the measured kit; fall back to a sane constant.
  const { min, size } = hierarchySize(holder);
  const s = size.y > 0.1 && size.y < 10 ? 1.5 / size.y : 2.6;
  holder.scaling.setAll(s);
  holder.position.set(x, Number.isFinite(min.y) ? Math.max(0, -min.y * s) : 0, z);
  holder.rotation.y = yaw;
  overrides.apply(holder, 'character-skeleton');
  for (const m of holder.getChildMeshes(false)) m.isPickable = false;
}

/** Steady warm halos (billboards, additive, low alpha) instead of many real lights. */
function buildGlows(scene: Scene, root: TransformNode, spots: Vector3[]): void {
  if (!spots.length) return;
  const mat = new StandardMaterial('halloween-glow-mat', scene);
  mat.diffuseTexture = softParticleTexture(scene);
  mat.useAlphaFromDiffuseTexture = true;
  mat.diffuseColor = new Color3(1, 0.62, 0.22); // candle gold, as in the reference stairs of candles
  mat.specularColor = Color3.Black();
  mat.disableLighting = true;
  mat.alphaMode = Constants.ALPHA_ADD;
  mat.alpha = 0.3;
  for (const [i, p] of spots.entries()) {
    const halo = MeshBuilder.CreatePlane(`halloween-glow-${i}`, { size: 0.9 }, scene);
    halo.billboardMode = TransformNode.BILLBOARDMODE_ALL;
    halo.position.copyFrom(p);
    halo.material = mat;
    halo.isPickable = false;
    halo.parent = root;
  }
}

/** Canvas-drawn cobwebs with small spiders, hung at crypt corners and on the gate lampposts. */
function buildWebs(scene: Scene, root: TransformNode): { freeze(): void } {
  const tex = new DynamicTexture('halloween-web', 256, scene, true);
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, 256, 256);
  ctx.strokeStyle = 'rgba(214,202,178,0.85)'; // dusty aged thread, not blue-white
  ctx.lineWidth = 1.6;
  const spokes = 9;
  const angles = Array.from({ length: spokes }, (_, i) => (i / spokes) * Math.PI * 2 + (i % 2 ? 0.08 : -0.05));
  ctx.beginPath();
  for (const a of angles) {
    ctx.moveTo(128, 128);
    ctx.lineTo(128 + Math.cos(a) * 124, 128 + Math.sin(a) * 124);
  }
  ctx.stroke();
  ctx.lineWidth = 1.2;
  for (let ring = 1; ring <= 7; ring++) {
    const r = ring * 16;
    ctx.beginPath();
    angles.forEach((a, i) => {
      const b = angles[(i + 1) % spokes] + (i === spokes - 1 ? Math.PI * 2 : 0);
      const x0 = 128 + Math.cos(a) * r;
      const y0 = 128 + Math.sin(a) * r;
      const mid = (a + b) / 2;
      const sag = r * 0.82; // threads sag toward the centre between spokes
      if (i === 0) ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(128 + Math.cos(mid) * sag, 128 + Math.sin(mid) * sag, 128 + Math.cos(b) * r, 128 + Math.sin(b) * r);
    });
    ctx.stroke();
  }
  tex.hasAlpha = true;
  tex.update();

  const mat = new StandardMaterial('halloween-web-mat', scene);
  mat.diffuseTexture = tex;
  mat.useAlphaFromDiffuseTexture = true;
  mat.diffuseColor = new Color3(0.72, 0.68, 0.6);
  mat.emissiveColor = new Color3(0.3, 0.28, 0.25); // readable in the dark, never glaring
  mat.specularColor = Color3.Black();
  mat.disableLighting = true;
  mat.backFaceCulling = false;
  mat.alpha = 0.75;

  const spiderMat = flatMaterial(scene, 'halloween-spider-mat', new Color3(0.04, 0.035, 0.05), new Color3(0.05, 0.03, 0.06));
  const meshes: TransformNode[] = [];

  const web = (x: number, y: number, z: number, yaw: number, size: number, spider: boolean) => {
    const plane = MeshBuilder.CreatePlane('halloween-web', { size }, scene);
    plane.position.set(x, y, z);
    plane.rotation.y = yaw;
    plane.material = mat;
    plane.isPickable = false;
    plane.parent = root;
    meshes.push(plane);
    if (!spider) return;
    // Small low-poly spider hanging a little below the web on a single thread.
    const node = new TransformNode('halloween-spider', scene);
    node.parent = root;
    node.position.set(x, y - size * 0.35, z);
    node.rotation.y = yaw;
    const body = MeshBuilder.CreateSphere('halloween-spider-body', { diameter: 0.14, segments: 4 }, scene);
    body.scaling.set(1, 1.2, 0.8);
    body.position.y = -0.06;
    const head = MeshBuilder.CreateSphere('halloween-spider-head', { diameter: 0.08, segments: 4 }, scene);
    head.position.y = 0.04;
    const legs: Vector3[][] = [];
    for (const side of [-1, 1]) for (let i = 0; i < 4; i++) {
      const y0 = 0.02 - i * 0.035;
      legs.push([new Vector3(0, y0, 0), new Vector3(side * 0.09, y0 + 0.04, 0), new Vector3(side * 0.14, y0 - 0.05 + i * 0.015, 0)]);
    }
    legs.push([new Vector3(0, 0.06, 0), new Vector3(0, size * 0.35, 0)]); // thread back up to the web
    const lines = MeshBuilder.CreateLineSystem('halloween-spider-legs', { lines: legs }, scene);
    lines.color = new Color3(0.22, 0.2, 0.26);
    for (const m of [body, head, lines]) {
      if (m !== lines) m.material = spiderMat;
      m.parent = node;
      m.isPickable = false;
    }
    meshes.push(node);
  };

  const crypts = WORLD.obstacles.filter((o) => o.id.startsWith('crypt'));
  for (const o of crypts) {
    // Outer front corner facing the courtyard centre, set diagonally across the corner.
    const sxSign = o.x < 0 ? 1 : -1;
    const cx = o.x + sxSign * (o.width / 2 + 0.05);
    const cz = o.z - (o.depth / 2 + 0.05);
    web(cx, 2.4, cz, sxSign > 0 ? -Math.PI / 4 : Math.PI / 4, 1.7, true);
  }
  // Gate lampposts nearest the spawn (x=±3.2, z=-20 in world.ts); small webs facing the spawn.
  const spawnZ = WORLD.spawn[2];
  for (const x of [-3.2, 3.2]) web(x + (x < 0 ? 0.35 : -0.35), 1.55, spawnZ + 3.05, x < 0 ? 0.35 : -0.35, 0.9, x > 0);
  // A web strung across the portal-side fence corner, out of the portal's sightline.
  const b = WORLD.bounds;
  web(b.maxX - 1.1, 1.3, b.minZ + 1.1, Math.PI / 4, 1.6, true);
  // Pumpkin Graveyard: webs strung near the giant pumpkin and on a ruined chapel arcade pillar.
  web(-40.2, 2.6, -2.4, -Math.PI / 5, 2.2, true);
  web(-40.4, 2.2, -12, Math.PI / 5, 1.8, false);
  web(-18.4, 3.4, 14.4, Math.PI / 2, 1.8, true);

  return {
    freeze() {
      for (const n of meshes) {
        n.computeWorldMatrix(true);
        n.freezeWorldMatrix();
        for (const m of n.getChildMeshes(false)) m.freezeWorldMatrix();
      }
    },
  };
}
