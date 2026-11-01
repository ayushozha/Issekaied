# Issekaied — The Dead Remember · [Play live demo ↗](https://issekaied.ayushojha.com)

A first-person Halloween adventure built around **stateful characters** and **agent-to-agent communication**: the ghosts you banish remember your name, share warnings, and come back with a grudge.

**Terse Durable Actors × Agent Relay** · OpenAI · Mastra · Supabase · Freestyle · Superserve

[Play in your browser](https://issekaied.ayushojha.com) · [Watch the two-minute demo](https://issekaied.ayushojha.com/video/Issekaied-2min-submission-v2.mp4) · [Sponsor integrations](#sponsor-integrations) · [Run locally](#run-locally)

## Sponsor integrations

| Track technology | What it powers in the game |
| --- | --- |
| **Terse Durable Actors — Stateful Apps** | Each ghost retains its grudges and encounter history. Divine actors share persistent context, and the Source remembers player arrivals, deaths and banishments. The actual actor runtime is hosted on Freestyle. |
| **Agent Relay — Agent-to-Agent Communication** | Ghosts send warnings through the enemy hivemind; recipients can change tactics. The pantheon shares invocation outcomes, and the Source relays canonical world facts through the self-hosted Relaycast engine. |

| Sponsor | What it powers in the game |
| --- | --- |
| **OpenAI** | NPC intelligence and individual voices, plus two-way Realtime voice and text with the Source. |
| **Mastra** | Event-triggered NPC agents produce structured dialogue and validated tactics grounded in encounter events. |
| **Supabase** | Player records, gameplay events, searchable lore and the live hunter leaderboard. Unique event IDs prevent duplicate history; backend-only tables are protected by RLS. |
| **Freestyle** | An isolated, persistent VM runs the real Terse actor service separately from the game server. |
| **Superserve** | Disposable sandboxes run bounded tactic and encounter-scoring jobs; validated results inform returning ghosts and echo encounters. |

**The demo loop:** banish a ghost → **Terse** saves who did it → **Agent Relay** warns other ghosts → the world reacts when you return. Ask the **OpenAI Realtime** Source for directions, and see the recorded hunt on the **Supabase** leaderboard.

[Integration code and runtime evidence](#track-technology-in-the-running-game) · [Demo script](docs/DEMO-SCRIPT-2MIN.md) · [Verification notes](docs/DEMO.md) · [Asset credits](docs/MAP-ASSETS.md)

<p align="center"><img src="docs/assets/submission-cover.jpg" width="480" alt="Issekaied concept cover: the Returned hunter, divine protectors and Bellgrave ghosts"></p>

*Project key art. Gameplay uses a 3D courtyard, illustrated ghost impostors and live interface elements.*

![Actual Bellgrave gameplay: stone cathedral, crimson windows, Halloween props and the live hunter interface](docs/assets/bellgrave-gameplay.png)

*Actual browser gameplay, captured from the verified build: the authored cathedral, textured paths, illustrated enemies and live interface.*

## The hunt

Your old world ended. A ten-second narrated prologue brings you into Bellgrave: a hand-built Halloween realm of pumpkin graves, ruined chapel arches, lantern paths and a guarded eastern altar. Fifty enemies inhabit the expanded map. Recover three sigils from Morrow, Nix and Vesper, then confront Raksha. The echo portal changes the encounter inside this same world.

The hunter draws strength from Ganesha, Hanuman, Shiva and Vishnu according to the encounter. There is no deity-selection screen. Ghosts patrol their own areas, warn one another and adapt when a remembered hunter returns. Engaged ghosts close in to strike: evasive ghosts retreat briefly between attacks, and ambushers wait briefly before charging. A ranged hit provokes the struck ghost within its pursuit boundary; the gate remains safe ground.

| Control | Action |
| --- | --- |
| WASD / Shift | Move / sprint |
| Left mouse / right mouse | Primary attack / protective ward |
| Q | Invoke the appropriate divine incantation |
| R | Recovery mantra |
| E | Shrine, portal or explicit return after defeat |
| V / The Source panel | Push-to-talk, or type a question |
| Escape | Pause and release the mouse |

Settings control music, voice, effects, look sensitivity and reduced motion. Visible weapon swings and ward animations accompany mouse attacks; enemies lunge on confirmed strikes. Incantations last under two seconds, use distinct portraits, mandalas, wind, frost and chakra effects, and cost 25 vitality. Nearby enemies speak sparingly; the Source answers when you ask. Movement requires held keys and stops when input is released or lost.

The on-screen hunter leaderboard records banishments, deaths, arrivals and play time from server-authored events in Supabase. Open **Leaderboard** from the main menu to inspect the full top-ten ledger, or use **Copy join link** to invite another hunter. Ghost memory and player history continue across hunts.

## Stateful characters: a world that remembers

A banishment records the hunter, power and event ID. The returning ghost retrieves that history, changes tactics and can speak about the encounter. Shiva, Vishnu and The Source retain shared context across games; The Source maintains player arrivals, deaths and banishments and answers questions using the current objective and world state.

The Source uses OpenAI Realtime for two-way voice and text. Microphone access starts only through a player action; the game does not persist raw microphone audio. Recorded gameplay facts, rather than chat claims, update durable counters.

## Agent-to-agent communication: a world that reacts

After a banishment, Agent Relay carries a grounded warning through the enemy hivemind. Recipients can change tactics when the message is delivered. The pantheon shares invocation outcomes, while the Source distributes canonical world facts. Persistent state gives each character history; communication lets those characters influence one another.

## Join the same world

Open [issekaied.ayushojha.com](https://issekaied.ayushojha.com), enter a hunter name and join Bellgrave. Participants share the live room and see one another. A browser guest key keeps identity stable between visits; names alone are not identity. The server enforces a configured capacity of 50 hunters, but 50 simultaneous real browsers have not been load-tested. The hunter ledger records accepted joins and gameplay events in Supabase.

## Track technology in the running game

**Terse is a real remote runtime here.** [`actor/src/`](actor/src/) defines the durable ghost, deity and Source actors. [`server/src/integrations/memory.ts`](server/src/integrations/memory.ts) calls them through `terse-sdk` actor stubs. The actor service runs on a Freestyle VM; the main game API runs on the VPS. Ghost banishments and grudges, shared Shiva/Vishnu context and the Source ledger survive independently of a room's lifetime. This demo self-hosts Terse's local/dev runtime, rather than claiming managed Terse Cloud or replicated production infrastructure.

Enemy reactions happen immediately; strategy persistence runs separately with at most four concurrent writes. Repeated pending strategy updates for the same ghost keep the latest intent, while encounter history remains in the canonical event log.

**Agent Relay is in the gameplay path.** [`server/src/integrations/relay.ts`](server/src/integrations/relay.ts) uses `@agent-relay/sdk` with the private self-hosted Relaycast engine: `hivemind` delivers enemy warnings that recipients use to change tactics; `pantheon` shares invocation outcomes between divine agents. The Source also relays canonical world facts. This is the SDK integration, separate from installing the coding-session CLI. The official [Agent Relay framework guide](https://agentrelay.net/docs/communicate) and [Relaycast self-hosting guide](https://github.com/AgentWorkforce/relaycast#self-hosting) describe these supported integration paths.

Stable sender identities publish to those shared channels; each server start opens a fresh receiving session. Ghost warnings and divine updates have separate delivery tracking even when they refer to the same gameplay event. Persistent history remains in Terse and Supabase.

The public [`/health`](https://issekaied.ayushojha.com/health) endpoint exposes provider modes, reachability and sent/received counters. `terse` and `relay` identify actual provider paths; fallback modes are explicitly named. Counters are per process and reset on deployment. They are operational evidence, not sponsor billing receipts.

Movement and combat never wait for model, database, actor-network or sandbox calls. Provider failures have explicit modes; a local fallback is never presented as a successful hosted integration.

```mermaid
flowchart LR
  B[Browser: Bellgrave] <--> G[Bun game server on VPS]
  G <--> T[Terse actors on Freestyle]
  G <--> R[Agent Relay channels]
  G --> D[Supabase events and lore]
  G --> A[Mastra and OpenAI NPC minds]
  G --> S[Superserve tactic rehearsal]
  B <--> O[OpenAI Realtime: The Source]
```

## Run locally

Use Bun. Copy `.env.example` to the ignored `.env` file, then put your server-side configuration and keys in `.env`. In PowerShell, from the repository root:

```powershell
Copy-Item .env.example .env
Set-Location server
bun install
bun run dev
```

In another terminal, from the repository root:

```powershell
$env:ISSEKAIED_BACKEND_URL = "http://127.0.0.1:8791"
Set-Location client
bun install
bun run dev
```

Set `PORT=8791` and `HOST=127.0.0.1` for that local setup. Production containers bind to `0.0.0.0`; the public HTTPS endpoint proxies HTTP and WebSockets to the same backend.

Required runtime configuration includes `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_TTS_MODEL`, `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE`, `SUPABASE_URL`, the Supabase backend secret, `TERSE_ACTOR_URL`, `TERSE_API_KEY`, `RELAY_BASE_URL` and `RELAY_WORKSPACE_KEY`. Tactic rehearsal also uses `SUPERSERVE_API_KEY`, `SUPERSERVE_TEMPLATE` and `SUPERSERVE_REHEARSAL=1`.

Keep management credentials and provider keys out of browser code and `VITE_` variables. The Source endpoint returns only a short-lived Realtime credential. Actor setup is documented in [actor/README.md](actor/README.md); the additive database setup is under `server/supabase/`.

## Verification and limits

The backend passes 43 focused tests, including repeated strikes for every enemy tactic, ranged-hit retaliation, local pursuit boundaries, reconnect sequence resets, rejection of late input from replaced sockets, and bounded strategy writes for a 50-ghost warning. Network checks cover 50 unique enemies, authoritative health-cost powers, stale-input expiry and leaderboard persistence across a restart; the integrated client build passes. OpenAI Realtime connected in the public browser and answered grounded objective questions with streamed audio. Hosted Terse state survived service restart; actual Relay delivery and database RLS/idempotency/search were checked independently. See [the demo notes](docs/DEMO.md) for exact evidence and limits.

Both frontend and backend are live at the demo URL. The VPS deployment script builds immutable releases from `main`, checks the Source routes before activation and preserves the previous release for rollback. See [deployment instructions](deploy/vps/README.md).

A separate 50-client, 15-second synthetic smoke is not a claim of 50 real browser players or production readiness. Guest identity belongs to the browser key, not the display name. The hosted actor service uses Terse's local/dev runtime on Freestyle with demo lifecycle limits. Source deduplication and retained player records are bounded at 5,000; canonical event history remains in Supabase.

Active room positions and quest progress reset when the game API restarts; durable ghost history and recorded events remain in Terse and Supabase. Text questions, controlled spoken input and streamed Source replies passed public acceptance. A physical microphone still needs a human check.

Music credits and optimized-file provenance are in [audio credits](assets/audio/optimized/CREDITS.md). Voices and traditional recitations are synthesized with artificial intelligence; pronunciation and Vedic intonation are not human-certified. [Hanuman](assets/audio/hanuman/PROVENANCE.md), [Shiva](assets/audio/shiva/PROVENANCE.md) and [Maha Mrityunjaya](assets/audio/mantra/PROVENANCE.md) source records are included.

## Repository and license

`client/` contains Babylon.js, audio and the interface; `server/` contains the authoritative game and provider adapters; `actor/` contains durable state; `shared/` defines the map/protocol; `assets/` and `docs/` contain art, music and provenance.

No project-wide code license is currently checked in. Third-party assets retain their included CC0 or CC-BY-4.0 terms. Preserve the notices and attribution when redistributing them.
