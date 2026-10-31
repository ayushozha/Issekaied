import { describe, expect, test } from 'bun:test';
import { powerForEnemyLevel, type CombatAction, type Vec3 } from '../../shared/protocol';
import { counterStrategy } from '../../actor/src/memory.ts';
import { HEAL, IDLE_INACTIVE_MS, INCANTATION_HP_COST, PLAYER_MAX_HP, POWERS, PRIMARY, STALE_INPUT_MS, WARD, enemyMaxHp, returnDelayMs } from './combat.ts';
import type { ServerEvent } from './events.ts';
import { Room, playerIdFor, type RoomEnemy, type RoomPlayer, type RoomSignal } from './room.ts';
import { ADVENTURE, MELEE_STOP, WORLD, dist2d, inSafeZone, xz } from './world.ts';

const KEY_A = 'guest-key-aaaaaaaa-1111';
const KEY_B = 'guest-key-bbbbbbbb-2222';
const KEY_C = 'guest-key-cccccccc-3333';

/** Fake clock + a scripted hunter that sends deliberate input, like a real client does, every tick. */
function makeRoom(capacity = 2) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const events: ServerEvent[] = [];
  const signals: RoomSignal[] = [];
  const room = new Room('bellgrave', { capacity, tickRate: 20, now: clock.now, onEvent: (e) => events.push(e), onSignal: (s) => signals.push(s) });
  const seqs = new Map<string, number>();
  const next = (p: RoomPlayer) => {
    const n = (seqs.get(p.id) ?? 0) + 1;
    seqs.set(p.id, n);
    return n;
  };
  const input = (p: RoomPlayer, moveX = 0, moveZ = 0, extra: { sprint?: boolean; active?: boolean; yaw?: number } = {}) =>
    room.applyInput(p.id, { type: 'input', v: 1, seq: next(p), moveX, moveZ, yaw: extra.yaw ?? 0, pitch: 0, sprint: extra.sprint ?? false, ...(extra.active === undefined ? {} : { active: extra.active }) });
  const cast = (p: RoomPlayer, action: CombatAction, aim: Vec3 = [0, 0, 1]) => room.cast(p.id, { type: 'cast', v: 1, seq: next(p), aim, action });
  const interact = (p: RoomPlayer, target: 'shrine' | 'portal' | 'respawn') => room.interact(p.id, { type: 'interact', v: 1, seq: next(p), target });
  const tick = (ticks = 1) => {
    for (let i = 0; i < ticks; i++) {
      clock.advance(50);
      room.step();
    }
  };
  /** Keep sending zero movement so the hunter counts as deliberately present. */
  const idle = (p: RoomPlayer, ticks: number) => {
    for (let i = 0; i < ticks; i++) {
      input(p);
      tick();
    }
  };
  /** Walk toward a point for `ticks`, re-sending the direction every tick. */
  const walkTo = (p: RoomPlayer, to: { x: number; z: number }, ticks: number, sprint = true) => {
    for (let i = 0; i < ticks; i++) {
      const dx = to.x - p.x;
      const dz = to.z - p.z;
      const len = Math.hypot(dx, dz) || 1;
      if (len < 0.3) input(p);
      else input(p, dx / len, dz / len, { sprint });
      tick();
    }
  };
  const aimAt = (p: RoomPlayer, e: RoomEnemy): Vec3 => {
    const dx = e.x - p.x;
    const dy = 1.2 - p.y;
    const dz = e.z - p.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    return [dx / l, dy / l, dz / l];
  };
  const join = (key: string, name: string) => {
    const r = room.join(key, name);
    if (!r.ok) throw new Error(r.code);
    return r.player;
  };
  /** Fight like a player from 5 m: incantations when the deity allows, primary strikes in between (an adapted haunt may keep its distance). */
  const banishWith = (p: RoomPlayer, e: RoomEnemy, maxActions = 60) => {
    p.x = e.x;
    p.z = e.z - 5;
    p.hp = PLAYER_MAX_HP;
    for (let i = 0; i < maxActions && e.state === 'hunting'; i++) {
      input(p);
      cast(p, i % 4 === 0 ? 'incantation' : 'primary', aimAt(p, e));
      tick(Math.ceil((PRIMARY.cooldownMs + 60) / 50)); // real time passes: a knocked-back haunt walks back
      p.hp = PLAYER_MAX_HP; // the test is about the haunt; keep the hunter alive
    }
    return e.state === 'banished';
  };
  return { room, clock, events, signals, input, cast, interact, tick, idle, walkTo, aimAt, join, banishWith };
}

