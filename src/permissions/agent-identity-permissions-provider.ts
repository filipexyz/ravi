import type { ContextCapability } from "../router/router-db.js";
import { materializeAgentDefaultCapabilities } from "./agent-default-capabilities-provider.js";
import { runtimeBootstrapProvider } from "./runtime-bootstrap-provider.js";
import type {
  PermissionProvider,
  PermissionProviderCapabilityOptions,
  PermissionProviderDecision,
  PermissionProviderRequest,
  PermissionProviderSubject,
} from "./provider-types.js";

export const AGENT_IDENTITY_SUBJECT_TYPE = "agent_identity";
export const AGENT_IDENTITY_AUTHORITY_MODE = "agent-identity";
export const AGENT_IDENTITY_AUTHORITY_RESOLVER = "agent-identity-v1";

export type AgentIdentityCompartmentType = "workspace" | "chat" | "dm" | "automation";

export interface AgentIdentityCompartment {
  type: AgentIdentityCompartmentType;
  id: string;
}

export const agentIdentityPermissionsProvider: PermissionProvider = {
  id: "agent-identity-permissions",
  version: "agent-identity/v1",
  required: true,
  supports() {
    return false;
  },
  authorize(request) {
    return notApplicableDecision(request);
  },
  materializeCapabilities(subject, options) {
    if (subject.type !== AGENT_IDENTITY_SUBJECT_TYPE) return [];

    const parsed = parseAgentIdentitySubjectId(subject.id);
    const executorAgentId = cleanString(options?.executorAgentId) ?? parsed?.agentId;
    if (!executorAgentId) return [];
    if (parsed?.agentId && parsed.agentId !== executorAgentId) return [];

    const executorCapabilities = options?.executorCapabilities?.length
      ? options.executorCapabilities
      : materializeExecutorAgentCapabilities(executorAgentId);
    const compartment = resolveCompartment(subject, parsed?.compartment, options);
    const sourcePrefix = `agent-identity:${executorAgentId}:${compartment.type}:${compartment.id}`;

    return dedupeCapabilities(
      executorCapabilities.map((capability) => ({
        permission: capability.permission,
        objectType: capability.objectType,
        objectId: capability.objectId,
        source: `${sourcePrefix}:executor`,
      })),
    );
  },
};

export function buildAgentIdentitySubjectId(agentId: string, compartment: AgentIdentityCompartment): string {
  return `${agentId}:${compartment.type}:${compartment.id}`;
}

export function parseAgentIdentitySubjectId(
  value: string,
): { agentId: string; compartment: AgentIdentityCompartment } | null {
  const parts = value.split(":");
  if (parts.length < 3) return null;
  const agentId = cleanString(parts.shift());
  const compartmentType = cleanString(parts.shift());
  const compartmentId = cleanString(parts.join(":"));
  if (!agentId || !isAgentIdentityCompartmentType(compartmentType) || !compartmentId) return null;
  return {
    agentId,
    compartment: {
      type: compartmentType,
      id: compartmentId,
    },
  };
}

function materializeExecutorAgentCapabilities(agentId: string): ContextCapability[] {
  return dedupeCapabilities([
    ...(runtimeBootstrapProvider.materializeCapabilities?.({ type: "agent", id: agentId }) ?? []),
    ...materializeAgentDefaultCapabilities(agentId),
  ]);
}

function resolveCompartment(
  subject: PermissionProviderSubject,
  parsed: AgentIdentityCompartment | undefined,
  options: PermissionProviderCapabilityOptions | undefined,
): AgentIdentityCompartment {
  const optionType = cleanString(options?.compartmentType);
  const optionId = cleanString(options?.compartmentId);
  if (isAgentIdentityCompartmentType(optionType) && optionId) {
    return { type: optionType, id: optionId };
  }
  if (parsed) return parsed;
  return { type: "workspace", id: subject.id };
}

function isAgentIdentityCompartmentType(value: unknown): value is AgentIdentityCompartmentType {
  return value === "workspace" || value === "chat" || value === "dm" || value === "automation";
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function dedupeCapabilities(capabilities: ContextCapability[]): ContextCapability[] {
  const seen = new Set<string>();
  const result: ContextCapability[] = [];
  for (const capability of capabilities) {
    const key = `${capability.permission}:${capability.objectType}:${capability.objectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(capability);
  }
  return result;
}

function notApplicableDecision(request: PermissionProviderRequest): PermissionProviderDecision {
  return {
    decision: "not_applicable",
    allowed: false,
    providerId: agentIdentityPermissionsProvider.id,
    providerVersion: agentIdentityPermissionsProvider.version,
    reasonCode: "agent_identity_materializer_only",
    permission: request.permission,
    objectType: request.objectType,
    objectId: request.objectId,
    ...(request.subject ? { subject: request.subject } : {}),
  };
}
