import worldJson from '../../shared/world.json';
import type { Species, Vec3 } from '../../shared/protocol';

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

/** Shared world definition (coordinator-owned JSON). The client collides against the same boxes. */
export const WORLD = worldJson as unknown as WorldDef;
export const ADVENTURE = WORLD.adventure;

export const PLAYER_RADIUS = WORLD.playerRadius;
export const ENEMY_RADIUS = 0.5;
/** Haunts stop here: close enough to strike, never inside the hunter's near-camera volume. */
export const MELEE_STOP = PLAYER_RADIUS + ENEMY_RADIUS + 0.9;
export const MELEE_REACH = MELEE_STOP + 0.4;
/** Minimum spacing between two haunts so they never stack into one silhouette. */
export const ENEMY_SPACING = 1.0;
export const EYE_HEIGHT = WORLD.spawn[1];
export const ENEMY_Y = 1.2;

export interface XZ { x: number; z: number }

export const xz = (v: Vec3): XZ => ({ x: v[0], z: v[2] });
export const dist2d = (a: XZ, b: XZ): number => Math.hypot(a.x - b.x, a.z - b.z);
/** Inside the safe gate area: haunts never target or follow hunters here. */
export const inSafeZone = (p: XZ): boolean => dist2d(p, xz(WORLD.spawn)) <= ADVENTURE.safeSpawnRadius;
export const nearLandmark = (p: XZ, l: Landmark): boolean => dist2d(p, xz(l.position)) <= l.radius;

/** Push a circle of `radius` out of every shared obstacle and clamp to bounds. Mutates `pos`. Mirrors client/src/world.ts. */
export function resolveCollisions(pos: XZ, radius: number): void {
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

/** Keep `pos` within `radius` of `home` (encounter boundary). Mutates `pos`. */
export function clampToCircle(pos: XZ, home: XZ, radius: number): void {
  const d = dist2d(pos, home);
  if (d <= radius) return;
  pos.x = home.x + ((pos.x - home.x) / d) * radius;
  pos.z = home.z + ((pos.z - home.z) / d) * radius;
}

/** Deterministic spawn slot so simultaneous hunters do not stack on the gate. */
export function spawnSlot(index: number): XZ {
  const col = (index % 7) - 3;
  const row = Math.floor(index / 7) % 4;
  return { x: WORLD.spawn[0] + col * 1.2, z: WORLD.spawn[2] - row * 1.2 };
}
