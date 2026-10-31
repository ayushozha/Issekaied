import path from 'node:path';

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const str = (v: string | undefined): string | undefined => (v && v.trim() ? v.trim() : undefined);

/**
 * Runtime configuration. Values come from the process environment (the `start`/`dev` scripts load the
 * root `.env` with `bun --env-file`). Secrets are only ever read here and never logged; `presence()`
 * exposes booleans for /health so missing configuration is reported without leaking values.
 */
export const config = {
  host: process.env.HOST ?? '::',
  port: num(process.env.PORT, 8787),
  tickRate: num(process.env.TICK_RATE, 20),
  snapshotRate: num(process.env.SNAPSHOT_RATE, 10),
  roomCapacity: num(process.env.ROOM_CAPACITY, 50),
  roomIds: (process.env.ROOM_IDS ?? 'bellgrave').split(',').map((s) => s.trim()).filter(Boolean),
  dataDir: process.env.ISSEKAIED_DATA_DIR ?? path.resolve(import.meta.dir, '../.data'),
  npcConfigPath: process.env.NPC_CONFIG_PATH ?? path.resolve(import.meta.dir, '../config/npcs.json'),
  openai: {
    apiKey: str(process.env.OPENAI_API_KEY),
    model: str(process.env.OPENAI_MODEL),
    ttsModel: str(process.env.OPENAI_TTS_MODEL),
    /** Optional default voice; per-NPC voices in config/npcs.json still win. */
    ttsVoice: str(process.env.OPENAI_TTS_VOICE),
    /** The Source (OpenAI Realtime narrator). Both are required to enable it; nothing is defaulted in code. */
    realtimeModel: str(process.env.OPENAI_REALTIME_MODEL),
    realtimeVoice: str(process.env.OPENAI_REALTIME_VOICE),
  },
  supabase: {
    url: str(process.env.SUPABASE_URL),
    secretKey: str(process.env.SUPABASE_SECRET_KEY) ?? str(process.env.SUPABASE_SERVICE_ROLE_KEY),
  },
  terse: {
    actorUrl: str(process.env.TERSE_ACTOR_URL),
    apiKey: str(process.env.TERSE_API_KEY),
  },
  relay: {
    workspaceKey: str(process.env.RELAY_WORKSPACE_KEY),
    baseUrl: str(process.env.RELAY_BASE_URL),
  },
  superserve: {
    apiKey: str(process.env.SUPERSERVE_API_KEY),
    rehearsal: process.env.SUPERSERVE_REHEARSAL === '1',
    template: str(process.env.SUPERSERVE_TEMPLATE) ?? 'superserve/node-22',
  },
} as const;

export type Config = typeof config;

/** Which configuration keys are present. Booleans only; this is what /health reports. */
export const presence = () => ({
  OPENAI_API_KEY: !!config.openai.apiKey,
  OPENAI_MODEL: !!config.openai.model,
  OPENAI_TTS_MODEL: !!config.openai.ttsModel,
  OPENAI_REALTIME_MODEL: !!config.openai.realtimeModel,
  OPENAI_REALTIME_VOICE: !!config.openai.realtimeVoice,
  SUPABASE_URL: !!config.supabase.url,
  SUPABASE_SECRET_KEY: !!config.supabase.secretKey,
  TERSE_ACTOR_URL: !!config.terse.actorUrl,
  TERSE_API_KEY: !!config.terse.apiKey,
  RELAY_WORKSPACE_KEY: !!config.relay.workspaceKey,
  SUPERSERVE_API_KEY: !!config.superserve.apiKey,
  SUPERSERVE_REHEARSAL: config.superserve.rehearsal,
});

export const missingConfig = (): string[] =>
  Object.entries(presence())
    .filter(([, present]) => !present)
    .map(([key]) => key);
