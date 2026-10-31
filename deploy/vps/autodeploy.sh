#!/usr/bin/env bash
# Issekaied VPS autodeploy. Modes: --poll (default), --artifact FILE --revision SHA, --check.
# Never edits runtime.env, compose, or containers other than issekaied-api* and an nginx reload of issekaied-web.
set -Eeuo pipefail
umask 022

ROOT=/home/ayush/issekaied
DEPLOY="$ROOT/.deploy"; RELEASES="$ROOT/releases"; CONF="$ROOT/config/nginx.conf"
ENV_FILE="$ROOT/runtime.env"; DATA="$ROOT/api-data"
REPO_URL=git@github.com:ayushozha/Issekaied.git
BUN_IMAGE=oven/bun:1.3.9; NETWORK=coolify; API=issekaied-api; WEB=issekaied-web
DOMAIN=issekaied.ayushojha.com

log() { printf '%s autodeploy: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

MODE=poll; ARTIFACT=""; REV=""
while [ $# -gt 0 ]; do
  case "$1" in
    --poll) MODE=poll ;;
    --check) MODE=check ;;
    --artifact) MODE=artifact; ARTIFACT="${2:?}"; shift ;;
    --revision) REV="${2:?}"; shift ;;
    *) die "unknown argument: $1" ;;
  esac; shift
done

check() {
  local ok=0
  for c in docker git flock curl python3; do command -v "$c" >/dev/null || { log "missing command $c"; ok=1; }; done
  for f in "$DEPLOY/id_ed25519" "$DEPLOY/known_hosts"; do [ -f "$f" ] || { log "missing $f"; ok=1; }; done
  [ -f "$ENV_FILE" ] && [ "$(stat -c %a "$ENV_FILE")" = 600 ] || { log "runtime.env must exist with mode 600"; ok=1; }
  [ -d "$DATA" ] || { log "missing $DATA (owner uid 1000)"; ok=1; }
  [ -d "$(dirname "$CONF")" ] || { log "missing config dir"; ok=1; }
  docker network inspect "$NETWORK" >/dev/null 2>&1 || { log "missing docker network $NETWORK"; ok=1; }
  docker inspect "$WEB" >/dev/null 2>&1 || { log "missing container $WEB"; ok=1; }
  [ $ok = 0 ] && log "check ok" || log "check FAILED"
  return $ok
}

mkdir -p "$DEPLOY" "$RELEASES"
if [ "$MODE" = check ]; then check; exit $?; fi
exec 9>"$DEPLOY/deploy.lock"
flock -n 9 || { log "another deploy holds the lock; skipping"; exit 0; }

CUR_SHA=$(cat "$DEPLOY/current.sha" 2>/dev/null || true)
STAGE=""; cleanup_stage() { [ -n "$STAGE" ] && [ -d "$STAGE" ] && rm -rf -- "$STAGE"; return 0; }
trap cleanup_stage EXIT

# ---------- 1. obtain revision into an immutable release dir ----------
if [ "$MODE" = poll ]; then
  export GIT_SSH_COMMAND="ssh -i $DEPLOY/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$DEPLOY/known_hosts -o ForwardAgent=no -o BatchMode=yes"
  export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1
  REPO="$DEPLOY/repo.git"
  [ -d "$REPO" ] || git init -q --bare "$REPO"
  git --git-dir="$REPO" fetch -q --no-tags --depth=50 "$REPO_URL" +refs/heads/main:refs/heads/main
  REV=$(git --git-dir="$REPO" rev-parse refs/heads/main)
else
  [ -f "$ARTIFACT" ] || die "artifact not found"
fi
[[ "$REV" =~ ^[0-9a-f]{40}$ ]] || die "revision must be a full 40-char lowercase sha"
[ "$REV" = "$CUR_SHA" ] && { log "already at $REV"; exit 0; }
if [ "$MODE" = poll ] && [ "$(cat "$DEPLOY/failed.sha" 2>/dev/null || true)" = "$REV" ]; then
  log "$REV previously failed/incomplete; waiting for a new commit"; exit 0; fi