describe('membership and identity', () => {
  test('ids are stable, non-reversible, and capacity is enforced', () => {
    const { room, join } = makeRoom(2);
    const a = join(KEY_A, 'Ayla');
    const b = join(KEY_B, 'Bram');
    expect(a.id).toBe(playerIdFor(KEY_A));
    expect(a.id).not.toContain(KEY_A);
    expect(a.id).toHaveLength(12);
    expect(b.id).not.toBe(a.id);
    expect(room.join(KEY_C, 'Cass')).toEqual({ ok: false, code: 'room_full' });
    expect(JSON.stringify(room.snapshot())).not.toContain(KEY_A);
    expect(inSafeZone(a)).toBe(true);
  });

  test('a disconnected hunter leaves the snapshot and reattaches with the same id and HP', () => {
    const { room, join } = makeRoom();
    const a = join(KEY_A, 'Ayla');
    a.hp = 40;
    room.leave(a.id);
    expect(room.snapshot().players).toHaveLength(0);
    const again = room.join(KEY_A, 'Ayla');
    expect(again.ok && again.reconnected).toBe(true);
    expect(again.ok && again.player.id).toBe(a.id);
    expect(again.ok && again.player.hp).toBe(40);
    expect(room.snapshot().players.map((p) => p.id)).toEqual([a.id]);
  });

  test('a reloaded client restarts at seq 1: rejoin resets the per-connection sequence (live hunter)', () => {
    const { room, clock, join, tick } = makeRoom();
    const a = join(KEY_A, 'Ayla');
    a.x = 0;
    room.applyInput(a.id, { type: 'input', v: 1, seq: 4698, moveX: 0, moveZ: 1, yaw: 0, pitch: 0, sprint: true });
    tick(3);
    a.hp = 55;
    a.skillCooldowns = { primary: clock.now() + 5000 };
    const cooldownsBefore = { ...a.cooldowns };
    const [x, z] = [a.x, a.z];
    expect(a.lastSeq).toBe(4698);
    expect(a.move.z).toBe(1);

    const again = room.join(KEY_A, 'Ayla'); // no leave in between: the old socket is still live
    expect(again.ok && again.reconnected).toBe(true);
    expect(again.ok && again.player).toBe(a);
    expect(a.lastSeq).toBe(0);
    expect(a.ackSeq).toBe(0);
    expect(a.active).toBe(false); // stays safe until the new connection sends intent
    expect(a.move).toEqual({ x: 0, z: 0, sprint: false });
    expect(a.speed).toBe(0);
    tick(2);
    expect([a.x, a.z]).toEqual([x, z]); // old movement does not carry over
    expect(a.hp).toBe(55);
    expect(a.cooldowns).toEqual(cooldownsBefore);
    expect(a.skillCooldowns.primary).toBeGreaterThan(clock.now());

    // Fresh connection seq 1 is accepted immediately and moves the hunter.
    room.applyInput(a.id, { type: 'input', v: 1, seq: 1, moveX: 0, moveZ: 1, yaw: 0, pitch: 0, sprint: true });
    expect(a.ackSeq).toBe(1);
    expect(a.active).toBe(true);
    tick(3);
    expect(a.z).toBeGreaterThan(z);

    // Duplicate / replayed seq within the new connection is still rejected.
    room.applyInput(a.id, { type: 'input', v: 1, seq: 2, moveX: 1, moveZ: 0, yaw: 0, pitch: 0, sprint: false });
    room.applyInput(a.id, { type: 'input', v: 1, seq: 1, moveX: -1, moveZ: 0, yaw: 0, pitch: 0, sprint: true });
    room.applyInput(a.id, { type: 'input', v: 1, seq: 2, moveX: -1, moveZ: 0, yaw: 0, pitch: 0, sprint: true });
    expect(a.ackSeq).toBe(2);
    expect(a.move).toEqual({ x: 1, z: 0, sprint: false });
  });

  test('a parked hunter rejoining also restarts at seq 1 and keeps HP and cooldowns', () => {
    const { room, clock, join, tick } = makeRoom();
    const a = join(KEY_A, 'Ayla');
    room.applyInput(a.id, { type: 'input', v: 1, seq: 4698, moveX: 1, moveZ: 0, yaw: 0, pitch: 0, sprint: true });
    tick(2);
    a.hp = 40;
    a.skillCooldowns = { secondary: clock.now() + 9000 };
    room.leave(a.id);
    expect(room.players.size).toBe(0);

    const again = room.join(KEY_A, 'Ayla');
    expect(again.ok && again.player).toBe(a);
    expect(room.players.get(a.id)).toBe(a);
    expect(a.lastSeq).toBe(0);
    expect(a.active).toBe(false);
    expect(a.move).toEqual({ x: 0, z: 0, sprint: false });
    expect(a.hp).toBe(40);
    expect(a.skillCooldowns.secondary).toBeGreaterThan(clock.now());
    expect(room.snapshot().players[0]).toMatchObject({ id: a.id, ackSeq: 0, active: false });

    const x = a.x;
    room.applyInput(a.id, { type: 'input', v: 1, seq: 1, moveX: 1, moveZ: 0, yaw: 0, pitch: 0, sprint: false });
    tick(3);
    expect(a.ackSeq).toBe(1);
    expect(a.x).toBeGreaterThan(x);
    room.applyInput(a.id, { type: 'input', v: 1, seq: 1, moveX: -1, moveZ: 0, yaw: 0, pitch: 0, sprint: false }); // replay
    expect(a.move.x).toBe(1);
  });
});

