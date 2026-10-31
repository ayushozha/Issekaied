import { describe, expect, test } from 'bun:test';
import { clampMove, normalizeAim, parseClientMessage, sanitizeName } from './validate.ts';

describe('client message validation', () => {
  test('accepts the three protocol messages', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'join', v: 1, roomId: 'bellgrave', name: 'Ayla', playerKey: '6f2d1c3e-aaaa-bbbb-cccc-000000000000' }))?.type).toBe('join');
    expect(parseClientMessage(JSON.stringify({ type: 'input', v: 1, seq: 1, moveX: 0.5, moveZ: -0.5, yaw: 1, pitch: 0, sprint: false }))?.type).toBe('input');
    expect(parseClientMessage(JSON.stringify({ type: 'cast', v: 1, seq: 2, aim: [0, 0, 1] }))?.type).toBe('cast');
  });

  test('rejects power selection, damage claims, bad versions, non-finite numbers, and oversized frames', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'selectPower', v: 1, power: 'vishnu' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'cast', v: 1, seq: 2, aim: [0, 0, 1], damage: 999 }))?.type).toBe('cast'); // extra keys are dropped, never trusted
    expect((parseClientMessage(JSON.stringify({ type: 'cast', v: 1, seq: 2, aim: [0, 0, 1], damage: 999 })) as unknown as { damage?: number })?.damage).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: 'cast', v: 2, seq: 2, aim: [0, 0, 1] }))).toBeNull();
    expect(parseClientMessage('{"type":"input","v":1,"seq":1,"moveX":1e309,"moveZ":0,"yaw":0,"pitch":0,"sprint":false}')).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'join', v: 1, roomId: 'bellgrave', name: 'x', playerKey: 'short' }))).toBeNull();
    expect(parseClientMessage('{' + '"a":1,'.repeat(600) + '"b":2}')).toBeNull();
    expect(parseClientMessage(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(parseClientMessage('not json')).toBeNull();
  });

  test('names, moves and aims are normalised', () => {
    expect(sanitizeName('  <script>Ayla</script>  ')).toBe('scriptAylascript');
    expect(sanitizeName('💀💀💀')).toBe('Hunter');
    expect(sanitizeName('a'.repeat(40))).toHaveLength(16);
    expect(clampMove(3, 4)).toEqual({ x: 0.6, z: 0.8 });
    expect(clampMove(0.2, 0)).toEqual({ x: 0.2, z: 0 });
    expect(normalizeAim([0, 0, 0])).toBeNull();
    expect(normalizeAim([0, 0, 10])).toBeNull();
    expect(normalizeAim([0, 0, 0.9])).toEqual([0, 0, 1]);
  });
});
