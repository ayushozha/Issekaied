import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { powerForEnemyLevel, type EnemyState, type GameEvent, type GhostStrategy, type PlayerState, type PowerId, type RoomSnapshot, type Vec3 } from '../../shared/protocol';
import { CHANNELS } from './powers';
import { aimThreshold } from './entities';
import { WORLD, resolveCollisions } from './world';

/**
 * OFFLINE PREVIEW ONLY. A tiny deterministic stand-in for the authoritative room so the arena can
 * be reviewed when the backend is unreachable. It is clearly labelled in the HUD, runs in one
 * browser, persists nothing, and is torn down the moment a real welcome arrives.
 */
const PREVIEW_COOLDOWN_MS: Record<PowerId, number> = { ganesha: 4000, hanuman: 2200, shiva: 5000, vishnu: 3500 };
const PREVIEW_RANGE: Record<PowerId, number> = { ganesha: 8, hanuman: 12, shiva: 9, vishnu: 22 };
const PREVIEW_DAMAGE = 34;
const RETURN_MS = 10000;
const ENEMY_RADIUS = 0.5;
/** Haunts close to striking distance but never into the hunter's near-camera volume. */
const MELEE_STOP = WORLD.playerRadius + ENEMY_RADIUS + 0.9;
const MELEE_REACH = MELEE_STOP + 0.4;
const STRATEGY_AFTER: Record<PowerId, GhostStrategy> = { ganesha: 'keep_distance', hanuman: 'flank', shiva: 'ambush', vishnu: 'keep_distance' };

export interface PreviewHandlers {
  getSelf(): { pos: Vector3; yaw: number; pitch: number };
  onSnapshot(snap: RoomSnapshot): void;
  onEvent(ev: GameEvent): void;
}

export class LocalPreview {
  readonly selfId = 'preview-self';
  private readonly self: PlayerState;
  private readonly enemies: EnemyState[];
  private readonly slow = new Map<string, number>();
  private timer = 0;
  private tick = 0;
  private events = 0;
  private respawnAt = 0;
  private lastContact = 0;

  constructor(name: string, private readonly h: PreviewHandlers) {
    this.self = { id: this.selfId, name, position: [...WORLD.spawn] as Vec3, yaw: 0, pitch: 0, hp: 100, power: 'ganesha', cooldowns: { ganesha: 0, hanuman: 0, shiva: 0, vishnu: 0 }, ackSeq: 0 };
    this.enemies = WORLD.enemySpawns.map((s) => ({
      id: s.id,
      name: s.name,
      species: s.species,
      level: s.level,
      position: [...s.position] as Vec3,
      yaw: 0,
      hp: 60 + s.level * 12,
      maxHp: 60 + s.level * 12,
      state: 'hunting' as const,
      strategy: 'chase' as const,
      memory: { banishments: 0, version: 1 },
      returnsAt: 0,
    }));
  }

  start(): void {
    if (this.timer) return;
    this.timer = window.setInterval(() => this.step(0.1), 100);
    this.emit({ kind: 'whisper', fromId: 'system', text: 'Offline preview: haunts are simulated locally; nothing is saved.' });
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
  }

  get running(): boolean {
    return this.timer !== 0;
  }

  /** Mirrors the server contract: the caller supplies only an aim; the enemy level picks the channel. */
  cast(aim: Vec3): void {
    if (this.self.hp <= 0) return;
    const now = Date.now();
    const origin = this.h.getSelf().pos;
    const dir = Vector3.FromArray(aim);
    // Same cone rule as the HUD/prediction so the predicted channel matches the preview's choice.
    let target: EnemyState | null = null;
    let bestScore = -Infinity;
    for (const e of this.enemies) {
      if (e.state === 'banished') continue;
      const to = Vector3.FromArray(e.position).subtract(origin);
      const dist = to.length();
      const cos = Vector3.Dot(to.scale(1 / Math.max(dist, 0.01)), dir);
      if (dist < 0.5 || dist > 45 || cos < aimThreshold(dist)) continue;
      const score = cos - dist * 0.002;
      if (score > bestScore) {
        bestScore = score;
        target = e;
      }
    }
    const power = powerForEnemyLevel(target?.level ?? 1);
    if (this.self.cooldowns[power] > now) return;
    this.self.cooldowns = { ...this.self.cooldowns, [power]: now + PREVIEW_COOLDOWN_MS[power] };
    this.self.power = power;
    this.emit({ kind: 'cast', fromId: this.selfId, power, position: [origin.x, origin.y, origin.z] });
    if (!target) return;
    const dist = Vector3.Distance(Vector3.FromArray(target.position), origin);
    if (dist > PREVIEW_RANGE[power]) return;
    target.hp = Math.max(0, target.hp - PREVIEW_DAMAGE);
    this.emit({ kind: 'hit', fromId: this.selfId, toId: target.id, power, position: [...target.position] as Vec3 });
    if (power === 'shiva') this.slow.set(target.id, now + 3000);
    if (target.hp <= 0) this.banish(target, power, now);
  }

