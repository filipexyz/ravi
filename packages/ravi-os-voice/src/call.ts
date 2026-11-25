import { RaviClient, RaviStreamClient, createHttpTransport } from "@ravi-os/sdk";
import type { VoiceCallStreamPayload } from "@ravi-os/sdk/streaming";
import type { VoiceCallsStartReturn } from "@ravi-os/sdk/types";

export type VoiceMode = "push" | "live" | "handsfree" | "mock";
export type VoiceEvent = VoiceCallStreamPayload;
export type VoiceEventType = VoiceEvent["type"];

export interface RaviVoiceConfig {
  /** Base URL of the Ravi gateway, e.g. `http://127.0.0.1:7777`. */
  baseUrl: string;
  /** A device key from `ravi voice devices pair` (or any runtime key allowed to call). */
  contextKey: string;
  fetch?: typeof fetch;
}

export interface OpenApproval {
  approvalId: string;
  version: number;
  digest: string;
  text: string;
}

type Listener = (event: VoiceEvent) => void | Promise<void>;

/** The two SDK clients a voice app needs, built from one key. */
export function createRaviVoice(config: RaviVoiceConfig) {
  const client = new RaviClient(createHttpTransport(config));
  const stream = new RaviStreamClient(config);
  return {
    client,
    stream,
    /** Sessions this key may open a call on. */
    targets: () => client.voice.targets.list(),
    /**
     * Open a call on a session. For `live` pass the WebRTC offer (see
     * `connectLive`); for `handsfree` join the returned room (see `joinRoom`).
     */
    async start(session: string, options: { mode?: VoiceMode; profile?: string; offer?: string } = {}) {
      const started = await client.voice.calls.start(session, options);
      return new RaviVoiceCall(client, stream, started);
    },
    /** Reattach to a call you already have (e.g. after a page reload). */
    attach(callId: string, lastSeq = 0) {
      return new RaviVoiceCall(client, stream, { callId, lastSeq } as VoiceCallsStartReturn);
    },
  };
}

/**
 * One call. `follow()` keeps the event stream open and resumes from the last
 * `seq` after a drop; `on()` subscribes to event types.
 */
export class RaviVoiceCall {
  readonly id: string;
  readonly info: VoiceCallsStartReturn;
  private lastSeq: number;
  private listeners = new Map<string, Set<Listener>>();
  private abort: AbortController | null = null;
  private approvals = new Map<string, OpenApproval>();

  constructor(
    readonly client: RaviClient,
    private readonly stream: RaviStreamClient,
    info: VoiceCallsStartReturn,
  ) {
    this.info = info;
    this.id = info.callId;
    this.lastSeq = info.lastSeq ?? 0;
  }

  /** Subscribe to one event type, or `*` for all. Returns the unsubscribe function. */
  on(type: VoiceEventType | "*", listener: Listener): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
    return () => set?.delete(listener);
  }

  /** Requests waiting for a tap in this call. */
  openApprovals(): OpenApproval[] {
    return [...this.approvals.values()];
  }

  /** Follow the call until it ends or `close()` is called, reconnecting with backoff. */
  async follow(): Promise<void> {
    if (this.abort) return;
    const abort = new AbortController();
    this.abort = abort;
    let delay = 500;
    while (!abort.signal.aborted) {
      try {
        for await (const message of this.stream.voiceCall(this.id, { after: this.lastSeq, signal: abort.signal })) {
          if (message.event === "end") return;
          const event = message.data;
          if (event.type !== "call.snapshot") this.lastSeq = Math.max(this.lastSeq, event.seq);
          this.track(event);
          this.dispatch(event);
          delay = 500;
          if (event.type === "call.ended") return;
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        this.dispatch({ callId: this.id, seq: this.lastSeq, type: "error", data: { code: "STREAM_DROPPED", error: String(error) } });
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 8000);
    }
  }

  /** Stop following (the call keeps running; use `end()` to end it). */
  close(): void {
    this.abort?.abort();
    this.abort = null;
  }

  say(text: string) {
    return this.client.voice.calls.send(this.id, [text]);
  }

  /** Push-to-talk: send one recorded clip. */
  async push(clip: Blob) {
    return this.client.voice.calls.push(this.id, { audioData: await blobToBase64(clip), mime: clip.type || "audio/webm" });
  }

  /** Stop speaking now; running work continues in the session. */
  silence() {
    return this.client.voice.calls.silence(this.id);
  }

  cancelTurn(turn?: string) {
    return this.client.voice.calls.cancelTurn(this.id, turn ? { turn } : {});
  }

  /** Approve with a tap. Sends the version and digest the call showed, so a changed request is refused. */
  approve(approvalId: string) {
    const open = this.approvals.get(approvalId);
    return this.client.voice.calls.approve(this.id, approvalId, {
      execute: true,
      ...(open ? { version: String(open.version), digest: open.digest } : {}),
    });
  }

  deny(approvalId: string) {
    return this.client.voice.calls.deny(this.id, approvalId);
  }

  /** Fetch a synthesized clip named in `agent.transcript.data.audio.item`. */
  async audio(item: string): Promise<Blob> {
    const clip = await this.client.voice.calls.audio(this.id, item);
    return base64ToBlob(clip.audioBase64 ?? "", clip.mime);
  }

  connect(offer?: string) {
    return this.client.voice.calls.connect(this.id, offer ? { offer } : {});
  }

  async end() {
    this.close();
    return this.client.voice.calls.end(this.id);
  }

  private track(event: VoiceEvent): void {
    if (event.type === "call.snapshot") {
      const open = (event.data.openApprovals as OpenApproval[] | undefined) ?? [];
      this.approvals = new Map(open.map((item) => [item.approvalId, item]));
      // The snapshot's lastSeq is only a high-water mark: the replayed events
      // after the cursor still follow, and the cursor moves as each one arrives.
    } else if (event.type === "turn.approval_requested") {
      const data = event.data as unknown as OpenApproval;
      this.approvals.set(data.approvalId, {
        approvalId: data.approvalId,
        version: Number(data.version ?? 1),
        digest: data.digest,
        text: data.text,
      });
    } else if (event.type === "turn.approval_resolved") {
      this.approvals.delete(String(event.data.approvalId));
    }
  }

  private reportListenerError(event: VoiceEvent, error: unknown): void {
    if (event.type === "error") return;
    this.dispatch({
      callId: this.id,
      seq: this.lastSeq,
      type: "error",
      data: { code: "LISTENER_FAILED", for: event.type, error: String(error) },
    });
  }

  private dispatch(event: VoiceEvent): void {
    for (const key of [event.type, "*"]) {
      for (const listener of this.listeners.get(key) ?? []) {
        // A listener error, sync or async, must not stop the stream.
        try {
          const result = listener(event);
          if (result && typeof (result as Promise<void>).catch === "function") {
            (result as Promise<void>).catch((error) => this.reportListenerError(event, error));
          }
        } catch (error) {
          this.reportListenerError(event, error);
        }
      }
    }
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBlob(b64: string, mime: string): Blob {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
