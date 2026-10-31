import { createHash } from 'node:crypto';
import {
  powerForEnemyLevel,
  type AdventureState,
  type CombatAction,
  type EnemyState,
  type GhostStrategy,
  type PlayerState,
  type PowerId,
  type RoomSnapshot,
  type Species,
  type Vec3,
} from '../../shared/protocol';
import { STRATEGIES, counterStrategy } from '../../actor/src/memory.ts';
import {
  CAST_MIN_INTERVAL_MS,
  DEITY_NAME,
  ECHO_LIMITS,
  ENEMY_ATTACK_INTERVAL_MS,
  ENEMY_PATROL_RADIUS,
  ENEMY_RETURNING_MS,
  GANESHA_WARD_MS,
  HANUMAN_KNOCKBACK_M,
  HEAL,
  IDLE_INACTIVE_MS,
  PLAYER_MAX_HP,
  PORTAL_COOLDOWN_MS,
  POWERS,
  PRIMARY,
  SHIVA_SLOW_FACTOR,
  SHIVA_SLOW_MS,
  SHRINE_COOLDOWN_MS,
  STALE_INPUT_MS,
  WARD,
  contactDamage,
  defaultEchoScaling,
  enemyMaxHp,
  enemySpeed,
  pickTarget,
  returnDelayMs,
} from './combat.ts';
import type { ServerEvent } from './events.ts';
import type { EncounterPlan } from './tactics.ts';
import { clampMove, clampPitch, normalizeAim, normalizeYaw, type CastMessage, type InputMessage, type InteractMessage } from './validate.ts';
import {
  ADVENTURE,
  ENEMY_RADIUS,
  ENEMY_SPACING,
  ENEMY_Y,
  EYE_HEIGHT,
  MELEE_REACH,
  MELEE_STOP,
  PLAYER_RADIUS,
  WORLD,
  clampToCircle,
  dist2d,
  inSafeZone,
  nearLandmark,
  resolveCollisions,
  spawnSlot,
  xz,
  type XZ,
} from './world.ts';

const PARKED_TTL_MS = 120_000;
const ENCOUNTER_RANGE_M = 14;
const GATE_NOTICE_MS = 5000;
const ZERO: XZ = { x: 0, z: 0 };

export interface RoomPlayer {
  id: string;
  /** Guest key; never leaves the server. */
  key: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  hp: number;
  power: PowerId;
  cooldowns: Record<PowerId, number>;
  skillCooldowns: Partial<Record<CombatAction, number>>;
  wardUntil: number;
  /** False while paused (client said so) or idle long enough that no deliberate input is arriving. */
  active: boolean;
  ackSeq: number;
  lastSeq: number;
  lastInputAt: number;
  move: { x: number; z: number; sprint: boolean };
  speed: number;
  lastCastAt: number;
  shrineAt: number;
  lastNoticeAt: number;
  connected: boolean;
  lastSeen: number;
  slot: number;
}

export interface RoomEnemy {
  id: string;
  name: string;
  species: Species;
  level: number;
  x: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  state: EnemyState['state'];
  strategy: GhostStrategy;
  memory: EnemyState['memory'];
  returnsAt: number;
  huntsAt: number;
  /** Encounter home: patrol centre, aggro origin and leash anchor. */
  home: XZ;
  targetId: string | null;
  patrolPhase: number;
  /** Boss gate: a gated haunt neither hunts nor can be damaged. */
  gated: boolean;
  hpMul: number;
  speedMul: number;
  aggroBonus: number;
  slowUntil: number;
  nextAttackAt: number;
  /** Tactic adopted on the next return (rehearsal, hivemind or mind output, already validated). */
  pendingStrategy?: GhostStrategy;
  lastBanisher?: { hunterId: string; hunterName: string; power: PowerId };
  /** Hunters remembered from durable memory; meeting one again raises an `encounter` signal. */
  grudgeHunters: Set<string>;
  greeted: Set<string>;
}

interface Adventure {
  stage: number;
  sigils: Set<string>;
  bossDefeated: boolean;
  portalReady: boolean;
  echo: number;
  lastPortalAt: number;
}

export type RoomSignal =
  | { type: 'join'; player: RoomPlayer; reconnected: boolean }
  | { type: 'leave'; player: RoomPlayer }
  | { type: 'invocation'; eventId: string; player: RoomPlayer; power: PowerId; enemy: RoomEnemy | null; hit: boolean }
  | { type: 'banish'; eventId: string; enemy: RoomEnemy; player: RoomPlayer; power: PowerId; distance: number }
  | { type: 'return'; eventId: string; enemy: RoomEnemy; banisherPresent: boolean }
  | { type: 'hunter_death'; eventId: string; player: RoomPlayer; enemy: RoomEnemy }
  | { type: 'encounter'; enemy: RoomEnemy; player: RoomPlayer }
  | { type: 'quest'; eventId: string; stage: number; sigils: number; bossDefeated: boolean; echo: number; player: RoomPlayer; subject?: RoomEnemy }
  | { type: 'portal'; eventId: string; player: RoomPlayer; echo: number };

export interface RoomOptions {
  capacity: number;
  tickRate?: number;
  now?: () => number;
  nextEventId?: () => string;
  onEvent?: (event: ServerEvent) => void;
  onSignal?: (signal: RoomSignal) => void;
}

