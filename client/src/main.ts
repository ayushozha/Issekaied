import '@babylonjs/core/Meshes/instancedMesh'; // side effect: createInstance() used by kit props during buildWorld
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer';
import { registerBuiltInLoaders } from '@babylonjs/loaders/dynamic';
import {
  powerForEnemyLevel,
  type AdventureState,
  type CombatAction,
  type EnemyState,
  type GameEvent,
  type PlayerState,
  type PowerId,
  type RoomSnapshot,
} from '../../shared/protocol';
import { CHANNELS } from './powers';
import { WORLD, buildWorld } from './world';
import { LocalPlayer } from './player';
import { EntityLayer, spriteKeyFor } from './entities';
import { EffectsLayer } from './effects';
import { Hud } from './hud';
import { Menus, type Recitation, type Settings } from './menus';
import { NetClient, sanitizeName, type InteractTarget } from './net';
import { LocalPreview } from './offline';
import { AudioEngine, NPC_INTROS, SACRED, safeServerAudioUrl, type MusicPhase } from './audio';
import { dressHalloween } from './halloween-props';
import { DIRECTIONS, SourceVoice } from './source-voice';

registerBuiltInLoaders();

// Mac-owned onboarding module; resolved at build time if present, so the client builds either way.
type RebirthModule = { startRebirthIntro: (onDone: () => void, options?: { videoUrl?: string }) => () => void };
const rebirthModules = import.meta.glob<RebirthModule>('./rebirth-intro.ts');
const ONBOARDING_SEEN = 'issekaied.onboardingSeen';
const SOURCE_SEEN = 'issekaied.sourceIntroSeen';
const SHORT_CUE = (name: string) => `/audio/short/${name}.mp3`;
const NPC_RANGE = 9;
const LAUGH_RANGE = 6;
const flag = (key: string): boolean => {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
};
const setFlag = (key: string): void => {
  try {
    localStorage.setItem(key, '1');
  } catch {
    /* storage unavailable */
  }
};

const canvas = document.getElementById('game') as HTMLCanvasElement;
const engine = new Engine(canvas, true, { stencil: false, preserveDrawingBuffer: false });
engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 1.5));
const scene = new Scene(engine);
const glow = new GlowLayer('glow', scene, { blurKernelSize: 32 });
glow.intensity = 0.55;

const hud = new Hud({
  onRetry: () => net?.retryNow(),
  onReturnToTitle: () => leaveToTitle(),
  onRespawn: () => respawn(),
  onDevPreview: () => startDevPreview(),
});
const player = new LocalPlayer(scene, canvas, glow);
const entities = new EntityLayer(scene, glow);
entities.onAssetIssue = (text) => hud.whisper(text, undefined, true);
const effects = new EffectsLayer(scene);

const RECITATIONS: Record<Recitation, { url: string; caption: string }> = {
  hanuman: { url: SACRED.hanumanFull, caption: 'Hanuman Chalisa · synthesized recitation' },
  shiva: { url: SACRED.shivaFull, caption: 'Shiva Tandava Stotram · synthesized recitation' },
  mantra: { url: SACRED.mrityunjaya, caption: 'Maha Mrityunjaya mantra · synthesized recitation' },
};

const menus: Menus = new Menus({
  onEnter: (name) => enter(name),
  onResume: () => resume(),
  onReturnToTitle: () => leaveToTitle(),
  onSettings: (s) => applySettings(s),
  onGesture: () => audio.unlock(),
  onListen: (kind) => audio.listen(kind ? RECITATIONS[kind].url : null),
  recitationAvailable: (kind): Promise<boolean> => audio.available(RECITATIONS[kind].url),
});
const audio: AudioEngine = new AudioEngine(menus.settings, (text, speaker) => hud.whisper(text, speaker, false, true));
applySettings(menus.settings);
const world = buildWorld(scene, { report: (t) => menus.setMainStatus(t) });
void dressHalloween(scene);

