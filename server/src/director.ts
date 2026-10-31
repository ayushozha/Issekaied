import type { GhostStrategy, PowerId } from '../../shared/protocol';
import { STRATEGIES, counterStrategy, type GhostMemory, type Invocation } from '../../actor/src/memory.ts';
import { DEITY_NAME } from './combat.ts';
import type { EventLog } from './integrations/eventlog.ts';
import { deityActorId, type MemoryStore } from './integrations/memory.ts';
import type { MindFacts, MindTrigger, Minds } from './integrations/minds.ts';
import type { Channels, HivemindWarning, PantheonNote, Via } from './integrations/relay.ts';
import type { Rehearsal } from './integrations/rehearsal.ts';
import type { Voice } from './integrations/voice.ts';
import type { MemoryHydration, Room, RoomEnemy, RoomPlayer, RoomSignal } from './room.ts';
import type { EncounterBlueprint } from './tactics.ts';

/** Canonical world fact for The Source ledger; mirrors the Source module's SourceEvent shape. */
export interface SourceFact {
  eventId: string;
  kind: 'join' | 'death' | 'banishment' | 'quest' | 'portal';
  at: number;
  roomId: string;
  playerId: string;
  playerName: string;
  subjectId?: string;
  subjectName?: string;
}

/**
 * The director reacts to room signals *after* the tick: it persists episodes to the durable minds,
 * asks the NPC minds for dialogue, rehearses tactics, relays warnings, plans echo trials, and feeds
 * validated results back into the room (pending strategies, tactic changes, whispers, echo plans).
 * Every path is fire-and-forget with bounded fan-out; a failing provider only shows up as a counter.
 */
export interface DirectorDeps {
  rooms: Map<string, Room>;
  eventLog: EventLog;
  memory: MemoryStore;
  channels: Channels;
  minds: Minds;
  voice: Voice;
  rehearsal: Rehearsal;
  /** The Source ledger; receives only server-authored death/banishment/quest/portal facts (joins come from the socket layer). */
  source?: { record(fact: SourceFact): Promise<void> };
  now?: () => number;
  log?: (line: string) => void;
}

export interface Director {
  handle(roomId: string, signal: RoomSignal): void;
  /** Load durable ghost memory into the rooms (restart/reconnect proof). */
  hydrate(): Promise<void>;
  status(): Record<string, unknown>;
  close(): Promise<void>;
}

const INVOCATION_FLUSH_MS = 2000;
const KILL_TALK_COOLDOWN_MS = 20_000;
const JOIN_GREETING_DELAY_MS = 1500;
const MAX_PANTHEON_CONTEXT = 12;

export const hydrationFrom = (mem: GhostMemory): MemoryHydration => {
  const banished = mem.episodes.filter((e) => e.kind === 'banished');
  const last = banished[banished.length - 1];
  return { banishments: mem.banishments, lastPower: last?.power, lastHunterName: last?.hunterName, strategy: mem.strategy, grudgeHunterIds: Object.keys(mem.grudges) };
};

