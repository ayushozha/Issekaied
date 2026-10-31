import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentRelay } from '@agent-relay/sdk';
import { z } from 'zod';
import type { GhostStrategy, PowerId } from '../../../shared/protocol';
import type { Config } from '../config.ts';

/**
 * Two Agent Relay channels carry real context between minds:
 *   #hivemind  — enemy warnings ("Vesper fell to Shiva; ambush instead"). Recipients change tactics
 *                when the message is *delivered*, so a delivered message is what alters behaviour.
 *   #pantheon  — deity context shared across rooms (which hunter drew on which power, outcome).
 *
 * `relay` mode uses RELAY_WORKSPACE_KEY. Without it the explicit `local-bus` delivers the same
 * payloads in-process and is reported as such; nothing pretends to be Relay.
 */
const warningSchema = z.object({
  issekaied: z.literal('warning'),
  eventId: z.string(),
  roomId: z.string(),
  ghostId: z.string(),
  ghostName: z.string(),
  hunterId: z.string(),
  hunterName: z.string(),
  power: z.enum(['ganesha', 'hanuman', 'shiva', 'vishnu']),
  suggestedStrategy: z.enum(['chase', 'flank', 'keep_distance', 'ambush']),
  at: z.number(),
  /** Synthetic verification traffic; receivers must never apply it to game state or persist it as history. */
  testOnly: z.boolean().optional(),
});
const noteSchema = z.object({
  issekaied: z.literal('pantheon'),
  eventId: z.string(),
  roomId: z.string(),
  deity: z.enum(['ganesha', 'hanuman', 'shiva', 'vishnu']),
  hunterId: z.string(),
  hunterName: z.string(),
  enemyId: z.string(),
  enemyLevel: z.number(),
  banished: z.boolean(),
  at: z.number(),
  testOnly: z.boolean().optional(),
});

export type HivemindWarning = Omit<z.infer<typeof warningSchema>, 'issekaied'> & { power: PowerId; suggestedStrategy: GhostStrategy };
export type PantheonNote = Omit<z.infer<typeof noteSchema>, 'issekaied'> & { deity: PowerId };
export type Via = 'relay' | 'local';
export type ChannelsMode = 'relay' | 'relay-unavailable' | 'local-bus';

export interface Channels {
  mode(): ChannelsMode;
  start(): Promise<void>;
  warn(w: HivemindWarning): Promise<void>;
  share(n: PantheonNote): Promise<void>;
  onWarning(handler: (w: HivemindWarning, via: Via) => void): void;
  onPantheon(handler: (n: PantheonNote, via: Via) => void): void;
  status(): Record<string, unknown>;
  close(): Promise<void>;
}

const HIVEMIND = 'hivemind';
const PANTHEON = 'pantheon';

/** Channel and participant names. Probes must pass their own so verification traffic never enters the game channels. */
export interface ChannelNames {
  hivemind: string;
  pantheon: string;
  agentPrefix: string;
}
export const GAME_CHANNELS: ChannelNames = { hivemind: HIVEMIND, pantheon: PANTHEON, agentPrefix: 'issekaied' };
/** If Relay has not echoed our own message back within this window, deliver it locally so gameplay still reacts. */
const ECHO_GRACE_MS = 5000;
const START_RETRY_MS = 60_000;

class Bus {
  private readonly warnings: ((w: HivemindWarning, via: Via) => void)[] = [];
  private readonly notes: ((n: PantheonNote, via: Via) => void)[] = [];
  onWarning(h: (w: HivemindWarning, via: Via) => void): void {
    this.warnings.push(h);
  }
  onPantheon(h: (n: PantheonNote, via: Via) => void): void {
    this.notes.push(h);
  }
  deliverWarning(w: HivemindWarning, via: Via): void {
    for (const h of this.warnings) h(w, via);
  }
  deliverNote(n: PantheonNote, via: Via): void {
    for (const h of this.notes) h(n, via);
  }
}

