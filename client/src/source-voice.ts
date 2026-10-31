/**
 * The Source: a game character voiced through the OpenAI Realtime GA WebRTC flow, using only native
 * browser APIs. The client never holds a model id, instructions or the main API key: it asks our own
 * backend for a short-lived client secret (kept in memory only), posts its SDP offer with that secret,
 * and exchanges events over the "oai-events" data channel. Nothing connects or opens a microphone until
 * an explicit user gesture, and `stop()` tears every track, channel and element down.
 */
export type SourceStatus = 'idle' | 'connecting' | 'live' | 'error' | 'closed';

export interface SourceHandlers {
  onStatus(status: SourceStatus, detail: string): void;
  /** Partial updates replace the current line of that role until `final`. */
  onTranscript(role: 'source' | 'you', text: string, final: boolean): void;
  /** True while The Source is audibly answering (used to duck music). */
  onSpeaking(active: boolean): void;
  /** Remote audio element, so volume/mute settings can be applied to it. */
  onRemoteAudio(el: HTMLAudioElement): void;
  /** Fresh authoritative context for the get_game_state tool; returned opaque to the model. */
  fetchContext(): Promise<unknown>;
}

const SESSION_URL = '/api/source/session';
const CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const KICKOFF = 'I have just entered Bellgrave. Introduce yourself and tell me where to begin.';
export const DIRECTIONS = 'Where should I go next? Check my current state first.';
const MAX_SEEN_CALLS = 50;
const SETUP_DEADLINE_MS = 20000; // whole setup: secret, SDP exchange, channel open
const FETCH_TIMEOUT_MS = 15000;

interface RealtimeEvent {
  type: string;
  delta?: string;
  transcript?: string;
  text?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  error?: { message?: string };
}

export class SourceVoice {
  status: SourceStatus = 'idle';
  hasMic = false;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private mic: MediaStream | null = null;
  private held = false;
  private generation = 0;
  private sourceLine = '';
  private readonly seenCalls: string[] = [];
  /** Only one response may write the default conversation at a time (Realtime API rule). */
  private responseActive = false;
  private awaitingToolOutput = false;
  private pendingTurn: string | null = null; // a single bounded slot; a newer turn replaces an older one
  private openedResolve: ((ok: boolean) => void) | null = null;
  private setupTimer = 0;

  constructor(private readonly playerKey: string, private readonly roomId: string, private readonly h: SourceHandlers) {}

  get live(): boolean {
    return this.status === 'live' && this.dc?.readyState === 'open';
  }

  /**
   * Called from a user gesture. Resolves true once the data channel is open. `withMic` on a live text-only
   * session reconnects with the microphone. `firstTurn` is folded into the single opening response so the
   * introduction and the player's first question never race as two responses.
   */
  async connect(withMic: boolean, firstTurn: string | null = null): Promise<boolean> {
    if (this.status === 'connecting') return false;
    if (this.live && (!withMic || this.hasMic)) return true;
    this.teardown('idle', '');
    const gen = ++this.generation;
    this.setStatus('connecting', withMic ? 'asking for the microphone…' : 'connecting…');
    this.setupTimer = window.setTimeout(() => {
      if (gen === this.generation && this.status === 'connecting') this.teardown('error', 'The Source did not answer in time. Try again.');
    }, SETUP_DEADLINE_MS);

    let mic: MediaStream | null = null;
    if (withMic) {
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        this.setStatus('connecting', 'microphone unavailable; text still works');
      }
      if (gen !== this.generation) {
        mic?.getTracks().forEach((t) => t.stop());
        return false;
      }
    }

