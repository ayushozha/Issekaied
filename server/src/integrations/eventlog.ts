import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { GameEvent, PowerId } from '../../../shared/protocol';
import type { Config } from '../config.ts';
import type { ServerEvent } from '../events.ts';

/**
 * Canonical gameplay-event history, stable player records and searchable lore.
 *
 * `supabase` mode writes to the isolated Supabase project (schema in server/supabase/schema.sql).
 * `local-jsonl` is an explicit fallback for running without the project provisioned; it is reported
 * as such in /health and is NOT the canonical store. Writes are queued and flushed off the tick.
 */
export interface StoredEvent {
  eventId: string;
  roomId: string;
  tick: number;
  kind: GameEvent['kind'];
  fromId: string;
  toId?: string;
  power?: PowerId;
  text?: string;
  at: number;
}

export interface EventQuery {
  participantIds: string[];
  kinds?: GameEvent['kind'][];
  limit?: number;
}

export interface LoreRow {
  roomId: string;
  subjectId: string;
  title: string;
  body: string;
  eventIds: string[];
  at?: number;
}

export interface EventLog {
  readonly mode: 'supabase' | 'local-jsonl';
  record(roomId: string, event: ServerEvent): void;
  upsertPlayer(player: { id: string; name: string }): void;
  recent(query: EventQuery): Promise<StoredEvent[]>;
  addLore(entry: LoreRow): void;
  searchLore(query: string, limit?: number): Promise<LoreRow[]>;
  status(): Record<string, unknown>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

const FLUSH_MS = 1000;
const MAX_QUEUE = 5000;
const MAX_LOCAL_TAIL = 5000;
const MAX_SEEN = 20000;

const toStored = (roomId: string, ev: ServerEvent, at: number): StoredEvent => ({
  eventId: ev.eventId,
  roomId,
  tick: ev.tick,
  kind: ev.kind,
  fromId: ev.fromId,
  toId: ev.toId,
  power: ev.power,
  text: ev.text,
  at,
});

class SeenIds {
  private readonly order: string[] = [];
  private readonly set = new Set<string>();
  has(id: string): boolean {
    return this.set.has(id);
  }
  add(id: string): boolean {
    if (this.set.has(id)) return false;
    this.set.add(id);
    this.order.push(id);
    if (this.order.length > MAX_SEEN) this.set.delete(this.order.shift() as string);
    return true;
  }
}

const matches = (e: StoredEvent, q: EventQuery) =>
  (e.toId !== undefined && q.participantIds.includes(e.toId) || q.participantIds.includes(e.fromId)) && (!q.kinds || q.kinds.includes(e.kind));

// ---- local JSONL fallback -----------------------------------------------------------------------

class LocalJsonlLog implements EventLog {
  readonly mode = 'local-jsonl' as const;
  private readonly seen = new SeenIds();
  private readonly tail: StoredEvent[] = [];
  private readonly lore: LoreRow[] = [];
  private pending: string[] = [];
  private pendingLore: string[] = [];
  private writes = 0;
  private failures = 0;
  private lastError = '';
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly dir: string) {}

  async init(): Promise<this> {
    await mkdir(this.dir, { recursive: true });
    await this.load(path.join(this.dir, 'events.jsonl'), (row) => {
      const e = row as StoredEvent;
      if (typeof e.eventId === 'string' && this.seen.add(e.eventId)) this.tail.push(e);
    });
    await this.load(path.join(this.dir, 'lore.jsonl'), (row) => this.lore.push(row as LoreRow));
    if (this.tail.length > MAX_LOCAL_TAIL) this.tail.splice(0, this.tail.length - MAX_LOCAL_TAIL);
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    return this;
  }

