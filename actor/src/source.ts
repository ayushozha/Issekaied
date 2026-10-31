import { Actor, Persisted } from 'terse-sdk/actor';

/**
 * The Source: one global, persistent, omniscient narrator (canonical actor id "global-source").
 * Its ledger is built ONLY from authoritative game events the server records (join, death,
 * banishment, quest, portal). Chat, Relay messages and model output never reach this actor.
 *
 * The whole ledger is one `@Persisted` field, reassigned by pure synchronous reducers. Every
 * dictionary is keyed via `key()` and read with own-property checks, so ids such as "__proto__"
 * or "constructor" can never touch Object.prototype.
 */
export type SourceEventKind = 'join' | 'death' | 'banishment' | 'quest' | 'portal';
export const SOURCE_EVENT_KINDS: readonly SourceEventKind[] = ['join', 'death', 'banishment', 'quest', 'portal'];

export interface SourceEvent {
  eventId: string;
  kind: SourceEventKind;
  at: number;
  roomId: string;
  playerId: string;
  playerName: string;
  subjectId?: string;
  subjectName?: string;
}

export type SourceCounts = Record<SourceEventKind, number>;

export interface SourcePlayerRecord {
  playerId: string;
  playerName: string;
  counts: SourceCounts;
  firstAt: number;
  lastAt: number;
  lastRoomId: string;
}

export interface SourceFact {
  eventId: string;
  kind: SourceEventKind;
  at: number;
  roomId: string;
  playerId: string;
  playerName: string;
  subjectId?: string;
  subjectName?: string;
}

export interface SourceLedger {
  version: number;
  counts: SourceCounts;
  players: Record<string, SourcePlayerRecord>;
  /** Most recently active player ids, newest last. */
  recentPlayers: string[];
  recentFacts: SourceFact[];
  /** Applied event ids. Membership map + FIFO order; bounded by MAX_SEEN (see limitations). */
  seen: Record<string, 1>;
  seenOrder: string[];
  /** Count of events dropped because they were already applied (proves dedupe). */
  duplicates: number;
  rejected: number;
}

export interface SourceContext {
  playerId: string;
  known: boolean;
  player?: SourcePlayerRecord;
  playerFacts: SourceFact[];
  global: SourceCounts;
  totalPlayers: number;
  recentPlayers: Array<{ playerId: string; playerName: string; lastAt: number }>;
  recentFacts: SourceFact[];
  version: number;
}

export interface RecordResult {
  applied: boolean;
  reason?: 'duplicate' | 'invalid';
  version: number;
}

export const MAX_SEEN = 5_000;
export const MAX_PLAYERS = 5_000;
const MAX_RECENT_FACTS = 80;
const MAX_RECENT_PLAYERS = 40;
const MAX_ID = 128;
const MAX_NAME = 64;
const ID_RE = /^[A-Za-z0-9:._-]{1,128}$/;

const zero = (): SourceCounts => ({ join: 0, death: 0, banishment: 0, quest: 0, portal: 0 });

export const EMPTY_SOURCE: SourceLedger = {
  version: 1,
  counts: zero(),
  players: {},
  recentPlayers: [],
  recentFacts: [],
  seen: {},
  seenOrder: [],
  duplicates: 0,
  rejected: 0,
};

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
/** Prefixed key so no user-controlled id ever equals a prototype member name. */
const key = (id: string) => `k:${id}`;

const cleanName = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME);
  return s.length ? s : null;
};
const cleanId = (v: unknown): string | null => (typeof v === 'string' && v.length <= MAX_ID && ID_RE.test(v) ? v : null);

/** Validate and normalize an untrusted event. Returns null when anything is out of bounds. */
export function validateSourceEvent(e: unknown): SourceEvent | null {
  if (!e || typeof e !== 'object') return null;
  const r = e as Record<string, unknown>;
  const eventId = cleanId(r.eventId);
  const roomId = cleanId(r.roomId);
  const playerId = cleanId(r.playerId);
  const playerName = cleanName(r.playerName);
  const kind = r.kind as SourceEventKind;
  const at = r.at;
  if (!eventId || !roomId || !playerId || !playerName) return null;
  if (!SOURCE_EVENT_KINDS.includes(kind)) return null;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
  const out: SourceEvent = { eventId, kind, at: Math.floor(at), roomId, playerId, playerName };
  if (r.subjectId !== undefined) {
    const s = cleanId(r.subjectId);
    if (!s) return null;
    out.subjectId = s;
  }
  if (r.subjectName !== undefined) {
    const s = cleanName(r.subjectName);
    if (!s) return null;
    out.subjectName = s;
  }
  return out;
}

