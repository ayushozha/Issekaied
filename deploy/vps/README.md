# Issekaied VPS autodeploy

`autodeploy.sh` deploys an immutable revision of Issekaied on the VPS. It handles two cases: polling `main` on GitHub, or taking a frozen release artifact. It never edits `runtime.env`, the compose file, Traefik/TLS labels, or any container other than `issekaied-api*`. The only thing it does to `issekaied-web` is an nginx reload.

## Layout (fixed root `/home/ayush/issekaied`)

| Path | Owner | Purpose |
|---|---|---|
| `.deploy/id_ed25519`, `.deploy/known_hosts` | coordinator | read-only, repo-only deploy key and GitHub's official host keys |
| `.deploy/repo.git` | script | bare mirror of `main` only |
| `.deploy/deploy.lock` | script | `flock` so only one deploy runs at a time |
| `.deploy/current.sha` | script | last revision that deployed successfully (written only after success) |
| `.deploy/enabled` | coordinator | presence enables the installed minute cron; remove it to pause polling |
| `.deploy/failed.sha` | script | the last failed or incomplete revision; polling skips it until `main` moves |
| `releases/<sha>/` | script | immutable release (`client/dist` plus backend sources) |
| `current`, `previous` | script | symlinks to `releases/<sha>` |
| `config/nginx.conf` | script | site config; this directory is mounted at `/etc/nginx/conf.d` in `issekaied-web` |
| `runtime.env` (mode 600) | coordinator | provider keys and Relay fields; the script passes it via `--env-file` and never reads its contents |
| `api-data/` (uid 1000) | coordinator | persistent `/data` |

`issekaied-web` has to mount `releases/` read-only at `/srv/releases` and share the `coolify` network.

## Runtime allowlist

The API container gets `--env-file runtime.env`, `HOST=0.0.0.0`, `PORT=8791`, `ISSEKAIED_DATA_DIR=/data`, and the volume `api-data:/data`. It runs on the `coolify` network with no host ports, `--memory 1g --cpus 1 --pids-limit 256 --restart unless-stopped`, as the image's `bun` user. Nginx proxies `/ws`, `/api/` and `/health` to `issekaied-api:8791` without rewriting the path, using the Docker DNS resolver and a variable upstream. `/healthz` returns `{"ok":true,"status":"online","sha":…}` locally. Dotfiles and `env/log/sql/sqlite/db/pem/key` files return 403.

Provider fields are decoded before writing Docker `runtime.env`: OpenAI API key and chat/TTS/Realtime model and voice settings; Supabase URL plus backend secret/service-role key; Terse URL/key; Relay workspace key/base URL; Superserve key/rehearsal/template. Keep dotenv quote delimiters out of Docker values. Never include Hostinger, GitHub/Supabase PATs, database passwords, Freestyle control keys, or SSH private keys.

## Commands

```bash
deploy/vps/autodeploy.sh --check                       # prerequisites only
deploy/vps/autodeploy.sh                               # --poll: fetch main, build, activate if changed
deploy/vps/autodeploy.sh --artifact /path/release.tgz --revision <40-char sha>
```

Poll revisions are Git commit SHAs. A manual frozen artifact may instead use its SHA256 prefix as a 40-character content identifier; do not describe that content ID as a Git commit.

The artifact must be a gzip tar containing only these root paths, with no outer folder: `server/package.json`, `server/bun.lock`, `server/src/`, `server/config/`, `shared/`, `actor/src/`, `client/dist/` (which must contain `index.html`), and `deploy/vps/Dockerfile`. Before extracting, Python rejects any absolute path, `..`, link, special file, `.env*`, `node_modules`, `.git`, or path that escapes the stage. The frontend build is skipped for artifacts.

In poll mode, the script runs `git archive` on the exact `main` head and requires these files: the Dockerfile, the server and client package files and lockfiles, `shared/world.json`, `shared/protocol.ts`, `actor/src/source.ts`, and `server/src/integrations/source.ts`. It then builds `client` in `oven/bun:1.3.9` as the host uid:gid with `bun install --frozen-lockfile && bun run build`.

