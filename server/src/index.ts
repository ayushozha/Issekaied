import pkg from '../package.json';
import { config, missingConfig, presence } from './config.ts';
import { createDirector } from './director.ts';
import { EventIds, Fanout, type ServerEvent } from './events.ts';
import { startGameServer } from './game.ts';
import { createEventLog } from './integrations/eventlog.ts';
import { createMemoryStore } from './integrations/memory.ts';
import { createMinds, loadNpcConfig } from './integrations/minds.ts';
import { createRehearsal } from './integrations/rehearsal.ts';
import { createChannels } from './integrations/relay.ts';
import { createSourceService, type SourceService } from './integrations/source.ts';
import { createVoice } from './integrations/voice.ts';
import { resolveSourcePlayer } from './game.ts';
import { Room, type RoomSignal } from './room.ts';

const startedAt = Date.now();
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const ids = new EventIds();
const events = new Fanout<ServerEvent>();
const signals = new Fanout<RoomSignal>();
const rooms = new Map<string, Room>();
for (const id of config.roomIds) {
  rooms.set(
    id,
    new Room(id, {
      capacity: config.roomCapacity,
      tickRate: config.tickRate,
      nextEventId: () => ids.next(),
      onEvent: (ev) => events.emit(id, ev),
      onSignal: (s) => signals.emit(id, s),
    }),
  );
}

const npcConfig = await loadNpcConfig(config.npcConfigPath);
if (config.openai.ttsVoice) npcConfig.defaultVoice = config.openai.ttsVoice;
const eventLog = await createEventLog(config);
const memory = createMemoryStore(config);
const channels = createChannels(config);
const minds = createMinds(config, npcConfig);
const voice = createVoice(config, npcConfig);
const rehearsal = createRehearsal(config);
events.subscribe((roomId, ev) => eventLog.record(roomId, ev));

// The Source: OpenAI Realtime narrator (Mac-owned module). Enabled only with typed model + voice config;
// the browser only ever receives the module's ephemeral client secret. Model/voice are never defaulted here.
let source: SourceService | null = null;
let sourceDisabledReason = '';
if (config.openai.apiKey && config.openai.realtimeModel && config.openai.realtimeVoice) {
  try {
    source = createSourceService({
      apiKey: config.openai.apiKey,
      realtimeModel: config.openai.realtimeModel,
      voice: config.openai.realtimeVoice,
      terseUrl: config.terse.actorUrl,
      terseKey: config.terse.apiKey,
      relayWorkspaceKey: config.relay.workspaceKey,
      relayBaseUrl: config.relay.baseUrl,
      resolvePlayer: (playerKey, roomId) => resolveSourcePlayer(rooms, playerKey, roomId),
    });
  } catch (err) {
    sourceDisabledReason = `createSourceService failed: ${(err as Error).message}`.slice(0, 160);
  }
} else {
  sourceDisabledReason = [!config.openai.apiKey && 'OPENAI_API_KEY', !config.openai.realtimeModel && 'OPENAI_REALTIME_MODEL', !config.openai.realtimeVoice && 'OPENAI_REALTIME_VOICE'].filter(Boolean).join(', ') + ' missing';
}

const director = createDirector({ rooms, eventLog, memory, channels, minds, voice, rehearsal, source: source ?? undefined, log });
signals.subscribe((roomId, s) => director.handle(roomId, s));

/**
 * Hosting metadata only: the primary API runs on the VPS; Terse/Source actors are hosted on Freestyle when
 * TERSE_ACTOR_URL names a *.style.dev host. Hostname only (never path, token or userinfo); runtime
 * reachability is reported by the adjacent `terse` status, not here. Invalid or missing URLs never throw.
 */