export function applySourceEvent(l: SourceLedger, raw: unknown): { ledger: SourceLedger; result: RecordResult } {
  const e = validateSourceEvent(raw);
  if (!e) {
    const ledger = { ...l, rejected: l.rejected + 1 };
    return { ledger, result: { applied: false, reason: 'invalid', version: l.version } };
  }
  if (has(l.seen, key(e.eventId))) {
    const ledger = { ...l, duplicates: l.duplicates + 1 };
    return { ledger, result: { applied: false, reason: 'duplicate', version: l.version } };
  }
  const pk = key(e.playerId);
  const prev: SourcePlayerRecord | undefined = has(l.players, pk) ? l.players[pk] : undefined;
  const player: SourcePlayerRecord = {
    playerId: e.playerId,
    playerName: e.playerName,
    counts: { ...(prev?.counts ?? zero()), [e.kind]: (prev?.counts[e.kind] ?? 0) + 1 },
    firstAt: prev ? Math.min(prev.firstAt, e.at) : e.at,
    lastAt: prev ? Math.max(prev.lastAt, e.at) : e.at,
    lastRoomId: e.roomId,
  };
  let players: Record<string, SourcePlayerRecord> = { ...l.players, [pk]: player };
  const keys = Object.keys(players);
  if (keys.length > MAX_PLAYERS) {
    // Evict the least recently active player record (counts in `counts` stay global and exact).
    const victim = keys.filter((k) => k !== pk).sort((a, b) => players[a]!.lastAt - players[b]!.lastAt)[0];
    if (victim) {
      players = { ...players };
      delete players[victim];
    }
  }
  const seenOrder = [...l.seenOrder, e.eventId];
  let seen: Record<string, 1> = { ...l.seen, [key(e.eventId)]: 1 };
  if (seenOrder.length > MAX_SEEN) {
    const dropped = seenOrder.splice(0, seenOrder.length - MAX_SEEN);
    seen = { ...seen };
    for (const d of dropped) delete seen[key(d)];
  }
  const fact: SourceFact = { ...e };
  const ledger: SourceLedger = {
    ...l,
    version: l.version + 1,
    counts: { ...l.counts, [e.kind]: l.counts[e.kind] + 1 },
    players,
    recentPlayers: [...l.recentPlayers.filter((p) => p !== e.playerId), e.playerId].slice(-MAX_RECENT_PLAYERS),
    recentFacts: [...l.recentFacts, fact].slice(-MAX_RECENT_FACTS),
    seen,
    seenOrder,
  };
  return { ledger, result: { applied: true, version: ledger.version } };
}

export function sourceContext(l: SourceLedger, playerId: string): SourceContext {
  const id = cleanId(playerId) ?? '';
  const pk = key(id);
  const player = id && has(l.players, pk) ? l.players[pk] : undefined;
  return {
    playerId: id,
    known: !!player,
    player,
    playerFacts: id ? l.recentFacts.filter((f) => f.playerId === id).slice(-12) : [],
    global: l.counts,
    totalPlayers: Object.keys(l.players).length,
    recentPlayers: l.recentPlayers
      .slice(-12)
      .map((p) => (has(l.players, key(p)) ? l.players[key(p)]! : null))
      .filter((p): p is SourcePlayerRecord => !!p)
      .map((p) => ({ playerId: p.playerId, playerName: p.playerName, lastAt: p.lastAt })),
    recentFacts: l.recentFacts.slice(-20),
    version: l.version,
  };
}

export interface SourceSnapshot {
  version: number;
  counts: SourceCounts;
  totalPlayers: number;
  recentPlayers: string[];
  recentFacts: SourceFact[];
  seenCount: number;
  seenLimit: number;
  duplicates: number;
  rejected: number;
}

export function sourceSnapshot(l: SourceLedger): SourceSnapshot {
  return {
    version: l.version,
    counts: l.counts,
    totalPlayers: Object.keys(l.players).length,
    recentPlayers: l.recentPlayers,
    recentFacts: l.recentFacts,
    seenCount: l.seenOrder.length,
    seenLimit: MAX_SEEN,
    duplicates: l.duplicates,
    rejected: l.rejected,
  };
}

export class Source extends Actor {
  @Persisted private ledger: SourceLedger = EMPTY_SOURCE;

  async record(event: SourceEvent): Promise<RecordResult> {
    const { ledger, result } = applySourceEvent(this.ledger, event);
    this.ledger = ledger;
    return result;
  }

  async context(playerId: string): Promise<SourceContext> {
    return sourceContext(this.ledger, playerId);
  }

  async snapshot(): Promise<SourceSnapshot> {
    return sourceSnapshot(this.ledger);
  }
}
