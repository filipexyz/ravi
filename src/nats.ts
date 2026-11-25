/**
 * NATS Singleton
 *
 * Direct NATS connection — pub/sub only, no JetStream.
 * Pub/sub only — no JetStream, no persistence.
 *
 * Supports both explicit connect (daemon) and lazy connect (CLI).
 */

import { connect, type Msg, type NatsConnection, type Subscription, StringCodec } from "nats";
import { redactNatsUrl } from "./security/nats-exposure.js";
import { logger } from "./utils/logger.js";

const log = logger.child("nats");
const sc = StringCodec();

const DEFAULT_URL = process.env.NATS_URL || "nats://127.0.0.1:4222";

let nc: NatsConnection | null = null;
let connecting: { promise: Promise<void>; failureLogged: boolean } | null = null;
let explicitConnect = false;

/**
 * Explicitly connect to NATS. Used by daemon on startup.
 *
 * With retry enabled (default for daemon), retries up to 30 times with 2s intervals
 * to handle PM2 parallel startup where NATS might not be ready yet.
 */
export async function connectNats(
  url = DEFAULT_URL,
  opts?: { explicit?: boolean; retry?: boolean; quiet?: boolean },
): Promise<void> {
  const maxRetries = opts?.retry !== false && opts?.explicit ? 30 : 1;
  const retryInterval = 2000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      nc = await connect({
        servers: url,
        reconnect: true,
        maxReconnectAttempts: -1,
      });

      if (opts?.explicit) explicitConnect = true;

      log.info("Connected to NATS", { server: redactNatsUrl(url), attempt });

      // Log status changes (only for long-lived daemon connections)
      if (opts?.explicit) {
        (async () => {
          for await (const s of nc!.status()) {
            log.debug("NATS status", { type: s.type, data: s.data });
          }
        })().catch(() => {});
      }
      return;
    } catch (err) {
      if (attempt === maxRetries) {
        log[opts?.quiet ? "debug" : "error"]("Failed to connect to NATS after all retries", {
          url: redactNatsUrl(url),
          attempts: maxRetries,
        });
        throw err;
      }
      log.info("NATS not ready, retrying...", { url: redactNatsUrl(url), attempt, maxRetries });
      await new Promise((r) => setTimeout(r, retryInterval));
    }
  }
}

export { redactNatsUrl };

/** Whether NATS was explicitly connected (daemon) vs lazy (CLI) */
export function isExplicitConnect(): boolean {
  return explicitConnect;
}

/**
 * Lazy connect — called automatically on first emit/subscribe.
 * Allows CLI commands to work without explicit connectNats().
 *
 * `quiet` is for best-effort callers (the CLI audit event) that ignore a
 * missing daemon: their failure logs at debug instead of printing an error
 * after a command that succeeded. Other callers still get the error line, once
 * per attempt, even when they join an attempt a quiet caller started.
 */
export async function ensureConnected(opts?: { quiet?: boolean }): Promise<NatsConnection> {
  if (nc) return nc;
  if (!connecting) {
    const quiet = opts?.quiet === true;
    // A loud attempt logs its own failure inside connectNats.
    const next = { failureLogged: !quiet, promise: connectNats(DEFAULT_URL, { quiet }) };
    next.promise = next.promise.finally(() => {
      if (connecting === next) connecting = null;
    });
    connecting = next;
  }
  const attempt = connecting;
  try {
    await attempt.promise;
  } catch (err) {
    if (!opts?.quiet && !attempt.failureLogged) {
      attempt.failureLogged = true;
      log.error("Failed to connect to NATS after all retries", { url: redactNatsUrl(DEFAULT_URL), attempts: 1 });
    }
    throw err;
  }
  return nc!;
}

export function isSessionResponseTopic(topic: string): boolean {
  return /^ravi\.session\.[^.]+\.response$/.test(topic);
}

export function getNats(): NatsConnection {
  if (!nc) throw new Error("NATS not connected — call connectNats() first");
  return nc;
}

/**
 * Publish JSON data to a topic.
 * Drop-in replacement for nats.emit()
 */
export async function publish(
  topic: string,
  data: Record<string, unknown>,
  opts?: { quietConnect?: boolean },
): Promise<void> {
  const conn = await ensureConnected({ quiet: opts?.quietConnect });

  // Trace session-response emissions (helps debug ghost chat replies).
  // Approval/system topics such as `ravi.approval.response` are not chat emits
  // and must not trip this detector when a reaction resolves HIL without a
  // matching in-process session.response waiter.
  if (isSessionResponseTopic(topic) && !("_emitId" in data)) {
    const stack = new Error().stack?.split("\n").slice(2, 8).join("\n") || "no stack";
    log.warn("GHOST_EMIT_DETECTED", {
      topic,
      keys: Object.keys(data),
      fullData: JSON.stringify(data).slice(0, 500),
      stack,
    });
  }

  conn.publish(topic, sc.encode(JSON.stringify(data)));
}

