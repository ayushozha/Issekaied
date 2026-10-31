import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ServerMessage } from '../../shared/protocol';
import { EventIds, Fanout, type ServerEvent } from './events.ts';
import { resolveSourcePlayer, startGameServer, type GameServer } from './game.ts';
import { Room, playerIdFor } from './room.ts';

/** Real Bun server on an ephemeral port, real WebSocket clients: the protocol as the browser sees it. */
let game: GameServer;
let base: string;
const rooms = new Map<string, Room>();
const joins: { roomId: string; playerId: string; name: string; reconnected: boolean }[] = [];
const KEY_A = 'guest-aaaaaaaa-1111-2222-3333-444444444444';
const KEY_B = 'guest-bbbbbbbb-1111-2222-3333-444444444444';
const KEY_C = 'guest-cccccccc-1111-2222-3333-444444444444';

class Client {
  readonly messages: ServerMessage[] = [];
  readonly ws: WebSocket;
  closed: Promise<{ code: number; reason: string }>;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (e) => this.messages.push(JSON.parse(String(e.data)) as ServerMessage);
    this.closed = new Promise((resolve) => (this.ws.onclose = (e) => resolve({ code: e.code, reason: e.reason })));
  }
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('socket error'));
    });
  }
  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }
  async waitFor<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeoutMs = 3000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.find(pred);
      if (found) return found;
      await Bun.sleep(20);
    }
    throw new Error(`timed out waiting for message; got ${JSON.stringify(this.messages.map((m) => m.type))}`);
  }
}

const isWelcome = (m: ServerMessage): m is Extract<ServerMessage, { type: 'welcome' }> => m.type === 'welcome';
const isError = (code: string) => (m: ServerMessage): m is Extract<ServerMessage, { type: 'error' }> => m.type === 'error' && m.code === code;

beforeAll(() => {
  const ids = new EventIds('test');
  const events = new Fanout<ServerEvent>();
  const room = new Room('bellgrave', { capacity: 2, tickRate: 20, nextEventId: () => ids.next(), onEvent: (ev) => events.emit('bellgrave', ev) });
  rooms.set('bellgrave', room);
  game = startGameServer({
    host: '127.0.0.1',
    port: 0,
    rooms,
    tickRate: 20,
    snapshotRate: 10,
    health: () => ({ ok: true, test: true }),
    audio: async () => null,
    lore: async (q) => [{ query: q }],
    // Stand-in for the Source module: it only ever sees /api/source/* requests and may decline with null.
    source: { handle: async (req) => (new URL(req.url).pathname === '/api/source/session' ? Response.json({ delegated: true, method: req.method }) : null) },
    onJoin: (info) => joins.push(info),
    leaderboard: async () => ({ mode: 'local-jsonl', players: [{ name: 'Ayla', kills: 2, deaths: 0, joins: 1, timeSeconds: 12 }], updatedAt: 1 }),
  });
  events.subscribe((roomId, ev) => game.publish(roomId, ev));
  base = `127.0.0.1:${game.port}`;
});

afterAll(() => game.stop());

