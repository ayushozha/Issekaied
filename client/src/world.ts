import { Scene } from '@babylonjs/core/scene';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3, Vector4 } from '@babylonjs/core/Maths/math.vector';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import '@babylonjs/core/Meshes/instancedMesh'; // createInstance side effect
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
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

/** Albedo-only generated surface textures (1254 px, tileable), served from publicDir. */
const SURFACE_URL = {
  stone: '/generated/materials/cathedral-stone.png',
  cobble: '/generated/materials/courtyard-cobble.png',
  wood: '/generated/materials/aged-wood.png',
} as const;
type SurfaceKind = keyof typeof SURFACE_URL;
/** Metres covered by one repeat of each texture. */
const SURFACE_TILE: Record<SurfaceKind, number> = { stone: 3, cobble: 3.5, wood: 2 };
const surfaceCache = new WeakMap<Scene, Partial<Record<SurfaceKind, Texture>>>();

function surfaceTexture(scene: Scene, kind: SurfaceKind): Texture {
  let cache = surfaceCache.get(scene);
  if (!cache) surfaceCache.set(scene, (cache = {}));
  let tex = cache[kind];
  if (!tex) {
    tex = new Texture(SURFACE_URL[kind], scene);
    tex.anisotropicFilteringLevel = 8;
    cache[kind] = tex;
  }
  return tex;
}

/** StandardMaterial with a repeated generated texture. uScale/vScale 1 = UVs already in tile units. */
function surfaceMaterial(scene: Scene, name: string, kind: SurfaceKind, tint: Color3, uScale = 1, vScale = uScale): StandardMaterial {
  const m = flatMaterial(scene, name, tint);
  const base = surfaceTexture(scene, kind);
  let tex = base;
  if (uScale !== 1 || vScale !== 1) {
    tex = base.clone(); // shares the engine-cached GPU image; only the repeat differs
    tex.uScale = uScale;
    tex.vScale = vScale;
  }
  m.diffuseTexture = tex;
  m.ambientColor = new Color3(0.55, 0.55, 0.6); // picks up the cold scene ambient, no emissive whitewash
  return m;
}

/** Box whose UVs tile at `tile` metres per repeat on every face (no stretching on long walls). */
function tiledBox(scene: Scene, name: string, w: number, h: number, d: number, tile: number): Mesh {
  const f = (a: number, b: number) => new Vector4(0, 0, a / tile, b / tile);
  return MeshBuilder.CreateBox(name, { width: w, height: h, depth: d, wrap: true, faceUV: [f(w, h), f(w, h), f(d, h), f(d, h), f(w, d), f(w, d)] }, scene);
}

/** Convex, double-sided flat shape in the local XY plane (fan triangulated, no earcut needed). */
function flatShape(scene: Scene, name: string, outline: Array<[number, number]>, center: [number, number], tile = SURFACE_TILE.stone): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];
  const n = outline.length;
  for (const side of [0, 1]) {
    const base = positions.length / 3;
    for (const [x, y] of [center, ...outline]) {
      positions.push(x, y, 0);
      uvs.push(x / tile, y / tile);
    }
    for (let i = 0; i < n; i++) {
      const a = base + 1 + i;
      const b = base + 1 + ((i + 1) % n);
      if (side === 0) indices.push(base, a, b);
      else indices.push(base, b, a);
    }
  }
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = normals;
  vd.uvs = uvs;
  const mesh = new Mesh(name, scene);
  vd.applyToMesh(mesh);
  return mesh;
}

/** Equilateral pointed (lancet) arch outline: width w, straight jambs to `spring`, apex at spring + 0.866w. */
function lancetOutline(w: number, spring: number, seg = 6): Array<[number, number]> {
  const h = w / 2;
  const pts: Array<[number, number]> = [[-h, 0], [h, 0], [h, spring]];
  for (let i = 1; i <= seg; i++) {
    const t = (i / seg) * (Math.PI / 3);
    pts.push([-h + w * Math.cos(t), spring + w * Math.sin(t)]);
  }
  for (let i = 1; i < seg; i++) {
    const t = (2 * Math.PI) / 3 + (i / seg) * (Math.PI / 3);
    pts.push([h + w * Math.cos(t), spring + w * Math.sin(t)]);
  }
  pts.push([-h, spring]);
  return pts;
}

/** Open moulding path following a lancet outline (jamb → arch → jamb), at local depth z. */
const lancetPath = (w: number, spring: number, z = 0): Vector3[] => {
  const pts = lancetOutline(w, spring).slice(1);
  pts.push([-w / 2, 0]);
  return pts.map(([x, y]) => new Vector3(x, y, z));
};

const mergeStatic = (name: string, parts: Mesh[], mat: StandardMaterial): Mesh | null => {
  const merged = Mesh.MergeMeshes(parts, true, true);
  if (!merged) return null;
  merged.name = name;
  merged.material = mat;
  merged.isPickable = false;
  merged.freezeWorldMatrix();
  return merged;
};

