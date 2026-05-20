// GENERATED FILE — DO NOT EDIT.
// Run `ravi sdk client generate` to regenerate.
// Drift is detected by `ravi sdk client check` (CI).

import { buildErrorFromGateway, RaviTransportError, type RaviErrorBody } from "./errors.js";
import { REGISTRY_HASH, SDK_VERSION } from "./version.js";

export interface StreamClientConfig {
  /** Base URL of the Ravi gateway. Example: `http://127.0.0.1:7777`. */
  baseUrl: string;
  /** Runtime context key (`rctx_*`). Sent as `Authorization: Bearer <key>`. */
  contextKey: string;
  /** Optional fetch override (testing, custom retry layers, edge runtimes). */
  fetch?: typeof fetch;
  /** Extra headers merged into every request (after SDK headers). */
  headers?: Record<string, string>;
}

export interface RaviSseEvent<TData = unknown> {
  id?: string;
  event: string;
  data: TData;
}

export interface EventsStreamOptions {
  subject?: string;
  filter?: string;
  only?: string;
  noClaude?: boolean;
  noHeartbeat?: boolean;
  signal?: AbortSignal;
}

export interface TasksStreamOptions {
  taskId?: string;
  signal?: AbortSignal;
}

export interface SessionStreamOptions {
  /** Seconds before the stream emits `event: end` and closes. `0` means no natural timeout. */
  timeout?: number;
  signal?: AbortSignal;
}

export interface ChatStreamOptions {
  signal?: AbortSignal;
}

export interface InstanceStreamOptions {
  signal?: AbortSignal;
}

export interface AuditStreamOptions {
  signal?: AbortSignal;
}

export type GatewayTopicEvent = {
  count?: number;
  data: unknown;
  timestamp?: string;
  topic: string;
  type: string;
};

export type TaskStreamPayload = {
  topic: string;
  type: "task.event";
  [k: string]: unknown;
};

export type SessionStreamPayload = {
  data?: unknown;
  reason?: string;
  sessionName: string;
  timeoutMs?: number;
  timestamp?: string;
  topic?: string;
  type: "session.event" | "stream.end";
};

export type ChatStreamPayload = {
  chatId: string;
  data: unknown;
  timestamp: string;
  topic: string;
  type: "chat.event";
};

export type InstanceStreamPayload = {
  data: unknown;
  instanceId: string;
  timestamp: string;
  topic: string;
  type: "instance.event";
};

export type OmniMessageReceivedEnvelope = {
  id: string;
  metadata?: {
    channelType?: string;
    ingestMode?: string;
    instanceId?: string;
    personId?: string;
    source?: string;
    [k: string]: unknown;
  };
  payload: {
    chatId: string;
    content: {
      isVoiceNote?: boolean;
      localPath?: string;
      mediaUrl?: string;
      mimeType?: string;
      text?: string;
      type: string;
      [k: string]: unknown;
    };
    externalId: string;
    from: string;
    replyToId?: string;
    [k: string]: unknown;
  };
  timestamp: number;
  type: string;
  [k: string]: unknown;
};

export type OmniReactionReceivedEnvelope = {
  id: string;
  metadata?: {
    channelType?: string;
    ingestMode?: string;
    instanceId?: string;
    personId?: string;
    source?: string;
    [k: string]: unknown;
  };
  payload: {
    chatId: string;
    emoji: string;
    from: string;
    messageId: string;
    [k: string]: unknown;
  };
  timestamp: number;
  type: string;
  [k: string]: unknown;
};

export type PresenceTypingPayload = {
  chatId?: string;
  from?: string;
  isTyping?: boolean;
  timestamp?: number;
  [k: string]: unknown;
};

export type ChatUnreadUpdatedPayload = {
  chatId?: string;
  lastReadMessageId?: string;
  timestamp?: number;
  unreadCount?: number;
  [k: string]: unknown;
};