  private async load(file: string, each: (row: unknown) => void): Promise<void> {
    try {
      const text = await readFile(file, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          each(JSON.parse(line));
        } catch {
          /* skip a corrupt line */
        }
      }
    } catch {
      /* no file yet */
    }
  }

  record(roomId: string, event: ServerEvent): void {
    if (!this.seen.add(event.eventId)) return;
    const stored = toStored(roomId, event, Date.now());
    this.tail.push(stored);
    if (this.tail.length > MAX_LOCAL_TAIL) this.tail.shift();
    if (this.pending.length < MAX_QUEUE) this.pending.push(JSON.stringify(stored));
  }

  upsertPlayer(): void {
    /* player identity lives in Supabase; the local fallback only keeps events and lore */
  }

  async recent(q: EventQuery): Promise<StoredEvent[]> {
    const out: StoredEvent[] = [];
    for (let i = this.tail.length - 1; i >= 0 && out.length < (q.limit ?? 10); i--) if (matches(this.tail[i], q)) out.push(this.tail[i]);
    return out;
  }

  addLore(entry: LoreRow): void {
    const row = { ...entry, at: entry.at ?? Date.now() };
    this.lore.push(row);
    this.pendingLore.push(JSON.stringify(row));
  }

  async searchLore(query: string, limit = 10): Promise<LoreRow[]> {
    const q = query.toLowerCase();
    const out: LoreRow[] = [];
    for (let i = this.lore.length - 1; i >= 0 && out.length < limit; i--) {
      const l = this.lore[i];
      if (!q || l.title.toLowerCase().includes(q) || l.body.toLowerCase().includes(q) || l.subjectId === q) out.push(l);
    }
    return out;
  }

  status(): Record<string, unknown> {
    return { mode: this.mode, dir: this.dir, events: this.tail.length, lore: this.lore.length, writes: this.writes, failures: this.failures, lastError: this.lastError || undefined };
  }

  async flush(): Promise<void> {
    const events = this.pending;
    const lore = this.pendingLore;
    this.pending = [];
    this.pendingLore = [];
    try {
      if (events.length) await appendFile(path.join(this.dir, 'events.jsonl'), events.join('\n') + '\n');
      if (lore.length) await appendFile(path.join(this.dir, 'lore.jsonl'), lore.join('\n') + '\n');
      this.writes += events.length + lore.length;
    } catch (err) {
      this.failures += 1;
      this.lastError = (err as Error).message;
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}

// ---- Supabase ---------------------------------------------------------------------------------

interface EventRow {
  event_id: string;
  room_id: string;
  tick: number;
  kind: string;
  from_id: string;
  to_id: string | null;
  power: string | null;
  position: number[] | null;
  text: string | null;
}

class SupabaseLog implements EventLog {
  readonly mode = 'supabase' as const;
  private readonly seen = new SeenIds();
  private pending: EventRow[] = [];
  private pendingLore: LoreRow[] = [];
  private pendingPlayers = new Map<string, string>();
  private writes = 0;
  private failures = 0;
  private lastError = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;

  constructor(private readonly db: SupabaseClient, private readonly projectHost: string) {}

  start(): this {
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    return this;
  }

  record(roomId: string, event: ServerEvent): void {
    if (!this.seen.add(event.eventId)) return;
    if (this.pending.length >= MAX_QUEUE) return;
    this.pending.push({
      event_id: event.eventId,
      room_id: roomId,
      tick: event.tick,
      kind: event.kind,
      from_id: event.fromId,
      to_id: event.toId ?? null,
      power: event.power ?? null,
      position: event.position ?? null,
      text: event.text ?? null,
    });
  }

  upsertPlayer(player: { id: string; name: string }): void {
    this.pendingPlayers.set(player.id, player.name);
  }

  async recent(q: EventQuery): Promise<StoredEvent[]> {
    const ids = q.participantIds.map((id) => `"${id.replace(/[^A-Za-z0-9_-]/g, '')}"`).join(',');
    let req = this.db
      .from('game_events')
      .select('event_id, room_id, tick, kind, from_id, to_id, power, text, created_at')
      .or(`from_id.in.(${ids}),to_id.in.(${ids})`)
      .order('created_at', { ascending: false })
      .limit(q.limit ?? 10);
    if (q.kinds) req = req.in('kind', q.kinds);
    const { data, error } = await req;
    if (error) {
      this.failures += 1;
      this.lastError = error.message;
      return [];
    }
    return (data ?? []).map((r) => ({
      eventId: r.event_id as string,
      roomId: r.room_id as string,
      tick: r.tick as number,
      kind: r.kind as GameEvent['kind'],
      fromId: r.from_id as string,
      toId: (r.to_id as string | null) ?? undefined,
      power: (r.power as PowerId | null) ?? undefined,
      text: (r.text as string | null) ?? undefined,
      at: Date.parse(r.created_at as string),
    }));
  }

  addLore(entry: LoreRow): void {
    this.pendingLore.push(entry);
  }

  async searchLore(query: string, limit = 10): Promise<LoreRow[]> {
    let req = this.db.from('lore').select('room_id, subject_id, title, body, event_ids, created_at').order('created_at', { ascending: false }).limit(limit);
    if (query.trim()) req = req.textSearch('fts', query.trim().split(/\s+/).join(' & '));
    const { data, error } = await req;
    if (error) {
      this.failures += 1;
      this.lastError = error.message;
      return [];
    }
    return (data ?? []).map((r) => ({
      roomId: r.room_id as string,
      subjectId: r.subject_id as string,
      title: r.title as string,
      body: r.body as string,
      eventIds: (r.event_ids as string[]) ?? [],
      at: Date.parse(r.created_at as string),
    }));
  }

  status(): Record<string, unknown> {
    return { mode: this.mode, project: this.projectHost, queued: this.pending.length, writes: this.writes, failures: this.failures, lastError: this.lastError || undefined };
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const events = this.pending.splice(0, 500);
    const lore = this.pendingLore.splice(0, 100);
    const players = [...this.pendingPlayers.entries()];
    this.pendingPlayers.clear();
    const now = new Date().toISOString();
    const attempt = async (label: string, run: () => PromiseLike<{ error: { message: string } | null }>, requeue: () => void) => {
      try {
        const { error } = await run();
        if (error) throw new Error(`${label}: ${error.message}`);
      } catch (err) {
        this.failures += 1;
        this.lastError = (err as Error).message;
        requeue();
      }
    };
    if (events.length) {
      await attempt(
        'game_events',
        () => this.db.from('game_events').upsert(events, { onConflict: 'event_id', ignoreDuplicates: true }),
        () => void (this.pending = [...events, ...this.pending].slice(0, MAX_QUEUE)),
      );
      this.writes += events.length;
    }
    if (players.length) {
      await attempt(
        'players',
        () => this.db.from('players').upsert(players.map(([id, name]) => ({ id, name, last_seen: now })), { onConflict: 'id' }),
        () => players.forEach(([id, name]) => this.pendingPlayers.set(id, name)),
      );
    }
    if (lore.length) {
      await attempt(
        'lore',
        () => this.db.from('lore').insert(lore.map((l) => ({ room_id: l.roomId, subject_id: l.subjectId, title: l.title, body: l.body, event_ids: l.eventIds }))),
        () => void (this.pendingLore = [...lore, ...this.pendingLore]),
      );
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}

export async function createEventLog(cfg: Config): Promise<EventLog> {
  if (cfg.supabase.url && cfg.supabase.secretKey) {
    const client = createClient(cfg.supabase.url, cfg.supabase.secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
    return new SupabaseLog(client, new URL(cfg.supabase.url).host).start();
  }
  return new LocalJsonlLog(cfg.dataDir).init();
}
