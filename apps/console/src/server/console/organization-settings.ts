import type { OrganizationSettingsData } from "@/features/console/types";
import { ConsoleApiError } from "./api-error";
import type { ConsoleWorkspace } from "./workspace";

/** A browser identity, never a role/grant supplied by the form. */
export function organizationSettingsActor(workspace: ConsoleWorkspace) {
  if (workspace.mode !== "oidc") throw new ConsoleApiError(403, { error: "organization_forbidden" });
  return { organizationId: workspace.organization.id, userId: workspace.user.id };
}

/** Settings permissions do not include member administration or project token metadata. */
export function organizationSettingsPayload(
  organization: Pick<ConsoleWorkspace["organization"], "id" | "name" | "slug">): OrganizationSettingsData {
  return { id: organization.id, name: organization.name, slug: organization.slug };
}
