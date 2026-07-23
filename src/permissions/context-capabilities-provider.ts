import { canWithCapabilities } from "./capability-snapshot.js";
import type { PermissionProvider, PermissionProviderDecision, PermissionProviderRequest } from "./provider-types.js";

export const contextCapabilitiesProvider: PermissionProvider = {
  id: "context-capabilities",
  version: "snapshot/v1",
  required: true,
  supports(request) {
    return Boolean(request.context || request.capabilities);
  },
  authorize(request) {
    return authorizeContextCapabilities(request);
  },
};

export function authorizeContextCapabilities(request: PermissionProviderRequest): PermissionProviderDecision {
  const capabilities = request.context?.capabilities ?? request.capabilities ?? [];
  const requiresExactResource =
    request.operation?.kind === "cli-command" && request.operation.access.requireConcreteResource === true;
  const allowed = requiresExactResource
    ? capabilities.some(
        (capability) =>
          capability.permission === request.permission &&
          capability.objectType === request.objectType &&
          capability.objectId === request.objectId,
      )
    : canWithCapabilities(capabilities, request.permission, request.objectType, request.objectId);

  return {
    decision: allowed ? "allow" : "deny",
    allowed,
    providerId: contextCapabilitiesProvider.id,
    providerVersion: contextCapabilitiesProvider.version,
    reasonCode: allowed
      ? requiresExactResource
        ? "context_capabilities_exact_resource_allow"
        : "context_capabilities_allow"
      : requiresExactResource
        ? "context_capabilities_exact_resource_deny"
        : "context_capabilities_deny",
    permission: request.permission,
    objectType: request.objectType,
    objectId: request.objectId,
    ...(request.subject ? { subject: request.subject } : {}),
    ...(contextIdFrom(request.context) ? { contextId: contextIdFrom(request.context) } : {}),
  };
}

function contextIdFrom(context: PermissionProviderRequest["context"]): string | undefined {
  const value = (context as { contextId?: unknown } | null | undefined)?.contextId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
