import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sandboxRunner, transpiledTactics } from './integrations/rehearsal.ts';
import { scoreEncounter, scoreTactics, type EncounterBlueprint, type RehearsalEpisode } from './tactics.ts';

const episode: RehearsalEpisode = {
  ghostId: 'vesper',
  level: 6,
  hunterId: 'abc123',
  power: 'shiva',
  distance: 6,
  history: [
    { power: 'shiva', distance: 7 },
    { power: 'ganesha', distance: 5 },
  ],
  strategies: ['chase', 'flank', 'keep_distance', 'ambush'],
};

const blueprint: EncounterBlueprint = {
  echo: 2,
  enemies: [
    { id: 'morrow', level: 1, history: [{ power: 'ganesha', distance: 12 }], strategies: ['chase', 'flank', 'keep_distance', 'ambush'] },
    { id: 'raksha', level: 9, history: [], strategies: ['chase', 'flank'] },
  ],
};

const hasNode = Bun.which('node') !== null;

describe('tactic rehearsal', () => {
  test('is deterministic and only ever returns an allowed strategy', () => {
    const a = scoreTactics(episode);
    const b = scoreTactics(episode);
    expect(a).toEqual(b);
    expect(episode.strategies).toContain(a.strategy);
    expect(Object.keys(a.scores).sort()).toEqual(['ambush', 'chase', 'flank', 'keep_distance']);
    expect(scoreTactics({ ...episode, strategies: ['flank'] }).strategy).toBe('flank');
    // Short-reach powers at long engagement range: hover outside their reach. Up close: burst from hiding.
    expect(scoreTactics({ ...episode, power: 'ganesha', distance: 12, history: [{ power: 'ganesha', distance: 12 }] }).strategy).toBe('keep_distance');
    expect(scoreTactics({ ...episode, power: 'ganesha', distance: 4, history: [{ power: 'ganesha', distance: 4 }] }).strategy).toBe('ambush');
  });

  test('an echo plan is deterministic, bounded, and keeps every haunt inside its allowed tactics', () => {
    const plan = scoreEncounter(blueprint);
    expect(plan).toEqual(scoreEncounter(blueprint));
    expect(plan.echo).toBe(2);
    expect(plan.enemies.map((e) => e.id)).toEqual(['morrow', 'raksha']);
    expect(['chase', 'flank']).toContain(plan.enemies[1].strategy);
    for (const e of plan.enemies) {
      expect(e.hpMul).toBeGreaterThanOrEqual(1);
      expect(e.hpMul).toBeLessThanOrEqual(1.5);
      expect(e.speedMul).toBeLessThanOrEqual(1.3);
      expect(e.aggroBonus).toBeLessThanOrEqual(4);
    }
    expect(scoreEncounter({ ...blueprint, echo: 50 }).enemies[0]).toMatchObject({ hpMul: 1.5, speedMul: 1.3, aggroBonus: 4 });
  });

  test.skipIf(!hasNode)('the script shipped to the Superserve sandbox runs under plain Node for both job kinds', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'issekaied-rehearsal-'));
    await writeFile(path.join(dir, 'tactics.mjs'), await transpiledTactics());
    await writeFile(path.join(dir, 'run.mjs'), sandboxRunner);
    await writeFile(path.join(dir, 'episode.json'), JSON.stringify(episode));
    await writeFile(path.join(dir, 'blueprint.json'), JSON.stringify(blueprint));
    for (const [file, expected] of [
      ['episode.json', scoreTactics(episode)],
      ['blueprint.json', scoreEncounter(blueprint)],
    ] as const) {
      const proc = Bun.spawn(['node', 'run.mjs', file], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(stderr).toBe('');
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual(expected);
    }
  });
});
