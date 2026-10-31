import type { Server, ServerWebSocket } from 'bun';
import type { ServerMessage, Vec3 } from '../../shared/protocol';
import type { ServerEvent } from './events.ts';
import { playerIdFor, type Room } from './room.ts';
import { parseClientMessage, sanitizeName } from './validate.ts';
import { ADVENTURE, ENEMY_Y, EYE_HEIGHT, WORLD, dist2d } from './world.ts';

/**
 * Bun HTTP + WebSocket front door. GET /health, GET /api/audio/<eventId>, GET /api/lore?q=, and the
 * /ws game socket. Every socket is bound to exactly one player after its join message; the room only
 * ever hears intents attributed to that bound identity. Snapshots and events are published once per
 * room topic (Bun pub/sub) instead of being serialised per socket.
 */
interface SocketData {
  playerId: string | null;
  roomId: string | null;
  tokens: number;
  refilledAt: number;
  drops: number;
  bad: number;
}

type GameSocket = ServerWebSocket<SocketData>;

export interface GameServerOptions {
  host: string;
  port: number;
  rooms: Map<string, Room>;
  tickRate: number;
  snapshotRate: number;
  health: () => unknown;
  audio?: (eventId: string) => Promise<Uint8Array | null>;
  lore?: (query: string) => Promise<unknown>;
  /** The Source narrator service; only `/api/source/*` requests are delegated to it. */
  source?: { handle(req: Request): Promise<Response | null> };
  /** Fires after a socket has successfully joined and received its welcome (public id, never the guest key). */
  onJoin?: (info: { roomId: string; playerId: string; name: string; reconnected: boolean }) => void;
  log?: (line: string) => void;
}

/** Authoritative snapshot of one hunter for The Source; mirrors the Source module's player context shape. */
export interface SourcePlayerView {
  playerId: string;
  playerName: string;
  roomId: string;
  position: Vec3;
  hp: number;
  objective: string;
  nearbyEncounters: Array<{ id: string; name: string; level: number; position: Vec3; state: string }>;
  landmarks?: Array<{ name: string; position: Vec3 }>;
}

const NEARBY_LIMIT = 6;
const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Binds a guest key + room to the hunter currently joined on an open socket and returns only authoritative
 * room state under the same stable public id persistent memory uses. Null for unknown keys, rooms, or
 * hunters who are not connected right now. Dead or paused hunters are returned with their real HP.
 */
