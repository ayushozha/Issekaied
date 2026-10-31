import type { PowerId } from '../../shared/protocol';

/**
 * Browser audio on native HTMLAudioElement + a tiny Web Audio synth. One streaming music track at a
 * time (plus one fading out), one voice slot shared by haunt speech and chants, one optional loop.
 * Nothing here is preloaded up front; a track is requested only when its phase is first needed.
 * Every public method is safe to call before the user gesture: playback simply waits for unlock().
 */
export interface AudioSettings {
  music: number;
  voice: number;
  effects: number;
  muted: boolean;
}

export type MusicPhase = 'title' | 'respite' | 'explore' | 'tension' | 'combat' | 'boss' | 'scare' | 'fallen';

const RANK: Record<MusicPhase, number> = { title: 0, respite: 1, explore: 2, tension: 3, combat: 4, boss: 5, scare: 6, fallen: 7 };
const MUSIC_BASE = '/audio/optimized/';
/** Licensed Kevin MacLeod tracks (CC BY 4.0); the credits screen in index.html must list every file here. */
const PLAYLIST: Record<MusicPhase, string[]> = {
  title: ['title-ghostpocalypse-departure.ogg'],
  respite: ['hub-ossuary-a-beginning.ogg'],
  explore: ['explore-gathering-darkness.ogg', 'explore-night-of-chaos.ogg'],
  tension: ['tension-right-behind-you.ogg'],
  combat: ['combat-zombie-chase.ogg'],
  boss: ['boss-ghostpocalypse-master.ogg'],
  scare: ['scare-gateway-to-hell.ogg'],
  fallen: ['calaca-danse-macabre.ogg'],
};
const CROSSFADE_S = 1.4;
const DOWNSHIFT_HOLD_MS = 5000;
const DUCK = 0.3;
const PAUSE_DUCK = 0.45;
const VOICE_MAX_S = 30;
const VOICE_QUEUE_MAX = 2;
const CUE_MIN_INTERVAL_MS = 6000;
const PROBE_RETRY_MS = 120000;

/** Recitation files synthesized with artificial intelligence (see the PROVENANCE.md beside each); missing files are skipped. */
export const SACRED = {
  hanumanCue: '/audio/hanuman/chalisa-cue.mp3',
  hanumanFull: '/audio/hanuman/chalisa-full.mp3',
  shivaCue: '/audio/shiva/tandava-cue.mp3',
  shivaFull: '/audio/shiva/tandava-full.mp3',
  mrityunjaya: '/audio/mantra/mrityunjaya.mp3',
  mrityunjayaLoop: '/audio/mantra/mrityunjaya-healing-loop.mp3',
} as const;

/** Fixed fictional introductions (AI speech, see assets/audio/npc/PROVENANCE.md). Captions are the exact spoken text. */
export const NPC_INTROS: Record<string, { url: string; text: string }> = {
  morrow: { url: '/audio/npc/morrow-intro.mp3', text: 'I am Morrow, once the bell-ringer of this chapel. Walk softly; even the echoes are listening.' },
  nix: { url: '/audio/npc/nix-intro.mp3', text: 'The name is Nix. Welcome to the west crypt; do try not to make yourself comfortable.' },
  vesper: { url: '/audio/npc/vesper-intro.mp3', text: 'I am Vesper, and this chapel is my stage. Take your place, hunter; the performance begins at midnight.' },
  raksha: { url: '/audio/npc/raksha-intro.mp3', text: 'I am Raksha, keeper of the eastern ruin. Enter with courage, hunter; Bellgrave tests all who cross its stones.' },
};

/** Accepts only same-origin relative `/api/audio/...` paths from the server; anything else is dropped. */
export function safeServerAudioUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 512) return null;
  if (!/^\/api\/audio\/[A-Za-z0-9._\-/]+(\?[A-Za-z0-9=&._-]*)?$/.test(raw) || raw.includes('..') || raw.includes('//')) return null;
  try {
    const u = new URL(raw, location.origin);
    return u.origin === location.origin && u.pathname.startsWith('/api/audio/') ? u.pathname + u.search : null;
  } catch {
    return null;
  }
}