fail_mark() { [ "$MODE" = poll ] && echo "$REV" > "$DEPLOY/failed.sha"; return 0; }

REL="$RELEASES/$REV"; SHORT=${REV:0:12}
if [ -f "$REL/client/dist/index.html" ]; then
  log "reusing existing release $REV"
else
  [ -e "$REL" ] && die "incomplete release dir $REL exists; inspect manually"
  STAGE=$(mktemp -d "$RELEASES/.stage-$SHORT-XXXX")
  if [ "$MODE" = poll ]; then
    git --git-dir="$REPO" archive --format=tar "$REV" | tar -x -C "$STAGE" --no-same-owner
    for f in deploy/vps/Dockerfile server/package.json server/bun.lock client/package.json client/bun.lock \
             shared/world.json shared/protocol.ts actor/src/source.ts server/src/integrations/source.ts; do
      [ -f "$STAGE/$f" ] || { log "incomplete revision $REV: missing $f; skipping"; fail_mark; exit 0; }
    done
    log "building frontend for $SHORT"
    docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e BUN_INSTALL_CACHE_DIR=/tmp/bun \
      -v "$STAGE:/src" -w /src/client "$BUN_IMAGE" sh -c 'bun install --frozen-lockfile && bun run build' \
      || { fail_mark; die "frontend build failed"; }
    rm -rf -- "$STAGE/client/node_modules"
  else
    python3 -I - "$ARTIFACT" "$STAGE" <<'PY' || die "artifact validation failed"
import os, sys, tarfile
art, stage = sys.argv[1], os.path.realpath(sys.argv[2])
files = {"server/package.json", "server/bun.lock", "deploy/vps/Dockerfile"}
optional = {".dockerignore", "deploy/vps/.dockerignore"}  # allowed exact files, never required
trees = ("server/src/", "server/config/", "shared/", "actor/src/", "client/dist/")
dirs = {"server", "client", "deploy", "deploy/vps", "actor"} | {t.rstrip("/") for t in trees}
bad = {"node_modules", ".git"}
seen = set()
with tarfile.open(art, "r:gz") as t:
    for m in t.getmembers():
        n = m.name[2:] if m.name.startswith("./") else m.name
        n = n.rstrip("/")
        if not n or n == ".": continue
        parts = n.split("/")
        if n.startswith("/") or ".." in parts or "" in parts: sys.exit(f"unsafe path: {n}")
        if not (m.isreg() or m.isdir()): sys.exit(f"not a regular file/dir: {n}")
        if any(p in bad or p.startswith(".env") for p in parts): sys.exit(f"forbidden entry: {n}")
        if n in optional and not m.isreg(): sys.exit(f"optional entry must be a regular file: {n}")
        if not (n in files or n in optional or n in dirs or any((n + "/").startswith(t) for t in trees)):
            sys.exit(f"outside allowed roots: {n}")
        if not os.path.realpath(os.path.join(stage, n)).startswith(stage + os.sep): sys.exit(f"escapes stage: {n}")
        seen.add(n)
need = files | {"client/dist/index.html"}
if need - seen or not any(s.startswith("server/src/") for s in seen): sys.exit(f"missing: {sorted(need - seen)}")
PY
    tar -xzf "$ARTIFACT" -C "$STAGE" --no-same-owner --no-same-permissions
  fi
  chmod -R a+rX "$STAGE"
  mv -T "$STAGE" "$REL"; STAGE=""
fi

