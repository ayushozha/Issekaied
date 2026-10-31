import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer';
import { registerBuiltInLoaders } from '@babylonjs/loaders/dynamic';
import { powerForEnemyLevel, type GameEvent, type PlayerState, type PowerId, type RoomSnapshot } from '../../shared/protocol';
import { CHANNELS } from './powers';
import { WORLD, buildWorld } from './world';
import { LocalPlayer } from './player';
import { EntityLayer } from './entities';
import { EffectsLayer } from './effects';
import { Hud } from './hud';
import { Menus, type Settings } from './menus';
import { NetClient, sanitizeName } from './net';
import { LocalPreview } from './offline';

registerBuiltInLoaders();

const canvas = document.getElementById('game') as HTMLCanvasElement;
const engine = new Engine(canvas, true, { stencil: false, preserveDrawingBuffer: false });
engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 1.5));
const scene = new Scene(engine);
const glow = new GlowLayer('glow', scene, { blurKernelSize: 32 });
glow.intensity = 0.7;

const hud = new Hud();
const player = new LocalPlayer(scene, canvas);
const entities = new EntityLayer(scene);
const effects = new EffectsLayer(scene);
const menus = new Menus({
  onEnter: (name) => enter(name),
  onResume: () => resume(),
  onReturnToTitle: () => leaveToTitle(),
  onSettings: (s) => applySettings(s),
});
applySettings(menus.settings);
buildWorld(scene, { report: (t) => menus.setMainStatus(t) });

// Session state. `net` doubles as the "a hunt is in progress" flag; everything below is reset by leaveToTitle().
let net: NetClient | null = null;
let preview: LocalPreview | null = null;
let selfId: string | null = null;
let self: PlayerState | null = null;
let lastHp = 100;
let lastPredictedCast: { power: PowerId; at: number } | null = null;
let inputTimer = 0;

const serverNow = () => net?.serverNow() ?? Date.now();
const online = () => !!net?.online;

function applySettings(s: Settings): void {
  player.sensitivity = s.sensitivity;
  player.reduceMotion = s.reduceMotion;
}

// ---- snapshots & events -----------------------------------------------------------------------

function applySnapshot(snap: RoomSnapshot): void {
  if (!net) return; // late message after return to title
  self = snap.players.find((p) => p.id === selfId) ?? null;
  if (self) {
    if (preview?.running) player.pos.y = self.position[1];
    else player.reconcile(self.position, self.ackSeq);
    if (self.hp < lastHp) hud.flash('#ff2a2a');
    if (self.hp > 0 && lastHp <= 0) player.teleport(self.position);
    lastHp = self.hp;
    hud.setSelf(self);
  }
  entities.applySnapshot(snap, selfId);
  hud.setPlayers(snap.players, selfId);
  hud.setEnemies(snap.enemies, serverNow());
}

function handleEvent(ev: GameEvent): void {
  if (!net) return;
  const at = ev.position ? Vector3.FromArray(ev.position) : entities.positionOf(ev.toId ?? ev.fromId);
  const name = (id: string | undefined) => (id ? entities.enemyState(id)?.name ?? (id === selfId ? self?.name : undefined) ?? 'A hunter' : 'Someone');
  switch (ev.kind) {
    case 'cast': {
      if (!ev.power) return;
      if (ev.fromId === selfId) {
        // Already predicted locally unless the server picked a different channel than we expected.
        const recent = lastPredictedCast && Date.now() - lastPredictedCast.at < 600;
        if (recent && lastPredictedCast?.power === ev.power) return;
        hud.invocationCue(CHANNELS[ev.power]);
        effects.cast(ev.power, player.camera.position.clone(), Vector3.FromArray(player.aim()), null);
        if (ev.power === 'ganesha') hud.flash(CHANNELS.ganesha.color);
        return;
      }
      const node = entities.nodeOf(ev.fromId);
      const origin = at ?? node?.position ?? null;
      if (!origin) return;
      const yaw = node?.rotation.y ?? 0;
      effects.cast(ev.power, origin.clone(), new Vector3(Math.sin(yaw), 0, Math.cos(yaw)), node);
      return;
    }
    case 'hit':
      if (at) effects.hit(ev.power, at);
      if (ev.toId === selfId) hud.flash('#ff2a2a');
      return;
    case 'banish':
      if (at) effects.banish(at);
      hud.whisper(ev.text ?? `${name(ev.toId)} is banished by ${name(ev.fromId)}${ev.power ? ` through ${CHANNELS[ev.power].deity}` : ''}.`, undefined, true);
      return;
    case 'return':
      if (at && ev.fromId !== selfId) effects.returned(at);
      hud.whisper(ev.text ?? `${name(ev.fromId)} returns.`, undefined, true);
      return;
    case 'whisper':
      hud.whisper(ev.text ?? '…', entities.enemyState(ev.fromId)?.name ?? (ev.fromId === 'system' ? undefined : name(ev.fromId)), ev.fromId === 'system');
      return;
    case 'death':
      hud.whisper(ev.text ?? `${name(ev.fromId)} has fallen.`, undefined, true);
      return;
    case 'power':
      if (ev.text) hud.whisper(ev.text, undefined, true);
      return;
  }
}

