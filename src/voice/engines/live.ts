/**
 * `live` engine: OpenAI GPT-Live with `delegation: client`.
 *
 * The app holds the WebRTC media directly with OpenAI. The daemon posts the
 * app's SDP offer, owns the only sideband and turns each delegation into a
 * session turn. Facts below come from OpenAI's GPT-Live docs as read on
 * 2026-11-24 (pesquisa/v1-facts-openai-gemini.md) and re-checked against the
 * sideband reference on 2026-11-26: appends carry their text in `content`;
 * transcripts stream as deltas with `start_ms`/`end_ms` and have no done
 * event; errors nest their details under `error`.
 */
import WebSocket from "ws";
import type { VoiceEngineDescriptor } from "./types.js";
import { envHas } from "./types.js";

export const LIVE_API_BASE = "https://api.openai.com/v1/live/sessions";
export const LIVE_DEFAULT_MODEL = "gpt-live-1.1";
export const LIVE_DEFAULT_VOICE = "marin";
/** US$ 0.05 per active minute (standby is US$ 0.02). */
export const LIVE_USD_PER_ACTIVE_MINUTE = 0.05;
/** Appends are capped at 500 tokens; keep each chunk well under it. */
const APPEND_CHUNK_CHARS = 1500;
/** Wait this long after a delegation for the transcript that triggered it to settle. */
export const DELEGATION_SETTLE_MS = 900;
/** A pause longer than this between transcript deltas starts a new utterance. */
export const UTTERANCE_GAP_MS = 1200;
/** Events that carry reflected audio. They are dropped on arrival, never stored or published. */
const AUDIO_EVENTS = new Set(["session.input_audio.append", "session.output_audio.delta"]);

export function liveApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.RAVI_VOICE_OPENAI_API_KEY?.trim() || null;
}

export const liveEngine: VoiceEngineDescriptor = {
  id: "live",
  label: "Live (OpenAI GPT-Live, delegação para a sessão)",
  connectionKind: "webrtc",
  capabilities: {
    bargeIn: true,
    streamingAudio: true,
    exactSpeech: false,
    serverAudio: false,
    needs: ["RAVI_VOICE_OPENAI_API_KEY"],
  },
  costPerMinuteUsd: LIVE_USD_PER_ACTIVE_MINUTE,
  check(env = process.env) {
    const missing = envHas(env, "RAVI_VOICE_OPENAI_API_KEY") ? [] : ["RAVI_VOICE_OPENAI_API_KEY"];
    const notes = [
      "Uses its own key, never OPENAI_API_KEY (Codex inherits that one). Give the key's project a spend limit.",
      "The voice model paraphrases; it never reads the session's text word for word.",
      "A daemon restart ends live calls: the sideband cannot reconnect.",
    ];
    return { engine: "live", ready: missing.length === 0, missing, notes };
  },
};

export function buildLiveInstructions(input: { language: string; sessionLabel: string }): string {
  const lang = input.language.toLowerCase().startsWith("pt") ? "Brazilian Portuguese" : input.language;
  return [
    `You are Ravi, the person's assistant, speaking for the Ravi session "${input.sessionLabel}". Speak ${lang}. Keep answers short.`,
    "You are not a generic assistant: behind you is a Ravi session with tools (messages, files, code, tasks, calendar, pages, bases).",
    "When asked what you can do, which tools or which session you have, delegate the question instead of listing generic skills.",
    "",
    "Delegation policy:",
    "- Delegate everything about the person's work, files, messages, calendar, tasks, code or anything you would need to look up. The session behind you does the work and is the only source of facts about it.",
    "- Never claim that something was done, sent, saved or found unless the session told you so.",
    "- Do not delegate greetings, small talk, or a repeat of a result the session already gave in this call.",
    "",
    "Approvals: never treat a spoken yes as approval. Tell the person to tap the approval on screen.",
    "If the person says stop or cancel, say it is cancelled only after the session confirms.",
  ].join("\n");
}

