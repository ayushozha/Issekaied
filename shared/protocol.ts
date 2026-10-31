export const PROTOCOL_VERSION = 1 as const;
export const POWER_IDS = ['ganesha', 'hanuman', 'shiva', 'vishnu'] as const;
export type PowerId = typeof POWER_IDS[number];
export const powerForEnemyLevel = (level: number): PowerId =>
  level <= 2 ? 'ganesha' : level <= 4 ? 'hanuman' : level <= 7 ? 'shiva' : 'vishnu';
export type Vec3 = [number, number, number];
export type Species = 'ghost' | 'ghoul' | 'goblin' | 'orc' | 'beast' | 'rakshasa';
export type GhostStrategy = 'chase' | 'flank' | 'keep_distance' | 'ambush';
export const COMBAT_ACTIONS = ['primary', 'secondary', 'incantation', 'heal'] as const;
export type CombatAction = typeof COMBAT_ACTIONS[number];

export interface PlayerState {
  id: string;
  name: string;
  position: Vec3;
  yaw: number;
  pitch: number;
  hp: number;
  power: PowerId;
  cooldowns: Record<PowerId, number>;
  ackSeq: number;
  skillCooldowns?: Partial<Record<CombatAction, number>>;
  wardUntil?: number;
  active?: boolean;
}

export interface EnemyState {
  id: string;
  name: string;
  species: Species;
  level: number;
  position: Vec3;
  yaw: number;
  hp: number;
  maxHp: number;
  state: 'hunting' | 'banished' | 'returning';
  strategy: GhostStrategy;
  memory: { banishments: number; lastPower?: PowerId; lastHunterName?: string; version: number };
  returnsAt: number;
  aggro?: boolean;
}

export interface AdventureState {
  stage: number;
  sigils: number;
  objective: string;
  targetId?: string;
  portalReady: boolean;
  bossDefeated: boolean;
  echo: number;
}

export interface RoomSnapshot {
  tick: number;
  serverTime: number;
  players: PlayerState[];
  enemies: EnemyState[];
  adventure?: AdventureState;
}

export type ClientMessage =
  | { type: 'join'; v: 1; roomId: string; name: string; playerKey: string }
  | { type: 'input'; v: 1; seq: number; moveX: number; moveZ: number; yaw: number; pitch: number; sprint: boolean; active?: boolean }
  | { type: 'cast'; v: 1; seq: number; aim: Vec3; action?: CombatAction }
  | { type: 'interact'; v: 1; seq: number; target: 'shrine' | 'portal' | 'respawn' };

export interface GameEvent {
  type: 'event';
  eventId: string;
  tick: number;
  kind: 'cast' | 'hit' | 'banish' | 'return' | 'whisper' | 'death' | 'power' | 'quest' | 'portal';
  fromId: string;
  toId?: string;
  power?: PowerId;
  action?: CombatAction;
  position?: Vec3;
  text?: string;
  /** Same-origin server-generated speech; never an arbitrary NPC-supplied external URL. */
  audioUrl?: string;
}

export type ServerMessage =
  | { type: 'welcome'; v: 1; selfId: string; roomId: string; tickRate: number; snapshotRate: number; snapshot: RoomSnapshot }
  | { type: 'snapshot'; v: 1; snapshot: RoomSnapshot }
  | GameEvent
  | { type: 'error'; code: string; message: string };
