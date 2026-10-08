/**
 * Local principal for a Pages app gateway invoke.
 *
 * Ravi Link is looked up only in the local actor-binding cache, never through
 * Console during an invoke. A contact is used only when exactly one unexpired
 * cached binding matches the viewer, the organization, and (when the binding
 * names one) this installation's Console id. Zero or several matches mean no
 * contact.
 */

import type { ActorBinding } from "../cloud-auth/types.js";

export interface AppGatewayPrincipal {
  actorPrincipal: string;
  surfacePrincipal: string;
  contactId: string | null;
}

export function resolveAppGatewayPrincipal(input: {
  raviUserId: string;
  raviOrgId: string;
  siteId: string;
  /** This installation's Console id from the ticket response. */
  installationId: string;
  bindings: readonly ActorBinding[];
}): AppGatewayPrincipal {
  const matches = input.bindings.filter(
    (binding) =>
      binding.consoleUserId === input.raviUserId &&
      binding.orgId === input.raviOrgId &&
      (!binding.installationId || binding.installationId === input.installationId),
  );
  const contactId = matches.length === 1 ? matches[0]!.contactId : null;
  return {
    actorPrincipal: contactId ? `contact:${contactId}` : `ravi_user:${input.raviUserId}`,
    surfacePrincipal: `pages_site:${input.siteId}`,
    contactId,
  };
}