export function createDirector(deps: DirectorDeps): Director {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const counters = {
    signals: 0,
    errors: 0,
    spoken: 0,
    warningsApplied: { relay: 0, local: 0 },
    pantheonNotes: { relay: 0, local: 0 },
    testOnlyIgnored: 0,
    rehearsals: 0,
    echoPlans: 0,
    questMilestones: 0,
    strategyChanges: 0,
    sourceFacts: 0,
    sourceFailures: 0,
  };
  let lastError = '';
  const invocationBatches = new Map<string, Invocation[]>();
  const killTalkAt = new Map<string, number>();
  const pantheonContext: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const fail = (where: string) => (err: unknown) => {
    counters.errors += 1;
    lastError = `${where}: ${(err as Error)?.message ?? String(err)}`.slice(0, 200);
    log(`director ${lastError}`);
  };

  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  const episodeFacts = async (enemy: RoomEnemy, player: RoomPlayer, mem: GhostMemory | null): Promise<MindFacts['episodes']> => {
    const facts: MindFacts['episodes'] = [];
    for (const e of (mem?.episodes ?? []).filter((e) => e.hunterId === player.id).slice(-3)) {
      facts.push({ eventId: e.eventId, summary: `${e.kind.replace('_', ' ')} ${e.power ? `through ${DEITY_NAME[e.power]}` : ''} in ${e.roomId}`.replace(/\s+/g, ' ').trim() });
    }
    const stored = await deps.eventLog.recent({ participantIds: [enemy.id, player.id], kinds: ['banish', 'death', 'return'], limit: 4 }).catch(() => []);
    for (const s of stored) if (!facts.some((f) => f.eventId === s.eventId)) facts.push({ eventId: s.eventId, summary: s.text ?? `${s.kind} event` });
    return facts.slice(0, 6);
  };

  const speak = async (room: Room, npc: { id: string; name: string }, trigger: MindTrigger, facts: MindFacts) => {
    const res = await deps.minds.respond({ npcId: npc.id, npcName: npc.name, trigger, roomId: room.id, facts });
    const withAudio = deps.voice.mode() === 'openai-tts';
    const ev = room.whisper(npc.id, res.dialogue, { withAudio });
    if (withAudio) deps.voice.speak(ev.eventId, npc.id, res.dialogue);
    counters.spoken += 1;
    return { ...res, eventId: ev.eventId };
  };

  /** Hand a canonical fact to The Source off the tick: server event id, server time, stable public hunter id. */
  const fact = (room: Room, kind: SourceFact['kind'], eventId: string, player: RoomPlayer, subject?: { id: string; name: string }) => {
    if (!deps.source) return;
    counters.sourceFacts += 1;
    deps.source
      .record({ eventId, kind, at: now(), roomId: room.id, playerId: player.id, playerName: player.name, ...(subject ? { subjectId: subject.id, subjectName: subject.name } : {}) })
      .catch((err) => {
        counters.sourceFailures += 1;
        fail('source.record')(err);
      });
  };

  const adopt = (room: Room, enemy: RoomEnemy, strategy: GhostStrategy, reason: string, eventId: string, announce = true) => {
    if (!STRATEGIES.includes(strategy)) return;
    if (room.setStrategy(enemy.id, strategy, reason, announce)) counters.strategyChanges += 1;
    deps.memory.ghost(enemy.id).setStrategy(strategy, eventId).catch(fail('memory.setStrategy'));
  };

  // ---- hivemind & pantheon deliveries -----------------------------------------------------------

  deps.channels.onWarning((w: HivemindWarning, via: Via) => {
    if (w.testOnly) {
      counters.testOnlyIgnored += 1;
      return; // synthetic verification traffic never touches game state
    }
    counters.warningsApplied[via] += 1;
    let spoke = false;
    for (const room of deps.rooms.values()) {
      for (const e of room.enemies) {
        if (e.id === w.ghostId || e.state === 'banished' || e.gated) continue;
        adopt(room, e, w.suggestedStrategy, `${w.ghostName}'s warning via ${via === 'relay' ? 'Agent Relay' : 'local bus'}`, w.eventId);
        if (!spoke) {
          spoke = true;
          speak(room, e, 'warning', { hunterName: w.hunterName, power: w.power, warnedBy: w.ghostName, episodes: [{ eventId: w.eventId, summary: `${w.ghostName} banished by ${w.hunterName} through ${DEITY_NAME[w.power]}` }], allowedStrategies: [w.suggestedStrategy] }).catch(fail('speak.warning'));
        }
      }
    }
  });

  deps.channels.onPantheon((n: PantheonNote, via: Via) => {
    if (n.testOnly) {
      counters.testOnlyIgnored += 1;
      return;
    }
    counters.pantheonNotes[via] += 1;
    pantheonContext.push(`${DEITY_NAME[n.deity]} aided ${n.hunterName} against ${n.enemyId} (level ${n.enemyLevel}) in ${n.roomId}${n.banished ? ', banished' : ''}.`);
    if (pantheonContext.length > MAX_PANTHEON_CONTEXT) pantheonContext.shift();
  });

  // ---- signal handlers ---------------------------------------------------------------------------

  const onJoin = (room: Room, player: RoomPlayer) => {
    deps.eventLog.upsertPlayer({ id: player.id, name: player.name });
    later(JOIN_GREETING_DELAY_MS, () => {
      void (async () => {
        if (!room.players.get(player.id)?.connected) return;
        for (const deity of ['shiva', 'vishnu'] as PowerId[]) {
          const ctx = await deps.memory.deity(deity).context(player.id);
          if (ctx.known) {
            const res = await deps.minds.respond({
              npcId: deity,
              npcName: DEITY_NAME[deity],
              trigger: 'deity_join',
              roomId: room.id,
              facts: { hunterName: player.name, power: deity, memorySummary: ctx.summary, episodes: ctx.citedEventIds.map((id) => ({ eventId: id, summary: 'earlier invocation' })), allowedStrategies: ['chase'], extra: pantheonContext.length ? `Pantheon context: ${pantheonContext.slice(-4).join(' ')}` : undefined },
            });
            room.notice(deity, `${DEITY_NAME[deity]}: ${res.dialogue}`);
            return;
          }
        }
        const shiva = await deps.memory.deity('shiva').snapshot();
        if (shiva.invocations > 0) room.notice('shiva', `Shiva: ${(await deps.memory.deity('shiva').context()).summary} You arrive in a world that remembers.`);
      })().catch(fail('join'));
    });
  };

  const onInvocation = (room: Room, s: Extract<RoomSignal, { type: 'invocation' }>) => {
    const id = deityActorId(s.power, room.id);
    const batch = invocationBatches.get(id) ?? [];
    batch.push({ eventId: s.eventId, at: now(), roomId: room.id, hunterId: s.player.id, hunterName: s.player.name, enemyId: s.enemy?.id ?? 'none', enemyLevel: s.enemy?.level ?? 0, banished: false });
    invocationBatches.set(id, batch);
  };

  const onBanish = async (room: Room, s: Extract<RoomSignal, { type: 'banish' }>) => {
    const { enemy, player, power, eventId } = s;
    const at = now();
    fact(room, 'banishment', eventId, player, enemy); // banish event: fromId = hunter, toId = haunt
    const ghost = deps.memory.ghost(enemy.id);
    const memBefore = await ghost.snapshot().catch(() => null);
    const mem = await ghost.recordBanishment({ eventId, at, roomId: room.id, hunterId: player.id, hunterName: player.name, power, distance: s.distance, tactic: enemy.strategy });
    room.hydrateMemory(enemy.id, hydrationFrom(mem));

    const history = (memBefore?.episodes ?? []).filter((e) => e.kind === 'banished' && e.hunterId === player.id && e.power).map((e) => ({ power: e.power as PowerId, distance: e.distance ?? 6 }));
    deps.rehearsal
      .run({ ghostId: enemy.id, level: enemy.level, hunterId: player.id, power, distance: s.distance, history, strategies: [...STRATEGIES] })
      .then((r) => {
        counters.rehearsals += 1;
        room.setPendingStrategy(enemy.id, r.strategy);
        deps.memory.ghost(enemy.id).setStrategy(r.strategy, `${eventId}:rehearsal`).catch(fail('memory.setStrategy'));
        log(`rehearsal ${enemy.id} -> ${r.strategy} (${r.executor}, ${r.durationMs}ms)`);
      })
      .catch(fail('rehearsal'));

    void deps.channels.warn({ eventId, roomId: room.id, ghostId: enemy.id, ghostName: enemy.name, hunterId: player.id, hunterName: player.name, power, suggestedStrategy: counterStrategy(power), at }).catch(fail('channels.warn'));
    void deps.channels.share({ eventId, roomId: room.id, deity: power, hunterId: player.id, hunterName: player.name, enemyId: enemy.id, enemyLevel: enemy.level, banished: true, at }).catch(fail('channels.share'));
    const batch = invocationBatches.get(deityActorId(power, room.id)) ?? [];
    batch.push({ eventId: `${eventId}:banish`, at, roomId: room.id, hunterId: player.id, hunterName: player.name, enemyId: enemy.id, enemyLevel: enemy.level, banished: true });
    invocationBatches.set(deityActorId(power, room.id), batch);

    const recall = await ghost.recall(player.id);
    const res = await speak(room, enemy, 'banished', { hunterName: player.name, power, memorySummary: recall.summary, episodes: await episodeFacts(enemy, player, mem), allowedStrategies: [counterStrategy(power), ...STRATEGIES.filter((x) => x !== counterStrategy(power))] });
    deps.eventLog.addLore({ roomId: room.id, subjectId: enemy.id, title: `${enemy.name} banished by ${player.name}`, body: `${res.dialogue} ${recall.summary}`.trim(), eventIds: [eventId, ...res.citedEventIds.filter((id) => id !== eventId)].slice(0, 8) });
    ghost.addLore(res.dialogue, [eventId, ...res.citedEventIds], at).catch(fail('memory.addLore'));
  };

  const onReturn = async (room: Room, s: Extract<RoomSignal, { type: 'return' }>) => {
    const { enemy, eventId } = s;
    const banisher = enemy.lastBanisher;
    const ghost = deps.memory.ghost(enemy.id);
    await ghost.recordReturn({ eventId, at: now(), roomId: room.id, hunterId: banisher?.hunterId ?? 'none', hunterName: banisher?.hunterName ?? 'nobody', power: banisher?.power, tactic: enemy.strategy });
    if (!s.banisherPresent || !banisher) return;
    const player = room.players.get(banisher.hunterId);
    if (!player) return;
    const recall = await ghost.recall(player.id);
    adopt(room, enemy, recall.tactic, `remembers ${player.name}`, `${eventId}:recall`, false);
    const mem = await ghost.snapshot().catch(() => null);
    await speak(room, enemy, 'return', { hunterName: player.name, power: banisher.power, memorySummary: recall.summary, episodes: await episodeFacts(enemy, player, mem), allowedStrategies: [recall.tactic] });
  };

  const onDeath = async (room: Room, s: Extract<RoomSignal, { type: 'hunter_death' }>) => {
    const { enemy, player, eventId } = s;
    fact(room, 'death', eventId, player, enemy); // death event: fromId = fallen hunter, toId = haunt
    await deps.memory.ghost(enemy.id).recordKill({ eventId, at: now(), roomId: room.id, hunterId: player.id, hunterName: player.name, tactic: enemy.strategy });
    const last = killTalkAt.get(enemy.id) ?? 0;
    if (now() - last < KILL_TALK_COOLDOWN_MS) return;
    killTalkAt.set(enemy.id, now());
    await speak(room, enemy, 'kill', { hunterName: player.name, episodes: [{ eventId, summary: `${player.name} fell to ${enemy.name}` }], allowedStrategies: [enemy.strategy] });
  };

  const onEncounter = async (room: Room, s: Extract<RoomSignal, { type: 'encounter' }>) => {
    const { enemy, player } = s;
    const ghost = deps.memory.ghost(enemy.id);
    const recall = await ghost.recall(player.id);
    if (!recall.known) return;
    const eventId = `${enemy.id}:${player.id}:${now()}`;
    adopt(room, enemy, recall.tactic, `recognises ${player.name}`, eventId);
    const mem = await ghost.snapshot().catch(() => null);
    await speak(room, enemy, 'encounter', { hunterName: player.name, power: recall.grudge?.lastPower, memorySummary: recall.summary, episodes: await episodeFacts(enemy, player, mem), allowedStrategies: [recall.tactic] });
  };

  const onQuest = (room: Room, s: Extract<RoomSignal, { type: 'quest' }>) => {
    fact(room, 'quest', s.eventId, s.player, s.subject); // the hunter whose banishment or portal use caused the milestone
    if (s.stage < 2) return; // sigil pickups are already canonical game events; lore marks the milestones
    counters.questMilestones += 1;
    const title = s.bossDefeated ? `Echo ${s.echo}: the boss altar falls` : `Echo ${s.echo}: three sigils unlock the altar`;
    deps.eventLog.addLore({ roomId: room.id, subjectId: 'adventure', title, body: `${s.sigils} sigils, stage ${s.stage}${s.bossDefeated ? ', portal open' : ''}.`, eventIds: [s.eventId] });
  };

  /** Echo portal: plan the altered trial from what the hunters actually did to each haunt, outside the tick. */
  const onPortal = async (room: Room, s: Extract<RoomSignal, { type: 'portal' }>) => {
    fact(room, 'portal', s.eventId, s.player);
    const present = new Set([...room.players.values()].filter((p) => p.connected).map((p) => p.id));
    const enemies: EncounterBlueprint['enemies'] = [];
    for (const e of room.enemies) {
      const mem = await deps.memory.ghost(e.id).snapshot().catch(() => null);
      const relevant = (mem?.episodes ?? []).filter((ep) => ep.kind === 'banished' && ep.power);
      const byPresent = relevant.filter((ep) => present.has(ep.hunterId));
      const history = (byPresent.length ? byPresent : relevant).slice(-8).map((ep) => ({ power: ep.power as PowerId, distance: ep.distance ?? 6 }));
      enemies.push({ id: e.id, level: e.level, history, strategies: [...STRATEGIES] });
    }
    const plan = await deps.rehearsal.plan({ echo: s.echo, enemies });
    counters.echoPlans += 1;
    const applied = room.applyEchoPlan(plan);
    if (applied) for (const entry of plan.enemies) deps.memory.ghost(entry.id).setStrategy(entry.strategy, `${s.eventId}:echo${s.echo}`).catch(fail('memory.setStrategy'));
    deps.eventLog.addLore({ roomId: room.id, subjectId: 'adventure', title: `Echo ${s.echo} begins`, body: plan.rationale, eventIds: [s.eventId] });
    log(`echo plan ${s.echo}: ${plan.executor}${plan.cached ? ' (cached)' : ''} ${plan.durationMs}ms applied=${applied}`);
  };

  const flushInvocations = () => {
    for (const [id, batch] of invocationBatches) {
      invocationBatches.delete(id);
      deps.memory.deity(id).recordInvocations(batch).catch(fail('memory.recordInvocations'));
    }
  };
  const flushTimer = setInterval(flushInvocations, INVOCATION_FLUSH_MS);

  return {
    handle(roomId, signal) {
      const room = deps.rooms.get(roomId);
      if (!room) return;
      counters.signals += 1;
      switch (signal.type) {
        case 'join':
          onJoin(room, signal.player);
          return;
        case 'leave':
          return;
        case 'invocation':
          onInvocation(room, signal);
          return;
        case 'banish':
          onBanish(room, signal).catch(fail('banish'));
          return;
        case 'return':
          onReturn(room, signal).catch(fail('return'));
          return;
        case 'hunter_death':
          onDeath(room, signal).catch(fail('death'));
          return;
        case 'encounter':
          onEncounter(room, signal).catch(fail('encounter'));
          return;
        case 'quest':
          onQuest(room, signal);
          return;
        case 'portal':
          onPortal(room, signal).catch(fail('portal'));
          return;
      }
    },
    async hydrate() {
      for (const room of deps.rooms.values()) {
        for (const e of room.enemies) {
          try {
            const mem = await deps.memory.ghost(e.id).snapshot();
            room.hydrateMemory(e.id, hydrationFrom(mem));
          } catch (err) {
            fail('hydrate')(err);
          }
        }
      }
      log(`hydrated ghost memory via ${deps.memory.mode()}`);
    },
    status() {
      return { ...counters, pendingInvocationBatches: invocationBatches.size, pantheonContext: pantheonContext.length, lastError: lastError || undefined };
    },
    async close() {
      clearInterval(flushTimer);
      for (const t of timers) clearTimeout(t);
      flushInvocations();
    },
  };
}