    let secret: string;
    try {
      const res = await fetch(SESSION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerKey: this.playerKey, roomId: this.roomId }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`session ${res.status}`);
      // expiresAt is the credential's TTL for this SDP setup only; it never bounds a healthy RTC session.
      const body = (await res.json()) as { clientSecret?: string; expiresAt?: number };
      if (!body.clientSecret) throw new Error('no client secret');
      secret = body.clientSecret;
    } catch (err) {
      mic?.getTracks().forEach((t) => t.stop());
      if (gen === this.generation) this.setStatus('error', `The Source is unavailable (${err instanceof Error ? err.message : 'request failed'}).`);
      return false;
    }
    if (gen !== this.generation) {
      mic?.getTracks().forEach((t) => t.stop());
      return false;
    }

    const pc = new RTCPeerConnection();
    this.pc = pc;
    const audioEl = new Audio();
    audioEl.autoplay = true;
    this.audioEl = audioEl;
    this.h.onRemoteAudio(audioEl);
    pc.ontrack = (e) => {
      if (gen !== this.generation) return;
      audioEl.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      void audioEl.play().catch(() => {});
    };
    if (mic) {
      this.mic = mic;
      this.hasMic = true;
      for (const track of mic.getAudioTracks()) {
        track.enabled = this.held; // transmit only while V / the button is actually held
        pc.addTrack(track, mic);
      }
    } else {
      this.hasMic = false;
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    const dc = pc.createDataChannel('oai-events');
    this.dc = dc;
    dc.onmessage = (e) => {
      if (gen === this.generation) this.handleEvent(e.data);
    };
    dc.onclose = () => {
      if (gen === this.generation && this.status === 'live') this.teardown('closed', 'The Source fell silent (channel closed).');
    };
    pc.onconnectionstatechange = () => {
      if (gen !== this.generation) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') this.teardown('error', 'Connection to The Source was lost.');
    };
    const opened = new Promise<boolean>((resolve) => {
      this.openedResolve = resolve; // teardown settles it with false
      dc.onopen = () => resolve(gen === this.generation);
    });

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = await fetch(CALLS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/sdp' },
        body: offer.sdp ?? '',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`realtime ${res.status}`);
      const answer = await res.text();
      if (gen !== this.generation) return false;
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    } catch (err) {
      if (gen === this.generation) this.teardown('error', `Could not reach The Source (${err instanceof Error ? err.message : 'network error'}).`);
      return false;
    }
    const ok = await opened;
    if (!ok || gen !== this.generation) return false;
    window.clearTimeout(this.setupTimer);
    this.openedResolve = null;
    this.setStatus('live', this.hasMic ? 'live · hold V or the mic button to speak' : 'live · text only (no microphone)');
    // One opening response: the introduction request, with the player's first question folded in if there was one.
    this.sendUserText(firstTurn ? `${KICKOFF} Then answer this: ${firstTurn}` : KICKOFF, false);
    return true;
  }

  /** Push-to-talk. The mic track transmits only while held; server-side VAD segments the speech. */
  setHeld(held: boolean): void {
    this.held = held;
    for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = held;
  }

  sendText(text: string): void {
    const clean = text.trim().slice(0, 400);
    if (!clean) return;
    this.sendUserText(clean, true);
  }

  askDirections(): void {
    this.sendUserText(DIRECTIONS, true);
  }

  stop(): void {
    this.teardown('idle', '');
  }

  /** Starts a response for a user turn, or parks it (single slot) while another response is still writing. */
  private sendUserText(text: string, echo: boolean): void {
    if (!this.live || !this.dc) return;
    if (echo) this.h.onTranscript('you', text, true);
    if (this.responseActive || this.awaitingToolOutput) {
      this.pendingTurn = text;
      return;
    }
    this.dc.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }));
    this.dc.send(JSON.stringify({ type: 'response.create' }));
    this.responseActive = true;
  }

  /** Called when a response finishes: the tool continuation has precedence, then the parked user turn. */
  private flushPending(): void {
    if (this.awaitingToolOutput || !this.pendingTurn) return;
    const text = this.pendingTurn;
    this.pendingTurn = null;
    this.sendUserText(text, false);
  }

  private handleEvent(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let ev: RealtimeEvent;
    try {
      ev = JSON.parse(raw) as RealtimeEvent;
    } catch {
      return;
    }
    switch (ev.type) {
      case 'response.output_audio_transcript.delta':
      case 'response.output_text.delta':
        this.sourceLine += ev.delta ?? '';
        this.h.onTranscript('source', this.sourceLine, false);
        return;
      case 'response.output_audio_transcript.done':
      case 'response.output_text.done':
        this.h.onTranscript('source', ev.transcript ?? ev.text ?? this.sourceLine, true);
        this.sourceLine = '';
        return;
      case 'conversation.item.input_audio_transcription.completed':
        if (ev.transcript) this.h.onTranscript('you', ev.transcript, true);
        return;
      case 'output_audio_buffer.started':
        this.h.onSpeaking(true);
        return;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.h.onSpeaking(false);
        return;
      case 'response.done':
      case 'response.cancelled':
        this.h.onSpeaking(false);
        this.responseActive = false;
        this.flushPending();
        return;
      case 'response.function_call_arguments.done':
        if (ev.name === 'get_game_state' && ev.call_id && !this.seenCalls.includes(ev.call_id)) {
          this.awaitingToolOutput = true; // the parked user turn waits until the tool continuation has been sent
          void this.answerStateCall(ev.call_id);
        }
        return;
      case 'error':
        this.setStatus('error', ev.error?.message ?? 'The Source reported an error.');
        return;
    }
  }

  /** The tool has no arguments: fetch fresh authoritative context and hand it back verbatim, once per call id. */
  private async answerStateCall(callId: string): Promise<void> {
    this.seenCalls.push(callId);
    if (this.seenCalls.length > MAX_SEEN_CALLS) this.seenCalls.shift();
    const gen = this.generation;
    let output: unknown;
    try {
      output = await this.h.fetchContext();
    } catch {
      output = { error: 'game context unavailable right now' };
    }
    if (gen !== this.generation || !this.live || !this.dc) return;
    // The function-call response must have finished before the continuation response starts.
    while (this.responseActive && gen === this.generation) await new Promise((r) => window.setTimeout(r, 100));
    if (gen !== this.generation || !this.live || !this.dc) return;
    this.dc.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) } }));
    this.dc.send(JSON.stringify({ type: 'response.create' }));
    this.responseActive = true;
    this.awaitingToolOutput = false;
  }

  private setStatus(status: SourceStatus, detail: string): void {
    this.status = status;
    this.h.onStatus(status, detail);
  }

  private teardown(status: SourceStatus, detail: string): void {
    this.generation += 1; // every in-flight await now ignores its result
    window.clearTimeout(this.setupTimer);
    this.openedResolve?.(false); // a pending connect() settles instead of hanging
    this.openedResolve = null;
    this.responseActive = false;
    this.awaitingToolOutput = false;
    this.pendingTurn = null;
    this.dc?.close();
    this.pc?.close();
    this.mic?.getTracks().forEach((t) => t.stop());
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.srcObject = null;
    }
    this.dc = null;
    this.pc = null;
    this.mic = null;
    this.audioEl = null;
    this.hasMic = false;
    this.sourceLine = '';
    this.h.onSpeaking(false);
    this.setStatus(status, detail);
  }
}
