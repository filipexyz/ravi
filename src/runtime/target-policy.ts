import type { RuntimeCredentialStatus } from "./credential-types.js";
import type { RuntimeEffort, RuntimeProviderId, RuntimeThinking } from "./types.js";

export interface RuntimeTarget {
  id: string;
  runtimeProvider: RuntimeProviderId;
  model: string;
  /** Snapshot of the reusable model preset used to materialize this target. */
  modelPreset?: { id: string; version: number };
  effort?: RuntimeEffort;
  thinking?: RuntimeThinking;
  credentialRequirements?: RuntimeTargetCredentialRequirements;
  requiredCapabilities?: string[];
}

export interface RuntimeTargetCredentialRequirements {
  /** Restrict selection to existing managed credential ids. */
  credentialIds?: string[];
  /** Restrict selection to existing credential auth methods. */
  authMethods?: string[];
  /** Require the credential/session compatibility boundary to match exactly. */
  sessionCompatibilityKey?: string;
  /** Fail closed when no managed credential satisfies the target. */
  requireManaged?: boolean;
}

export interface RuntimeTargetPolicy {
  id: string;
  strategy: "ordered" | "health-aware";
  targets: RuntimeTarget[];
  maxAttemptsPerTarget: number;
  /** Same-target credential recoveries are bounded separately from target attempts. */
  maxCredentialRecoveryAttemptsPerTarget?: number;
  cooldownMs?: number;
  circuitBreakerThreshold?: number;
}

export interface RuntimeTargetHealth {
  targetId: string;
  status: "healthy" | "cooldown" | "open";
  cooldownUntil?: number;
  consecutiveFailures: number;
}

export interface RuntimeTargetAttempt {
  targetId: string;
  attempt: number;
  startedAt: number;
  completedAt?: number;
  outcome?: "success" | "recoverable_failure" | "terminal_failure";
  failureKind?: string;
}

export interface RuntimeTargetTurnState {
  logicalTurnId: string;
  attempts: RuntimeTargetAttempt[];
  /** Recovery count survives replay/restart without consuming target failover budget. */
  credentialRecoveries?: Record<string, number>;
  /** Task quota convergence deferred until the logical turn succeeds or target recovery is exhausted. */
  pendingTaskQuota?: { taskId: string; error: string };
  sideEffectBoundaryCrossed: boolean;
  terminal: boolean;
}

export interface RuntimeTargetEligibilityContext {
  now: number;
  registeredProviders: ReadonlySet<RuntimeProviderId>;
  availableCapabilities: ReadonlyMap<RuntimeProviderId, ReadonlySet<string>>;
  permittedTargetIds?: ReadonlySet<string>;
  credentialEligibility?: ReadonlyMap<string, { eligible: boolean; detail?: string }>;
  health?: ReadonlyMap<string, RuntimeTargetHealth>;
}

export interface RuntimeTargetRejection {
  targetId: string;
  reason:
    | "already_succeeded"
    | "attempts_exhausted"
    | "provider_unregistered"
    | "capability_missing"
    | "permission_denied"
    | "credential_unavailable"
    | "cooldown"
    | "circuit_open"
    | "side_effect_boundary"
    | "turn_terminal";
  detail?: string;
}

export type RuntimeTargetSelection =
  | { status: "selected"; target: RuntimeTarget; rejected: RuntimeTargetRejection[] }
  | { status: "exhausted"; rejected: RuntimeTargetRejection[] };

