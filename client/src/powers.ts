import { POWER_IDS, powerForEnemyLevel, type PowerId } from '../../shared/protocol';

/**
 * Presentation data for the four channels. The server decides which channel
 * answers an attack (shared `powerForEnemyLevel`); the client only renders it.
 * Motifs are abstract and respectful: lotus, wind, crescent moon, chakra wheel.
 */
export interface Channel {
  id: PowerId;
  deity: string;
  effect: string;
  color: string;
  accent: string;
  portrait: string;
  motif: string;
  band: string;
}

const svg = (body: string) =>
  `<svg viewBox="0 0 48 48" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const MOTIFS: Record<PowerId, string> = {
  ganesha: svg(
    '<path d="M24 40c-8-4-13-10-13-17 4 1 7 3 9 6 0-7 1-13 4-18 3 5 4 11 4 18 2-3 5-5 9-6 0 7-5 13-13 17z"/><circle cx="24" cy="36" r="2"/>',
  ),
  hanuman: svg('<path d="M8 18c8-6 16-6 24 0"/><path d="M10 26c10-6 18-6 28 0"/><path d="M14 34c7-4 13-4 20 0"/>'),
  shiva: svg('<path d="M30 8a16 16 0 1 0 10 28A13 13 0 0 1 30 8z"/><path d="M12 14v8M8 18h8"/>'),
  vishnu: svg(
    '<circle cx="24" cy="24" r="15"/><circle cx="24" cy="24" r="4"/><path d="M24 9v11M24 28v11M9 24h11M28 24h11M13 13l8 8M27 27l8 8M35 13l-8 8M21 27l-8 8"/>',
  ),
};

const bandLabel = (id: PowerId) => {
  const levels = Array.from({ length: 12 }, (_, i) => i + 1).filter((l) => powerForEnemyLevel(l) === id);
  return id === 'vishnu' ? `Lv ${levels[0]}+` : `Lv ${levels[0]}–${levels[levels.length - 1]}`;
};

const base: Record<PowerId, Pick<Channel, 'deity' | 'effect' | 'color' | 'accent'>> = {
  ganesha: { deity: 'Ganesha', effect: 'golden protective shockwave', color: '#f2b134', accent: '#fff1b8' },
  hanuman: { deity: 'Hanuman', effect: 'saffron wind strike', color: '#ff7a1a', accent: '#ffd0a0' },
  shiva: { deity: 'Shiva', effect: 'icy slowing pulse', color: '#67c7ff', accent: '#e4f7ff' },
  vishnu: { deity: 'Vishnu', effect: 'returning chakra', color: '#3b6cff', accent: '#ffd45a' },
};

export const CHANNELS: Record<PowerId, Channel> = Object.fromEntries(
  POWER_IDS.map((id) => [
    id,
    { id, ...base[id], portrait: `/generated/power-${id}.png`, motif: MOTIFS[id], band: bandLabel(id) },
  ]),
) as Record<PowerId, Channel>;

export const channelForLevel = (level: number): Channel => CHANNELS[powerForEnemyLevel(level)];
