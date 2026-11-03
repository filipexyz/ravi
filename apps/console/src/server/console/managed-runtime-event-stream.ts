const DEFAULT_STREAM_WINDOW_MS = 24_000;
const DEFAULT_POLL_INTERVAL_MS = 1_250;

export type ManagedRuntimeStreamEvent = {
  id: string;
  sequence: number;
  [key: string]: unknown;
};

type EventPage = {
  items: ManagedRuntimeStreamEvent[];
  nextSequence: number;
};

type EventLoader = (afterSequence: number) => Promise<EventPage>;

type StreamOptions = {
  initialPage: EventPage;
  initialSequence: number;
  loadEvents: EventLoader;
  /** Required, fresh server authorization after loading and before any payload. */
  authorizeEmission: () => Promise<void>;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  streamWindowMs?: number;
};

const encoder = new TextEncoder();

export function managedRuntimeEventCursor(input: {
  after: string | null;
  lastEventId: string | null;
}) {
  const candidate = input.lastEventId ?? input.after ?? "0";
  const parsed = Number(candidate);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function encodeManagedRuntimeStreamEvent(event: ManagedRuntimeStreamEvent) {
  return encoder.encode(
    `id: ${event.sequence}\nevent: session\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

export function createManagedRuntimeEventStream(options: StreamOptions) {
  let stopped = false;
  let cleanup = () => {};
  const lifetime = new AbortController();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const stop = () => {
        if (stopped) return;
        stopped = true;
        cleanup();
        controller.close();
      };
      const abort = () => stop();
      cleanup = () => {
        options.signal?.removeEventListener("abort", abort);
        lifetime.abort();
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) { stop(); return; }

      let cursor = options.initialSequence;
      const startedAt = Date.now();
      const windowMs = options.streamWindowMs ?? DEFAULT_STREAM_WINDOW_MS;
      const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

      try {
        await options.authorizeEmission();
        if (stopped) return;
        controller.enqueue(encoder.encode(": connected\n\n"));
        cursor = enqueuePage(controller, options.initialPage, cursor);

        while (!stopped && Date.now() - startedAt < windowMs) {
          await delay(pollMs, lifetime.signal);
          if (stopped) break;
          const page = await options.loadEvents(cursor);
          if (stopped) break;
          await options.authorizeEmission();
          if (stopped) break;
          cursor = enqueuePage(controller, page, cursor);
          if (page.items.length === 0) {
            controller.enqueue(encoder.encode(`: heartbeat ${cursor}\n\n`));
          }
        }
      } catch {
        if (!stopped && !options.signal?.aborted) {
          controller.enqueue(
            encoder.encode(
              `event: stream_error\ndata: ${JSON.stringify({ error: "managed_runtime_stream_unavailable" })}\n\n`,
            ),
          );
        }
      } finally {
        stop();
      }
    },
    cancel() {
      stopped = true;
      cleanup();
    },
  });

  return stream;
}

function enqueuePage(
  controller: ReadableStreamDefaultController<Uint8Array>,
  page: EventPage,
  currentCursor: number,
) {
  let cursor = currentCursor;
  for (const event of page.items) {
    if (event.sequence <= cursor) continue;
    controller.enqueue(encodeManagedRuntimeStreamEvent(event));
    cursor = event.sequence;
  }
  return Math.max(cursor, page.nextSequence);
}

async function delay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}
