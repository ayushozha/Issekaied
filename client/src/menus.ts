const SETTINGS_KEY = 'issekaied.settings';
const NAME_KEY = 'issekaied.name';

export interface Settings {
  /** Mouse-look multiplier, 0.3–3. */
  sensitivity: number;
  /** Disables head bob; for players sensitive to camera motion. */
  reduceMotion: boolean;
  /** Channel volumes 0–1 and a master mute. */
  music: number;
  voice: number;
  effects: number;
  muted: boolean;
}

export type Recitation = 'hanuman' | 'shiva' | 'mantra';

/** Reduced motion is on by default; a consciously saved preference (either way) is respected. */
const DEFAULTS: Settings = { sensitivity: 1, reduceMotion: true, music: 0.6, voice: 0.9, effects: 0.7, muted: false };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const unit = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : fallback);

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>;
    const sens = Number(raw.sensitivity);
    return {
      sensitivity: Number.isFinite(sens) && sens > 0 ? clamp(sens, 0.3, 3) : DEFAULTS.sensitivity,
      reduceMotion: typeof raw.reduceMotion === 'boolean' ? raw.reduceMotion : DEFAULTS.reduceMotion,
      music: unit(raw.music, DEFAULTS.music),
      voice: unit(raw.voice, DEFAULTS.voice),
      effects: unit(raw.effects, DEFAULTS.effects),
      muted: raw.muted === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode / quota): settings last for this page only */
  }
}

export type Screen = 'splash' | 'main' | 'pause' | 'settings' | 'credits' | 'confirm';

export interface MenuHandlers {
  onEnter(name: string): void;
  onResume(): void;
  onReturnToTitle(): void;
  onSettings(settings: Settings): void;
  /** First user gesture on the title screen; audio may start from here. */
  onGesture(): void;
  /** Optional listening to a full recitation from Settings; null stops. */
  onListen(kind: Recitation | null): void;
  /** Whether a recitation file exists yet (another worker is generating them). */
  recitationAvailable(kind: Recitation): Promise<boolean>;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

/**
 * Title, main menu, pause, settings, credits and confirmation screens. Pure DOM over the live scene so
 * the courtyard stays visible behind every screen. main.ts owns the session and decides what Enter,
 * Resume and Return to title actually do.
 */
export class Menus {
  settings = loadSettings();
  private inSession = false;
  private screen: Screen | null = null;
  private returnTo: Screen = 'main';
  private onConfirm: (() => void) | null = null;
  private readonly root = $('screens');
  private readonly sections = [...this.root.querySelectorAll<HTMLElement>('[data-screen]')];
  private readonly name = $<HTMLInputElement>('name');
  private readonly mainStatus = $('menu-status');
  private readonly pauseStatus = $('pause-status');
  private readonly sens = $<HTMLInputElement>('set-sensitivity');
  private readonly sensOut = $('set-sensitivity-out');
  private readonly motion = $<HTMLInputElement>('set-motion');
  private readonly music = $<HTMLInputElement>('set-music');
  private readonly voice = $<HTMLInputElement>('set-voice');
  private readonly effects = $<HTMLInputElement>('set-effects');
  private readonly muted = $<HTMLInputElement>('set-muted');
  private readonly listenButtons: Record<Recitation, HTMLButtonElement> = {
    hanuman: $<HTMLButtonElement>('btn-listen-hanuman'),
    shiva: $<HTMLButtonElement>('btn-listen-shiva'),
    mantra: $<HTMLButtonElement>('btn-listen-mantra'),
  };
  private readonly confirmTitle = $('confirm-title');
  private readonly confirmBody = $('confirm-body');
  private readonly confirmYes = $<HTMLButtonElement>('btn-confirm-yes');
  private readonly confirmNo = $<HTMLButtonElement>('btn-confirm-no');

  constructor(private readonly h: MenuHandlers) {
    this.name.value = localStorage.getItem(NAME_KEY) ?? '';

    const leaveSplash = () => {
      this.h.onGesture();
      this.show('main');
    };
    $('screen-splash').addEventListener('click', leaveSplash);
    window.addEventListener('keydown', (e) => {
      if (this.screen === 'splash') leaveSplash();
      else if (e.key === 'Escape' && (this.screen === 'settings' || this.screen === 'credits' || this.screen === 'confirm')) this.show(this.returnTo);
    });

    const enter = () => {
      persist(NAME_KEY, this.name.value);
      this.h.onEnter(this.name.value);
    };
    $('btn-enter').addEventListener('click', enter);
    this.name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') enter();
    });
    $('btn-settings').addEventListener('click', () => this.openSettings('main'));
    $('btn-credits').addEventListener('click', () => this.openCredits('main'));
    $('btn-exit').addEventListener('click', () =>
      this.confirm('Leave Bellgrave?', 'This returns you to the title screen. The browser tab stays open.', 'Leave', 'Stay', () => this.show('splash')),
    );

