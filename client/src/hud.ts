import { COMBAT_ACTIONS, type AdventureState, type CombatAction, type EnemyState, type PlayerState } from '../../shared/protocol';
import { channelForLevel, type Channel } from './powers';
import type { NetStatus } from './net';
import { WORLD } from './world';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

export type ConnectionPanel = 'hidden' | 'connecting' | 'retrying' | 'lost' | 'failed';

export interface HudHandlers {
  onRetry(): void;
  onReturnToTitle(): void;
  onRespawn(): void;
  onDevPreview(): void;
}

/**
 * Compact DOM overlay: vitality, objective/sigils, target line, five real action slots with authoritative
 * cooldowns, an E prompt only when something is in reach, and two modal panels (connection, defeat).
 * Nothing here selects a deity and nothing flashes the whole screen.
 */
export class Hud {
  private readonly root = $('hud');
  private readonly status = $('status');
  private readonly previewBanner = $('preview-banner');
  private readonly target = $('target');
  private readonly targetName = $('target-name');
  private readonly targetChannel = $('target-channel');
  private readonly selfName = $('self-name');
  private readonly selfHp = $('self-hp');
  private readonly wardChip = $('ward-chip');
  private readonly objectiveText = $('objective-text');
  private readonly sigils = $('sigils');
  private readonly bossState = $('boss-state');
  private readonly nextLine = $('next-line');
  private readonly huntersLine = $('hunters-line');
  private readonly whispers = $('whispers');
  private readonly interactPrompt = $('interact-prompt');
  private readonly interactText = $('interact-text');
  private readonly cue = $('invoke-cue');
  private readonly cueImg = $<HTMLImageElement>('invoke-cue-img');
  private readonly cueText = $('invoke-cue-text');
  private readonly connection = $('connection');
  private readonly connectionTitle = $('connection-title');
  private readonly connectionBody = $('connection-body');
  private readonly btnRetry = $<HTMLButtonElement>('btn-retry');
  private readonly defeat = $('defeat');
  private readonly defeatText = $('defeat-text');
  private readonly nowPlaying = $('now-playing');
  private readonly slots = new Map<CombatAction, { fill: HTMLElement; time: HTMLElement; root: HTMLElement }>();
  private readonly interactSlot = $('slot-interact');
  private readonly sigilEls = new Map<string, HTMLLIElement>();
  private cooldowns: Record<CombatAction, number> = { primary: 0, secondary: 0, incantation: 0, heal: 0 };
  private cooldownTotal: Record<CombatAction, number> = { primary: 1, secondary: 1, incantation: 1, heal: 1 };
  private wardUntil = 0;
  private cueTimer = 0;
  private sigilKey = '';
  private leaderboardTimer = 0;
  private leaderboardRequest: AbortController | null = null;

  constructor(h: HudHandlers) {
    for (const action of COMBAT_ACTIONS) {
      const root = $(`slot-${action}`);
      this.slots.set(action, { root, fill: root.querySelector('.cd') as HTMLElement, time: root.querySelector('.time') as HTMLElement });
    }
    const adv = WORLD.adventure;
    for (const id of [...adv.sigilEnemyIds, adv.bossId]) {
      const li = document.createElement('li');
      li.dataset.id = id;
      li.className = id === adv.bossId ? 'boss' : '';
      li.title = id === adv.bossId ? 'Keeper' : `Sigil: ${id}`;
      li.textContent = id === adv.bossId ? '✦' : '◉';
      this.sigils.appendChild(li);
      this.sigilEls.set(id, li);
    }
    this.btnRetry.addEventListener('click', () => h.onRetry());
    $('btn-connection-title').addEventListener('click', () => h.onReturnToTitle());
    $('btn-respawn').addEventListener('click', () => h.onRespawn());
    $('btn-defeat-menu').addEventListener('click', () => h.onReturnToTitle());
    const dev = $<HTMLButtonElement>('btn-dev-preview');
    if (import.meta.env.DEV) {
      dev.hidden = false;
      dev.addEventListener('click', () => h.onDevPreview());
    }
    // Under pointer lock the HUD is pointer-events:none, so the wheel scrolls the leaderboard list directly.
    window.addEventListener('wheel', (e) => {
      const list = $('leaderboard-list');
      if (this.root.hidden || !document.pointerLockElement || e.ctrlKey || e.metaKey || !e.deltaY || list.scrollHeight <= list.clientHeight) return;
      const step = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? list.clientHeight : 1;
      list.scrollTop += e.deltaY * step;
      e.preventDefault();
    }, { passive: false });
  }

