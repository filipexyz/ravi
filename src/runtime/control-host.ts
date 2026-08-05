import { logger } from "../utils/logger.js";
import type { RuntimeControlRequest, RuntimeControlResult } from "./types.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import { resolveRuntimeStreamingSession } from "./session-pool.js";

const log = logger.child("bot");

const NON_DURABLE_PROMPT_CONTROL_OPERATIONS = new Set<RuntimeControlRequest["operation"]>([
  "turn.steer",
  "turn.follow_up",
]);

export interface RuntimeControlNatsRequest {
  sessionName?: string;
  sessionKey?: string;
  request?: RuntimeControlRequest;
  replyTopic?: string;
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
    await replyRuntimeControlError(
      replyTopic,
      `No active runtime session found for ${data.sessionName ?? data.sessionKey ?? "(unknown)"}.`,
      options.safeEmit,
    );
    return;
  }

  if (NON_DURABLE_PROMPT_CONTROL_OPERATIONS.has(request.operation)) {
    const result: RuntimeControlResult = {
      ok: false,
      operation: request.operation,
      state: {
        provider: resolved.session.queryHandle.provider,
        activeTurn: resolved.session.turnActive,
      },
      error: `Runtime control '${request.operation}' is disabled: durable prompt input journaling is not available yet.`,
    };
    await emitRuntimeControlResult(resolved.name, resolved.session, replyTopic, result, options.safeEmit);
    return;
  }

  if (!resolved.session.queryHandle.control) {
    const result: RuntimeControlResult = {
      ok: false,
      operation: request.operation,
      state: {
        provider: resolved.session.queryHandle.provider,
        activeTurn: resolved.session.turnActive,
        supportedOperations: [],
      },
      error: `Runtime provider '${resolved.session.queryHandle.provider}' does not expose control operations.`,
    };
    if (replyTopic) {
      await options.safeEmit(replyTopic, { result });
    }
    return;
  }

  const result = await resolved.session.queryHandle.control(request);
  await emitRuntimeControlResult(resolved.name, resolved.session, replyTopic, result, options.safeEmit);
}
