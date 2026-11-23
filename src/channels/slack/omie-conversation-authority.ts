import type { ChatMessageRecord, ChatRecord } from "../../router/router-db.js";
import { dbFindChatMessage, dbGetChat } from "../../router/router-db.js";
import type { PlatformIdentity } from "../../contacts.js";
import { resolvePlatformIdentity } from "../../contacts.js";
import { configStore } from "../../config-store.js";
import { AppError } from "../../apps/omie-orders/domain.js";
import type { ConversationAuthority, ConversationTurnVerdict } from "../../apps/omie-orders/conversation-authority.js";
import type { OmieScope } from "../../apps/omie-orders/scope.js";
import { SlackWebApiClient } from "./client.js";
import {
  credentialConnectionForChannel,
  isSlackGatewayChannel,
  resolveSlackCredentialConfigFromEnv,
} from "./credentials.js";
import { resolveScopedSlackIdentity, resolveSlackInstanceAliases } from "./instance-alias.js";

const SLACK = "slack";
const SLACK_USER = /^[UW][A-Z0-9]+$/;
const SLACK_CONVERSATION = /^[CG][A-Z0-9]+$/;

/** Persisted state the Slack adapter reads. Every lookup is called at verification time, never cached. */
export interface SlackOmieLookups {
  canonicalInstance(id: string): string;
  chat(id: string): ChatRecord | null;
  message(chatId: string, providerMessageId: string): ChatMessageRecord | null;
  platform(userId: string, scope: OmieScope): PlatformIdentity | null;
}

export interface MemberClient {
  conversationsMembers(input: {
    channel: string;
    limit: number;
    cursor?: string;
  }): Promise<{ members?: unknown; response_metadata?: { next_cursor?: string } }>;
}

export function scopedMessage(chatId: string, providerMessageId: string, chat = dbGetChat, find = dbFindChatMessage) {
  const source = chat(chatId);
  return source ? find({ channel: SLACK, instanceId: source.instanceId, chatId, providerMessageId }) : null;
}

export function scopedPlatform(
  userId: string,
  scope: OmieScope,
  config = configStore.getConfig(),
  lookup = resolvePlatformIdentity,
) {
  const aliases = resolveSlackInstanceAliases(config, scope.account);
  return resolveScopedSlackIdentity(
    aliases,
    (instanceId) => (instanceId ? lookup({ channel: SLACK, instanceId, platformUserId: userId }) : null),
    (identity) => `${identity.ownerType}:${identity.ownerId}`,
  ).identity;
}

export const defaultSlackOmieLookups: SlackOmieLookups = {
  canonicalInstance: (id) => resolveSlackInstanceAliases(configStore.getConfig(), id).canonical,
  chat: dbGetChat,
  message: (chatId, providerMessageId) => scopedMessage(chatId, providerMessageId),
  platform: (userId, scope) => scopedPlatform(userId, scope),
};

/** Paginate completely, fail closed on malformed pages, loops or unavailable Slack. No membership cache. */
export async function currentMember(client: MemberClient, userId: string, scope: OmieScope): Promise<boolean> {
  if (!SLACK_USER.test(userId)) return false;
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const result = await client.conversationsMembers({ channel: scope.channel, limit: 200, cursor });
    if (!Array.isArray(result.members) || !result.members.every((x) => typeof x === "string")) return false;
    if (result.members.includes(userId)) return true;
    const next = result.response_metadata?.next_cursor;
    if (!next) return false;
    if (typeof next !== "string" || seen.has(next)) return false;
    seen.add(next);
    cursor = next;
  }
  return false;
}

