import type { ContextCapability } from "../router/router-db.js";
import { dbGetAgent, dbUpdateAgent } from "../router/router-db.js";
import type { AgentConfig } from "../router/types.js";
import { canWithCapabilities } from "./capability-snapshot.js";
import type { PermissionProvider, PermissionProviderDecision, PermissionProviderRequest } from "./provider-types.js";

export const AGENT_RUNTIME_PERMISSIONS_DEFAULTS_KEY = "runtimePermissions";
export const AGENT_RUNTIME_PERMISSION_PROFILES = ["bootstrap", "full-access"] as const;

export type AgentRuntimePermissionProfile = (typeof AGENT_RUNTIME_PERMISSION_PROFILES)[number];

export interface AgentRuntimePermissionsConfig {
  profile?: AgentRuntimePermissionProfile;
  capabilities?: Array<string | Partial<ContextCapability>>;
}

export const agentDefaultCapabilitiesProvider: PermissionProvider = {
  id: "agent-default-capabilities",
  version: "agent-defaults/v1",
  required: true,
  supports() {
    return false;
  },
  authorize(request) {
    return notApplicableDecision(request);
  },
  materializeCapabilities(subject, options) {
    if (subject.type === "agent") {
      return materializeAgentDefaultCapabilities(subject.id, {
        source: `agent-default-capabilities:agent:${subject.id}`,
      });
    }

    const executorAgentId = options?.executorAgentId?.trim();
    if (subject.type === "automation" && executorAgentId) {
      return materializeAgentDefaultCapabilities(executorAgentId, {
        source: `agent-default-capabilities:automation:${subject.id}:agent:${executorAgentId}`,
      });
    }

    return [];
  },
};

export function normalizeAgentRuntimePermissionProfile(value: unknown): AgentRuntimePermissionProfile | "none" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "none" || normalized === "clear" || normalized === "off") return "none";
  return AGENT_RUNTIME_PERMISSION_PROFILES.includes(normalized as AgentRuntimePermissionProfile)
    ? (normalized as AgentRuntimePermissionProfile)
    : null;
}

export function buildAgentRuntimePermissionsDefaults(
  defaults: Record<string, unknown> | null | undefined,
  config: AgentRuntimePermissionsConfig | null,
): Record<string, unknown> | null {
  const next = { ...(defaults ?? {}) };
  if (config) {
    next[AGENT_RUNTIME_PERMISSIONS_DEFAULTS_KEY] = compactRuntimePermissionsConfig(config);
  } else {
    delete next[AGENT_RUNTIME_PERMISSIONS_DEFAULTS_KEY];
  }
  return Object.keys(next).length > 0 ? next : null;
}

export function readAgentRuntimePermissionsConfig(agentId: string): AgentRuntimePermissionsConfig | null {
  const agent = dbGetAgent(agentId);
  if (!agent?.defaults) return null;
  return getAgentRuntimePermissionsConfigFromDefaults(agent.defaults);
}

export function getAgentRuntimePermissionsConfigFromDefaults(
  defaults: Record<string, unknown> | null | undefined,
): AgentRuntimePermissionsConfig | null {
  if (!defaults) return null;
  return normalizeAgentRuntimePermissionsConfig(defaults[AGENT_RUNTIME_PERMISSIONS_DEFAULTS_KEY]);
}

export function materializeAgentDefaultCapabilities(
  agentId: string,
  options: { source?: string } = {},
): ContextCapability[] {
  const config = readAgentRuntimePermissionsConfig(agentId);
  if (!config) return [];

  const source = options.source ?? `agent-default-capabilities:agent:${agentId}`;
  return dedupeCapabilities([
    ...profileCapabilities(config.profile, source),
    ...explicitCapabilities(config.capabilities, source),
  ]);
}

export const materializeAgentRuntimePermissionCapabilities = materializeAgentDefaultCapabilities;

export function ensureAgentRuntimeCapability(
  agentId: string,
  capability: Pick<ContextCapability, "permission" | "objectType" | "objectId">,
): { changed: boolean; agent: AgentConfig | null; runtimePermissions: AgentRuntimePermissionsConfig | null } {
  const agent = dbGetAgent(agentId);
  if (!agent) {
    return { changed: false, agent: null, runtimePermissions: null };
  }

  const normalizedCapability = normalizeCapabilityInput(capability);
  if (!normalizedCapability) {
    return {
      changed: false,
      agent,
      runtimePermissions: getAgentRuntimePermissionsConfigFromDefaults(agent.defaults),
    };
  }

  const current = getAgentRuntimePermissionsConfigFromDefaults(agent.defaults);
  const existingCapabilities = explicitCapabilities(current?.capabilities, "existing").map(stripCapabilitySource);
  if (
    canWithCapabilities(
      existingCapabilities,
      normalizedCapability.permission,
      normalizedCapability.objectType,
      normalizedCapability.objectId,
    )
  ) {
    return { changed: false, agent, runtimePermissions: current };
  }

  const nextConfig: AgentRuntimePermissionsConfig = {
    ...(current ?? {}),
    capabilities: [...existingCapabilities, normalizedCapability],
  };
  const nextDefaults = buildAgentRuntimePermissionsDefaults(agent.defaults, nextConfig);
  const updated = dbUpdateAgent(agentId, { defaults: nextDefaults });
  return { changed: true, agent: updated, runtimePermissions: nextConfig };
}

