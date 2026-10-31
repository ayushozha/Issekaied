import type { GameEvent } from '../../shared/protocol';

/**
 * Wire event. `audioUrl` is an additive, optional field (clients on PROTOCOL_VERSION 1 ignore it);
 * the coordinator has been asked to add it to shared/protocol.ts.
 */
export type ServerEvent = GameEvent & { audioUrl?: string };

/** Minimal per-room fan-out so rooms can be created before the network/director layers that consume them. */
export class Fanout<T> {
  private readonly subs = new Set<(roomId: string, item: T) => void>();
  subscribe(fn: (roomId: string, item: T) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  emit(roomId: string, item: T): void {
    for (const fn of this.subs) fn(roomId, item);
  }
}

/** Unique event ids: a per-boot random prefix plus a monotonic counter, so replays and restarts never collide. */
export class EventIds {
  private n = 0;
  constructor(readonly bootId: string = crypto.randomUUID().slice(0, 8)) {}
  next(): string {
    this.n += 1;
    return `${this.bootId}-${this.n.toString(36)}`;
  }
}
