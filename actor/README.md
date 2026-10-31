# Issekaied Terse Durable Actors

Persistent ghost memory and deity context for the multiplayer game, implemented by two classes in `src/actor.ts`.

| Actor | ID scheme | Persisted state |
| --- | --- | --- |
| `Ghost` | Enemy ID: `morrow`, `nix`, `vesper`, `raksha` | Banishments, kills, hunter grudges, event-linked episodes, tactic and lore |
| `Source` | `source` globally | arrivals, deaths, banishments, per-player statistics and recent canonical facts |
| `Deity` | `ganesha.<roomId>` and `hanuman.<roomId>` per room; `shiva` and `vishnu` globally across rooms/games | Invocations, banishments, hunters, rooms and recent event IDs |

Actor IDs must contain only ASCII letters, digits, `.`, `_` or `-`; they must not be `.` or `..`. Colons are rejected by the SDK and runtime. Keep room IDs within that character set.

Each actor reassigns one `@Persisted` state field through the pure reducers in `src/memory.ts`. Actor methods do not wait for network services; OpenAI, Relay and Supabase work stays outside the actor mailbox. The server may reuse the reducers for an explicitly labeled local-file fallback; that fallback is separate from the Terse runtime.

## Local runtime

The actor engine requires **Bun 1.4.2 or newer**. From this directory:

```sh
bun install --frozen-lockfile
bunx terse-cli@0.14.9 actor dev --port 7100 --project-id local
```

This runs the official local/dev runtime on `127.0.0.1:7100` without a managed Terse account, login or global CLI installation. A generated client is not required: the game server uses `terse-sdk/actors` stubs.

Configure these values through the process environment or an ignored local `.env` before starting it:

| Variable | Purpose |
| --- | --- |
| `TERSE_ACTOR_SECRET` | Random shared secret required by the actor runtime |
| `DURABLE_ACTORS_DATA_DIR` | Absolute persistent data directory; keep the same directory across restarts |

The game server uses:

```dotenv
TERSE_ACTOR_URL=http://127.0.0.1:7100/v1/projects/local/actors
TERSE_API_KEY=<the same value as TERSE_ACTOR_SECRET>
```

The SDK sends `Authorization: Bearer <TERSE_API_KEY>`. Keep both secrets on server processes, out of the browser, source and logs. The upstream CLI includes its secret in ready banners, so redact its output before capturing or hosting it. Never publish raw startup logs.

Without an explicit data directory, local state uses `.durable-actors/`, which is ignored. This is a development runtime with local persistence; managed hosting, backups and replication are separate concerns.

## Verification

```sh
bun test
bun run typecheck
```

The four reducer tests cover hunter-specific grudges, repeated-event deduplication, event-linked recall, bounded histories/tactics and deity context across rooms. They also run on Windows Bun 1.3.9; that does not establish actor-engine compatibility on that version. Real runtime/RPC and restart checks are separate from these unit tests.

Repeated banishments, kills and invocation events are deduplicated. Lore appends are not idempotent, so callers must avoid delivering the same lore entry twice.