/** Wait until the server has processed everything published on this connection. */
export async function flushNats(): Promise<void> {
  const conn = await ensureConnected();
  await conn.flush();
}

export interface SubscribeOptions {
  /** NATS queue group name. When set, only one subscriber in the group receives each message. */
  queue?: string;
  /** Closes the subscriptions and wakes an idle next() during owner shutdown. */
  signal?: AbortSignal;
}

function assertSubscriptionCleanup(failures: Error[]): void {
  if (failures.length) throw new AggregateError(failures, "NATS subscription close failed", { cause: failures[0] });
}

async function* abortableSubscription(sub: Subscription, signal: AbortSignal): AsyncGenerator<Msg> {
  const failures: Error[] = [];
  let closed = false;
  let unsubscribeFailed = false;
  let iterator: AsyncIterator<Msg> | undefined;
  let wake: (() => void) | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      sub.unsubscribe();
    } catch (cause) {
      unsubscribeFailed = true;
      failures.push(new Error("NATS subscription unsubscribe failed", { cause }));
      // A failed unsubscribe cannot settle an idle next(); fail the proof
      // without waiting forever for cleanup that the transport rejected.
      wake?.();
    }
  };
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) close();
  try {
    iterator = sub[Symbol.asyncIterator]();
    while (!signal.aborted) {
      const result = await new Promise<IteratorResult<Msg>>((resolve, reject) => {
        wake = () => resolve({ done: true, value: undefined });
        Promise.resolve(iterator!.next()).then(resolve, reject);
      });
      wake = undefined;
      if (result.done || signal.aborted) break;
      yield result.value;
    }
  } catch (cause) {
    failures.push(new Error("NATS subscription iteration failed", { cause }));
  } finally {
    signal.removeEventListener("abort", close);
    close();
    if (!unsubscribeFailed) {
      try {
        await iterator?.return?.();
      } catch (cause) {
        failures.push(new Error("NATS subscription iterator return failed", { cause }));
      }
    }
    assertSubscriptionCleanup(failures);
  }
}

/**
 * Subscribe to one or more topic patterns.
 * Drop-in replacement for nats.subscribe()
 *
 * Supports variadic patterns: subscribe("a.*", "b.*") merges both into one stream.
 * NATS '*' = single-token wildcard, '>' = multi-level wildcard.
 *
 * For queue groups, pass an options object as the last argument:
 *   subscribe("ravi.session.*.response", { queue: "ravi-gateway" })
 *   subscribe(["ravi.a.*", "ravi.b.*"], { queue: "ravi-gateway" })
 *
 * Queue groups ensure only one subscriber in the group receives each message —
 * essential for multi-daemon deployments.
 */
