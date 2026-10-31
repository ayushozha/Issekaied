import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config } from './config.ts';
import type { ServerEvent } from './events.ts';
import { createEventLog } from './integrations/eventlog.ts';

/** Local durable fallback: leaderboard aggregation is idempotent per event id and survives a restart. */
let dir: string;
const cfg = () => ({ dataDir: dir, supabase: {} }) as unknown as Config;
const ev = (eventId: string, kind: ServerEvent['kind'], fromId: string, toId?: string): ServerEvent => ({ type: 'event', eventId, tick: 1, kind, fromId, toId });

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'issekaied-leaderboard-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('leaderboard (local-jsonl)', () => {
  test('kills, deaths, joins and session time aggregate once per event id and persist across restart', async () => {
    const log = await createEventLog(cfg());
    expect(log.mode).toBe('local-jsonl');
    log.upsertPlayer({ id: 'aaaaaaaaaaaa', name: 'Ayla' });
    log.upsertPlayer({ id: 'bbbbbbbbbbbb', name: 'Bram <b>' });
    log.bookkeeping('r', 'join', 'aaaaaaaaaaaa', 'j1');
    log.bookkeeping('r', 'join', 'aaaaaaaaaaaa', 'j1'); // duplicate delivery
    log.bookkeeping('r', 'join', 'bbbbbbbbbbbb', 'j2');
    log.record('r', ev('k1', 'banish', 'aaaaaaaaaaaa', 'morrow'));
    log.record('r', ev('k1', 'banish', 'aaaaaaaaaaaa', 'morrow')); // duplicate
    log.record('r', ev('k2', 'banish', 'aaaaaaaaaaaa', 'nix'));
    log.record('r', ev('d1', 'death', 'bbbbbbbbbbbb', 'raksha'));
    log.record('r', ev('c1', 'cast', 'bbbbbbbbbbbb')); // not a stat
    log.bookkeeping('r', 'session', 'aaaaaaaaaaaa', 's1', 10_000);
    log.bookkeeping('r', 'session', 'aaaaaaaaaaaa', 's1', 10_000); // duplicate chunk
    log.bookkeeping('r', 'session', 'aaaaaaaaaaaa', 's2', 2_500);
    log.bookkeeping('r', 'session', 'bbbbbbbbbbbb', 's3', -5); // never negative
    const rows = await log.leaderboard(10);
    expect(rows).toEqual([
      { playerId: 'aaaaaaaaaaaa', name: 'Ayla', kills: 2, deaths: 0, joins: 1, timeSeconds: 12 },
      { playerId: 'bbbbbbbbbbbb', name: 'Bram <b>', kills: 0, deaths: 1, joins: 1, timeSeconds: 0 },
    ]);
    await log.close();

    const again = await createEventLog(cfg());
    expect(await again.leaderboard(10)).toEqual(rows); // derived from every persisted event + persisted names
    expect(await again.leaderboard(1)).toHaveLength(1);
    await again.close();
  });
});
