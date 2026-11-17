import { reportErrorDiagnostic } from "../utils/error-reporting.js";
import { logger } from "../utils/logger.js";
import { ChannelOutputEnvelopeSchema, type ChannelOutputEnvelope } from "./backend.js";
import {
  CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
  channelOutputHandoffConfirmationMatches,
  channelOutputHandoffEvidenceMatches,
  getChannelOutputHandoffEvidence,
  type ChannelOutputEmissionContext,
  type ChannelOutputHandoffConfirmation,
} from "./output-handoff.js";

const RETRY_DELAYS_MS = [100, 400] as const;
const MAX_ATTEMPTS = 1 + RETRY_DELAYS_MS.length;
const log = logger.child("channels:terminal-output-handoff");

/** Process-local handoff state; publication is never reported as Slack delivery. */
export interface TerminalOutputHandoffState {
  phase: "text_handoff";
  status:
    | "handed_off"
    | "unclassified"
    | "retry_scheduled"
    | "retry_exhausted"
    | "owner_lost"
    | "non_retryable"
    | "outcome_unknown";
  attempt: number;
  maxAttempts: number;
  errorCode?: string;
  nextAttemptAt?: number;
  disposition?: ChannelOutputHandoffConfirmation["disposition"];
}

/** An explicit exhausted/refused stage, retaining the original error separately from diagnostics. */
export class TerminalOutputHandoffError extends Error {
  readonly outcome: TerminalOutputHandoffState;
  override readonly cause: unknown;

  constructor(outcome: TerminalOutputHandoffState, cause: unknown) {
    super(`Terminal text handoff: ${outcome.status}`);
    this.name = "TerminalOutputHandoffError";
    this.outcome = Object.freeze({ ...outcome });
    this.cause = cause;
  }
}

/**
 * Retains one immutable terminal until its initial handoff and at most two
 * completed pre-save retries finish. The initial call preserves ordinary sink
 * behavior; a generic resolved Promise remains unclassified. A known adapter's
 * exact, finished pre-save SQLite refusal alone pins a concrete request hash and
 * authorizes a delayed retry with a restrictive capability. The first pin never
 * changes, and no restricted request falls back to an unrestricted one.
 *
 * Positive durable save, unclassified success, unknown errors and timeouts all
 * end host dispatch. After save the existing outbox reconciler owns recovery;
 * this function neither replays the provider nor races an uncancellable sink
 * against a timer. Its attempt count is bounded, not external-call duration.
 */
export async function handoffTerminalOutputWithRecovery(
  input: ChannelOutputEnvelope,
  emit: (
    output: ChannelOutputEnvelope,
    context?: ChannelOutputEmissionContext,
  ) => Promise<ChannelOutputHandoffConfirmation | undefined> | Promise<void>,
  options: {
    mayEmit: () => boolean;
    onState?: (state: TerminalOutputHandoffState) => void;
  },
): Promise<ChannelOutputHandoffConfirmation | undefined> {
  const output = freezeOutput(ChannelOutputEnvelopeSchema.parse(input));
  let attempt = 0;
  let pinnedRequestFingerprint: string | undefined;

  /** Optional diagnostics cannot authorize a retry or replace the primary failure. */
  const notify = (state: TerminalOutputHandoffState): void => {
    try {
      options.onState?.(Object.freeze(state));
    } catch (error) {
      // Observers are outside the delivery decision.
      reportErrorDiagnostic(log, "Terminal handoff observer failed", error, { operation: "terminal_handoff_observer" });
    }
  };
  /** A pure captured-owner fence is re-evaluated after every scheduled wait. */
  const owns = (): boolean => {
    try {
      return options.mayEmit() === true;
    } catch (error) {
      reportErrorDiagnostic(log, "Terminal handoff owner check failed", error, { operation: "terminal_handoff_owner" });
      return false;
    }
  };
  /** Record a terminal local outcome without claiming that a previous external call did not occur. */
  const stop = (status: TerminalOutputHandoffState["status"], errorCode: string, cause: unknown): never => {
    const outcome: TerminalOutputHandoffState = {
      phase: "text_handoff",
      status,
      attempt,
      maxAttempts: MAX_ATTEMPTS,
      errorCode,
    };
    notify(outcome);
    throw new TerminalOutputHandoffError(outcome, cause);
  };

  for (;;) {
    if (!owns()) return stop("owner_lost", "OWNER_LOST", undefined);
    attempt += 1;
    let confirmation: Awaited<ReturnType<typeof emit>>;
    let failure: unknown;
    let failed = false;
    try {
      confirmation = await emit(
        output,
        pinnedRequestFingerprint === undefined
          ? undefined
          : {
              capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
              expectedRequestFingerprint: pinnedRequestFingerprint,
            },
      );
    } catch (error) {
      failed = true;
      failure = error;
    }
    if (!failed) {
      if (confirmation === undefined) {
        notify({ phase: "text_handoff", status: "unclassified", attempt, maxAttempts: MAX_ATTEMPTS });
        return undefined;
      }
      if (!channelOutputHandoffConfirmationMatches(confirmation, output, pinnedRequestFingerprint)) {
        return stop("outcome_unknown", "INVALID_CONFIRMATION", undefined);
      }
      // Owner loss after acceptance cannot retract the saved job or authorize
      // another emit. This confirmation is settlement, not fresh authority.
      notify({
        phase: "text_handoff",
        status: "handed_off",
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        disposition: confirmation.disposition,
      });
      return confirmation;
    }

    const evidence = getChannelOutputHandoffEvidence(failure);
    if (!evidence) return stop("outcome_unknown", "UNCLASSIFIED", failure);
    if (!channelOutputHandoffEvidenceMatches(evidence, output, pinnedRequestFingerprint)) {
      return stop("non_retryable", "OUTPUT_OR_REQUEST_CONFLICT", failure);
    }
    if (evidence.disposition === "unknown") return stop("outcome_unknown", evidence.code, failure);
    if (evidence.disposition !== "finished_pre_save_missing") {
      return stop("non_retryable", evidence.code, failure);
    }
    // Validation includes operationFinished, identity, output/key and a closed
    // transient code. No job-less failure or generic message can reach this pin.
    pinnedRequestFingerprint ??= evidence.requestFingerprint;
    if (attempt >= MAX_ATTEMPTS) return stop("retry_exhausted", evidence.code, failure);
    if (!owns()) return stop("owner_lost", "OWNER_LOST", failure);
    const delay = RETRY_DELAYS_MS[attempt - 1]!;
    notify({
      phase: "text_handoff",
      status: "retry_scheduled",
      attempt,
      maxAttempts: MAX_ATTEMPTS,
      errorCode: evidence.code,
      nextAttemptAt: Date.now() + delay,
    });
    if (!owns()) return stop("owner_lost", "OWNER_LOST", failure);
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    if (!owns()) return stop("owner_lost", "OWNER_LOST", failure);
  }
}

/** Freeze parsed JSON only, preserving the caller's objects and runtime predicates. */
function freezeOutput<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeOutput(child);
    Object.freeze(value);
  }
  return value;
}
