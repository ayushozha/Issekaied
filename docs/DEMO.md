# Demo verification

The public URL is https://issekaied.ayushojha.com. The upgraded frontend and backend are live over HTTPS. This document separates isolated checks from public gameplay evidence.

## Checked

- Server TypeScript check and 28 tests passed.
- Actor reducer tests passed; Source actor/module focused checks passed.
- Provider-free two-client quest: 36/36 checks, safe gate through three sigils, boss and same-courtyard echo.
- Browser: 30.5 seconds safe idle, deliberate movement and mouse actions, shrine, blur/inactivity, explicit death/respawn and teardown.
- Real Terse on Freestyle: authenticated SDK calls, state after restart and duplicate protection; Source tested with unique probe IDs only.
- Supabase: RLS, backend writes, idempotent events, lore search, and quest/portal CHECK migration.
- Real Relay: separate pantheon/hivemind delivery; official private self-host fallback also passed 4/4 messages.
- OpenAI Realtime browser acceptance: ephemeral credential, upstream SDP 201, connected peer/data channel, audible response packets and three grounded `get_game_state` calls. Text directions correctly described the current three-sigil objective. Stop/mute and denied-microphone fallback were checked; human microphone speech recognition remains unverified.
- Public HTTPS, WebSocket upgrade, mounted Source routes and backend-only credential boundaries passed. Requests for `.env` and `.git/config` return 403.
- Public process counters at 22:07 UTC: 175 Supabase writes, 82 Terse calls, 10 game Relay messages sent, 14 Mastra/OpenAI responses, 14 NPC voice responses and five Superserve jobs created and cleaned up. These are observed counters, not billing receipts. One Terse request used fallback; actor reachability had recovered at capture.

## Public gameplay evidence

- Initial public browser: approved splash artwork, successful server connection and no page errors.
- Public combat: normal mouse aim, sprint, discrete primary attacks and Ganesha invocation banished Morrow as "Ayush Demo". The server recorded that hunter in Morrow's memory; the player retained 92 HP. No development teleport or state changes were used.
- Remembered return: Morrow addressed "Ayush Demo" and recalled the Ganesha banishment and its earlier defeat of that player. Other NPC dialogue reacted to the same banishment.
- Public Source: connected WebRTC peer, active remote audio stream and a fresh `get_game_state` call produced spoken directions grounded in the current safe-gate/sigil objective. Text questions passed. A controlled 3.8-second spoken fixture also produced upstream speech-start/stop/commit events, a game-state lookup and a spoken reply; its track disabled immediately on release. No ambient microphone was recorded. A physical microphone still needs a human check.
- Both frontend and backend were built from complete `main` and automatically activated at 22:10 UTC. The minute timer subsequently checked the same revision successfully; HTTPS, WebSocket upgrade, Source authorization probes and provider modes passed after activation.

The complete boss/echo route passed the isolated network progression check; a full public-browser completion has not been claimed.

The synthetic capacity and isolated progression checks do not prove 50 real browsers or production readiness.

Freestyle hosts the Terse actor runtime rather than the main VPS game server. Its credit balance and the other sponsors' billing dashboards have not been verified. Superserve runs disposable encounter-scoring jobs; it is not the map renderer. Deployment details and rollback are in [the VPS guide](../deploy/vps/README.md).