  private banish(e: EnemyState, power: PowerId, now: number): void {
    e.state = 'banished';
    e.returnsAt = now + RETURN_MS;
    e.memory = { ...e.memory, banishments: e.memory.banishments + 1, lastPower: power, lastHunterName: this.self.name, version: e.memory.version + 1 };
    e.strategy = STRATEGY_AFTER[power];
    this.emit({ kind: 'banish', fromId: this.selfId, toId: e.id, power, position: [...e.position] as Vec3 });
    const witness = this.enemies.find((o) => o.id !== e.id && o.state !== 'banished');
    if (witness) {
      this.emit({ kind: 'whisper', fromId: witness.id, text: `${e.name} fell to ${CHANNELS[power].deity}'s ${CHANNELS[power].effect}. I will ${e.strategy.replace('_', ' ')} instead.` });
      witness.strategy = STRATEGY_AFTER[power];
      this.emit({ kind: 'power', fromId: witness.id, text: `${witness.name} changes tactics: ${witness.strategy.replace('_', ' ')}` });
    }
  }

  private step(dt: number): void {
    const now = Date.now();
    const me = this.h.getSelf();
    this.self.position = [me.pos.x, me.pos.y, me.pos.z];
    this.self.yaw = me.yaw;
    this.self.pitch = me.pitch;

    if (this.self.hp <= 0 && now >= this.respawnAt) {
      this.self.hp = 100;
      this.self.position = [...WORLD.spawn] as Vec3;
      this.emit({ kind: 'return', fromId: this.selfId, position: this.self.position, text: `${this.self.name} returns to the gate.` });
    }

    for (const e of this.enemies) {
      if (e.state === 'banished') {
        if (now >= e.returnsAt) {
          e.state = 'hunting';
          e.hp = e.maxHp;
          const spawn = WORLD.enemySpawns.find((s) => s.id === e.id);
          if (spawn) e.position = [...spawn.position] as Vec3;
          this.emit({ kind: 'return', fromId: e.id, position: e.position, text: `${e.name} returns, remembering ${this.self.name}.` });
          this.emit({ kind: 'whisper', fromId: e.id, text: `I remember you, ${this.self.name}.` });
        }
        continue;
      }
      const pos = Vector3.FromArray(e.position);
      const to = me.pos.subtract(pos);
      to.y = 0;
      const dist = to.length();
      const dir = dist > 0.01 ? to.scale(1 / dist) : Vector3.Zero();
      const slowed = (this.slow.get(e.id) ?? 0) > now ? 0.4 : 1;
      let speed = (2.2 + e.level * 0.15) * slowed;
      const approach = dist > MELEE_STOP ? dir : Vector3.Zero();
      let move = approach;
      switch (e.strategy) {
        case 'keep_distance':
          move = dist < 9 ? dir.scale(-1) : dist > 12 ? dir : Vector3.Zero();
          break;
        case 'flank':
          move = dist > 3 ? dir.scale(0.6).add(new Vector3(-dir.z, 0, dir.x).scale(0.8)) : approach;
          break;
        case 'ambush':
          if (dist > 9) speed = 0;
          else speed *= 1.6;
          break;
      }
      if (this.self.hp <= 0) speed = 0;
      // Never cross the melee line in one step, whatever the speed.
      pos.addInPlace(move.scale(Math.min(speed * dt, Math.max(0, dist - MELEE_STOP) + 0.001)));
      resolveCollisions(pos, ENEMY_RADIUS);
      // Enforce separation even if the hunter walked into the haunt.
      const gap = pos.subtract(me.pos);
      gap.y = 0;
      let g = gap.length();
      if (g < MELEE_STOP) {
        const away = g > 0.01 ? gap.scale(1 / g) : new Vector3(-Math.sin(me.yaw), 0, -Math.cos(me.yaw));
        pos.set(me.pos.x + away.x * MELEE_STOP, pos.y, me.pos.z + away.z * MELEE_STOP);
        resolveCollisions(pos, ENEMY_RADIUS);
        g = MELEE_STOP;
      }
      e.position = [pos.x, 1.2, pos.z];
      e.yaw = Math.atan2(dir.x, dir.z);
      if (g <= MELEE_REACH && this.self.hp > 0 && now - this.lastContact > 500) {
        this.lastContact = now;
        this.self.hp = Math.max(0, this.self.hp - 6);
        this.emit({ kind: 'hit', fromId: e.id, toId: this.selfId, position: this.self.position });
        if (this.self.hp <= 0) {
          this.respawnAt = now + 4000;
          this.emit({ kind: 'death', fromId: this.selfId, toId: e.id, text: `${this.self.name} fell to ${e.name}.` });
        }
      }
    }

    this.tick += 1;
    this.h.onSnapshot({ tick: this.tick, serverTime: now, players: [{ ...this.self }], enemies: this.enemies.map((e) => ({ ...e, position: [...e.position] as Vec3 })) });
  }

  private emit(partial: Omit<GameEvent, 'type' | 'eventId' | 'tick'>): void {
    this.h.onEvent({ type: 'event', eventId: `preview-${++this.events}`, tick: this.tick, ...partial });
  }
}