describe('deliberate movement', () => {
  test('input is a direction, not a position: speed is capped and obstacles block', () => {
    const { join, input, tick, walkTo } = makeRoom();
    const a = join(KEY_A, 'Ayla');
    a.x = 0; // line up with the fountain (x -2..2, z -8..-4) north of the gate
    const startZ = a.z;
    input(a, 0, 1000, { sprint: true });
    tick();
    expect(a.z - startZ).toBeGreaterThan(0);
    expect(a.z - startZ).toBeLessThanOrEqual(WORLD.sprintSpeed * 0.05 + 1e-9);
    walkTo(a, { x: 0, z: 0 }, 60);
    expect(a.z).toBeCloseTo(-8 - WORLD.playerRadius, 6);
    expect(a.x).toBe(0);
  });

  test('stale input stops the hunter and a silent client becomes inactive', () => {
    const { room, join, input, tick } = makeRoom();
    const a = join(KEY_A, 'Ayla');
    expect(STALE_INPUT_MS).toBeLessThanOrEqual(220);
    input(a, 0, 1, { sprint: true });
    tick(Math.ceil(STALE_INPUT_MS / 50) + 1);
    expect(a.move.sprint).toBe(false);
    const frozenZ = a.z;
    tick(20);
    expect(a.z).toBe(frozenZ); // no walking without fresh input
    expect(a.active).toBe(true);
    tick(Math.ceil(IDLE_INACTIVE_MS / 50));
    expect(a.active).toBe(false);
    expect(room.snapshot().players[0].active).toBe(false);
    input(a); // any deliberate input resumes
    expect(a.active).toBe(true);
  });

  test('paused hunters neither move nor act, and haunts lose interest in them', () => {
    const { room, join, input, cast, tick, events } = makeRoom();
    const a = join(KEY_A, 'Ayla');
    const morrow = room.enemy('morrow')!;
    a.x = morrow.x;
    a.z = morrow.z - 3;
    input(a);
    tick();
    expect(morrow.targetId).toBe(a.id);
    input(a, 0, 1, { sprint: true, active: false });
    const z = a.z;
    tick(5);
    expect(a.z).toBe(z);
    expect(morrow.targetId).toBeNull();
    const hits = events.filter((e) => e.kind === 'hit' && e.toId === a.id).length;
    input(a, 0, 0, { active: false });
    tick(40);
    expect(events.filter((e) => e.kind === 'hit' && e.toId === a.id).length).toBe(hits);
    cast(a, 'primary');
    expect(events.some((e) => e.kind === 'cast' && e.fromId === a.id)).toBe(false);
  });

  test('stale or replayed sequence numbers are ignored', () => {
    const { room, join } = makeRoom();
    const a = join(KEY_A, 'Ayla');
    room.applyInput(a.id, { type: 'input', v: 1, seq: 5, moveX: 0, moveZ: 0, yaw: 1, pitch: 0, sprint: false });
    room.applyInput(a.id, { type: 'input', v: 1, seq: 3, moveX: 0, moveZ: 0, yaw: 2, pitch: 0, sprint: false });
    expect(a.yaw).toBe(1);
    expect(a.ackSeq).toBe(5);
  });
});

