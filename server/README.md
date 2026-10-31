# Issekaied server

Authoritative Bun room for the Bellgrave adventure: 20 Hz movement/combat, 10 Hz snapshots, `GET /health`,
`WS /ws`, `GET /api/audio/<eventId>`, `GET /api/lore?q=`. The client never decides positions, damage, levels,
kills, powers, cooldowns or quest state. It sends `join`, `input` (a direction plus `active`), `cast` with an
explicit `action`, and `interact`; the server picks the deity channel with the shared `powerForEnemyLevel`.

| Client intent | Server behaviour |
| --- | --- |
| `input` every tick | Direction only; movement stops 400 ms after the last input, hunter goes inactive after 5 s or on `active:false` (not targeted, cannot act) |
| `cast` `primary` (LMB) | Aimed strike, 18 m, own 0.6 s cooldown |
| `cast` `secondary` (RMB) | Ward: halves damage 4 s, repels haunts within 3 m, 8 s cooldown |
| `cast` `incantation` (Q) | Automatic level-based deity power with per-deity cooldowns |
| `cast` `heal` (R) | +35 HP bounded, 12 s cooldown |
| `interact` `shrine` / `portal` / `respawn` (E) | Proximity-checked blessing, echo portal (boss must be defeated), explicit respawn after defeat |

Haunts patrol their encounter home, aggro within 8 m, leash at 14 m, never target hunters inside the 7 m safe
gate. Morrow, Nix and Vesper each yield one sigil (idempotent); three sigils ungate Raksha; the boss opens the
portal; the portal restarts the same courtyard as an echo with bounded scaling and rehearsed tactics.

## Run

```sh
cd server && bun install
bun run start          # loads ../.env, listens on [::]:8787 (dual-stack so Vite's localhost proxy works)
bun run check          # tsc + bun test
# Provider-free fixture (coordinator-owned env file; all provider keys blank, 127.0.0.1:8791, room phase2-probe):
DISABLE_BOOST=1 bun --env-file="<abs>/.claude-orchestration/phase2-fixture.env" src/index.ts
bun scripts/adventure-check.ts --url ws://127.0.0.1:8791/ws --room phase2-probe   # two-client adventure smoke
bun scripts/relay-probe.ts     # real Relay delivery check on probe-only agents/channels (needs RELAY_WORKSPACE_KEY)
bun scripts/smoke.ts --clients 50 --seconds 15      # Phase 1 synthetic load (historical)
bun scripts/live-check.ts                           # Phase 1 provider check: approach, banish, speech, return
```

## Layout

| Path | Role |
| --- | --- |
| `src/room.ts` | Authoritative simulation: join/reconnect, inputs, casts, haunt AI, separation, banish/return, snapshots |
| `src/combat.ts`, `src/world.ts` | Bounded combat constants; shared world + collision mirror of the client |
| `src/validate.ts` | Zod trust boundary for every client frame |
| `src/game.ts` | Bun HTTP/WebSocket front door, socket→identity binding, rate limiting, pub/sub snapshots |
| `src/director.ts` | Reacts to room signals off the tick: memory, minds, rehearsal, relay, lore |
| `src/integrations/eventlog.ts` | Supabase canonical events/players/lore (`supabase`) or explicit `local-jsonl` fallback |
| `src/integrations/memory.ts` | Terse Durable Actors via `terse-sdk/actors` stubs (`terse`) or explicit `local-file` fallback |
| `src/integrations/relay.ts` | Agent Relay `#hivemind` / `#pantheon` channels (`relay`) or explicit `local-bus` |
| `src/integrations/minds.ts` | Mastra agents per persona on `OPENAI_MODEL` (`mastra-openai`) or deterministic `scripted` |
| `src/integrations/voice.ts` | OpenAI TTS on `OPENAI_TTS_MODEL`, voices from `config/npcs.json` (`openai-tts`) or `disabled` |
| `src/integrations/rehearsal.ts`, `src/tactics.ts` | Superserve microVM tactic rehearsal (`superserve`) or `local-scoring` |
| `config/npcs.json` | Deployment config: personas and voices |
| `supabase/schema.sql` | Tables the Supabase mode writes to |
| `../actor` | The Terse actor project (Ghost, Deity) |

## Environment

| Variable | Effect |
| --- | --- |
| `HOST`, `PORT` | Bind address (default `::`) and port (default `8787`) |
| `ROOM_CAPACITY`, `ROOM_IDS`, `TICK_RATE`, `SNAPSHOT_RATE` | Defaults 50, `bellgrave`, 20, 10 |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Enables Mastra NPC minds (`openai/<model>` through Mastra's router) |
| `OPENAI_TTS_MODEL` | Enables server-side speech; voices come from `config/npcs.json` (`NPC_CONFIG_PATH` overrides) |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) | Canonical event log, players, searchable lore |
| `TERSE_ACTOR_URL`, `TERSE_API_KEY` | Terse actors (local dev: `http://127.0.0.1:7100/v1/projects/local/actors`, no key) |
| `RELAY_WORKSPACE_KEY`, `RELAY_BASE_URL` | Agent Relay workspace; agent tokens persist in `.data/relay-agents.json` |
| `SUPERSERVE_API_KEY`, `SUPERSERVE_REHEARSAL=1`, `SUPERSERVE_TEMPLATE` | MicroVM rehearsal (billable; off until explicitly enabled) |
| `ISSEKAIED_DATA_DIR` | Local fallback files (default `server/.data`) |

`/health` reports every mode and counter without secrets; anything named `local-*` is a fallback, not the provider.