// ---- session state (everything below is reset by leaveToTitle) -------------------------------
let net: NetClient | null = null;
let preview: LocalPreview | null = null;
let sessionName = 'Hunter';
let selfId: string | null = null;
let self: PlayerState | null = null;
let dead = false;
let lastDeathText = '';
let lastAdventure: AdventureState | undefined;
let inputTimer = 0;
let lastCombatAt = 0;
let scareUntil = 0;
let lastPrimary: { power: PowerId; at: number } | null = null;
/** Cleared on blur/hidden; only a deliberate Enter/Resume gesture sets it again. */
let focused = true;
const introduced = new Set<string>();

const serverNow = () => net?.serverNow() ?? Date.now();
const online = () => !!net?.online;
const sessionActive = () => net !== null || preview !== null;
/** A real session that is not currently answered by the server: the connection panel owns the screen. */
const connectionPanelVisible = () => net !== null && !online();
/** The only state in which held keys may move the hunter and actions may be sent. */
const inputAllowed = () => (online() || !!preview?.running) && !dead && focused && player.locked && menus.current === null;

function applySettings(s: Settings): void {
  player.sensitivity = s.sensitivity;
  player.reduceMotion = s.reduceMotion;
  effects.setReducedMotion(s.reduceMotion);
  audio?.applySettings(s);
}

/** Re-evaluates the gate; when it closes, held input is dropped and an idle packet goes out immediately. */
function refreshInputGate(): void {
  const allowed = inputAllowed();
  if (player.inputEnabled && !allowed) {
    player.clearHeld();
    sendIdle();
  }
  player.inputEnabled = allowed;
  preview?.setActive(allowed);
}

function sendIdle(): void {
  if (online() && net) net.sendInput(0, 0, player.yaw, player.pitch, false, false);
}

const distXZ = (a: Vector3, p: readonly number[]) => Math.hypot(p[0] - a.x, p[2] - a.z);

// ---- snapshots & events -----------------------------------------------------------------------

function applySnapshot(snap: RoomSnapshot): void {
  if (!sessionActive()) return; // late message after return to title
  const now = serverNow();
  self = snap.players.find((p) => p.id === selfId) ?? null;
  if (self) {
    if (preview?.running) player.pos.y = self.position[1];
    else player.reconcile(self.position, self.ackSeq);
    if (self.hp <= 0 && !dead) onDefeated();
    if (self.hp > 0 && dead) onRevived(self.position);
    hud.setSelf(self, now);
  }
  entities.applySnapshot(snap, selfId);
  // NPC speech is local to the haunt: cut it once that haunt is out of earshot.
  const speakingNpc = audio.speakingNpcId;
  if (speakingNpc) {
    const st = entities.enemyState(speakingNpc);
    if (!st || st.state === 'banished' || distXZ(player.camera.position, st.position) > NPC_RANGE) audio.stopNpc();
  }
  lastAdventure = snap.adventure;
  world.setPortalReady(!!snap.adventure?.portalReady);
  hud.setAdventure(snap.adventure, snap.enemies, snap.players.length, nextTarget(snap.adventure, snap.enemies));
  updateMusic(snap);
  maybeIntroduce(snap);
}

function nextTarget(adv: AdventureState | undefined, enemies: EnemyState[]): { name: string; zone: string; dist: number } | null {
  const e = adv?.targetId ? enemies.find((x) => x.id === adv.targetId) : undefined;
  if (!e) return null;
  const zone = WORLD.adventure.zones.find((z) => z.id === e.id)?.name ?? '';
  return { name: e.name, zone, dist: distXZ(player.camera.position, e.position) };
}

/** Authoritative fall: freeze, release the mouse, show the retry panel. No timer brings the hunter back. */
function onDefeated(): void {
  dead = true;
  refreshInputGate();
  player.releaseLock();
  hud.setDefeat(true, lastDeathText);
  audio.sfx.hurt();
}

function onRevived(pos: PlayerState['position']): void {
  dead = false;
  hud.setDefeat(false);
  player.teleport(pos);
  refreshInputGate();
}