export async function* subscribe(
  ...args: [...string[], SubscribeOptions] | string[]
): AsyncGenerator<{ topic: string; data: Record<string, unknown> }> {
  const last = args[args.length - 1];
  if (typeof last === "object" && last?.signal?.aborted) return;
  const conn = await ensureConnected();

  // Parse args: last element may be an options object (not a string)
  let patternList: string[];
  let opts: SubscribeOptions | undefined;
  if (args.length > 0 && typeof last === "object" && last !== null && !Array.isArray(last)) {
    opts = last as SubscribeOptions;
    patternList = args.slice(0, -1) as string[];
  } else {
    patternList = args as string[];
  }

  if (patternList.length === 0 || opts?.signal?.aborted) return;

  const subOpts = opts?.queue ? { queue: opts.queue } : undefined;

  // Content-based dedup: JetStream streams can cause `>` wildcard subscribers to
  // receive the same message twice (original publish + consumer delivery with $JS.ACK reply).
  // Track recently seen subject+payload fingerprints within a short window.
  const _dedup = new Map<string, number>();
  const DEDUP_WINDOW_MS = 250;
  let _dedupOps = 0;

  function isDuplicate(subject: string, raw: string): boolean {
    const key = subject + "\0" + raw.slice(0, 256);
    const now = Date.now();
    const prev = _dedup.get(key);
    if (prev !== undefined && now - prev < DEDUP_WINDOW_MS) return true;
    _dedup.set(key, now);
    if (++_dedupOps >= 500) {
      _dedupOps = 0;
      for (const [k, t] of _dedup) {
        if (now - t > DEDUP_WINDOW_MS) _dedup.delete(k);
      }
    }
    return false;
  }

  if (patternList.length === 1) {
    // Fast path: single subscription
    const sub = conn.subscribe(patternList[0], subOpts);
    for await (const msg of opts?.signal ? abortableSubscription(sub, opts.signal) : sub) {
      // Skip NATS internal subjects (JetStream replies, API calls, advisories)
      if (msg.subject.startsWith("_INBOX.") || msg.subject.startsWith("$")) continue;
      // Skip JetStream consumer deliveries (reply=$JS.ACK...) — these are duplicates
      // of messages already received via core pub/sub when a stream captures the subject
      if (msg.reply?.startsWith("$JS.ACK.")) continue;
      try {
        const raw = sc.decode(msg.data);
        if (isDuplicate(msg.subject, raw)) continue;
        const data = JSON.parse(raw) as Record<string, unknown>;
        yield { topic: msg.subject, data };
      } catch {
        // Silently skip non-JSON messages (e.g. JetStream headers, binary payloads)
      }
    }
    return;
  }

  // Multi-pattern: merge multiple subscriptions into one async generator
  type Event = { topic: string; data: Record<string, unknown> };
  const queue: Event[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  const subs = patternList.map((p) => conn.subscribe(p, subOpts));
  const cancellation = opts?.signal ? new AbortController() : undefined;
  const onAbort = () => {
    done = true;
    cancellation?.abort();
    resolve?.();
  };
  opts?.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts?.signal?.aborted) onAbort();
  let remaining = subs.length;

  // Pump each subscription into the shared queue
  const pumps = subs.map(async (sub) => {
    try {
      for await (const msg of cancellation ? abortableSubscription(sub, cancellation.signal) : sub) {
        if (done) return;
        // Skip NATS internal subjects (JetStream replies, API calls, advisories)
        if (msg.subject.startsWith("_INBOX.") || msg.subject.startsWith("$")) continue;
        // Skip JetStream consumer deliveries (duplicates of core pub/sub)
        if (msg.reply?.startsWith("$JS.ACK.")) continue;
        try {
          const raw = sc.decode(msg.data);
          if (isDuplicate(msg.subject, raw)) continue;
          const data = JSON.parse(raw) as Record<string, unknown>;
          queue.push({ topic: msg.subject, data });
          resolve?.();
        } catch {
          // Silently skip non-JSON messages (e.g. JetStream headers, binary payloads)
        }
      }
    } catch (cause) {
      if (cancellation) onAbort();
      throw cause;
    } finally {
      remaining -= 1;
      if (cancellation && remaining === 0) {
        done = true;
        resolve?.();
      }
    }
  });

  // Observe pump rejection immediately; shutdown still reports every failure.
  const settledPumps = opts?.signal ? Promise.allSettled(pumps) : undefined;

  try {
    while (!done || (cancellation && !cancellation.signal.aborted && queue.length > 0)) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        await new Promise<void>((r) => {
          resolve = r;
        });
        resolve = null;
      }
    }
  } finally {
    done = true;
    opts?.signal?.removeEventListener("abort", onAbort);
    if (!opts?.signal) {
      for (const sub of subs) sub.unsubscribe();
      await Promise.allSettled(pumps);
    } else {
      onAbort();
      const failures: Error[] = [];
      for (const result of (await settledPumps) ?? []) {
        if (result.status === "rejected")
          failures.push(new Error("NATS subscription pump failed", { cause: result.reason }));
      }
      assertSubscriptionCleanup(failures);
    }
  }
}

/**
 * Drain and close the NATS connection.
 */
export async function closeNats(options: { drainTimeoutMs?: number } = {}): Promise<void> {
  // A lazy connection still being established has no `nc` yet. Closing now would do nothing, the handshake would
  // finish afterwards and the open socket would keep the process alive. Wait for the attempt, then close what it
  // opened. A failed attempt leaves nothing to close. The daemon connects explicitly and never lands here mid-attempt.
  if (!nc && connecting) {
    try {
      await connecting.promise;
    } catch (error) {
      // The caller that started the attempt reports its own failure; here it only means there is nothing to close.
      log.debug("Pending NATS connect failed before close", { error: error instanceof Error ? error.message : error });
    }
  }
  if (nc) {
    const current = nc;
    if (options.drainTimeoutMs && options.drainTimeoutMs > 0) {
      await drainWithTimeout(current, options.drainTimeoutMs);
    } else {
      await current.drain();
    }
    nc = null;
    explicitConnect = false;
    log.info("NATS connection closed");
  }
}

async function drainWithTimeout(conn: NatsConnection, timeoutMs: number): Promise<void> {
  let timedOut = false;
  await Promise.race([
    conn.drain(),
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timedOut) {
    log.warn("NATS drain timed out; closing connection", { timeoutMs });
    await conn.close();
  }
}

/**
 * Convenience object for emit/subscribe/close.
 *
 * Usage: import { nats } from "./nats.js";
 *        nats.emit(topic, data)
 *        nats.subscribe(pattern)
 */
export const nats = {
  emit: publish,
  subscribe: (...args: [...string[], SubscribeOptions] | string[]) =>
    subscribe(...(args as Parameters<typeof subscribe>)),
  close: closeNats,
};