# ---------- 2. build API image and start candidate ----------
IMAGE="$API:$REV"; CAND="$API-candidate-$SHORT"
log "building $IMAGE"
docker build -q -f "$REL/deploy/vps/Dockerfile" -t "$IMAGE" "$REL" >/dev/null || { fail_mark; die "api image build failed"; }
docker rm -f "$CAND" >/dev/null 2>&1 || true
docker run -d --name "$CAND" --network "$NETWORK" --env-file "$ENV_FILE" \
  -e HOST=0.0.0.0 -e PORT=8791 -e ISSEKAIED_DATA_DIR=/data -v "$DATA:/data" \
  --memory 1g --cpus 1 --pids-limit 256 --restart unless-stopped "$IMAGE" >/dev/null
CAND_ID=$(docker inspect -f '{{.Id}}' "$CAND")

# Activation gate (documented in README): a partial server cohort (Source files present but
# unwired, or realtime config absent) must never replace the good release. Probes use only
# invalid/unbound requests: they never mint credentials, never reach canonical actors, no WS.
# Prints a single reason code (metadata only) on failure; never prints bodies or env.
API_GATE_JS='
const B = "http://127.0.0.1:8791";
const t = () => AbortSignal.timeout(4000);
const no = (why) => { console.log(why); process.exit(1); };
const r = await fetch(B + "/health", { signal: t() });
if (r.status !== 200) no("health_status_" + r.status);
let j; try { j = await r.json(); } catch { no("health_not_json"); }
if (j?.ok !== true) no("health_not_ok");
if (Array.isArray(j.missingConfig) && j.missingConfig.length) no("missing_config_" + j.missingConfig.length);
if (j.config?.OPENAI_REALTIME_MODEL !== true) no("realtime_model_absent");
if (j.config?.OPENAI_REALTIME_VOICE !== true) no("realtime_voice_absent");
const src = j.integrations?.source;
if (!src) no("source_status_absent");
if (src.memory !== "terse") no("source_memory_not_terse");
const post = (p, body) => fetch(B + p, { method: "POST", signal: t(),
  headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const s = await post("/api/source/session", {});
if (s.status !== 400) no("source_session_probe_" + s.status);
const c = await post("/api/source/context", { playerKey: "not-bound-probe", roomId: "bellgrave" });
if (c.status !== 403) no("source_context_probe_" + c.status);
'
api_healthy() { # $1 container; bounded ~60s (30 x (<=2s sleep + per-request 4s timeouts))
  local i why=unreachable start=$SECONDS
  for i in $(seq 1 30); do
    (( SECONDS - start >= 60 )) && break
    why=$(timeout 15 docker exec "$1" bun -e "$API_GATE_JS" 2>/dev/null | head -c 64) && return 0
    [[ -n "$why" ]] || why=unreachable
    sleep 2
  done
  echo "api gate failed: ${why//[^a-z0-9_]/}" >&2; return 1
}
if ! api_healthy "$CAND"; then
  # Safe metadata only: no logs, Args, Config.Env or State.Error (may carry provider/session secrets).
  docker inspect -f 'candidate state={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}' \
    "$CAND_ID" >&2 2>/dev/null || true
  docker rm -f "$CAND_ID" >/dev/null 2>&1 || true
  fail_mark; die "candidate unhealthy; previous release unchanged"
fi

# ---------- 3. activate: swap containers, nginx config, current symlink ----------
write_nginx() { # $1 sha
  local P='proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
    proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $issekaied_connection;
    proxy_connect_timeout 60s; proxy_read_timeout 60s; proxy_send_timeout 60s;'
  local H='add_header X-Content-Type-Options nosniff always; add_header Referrer-Policy strict-origin-when-cross-origin always;'
  cat <<NGINX
# Generated by deploy/vps/autodeploy.sh for $1 — do not edit by hand.
map \$http_upgrade \$issekaied_connection { default upgrade; '' close; }
server {
  listen 80;
  server_name $DOMAIN;
  server_tokens off;
  charset utf-8;
  gzip on; gzip_vary on; gzip_min_length 1024;
  gzip_types text/css application/javascript application/json image/svg+xml text/plain;
  resolver 127.0.0.11 valid=5s ipv6=off;
  set \$issekaied_api http://$API:8791;
  root /srv/releases/$1/client/dist;
  index index.html;
  $H

  location ~ /\. { return 403; }
  location ~* \.(env|log|sql|sqlite|sqlite3|db|pem|key)$ { return 403; }

  location = /healthz { default_type application/json; add_header Cache-Control "no-store"; $H return 200 '{"ok":true,"status":"online","sha":"$1"}'; }

  location = /health { proxy_pass \$issekaied_api; $P }
  location /api/ { proxy_pass \$issekaied_api; $P }
  location /ws { proxy_pass \$issekaied_api; $P }

  location /assets/ { try_files \$uri =404; add_header Cache-Control "public, max-age=31536000, immutable"; $H }
  location / { try_files \$uri /index.html; add_header Cache-Control "no-cache"; $H }
}
NGINX
}
web_health() {
  local i body
  for i in $(seq 1 15); do
    body=$(docker exec "$WEB" sh -c "curl -fsS -H 'Host: $DOMAIN' http://127.0.0.1/health 2>/dev/null || wget -qO- --header 'Host: $DOMAIN' http://127.0.0.1/health" 2>/dev/null || true)
    printf '%s' "$body" | python3 -I -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("ok") is True else 1)' 2>/dev/null && return 0
    sleep 2
  done; return 1
}

OLD_CONF=""; [ -f "$CONF" ] && { OLD_CONF="$DEPLOY/nginx.conf.previous"; cp -p "$CONF" "$OLD_CONF"; }
OLD_LINK=$(readlink "$ROOT/current" 2>/dev/null || true)
PREV=""; ACTIVATED=0
rollback() {
  [ "$ACTIVATED" = 1 ] && return 0
  log "rolling back activation of $SHORT"
  docker rm -f "$CAND_ID" >/dev/null 2>&1 || true
  if [ -n "$PREV" ]; then docker rename "$PREV" "$API" >/dev/null 2>&1 || true; docker start "$API" >/dev/null 2>&1 || true; fi
  if [ -n "$OLD_CONF" ]; then cp -p "$OLD_CONF" "$CONF"; else rm -f "$CONF"; fi
  if [ -n "$OLD_LINK" ]; then ln -sfn "$OLD_LINK" "$ROOT/.current.tmp" && mv -Tf "$ROOT/.current.tmp" "$ROOT/current"
  else rm -f "$ROOT/current"; fi
  docker exec "$WEB" nginx -t >/dev/null 2>&1 && docker exec "$WEB" nginx -s reload >/dev/null 2>&1 || true
  fail_mark
}
trap 'rollback; cleanup_stage' ERR

if docker inspect "$API" >/dev/null 2>&1; then
  PREV="$API-previous-$(date -u +%Y%m%d%H%M%S)"
  docker rename "$API" "$PREV"
fi
docker rename "$CAND_ID" "$API"
write_nginx "$REV" > "$CONF.tmp" && mv -f "$CONF.tmp" "$CONF"
docker exec "$WEB" nginx -t >/dev/null 2>&1 || { log "nginx -t failed"; false; }
docker exec "$WEB" nginx -s reload >/dev/null
[ -n "$OLD_LINK" ] && ln -sfn "$OLD_LINK" "$ROOT/previous"
ln -sfn "releases/$REV" "$ROOT/.current.tmp" && mv -Tf "$ROOT/.current.tmp" "$ROOT/current"
web_health || { log "public /health through $WEB failed"; false; }

echo "$REV" > "$DEPLOY/current.sha.tmp" && mv -f "$DEPLOY/current.sha.tmp" "$DEPLOY/current.sha"
ACTIVATED=1; trap cleanup_stage ERR
rm -f "$DEPLOY/failed.sha"
[ -n "$PREV" ] && docker stop "$PREV" >/dev/null 2>&1 || true
log "activated $REV${PREV:+ (previous API stopped as $PREV)}"
