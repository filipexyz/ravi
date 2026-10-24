import { logger } from "../utils/logger.js";
import type { RuntimeControlRequest, RuntimeControlResult } from "./types.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import { resolveRuntimeStreamingSession } from "./session-pool.js";
import {
  RUNTIME_CONTROL_DISABLED,
  RUNTIME_CONTROL_DISABLED_REASON,
  RUNTIME_CONTROL_FAILED,
  RUNTIME_CONTROL_TIMEOUT,
  isRetryableRuntimeControlCode,
  RUNTIME_NO_ACTIVE_TURN,
  RUNTIME_OPERATION_UNSUPPORTED,
  RUNTIME_SESSION_NOT_ACTIVE,
  hostRuntimeControlState,
  isHostDisabledRuntimeControlOperation,
  runtimeControlCatalogCopy,
  type RuntimeControlErrorCode,
} from "./runtime-control-errors.js";

const log = logger.child("bot");

/** Below the CLI's 15 s reply timeout, so a stuck provider still yields a typed answer. */
export const RUNTIME_CONTROL_PROVIDER_TIMEOUT_MS = 10_000;

export interface RuntimeControlNatsRequest {
  sessionName?: string;
  sessionKey?: string;
  request?: RuntimeControlRequest;
  replyTopic?: string;
  /** Ravi correlation metadata, applied only after the runtime confirms a goal operation. */
  goalMetadata?: { taskId?: string; projectId?: string; blockedReason?: string };
}

export type RuntimeSafeEmit = (topic: string, data: Record<string, unknown>) => Promise<void>;

export function resolveRuntimeControlSession(
  streamingSessions: Map<string, RuntimeHostStreamingSession>,
  sessionName?: string,
  sessionKey?: string,
): { name: string; session: RuntimeHostStreamingSession } | null {
  return resolveRuntimeStreamingSession(streamingSessions, { sessionName, sessionKey });
}

export async function replyRuntimeControlError(
  replyTopic: string | undefined,
  error: string,
  safeEmit: RuntimeSafeEmit,
): Promise<void> {
  if (!replyTopic) {
    log.warn("Runtime control request failed without reply topic", { error });
    return;
  }
  await safeEmit(replyTopic, { error });
}

async function emitRuntimeControlResult(
  sessionName: string,
  session: RuntimeHostStreamingSession,
  replyTopic: string | undefined,
  result: RuntimeControlResult,
  safeEmit: RuntimeSafeEmit,
): Promise<void> {
  if (replyTopic) {
    await safeEmit(replyTopic, { result });
  }

  await safeEmit(`ravi.session.${sessionName}.runtime`, {
    type: "runtime.control",
    provider: session.queryHandle.provider,
    operation: result.operation,
    ok: result.ok,
    error: result.error,
    ...(result.code ? { code: result.code } : {}),
    state: result.state,
    timestamp: Date.now(),
  }).catch((error) => {
    log.warn("Failed to emit runtime control event", { sessionName, error });
  });
}

export async function handleRuntimeControlRequest(
  data: RuntimeControlNatsRequest,
  options: {
    streamingSessions: Map<string, RuntimeHostStreamingSession>;
    safeEmit: RuntimeSafeEmit;
  },
): Promise<void> {
  const { replyTopic, request } = data;
  if (!request?.operation) {
    await replyRuntimeControlError(replyTopic, "Runtime control request is missing an operation.", options.safeEmit);
    return;
  }

  const resolved = resolveRuntimeControlSession(options.streamingSessions, data.sessionName, data.sessionKey);
  if (!resolved) {
    const result = runtimeControlRefusal(request.operation, RUNTIME_SESSION_NOT_ACTIVE);
    if (replyTopic) {
      await options.safeEmit(replyTopic, { result });
    } else {
      log.warn("Runtime control request failed without reply topic", { code: result.code });
    }
    return;
  }

  const { session } = resolved;
  const baseState = () => ({ provider: session.queryHandle.provider, activeTurn: session.turnActive });

  if (isHostDisabledRuntimeControlOperation(request.operation)) {
    const result = runtimeControlRefusal(request.operation, RUNTIME_CONTROL_DISABLED, {
      state: baseState(),
      disabledReason: RUNTIME_CONTROL_DISABLED_REASON,
      error: `Runtime control '${request.operation}' is disabled: durable prompt input journaling is not available yet.`,
    });
    await emitRuntimeControlResult(resolved.name, session, replyTopic, result, options.safeEmit);
    return;
  }

  if (!session.queryHandle.control) {
    const result = runtimeControlRefusal(request.operation, RUNTIME_OPERATION_UNSUPPORTED, {
      state: { ...baseState(), supportedOperations: [] },
      error: `Runtime provider '${session.queryHandle.provider}' does not expose control operations.`,
    });
    if (replyTopic) {
      await options.safeEmit(replyTopic, { result });
    }
    return;
  }

  const result = await runProviderControl(session, request);
  await emitRuntimeControlResult(resolved.name, session, replyTopic, result, options.safeEmit);
}

function runtimeControlRefusal(
  operation: RuntimeControlRequest["operation"],
  code: RuntimeControlErrorCode,
  extra: Partial<RuntimeControlResult> = {},
): RuntimeControlResult {
  const catalog = runtimeControlCatalogCopy(code);
  return {
    ok: false,
    operation,
    error: catalog?.message,
    ...extra,
    code,
    retryable: isRetryableRuntimeControlCode(code, operation),
    suggestedAction: catalog?.suggestedAction,
  };
}

/**
 * Bound the provider call and give every outcome a code. The provider keeps
 * running after a timeout; the caller only stops waiting for it.
 */
async function runProviderControl(
  session: RuntimeHostStreamingSession,
  request: RuntimeControlRequest,
): Promise<RuntimeControlResult> {
  const control = session.queryHandle.control;
  if (!control) {
    return runtimeControlRefusal(request.operation, RUNTIME_OPERATION_UNSUPPORTED);
  }
  const state = () => ({ provider: session.queryHandle.provider, activeTurn: session.turnActive });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RuntimeControlResult>((resolve) => {
    timer = setTimeout(
      () => resolve(runtimeControlRefusal(request.operation, RUNTIME_CONTROL_TIMEOUT, { state: state() })),
      RUNTIME_CONTROL_PROVIDER_TIMEOUT_MS,
    );
  });
  let result: RuntimeControlResult;
  try {
    result = await Promise.race([
      Promise.resolve()
        .then(() => control(request))
        .catch(
          (error): RuntimeControlResult => ({
            ok: false,
            operation: request.operation,
            state: state(),
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }

  const normalized: RuntimeControlResult = result.state
    ? { ...result, state: hostRuntimeControlState(result.state) }
    : result;
  if (normalized.ok || normalized.code) return normalized;
  const code =
    request.operation.startsWith("turn.") && !session.turnActive ? RUNTIME_NO_ACTIVE_TURN : RUNTIME_CONTROL_FAILED;
  return runtimeControlRefusal(request.operation, code, {
    ...normalized,
    error: normalized.error ?? runtimeControlCatalogCopy(code)?.message,
  });
}
