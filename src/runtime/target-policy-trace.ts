import { listSessionEvents } from "../session-trace/session-trace-db.js";
import type {
  RuntimeTargetAttempt,
  RuntimeTargetHealth,
  RuntimeTargetPolicy,
  RuntimeTargetTurnState,
} from "./target-policy.js";

/** Build cooldown/circuit state from the append-only trace without new persistence. */
export function reconstructRuntimeTargetHealth(
  sessionKey: string,
  policy: RuntimeTargetPolicy,
  now: number,
): Map<string, RuntimeTargetHealth> {
  const relevant = listSessionEvents(sessionKey).filter(
    (event) =>
      readString(event.payloadJson, "policyId", "policy_id", "runtimeTargetPolicyId", "runtime_target_policy_id") ===
      policy.id,
  );
  const cooldownMs = policy.cooldownMs ?? 30_000;
  const threshold = policy.circuitBreakerThreshold ?? 3;
  return new Map(
    policy.targets.map((target) => {
      let consecutiveFailures = 0;
      let lastFailureAt: number | undefined;
      for (const event of relevant) {
        const targetId = readString(event.payloadJson, "targetId", "target_id", "runtimeTargetId", "runtime_target_id");
        if (targetId !== target.id) continue;
        if (event.eventType === "runtime.target.succeeded") {
          consecutiveFailures = 0;
          lastFailureAt = undefined;
        } else if (event.eventType === "runtime.target.switch_requested") {
          consecutiveFailures++;
          lastFailureAt = event.timestamp;
        }
      }
      const cooldownUntil = lastFailureAt === undefined ? undefined : lastFailureAt + cooldownMs;
      const cooling = cooldownUntil !== undefined && cooldownUntil > now;
      const status =
        consecutiveFailures >= threshold && cooling
          ? ("open" as const)
          : cooling
            ? ("cooldown" as const)
            : ("healthy" as const);
      return [
        target.id,
        { targetId: target.id, status, ...(cooldownUntil ? { cooldownUntil } : {}), consecutiveFailures },
      ];
    }),
  );
}

/** Reconstruct the latest unfinished logical target turn from the append-only Session Trace. */
export function reconstructRuntimeTargetTurnState(
  sessionKey: string,
  policyId: string,
): RuntimeTargetTurnState | undefined {
  const events = listSessionEvents(sessionKey).filter((event) => {
    const payload = event.payloadJson;
    return (
      readString(payload, "policyId", "policy_id", "runtimeTargetPolicyId", "runtime_target_policy_id") === policyId
    );
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
  const credentialRecoveries: Record<string, number> = {};
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
    if (event.eventType === "runtime.target.credential_recovery") {
      const targetId = readString(event.payloadJson, "targetId", "target_id");
      if (targetId) credentialRecoveries[targetId] = (credentialRecoveries[targetId] ?? 0) + 1;
      if (event.status !== "recovering") continue;
      let attemptIndex = -1;
      for (let index = attempts.length - 1; index >= 0; index--) {
        const candidate = attempts[index];
        if (candidate?.targetId === targetId && !candidate.completedAt) {
          attemptIndex = index;
          break;
        }
      }
      if (attemptIndex >= 0) attempts.splice(attemptIndex, 1);
      continue;
    }
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
  if (attempts.length === 0 && Object.keys(credentialRecoveries).length === 0) return undefined;
  const replayBlocked = turnEvents.some(
    (event) => event.eventType === "runtime.target.replay_blocked" || event.eventType === "tool.start",
  );
  return {
    logicalTurnId,
    attempts,
    credentialRecoveries,
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
