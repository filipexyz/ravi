import { getRuntimeModelPreset } from "./model-preset-store.js";
import type { RuntimeModelPreset } from "./model-preset-store.js";
import { parseRuntimeEffort } from "./effort.js";
import { validateRuntimeTargetPolicy, type RuntimeTargetPolicy } from "./target-policy.js";
import type { RuntimeThinking } from "./types.js";

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

export function parseRuntimeTargetPolicy(
  value: unknown,
  options: { lookupModelPreset?: (id: string) => RuntimeModelPreset | null } = {},
): RuntimeTargetPolicy {
  if (!isRecord(value)) throw new Error("Runtime target policy must be an object.");
  assertKnownFields(
    value,
    new Set([
      "id",
      "strategy",
      "targets",
      "maxAttemptsPerTarget",
      "maxCredentialRecoveryAttemptsPerTarget",
      "cooldownMs",
      "circuitBreakerThreshold",
    ]),
    "policy",
  );
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
  const policy: RuntimeTargetPolicy = {
    id: requireString(value.id, "policy id"),
    strategy,
    maxAttemptsPerTarget: Number(maxAttemptsPerTarget),
    maxCredentialRecoveryAttemptsPerTarget: readNonNegativeInteger(
      value.maxCredentialRecoveryAttemptsPerTarget,
      1,
      "maxCredentialRecoveryAttemptsPerTarget",
    ),
    cooldownMs: readNonNegativeInteger(value.cooldownMs, 30_000, "cooldownMs"),
    circuitBreakerThreshold: readPositiveInteger(value.circuitBreakerThreshold, 3, "circuitBreakerThreshold"),
    targets: value.targets.map((target, index) => {
      if (!isRecord(target)) throw new Error(`Runtime target at index ${index} must be an object.`);
      if (target.credentialScope !== undefined || target.sessionCompatibilityKey !== undefined) {
        throw new Error(
          `Runtime target ${index} uses obsolete credential fields. Use credentialRequirements with credentialIds, authMethods, sessionCompatibilityKey, or requireManaged.`,
        );
      }
      assertKnownFields(
        target,
        new Set([
          "id",
          "runtimeProvider",
          "model",
          "modelPresetId",
          "modelPreset",
          "effort",
          "thinking",
          "credentialRequirements",
          "requiredCapabilities",
        ]),
        `target ${index}`,
      );
      const modelPresetId = readOptionalString(target.modelPresetId, `target ${index} modelPresetId`);
      const directRuntimeProvider = readOptionalString(target.runtimeProvider, `target ${index} runtimeProvider`);
      const directModel = readOptionalString(target.model, `target ${index} model`);
      if (modelPresetId && (directRuntimeProvider || directModel)) {
        throw new Error(`Runtime target ${index} must use either modelPresetId or runtimeProvider + model, not both.`);
      }
      let runtimeProvider = directRuntimeProvider;
      let model = directModel;
      let modelPreset: { id: string; version: number } | undefined;
      if (modelPresetId) {
        const preset = (options.lookupModelPreset ?? getRuntimeModelPreset)(modelPresetId);
        if (!preset) {
          throw new Error(
            `Runtime target ${index} model preset not found: ${modelPresetId}. Run: ravi runtime presets list`,
          );
        }
        if (!preset.enabled) {
          throw new Error(
            `Runtime target ${index} model preset is disabled: ${preset.id}. Run: ravi runtime presets enable ${preset.id}`,
          );
        }
        runtimeProvider = preset.provider;
        model = preset.model;
        modelPreset = { id: preset.id, version: preset.version };
      } else {
        modelPreset = readMaterializedModelPreset(target.modelPreset, index);
      }
      const credentialRequirements = parseCredentialRequirements(target.credentialRequirements, index);
      const effort = parseTargetEffort(target.effort, index);
      const thinking = parseTargetThinking(target.thinking, index);
      const requiredCapabilities = parseRequiredCapabilities(target.requiredCapabilities, index);
      return {
        id: requireString(target.id, `target ${index} id`),
        runtimeProvider: requireString(runtimeProvider, `target ${index} runtimeProvider`),
        model: requireString(model, `target ${index} model`),
        ...(modelPreset ? { modelPreset } : {}),
        ...(effort ? { effort } : {}),
        ...(thinking ? { thinking } : {}),
        ...(credentialRequirements ? { credentialRequirements } : {}),
        ...(requiredCapabilities ? { requiredCapabilities } : {}),
      };
    }),
  };
  validateRuntimeTargetPolicy(policy);
  return policy;
}

