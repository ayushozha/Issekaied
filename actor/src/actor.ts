import { Actor, Persisted } from 'terse-sdk/actor';
import {
  EMPTY_DEITY,
  EMPTY_GHOST,
  applyBanishment,
  applyInvocations,
  applyKill,
  applyReturn,
  deityContext,
  recall,
  withLore,
  withStrategy,
  type DeityMemory,
  type Episode,
  type GhostMemory,
  type GhostStrategy,
  type Invocation,
  type Recall,
} from './memory.ts';

/** The Source: global omniscient narrator ledger (canonical id "global-source"). See source.ts. */
export { Source } from './source.ts';

/**
 * One durable actor per named enemy (actor id = enemy id, e.g. "vesper"). The whole memory is one
 * `@Persisted` field that is reassigned, never mutated in place, so every method commits a complete
 * new value. Methods are pure reducers over JSON and never await network IO, so the actor's single
 * mailbox is never held open by an LLM or HTTP call (the game server does that work outside).
 */
export class Ghost extends Actor {
  @Persisted private memory: GhostMemory = EMPTY_GHOST;

  async recordBanishment(episode: Omit<Episode, 'kind'>): Promise<GhostMemory> {
    this.memory = applyBanishment(this.memory, episode);
    return this.memory;
  }

  async recordKill(episode: Omit<Episode, 'kind' | 'power'>): Promise<GhostMemory> {
    this.memory = applyKill(this.memory, episode);
    return this.memory;
  }

  async recordReturn(episode: Omit<Episode, 'kind'>): Promise<GhostMemory> {
    this.memory = applyReturn(this.memory, episode);
    return this.memory;
  }

  async setStrategy(strategy: GhostStrategy, eventId: string): Promise<GhostMemory> {
    this.memory = withStrategy(this.memory, strategy, eventId);
    return this.memory;
  }

  async addLore(text: string, eventIds: string[], at: number): Promise<GhostMemory> {
    this.memory = withLore(this.memory, text, eventIds, at);
    return this.memory;
  }

  async recall(hunterId: string): Promise<Recall> {
    return recall(this.memory, hunterId);
  }

  async snapshot(): Promise<GhostMemory> {
    return this.memory;
  }
}

/**
 * Deity context. Actor ids: "shiva" and "vishnu" are global (one actor across every room and game);
 * "ganesha:<roomId>" and "hanuman:<roomId>" are per room, and share wider context through Agent Relay.
 */
export class Deity extends Actor {
  @Persisted private memory: DeityMemory = EMPTY_DEITY;

  async recordInvocations(batch: Invocation[]): Promise<DeityMemory> {
    this.memory = applyInvocations(this.memory, batch);
    return this.memory;
  }

  async context(hunterId?: string): Promise<{ known: boolean; summary: string; citedEventIds: string[] }> {
    return deityContext(this.memory, hunterId);
  }

  async snapshot(): Promise<DeityMemory> {
    return this.memory;
  }
}