// ---- input & attack ---------------------------------------------------------------------------

function attack(): void {
  if (!self || self.hp <= 0) return;
  const aim = player.aim();
  const aimV = Vector3.FromArray(aim);
  const target = entities.pickTarget(player.camera.position, aimV);
  const expected = powerForEnemyLevel(target?.level ?? 1);
  const now = serverNow();
  if (!hud.isReady(expected, now)) {
    hud.flash('#444');
    return;
  }
  if (target) {
    // Predict the server's channel choice for instant feedback; the 'cast' event confirms or corrects.
    lastPredictedCast = { power: expected, at: Date.now() };
    hud.invocationCue(CHANNELS[expected]);
    effects.cast(expected, player.camera.position.clone(), aimV, null);
    if (expected === 'ganesha') hud.flash(CHANNELS.ganesha.color);
  } else {
    lastPredictedCast = null;
  }
  if (online()) net?.sendCast(aim);
  else preview?.cast(aim);
}

function startInputLoop(): void {
  window.clearInterval(inputTimer);
  const rate = net?.tickRate ?? 20;
  inputTimer = window.setInterval(() => {
    const move = player.moveInput();
    if (online() && net) {
      const seq = net.sendInput(move.x, move.z, player.yaw, player.pitch, player.sprinting);
      player.record(seq);
    }
  }, 1000 / rate);
}

// ---- session ----------------------------------------------------------------------------------

function startSession(name: string): void {
  preview = new LocalPreview(name, {
    getSelf: () => ({ pos: player.pos, yaw: player.yaw, pitch: player.pitch }),
    onSnapshot: applySnapshot,
    onEvent: handleEvent,
  });
  net = new NetClient(name, 'bellgrave', {
    onWelcome: (msg) => {
      preview?.stop();
      selfId = msg.selfId;
      lastHp = 100;
      hud.whisper(`Joined ${msg.roomId} as ${name}.`, undefined, true);
      startInputLoop();
    },
    onSnapshot: applySnapshot,
    onEvent: handleEvent,
    onStatus: (status, detail) => {
      if (status === 'online') preview?.stop();
      if (status === 'offline' && preview && !preview.running) {
        selfId = preview.selfId;
        preview.start();
      }
      hud.setStatus(status, detail, !!preview?.running);
    },
    onServerError: (code, message) => hud.whisper(`${code}: ${message}`, 'server', true),
  });
  net.connect();
  startInputLoop();
}

/** Enter Bellgrave from the main menu (user gesture). Pointer lock is requested here and nowhere automatic. */
function enter(rawName: string): void {
  if (!net) startSession(sanitizeName(rawName));
  hud.show();
  menus.hide();
  player.requestLock();
}

/** Resume from the pause screen; the click itself is the gesture that permits re-locking the mouse. */
function resume(): void {
  if (!net) {
    menus.show('main');
    return;
  }
  hud.show();
  menus.hide();
  player.requestLock();
}

/** Ends the hunt: stops network and preview, drops all server-owned views, resets local state, shows the title. */
function leaveToTitle(): void {
  window.clearInterval(inputTimer);
  inputTimer = 0;
  net?.dispose();
  net = null;
  preview?.stop();
  preview = null;
  selfId = null;
  self = null;
  lastHp = 100;
  lastPredictedCast = null;
  entities.clear();
  hud.reset();
  player.teleport(WORLD.spawn);
  player.yaw = 0;
  player.pitch = -0.02;
  player.releaseLock();
  menus.show('splash');
}

player.onAttack = attack;
player.onLockChange = (locked) => {
  if (!net) return; // no hunt in progress: the menus own the screen
  if (locked) {
    hud.show();
    menus.hide();
  } else {
    menus.setPauseStatus('');
    menus.show('pause');
  }
};
player.onLockError = (reason) => {
  if (!net || player.locked) return; // a late error while we already hold the lock is not a failure
  menus.setPauseStatus(`Mouse lock failed (${reason}). Click Resume to try again; browsers need a moment after Esc.`);
  menus.show('pause');
};
canvas.addEventListener('click', () => {
  if (net && !player.locked && menus.current === null) player.requestLock();
});

// Idle view behind the title screens: camera at spawn looking at the chapel.
player.yaw = 0;
player.pitch = -0.02;
player.teleport(WORLD.spawn);

if (import.meta.env.DEV) {
  // Dev-only inspection handle for smoke tests; stripped from production builds.
  (window as unknown as { __issekaied?: unknown }).__issekaied = { scene, player, entities, menus };
}

engine.runRenderLoop(() => {
  const dt = Math.min(0.1, engine.getDeltaTime() / 1000);
  player.update(dt);
  entities.update(dt);
  const now = serverNow();
  hud.tick(now);
  hud.setTarget(self ? entities.pickTarget(player.camera.position, Vector3.FromArray(player.aim())) : null, now);
  scene.render();
});
window.addEventListener('resize', () => engine.resize());
