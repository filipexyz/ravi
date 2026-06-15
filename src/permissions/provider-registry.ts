import { contextCapabilitiesProvider } from "./context-capabilities-provider.js";
import type { PermissionProvider } from "./provider-types.js";
import { runtimeBootstrapProvider } from "./runtime-bootstrap-provider.js";

export const localOperatorProvider: PermissionProvider = {
  id: "local-operator",
  version: "bootstrap",
  required: true,
  supports(request) {
    return request.localOperator === true && !request.context && !request.subject && !request.capabilities;
  },
  authorize(request) {
    return {
      decision: "allow",
      allowed: true,
      providerId: this.id,
      providerVersion: this.version,
      reasonCode: "local_operator_no_subject",
      permission: request.permission,
      objectType: request.objectType,
      objectId: request.objectId,
    };
  },
};

const DEFAULT_PERMISSION_PROVIDERS: PermissionProvider[] = [localOperatorProvider, contextCapabilitiesProvider];
const DEFAULT_CAPABILITY_MATERIALIZERS: PermissionProvider[] = [runtimeBootstrapProvider];

export function getConfiguredPermissionProviders(): PermissionProvider[] {
  return DEFAULT_PERMISSION_PROVIDERS;
}

export function getConfiguredCapabilityMaterializers(): PermissionProvider[] {
  return DEFAULT_CAPABILITY_MATERIALIZERS;
}