function parseTargetEffort(value: unknown, targetIndex: number) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Runtime target ${targetIndex} effort must be a string.`);
  return parseRuntimeEffort(value);
}

function parseTargetThinking(value: unknown, targetIndex: number): RuntimeThinking | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Runtime target ${targetIndex} thinking must be a string.`);
  const normalized = value.trim().toLowerCase();
  if (normalized !== "off" && normalized !== "normal" && normalized !== "verbose") {
    throw new Error(`Invalid runtime thinking: ${value}. Use off|normal|verbose.`);
  }
  return normalized;
}

function parseRequiredCapabilities(value: unknown, targetIndex: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Runtime target ${targetIndex} requiredCapabilities must be a non-empty string array.`);
  }
  return value.map((item) => requireString(item, `target ${targetIndex} capability`));
}

function parseCredentialRequirements(value: unknown, targetIndex: number) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Runtime target ${targetIndex} credentialRequirements must be an object.`);
  }
  assertKnownFields(
    value,
    new Set(["credentialIds", "authMethods", "sessionCompatibilityKey", "requireManaged"]),
    `target ${targetIndex} credentialRequirements`,
  );
  const credentialIds = readOptionalStringArray(value.credentialIds, "credentialIds");
  const authMethods = readOptionalStringArray(value.authMethods, "authMethods");
  const sessionCompatibilityKey = readOptionalString(
    value.sessionCompatibilityKey,
    `target ${targetIndex} credentialRequirements.sessionCompatibilityKey`,
  );
  if (value.requireManaged !== undefined && typeof value.requireManaged !== "boolean") {
    throw new Error(`Runtime target ${targetIndex} credentialRequirements.requireManaged must be boolean.`);
  }
  if (!credentialIds && !authMethods && !sessionCompatibilityKey && value.requireManaged !== true) {
    throw new Error(
      `Runtime target ${targetIndex} credentialRequirements must contain an enforceable managed credential constraint.`,
    );
  }
  return {
    ...(credentialIds ? { credentialIds } : {}),
    ...(authMethods ? { authMethods } : {}),
    ...(sessionCompatibilityKey ? { sessionCompatibilityKey } : {}),
    ...(typeof value.requireManaged === "boolean" ? { requireManaged: value.requireManaged } : {}),
  };
}

function readMaterializedModelPreset(value: unknown, targetIndex: number) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Runtime target ${targetIndex} modelPreset must be an object.`);
  assertKnownFields(value, new Set(["id", "version"]), `target ${targetIndex} modelPreset`);
  const id = requireString(value.id, `target ${targetIndex} modelPreset.id`);
  const version = value.version;
  if (!Number.isInteger(version) || Number(version) < 1) {
    throw new Error(`Runtime target ${targetIndex} modelPreset.version must be a positive integer.`);
  }
  return { id, version: Number(version) };
}

function readOptionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Runtime target ${label} must be a non-empty string array.`);
  }
  return value.map((item) => requireString(item, label));
}

function readNonNegativeInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 0)
    throw new Error(`Runtime target policy ${label} must be a non-negative integer.`);
  return Number(value);
}

function readPositiveInteger(value: unknown, fallback: number, label: string): number {
  const parsed = readNonNegativeInteger(value, fallback, label);
  if (parsed < 1) throw new Error(`Runtime target policy ${label} must be a positive integer.`);
  return parsed;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Runtime target ${label} is required.`);
  return value.trim();
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertKnownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Runtime target ${label} contains unknown field(s): ${unknown.sort().join(", ")}.`);
  }
}
