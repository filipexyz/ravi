import { contactExists, recordContactPermissionGrantEvent, resolveMergedContactId } from "../contacts.js";
import { revokeLiveRuntimeContextsForContactGrant } from "../runtime/context-registry.js";
import {
  type ContactChatGrant,
  dbDeleteContactChatGrant,
  dbEnsureContactChatGrant,
  dbListContactChatGrants,
} from "./contact-chat-grants.js";
import { formatContactGrantScope, readProfileCapabilityStrings } from "./contact-policy-permissions-provider.js";

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
 *   a grant the target already has is kept once);
 * - a merge never changes who governs a chat: a chat with at least one grant
 *   is governed by contact grants, and with none it falls back to the agent
 *   identity. A drop that would remove the LAST grant covering its scope is
 *   not done; the row stays where it is (on a deleted id it authorizes no one)
 *   and the outcome says so.
 */

export interface MergedGrantOutcome {
  grantId: string;
  profileSlug: string;
  scopeType: ContactChatGrant["scopeType"];
  scopeId: string;
  outcome: "moved" | "already_on_target" | "dropped_break_glass" | "dropped_no_target" | "kept_last_governing_grant";
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

function grantScopeLabel(grant: ContactChatGrant): string {
  return formatContactGrantScope(
    grant.scopeType === "chat" ? { type: "chat", chatId: grant.scopeId } : { type: "chat_tag", chatTag: grant.scopeId },
  );
}

function isLastGrantCoveringScope(grant: ContactChatGrant): boolean {
  return (
    dbListContactChatGrants({ scopeType: grant.scopeType, scopeId: grant.scopeId }).filter(
      (other) => other.id !== grant.id,
    ).length === 0
  );
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
  const drop = (outcome: "dropped_break_glass" | "dropped_no_target"): MergedGrantOutcome => {
    if (isLastGrantCoveringScope(grant)) return { ...base, outcome: "kept_last_governing_grant" };
    dbDeleteContactChatGrant(key);
    revokeLiveRuntimeContextsForContactGrant(grant.contactId, `${grant.profileSlug}@${grantScopeLabel(grant)}`, {
      reason: "contact_grant_dropped_on_merge",
    });
    return { ...base, outcome };
  };
  if (!targetContactId) return drop("dropped_no_target");
  if (profileCarriesBreakGlass(grant.profileSlug)) return drop("dropped_break_glass");
  const { created } = dbEnsureContactChatGrant({
    contactId: targetContactId,
    profileSlug: grant.profileSlug,
    scopeType: grant.scopeType,
    scopeId: grant.scopeId,
    createdBy: `contact-merge:${grant.contactId}`,
  });
  dbDeleteContactChatGrant(key);
  revokeLiveRuntimeContextsForContactGrant(grant.contactId, `${grant.profileSlug}@${grantScopeLabel(grant)}`, {
    reason: "contact_grant_moved_on_merge",
  });
  return { ...base, outcome: created ? "moved" : "already_on_target" };
}

/** Called right after `mergeContacts` commits. */
export function reassignContactChatGrantsOnMerge(sourceContactId: string, targetContactId: string): ReassignResult {
  // A self-merge is not a merge: nothing moves and nothing is dropped.
  if (sourceContactId === targetContactId) return { sourceContactId, targetContactId, grants: [] };
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
 * before this fix). Those rows authorize no one: no turn resolves to a deleted
 * id. The repair must not change effective permissions, so it never moves a
 * grant to the survivor (the operator may have revoked the survivor's own grant
 * since); it only removes dead rows, and keeps the last row covering a scope so
 * the chat stays governed. The survivor, when the merge chain reaches one, gets
 * the audit event.
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
    const outcomes = grants.map((grant) => reassignGrant(grant, null));
    if (outcomes.every((outcome) => outcome.outcome === "kept_last_governing_grant")) continue;
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