export type JoinResult = { ok: true; player: RoomPlayer; reconnected: boolean } | { ok: false; code: 'room_full' };

export interface MemoryHydration {
  banishments: number;
  lastPower?: PowerId;
  lastHunterName?: string;
  strategy?: GhostStrategy;
  grudgeHunterIds?: string[];
}

/** Stable, non-reversible public id for a guest key so other clients never see the key itself. */
export const playerIdFor = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 12);

const vec = (p: XZ, y: number): Vec3 => [round(p.x), y, round(p.z)];
const round = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
const zoneName = (id: string) => ADVENTURE.zones.find((z) => z.id === id)?.name ?? id;

/**
 * Authoritative Bellgrave adventure room. Owns positions, HP, hits, cooldowns, aggro, banishments,
 * returns and quest progression. Fixed-step `step()` at the tick rate; `snapshot()` at the snapshot rate.
 * Nothing in here waits on the network or a provider.
 */
export class Room {
  tick = 0;
  readonly players = new Map<string, RoomPlayer>();
  readonly enemies: RoomEnemy[];
  private readonly adv: Adventure = { stage: 1, sigils: new Set(), bossDefeated: false, portalReady: false, echo: 0, lastPortalAt: 0 };
  private readonly parked = new Map<string, RoomPlayer>();
  private readonly dt: number;
  private readonly now: () => number;
  private readonly nextEventId: () => string;
  private readonly onEvent: (event: ServerEvent) => void;
  private readonly onSignal: (signal: RoomSignal) => void;
  private nextSlot = 0;
  private counter = 0;

  constructor(readonly id: string, private readonly opts: RoomOptions) {
    this.dt = 1 / (opts.tickRate ?? 20);
    this.now = opts.now ?? Date.now;
    this.nextEventId = opts.nextEventId ?? (() => `${this.id}-${++this.counter}`);
    this.onEvent = opts.onEvent ?? (() => {});
    this.onSignal = opts.onSignal ?? (() => {});
    this.enemies = WORLD.enemySpawns.map((s, i) => ({
      id: s.id,
      name: s.name,
      species: s.species,
      level: s.level,
      x: s.position[0],
      z: s.position[2],
      yaw: 0,
      hp: enemyMaxHp(s.level),
      maxHp: enemyMaxHp(s.level),
      state: 'hunting',
      strategy: 'chase',
      memory: { banishments: 0, version: 1 },
      returnsAt: 0,
      huntsAt: 0,
      home: xz(s.position),
      targetId: null,
      patrolPhase: i * 1.7,
      gated: s.id === ADVENTURE.bossId,
      hpMul: 1,
      speedMul: 1,
      aggroBonus: 0,
      slowUntil: 0,
      nextAttackAt: 0,
      grudgeHunters: new Set(),
      greeted: new Set(),
    }));
  }

