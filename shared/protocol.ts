export const PROTOCOL_VERSION = 1 as const;
export const POWER_IDS = ['ganesha', 'hanuman', 'shiva', 'vishnu'] as const;
export type PowerId = typeof POWER_IDS[number];
export const powerForEnemyLevel = (level: number): PowerId =>
  level <= 2 ? 'ganesha' : level <= 4 ? 'hanuman' : level <= 7 ? 'shiva' : 'vishnu';
export type Vec3 = [number, number, number];
export type Species = 'ghost' | 'ghoul' | 'goblin' | 'orc' | 'beast' | 'rakshasa';
export type GhostStrategy = 'chase' | 'flank' | 'keep_distance' | 'ambush';

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
}

export interface RoomSnapshot {
  tick: number;
  serverTime: number;
  players: PlayerState[];
  enemies: EnemyState[];
}

export type ClientMessage =
  | { type: 'join'; v: 1; roomId: string; name: string; playerKey: string }
  | { type: 'input'; v: 1; seq: number; moveX: number; moveZ: number; yaw: number; pitch: number; sprint: boolean }
  | { type: 'cast'; v: 1; seq: number; aim: Vec3 };

export interface GameEvent {
  type: 'event';
  eventId: string;
  tick: number;
  kind: 'cast' | 'hit' | 'banish' | 'return' | 'whisper' | 'death' | 'power';
  fromId: string;
  toId?: string;
  power?: PowerId;
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