/** Music phase from what the room actually contains: aggro, distance, the keeper, recent combat. */
function updateMusic(snap: RoomSnapshot): void {
  if (!self) return;
  const now = Date.now();
  const eye = player.camera.position;
  let nearestHunting = Infinity;
  let nearestAggro = Infinity;
  let bossAwake = false;
  for (const e of snap.enemies) {
    if (e.state !== 'hunting') continue;
    const d = distXZ(eye, e.position);
    nearestHunting = Math.min(nearestHunting, d);
    if (e.aggro) {
      nearestAggro = Math.min(nearestAggro, d);
      if (e.id === WORLD.adventure.bossId) bossAwake = true;
    }
  }
  let phase: MusicPhase;
  if (dead) phase = 'fallen';
  else if (scareUntil > now) phase = 'scare';
  else if (bossAwake) phase = 'boss';
  else if (nearestAggro <= 14 || now - lastCombatAt < 6000) phase = 'combat';
  else if (nearestHunting <= 12) phase = 'tension';
  else if (nearestHunting < Infinity) phase = 'explore';
  else phase = 'respite';
  audio.setPhase(phase);
  hud.setNowPlaying(audio.currentTrack ? `♪ ${audio.currentTrack.replace(/\.ogg$/, '')}` : '');
}

/** Fixed intro clip, once per canonical haunt per page session, only when it hunts within earshot (single NPC slot). */
function maybeIntroduce(snap: RoomSnapshot): void {
  if (!self || dead || audio.speaking) return;
  const eye = player.camera.position;
  for (const e of snap.enemies) {
    if (e.state !== 'hunting' || introduced.has(e.id)) continue;
    const intro = NPC_INTROS[e.id];
    if (!intro || distXZ(eye, e.position) > NPC_RANGE) continue;
    if (audio.npc(e.id, intro.url, intro.text, e.name)) {
      introduced.add(e.id);
      return;
    }
  }
}

/** Only four laugh files exist; the monster render keys map to their haunt audio family. */
const LAUGH_FAMILY: Record<string, string> = { goblin: 'nix', orc: 'raksha', beast: 'vesper' };

/** Rare nearby laugh (≤ 6 m) on a real encounter beat; the single NPC slot and cooldowns keep it rare. */
function npcLaugh(id: string, range: number): void {
  const st = entities.enemyState(id);
  if (!st || st.state === 'banished' || distXZ(player.camera.position, st.position) > range) return;
  const key = spriteKeyFor(st);
  audio.npc(id, SHORT_CUE(`laugh-${LAUGH_FAMILY[key] ?? key}`), undefined, st.name);
}

/** Gameplay invocations use only the short (≤2 s) cues; full recitations stay in Settings → Listen. */
function invocationAudio(power: PowerId): void {
  audio.sfx.cast(power);
  audio.cue(SHORT_CUE(power), `${CHANNELS[power].deity} · short invocation`, 'Chant');
}

const feetOf = (eye: Vector3) => eye.add(new Vector3(0, -1.6, 0));