export class RaviStreamClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: StreamClientConfig) {
    this.baseUrl = stripTrailingSlash(config.baseUrl);
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error(
        "RaviStreamClient: no global `fetch` available. Pass `config.fetch` explicitly when running in a stripped-down runtime.",
      );
    }
  }

  /**
   * Subscribe to the full NATS event bus. Mirrors `ravi events stream` and suppresses the same noisy topics (message.*, reaction.*, instance.*, presence.typing, chat.unread-updated, .stream, claude stream chunks).
   */
  events(options: EventsStreamOptions = {}): AsyncIterable<RaviSseEvent<GatewayTopicEvent>> {
    const params = new URLSearchParams();
    appendString(params, "subject", options.subject);
    appendString(params, "filter", options.filter);
    appendString(params, "only", options.only);
    appendBool(params, "noClaude", options.noClaude);
    appendBool(params, "noHeartbeat", options.noHeartbeat);
    return this.stream<GatewayTopicEvent>("events", params, options.signal);
  }

  /**
   * Subscribe to task lifecycle events (`ravi.task.<id>.event`).
   */
  tasks(options: TasksStreamOptions = {}): AsyncIterable<RaviSseEvent<TaskStreamPayload>> {
    const params = new URLSearchParams();
    appendString(params, "taskId", options.taskId);
    return this.stream<TaskStreamPayload>("tasks", params, options.signal);
  }

  /**
   * Subscribe to runtime debug events for a single session: prompts, responses, streamed chunks, tool calls, provider runtime events, claude SDK events, delivery telemetry, and approval request/response.
   */
  session(name: string, options: SessionStreamOptions = {}): AsyncIterable<RaviSseEvent<SessionStreamPayload>> {
    const params = new URLSearchParams();
    appendNumber(params, "timeout", options.timeout);
    return this.stream<SessionStreamPayload>("sessions/" + encodeURIComponent(name), params, options.signal);
  }

  /**
   * Subscribe to the live event stream for a single chat: new messages, reactions, presence/typing, and unread updates. The server filters by `chatId` against the upstream omni payload — events for other chats are discarded before reaching the client.
   */
  chat(chatId: string, options: ChatStreamOptions = {}): AsyncIterable<RaviSseEvent<ChatStreamPayload>> {
    const params = new URLSearchParams();
    return this.stream<ChatStreamPayload>("chats/" + encodeURIComponent(chatId), params, options.signal);
  }

  /**
   * Subscribe to lifecycle events for a single omni instance: QR code, connected, disconnected. Filtered server-side.
   */
  instance(instanceId: string, options: InstanceStreamOptions = {}): AsyncIterable<RaviSseEvent<InstanceStreamPayload>> {
    const params = new URLSearchParams();
    return this.stream<InstanceStreamPayload>("instances/" + encodeURIComponent(instanceId), params, options.signal);
  }

  /**
   * Subscribe to the global audit event stream (`ravi.audit.>`).
   */
  audit(options: AuditStreamOptions = {}): AsyncIterable<RaviSseEvent<GatewayTopicEvent>> {
    const params = new URLSearchParams();
    return this.stream<GatewayTopicEvent>("audit", params, options.signal);
  }

  private async *stream<TData>(
    channelPath: string,
    params: URLSearchParams,
    signal?: AbortSignal,
  ): AsyncIterable<RaviSseEvent<TData>> {
    const suffix = params.toString();
    const url = `${this.baseUrl}/api/v1/_stream/${channelPath}${suffix ? `?${suffix}` : ""}`;
    const response = await this.fetchStream(url, signal);
    yield* parseSse<TData>(response.body);
  }

  private async fetchStream(url: string, signal?: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${this.config.contextKey}`,
          "x-ravi-sdk-version": SDK_VERSION,
          "x-ravi-registry-hash": REGISTRY_HASH,
          ...(this.config.headers ?? {}),
        },
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw new RaviTransportError(err instanceof Error ? err.message : "network error opening Ravi stream", err);
    }

    if (!response.ok) {
      const rawText = await safeText(response);
      throw buildErrorFromGateway(response.status, parseJson(rawText), "sdk.stream");
    }
    return response;
  }
}

/**
 * Typed decoders for the sub-events emitted by `ChatStreamPayload`.
 * Each helper re-decodes the raw `data` field into a concrete shape so
 * callers can switch on the SSE `event` name and unwrap with confidence.
 */

export function decodeMessage(envelope: ChatStreamPayload): OmniMessageReceivedEnvelope {
  return envelope.data as OmniMessageReceivedEnvelope;
}

export function decodeReaction(envelope: ChatStreamPayload): OmniReactionReceivedEnvelope {
  return envelope.data as OmniReactionReceivedEnvelope;
}

export function decodePresenceTyping(envelope: ChatStreamPayload): PresenceTypingPayload {
  return envelope.data as PresenceTypingPayload;
}

export function decodeUnread(envelope: ChatStreamPayload): ChatUnreadUpdatedPayload {
  return envelope.data as ChatUnreadUpdatedPayload;
}

export function createStreamClient(config: StreamClientConfig): RaviStreamClient {
  return new RaviStreamClient(config);
}

export async function* parseSse<TData = unknown>(
  body: ReadableStream<Uint8Array> | null,
): AsyncIterable<RaviSseEvent<TData>> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let eventId: string | undefined;
  let dataLines: string[] = [];
  let completed = false;

  const flush = (): RaviSseEvent<TData> | null => {
    if (dataLines.length === 0) {
      eventName = "message";
      eventId = undefined;
      return null;
    }
    const raw = dataLines.join("\n");
    const out = {
      ...(eventId !== undefined ? { id: eventId } : {}),
      event: eventName,
      data: JSON.parse(raw) as TData,
    };
    eventName = "message";
    eventId = undefined;
    dataLines = [];
    return out;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line === "") {
          const event = flush();
          if (event) yield event;
        } else if (!line.startsWith(":")) {
          const colonIndex = line.indexOf(":");
          const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
          const valuePart = colonIndex === -1 ? "" : line.slice(colonIndex + 1).replace(/^ /, "");
          if (field === "event") eventName = valuePart || "message";
          if (field === "id") eventId = valuePart;
          if (field === "data") dataLines.push(valuePart);
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }

    const tail = decoder.decode();
    if (tail) buffer += tail;
    if (buffer.length > 0) {
      for (const line of buffer.split("\n")) {
        if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        if (line.startsWith("event:")) eventName = line.slice(6).replace(/^ /, "") || "message";
        if (line.startsWith("id:")) eventId = line.slice(3).replace(/^ /, "");
      }
    }
    const event = flush();
    if (event) yield event;
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

function appendString(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined && value.trim() !== "") params.set(key, value);
}

function appendNumber(params: URLSearchParams, key: string, value: number | undefined): void {
  if (value !== undefined && Number.isFinite(value)) params.set(key, String(value));
}

function appendBool(params: URLSearchParams, key: string, value: boolean | undefined): void {
  if (value === true) params.set(key, "1");
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function parseJson(raw: string): RaviErrorBody | null {
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw) as RaviErrorBody;
  } catch {
    return { error: "MalformedResponse", message: raw.slice(0, 1024) };
  }
}
