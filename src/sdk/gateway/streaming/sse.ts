import type { StreamEvent } from "./types.js";

export const DEFAULT_KEEPALIVE_MS = 15_000;
export const DEFAULT_MAX_QUEUE = 256;

const encoder = new TextEncoder();

export interface SseStreamOptions {
  signal?: AbortSignal;
  keepaliveMs?: number;
  maxQueue?: number;
  lastEventId?: string | null;
  onClose?: (reason: "completed" | "cancelled" | "aborted" | "errored", error?: unknown) => Promise<void> | void;
}

export function createSseResponse(events: AsyncIterable<StreamEvent>, options: SseStreamOptions = {}): Response {
  const body = createSseReadableStream(events, options);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

export function createSseReadableStream(
  events: AsyncIterable<StreamEvent>,
  options: SseStreamOptions = {},
): ReadableStream {
  const keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
  const maxQueue = Math.max(1, options.maxQueue ?? DEFAULT_MAX_QUEUE);
  const abortController = new AbortController();
  const pending: Uint8Array[] = [];
  let nextSequence = resolveNextSequence(options.lastEventId);
  let closed = false;
  let sourceEnded = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const closeOnce = async (reason: "completed" | "cancelled" | "aborted" | "errored", error?: unknown) => {
    if (closed) return;
    closed = true;
    if (keepalive) clearInterval(keepalive);
    options.signal?.removeEventListener("abort", forwardAbort);
    if (reason === "aborted" && controllerRef) {
      try {
        controllerRef.close();
      } catch {
        // The stream may already be cancelled by the HTTP runtime.
      }
    }
    abortController.abort();
    await options.onClose?.(reason, error);
  };

  const enqueueFrame = (frame: string) => {
    if (closed) return;
    if (pending.length >= maxQueue) {
      pending.shift();
    }
    pending.push(encoder.encode(frame));
    flush();
  };

  const closeControllerIfDone = () => {
    if (!sourceEnded || pending.length > 0 || !controllerRef || closed) return;
    controllerRef.close();
    void closeOnce("completed");
  };

  const flush = () => {
    if (!controllerRef || closed) return;
    while (pending.length > 0 && (controllerRef.desiredSize ?? 1) > 0) {
      controllerRef.enqueue(pending.shift()!);
    }
    closeControllerIfDone();
  };

  function forwardAbort() {
    void closeOnce("aborted");
  }
  options.signal?.addEventListener("abort", forwardAbort, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      keepalive = setInterval(() => enqueueFrame(": ping\n\n"), keepaliveMs);
      enqueueFrame(": connected\n\n");

      void (async () => {
        try {
          for await (const event of events) {
            if (closed || abortController.signal.aborted) break;
            const id = event.id ?? String(nextSequence++);
            enqueueFrame(encodeSseEvent({ ...event, id }));
          }
          sourceEnded = true;
          flush();
        } catch (error) {
          if (!closed) {
            controller.error(error);
          }
          await closeOnce("errored", error);
        }
      })();
    },
    pull() {
      flush();
    },
    async cancel() {
      await closeOnce("cancelled");
    },
  });

  return stream;
}

export function encodeSseEvent(event: StreamEvent): string {
  const lines: string[] = [];
  if (event.id !== undefined) lines.push(`id: ${sanitizeSseFieldValue(event.id)}`);
  lines.push(`event: ${sanitizeSseFieldValue(event.event)}`);
  lines.push(`data: ${toSingleLineJson(event.data)}`);
  return `${lines.join("\n")}\n\n`;
}

function resolveNextSequence(lastEventId: string | null | undefined): number {
  if (!lastEventId?.trim()) return 1;
  const parsed = Number.parseInt(lastEventId, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed + 1 : 1;
}

function sanitizeSseFieldValue(value: string): string {
  return value.replace(/[\r\n]/g, " ");
}

function toSingleLineJson(value: unknown): string {
  const encoded = JSON.stringify(value ?? null);
  return (encoded ?? "null").replace(/[\r\n]/g, " ");
}
