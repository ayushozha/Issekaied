import OpenAI from 'openai';
import type { Config } from '../config.ts';
import type { NpcConfig } from './minds.ts';

/**
 * Server-side speech for NPC dialogue. The TTS model comes from OPENAI_TTS_MODEL and each NPC's voice
 * from the deployment config (server/config/npcs.json). Audio is cached in memory and served from
 * /api/audio/<eventId>; the HTTP handler long-polls while synthesis is pending so the whisper event
 * can be sent immediately and gameplay never waits on speech.
 */
export interface Voice {
  mode(): 'openai-tts' | 'disabled';
  /** Start synthesis for an event; fire and forget. */
  speak(eventId: string, npcId: string, text: string): void;
  /** Resolve the audio for an event, waiting up to `waitMs` for pending synthesis. */
  get(eventId: string, waitMs: number): Promise<Uint8Array | null>;
  status(): Record<string, unknown>;
}

const MAX_CACHE = 120;
const MAX_TEXT = 300;
const PER_MINUTE = 40;

class DisabledVoice implements Voice {
  constructor(private readonly reason: string) {}
  mode(): 'disabled' {
    return 'disabled';
  }
  speak(): void {}
  async get(): Promise<null> {
    return null;
  }
  status(): Record<string, unknown> {
    return { mode: this.mode(), reason: this.reason };
  }
}

class OpenAiVoice implements Voice {
  private readonly client: OpenAI;
  private readonly cache = new Map<string, Uint8Array>();
  private readonly pending = new Map<string, Promise<Uint8Array | null>>();
  private readonly minute: number[] = [];
  private ok = 0;
  private failed = 0;
  private throttled = 0;
  private lastError = '';

  constructor(apiKey: string, private readonly model: string, private readonly npcs: NpcConfig) {
    this.client = new OpenAI({ apiKey, timeout: 15_000, maxRetries: 1 });
  }

  mode(): 'openai-tts' {
    return 'openai-tts';
  }

  private voiceFor(npcId: string): string {
    return this.npcs.npcs[npcId]?.voice ?? this.npcs.defaultVoice;
  }

  speak(eventId: string, npcId: string, text: string): void {
    if (this.cache.has(eventId) || this.pending.has(eventId)) return;
    const now = Date.now();
    while (this.minute.length && now - this.minute[0] > 60_000) this.minute.shift();
    if (this.minute.length >= PER_MINUTE) {
      this.throttled += 1;
      return;
    }
    this.minute.push(now);
    const job = this.synthesize(npcId, text.slice(0, MAX_TEXT))
      .then((audio) => {
        if (audio) this.store(eventId, audio);
        return audio;
      })
      .finally(() => this.pending.delete(eventId));
    this.pending.set(eventId, job);
  }

  private async synthesize(npcId: string, input: string): Promise<Uint8Array | null> {
    try {
      const res = await this.client.audio.speech.create({ model: this.model, voice: this.voiceFor(npcId), input, response_format: 'mp3' });
      const audio = new Uint8Array(await res.arrayBuffer());
      this.ok += 1;
      return audio;
    } catch (err) {
      this.failed += 1;
      this.lastError = (err as Error).message.slice(0, 200);
      return null;
    }
  }

  private store(eventId: string, audio: Uint8Array): void {
    this.cache.set(eventId, audio);
    if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
  }

  async get(eventId: string, waitMs: number): Promise<Uint8Array | null> {
    const hit = this.cache.get(eventId);
    if (hit) return hit;
    const pending = this.pending.get(eventId);
    if (!pending) return null;
    return Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs))]);
  }

  status(): Record<string, unknown> {
    return { mode: this.mode(), model: this.model, cached: this.cache.size, pending: this.pending.size, ok: this.ok, failed: this.failed, throttled: this.throttled, lastError: this.lastError || undefined };
  }
}

export function createVoice(cfg: Config, npcs: NpcConfig): Voice {
  if (!cfg.openai.apiKey) return new DisabledVoice('OPENAI_API_KEY missing');
  if (!cfg.openai.ttsModel) return new DisabledVoice('OPENAI_TTS_MODEL missing');
  return new OpenAiVoice(cfg.openai.apiKey, cfg.openai.ttsModel, npcs);
}