export function ensureAgentCanViewAgent(agentId: string | null | undefined, targetAgentId: string): boolean {
  const owner = agentId?.trim();
  const target = targetAgentId.trim();
  if (!owner || !target) return false;
  return ensureAgentRuntimeCapability(owner, { permission: "view", objectType: "agent", objectId: target }).changed;
}

export function ensureAgentCanViewAllAgents(agentId: string | null | undefined): boolean {
  const owner = agentId?.trim();
  if (!owner) return false;
  return ensureAgentRuntimeCapability(owner, { permission: "view", objectType: "agent", objectId: "*" }).changed;
}

function normalizeAgentRuntimePermissionsConfig(value: unknown): AgentRuntimePermissionsConfig | null {
  if (typeof value === "string") {
    const profile = normalizeAgentRuntimePermissionProfile(value);
    return profile && profile !== "none" ? { profile } : null;
  }
  if (!isRecord(value)) return null;

  const profile = normalizeAgentRuntimePermissionProfile(value.profile);
  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities.flatMap((capability) => {
        const normalized = normalizeCapabilityInput(capability);
        return normalized ? [normalized] : [];
      })
    : undefined;

  const config: AgentRuntimePermissionsConfig = {};
  if (profile && profile !== "none") config.profile = profile;
  if (capabilities?.length) config.capabilities = capabilities;
  return Object.keys(config).length > 0 ? config : null;
}

function compactRuntimePermissionsConfig(config: AgentRuntimePermissionsConfig): AgentRuntimePermissionsConfig {
  return {
    ...(config.profile ? { profile: config.profile } : {}),
    ...(config.capabilities?.length ? { capabilities: config.capabilities } : {}),
  };
}

function profileCapabilities(profile: AgentRuntimePermissionProfile | undefined, source: string): ContextCapability[] {
  if (profile !== "full-access") return [];
  return [
    {
      permission: "admin",
      objectType: "system",
      objectId: "*",
      source,
    },
  ];
}

function explicitCapabilities(
  values: AgentRuntimePermissionsConfig["capabilities"],
  source: string,
): ContextCapability[] {
  return (values ?? []).flatMap((value) => {
    const capability = normalizeCapabilityInput(value);
    return capability ? [{ ...capability, source }] : [];
  });
}

function normalizeCapabilityInput(value: string | Partial<ContextCapability> | unknown): ContextCapability | null {
  if (typeof value === "string") {
    const parts = value.split(":");
    if (parts.length < 3) return null;
    const [permission, objectType, ...objectIdParts] = parts;
    return normalizeCapabilityObject({
      permission,
      objectType,
      objectId: objectIdParts.join(":"),
    });
  }
  if (isRecord(value)) {
    return normalizeCapabilityObject(value);
  }
  return null;
}

function normalizeCapabilityObject(value: Record<string, unknown>): ContextCapability | null {
  const permission = cleanString(value.permission);
  const objectType = cleanString(value.objectType);
  const objectId = cleanString(value.objectId);
  if (!permission || !objectType || !objectId) return null;
  return { permission, objectType, objectId };
}

function stripCapabilitySource(capability: ContextCapability): ContextCapability {
  return {
    permission: capability.permission,
    objectType: capability.objectType,
    objectId: capability.objectId,
  };
}

function dedupeCapabilities(capabilities: ContextCapability[]): ContextCapability[] {
  const seen = new Set<string>();
  const result: ContextCapability[] = [];
  for (const capability of capabilities) {
    const key = `${capability.permission}:${capability.objectType}:${capability.objectId}:${capability.source ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(capability);
  }
  return result;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notApplicableDecision(request: PermissionProviderRequest): PermissionProviderDecision {
  return {
    decision: "not_applicable",
    allowed: false,
    providerId: agentDefaultCapabilitiesProvider.id,
    providerVersion: agentDefaultCapabilitiesProvider.version,
    reasonCode: "agent_default_capabilities_materializer_only",
    permission: request.permission,
    objectType: request.objectType,
    objectId: request.objectId,
    ...(request.subject ? { subject: request.subject } : {}),
  };
}