  show(): void {
    this.root.hidden = false;
    if (!this.leaderboardTimer) {
      void this.refreshLeaderboard();
      this.leaderboardTimer = window.setInterval(() => void this.refreshLeaderboard(), 8000);
    }
  }

  private async refreshLeaderboard(): Promise<void> {
    if (this.root.hidden || this.leaderboardRequest) return;
    const request = new AbortController();
    this.leaderboardRequest = request;
    const timeout = window.setTimeout(() => request.abort(), 5000);
    try {
      const response = await fetch('/api/leaderboard', { signal: request.signal });
      if (!response.ok) throw new Error('ledger unavailable');
      const body = await response.json() as { mode?: string; players?: unknown[]; entries?: unknown[]; onlineCount?: unknown; total?: unknown };
      if (this.root.hidden) return;
      const rows = body.players ?? body.entries;
      if (!Array.isArray(rows)) throw new Error('ledger unavailable');
      const list = $('leaderboard-list');
      list.replaceChildren();
      let online = 0;
      for (const raw of rows) {
        // Every registered hunter; the list scrolls instead of truncating.
        const row = raw as Record<string, unknown>;
        const number = (key: string) => typeof row[key] === 'number' && Number.isFinite(row[key]) ? Math.max(0, Math.floor(row[key] as number)) : 0;
        const isOnline = row.online === true; // older payloads lack the field: treated as not shown online
        if (isOnline) online += 1;
        const li = document.createElement('li');
        li.dataset.online = String(isOnline);
        const name = document.createElement('span');
        name.textContent = `${isOnline ? '● ' : ''}${typeof row.name === 'string' ? row.name.slice(0, 24) : 'Hunter'}`;
        const stats = document.createElement('strong');
        stats.textContent = `${number('kills')} / ${number('deaths')}`;
        li.append(name, stats);
        li.title = `${isOnline ? 'In Bellgrave now · ' : ''}${number('joins')} arrivals · ${Math.floor(number('timeSeconds') / 60)} minutes played`;
        list.appendChild(li);
      }
      const onlineCount = typeof body.onlineCount === 'number' ? body.onlineCount : online;
      const overflow = list.scrollHeight > list.clientHeight ? ' · wheel to browse' : '';
      $('leaderboard-status').textContent = `${body.mode === 'supabase' ? 'Saved in Supabase' : 'Local saved ledger'} · ${rows.length ? `${rows.length} hunters · ${onlineCount} online${overflow}` : 'awaiting hunters'}`;
    } catch {
      if (!this.root.hidden) $('leaderboard-status').textContent = 'Ledger unavailable · retrying';
    } finally {
      window.clearTimeout(timeout);
      if (this.leaderboardRequest === request) this.leaderboardRequest = null;
    }
  }

