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
import { inferDeliveryBarrier, requireDeliveryBarrier, type DeliveryBarrierSource } from "../delivery-barriers.js";
import { recordPromptPublishedTrace } from "../session-trace/channel-trace.js";
import { logger } from "../utils/logger.js";

const log = logger.child("session-stream");
const sc = StringCodec();

export const SESSION_STREAM = "SESSION_PROMPTS";
export const SESSION_SUBJECT_FILTER = "ravi.session.*.prompt";

/** Shared consumer name — all daemons pull from this single consumer. */
const CONSUMER_NAME = "ravi-prompts";
let legacyConsumerCleanupComplete = false;
let legacyConsumerCleanupInFlight: Promise<void> | null = null;
let sessionPromptInfrastructureInFlight: Promise<void> | null = null;

export function getConsumerName(): string {
  return CONSUMER_NAME;
}

/**
 * Ensure the SESSION_PROMPTS JetStream stream exists.
 * Safe to call multiple times — idempotent.
 * Called once during daemon startup before bot and omni consumer start.
 */
export async function ensureSessionPromptsStream(existingJsm?: JetStreamManager): Promise<void> {
  const jsm = existingJsm ?? (await getNats().jetstreamManager());

  try {
    await jsm.streams.info(SESSION_STREAM);
    log.debug("SESSION_PROMPTS stream already exists");
    return;
  } catch {
    // Stream doesn't exist — create it
  }

  try {
    await jsm.streams.add({
      name: SESSION_STREAM,
      subjects: [SESSION_SUBJECT_FILTER],
      retention: RetentionPolicy.Workqueue,
      storage: "memory" as never, // prompts are ephemeral — no need for disk persistence
      max_age: 60_000_000_000, // 60s in nanoseconds — drop stale prompts
      num_replicas: 1,
    });
  } catch (err) {
    await ensureStreamExistsAfterRace(jsm, err);
    return;
  }

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
  const consumers = await jsm.consumers.list(SESSION_STREAM).next();
  for (const c of consumers) {
    if (c.name !== CONSUMER_NAME && c.name.startsWith("ravi-prompts")) {
      try {
        await jsm.consumers.delete(SESSION_STREAM, c.name);
        log.info("Deleted legacy consumer", { name: c.name });
      } catch (err) {
        if (isNotFoundError(err)) {
          log.debug("Legacy consumer already gone", { name: c.name });
          continue;
        }
        log.warn("Failed to delete legacy consumer", { name: c.name, error: err });
        throw err;
      }
    }
  }
}

async function ensureLegacyConsumersCleaned(jsm: JetStreamManager): Promise<void> {
  if (legacyConsumerCleanupComplete) return;
  if (!legacyConsumerCleanupInFlight) {
    legacyConsumerCleanupInFlight = cleanupLegacyConsumers(jsm)
      .then(() => {
        legacyConsumerCleanupComplete = true;
      })
      .catch((err) => {
        log.warn("Legacy consumer cleanup failed", { error: err });
        throw err;
      })
      .finally(() => {
        legacyConsumerCleanupInFlight = null;
      });
  }
  await legacyConsumerCleanupInFlight;
}

/**
 * Ensure the shared durable consumer exists on SESSION_PROMPTS.
 * Called during bot startup. Safe to call multiple times — idempotent.
 *
 * All daemons share this single consumer. NATS distributes messages
 * across active pull subscribers automatically (round-robin).
 */
export async function ensureSessionConsumer(jsm: JetStreamManager): Promise<void> {
  // One-time migration: delete old per-daemon consumers before adding the shared one.
  // If cleanup fails, the next recovery pass retries instead of permanently skipping it.
  await ensureLegacyConsumersCleaned(jsm);

  try {
    await jsm.consumers.info(SESSION_STREAM, CONSUMER_NAME);
    log.debug("Session consumer already exists", { consumerName: CONSUMER_NAME });
    return;
  } catch {
    // Consumer doesn't exist — create it
  }

  try {
    await jsm.consumers.add(SESSION_STREAM, {
      durable_name: CONSUMER_NAME,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      // ack_wait: 5 minutes (in nanoseconds) — long turns shouldn't timeout
      ack_wait: 300_000_000_000,
    });
  } catch (err) {
    await ensureConsumerExistsAfterRace(jsm, err);
    return;
  }

  log.info("Created session JetStream consumer", {
    stream: SESSION_STREAM,
    consumerName: CONSUMER_NAME,
    ack_wait_s: 300,
  });
}

