import { contactExists, recordContactPermissionGrantEvent, resolveMergedContactId } from "../contacts.js";
import {
  type ContactChatGrant,
  dbDeleteContactChatGrant,
  dbEnsureContactChatGrant,
  dbListContactChatGrants,
} from "./contact-chat-grants.js";
import { readProfileCapabilityStrings } from "./contact-policy-permissions-provider.js";

/**
 * Chat-scoped grants follow a contact merge.
 *
 * Grants live in ravi.db keyed by contact id; contacts live in chat.db. A merge
 * deletes the source contact, so a grant left on the source id is dead: no
 * turn resolves to that id again, and no command can name it. Before this,
 * every merge left such rows behind.
 *
 * Rule (spec permissions/contact-merge-grants):
 * - a grant whose profile carries break-glass power (any `admin:system`
 *   capability or the whole `execute:executable:*`) is NOT carried over:
 *   that power only comes from an approved `permissions request`. It is
 *   removed and recorded on the surviving contact;
 * - any other grant moves to the surviving contact (same profile, same scope;
 *   a grant the target already has is kept once).
 */

export interface MergedGrantOutcome {
  grantId: string;
  profileSlug: string;
  scopeType: ContactChatGrant["scopeType"];
  scopeId: string;
  outcome: "moved" | "already_on_target" | "dropped_break_glass" | "dropped_no_target";
}

export interface ReassignResult {
  sourceContactId: string;
  targetContactId: string | null;
  grants: MergedGrantOutcome[];
}

export function isBreakGlassCapabilityString(value: string): boolean {
  const capability = value.trim().toLowerCase();
  return capability.startsWith("admin:system") || capability === "execute:executable:*";
}

export function profileCarriesBreakGlass(profileSlug: string): boolean {
  return readProfileCapabilityStrings(profileSlug).some(isBreakGlassCapabilityString);
}

function reassignGrant(grant: ContactChatGrant, targetContactId: string | null): MergedGrantOutcome {
  const base = {
    grantId: grant.id,
    profileSlug: grant.profileSlug,
    scopeType: grant.scopeType,
    scopeId: grant.scopeId,
  };
  const key = {
    contactId: grant.contactId,
    profileSlug: grant.profileSlug,
    scopeType: grant.scopeType,
    scopeId: grant.scopeId,
  };
  if (!targetContactId) {
    dbDeleteContactChatGrant(key);
    return { ...base, outcome: "dropped_no_target" };
  }
  if (profileCarriesBreakGlass(grant.profileSlug)) {
    dbDeleteContactChatGrant(key);
    return { ...base, outcome: "dropped_break_glass" };
  }
  const { created } = dbEnsureContactChatGrant({
    contactId: targetContactId,
    profileSlug: grant.profileSlug,
    scopeType: grant.scopeType,
    scopeId: grant.scopeId,
    createdBy: `contact-merge:${grant.contactId}`,
  });
  dbDeleteContactChatGrant(key);
  return { ...base, outcome: created ? "moved" : "already_on_target" };
}

/** Called right after `mergeContacts` commits. */
export function reassignContactChatGrantsOnMerge(sourceContactId: string, targetContactId: string): ReassignResult {
  const grants = dbListContactChatGrants({ contactId: sourceContactId }).map((grant) =>
    reassignGrant(grant, targetContactId),
  );
  if (grants.length > 0) {
    recordContactPermissionGrantEvent(targetContactId, { sourceContactId, targetContactId, grants });
  }
  return { sourceContactId, targetContactId, grants };
}

/**
 * Boot repair for grants left on contacts that no longer exist (merges done
 * before this fix). Same rule as a merge; a grant whose contact was never
 * merged anywhere is removed, since nothing can resolve to it.
 */
export function repairOrphanContactChatGrants(): ReassignResult[] {
  const bySource = new Map<string, ContactChatGrant[]>();
  for (const grant of dbListContactChatGrants()) {
    if (contactExists(grant.contactId)) continue;
    const list = bySource.get(grant.contactId) ?? [];
    list.push(grant);
    bySource.set(grant.contactId, list);
  }
  const results: ReassignResult[] = [];
  for (const [sourceContactId, grants] of bySource) {
    const targetContactId = resolveMergedContactId(sourceContactId);
    const outcomes = grants.map((grant) => reassignGrant(grant, targetContactId));
    if (targetContactId) {
      recordContactPermissionGrantEvent(targetContactId, {
        sourceContactId,
        targetContactId,
        grants: outcomes,
        repair: true,
      });
    }
    results.push({ sourceContactId, targetContactId, grants: outcomes });
  }
  return results;
}