export interface CreateLiveSessionInput {
  apiKey: string;
  sdpOffer: string;
  instructions: string;
  model?: string;
  voice?: string;
  /** Text-only history seeded at start (max 128 messages). */
  history?: Array<{ role: "user" | "assistant" | "developer"; text: string }>;
  fetchImpl?: typeof fetch;
}

export interface CreatedLiveSession {
  sessionId: string;
  sdpAnswer: string;
}

export async function createLiveSession(input: CreateLiveSessionInput): Promise<CreatedLiveSession> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = {
    session: {
      model: input.model ?? LIVE_DEFAULT_MODEL,
      instructions: input.instructions,
      ...(input.history?.length
        ? {
            input: input.history.slice(-128).map((item) => ({
              role: item.role,
              content: [{ type: item.role === "assistant" ? "output_text" : "input_text", text: item.text }],
            })),
          }
        : {}),
      audio: { output: { voice: input.voice ?? LIVE_DEFAULT_VOICE } },
      delegation: { type: "client" },
      store: false,
      // Untrusted frontend: the browser may neither send events nor read the seeded context.
      client: { data_channel: { allowed_client_events: [], allowed_server_events: [] } },
    },
    transport: { type: "webrtc", sdp: input.sdpOffer },
  };
  const response = await fetchImpl(LIVE_API_BASE, {
    method: "POST",
    headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`GPT-Live session create failed (${response.status}): ${redactBody(raw)}`);
  }
  const parsed = safeJson(raw) as { session?: { id?: unknown }; transport?: { sdp?: unknown } } | null;
  const sessionId = typeof parsed?.session?.id === "string" ? parsed.session.id : "";
  const sdpAnswer = typeof parsed?.transport?.sdp === "string" ? parsed.transport.sdp : "";
  if (!sessionId || !sdpAnswer) throw new Error("GPT-Live session create returned no session id or SDP answer");
  return { sessionId, sdpAnswer };
}

export async function closeLiveSession(input: {
  apiKey: string;
  sessionId: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    await fetchImpl(`${LIVE_API_BASE}/${encodeURIComponent(input.sessionId)}/close`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // no-cause: best effort; the sideband close below ends the session too.
  }
}

// ---------------------------------------------------------------------------
// Sideband
// ---------------------------------------------------------------------------

export interface LiveSocket {
  send(data: string): void;
  close(): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "open", listener: () => void): unknown;
}

export interface LiveSidebandHandlers {
  /** A delegation settled: the person asked for work. */
  onDelegation(input: { delegationId: string; text: string }): void;
  onUserTranscript(text: string): void;
  onAgentTranscript(text: string): void;
  onUsage(input: { seconds: number; activeSeconds?: number }): void;
  onClosed(reason: string): void;
  onError(error: LiveProviderError): void;
}

/** A provider `error` event, with the fields the provider sent. */
export class LiveProviderError extends Error {
  constructor(
    message: string,
    readonly providerCode: string | null = null,
    readonly providerType: string | null = null,
    readonly param: string | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LiveProviderError";
  }
}

/** Reads `{ type: "error", error: { type, code, message, param } }`; falls back to top-level fields. */
export function liveProviderError(event: Record<string, unknown>): LiveProviderError {
  const nested = event.error && typeof event.error === "object" ? (event.error as Record<string, unknown>) : {};
  const code = stringField(nested, "code") || stringField(event, "code");
  const type = stringField(nested, "type");
  const message = stringField(nested, "message") || stringField(event, "message");
  const param = stringField(nested, "param");
  return new LiveProviderError(
    message || (code ? `GPT-Live error: ${code}` : "GPT-Live error"),
    code || null,
    type || null,
    param || null,
  );
}

