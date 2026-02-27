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
 */

import { AckPolicy, DeliverPolicy, RetentionPolicy, StringCodec, type JetStreamManager } from "nats";
import { getNats } from "../nats.js";
import { logger } from "../utils/logger.js";

const log = logger.child("session-stream");
const sc = StringCodec();

export const SESSION_STREAM = "SESSION_PROMPTS";
export const SESSION_SUBJECT_FILTER = "ravi.session.*.prompt";

/**
 * Each daemon registers its own durable consumer on SESSION_PROMPTS.
 * NATS WorkQueuePolicy distributes messages across all active consumers —
 * each message goes to exactly one consumer (one daemon).
 *
 * Consumer name includes daemonId to ensure uniqueness per instance.
 * Unlike a shared consumer, this enables true parallel distribution.
 */
export function makeConsumerName(daemonId: string): string {
  return `ravi-prompts-${daemonId}`;
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
    storage: "memory" as never,   // prompts are ephemeral — no need for disk persistence
    max_age: 60_000_000_000,      // 60s in nanoseconds — drop stale prompts
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
 * Ensure a per-daemon durable consumer exists on SESSION_PROMPTS.
 * Called during bot startup. Safe to call multiple times.
 *
 * Each daemon uses a unique consumer name (ravi-prompts-{daemonId}) so that
 * NATS distributes messages across all running daemons simultaneously.
 * WorkQueuePolicy guarantees each message is delivered to exactly one consumer.
 */
export async function ensureSessionConsumer(jsm: JetStreamManager, consumerName: string): Promise<void> {
  try {
    await jsm.consumers.info(SESSION_STREAM, consumerName);
    log.debug("Session consumer already exists", { consumerName });
    return;
  } catch {
    // Consumer doesn't exist — create it
  }

  await jsm.consumers.add(SESSION_STREAM, {
    durable_name: consumerName,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    // ack_wait: 5 minutes (in nanoseconds) — long turns shouldn't timeout
    ack_wait: 300_000_000_000,
  });

  log.info("Created session JetStream consumer", {
    stream: SESSION_STREAM,
    consumerName,
    ack_wait_s: 300,
  });
}

/**
 * Publish a session prompt to the JetStream work queue.
 * Replaces: nats.emit(`ravi.session.${sessionName}.prompt`, payload)
 */
export async function publishSessionPrompt(
  sessionName: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const nc = getNats();
  const js = nc.jetstream();
  await js.publish(
    `ravi.session.${sessionName}.prompt`,
    sc.encode(JSON.stringify(payload)),
  );
}
