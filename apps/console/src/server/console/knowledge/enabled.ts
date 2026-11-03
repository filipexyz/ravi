import { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";

/**
 * Whether capture (meeting transcripts, page text, the retention announcement)
 * may run for an organization: `console.knowledge` is entitlement-required, and
 * an organization that never enabled it keeps nothing.
 */
export async function isKnowledgeEnabledForOrganization(
  organizationId: string,
  deps: { featureAccess?: typeof getConsoleFeatureAccessForOrganizationRole } = {},
): Promise<boolean> {
  const featureAccess = deps.featureAccess ?? getConsoleFeatureAccessForOrganizationRole;
  const access = await featureAccess({ organizationId, role: "owner" });
  return access.byKey["console.knowledge"]?.available === true;
}
