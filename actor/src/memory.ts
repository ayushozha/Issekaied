/**
 * Pure memory reducers shared by the Terse actors (actor.ts) and the server's explicit
 * local-file fallback. Everything here is deterministic JSON-in / JSON-out so the actor
 * can persist by reassigning one `@Persisted` field, and the same logic can be unit-tested
 * on any Bun version. The string unions mirror shared/protocol.ts; they are repeated here
 * so the actor project stays self-contained for `terse deploy`.
 */
export type PowerId = 'ganesha' | 'hanuman' | 'shiva' | 'vishnu';
export type GhostStrategy = 'chase' | 'flank' | 'keep_distance' | 'ambush';
export const STRATEGIES: readonly GhostStrategy[] = ['chase', 'flank', 'keep_distance', 'ambush'];

const MAX_EPISODES = 60;
const MAX_SEEN = 300;
const MAX_LORE = 40;
const MAX_RECENT = 120;

export interface Episode {
  eventId: string;
  at: number;
  roomId: string;
  kind: 'banished' | 'returned' | 'killed_hunter';
  hunterId: string;
  hunterName: string;
  power?: PowerId;
  /** Where the ghost stood relative to the hunter when the episode ended (meters). */
  distance?: number;
  tactic?: GhostStrategy;
}

export interface Grudge {
  hunterId: string;
  hunterName: string;
  banishments: number;
  killedHunter: number;
  lastPower?: PowerId;
  lastAt: number;
  lastRoomId: string;
  powers: Partial<Record<PowerId, number>>;
}

export interface LoreEntry {
  text: string;
  eventIds: string[];
  at: number;
}

export interface GhostMemory {
  version: number;
  banishments: number;
  kills: number;
  strategy: GhostStrategy;
  grudges: Record<string, Grudge>;
  episodes: Episode[];
  lore: LoreEntry[];
  /** Event ids already applied; protects against duplicate or replayed deliveries. */
  seen: string[];
}

export const EMPTY_GHOST: GhostMemory = {
  version: 1,
  banishments: 0,
  kills: 0,
  strategy: 'chase',
  grudges: {},
  episodes: [],
  lore: [],
  seen: [],
};

export interface Recall {
  known: boolean;
  grudge?: Grudge;
  episodes: Episode[];
  /** Tactic the ghost should adopt against this hunter, derived from remembered facts. */
  tactic: GhostStrategy;
  summary: string;
}

const DEITY_NAME: Record<PowerId, string> = { ganesha: 'Ganesha', hanuman: 'Hanuman', shiva: 'Shiva', vishnu: 'Vishnu' };

/** Deterministic counter-tactic for the power that last banished a ghost. */
export const counterStrategy = (power: PowerId): GhostStrategy =>
  power === 'ganesha' ? 'keep_distance' : power === 'hanuman' ? 'flank' : power === 'shiva' ? 'ambush' : 'chase';

const seenBefore = (m: GhostMemory | DeityMemory, eventId: string) => m.seen.includes(eventId);
const remember = (seen: string[], eventId: string) => [...seen, eventId].slice(-MAX_SEEN);
const bounded = <T>(list: T[], max: number) => (list.length > max ? list.slice(list.length - max) : list);

function withEpisode(m: GhostMemory, ep: Episode): GhostMemory {
  return { ...m, episodes: bounded([...m.episodes, ep], MAX_EPISODES), seen: remember(m.seen, ep.eventId) };
}

function bumpGrudge(m: GhostMemory, ep: Episode, field: 'banishments' | 'killedHunter'): Record<string, Grudge> {
  const prev = m.grudges[ep.hunterId] ?? {
    hunterId: ep.hunterId,
    hunterName: ep.hunterName,
    banishments: 0,
    killedHunter: 0,
    lastAt: 0,
    lastRoomId: ep.roomId,
    powers: {},
  };
  const powers = ep.power ? { ...prev.powers, [ep.power]: (prev.powers[ep.power] ?? 0) + 1 } : prev.powers;
  return {
    ...m.grudges,
    [ep.hunterId]: {
      ...prev,
      hunterName: ep.hunterName,
      [field]: prev[field] + 1,
      lastPower: ep.power ?? prev.lastPower,
      lastAt: ep.at,
      lastRoomId: ep.roomId,
      powers,
    },
  };
}

/** A hunter banished this ghost. Idempotent per eventId. */
export function applyBanishment(m: GhostMemory, ep: Omit<Episode, 'kind'>): GhostMemory {
  if (seenBefore(m, ep.eventId)) return m;
  const episode: Episode = { ...ep, kind: 'banished' };
  const next = withEpisode(m, episode);
  return {
    ...next,
    version: m.version + 1,
    banishments: m.banishments + 1,
    grudges: bumpGrudge(m, episode, 'banishments'),
    strategy: ep.power ? counterStrategy(ep.power) : m.strategy,
  };
}

/** This ghost killed a hunter. Idempotent per eventId. */
export function applyKill(m: GhostMemory, ep: Omit<Episode, 'kind' | 'power'>): GhostMemory {
  if (seenBefore(m, ep.eventId)) return m;
  const episode: Episode = { ...ep, kind: 'killed_hunter' };
  return { ...withEpisode(m, episode), version: m.version + 1, kills: m.kills + 1, grudges: bumpGrudge(m, episode, 'killedHunter') };
}

/** The ghost returned to the world (recorded so lore can cite it). Idempotent per eventId. */
export function applyReturn(m: GhostMemory, ep: Omit<Episode, 'kind'>): GhostMemory {
  if (seenBefore(m, ep.eventId)) return m;
  return { ...withEpisode(m, { ...ep, kind: 'returned' }), version: m.version + 1 };
}

