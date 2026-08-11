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
        throw new Error(`Kimi Code request failed (HTTP ${response.status})`);
      }
      if (!response.body) {
        throw new Error("Kimi Code response did not include a stream body");
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
            if (isAbortError(error) || closed || request.signal?.aborted) return;
            throw error;
          }
          if (chunk.done) break;
          retained += decoder.decode(chunk.value, { stream: true });
          assertBoundedBuffer(retained);
          const parsed = extractSseEvents(retained);
          retained = parsed.remainder;
          for (const payload of parsed.payloads) {
            if (payload === "[DONE]") {
              done = true;
              yield { type: "done" };
              return;
            }
            try {
              yield { type: "message", data: JSON.parse(payload) };
            } catch {
              throw new Error("Kimi Code stream contained malformed JSON");
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
    throw new Error("Kimi Code SSE buffer limit exceeded");
  }
}

function extractSseEvents(source: string): { payloads: string[]; remainder: string } {
  const events = source.split(/\r?\n\r?\n/);
  const remainder = events.pop() ?? "";
  const payloads: string[] = [];
  for (const event of events) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (data.length > 0) payloads.push(data.join("\n"));
  }
  return { payloads, remainder };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
}
