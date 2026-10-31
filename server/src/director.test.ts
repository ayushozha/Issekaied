import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { counterStrategy } from '../../actor/src/memory.ts';
import { PRIMARY } from './combat.ts';
import type { Config } from './config.ts';
import { createDirector, type Director } from './director.ts';
import { EventIds, Fanout, type ServerEvent } from './events.ts';
import { createEventLog, type EventLog } from './integrations/eventlog.ts';
import { createMemoryStore, type MemoryStore } from './integrations/memory.ts';
import { createMinds, loadNpcConfig, type NpcConfig } from './integrations/minds.ts';
import { createRehearsal } from './integrations/rehearsal.ts';
import { createChannels } from './integrations/relay.ts';
import { createVoice } from './integrations/voice.ts';
import { Room, type RoomPlayer, type RoomSignal } from './room.ts';
import { ADVENTURE, xz } from './world.ts';

/**
 * Offline end-to-end: a banishment flows through the director into the (local-file) memory store,
 * the (local-bus) hivemind, scripted minds, local rehearsal and the (local-jsonl) event log; then a
 * fresh room + director hydrate from the same store, proving memory survives a "restart"; finally the
 * echo portal is planned through the rehearsal path and applied to the room.
 */
let dir: string;
let cfg: Config;
let npcs: NpcConfig;
let eventLog: EventLog;
let memory: MemoryStore;
const KEY = 'guest-dddddddd-1111-2222-3333-444444444444';

const settle = () => Bun.sleep(80);

function world(name: string) {
  let t = 5_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const ids = new EventIds(name);
  const events: ServerEvent[] = [];
  const fanEvents = new Fanout<ServerEvent>();
  const fanSignals = new Fanout<RoomSignal>();
  const room = new Room('bellgrave', { capacity: 4, tickRate: 20, now: clock.now, nextEventId: () => ids.next(), onEvent: (e) => fanEvents.emit('bellgrave', e), onSignal: (s) => fanSignals.emit('bellgrave', s) });
  fanEvents.subscribe((_r, e) => events.push(e));
  fanEvents.subscribe((r, e) => eventLog.record(r, e));
  const director: Director = createDirector({
    rooms: new Map([['bellgrave', room]]),
    eventLog,
    memory,
    channels: createChannels(cfg),
    minds: createMinds(cfg, npcs),
    voice: createVoice(cfg, npcs),
    rehearsal: createRehearsal(cfg),
    now: clock.now,
  });
  fanSignals.subscribe((r, s) => director.handle(r, s));
  let seq = 0;
  const poke = (p: RoomPlayer) => room.applyInput(p.id, { type: 'input', v: 1, seq: ++seq, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, sprint: false });
  const run = (ticks: number) => {
    for (let i = 0; i < ticks; i++) {
      clock.advance(50);
      room.step();
    }
  };
  /** Fight like a player: incantations when the deity allows, primary strikes in between (haunts warned to keep distance retreat to 9-12 m). */
  const banish = (p: RoomPlayer, id: string) => {
    const e = room.enemy(id)!;
    p.x = e.x;
    p.z = e.z - 5;
    p.hp = 100;
    for (let i = 0; i < 60 && e.state === 'hunting'; i++) {
      poke(p);
      const dx = e.x - p.x;
      const dy = 1.2 - p.y;
      const dz = e.z - p.z;
      const l = Math.hypot(dx, dy, dz);
      room.cast(p.id, { type: 'cast', v: 1, seq: ++seq, aim: [dx / l, dy / l, dz / l], action: i % 4 === 0 ? 'incantation' : 'primary' });
      run(Math.ceil((PRIMARY.cooldownMs + 60) / 50));
      p.hp = 100;
    }
    if (e.state !== 'banished') throw new Error(`${id} was not banished (strategy ${e.strategy}, hp ${e.hp})`);
  };
  return { room, clock, events, director, run, poke, banish, seq: () => ++seq };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'issekaied-director-'));
  cfg = {
    dataDir: dir,
    npcConfigPath: path.resolve(import.meta.dir, '../config/npcs.json'),
    openai: {},
    supabase: {},
    terse: {},
    relay: {},
    superserve: { rehearsal: false, template: 'superserve/node-22' },
  } as unknown as Config;
  npcs = await loadNpcConfig(cfg.npcConfigPath);
  eventLog = await createEventLog(cfg);
  memory = createMemoryStore(cfg);
  expect(eventLog.mode).toBe('local-jsonl');
  expect(memory.mode()).toBe('local-file');
});

afterAll(async () => {
  await eventLog.close();
  await memory.close();
  await rm(dir, { recursive: true, force: true });
});

