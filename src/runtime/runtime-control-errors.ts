import type { RuntimeControlCapabilities, RuntimeControlOperation, RuntimeControlState } from "./types.js";

/**
 * Typed refusals for `sessions runtime` controls. The host writes the code;
 * the CLI and the remote relay render local catalog copy for it, so a refusal
 * never reaches the caller as a generic "command failed".
 */
export const RUNTIME_CONTROL_DISABLED = "RUNTIME_CONTROL_DISABLED";
export const RUNTIME_SESSION_NOT_ACTIVE = "RUNTIME_SESSION_NOT_ACTIVE";
export const RUNTIME_OPERATION_UNSUPPORTED = "RUNTIME_OPERATION_UNSUPPORTED";
export const RUNTIME_NO_ACTIVE_TURN = "RUNTIME_NO_ACTIVE_TURN";
export const RUNTIME_CONTROL_TIMEOUT = "RUNTIME_CONTROL_TIMEOUT";
export const RUNTIME_CONTROL_UNAVAILABLE = "RUNTIME_CONTROL_UNAVAILABLE";
export const RUNTIME_CONTROL_FAILED = "RUNTIME_CONTROL_FAILED";

export type RuntimeControlErrorCode =
  | typeof RUNTIME_CONTROL_DISABLED
  | typeof RUNTIME_SESSION_NOT_ACTIVE
  | typeof RUNTIME_OPERATION_UNSUPPORTED
  | typeof RUNTIME_NO_ACTIVE_TURN
  | typeof RUNTIME_CONTROL_TIMEOUT
  | typeof RUNTIME_CONTROL_UNAVAILABLE
  | typeof RUNTIME_CONTROL_FAILED;

/** Why a host control is switched off. Bounded so the relay can pass it through. */
export const RUNTIME_CONTROL_DISABLED_REASON = "durable_input_journal_unavailable";

/**
 * Host `turn.steer`/`turn.follow_up` add input that the durable attempt fence
 * cannot record yet (daemon/restart/crash-recovery). Providers still support
 * them for the dispatcher's implicit native steer, so they stay in provider
 * capabilities but are removed from every host-facing operation list.
 */
export const HOST_DISABLED_RUNTIME_CONTROL_OPERATIONS: readonly RuntimeControlOperation[] = [
  "turn.steer",
  "turn.follow_up",
];

export function isHostDisabledRuntimeControlOperation(operation: RuntimeControlOperation): boolean {
  return HOST_DISABLED_RUNTIME_CONTROL_OPERATIONS.includes(operation);
}

/** Split provider operations into what the host accepts and what it refuses. */
export function hostRuntimeControlOperations(operations: readonly RuntimeControlOperation[]): {
  operations: RuntimeControlOperation[];
  disabledOperations: RuntimeControlOperation[];
} {
  return {
    operations: operations.filter((operation) => !isHostDisabledRuntimeControlOperation(operation)),
    disabledOperations: operations.filter(isHostDisabledRuntimeControlOperation),
  };
}

export function hostRuntimeControlSummary(
  capabilities: RuntimeControlCapabilities,
): RuntimeControlCapabilities & { disabledOperations: RuntimeControlOperation[] } {
  return { supported: capabilities.supported, ...hostRuntimeControlOperations(capabilities.operations) };
}

export function hostRuntimeControlState(state: RuntimeControlState): RuntimeControlState {
  if (!state.supportedOperations) return state;
  const { operations, disabledOperations } = hostRuntimeControlOperations(state.supportedOperations);
  return {
    ...state,
    supportedOperations: operations,
    ...(disabledOperations.length > 0 ? { disabledOperations } : {}),
  };
}

const RUNTIME_CONTROL_CATALOG: Record<RuntimeControlErrorCode, { message: string; suggestedAction: string }> = {
  [RUNTIME_CONTROL_DISABLED]: {
    message:
      "This runtime control is disabled on the host: added input cannot be journaled durably yet. Nothing was sent to the runtime.",
    suggestedAction:
      'Send the input through the session queue instead: ravi sessions send <session> "..." --steer (or --immediate)',
  },
  [RUNTIME_SESSION_NOT_ACTIVE]: {
    message: "The session has no active runtime on this host.",
    suggestedAction: "Check the session with: ravi sessions read <session> --json, or start it with ravi sessions send",
  },
  [RUNTIME_OPERATION_UNSUPPORTED]: {
    message: "The session's runtime provider does not support this control operation.",
    suggestedAction: "Read the supported operations with: ravi sessions runtime read <session> --json",
  },
  [RUNTIME_NO_ACTIVE_TURN]: {
    message: "The runtime has no active turn to apply this control to.",
    suggestedAction: "Retry while the session is running a turn, or use ravi sessions send to start one",
  },
  [RUNTIME_CONTROL_TIMEOUT]: {
    message: "The runtime did not answer the control request in time.",
    suggestedAction: "Retry; if it keeps timing out, inspect the session with: ravi sessions trace <session> --explain",
  },
  [RUNTIME_CONTROL_UNAVAILABLE]: {
    message: "The daemon did not take the runtime control request.",
    suggestedAction: "Check the daemon with: ravi daemon status, then retry",
  },
  [RUNTIME_CONTROL_FAILED]: {
    message: "The runtime refused the control request.",
    suggestedAction: "Inspect the session with: ravi sessions trace <session> --explain",
  },
};

/** Local catalog copy for a runtime control code. Never echoes runtime text. */
export function runtimeControlCatalogCopy(code: string): { message: string; suggestedAction: string } | undefined {
  return Object.hasOwn(RUNTIME_CONTROL_CATALOG, code)
    ? RUNTIME_CONTROL_CATALOG[code as RuntimeControlErrorCode]
    : undefined;
}

export function isRetryableRuntimeControlCode(code: string): boolean {
  return code === RUNTIME_CONTROL_TIMEOUT || code === RUNTIME_CONTROL_UNAVAILABLE;
}
