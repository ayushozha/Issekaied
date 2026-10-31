/**
 * Ghost-tactic rehearsal and echo-encounter planning: deterministic, dependency-free scorers. This file
 * is also shipped verbatim (transpiled to JS) into a Superserve microVM by integrations/rehearsal.ts, so
 * it must not import anything. The authoritative room validates and clamps whatever comes back.
 */
export type RehearsalPower = 'ganesha' | 'hanuman' | 'shiva' | 'vishnu';
export type RehearsalStrategy = 'chase' | 'flank' | 'keep_distance' | 'ambush';

export interface RehearsalEpisode {
  ghostId: string;
  level: number;
  hunterId: string;
  /** Power that banished the ghost this time. */
  power: RehearsalPower;
  /** Distance between ghost and hunter at banishment (meters). */
  distance: number;
  /** Earlier banishments by this hunter: power used and distance. */
  history: { power: RehearsalPower; distance: number }[];
  strategies: RehearsalStrategy[];
}

export interface RehearsalResult {
  strategy: RehearsalStrategy;
  scores: Record<RehearsalStrategy, number>;
  rationale: string;
}

/** Input for one echo trial: every haunt with the recorded banishments the current hunters inflicted on it. */
export interface EncounterBlueprint {
  echo: number;
  enemies: { id: string; level: number; history: { power: RehearsalPower; distance: number }[]; strategies: RehearsalStrategy[] }[];
}

export interface EncounterPlan {
  echo: number;
  enemies: { id: string; strategy: RehearsalStrategy; hpMul: number; speedMul: number; aggroBonus: number }[];
  rationale: string;
}

const RANGE: Record<RehearsalPower, number> = { ganesha: 8, hanuman: 12, shiva: 9, vishnu: 22 };
const DPS: Record<RehearsalPower, number> = { ganesha: 30 / 4, hanuman: 22 / 2.2, shiva: 26 / 5, vishnu: 36 / 3.5 };
const ALL: RehearsalStrategy[] = ['chase', 'flank', 'keep_distance', 'ambush'];
const LIMITS = { hpMul: 1.5, speedMul: 1.3, aggroBonus: 4 };
const powerForLevel = (level: number): RehearsalPower => (level <= 2 ? 'ganesha' : level <= 4 ? 'hanuman' : level <= 7 ? 'shiva' : 'vishnu');

/** Expected damage taken before reaching melee for each approach, lower is better; returned as survivability scores. */
export function scoreTactics(ep: RehearsalEpisode): RehearsalResult {
  const allowed = ep.strategies.filter((s) => ALL.includes(s));
  const strategies = allowed.length ? allowed : ALL;
  const hp = 60 + ep.level * 12;
  const speed = (2.2 + ep.level * 0.15) * 0.8; // hunters keep some distance; discount closing speed
  const powers = [ep.power, ...ep.history.map((h) => h.power)];
  const weight = (p: RehearsalPower) => powers.filter((q) => q === p).length / powers.length;
  const longReach = weight('vishnu');
  const shortReach = weight('ganesha') + weight('shiva');
  const knockback = weight('hanuman');
  const engageDist = [ep.distance, ...ep.history.map((h) => h.distance)].reduce((a, b) => a + b, 0) / (ep.history.length + 1);
  const expectedDamage = (p: RehearsalPower, seconds: number, exposure: number) => DPS[p] * seconds * exposure;
  const scores = {} as Record<RehearsalStrategy, number>;
  for (const s of strategies) {
    let survivability = hp;
    for (const p of [ep.power, ...ep.history.map((h) => h.power)]) {
      const w = 1 / powers.length;
      const approach = Math.max(0.5, engageDist - 1.85) / speed;
      switch (s) {
        case 'chase':
          survivability -= w * expectedDamage(p, approach, 1);
          break;
        case 'flank':
          // Longer path but the hunter's aim cone misses more often; knockback matters less off-axis.
          survivability -= w * expectedDamage(p, approach * 1.35, 0.65 - 0.15 * knockback);
          break;
        case 'keep_distance':
          // Hovering at 9 to 12 m is outside short powers entirely and only partly inside long ones,
          // but the haunt rarely lands its own hit, which costs it a flat amount per encounter.
          survivability -= w * (expectedDamage(p, approach, RANGE[p] < 10 ? 0 : 0.6) + (RANGE[p] < 10 ? 8 : 0));
          break;
        case 'ambush':
          // Waits beyond 9 m, then closes at 1.6x: half the exposure window, but long reach still finds it.
          survivability -= w * expectedDamage(p, approach / 1.6, 0.5 + 0.3 * longReach);
          break;
      }
    }
    scores[s] = Math.round(survivability * 10) / 10;
  }
  const best = strategies.slice().sort((a, b) => scores[b] - scores[a] || ALL.indexOf(a) - ALL.indexOf(b))[0];
  const rationale =
    `${ep.ghostId} (level ${ep.level}) vs ${ep.hunterId}: ${powers.length} banishment${powers.length === 1 ? '' : 's'}, ` +
    `${shortReach > 0.5 ? 'mostly short-reach powers' : longReach > 0.5 ? 'mostly long-reach powers' : 'mixed powers'}, ` +
    `average engagement ${engageDist.toFixed(1)} m. Best rehearsed tactic: ${best.replace('_', ' ')}.`;
  return { strategy: best, scores, rationale };
}

/**
 * Plan one echo trial: per haunt, the tactic rehearsed against what the hunters actually did to it, plus
 * bounded scaling that grows with the echo number. Everything is clamped here and again by the room.
 */
export function scoreEncounter(bp: EncounterBlueprint): EncounterPlan {
  const echo = Math.max(1, Math.floor(bp.echo));
  const enemies = bp.enemies.slice(0, 16).map((e, i) => {
    const history = e.history.slice(-8);
    const last = history[history.length - 1];
    const episode: RehearsalEpisode = {
      ghostId: e.id,
      level: e.level,
      hunterId: 'echo',
      power: last?.power ?? powerForLevel(e.level),
      distance: last?.distance ?? 6 + ((echo + i) % 3) * 3,
      history: history.slice(0, -1),
      strategies: e.strategies,
    };
    const { strategy } = scoreTactics(episode);
    return {
      id: e.id,
      strategy,
      hpMul: Math.min(LIMITS.hpMul, 1 + 0.2 * echo),
      speedMul: Math.min(LIMITS.speedMul, 1 + 0.08 * echo),
      aggroBonus: Math.min(LIMITS.aggroBonus, echo),
    };
  });
  return { echo, enemies, rationale: `Echo ${echo}: ${enemies.map((e) => `${e.id}→${e.strategy.replace('_', ' ')}`).join(', ')}; haunts ${Math.round((enemies[0]?.hpMul ?? 1) * 100)}% vitality.` };
}
