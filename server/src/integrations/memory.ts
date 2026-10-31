import { mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createActorStub } from 'terse-sdk/actors';
import type { PowerId } from '../../../shared/protocol';
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
} from '../../../actor/src/memory.ts';
import type { Config } from '../config.ts';

/**
 * Durable minds. `terse` talks to the Terse Durable Actors in ../../actor through `terse-sdk/actors`
 * stubs (TERSE_ACTOR_URL / TERSE_API_KEY). `local-file` is an explicit, clearly-labelled fallback
 * that runs the same reducers against server/.data/memory.json; it is never reported as Terse.
 * When Terse is configured but unreachable, calls fall through to the local file so gameplay memory
 * still works, and /health says `terse-unreachable` with the last error.
 */
export interface DeityContext { known: boolean; summary: string; citedEventIds: string[] }

export interface GhostHandle {
  recordBanishment(episode: Omit<Episode, 'kind'>): Promise<GhostMemory>;
  recordKill(episode: Omit<Episode, 'kind' | 'power'>): Promise<GhostMemory>;
  recordReturn(episode: Omit<Episode, 'kind'>): Promise<GhostMemory>;
  setStrategy(strategy: GhostStrategy, eventId: string): Promise<GhostMemory>;
  addLore(text: string, eventIds: string[], at: number): Promise<GhostMemory>;
  recall(hunterId: string): Promise<Recall>;
  snapshot(): Promise<GhostMemory>;
}

export interface DeityHandle {
  recordInvocations(batch: Invocation[]): Promise<DeityMemory>;
  context(hunterId?: string): Promise<DeityContext>;
  snapshot(): Promise<DeityMemory>;
}

export type MemoryMode = 'terse' | 'terse-unreachable' | 'local-file';

export interface MemoryStore {
  mode(): MemoryMode;
  ghost(id: string): GhostHandle;
  deity(id: string): DeityHandle;
  /** Checks the Terse runtime; resolves false when Terse is not configured or unreachable. */
  probe(): Promise<boolean>;
  status(): Record<string, unknown>;
  close(): Promise<void>;
}

/** Shiva and Vishnu are one actor each across every room and game; Ganesha and Hanuman are per room. */
export const deityActorId = (power: PowerId, roomId: string): string => (power === 'shiva' || power === 'vishnu' ? power : `${power}.${roomId}`);

// ---- local file --------------------------------------------------------------------------------

interface MemoryFile { ghosts: Record<string, GhostMemory>; deities: Record<string, DeityMemory> }

export class LocalFileMemory implements MemoryStore {
  private readonly file: string;
  private data: MemoryFile = { ghosts: {}, deities: {} };
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private writes = 0;
  private lastError = '';

  constructor(dir: string) {
    this.file = path.join(dir, 'memory.json');
    mkdirSync(dir, { recursive: true });
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<MemoryFile>;
      this.data = { ghosts: parsed.ghosts ?? {}, deities: parsed.deities ?? {} };
    } catch {
      /* fresh store */
    }
  }

  mode(): MemoryMode {
    return 'local-file';
  }

  private ghostMem(id: string): GhostMemory {
    return this.data.ghosts[id] ?? EMPTY_GHOST;
  }

  private setGhost(id: string, m: GhostMemory): GhostMemory {
    if (m !== this.data.ghosts[id]) {
      this.data = { ...this.data, ghosts: { ...this.data.ghosts, [id]: m } };
      this.scheduleSave();
    }
    return m;
  }

  ghost(id: string): GhostHandle {
    return {
      recordBanishment: async (ep) => this.setGhost(id, applyBanishment(this.ghostMem(id), ep)),
      recordKill: async (ep) => this.setGhost(id, applyKill(this.ghostMem(id), ep)),
      recordReturn: async (ep) => this.setGhost(id, applyReturn(this.ghostMem(id), ep)),
      setStrategy: async (s, eventId) => this.setGhost(id, withStrategy(this.ghostMem(id), s, eventId)),
      addLore: async (text, eventIds, at) => this.setGhost(id, withLore(this.ghostMem(id), text, eventIds, at)),
      recall: async (hunterId) => recall(this.ghostMem(id), hunterId),
      snapshot: async () => this.ghostMem(id),
    };
  }

  deity(id: string): DeityHandle {
    const mem = () => this.data.deities[id] ?? EMPTY_DEITY;
    return {
      recordInvocations: async (batch) => {
        const next = applyInvocations(mem(), batch);
        if (next !== this.data.deities[id]) {
          this.data = { ...this.data, deities: { ...this.data.deities, [id]: next } };
          this.scheduleSave();
        }
        return next;
      },
      context: async (hunterId) => deityContext(mem(), hunterId),
      snapshot: async () => mem(),
    };
  }

  async probe(): Promise<boolean> {
    return false;
  }

  status(): Record<string, unknown> {
    return { mode: this.mode(), file: this.file, ghosts: Object.keys(this.data.ghosts).length, deities: Object.keys(this.data.deities).length, writes: this.writes, lastError: this.lastError || undefined };
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saving = this.saving.then(() => this.save());
    }, 150);
  }

  private async save(): Promise<void> {
    try {
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data));
      await rename(tmp, this.file);
      this.writes += 1;
    } catch (err) {
      this.lastError = (err as Error).message;
    }
  }

  async close(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saving = this.saving.then(() => this.save());
    }
    await this.saving;
  }
}

