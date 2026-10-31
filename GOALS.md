# Issekaied gameplay requirements

Latest user requirements, October 31, 2026. These are acceptance goals, not claims that integrations already work.

## Game

First-person haunted-world action. Enemy encounter level automatically determines which divine power the hunter draws from Ganesha, Hanuman, Shiva or Vishnu. Deities provide aid; there is no deity or power selection screen. Initial target is a first playable, with approximately 50 simultaneous players as a separate measured target.

## Persistent minds, voices and world history

- Each NPC has its own persona, goals, voice profile and memory. OpenAI powers NPC dialogue/decisions and distinct speech, with models and voices selected through deployment configuration.
- Defeated ghosts retain their identity, the identity of the hunter who banished them, relevant tactics and encounter history. Those facts generate grounded lore and changed behavior when the ghost meets that hunter again.
- Terse Durable Actors retain ghost/player grudges, encounter summaries and persistent deity state across sessions and games.
- Shiva and Vishnu explicitly share multiverse context across all game rooms. New hunters enter a world whose earlier events are remembered. Other gods can share pantheon context through Agent Relay.
- Agent Relay carries real messages between gods and a separate enemy hivemind for ghosts, ghouls, goblins, orcs, beasts and rakshasas. Warnings must affect subsequent behavior rather than appearing as decorative text.
- Supabase stores stable player identity, authoritative event history and searchable world lore. Anonymous identity is scoped to its actual session/account lifecycle; names alone do not establish identity.
- Keep complete canonical gameplay-event history outside prompts. Retrieve relevant episodes and bounded summaries for each response, with event IDs supporting remembered facts. Movement packets are not narrative events.

## Meaningful provider roles

| Service | Intended runtime responsibility | Proof required |
| --- | --- | --- |
| OpenAI | Individual NPC minds and distinct voices | A grounded NPC response and audible speech from configured models |
| Terse Durable Actors | Persistent ghosts and deity context | Memory survives process restart/reconnect and appears in another room |
| Agent Relay | Pantheon coordination and enemy warnings | A delivered message changes a recipient's reaction or strategy |
| Mastra | Event-triggered agent/tool orchestration | A real agent invocation produces a validated gameplay response |
| Supabase | Identity, canonical event log and lore retrieval | Events persist once, player identity is bound correctly, and prior lore is retrieved |
| Freestyle | Actor/agent service hosting alongside the VPS game | The allocated VM runs a real game-related service |
| Superserve | Isolated ghost-tactic rehearsal jobs | A real sandbox replay scores allowed tactics and informs a returning enemy |

Superserve's proposed role follows its documented microVM/command-execution product; it is not being treated as an inference or voice provider. This rehearsal remains outside the real-time simulation. The authoritative game validates all returned strategies.

## Boundaries and milestones

- Core movement/combat never waits on LLM, speech, database or sandbox network requests.
- Generated lore may embellish fiction, but remembered kills, warnings and player history must come from recorded game events.
- Credentials stay server-side. Supabase management PATs are separate from runtime project keys.
- Report missing configuration, offline fallback, synthetic capacity tests and unverified integrations explicitly.
- Notify the user when project setup, basic screen, assets and first map are actually reviewable.
- Use the ayushozha GitHub account. Push checked checkpoints and merge them into main through the repository's gates, leaving no PRs open. The coordinator owns publication.

## Hosting and audio additions

- The primary public game target is `https://issekaied.ayushojha.com`, on the existing `ayush-vps` connection. Preserve other hosted apps. Report DNS, TLS, preview and authoritative-backend status separately.
- Use the nine downloaded, attributed music tracks. Preserve original files and serve optimized browser copies with meaningful music/voice/effects controls. Avoid downloading every track before play.
- Include our own recitations of verified traditional Hanuman Chalisa, Shiva Tandava Stotram and Maha Mrityunjaya texts, with provenance and AI-voice disclosure. Do not redistribute an unlicensed commercial rendition.
- Hanuman Chalisa accompanies Hanuman's automatic combat invocation, Shiva Tandava accompanies Shiva's invocation, and Maha Mrityunjaya supplies a protection/healing cue. These are requested mechanics pending implementation and runtime verification.
- NPC introductions are separate fixed fictional assets; they are not evidence of dynamic memory or live AI dialogue.

## Frozen presentation scope - one Bellgrave adventure

The courtyard and chapel approach are the single presentation map. Safe gate -> Morrow, Nix and Vesper encounters -> Raksha boss altar -> one echo trial at the courtyard portal. Reuse this same map; no second floor or new world.

- Deliberate WASD movement only; stop input on blur, menu or defeat. No automatic respawn loop or auto-attacking.
- LMB primary attack, RMB ward/charged action, Q automatic level-based incantation, R recovery mantra, E shrine/portal/respawn interaction, Escape pause. No deity picker.
- Three sigils unlock the boss; enemies patrol locally, aggro within their encounter area and leash back. Gate spawn is safe.
- No full-screen damage/invocation flashes. Restrained effects and readable non-glowing nameplates, with reduced motion/flashes enabled by default.
- Match the generated ghosts with transparent art impostors in the 3D world and use the generated title backdrop. These are 2D game sprites, not claimed rigged 3D characters.
- Terse persistent ghost memory is the central demonstration: recorded defeat, named recall, changed return tactics and memory surviving service restart. Relay warns peers; global Shiva/Vishnu actors remember prior hunters.
- Superserve validates a bounded tactics/encounter variation for the same-map echo portal; Freestyle hosts actual Terse actors. Network services stay outside the real-time tick.
