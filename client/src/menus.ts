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

export type Screen = 'splash' | 'main' | 'pause' | 'settings' | 'credits' | 'confirm' | 'leaderboard';

interface BoardRow { name: string; kills: number; deaths: number; joins: number; timeSeconds: number; online: boolean | null }
const BOARD_REFRESH_MS = 8000;
const MAX_STAT = 1_000_000_000;
const stat = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX_STAT, Math.max(0, Math.floor(v))) : 0);

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
  private readonly boardBody = $<HTMLTableSectionElement>('leaderboard-table-body');
  private readonly boardStatus = $('leaderboard-screen-status');
  private readonly boardEmpty = $('leaderboard-empty');
  private readonly boardRefresh = $<HTMLButtonElement>('btn-leaderboard-refresh');
  private readonly shareStatus = $('share-status');
  private readonly joinLink = $<HTMLInputElement>('join-link');
  private boardRequest: AbortController | null = null;
  private boardTimer = 0;

  constructor(private readonly h: MenuHandlers) {
    this.name.value = localStorage.getItem(NAME_KEY) ?? '';

    const leaveSplash = () => {
      this.h.onGesture();
      this.show('main');
    };
    $('screen-splash').addEventListener('click', leaveSplash);
    window.addEventListener('keydown', (e) => {
      if (this.screen === 'splash') leaveSplash();
      else if (e.key === 'Escape' && this.screen === 'leaderboard') this.closeLeaderboard();
      else if (e.key === 'Escape' && (this.screen === 'settings' || this.screen === 'credits' || this.screen === 'confirm')) this.show(this.returnTo);
    });

    $('btn-leaderboard').addEventListener('click', () => this.openLeaderboard('main'));
    this.boardRefresh.addEventListener('click', () => void this.loadLeaderboard());
    $('btn-leaderboard-back').addEventListener('click', () => this.closeLeaderboard());
    $('btn-copy-link').addEventListener('click', () => void this.copyJoinLink());

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
    if (screen !== 'leaderboard') {
      window.clearInterval(this.boardTimer); // presence refresh runs only while the board is open
      this.boardTimer = 0;
      if (this.boardRequest) {
        this.boardRequest.abort(); // never let a stale ledger request land on another screen
        this.boardRequest = null;
      }
    }
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

  private openLeaderboard(from: Screen): void {
    this.returnTo = from;
    this.show('leaderboard');
    this.boardRefresh.focus();
    void this.loadLeaderboard();
    window.clearInterval(this.boardTimer);
    this.boardTimer = window.setInterval(() => {
      if (this.screen === 'leaderboard' && !this.boardRequest) void this.loadLeaderboard();
    }, BOARD_REFRESH_MS);
  }

  private closeLeaderboard(): void {
    window.clearInterval(this.boardTimer);
    this.boardTimer = 0;
    this.boardRequest?.abort();
    this.boardRequest = null;
    this.show(this.returnTo === 'leaderboard' ? 'main' : this.returnTo);
    $('btn-leaderboard').focus();
  }

  /** Reads the existing public GET /api/leaderboard once per open/refresh; never creates a player or session. */
  private async loadLeaderboard(): Promise<void> {
    this.boardRequest?.abort();
    const request = new AbortController();
    this.boardRequest = request;
    const timeout = window.setTimeout(() => request.abort(), 5000);
    this.boardRefresh.disabled = true;
    this.boardStatus.textContent = 'Reading the ledger…';
    try {
      const response = await fetch('/api/leaderboard', { signal: request.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`http ${response.status}`);
      const body = (await response.json()) as { mode?: unknown; players?: unknown; entries?: unknown; updatedAt?: unknown; onlineCount?: unknown; total?: unknown };
      if (request.signal.aborted) return;
      const raw = Array.isArray(body.players) ? body.players : Array.isArray(body.entries) ? body.entries : null;
      if (!raw) throw new Error('malformed');
      // Every registered hunter is listed; the wrap scrolls. `online` may be absent from older payloads.
      const rows: BoardRow[] = raw.map((r) => {
        const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
        return { name: typeof o.name === 'string' ? o.name.slice(0, 36) : 'Hunter', kills: stat(o.kills), deaths: stat(o.deaths), joins: stat(o.joins), timeSeconds: stat(o.timeSeconds), online: typeof o.online === 'boolean' ? o.online : null };
      });
      this.boardBody.replaceChildren();
      for (const row of rows) {
        const tr = document.createElement('tr');
        if (row.online) tr.dataset.online = 'true';
        const presence = row.online === null ? '—' : row.online ? 'Online' : 'Offline';
        for (const value of [row.name, presence, row.kills, row.deaths, row.joins, Math.floor(row.timeSeconds / 60)]) {
          const td = document.createElement('td');
          td.textContent = String(value);
          tr.appendChild(td);
        }
        this.boardBody.appendChild(tr);
      }
      this.boardEmpty.hidden = rows.length > 0;
      const ledger = body.mode === 'supabase' ? 'Saved ledger (Supabase)' : body.mode === 'local-jsonl' ? 'Local saved ledger' : 'Ledger';
      const when = typeof body.updatedAt === 'number' && Number.isFinite(body.updatedAt) ? ` · ${new Date(body.updatedAt).toLocaleTimeString()}` : '';
      const online = typeof body.onlineCount === 'number' ? body.onlineCount : rows.filter((r) => r.online).length;
      this.boardStatus.textContent = rows.length ? `${ledger} · ${rows.length} hunters · ${online} online${when}` : `${ledger} · no hunters recorded yet${when}`;
    } catch (err) {
      if (request.signal.aborted && this.boardRequest !== request) return; // left the screen or refreshed
      this.boardStatus.textContent = (err as Error)?.name === 'AbortError' ? 'Leaderboard timed out · try Refresh' : 'Leaderboard unavailable · try Refresh';
    } finally {
      window.clearTimeout(timeout);
      if (this.boardRequest === request) this.boardRequest = null;
      this.boardRefresh.disabled = false;
    }
  }

  /** Clean public link: origin + path only, never query, hash or the stored guest key. */
  private async copyJoinLink(): Promise<void> {
    const link = `${location.origin}${location.pathname}`;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(link);
      this.joinLink.hidden = true;
      this.shareStatus.textContent = 'Link copied. Friends open it and enter a name.';
    } catch {
      this.joinLink.value = link;
      this.joinLink.hidden = false;
      this.joinLink.focus();
      this.joinLink.select();
      this.shareStatus.textContent = 'Copy was blocked by the browser. The link is selected below; copy it by hand.';
    }
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
