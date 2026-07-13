import type { RuntimeEffort, RuntimeProviderId, RuntimeThinking } from "./types.js";

export interface RuntimeTarget {
  id: string;
  runtimeProvider: RuntimeProviderId;
  model: string;
  effort?: RuntimeEffort;
  thinking?: RuntimeThinking;
  credentialScope?: string;
  requiredCapabilities?: string[];
  sessionCompatibilityKey?: string;
}

export interface RuntimeTargetPolicy {
  id: string;
  strategy: "ordered" | "health-aware";
  targets: RuntimeTarget[];
  maxAttemptsPerTarget: number;
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
  sideEffectBoundaryCrossed: boolean;
  terminal: boolean;
}

export interface RuntimeTargetEligibilityContext {
  now: number;
  registeredProviders: ReadonlySet<RuntimeProviderId>;
  availableCapabilities: ReadonlyMap<RuntimeProviderId, ReadonlySet<string>>;
  permittedTargetIds?: ReadonlySet<string>;
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
    | "cooldown"
    | "circuit_open";
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
  validatePolicy(policy);
  const rejected: RuntimeTargetRejection[] = [];
  const successful = new Set(
    state.attempts.filter((attempt) => attempt.outcome === "success").map((attempt) => attempt.targetId),
  );

  for (const target of policy.targets) {
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
}

export type RuntimeTargetFailureAction = "recover_credential" | "retry_same_target" | "switch_target" | "terminate";

export function decideRuntimeTargetFailure(input: RuntimeTargetFailureDecisionInput): RuntimeTargetFailureAction {
  if (!input.recoverable || !input.replayEligible || input.sideEffectBoundaryCrossed) return "terminate";
  if (input.scope === "request" || input.scope === "session" || input.scope === "unknown") return "terminate";
  if (input.scope === "credential" && input.attemptsOnTarget < input.maxAttemptsPerTarget) return "recover_credential";
  if (input.scope === "target") return "switch_target";
  return input.attemptsOnTarget < input.maxAttemptsPerTarget ? "retry_same_target" : "switch_target";
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

function validatePolicy(policy: RuntimeTargetPolicy): void {
  if (!policy.id.trim()) throw new Error("Runtime target policy id is required.");
  if (!Number.isInteger(policy.maxAttemptsPerTarget) || policy.maxAttemptsPerTarget < 1) {
    throw new Error("maxAttemptsPerTarget must be a positive integer.");
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
