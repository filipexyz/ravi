/**
 * SESSION_PROMPTS JetStream stream
 *
 * Work queue stream for routing session prompts to exactly one daemon.
 * Replaces NATS core pub/sub for ravi.session.*.prompt subjects.
 *
 * WorkQueuePolicy guarantees:
 *   - Each message is delivered to exactly one consumer
 *   - Message is deleted from stream after ack
 *   - If daemon crashes before ack, message is redelivered after ack_wait
 *
 * A single shared consumer ("ravi-prompts") is used by all daemons.
 * NATS automatically distributes messages across active pull subscribers
 * on the same consumer — no per-daemon consumers needed.
 */

import { AckPolicy, DeliverPolicy, RetentionPolicy, StringCodec, type JetStreamManager } from "nats";
import { getNats, ensureConnected } from "../nats.js";
import { logger } from "../utils/logger.js";

const log = logger.child("session-stream");
const sc = StringCodec();

export const SESSION_STREAM = "SESSION_PROMPTS";
export const SESSION_SUBJECT_FILTER = "ravi.session.*.prompt";

/** Shared consumer name — all daemons pull from this single consumer. */
const CONSUMER_NAME = "ravi-prompts";

export function getConsumerName(): string {
  return CONSUMER_NAME;
}

/**
 * Ensure the SESSION_PROMPTS JetStream stream exists.
 * Safe to call multiple times — idempotent.
 * Called once during daemon startup before bot and omni consumer start.
 */
export async function ensureSessionPromptsStream(): Promise<void> {
  const nc = getNats();
  const jsm = await nc.jetstreamManager();

  try {
    await jsm.streams.info(SESSION_STREAM);
    log.debug("SESSION_PROMPTS stream already exists");
    return;
  } catch {
    // Stream doesn't exist — create it
  }

  await jsm.streams.add({
    name: SESSION_STREAM,
    subjects: [SESSION_SUBJECT_FILTER],
    retention: RetentionPolicy.Workqueue,
    storage: "memory" as never, // prompts are ephemeral — no need for disk persistence
    max_age: 60_000_000_000, // 60s in nanoseconds — drop stale prompts
    num_replicas: 1,
  });

  log.info("Created SESSION_PROMPTS JetStream stream", {
    subjects: [SESSION_SUBJECT_FILTER],
    retention: "workqueue",
    storage: "memory",
    max_age_s: 60,
  });
}

/**
 * Clean up stale per-daemon consumers from previous code.
 * Old versions created consumers named "ravi-prompts-{pid}-{random}".
 * WorkQueue only allows one consumer — delete them before creating the shared one.
 */
async function cleanupLegacyConsumers(jsm: JetStreamManager): Promise<void> {
  try {
    const consumers = await jsm.consumers.list(SESSION_STREAM).next();
    for (const c of consumers) {
      if (c.name !== CONSUMER_NAME && c.name.startsWith("ravi-prompts")) {
        try {
          await jsm.consumers.delete(SESSION_STREAM, c.name);
          log.info("Deleted legacy consumer", { name: c.name });
        } catch (err) {
          log.warn("Failed to delete legacy consumer", { name: c.name, error: err });
        }
      }
    }
  } catch (err) {
    log.warn("Failed to list consumers for cleanup", { error: err });
  }
}

/**
 * Ensure the shared durable consumer exists on SESSION_PROMPTS.
 * Called during bot startup. Safe to call multiple times — idempotent.
 *
 * All daemons share this single consumer. NATS distributes messages
 * across active pull subscribers automatically (round-robin).
 */
export async function ensureSessionConsumer(jsm: JetStreamManager): Promise<void> {
  // One-time migration: delete old per-daemon consumers (non-blocking — don't delay startup)
  cleanupLegacyConsumers(jsm).catch((err) => log.warn("Legacy consumer cleanup failed", { error: err }));

  try {
    await jsm.consumers.info(SESSION_STREAM, CONSUMER_NAME);
    log.debug("Session consumer already exists", { consumerName: CONSUMER_NAME });
    return;
  } catch {
    // Consumer doesn't exist — create it
  }

  await jsm.consumers.add(SESSION_STREAM, {
    durable_name: CONSUMER_NAME,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    // ack_wait: 5 minutes (in nanoseconds) — long turns shouldn't timeout
    ack_wait: 300_000_000_000,
  });

  log.info("Created session JetStream consumer", {
    stream: SESSION_STREAM,
    consumerName: CONSUMER_NAME,
    ack_wait_s: 300,
  });
}

/**
 * Publish a session prompt to the JetStream work queue.
 * Replaces: nats.emit(`ravi.session.${sessionName}.prompt`, payload)
 */
export async function publishSessionPrompt(sessionName: string, payload: Record<string, unknown>): Promise<void> {
  const nc = await ensureConnected();
  const js = nc.jetstream();
  await js.publish(`ravi.session.${sessionName}.prompt`, sc.encode(JSON.stringify(payload)));
}