export interface LiveSidebandOptions {
  apiKey: string;
  sessionId: string;
  handlers: LiveSidebandHandlers;
  socketFactory?: (url: string, headers: Record<string, string>) => LiveSocket;
  settleMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

/**
 * The daemon's sideband. It is the only writer of appends. Reflected audio is
 * dropped on arrival. Delegations are deduped by id and settled so the user
 * transcript that triggered them is complete.
 */
export class LiveSideband {
  private socket: LiveSocket | null = null;
  private userBuffer = "";
  /** End of the last user transcript delta, when the provider sent it. */
  private userLastEndMs: number | null = null;
  /**
   * Finished utterances since the voice model last answered on its own. A
   * delegation takes all of them (nothing the person said is dropped); the
   * model answering means they were conversation, so they are shown then.
   */
  private pendingUtterances: string[] = [];
  /** Delegations created but not yet settled. */
  private pendingDelegations = 0;
  /** A model reply is being transcribed (timestamps decide when one ends). */
  private replyOpen = false;
  /** End of the last model transcript delta, when the provider sent it. */
  private agentLastEndMs: number | null = null;
  private agentBuffer = "";
  private readonly seenDelegations = new Set<string>();
  private closed = false;

  constructor(private readonly options: LiveSidebandOptions) {}

  connect(): void {
    const url = `${LIVE_API_BASE.replace(/^https:/, "wss:")}/${encodeURIComponent(this.options.sessionId)}/attach`;
    const headers = { authorization: `Bearer ${this.options.apiKey}` };
    const factory =
      this.options.socketFactory ?? ((target, h) => new WebSocket(target, { headers: h }) as unknown as LiveSocket);
    const socket = factory(url, headers);
    this.socket = socket;
    socket.on("message", (data) => this.handleRaw(data));
    socket.on("close", () => this.finish("sideband_closed"));
    socket.on("error", (error) =>
      this.options.handlers.onError(new LiveProviderError(error.message, null, null, null, { cause: error })),
    );
  }

  /** Spoken update for the person (paraphrased by the voice model). */
  commentary(text: string, delegationId: string | null): void {
    this.append("session.commentary.append", text, delegationId);
  }

  /** Silent context for the voice model. */
  thinking(text: string, delegationId: string | null): void {
    this.append("session.thinking.append", text, delegationId);
  }

  /**
   * Publish what the person said that no delegation or reply took yet. The
   * door calls this before it marks the call as ending, while transcripts are
   * still accepted (a goodbye said right before hanging up is kept).
   */
  drain(): void {
    this.finishUtterance();
    this.emitConversation();
  }

  close(): void {
    if (this.closed) return;
    try {
      this.socket?.send(JSON.stringify({ type: "session.close" }));
    } catch {
      // no-cause: closing a socket that already dropped.
    }
    try {
      this.socket?.close();
    } catch {
      // no-cause: closing a socket that already dropped.
    }
    this.finish("closed_by_door");
  }

  /** Visible for tests. */
  handleRaw(data: unknown): void {
    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    // Drop reflected audio before parsing the (large) payload.
    if (
      text.length > 512 &&
      /"type"\s*:\s*"session\.(?:input_audio\.append|output_audio\.delta)"/.test(text.slice(0, 200))
    ) {
      return;
    }
    const event = safeJson(text) as Record<string, unknown> | null;
    if (!event || typeof event.type !== "string") return;
    this.handleEvent(event);
  }

