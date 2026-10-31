/**
 * One scripted hunter against a running server: walk toward Morrow, let the server choose the power,
 * banish him, watch the whisper (and fetch its speech if the server advertised audio), then wait for
 * the return. Exercises whatever providers the server has configured and prints /health counters.
 *
 *   bun scripts/live-check.ts --url ws://localhost:8787/ws
 */
import type { EnemyState, GameEvent, PlayerState, ServerMessage, Vec3 } from '../../shared/protocol';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const url = arg('url', 'ws://localhost:8787/ws');
const http = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
const target = arg('target', 'morrow');

let self: PlayerState | null = null;
let enemy: EnemyState | null = null;
let selfId = '';
let seq = 0;
const events: (GameEvent & { audioUrl?: string })[] = [];
const log = (line: string) => console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s ${line}`);
const started = Date.now();

const ws = new WebSocket(url);
ws.onopen = () => ws.send(JSON.stringify({ type: 'join', v: 1, roomId: 'bellgrave', name: 'LiveCheck', playerKey: `live-${crypto.randomUUID()}` }));
ws.onmessage = (e) => {
  const msg = JSON.parse(String(e.data)) as ServerMessage;
  if (msg.type === 'welcome') {
    selfId = msg.selfId;
    log(`welcome selfId=${selfId} tick=${msg.tickRate}Hz snapshots=${msg.snapshotRate}Hz enemies=${msg.snapshot.enemies.map((x) => `${x.id}:L${x.level}`).join(',')}`);
  } else if (msg.type === 'snapshot') {
    self = msg.snapshot.players.find((p) => p.id === selfId) ?? null;
    enemy = msg.snapshot.enemies.find((x) => x.id === target) ?? null;
  } else if (msg.type === 'event') {
    events.push(msg);
    if (msg.kind !== 'hit' || msg.toId === selfId) log(`event ${msg.kind} from=${msg.fromId}${msg.toId ? ` to=${msg.toId}` : ''}${msg.power ? ` power=${msg.power}` : ''}${msg.text ? ` "${msg.text}"` : ''}${msg.audioUrl ? ` audio=${msg.audioUrl}` : ''}`);
  } else if (msg.type === 'error') log(`error ${msg.code}: ${msg.message}`);
};
ws.onclose = (e) => log(`socket closed ${e.code} ${e.reason}`);

const send = (m: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
const toEnemy = (): { dist: number; aim: Vec3; dir: { x: number; z: number } } | null => {
  if (!self || !enemy) return null;
  const dx = enemy.position[0] - self.position[0];
  const dy = enemy.position[1] - self.position[1];
  const dz = enemy.position[2] - self.position[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  const flat = Math.hypot(dx, dz) || 1;
  return { dist: flat, aim: [dx / len, dy / len, dz / len], dir: { x: dx / flat, z: dz / flat } };
};

const until = async (pred: () => boolean, timeoutMs: number, what: string) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await Bun.sleep(50);
  }
  log(`timeout waiting for ${what}`);
  return false;
};

await until(() => !!self && !!enemy, 5000, 'welcome + snapshot');

// Walk toward the haunt at the tick rate until it is within 5 m; the server owns the actual movement.
const walker = setInterval(() => {
  const v = toEnemy();
  if (!v) return;
  const moving = v.dist > 5;
  send({ type: 'input', v: 1, seq: ++seq, moveX: moving ? v.dir.x : 0, moveZ: moving ? v.dir.z : 0, yaw: Math.atan2(v.dir.x, v.dir.z), pitch: 0, sprint: true });
}, 50);
await until(() => (toEnemy()?.dist ?? 99) <= 5.5, 30_000, 'closing to 5 m');
log(`in range: ${target} at ${toEnemy()?.dist.toFixed(2)} m, hp=${enemy?.hp}/${enemy?.maxHp}, my hp=${self?.hp}`);

// Cast whenever the server will accept it, until the haunt is banished.
let lastCast = 0;
const caster = setInterval(() => {
  const v = toEnemy();
  if (!v || !self || enemy?.state !== 'hunting' || Date.now() - lastCast < 300) return;
  send({ type: 'cast', v: 1, seq: ++seq, aim: v.aim });
  lastCast = Date.now();
}, 100);
const banished = await until(() => events.some((e) => e.kind === 'banish' && e.toId === target), 60_000, 'banish');
clearInterval(caster);
if (banished) {
  const whisper = await until(() => events.some((e) => e.kind === 'whisper' && e.fromId === target), 15_000, 'whisper from the banished haunt');
  const w = events.find((e) => e.kind === 'whisper' && e.fromId === target);
  if (whisper && w?.audioUrl) {
    const t0 = Date.now();
    const res = await fetch(`${http}${w.audioUrl}`);
    const bytes = res.ok ? (await res.arrayBuffer()).byteLength : 0;
    log(`audio ${w.audioUrl}: http ${res.status} ${res.headers.get('content-type') ?? ''} ${bytes} bytes after ${Date.now() - t0} ms`);
  }
  await until(() => events.some((e) => e.kind === 'return' && e.fromId === target), 20_000, 'return');
  await Bun.sleep(2500); // let the return whisper arrive
}
clearInterval(walker);
ws.close();
await Bun.sleep(300);

try {
  const h = (await (await fetch(`${http}/health`)).json()) as Record<string, unknown>;
  const integrations = h.integrations as Record<string, Record<string, unknown>>;
  for (const [k, v] of Object.entries(integrations)) log(`health ${k}: ${JSON.stringify(v)}`);
  log(`health director: ${JSON.stringify(h.director)}`);
  log(`health loop: ${JSON.stringify(h.loop)}`);
  const lore = await (await fetch(`${http}/api/lore?q=${target}`)).json();
  log(`lore search "${target}": ${JSON.stringify(lore).slice(0, 400)}`);
} catch (err) {
  log(`health unavailable: ${(err as Error).message}`);
}
log(`events seen: ${events.length}, unique ids: ${new Set(events.map((e) => e.eventId)).size}`);