/** Shared cathedral palette: charcoal weathered stone, slate roofs, dark tracery, crimson + gold glass. */
interface GothicMats {
  stone: StandardMaterial;
  roof: StandardMaterial;
  tracery: StandardMaterial;
  glass: StandardMaterial;
  roseGlass: StandardMaterial;
  goldGlass: StandardMaterial;
  wax: StandardMaterial;
  flame: StandardMaterial;
  cloth: StandardMaterial;
}
const gothicCache = new WeakMap<Scene, GothicMats>();
function gothicMats(scene: Scene): GothicMats {
  let m = gothicCache.get(scene);
  if (m) return m;
  const glow = (name: string, e: Color3, fog = true) => {
    const g = flatMaterial(scene, name, Color3.Black(), e);
    g.disableLighting = true;
    g.fogEnabled = fog;
    return g;
  };
  m = {
    stone: surfaceMaterial(scene, 'cathedral-stone', 'stone', new Color3(0.86, 0.84, 0.88)),
    roof: surfaceMaterial(scene, 'cathedral-slate', 'stone', new Color3(0.42, 0.4, 0.47)),
    // Dim gold-bronze tracery so mouldings, mullions and rose spokes read against crimson glass at night.
    tracery: flatMaterial(scene, 'cathedral-tracery', new Color3(0.4, 0.29, 0.1), new Color3(0.26, 0.16, 0.045)),
    glass: glow('crimson-glass', new Color3(0.6, 0.06, 0.07)),
    // Rose windows read through the haze like lit glass: fog-exempt, deliberately not bright.
    roseGlass: glow('rose-glass', new Color3(0.5, 0.04, 0.06), false),
    goldGlass: glow('gold-glass', new Color3(0.85, 0.52, 0.16), false),
    wax: flatMaterial(scene, 'cathedral-wax', new Color3(0.78, 0.7, 0.58), new Color3(0.08, 0.05, 0.02)),
    flame: glow('cathedral-flame', new Color3(1, 0.68, 0.28)),
    cloth: flatMaterial(scene, 'cathedral-banner', new Color3(0.34, 0.03, 0.04), new Color3(0.12, 0.01, 0.015)),
  };
  m.cloth.backFaceCulling = false;
  gothicCache.set(scene, m);
  return m;
}

/** Hidden source meshes for a stained-glass lancet: crimson pane + merged stone tracery (frame, mullion, foil). */
interface LancetKit { glass: Mesh; tracery: Mesh; height: number }
function lancetKit(scene: Scene, name: string, w: number, spring: number, mats: GothicMats): LancetKit {
  const glass = flatShape(scene, `${name}-glass-src`, lancetOutline(w, spring), [0, spring * 0.6]);
  glass.material = mats.glass;
  const frame = MeshBuilder.CreateTube(`${name}-frame`, { path: lancetPath(w, spring, -0.05), radius: Math.max(0.07, w * 0.08), tessellation: 6 }, scene);
  const mullion = MeshBuilder.CreateBox(`${name}-mullion`, { width: Math.max(0.08, w * 0.08), height: spring + w * 0.3, depth: 0.12 }, scene);
  mullion.position.set(0, (spring + w * 0.3) / 2, -0.05);
  const foil = MeshBuilder.CreateTorus(`${name}-foil`, { diameter: w * 0.42, thickness: Math.max(0.05, w * 0.06), tessellation: 14 }, scene);
  foil.rotation.x = Math.PI / 2;
  foil.position.set(0, spring + w * 0.44, -0.05);
  const transom = MeshBuilder.CreateBox(`${name}-transom`, { width: w, height: Math.max(0.06, w * 0.06), depth: 0.1 }, scene);
  transom.position.set(0, spring * 0.5, -0.05);
  const tracery = mergeStatic(`${name}-tracery-src`, [frame, mullion, foil, transom], mats.tracery) ?? new Mesh(`${name}-tracery-empty`, scene);
  for (const s of [glass, tracery]) {
    s.isVisible = false;
    s.isPickable = false;
  }
  return { glass, tracery, height: spring + w * 0.866 };
}

/** Places a lancet; local -Z (the glass front) faces the direction given by yaw. */
function placeLancet(kit: LancetKit, name: string, x: number, y: number, z: number, yaw = 0): void {
  for (const src of [kit.glass, kit.tracery]) {
    const inst = src.createInstance(`${name}-${src === kit.glass ? 'glass' : 'tracery'}`);
    inst.position.set(x, y, z);
    inst.rotation.y = yaw;
    inst.isPickable = false;
    inst.computeWorldMatrix(true);
    inst.freezeWorldMatrix();
  }
}