  private handleEvent(event: Record<string, unknown>): void {
    const type = event.type as string;
    if (AUDIO_EVENTS.has(type)) return;
    switch (type) {
      case "session.input_transcript.delta": {
        // No done event exists: a pause between deltas ends the utterance.
        const startMs = numberField(event, "start_ms");
        if (this.userBuffer.trim() && startMs !== null && this.userLastEndMs !== null) {
          if (startMs - this.userLastEndMs > UTTERANCE_GAP_MS) this.finishUtterance();
        }
        this.userBuffer += stringField(event, "delta");
        const endMs = numberField(event, "end_ms");
        if (endMs !== null) this.userLastEndMs = endMs;
        return;
      }
      case "session.input_transcript.done":
      case "session.input_transcript.completed":
        this.finishUtterance();
        return;
      case "session.output_transcript.delta": {
        // Only the START of a model reply ends the person's utterance. Later
        // deltas of the same reply are not boundaries: words the person says
        // over a reply (a barge-in) stay one request.
        const startMs = numberField(event, "start_ms");
        const replyStarts =
          startMs !== null && this.agentLastEndMs !== null
            ? startMs - this.agentLastEndMs > UTTERANCE_GAP_MS
            : !this.replyOpen;
        if (replyStarts) {
          this.finishUtterance();
          // If no delegation is waiting for it, what was said was conversation.
          if (this.pendingDelegations === 0) this.emitConversation();
        }
        this.replyOpen = true;
        const endMs = numberField(event, "end_ms");
        if (endMs !== null) this.agentLastEndMs = endMs;
        this.agentBuffer += stringField(event, "delta");
        if (/[.!?…]\s*$/.test(this.agentBuffer)) this.flushAgent();
        return;
      }
      case "session.output_transcript.done":
      case "session.output_transcript.completed":
        this.replyOpen = false;
        this.flushAgent();
        return;
      case "session.delegation.created": {
        const delegation = (event.delegation as Record<string, unknown> | undefined) ?? event;
        const id = stringField(delegation, "id") || stringField(event, "delegation_id");
        if (!id || this.seenDelegations.has(id)) return;
        this.seenDelegations.add(id);
        this.pendingDelegations += 1;
        const setTimer = this.options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
        // Cancel the automatic "I'm checking" with an empty thinking append; the
        // door speaks its own acknowledgement from real session events.
        this.thinking("", id);
        setTimer(() => {
          this.pendingDelegations = Math.max(0, this.pendingDelegations - 1);
          const text = this.takeUserText();
          this.options.handlers.onDelegation({ delegationId: id, text });
        }, this.options.settleMs ?? DELEGATION_SETTLE_MS);
        return;
      }
      case "session.usage.updated": {
        const usage = (event.usage as Record<string, unknown> | undefined) ?? event;
        const seconds = numberField(usage, "seconds");
        const activeSeconds = numberField(usage, "active_seconds");
        if (seconds !== null) {
          this.options.handlers.onUsage({ seconds, ...(activeSeconds !== null ? { activeSeconds } : {}) });
        }
        return;
      }
      case "session.closed":
        this.finish("provider_closed");
        return;
      case "error":
        this.options.handlers.onError(liveProviderError(event));
        return;
      default:
        return;
    }
  }

  private takeUserText(): string {
    // Everything said since the model last answered goes to the session, in
    // order, including words still streaming. The door records it as the
    // turn's transcript, so it is not published here (it would show twice).
    this.finishUtterance();
    const text = this.pendingUtterances.join(" ").trim();
    this.pendingUtterances = [];
    return text;
  }

  /** Close the utterance being heard and keep it until a delegation or an answer takes it. */
  private finishUtterance(): void {
    const text = this.userBuffer.trim();
    this.userBuffer = "";
    this.userLastEndMs = null;
    if (text) this.pendingUtterances.push(text);
  }

  /** The model answered on its own: what was pending was conversation; show each once. */
  private emitConversation(): void {
    const pending = this.pendingUtterances;
    this.pendingUtterances = [];
    for (const text of pending) this.options.handlers.onUserTranscript(text);
  }

  private flushAgent(): void {
    const text = this.agentBuffer.trim();
    this.agentBuffer = "";
    if (text) this.options.handlers.onAgentTranscript(text);
  }

  private append(type: string, text: string, delegationId: string | null): void {
    if (this.closed || !this.socket) return;
    const chunks = text ? chunkText(text, APPEND_CHUNK_CHARS) : [""];
    for (const chunk of chunks) {
      this.socket.send(JSON.stringify({ type, delegation_id: delegationId, content: chunk }));
    }
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.finishUtterance();
    this.emitConversation();
    this.flushAgent();
    this.options.handlers.onClosed(reason);
  }
}

export function chunkText(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf(". ", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // no-cause: a non-JSON provider frame is ignored, not an error.
    return null;
  }
}

function redactBody(raw: string): string {
  return raw.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-…").slice(0, 300);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