interface Fade { target: number; perSecond: number; stopAtZero: boolean }
interface VoiceItem { url: string; caption?: string; speaker?: string; priority?: boolean }

export class AudioEngine {
  readonly sfx = new Sfx();
  private settings: AudioSettings;
  private unlocked = false;
  private phase: MusicPhase = 'title';
  private wanted: MusicPhase = 'title';
  private wantedSince = 0;
  private current: { el: HTMLAudioElement; file: string } | null = null;
  private fadingOut: HTMLAudioElement | null = null;
  private exploreIndex = 0;
  private paused = false;
  private ducked = 0;
  private voice: HTMLAudioElement | null = null;
  private voiceItem: VoiceItem | null = null;
  private nextCue: VoiceItem | null = null; // at most one ritual cue waits behind another
  private voiceTimer = 0;
  private readonly queue: VoiceItem[] = [];
  private remote: HTMLAudioElement | null = null;
  private externalSpeech = false;
  private loop: HTMLAudioElement | null = null;
  private loopWanted = false;
  private readonly lastCue = new Map<string, number>();
  private readonly probes = new Map<string, { ok: boolean; at: number }>();
  private readonly fades = new Map<HTMLAudioElement, Fade>();
  private fadeTimer = 0;

  constructor(settings: AudioSettings, private readonly onCaption: (text: string, speaker?: string) => void) {
    this.settings = { ...settings };
    this.sfx.volume = settings.effects;
    this.sfx.muted = settings.muted;
  }

  /** Call from a user gesture (key, click, tap). Starts whatever phase is pending. */
  unlock(): void {
    this.unlocked = true;
    this.sfx.unlock();
    if (this.current) void this.current.el.play().catch(() => {});
    else this.playFile(this.pickFile(this.phase));
  }

  applySettings(s: AudioSettings): void {
    this.settings = { ...s };
    this.sfx.volume = s.effects;
    this.sfx.muted = s.muted;
    this.sfx.apply();
    for (const el of [this.current?.el, this.fadingOut, this.voice, this.loop, this.remote]) if (el) el.muted = s.muted;
    if (this.voice) this.voice.volume = s.voice;
    if (this.remote) this.remote.volume = s.voice;
    if (this.loop && !this.fades.has(this.loop)) this.loop.volume = s.voice;
    this.applyMusicVolume(0.3);
  }

  get currentTrack(): string | null {
    return this.current?.file ?? null;
  }

  get musicPhase(): MusicPhase {
    return this.phase;
  }

  // ---- music ----------------------------------------------------------------------------------

