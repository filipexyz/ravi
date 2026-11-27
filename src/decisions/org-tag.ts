import { CliExpectedError } from "../cli/expected-error.js";
import { findContactsByTag } from "../contacts.js";
import { OWNER_CONTACT_TAG } from "../knowledge/owner.js";
import { callerIsAgentOrRemote } from "../permissions/break-glass.js";
import { getScopeContext } from "../permissions/scope.js";
import { dbGetAgent, dbGetSetting, dbSetSetting } from "../router/router-db.js";
import { dbEnsureTagBinding, tryNormalizeTagSlug } from "../tags/tag-db.js";

/**
 * Org decisions reach only agents tagged as working for the org. Without the tag (client-facing agents, or any agent
 * nobody classified) a turn carries just its agent's own and its thread's decisions: the owner approving "org" does
 * not see client audiences, so the default is closed.
 */
export const ORG_DECISIONS_AGENT_TAG = "org-internal";

/** The installation's owner: a contact tagged `permission-owner` now, read at the time of the check. */
export function isInstallationOwner(contactId: string | null | undefined): boolean {
  if (!contactId) return false;
  return findContactsByTag(OWNER_CONTACT_TAG).some((contact) => contact.id === contactId);
}

/**
 * Who reads org decisions is the owner's call: attaching or detaching `org-internal` is refused to agents and remote
 * callers, except a turn carrying the installation owner's own authority. The local operator always may.
 */
export function assertOrgInternalTagWriteAllowed(action: string, slug: string): void {
  if (tryNormalizeTagSlug(slug) !== ORG_DECISIONS_AGENT_TAG) return;
  if (!callerIsAgentOrRemote()) return;
  const owner = getScopeContext().context?.metadata?.ownerAuthority;
  if (typeof owner === "string" && owner.startsWith("contact:") && isInstallationOwner(owner.slice("contact:".length)))
    return;
  throw new CliExpectedError(
    `${action}: ${ORG_DECISIONS_AGENT_TAG} decides which agents read the org's decisions; only the installation owner or the local operator sets it.`,
    "PERMISSION_DENIED",
    1,
    "Ask the owner, or run it from the operator's terminal.",
  );
}

const ORG_INTERNAL_SEEDED_SETTING = "decisions.orgInternalSeeded";

/**
 * Once per installation, `main` is tagged as working for the org, so org decisions keep reaching it after this
 * release. Removing the tag afterwards is respected: the seed never runs again.
 */
export function seedOrgInternalTagOnce(): void {
  if (dbGetSetting(ORG_INTERNAL_SEEDED_SETTING)) return;
  if (dbGetAgent("main"))
    dbEnsureTagBinding({
      slug: ORG_DECISIONS_AGENT_TAG,
      assetType: "agent",
      assetId: "main",
      source: "decisions",
      label: "Works for the org",
      description: "Receives the org's decisions in every turn.",
    });
  dbSetSetting(ORG_INTERNAL_SEEDED_SETTING, new Date().toISOString());
}
