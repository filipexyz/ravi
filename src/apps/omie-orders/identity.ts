import type { ContextRecord } from "../../router/router-db.js";
import { AppError } from "./domain.js";
import { type VerifiedIdentity } from "./access.js";
import type { ConversationAuthority } from "./conversation-authority.js";
import type { OmieScope } from "./scope.js";

export interface IdentityStore {
  scope: OmieScope;
  /** The adapter of `scope.channelType`; it proves the conversation, the message and the platform identity. */
  authority: ConversationAuthority;
  current(): ContextRecord | undefined;
  live(id: string): ContextRecord | null;
  contactActive(id: string): boolean;
}

/** Only persisted, live ancestry can supply the human actor. Child metadata,
 * session labels, output destinations and relay text are never identity proof. */
export function verifiedCaller(store: IdentityStore): VerifiedIdentity {
  const SCOPE = store.scope;
  if (store.authority.channelType !== SCOPE.channelType) deny();
  const claimed = store.current();
  let context = claimed && store.live(claimed.contextId);
  if (!context || context.contextKey !== claimed?.contextKey) deny();
  const child = context;
  if (
    child.kind !== "app-runtime" ||
    child.metadata?.appId !== SCOPE.app ||
    child.metadata?.source !== "app-router" ||
    child.metadata?.issuedFor !== `app:${SCOPE.app}` ||
    typeof child.metadata?.parentContextId !== "string"
  )
    deny();
  const seen = new Set<string>();
  while (typeof context.metadata?.parentContextId === "string") {
    if (seen.has(context.contextId) || seen.size >= 32) deny();
    seen.add(context.contextId);
    const parent = store.live(context.metadata.parentContextId);
    if (
      !parent ||
      parent.agentId !== child.agentId ||
      parent.sessionKey !== child.sessionKey ||
      JSON.stringify(parent.source) !== JSON.stringify(child.source)
    )
      deny();
    context = parent;
  }
  const actor = context.metadata?.actor as Record<string, unknown> | undefined;
  const provenance = context.metadata?.turnProvenance as Record<string, unknown> | undefined;
  if (
    context.kind !== "turn-runtime" ||
    context.metadata?.authorityResolver !== "agent-identity-v1" ||
    context.metadata?.actorResolution !== "resolved" ||
    provenance?.origin !== "human" ||
    actor?.actorType !== "contact" ||
    typeof actor.contactId !== "string" ||
    context.metadata?.actorPrincipal !== `contact:${actor.contactId}` ||
    context.agentId !== SCOPE.executor ||
    !store.contactActive(actor.contactId)
  )
    deny();
  const source = context.source;
  if (!source || source.channel !== SCOPE.channelType) channelDenied();
  if (typeof actor.sourceMessageId !== "string" || typeof actor.platformIdentityId !== "string") deny();
  const verdict = store.authority.verifyTurn({
    scope: SCOPE,
    source,
    actor: {
      contactId: actor.contactId,
      sourceMessageId: actor.sourceMessageId,
      platformIdentityId: actor.platformIdentityId,
    },
  });
  if (!verdict.ok) {
    if (verdict.reason === "channel") channelDenied();
    deny();
  }
  if (typeof verdict.platformUserId !== "string" || !verdict.platformUserId) deny();
  return {
    verified: true,
    contactGoverned: context.metadata?.actorAuthorizationMode === "user-overlay",
    contextId: child.contextId,
    source: { channel: SCOPE.channelType, account: SCOPE.account, rootChannel: SCOPE.channel },
    actor: { kind: "human", id: actor.contactId, platformUserId: verdict.platformUserId },
  };
}
function deny(): never {
  throw new AppError("OMIE_IDENTITY_REQUIRED", "Turno humano e identidade de origem verificados são obrigatórios.");
}
function channelDenied(): never {
  throw new AppError("OMIE_CHANNEL_DENIED", "Operação restrita ao canal configurado.");
}