class LocalBus implements Channels {
  readonly bus = new Bus();
  private delivered = 0;
  mode(): ChannelsMode {
    return 'local-bus';
  }
  async start(): Promise<void> {}
  async warn(w: HivemindWarning): Promise<void> {
    this.delivered += 1;
    queueMicrotask(() => this.bus.deliverWarning(w, 'local'));
  }
  async share(n: PantheonNote): Promise<void> {
    this.delivered += 1;
    queueMicrotask(() => this.bus.deliverNote(n, 'local'));
  }
  onWarning(h: (w: HivemindWarning, via: Via) => void): void {
    this.bus.onWarning(h);
  }
  onPantheon(h: (n: PantheonNote, via: Via) => void): void {
    this.bus.onPantheon(h);
  }
  status(): Record<string, unknown> {
    return { mode: this.mode(), delivered: this.delivered, channels: [HIVEMIND, PANTHEON] };
  }
  async close(): Promise<void> {}
}

type LiveAgent = Awaited<ReturnType<AgentRelay['workspace']['register']>> extends infer R ? (R extends unknown[] ? never : R) : never;
type Inbound = { metadata?: unknown; channel?: { name?: string }; target?: { kind: string; channelName?: string } };
/**
 * The installed SDK's `assembleAgentClient` gives every live agent its own scoped `addListener` and
 * `events.disconnect()`, but the declared `RelayAgentClient` type omits them. Narrow structurally here.
 */
type ScopedListener = { addListener(selector: 'message.created', handler: (e: { message: Inbound }) => void): () => void; events: { disconnect(): Promise<void> } };
/** Warning and pantheon notes for one gameplay event share an eventId; internal dedupe keys carry the kind. */
const dedupeKey = (kind: 'warning' | 'pantheon', eventId: string) => `${kind}:${eventId}`;

const describeWarning = (w: HivemindWarning) =>
  `${w.ghostName} fell to ${w.hunterName} through ${w.power} in ${w.roomId}. Suggest ${w.suggestedStrategy.replace('_', ' ')}. [${w.eventId}]`;
const describeNote = (n: PantheonNote) =>
  `${n.deity} aided ${n.hunterName} against ${n.enemyId} (level ${n.enemyLevel}) in ${n.roomId}${n.banished ? ': banished' : ''}. [${n.eventId}]`;

class RelayChannels implements Channels {
  private readonly bus = new Bus();
  private relay: AgentRelay | null = null;
  private hivemind: LiveAgent | null = null;
  private pantheon: LiveAgent | null = null;
  /** Fresh receiver registered per boot; its token is never persisted. Senders keep their stable identities. */
  private receiver: LiveAgent | null = null;
  private receiverName = '';
  private unlisten: (() => void) | null = null;
  private ready = false;
  private sent = 0;
  private received = 0;
  private echoMissing = 0;
  private failures = 0;
  private lastError = '';
  private readonly awaitingEcho = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly seen = new Set<string>();
  private starting: Promise<void> | null = null;
  private agentNames: string[] = [];
  private lastReceivedAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private closed = false;

  constructor(private readonly cfg: Config, private readonly names: ChannelNames = GAME_CHANNELS) {}

  mode(): ChannelsMode {
    return this.ready ? 'relay' : 'relay-unavailable';
  }

  onWarning(h: (w: HivemindWarning, via: Via) => void): void {
    this.bus.onWarning(h);
  }
  onPantheon(h: (n: PantheonNote, via: Via) => void): void {
    this.bus.onPantheon(h);
  }

  start(): Promise<void> {
    this.starting ??= this.connect().catch((err) => {
      this.failures += 1;
      this.lastError = `start: ${(err as Error).message}`.slice(0, 200);
      this.ready = false;
      this.scheduleRetry();
    });
    return this.starting;
  }