function handleEvent(ev: GameEvent): void {
  if (!sessionActive()) return;
  const at = ev.position ? Vector3.FromArray(ev.position) : entities.positionOf(ev.toId ?? ev.fromId);
  const name = (id: string | undefined) => (id ? entities.enemyState(id)?.name ?? (id === selfId ? self?.name : undefined) ?? 'A hunter' : 'Someone');
  // Server-generated speech: same-origin /api/audio/... only, only from a resolved haunt within earshot, single NPC slot.
  const voiceUrl = safeServerAudioUrl(ev.audioUrl);
  const speakerState = entities.enemyState(ev.fromId);
  if (voiceUrl && speakerState && distXZ(player.camera.position, speakerState.position) <= NPC_RANGE) audio.npc(ev.fromId, voiceUrl, undefined, speakerState.name);
  if (ev.fromId === selfId || ev.toId === selfId) lastCombatAt = Date.now();

  switch (ev.kind) {
    case 'cast': {
      const action: CombatAction = ev.action ?? 'primary';
      const eye = player.camera.position.clone();
      if (action === 'heal') {
        // An accepted recovery carries no deity power. The authority already changed HP; the client only
        // plays the mantra once (bounded) and never on a rejected cast.
        const origin = ev.fromId === selfId ? eye : (at ?? entities.nodeOf(ev.fromId)?.position ?? null);
        if (!origin) return;
        effects.heal(feetOf(origin));
        if (ev.fromId === selfId) audio.cue(SHORT_CUE('heal'), 'Maha Mrityunjaya · short recovery cue', 'Chant');
        return;
      }
      if (!ev.power) return; // every deity-power action names its channel
      if (ev.fromId === selfId) {
        // Only the primary strike is predicted locally; the server's event must not replay it.
        if (action === 'primary') {
          const recent = lastPrimary && Date.now() - lastPrimary.at < 600 && lastPrimary.power === ev.power;
          if (!recent) strikeFx(ev.power, null);
          return;
        }
        if (action === 'incantation') {
          hud.invocationCue(CHANNELS[ev.power]);
          effects.cast(ev.power, eye, Vector3.FromArray(player.aim()), null);
          invocationAudio(ev.power);
        } else if (action === 'secondary') {
          effects.ward(feetOf(eye), CHANNELS[ev.power].color);
          audio.sfx.cast(ev.power);
        }
        return;
      }
      const node = entities.nodeOf(ev.fromId);
      const origin = at ?? node?.position ?? null;
      if (!origin) return;
      if (action === 'incantation') {
        const yaw = node?.rotation.y ?? 0;
        effects.cast(ev.power, origin.clone(), new Vector3(Math.sin(yaw), 0, Math.cos(yaw)), node);
      } else if (action === 'secondary') effects.ward(feetOf(origin), CHANNELS[ev.power].color);
      else effects.hit(ev.power, origin.add(new Vector3(0, -0.4, 0)));
      return;
    }
    case 'hit':
      if (at) effects.hit(ev.power, at);
      if (ev.toId === selfId) {
        audio.sfx.hurt();
        npcLaugh(ev.fromId, LAUGH_RANGE);
      } else {
        if (ev.toId) entities.flashHit(ev.toId);
        audio.sfx.hit();
      }
      return;
    case 'banish':
      if (at) effects.banish(at);
      audio.sfx.banish();
      hud.whisper(ev.text ?? `${name(ev.toId)} is banished by ${name(ev.fromId)}${ev.power ? ` through ${CHANNELS[ev.power].deity}` : ''}.`, undefined, true);
      return;
    case 'return': {
      if (at && ev.fromId !== selfId) effects.returned(at);
      const memory = entities.enemyState(ev.fromId)?.memory;
      if (self && memory?.lastHunterName === self.name) scareUntil = Date.now() + 20000;
      npcLaugh(ev.fromId, LAUGH_RANGE);
      hud.whisper(ev.text ?? `${name(ev.fromId)} returns.`, undefined, true);
      return;
    }
    case 'whisper':
      hud.whisper(ev.text ?? '…', entities.enemyState(ev.fromId)?.name ?? (ev.fromId === 'system' ? undefined : name(ev.fromId)), ev.fromId === 'system');
      return;
    case 'death':
      if (ev.fromId === selfId || ev.toId === selfId) lastDeathText = ev.text ?? `${name(ev.toId)} remembers your last encounter.`;
      hud.whisper(ev.text ?? `${name(ev.fromId)} has fallen.`, undefined, true);
      return;
    case 'power':
    case 'quest':
      if (ev.text) hud.whisper(ev.text, undefined, true);
      return;
    case 'portal': {
      const p = at ?? Vector3.FromArray(WORLD.adventure.portal.position).add(new Vector3(0, 1.7, 0));
      effects.returned(p);
      if (ev.text) hud.whisper(ev.text, undefined, true);
      return;
    }
  }
}

// ---- deliberate actions -----------------------------------------------------------------------

function strikeFx(power: PowerId, target: Vector3 | null): void {
  audio.sfx.cast(power);
  effects.primary(player.camera.position.clone(), Vector3.FromArray(player.aim()), target);
}

/** One discrete action per press. Local feedback only for the primary strike; everything else waits for the authority. */
function act(action: CombatAction): void {
  if (!inputAllowed()) return;
  if (!hud.isReady(action, serverNow())) return;
  const aim = player.aim();
  if (action === 'primary') {
    const target = entities.pickTarget(player.camera.position, Vector3.FromArray(aim));
    const power = powerForEnemyLevel(target?.level ?? 1);
    lastPrimary = { power, at: Date.now() };
    strikeFx(power, target ? Vector3.FromArray(target.position) : null);
  }
  if (online()) net?.sendCast(aim, action);
  else preview?.cast(aim, action);
}

