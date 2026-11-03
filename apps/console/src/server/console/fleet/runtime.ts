import { dbClient } from "@/server/db";
import { FleetError } from "./contract";
import { postgresFleetStore } from "./postgres-store";
import { FleetService } from "./service";
import { probeInstallation } from "./ssh-probe";
import { Kv2Vault, vaultConfig } from "./vault";
import { FleetSsoService } from "./sso-service";
import { getOidcBaseConfig } from "@/lib/auth/oidc-config";
import { OnboardingService } from "./onboarding";
import type { FleetActor } from "./contract";
import { readOrganizationAccess } from "./authorization";
import { OrganizationMembersService } from "./members";
import { sshPortPolicy } from "./ssh-policy";
import { ApiKeysService } from "./api-keys";

export function apiKeysService() {
  if (process.env.RAVI_AUTH_MODE !== "oidc") throw new FleetError("fleet_not_configured", 503);
  return new ApiKeysService(dbClient, getOidcBaseConfig().organizationId);
}

export function organizationMembersService() {
  if (process.env.RAVI_AUTH_MODE !== "oidc") throw new FleetError("fleet_not_configured", 503);
  return new OrganizationMembersService(dbClient, getOidcBaseConfig().organizationId);
}

export function organizationAccess(actor: FleetActor) {
  if (process.env.RAVI_AUTH_MODE !== "oidc") throw new FleetError("fleet_not_configured", 503);
  return readOrganizationAccess(dbClient, getOidcBaseConfig().organizationId, actor);
}

export function onboardingService() {
  if (process.env.RAVI_AUTH_MODE !== "oidc") throw new FleetError("fleet_not_configured", 503);
  return new OnboardingService(dbClient, getOidcBaseConfig().organizationId);
}

export function fleetSsoService() {
  if (process.env.RAVI_AUTH_MODE !== "oidc") throw new FleetError("fleet_not_configured", 503);
  const vault = { put: (...args: Parameters<Kv2Vault["put"]>) => new Kv2Vault(vaultConfig()).put(...args),
    read: (...args: Parameters<Kv2Vault["read"]>) => new Kv2Vault(vaultConfig()).read(...args) };
  return new FleetSsoService(dbClient, vault, getOidcBaseConfig());
}

export function fleetService() {
  if (process.env.RAVI_AUTH_MODE !== "oidc") throw new FleetError("fleet_not_configured", 503);
  const { organizationId, secret: operationKey } = getOidcBaseConfig();
  // Resolve Vault lazily: metadata remains visible while the coffer is sealed/unconfigured.
  const vault = { put: (...args: Parameters<Kv2Vault["put"]>) => new Kv2Vault(vaultConfig()).put(...args),
    read: (...args: Parameters<Kv2Vault["read"]>) => new Kv2Vault(vaultConfig()).read(...args) };
  return new FleetService(postgresFleetStore(dbClient), vault, probeInstallation, { organizationId, operationKey, allowedSshPorts: sshPortPolicy() });
}