  get connectedCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n += 1;
    return n;
  }

  enemy(id: string): RoomEnemy | undefined {
    return this.enemies.find((e) => e.id === id);
  }

  // ---- membership -----------------------------------------------------------------------------

  join(key: string, name: string): JoinResult {
    const id = playerIdFor(key);
    const now = this.now();
    const live = this.players.get(id);
    if (live) {
      live.connected = true;
      live.lastSeen = now;
      live.lastInputAt = now;
      live.name = name;
      this.onSignal({ type: 'join', player: live, reconnected: true });
      return { ok: true, player: live, reconnected: true };
    }
    const parked = this.parked.get(id);
    if (parked) {
      if (this.connectedCount >= this.opts.capacity) return { ok: false, code: 'room_full' };
      this.parked.delete(id);
      parked.connected = true;
      parked.lastSeen = now;
      parked.lastInputAt = now;
      parked.name = name;
      parked.move = { x: 0, z: 0, sprint: false };
      this.players.set(id, parked);
      this.onSignal({ type: 'join', player: parked, reconnected: true });
      return { ok: true, player: parked, reconnected: true };
    }
    if (this.connectedCount >= this.opts.capacity) return { ok: false, code: 'room_full' };
    const slot = this.nextSlot++;
    const at = spawnSlot(slot);
    const player: RoomPlayer = {
      id,
      key,
      name,
      x: at.x,
      y: EYE_HEIGHT,
      z: at.z,
      yaw: 0,
      pitch: 0,
      hp: PLAYER_MAX_HP,
      power: 'ganesha',
      cooldowns: { ganesha: 0, hanuman: 0, shiva: 0, vishnu: 0 },
      skillCooldowns: {},
      wardUntil: 0,
      active: true,
      ackSeq: 0,
      lastSeq: 0,
      lastInputAt: now,
      move: { x: 0, z: 0, sprint: false },
      speed: 0,
      lastCastAt: 0,
      shrineAt: 0,
      lastNoticeAt: 0,
      connected: true,
      lastSeen: now,
      slot,
    };
    this.players.set(id, player);
    this.onSignal({ type: 'join', player, reconnected: false });
    return { ok: true, player, reconnected: false };
  }

  /** Disconnect: the hunter leaves the snapshot but can reattach with the same guest key for a while. */
  leave(playerId: string): void {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connected = false;
    p.lastSeen = this.now();
    p.move = { x: 0, z: 0, sprint: false };
    p.speed = 0;
    this.players.delete(playerId);
    this.parked.set(playerId, p);
    for (const e of this.enemies) if (e.targetId === playerId) e.targetId = null;
    this.onSignal({ type: 'leave', player: p });
  }

  // ---- client intents (already schema-validated) ------------------------------------------------

  applyInput(playerId: string, msg: InputMessage): void {
    const p = this.players.get(playerId);
    if (!p || !p.connected) return;
    if (msg.seq <= p.lastSeq) return; // stale or replayed
    const now = this.now();
    p.lastSeq = msg.seq;
    p.ackSeq = msg.seq;
    p.lastInputAt = now;
    p.yaw = normalizeYaw(msg.yaw);
    p.pitch = clampPitch(msg.pitch);
    p.active = msg.active ?? true; // resume is explicit: the next deliberate input with active !== false
    const m = p.active && p.hp > 0 ? clampMove(msg.moveX, msg.moveZ) : ZERO;
    p.move = { x: m.x, z: m.z, sprint: msg.sprint };
  }

  /** Can this hunter act right now? Dead, paused/idle or disconnected hunters cannot. */
  private canAct(p: RoomPlayer | undefined): p is RoomPlayer {
    return !!p && p.connected && p.active && p.hp > 0;
  }

  private acceptSeq(p: RoomPlayer, seq: number): boolean {
    if (seq <= p.lastSeq) return false; // duplicate or replayed action
    p.lastSeq = seq;
    return true;
  }

  private aimedTarget(p: RoomPlayer, aim: Vec3): RoomEnemy | null {
    return (
      pickTarget([p.x, p.y, p.z], aim, this.enemies.map((e) => ({ e, position: [e.x, ENEMY_Y, e.z] as Vec3, state: e.state, level: e.level })))?.e ?? null
    );
  }

  /** Explicit hunter actions. The server picks the deity channel from the targeted haunt's level. */
  cast(playerId: string, msg: CastMessage): void {
    const p = this.players.get(playerId);
    if (!this.canAct(p) || !this.acceptSeq(p, msg.seq)) return;
    const aim = normalizeAim(msg.aim);
    if (!aim) return;
    const now = this.now();
    if (now - p.lastCastAt < CAST_MIN_INTERVAL_MS) return;
    const action: CombatAction = msg.action ?? 'primary';
    if ((p.skillCooldowns[action] ?? 0) > now) return; // cooldown spam is rejected silently
    switch (action) {
      case 'primary':
        return this.primary(p, aim, now);
      case 'secondary':
        return this.ward(p, now);
      case 'incantation':
        return this.incantation(p, aim, now);
      case 'heal':
        return this.heal(p, now);
    }
  }

  private primary(p: RoomPlayer, aim: Vec3, now: number): void {
    const target = this.aimedTarget(p, aim);
    const power = powerForEnemyLevel(target?.level ?? 1);
    p.lastCastAt = now;
    p.skillCooldowns = { ...p.skillCooldowns, primary: now + PRIMARY.cooldownMs };
    this.emit({ kind: 'cast', action: 'primary', fromId: p.id, power, position: vec(p, EYE_HEIGHT) });
    if (!target) return;
    const d = Math.hypot(target.x - p.x, ENEMY_Y - p.y, target.z - p.z);
    if (d > PRIMARY.range) return;
    this.damage(target, p, PRIMARY.damage, power, 'primary', d, now);
  }

  private ward(p: RoomPlayer, now: number): void {
    p.lastCastAt = now;
    p.skillCooldowns = { ...p.skillCooldowns, secondary: now + WARD.cooldownMs };
    p.wardUntil = now + WARD.durationMs;
    this.emit({ kind: 'cast', action: 'secondary', fromId: p.id, power: p.power, position: vec(p, EYE_HEIGHT) });
    for (const e of this.enemies) {
      if (e.state === 'banished' || e.gated) continue;
      const g = dist2d(e, p);
      if (g > WARD.repelRadius) continue;
      const n = g > 0.01 ? { x: (e.x - p.x) / g, z: (e.z - p.z) / g } : { x: -Math.sin(p.yaw), z: -Math.cos(p.yaw) };
      e.x += n.x * WARD.repelM;
      e.z += n.z * WARD.repelM;
      this.settleEnemy(e);
    }
  }

  private incantation(p: RoomPlayer, aim: Vec3, now: number): void {
    const target = this.aimedTarget(p, aim);
    const power = powerForEnemyLevel(target?.level ?? 1);
    if (p.cooldowns[power] > now) return; // the deity's own cooldown, not the client's clock
    p.lastCastAt = now;
    p.cooldowns = { ...p.cooldowns, [power]: now + POWERS[power].cooldownMs };
    p.skillCooldowns = { ...p.skillCooldowns, incantation: now + CAST_MIN_INTERVAL_MS };
    p.power = power;
    if (power === 'ganesha') p.wardUntil = Math.max(p.wardUntil, now + GANESHA_WARD_MS);
    const castId = this.emit({ kind: 'cast', action: 'incantation', fromId: p.id, power, position: vec(p, EYE_HEIGHT) });
    let hit = false;
    if (target) {
      const d = Math.hypot(target.x - p.x, ENEMY_Y - p.y, target.z - p.z);
      if (d <= POWERS[power].range) {
        hit = this.damage(target, p, POWERS[power].damage, power, 'incantation', d, now);
        if (hit && target.state !== 'banished') {
          if (power === 'shiva') target.slowUntil = now + SHIVA_SLOW_MS;
          if (power === 'hanuman') {
            const g = dist2d(target, p) || 1;
            target.x += ((target.x - p.x) / g) * HANUMAN_KNOCKBACK_M;
            target.z += ((target.z - p.z) / g) * HANUMAN_KNOCKBACK_M;
            this.settleEnemy(target);
          }
        }
      }
    }
    this.onSignal({ type: 'invocation', eventId: castId, player: p, power, enemy: target, hit });
  }

  private heal(p: RoomPlayer, now: number): void {
    p.lastCastAt = now;
    p.skillCooldowns = { ...p.skillCooldowns, heal: now + HEAL.cooldownMs };
    p.hp = Math.min(PLAYER_MAX_HP, p.hp + HEAL.amount);
    this.emit({ kind: 'cast', action: 'heal', fromId: p.id, position: vec(p, EYE_HEIGHT), text: `${p.name} recites the recovery mantra.` });
  }

  /** Applies validated damage; a gated boss takes none and the hunter is told why (rate-limited). */
  private damage(e: RoomEnemy, p: RoomPlayer, amount: number, power: PowerId, action: CombatAction, distance: number, now: number): boolean {
    if (e.state === 'banished') return false;
    if (e.gated) {
      if (now - p.lastNoticeAt > GATE_NOTICE_MS) {
        p.lastNoticeAt = now;
        this.emit({ kind: 'power', fromId: e.id, toId: p.id, text: `${e.name} is warded by the altar. Three sigils must burn first (${this.adv.sigils.size}/3).` });
      }
      return false;
    }
    e.hp = Math.max(0, e.hp - amount);
    if (!e.targetId && this.targetable(p, e, 'acquire')) e.targetId = p.id; // being struck wakes a patrolling haunt
    this.emit({ kind: 'hit', action, fromId: p.id, toId: e.id, power, position: vec(e, ENEMY_Y) });
    if (e.hp <= 0) this.banish(e, p, power, distance, now);
    return true;
  }

  /** E key: shrine blessing, echo portal, or an explicit respawn after defeat. Proximity is server-checked. */
  interact(playerId: string, msg: InteractMessage): void {
    const p = this.players.get(playerId);
    if (!p || !p.connected || !this.acceptSeq(p, msg.seq)) return;
    const now = this.now();
    switch (msg.target) {
      case 'respawn':
        if (p.hp > 0) return;
        this.respawn(p, now);
        return;
      case 'shrine':
        if (!this.canAct(p) || !nearLandmark(p, ADVENTURE.shrine) || now - p.shrineAt < SHRINE_COOLDOWN_MS) return;
        p.shrineAt = now;
        p.hp = PLAYER_MAX_HP;
        p.wardUntil = Math.max(p.wardUntil, now + WARD.durationMs);
        this.emit({ kind: 'power', fromId: ADVENTURE.shrine.id, toId: p.id, position: ADVENTURE.shrine.position, text: `${p.name} prays at the gate shrine and is restored.` });
        return;
      case 'portal':
        if (!this.canAct(p) || !nearLandmark(p, ADVENTURE.portal)) return;
        if (!this.adv.portalReady) {
          if (now - p.lastNoticeAt > GATE_NOTICE_MS) {
            p.lastNoticeAt = now;
            this.emit({ kind: 'power', fromId: ADVENTURE.portal.id, toId: p.id, text: `The echo portal is sealed until ${this.enemy(ADVENTURE.bossId)?.name ?? 'the boss'} falls.` });
          }
          return;
        }
        if (now - this.adv.lastPortalAt < PORTAL_COOLDOWN_MS) return;
        this.startEcho(p, now);
        return;
    }
  }

  private respawn(p: RoomPlayer, now: number): void {
    const at = spawnSlot(p.slot);
    p.hp = PLAYER_MAX_HP;
    p.x = at.x;
    p.z = at.z;
    p.speed = 0;
    p.move = { x: 0, z: 0, sprint: false };
    p.wardUntil = 0;
    p.active = true;
    p.lastInputAt = now;
    this.emit({ kind: 'return', fromId: p.id, position: vec(p, EYE_HEIGHT), text: `${p.name} returns to the gate.` });
  }

  // ---- adventure progression ------------------------------------------------------------------

  private objective(): Pick<AdventureState, 'objective' | 'targetId'> {
    const boss = this.enemy(ADVENTURE.bossId);
    if (this.adv.stage >= 3) return { objective: `${boss?.name ?? 'The boss'} is banished. Step through the echo portal at the courtyard's edge.`, targetId: ADVENTURE.portal.id };
    if (this.adv.stage === 2) return { objective: `Three sigils burn. Banish ${boss?.name ?? 'the boss'} at the ${zoneName(ADVENTURE.bossId)}.`, targetId: ADVENTURE.bossId };
    const remaining = ADVENTURE.sigilEnemyIds.filter((id) => !this.adv.sigils.has(id));
    const names = remaining.map((id) => this.enemy(id)?.name ?? id).join(', ');
    return { objective: `Earn the sigils: banish ${names} (${this.adv.sigils.size}/3). The gate is safe ground.`, targetId: remaining[0] };
  }

  adventureState(): AdventureState {
    return { stage: this.adv.stage, sigils: this.adv.sigils.size, ...this.objective(), portalReady: this.adv.portalReady, bossDefeated: this.adv.bossDefeated, echo: this.adv.echo };
  }

  private refreshGate(): void {
    const boss = this.enemy(ADVENTURE.bossId);
    if (boss) boss.gated = this.adv.stage < 2;
  }

  /** Quest milestone. `player` is the hunter whose authoritative action caused it (banisher or portal user). */
  private quest(text: string, player: RoomPlayer, subject?: RoomEnemy): void {
    const eventId = this.emit({ kind: 'quest', fromId: 'adventure', toId: subject?.id, text });
    this.onSignal({ type: 'quest', eventId, stage: this.adv.stage, sigils: this.adv.sigils.size, bossDefeated: this.adv.bossDefeated, echo: this.adv.echo, player, subject });
  }

  /** Idempotent progression from an actual banishment: each haunt yields its sigil once per echo. */
  private progress(e: RoomEnemy, p: RoomPlayer): void {
    if (ADVENTURE.sigilEnemyIds.includes(e.id) && !this.adv.sigils.has(e.id)) {
      this.adv.sigils.add(e.id);
      if (this.adv.sigils.size >= ADVENTURE.sigilEnemyIds.length && this.adv.stage < 2) {
        this.adv.stage = 2;
        this.refreshGate();
        this.quest(`The sigil of ${zoneName(e.id)} is earned (3/3). Three sigils burn: ${this.enemy(ADVENTURE.bossId)?.name ?? 'the boss'} stirs at the ${zoneName(ADVENTURE.bossId)}.`, p, e);
      } else {
        this.quest(`The sigil of ${zoneName(e.id)} is earned (${this.adv.sigils.size}/3).`, p, e);
      }
      return;
    }
    if (e.id === ADVENTURE.bossId && this.adv.stage === 2 && !this.adv.bossDefeated) {
      this.adv.bossDefeated = true;
      this.adv.portalReady = true;
      this.adv.stage = 3;
      this.quest(`${e.name} is banished. The echo portal opens at the courtyard's edge.`, p, e);
    }
  }

  /** Same courtyard, altered trial: haunts re-home with bounded scaling and the boss gate closes again. */
  private startEcho(p: RoomPlayer, now: number): void {
    this.adv.echo += 1;
    this.adv.sigils.clear();
    this.adv.bossDefeated = false;
    this.adv.portalReady = false;
    this.adv.stage = 1;
    this.adv.lastPortalAt = now;
    const scaling = defaultEchoScaling(this.adv.echo);
    for (const e of this.enemies) {
      e.hpMul = scaling.hpMul;
      e.speedMul = scaling.speedMul;
      e.aggroBonus = scaling.aggroBonus;
      e.maxHp = Math.round(enemyMaxHp(e.level) * e.hpMul);
      e.hp = e.maxHp;
      e.state = 'hunting';
      e.x = e.home.x;
      e.z = e.home.z;
      e.targetId = null;
      e.returnsAt = 0;
      e.slowUntil = 0;
      e.nextAttackAt = now + ENEMY_RETURNING_MS;
      e.strategy = e.pendingStrategy ?? (e.lastBanisher ? counterStrategy(e.lastBanisher.power) : e.strategy);
      e.pendingStrategy = undefined;
      e.greeted.clear();
    }
    this.refreshGate();
    const eventId = this.emit({ kind: 'portal', fromId: p.id, position: ADVENTURE.portal.position, text: `${p.name} steps through the echo portal. Echo ${this.adv.echo} begins in the same courtyard.` });
    this.quest(`Echo ${this.adv.echo}: the haunts return changed. ${this.objective().objective}`, p);
    this.onSignal({ type: 'portal', eventId, player: p, echo: this.adv.echo });
  }

  /** Apply a rehearsed echo plan (from Superserve or the local scorer). Clamped; ignored if the echo moved on. */
  applyEchoPlan(plan: EncounterPlan): boolean {
    if (plan.echo !== this.adv.echo || this.adv.echo === 0) return false;
    let changed = 0;
    for (const entry of plan.enemies) {
      const e = this.enemy(entry.id);
      if (!e || !STRATEGIES.includes(entry.strategy)) continue;
      const hpMul = clamp(entry.hpMul, 1, ECHO_LIMITS.hpMul);
      const maxHp = Math.round(enemyMaxHp(e.level) * hpMul);
      e.hp = e.state === 'banished' ? 0 : Math.max(1, Math.round((e.hp / e.maxHp) * maxHp));
      e.maxHp = maxHp;
      e.hpMul = hpMul;
      e.speedMul = clamp(entry.speedMul, 1, ECHO_LIMITS.speedMul);
      e.aggroBonus = clamp(entry.aggroBonus, 0, ECHO_LIMITS.aggroBonus);
      if (e.state === 'banished') e.pendingStrategy = entry.strategy;
      else e.strategy = entry.strategy;
      changed += 1;
    }
    if (changed) this.emit({ kind: 'power', fromId: 'adventure', text: `The echo settles: ${plan.rationale.slice(0, 160)}` });
    return changed > 0;
  }

  // ---- director hooks (validated, deterministic) -----------------------------------------------

  /** Change a haunt's tactic now. Returns false for unknown ids or strategies. */
  setStrategy(enemyId: string, strategy: GhostStrategy, reason: string, announce = true): boolean {
    const e = this.enemy(enemyId);
    if (!e || !STRATEGIES.includes(strategy)) return false;
    if (e.strategy === strategy) return true;
    e.strategy = strategy;
    if (announce) this.emit({ kind: 'power', fromId: e.id, text: `${e.name} changes tactics: ${strategy.replace('_', ' ')} (${reason}).` });
    return true;
  }

  /** Tactic a banished haunt adopts when it returns. */
  setPendingStrategy(enemyId: string, strategy: GhostStrategy): boolean {
    const e = this.enemy(enemyId);
    if (!e || !STRATEGIES.includes(strategy)) return false;
    e.pendingStrategy = strategy;
    return true;
  }

  /** Apply durable memory (from Terse or the explicit local fallback) at boot or after a write. */
  hydrateMemory(enemyId: string, mem: MemoryHydration): void {
    const e = this.enemy(enemyId);
    if (!e) return;
    if (mem.banishments >= e.memory.banishments) {
      e.memory = { banishments: mem.banishments, lastPower: mem.lastPower ?? e.memory.lastPower, lastHunterName: mem.lastHunterName ?? e.memory.lastHunterName, version: e.memory.version + 1 };
    }
    if (mem.strategy && STRATEGIES.includes(mem.strategy) && e.state !== 'banished') e.strategy = mem.strategy;
    for (const h of mem.grudgeHunterIds ?? []) e.grudgeHunters.add(h);
  }

  /** NPC dialogue. With `withAudio`, the event carries the URL where the server will serve its speech. */
  whisper(fromId: string, text: string, extra: { toId?: string; withAudio?: boolean } = {}): ServerEvent {
    const eventId = this.nextEventId();
    const event: ServerEvent = { type: 'event', eventId, tick: this.tick, kind: 'whisper', fromId, text: text.slice(0, 240) };
    if (extra.toId) event.toId = extra.toId;
    if (extra.withAudio) event.audioUrl = `/api/audio/${eventId}`;
    this.onEvent(event);
    return event;
  }

  /** System-styled line (rendered like a tactic change), used for deity context and warnings. */
  notice(fromId: string, text: string): ServerEvent {
    const event: ServerEvent = { type: 'event', eventId: this.nextEventId(), tick: this.tick, kind: 'power', fromId, text: text.slice(0, 240) };
    this.onEvent(event);
    return event;
  }

  // ---- simulation -------------------------------------------------------------------------------

  /** One fixed simulation step. */
  step(): void {
    const now = this.now();
    this.tick += 1;
    for (const p of this.players.values()) this.stepPlayer(p, now);
    for (const e of this.enemies) this.stepEnemy(e, now);
    this.separateEnemies();
    // Final pass: no haunt may end a tick inside any hunter's near-camera volume, dead or alive, targeted or not.
    for (const e of this.enemies) if (e.state !== 'banished') this.keepOutOfHunters(e);
    for (const e of this.enemies) if (e.state !== 'banished') this.contact(e, now);
    if (this.tick % 40 === 0) this.expireParked(now);
  }

  private stepPlayer(p: RoomPlayer, now: number): void {
    if (p.hp <= 0) return; // defeated hunters wait for an explicit respawn interaction
    const sinceInput = now - p.lastInputAt;
    if (sinceInput > IDLE_INACTIVE_MS) p.active = false; // no deliberate input for a while: treated as paused
    if (!p.active || sinceInput > STALE_INPUT_MS) {
      p.move = { x: 0, z: 0, sprint: false };
      p.speed = 0;
      return;
    }
    const moving = p.move.x !== 0 || p.move.z !== 0;
    const target = moving ? (p.move.sprint ? WORLD.sprintSpeed : WORLD.walkSpeed) : 0;
    p.speed += (target - p.speed) * Math.min(1, this.dt * 12);
    p.x += p.move.x * p.speed * this.dt;
    p.z += p.move.z * p.speed * this.dt;
    resolveCollisions(p, PLAYER_RADIUS);
  }

  /** Local aggro: alive, active hunters outside the safe gate, within the haunt's aggro radius (acquire) or its leash (keep). */
  private targetable(p: RoomPlayer | undefined, e: RoomEnemy, mode: 'acquire' | 'keep'): p is RoomPlayer {
    if (!p || !p.connected || !p.active || p.hp <= 0 || inSafeZone(p)) return false;
    if (dist2d(p, e.home) > ADVENTURE.leashRadius) return false;
    return mode === 'keep' || dist2d(p, e) <= ADVENTURE.aggroRadius + e.aggroBonus;
  }

  private acquire(e: RoomEnemy): RoomPlayer | null {
    let best: RoomPlayer | null = null;
    let bestD = Infinity;
    for (const p of this.players.values()) {
      if (!this.targetable(p, e, 'acquire')) continue;
      const d = dist2d(e, p);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  private stepEnemy(e: RoomEnemy, now: number): void {
    if (e.state === 'banished') {
      if (now >= e.returnsAt) this.returnEnemy(e, now);
      return;
    }
    if (e.state === 'returning' && now >= e.huntsAt) e.state = 'hunting';
    if (e.gated) {
      e.targetId = null;
      this.patrol(e);
      return;
    }
    let hunter = e.targetId ? this.players.get(e.targetId) : undefined;
    if (!this.targetable(hunter, e, 'keep')) {
      hunter = this.acquire(e) ?? undefined;
      e.targetId = hunter?.id ?? null;
    }
    if (!hunter) {
      this.patrol(e);
    } else {
      this.pursue(e, hunter, now);
    }
    for (const p of this.players.values()) {
      if (!p.connected || !p.active || p.hp <= 0 || !e.grudgeHunters.has(p.id) || e.greeted.has(p.id) || dist2d(e, p) > ENCOUNTER_RANGE_M) continue;
      e.greeted.add(p.id);
      this.onSignal({ type: 'encounter', enemy: e, player: p });
    }
  }

  private pursue(e: RoomEnemy, hunter: RoomPlayer, now: number): void {
    const dist = dist2d(hunter, e);
    const dir: XZ = dist > 0.01 ? { x: (hunter.x - e.x) / dist, z: (hunter.z - e.z) / dist } : ZERO;
    let speed = enemySpeed(e.level) * e.speedMul * (e.slowUntil > now ? SHIVA_SLOW_FACTOR : 1) * (e.state === 'returning' ? 0.5 : 1);
    const approach: XZ = dist > MELEE_STOP ? dir : ZERO;
    let move = approach;
    switch (e.strategy) {
      case 'keep_distance':
        move = dist < 9 ? { x: -dir.x, z: -dir.z } : dist > 12 ? dir : ZERO;
        break;
      case 'flank':
        move = dist > 3 ? { x: dir.x * 0.6 - dir.z * 0.8, z: dir.z * 0.6 + dir.x * 0.8 } : approach;
        break;
      case 'ambush':
        if (dist > 9) speed = 0;
        else speed *= 1.6;
        break;
    }
    // Never cross the melee line in one step, whatever the speed.
    const towards = move.x * dir.x + move.z * dir.z > 0;
    const stepLen = towards ? Math.min(speed * this.dt, Math.max(0, dist - MELEE_STOP)) : speed * this.dt;
    e.x += move.x * stepLen;
    e.z += move.z * stepLen;
    this.settleEnemy(e);
    e.yaw = Math.atan2(dir.x, dir.z);
  }

  /** Idle haunts walk a slow loop around their encounter home; leashed haunts head back there first. */
  private patrol(e: RoomEnemy): void {
    e.patrolPhase += this.dt * 0.35;
    const waypoint: XZ = { x: e.home.x + Math.cos(e.patrolPhase) * ENEMY_PATROL_RADIUS, z: e.home.z + Math.sin(e.patrolPhase) * ENEMY_PATROL_RADIUS };
    const d = dist2d(e, waypoint);
    if (d < 0.05) return;
    const far = dist2d(e, e.home) > ENEMY_PATROL_RADIUS + 1;
    const step = Math.min(d, enemySpeed(e.level) * (far ? 0.9 : 0.35) * this.dt);
    e.x += ((waypoint.x - e.x) / d) * step;
    e.z += ((waypoint.z - e.z) / d) * step;
    e.yaw = Math.atan2(waypoint.x - e.x, waypoint.z - e.z);
    this.settleEnemy(e);
  }

  /** Collision plus the encounter boundary: tactics never carry a haunt beyond its leash. */
  private settleEnemy(e: RoomEnemy): void {
    clampToCircle(e, e.home, ADVENTURE.leashRadius);
    resolveCollisions(e, ENEMY_RADIUS);
  }

  /** Haunts never stand inside a hunter's near-camera volume, even if the hunter walks into them. */
  private keepOutOfHunters(e: RoomEnemy): void {
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      let g = dist2d(e, p);
      if (g >= MELEE_STOP) continue;
      const away: XZ = g > 0.01 ? { x: (e.x - p.x) / g, z: (e.z - p.z) / g } : { x: -Math.sin(p.yaw), z: -Math.cos(p.yaw) };
      e.x = p.x + away.x * MELEE_STOP;
      e.z = p.z + away.z * MELEE_STOP;
      resolveCollisions(e, ENEMY_RADIUS);
      g = dist2d(e, p);
      if (g < MELEE_STOP - 1e-9) {
        // The haunt is pinned against an obstacle or the world edge: step the hunter back instead.
        const back: XZ = g > 0.01 ? { x: (p.x - e.x) / g, z: (p.z - e.z) / g } : { x: -away.x, z: -away.z };
        p.x = e.x + back.x * MELEE_STOP;
        p.z = e.z + back.z * MELEE_STOP;
        resolveCollisions(p, PLAYER_RADIUS);
      }
    }
  }

  private separateEnemies(): void {
    const live = this.enemies.filter((e) => e.state !== 'banished');
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        const g = dist2d(a, b);
        if (g >= ENEMY_SPACING) continue;
        const push = (ENEMY_SPACING - g) / 2;
        const nx = g > 0.01 ? (b.x - a.x) / g : 1;
        const nz = g > 0.01 ? (b.z - a.z) / g : 0;
        a.x -= nx * push;
        a.z -= nz * push;
        b.x += nx * push;
        b.z += nz * push;
        resolveCollisions(a, ENEMY_RADIUS);
        resolveCollisions(b, ENEMY_RADIUS);
      }
    }
  }

  /** Only an aggroed, ungated, hunting haunt strikes, and only its current target within reach. */
  private contact(e: RoomEnemy, now: number): void {
    if (e.state !== 'hunting' || e.gated || !e.targetId || now < e.nextAttackAt) return;
    const hunter = this.players.get(e.targetId);
    if (!this.targetable(hunter, e, 'keep') || dist2d(e, hunter) > MELEE_REACH) return;
    e.nextAttackAt = now + ENEMY_ATTACK_INTERVAL_MS;
    let dmg = contactDamage(e.level);
    if (hunter.wardUntil > now) dmg = Math.ceil(dmg * WARD.damageFactor);
    hunter.hp = Math.max(0, hunter.hp - dmg);
    this.emit({ kind: 'hit', fromId: e.id, toId: hunter.id, position: vec(hunter, EYE_HEIGHT) });
    if (hunter.hp <= 0) {
      hunter.move = { x: 0, z: 0, sprint: false };
      hunter.speed = 0;
      for (const other of this.enemies) if (other.targetId === hunter.id) other.targetId = null;
      const eventId = this.emit({ kind: 'death', fromId: hunter.id, toId: e.id, position: vec(hunter, EYE_HEIGHT), text: `${hunter.name} fell to ${e.name}. Press E at the gate to return.` });
      this.onSignal({ type: 'hunter_death', eventId, player: hunter, enemy: e });
    }
  }

  private banish(e: RoomEnemy, p: RoomPlayer, power: PowerId, distance: number, now: number): void {
    e.state = 'banished';
    e.hp = 0;
    e.slowUntil = 0;
    e.targetId = null;
    e.returnsAt = now + returnDelayMs(e.level);
    e.memory = { banishments: e.memory.banishments + 1, lastPower: power, lastHunterName: p.name, version: e.memory.version + 1 };
    e.lastBanisher = { hunterId: p.id, hunterName: p.name, power };
    e.pendingStrategy ??= counterStrategy(power);
    e.grudgeHunters.add(p.id);
    e.greeted.clear();
    const eventId = this.emit({
      kind: 'banish',
      fromId: p.id,
      toId: e.id,
      power,
      position: vec(e, ENEMY_Y),
      text: `${e.name} is banished by ${p.name} through ${DEITY_NAME[power]}.`,
    });
    this.onSignal({ type: 'banish', eventId, enemy: e, player: p, power, distance: round(distance) });
    this.progress(e, p);
  }

  private returnEnemy(e: RoomEnemy, now: number): void {
    e.state = 'returning';
    e.huntsAt = now + ENEMY_RETURNING_MS;
    e.hp = e.maxHp;
    e.x = e.home.x;
    e.z = e.home.z;
    e.targetId = null;
    e.nextAttackAt = now + ENEMY_RETURNING_MS;
    if (e.pendingStrategy) {
      e.strategy = e.pendingStrategy;
      e.pendingStrategy = undefined;
    }
    const banisher = e.lastBanisher ? this.players.get(e.lastBanisher.hunterId) : undefined;
    const banisherPresent = !!banisher?.connected;
    if (banisherPresent && banisher) e.greeted.add(banisher.id); // the return line already addresses them; no second "encounter"
    const text = banisherPresent && e.lastBanisher ? `${e.name} returns, remembering ${e.lastBanisher.hunterName}.` : `${e.name} returns.`;
    const eventId = this.emit({ kind: 'return', fromId: e.id, position: vec(e, ENEMY_Y), text });
    this.onSignal({ type: 'return', eventId, enemy: e, banisherPresent });
  }

  private expireParked(now: number): void {
    for (const [id, p] of this.parked) if (now - p.lastSeen > PARKED_TTL_MS) this.parked.delete(id);
  }

  private emit(partial: Omit<ServerEvent, 'type' | 'eventId' | 'tick'>): string {
    const event: ServerEvent = { type: 'event', eventId: this.nextEventId(), tick: this.tick, ...partial };
    this.onEvent(event);
    return event.eventId;
  }

  // ---- output -----------------------------------------------------------------------------------

  snapshot(): RoomSnapshot {
    const players: PlayerState[] = [];
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      players.push({
        id: p.id,
        name: p.name,
        position: vec(p, EYE_HEIGHT),
        yaw: p.yaw,
        pitch: p.pitch,
        hp: p.hp,
        power: p.power,
        cooldowns: p.cooldowns,
        ackSeq: p.ackSeq,
        skillCooldowns: p.skillCooldowns,
        wardUntil: p.wardUntil,
        active: p.active,
      });
    }
    const enemies: EnemyState[] = this.enemies.map((e) => ({
      id: e.id,
      name: e.name,
      species: e.species,
      level: e.level,
      position: vec(e, ENEMY_Y),
      yaw: e.yaw,
      hp: e.hp,
      maxHp: e.maxHp,
      state: e.state,
      strategy: e.strategy,
      memory: e.memory,
      returnsAt: e.returnsAt,
      aggro: e.targetId !== null,
    }));
    return { tick: this.tick, serverTime: this.now(), players, enemies, adventure: this.adventureState() };
  }
}