describe('director strategy write queue', () => {
  test('hivemind warnings fan out to at most 4 in-flight Ghost.setStrategy writes, never overlap per enemy, coalesce to the latest intent, and drain on close', async () => {
    // 50 haunts in one room; the room reacts synchronously while durable writes are bounded.
    const enemies = Array.from({ length: 50 }, (_, i) => ({ id: `haunt-${i}`, name: `Haunt ${i}`, state: 'hunting', gated: false, strategy: 'chase' }));
    const roomStrategies = new Map<string, string>();
    const room = {
      id: 'bellgrave',
      enemies,
      players: new Map(),
      setStrategy: (id: string, s: string) => (roomStrategies.set(id, s), true),
      whisper: (fromId: string) => ({ eventId: `whisper:${fromId}` }),
    } as unknown as Room;

    // Fake Ghost.setStrategy: resolves only when the test releases it; records concurrency and per-enemy overlap.
    const releases: (() => void)[] = [];
    const persisted = new Map<string, { strategy: string; eventId: string }[]>();
    const active = new Set<string>();
    let maxActive = 0;
    let overlapped = false;
    const fakeMemory = {
      mode: () => memory.mode(),
      deity: (id: string) => memory.deity(id),
      ghost: (id: string) => ({
        ...memory.ghost(id),
        setStrategy: (strategy: string, eventId: string) =>
          new Promise<unknown>((resolve) => {
            if (active.has(id)) overlapped = true;
            active.add(id);
            maxActive = Math.max(maxActive, active.size);
            releases.push(() => {
              active.delete(id);
              persisted.set(id, [...(persisted.get(id) ?? []), { strategy, eventId }]);
              resolve({});
            });
          }),
      }),
    } as unknown as MemoryStore;

    const channels = createChannels(cfg);
    const director = createDirector({ rooms: new Map([['bellgrave', room]]), eventLog, memory: fakeMemory, channels, minds: createMinds(cfg, npcs), voice: createVoice(cfg, npcs), rehearsal: createRehearsal(cfg) });
    const warning = (eventId: string, power: 'ganesha' | 'shiva') => ({ eventId, roomId: 'bellgrave', ghostId: 'morrow', ghostName: 'Morrow', hunterId: 'h1', hunterName: 'Ayla', power, suggestedStrategy: counterStrategy(power), at: 1 });

    await channels.warn(warning('w1', 'ganesha'));
    await Bun.sleep(5);
    // Gameplay already changed for every haunt before a single remote promise resolved.
    expect(roomStrategies.size).toBe(50);
    for (const e of enemies) expect(roomStrategies.get(e.id)).toBe(counterStrategy('ganesha'));
    expect(releases.length).toBe(4);
    expect(director.status()).toMatchObject({ strategyWrites: { active: 4, pending: 46, coalesced: 0, limit: 4 } });

    // A second and third warning while writes are in flight: the room flips immediately, pending intents are overwritten, not appended.
    await channels.warn(warning('w2', 'shiva'));
    await channels.warn(warning('w3', 'ganesha'));
    await Bun.sleep(5);
    for (const e of enemies) expect(roomStrategies.get(e.id)).toBe(counterStrategy('ganesha'));
    expect(releases.length).toBe(4); // still only 4 RPCs started
    const mid = director.status().strategyWrites as Record<string, number>;
    expect(mid.active).toBe(4);
    expect(mid.pending).toBe(50); // bounded by known enemies, not by warnings (46 queued + 4 in-flight each hold one latest intent)
    expect(mid.coalesced).toBe(96); // 46 pending overwritten twice + 4 in-flight overwritten once each (w2 -> w3)

    // Release everything as it arrives; close() must not resolve until the queue has fully drained.
    let closed = false;
    const closing = director.close().then(() => (closed = true));
    while (!closed) {
      await Bun.sleep(1);
      expect(active.size).toBeLessThanOrEqual(4);
      while (releases.length) releases.shift()!();
    }
    await closing;

    expect(maxActive).toBe(4);
    expect(overlapped).toBe(false);
    expect(persisted.size).toBe(50);
    for (const e of enemies) {
      const writes = persisted.get(e.id)!;
      expect(writes.length).toBeLessThanOrEqual(2); // first in-flight + one coalesced latest; intermediate w2 never reached the store
      expect(writes[writes.length - 1]).toEqual({ strategy: counterStrategy('ganesha'), eventId: 'w3' });
    }
    expect(director.status()).toMatchObject({ errors: 0, strategyWrites: { active: 0, pending: 0, coalesced: 96, limit: 4 } });
    await channels.close();
  });
});