export function resolveSourcePlayer(rooms: Map<string, Room>, playerKey: string, roomId: string): SourcePlayerView | null {
  const room = rooms.get(roomId);
  if (!room) return null;
  const p = room.players.get(playerIdFor(playerKey));
  if (!p || p.key !== playerKey || !p.connected) return null;
  const nearby = room.enemies
    .map((e) => ({ e, d: dist2d(e, p) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, NEARBY_LIMIT)
    .map(({ e }) => ({ id: e.id, name: e.name, level: e.level, position: [round(e.x), ENEMY_Y, round(e.z)] as Vec3, state: e.state }));
  const landmarks: SourcePlayerView['landmarks'] = [
    { name: 'the gate (safe ground)', position: WORLD.spawn },
    { name: `gate shrine (${ADVENTURE.shrine.id})`, position: ADVENTURE.shrine.position },
    { name: `echo portal (${ADVENTURE.portal.id})`, position: ADVENTURE.portal.position },
    ...ADVENTURE.zones.map((z) => ({ name: z.name, position: z.position })),
  ];
  return {
    playerId: p.id,
    playerName: p.name,
    roomId: room.id,
    position: [round(p.x), EYE_HEIGHT, round(p.z)],
    hp: p.hp,
    objective: room.adventureState().objective,
    nearbyEncounters: nearby,
    landmarks,
  };
}

export interface LoopMetrics {
  steps: number;
  avgStepMs: number;
  maxStepMs: number;
  maxLagMs: number;
  sockets: number;
  publishedSnapshots: number;
  publishedEvents: number;
}

export interface GameServer {
  server: Server<SocketData>;
  port: number;
  publish(roomId: string, event: ServerEvent): void;
  metrics(): LoopMetrics;
  stop(): void;
}

const RATE_PER_SECOND = 60;
const BURST = 120;
const MAX_DROPS = 500;
const MAX_BAD = 20;
const topic = (roomId: string) => `room:${roomId}`;

const allow = (d: SocketData, now: number): boolean => {
  d.tokens = Math.min(BURST, d.tokens + ((now - d.refilledAt) / 1000) * RATE_PER_SECOND);
  d.refilledAt = now;
  if (d.tokens < 1) return false;
  d.tokens -= 1;
  return true;
};

export function startGameServer(opts: GameServerOptions): GameServer {
  const log = opts.log ?? (() => {});
  const sockets = new Map<string, GameSocket>();
  const m: LoopMetrics = { steps: 0, avgStepMs: 0, maxStepMs: 0, maxLagMs: 0, sockets: 0, publishedSnapshots: 0, publishedEvents: 0 };
  let stepMsTotal = 0;

  const send = (ws: GameSocket, msg: ServerMessage) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  };
  const sendError = (ws: GameSocket, code: string, message: string) => send(ws, { type: 'error', code, message });

  const join = (ws: GameSocket, msg: Extract<ServerMessageInput, { type: 'join' }>) => {
    const d = ws.data;
    if (d.playerId) return sendError(ws, 'already_joined', 'this socket is already bound to a hunter');
    const room = opts.rooms.get(msg.roomId);
    if (!room) return sendError(ws, 'room_unknown', `no room named ${msg.roomId}`);
    const result = room.join(msg.playerKey, sanitizeName(msg.name));
    if (!result.ok) {
      sendError(ws, result.code, 'the room is full');
      ws.close(4003, 'room full');
      return;
    }
    const key = `${room.id}:${result.player.id}`;
    const previous = sockets.get(key);
    if (previous && previous !== ws) {
      previous.data.playerId = null; // the close handler must not park a hunter who just reattached
      previous.close(4001, 'superseded by a newer connection');
    }
    sockets.set(key, ws);
    d.playerId = result.player.id;
    d.roomId = room.id;
    ws.subscribe(topic(room.id));
    send(ws, { type: 'welcome', v: 1, selfId: result.player.id, roomId: room.id, tickRate: opts.tickRate, snapshotRate: opts.snapshotRate, snapshot: room.snapshot() });
    log(`join ${room.id} ${result.player.name} (${result.player.id})${result.reconnected ? ' reconnected' : ''} players=${room.connectedCount}`);
    opts.onJoin?.({ roomId: room.id, playerId: result.player.id, name: result.player.name, reconnected: result.reconnected });
  };

  const server = Bun.serve<SocketData>({
    hostname: opts.host,
    port: opts.port,
    development: false,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/health') return Response.json(opts.health(), { headers: { 'cache-control': 'no-store' } });
      if (url.pathname === '/ws') {
        const upgraded = srv.upgrade(req, { data: { playerId: null, roomId: null, tokens: BURST, refilledAt: Date.now(), drops: 0, bad: 0 } });
        return upgraded ? undefined : new Response('WebSocket upgrade required', { status: 426 });
      }
      if (url.pathname.startsWith('/api/audio/')) {
        const id = url.pathname.slice('/api/audio/'.length);
        if (!opts.audio || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return new Response('not found', { status: 404 });
        const audio = await opts.audio(id);
        return audio
          ? new Response(audio, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'public, max-age=3600' } })
          : new Response('no audio for this event', { status: 404 });
      }
      if (url.pathname === '/api/lore') {
        const q = (url.searchParams.get('q') ?? '').slice(0, 80);
        return Response.json((await opts.lore?.(q)) ?? []);
      }
      if (url.pathname.startsWith('/api/source/')) {
        if (!opts.source) return Response.json({ error: 'source_not_configured' }, { status: 503, headers: { 'cache-control': 'no-store' } });
        const handled = await opts.source.handle(req);
        if (handled) return handled;
      }
      return new Response('not found', { status: 404 });
    },
    websocket: {
      maxPayloadLength: 4096,
      idleTimeout: 120,
      perMessageDeflate: false,
      open() {},
      message(ws, raw) {
        const d = ws.data;
        if (!allow(d, Date.now())) {
          d.drops += 1;
          if (d.drops > MAX_DROPS) ws.close(4008, 'rate limited');
          return;
        }
        const msg = parseClientMessage(typeof raw === 'string' ? raw : null);
        if (!msg) {
          d.bad += 1;
          sendError(ws, 'bad_message', 'unrecognised or malformed message');
          if (d.bad > MAX_BAD) ws.close(4002, 'too many bad messages');
          return;
        }
        if (msg.type === 'join') return join(ws, msg);
        if (!d.playerId || !d.roomId) return sendError(ws, 'not_joined', 'send a join message first');
        const room = opts.rooms.get(d.roomId);
        if (!room) return;
        if (msg.type === 'input') room.applyInput(d.playerId, msg);
        else if (msg.type === 'cast') room.cast(d.playerId, msg);
        else room.interact(d.playerId, msg);
      },
      close(ws) {
        const d = ws.data;
        if (!d.playerId || !d.roomId) return;
        const key = `${d.roomId}:${d.playerId}`;
        if (sockets.get(key) !== ws) return;
        sockets.delete(key);
        const room = opts.rooms.get(d.roomId);
        room?.leave(d.playerId);
        log(`leave ${d.roomId} ${d.playerId} players=${room?.connectedCount ?? 0}`);
      },
    },
  });

  const tickMs = 1000 / opts.tickRate;
  const snapshotEvery = Math.max(1, Math.round(opts.tickRate / opts.snapshotRate));
  let expected = performance.now() + tickMs;
  const warmupUntil = performance.now() + 2000; // ignore JIT/startup jitter in the lag metric
  const timer = setInterval(() => {
    const start = performance.now();
    if (start > warmupUntil) m.maxLagMs = Math.max(m.maxLagMs, Math.round((start - expected) * 10) / 10);
    expected = Math.max(expected + tickMs, start - tickMs); // never accumulate a backlog after a stall
    for (const room of opts.rooms.values()) {
      room.step();
      if (room.tick % snapshotEvery === 0 && server.subscriberCount(topic(room.id)) > 0) {
        server.publish(topic(room.id), JSON.stringify({ type: 'snapshot', v: 1, snapshot: room.snapshot() } satisfies ServerMessage));
        m.publishedSnapshots += 1;
      }
    }
    const took = performance.now() - start;
    m.steps += 1;
    stepMsTotal += took;
    m.avgStepMs = Math.round((stepMsTotal / m.steps) * 1000) / 1000;
    m.maxStepMs = Math.max(m.maxStepMs, Math.round(took * 100) / 100);
  }, tickMs);

  return {
    server,
    port: server.port ?? opts.port,
    publish(roomId, event) {
      server.publish(topic(roomId), JSON.stringify(event));
      m.publishedEvents += 1;
    },
    metrics() {
      return { ...m, sockets: sockets.size };
    },
    stop() {
      clearInterval(timer);
      server.stop(true);
    },
  };
}

type ServerMessageInput = NonNullable<ReturnType<typeof parseClientMessage>>;
