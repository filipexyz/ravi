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
/**
 * Appends are capped at 500 tokens. Portuguese with numbers, ids and acronyms
 * can pass 2 characters per token, so chunks stay at 900 characters.
 */
export const APPEND_CHUNK_CHARS = 900;
/** Wait this long after a delegation for the transcript that triggered it to settle. */
export const DELEGATION_SETTLE_MS = 900;
/** A pause longer than this between transcript deltas starts a new utterance. */
export const UTTERANCE_GAP_MS = 1200;
/**
 * Speech the model answered on its own is shown as conversation only after
 * this long without a delegation: the model may start talking ("deixa eu
 * ver") before it delegates, and the request must still reach the session.
 */
export const CONVERSATION_SETTLE_MS = 3000;
/** How many shown utterances a late delegation can still take. */
const RECENT_SHOWN_LIMIT = 3;
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
  /** Deltas of the utterance being heard, so a delegation offset can split it. */
  private userParts: Array<{ text: string; startMs: number | null }> = [];
  /** End of the last user transcript delta, when the provider sent it. */
  private userLastEndMs: number | null = null;
  /** Start of the utterance being heard, when the provider sent it. */
  private userStartMs: number | null = null;
  /**
   * Finished utterances nobody took yet. A delegation takes them (nothing the
   * person said is dropped). Ones the model answered on its own are shown as
   * conversation after CONVERSATION_SETTLE_MS without a delegation.
   */
  private pendingUtterances: Array<{ text: string; startMs: number | null; answeredBy: number | null }> = [];
  /** Counts model replies; each conversation timer only shows what its own reply answered. */
  private replySeq = 0;
  /**
   * The last utterances shown as conversation that no delegation took. If a
   * delegation arrives after the window with nothing pending, the latest of
   * these that started before its offset is the request.
   */
  private recentShown: Array<{ text: string; startMs: number | null }> = [];
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
        if (!this.userBuffer.trim() && startMs !== null) this.userStartMs = startMs;
        const delta = stringField(event, "delta");
        this.userBuffer += delta;
        this.userParts.push({ text: delta, startMs });
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
          // What was said may be conversation, or the model may delegate it
          // next. Keep it; show it as conversation only if no delegation
          // takes it within CONVERSATION_SETTLE_MS.
          const reply = ++this.replySeq;
          let answeredNow = false;
          for (const item of this.pendingUtterances) {
            if (item.answeredBy === null) {
              item.answeredBy = reply;
              answeredNow = true;
            }
          }
          if (answeredNow) this.timer(() => this.emitAnswered(reply), CONVERSATION_SETTLE_MS);
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
        // Where the delegation sits on the session timeline: speech that
        // started after it belongs to the next request.
        const offsetMs = numberField(delegation, "offset_ms") ?? numberField(event, "offset_ms");
        // Cancel the automatic "I'm checking" with an empty thinking append; the
        // door speaks its own acknowledgement from real session events.
        this.thinking("", id);
        this.timer(() => {
          this.pendingDelegations = Math.max(0, this.pendingDelegations - 1);
          const text = this.takeUserText(offsetMs);
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

  private timer(fn: () => void, ms: number): void {
    const setTimer = this.options.setTimer ?? ((cb: () => void, delay: number) => setTimeout(cb, delay));
    setTimer(fn, ms);
  }

  private takeUserText(offsetMs: number | null = null): string {
    // Everything not yet taken goes to the session, in order, including
    // words still streaming; only speech that started after the delegation's
    // offset stays for the next request. The door records the text as the
    // turn's transcript, so it is not published here (it would show twice).
    // Words of the open utterance said after the offset are the next request.
    let later: typeof this.userParts = [];
    if (offsetMs !== null) {
      const cut = this.userParts.findIndex((part) => part.startMs !== null && part.startMs > offsetMs);
      if (cut > 0) {
        later = this.userParts.slice(cut);
        this.userBuffer = this.userParts
          .slice(0, cut)
          .map((part) => part.text)
          .join("");
        this.userParts = this.userParts.slice(0, cut);
      } else if (cut === 0) {
        later = this.userParts;
        this.userBuffer = "";
        this.userParts = [];
      }
    }
    const laterLastEndMs = later.length ? this.userLastEndMs : null;
    this.finishUtterance();
    if (later.length) {
      this.userParts = later;
      this.userBuffer = later.map((part) => part.text).join("");
      this.userStartMs = later[0]?.startMs ?? null;
      this.userLastEndMs = laterLastEndMs;
    }
    const before = (item: { startMs: number | null }) =>
      offsetMs === null || item.startMs === null || item.startMs <= offsetMs;
    const eligible = this.pendingUtterances.filter(before);
    this.pendingUtterances = this.pendingUtterances.filter((item) => !before(item));
    const unanswered = eligible.filter((item) => item.answeredBy === null);
    const answered = eligible.filter((item) => item.answeredBy !== null);
    let taken: string[];
    let conversation: typeof answered;
    if (unanswered.length) {
      // New speech after the model's reply is the request; what the model
      // already answered was conversation.
      taken = unanswered.map((item) => item.text);
      conversation = answered;
    } else if (answered.length) {
      // The model talked ("deixa eu ver") and then delegated: the request is
      // the last thing it answered; anything earlier was conversation.
      taken = [answered[answered.length - 1]?.text ?? ""];
      conversation = answered.slice(0, -1);
    } else {
      // The conversation window already showed it: take the latest shown
      // utterance that started before the offset instead of asking to repeat.
      const recent = [...this.recentShown].reverse().find(before);
      taken = recent ? [recent.text] : [];
      conversation = [];
      if (recent) this.recentShown = this.recentShown.filter((item) => item !== recent);
    }
    for (const item of conversation) this.showConversation(item);
    return taken.join(" ").trim();
  }

  private showConversation(item: { text: string; startMs: number | null }): void {
    this.options.handlers.onUserTranscript(item.text);
    this.recentShown.push({ text: item.text, startMs: item.startMs });
    if (this.recentShown.length > RECENT_SHOWN_LIMIT) this.recentShown.shift();
  }

  /** Close the utterance being heard and keep it until a delegation or an answer takes it. */
  private finishUtterance(): void {
    const text = this.userBuffer.trim();
    const startMs = this.userStartMs;
    this.userBuffer = "";
    this.userParts = [];
    this.userLastEndMs = null;
    this.userStartMs = null;
    if (text) this.pendingUtterances.push({ text, startMs, answeredBy: null });
  }

  /**
   * Speech this reply answered that no delegation took within the window was
   * conversation: show it once. A delegation still settling takes it instead.
   */
  private emitAnswered(reply: number): void {
    if (this.closed) return;
    if (this.pendingDelegations > 0) {
      // A delegation is settling: check again later instead of dropping the timer.
      this.timer(() => this.emitAnswered(reply), CONVERSATION_SETTLE_MS);
      return;
    }
    const shown = this.pendingUtterances.filter((item) => item.answeredBy === reply);
    this.pendingUtterances = this.pendingUtterances.filter((item) => item.answeredBy !== reply);
    for (const item of shown) this.showConversation(item);
  }

  /** Show everything nobody took (hangup or close). */
  private emitConversation(): void {
    const pending = this.pendingUtterances;
    this.pendingUtterances = [];
    for (const item of pending) this.options.handlers.onUserTranscript(item.text);
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
    // A chunk is rest.slice(0, cut + 1): cut must stay below max.
    let cut = rest.lastIndexOf(". ", max - 1);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max - 1);
    if (cut < max / 2) cut = max - 1;
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