  /** Clears every per-session readout so a new hunt (or the title screen) starts from a blank HUD. */
  reset(): void {
    this.root.hidden = true;
    window.clearInterval(this.leaderboardTimer);
    this.leaderboardTimer = 0;
    this.leaderboardRequest?.abort();
    this.leaderboardRequest = null;
    $('leaderboard-list').replaceChildren();
    this.whispers.replaceChildren();
    this.cooldowns = { primary: 0, secondary: 0, incantation: 0, heal: 0 };
    this.wardUntil = 0;
    this.wardChip.hidden = true;
    this.selfHp.style.width = '100%';
    this.target.hidden = true;
    this.interactPrompt.hidden = true;
    this.cue.hidden = true;
    this.defeat.hidden = true;
    this.connection.hidden = true;
    this.previewBanner.hidden = true;
    this.nowPlaying.textContent = '';
    this.objectiveText.textContent = '—';
    this.bossState.textContent = '';
    this.nextLine.textContent = '';
    this.huntersLine.textContent = '';
    this.sigilKey = '';
    for (const li of this.sigilEls.values()) li.dataset.state = '';
    this.setStatus('connecting', 'Connecting…');
  }

  setStatus(kind: NetStatus, detail: string): void {
    this.status.dataset.kind = kind;
    this.status.textContent = kind === 'online' ? `Connected · ${detail}` : kind === 'connecting' ? `Connecting · ${detail}` : `Not connected · ${detail}`;
  }

  /** Dev-only synthetic preview marker; never shown for a real connection. */
  setPreviewBanner(on: boolean): void {
    this.previewBanner.hidden = !on;
  }

  setConnection(panel: ConnectionPanel, detail: string): void {
    this.connection.hidden = panel === 'hidden';
    if (panel === 'hidden') return;
    const copy: Record<Exclude<ConnectionPanel, 'hidden'>, [string, string]> = {
      connecting: ['Connecting to Bellgrave…', 'Reaching the authoritative server. Movement and actions wait until it answers.'],
      retrying: ['Connection failed', `The server did not answer; ${detail}. Nothing is simulated locally.`],
      lost: ['Connection lost', `Reconnecting (${detail}). Your hunter is frozen until the server answers.`],
      failed: ['Connection failed', `${detail}. Retry when the server is up, or return to the title.`],
    };
    const [title, body] = copy[panel];
    this.connectionTitle.textContent = title;
    this.connectionBody.textContent = body;
    this.btnRetry.disabled = panel === 'connecting';
  }

  setSelf(p: PlayerState, now: number): void {
    this.selfName.textContent = p.name;
    this.selfHp.style.width = `${Math.max(0, Math.min(100, p.hp))}%`;
    for (const action of COMBAT_ACTIONS) {
      const deadline = p.skillCooldowns?.[action] ?? 0;
      if (deadline > this.cooldowns[action]) this.cooldownTotal[action] = Math.max(250, deadline - now);
      this.cooldowns[action] = deadline;
    }
    this.wardUntil = p.wardUntil ?? 0;
  }

  /** Objective card from the authoritative adventure state; without one the card says so. */
  setAdventure(adv: AdventureState | undefined, enemies: EnemyState[], hunters: number, next: { name: string; zone: string; dist: number } | null): void {
    const world = WORLD.adventure;
    this.objectiveText.textContent = adv?.objective || 'Awaiting the keeper’s word from the server…';
    const key = `${adv?.sigils ?? -1}|${adv?.bossDefeated}|${adv?.portalReady}|${adv?.echo}|${enemies.map((e) => `${e.id}:${e.state}:${e.aggro ? 1 : 0}`).join(',')}`;
    if (key !== this.sigilKey) {
      this.sigilKey = key;
      const sealedCount = adv?.sigils ?? 0;
      world.sigilEnemyIds.forEach((id, i) => {
        const li = this.sigilEls.get(id);
        if (li) li.dataset.state = i < sealedCount ? 'sealed' : 'open';
      });
      const bossLi = this.sigilEls.get(world.bossId);
      const boss = enemies.find((e) => e.id === world.bossId);
      const bossText = adv?.bossDefeated ? 'Keeper defeated' : sealedCount >= world.sigilEnemyIds.length ? (boss?.aggro ? 'Keeper awake' : 'Keeper waits at the altar') : 'Keeper sealed';
      if (bossLi) bossLi.dataset.state = adv?.bossDefeated ? 'sealed' : sealedCount >= world.sigilEnemyIds.length ? 'open' : '';
      const portal = adv?.portalReady ? ` · Portal open${adv.echo ? ` · Echo ${adv.echo}` : ''}` : adv ? ' · Portal sealed' : '';
      this.bossState.textContent = adv ? `${bossText}${portal}` : '';
    }
    this.nextLine.textContent = next ? `Next: ${next.name} · ${next.zone} · ${Math.round(next.dist)} m` : '';
    this.huntersLine.textContent = hunters > 1 ? `${hunters} hunters in the courtyard` : '';
  }

