/**
 * NATS Singleton
 *
 * Direct NATS connection — pub/sub only, no JetStream.
 * Pub/sub only — no JetStream, no persistence.
 *
 * Supports both explicit connect (daemon) and lazy connect (CLI).
 */

import { connect, type NatsConnection, StringCodec } from "nats";
import { logger } from "./utils/logger.js";

const log = logger.child("nats");
const sc = StringCodec();

const DEFAULT_URL = process.env.NATS_URL || "nats://127.0.0.1:4222";

let nc: NatsConnection | null = null;
let connecting: Promise<void> | null = null;
let explicitConnect = false;

/**
 * Explicitly connect to NATS. Used by daemon on startup.
 *
 * With retry enabled (default for daemon), retries up to 30 times with 2s intervals
 * to handle PM2 parallel startup where NATS might not be ready yet.
 */
export async function connectNats(
  url = DEFAULT_URL,
  opts?: { explicit?: boolean; retry?: boolean }
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

      log.info("Connected to NATS", { server: url, attempt });

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
        log.error("Failed to connect to NATS after all retries", { url, attempts: maxRetries });
        throw err;
      }
      log.info("NATS not ready, retrying...", { url, attempt, maxRetries });
      await new Promise((r) => setTimeout(r, retryInterval));
    }
  }
}

/** Whether NATS was explicitly connected (daemon) vs lazy (CLI) */
export function isExplicitConnect(): boolean {
  return explicitConnect;
}

/**
 * Lazy connect — called automatically on first emit/subscribe.
 * Allows CLI commands to work without explicit connectNats().
 */
async function ensureConnected(): Promise<NatsConnection> {
  if (nc) return nc;
  if (!connecting) {
    connecting = connectNats(DEFAULT_URL).finally(() => { connecting = null; });
  }
  await connecting;
  return nc!;
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
  data: Record<string, unknown>
): Promise<void> {
  const conn = await ensureConnected();

  // Trace .response emissions (helps debug ghost responses)
  if (topic.includes(".response")) {
    const hasEmitId = "_emitId" in data;
    if (!hasEmitId) {
      const stack =
        new Error().stack?.split("\n").slice(2, 8).join("\n") || "no stack";
      log.warn("GHOST_EMIT_DETECTED", {
        topic,
        keys: Object.keys(data),
        fullData: JSON.stringify(data).slice(0, 500),
        stack,
      });
    }
  }

  conn.publish(topic, sc.encode(JSON.stringify(data)));
}

export interface SubscribeOptions {
  /** NATS queue group name. When set, only one subscriber in the group receives each message. */
  queue?: string;
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
  const conn = await ensureConnected();

  // Parse args: last element may be an options object (not a string)
  let patternList: string[];
  let opts: SubscribeOptions | undefined;
  const last = args[args.length - 1];
  if (args.length > 0 && typeof last === "object" && last !== null && !Array.isArray(last)) {
    opts = last as SubscribeOptions;
    patternList = args.slice(0, -1) as string[];
  } else {
    patternList = args as string[];
  }

  if (patternList.length === 0) return;

  const subOpts = opts?.queue ? { queue: opts.queue } : undefined;

  if (patternList.length === 1) {
    // Fast path: single subscription
    const sub = conn.subscribe(patternList[0], subOpts);
    for await (const msg of sub) {
      // Skip NATS internal subjects (JetStream replies, API calls, advisories)
      if (msg.subject.startsWith("_INBOX.") || msg.subject.startsWith("$")) continue;
      // Skip JetStream consumer deliveries (reply=$JS.ACK...) — these are duplicates
      // of messages already received via core pub/sub when a stream captures the subject
      if (msg.reply?.startsWith("$JS.ACK.")) continue;
      try {
        const raw = sc.decode(msg.data);
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

  // Pump each subscription into the shared queue
  const pumps = subs.map(async (sub) => {
    for await (const msg of sub) {
      if (done) return;
      // Skip NATS internal subjects (JetStream replies, API calls, advisories)
      if (msg.subject.startsWith("_INBOX.") || msg.subject.startsWith("$")) continue;
      // Skip JetStream consumer deliveries (duplicates of core pub/sub)
      if (msg.reply?.startsWith("$JS.ACK.")) continue;
      try {
        const raw = sc.decode(msg.data);
        const data = JSON.parse(raw) as Record<string, unknown>;
        queue.push({ topic: msg.subject, data });
        resolve?.();
      } catch {
        // Silently skip non-JSON messages (e.g. JetStream headers, binary payloads)
      }
    }
  });

  try {
    while (!done) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        await new Promise<void>((r) => { resolve = r; });
        resolve = null;
      }
    }
  } finally {
    done = true;
    for (const sub of subs) sub.unsubscribe();
    await Promise.allSettled(pumps);
  }
}

/**
 * Drain and close the NATS connection.
 */
export async function closeNats(): Promise<void> {
  if (nc) {
    await nc.drain();
    nc = null;
    log.info("NATS connection closed");
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
  subscribe: (...args: [...string[], SubscribeOptions] | string[]) => subscribe(...(args as Parameters<typeof subscribe>)),
  close: closeNats,
};
