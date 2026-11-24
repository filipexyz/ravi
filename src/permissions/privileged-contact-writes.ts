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
import { dbGetTagDefinition } from "../tags/tag-db.js";
import type { TagDefinition } from "../tags/types.js";
import { readPermissionTagCapabilities } from "./authorization-guidance.js";
import {
  BREAK_GLASS_REQUEST_COMMAND,
  breakGlassCapabilities,
  callerIsAgentOrRemote,
  isPermissionProfileDefinition,
  tagDefinitionBreakGlassReasons,
} from "./break-glass.js";
import { dbListContactChatGrants } from "./contact-chat-grants.js";
import { contactPermissionPolicyTags } from "./contact-policy-permissions-provider.js";
import { isPermissionPolicyTag, normalizePermissionTag } from "./permission-tags.js";
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
  if (callerHasAdminAuthority()) {
    // Holding admin lifts the generic check below, never the break-glass one.
    assertNoBreakGlassContactChange(action, contactIds);
    return;
  }
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

function breakGlassDenied(message: string): CliExpectedError {
  return new CliExpectedError(
    message,
    "FULL_ACCESS_APPROVAL_REQUIRED",
    3,
    `Break-glass power (admin:system:* or execute:executable:*) reaches a contact only through operator approval: ${BREAK_GLASS_REQUEST_COMMAND}`,
  );
}

/**
 * Refuse giving break-glass power by tagging, from an agent turn or a Console
 * invocation (spec permissions/break-glass). Holding admin does not lift this.
 * The local operator terminal keeps the owner bootstrap (`ravi contacts tag
 * <contact> permission-owner`). Removing a tag is never refused here.
 */
export function assertBreakGlassTagWriteAllowed(action: string, addedSlugs: readonly string[]): void {
  if (!callerIsAgentOrRemote()) return;
  const reasons = addedSlugs.flatMap((raw) => {
    // Same spelling the contact-policy provider reads (`permission.owner` = `permission-owner`).
    const slug = normalizePermissionTag(raw);
    return slug ? tagDefinitionBreakGlassReasons(slug, dbGetTagDefinition(slug)) : [];
  });
  if (reasons.length === 0) return;
  throw breakGlassDenied(
    `${action}: ${[...new Set(reasons)].join(", ")} confers break-glass power; an agent never grants it by tagging.`,
  );
}

/**
 * Refuse a permission profile definition (kind system, source permissions)
 * that would carry break-glass capabilities, from any caller. Admin profiles
 * have no definition, and full-access is built in: no definition needs them.
 */
export function assertPermissionDefinitionWithoutBreakGlass(
  action: string,
  slug: string,
  resulting: Pick<TagDefinition, "kind" | "source" | "metadata"> | null,
): void {
  if (!resulting || !isPermissionProfileDefinition(resulting)) return;
  const reasons = breakGlassCapabilities(readPermissionTagCapabilities(resulting as TagDefinition));
  if (reasons.length === 0) return;
  throw breakGlassDenied(
    `${action}: ${slug} would carry ${reasons.join(", ")}; a permission profile never carries break-glass power.`,
  );
}

/**
 * What break-glass power a contact holds or would hold once allowed: admin
 * tags by name, permission tags that carry break-glass, and chat grants whose
 * profile carries it. A dormant (not allowed) contact counts too.
 */
export function contactBreakGlassReasons(contactId: string): string[] {
  const fromTags = contactPermissionPolicyTags(contactId).flatMap((slug) =>
    tagDefinitionBreakGlassReasons(slug, dbGetTagDefinition(slug)),
  );
  const fromGrants = dbListContactChatGrants({ contactId }).flatMap((grant) =>
    tagDefinitionBreakGlassReasons(grant.profileSlug, dbGetTagDefinition(grant.profileSlug)),
  );
  return [...new Set([...fromTags, ...fromGrants])];
}

/**
 * Refuse, from an agent turn or a Console invocation, any write that makes an
 * identity resolve to a contact holding break-glass power, or that activates
 * such a contact: linking an identity, merging, setting its email or phone,
 * allowing or approving it (spec permissions/break-glass). Holding admin does
 * not lift this. The operator terminal is not refused.
 */
export function assertNoBreakGlassContactChange(action: string, contactIds: readonly string[]): void {
  if (!callerIsAgentOrRemote()) return;
  const reasons = [...new Set(contactIds.flatMap(contactBreakGlassReasons))];
  if (reasons.length === 0) return;
  throw breakGlassDenied(
    `${action}: the contact holds break-glass power (${reasons.join(", ")}); an agent never changes its identities or activates it.`,
  );
}
