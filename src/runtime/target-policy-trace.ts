import { listSessionEvents } from "../session-trace/session-trace-db.js";
import type { RuntimeTargetAttempt, RuntimeTargetTurnState } from "./target-policy.js";

/** Reconstruct the latest unfinished logical target turn from the append-only Session Trace. */
export function reconstructRuntimeTargetTurnState(
  sessionKey: string,
  policyId: string,
): RuntimeTargetTurnState | undefined {
  const events = listSessionEvents(sessionKey).filter((event) => {
    const payload = event.payloadJson;
    return readString(payload, "policyId", "policy_id") === policyId;
  });
  const latestStart = [...events]
    .reverse()
    .find(
      (event) =>
        event.eventType === "runtime.start" && readString(event.payloadJson, "logicalTurnId", "logical_turn_id"),
    );
  const logicalTurnId = latestStart
    ? readString(latestStart.payloadJson, "logicalTurnId", "logical_turn_id")
    : undefined;
  if (!logicalTurnId) return undefined;

  const turnEvents = events.filter(
    (event) => readString(event.payloadJson, "logicalTurnId", "logical_turn_id") === logicalTurnId,
  );
  if (turnEvents.some((event) => event.eventType === "runtime.target.succeeded")) return undefined;

  const attempts: RuntimeTargetAttempt[] = [];
  for (const event of turnEvents) {
    if (event.eventType !== "runtime.start") continue;
    const targetId = readString(event.payloadJson, "runtimeTargetId", "runtime_target_id");
    if (!targetId) continue;
    attempts.push({
      targetId,
      attempt: attempts.filter((item) => item.targetId === targetId).length + 1,
      startedAt: event.timestamp,
    });
  }
  for (const event of turnEvents) {
    if (event.eventType !== "runtime.target.switch_requested" && event.eventType !== "runtime.target.replay_blocked") {
      continue;
    }
    const targetId = readString(event.payloadJson, "targetId", "target_id");
    const attempt = [...attempts].reverse().find((item) => item.targetId === targetId && !item.completedAt);
    if (!attempt) continue;
    attempt.completedAt = event.timestamp;
    attempt.outcome =
      event.eventType === "runtime.target.switch_requested" ? "recoverable_failure" : "terminal_failure";
    attempt.failureKind = "target";
  }
  if (attempts.length === 0) return undefined;
  const replayBlocked = turnEvents.some((event) => event.eventType === "runtime.target.replay_blocked");
  return {
    logicalTurnId,
    attempts,
    sideEffectBoundaryCrossed: replayBlocked,
    terminal: replayBlocked,
  };
}

function readString(value: unknown, ...keys: string[]): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return undefined;
}
