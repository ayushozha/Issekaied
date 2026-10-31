import type { PowerId, Vec3 } from '../../shared/protocol';

/**
 * Bounded, deterministic combat constants owned by the server; the client only renders what it is told.
 *
 * Hunter actions (shared CombatAction):
 *   primary      LMB  aimed strike, short cooldown, modest damage, long reach
 *   secondary    RMB  ward: halves incoming damage for a while and repels haunts already in your face
 *   incantation  Q    the automatic level-based deity power (per-deity cooldowns below)
 *   heal         R    recovery mantra, bounded healing on a long cooldown
 */
export interface PowerSpec { cooldownMs: number; range: number; damage: number }

export const POWERS: Record<PowerId, PowerSpec> = {
  ganesha: { cooldownMs: 4000, range: 8, damage: 30 }, // protective shockwave: also wards the hunter
  hanuman: { cooldownMs: 2200, range: 12, damage: 22 }, // wind strike: knocks the haunt back
  shiva: { cooldownMs: 5000, range: 9, damage: 26 }, // icy pulse: slows the haunt
  vishnu: { cooldownMs: 3500, range: 22, damage: 36 }, // returning chakra: longest reach
};

export const PRIMARY = { cooldownMs: 600, range: 18, damage: 14 };
export const WARD = { cooldownMs: 8000, durationMs: 4000, repelRadius: 3, repelM: 2, damageFactor: 0.5 };
export const HEAL = { cooldownMs: 12000, amount: 35 };

export const DEITY_NAME: Record<PowerId, string> = { ganesha: 'Ganesha', hanuman: 'Hanuman', shiva: 'Shiva', vishnu: 'Vishnu' };

export const SHIVA_SLOW_MS = 3000;
export const SHIVA_SLOW_FACTOR = 0.4;
export const HANUMAN_KNOCKBACK_M = 2.5;
export const GANESHA_WARD_MS = 4000;

export const PLAYER_MAX_HP = 100;
/** Minimum spacing between accepted actions of any kind, independent of per-action cooldowns. */
export const CAST_MIN_INTERVAL_MS = 150;
/** Movement intent older than this is dropped so a lost tab never leaves a hunter walking. */
export const STALE_INPUT_MS = 400;
/** No input at all for this long marks the hunter inactive (treated like paused). */
export const IDLE_INACTIVE_MS = 5000;
export const TARGET_MIN_DIST = 0.5;
export const TARGET_MAX_DIST = 45;
export const SHRINE_COOLDOWN_MS = 20000;
export const PORTAL_COOLDOWN_MS = 10000;

export const ENEMY_ATTACK_INTERVAL_MS = 800;
export const ENEMY_RETURNING_MS = 1500;
export const ENEMY_PATROL_RADIUS = 2.5;
/** Banished haunts come back after 8 to 12 seconds, scaling with level. */
export const returnDelayMs = (level: number): number => Math.min(12000, 8000 + level * 400);
export const enemyMaxHp = (level: number): number => 60 + level * 12;
export const enemySpeed = (level: number): number => 2.2 + level * 0.15;
export const contactDamage = (level: number): number => 4 + Math.round(level * 0.6);

/** Echo trials scale encounters within hard bounds; the plan from rehearsal is clamped to these too. */
export const ECHO_LIMITS = { hpMul: 1.5, speedMul: 1.3, aggroBonus: 4 };
export const defaultEchoScaling = (echo: number) => ({
  hpMul: Math.min(ECHO_LIMITS.hpMul, 1 + 0.2 * echo),
  speedMul: Math.min(ECHO_LIMITS.speedMul, 1 + 0.08 * echo),
  aggroBonus: Math.min(ECHO_LIMITS.aggroBonus, echo),
});

/** Minimum cosine between aim and the direction to a haunt for it to count as targeted (same rule as the client HUD). */
export const aimThreshold = (dist: number): number => (dist < 6 ? 0.93 : 0.985);

export interface Targetable { position: Vec3; state: string; level: number }

/** Picks the haunt nearest the aim ray inside a narrow cone. Banished haunts are never targets. */
export function pickTarget<T extends Targetable>(origin: Vec3, aim: Vec3, candidates: Iterable<T>): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    if (c.state === 'banished') continue;
    const dx = c.position[0] - origin[0];
    const dy = c.position[1] - origin[1];
    const dz = c.position[2] - origin[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist < TARGET_MIN_DIST || dist > TARGET_MAX_DIST) continue;
    const cos = (dx * aim[0] + dy * aim[1] + dz * aim[2]) / dist;
    if (cos < aimThreshold(dist)) continue;
    const score = cos - dist * 0.002;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}
