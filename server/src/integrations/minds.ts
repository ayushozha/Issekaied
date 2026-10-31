import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import type { GhostStrategy, PowerId } from '../../../shared/protocol';
import { STRATEGIES } from '../../../actor/src/memory.ts';
import type { Config } from '../config.ts';
import { DEITY_NAME } from '../combat.ts';

/**
 * NPC minds. One Mastra agent per persona (server/config/npcs.json) on the model named by
 * OPENAI_MODEL through Mastra's model router (OPENAI_API_KEY). Every response is structured and
 * validated: short public dialogue, a strategy from the allowed list, and cited event ids that must
 * come from the facts we supplied. Nothing in the simulation waits on this; failures return a
 * deterministic scripted line and are counted in /health. No chain-of-thought is requested or logged.
 */
export type MindTrigger = 'banished' | 'return' | 'kill' | 'warning' | 'encounter' | 'deity_join';

export interface MindFacts {
  hunterName?: string;
  power?: PowerId;
  memorySummary?: string;
  episodes: { eventId: string; summary: string }[];
  allowedStrategies: GhostStrategy[];
  warnedBy?: string;
  extra?: string;
}

export interface MindRequest {
  npcId: string;
  npcName: string;
  trigger: MindTrigger;
  roomId: string;
  facts: MindFacts;
}

export interface MindResponse {
  dialogue: string;
  strategy?: GhostStrategy;
  citedEventIds: string[];
  source: 'mastra' | 'scripted' | 'scripted-after-failure';
}

export interface NpcConfig {
  defaultVoice: string;
  npcs: Record<string, { voice: string; persona: string }>;
}

export interface Minds {
  mode(): 'mastra-openai' | 'scripted';
  respond(req: MindRequest): Promise<MindResponse>;
  status(): Record<string, unknown>;
}

const EFFECT: Record<PowerId, string> = { ganesha: 'golden shockwave', hanuman: 'saffron wind', shiva: 'icy pulse', vishnu: 'returning chakra' };
const words = (s: GhostStrategy) => s.replace('_', ' ');
const MAX_DIALOGUE = 160;
const MAX_IN_FLIGHT = 3;

const outputSchema = z.object({
  dialogue: z.string().max(240).describe('What the character says aloud. Public, in character, at most two short sentences.'),
  strategy: z.enum(['chase', 'flank', 'keep_distance', 'ambush']).describe('Tactic the character will use next, from the allowed list.'),
  citedEventIds: z.array(z.string()).max(4).describe('Ids of the supplied game events the dialogue is grounded in.'),
});

export function scriptedLine(req: MindRequest): MindResponse {
  const { facts, npcName } = req;
  const power = facts.power;
  const deity = power ? DEITY_NAME[power] : 'the gods';
  const strategy = facts.allowedStrategies[0];
  const hunter = facts.hunterName ?? 'hunter';
  const cited = facts.episodes.slice(0, 2).map((e) => e.eventId);
  const line = (() => {
    switch (req.trigger) {
      case 'banished':
        return `${deity}'s ${power ? EFFECT[power] : 'light'} unmakes me, ${hunter}. I will ${words(strategy)} when I return.`;
      case 'return':
        return facts.memorySummary ? `I remember you, ${hunter}. ${facts.memorySummary}` : `${npcName} stirs again in the dark.`;
      case 'kill':
        return `Rest, ${hunter}. The gate will take you back; I will be waiting.`;
      case 'warning':
        return `${facts.warnedBy ?? 'A voice'} fell to ${deity}. I will ${words(strategy)} instead.`;
      case 'encounter':
        return `You again, ${hunter}. ${facts.memorySummary ?? ''} Not this time.`.replace(/\s+/g, ' ').trim();
      case 'deity_join':
        return `${npcName} remembers ${hunter}. ${facts.memorySummary ?? ''}`.trim();
    }
  })();
  return { dialogue: line.slice(0, MAX_DIALOGUE), strategy, citedEventIds: cited, source: 'scripted' };
}

class ScriptedMinds implements Minds {
  private served = 0;
  mode(): 'scripted' {
    return 'scripted';
  }
  async respond(req: MindRequest): Promise<MindResponse> {
    this.served += 1;
    return scriptedLine(req);
  }
  status(): Record<string, unknown> {
    return { mode: this.mode(), served: this.served, reason: 'OPENAI_API_KEY or OPENAI_MODEL missing' };
  }
}