describe('explicit actions', () => {
  test('primary strikes the aimed haunt, respects its own cooldown, and rejects spam and replays', () => {
    const { room, clock, join, input, cast, aimAt, events } = makeRoom();
    const a = join(KEY_A, 'Ayla');
    const morrow = room.enemy('morrow')!;
    a.x = morrow.x;
    a.z = morrow.z - 5;
    input(a);
    cast(a, 'primary', aimAt(a, morrow));
    expect(events.filter((e) => e.kind === 'cast' && e.action === 'primary')).toHaveLength(1);
    expect(events.find((e) => e.kind === 'hit')?.action).toBe('primary');
    expect(morrow.hp).toBe(enemyMaxHp(1) - PRIMARY.damage);
    expect(morrow.targetId).toBe(a.id); // being struck wakes the haunt
    for (let i = 0; i < 5; i++) cast(a, 'primary', aimAt(a, morrow)); // spam inside the cooldown
    room.cast(a.id, { type: 'cast', v: 1, seq: 1, aim: aimAt(a, morrow), action: 'primary' }); // replayed seq
    expect(events.filter((e) => e.kind === 'cast')).toHaveLength(1);
    clock.advance(PRIMARY.cooldownMs + 1);
    cast(a, 'primary', aimAt(a, morrow));
    expect(events.filter((e) => e.kind === 'cast')).toHaveLength(2);
    expect(morrow.hp).toBe(enemyMaxHp(1) - 2 * PRIMARY.damage);
  });

  test('incantation draws the deity from the haunt level and keeps per-deity cooldowns', () => {
    const { room, clock, join, input, cast, aimAt, events } = makeRoom();
    const a = join(KEY_A, 'Ayla');
    const morrow = room.enemy('morrow')!;
    a.x = morrow.x;
    a.z = morrow.z - 5;
    input(a);
    cast(a, 'incantation', aimAt(a, morrow));
    const c = events.find((e) => e.kind === 'cast');
    expect(c?.action).toBe('incantation');
    expect(c?.power).toBe(powerForEnemyLevel(morrow.level));
    expect(morrow.hp).toBe(enemyMaxHp(1) - POWERS.ganesha.damage);
    expect(a.wardUntil).toBeGreaterThan(clock.now()); // Ganesha also wards
    clock.advance(200);
    cast(a, 'incantation', aimAt(a, morrow));
    expect(events.filter((e) => e.kind === 'cast')).toHaveLength(1); // Ganesha is on cooldown
    clock.advance(POWERS.ganesha.cooldownMs);
    cast(a, 'incantation', aimAt(a, morrow));
    expect(events.filter((e) => e.kind === 'cast')).toHaveLength(2);
    const raksha = room.enemy('raksha')!;
    a.x = raksha.x;
    a.z = raksha.z - 10;
    cast(a, 'incantation', [0, 0, 10]); // scaled aim is rejected
    expect(events.filter((e) => e.kind === 'cast')).toHaveLength(2);
    clock.advance(200);
    cast(a, 'incantation', aimAt(a, raksha));
    expect(events.filter((e) => e.kind === 'cast').at(-1)?.power).toBe('vishnu');
  });

  test('ward halves damage and repels; heal is bounded with a long cooldown; the dead cannot act', () => {
    const { room, clock, join, input, cast, tick, events } = makeRoom();
    const a = join(KEY_A, 'Ayla');
    const morrow = room.enemy('morrow')!;
    a.x = morrow.x;
    a.z = morrow.z - 2;
    input(a);
    cast(a, 'secondary');
    expect(events.at(-1)).toMatchObject({ kind: 'cast', action: 'secondary' });
    expect(dist2d(a, morrow)).toBeGreaterThanOrEqual(2 + WARD.repelM - 1e-6);
    expect(a.wardUntil).toBe(clock.now() + WARD.durationMs);
    cast(a, 'secondary');
    expect(events.filter((e) => e.action === 'secondary')).toHaveLength(1); // cooldown
    a.hp = 50;
    clock.advance(200);
    cast(a, 'heal');
    expect(a.hp).toBe(50 + HEAL.amount);
    cast(a, 'heal');
    expect(events.filter((e) => e.action === 'heal')).toHaveLength(1);
    a.hp = PLAYER_MAX_HP - 5;
    clock.advance(HEAL.cooldownMs);
    cast(a, 'heal');
    expect(a.hp).toBe(PLAYER_MAX_HP); // bounded
    a.hp = 0;
    const casts = events.filter((e) => e.kind === 'cast').length;
    clock.advance(1000);
    cast(a, 'primary');
    cast(a, 'heal');
    tick(5);
    expect(events.filter((e) => e.kind === 'cast').length).toBe(casts);
  });
});