const freestyleHosting = (): Record<string, unknown> => {
  const raw = config.terse.actorUrl;
  if (!raw) return { mode: 'not-configured', api: 'vps', detail: 'TERSE_ACTOR_URL missing; no actor host configured' };
  let hostname = '';
  try {
    hostname = new URL(raw).hostname.toLowerCase();
  } catch {
    return { mode: 'external-host-unknown', api: 'vps', detail: 'TERSE_ACTOR_URL is not a parseable URL' };
  }
  const onFreestyle = hostname === 'style.dev' || hostname.endsWith('.style.dev');
  return onFreestyle
    ? { mode: 'actor-host', api: 'vps', actorHost: hostname, role: 'Terse + Source actors on Freestyle (style.dev); see integrations.terse for reachability' }
    : { mode: 'external-host-unknown', api: 'vps', actorHost: hostname, role: 'actor host is not a style.dev domain' };
};

const health = () => ({
  ok: true,
  service: pkg.name,
  version: pkg.version,
  phase: 2,
  pid: process.pid,
  bootId: ids.bootId,
  uptimeMs: Date.now() - startedAt,
  now: Date.now(),
  tickRate: config.tickRate,
  snapshotRate: config.snapshotRate,
  rooms: [...rooms.values()].map((r) => ({
    id: r.id,
    players: r.connectedCount,
    capacity: config.roomCapacity,
    tick: r.tick,
    adventure: r.adventureState(),
    enemies: r.enemies.map((e) => ({
      id: e.id,
      name: e.name,
      level: e.level,
      state: e.state,
      strategy: e.strategy,
      hp: e.hp,
      maxHp: e.maxHp,
      aggro: e.targetId !== null,
      gated: e.gated,
      home: e.home,
      banishments: e.memory.banishments,
      lastHunterName: e.memory.lastHunterName,
    })),
  })),
  loop: game.metrics(),
  integrations: {
    supabase: eventLog.status(),
    terse: memory.status(),
    agentRelay: channels.status(),
    mastraOpenAI: minds.status(),
    voice: voice.status(),
    superserve: rehearsal.status(),
    source: source ? source.status() : { mode: 'not-configured', reason: sourceDisabledReason },
    freestyle: freestyleHosting(),
  },
  director: director.status(),
  config: presence(),
  missingConfig: missingConfig(),
  notes: ['room capacity is configured, not load-tested', 'modes named local-* are explicit fallbacks, not the hosted provider'],
});

const game = startGameServer({
  host: config.host,
  port: config.port,
  rooms,
  tickRate: config.tickRate,
  snapshotRate: config.snapshotRate,
  health,
  audio: (eventId) => voice.get(eventId, 10_000),
  lore: (q) => eventLog.searchLore(q),
  source: source ?? undefined,
  // Socket-bound join fact: fires only after a validated join on an open socket, with the stable public id.
  onJoin: ({ roomId, playerId, name }) => {
    if (!source) return;
    source.record({ eventId: ids.next(), kind: 'join', at: Date.now(), roomId, playerId, playerName: name }).catch((err) => log(`source.record join: ${(err as Error).message}`));
  },
  log,
});
events.subscribe((roomId, ev) => game.publish(roomId, ev));

log(`${pkg.name} ${pkg.version} listening on http://${config.host}:${game.port} (GET /health, WS /ws) rooms=${[...rooms.keys()].join(',')} capacity=${config.roomCapacity}`);
log(`modes: events=${eventLog.mode} memory=${memory.mode()} channels=${channels.mode()} minds=${minds.mode()} voice=${voice.mode()} rehearsal=${rehearsal.mode()} source=${source ? 'configured' : `not-configured (${sourceDisabledReason})`}`);
if (missingConfig().length) log(`missing config: ${missingConfig().join(', ')}`);

// Provider start-up never gates playability: the room is live already.
void director.hydrate();
void channels.start().then(() => log(`channels: ${channels.mode()}`));
if (config.terse.actorUrl) {
  void memory.probe().then((ok) => log(`terse probe: ${ok ? 'reachable' : 'unreachable, using local-file fallback until it answers'}`));
  setInterval(() => void memory.probe(), 30_000);
}

const shutdown = async (signal: string) => {
  log(`${signal}: shutting down`);
  game.stop();
  await director.close();
  await Promise.allSettled([eventLog.close(), memory.close(), channels.close(), source?.close() ?? Promise.resolve()]);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
