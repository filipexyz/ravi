import { expect, test } from "bun:test";
import type { OmieScope } from "../../apps/omie-orders/scope.js";
import {
  createSlackOmieConversationAuthority,
  type MemberClient,
  type SlackOmieLookups,
} from "./omie-conversation-authority.js";

const SCOPE: OmieScope = Object.freeze({
  app: "omie-orders",
  channelType: "slack",
  account: "example-slack",
  channel: "CEXAMPLE01",
  canonicalChat: "chat_example",
  executor: "example-executor",
  connection: "example-orders",
  channelConnection: "example-slack-connection",
});
const ACTOR = { contactId: "person", sourceMessageId: "123.456", platformIdentityId: "pi-synthetic" };
const THREAD_CHAT = "chat_example_thread";

function lookups(): SlackOmieLookups & { platformRecord: Record<string, unknown> } {
  const platformRecord: Record<string, unknown> = {
    id: "pi-synthetic",
    ownerType: "contact",
    ownerId: "person",
    channel: "slack",
    instanceId: SCOPE.account,
    platformUserId: "USYNTHETIC1",
  };
  return {
    platformRecord,
    canonicalInstance: (id) => id,
    chat: (id) =>
      ({
        id,
        channel: "slack",
        instanceId: SCOPE.account,
        platformChatId: id === SCOPE.canonicalChat ? SCOPE.channel : `${SCOPE.channel}#123.400`,
        chatType: id === SCOPE.canonicalChat ? "group" : "thread",
        rawProvenance: { threadTs: id === SCOPE.canonicalChat ? null : "123.400" },
      }) as any,
    message: (chatId, providerMessageId) =>
      ({
        actorType: "contact",
        channel: "slack",
        instanceId: SCOPE.account,
        chatId,
        providerMessageId,
        rawChatId: SCOPE.channel,
        rawProvenance: { senderKind: "user" },
        contactId: "person",
        platformIdentityId: "pi-synthetic",
        rawSenderId: "USYNTHETIC1",
      }) as any,
    platform: () => platformRecord as any,
  };
}
const source = (canonicalChatId = SCOPE.canonicalChat) => ({
  channel: "slack",
  accountId: SCOPE.account,
  chatId: SCOPE.channel,
  canonicalChatId,
});

test("a persisted human message in the configured channel or in one of its threads is accepted", () => {
  const authority = createSlackOmieConversationAuthority(lookups());
  expect(authority.verifyTurn({ scope: SCOPE, source: source(), actor: ACTOR })).toEqual({
    ok: true,
    platformUserId: "USYNTHETIC1",
  });
  // A thread turn carries the thread's own canonical chat, not the root one.
  expect(authority.verifyTurn({ scope: SCOPE, source: source(THREAD_CHAT), actor: ACTOR })).toEqual({
    ok: true,
    platformUserId: "USYNTHETIC1",
  });
});

test("another conversation is a channel refusal; an unproven author is an identity refusal", () => {
  const authority = createSlackOmieConversationAuthority(lookups());
  expect(authority.verifyTurn({ scope: SCOPE, source: { ...source(), chatId: "COTHER01" }, actor: ACTOR })).toEqual({
    ok: false,
    reason: "channel",
  });
  expect(authority.verifyTurn({ scope: SCOPE, source: { ...source(), accountId: "other" }, actor: ACTOR })).toEqual({
    ok: false,
    reason: "channel",
  });
  const bot = lookups();
  bot.message = (chatId, id) => ({ ...(lookups().message(chatId, id) as any), rawProvenance: { senderKind: "bot" } });
  expect(
    createSlackOmieConversationAuthority(bot).verifyTurn({ scope: SCOPE, source: source(), actor: ACTOR }),
  ).toEqual({
    ok: false,
    reason: "identity",
  });
  const otherOwner = lookups();
  otherOwner.platformRecord.ownerId = "someone-else";
  expect(
    createSlackOmieConversationAuthority(otherOwner).verifyTurn({ scope: SCOPE, source: source(), actor: ACTOR }),
  ).toEqual({ ok: false, reason: "identity" });
  const fakeThread = lookups();
  fakeThread.chat = (id) =>
    id === SCOPE.canonicalChat
      ? lookups().chat(id)
      : ({
          id,
          channel: "slack",
          instanceId: SCOPE.account,
          platformChatId: "COTHER01#123.400",
          chatType: "thread",
          rawProvenance: { threadTs: "123.400" },
        } as any);
  expect(
    createSlackOmieConversationAuthority(fakeThread).verifyTurn({
      scope: SCOPE,
      source: source(THREAD_CHAT),
      actor: ACTOR,
    }),
  ).toEqual({ ok: false, reason: "identity" });
  const deleted = lookups();
  deleted.message = (chatId, id) => ({ ...(lookups().message(chatId, id) as any), deletedAt: 1 });
  expect(
    createSlackOmieConversationAuthority(deleted).verifyTurn({ scope: SCOPE, source: source(), actor: ACTOR }),
  ).toEqual({ ok: false, reason: "identity" });
});

test("membership is read fresh through the configured connection and fails closed on any doubt", async () => {
  let members: unknown = ["UOTHER", "USYNTHETIC1"];
  const seen: OmieScope[] = [];
  const client: MemberClient = { conversationsMembers: async () => ({ members }) };
  const authority = createSlackOmieConversationAuthority(lookups(), async (scope) => {
    seen.push(scope);
    return client;
  });
  const ask = (platformUserId: string, scope = SCOPE) => authority.isCurrentMember({ scope, platformUserId, fetch });
  expect(await ask("USYNTHETIC1")).toBe(true);
  members = ["UOTHER"];
  expect(await ask("USYNTHETIC1")).toBe(false);
  members = "malformed";
  expect(await ask("USYNTHETIC1")).toBe(false);
  // A value that is not a Slack user id, or a conversation that is not a Slack channel, never reaches Slack.
  const before = seen.length;
  expect(await ask("not-a-user")).toBe(false);
  expect(await ask("USYNTHETIC1", { ...SCOPE, channel: "room-1" })).toBe(false);
  expect(seen.length).toBe(before);
});

test("the adapter names its own per-call capabilities and conversation shape", () => {
  const authority = createSlackOmieConversationAuthority(lookups());
  expect(authority.channelType).toBe("slack");
  expect(authority.capabilities(SCOPE)).toEqual([
    "use:credential:slack:example-slack-connection",
    "execute:slack:conversations.members",
  ]);
  expect(authority.isValidConversation("CEXAMPLE01")).toBe(true);
  expect(authority.isValidConversation("GEXAMPLE01")).toBe(true);
  expect(authority.isValidConversation("room-1")).toBe(false);
});