describe('director (offline modes)', () => {
  test('a banishment is remembered, warns the other haunts, speaks, rehearses, and becomes searchable lore', async () => {
    const { room, events, director, run, banish } = world('one');
    const joined = room.join(KEY, 'Ayla');
    if (!joined.ok) throw new Error('join failed');
    const player = joined.player;
    const morrow = room.enemy('morrow')!;
    banish(player, 'morrow');
    const banishEvent = events.find((e) => e.kind === 'banish')!;
    await settle();

    const mem = await memory.ghost('morrow').snapshot();
    expect(mem.banishments).toBe(1);
    expect(mem.grudges[player.id]).toMatchObject({ hunterName: 'Ayla', banishments: 1, lastPower: 'ganesha' });
    expect(mem.episodes.map((e) => e.eventId)).toContain(banishEvent.eventId);
    expect(morrow.pendingStrategy).toBeDefined();

    // Delivered hivemind warning changed the live recipients (the gated boss is left alone).
    for (const id of ['nix', 'vesper']) expect(room.enemy(id)!.strategy).toBe(counterStrategy('ganesha'));
    expect(room.enemy('raksha')!.strategy).toBe('chase');
    expect(events.some((e) => e.kind === 'power' && e.text?.includes('changes tactics') && e.text.includes('warning'))).toBe(false); // silent adoption, no 49-notice spam
    expect(events.some((e) => e.kind === 'whisper' && e.fromId === 'morrow')).toBe(true);
    expect(events.some((e) => e.kind === 'whisper' && ['nix', 'vesper'].includes(e.fromId))).toBe(true);
    expect(events.every((e) => e.audioUrl === undefined)).toBe(true); // voice disabled: no fake audio URLs
    expect(events.some((e) => e.kind === 'quest' && e.text?.includes('(1/3)'))).toBe(true);

    await eventLog.flush();
    const lore = await eventLog.searchLore('Morrow');
    expect(lore.length).toBeGreaterThan(0);
    expect(lore[0].eventIds).toContain(banishEvent.eventId);
    const recent = await eventLog.recent({ participantIds: ['morrow'], kinds: ['banish'] });
    expect(recent.map((e) => e.eventId)).toContain(banishEvent.eventId);

    run(1);
    expect(director.status()).toMatchObject({ errors: 0 });
    await director.close();
  });

  test('a fresh room hydrates the grudge and the haunt recognises the hunter again', async () => {
    const { room, events, director, run, poke } = world('two');
    await director.hydrate();
    const morrow = room.enemy('morrow')!;
    const stored = await memory.ghost('morrow').snapshot();
    expect(morrow.memory).toMatchObject({ banishments: 1, lastPower: 'ganesha', lastHunterName: 'Ayla' });
    expect(morrow.strategy).toBe(stored.strategy); // the rehearsed tactic persisted across the "restart"

    const joined = room.join(KEY, 'Ayla');
    if (!joined.ok) throw new Error('join failed');
    expect(morrow.grudgeHunters.has(joined.player.id)).toBe(true);
    joined.player.x = morrow.x;
    joined.player.z = morrow.z - 10;
    poke(joined.player);
    run(2);
    await settle();
    const whisper = events.find((e) => e.kind === 'whisper' && e.fromId === 'morrow');
    expect(whisper?.text).toContain('Ayla');
    // Meeting the remembered hunter retrieves the grudge and changes tactics to counter their favourite power.
    expect(morrow.strategy).toBe(counterStrategy('ganesha'));
    expect(events.some((e) => e.kind === 'power' && e.fromId === 'morrow' && e.text?.includes('recognises Ayla'))).toBe(true);
    expect(director.status()).toMatchObject({ errors: 0 });
    await director.close();
  });

  test('the echo portal is planned off the tick from recorded banishments and applied to the same room', async () => {
    const { room, events, director, banish, poke, seq } = world('three');
    await director.hydrate();
    const joined = room.join(KEY, 'Ayla');
    if (!joined.ok) throw new Error('join failed');
    const p = joined.player;
    for (const id of ['morrow', 'nix', 'vesper', 'raksha']) banish(p, id);
    await settle();
    expect(room.adventureState()).toMatchObject({ stage: 3, portalReady: true });
    const portal = xz(ADVENTURE.portal.position);
    p.x = portal.x;
    p.z = portal.z;
    poke(p);
    room.interact(p.id, { type: 'interact', v: 1, seq: seq(), target: 'portal' });
    await settle();
    expect(room.adventureState()).toMatchObject({ echo: 1, stage: 1, sigils: 0 });
    expect(events.some((e) => e.kind === 'portal')).toBe(true);
    expect(events.some((e) => e.kind === 'power' && e.fromId === 'adventure' && e.text?.includes('The echo settles'))).toBe(true);
    expect(director.status()).toMatchObject({ echoPlans: 1, errors: 0 });
    const vesper = room.enemy('vesper')!;
    expect(vesper.hpMul).toBeCloseTo(1.2, 6);
    expect(['chase', 'flank', 'keep_distance', 'ambush']).toContain(vesper.strategy);
    await eventLog.flush();
    expect((await eventLog.searchLore('Echo 1')).length).toBeGreaterThan(0);
    await director.close();
  });
});
