/**
 * Bounded retry for outbound transport calls (ported from the legacy bridge sender).
 *
 * Attempt n+1 waits `n * baseDelayMs` (1s, 2s with the defaults), or longer when the
 * error carries a `retryAfterMs`. Whether an error is retried is a per-call policy:
 * callers pass `isRetryable` for operations whose failure may be ambiguous.
 */

import { logger } from "../../utils/logger.js";
import { isRetryableTransportError } from "./errors.js";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
/** Upper bound for a transport-provided `retryAfterMs`. */
const MAX_RETRY_AFTER_MS = 60_000;

const defaultLog = logger.child("channels:outbound-retry");

export interface TransportRetryOptions {
  /** Default 3. */
  attempts?: number;
  /** Delay before attempt n+1 = n * baseDelayMs. Default 1000. */
  baseDelayMs?: number;
  /** Default isRetryableTransportError. */
  isRetryable?: (err: unknown) => boolean;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
  log?: { warn(message: string, data?: Record<string, unknown>): void };
}

function retryAfterMsOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object" || !("retryAfterMs" in err)) return undefined;
  const value = (err as { retryAfterMs: unknown }).retryAfterMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(value, MAX_RETRY_AFTER_MS);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTransportRetry<T>(
  operation: () => Promise<T>,
  context: string,
  options: TransportRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const isRetryable = options.isRetryable ?? isRetryableTransportError;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? defaultLog;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt >= attempts || !isRetryable(err)) break;
      const delayMs = Math.max(attempt * baseDelayMs, retryAfterMsOf(err) ?? 0);
      log.warn(`${context} failed (attempt ${attempt}/${attempts}), retrying in ${delayMs}ms`, { error: err });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