## Flow

1. Stage the release, then build the image `issekaied-api:<sha>` from `deploy/vps/Dockerfile`.
2. Start `issekaied-api-candidate-<sha12>` and require it to pass the **Source activation gate** (below) within 60s. If it fails, only that candidate is removed; the live release, `current.sha`, nginx config and symlinks are untouched, and the revision is recorded in `failed.sha`.
3. Rename the old `issekaied-api` to `issekaied-api-previous-<ts>`, leaving it running, and rename the candidate to `issekaied-api`. Then write `nginx.conf`, run `nginx -t`, reload, and swap the `current` symlink.
4. Check `/health` through `issekaied-web`. On success, the script writes `current.sha` and stops the previous API container without removing it.
   On any failure it restores the old container name, the old config and the old symlink, then reloads nginx.

## Source activation gate (candidate only)

The candidate must pass all of these. Each one runs inside the container as `bun -e` with Bun's native `fetch` against `127.0.0.1:8791`. Every request times out after 4s, each attempt is capped at 15s, and the gate retries every 2s for up to 60s in total. This stops `main` from replacing a good release with a partial server cohort, such as one where the Source files exist but are not wired in:

1. `GET /health` returns HTTP 200, and the JSON has `ok === true`.
2. If `missingConfig` is an array, it is empty.
3. `config.OPENAI_REALTIME_MODEL === true` and `config.OPENAI_REALTIME_VOICE === true`. These are presence booleans only, and the gate contains no model IDs.
4. `integrations.source` is present, and `integrations.source.memory === "terse"`. This reports the configured Terse Source backend; the gate itself avoids canonical actor calls.
5. `POST /api/source/session` with body `{}` returns **400** (`bad_request`). This proves the route is mounted. It never mints a client secret.
6. `POST /api/source/context` with body `{"playerKey":"not-bound-probe","roomId":"bellgrave"}` returns **403** (`not_in_room`). This proves player binding is enforced. Because nobody is bound, the server never calls the canonical Source actor.

No WebSocket join happens. On failure, the script prints a single sanitized reason code to stderr (for example `api gate failed: realtime_voice_absent` or `source_context_probe_200`), plus the safe `docker inspect` state line. It never prints response bodies, logs or env. After activation, the post-swap check through `issekaied-web` still only requires `/health` 200 with `ok:true`. Rollback, the auth/deploy-key controls and artifact archive validation are unchanged.

## Cron (the coordinator installs this)

```cron
* * * * * test -f /home/ayush/issekaied/.deploy/enabled && /home/ayush/issekaied/.deploy/autodeploy.sh --poll >> /home/ayush/issekaied/.deploy/autodeploy.log 2>&1 # issekaied-main-autodeploy
```

The coordinator installs the trusted script at `.deploy/autodeploy.sh`. Enable the timer only after the public release is verified and complete `main` is published: `touch /home/ayush/issekaied/.deploy/enabled`. Remove that file to pause; other cron jobs are preserved.

## Rollback and limits

- **Manual rollback:** run `--artifact` again with an older release, or `docker start` the stopped `issekaied-api-previous-*` container and restore `.deploy/nginx.conf.previous`.
- **No automatic pruning:** old releases, images and stopped previous containers accumulate until you clean them up.
- **Data is never rolled back:** `api-data` is shared across releases, so an incompatible data change cannot be reverted by switching releases.
- **Brief overlap during the swap:** two API containers run during activation, and websocket clients reconnect after the nginx reload.
- **Validation:** macOS/Linux `bash -n`, VPS `--check`, forbidden `.env` archive rejection, private API health, public HTTPS/WSS, protected-path 403s, and Source binding checks passed. The final Source activation gate also passed against the live VPS API. The initial rollout used a frozen content artifact; a complete Git-main polling build is verified separately. GNU `timeout` is available on this VPS.
- **Partial-main guard:** the deployed API already reports both Realtime config flags and `integrations.source`. A future candidate missing those fields or the Source binding routes is rejected, preserving the working release.
