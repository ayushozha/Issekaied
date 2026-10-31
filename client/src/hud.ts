import { POWER_IDS, type EnemyState, type PlayerState, type PowerId } from '../../shared/protocol';
import { CHANNELS, channelForLevel, type Channel } from './powers';
import { STRATEGY_COLOR } from './entities';
import type { NetStatus } from './net';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

/**
 * DOM overlay. Deliberately read-only about channels: the server picks the deity for each attack,
 * so there is nothing to select here, only readiness, the current target and the last invocation.
 */
export class Hud {
  private readonly root = $('hud');
  private readonly status = $('status');
  private readonly offline = $('offline');
  private readonly target = $('target');
  private readonly targetName = $('target-name');
  private readonly targetChannel = $('target-channel');
  private readonly selfName = $('self-name');
  private readonly selfHp = $('self-hp');
  private readonly selfHpText = $('self-hp-text');
  private readonly invocationPortrait = $<HTMLImageElement>('invocation-portrait');
  private readonly invocationName = $('invocation-name');
  private readonly invocationCd = $('invocation-cd');
  private readonly channels = $('channels');
  private readonly players = $('players');
  private readonly enemies = $('enemies');
  private readonly whispers = $('whispers');
  private readonly cue = $('invoke-cue');
  private readonly cueImg = $<HTMLImageElement>('invoke-cue-img');
  private readonly cueText = $('invoke-cue-text');
  private readonly death = $('death');
  private readonly flashEl = $('flash');
  private readonly menu = $('menu');
  private readonly menuStatus = $('menu-status');
  private readonly channelEls = new Map<PowerId, HTMLLIElement>();
  private cooldowns: Record<PowerId, number> = { ganesha: 0, hanuman: 0, shiva: 0, vishnu: 0 };
  private cooldownTotal: Record<PowerId, number> = { ganesha: 1, hanuman: 1, shiva: 1, vishnu: 1 };
  private lastPower: PowerId | null = null;
  private cueTimer = 0;
  private flashTimer = 0;
  private enemyKey = '';
  private playerKey = '';

  constructor() {
    for (const id of POWER_IDS) {
      const li = document.createElement('li');
      li.title = `${CHANNELS[id].deity} · ${CHANNELS[id].band} · ${CHANNELS[id].effect}`;
      li.style.setProperty('--c', CHANNELS[id].color);
      li.dataset.ready = 'true';
      this.channels.appendChild(li);
      this.channelEls.set(id, li);
    }
    // Warm the portrait cache so the first invocation cue does not pop in late.
    for (const id of POWER_IDS) new Image().src = CHANNELS[id].portrait;
  }

  showGame(): void {
    this.root.hidden = false;
    this.menu.hidden = true;
  }

  showMenu(text = ''): void {
    this.menu.hidden = false;
    this.menuStatus.textContent = text;
  }

  setMenuStatus(text: string): void {
    this.menuStatus.textContent = text;
  }

  setStatus(kind: NetStatus, detail: string): void {
    this.status.dataset.kind = kind;
    this.status.textContent = kind === 'online' ? `Connected · ${detail}` : kind === 'offline' ? `Offline preview · ${detail}` : detail;
    this.offline.hidden = kind !== 'offline';
  }

  setSelf(p: PlayerState | null): void {
    if (!p) return;
    this.selfName.textContent = p.name;
    const hp = Math.max(0, Math.min(100, p.hp));
    this.selfHp.style.width = `${hp}%`;
    this.selfHpText.textContent = `${Math.round(hp)}`;
    this.death.hidden = p.hp > 0;
    for (const id of POWER_IDS) {
      const deadline = p.cooldowns?.[id] ?? 0;
      if (deadline > this.cooldowns[id]) this.cooldownTotal[id] = Math.max(250, deadline - Date.now());
      this.cooldowns[id] = deadline;
    }
    if (p.power && p.power !== this.lastPower) {
      this.lastPower = p.power;
      const ch = CHANNELS[p.power];
      this.invocationPortrait.src = ch.portrait;
      this.invocationPortrait.hidden = false;
      this.invocationName.textContent = `${ch.deity} · ${ch.effect}`;
      this.invocationCd.parentElement?.style.setProperty('--accent', ch.color);
    }
  }

  /** Per-frame cooldown readout. `now` is the server clock estimate in epoch ms. */
  tick(now: number): void {
    for (const id of POWER_IDS) {
      const remaining = Math.max(0, this.cooldowns[id] - now);
      this.channelEls.get(id)!.dataset.ready = remaining <= 0 ? 'true' : 'false';
      if (id === this.lastPower) {
        const frac = remaining <= 0 ? 1 : 1 - Math.min(1, remaining / this.cooldownTotal[id]);
        this.invocationCd.style.width = `${Math.round(frac * 100)}%`;
      }
    }
  }

  isReady(power: PowerId, now: number): boolean {
    return this.cooldowns[power] <= now;
  }

