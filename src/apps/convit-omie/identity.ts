import type { ContextRecord, ChatRecord, ChatMessageRecord } from "../../router/router-db.js";
import type { PlatformIdentity } from "../../contacts.js";
import { AppError } from "./domain.js";
import { SCOPE, type VerifiedIdentity } from "./access.js";

export interface IdentityStore {
  current(): ContextRecord | undefined;
  canonicalInstance(id: string): string;
  live(id: string): ContextRecord | null;
  chat(id: string): ChatRecord | null;
  message(chatId: string, messageId: string): ChatMessageRecord | null;
  platform(userId: string): PlatformIdentity | null;
  contactActive(id: string): boolean;
}

/** Only persisted, live ancestry can supply the human actor. Child metadata,
 * session labels, output destinations and relay text are never identity proof. */
export function verifiedCaller(store: IdentityStore): VerifiedIdentity {
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
  if (
    !source ||
    source.channel !== "slack" ||
    source.accountId !== SCOPE.account ||
    source.chatId !== SCOPE.channel ||
    !source.canonicalChatId
  ) {
    throw new AppError("OMIE_CHANNEL_DENIED", "Operação restrita ao canal configurado.");
  }
  const rootChat = store.chat(SCOPE.canonicalChat);
  if (
    !rootChat ||
    rootChat.channel !== "slack" ||
    store.canonicalInstance(rootChat.instanceId) !== store.canonicalInstance(SCOPE.account) ||
    rootChat.platformChatId !== SCOPE.channel
  )
    deny();
  const chat = store.chat(source.canonicalChatId);
  const threadTs = chat?.rawProvenance?.threadTs;
  const isRoot = chat?.id === rootChat.id && chat.platformChatId === SCOPE.channel;
  const isThread =
    chat?.chatType === "thread" &&
    typeof threadTs === "string" &&
    /^\d+\.\d+$/.test(threadTs) &&
    chat.platformChatId === `${SCOPE.channel}#${threadTs}`;
  if (
    !chat ||
    chat.channel !== "slack" ||
    store.canonicalInstance(chat.instanceId) !== store.canonicalInstance(SCOPE.account) ||
    (!isRoot && !isThread)
  )
    deny();
  if (typeof actor.sourceMessageId !== "string" || typeof actor.platformIdentityId !== "string") deny();
  const message = store.message(chat.id, actor.sourceMessageId);
  if (
    !message ||
    message.actorType !== "contact" ||
    message.channel !== "slack" ||
    store.canonicalInstance(message.instanceId) !== store.canonicalInstance(SCOPE.account) ||
    message.chatId !== chat.id ||
    message.providerMessageId !== actor.sourceMessageId ||
    message.rawChatId !== SCOPE.channel ||
    message.rawProvenance?.senderKind !== "user" ||
    message.contactId !== actor.contactId ||
    message.platformIdentityId !== actor.platformIdentityId ||
    !message.rawSenderId ||
    message.deletedAt
  )
    deny();
  const platform = store.platform(message.rawSenderId);
  if (
    !platform ||
    platform.id !== actor.platformIdentityId ||
    platform.ownerType !== "contact" ||
    platform.ownerId !== actor.contactId ||
    store.canonicalInstance(platform.instanceId) !== store.canonicalInstance(SCOPE.account) ||
    platform.channel !== "slack" ||
    !/^[UW][A-Z0-9]+$/.test(platform.platformUserId)
  )
    deny();
  return {
    verified: true,
    contextId: child.contextId,
    source: { channel: "slack", account: SCOPE.account, rootChannel: SCOPE.channel },
    actor: { kind: "human", id: actor.contactId, slackUserId: platform.platformUserId },
  };
}
function deny(): never {
  throw new AppError("OMIE_IDENTITY_REQUIRED", "Turno humano e identidade de origem verificados são obrigatórios.");
}
