import { getSession, getSessionByName } from "../router/index.js";
import { logger } from "../utils/logger.js";
import type { RuntimeControlRequest, RuntimeControlResult } from "./types.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";

const log = logger.child("bot");

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
  if (sessionName) {
    const direct = streamingSessions.get(sessionName);
    if (direct) {
      return { name: sessionName, session: direct };
    }
  }

  if (sessionKey) {
    const direct = streamingSessions.get(sessionKey);
    if (direct) {
      return { name: sessionKey, session: direct };
    }

    const stored = getSession(sessionKey);
    if (stored?.name) {
      const named = streamingSessions.get(stored.name);
      if (named) {
        return { name: stored.name, session: named };
      }
    }
  }

  if (sessionName) {
    const stored = getSessionByName(sessionName) ?? getSession(sessionName);
    if (stored?.sessionKey) {
      const byKey = streamingSessions.get(stored.sessionKey);
      if (byKey) {
        return { name: stored.name ?? stored.sessionKey, session: byKey };
      }
    }
  }

  if (sessionKey) {
    for (const [name, session] of streamingSessions) {
      const stored = getSessionByName(name);
      if (stored?.sessionKey === sessionKey) {
        return { name, session };
      }
    }
  }

  return null;
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
  if (replyTopic) {
    await options.safeEmit(replyTopic, { result });
  }

  await options
    .safeEmit(`ravi.session.${resolved.name}.runtime`, {
      type: "runtime.control",
      provider: resolved.session.queryHandle.provider,
      operation: request.operation,
      ok: result.ok,
      error: result.error,
      state: result.state,
      timestamp: Date.now(),
    })
    .catch((error) => {
      log.warn("Failed to emit runtime control event", { sessionName: resolved.name, error });
    });
}
