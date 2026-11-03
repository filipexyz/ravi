import type { OrganizationAction } from "@/shared/organization-access";

/** Ordered destinations, not grants. `allows` is a current server observation. */
export const ORGANIZATION_SETTINGS_DESTINATIONS = [
  { href: "/org/settings", action: "organization.settings.read" },
  { href: "/org/sso", action: "organization.sso.read" },
  { href: "/org/credentials", action: "organization.credentials.read" },
  { href: "/org/api-keys", action: "organization.api_keys.read" },
  { href: "/org/installations", action: "organization.installations.read" },
  { href: "/org/permissions", action: "organization.authorization.read" },
] as const satisfies ReadonlyArray<{ href: string; action: OrganizationAction }>;

export function readableOrganizationSettingsHref(allows: (action: OrganizationAction) => boolean) {
  return ORGANIZATION_SETTINGS_DESTINATIONS.find(item => allows(item.action))?.href ?? null;
}