  /** A transient Relay outage at boot must not leave the game on the local bus for the whole session. */
  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.starting = null;
      this.retries += 1;
      void this.start();
    }, START_RETRY_MS);
  }

  private async connect(): Promise<void> {
    const relay = new AgentRelay({
      workspaceKey: this.cfg.relay.workspaceKey,
      ...(this.cfg.relay.baseUrl ? { baseUrl: this.cfg.relay.baseUrl } : {}),
      onError: (err) => {
        this.failures += 1;
        this.lastError = `listener: ${(err as Error)?.message ?? String(err)}`;
      },
    });
    this.relay = relay;
    const tokens = await this.loadTokens();
    const { hivemind, pantheon, agentPrefix } = this.names;
    this.hivemind = await this.agent(relay, tokens, `${agentPrefix}-hivemind`, 'Enemy hivemind of Issekaied: relays banishment warnings between haunts.');
    this.pantheon = await this.agent(relay, tokens, `${agentPrefix}-pantheon`, 'Pantheon herald of Issekaied: shares deity context across rooms.');
    await this.saveTokens(tokens);
    // Both participants join both channels so every message is received by a distinct registered agent,
    // not only echoed to its own sender. Deliveries are deduplicated by event id.
    await this.joinChannel(this.hivemind, hivemind, 'Enemy warnings; recipients change tactics on delivery.');
    await this.joinChannel(this.pantheon, pantheon, 'Deity context shared across every room and game.');
    await this.joinChannel(this.pantheon, hivemind, 'Enemy warnings; recipients change tactics on delivery.');
    await this.joinChannel(this.hivemind, pantheon, 'Deity context shared across every room and game.');
    // A fresh receiving stream avoids reusing persisted sender consumer positions; its scoped listener opens
    // only its own stream while stable senders remain REST producers.
    await this.listenFresh(relay, agentPrefix, hivemind, pantheon);
    if (this.closed) {
      await this.disposeReceiver();
      return;
    }
    this.ready = true;
    this.agentNames = [this.hivemind.name, this.pantheon.name];
  }

  private async listenFresh(relay: AgentRelay, agentPrefix: string, hivemind: string, pantheon: string): Promise<void> {
    const name = `${agentPrefix}-receiver-${crypto.randomUUID().slice(0, 8)}`;
    try {
      this.receiver = (await relay.workspace.register({ name, type: 'agent', persona: 'Issekaied receiver: consumes hivemind and pantheon traffic for this server boot.' })) as LiveAgent;
      this.receiverName = this.receiver.name;
      await this.receiver.channels.join(hivemind);
      await this.receiver.channels.join(pantheon);
      this.unlisten = (this.receiver as unknown as ScopedListener).addListener('message.created', ({ message }) => this.receive(message));
    } catch (err) {
      await this.disposeReceiver();
      throw new Error(`receiver ${name}: ${(err as Error).message}`);
    }
  }

  /** Detach the scoped listener and close the receiver's own event stream. The identity may stay registered for audit. */
  private async disposeReceiver(): Promise<void> {
    this.unlisten?.();
    this.unlisten = null;
    const receiver = this.receiver as unknown as ScopedListener | null;
    this.receiver = null;
    try {
      await receiver?.events.disconnect();
    } catch (err) {
      this.lastError = `disconnect receiver: ${(err as Error).message}`;
    }
  }

  private async agent(relay: AgentRelay, tokens: Record<string, string>, name: string, persona: string): Promise<LiveAgent> {
    if (tokens[name]) {
      try {
        return (await relay.workspace.reconnect({ apiToken: tokens[name] })) as LiveAgent;
      } catch (err) {
        this.lastError = `reconnect ${name}: ${(err as Error).message}`;
        delete tokens[name];
      }
    }
    for (const candidate of [name, `${name}-${crypto.randomUUID().slice(0, 6)}`]) {
      try {
        const live = (await relay.workspace.register({ name: candidate, type: 'agent', persona })) as LiveAgent;
        const token = (live as unknown as { token?: string; apiToken?: string }).token ?? (live as unknown as { apiToken?: string }).apiToken;
        if (token) tokens[name] = token;
        return live;
      } catch (err) {
        this.lastError = `register ${candidate}: ${(err as Error).message}`;
      }
    }
    throw new Error(this.lastError);
  }

  private async joinChannel(agent: LiveAgent, name: string, topic: string): Promise<void> {
    try {
      await agent.channels.create({ name, topic });
    } catch {
      /* already exists */
    }
    await agent.channels.join(name);
  }

  private tokensFile(): string {
    return path.join(this.cfg.dataDir, 'relay-agents.json');
  }

  private async loadTokens(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.tokensFile(), 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private async saveTokens(tokens: Record<string, string>): Promise<void> {
    try {
      await mkdir(this.cfg.dataDir, { recursive: true });
      await writeFile(this.tokensFile(), JSON.stringify(tokens), { mode: 0o600 });
    } catch (err) {
      this.lastError = `save tokens: ${(err as Error).message}`;
    }
  }

  private receive(message: Inbound): void {
    const channel = message.channel?.name ?? (message.target?.kind === 'channel' ? message.target.channelName : undefined);
    const meta = message.metadata;
    if (!meta || typeof meta !== 'object') return;
    const kind = (meta as { issekaied?: string }).issekaied;
    if (kind === 'warning' && channel !== this.names.pantheon) {
      const parsed = warningSchema.safeParse(meta);
      if (!parsed.success || !this.firstTime(dedupeKey('warning', parsed.data.eventId))) return;
      this.received += 1;
      this.lastReceivedAt = Date.now();
      const { issekaied: _tag, ...w } = parsed.data;
      this.bus.deliverWarning(w, 'relay');
    } else if (kind === 'pantheon' && channel !== this.names.hivemind) {
      const parsed = noteSchema.safeParse(meta);
      if (!parsed.success || !this.firstTime(dedupeKey('pantheon', parsed.data.eventId))) return;
      this.received += 1;
      this.lastReceivedAt = Date.now();
      const { issekaied: _tag, ...n } = parsed.data;
      this.bus.deliverNote(n, 'relay');
    }
  }

  /** Dedupe deliveries (by kind:eventId) and cancel the local echo fallback for a message we sent ourselves. */
  private firstTime(key: string): boolean {
    const timer = this.awaitingEcho.get(key);
    if (timer) {
      clearTimeout(timer);
      this.awaitingEcho.delete(key);
    }
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value as string);
    return true;
  }

  private async send(agent: LiveAgent | null, channel: string, text: string, metadata: Record<string, unknown>, key: string, local: () => void): Promise<void> {
    if (!this.ready || !agent) {
      local();
      return;
    }
    try {
      await agent.sendMessage({ to: `#${channel}`, text, metadata, idempotencyKey: key });
      this.sent += 1;
      // A fast callback may already have delivered this message before the send promise resolved.
      if (this.seen.has(key)) return;
      this.awaitingEcho.set(
        key,
        setTimeout(() => {
          this.awaitingEcho.delete(key);
          if (this.seen.has(key)) return;
          this.echoMissing += 1;
          this.seen.add(key);
          local();
        }, ECHO_GRACE_MS),
      );
    } catch (err) {
      this.failures += 1;
      this.lastError = `send #${channel}: ${(err as Error).message}`;
      this.ready = false;
      local();
    }
  }

  warn(w: HivemindWarning): Promise<void> {
    return this.send(this.hivemind, this.names.hivemind, describeWarning(w), { issekaied: 'warning', ...w }, dedupeKey('warning', w.eventId), () => this.bus.deliverWarning(w, 'local'));
  }

  share(n: PantheonNote): Promise<void> {
    return this.send(this.pantheon, this.names.pantheon, describeNote(n), { issekaied: 'pantheon', ...n }, dedupeKey('pantheon', n.eventId), () => this.bus.deliverNote(n, 'local'));
  }

  status(): Record<string, unknown> {
    return {
      mode: this.mode(),
      configured: true,
      authenticated: this.relay?.toJSON().authenticated ?? false,
      ready: this.ready,
      channels: [this.names.hivemind, this.names.pantheon],
      agents: this.agentNames,
      receiver: this.receiverName || undefined,
      sent: this.sent,
      received: this.received,
      lastReceivedAt: this.lastReceivedAt || undefined,
      startRetries: this.retries,
      echoMissing: this.echoMissing,
      failures: this.failures,
      lastError: this.lastError || undefined,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.ready = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const t of this.awaitingEcho.values()) clearTimeout(t);
    this.awaitingEcho.clear();
    await this.disposeReceiver();
  }
}

export function createChannels(cfg: Config, names: ChannelNames = GAME_CHANNELS): Channels {
  return cfg.relay.workspaceKey ? new RelayChannels(cfg, names) : new LocalBus();
}