describe('fifty haunts and the Q cost', () => {
  test('exactly 50 stable haunts: the four quest haunts unchanged, 46 outer ones outside the core, inside bounds, non-overlapping, all beyond the safe gate', () => {
    const { room } = makeRoom();
    expect(room.enemies).toHaveLength(50);
    expect(new Set(room.enemies.map((e) => e.id)).size).toBe(50);
    expect(room.enemies.slice(0, 4).map((e) => [e.id, e.level, e.home])).toEqual(WORLD.enemySpawns.map((s) => [s.id, s.level, { x: s.position[0], z: s.position[2] }]));
    const outer = room.enemies.slice(4);
    expect(outer.map((e) => e.id).slice(0, 7)).toEqual(['ghost-01', 'ghoul-02', 'goblin-03', 'orc-04', 'beast-05', 'rakshasa-06', 'ghost-07']);
    for (const e of outer) {
      expect(Math.hypot(e.home.x, e.home.z)).toBeGreaterThan(32);
      expect(Math.abs(e.home.x)).toBeLessThan(64 - ADVENTURE.leashRadius / 2);
      expect(e.level).toBeGreaterThanOrEqual(1);
      expect(e.level).toBeLessThanOrEqual(9);
      expect(dist2d(e.home, xz(WORLD.spawn))).toBeGreaterThan(ADVENTURE.safeSpawnRadius + ADVENTURE.aggroRadius); // a haunt at home can never aggro the gate
    }
    for (let i = 0; i < room.enemies.length; i++) for (let j = i + 1; j < room.enemies.length; j++) expect(dist2d(room.enemies[i].home, room.enemies[j].home)).toBeGreaterThan(3);
    const snap = room.snapshot();
    expect(snap.enemies).toHaveLength(50);
    expect(snap.enemies.find((e) => e.id === 'ghost-01')?.baseId).toBe('morrow');
    expect(snap.enemies.find((e) => e.id === 'rakshasa-06')?.baseId).toBe('raksha');
    expect(snap.enemies.find((e) => e.id === 'vesper')?.baseId).toBe('vesper');
    expect(room.adventureState().targetId).toBe('morrow');
  });

  test('Q costs 25% max HP, is refused when unaffordable, and never kills the caster', () => {
    const { room, clock, join, input, cast, events } = makeRoom();
    const a = join(KEY_A, 'Ayla');
    a.x = room.enemy('morrow')!.x;
    a.z = room.enemy('morrow')!.z - 5;
    input(a);
    cast(a, 'incantation');
    expect(a.hp).toBe(PLAYER_MAX_HP - INCANTATION_HP_COST);
    expect(events.find((e) => e.kind === 'cast')?.hpCost).toBe(INCANTATION_HP_COST);
    a.hp = INCANTATION_HP_COST; // exactly the cost: would leave 0 HP
    const casts = events.filter((e) => e.kind === 'cast').length;
    cast(a, 'incantation');
    expect(a.hp).toBe(INCANTATION_HP_COST);
    expect(events.filter((e) => e.kind === 'cast').length).toBe(casts);
    expect(a.cooldowns.ganesha).toBeLessThanOrEqual(room.snapshot().serverTime + POWERS.ganesha.cooldownMs); // no cooldown was charged for the refusal
    a.hp = INCANTATION_HP_COST + 1;
    clock.advance(200);
    cast(a, 'primary'); // free actions still work
    expect(events.filter((e) => e.kind === 'cast').length).toBe(casts + 1);
    expect(a.hp).toBe(INCANTATION_HP_COST + 1);
  });
});

