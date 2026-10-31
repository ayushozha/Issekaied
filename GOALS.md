# Issekaied gameplay requirements

Latest user requirements, October 31, 2026. These are acceptance goals, not claims that integrations already work.

## Game

First-person haunted-world action. Enemy encounter level automatically determines which divine power the hunter draws from Ganesha, Hanuman, Shiva or Vishnu. Deities provide aid; there is no deity or power selection screen. Initial target is a first playable, with approximately50 simultaneous players as a separate measured target.

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
| Freestyle | Public app/backend and agent hosting | The actual game endpoint runs on the allocated VM |
| Superserve | Isolated ghost-tactic rehearsal jobs | A real sandbox replay scores allowed tactics and informs a returning enemy |

Superserve's proposed role follows its documented microVM/command-execution product; it is not being treated as an inference or voice provider. This rehearsal remains outside the real-time simulation. The authoritative game validates all returned strategies.

## Boundaries and milestones

- Core movement/combat never waits on LLM, speech, database or sandbox network requests.
- Generated lore may embellish fiction, but remembered kills, warnings and player history must come from recorded game events.
- Credentials stay server-side. Supabase management PATs are separate from runtime project keys.
- Report missing configuration, offline fallback, synthetic capacity tests and unverified integrations explicitly.
- Notify the user when project setup, basic screen, assets and first map are actually reviewable.
- Use the ayushozha GitHub account. Push checked checkpoints and merge them into main through the repository's gates, leaving no PRs open. The coordinator owns publication.
