/**
 * Person credentials.
 *
 * A runtime context the operator issues for one person (a paired device key,
 * for example) carries `personCredentialContactId`. Such a credential is not a
 * turn and lends nothing of its own: a session relay produced with it is that
 * person's turn. The runtime resolves the actor to the contact and applies the
 * authority a turn of that person in the session's chat would get (their chat
 * grants, or the agent without the break-glass they do not hold). A credential
 * that is revoked or expired, or whose contact is gone, blocked or opted out,
 * lends nothing at all.
 *
 * The core knows only the marker, never the surface that issued it.
 */
import { getContactDetails } from "../contacts.js";
import { dbGetContext, type ContextRecord } from "../router/router-db.js";
import { isRuntimeContextLive } from "./context-liveness.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { resolveRuntimeTurnOrigin } from "./turn-origin.js";

export const PERSON_CREDENTIAL_CONTACT_KEY = "personCredentialContactId";

/** Metadata that marks a context as one person's credential. */
export function personCredentialMetadata(contactId: string): Record<string, string> {
  return { [PERSON_CREDENTIAL_CONTACT_KEY]: contactId };
}

/**
 * The contact a context is a credential for, or null. A context bound to an
 * agent or a session is a turn or agent work, never a person's credential.
 */
export function personCredentialContactId(
  record: Pick<ContextRecord, "agentId" | "sessionKey" | "metadata"> | null | undefined,
): string | null {
  const value = record?.metadata?.[PERSON_CREDENTIAL_CONTACT_KEY];
  if (typeof value !== "string" || !value.trim()) return null;
  if (record?.agentId || record?.sessionKey) return null;
  return value.trim();
}

export interface PersonCredentialCaller {
  caller: ContextRecord;
  contactId: string;
  /** False when the credential is revoked or expired, or the contact is gone, blocked or opted out. */
  usable: boolean;
  displayName?: string;
}

/** The person whose credential produced this prompt (its turn origin's caller), or null. */
export function resolvePersonCredentialCaller(
  prompt: Pick<RuntimeLaunchPrompt, "_turnOrigin">,
): PersonCredentialCaller | null {
  const callerContextId = resolveRuntimeTurnOrigin(prompt._turnOrigin)?.callerContextId;
  if (!callerContextId) return null;
  const caller = dbGetContext(callerContextId);
  const contactId = personCredentialContactId(caller);
  if (!caller || !contactId) return null;
  const details = getContactDetails(contactId, { includeDuplicateCandidates: false });
  const usable = Boolean(
    isRuntimeContextLive(caller) && details && details.policy?.status !== "blocked" && !details.policy?.optOut,
  );
  const displayName = details?.contact.displayName?.trim();
  return { caller, contactId, usable, ...(displayName ? { displayName } : {}) };
}