const buildPrompt = (req: MindRequest): string => {
  const f = req.facts;
  const lines = [
    `Room: ${req.roomId}. Trigger: ${req.trigger}.`,
    f.hunterName ? `Hunter involved: ${f.hunterName}.` : '',
    f.power ? `Divine power involved: ${DEITY_NAME[f.power]} (${EFFECT[f.power]}).` : '',
    f.warnedBy ? `Warning received from: ${f.warnedBy}.` : '',
    f.memorySummary ? `What you remember: ${f.memorySummary}` : 'You have no prior memory of this hunter.',
    f.episodes.length ? `Recorded game events you may cite by id:\n${f.episodes.map((e) => `- ${e.eventId}: ${e.summary}`).join('\n')}` : 'No recorded events to cite.',
    f.extra ?? '',
    `Allowed strategies: ${f.allowedStrategies.join(', ')}.`,
    'Respond with public dialogue only (no inner thoughts), one strategy from the allowed list, and cite only the event ids listed above.',
  ];
  return lines.filter(Boolean).join('\n');
};

class MastraMinds implements Minds {
  private readonly agents = new Map<string, Agent>();
  private readonly busy = new Set<string>();
  private inFlight = 0;
  private ok = 0;
  private failed = 0;
  private dropped = 0;
  private fallback = 0;
  private lastError = '';

  constructor(private readonly model: string, private readonly npcs: NpcConfig) {}

  mode(): 'mastra-openai' {
    return 'mastra-openai';
  }

  private agentFor(npcId: string, npcName: string): Agent {
    let agent = this.agents.get(npcId);
    if (!agent) {
      const persona = this.npcs.npcs[npcId]?.persona ?? `You are ${npcName}, a haunt of Bellgrave. Speak in at most two short sentences.`;
      agent = new Agent({
        id: `issekaied-${npcId}`,
        name: npcName,
        instructions: `${persona}\nYou only ever speak publicly, in character, grounded in the recorded game events you are given. Never invent kills or hunters that are not in the facts. Keep dialogue under 160 characters.`,
        model: this.model,
      });
      this.agents.set(npcId, agent);
    }
    return agent;
  }

  async respond(req: MindRequest): Promise<MindResponse> {
    if (this.busy.has(req.npcId) || this.inFlight >= MAX_IN_FLIGHT) {
      this.dropped += 1;
      return scriptedLine(req);
    }
    this.busy.add(req.npcId);
    this.inFlight += 1;
    try {
      const scripted = scriptedLine(req);
      const fallbackValue = { dialogue: scripted.dialogue, strategy: scripted.strategy ?? req.facts.allowedStrategies[0], citedEventIds: scripted.citedEventIds };
      const result = await this.agentFor(req.npcId, req.npcName).generate(buildPrompt(req), {
        structuredOutput: { schema: outputSchema, errorStrategy: 'fallback', fallbackValue },
        modelSettings: { maxOutputTokens: 220, temperature: 0.9, timeout: { totalMs: 9000 } },
        maxSteps: 1,
      });
      if (result.usedFallbackValue) {
        this.fallback += 1;
        return { ...scripted, source: 'scripted-after-failure' };
      }
      const out = result.object;
      if (!out) throw new Error('empty structured output');
      this.ok += 1;
      const allowedIds = new Set(req.facts.episodes.map((e) => e.eventId));
      const strategy = STRATEGIES.includes(out.strategy) && req.facts.allowedStrategies.includes(out.strategy) ? out.strategy : req.facts.allowedStrategies[0];
      const dialogue = out.dialogue.replace(/\s+/g, ' ').trim().slice(0, MAX_DIALOGUE) || scripted.dialogue;
      return { dialogue, strategy, citedEventIds: out.citedEventIds.filter((id) => allowedIds.has(id)), source: 'mastra' };
    } catch (err) {
      this.failed += 1;
      this.lastError = (err as Error).message.slice(0, 200);
      return { ...scriptedLine(req), source: 'scripted-after-failure' };
    } finally {
      this.busy.delete(req.npcId);
      this.inFlight -= 1;
    }
  }

  status(): Record<string, unknown> {
    return { mode: this.mode(), model: this.model, personas: Object.keys(this.npcs.npcs).length, ok: this.ok, failed: this.failed, fallback: this.fallback, dropped: this.dropped, lastError: this.lastError || undefined };
  }
}

/** Mastra's router wants `provider/model`; OPENAI_MODEL may already carry the prefix. */
export const mastraModelId = (openaiModel: string): string => (openaiModel.includes('/') ? openaiModel : `openai/${openaiModel}`);

export function createMinds(cfg: Config, npcs: NpcConfig): Minds {
  if (cfg.openai.apiKey && cfg.openai.model) return new MastraMinds(mastraModelId(cfg.openai.model), npcs);
  return new ScriptedMinds();
}

export async function loadNpcConfig(file: string): Promise<NpcConfig> {
  const raw = (await Bun.file(file).json()) as Partial<NpcConfig>;
  return { defaultVoice: raw.defaultVoice ?? 'ash', npcs: raw.npcs ?? {} };
}
