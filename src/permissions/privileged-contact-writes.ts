/**
 * Guards for contact writes that confer permission authority.
 *
 * Provider-owned `permission-*` tags (and contact chat grants) turn into
 * capabilities, with `permission-admin|owner|superadmin` giving
 * `admin:system:*`. A contact, tag or tag-rule write grant is weaker than that,
 * so writing those tags, binding identities to a contact that holds them, or
 * merging such a contact needs admin authority. `ravi permissions allow`
 * (src/permissions/apply-grant.ts) stays the way to grant them.
 */
import { CliExpectedError } from "../cli/expected-error.js";
import { dbListContactChatGrants } from "./contact-chat-grants.js";
import { contactPermissionPolicyTags } from "./contact-policy-permissions-provider.js";
import { isPermissionPolicyTag } from "./permission-tags.js";
import { getScopeContext, isScopeEnforced } from "./scope.js";

export { isPermissionPolicyTag };

/** The caller holds admin:system:* (the local operator, or an admin principal). */
export function callerHasAdminAuthority(): boolean {
  return !isScopeEnforced(getScopeContext());
}

/** Contacts whose tags or chat grants confer capabilities. */
export function contactHoldsPermissionAuthority(contactId: string): boolean {
  return contactPermissionPolicyTags(contactId).length > 0 || dbListContactChatGrants({ contactId }).length > 0;
}

function denied(message: string): CliExpectedError {
  return new CliExpectedError(
    message,
    "PERMISSION_DENIED",
    1,
    "Grant permission profiles with 'ravi permissions allow', or run this as an admin principal",
  );
}

/** Refuse writing (adding or removing) permission tags without admin authority. */
export function assertPermissionTagWriteAuthority(action: string, tags: readonly string[]): void {
  const privileged = tags.filter(isPermissionPolicyTag);
  if (privileged.length === 0 || callerHasAdminAuthority()) return;
  throw denied(`${action}: ${privileged.join(", ")} is a provider-owned permission tag and needs admin authority.`);
}

/** Refuse changing identities or bindings of contacts that hold permission authority. */
export function assertPrivilegedContactWriteAuthority(action: string, contactIds: readonly string[]): void {
  if (callerHasAdminAuthority()) return;
  const privileged = contactIds.filter(contactHoldsPermissionAuthority);
  if (privileged.length === 0) return;
  throw denied(
    `${action}: contact ${privileged.join(", ")} holds permission authority, so this needs admin authority.`,
  );
}

/**
 * Refuse creating, changing, binding or unbinding a provider-owned permission
 * tag (a `permission-*` slug, or a definition with kind system and source
 * permissions) through the generic tags commands without admin authority.
 */
export function assertProviderOwnedTagWriteAuthority(
  action: string,
  slug: string,
  definitionIsPermission: boolean,
): void {
  if (!definitionIsPermission && !isPermissionPolicyTag(slug)) return;
  if (callerHasAdminAuthority()) return;
  throw denied(`${action}: ${slug} is a provider-owned permission tag and needs admin authority.`);
}