describe('http surface', () => {
  test('GET /health answers JSON without credentials', async () => {
    const res = await fetch(`http://${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, test: true });
  });

  test('audio for an unknown event is 404 and lore search answers', async () => {
    expect((await fetch(`http://${base}/api/audio/nope`)).status).toBe(404);
    expect((await fetch(`http://${base}/api/audio/../etc`)).status).toBe(404);
    expect(await (await fetch(`http://${base}/api/lore?q=Vesper`)).json()).toEqual([{ query: 'Vesper' }]);
    expect((await fetch(`http://${base}/ws`)).status).toBe(426);
  });
});

describe('websocket room', () => {
  test('two independent clients join, each sees the other, and identities are bound to sockets', async () => {
    const a = new Client(`ws://${base}/ws`);
    const b = new Client(`ws://${base}/ws`);
    await Promise.all([a.open(), b.open()]);

    a.send({ type: 'input', v: 1, seq: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, sprint: false });
    await a.waitFor(isError('not_joined'));
    a.send({ type: 'selectDeity', v: 1, power: 'vishnu' });
    await a.waitFor(isError('bad_message'));
    a.send({ type: 'join', v: 1, roomId: 'nowhere', name: 'Ayla', playerKey: KEY_A });
    await a.waitFor(isError('room_unknown'));

    a.send({ type: 'join', v: 1, roomId: 'bellgrave', name: 'Ayla <b>', playerKey: KEY_A });
    b.send({ type: 'join', v: 1, roomId: 'bellgrave', name: 'Bram', playerKey: KEY_B });
    const wa = await a.waitFor(isWelcome);
    const wb = await b.waitFor(isWelcome);
    expect(wa.selfId).toBe(playerIdFor(KEY_A));
    expect(wb.selfId).toBe(playerIdFor(KEY_B));
    expect(wa.tickRate).toBe(20);
    expect(wa.snapshot.enemies).toHaveLength(50);
    for (const id of ['morrow', 'nix', 'raksha', 'vesper']) expect(wa.snapshot.enemies.some((e) => e.id === id)).toBe(true);
    expect(wa.snapshot.enemies.find((e) => e.id === 'ghost-01')?.baseId).toBe('morrow');
    expect(wa.snapshot.players.find((p) => p.id === wa.selfId)!.name).toBe('Ayla b');

    const both = (m: ServerMessage) => m.type === 'snapshot' && m.snapshot.players.length === 2;
    await a.waitFor((m): m is Extract<ServerMessage, { type: 'snapshot' }> => both(m));
    await b.waitFor((m): m is Extract<ServerMessage, { type: 'snapshot' }> => both(m));
    expect(JSON.stringify(a.messages)).not.toContain(KEY_B);

    a.send({ type: 'join', v: 1, roomId: 'bellgrave', name: 'Again', playerKey: KEY_A });
    await a.waitFor(isError('already_joined'));
    expect(wa.snapshot.adventure).toMatchObject({ stage: 1, sigils: 0, echo: 0 });
    expect(wa.snapshot.players[0].active).toBe(true);
    a.send({ type: 'interact', v: 1, seq: 1, target: 'teleport' });
    await a.waitFor(isError('bad_message'));
    a.send({ type: 'interact', v: 1, seq: 1, target: 'respawn' }); // alive: silently ignored, never an error loop

    // Casting produces a server-chosen power event seen by the other hunter too.
    a.send({ type: 'cast', v: 1, seq: 2, aim: [0, 0, 1] });
    const castSeen = (m: ServerMessage): m is Extract<ServerMessage, { type: 'event' }> => m.type === 'event' && m.kind === 'cast' && m.fromId === wa.selfId;
    const ev = await b.waitFor(castSeen);
    expect(ev.power).toBeDefined();
    expect(['ganesha', 'hanuman', 'shiva', 'vishnu']).toContain(ev.power as string);

    // Capacity 2: a third hunter is refused and disconnected.
    const c = new Client(`ws://${base}/ws`);
    await c.open();
    c.send({ type: 'join', v: 1, roomId: 'bellgrave', name: 'Cass', playerKey: KEY_C });
    await c.waitFor(isError('room_full'));
    expect((await c.closed).code).toBe(4003);

    // Reconnect from a new socket with the same guest key: same identity, old socket superseded.
    const a2 = new Client(`ws://${base}/ws`);
    await a2.open();
    a2.send({ type: 'join', v: 1, roomId: 'bellgrave', name: 'Ayla', playerKey: KEY_A });
    const wa2 = await a2.waitFor(isWelcome);
    expect(wa2.selfId).toBe(wa.selfId);
    expect((await a.closed).code).toBe(4001);
    await Bun.sleep(150);
    const latest = [...a2.messages].reverse().find((m) => m.type === 'snapshot');
    expect(latest && latest.type === 'snapshot' ? latest.snapshot.players.length : 0).toBe(2);

    // The reloaded client counts from seq 1 again (the old socket reached seq 2): the room must accept it.
    a2.send({ type: 'input', v: 1, seq: 1, moveX: 0, moveZ: 0, yaw: 1, pitch: 0, sprint: false });
    const acked = (m: ServerMessage): m is Extract<ServerMessage, { type: 'snapshot' }> =>
      m.type === 'snapshot' && m.snapshot.players.some((p) => p.id === wa.selfId && p.ackSeq === 1 && p.active);
    await a2.waitFor(acked);

    a2.ws.close();
    b.ws.close();
    await Promise.all([a2.closed, b.closed]);
    await Bun.sleep(50);
    expect(game.metrics().sockets).toBe(0);
  });

  test('the Source resolver binds a guest key only to a live joined socket and never exposes the key', async () => {
    expect(resolveSourcePlayer(rooms, KEY_C, 'bellgrave')).toBeNull(); // never joined
    const c = new Client(`ws://${base}/ws`);
    await c.open();
    c.send({ type: 'join', v: 1, roomId: 'bellgrave', name: 'Cass', playerKey: KEY_C });
    const wc = await c.waitFor(isWelcome);
    expect(joins.at(-1)).toEqual({ roomId: 'bellgrave', playerId: playerIdFor(KEY_C), name: 'Cass', reconnected: false });
    expect(JSON.stringify(joins)).not.toContain(KEY_C);

    const ctx = resolveSourcePlayer(rooms, KEY_C, 'bellgrave');
    expect(ctx).not.toBeNull();
    expect(ctx!.playerId).toBe(wc.selfId);
    expect(ctx!.playerName).toBe('Cass');
    expect(ctx!.hp).toBe(100);
    expect(ctx!.position).toHaveLength(3);
    expect(ctx!.objective).toContain('sigils');
    expect(ctx!.nearbyEncounters.length).toBeGreaterThan(0);
    expect(ctx!.nearbyEncounters.length).toBeLessThanOrEqual(6);
    expect(ctx!.landmarks?.some((l) => l.name.includes('gate'))).toBe(true);
    expect(JSON.stringify(ctx)).not.toContain(KEY_C);
    expect(resolveSourcePlayer(rooms, KEY_C, 'nowhere')).toBeNull();
    expect(resolveSourcePlayer(rooms, 'guest-unknown-0000-1111-2222-333333333333', 'bellgrave')).toBeNull();

    // Only /api/source/* reaches the module; it may decline, and the existing routes are untouched.
    const session = await fetch(`http://${base}/api/source/session`, { method: 'POST', body: JSON.stringify({ playerKey: KEY_C, roomId: 'bellgrave' }) });
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ delegated: true, method: 'POST' });
    expect((await fetch(`http://${base}/api/source/other`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`http://${base}/health`)).status).toBe(200);
    const board = await (await fetch(`http://${base}/api/leaderboard`)).json();
    expect(board).toEqual({ mode: 'local-jsonl', players: [{ name: 'Ayla', kills: 2, deaths: 0, joins: 1, timeSeconds: 12 }], updatedAt: 1 });
    expect(JSON.stringify(board)).not.toContain('playerId');

    c.ws.close();
    await c.closed;
    await Bun.sleep(50);
    expect(resolveSourcePlayer(rooms, KEY_C, 'bellgrave')).toBeNull(); // parked, no open socket
  });
});

