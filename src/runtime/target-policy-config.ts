import type { RuntimeTargetPolicy } from "./target-policy.js";

export type RuntimeTargetPolicySource = "session_override" | "task_profile" | "agent_default" | "none";

export interface ResolvedRuntimeTargetPolicy {
  policy: RuntimeTargetPolicy | null;
  source: RuntimeTargetPolicySource;
  provenance: string | null;
}

export function resolveRuntimeTargetPolicy(input: {
  sessionOverride?: unknown;
  taskProfilePolicy?: unknown;
  taskProfileId?: string;
  agentDefaults?: Record<string, unknown> | null;
  agentId?: string;
}): ResolvedRuntimeTargetPolicy {
  if (input.sessionOverride !== undefined && input.sessionOverride !== null) {
    return {
      policy: parseRuntimeTargetPolicy(input.sessionOverride),
      source: "session_override",
      provenance: "session.runtimeTargetPolicy",
    };
  }
  if (input.taskProfilePolicy !== undefined && input.taskProfilePolicy !== null) {
    return {
      policy: parseRuntimeTargetPolicy(input.taskProfilePolicy),
      source: "task_profile",
      provenance: input.taskProfileId ? `task-profile:${input.taskProfileId}` : "task-profile",
    };
  }
  const agentPolicy = input.agentDefaults?.runtimeTargetPolicy;
  if (agentPolicy !== undefined && agentPolicy !== null) {
    return {
      policy: parseRuntimeTargetPolicy(agentPolicy),
      source: "agent_default",
      provenance: input.agentId
        ? `agent:${input.agentId}.defaults.runtimeTargetPolicy`
        : "agent.defaults.runtimeTargetPolicy",
    };
  }
  return { policy: null, source: "none", provenance: null };
}

export function parseRuntimeTargetPolicy(value: unknown): RuntimeTargetPolicy {
  if (!isRecord(value)) throw new Error("Runtime target policy must be an object.");
  const strategy = value.strategy;
  if (strategy !== "ordered" && strategy !== "health-aware") {
    throw new Error("Runtime target policy strategy must be ordered or health-aware.");
  }
  if (!Array.isArray(value.targets) || value.targets.length === 0) {
    throw new Error("Runtime target policy requires a non-empty targets array.");
  }
  const maxAttemptsPerTarget = value.maxAttemptsPerTarget ?? 1;
  if (!Number.isInteger(maxAttemptsPerTarget) || Number(maxAttemptsPerTarget) < 1) {
    throw new Error("Runtime target policy maxAttemptsPerTarget must be a positive integer.");
  }
  return {
    id: requireString(value.id, "policy id"),
    strategy,
    maxAttemptsPerTarget: Number(maxAttemptsPerTarget),
    targets: value.targets.map((target, index) => {
      if (!isRecord(target)) throw new Error(`Runtime target at index ${index} must be an object.`);
      return {
        id: requireString(target.id, `target ${index} id`),
        runtimeProvider: requireString(target.runtimeProvider, `target ${index} runtimeProvider`),
        model: requireString(target.model, `target ${index} model`),
        ...(typeof target.effort === "string" ? { effort: target.effort as never } : {}),
        ...(typeof target.thinking === "string" ? { thinking: target.thinking as never } : {}),
        ...(typeof target.credentialScope === "string" ? { credentialScope: target.credentialScope } : {}),
        ...(Array.isArray(target.requiredCapabilities)
          ? { requiredCapabilities: target.requiredCapabilities.map((item) => requireString(item, "capability")) }
          : {}),
        ...(typeof target.sessionCompatibilityKey === "string"
          ? { sessionCompatibilityKey: target.sessionCompatibilityKey }
          : {}),
      };
    }),
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Runtime target ${label} is required.`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