async function slackMemberClient(scope: OmieScope, fetchImpl: typeof fetch): Promise<MemberClient> {
  const channel = configStore.getConfig().channels?.[scope.account];
  if (!channel || channel.enabled === false || channel.provider !== SLACK)
    throw new AppError("OMIE_MEMBERSHIP_REQUIRED", "Conta do canal indisponível.");
  if (isSlackGatewayChannel(channel) || credentialConnectionForChannel(channel) !== scope.channelConnection)
    throw new AppError("OMIE_MEMBERSHIP_REQUIRED", "Conexão do canal não corresponde à configuração privada.");
  const config = await resolveSlackCredentialConfigFromEnv(process.env, { channel, action: "conversations.members" });
  if (!config) throw new AppError("OMIE_MEMBERSHIP_REQUIRED", "Verificação de participação indisponível.");
  return new SlackWebApiClient({
    appToken: config.appToken,
    botToken: config.botToken,
    apiBaseUrl: config.apiBaseUrl,
    defaultHeaders: config.requestHeaders,
    fetchImpl,
  });
}

/**
 * The Slack conversation authority: a turn is accepted only from a persisted human message in the configured channel
 * or in one of its threads (a thread turn carries its own canonical chat, `<channel>#<threadTs>`), from a platform
 * identity owned by the claimed contact on the configured workspace.
 */
export function createSlackOmieConversationAuthority(
  lookups: SlackOmieLookups = defaultSlackOmieLookups,
  members: (scope: OmieScope, fetchImpl: typeof fetch) => Promise<MemberClient> = slackMemberClient,
): ConversationAuthority {
  return {
    channelType: SLACK,
    isValidConversation: (conversation) => SLACK_CONVERSATION.test(conversation),
    verifyTurn({ scope, source, actor }): ConversationTurnVerdict {
      const channelDenied = { ok: false, reason: "channel" } as const;
      const identityDenied = { ok: false, reason: "identity" } as const;
      if (!SLACK_CONVERSATION.test(scope.channel)) return identityDenied;
      if (
        source.channel !== SLACK ||
        source.accountId !== scope.account ||
        source.chatId !== scope.channel ||
        !source.canonicalChatId
      )
        return channelDenied;
      const same = (instanceId: string) =>
        lookups.canonicalInstance(instanceId) === lookups.canonicalInstance(scope.account);
      const rootChat = lookups.chat(scope.canonicalChat);
      if (
        !rootChat ||
        rootChat.channel !== SLACK ||
        !same(rootChat.instanceId) ||
        rootChat.platformChatId !== scope.channel
      )
        return identityDenied;
      const chat = lookups.chat(source.canonicalChatId);
      const threadTs = chat?.rawProvenance?.threadTs;
      const isRoot = chat?.id === rootChat.id && chat.platformChatId === scope.channel;
      const isThread =
        chat?.chatType === "thread" &&
        typeof threadTs === "string" &&
        /^\d+\.\d+$/.test(threadTs) &&
        chat.platformChatId === `${scope.channel}#${threadTs}`;
      if (!chat || chat.channel !== SLACK || !same(chat.instanceId) || (!isRoot && !isThread)) return identityDenied;
      const message = lookups.message(chat.id, actor.sourceMessageId);
      if (
        !message ||
        message.actorType !== "contact" ||
        message.channel !== SLACK ||
        !same(message.instanceId) ||
        message.chatId !== chat.id ||
        message.providerMessageId !== actor.sourceMessageId ||
        message.rawChatId !== scope.channel ||
        message.rawProvenance?.senderKind !== "user" ||
        message.contactId !== actor.contactId ||
        message.platformIdentityId !== actor.platformIdentityId ||
        !message.rawSenderId ||
        message.deletedAt
      )
        return identityDenied;
      const platform = lookups.platform(message.rawSenderId, scope);
      if (
        !platform ||
        platform.id !== actor.platformIdentityId ||
        platform.ownerType !== "contact" ||
        platform.ownerId !== actor.contactId ||
        !same(platform.instanceId) ||
        platform.channel !== SLACK ||
        !SLACK_USER.test(platform.platformUserId)
      )
        return identityDenied;
      return { ok: true, platformUserId: platform.platformUserId };
    },
    async isCurrentMember({ scope, platformUserId, fetch }) {
      if (!SLACK_USER.test(platformUserId) || !SLACK_CONVERSATION.test(scope.channel)) return false;
      return currentMember(await members(scope, fetch), platformUserId, scope);
    },
    capabilities: (scope) => [`use:credential:slack:${scope.channelConnection}`, "execute:slack:conversations.members"],
  };
}