  /** Upward changes (calmer → tenser) are immediate; calmer phases must be requested for 5 s before they take over. */
  setPhase(phase: MusicPhase): void {
    const now = performance.now();
    if (phase !== this.wanted) {
      this.wanted = phase;
      this.wantedSince = now;
    }
    if (phase === this.phase) return;
    const immediate = RANK[phase] > RANK[this.phase] || phase === 'title';
    if (immediate || now - this.wantedSince >= DOWNSHIFT_HOLD_MS) {
      this.phase = phase;
      this.playFile(this.pickFile(phase));
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.applyMusicVolume(0.4);
  }

  private pickFile(phase: MusicPhase): string {
    const list = PLAYLIST[phase];
    return phase === 'explore' ? list[this.exploreIndex++ % list.length] : list[0];
  }

  private musicGain(): number {
    return this.settings.music * (this.ducked > 0 ? DUCK : 1) * (this.paused ? PAUSE_DUCK : 1);
  }

  private applyMusicVolume(seconds: number): void {
    if (this.current) this.fade(this.current.el, this.musicGain(), seconds, false);
  }

  private playFile(file: string): void {
    if (!this.unlocked || this.current?.file === file) return;
    if (this.fadingOut) this.stopElement(this.fadingOut); // bounded: at most one track fading out
    if (this.current) {
      this.fadingOut = this.current.el;
      this.fade(this.current.el, 0, CROSSFADE_S, true);
    }
    const el = new Audio(MUSIC_BASE + file);
    el.loop = true;
    el.preload = 'auto';
    el.volume = 0;
    el.muted = this.settings.muted;
    this.current = { el, file };
    void el.play().catch(() => {});
    this.fade(el, this.musicGain(), CROSSFADE_S, false);
  }

  // ---- voice slot: haunt speech, chant cues, optional listening -------------------------------

  /** Plays speech. `queue` lets server lines wait (max 2); intros and chants never queue. Returns whether accepted. */
  say(item: VoiceItem, queue = false): boolean {
    if (!this.unlocked) return false;
    if (this.voice) {
      if (!queue || this.queue.length >= VOICE_QUEUE_MAX) return false;
      this.queue.push(item);
      return true;
    }
    this.startVoice(item);
    return true;
  }

  /**
   * Ritual cue for an accepted invocation/recovery: rate-limited per file, and it takes priority over a
   * haunt intro or server line (which is cut); behind another cue it waits as the single pending cue.
   */
  cue(url: string, caption: string, speaker: string): void {
    if (!this.unlocked) return;
    const now = performance.now();
    if (now - (this.lastCue.get(url) ?? -Infinity) < CUE_MIN_INTERVAL_MS) return;
    this.lastCue.set(url, now);
    void this.available(url).then((ok) => {
      if (!ok) return;
      const item: VoiceItem = { url, caption, speaker, priority: true };
      if (!this.voice) this.startVoice(item);
      else if (this.voiceItem?.priority) this.nextCue = item;
      else {
        this.stopVoice();
        this.startVoice(item);
      }
    });
  }

  /** The Source's remote WebRTC audio follows the voice volume and mute like every other voice. */
  attachRemoteAudio(el: HTMLAudioElement): void {
    this.remote = el;
    el.volume = this.settings.voice;
    el.muted = this.settings.muted;
  }

  /** Ducks music while an external voice (The Source) is audibly answering. */
  setExternalSpeech(active: boolean): void {
    if (active === this.externalSpeech) return;
    this.externalSpeech = active;
    this.duck(active ? 1 : -1);
  }

  /** Optional listening from Settings: replaces whatever is in the voice slot; null stops. */
  listen(url: string | null): void {
    this.stopVoice();
    if (url) this.say({ url });
  }

  get speaking(): boolean {
    return this.voice !== null;
  }

  stopVoice(): void {
    this.queue.length = 0;
    const el = this.voice;
    if (!el) return;
    el.pause();
    this.endVoice(el);
  }

  private startVoice(item: VoiceItem): void {
    const el = new Audio(item.url);
    el.preload = 'auto';
    el.volume = this.settings.voice;
    el.muted = this.settings.muted;
    this.voice = el;
    this.voiceItem = item;
    this.duck(1);
    const done = () => this.endVoice(el);
    el.addEventListener('ended', done);
    el.addEventListener('error', done);
    this.voiceTimer = window.setTimeout(() => {
      el.pause();
      done();
    }, VOICE_MAX_S * 1000);
    el.play()
      .then(() => {
        if (item.caption) this.onCaption(item.caption, item.speaker);
      })
      .catch(done);
  }

  private endVoice(el: HTMLAudioElement): void {
    if (this.voice !== el) return;
    window.clearTimeout(this.voiceTimer);
    this.voice = null;
    this.voiceItem = null;
    this.duck(-1);
    const next = this.nextCue ?? this.queue.shift();
    this.nextCue = null;
    if (next) this.startVoice(next);
  }

  // ---- loop: Maha Mrityunjaya while fallen ----------------------------------------------------

  startLoop(url: string, caption: string, speaker: string): void {
    this.loopWanted = true;
    if (this.loop || !this.unlocked) return;
    void this.available(url).then((ok) => {
      if (!ok || this.loop || !this.loopWanted) return;
      const el = new Audio(url);
      el.loop = true;
      el.preload = 'auto';
      el.volume = 0;
      el.muted = this.settings.muted;
      this.loop = el;
      this.duck(1);
      el.play()
        .then(() => this.onCaption(caption, speaker))
        .catch(() => this.stopLoop());
      this.fade(el, this.settings.voice, 1.5, false);
    });
  }

  stopLoop(): void {
    this.loopWanted = false;
    const el = this.loop;
    if (!el) return;
    this.loop = null;
    this.duck(-1);
    this.fade(el, 0, 2, true);
  }

  /** Return to title: silence every voice/chant/loop and go back to the title track. */
  stopSession(): void {
    this.stopVoice();
    this.nextCue = null;
    this.stopLoop();
    this.setExternalSpeech(false);
    this.remote = null;
    this.lastCue.clear();
    this.paused = false;
    this.setPhase('title');
  }

  // ---- availability probe (missing recitations must not spam the network) ---------------------

  async available(url: string): Promise<boolean> {
    const cached = this.probes.get(url);
    const now = Date.now();
    if (cached && (cached.ok || now - cached.at < PROBE_RETRY_MS)) return cached.ok;
    let ok = false;
    try {
      const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      // Dev/SPA servers answer missing files with an HTML 200, so the content type is the real signal.
      ok = r.ok && (r.headers.get('content-type') ?? '').startsWith('audio/');
    } catch {
      ok = false;
    }
    this.probes.set(url, { ok, at: now });
    return ok;
  }

  // ---- internals ------------------------------------------------------------------------------

  private duck(delta: number): void {
    this.ducked = Math.max(0, this.ducked + delta);
    this.applyMusicVolume(0.4);
  }

  private fade(el: HTMLAudioElement, target: number, seconds: number, stopAtZero: boolean): void {
    const clamped = Math.max(0, Math.min(1, target));
    this.fades.set(el, { target: clamped, perSecond: Math.max(0.05, Math.abs(clamped - el.volume) / Math.max(0.05, seconds)), stopAtZero });
    if (this.fadeTimer) return;
    let last = performance.now();
    this.fadeTimer = window.setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      for (const [node, f] of this.fades) {
        const d = f.target - node.volume;
        const step = f.perSecond * dt;
        node.volume = Math.abs(d) <= step ? f.target : node.volume + Math.sign(d) * step;
        if (node.volume === f.target) {
          this.fades.delete(node);
          if (f.stopAtZero && f.target === 0) this.stopElement(node);
        }
      }
      if (!this.fades.size) {
        window.clearInterval(this.fadeTimer);
        this.fadeTimer = 0;
      }
    }, 50);
  }

  private stopElement(el: HTMLAudioElement): void {
    el.pause();
    this.fades.delete(el);
    if (this.fadingOut === el) this.fadingOut = null;
  }
}