function nearbyInteract(): { target: InteractTarget; text: string; enabled: boolean } | null {
  if (!sessionActive()) return null;
  if (dead) return { target: 'respawn', text: 'Return to Bellgrave', enabled: true };
  const { shrine, portal } = WORLD.adventure;
  const eye = player.camera.position;
  // Exactly the shared landmark radius, matching the server's nearLandmark check, so E never promises a rejected interaction.
  if (distXZ(eye, shrine.position) <= shrine.radius) return { target: 'shrine', text: 'Commune with the shrine', enabled: true };
  if (distXZ(eye, portal.position) <= portal.radius) {
    const ready = !!lastAdventure?.portalReady;
    return { target: 'portal', text: ready ? 'Enter the echo portal' : 'The portal is sealed', enabled: ready };
  }
  return null;
}

function interact(): void {
  if (menus.current !== null) return;
  const near = nearbyInteract();
  if (!near?.enabled) return;
  if (near.target === 'respawn') {
    respawn();
    return;
  }
  if (!inputAllowed()) return;
  if (online()) net?.sendInteract(near.target);
  else preview?.interact(near.target);
}

/** Explicit return after a fall (E or the panel button); the server decides when the hunter is back. */
function respawn(): void {
  if (!dead || !sessionActive()) return;
  if (online()) net?.sendInteract('respawn');
  else preview?.interact('respawn');
  player.requestLock(); // the click/key is the gesture
}

function startInputLoop(): void {
  window.clearInterval(inputTimer);
  const rate = net?.tickRate ?? 20;
  inputTimer = window.setInterval(() => {
    if (!online() || !net) return;
    if (inputAllowed()) {
      const move = player.moveInput();
      player.record(net.sendInput(move.x, move.z, player.yaw, player.pitch, player.sprinting, true));
    } else {
      net.sendInput(0, 0, player.yaw, player.pitch, false, false);
    }
  }, 1000 / rate);
}

// ---- session ----------------------------------------------------------------------------------

function startSession(name: string): void {
  sessionName = name;
  dead = false;
  hud.setConnection('connecting', '');
  hud.setStatus('connecting', 'connecting');
  net = new NetClient(name, 'bellgrave', {
    onWelcome: (msg) => {
      selfId = msg.selfId;
      dead = false;
      hud.whisper(`Joined ${msg.roomId} as ${name}.`, undefined, true);
      hud.setConnection('hidden', '');
      startInputLoop();
      refreshInputGate();
      audio.setPhase('explore');
      // The mouse is free while connecting; taking it requires a deliberate click, never an automatic lock.
      if (!player.locked && (menus.current === null || menus.current === 'pause')) {
        menus.setPauseStatus('Connected to Bellgrave. Click Resume hunting to take the mouse.');
        menus.show('pause');
        audio.setPaused(true);
      }
    },
    onSnapshot: applySnapshot,
    onEvent: handleEvent,
    onStatus: (status, detail, hadWelcome) => {
      hud.setStatus(status, detail);
      if (status === 'online') hud.setConnection('hidden', '');
      else if (status === 'connecting') hud.setConnection(hadWelcome ? 'lost' : 'connecting', detail);
      else if (status === 'offline') hud.setConnection(hadWelcome ? 'lost' : 'retrying', detail);
      else hud.setConnection('failed', detail);
      refreshInputGate(); // frozen whenever the authority is not answering
      if (status !== 'online') {
        player.releaseLock(); // the panel's buttons must be reachable with a real mouse
        audio.stopNpc();
      }
    },
    onServerError: (code, message) => hud.whisper(`${code}: ${message}`, 'server', true),
  });
  net.connect();
  startInputLoop();
}

