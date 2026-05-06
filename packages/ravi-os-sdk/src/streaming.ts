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
  only?: "prompt" | "response" | "tool" | "claude" | "runtime" | "cli" | "audit" | string;
  noClaude?: boolean;
  noHeartbeat?: boolean;
  signal?: AbortSignal;
}

export interface TasksStreamOptions {
  taskId?: string;
  signal?: AbortSignal;
}

export interface SessionStreamOptions {
  /** Seconds. Defaults to the gateway's sessions/debug window; `0` means no natural timeout. */
  timeout?: number;
  signal?: AbortSignal;
}

export interface AuditStreamOptions {
  signal?: AbortSignal;
}

export interface GatewayTopicEvent {
  type: string;
  topic: string;
  data: unknown;
  timestamp?: string;
  count?: number;
}

export interface TaskStreamPayload {
  type: "task.event";
  topic: string;
  [key: string]: unknown;
}

export interface SessionStreamPayload {
  type: "session.event" | "stream.end";
  sessionName: string;
  topic?: string;
  data?: unknown;
  reason?: string;
  timeoutMs?: number;
  timestamp?: string;
}

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

  events(options: EventsStreamOptions = {}): AsyncIterable<RaviSseEvent<GatewayTopicEvent>> {
    const params = new URLSearchParams();
    append(params, "subject", options.subject);
    append(params, "filter", options.filter);
    append(params, "only", options.only);
    appendBool(params, "noClaude", options.noClaude);
    appendBool(params, "noHeartbeat", options.noHeartbeat);
    return this.stream<GatewayTopicEvent>("events", params, options.signal);
  }

  tasks(options: TasksStreamOptions = {}): AsyncIterable<RaviSseEvent<TaskStreamPayload>> {
    const params = new URLSearchParams();
    append(params, "taskId", options.taskId);
    return this.stream<TaskStreamPayload>("tasks", params, options.signal);
  }

  session(name: string, options: SessionStreamOptions = {}): AsyncIterable<RaviSseEvent<SessionStreamPayload>> {
    const params = new URLSearchParams();
    if (options.timeout !== undefined) append(params, "timeout", String(options.timeout));
    return this.stream<SessionStreamPayload>(`sessions/${encodeURIComponent(name)}`, params, options.signal);
  }

  audit(options: AuditStreamOptions = {}): AsyncIterable<RaviSseEvent<GatewayTopicEvent>> {
    return this.stream<GatewayTopicEvent>("audit", new URLSearchParams(), options.signal);
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

function append(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined && value.trim() !== "") params.set(key, value);
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