/** Rose window facing -Z: crimson glass, gold oculus, stone tracery (rings, 12 spokes, 12 foils). ~3.5k verts. */
function buildRose(scene: Scene, name: string, c: Vector3, r: number, mats: GothicMats): void {
  const glass = MeshBuilder.CreateDisc(`${name}-glass`, { radius: r * 0.97, tessellation: 36, sideOrientation: Mesh.DOUBLESIDE }, scene);
  glass.position.copyFrom(c);
  glass.material = mats.roseGlass;
  const oculus = MeshBuilder.CreateDisc(`${name}-oculus`, { radius: r * 0.3, tessellation: 20, sideOrientation: Mesh.DOUBLESIDE }, scene);
  oculus.position.set(c.x, c.y, c.z - 0.02);
  oculus.material = mats.goldGlass;
  for (const m of [glass, oculus]) freezeStatic(m);
  const z = c.z - 0.07;
  const parts: Mesh[] = [];
  const ring = (n: string, d: number, t: number, tess: number, x = c.x, y = c.y) => {
    const m = MeshBuilder.CreateTorus(n, { diameter: d, thickness: t, tessellation: tess }, scene);
    m.rotation.x = Math.PI / 2;
    m.position.set(x, y, z);
    parts.push(m);
  };
  ring(`${name}-outer`, r * 2, r * 0.16, 36);
  ring(`${name}-inner`, r * 0.66, r * 0.08, 24);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const spoke = MeshBuilder.CreateBox(`${name}-spoke-${i}`, { width: r * 0.06, height: r * 0.68, depth: 0.12 }, scene);
    spoke.rotation.z = a;
    spoke.position.set(c.x - Math.sin(a) * r * 0.66, c.y + Math.cos(a) * r * 0.66, z);
    parts.push(spoke);
    const fa = a + Math.PI / 12;
    ring(`${name}-foil-${i}`, r * 0.3, r * 0.045, 12, c.x - Math.sin(fa) * r * 0.7, c.y + Math.cos(fa) * r * 0.7);
  }
  mergeStatic(`${name}-tracery`, parts, mats.tracery);
}

/** Candle sources (wax + steady flame) for instancing; instances never flicker or change exposure. */
function candleSources(scene: Scene, mats: GothicMats, name: string): { wax: Mesh; flame: Mesh } {
  const wax = MeshBuilder.CreateCylinder(`${name}-wax-src`, { diameter: 0.1, height: 1, tessellation: 8 }, scene);
  wax.material = mats.wax;
  const flame = MeshBuilder.CreateSphere(`${name}-flame-src`, { diameter: 0.08, segments: 4 }, scene);
  flame.material = mats.flame;
  for (const s of [wax, flame]) {
    s.isVisible = false;
    s.isPickable = false;
  }
  return { wax, flame };
}
function placeCandle(src: { wax: Mesh; flame: Mesh }, name: string, x: number, y: number, z: number, h: number): void {
  const w = src.wax.createInstance(`${name}-wax`);
  w.scaling.y = h;
  w.position.set(x, y + h / 2, z);
  const f = src.flame.createInstance(`${name}-flame`);
  f.scaling.y = 1.6;
  f.position.set(x, y + h + 0.06, z);
  for (const i of [w, f]) freezeStatic(i as unknown as Mesh);
}

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

/**
 * Gothic recolour policy for Kenney kits, by file-name category. Applied ONLY to the materials owned by
 * the freshly loaded AssetContainer (each loadKit call owns its own copies); scene.materials is never
 * iterated. Role kits (pumpkin*, candle*, lantern*, character-*, fire-basket, lightpost*) stay untouched.
 *  - iron:     iron-fence*            → atlas dropped, dark wrought iron (the atlas is neon green/teal)
 *  - deadwood: pine*, trunk*          → atlas dropped, charcoal-brown dead wood (no green foliage)
 *  - stone:    crypt*, column*, pillar*, stone-wall*, brick-wall*, altar-stone, grave*, border-pillar,
 *              urn*, cross-column, cross, rocks* → atlas kept, multiplied to weathered charcoal
 *  - timber:   fence*, cross-wood, bench*, coffin*, debris-wood, altar-wood → atlas kept, aged dark brown
 */
type KitTheme = 'iron' | 'deadwood' | 'stone' | 'timber';
function kitTheme(file: string): KitTheme | null {
  const n = file.replace(/\.glb$/i, '');
  if (/^(pumpkin|candle|lantern|character|fire-basket|lightpost)/.test(n)) return null;
  if (n.startsWith('iron-fence')) return 'iron';
  if (/^(pine|trunk)/.test(n)) return 'deadwood';
  if (/^(crypt|column|pillar|stone-wall|brick-wall|altar-stone|grave|border-pillar|urn|cross-column|rocks)/.test(n) || n === 'cross') return 'stone';
  if (/^(fence|cross-wood|bench|coffin|debris-wood|altar-wood)/.test(n)) return 'timber';
  return null;
}

interface PbrLike { albedoColor?: Color3; albedoTexture?: unknown; metallic?: number | null; roughness?: number | null }
function themeKit(container: AssetContainer, theme: KitTheme): void {
  for (const mat of container.materials) {
    const m = mat as unknown as PbrLike;
    if (!(m.albedoColor instanceof Color3)) continue; // only glTF PBR materials
    if (theme === 'iron' || theme === 'deadwood') {
      m.albedoTexture = null; // texture stays owned by the container; not disposed here
      m.albedoColor = theme === 'iron' ? new Color3(0.055, 0.055, 0.065) : new Color3(0.1, 0.085, 0.075);
      m.metallic = 0;
      m.roughness = 0.92;
    } else {
      m.albedoColor = theme === 'stone' ? new Color3(0.56, 0.54, 0.58) : new Color3(0.5, 0.4, 0.33);
    }
  }
}

