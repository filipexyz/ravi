import { isRuntimeProviderCapacityFailure } from "./credential-classifier.js";
import type { RuntimeCredentialFailureSignal } from "./credential-types.js";

export const PROVIDER_CAPACITY_EXHAUSTED_REASON = "provider_capacity_exhausted";
export const PROVIDER_CAPACITY_EXHAUSTED_MESSAGE =
  "The model is temporarily at capacity. The retry limit was reached; your session is preserved. Please try again later.";
export const PROVIDER_CAPACITY_UNSAFE_MESSAGE =
  "The model is temporarily at capacity. Your session and completed work are preserved; this turn was not repeated to avoid duplicate actions.";

export const PROVIDER_CAPACITY_MAX_RETRIES = 3;
export const PROVIDER_CAPACITY_MAX_ELAPSED_MS = 30_000;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 8_000;

/** Carried by the original turn input, never by unrelated successor messages. */
export interface ProviderCapacityRetryState {
  startedAt: number;
  retries: number;
}

export type ProviderCapacityRetryDecision =
  | { action: "not_capacity" }
  | { action: "retry"; state: ProviderCapacityRetryState; delayMs: number }
  | {
      action: "exhausted";
      state: ProviderCapacityRetryState;
      reason: typeof PROVIDER_CAPACITY_EXHAUSTED_REASON;
    };

export function isProviderCapacityFailure(signal: RuntimeCredentialFailureSignal | undefined): boolean {
  return signal !== undefined && isRuntimeProviderCapacityFailure(signal);
}

export function decideProviderCapacityRetry(input: {
  signal: RuntimeCredentialFailureSignal | undefined;
  state?: ProviderCapacityRetryState;
  now?: number;
  random?: () => number;
}): ProviderCapacityRetryDecision {
  if (!isProviderCapacityFailure(input.signal)) return { action: "not_capacity" };

  const now = input.now ?? Date.now();
  const state = input.state ?? { startedAt: now, retries: 0 };
  const elapsed = Math.max(0, now - state.startedAt);
  const remaining = PROVIDER_CAPACITY_MAX_ELAPSED_MS - elapsed;
  const exhausted: ProviderCapacityRetryDecision = {
    action: "exhausted",
    state,
    reason: PROVIDER_CAPACITY_EXHAUSTED_REASON,
  };
  if (state.retries >= PROVIDER_CAPACITY_MAX_RETRIES || remaining <= 0) return exhausted;

  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** state.retries);
  const sample = (input.random ?? Math.random)();
  const jitter = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 1;
  // Equal jitter avoids a tight loop even when the random sample is zero.
  const backoff = Math.round(ceiling / 2 + (ceiling / 2) * jitter);
  const retryAfter = input.signal?.retryAfterMs ?? 0;
  const delayMs = Math.max(backoff, Number.isNaN(retryAfter) ? 0 : retryAfter);
  // Never shorten the upstream floor to squeeze another attempt into the budget.
  if (delayMs >= remaining) return exhausted;
  return {
    action: "retry",
    state: { startedAt: state.startedAt, retries: state.retries + 1 },
    delayMs,
  };
}