/**
 * Ensure both sides of the prompt work queue exist.
 *
 * This is intentionally safe to call from publishers and health checks. If NATS
 * restarts, the memory-backed stream and durable consumer can disappear while
 * the daemon process stays alive; re-ensuring both pieces lets the pull loop
 * recover without requiring a full daemon restart.
 */
export async function ensureSessionPromptInfrastructure(existingJsm?: JetStreamManager): Promise<void> {
  if (sessionPromptInfrastructureInFlight) return sessionPromptInfrastructureInFlight;

  sessionPromptInfrastructureInFlight = ensureSessionPromptInfrastructureOnce(existingJsm).finally(() => {
    sessionPromptInfrastructureInFlight = null;
  });
  return sessionPromptInfrastructureInFlight;
}

async function ensureSessionPromptInfrastructureOnce(existingJsm?: JetStreamManager): Promise<void> {
  const jsm = existingJsm ?? (await getNats().jetstreamManager());
  await ensureSessionPromptsStream(jsm);
  await ensureSessionConsumer(jsm);
}

/**
 * Publish a session prompt to the JetStream work queue.
 * Replaces: nats.emit(`ravi.session.${sessionName}.prompt`, payload)
 */
export async function publishSessionPrompt(sessionName: string, payload: Record<string, unknown>): Promise<void> {
  const nc = await ensureConnected();
  await ensureSessionPromptInfrastructure();
  const js = nc.jetstream();
  const explicitDeliveryBarrier = typeof payload.deliveryBarrier === "string" ? payload.deliveryBarrier : undefined;
  const hasExplicitBarrier = Boolean(explicitDeliveryBarrier?.trim());
  const deliveryBarrier = hasExplicitBarrier
    ? requireDeliveryBarrier(explicitDeliveryBarrier, "deliveryBarrier")
    : inferDeliveryBarrier(payload);
  const deliveryBarrierSource =
    typeof payload.deliveryBarrierSource === "string" && isDeliveryBarrierSource(payload.deliveryBarrierSource)
      ? payload.deliveryBarrierSource
      : hasExplicitBarrier
        ? "explicit"
        : "inferred";
  const enrichedPayload = {
    ...payload,
    deliveryBarrier,
    deliveryBarrierSource,
  };
  await js.publish(`ravi.session.${sessionName}.prompt`, sc.encode(JSON.stringify(enrichedPayload)));
  try {
    recordPromptPublishedTrace({ sessionName, payload: enrichedPayload });
  } catch (error) {
    log.warn("Failed to record prompt published trace", { sessionName, error });
  }
}

function isDeliveryBarrierSource(value: string): value is DeliveryBarrierSource {
  return value === "explicit" || value === "default" || value === "inferred";
}

async function ensureStreamExistsAfterRace(jsm: JetStreamManager, originalError: unknown): Promise<void> {
  try {
    await jsm.streams.info(SESSION_STREAM);
    log.debug("SESSION_PROMPTS stream created concurrently");
  } catch {
    throw originalError;
  }
}

async function ensureConsumerExistsAfterRace(jsm: JetStreamManager, originalError: unknown): Promise<void> {
  try {
    await jsm.consumers.info(SESSION_STREAM, CONSUMER_NAME);
    log.debug("Session consumer created concurrently", { consumerName: CONSUMER_NAME });
  } catch {
    throw originalError;
  }
}

function isNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return message.includes("not found") || message.includes("deleted");
}