/** Dev-only, explicit: replaces the (failed) connection with a local synthetic room. Stripped from production. */
function startDevPreview(): void {
  if (!import.meta.env.DEV || preview) return;
  net?.dispose();
  net = null;
  window.clearInterval(inputTimer);
  preview = new LocalPreview(sessionName, {
    getSelf: () => ({ pos: player.pos, yaw: player.yaw, pitch: player.pitch }),
    onSnapshot: applySnapshot,
    onEvent: handleEvent,
  });
  selfId = preview.selfId;
  dead = false;
  preview.start();
  hud.setConnection('hidden', '');
  hud.setPreviewBanner(true);
  hud.setStatus('offline', 'local synthetic preview (dev only)');
  refreshInputGate();
  audio.setPhase('explore');
}

let cancelIntro: (() => void) | null = null;

/** Enter Bellgrave from the main menu (user gesture). Pointer lock and audio start here and nowhere automatic. */
function enter(rawName: string): void {
  audio.unlock();
  focused = true;
  player.clearHeld(); // never carry keys held before entry
  const name = sanitizeName(rawName);
  const intro = rebirthModules['./rebirth-intro.ts'];
  if (!sessionActive() && !cancelIntro && intro && !flag(ONBOARDING_SEEN)) {
    // First entry for this guest: the rebirth intro plays before any join; input stays inactive until it is done.
    menus.hide();
    void intro().then((mod) => {
      if (cancelIntro !== null || sessionActive()) return;
      let done = false;
      cancelIntro = mod.startRebirthIntro(() => {
        if (done) return;
        done = true;
        cancelIntro = null;
        setFlag(ONBOARDING_SEEN);
        beginHunt(name);
      }, { videoUrl: '/video/rebirth.mp4' });
    });
    return;
  }
  beginHunt(name);
}

function beginHunt(name: string): void {
  if (!sessionActive()) startSession(name);
  menus.setInSession(true);
  hud.show();
  menus.hide();
  audio.setPaused(false);
  // While the server has not answered, the connection panel owns the mouse; the lock comes from Resume after welcome.
  if (online() || preview?.running) player.requestLock();
  refreshInputGate();
}

/** Resume from the pause screen; the click itself is the gesture that permits re-locking the mouse. */
function resume(): void {
  if (!sessionActive()) {
    menus.show('main');
    return;
  }
  audio.unlock();
  focused = true;
  player.clearHeld(); // resume re-arms only fresh presses
  hud.show();
  menus.hide();
  audio.setPaused(false);
  player.requestLock();
  refreshInputGate();
}

// ---- The Source (realtime voice guide; a character, never an authority) --------------------------

const sourceUi = {
  status: document.getElementById('source-status') as HTMLElement,
  log: document.getElementById('source-log') as HTMLUListElement,
  mic: document.getElementById('btn-source-mic') as HTMLButtonElement,
  text: document.getElementById('source-text') as HTMLInputElement,
};
let source: SourceVoice | null = null;
let talkHeld = false;

function sourceLog(role: 'source' | 'you' | 'system', text: string, final: boolean): void {
  const last = sourceUi.log.lastElementChild as HTMLLIElement | null;
  if (!final && last?.dataset.role === role && last.dataset.final === 'false') {
    last.textContent = `${role === 'source' ? 'The Source' : 'You'}: ${text}`;
    return;
  }
  if (last?.dataset.final === 'false' && last.dataset.role === role) {
    last.textContent = `${role === 'source' ? 'The Source' : 'You'}: ${text}`;
    last.dataset.final = 'true';
    return;
  }
  const li = document.createElement('li');
  li.dataset.role = role;
  li.dataset.final = String(final);
  li.className = role;
  li.textContent = role === 'system' ? text : `${role === 'source' ? 'The Source' : 'You'}: ${text}`;
  sourceUi.log.appendChild(li);
  while (sourceUi.log.children.length > 8) sourceUi.log.firstElementChild?.remove();
}

