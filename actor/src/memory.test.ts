import { describe, expect, test } from 'bun:test';
import { EMPTY_DEITY, EMPTY_GHOST, applyBanishment, applyInvocations, applyKill, counterStrategy, deityContext, recall, withStrategy } from './memory.ts';

const ep = (eventId: string, power: 'ganesha' | 'hanuman' | 'shiva' | 'vishnu', hunterId = 'h1') => ({ eventId, at: 1000, roomId: 'bellgrave', hunterId, hunterName: 'Ayla', power, distance: 6 });

describe('ghost memory reducers', () => {
  test('banishments accumulate, duplicates are ignored, tactic counters the power', () => {
    let m = applyBanishment(EMPTY_GHOST, ep('e1', 'shiva'));
    m = applyBanishment(m, ep('e1', 'shiva')); // duplicate delivery
    m = applyBanishment(m, ep('e2', 'shiva'));
    m = applyBanishment(m, ep('e3', 'vishnu'));
    expect(m.banishments).toBe(3);
    expect(m.grudges.h1).toMatchObject({ banishments: 3, lastPower: 'vishnu', powers: { shiva: 2, vishnu: 1 } });
    expect(m.strategy).toBe(counterStrategy('vishnu'));
    expect(m.episodes).toHaveLength(3);
    expect(EMPTY_GHOST.banishments).toBe(0); // never mutated in place
  });

  test('recall picks the tactic against the hunter favourite power and cites episodes', () => {
    let m = applyBanishment(EMPTY_GHOST, ep('e1', 'shiva'));
    m = applyBanishment(m, ep('e2', 'shiva'));
    m = applyBanishment(m, ep('e3', 'ganesha'));
    m = applyKill(m, { eventId: 'k1', at: 2000, roomId: 'bellgrave', hunterId: 'h1', hunterName: 'Ayla' });
    const r = recall(m, 'h1');
    expect(r.known).toBe(true);
    expect(r.tactic).toBe(counterStrategy('shiva'));
    expect(r.summary).toContain('3 times');
    expect(r.summary).toContain('Shiva');
    expect(r.summary).toContain('felled them 1 time');
    expect(r.episodes.map((e) => e.eventId)).toEqual(['e1', 'e2', 'e3', 'k1']);
    expect(recall(m, 'stranger').known).toBe(false);
  });

  test('arrays stay bounded and strategy changes are idempotent per event', () => {
    let m = EMPTY_GHOST;
    for (let i = 0; i < 400; i++) m = applyBanishment(m, ep(`e${i}`, 'ganesha', `h${i % 5}`));
    expect(m.banishments).toBe(400);
    expect(m.episodes.length).toBeLessThanOrEqual(60);
    expect(m.seen.length).toBeLessThanOrEqual(300);
    const s = withStrategy(m, 'ambush', 'tactic-1');
    expect(s.strategy).toBe('ambush');
    expect(withStrategy(s, 'ambush', 'tactic-1')).toBe(s);
    expect(withStrategy(s, 'teleport' as never, 'tactic-2')).toBe(s);
  });
});

describe('deity memory reducers', () => {
  test('invocations aggregate across rooms and the context knows returning hunters', () => {
    const inv = (eventId: string, roomId: string, hunterId: string, banished: boolean) => ({ eventId, at: 1, roomId, hunterId, hunterName: 'Ayla', enemyId: 'vesper', enemyLevel: 6, banished });
    let d = applyInvocations(EMPTY_DEITY, [inv('i1', 'bellgrave', 'h1', false), inv('i2', 'bellgrave', 'h1', true), inv('i2', 'bellgrave', 'h1', true)]);
    d = applyInvocations(d, [inv('i3', 'other-room', 'h2', false)]);
    expect(d).toMatchObject({ invocations: 3, banishments: 1 });
    expect(Object.keys(d.rooms)).toEqual(['bellgrave', 'other-room']);
    expect(deityContext(d, 'h1')).toMatchObject({ known: true });
    expect(deityContext(d, 'h1').summary).toContain('2 rooms');
    expect(deityContext(d, 'nobody').known).toBe(false);
    expect(deityContext(d).citedEventIds).toEqual(['i1', 'i2', 'i3']);
  });
});