/** Loads a Kenney kit GLB into a reusable container; returns null on failure (caller keeps fallback). */
export async function loadKit(scene: Scene, file: string): Promise<AssetContainer | null> {
  try {
    const container = await LoadAssetContainerAsync(KENNEY + file, scene);
    const theme = kitTheme(file);
    if (theme) themeKit(container, theme);
    // Every lantern*/lightpost* container (world, player viewmodel, Halloween props) gets the one cached
    // iron atlas; awaited so callers never placeKit(cloneMaterials) a container still on the green atlas.
    if (/^(lantern|lightpost)/.test(file)) await themeWorldLanterns(scene, [container]);
    return container;
  } catch (err) {
    console.warn('[world] kit model failed', file, err);
    return null;
  }
}

/**
 * Lantern holders (every lantern* / lightpost* kit, via loadKit) use the shared Kenney
 * `colormap` atlas, whose frame texels are a bright green family (e.g. 46,152,114 / 75,181,128 / 90,196,135).
 * Frame and flame share one material slot, so instead of recolouring the material we give World's own
 * containers a remapped COPY of the atlas: only green-dominant texels become shaded dark iron; flame
 * (255,192,68), wax, glass-blue and everything else are untouched. The original PNG and the cached glTF
 * texture are never modified; only each lantern container's own material slots are repointed.
 */
const ironAtlasCache = new WeakMap<Scene, Promise<DynamicTexture | null>>();
function ironAtlas(scene: Scene, src: Texture): Promise<DynamicTexture | null> {
  let p = ironAtlasCache.get(scene);
  if (p) return p;
  p = new Promise<DynamicTexture | null>((resolve) => {
    if (typeof document === 'undefined') return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onerror = () => resolve(null);
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const px = data.data;
        for (let i = 0; i < px.length; i += 4) {
          const r = px[i], g = px[i + 1], b = px[i + 2];
          if (g > r + 35 && g > b + 5) {
            const l = (0.3 * r + 0.59 * g + 0.11 * b) / 255; // keep the atlas shading bands
            px[i] = 10 + l * 48;
            px[i + 1] = 10 + l * 45;
            px[i + 2] = 13 + l * 52;
          }
        }
        ctx.putImageData(data, 0, 0);
        const dt = new DynamicTexture('kit-iron-atlas', canvas, scene, true, src.samplingMode);
        dt.wrapU = src.wrapU;
        dt.wrapV = src.wrapV;
        dt.update(src.invertY);
        resolve(dt);
      } catch (err) {
        console.warn('[world] lantern atlas remap failed', err);
        resolve(null);
      }
    };
    img.src = KENNEY + 'Textures/colormap.png';
  });
  ironAtlasCache.set(scene, p);
  return p;
}