// ---- Terse ---------------------------------------------------------------------------------------

const GHOST_METHODS = [
  { name: 'recordBanishment', result: 'value' },
  { name: 'recordKill', result: 'value' },
  { name: 'recordReturn', result: 'value' },
  { name: 'setStrategy', result: 'value' },
  { name: 'addLore', result: 'value' },
  { name: 'recall', result: 'value' },
  { name: 'snapshot', result: 'value' },
] as const;
const DEITY_METHODS = [
  { name: 'recordInvocations', result: 'value' },
  { name: 'context', result: 'value' },
  { name: 'snapshot', result: 'value' },
] as const;

const CALL_TIMEOUT_MS = 4000;

class TerseMemory implements MemoryStore {
  private reachable = false;
  private calls = 0;
  private failures = 0;
  private fallbackCalls = 0;
  private lastError = '';
  private lastProbeAt = 0;

  constructor(private readonly fallback: LocalFileMemory, private readonly actorUrl: string) {}

  mode(): MemoryMode {
    return this.reachable ? 'terse' : 'terse-unreachable';
  }

  private async call<T>(label: string, remote: () => Promise<T>, local: () => Promise<T>): Promise<T> {
    this.calls += 1;
    try {
      const result = await Promise.race([
        remote(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${CALL_TIMEOUT_MS}ms`)), CALL_TIMEOUT_MS)),
      ]);
      this.reachable = true;
      return result;
    } catch (err) {
      this.failures += 1;
      this.fallbackCalls += 1;
      this.reachable = false;
      this.lastError = `${label}: ${(err as Error).message}`;
      return local();
    }
  }

  ghost(id: string): GhostHandle {
    const stub = createActorStub<GhostHandle>('Ghost', id, GHOST_METHODS);
    const local = this.fallback.ghost(id);
    return {
      recordBanishment: (ep) => this.call('Ghost.recordBanishment', () => stub.recordBanishment(ep), () => local.recordBanishment(ep)),
      recordKill: (ep) => this.call('Ghost.recordKill', () => stub.recordKill(ep), () => local.recordKill(ep)),
      recordReturn: (ep) => this.call('Ghost.recordReturn', () => stub.recordReturn(ep), () => local.recordReturn(ep)),
      setStrategy: (s, e) => this.call('Ghost.setStrategy', () => stub.setStrategy(s, e), () => local.setStrategy(s, e)),
      addLore: (t, ids, at) => this.call('Ghost.addLore', () => stub.addLore(t, ids, at), () => local.addLore(t, ids, at)),
      recall: (h) => this.call('Ghost.recall', () => stub.recall(h), () => local.recall(h)),
      snapshot: () => this.call('Ghost.snapshot', () => stub.snapshot(), () => local.snapshot()),
    };
  }

  deity(id: string): DeityHandle {
    const stub = createActorStub<DeityHandle>('Deity', id, DEITY_METHODS);
    const local = this.fallback.deity(id);
    return {
      recordInvocations: (b) => this.call('Deity.recordInvocations', () => stub.recordInvocations(b), () => local.recordInvocations(b)),
      context: (h) => this.call('Deity.context', () => stub.context(h), () => local.context(h)),
      snapshot: () => this.call('Deity.snapshot', () => stub.snapshot(), () => local.snapshot()),
    };
  }

  async probe(): Promise<boolean> {
    this.lastProbeAt = Date.now();
    const before = this.failures;
    await this.deity('shiva').snapshot();
    return this.failures === before;
  }

  status(): Record<string, unknown> {
    return {
      mode: this.mode(),
      actorUrl: this.actorUrl,
      reachable: this.reachable,
      calls: this.calls,
      failures: this.failures,
      fallbackCalls: this.fallbackCalls,
      lastProbeAt: this.lastProbeAt || undefined,
      lastError: this.lastError || undefined,
      fallback: this.fallback.status(),
    };
  }

  async close(): Promise<void> {
    await this.fallback.close();
  }
}

export function createMemoryStore(cfg: Config): MemoryStore {
  const local = new LocalFileMemory(cfg.dataDir);
  if (!cfg.terse.actorUrl) return local;
  return new TerseMemory(local, cfg.terse.actorUrl.replace(/\/v1\/.*$/, '/v1/…'));
}