/** Built on first use, from a user gesture, with the same guest key the game socket is bound to. */
function sourceClient(): SourceVoice | null {
  if (!net) {
    sourceUi.status.textContent = 'Enter Bellgrave with a live connection first.';
    return null;
  }
  source ??= new SourceVoice(net.playerKey, 'bellgrave', {
    onStatus: (status, detail) => {
      sourceUi.status.textContent = status === 'idle' ? 'Not connected' : status === 'live' ? `Live · ${detail}` : status === 'connecting' ? `Connecting · ${detail}` : detail || status;
      sourceUi.status.dataset.state = status;
      sourceUi.mic.dataset.mic = status === 'live' && source?.hasMic ? (talkHeld ? 'on' : 'ready') : 'off';
      if (status === 'live') sourceLog('system', 'The Source is listening.', true);
    },
    onTranscript: (role, text, final) => sourceLog(role, text, final),
    onSpeaking: (active) => audio.setExternalSpeech(active),
    onRemoteAudio: (el) => audio.attachRemoteAudio(el),
    fetchContext: async () => {
      const res = await fetch('/api/source/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerKey: net?.playerKey, roomId: 'bellgrave' }),
      });
      if (!res.ok) throw new Error(`context ${res.status}`);
      return (await res.json()) as unknown; // opaque: handed to the model as-is
    },
  });
  return source;
}

/** Hold-V / mic button: transmit only while held. First hold connects with the microphone (the gesture). */
function holdTalk(held: boolean): void {
  if (!held) {
    // Release is unconditional and idempotent: the mic track is disabled before any session/menu guard,
    // and it never creates a client or connects.
    talkHeld = false;
    source?.setHeld(false);
    sourceUi.mic.dataset.mic = source?.live && source.hasMic ? 'ready' : 'off';
    return;
  }
  if (talkHeld) return;
  if (!sessionActive() || menus.current === 'settings' || menus.current === 'credits') return;
  const s = sourceClient();
  if (!s) return;
  talkHeld = true;
  s.setHeld(true); // held state is recorded first, so a release during the permission prompt leaves the mic off
  sourceUi.mic.dataset.mic = s.live && s.hasMic ? 'on' : 'off';
  // A deliberate hold connects, or upgrades a text-only session to one with the microphone.
  if (!s.live || !s.hasMic) void sourceConnect(s, true, null);
}

/** One birth introduction per browser guest; afterwards only the player's own question is sent. */
async function sourceConnect(s: SourceVoice, withMic: boolean, firstTurn: string | null): Promise<boolean> {
  const introduce = !flag(SOURCE_SEEN);
  const ok = await s.connect(withMic, firstTurn, introduce);
  if (ok && introduce) setFlag(SOURCE_SEEN);
  return ok;
}
// Release must reach us even when a focused control stops bubbling: capture phase, plus the Source field taking focus.
window.addEventListener('keyup', (e) => {
  if (e.code === 'KeyV') holdTalk(false);
}, true);

/** Text or directions. A first use connects (text only, no microphone) with the question folded into the opening response. */
async function sourceAsk(text: string | null): Promise<void> {
  if (!sessionActive()) return;
  const s = sourceClient();
  if (!s) return;
  const turn = text === null ? DIRECTIONS : text.trim().slice(0, 400);
  if (!turn) return;
  if (!s.live) {
    sourceLog('you', turn, true);
    await sourceConnect(s, false, turn);
    return;
  }
  if (text === null) s.askDirections();
  else s.sendText(text);
}

player.onHoldTalk = holdTalk;
for (const [ev, held] of [['pointerdown', true], ['pointerup', false], ['pointerleave', false], ['pointercancel', false]] as const) {
  sourceUi.mic.addEventListener(ev, () => holdTalk(held));
}
(document.getElementById('btn-source-directions') as HTMLButtonElement).addEventListener('click', () => void sourceAsk(null));
(document.getElementById('btn-source-stop') as HTMLButtonElement).addEventListener('click', () => {
  source?.stop();
  sourceUi.status.textContent = 'Not connected';
  sourceUi.mic.dataset.mic = 'off';
});
(document.getElementById('source-form') as HTMLFormElement).addEventListener('submit', (e) => {
  e.preventDefault();
  const text = sourceUi.text.value;
  sourceUi.text.value = '';
  void sourceAsk(text);
});
// Typing to The Source must never move or strike the hunter: keys inside the field stop at the field.
sourceUi.text.addEventListener('keydown', (e) => e.stopPropagation());
sourceUi.text.addEventListener('keyup', (e) => e.stopPropagation());
sourceUi.text.addEventListener('focus', () => holdTalk(false));