/** Swaps the atlas on World's own lantern containers (before any placement); no-op if the remap fails. */
async function themeWorldLanterns(scene: Scene, containers: Array<AssetContainer | null>): Promise<void> {
  const owned = containers.filter((c): c is AssetContainer => !!c);
  const first = owned.flatMap((c) => c.materials).map((m) => (m as unknown as PbrLike).albedoTexture).find((t): t is Texture => t instanceof Texture);
  if (!first) return;
  const atlas = await ironAtlas(scene, first);
  if (!atlas) return;
  for (const c of owned) {
    for (const mat of c.materials) {
      const m = mat as unknown as PbrLike;
      if (!(m.albedoColor instanceof Color3) || !(m.albedoTexture instanceof Texture)) continue;
      m.albedoTexture = atlas; // old texture stays owned by its container; not disposed
    }
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
  const fog = new Color3(0.04, 0.042, 0.08);
  scene.clearColor = new Color4(fog.r, fog.g, fog.b, 1);
  scene.ambientColor = new Color3(0.08, 0.1, 0.16);
  scene.fogMode = Scene.FOGMODE_EXP2;
  // Thinner haze so the cathedral (29 m from spawn) and its spires/back rose wall read as layered depth.
  scene.fogDensity = 0.018;
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
  // Courtyard cobble, tiled at ~3.5-5 m per repeat (never one 1254 px image stretched over the map).
  const groundW = b.maxX - b.minX + 40;
  const groundD = b.maxZ - b.minZ + 40;
  const ground = MeshBuilder.CreateGround('ground', { width: groundW, height: groundD }, scene);
  ground.material = surfaceMaterial(scene, 'ground-mat', 'cobble', new Color3(0.5, 0.5, 0.54), groundW / 5, groundD / 5);
  freezeStatic(ground);
  // Plaza + processional path in brighter, finer paving so the route to the cathedral steps reads.
  const plazaMat = surfaceMaterial(scene, 'plaza-mat', 'cobble', new Color3(0.82, 0.8, 0.82), 15 / SURFACE_TILE.cobble);
  const plaza = MeshBuilder.CreateDisc('plaza', { radius: 7.5, tessellation: 40 }, scene);
  plaza.rotation.x = Math.PI / 2;
  plaza.position.set(0, 0.02, -6);
  plaza.material = plazaMat;
  freezeStatic(plaza);
  const pathMat = surfaceMaterial(scene, 'stone-mat', 'cobble', new Color3(0.82, 0.8, 0.82));
  for (const [z0, z1] of [[-24, -8], [-4, 6]] as const) {
    const path = tiledBox(scene, `path-${z0}`, 3, 0.04, z1 - z0, SURFACE_TILE.cobble);
    path.position.set(0, 0.015, (z0 + z1) / 2);
    path.material = pathMat;
    freezeStatic(path);
  }

  // Shared obstacles: the chapel is an authored stone cathedral; crypts show a stone box until the kit loads.
  const darkStone = surfaceMaterial(scene, 'dark-stone', 'stone', new Color3(0.62, 0.6, 0.64));
  const fallbacks = new Map<string, TransformNode>();
  for (const o of WORLD.obstacles) {
    if (o.id === 'chapel') {
      buildCathedral(scene, o);
      continue;
    }
    const holder = new TransformNode(`${o.id}-fallback`, scene);
    if (o.id === 'fountain') {
      buildFountain(scene, holder, o);
      continue; // the fountain is procedural by design
    }
    const box = tiledBox(scene, `${o.id}-box`, o.width, o.height, o.depth, SURFACE_TILE.stone);
    box.position.y = o.height / 2;
    box.material = darkStone;
    box.parent = holder;
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
  // The 38 MB wooden haunted_house.glb is intentionally no longer loaded: its timber facade clashed with
  // the gothic silhouette. The authored stone cathedral above occupies the same shared chapel collider.
  report('');
  void dressCourtyard(scene, fallbacks, lampSpots);
  return portal;
}

/**
 * Authored gothic cathedral inside/above the shared chapel collider (x −6..6, z 6..16 at chapel 0,11).
 * Front faces the spawn (−Z). Everything here is visual only and never extends past the footprint in X/Z;
 * the front steps are ornamental (inside the blocked box), not climbable.
 */
function buildCathedral(scene: Scene, o: Obstacle): void {
  const mats = gothicMats(scene);
  const T = SURFACE_TILE.stone;
  const cx = o.x;
  const front = o.z - o.depth / 2; // world z of the footprint front edge (6)
  const back = o.z + o.depth / 2; // 16
  const hw = o.width / 2; // 6
  const naveHalf = 3.6;
  const naveH = 12.5;
  const facadeZ = front + 1.4; // nave facade sits behind three ornamental steps
  const stone: Mesh[] = [];
  const roof: Mesh[] = [];
  const box = (n: string, w: number, h: number, d: number, x: number, y: number, z: number, into = stone) => {
    const m = tiledBox(scene, n, w, h, d, T);
    m.position.set(x, y, z);
    into.push(m);
    return m;
  };

  // Ornamental steps (inside the blocked footprint).
  for (let i = 0; i < 3; i++) {
    const z0 = front + i * 0.45;
    const h = 0.22 * (i + 1);
    box(`cath-step-${i}`, 7.6 - i * 0.4, h, facadeZ - z0, cx, h / 2, (z0 + facadeZ) / 2);
  }
  // Nave, side aisles and the two west-front towers.
  box('cath-nave', naveHalf * 2, naveH, back - facadeZ, cx, naveH / 2, (facadeZ + back) / 2);
  const towerW = 2.4;
  const towerX = hw - towerW / 2; // 4.8
  const towerZ = front + 1.25; // 7.25 (front face at 6.05)
  const aisleH = 6.5;
  for (const s of [-1, 1]) {
    box(`cath-aisle-${s}`, hw - naveHalf, aisleH, back - (towerZ + towerW / 2), cx + s * towerX, aisleH / 2, (towerZ + towerW / 2 + back) / 2);
    box(`cath-tower-${s}`, towerW, 18, towerW, cx + s * towerX, 9, towerZ);
    box(`cath-belfry-${s}`, towerW - 0.5, 3, towerW - 0.5, cx + s * towerX, 19.5, towerZ);
    box(`cath-tower-band-${s}`, towerW + 0.001, 0.35, towerW + 0.001, cx + s * towerX, 12.2, towerZ);
    // Lean-to aisle roof rising toward the nave wall.
    const run = hw - naveHalf;
    const pitch = Math.atan2(1.4, run);
    const slab = box(`cath-aisle-roof-${s}`, Math.hypot(run, 1.4) - 0.1, 0.25, back - (towerZ + towerW / 2), cx + s * (naveHalf + run / 2), aisleH + 0.7, (towerZ + towerW / 2 + back) / 2, roof);
    slab.rotation.z = -s * pitch;
  }
  // Steep nave roof (two slate slabs) and stone gables front and back.
  const rise = 5;
  const pitch = Math.atan2(rise, naveHalf);
  for (const s of [-1, 1]) {
    const slab = box(`cath-roof-${s}`, Math.hypot(naveHalf, rise) + 0.4, 0.3, back - facadeZ + 0.3, cx + s * (naveHalf / 2), naveH + rise / 2, (facadeZ + back) / 2, roof);
    slab.rotation.z = -s * pitch;
  }
  for (const [z, n] of [[facadeZ - 0.01, 'front'], [back + 0.01, 'back']] as const) {
    const gable = flatShape(scene, `cath-gable-${n}`, [[-naveHalf, 0], [naveHalf, 0], [0, rise]], [0, rise / 3]);
    gable.position.set(cx, naveH, z);
    stone.push(gable);
  }
  // Flying buttresses from aisle pinnacles to the clerestory wall.
  for (const s of [-1, 1]) {
    for (const z of [9.6, 12.4, 15.2]) {
      const dx = hw - 0.4 - naveHalf;
      const dy = 3.6;
      const strut = box(`cath-flyer-${s}-${z}`, Math.hypot(dx, dy), 0.32, 0.4, cx + s * (naveHalf + dx / 2), aisleH + 0.6 + dy / 2, z);
      strut.rotation.z = -s * Math.atan2(dy, dx);
      box(`cath-buttress-${s}-${z}`, 0.5, aisleH + 1.2, 0.6, cx + s * (hw - 0.25), (aisleH + 1.2) / 2, z);
    }
  }
  // Portal jamb columns flanking the doorway.
  for (const s of [-1, 1]) box(`cath-portal-col-${s}`, 0.36, 6.4, 0.36, cx + s * 2.05, 3.2, facadeZ - 0.2);
  // The west front faces away from the hemispheric moon (−Z vs +Z-ish direction), so with plain diffuse it
  // read as a near-black slab from spawn. A restrained warm "floodlit" wash: the same tiled stone texture as
  // emissive at low strength keeps mortar/texture detail (not a flat glow) while slate roofs stay dark for
  // silhouette contrast. Steady, no light added, no exposure change.
  const litStone = surfaceMaterial(scene, 'cathedral-stone-lit', 'stone', new Color3(0.86, 0.84, 0.88));
  litStone.emissiveTexture = litStone.diffuseTexture;
  litStone.emissiveColor = new Color3(0.7, 0.46, 0.33);
  mergeStatic('cathedral-stone', stone, litStone);
  mergeStatic('cathedral-roofs', roof, mats.roof);
  // Gold rake moulding up the pointed front gable, so the gothic point reads above the rose.
  const rake = MeshBuilder.CreateTube('cath-gable-rake', {
    path: [new Vector3(-naveHalf - 0.1, 0, 0), new Vector3(0, rise + 0.12, 0), new Vector3(naveHalf + 0.1, 0, 0)],
    radius: 0.12,
    tessellation: 6,
  }, scene);
  rake.position.set(cx, naveH, facadeZ - 0.08);
  rake.material = mats.tracery;
  freezeStatic(rake);

  // Spires and pinnacles (slate), all within the footprint.
  const spireParts: Mesh[] = [];
  const cone = (n: string, d: number, h: number, x: number, y: number, z: number, tess = 8) => {
    const m = MeshBuilder.CreateCylinder(n, { diameterTop: 0, diameterBottom: d, height: h, tessellation: tess }, scene);
    m.position.set(x, y + h / 2, z);
    spireParts.push(m);
  };
  for (const s of [-1, 1]) {
    cone(`cath-spire-${s}`, 2.3, 9, cx + s * towerX, 21, towerZ);
    for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) cone(`cath-pin-${s}-${px}-${pz}`, 0.42, 2.4, cx + s * towerX + px * 1.0, 18, towerZ + pz * 1.0, 4);
    for (const z of [9.6, 12.4, 15.2]) cone(`cath-bpin-${s}-${z}`, 0.45, 2.2, cx + s * (hw - 0.25), aisleH + 1.2, z, 4);
    cone(`cath-portal-pin-${s}`, 0.5, 1.8, cx + s * 2.05, 6.4, facadeZ - 0.2, 4);
  }
  cone('cath-fleche', 1.3, 8.5, cx, naveH + rise - 0.6, o.z + 1.5);
  cone('cath-gable-finial', 0.5, 1.6, cx, naveH + rise - 0.2, facadeZ - 0.05, 4);
  mergeStatic('cathedral-spires', spireParts, mats.roof);

  // Pointed portal: dark recess with an ember glow, double arch moulding.
  const portalW = 2.8;
  const portalSpring = 3.0;
  const recess = flatShape(scene, 'cath-portal-recess', lancetOutline(portalW, portalSpring), [0, portalSpring * 0.6]);
  recess.position.set(cx, 0.66, facadeZ - 0.02);
  // Weathered aged-wood door leaves (UVs tile per stone metre → 3/2 = 2 m wood repeat); the same grain
  // modulates the existing ember glow so the door reads as dark planks, not a flat red fill.
  const recessMat = surfaceMaterial(scene, 'cathedral-portal', 'wood', new Color3(0.16, 0.11, 0.09), SURFACE_TILE.stone / SURFACE_TILE.wood);
  recessMat.emissiveColor = new Color3(0.32, 0.09, 0.035);
  recessMat.emissiveTexture = recessMat.diffuseTexture;
  recess.material = recessMat;
  freezeStatic(recess);
  const mould = [0, 1].map((k) =>
    MeshBuilder.CreateTube(`cath-portal-mould-${k}`, { path: lancetPath(portalW + 0.3 + k * 0.45, portalSpring, 0), radius: 0.11 + k * 0.03, tessellation: 6 }, scene),
  );
  mould.forEach((m, k) => m.position.set(cx, 0.66, facadeZ - 0.06 - k * 0.06));
  mergeStatic('cathedral-portal-mould', mould, mats.tracery);

  // Rose window above the portal and lancet tracery on towers, clerestory and aisles.
  buildRose(scene, 'cath-rose', new Vector3(cx, 9.4, facadeZ - 0.03), 2.15, mats);
  const towerLancet = lancetKit(scene, 'cath-tower-lancet', 1.0, 2.4, mats);
  const clerestory = lancetKit(scene, 'cath-clerestory', 1.1, 2.4, mats);
  const aisleLancet = lancetKit(scene, 'cath-aisle-lancet', 0.9, 1.8, mats);
  for (const s of [-1, 1]) {
    for (const y of [6.2, 12.9]) placeLancet(towerLancet, `cath-tower-win-${s}-${y}`, cx + s * towerX, y, towerZ - towerW / 2 - 0.02);
    // Side faces: local −Z → outward (±X).
    const yaw = s < 0 ? Math.PI / 2 : -Math.PI / 2;
    for (const z of [11, 13.8]) placeLancet(clerestory, `cath-clere-${s}-${z}`, cx + s * (naveHalf + 0.02), 8.0, z, yaw);
    for (const z of [11, 13.8]) placeLancet(aisleLancet, `cath-aisle-win-${s}-${z}`, cx + s * (hw + 0.02), 1.7, z, yaw);
  }

  // Crimson banners with gold roundels between portal and towers; hanging gold lanterns at the portal.
  for (const s of [-1, 1]) {
    const banner = MeshBuilder.CreatePlane(`cath-banner-${s}`, { width: 0.95, height: 3.4 }, scene);
    banner.position.set(cx + s * 2.85, 4.6, facadeZ - 0.04);
    banner.material = mats.cloth;
    const sigil = MeshBuilder.CreateDisc(`cath-banner-sigil-${s}`, { radius: 0.26, tessellation: 16, sideOrientation: Mesh.DOUBLESIDE }, scene);
    sigil.position.set(cx + s * 2.85, 5.1, facadeZ - 0.06);
    sigil.material = mats.goldGlass;
    const lantern = MeshBuilder.CreateBox(`cath-lantern-${s}`, { width: 0.26, height: 0.4, depth: 0.26 }, scene);
    lantern.position.set(cx + s * 2.05, 3.3, facadeZ - 0.58);
    lantern.material = mats.goldGlass;
    for (const m of [banner, sigil, lantern]) freezeStatic(m);
  }

  // Steady candle rows on the ornamental steps (instanced), leaving the centre aisle dark stone.
  const candles = candleSources(scene, mats, 'cath-candle');
  const rand = seeded(611);
  for (let i = 0; i < 3; i++) {
    const y = 0.22 * (i + 1);
    const z = front + i * 0.45 + 0.18;
    for (const x of [-3.4, -2.8, -2.2, -1.6, 1.6, 2.2, 2.8, 3.4]) {
      if (Math.abs(x) > 3.8 - i * 0.2) continue;
      placeCandle(candles, `cath-candle-${i}-${x}`, cx + x + (rand() - 0.5) * 0.15, y, z, 0.16 + rand() * 0.26);
    }
  }

  // Steady warm-crimson glow pool before the steps. Deliberately NOT a PointLight: StandardMaterial caps at
  // 4 lights and the moon, two lamps, the Halloween gate glow and the hunter lantern already compete.
  const pool = MeshBuilder.CreateGround('cathedral-glow-pool', { width: 9, height: 5 }, scene);
  pool.position.set(cx, 0.045, front - 1.4);
  const poolMat = flatMaterial(scene, 'cathedral-glow-pool-mat', Color3.Black(), new Color3(0.42, 0.14, 0.06));
  poolMat.disableLighting = true;
  poolMat.opacityTexture = softParticleTexture(scene);
  poolMat.alphaMode = Constants.ALPHA_ADD;
  poolMat.disableDepthWrite = true;
  pool.material = poolMat;
  freezeStatic(pool);
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
  const stone = surfaceMaterial(scene, 'fountain-stone', 'stone', new Color3(0.8, 0.78, 0.82), (Math.PI * o.width) / SURFACE_TILE.stone, 0.6);
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

  // Ruined chapel courtyard: broken gothic arcade with pointed arches, back wall with traceried
  // crimson lancets and a rose window. Stone is real tiled texture; pieces are merged per material.
  const mats = gothicMats(scene);
  const ruin = surfaceMaterial(scene, 'ruin-stone', 'stone', new Color3(0.72, 0.7, 0.75));
  const ruinParts: Mesh[] = [];
  const rand = seeded(2027);
  const C = Z.ruinedChapel;
  const archW = 6 - 1.1;
  const archSrc = MeshBuilder.CreateTube('ruin-arch-src', { path: lancetPath(archW, 0, 0).slice(1, -1), radius: 0.38, tessellation: 8 }, scene);
  archSrc.material = ruin;
  archSrc.isVisible = false;
  archSrc.isPickable = false;
  for (const side of [-1, 1]) {
    const x = side * C.arcadeX;
    for (let z = C.arcadeZ[0], k = 0; z <= C.arcadeZ[1]; z += 6, k++) {
      const broken = (k + (side > 0 ? 1 : 0)) % 3 === 2;
      const h = broken ? 2.5 + rand() * 2 : 7.5;
      const p = tiledBox(scene, `ruin-pillar-${side}-${z}`, 1.1, h, 1.1, SURFACE_TILE.stone);
      p.position.set(x, h / 2, z);
      ruinParts.push(p);
      if (!broken) {
        const capital = tiledBox(scene, `ruin-capital-${side}-${z}`, 1.5, 0.35, 1.5, SURFACE_TILE.stone);
        capital.position.set(x, h - 0.1, z);
        ruinParts.push(capital);
      }
      if (!broken && z + 6 <= C.arcadeZ[1] && (k + 1 + (side > 0 ? 1 : 0)) % 3 !== 2) {
        const a = archSrc.createInstance(`ruin-arch-${side}-${z}`);
        a.rotation.y = Math.PI / 2; // pointed arch spanning along Z
        a.position.set(x, 7.4, z + 3);
        freezeStatic(a as unknown as Mesh);
      }
    }
  }
  // Back wall: segments with gaps (broken), traceried lancets lit crimson from behind, rose above.
  const lancet = lancetKit(scene, 'ruin-lancet', 1.4, 3.0, mats);
  buildRose(scene, 'ruin-rose', new Vector3(0, 11.6, C.backWallZ - 0.62), 2.6, mats);
  for (let x = -22; x <= 22; x += 4) {
    const gap = Math.abs(x) === 14; // collapsed sections the eye reads through
    const h = gap ? 2 : Math.abs(x) < 7 ? 15 : 10 - (Math.abs(x) % 8) * 0.4;
    const w = tiledBox(scene, `ruin-wall-${x}`, 4, h, 1.2, SURFACE_TILE.stone);
    w.position.set(x, h / 2, C.backWallZ);
    ruinParts.push(w);
    if (!gap && h > 8 && Math.abs(x) >= 4) placeLancet(lancet, `ruin-lancet-${x}`, x, 3.0, C.backWallZ - 0.62);
  }
  // Gable peak and twin pinnacles crowning the central (tallest) wall section.
  const peak = flatShape(scene, 'ruin-gable', [[-6, 0], [6, 0], [0, 4.5]], [0, 1.5]);
  peak.position.set(0, 15, C.backWallZ);
  ruinParts.push(peak);
  mergeStatic('ruin-stone-merged', ruinParts, ruin);
  const pins: Mesh[] = [];
  for (const x of [-6, 6, 0]) {
    const pin = MeshBuilder.CreateCylinder(`ruin-pin-${x}`, { diameterTop: 0, diameterBottom: x === 0 ? 0.9 : 1.1, height: x === 0 ? 3 : 5, tessellation: 4 }, scene);
    pin.position.set(x, x === 0 ? 19.5 + 1.5 : 15 + 2.5, C.backWallZ - 0.3);
    pins.push(pin);
  }
  mergeStatic('ruin-pinnacles', pins, mats.roof);

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
  // Radial gold rune spokes between the rings and a ring of steady ritual candles (instanced).
  const spokeSrc = MeshBuilder.CreateBox('altar-spoke-src', { width: 0.08, height: 0.02, depth: 1.9 }, scene);
  spokeSrc.material = gold;
  spokeSrc.isVisible = false;
  const ritual = candleSources(scene, mats, 'altar-candle');
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r = E.runeRadius - 1.1;
    const s = spokeSrc.createInstance(`altar-spoke-${i}`);
    s.position.set(E.x + Math.cos(a) * r, 0.03, E.z + Math.sin(a) * r);
    s.rotation.y = Math.atan2(Math.cos(a), Math.sin(a));
    freezeStatic(s as unknown as Mesh);
    const ca = a + Math.PI / 12;
    placeCandle(ritual, `altar-candle-${i}`, E.x + Math.cos(ca) * (E.runeRadius - 1.1), 0, E.z + Math.sin(ca) * (E.runeRadius - 1.1), 0.25 + (i % 3) * 0.12);
  }
  const obelisk = MeshBuilder.CreateCylinder('altar-obelisk-src', { diameterTop: 0.25, diameterBottom: 1.1, height: 7, tessellation: 4 }, scene);
  obelisk.material = surfaceMaterial(scene, 'obelisk-stone', 'stone', new Color3(0.72, 0.7, 0.75), 1, 7 / SURFACE_TILE.stone);
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