describe('superseded socket boundary', () => {
  /** Capture the websocket handlers Bun.serve was given and drive fake sockets whose close never fires: late frames from a replaced connection. */
  test('late input, cast and interact from a replaced socket never reach the room; the fresh socket works', () => {
    type Handlers = { message(ws: unknown, raw: string): void; close(ws: unknown): void };
    const realServe = Bun.serve;
    let handlers: Handlers | undefined;
    const fakeSocket = () => {
      const sent: ServerMessage[] = [];
      const closes: number[] = [];
      return {
        sent,
        closes,
        readyState: 1,
        data: { playerId: null as string | null, roomId: null as string | null, tokens: 120, refilledAt: Date.now(), drops: 0, bad: 0 },
        send: (raw: string) => void sent.push(JSON.parse(raw) as ServerMessage),
        close: (code: number) => void closes.push(code), // deferred: the server-side close handler is not invoked
        subscribe: () => {},
      };
    };
    const localRooms = new Map<string, Room>();
    const room = new Room('attic', { capacity: 2, tickRate: 20, nextEventId: () => 'e', onEvent: () => {} });
    localRooms.set('attic', room);
    let local: GameServer | undefined;
    try {
      (Bun as { serve: typeof Bun.serve }).serve = ((options: Parameters<typeof Bun.serve>[0]) => {
        handlers = (options as unknown as { websocket: Handlers }).websocket;
        return realServe(options);
      }) as typeof Bun.serve;
      local = startGameServer({ host: '127.0.0.1', port: 0, rooms: localRooms, tickRate: 20, snapshotRate: 10, health: () => ({ ok: true }) });
    } finally {
      (Bun as { serve: typeof Bun.serve }).serve = realServe;
    }
    try {
      if (!handlers) throw new Error('Bun.serve websocket handlers were not captured');
      const old = fakeSocket();
      const fresh = fakeSocket();
      const join = JSON.stringify({ type: 'join', v: 1, roomId: 'attic', name: 'Ayla', playerKey: KEY_A });
      handlers.message(old, join);
      expect(old.sent[0]?.type).toBe('welcome');
      const id = playerIdFor(KEY_A);
      const p = room.players.get(id)!;
      handlers.message(old, JSON.stringify({ type: 'input', v: 1, seq: 4698, moveX: 0, moveZ: 1, yaw: 0, pitch: 0, sprint: true }));
      expect(p.lastSeq).toBe(4698);

      handlers.message(fresh, join);
      expect(fresh.sent[0]?.type).toBe('welcome');
      expect(old.closes).toEqual([4001]);
      expect(p.lastSeq).toBe(0);
      expect(p.move).toEqual({ x: 0, z: 0, sprint: false });

      // Late frames from the replaced socket, including one that still believes it is bound to the hunter.
      const lateInput = JSON.stringify({ type: 'input', v: 1, seq: 4699, moveX: 1, moveZ: 0, yaw: 2, pitch: 0, sprint: true });
      const lateCast = JSON.stringify({ type: 'cast', v: 1, seq: 4700, aim: [0, 0, 1] });
      const lateInteract = JSON.stringify({ type: 'interact', v: 1, seq: 4701, target: 'respawn' });
      for (const data of [old.data, { ...old.data, playerId: id, roomId: 'attic' }]) {
        old.data = data;
        for (const raw of [lateInput, lateCast, lateInteract]) handlers.message(old, raw);
      }
      expect(p.lastSeq).toBe(0);
      expect(p.move).toEqual({ x: 0, z: 0, sprint: false });
      expect(p.yaw).toBe(0);
      expect(p.lastCastAt).toBe(0);
      expect(p.active).toBe(false);

      // The fresh socket drives the same hunter from seq 1.
      handlers.message(fresh, JSON.stringify({ type: 'input', v: 1, seq: 1, moveX: 1, moveZ: 0, yaw: 2, pitch: 0, sprint: true }));
      expect(p.lastSeq).toBe(1);
      expect(p.move).toEqual({ x: 1, z: 0, sprint: true });
      expect(p.active).toBe(true);
      handlers.message(fresh, JSON.stringify({ type: 'cast', v: 1, seq: 2, aim: [0, 0, 1] }));
      expect(p.lastCastAt).toBeGreaterThan(0);

      // The old socket's close finally arrives: it must not park the hunter who just reattached.
      handlers.close(old);
      expect(room.players.get(id)).toBe(p);
      expect(p.connected).toBe(true);
      expect(local.metrics().sockets).toBe(1);
    } finally {
      local?.stop();
    }
  });
});
