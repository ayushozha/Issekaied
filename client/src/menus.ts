const SETTINGS_KEY = 'issekaied.settings';
const NAME_KEY = 'issekaied.name';

export interface Settings {
  /** Mouse-look multiplier, 0.3–3. */
  sensitivity: number;
  /** Disables head bob; for players sensitive to camera motion. */
  reduceMotion: boolean;
}

const DEFAULTS: Settings = { sensitivity: 1, reduceMotion: false };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>;
    const sens = Number(raw.sensitivity);
    return { sensitivity: Number.isFinite(sens) && sens > 0 ? clamp(sens, 0.3, 3) : DEFAULTS.sensitivity, reduceMotion: raw.reduceMotion === true };
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

export type Screen = 'splash' | 'main' | 'pause' | 'settings' | 'confirm';

export interface MenuHandlers {
  onEnter(name: string): void;
  onResume(): void;
  onReturnToTitle(): void;
  onSettings(settings: Settings): void;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

/**
 * Title, main menu, pause, settings and confirmation screens. Pure DOM over the live scene so the
 * courtyard stays visible behind every screen. Nothing here touches gameplay state; main.ts owns
 * the session and decides what Enter / Resume / Return to title actually do.
 */
export class Menus {
  settings = loadSettings();
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
  private readonly confirmTitle = $('confirm-title');
  private readonly confirmBody = $('confirm-body');
  private readonly confirmYes = $<HTMLButtonElement>('btn-confirm-yes');
  private readonly confirmNo = $<HTMLButtonElement>('btn-confirm-no');

  constructor(private readonly h: MenuHandlers) {
    this.name.value = localStorage.getItem(NAME_KEY) ?? '';

    $('screen-splash').addEventListener('click', () => this.show('main'));
    window.addEventListener('keydown', (e) => {
      if (this.screen === 'splash') this.show('main');
      else if (e.key === 'Escape' && (this.screen === 'settings' || this.screen === 'confirm')) this.show(this.returnTo);
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
    $('btn-exit').addEventListener('click', () =>
      this.confirm('Leave Bellgrave?', 'This returns you to the title screen. The browser tab stays open.', 'Leave', 'Stay', () => this.show('splash')),
    );

    $('btn-resume').addEventListener('click', () => this.h.onResume());
    $('btn-pause-settings').addEventListener('click', () => this.openSettings('pause'));
    $('btn-title').addEventListener('click', () =>
      this.confirm('Return to title?', 'Your current hunt will end.', 'Return to title', 'Keep hunting', () => this.h.onReturnToTitle()),
    );

    $('btn-back').addEventListener('click', () => this.show(this.returnTo));
    this.sens.addEventListener('input', () => this.applySettings());
    this.motion.addEventListener('change', () => this.applySettings());
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

  show(screen: Screen): void {
    this.screen = screen;
    this.root.hidden = false;
    this.root.dataset.screen = screen;
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
    this.sens.value = String(this.settings.sensitivity);
    this.motion.checked = this.settings.reduceMotion;
    this.sensOut.textContent = `${this.settings.sensitivity.toFixed(1)}×`;
    this.show('settings');
  }

  private applySettings(): void {
    this.settings = { sensitivity: clamp(Number(this.sens.value) || 1, 0.3, 3), reduceMotion: this.motion.checked };
    this.sensOut.textContent = `${this.settings.sensitivity.toFixed(1)}×`;
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