    $('btn-resume').addEventListener('click', () => this.h.onResume());
    $('btn-pause-settings').addEventListener('click', () => this.openSettings('pause'));
    $('btn-pause-credits').addEventListener('click', () => this.openCredits('pause'));
    $('btn-title').addEventListener('click', () =>
      this.confirm('Return to title?', 'Your current hunt will end.', 'Return to title', 'Keep hunting', () => this.h.onReturnToTitle()),
    );

    $('btn-back').addEventListener('click', () => this.closeSettings());
    $('btn-settings-credits').addEventListener('click', () => this.openCredits('settings'));
    $('btn-credits-back').addEventListener('click', () => this.show(this.returnTo === 'settings' ? 'settings' : this.returnTo));
    for (const input of [this.sens, this.music, this.voice, this.effects]) input.addEventListener('input', () => this.applySettings());
    for (const input of [this.motion, this.muted]) input.addEventListener('change', () => this.applySettings());
    for (const kind of Object.keys(this.listenButtons) as Recitation[]) this.listenButtons[kind].addEventListener('click', () => this.h.onListen(kind));
    $('btn-listen-stop').addEventListener('click', () => this.h.onListen(null));

    this.confirmYes.addEventListener('click', () => {
      const action = this.onConfirm;
      this.onConfirm = null;
      action?.();
    });
    this.confirmNo.addEventListener('click', () => this.show(this.returnTo));

    this.show('splash');
  }

  get current(): Screen | null {
    return this.screen;
  }

  /** Title screens use the painted backdrop; in-session screens (pause etc.) stay translucent over the live courtyard. */
  setInSession(inSession: boolean): void {
    this.inSession = inSession;
    this.root.classList.toggle('titled', !inSession);
  }

  show(screen: Screen): void {
    this.screen = screen;
    this.root.hidden = false;
    this.root.dataset.screen = screen;
    this.root.classList.toggle('titled', !this.inSession);
    for (const s of this.sections) s.hidden = s.dataset.screen !== screen;
    if (screen === 'main') $('btn-enter').focus();
    if (screen === 'pause') $('btn-resume').focus();
  }

  hide(): void {
    this.screen = null;
    this.root.hidden = true;
  }

  setMainStatus(text: string): void {
    this.mainStatus.textContent = text;
  }

  setPauseStatus(text: string): void {
    this.pauseStatus.textContent = text;
  }

  private openSettings(from: Screen): void {
    this.returnTo = from;
    const s = this.settings;
    this.sens.value = String(s.sensitivity);
    this.motion.checked = s.reduceMotion;
    this.music.value = String(s.music);
    this.voice.value = String(s.voice);
    this.effects.value = String(s.effects);
    this.muted.checked = s.muted;
    this.renderOutputs();
    this.show('settings');
    for (const kind of Object.keys(this.listenButtons) as Recitation[]) {
      const btn = this.listenButtons[kind];
      btn.disabled = true;
      btn.title = 'Checking for the recitation file…';
      void this.h.recitationAvailable(kind).then((ok) => {
        btn.disabled = !ok;
        btn.title = ok ? 'Recitation of the traditional text, synthesized with artificial intelligence' : 'Not generated yet';
      });
    }
  }

  private closeSettings(): void {
    this.h.onListen(null);
    this.show(this.returnTo === 'settings' ? 'main' : this.returnTo);
  }

  private openCredits(from: Screen): void {
    this.returnTo = from;
    this.show('credits');
  }

  private renderOutputs(): void {
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    this.sensOut.textContent = `${this.settings.sensitivity.toFixed(1)}×`;
    $('set-music-out').textContent = pct(this.settings.music);
    $('set-voice-out').textContent = pct(this.settings.voice);
    $('set-effects-out').textContent = pct(this.settings.effects);
  }

  private applySettings(): void {
    this.settings = {
      sensitivity: clamp(Number(this.sens.value) || 1, 0.3, 3),
      reduceMotion: this.motion.checked,
      music: unit(Number(this.music.value), DEFAULTS.music),
      voice: unit(Number(this.voice.value), DEFAULTS.voice),
      effects: unit(Number(this.effects.value), DEFAULTS.effects),
      muted: this.muted.checked,
    };
    this.renderOutputs();
    persist(SETTINGS_KEY, JSON.stringify(this.settings));
    this.h.onSettings(this.settings);
  }

  private confirm(title: string, body: string, yes: string, no: string, onYes: () => void): void {
    this.returnTo = this.screen ?? 'main';
    this.confirmTitle.textContent = title;
    this.confirmBody.textContent = body;
    this.confirmYes.textContent = yes;
    this.confirmNo.textContent = no;
    this.onConfirm = onYes;
    this.show('confirm');
    this.confirmNo.focus();
  }
}