/** Ends the hunt: stops network/preview/voices, drops server-owned views, resets local state, shows the title. */
function leaveToTitle(): void {
  cancelIntro?.(); // a cancelled intro never joins
  cancelIntro = null;
  window.clearInterval(inputTimer);
  inputTimer = 0;
  sendIdle();
  source?.stop();
  source = null;
  talkHeld = false;
  sourceUi.log.replaceChildren();
  sourceUi.status.textContent = 'Not connected';
  sourceUi.mic.dataset.mic = 'off';
  net?.dispose();
  net = null;
  preview?.stop();
  preview = null;
  selfId = null;
  self = null;
  dead = false;
  lastDeathText = '';
  lastAdventure = undefined;
  lastCombatAt = 0;
  scareUntil = 0;
  lastPrimary = null;
  focused = true;
  // `introduced` is deliberately kept: each haunt's fixed intro plays at most once per page session.
  player.clearHeld();
  player.inputEnabled = false;
  entities.clear();
  hud.reset();
  audio.stopSession();
  world.setPortalReady(false);
  player.teleport(WORLD.spawn);
  player.yaw = 0;
  player.pitch = -0.02;
  player.releaseLock();
  menus.setInSession(false);
  menus.show('splash');
}

player.onAction = act;
player.onInteract = interact;
player.onLockChange = (locked) => {
  if (!sessionActive()) return; // no hunt in progress: the menus own the screen
  if (locked) {
    hud.show();
    menus.hide();
    audio.setPaused(false);
  } else if (!dead && !connectionPanelVisible()) {
    // Defeat and connection panels own the free mouse; the pause overlay must not cover their buttons.
    menus.setPauseStatus('');
    menus.show('pause');
    audio.setPaused(true);
  }
  if (!locked) {
    holdTalk(false); // releasing the mouse also releases push-to-talk
    audio.stopNpc();
  }
  refreshInputGate();
};
player.onLockError = (reason) => {
  if (!sessionActive() || player.locked) return;
  menus.setPauseStatus(`Mouse lock failed (${reason}). Click Resume to try again; browsers need a moment after Esc.`);
  menus.show('pause');
  audio.setPaused(true);
  refreshInputGate();
};
/** Focus left the page: freeze now, tell the server now, and require a deliberate Resume to continue. */
player.onFocusLost = () => {
  if (!sessionActive()) return;
  focused = false;
  refreshInputGate();
  sendIdle();
  holdTalk(false); // never keep transmitting after focus leaves
  audio.stopNpc();
  if (dead || connectionPanelVisible() || menus.current !== null) return; // those screens already own the resume path
  player.releaseLock();
  menus.setPauseStatus('The game lost focus. Click Resume hunting to continue.');
  menus.show('pause');
  audio.setPaused(true);
};
canvas.addEventListener('click', () => {
  if (sessionActive() && (online() || preview?.running) && !player.locked && !dead && menus.current === null) {
    focused = true;
    player.requestLock();
  }
});

// Idle view behind the title screens: camera at spawn looking at the chapel.
player.yaw = 0;
player.pitch = -0.02;
player.teleport(WORLD.spawn);
menus.setInSession(false);

if (import.meta.env.DEV) {
  // Dev-only inspection handle for smoke tests; stripped from production builds.
  (window as unknown as { __issekaied?: unknown }).__issekaied = { scene, player, entities, menus, audio, hud };
}

engine.runRenderLoop(() => {
  const dt = Math.min(0.1, engine.getDeltaTime() / 1000);
  player.update(dt);
  entities.update(dt);
  const now = serverNow();
  hud.tick(now);
  const aim = Vector3.FromArray(player.aim());
  const target = sessionActive() && !dead ? entities.pickTarget(player.camera.position, aim) : null;
  hud.setTarget(target, target ? distXZ(player.camera.position, target.position) : 0, now);
  entities.setTarget(target?.id ?? null);
  const near = nearbyInteract();
  hud.setInteract(near ? near.text : null);
  scene.render();
});
window.addEventListener('resize', () => engine.resize());
