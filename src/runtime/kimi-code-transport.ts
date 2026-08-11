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

export type KimiCodeRequestMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; reasoning_content?: string; tool_calls?: unknown[] }
  | { role: "assistant"; content?: undefined; reasoning_content?: string; tool_calls: [unknown, ...unknown[]] }
  | { role: "tool"; content: string; tool_call_id?: string };

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
  userAgent?: string;
}

export type KimiCodePreflightErrorCode =
  | "invalid_assistant_message"
  | "message_too_large"
  | "missing_api_key"
  | "request_too_large"
  | "unknown_model"
  | "untrusted_origin"
  | "unsupported_effort";

export class KimiCodePreflightError extends Error {
  readonly recoverable = false;

  constructor(
    readonly code: KimiCodePreflightErrorCode,
    message: string = code,
  ) {
    super(`[${code}] ${message}`);
    this.name = "KimiCodePreflightError";
  }
}

export type KimiCodeTransportPhase = "request_not_sent" | "acceptance_ambiguous" | "provider_protocol";

export class KimiCodeTransportError extends Error {
  constructor(
    readonly phase: KimiCodeTransportPhase,
    message: string,
  ) {
    super(message);
    this.name = "KimiCodeTransportError";
  }
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

export class KimiCodeProtocolError extends KimiCodeTransportError {
  readonly code: KimiCodeProtocolErrorCode;

  constructor(code: KimiCodeProtocolErrorCode) {
    const messages: Record<KimiCodeProtocolErrorCode, string> = {
      missing_stream_body: "Kimi Code protocol error: missing stream body",
      sse_buffer_limit: "Kimi Code protocol error: SSE buffer limit exceeded",
      sse_event_limit: "Kimi Code protocol error: SSE event limit exceeded",
      malformed_json: "Kimi Code protocol error: malformed JSON event",
    };
    super("provider_protocol", messages[code]);
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
    throw new KimiCodePreflightError("unknown_model", `Unknown Kimi Code model '${input.model}'`);
  }
  const apiKey = input.env?.[KIMI_CODE_CREDENTIAL_ENV_KEY]?.trim();
  if (!apiKey) {
    throw new KimiCodePreflightError("missing_api_key", `${KIMI_CODE_CREDENTIAL_ENV_KEY} is required for Kimi Code`);
  }

  const nativeMessages = normalizeKimiCodeRequestMessages(
    input.systemPromptAppend
      ? [{ role: "system" as const, content: input.systemPromptAppend }, ...messages]
      : [...messages],
  );
  for (const message of nativeMessages) {
    if (message.content !== undefined && new TextEncoder().encode(message.content).byteLength > MAX_MESSAGE_BYTES) {
      throw new KimiCodePreflightError("message_too_large", "Kimi Code input message exceeds the 2 MiB UTF-8 limit");
    }
  }

  let effort: "low" | "high" | "max" | undefined;
  try {
    effort = resolveKimiCodeEffort(input.model, input.effort);
  } catch {
    throw new KimiCodePreflightError(
      "unsupported_effort",
      `Kimi Code model '${input.model}' does not support effort '${input.effort}'`,
    );
  }
  const body = {
    model: input.model,
    messages: nativeMessages,
    stream: true as const,
    stream_options: { include_usage: true as const },
    prompt_cache_key: sessionId,
    ...(effort ? { thinking: { type: "enabled" as const, effort } } : {}),
  };
  const serializedBody = JSON.stringify(body);
  if (new TextEncoder().encode(serializedBody).byteLength > MAX_MESSAGE_BYTES) {
    throw new KimiCodePreflightError("request_too_large");
  }
  return {
    url: KIMI_CODE_CHAT_COMPLETIONS_URL,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "User-Agent": userAgent,
    },
    body,
  };
}