  /** Per-frame readouts. `now` is the server clock estimate in epoch ms. */
  tick(now: number): void {
    for (const action of COMBAT_ACTIONS) {
      const slot = this.slots.get(action)!;
      const remaining = Math.max(0, this.cooldowns[action] - now);
      const frac = remaining <= 0 ? 0 : Math.min(1, remaining / this.cooldownTotal[action]);
      slot.fill.style.height = `${Math.round(frac * 100)}%`;
      slot.time.textContent = remaining > 0 ? `${(remaining / 1000).toFixed(1)}` : '';
      slot.root.dataset.ready = remaining <= 0 ? 'true' : 'false';
    }
    const ward = Math.max(0, this.wardUntil - now);
    this.wardChip.hidden = ward <= 0;
    if (ward > 0) this.wardChip.textContent = `Warded ${(ward / 1000).toFixed(1)}s`;
  }

  isReady(action: CombatAction, now: number): boolean {
    return this.cooldowns[action] <= now;
  }

  setTarget(e: EnemyState | null, dist: number, now: number): void {
    this.target.hidden = !e;
    if (!e) return;
    const ch = channelForLevel(e.level);
    this.targetName.textContent = `${e.name} · Lv ${e.level} · ${Math.round(dist)} m`;
    const cd = Math.max(0, this.cooldowns.incantation - now);
    this.targetChannel.textContent = cd > 0 ? `Q · ${ch.deity} answers in ${(cd / 1000).toFixed(1)}s` : `Q · ${ch.deity} would answer`;
    this.target.style.setProperty('--accent', ch.color);
  }

  /** E prompt: only while something is actually in reach (or while fallen). */
  setInteract(text: string | null): void {
    this.interactPrompt.hidden = !text;
    if (text) this.interactText.textContent = text;
    this.interactSlot.dataset.ready = text ? 'true' : 'false';
  }

  setDefeat(show: boolean, text?: string): void {
    this.defeat.hidden = !show;
    if (show) this.defeatText.textContent = text || 'Bellgrave holds its breath.';
  }

  whisper(text: string, speaker?: string, system = false, voice = false): void {
    const li = document.createElement('li');
    if (system) li.className = 'system';
    if (voice) li.className = 'voice';
    if (speaker) {
      const b = document.createElement('b');
      b.textContent = `${speaker}: `;
      li.appendChild(b);
    }
    li.appendChild(document.createTextNode(text));
    this.whispers.prepend(li);
    while (this.whispers.children.length > 6) this.whispers.lastElementChild?.remove();
  }

  /** Small invocation cue beside the crosshair: portrait and deity line fade through, never a selectable card. */
  invocationCue(ch: Channel): void {
    window.clearTimeout(this.cueTimer);
    this.cue.hidden = true;
    this.cueImg.src = ch.portrait;
    this.cueText.textContent = `${ch.deity} answers`;
    this.cue.style.setProperty('--accent', ch.color);
    void this.cue.offsetWidth; // restart the CSS animation
    this.cue.hidden = false;
    this.cueTimer = window.setTimeout(() => (this.cue.hidden = true), 1300);
  }

  setNowPlaying(text: string): void {
    this.nowPlaying.textContent = text;
  }
}
