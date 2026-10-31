/**
 * Two real WebSocket clients against a running Phase 2 server (use the provider-free fixture):
 *   DISABLE_BOOST=1 bun --env-file=/absolute/path/to/fixture.env server/src/index.ts
 *   bun server/scripts/adventure-check.ts --url ws://127.0.0.1:8791/ws --room phase2-probe
 *
 * Bram stays at the safe gate sending deliberate zero-movement input and must never move or be hit.
 * Ayla verifies cooldown spam rejection, LMB/RMB/Q/R, the gated boss, local aggro + leash, earns the
 * three sigils, banishes the boss, steps through the echo portal, and prints the memory identities.
 * Every check prints PASS/FAIL; the process exits non-zero on any FAIL.
 */
import type { AdventureState, EnemyState, GameEvent, PlayerState, ServerMessage, Vec3 } from '../../shared/protocol';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const url = arg('url', 'ws://127.0.0.1:8791/ws');
const roomId = arg('room', 'phase2-probe');
const http = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
const started = Date.now();
const log = (line: string) => console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s ${line}`);
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};

class Hunter {
  selfId = '';
  seq = 0;
  self: PlayerState | null = null;
  enemies: EnemyState[] = [];
  adventure: AdventureState | undefined;
  readonly events: GameEvent[] = [];
  readonly ws: WebSocket;
  constructor(readonly name: string, readonly key: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (e) => this.receive(JSON.parse(String(e.data)) as ServerMessage);
  }
  private receive(msg: ServerMessage) {
    if (msg.type === 'welcome') {
      this.selfId = msg.selfId;
      this.apply(msg.snapshot);
    } else if (msg.type === 'snapshot') this.apply(msg.snapshot);
    else if (msg.type === 'event') this.events.push(msg);
    else if (msg.type === 'error') log(`${this.name} error ${msg.code}: ${msg.message}`);
  }
  private apply(s: { players: PlayerState[]; enemies: EnemyState[]; adventure?: AdventureState }) {
    this.self = s.players.find((p) => p.id === this.selfId) ?? null;
    this.enemies = s.enemies;
    this.adventure = s.adventure;
  }
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => {
        this.ws.send(JSON.stringify({ type: 'join', v: 1, roomId, name: this.name, playerKey: this.key }));
        resolve();
      };
      this.ws.onerror = () => reject(new Error('socket error'));
    });
  }
  send(msg: Record<string, unknown>) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ ...msg, seq: ++this.seq }));
  }
  input(moveX = 0, moveZ = 0, sprint = false, yaw = 0, active?: boolean) {
    this.send({ type: 'input', v: 1, moveX, moveZ, yaw, pitch: 0, sprint, ...(active === undefined ? {} : { active }) });
  }
  cast(action: 'primary' | 'secondary' | 'incantation' | 'heal', aim: Vec3 = [0, 0, 1]) {
    this.send({ type: 'cast', v: 1, aim, action });
  }
  interact(target: 'shrine' | 'portal' | 'respawn') {
    this.send({ type: 'interact', v: 1, target });
  }
  enemy(id: string) {
    return this.enemies.find((e) => e.id === id);
  }
  pos(): Vec3 | null {
    return this.self?.position ?? null;
  }
  dist(to: Vec3): number {
    const p = this.pos();
    return p ? Math.hypot(to[0] - p[0], to[2] - p[2]) : Infinity;
  }
  aimAt(to: Vec3): Vec3 {
    const p = this.pos() ?? [0, 1.7, 0];
    const d: Vec3 = [to[0] - p[0], to[1] - p[1], to[2] - p[2]];
    const l = Math.hypot(...d) || 1;
    return [d[0] / l, d[1] / l, d[2] / l];
  }
  count(kind: GameEvent['kind'], pred: (e: GameEvent) => boolean = () => true) {
    return this.events.filter((e) => e.kind === kind && pred(e)).length;
  }
}

const until = async (pred: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await Bun.sleep(50);
  }
  return false;
};

const health = async () => (await fetch(`${http}/health`)).json() as Promise<Record<string, unknown>>;

// ---- setup -------------------------------------------------------------------------------------

const h = await health();
const configFlags = h.config as Record<string, boolean>;
const providersOff = Object.entries(configFlags).every(([, v]) => v === false);
check('fixture: every provider flag in /health.config is false', providersOff, JSON.stringify(configFlags));
if (!providersOff) {
  console.error('refusing to run scripted progression against live providers');
  process.exit(2);
}
const ayla = new Hunter('Ayla', `check-ayla-${crypto.randomUUID()}`);
const bram = new Hunter('Bram', `check-bram-${crypto.randomUUID()}`);
await Promise.all([ayla.open(), bram.open()]);
check('both hunters joined', await until(() => !!ayla.self && !!bram.self, 5000), `${ayla.selfId} / ${bram.selfId}`);
const bramStart = bram.pos()!;

// Bram: deliberate presence at the gate, no movement, forever.
const bramLoop = setInterval(() => bram.input(), 50);

// Ayla: a controllable movement loop; `goal` null means stand still.
let goal: Vec3 | null = null;
let sprint = true;
const aylaLoop = setInterval(() => {
  const p = ayla.pos();
  if (!p || !goal || ayla.dist(goal) < 0.4) return ayla.input();
  const dx = goal[0] - p[0];
  const dz = goal[2] - p[2];
  const l = Math.hypot(dx, dz) || 1;
  ayla.input(dx / l, dz / l, sprint, Math.atan2(dx, dz));
}, 50);
const walkTo = async (to: Vec3, within = 1.5, timeoutMs = 30_000) => {
  goal = to;
  const ok = await until(() => ayla.dist(to) <= within, timeoutMs);
  goal = null;
  return ok;
};

// ---- 1. idle + cooldown spam + explicit actions at the safe gate -------------------------------

await Bun.sleep(3000);
check('idle hunters at the gate are not moved', ayla.dist(ayla.pos()!) === 0 && bram.dist(bramStart) < 0.01, `bram moved ${bram.dist(bramStart).toFixed(3)} m`);
check('idle hunters at the gate are not attacked', ayla.self!.hp === 100 && bram.self!.hp === 100 && bram.count('hit', (e) => e.toId === bram.selfId) === 0);
check('no haunt has aggro while hunters stay at the gate', ayla.enemies.every((e) => !e.aggro), ayla.enemies.map((e) => `${e.id}:${e.aggro}`).join(','));

const castsBefore = ayla.count('cast', (e) => e.fromId === ayla.selfId);
for (let i = 0; i < 6; i++) ayla.cast('primary');
await Bun.sleep(400);
check('primary spam inside the cooldown yields exactly one cast', ayla.count('cast', (e) => e.fromId === ayla.selfId) - castsBefore === 1);
ayla.cast('secondary');
await Bun.sleep(300);
ayla.cast('heal');
await Bun.sleep(300);
ayla.cast('incantation');
await Bun.sleep(600);
const actions = ayla.events.filter((e) => e.kind === 'cast' && e.fromId === ayla.selfId).map((e) => e.action);
check('RMB ward, R heal and Q incantation each produce one explicit cast', ['secondary', 'heal', 'incantation'].every((a) => actions.filter((x) => x === a).length === 1), actions.join(','));
check('ward is visible in the snapshot', (ayla.self?.wardUntil ?? 0) > 0 && (ayla.self?.skillCooldowns?.secondary ?? 0) > 0);

// ---- 2. gated boss ---------------------------------------------------------------------------------

const raksha = ayla.enemy('raksha')!;
check('boss altar is gated at the start', ayla.adventure?.stage === 1 && ayla.adventure?.targetId === 'morrow');
check('walked to the Eastern Altar', await walkTo(raksha.position, 6));
goal = null;
for (let i = 0; i < 3; i++) {
  ayla.cast('incantation', ayla.aimAt(ayla.enemy('raksha')!.position));
  await Bun.sleep(300);
}
await Bun.sleep(1500);
check('gated boss takes no damage and never aggroes', ayla.enemy('raksha')!.hp === ayla.enemy('raksha')!.maxHp && !ayla.enemy('raksha')!.aggro && ayla.count('hit', (e) => e.toId === 'raksha') === 0);
check('the hunter is told the altar is warded', ayla.count('power', (e) => e.fromId === 'raksha' && !!e.text?.includes('warded')) >= 1);

// ---- 3. local aggro and leash on Morrow ----------------------------------------------------------

const morrowHome = ayla.enemy('morrow')!.position;
check('approached Morrow', await walkTo(morrowHome, 6));
const aggroed = await until(() => !!ayla.enemy('morrow')?.aggro, 4000);
check('Morrow aggroes locally', aggroed);
check('other haunts do not pile on from across the map', !ayla.enemy('vesper')?.aggro && !ayla.enemy('nix')?.aggro);
sprint = true;
check('ran back to the gate', await walkTo([0, 1.7, -23], 2));
const leashed = await until(() => !ayla.enemy('morrow')?.aggro, 6000);
const morrowNow = ayla.enemy('morrow')!.position;
const fromHome = Math.hypot(morrowNow[0] - morrowHome[0], morrowNow[2] - morrowHome[2]);
check('Morrow lost the target and stays inside its leash', leashed && fromHome <= 14.01, `${fromHome.toFixed(1)} m from home`);
await Bun.sleep(1500);
check('nothing follows the hunter into the safe gate', ayla.enemies.every((e) => !e.aggro) && ayla.count('hit', (e) => e.toId === ayla.selfId && e.tick > (ayla.events.at(-1)?.tick ?? 0) - 20) === 0);

// ---- 4. three sigils, then the boss -----------------------------------------------------------------

const fight = async (id: string) => {
  const target = () => ayla.enemy(id)!;
  check(`reached ${id}`, await walkTo(target().position, 5.5, 45_000));
  const deadline = Date.now() + 90_000;
  while (target().state === 'hunting' && Date.now() < deadline) {
    const me = ayla.self!;
    if (me.hp <= 0) {
      ayla.interact('respawn');
      await until(() => (ayla.self?.hp ?? 0) > 0, 2000);
      check(`${id}: explicit respawn restored the hunter at the gate`, (ayla.self?.hp ?? 0) === 100 && ayla.dist([0, 1.7, -23]) < 8);
      check(`reached ${id} again`, await walkTo(target().position, 5.5, 45_000));
      continue;
    }
    if (me.hp < 45 && (me.skillCooldowns?.heal ?? 0) <= Date.now()) ayla.cast('heal');
    if (ayla.dist(target().position) < 3 && (me.skillCooldowns?.secondary ?? 0) <= Date.now()) ayla.cast('secondary');
    if (ayla.dist(target().position) > 6) {
      await walkTo(target().position, 5, 5000);
      continue;
    }
    ayla.cast('incantation', ayla.aimAt(target().position));
    ayla.cast('primary', ayla.aimAt(target().position));
    await Bun.sleep(250);
  }
  check(`${id} banished`, target().state === 'banished');
  goal = null;
  await Bun.sleep(400);
};

for (const id of ['morrow', 'nix', 'vesper']) await fight(id);
check('three distinct sigils earned', ayla.adventure?.sigils === 3 && ayla.adventure?.stage === 2, JSON.stringify(ayla.adventure));
check('quest events recorded each sigil once', ayla.count('quest') === 3);
await fight('raksha');
check('boss defeated opens the portal', ayla.adventure?.bossDefeated === true && ayla.adventure?.portalReady === true && ayla.adventure?.stage === 3, JSON.stringify(ayla.adventure));

// ---- 5. echo portal in the same courtyard ----------------------------------------------------------

const portal: Vec3 = [22, 1.7, -22];
check('reached the echo portal', await walkTo(portal, 2, 45_000));
ayla.interact('portal');
const echoed = await until(() => (ayla.adventure?.echo ?? 0) === 1, 3000);
check('explicit portal interaction starts echo 1 in the same courtyard', echoed && ayla.count('portal') === 1 && ayla.adventure?.stage === 1 && ayla.adventure?.sigils === 0, JSON.stringify(ayla.adventure));
await Bun.sleep(600);
const m = ayla.enemy('morrow')!;
check('haunts re-homed with bounded scaling and the boss gated again', m.state !== 'banished' && m.maxHp === Math.round(72 * 1.2) && m.hp === m.maxHp && m.memory.banishments >= 1, `morrow ${m.hp}/${m.maxHp} strategy=${m.strategy}`);
check('the echo plan settled off the tick', ayla.count('power', (e) => e.fromId === 'adventure' && !!e.text?.includes('The echo settles')) === 1);

// ---- 6. identities and memory ------------------------------------------------------------------------

check('Bram was never moved or hit for the whole run', bram.dist(bramStart) < 0.01 && bram.self?.hp === 100 && bram.count('hit', (e) => e.toId === bram.selfId) === 0);
check('event ids are unique', new Set(ayla.events.map((e) => e.eventId)).size === ayla.events.length);
const after = await health();
const room = (after.rooms as { adventure: AdventureState; enemies: { id: string; banishments: number; lastHunterName?: string }[] }[])[0];
check('ghost memory names the recorded killer', room.enemies.filter((e) => ['morrow', 'nix', 'vesper', 'raksha'].includes(e.id)).every((e) => e.banishments >= 1 && e.lastHunterName === 'Ayla'), JSON.stringify(room.enemies.map((e) => [e.id, e.banishments, e.lastHunterName])));
log(`memory/relay/events modes: ${JSON.stringify(Object.fromEntries(Object.entries(after.integrations as Record<string, { mode: string }>).map(([k, v]) => [k, v.mode])))}`);
log(`director: ${JSON.stringify(after.director)}`);
log(`loop: ${JSON.stringify(after.loop)}`);
log(`stable ids: ayla=${ayla.selfId} bram=${bram.selfId}`);

clearInterval(aylaLoop);
clearInterval(bramLoop);
ayla.ws.close();
bram.ws.close();
await Bun.sleep(200);
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