describe('local encounters', () => {
  test('idle hunters at the safe gate are never targeted, attacked or moved', () => {
    const { room, join, idle, events } = makeRoom();
    const a = join(KEY_A, 'Ayla');
    const start = { x: a.x, z: a.z };
    idle(a, 200); // ten seconds of deliberate presence, no movement
    expect({ x: a.x, z: a.z }).toEqual(start);
    expect(a.hp).toBe(PLAYER_MAX_HP);
    expect(events.filter((e) => e.kind === 'hit' || e.kind === 'death')).toHaveLength(0);
    for (const e of room.enemies) {
      expect(e.targetId).toBeNull();
      expect(dist2d(e, e.home)).toBeLessThanOrEqual(ADVENTURE.leashRadius);
      expect(room.snapshot().enemies.find((s) => s.id === e.id)?.aggro).toBe(false);
    }
  });

  test('haunts patrol near home, aggro locally, and leash back when the hunter runs', () => {
    const { room, join, idle, walkTo, tick } = makeRoom();
    const a = join(KEY_A, 'Ayla');
    const morrow = room.enemy('morrow')!;
    const nix = room.enemy('nix')!;
    tick(100);
    expect(dist2d(morrow, morrow.home)).toBeLessThanOrEqual(ADVENTURE.leashRadius);
    expect(dist2d(morrow, morrow.home)).toBeGreaterThan(0.5); // it patrols rather than standing still

    // Aggro is measured from the haunt itself (it patrols a 2.5 m loop), so place the hunter relative to it.
    a.x = morrow.x;
    a.z = morrow.z - (ADVENTURE.aggroRadius + 4);
    idle(a, 5);
    expect(morrow.targetId).toBeNull(); // outside its aggro radius
    a.z = morrow.z - (ADVENTURE.aggroRadius - 2);
    idle(a, 2);
    expect(morrow.targetId).toBe(a.id);
    expect(nix.targetId).toBeNull(); // the other haunt is far away and does not pile on

    // Run away past the leash: the haunt gives up and heads home, never leaving its boundary.
    walkTo(a, { x: morrow.home.x, z: morrow.home.z - 30 }, 120);
    expect(dist2d(a, morrow.home)).toBeGreaterThan(ADVENTURE.leashRadius);
    expect(morrow.targetId).toBeNull();
    for (let i = 0; i < 100; i++) {
      tick();
      expect(dist2d(morrow, morrow.home)).toBeLessThanOrEqual(ADVENTURE.leashRadius + 1e-6);
    }
    expect(dist2d(morrow, morrow.home)).toBeLessThan(5);
  });

  test('haunts never enter the melee volume even when the hunter walks into them, yet still land hits', () => {
    const { room, join, walkTo, tick, events } = makeRoom();
    const a = join(KEY_A, 'Ayla');
    const morrow = room.enemy('morrow')!;
    a.x = morrow.x;
    a.z = morrow.z;
    tick();
    expect(dist2d(a, morrow)).toBeGreaterThanOrEqual(MELEE_STOP - 1e-6);
    for (let i = 0; i < 100; i++) {
      walkTo(a, morrow, 1);
      for (const e of room.enemies) if (e.state !== 'banished') expect(dist2d(a, e)).toBeGreaterThanOrEqual(MELEE_STOP - 1e-6);
    }
    expect(events.some((e) => e.kind === 'hit' && e.toId === a.id)).toBe(true);
  });

  test('defeat is final until an explicit respawn; nothing attacks at the gate afterwards', () => {
    const { room, join, idle, interact, tick, events } = makeRoom();
    const a = join(KEY_A, 'Ayla');
    const raksha = room.enemy('raksha')!;
    raksha.gated = false; // fight the boss directly for this test
    a.x = raksha.x;
    a.z = raksha.z - 1.5;
    idle(a, 400);
    expect(a.hp).toBe(0);
    expect(events.some((e) => e.kind === 'death' && e.fromId === a.id)).toBe(true);
    const deaths = events.filter((e) => e.kind === 'death').length;
    const hits = events.filter((e) => e.kind === 'hit' && e.toId === a.id).length;
    idle(a, 200); // ten more seconds dead: no automatic respawn, no more hits
    expect(a.hp).toBe(0);
    expect(events.filter((e) => e.kind === 'return' && e.fromId === a.id)).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'hit' && e.toId === a.id).length).toBe(hits);
    expect(events.filter((e) => e.kind === 'death').length).toBe(deaths);
    interact(a, 'respawn');
    expect(a.hp).toBe(PLAYER_MAX_HP);
    expect(inSafeZone(a)).toBe(true);
    expect(events.filter((e) => e.kind === 'return' && e.fromId === a.id)).toHaveLength(1);
    idle(a, 100);
    expect(a.hp).toBe(PLAYER_MAX_HP);
    const ids = events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    tick();
  });
});

