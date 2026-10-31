import type { ClientMessage, CombatAction, GameEvent, RoomSnapshot, ServerMessage, Vec3 } from '../../shared/protocol';

export type NetStatus = 'connecting' | 'online' | 'offline' | 'failed';
type Welcome = Extract<ServerMessage, { type: 'welcome' }>;
export type InteractTarget = Extract<ClientMessage, { type: 'interact' }>['target'];

export interface NetHandlers {
  onWelcome(msg: Welcome): void;
  onSnapshot(snap: RoomSnapshot): void;
  onEvent(ev: GameEvent): void;
  /** `offline` = an attempt failed and a retry is scheduled; `failed` = auto-retries exhausted, waiting for the user. */
  onStatus(status: NetStatus, detail: string, hadWelcome: boolean): void;
  onServerError(code: string, message: string): void;
}

const KEY_STORAGE = 'issekaied.playerKey';
const MAX_AUTO_RETRIES = 4;

/** Stable random guest id for this browser. Not an identity; the server only uses it to reattach a guest. */
export function guestPlayerKey(): string {
  try {
    const existing = localStorage.getItem(KEY_STORAGE);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem(KEY_STORAGE, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}

export const sanitizeName = (raw: string): string =>
  raw.replace(/[^\p{L}\p{N} _'\-]/gu, '').trim().slice(0, 16) || 'Hunter';

/** Thin WebSocket client for the shared protocol: join, input, cast, interact; snapshots and events come back. */
export class NetClient {
  selfId: string | null = null;
  tickRate = 20;
  snapshotRate = 10;
  private ws: WebSocket | null = null;
  private seq = 0;
  private attempts = 0;
  private hadWelcome = false;
  private clockOffset = 0;
  private retry: number | undefined;
  private disposed = false;
  private readonly seen: string[] = [];
  private readonly seenSet = new Set<string>();
  readonly playerKey = guestPlayerKey();

  constructor(private readonly name: string, private readonly roomId: string, private readonly h: NetHandlers) {}

  get online(): boolean {
    return this.selfId !== null && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Server clock estimate (epoch ms) used for cooldown deadlines and return timers. */
  serverNow(): number {
    return Date.now() + this.clockOffset;
  }

  connect(): void {
    if (this.disposed) return;
    window.clearTimeout(this.retry);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    this.h.onStatus('connecting', this.attempts ? `attempt ${this.attempts + 1} of ${MAX_AUTO_RETRIES + 1}` : 'connecting', this.hadWelcome);

    ws.onopen = () => this.send({ type: 'join', v: 1, roomId: this.roomId, name: this.name, playerKey: this.playerKey });
    ws.onmessage = (e) => this.receive(e.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.selfId = null;
      this.attempts += 1;
      if (this.attempts > MAX_AUTO_RETRIES) {
        this.h.onStatus('failed', `no answer from the Bellgrave server after ${this.attempts} attempts`, this.hadWelcome);
        return;
      }
      const delay = Math.min(8000, 1000 * 2 ** Math.min(this.attempts - 1, 3));
      this.h.onStatus('offline', `retrying in ${Math.round(delay / 1000)}s`, this.hadWelcome);
      this.retry = window.setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {
      /* onclose follows and schedules the retry */
    };
  }

  /** Manual retry from the connection panel: resets the attempt budget. */
  retryNow(): void {
    this.attempts = 0;
    this.connect();
  }

  private receive(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'welcome':
        this.selfId = msg.selfId;
        this.tickRate = msg.tickRate || 20;
        this.snapshotRate = msg.snapshotRate || 10;
        this.attempts = 0;
        this.hadWelcome = true;
        this.clockOffset = msg.snapshot.serverTime - Date.now();
        this.h.onStatus('online', `room ${msg.roomId}`, true);
        this.h.onWelcome(msg);
        this.h.onSnapshot(msg.snapshot);
        break;
      case 'snapshot':
        this.clockOffset = msg.snapshot.serverTime - Date.now();
        this.h.onSnapshot(msg.snapshot);
        break;
      case 'event':
        if (this.remember(msg.eventId)) this.h.onEvent(msg);
        break;
      case 'error':
        this.h.onServerError(msg.code, msg.message);
        break;
    }
  }

  /** Delayed or duplicated events must not replay effects; the memory is bounded. */
  private remember(id: string): boolean {
    if (this.seenSet.has(id)) return false;
    this.seenSet.add(id);
    this.seen.push(id);
    if (this.seen.length > 400) this.seenSet.delete(this.seen.shift() as string);
    return true;
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Returns the sequence number used so the caller can record predicted state for reconciliation. */
  sendInput(moveX: number, moveZ: number, yaw: number, pitch: number, sprint: boolean, active: boolean): number {
    const seq = ++this.seq;
    this.send({ type: 'input', v: 1, seq, moveX, moveZ, yaw, pitch, sprint, active });
    return seq;
  }

  sendCast(aim: Vec3, action: CombatAction): void {
    this.send({ type: 'cast', v: 1, seq: ++this.seq, aim, action });
  }

  sendInteract(target: InteractTarget): void {
    this.send({ type: 'interact', v: 1, seq: ++this.seq, target });
  }

  /** Tears the socket down without firing any further handlers (no retry, no late snapshot). */
  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.retry);
    const ws = this.ws;
    this.ws = null;
    this.selfId = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    }
  }
}