/** Adopt a validated strategy (from rehearsal, a hivemind warning, or an NPC mind). */
export function withStrategy(m: GhostMemory, strategy: GhostStrategy, eventId: string): GhostMemory {
  if (!STRATEGIES.includes(strategy)) return m;
  if (m.strategy === strategy && seenBefore(m, eventId)) return m;
  return { ...m, version: m.version + 1, strategy, seen: remember(m.seen, eventId) };
}

export function withLore(m: GhostMemory, text: string, eventIds: string[], at: number): GhostMemory {
  const entry: LoreEntry = { text: text.slice(0, 400), eventIds: eventIds.slice(0, 8), at };
  return { ...m, version: m.version + 1, lore: bounded([...m.lore, entry], MAX_LORE) };
}

/** What this ghost remembers about one hunter, plus the tactic those memories imply. */
export function recall(m: GhostMemory, hunterId: string, limit = 6): Recall {
  const grudge = m.grudges[hunterId];
  const episodes = m.episodes.filter((e) => e.hunterId === hunterId).slice(-limit);
  if (!grudge) return { known: false, episodes, tactic: m.strategy, summary: 'No memory of this hunter.' };
  const favourite = (Object.entries(grudge.powers) as [PowerId, number][]).sort((a, b) => b[1] - a[1])[0]?.[0] ?? grudge.lastPower;
  const tactic = favourite ? counterStrategy(favourite) : m.strategy;
  const summary =
    `${grudge.hunterName} banished me ${grudge.banishments} time${grudge.banishments === 1 ? '' : 's'}` +
    (favourite ? `, mostly through ${DEITY_NAME[favourite]}` : '') +
    (grudge.killedHunter ? `; I have felled them ${grudge.killedHunter} time${grudge.killedHunter === 1 ? '' : 's'}` : '') +
    `. Last met in ${grudge.lastRoomId}.`;
  return { known: true, grudge, episodes, tactic, summary };
}

/** Short public summary used by prompts and health; never includes raw event payloads. */
export function ghostSummary(m: GhostMemory): string {
  const hunters = Object.values(m.grudges).sort((a, b) => b.banishments - a.banishments).slice(0, 3);
  return (
    `Banished ${m.banishments} time${m.banishments === 1 ? '' : 's'}, felled ${m.kills} hunter${m.kills === 1 ? '' : 's'}; current tactic ${m.strategy}.` +
    (hunters.length ? ` Grudges: ${hunters.map((h) => `${h.hunterName} (${h.banishments})`).join(', ')}.` : '')
  );
}

// ---- deities ------------------------------------------------------------------------------------

export interface Invocation {
  eventId: string;
  at: number;
  roomId: string;
  hunterId: string;
  hunterName: string;
  enemyId: string;
  enemyLevel: number;
  banished: boolean;
}

export interface DeityHunter {
  name: string;
  invocations: number;
  banishments: number;
  lastSeen: number;
  rooms: string[];
}

export interface DeityMemory {
  version: number;
  invocations: number;
  banishments: number;
  rooms: Record<string, number>;
  hunters: Record<string, DeityHunter>;
  /** Recent event ids the deity can cite. */
  recent: string[];
  seen: string[];
}

export const EMPTY_DEITY: DeityMemory = { version: 1, invocations: 0, banishments: 0, rooms: {}, hunters: {}, recent: [], seen: [] };

export function applyInvocation(d: DeityMemory, inv: Invocation): DeityMemory {
  if (seenBefore(d, inv.eventId)) return d;
  const prev = d.hunters[inv.hunterId] ?? { name: inv.hunterName, invocations: 0, banishments: 0, lastSeen: 0, rooms: [] };
  const rooms = prev.rooms.includes(inv.roomId) ? prev.rooms : [...prev.rooms, inv.roomId].slice(-12);
  return {
    ...d,
    version: d.version + 1,
    invocations: d.invocations + 1,
    banishments: d.banishments + (inv.banished ? 1 : 0),
    rooms: { ...d.rooms, [inv.roomId]: (d.rooms[inv.roomId] ?? 0) + 1 },
    hunters: {
      ...d.hunters,
      [inv.hunterId]: { name: inv.hunterName, invocations: prev.invocations + 1, banishments: prev.banishments + (inv.banished ? 1 : 0), lastSeen: inv.at, rooms },
    },
    recent: bounded([...d.recent, inv.eventId], MAX_RECENT),
    seen: remember(d.seen, inv.eventId),
  };
}

export function applyInvocations(d: DeityMemory, batch: Invocation[]): DeityMemory {
  return batch.reduce(applyInvocation, d);
}

/** Bounded context a deity shares with a hunter who just joined, across every room it has seen. */
export function deityContext(d: DeityMemory, hunterId?: string): { known: boolean; summary: string; citedEventIds: string[] } {
  const roomCount = Object.keys(d.rooms).length;
  const hunter = hunterId ? d.hunters[hunterId] : undefined;
  const base = `Answered ${d.invocations} invocation${d.invocations === 1 ? '' : 's'} and ${d.banishments} banishment${d.banishments === 1 ? '' : 's'} across ${roomCount} room${roomCount === 1 ? '' : 's'}.`;
  if (!hunter) return { known: false, summary: base, citedEventIds: d.recent.slice(-3) };
  return {
    known: true,
    summary: `${base} ${hunter.name} has drawn on this power ${hunter.invocations} time${hunter.invocations === 1 ? '' : 's'} in ${hunter.rooms.join(', ')}.`,
    citedEventIds: d.recent.slice(-3),
  };
}
