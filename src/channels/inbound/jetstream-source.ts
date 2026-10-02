/**
 * Durable JetStream pull loop shared by every inbound source.
 *
 * Byte-for-byte the semantics the channel consumer always had: a durable pull consumer
 * with `DeliverPolicy.New` and explicit ack, created when missing; messages are acked
 * **before** the handler runs (fire-and-forget, so a slow handler never stalls the
 * stream); undecodable payloads are nak'd; a missing stream is waited for (or created
 * through `ensureStream` for ravi-owned streams); bootstrap errors are retried.
 */

import { AckPolicy, DeliverPolicy, StringCodec, type JetStreamClient, type JetStreamManager } from "nats";
import type { Logger } from "../../utils/logger.js";

/** Wait up to 60s for streams to appear before unblocking start(). */
export const DURABLE_PULL_READY_TIMEOUT_MS = 60_000;
export const DURABLE_PULL_RETRY_DELAY_MS = 2_000;

const sc = StringCodec();

export interface DurablePullSubscription {
  stream: string;
  durable: string;
  filterSubject: string;
}

export interface RunDurablePullLoopOptions {
  js: JetStreamClient;
  jsm: JetStreamManager;
  subscription: DurablePullSubscription;
  /** Called when the stream is missing (CHANNEL_INBOUND); otherwise wait/retry until it appears (Omni streams). */
  ensureStream?: (jsm: JetStreamManager) => Promise<void>;
  /** Receives the subject and the JSON-decoded payload of every message (after it was acked). */
  handle: (subject: string, data: unknown) => Promise<void>;
  isRunning: () => boolean;
  log: Pick<Logger, "debug" | "info" | "warn" | "error">;
  /** Test seam: ready fallback and per-attempt consumer deadline. Default 60s. */
  readyTimeoutMs?: number;
  /** Test seam: delay between retries. Default 2s. */
  retryDelayMs?: number;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam (deadline clock). */
  now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isJetStreamBootstrapError(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return message.includes("stream not found") || message.includes("consumer not found");
}

/**
 * Ensure the durable pull consumer exists on its stream.
 * Retries until the stream appears (a publisher may still be initializing) or the deadline passes.
 * Returns false on timeout or when the loop stopped.
 */
export async function ensureDurableConsumer(
  options: Pick<RunDurablePullLoopOptions, "jsm" | "subscription" | "ensureStream" | "isRunning" | "log"> & {
    timeoutMs?: number;
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<boolean> {
  const { jsm, subscription, ensureStream, isRunning, log } = options;
  const { stream, durable: name, filterSubject } = subscription;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const retryDelayMs = options.retryDelayMs ?? DURABLE_PULL_RETRY_DELAY_MS;
  const deadline = now() + (options.timeoutMs ?? DURABLE_PULL_READY_TIMEOUT_MS);

  while (isRunning() && now() < deadline) {
    try {
      await jsm.streams.info(stream);
    } catch (err) {
      if (!isRunning()) return false;
      if (ensureStream) {
        // Ravi-owned stream (CHANNEL_INBOUND): create it instead of waiting for a publisher.
        try {
          await ensureStream(jsm);
          continue;
        } catch (ensureErr) {
          log.warn("Failed to create JetStream stream, retrying in 2s", { stream, name, error: ensureErr });
        }
      } else {
        log.debug("JetStream stream not ready yet, retrying in 2s", { stream, name, error: err });
      }
      await sleep(retryDelayMs);
      continue;
    }

    // Check if consumer already exists
    try {
      await jsm.consumers.info(stream, name);
      log.debug("Consumer already exists", { stream, name });
      return true;
    } catch {
      // Not found — try to create
    }

    // Try to create the consumer
    try {
      await jsm.consumers.add(stream, {
        durable_name: name,
        filter_subject: filterSubject,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.New,
      });
      log.info("Created JetStream consumer", { stream, name, filter: filterSubject });
      return true;
    } catch (err) {
      // Stream may not exist yet (publisher still initializing — retry)
      if (!isRunning()) return false;
      log.debug("JetStream consumer not ready yet, retrying in 2s", { stream, name, error: err });
      await sleep(retryDelayMs);
    }
  }

  log.error("Timed out waiting for JetStream stream to appear", { stream, name });
  return false;
}

/**
 * Run one durable pull loop.
 *
 * Resolves once the consumer is ready (the first `consume()` call succeeded), when the
 * loop stops, or after the ready fallback (60s) — whichever comes first. The loop keeps
 * pulling (and retrying) in the background until `isRunning()` turns false.
 */
export function runDurablePullLoop(options: RunDurablePullLoopOptions): Promise<void> {
  const { js, jsm, subscription, ensureStream, handle, isRunning, log } = options;
  const { stream, durable: consumerName } = subscription;
  const readyTimeoutMs = options.readyTimeoutMs ?? DURABLE_PULL_READY_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DURABLE_PULL_RETRY_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;

  return new Promise<void>((resolveReady) => {
    let notifiedReady = false;

    const markReady = () => {
      if (!notifiedReady) {
        notifiedReady = true;
        resolveReady();
      }
    };

    // Fallback: unblock start() after timeout even if streams never appear.
    // The loop continues retrying in the background.
    const readyFallback = setTimeout(() => {
      if (!notifiedReady) {
        log.warn("Consumer ready timeout — unblocking start(), will keep retrying in background", { stream });
        markReady();
      }
    }, readyTimeoutMs);

    (async () => {
      while (isRunning()) {
        try {
          // Ensure consumer exists (retries until stream is available)
          const ready = await ensureDurableConsumer({
            jsm,
            subscription,
            ensureStream,
            isRunning,
            log,
            timeoutMs: readyTimeoutMs,
            retryDelayMs,
            sleep,
            now: options.now,
          });
          if (!ready) {
            if (!isRunning()) break;
            continue;
          }
          if (!isRunning()) break;

          const consumer = await js.consumers.get(stream, consumerName);
          const messages = await consumer.consume();
          clearTimeout(readyFallback);
          markReady(); // Consumer is active — unblock start()

          for await (const msg of messages) {
            if (!isRunning()) {
              msg.nak();
              break;
            }
            try {
              const raw = sc.decode(msg.data);
              const data: unknown = JSON.parse(raw);
              // Ack immediately so the consume loop is never blocked by slow
              // handlers (e.g. outbound HTTP/RPC timeouts). Handlers are
              // fire-and-forget — errors are logged but don't stall the stream.
              msg.ack();
              handle(msg.subject, data).catch((err) => {
                log.error("Error handling event", { stream, subject: msg.subject, error: err });
              });
            } catch (err) {
              log.error("Error parsing event", { stream, subject: msg.subject, error: err });
              msg.nak();
            }
          }
        } catch (err) {
          if (!isRunning()) break;
          if (isJetStreamBootstrapError(err)) {
            log.warn("Consume loop waiting for JetStream bootstrap, retrying in 2s", {
              stream,
              consumerName,
              error: err,
            });
          } else {
            log.error("Consume loop error, restarting in 2s", { stream, consumerName, error: err });
          }
          await sleep(retryDelayMs);
        }
      }

      clearTimeout(readyFallback);
      markReady(); // Unblock start() even on clean exit without connecting
    })();
  });
}
