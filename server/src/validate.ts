import { z } from 'zod';
import { COMBAT_ACTIONS, type ClientMessage, type Vec3 } from '../../shared/protocol';

/** Trust boundary: every client frame is parsed and validated here before the room sees it. */
const MAX_FRAME_BYTES = 2048;
const finite = z.number().refine(Number.isFinite, 'must be finite');
const seq = z.number().int().min(0).max(2_147_483_647);

const joinSchema = z.object({
  type: z.literal('join'),
  v: z.literal(1),
  roomId: z.string().min(1).max(32).regex(/^[a-z0-9_-]+$/i),
  name: z.string().max(64),
  playerKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/),
});
const inputSchema = z.object({
  type: z.literal('input'),
  v: z.literal(1),
  seq,
  moveX: finite,
  moveZ: finite,
  yaw: finite,
  pitch: finite,
  sprint: z.boolean(),
  active: z.boolean().optional(),
});
const castSchema = z.object({
  type: z.literal('cast'),
  v: z.literal(1),
  seq,
  aim: z.tuple([finite, finite, finite]),
  action: z.enum(COMBAT_ACTIONS).optional(),
});
const interactSchema = z.object({ type: z.literal('interact'), v: z.literal(1), seq, target: z.enum(['shrine', 'portal', 'respawn']) });
const clientMessage = z.discriminatedUnion('type', [joinSchema, inputSchema, castSchema, interactSchema]);

export type JoinMessage = z.infer<typeof joinSchema>;
export type InputMessage = z.infer<typeof inputSchema>;
export type CastMessage = z.infer<typeof castSchema>;
export type InteractMessage = z.infer<typeof interactSchema>;

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_FRAME_BYTES) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = clientMessage.safeParse(json);
  return parsed.success ? (parsed.data as ClientMessage) : null;
}

/** Same rule as the client: letters, digits, space, _ ' - ; 16 chars; never empty. */
export const sanitizeName = (raw: string): string =>
  raw.replace(/[^\p{L}\p{N} _'\-]/gu, '').trim().slice(0, 16) || 'Hunter';

/** Aim must be close to a unit vector; it is renormalised so the client cannot scale reach. */
export function normalizeAim(aim: Vec3): Vec3 | null {
  const len = Math.hypot(aim[0], aim[1], aim[2]);
  if (!Number.isFinite(len) || len < 0.5 || len > 1.5) return null;
  return [aim[0] / len, aim[1] / len, aim[2] / len];
}

/** Movement intent is a direction with length at most 1; speed is the server's decision. */
export function clampMove(x: number, z: number): { x: number; z: number } {
  const len = Math.hypot(x, z);
  return len > 1 ? { x: x / len, z: z / len } : { x, z };
}

export const normalizeYaw = (yaw: number): number => {
  const twoPi = Math.PI * 2;
  return ((((yaw + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
};
export const clampPitch = (pitch: number): number => Math.min(1.5, Math.max(-1.5, pitch));