/** Synthesized invocation/hit cues (no sample assets exist), so the Effects slider controls something real. */
class Sfx {
  volume = 0.7;
  muted = false;
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;

  unlock(): void {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        this.gain = this.ctx.createGain();
        this.gain.connect(this.ctx.destination);
      } catch {
        return;
      }
    }
    void this.ctx.resume();
    this.apply();
  }

  apply(): void {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }

  cast(power: PowerId): void {
    const f = { ganesha: 330, hanuman: 392, shiva: 523, vishnu: 440 }[power];
    this.tone(f, f * 1.5, 0.35, 'sine', 0.22);
    this.tone(f / 2, f, 0.5, 'triangle', 0.1);
  }

  hit(): void {
    this.noise(0.12, 0.18);
  }

  hurt(): void {
    this.tone(110, 55, 0.18, 'sawtooth', 0.18);
  }

  banish(): void {
    [523, 659, 784].forEach((f, i) => window.setTimeout(() => this.tone(f, f, 0.6, 'sine', 0.16), i * 90));
  }

  private ready(): AudioContext | null {
    return this.ctx && this.gain && this.ctx.state === 'running' ? this.ctx : null;
  }

  private tone(from: number, to: number, seconds: number, type: OscillatorType, peak: number): void {
    const ctx = this.ready();
    if (!ctx || !this.gain) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + seconds);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    osc.connect(g).connect(this.gain);
    osc.start(t);
    osc.stop(t + seconds + 0.05);
  }

  private noise(seconds: number, peak: number): void {
    const ctx = this.ready();
    if (!ctx || !this.gain) return;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = peak;
    src.connect(g).connect(this.gain);
    src.start();
  }
}
