import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import {
  powerForEnemyLevel,
  type AdventureState,
  type CombatAction,
  type EnemyState,
  type GameEvent,
  type GhostStrategy,
  type PlayerState,
  type PowerId,
  type RoomSnapshot,
  type Vec3,
} from '../../shared/protocol';
import { CHANNELS } from './powers';
import { aimThreshold } from './entities';
import { WORLD, resolveCollisions } from './world';
import type { InteractTarget } from './net';

/**
 * DEV-ONLY LOCAL SYNTHETIC PREVIEW. Never started automatically: main.ts only constructs it from an
 * explicit dev button on the connection panel, and production builds drop that button. It mirrors the
 * client contract (actions, interact, adventure) with crude constants so screens can be checked without
 * a backend. Nothing here is networked, authoritative or persisted, and the HUD says so.
 */
const COOLDOWN_MS: Record<CombatAction, number> = { primary: 700, secondary: 6000, incantation: 5000, heal: 12000 };
const POWER_RANGE: Record<PowerId, number> = { ganesha: 8, hanuman: 12, shiva: 9, vishnu: 22 };
const STRIKE_DAMAGE = 18;
const INCANTATION_DAMAGE = 40;
const RETURN_MS = 12000;
const ENEMY_RADIUS = 0.5;
const MELEE_STOP = WORLD.playerRadius + ENEMY_RADIUS + 1.5;
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
  private readonly sealed = new Set<string>();
  private timer = 0;
  private tick = 0;
  private events = 0;
  private lastContact = 0;
  private bossDefeated = false;
  private echo = 0;

  constructor(name: string, private readonly h: PreviewHandlers) {
    this.self = {
      id: this.selfId,
      name,
      position: [...WORLD.spawn] as Vec3,
      yaw: 0,
      pitch: 0,
      hp: 100,
      power: 'ganesha',
      cooldowns: { ganesha: 0, hanuman: 0, shiva: 0, vishnu: 0 },
      ackSeq: 0,
      skillCooldowns: {},
      wardUntil: 0,
      active: false,
    };
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
      aggro: false,
    }));
  }

  start(): void {
    if (this.timer) return;
    this.timer = window.setInterval(() => this.step(0.1), 100);
    this.emit({ kind: 'whisper', fromId: 'system', text: 'Local synthetic preview (dev only): nothing here is networked, authoritative or saved.' });
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
  }

  get running(): boolean {
    return this.timer !== 0;
  }

  setActive(active: boolean): void {
    this.self.active = active;
  }

  cast(aim: Vec3, action: CombatAction): void {
    const now = Date.now();
    if (this.self.hp <= 0 || (this.self.skillCooldowns?.[action] ?? 0) > now) return;
    this.self.skillCooldowns = { ...this.self.skillCooldowns, [action]: now + COOLDOWN_MS[action] };
    const origin = this.h.getSelf().pos;
    const target = this.pickTarget(origin, Vector3.FromArray(aim));
    const power = powerForEnemyLevel(target?.level ?? 1);
    this.self.power = power;
    const at: Vec3 = [origin.x, origin.y, origin.z];
    switch (action) {
      case 'secondary':
        this.self.wardUntil = now + 4000;
        this.emit({ kind: 'cast', fromId: this.selfId, action, power, position: at });
        return;
      case 'heal':
        this.self.hp = Math.min(100, this.self.hp + 30);
        this.emit({ kind: 'cast', fromId: this.selfId, action, power, position: at, text: 'synthetic recovery' });
        return;
      default: {
        this.emit({ kind: 'cast', fromId: this.selfId, action, power, position: at });
        if (!target) return;
        const dist = Vector3.Distance(Vector3.FromArray(target.position), origin);
        if (dist > POWER_RANGE[power]) return;
        target.hp = Math.max(0, target.hp - (action === 'incantation' ? INCANTATION_DAMAGE : STRIKE_DAMAGE));
        target.aggro = true;
        this.emit({ kind: 'hit', fromId: this.selfId, toId: target.id, power, action, position: [...target.position] as Vec3 });
        if (power === 'shiva') this.slow.set(target.id, now + 3000);
        if (target.hp <= 0) this.banish(target, power, now);
      }
    }
  }

  interact(target: InteractTarget): void {
    const now = Date.now();
    if (target === 'respawn') {
      if (this.self.hp > 0) return;
      this.self.hp = 100;
      this.self.position = [...WORLD.spawn] as Vec3;
      this.emit({ kind: 'return', fromId: this.selfId, position: this.self.position, text: `${this.self.name} returns to the gate.` });
      return;
    }
    if (target === 'shrine') {
      this.emit({ kind: 'quest', fromId: 'system', text: `Shrine: ${this.adventure().objective}` });
      return;
    }
    if (target === 'portal' && this.bossDefeated) {
      this.echo += 1;
      for (const e of this.enemies) {
        e.state = 'hunting';
        e.hp = e.maxHp;
        e.aggro = false;
        e.strategy = STRATEGY_AFTER[e.memory.lastPower ?? 'ganesha'];
      }
      this.sealed.clear();
      this.bossDefeated = false;
      this.emit({ kind: 'portal', fromId: 'system', position: WORLD.adventure.portal.position, text: `Echo ${this.echo}: the courtyard remembers and resets (synthetic).` });
    }
    void now;
  }

  private pickTarget(origin: Vector3, dir: Vector3): EnemyState | null {
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
    return target;
  }

  private banish(e: EnemyState, power: PowerId, now: number): void {
    e.state = 'banished';
    e.aggro = false;
    e.returnsAt = now + RETURN_MS;
    e.memory = { ...e.memory, banishments: e.memory.banishments + 1, lastPower: power, lastHunterName: this.self.name, version: e.memory.version + 1 };
    e.strategy = STRATEGY_AFTER[power];
    this.emit({ kind: 'banish', fromId: this.selfId, toId: e.id, power, position: [...e.position] as Vec3 });
    const adv = WORLD.adventure;
    if (adv.sigilEnemyIds.includes(e.id) && !this.sealed.has(e.id)) {
      this.sealed.add(e.id);
      this.emit({ kind: 'quest', fromId: 'system', text: `Sigil ${this.sealed.size} of ${adv.sigilEnemyIds.length} sealed: ${e.name} is silenced (synthetic).` });
    } else if (e.id === adv.bossId && this.sealed.size >= adv.sigilEnemyIds.length) {
      this.bossDefeated = true;
      this.emit({ kind: 'quest', fromId: 'system', text: 'The keeper falls. The echo portal opens (synthetic).' });
    }
    const witness = this.enemies.find((o) => o.id !== e.id && o.state !== 'banished');
    if (witness) this.emit({ kind: 'whisper', fromId: witness.id, text: `${e.name} fell to ${CHANNELS[power].deity}'s ${CHANNELS[power].effect}. I will ${e.strategy.replace('_', ' ')} instead.` });
  }

  private adventure(): AdventureState {
    const adv = WORLD.adventure;
    const sigils = this.sealed.size;
    const next = adv.sigilEnemyIds.find((id) => !this.sealed.has(id));
    const objective = this.bossDefeated
      ? 'The echo portal is open. Press E at the portal to begin an echo.'
      : sigils < adv.sigilEnemyIds.length
        ? `Silence the bells: seal ${adv.sigilEnemyIds.length - sigils} more sigil${adv.sigilEnemyIds.length - sigils === 1 ? '' : 's'}.`
        : 'All sigils sealed. Face the keeper at the eastern altar.';
    return { stage: this.bossDefeated ? 3 : sigils < adv.sigilEnemyIds.length ? 1 : 2, sigils, objective, targetId: next ?? adv.bossId, portalReady: this.bossDefeated, bossDefeated: this.bossDefeated, echo: this.echo };
  }

  private step(dt: number): void {
    const now = Date.now();
    const me = this.h.getSelf();
    this.self.position = [me.pos.x, me.pos.y, me.pos.z];
    this.self.yaw = me.yaw;
    this.self.pitch = me.pitch;
    const warded = (this.self.wardUntil ?? 0) > now;

    for (const e of this.enemies) {
      if (e.state === 'banished') {
        if (now >= e.returnsAt) {
          e.state = 'hunting';
          e.hp = e.maxHp;
          const spawn = WORLD.enemySpawns.find((s) => s.id === e.id);
          if (spawn) e.position = [...spawn.position] as Vec3;
          this.emit({ kind: 'return', fromId: e.id, position: e.position, text: `${e.name} returns, remembering ${this.self.name}.` });
        }
        continue;
      }
      const pos = Vector3.FromArray(e.position);
      const to = me.pos.subtract(pos);
      to.y = 0;
      const dist = to.length();
      const spawn = WORLD.enemySpawns.find((s) => s.id === e.id);
      const home = spawn ? Vector3.FromArray(spawn.position) : pos.clone();
      const fromHome = Vector3.Distance(new Vector3(pos.x, 0, pos.z), new Vector3(home.x, 0, home.z));
      const safe = Vector3.Distance(new Vector3(me.pos.x, 0, me.pos.z), new Vector3(WORLD.spawn[0], 0, WORLD.spawn[2])) < WORLD.adventure.safeSpawnRadius;
      // Aggro inside the encounter radius, leash back beyond it; the safe gate is never attacked.
      if (!e.aggro && dist <= WORLD.adventure.aggroRadius && !safe && this.self.hp > 0) e.aggro = true;
      if (e.aggro && (fromHome > WORLD.adventure.leashRadius || safe || this.self.hp <= 0)) e.aggro = false;
      const dir = dist > 0.01 ? to.scale(1 / dist) : Vector3.Zero();
      const slowed = (this.slow.get(e.id) ?? 0) > now ? 0.4 : 1;
      let speed = (2.0 + e.level * 0.15) * slowed;
      let move = Vector3.Zero();
      if (e.aggro) {
        const approach = dist > MELEE_STOP ? dir : Vector3.Zero();
        move = approach;
        switch (e.strategy) {
          case 'keep_distance':
            move = dist < 9 ? dir.scale(-1) : dist > 12 ? dir : Vector3.Zero();
            break;
          case 'flank':
            move = dist > 3 ? dir.scale(0.6).add(new Vector3(-dir.z, 0, dir.x).scale(0.8)) : approach;
            break;
          case 'ambush':
            speed *= 1.4;
            break;
        }
      } else if (fromHome > 0.5) {
        const back = home.subtract(pos);
        back.y = 0;
        move = back.scale(1 / back.length());
        speed = 2.2;
      } else {
        // Idle patrol: a slow drift around the zone.
        move = new Vector3(Math.sin(now / 4000 + e.level), 0, Math.cos(now / 5000 + e.level)).scale(0.3);
        speed = 1;
      }
      pos.addInPlace(move.scale(Math.min(speed * dt, e.aggro ? Math.max(0, dist - MELEE_STOP) + 0.001 : speed * dt)));
      resolveCollisions(pos, ENEMY_RADIUS);
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
      if (e.aggro && g <= MELEE_REACH && this.self.hp > 0 && now - this.lastContact > 600) {
        this.lastContact = now;
        this.self.hp = Math.max(0, this.self.hp - (warded ? 2 : 6));
        this.emit({ kind: 'hit', fromId: e.id, toId: this.selfId, position: this.self.position });
        if (this.self.hp <= 0) this.emit({ kind: 'death', fromId: this.selfId, toId: e.id, text: `${e.name} remembers your last encounter.` });
      }
    }

    this.tick += 1;
    this.h.onSnapshot({
      tick: this.tick,
      serverTime: now,
      players: [{ ...this.self, skillCooldowns: { ...this.self.skillCooldowns } }],
      enemies: this.enemies.map((e) => ({ ...e, position: [...e.position] as Vec3 })),
      adventure: this.adventure(),
    });
  }

  private emit(partial: Omit<GameEvent, 'type' | 'eventId' | 'tick'>): void {
    this.h.onEvent({ type: 'event', eventId: `preview-${++this.events}`, tick: this.tick, ...partial });
  }
}
