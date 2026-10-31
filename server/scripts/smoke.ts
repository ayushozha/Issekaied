/**
 * Synthetic multi-client smoke/capacity check against a running server.
 *
 *   bun scripts/smoke.ts --url ws://localhost:8787/ws --clients 50 --seconds 15
 *
 * Each client joins bellgrave with its own guest key, walks a wandering path at the tick rate, and
 * casts whenever its cooldown allows. Prints join/snapshot/event counts, bytes received, and the
 * server's /health loop metrics afterwards. This is a synthetic load, not a browser test.
 */
import type { ServerMessage } from '../../shared/protocol';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const url = arg('url', 'ws://localhost:8787/ws');
const clients = Number(arg('clients', '10'));
const seconds = Number(arg('seconds', '10'));
const health = url.replace(/^ws/, 'http').replace(/\/ws$/, '/health');

interface Stat { welcome: boolean; snapshots: number; events: number; errors: string[]; bytes: number; lastPlayers: number; closed?: string }
const stats: Stat[] = [];
const sockets: WebSocket[] = [];

for (let i = 0; i < clients; i++) {
  const s: Stat = { welcome: false, snapshots: 0, events: 0, errors: [], bytes: 0, lastPlayers: 0 };
  stats.push(s);
  const ws = new WebSocket(url);
  sockets.push(ws);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', v: 1, roomId: 'bellgrave', name: `Smoke${i}`, playerKey: `smoke-${i}-${crypto.randomUUID()}` }));
  ws.onmessage = (e) => {
    const raw = String(e.data);
    s.bytes += raw.length;
    const msg = JSON.parse(raw) as ServerMessage;
    if (msg.type === 'welcome') s.welcome = true;
    else if (msg.type === 'snapshot') {
      s.snapshots += 1;
      s.lastPlayers = msg.snapshot.players.length;
    } else if (msg.type === 'event') s.events += 1;
    else if (msg.type === 'error') s.errors.push(msg.code);
  };
  ws.onclose = (e) => (s.closed = `${e.code} ${e.reason}`);
  await Bun.sleep(15); // stagger connects a little, like real players arriving
}

let seq = 0;
const start = Date.now();
const timer = setInterval(() => {
  seq += 1;
  const t = (Date.now() - start) / 1000;
  sockets.forEach((ws, i) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const yaw = t * 0.3 + i;
    ws.send(JSON.stringify({ type: 'input', v: 1, seq, moveX: Math.sin(yaw), moveZ: Math.cos(yaw), yaw, pitch: 0, sprint: i % 3 === 0 }));
    if (seq % 45 === i % 45) ws.send(JSON.stringify({ type: 'cast', v: 1, seq: ++seq, aim: [Math.sin(yaw), 0, Math.cos(yaw)] }));
  });
}, 50);

await Bun.sleep(seconds * 1000);
clearInterval(timer);
for (const ws of sockets) ws.close();
await Bun.sleep(300);

const joined = stats.filter((s) => s.welcome).length;
const snapshots = stats.reduce((a, s) => a + s.snapshots, 0);
const events = stats.reduce((a, s) => a + s.events, 0);
const bytes = stats.reduce((a, s) => a + s.bytes, 0);
const errors = stats.flatMap((s) => s.errors);
const seenPlayers = Math.max(...stats.map((s) => s.lastPlayers));
console.log(JSON.stringify({ url, clients, seconds, joined, snapshotsPerClient: Math.round(snapshots / Math.max(1, joined)), events, mbReceived: Math.round((bytes / 1e6) * 100) / 100, maxPlayersInSnapshot: seenPlayers, errors: [...new Set(errors)], closes: [...new Set(stats.map((s) => s.closed).filter(Boolean))] }, null, 2));
try {
  const h = (await (await fetch(health)).json()) as { loop: unknown; rooms: unknown };
  console.log('server loop:', JSON.stringify(h.loop));
  console.log('rooms:', JSON.stringify(h.rooms));
} catch (err) {
  console.log('health unavailable:', (err as Error).message);
}
