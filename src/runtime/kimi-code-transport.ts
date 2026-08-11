import packageJson from "../../package.json" with { type: "json" };
import {
  KIMI_CODE_CREDENTIAL_ENV_KEY,
  isKimiCodeModel,
  resolveKimiCodeEffort,
  type KimiCodeModel,
} from "./kimi-code-models.js";
import type { RuntimeStartRequest } from "./types.js";

const KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1";
const KIMI_CODE_CHAT_COMPLETIONS_URL = `${KIMI_CODE_BASE_URL}/chat/completions`;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_SSE_BUFFER_BYTES = 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const trustedKimiCodeHttpErrors = new WeakSet<KimiCodeHttpError>();

export interface KimiCodeRequestMessage {
  role: "system" | "user";
  content: string;
}

export interface KimiCodeTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    model: KimiCodeModel["id"];
    messages: KimiCodeRequestMessage[];
    stream: true;
    stream_options: { include_usage: true };
    prompt_cache_key: string;
    thinking?: { type: "enabled"; effort: "low" | "high" | "max" };
  };
  signal?: AbortSignal;
}

export type KimiCodeStreamEvent = { type: "message"; data: unknown } | { type: "done" } | { type: "eof" };

export interface KimiCodeTransport {
  stream(request: KimiCodeTransportRequest): AsyncIterable<KimiCodeStreamEvent>;
  close(): Promise<void>;
}

export interface CreateKimiCodeHttpTransportOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  userAgent?: string;
}

export interface KimiCodeHttpErrorInput {
  status: number;
  publicMessage: string;
  code?: string;
  type?: string;
  headers?: Record<string, string>;
  requestId?: string;
}

export class KimiCodeHttpError extends Error {
  readonly rawEvent: Record<string, unknown>;

  constructor(input: KimiCodeHttpErrorInput) {
    super(input.publicMessage);
    this.name = "KimiCodeHttpError";
    this.rawEvent = {
      status: input.status,
      ...(input.code ? { code: input.code } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.headers && Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
    };
  }
}

export type KimiCodeProtocolErrorCode =
  | "missing_stream_body"
  | "sse_buffer_limit"
  | "sse_event_limit"
  | "malformed_json";

export class KimiCodeProtocolError extends Error {
  readonly code: KimiCodeProtocolErrorCode;

  constructor(code: KimiCodeProtocolErrorCode) {
    const messages: Record<KimiCodeProtocolErrorCode, string> = {
      missing_stream_body: "Kimi Code protocol error: missing stream body",
      sse_buffer_limit: "Kimi Code protocol error: SSE buffer limit exceeded",
      sse_event_limit: "Kimi Code protocol error: SSE event limit exceeded",
      malformed_json: "Kimi Code protocol error: malformed JSON event",
    };
    super(messages[code]);
    this.name = "KimiCodeProtocolError";
    this.code = code;
  }
}

export function projectKimiCodeHttpError(error: KimiCodeHttpError): {
  message: string;
  rawEvent: Record<string, unknown>;
} {
  const source = isRecord(error.rawEvent) ? error.rawEvent : {};
  const status =
    typeof source.status === "number" && Number.isInteger(source.status) && source.status >= 400 && source.status <= 599
      ? source.status
      : 500;
  if (!trustedKimiCodeHttpErrors.has(error)) {
    return {
      message: `Kimi Code membership request failed (HTTP ${status})`,
      rawEvent: { status },
    };
  }
  const code = safeProviderToken(source.code);
  const type = safeProviderToken(source.type);
  const headers = safeFailureHeaderRecord(source.headers);
  const requestId = headers["x-request-id"] ?? headers["request-id"];
  return {
    message: safeKimiCodeFailureMessage(status, error.message),
    rawEvent: {
      status,
      ...(code ? { code } : {}),
      ...(type ? { type } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(requestId ? { requestId } : {}),
    },
  };
}

export function buildKimiCodeRequest(
  input: RuntimeStartRequest,
  messages: readonly KimiCodeRequestMessage[],
  sessionId: string,
  userAgent = `ravi/${packageJson.version}`,
): KimiCodeTransportRequest {
  if (!isKimiCodeModel(input.model)) {
    throw new Error(`Unknown Kimi Code model '${input.model}'`);
  }
  const apiKey = input.env?.[KIMI_CODE_CREDENTIAL_ENV_KEY]?.trim();
  if (!apiKey) {
    throw new Error(`${KIMI_CODE_CREDENTIAL_ENV_KEY} is required for Kimi Code`);
  }

  const nativeMessages = [
    ...messages,
    ...(input.systemPromptAppend ? [{ role: "system" as const, content: input.systemPromptAppend }] : []),
  ];
  for (const message of nativeMessages) {
    if (new TextEncoder().encode(message.content).byteLength > MAX_MESSAGE_BYTES) {
      throw new Error("Kimi Code input message exceeds the 2 MiB UTF-8 limit");
    }
  }

  const effort = resolveKimiCodeEffort(input.model, input.effort);
  return {
    url: KIMI_CODE_CHAT_COMPLETIONS_URL,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "User-Agent": userAgent,
    },
    body: {
      model: input.model,
      messages: nativeMessages,
      stream: true,
      stream_options: { include_usage: true },
      prompt_cache_key: sessionId,
      ...(effort ? { thinking: { type: "enabled" as const, effort } } : {}),
    },
  };
}

export function createKimiCodeHttpTransport(options: CreateKimiCodeHttpTransportOptions = {}): KimiCodeTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  let closed = false;

