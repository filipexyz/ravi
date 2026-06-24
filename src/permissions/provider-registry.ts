import { contextCapabilitiesProvider } from "./context-capabilities-provider.js";
import type { PermissionProvider } from "./provider-types.js";
import { agentIdentityPermissionsProvider } from "./agent-identity-permissions-provider.js";
import { agentDefaultCapabilitiesProvider } from "./agent-default-capabilities-provider.js";
import { contactPolicyPermissionsProvider } from "./contact-policy-permissions-provider.js";
import { operatorControlProvider } from "./operator-control-provider.js";
import { runtimeBootstrapProvider } from "./runtime-bootstrap-provider.js";

export const localOperatorProvider: PermissionProvider = operatorControlProvider;

const DEFAULT_PERMISSION_PROVIDERS: PermissionProvider[] = [operatorControlProvider, contextCapabilitiesProvider];
const DEFAULT_CAPABILITY_MATERIALIZERS: PermissionProvider[] = [
  runtimeBootstrapProvider,
  agentDefaultCapabilitiesProvider,
  agentIdentityPermissionsProvider,
  contactPolicyPermissionsProvider,
];

export function getConfiguredPermissionProviders(): PermissionProvider[] {
  return DEFAULT_PERMISSION_PROVIDERS;
}

export function getConfiguredCapabilityMaterializers(): PermissionProvider[] {
  return DEFAULT_CAPABILITY_MATERIALIZERS;
}