  setTarget(e: EnemyState | null, now: number): void {
    this.target.hidden = !e;
    if (!e) return;
    const ch = channelForLevel(e.level);
    this.targetName.textContent = `${e.name} · Lv ${e.level} ${e.species}`;
    const cd = Math.max(0, this.cooldowns[ch.id] - now);
    this.targetChannel.textContent = cd > 0 ? `${ch.deity} answers in ${(cd / 1000).toFixed(1)}s` : `${ch.deity} will answer · ${ch.effect}`;
    this.target.style.setProperty('--accent', ch.color);
  }

  setPlayers(players: PlayerState[], selfId: string | null): void {
    const key = players.map((p) => `${p.id}:${p.name}:${Math.round(p.hp)}:${p.power}`).join('|');
    if (key === this.playerKey) return;
    this.playerKey = key;
    this.players.replaceChildren(
      ...players.map((p) => {
        const li = document.createElement('li');
        if (p.id === selfId) li.className = 'me';
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.setProperty('--c', CHANNELS[p.power]?.color ?? '#ccc');
        const name = document.createElement('span');
        name.textContent = p.id === selfId ? `${p.name} (you)` : p.name;
        const mini = document.createElement('span');
        mini.className = 'mini';
        const fill = document.createElement('i');
        fill.style.width = `${Math.max(0, Math.min(100, p.hp))}%`;
        mini.appendChild(fill);
        li.append(dot, name, mini);
        return li;
      }),
    );
  }

  setEnemies(enemies: EnemyState[], now: number): void {
    const key = enemies.map((e) => `${e.id}:${Math.round(e.hp)}:${e.state}:${e.strategy}:${e.memory.banishments}:${e.memory.lastHunterName ?? ''}:${e.memory.lastPower ?? ''}:${e.state === 'banished' ? Math.ceil((e.returnsAt - now) / 1000) : ''}`).join('|');
    if (key === this.enemyKey) return;
    this.enemyKey = key;
    this.enemies.replaceChildren(
      ...enemies.map((e) => {
        const card = document.createElement('div');
        card.className = 'enemy';
        card.dataset.state = e.state;
        card.style.setProperty('--s', STRATEGY_COLOR[e.strategy] ?? '#ccc');
        const name = document.createElement('div');
        name.className = 'name';
        name.innerHTML = `<span>${esc(e.name)}</span><span class="lvl">Lv ${e.level} · ${esc(e.species)}</span>`;
        const bar = document.createElement('div');
        bar.className = 'bar foe';
        const fill = document.createElement('i');
        fill.style.width = `${e.maxHp ? Math.max(0, Math.min(100, (100 * e.hp) / e.maxHp)) : 0}%`;
        bar.appendChild(fill);
        const meta = document.createElement('div');
        meta.className = 'meta';
        const stateText = e.state === 'banished' ? `banished · back in ${Math.max(0, Math.ceil((e.returnsAt - now) / 1000))}s` : e.state;
        meta.innerHTML = `<span class="strategy">${esc(e.strategy.replace('_', ' '))}</span><span>${esc(stateText)}</span>`;
        card.append(name, bar, meta);
        if (e.memory.banishments > 0) {
          const grudge = document.createElement('div');
          grudge.className = 'grudge';
          const who = e.memory.lastHunterName ? ` · remembers ${esc(e.memory.lastHunterName)}` : '';
          const by = e.memory.lastPower ? ` (${CHANNELS[e.memory.lastPower].deity})` : '';
          grudge.textContent = `Grudge ×${e.memory.banishments}${who}${by}`;
          card.appendChild(grudge);
        }
        return card;
      }),
    );
  }

  whisper(text: string, speaker?: string, system = false): void {
    const li = document.createElement('li');
    if (system) li.className = 'system';
    if (speaker) {
      const b = document.createElement('b');
      b.textContent = `${speaker}: `;
      li.appendChild(b);
    }
    li.appendChild(document.createTextNode(text));
    this.whispers.prepend(li);
    while (this.whispers.children.length > 7) this.whispers.lastElementChild?.remove();
  }

  /** Brief invocation cue: portrait and deity line fade through, never a selectable card. */
  invocationCue(ch: Channel): void {
    window.clearTimeout(this.cueTimer);
    this.cue.hidden = true;
    this.cueImg.src = ch.portrait;
    this.cueText.textContent = `${ch.deity} answers · ${ch.effect}`;
    this.cue.style.setProperty('--accent', ch.color);
    // Re-trigger the CSS animation.
    void this.cue.offsetWidth;
    this.cue.hidden = false;
    this.cueTimer = window.setTimeout(() => (this.cue.hidden = true), 1400);
  }

  flash(color: string): void {
    window.clearTimeout(this.flashTimer);
    this.flashEl.style.setProperty('--flash', color);
    this.flashEl.classList.add('on');
    this.flashTimer = window.setTimeout(() => this.flashEl.classList.remove('on'), 90);
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