  return {
    async *stream(request: KimiCodeTransportRequest): AsyncGenerator<KimiCodeStreamEvent> {
      if (closed || request.signal?.aborted) return;
      let response: Response;
      try {
        response = await fetchImpl(resolveTransportUrl(request.url, options.baseUrl), {
          method: "POST",
          headers: { ...request.headers, ...(options.userAgent ? { "User-Agent": options.userAgent } : {}) },
          body: JSON.stringify(request.body),
          signal: combineSignals(request.signal, controller.signal),
        });
      } catch (error) {
        if (isAbortError(error) || closed || request.signal?.aborted) return;
        throw new Error("Kimi Code request could not be completed");
      }
      if (!response.ok) {
        throw await createKimiCodeHttpError(response);
      }
      if (!response.body) {
        throw new KimiCodeProtocolError("missing_stream_body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let retained = "";
      let done = false;
      try {
        while (!closed && !request.signal?.aborted) {
          let chunk;
          try {
            chunk = await reader.read();
          } catch (error) {
            if (isAbortError(error) || closed || request.signal?.aborted || controller.signal.aborted) return;
            throw new Error("Kimi Code stream could not be read");
          }
          if (chunk.done) break;
          retained += decoder.decode(chunk.value, { stream: true });
          const parsed = extractSseEvents(retained);
          retained = parsed.remainder;
          assertBoundedBuffer(retained);
          for (const payload of parsed.payloads) {
            if (payload === "[DONE]") {
              done = true;
              yield { type: "done" };
              return;
            }
            try {
              yield { type: "message", data: JSON.parse(payload) };
            } catch {
              throw new KimiCodeProtocolError("malformed_json");
            }
          }
        }
        if (!closed && !request.signal?.aborted && !done) yield { type: "eof" };
      } finally {
        try {
          await reader.cancel();
        } catch {
          // The stream may already be complete or aborted.
        }
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      controller.abort();
    },
  };
}

async function createKimiCodeHttpError(response: Response): Promise<KimiCodeHttpError> {
  const body = await readBoundedErrorBody(response);
  let decoded: unknown;
  try {
    decoded = body ? JSON.parse(body) : undefined;
  } catch {
    decoded = undefined;
  }
  const error = isRecord(decoded) && isRecord(decoded.error) ? decoded.error : isRecord(decoded) ? decoded : undefined;
  const providerMessage = typeof error?.message === "string" ? error.message : undefined;
  const code = safeProviderToken(error?.code);
  const type = safeProviderToken(error?.type);
  const headers = safeFailureHeaders(response.headers);
  const requestId = headers["x-request-id"] ?? headers["request-id"];
  const failure = new KimiCodeHttpError({
    status: response.status,
    publicMessage: safeKimiCodeFailureMessage(response.status, providerMessage),
    ...(code ? { code } : {}),
    ...(type ? { type } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(requestId ? { requestId } : {}),
  });
  trustedKimiCodeHttpErrors.add(failure);
  return failure;
}

async function readBoundedErrorBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let retained = "";
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_ERROR_BODY_BYTES) return "";
      retained += decoder.decode(chunk.value, { stream: true });
    }
    return retained + decoder.decode();
  } catch {
    return "";
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function safeKimiCodeFailureMessage(status: number, message: string | undefined): string {
  const text = message?.toLowerCase() ?? "";
  const known: Array<[string, string]> = [
    ["api key appears to be invalid", "The API Key appears to be invalid or may have expired."],
    ["invalid authentication", "Invalid Authentication"],
    ["subscription does not have access to k3", "Your current subscription does not have access to k3."],
    ["supports only kimi-k3 up to 256k context", "Your current plan supports only kimi-k3 up to 256K context."],
    [
      "subscription does not have access to kimi-for-coding-highspeed",
      "Your current subscription does not have access to kimi-for-coding-highspeed.",
    ],
    ["model id does not exist", "Your model id does not exist."],
    ["unable to verify your membership benefits", "We're unable to verify your membership benefits at this time."],
    [
      "usage limit for this billing cycle",
      "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle.",
    ],
    ["access terminated", "Access terminated."],
    ["engine is currently overloaded", "The engine is currently overloaded, please try again later."],
    [
      "receiving too many requests",
      "We're receiving too many requests at the moment. Please wait a moment and try again.",
    ],
    [
      "usage limit for this period",
      "You've reached your usage limit for this period. Your quota will be refreshed in the next period.",
    ],
    [
      "kimi monthly usage limit",
      "You've reached kimi monthly usage limit for this billing cycle. Your quota will be refreshed in the next cycle.",
    ],
    ["total message size", "Kimi Code total message size exceeds the service limit."],
    ["exceeded model token limit", "Kimi Code request exceeded the model token limit."],
    ["reasoning_content is missing", "Kimi Code request is missing required reasoning content."],
  ];
  for (const [needle, safeMessage] of known) {
    if (text.includes(needle)) return safeMessage;
  }
  if (/(?:weekly|monthly|5[- ]hour).*usage limit|usage limit.*(?:weekly|monthly|5[- ]hour)/.test(text)) {
    return "Kimi Code membership quota is exhausted.";
  }
  return `Kimi Code membership request failed (HTTP ${status})`;
}

function safeFailureHeaders(headers: Headers): Record<string, string> {
  return safeFailureHeaderRecord(Object.fromEntries(headers.entries()));
}

function safeFailureHeaderRecord(value: unknown): Record<string, string> {
  const safe: Record<string, string> = {};
  if (!isRecord(value)) return safe;
  for (const key of [
    "retry-after",
    "x-request-id",
    "request-id",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
  ]) {
    const headerValue = typeof value[key] === "string" ? value[key].trim() : undefined;
    if (!headerValue || headerValue.length > 128) continue;
    if (key.includes("request-id")) {
      if (/^[A-Za-z0-9._:-]+$/.test(headerValue)) safe[key] = headerValue;
      continue;
    }
    if (/^\d+(?:\.\d+)?$/.test(headerValue) || Number.isFinite(Date.parse(headerValue))) safe[key] = headerValue;
  }
  return safe;
}

function safeProviderToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(value) ? value : undefined;
}

function resolveTransportUrl(requestUrl: string, baseUrl?: string): string {
  if (!baseUrl) return requestUrl;
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function combineSignals(primary: AbortSignal | undefined, secondary: AbortSignal): AbortSignal {
  if (!primary) return secondary;
  if (primary.aborted || secondary.aborted) return AbortSignal.abort();
  const controller = new AbortController();
  const abort = () => controller.abort();
  primary.addEventListener("abort", abort, { once: true });
  secondary.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

function assertBoundedBuffer(value: string): void {
  if (new TextEncoder().encode(value).byteLength > MAX_SSE_BUFFER_BYTES) {
    throw new KimiCodeProtocolError("sse_buffer_limit");
  }
}

function extractSseEvents(source: string): { payloads: string[]; remainder: string } {
  const events = source.split(/\r?\n\r?\n/);
  const remainder = events.pop() ?? "";
  const payloads: string[] = [];
  for (const event of events) {
    if (new TextEncoder().encode(event).byteLength > MAX_SSE_EVENT_BYTES) {
      throw new KimiCodeProtocolError("sse_event_limit");
    }
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (data.length > 0) payloads.push(data.join("\n"));
  }
  return { payloads, remainder };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
