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
 * Explicitly connect to NATS. Used by daemon after starting nats-server.
 */
export async function connectNats(
  url = DEFAULT_URL,
  opts?: { explicit?: boolean }
): Promise<void> {
  nc = await connect({
    servers: url,
    reconnect: true,
    maxReconnectAttempts: -1,
  });

  if (opts?.explicit) explicitConnect = true;

  log.info("Connected to NATS", { server: url });

  // Log status changes (only for long-lived daemon connections)
  if (opts?.explicit) {
    (async () => {
      for await (const s of nc!.status()) {
        log.debug("NATS status", { type: s.type, data: s.data });
      }
    })().catch(() => {});
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

/**
 * Subscribe to one or more topic patterns.
 * Drop-in replacement for nats.subscribe()
 *
 * Supports variadic patterns: subscribe("a.*", "b.*") merges both into one stream.
 * NATS '*' = single-token wildcard, '>' = multi-level wildcard.
 */
export async function* subscribe(
  ...patterns: string[]
): AsyncGenerator<{ topic: string; data: Record<string, unknown> }> {
  const conn = await ensureConnected();
  if (patterns.length === 0) return;

  if (patterns.length === 1) {
    // Fast path: single subscription
    const sub = conn.subscribe(patterns[0]);
    for await (const msg of sub) {
      try {
        const raw = sc.decode(msg.data);
        const data = JSON.parse(raw) as Record<string, unknown>;
        yield { topic: msg.subject, data };
      } catch (err) {
        log.warn("Failed to parse NATS message", {
          subject: msg.subject,
          error: err,
        });
      }
    }
    return;
  }

  // Multi-pattern: merge multiple subscriptions into one async generator
  type Event = { topic: string; data: Record<string, unknown> };
  const queue: Event[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  const subs = patterns.map((p) => conn.subscribe(p));

  // Pump each subscription into the shared queue
  const pumps = subs.map(async (sub) => {
    for await (const msg of sub) {
      if (done) return;
      try {
        const raw = sc.decode(msg.data);
        const data = JSON.parse(raw) as Record<string, unknown>;
        queue.push({ topic: msg.subject, data });
        resolve?.();
      } catch (err) {
        log.warn("Failed to parse NATS message", {
          subject: msg.subject,
          error: err,
        });
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
  subscribe,
  close: closeNats,
};
