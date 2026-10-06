import { nats } from "../nats.js";
import { getSessionByName } from "../router/index.js";
import { recordRuntimeTraceEvent } from "../session-trace/runtime-trace.js";
import { logger } from "../utils/logger.js";
import type { RuntimeSafeEmit } from "./host-event-loop.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { formatUserFacingTurnFailure } from "./public-failure.js";

const log = logger.child("runtime:intake-failure");

export const RUNTIME_PROMPT_INTAKE_FAILED_USER_MESSAGE =
  "This message could not be delivered to an agent. Please contact the operator.";

export type RuntimePromptIntakeFailureReason = "no_agent";

export function isUserFacingPromptSource(source: RuntimeLaunchPrompt["source"] | undefined): boolean {
  const channel = source?.channel?.trim().toLowerCase();
  return channel === "whatsapp" || channel === "slack" || channel === "telegram" || channel === "discord";
}

/**
 * Terminal intake failure: the prompt cannot become a turn (e.g. its agent no
 * longer exists). Callers return normally afterwards so JetStream acknowledges
 * the message; throwing would redeliver the same permanently-bad prompt.
 * The drop is recorded as a durable `dispatch.intake_failed` session event,
 * ended on the runtime subject (stops typing presence), and a chat user gets a
 * short generic notice instead of silence.
 */
export function reportRuntimePromptIntakeFailure(input: {
  sessionName: string;
  prompt: RuntimeLaunchPrompt;
  reason: RuntimePromptIntakeFailureReason;
  stage: "dispatch" | "launch";
  instanceId: string;
  safeEmit: RuntimeSafeEmit;
  details?: Record<string, unknown>;
  /** False records the drop without a chat notice (one was already sent for this chat). */
  notifyUser?: boolean;
}): void {
  const { sessionName, prompt, reason, stage } = input;
  const sessionEntry = getSessionByName(sessionName);
  const source = prompt.source;
  const userFacing = isUserFacingPromptSource(source);
  const error = `Runtime prompt intake failed (${reason})`;

  log.error(error, { sessionName, reason, stage, userFacing, ...input.details });
  recordRuntimeTraceEvent({
    sessionKey: sessionEntry?.sessionKey ?? sessionName,
    sessionName,
    agentId: prompt._agentId ?? sessionEntry?.agentId,
    eventType: "dispatch.intake_failed",
    eventGroup: "dispatch",
    status: "failed",
    source,
    messageId: prompt.context?.messageId,
    error,
    payloadJson: { reason, stage, userFacing, ...input.details },
  });

  input
    .safeEmit(`ravi.session.${sessionName}.runtime`, {
      type: "dispatch.dropped",
      reason: `intake_failed:${reason}`,
      sessionName,
      ...(source ? { _source: source } : {}),
      timestamp: new Date().toISOString(),
    })
    .catch((emitError) => {
      log.warn("Failed to emit intake failure runtime event", { sessionName, reason, error: emitError });
    });

  if (userFacing && source && input.notifyUser !== false) {
    nats
      .emit(`ravi.session.${sessionName}.response`, {
        response: formatUserFacingTurnFailure(RUNTIME_PROMPT_INTAKE_FAILED_USER_MESSAGE),
        target: source,
        _emitId: Math.random().toString(36).slice(2, 8),
        _instanceId: input.instanceId,
        _pid: process.pid,
        _v: 2,
      })
      .catch((emitError) => {
        log.warn("Failed to emit intake failure notice", { sessionName, reason, error: emitError });
      });
  }
}