export function selectRuntimeTarget(
  policy: RuntimeTargetPolicy,
  state: RuntimeTargetTurnState,
  context: RuntimeTargetEligibilityContext,
): RuntimeTargetSelection {
  validateRuntimeTargetPolicy(policy);
  if (state.sideEffectBoundaryCrossed || state.terminal) {
    const reason = state.sideEffectBoundaryCrossed ? "side_effect_boundary" : "turn_terminal";
    return {
      status: "exhausted",
      rejected: policy.targets.map((target) => ({
        targetId: target.id,
        reason,
      })),
    };
  }
  const rejected: RuntimeTargetRejection[] = [];
  const successful = new Set(
    state.attempts.filter((attempt) => attempt.outcome === "success").map((attempt) => attempt.targetId),
  );

  const targets =
    policy.strategy === "health-aware"
      ? policy.targets
          .map((target, index) => ({
            target,
            index,
            failures: context.health?.get(target.id)?.consecutiveFailures ?? 0,
          }))
          .sort((left, right) => left.failures - right.failures || left.index - right.index)
          .map((entry) => entry.target)
      : policy.targets;

  for (const target of targets) {
    if (successful.has(target.id)) {
      rejected.push({ targetId: target.id, reason: "already_succeeded" });
      continue;
    }
    const attemptCount = state.attempts.filter((attempt) => attempt.targetId === target.id).length;
    if (attemptCount >= policy.maxAttemptsPerTarget) {
      rejected.push({ targetId: target.id, reason: "attempts_exhausted" });
      continue;
    }
    if (!context.registeredProviders.has(target.runtimeProvider)) {
      rejected.push({ targetId: target.id, reason: "provider_unregistered", detail: target.runtimeProvider });
      continue;
    }
    if (context.permittedTargetIds && !context.permittedTargetIds.has(target.id)) {
      rejected.push({ targetId: target.id, reason: "permission_denied" });
      continue;
    }
    const credentialEligibility = context.credentialEligibility?.get(target.id);
    if (credentialEligibility && !credentialEligibility.eligible) {
      rejected.push({
        targetId: target.id,
        reason: "credential_unavailable",
        ...(credentialEligibility.detail ? { detail: credentialEligibility.detail } : {}),
      });
      continue;
    }
    const capabilities = context.availableCapabilities.get(target.runtimeProvider) ?? new Set<string>();
    const missing = (target.requiredCapabilities ?? []).find((capability) => !capabilities.has(capability));
    if (missing) {
      rejected.push({ targetId: target.id, reason: "capability_missing", detail: missing });
      continue;
    }
    const health = context.health?.get(target.id);
    if (health?.status === "open") {
      rejected.push({ targetId: target.id, reason: "circuit_open" });
      continue;
    }
    if (health?.status === "cooldown" && (health.cooldownUntil ?? Number.POSITIVE_INFINITY) > context.now) {
      rejected.push({ targetId: target.id, reason: "cooldown", detail: String(health.cooldownUntil) });
      continue;
    }
    return { status: "selected", target, rejected };
  }
  return { status: "exhausted", rejected };
}

export interface RuntimeTargetFailureDecisionInput {
  recoverable: boolean;
  replayEligible: boolean;
  scope: "credential" | "target" | "request" | "session" | "unknown";
  sideEffectBoundaryCrossed: boolean;
  attemptsOnTarget: number;
  maxAttemptsPerTarget: number;
  credentialRecoveryEligible?: boolean;
  credentialRecoveriesOnTarget?: number;
  maxCredentialRecoveryAttemptsPerTarget?: number;
}

export type RuntimeTargetFailureScope = RuntimeTargetFailureDecisionInput["scope"];

/** Normalize provider failures before policy decides whether replay is safe. */
export function classifyRuntimeTargetFailure(input: {
  error: string;
  errorName?: string;
  caughtException?: boolean;
  recoverable?: boolean;
  rawEvent?: Record<string, unknown>;
  metadata?: { failureScope?: RuntimeTargetFailureScope };
  /** Internally classified credential failure; never sourced from provider metadata. */
  credentialFailure?: boolean;
  /** Internally classified provider/transport failure from structured evidence. */
  targetFailure?: boolean;
}): { recoverable: boolean; scope: RuntimeTargetFailureScope } {
  const errorIdentity = input.errorName?.trim().toLowerCase() ?? "";
  const normalizedScope = input.metadata?.failureScope;
  if (normalizedScope === "request" || normalizedScope === "session" || normalizedScope === "unknown") {
    return { recoverable: false, scope: normalizedScope };
  }
  if (input.credentialFailure || normalizedScope === "credential") {
    return { recoverable: input.recoverable === true, scope: "credential" };
  }
  if (input.targetFailure) {
    return { recoverable: input.recoverable === true, scope: "target" };
  }
  if (input.caughtException || errorIdentity) {
    return { recoverable: false, scope: "unknown" };
  }
  const detail = [input.errorName, input.error, input.rawEvent?.type, input.rawEvent?.subtype, input.rawEvent?.status]
    .filter((value) => value !== undefined && value !== null)
    .join(" ")
    .toLowerCase();
  if (/session|resume|thread.*mismatch|incompatib/.test(detail)) {
    return { recoverable: false, scope: "session" };
  }
  if (
    /malformed|schema|safety|refus|context.window|context length|too many tokens|forbidden|permission denied|not permitted|access denied/.test(
      detail,
    )
  ) {
    return { recoverable: false, scope: "request" };
  }
  if (/invalid (?:request|argument|parameter|prompt)|bad request/.test(detail)) {
    return { recoverable: false, scope: "request" };
  }
  if (
    /typeerror|referenceerror|syntaxerror|rangeerror|assertionerror|aggregateerror|cannot read propert|undefined is not|null is not/.test(
      detail,
    )
  ) {
    return { recoverable: false, scope: "unknown" };
  }
  if (
    /unavailable|overload|outage|timed?\s*out|timeout|connection (?:reset|refused)|econnreset|econnrefused/.test(detail)
  ) {
    return { recoverable: input.recoverable === true, scope: "target" };
  }
  return { recoverable: false, scope: "unknown" };
}