function normalizeKimiCodeRequestMessages(messages: readonly KimiCodeRequestMessage[]): KimiCodeRequestMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || message.content) return message;
    if (!message.tool_calls?.length) {
      throw new KimiCodePreflightError(
        "invalid_assistant_message",
        "Assistant messages without tool calls require non-empty content",
      );
    }
    const { content: _content, ...toolCallMessage } = message;
    return toolCallMessage as KimiCodeRequestMessage;
  });
}

export function createKimiCodeHttpTransport(options: CreateKimiCodeHttpTransportOptions = {}): KimiCodeTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  let closed = false;

  return {
    async *stream(request: KimiCodeTransportRequest): AsyncGenerator<KimiCodeStreamEvent> {
      if (closed || request.signal?.aborted) return;
      assertKimiCodeOrigin(request.url);
      const serializedBody = serializeKimiCodeTransportBody(request.body);
      const combined = combineSignals(request.signal, controller.signal);
      let phase: KimiCodeTransportPhase = "request_not_sent";
      let response: Response;
      try {
        try {
          // Once fetch is invoked this adapter has no evidence that zero request
          // bytes reached the provider, even when the returned promise rejects.
          phase = "acceptance_ambiguous";
          response = await fetchImpl(request.url, {
            method: "POST",
            headers: { ...request.headers, ...(options.userAgent ? { "User-Agent": options.userAgent } : {}) },
            body: serializedBody,
            signal: combined.signal,
          });
        } catch {
          if (closed || request.signal?.aborted || controller.signal.aborted || combined.signal.aborted) return;
          throw new KimiCodeTransportError(phase, "Kimi Code request could not be completed");
        }
        if (!response.ok) {
          throw await createKimiCodeHttpError(response);
        }
        if (!response.body) {
          throw new KimiCodeProtocolError("missing_stream_body");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const cancelReader = () => {
          void reader.cancel();
        };
        let retained = "";
        let done = false;
        combined.signal.addEventListener("abort", cancelReader, { once: true });
        try {
          while (!closed && !request.signal?.aborted && !combined.signal.aborted) {
            let chunk;
            try {
              chunk = await reader.read();
            } catch {
              if (closed || request.signal?.aborted || controller.signal.aborted || combined.signal.aborted) return;
              throw new KimiCodeTransportError(phase, "Kimi Code stream could not be read");
            }
            if (chunk.done) break;
            retained += decoder.decode(chunk.value, { stream: true });
            phase = "provider_protocol";
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
            phase = "acceptance_ambiguous";
          }
          if (!closed && !request.signal?.aborted && !combined.signal.aborted && !done) yield { type: "eof" };
        } finally {
          combined.signal.removeEventListener("abort", cancelReader);
          try {
            await reader.cancel();
          } catch {
            // The stream may already be complete or aborted.
          }
        }
      } finally {
        combined.cleanup();
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

function assertKimiCodeOrigin(requestUrl: string): void {
  try {
    if (new URL(requestUrl).origin === "https://api.kimi.com") return;
  } catch {
    // Fall through to the fixed preflight error.
  }
  throw new KimiCodePreflightError("untrusted_origin");
}

function serializeKimiCodeTransportBody(body: unknown): string {
  const serializedBody = JSON.stringify(body);
  if (typeof serializedBody !== "string" || new TextEncoder().encode(serializedBody).byteLength > MAX_MESSAGE_BYTES) {
    throw new KimiCodePreflightError("request_too_large");
  }
  return serializedBody;
}

function combineSignals(
  primary: AbortSignal | undefined,
  secondary: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  if (!primary) return { signal: secondary, cleanup: () => undefined };
  if (primary.aborted || secondary.aborted) return { signal: AbortSignal.abort(), cleanup: () => undefined };
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any([primary, secondary]), cleanup: () => undefined };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  primary.addEventListener("abort", abort, { once: true });
  secondary.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      primary.removeEventListener("abort", abort);
      secondary.removeEventListener("abort", abort);
    },
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