describe('cooperative progression', () => {
  test('three distinct sigils unlock the gated boss; repeats never count twice; the boss opens the portal', () => {
    const { room, clock, join, input, cast, aimAt, banishWith, tick, events } = makeRoom();
    const a = join(KEY_A, 'Ayla');
    const b = join(KEY_B, 'Bram');
    const raksha = room.enemy('raksha')!;
    expect(room.adventureState()).toMatchObject({ stage: 1, sigils: 0, portalReady: false, bossDefeated: false, echo: 0, targetId: 'morrow' });

    // The gated boss ignores damage and never hunts, even with a hunter in its face.
    a.x = raksha.x;
    a.z = raksha.z - 3;
    input(a);
    cast(a, 'incantation', aimAt(a, raksha));
    expect(raksha.hp).toBe(raksha.maxHp);
    expect(events.some((e) => e.kind === 'hit' && e.toId === 'raksha')).toBe(false);
    expect(events.some((e) => e.kind === 'power' && e.fromId === 'raksha' && e.text?.includes('warded'))).toBe(true);
    for (let i = 0; i < 40; i++) {
      input(a);
      tick();
    }
    expect(raksha.targetId).toBeNull();
    expect(a.hp).toBe(PLAYER_MAX_HP - INCANTATION_HP_COST); // only the Q cost, no boss damage

    expect(banishWith(a, room.enemy('morrow')!)).toBe(true);
    expect(room.adventureState()).toMatchObject({ stage: 1, sigils: 1, targetId: 'nix' });
    expect(banishWith(b, room.enemy('nix')!)).toBe(true); // a different hunter contributes
    expect(room.adventureState()).toMatchObject({ stage: 1, sigils: 2, targetId: 'vesper' });

    // Morrow returns and is banished again: still one sigil for Morrow.
    const morrow = room.enemy('morrow')!;
    clock.advance(returnDelayMs(1) + 2000);
    tick(40);
    expect(morrow.state).toBe('hunting');
    expect(banishWith(a, morrow)).toBe(true);
    expect(room.adventureState().sigils).toBe(2);

    expect(banishWith(b, room.enemy('vesper')!)).toBe(true);
    expect(room.adventureState()).toMatchObject({ stage: 2, sigils: 3, targetId: 'raksha', portalReady: false });
    expect(raksha.gated).toBe(false);
    expect(events.filter((e) => e.kind === 'quest')).toHaveLength(3);

    expect(banishWith(a, raksha)).toBe(true);
    expect(room.adventureState()).toMatchObject({ stage: 3, sigils: 3, bossDefeated: true, portalReady: true, targetId: ADVENTURE.portal.id });
    // Raksha returning and falling again grants nothing new.
    clock.advance(returnDelayMs(9) + 2000);
    tick(40);
    expect(banishWith(a, raksha)).toBe(true);
    expect(events.filter((e) => e.kind === 'quest')).toHaveLength(4);
    expect(room.adventureState()).toMatchObject({ stage: 3, echo: 0 });
  });

  test('the echo portal needs proximity and a defeated boss, then restarts the same courtyard changed', () => {
    const { room, clock, join, input, interact, banishWith, tick, events, signals } = makeRoom();
    const a = join(KEY_A, 'Ayla');
    const portal = xz(ADVENTURE.portal.position);
    a.x = portal.x;
    a.z = portal.z;
    input(a);
    interact(a, 'portal');
    expect(events.some((e) => e.kind === 'portal')).toBe(false);
    expect(events.some((e) => e.kind === 'power' && e.text?.includes('sealed'))).toBe(true);

    for (const id of ['morrow', 'nix', 'vesper', 'raksha']) expect(banishWith(a, room.enemy(id)!)).toBe(true);
    expect(room.adventureState().portalReady).toBe(true);
    a.x = portal.x + 10;
    a.z = portal.z;
    input(a);
    interact(a, 'portal');
    expect(events.some((e) => e.kind === 'portal')).toBe(false); // too far away
    a.x = portal.x;
    clock.advance(200);
    input(a);
    interact(a, 'portal');
    const portalEvent = events.find((e) => e.kind === 'portal');
    expect(portalEvent?.fromId).toBe(a.id);
    expect(room.adventureState()).toMatchObject({ stage: 1, sigils: 0, echo: 1, portalReady: false, bossDefeated: false, targetId: 'morrow' });
    const morrow = room.enemy('morrow')!;
    expect(morrow.state).toBe('hunting');
    expect(morrow.maxHp).toBe(Math.round(enemyMaxHp(1) * 1.2));
    expect(morrow.hp).toBe(morrow.maxHp);
    expect([morrow.x, morrow.z]).toEqual([morrow.home.x, morrow.home.z]);
    expect(morrow.strategy).toBe(counterStrategy('ganesha')); // it remembers how it fell
    expect(room.enemy('raksha')!.gated).toBe(true);
    expect(signals.some((s) => s.type === 'portal' && s.echo === 1)).toBe(true);
    expect(room.snapshot().adventure?.echo).toBe(1);

    // A rehearsed plan is clamped and only applies to the current echo.
    expect(room.applyEchoPlan({ echo: 7, enemies: [], rationale: 'stale' })).toBe(false);
    expect(room.applyEchoPlan({ echo: 1, enemies: [{ id: 'nix', strategy: 'ambush', hpMul: 9, speedMul: 0.1, aggroBonus: 99 }], rationale: 'bounded' })).toBe(true);
    const nix = room.enemy('nix')!;
    expect(nix.strategy).toBe('ambush');
    expect(nix.hpMul).toBe(1.5);
    expect(nix.speedMul).toBe(1);
    expect(nix.aggroBonus).toBe(4);
    expect(room.applyEchoPlan({ echo: 1, enemies: [{ id: 'nix', strategy: 'teleport' as never, hpMul: 1, speedMul: 1, aggroBonus: 0 }], rationale: 'junk' })).toBe(false);
    tick();
    interact(a, 'portal'); // not ready again until the boss falls once more
    expect(room.adventureState().echo).toBe(1);
  });
});