/** Derive health deterministically from the current logical turn journal. */
export function deriveRuntimeTargetHealth(
  policy: RuntimeTargetPolicy,
  state: RuntimeTargetTurnState,
): Map<string, RuntimeTargetHealth> {
  return new Map(
    policy.targets.map((target) => {
      const attempts = state.attempts.filter((attempt) => attempt.targetId === target.id);
      const failures = attempts.filter((attempt) => attempt.outcome === "recoverable_failure").length;
      const terminal = attempts.some((attempt) => attempt.outcome === "terminal_failure");
      return [
        target.id,
        {
          targetId: target.id,
          status: terminal ? ("open" as const) : ("healthy" as const),
          consecutiveFailures: failures,
        },
      ];
    }),
  );
}

export type RuntimeTargetFailureAction = "recover_credential" | "retry_same_target" | "switch_target" | "terminate";

export function decideRuntimeTargetFailure(input: RuntimeTargetFailureDecisionInput): RuntimeTargetFailureAction {
  if (!input.recoverable || !input.replayEligible || input.sideEffectBoundaryCrossed) return "terminate";
  if (input.scope === "request" || input.scope === "session" || input.scope === "unknown") return "terminate";
  if (input.scope === "credential") {
    if (!input.credentialRecoveryEligible) return "terminate";
    const recoveries = input.credentialRecoveriesOnTarget ?? 0;
    const maxRecoveries = input.maxCredentialRecoveryAttemptsPerTarget ?? 1;
    return recoveries < maxRecoveries ? "recover_credential" : "switch_target";
  }
  if (input.scope === "target") return "switch_target";
  return input.attemptsOnTarget < input.maxAttemptsPerTarget ? "retry_same_target" : "switch_target";
}

export function getRuntimeTargetCredentialRecoveryCount(state: RuntimeTargetTurnState, targetId: string): number {
  return state.credentialRecoveries?.[targetId] ?? 0;
}

export function recordRuntimeTargetCredentialRecovery(state: RuntimeTargetTurnState, targetId: string): number {
  const next = getRuntimeTargetCredentialRecoveryCount(state, targetId) + 1;
  state.credentialRecoveries = { ...(state.credentialRecoveries ?? {}), [targetId]: next };
  return next;
}

export function isRuntimeTargetAutoRollbackEligible(input: {
  runtimeProvider: RuntimeProviderId;
  managedCredentialId?: string | null;
  managedCredentialStatus?: RuntimeCredentialStatus | null;
}): boolean {
  return (
    input.runtimeProvider === "claude" &&
    Boolean(input.managedCredentialId?.trim()) &&
    input.managedCredentialStatus === "healthy"
  );
}

/** Convert the provider capability matrix into stable dotted names used by policy constraints. */
export function collectRuntimeCapabilityNames(value: unknown, prefix = ""): Set<string> {
  const names = new Set<string>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return names;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child === true || (typeof child === "string" && child !== "none")) names.add(path);
    if (child && typeof child === "object" && !Array.isArray(child)) {
      for (const nested of collectRuntimeCapabilityNames(child, path)) names.add(nested);
    }
  }
  return names;
}

export function validateRuntimeTargetPolicy(policy: RuntimeTargetPolicy): void {
  if (!policy.id.trim()) throw new Error("Runtime target policy id is required.");
  if (!Number.isInteger(policy.maxAttemptsPerTarget) || policy.maxAttemptsPerTarget < 1) {
    throw new Error("maxAttemptsPerTarget must be a positive integer.");
  }
  if (
    policy.maxCredentialRecoveryAttemptsPerTarget !== undefined &&
    (!Number.isInteger(policy.maxCredentialRecoveryAttemptsPerTarget) ||
      policy.maxCredentialRecoveryAttemptsPerTarget < 0)
  ) {
    throw new Error("maxCredentialRecoveryAttemptsPerTarget must be a non-negative integer.");
  }
  if (policy.cooldownMs !== undefined && (!Number.isInteger(policy.cooldownMs) || policy.cooldownMs < 0))
    throw new Error("cooldownMs must be a non-negative integer.");
  if (
    policy.circuitBreakerThreshold !== undefined &&
    (!Number.isInteger(policy.circuitBreakerThreshold) || policy.circuitBreakerThreshold < 1)
  ) {
    throw new Error("circuitBreakerThreshold must be a positive integer.");
  }
  if (policy.targets.length === 0) throw new Error("Runtime target policy requires at least one target.");
  const ids = new Set<string>();
  for (const target of policy.targets) {
    if (!target.id.trim() || !target.runtimeProvider.trim() || !target.model.trim()) {
      throw new Error("Every runtime target requires id, runtimeProvider and model.");
    }
    if (ids.has(target.id)) throw new Error(`Duplicate runtime target id: ${target.id}`);
    ids.add(target.id);
  }
}
