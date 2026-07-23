import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SLACK_ROUTING_POLICY,
  isSlackMessageEventStructurallyEligible,
  normalizeSlackRoutingPolicy,
  resolveSlackThreadContext,
  shouldIgnoreSlackMessageEvent,
  slackPeerKindForChannelType,
  slackRoutingPolicyFromChannelDefaults,
  slackRoutingPolicyFromEnv,
} from "./routing.js";

describe("Slack routing policy", () => {
  it("keeps foreign bot aliases disabled by default and out of environment config", () => {
    expect(normalizeSlackRoutingPolicy({}).botMessageAliasesByChat).toEqual({});
    expect(
      slackRoutingPolicyFromEnv({
        RAVI_SLACK_BOT_MESSAGE_ALIASES_BY_CHAT: '{"C1":["Ravi"]}',
      } as NodeJS.ProcessEnv).botMessageAliasesByChat,
    ).toEqual({});
  });

  it("normalizes chat-scoped bot aliases from channel defaults", () => {
    expect(
      slackRoutingPolicyFromChannelDefaults(
        {
          botMessageAliasesByChat: {
            C1: [" Ravi ", "ravi", "Hana", ""],
            C2: "not-an-array",
          },
        },
        {} as NodeJS.ProcessEnv,
      ).botMessageAliasesByChat,
    ).toEqual({ C1: ["ravi", "Hana"] });
  });

  it("keeps threaded messages in the same thread by default", () => {
    const thread = resolveSlackThreadContext(
      { ts: "1710000000.000200", thread_ts: "1710000000.000100" },
      DEFAULT_SLACK_ROUTING_POLICY,
    );

    expect(thread).toEqual({
      inboundThreadTs: "1710000000.000100",
      routeThreadTs: "1710000000.000100",
      outboundThreadTs: "1710000000.000100",
    });
  });

  it("can route a root message into a new thread for reply policy", () => {
    const policy = normalizeSlackRoutingPolicy({ rootReplyMode: "new_thread" });
    const thread = resolveSlackThreadContext({ ts: "1710000000.000300" }, policy);

    expect(thread).toEqual({
      routeThreadTs: "1710000000.000300",
      outboundThreadTs: "1710000000.000300",
    });
  });

  it("can subscribe at chat scope while still replying into the inbound thread", () => {
    const policy = normalizeSlackRoutingPolicy({ subscriptionScope: "chat" });
    const thread = resolveSlackThreadContext({ ts: "1710000000.000400", thread_ts: "1710000000.000100" }, policy);

    expect(thread).toEqual({
      inboundThreadTs: "1710000000.000100",
      outboundThreadTs: "1710000000.000100",
    });
  });

  it("maps Slack IMs to dm sessions and non-IM conversations to group routes", () => {
    expect(slackPeerKindForChannelType("im")).toBe("dm");
    expect(slackPeerKindForChannelType("channel")).toBe("group");
    expect(slackPeerKindForChannelType("group")).toBe("group");
    expect(slackPeerKindForChannelType("mpim")).toBe("group");
    expect(slackPeerKindForChannelType(undefined)).toBe("group");
  });

  it("ignores non-message events and foreign bots when local auth identity is unavailable", () => {
    expect(shouldIgnoreSlackMessageEvent({ type: "reaction_added", user: "U1", channel: "C1", ts: "1.0" })).toBe(true);
    expect(shouldIgnoreSlackMessageEvent({ type: "message", bot_id: "B1", channel: "C1", ts: "1.0" })).toBe(true);
    expect(shouldIgnoreSlackMessageEvent({ type: "message", user: "U1", channel: "C1", ts: "1.0" })).toBe(false);
  });

  it("structurally prefilters unsupported or malformed messages before identity policy", () => {
    expect(isSlackMessageEventStructurallyEligible({ type: "reaction_added", channel: "C1", ts: "1.0" })).toBe(false);
    expect(isSlackMessageEventStructurallyEligible({ type: "message", hidden: true, channel: "C1", ts: "1.0" })).toBe(
      false,
    );
    expect(
      isSlackMessageEventStructurallyEligible({
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        ts: "1.0",
      }),
    ).toBe(false);
    expect(isSlackMessageEventStructurallyEligible({ type: "message", channel: " ", ts: "1.0" })).toBe(false);
    expect(isSlackMessageEventStructurallyEligible({ type: "message", channel: "C1", ts: " " })).toBe(false);
    expect(isSlackMessageEventStructurallyEligible({ type: "message", channel: "C1", ts: "1.0" })).toBe(true);
  });

  it("ignores the local bot by either bot_id or user id", () => {
    const options = { selfBotId: "BLOCAL", selfUserId: "ULOCAL" };
    expect(
      shouldIgnoreSlackMessageEvent(
        {
          type: "message",
          subtype: "bot_message",
          bot_id: "BLOCAL",
          user: "UOTHER",
          channel: "C1",
          ts: "1.0",
          text: "<@ULOCAL> loop",
        },
        options,
      ),
    ).toBe(true);
    expect(
      shouldIgnoreSlackMessageEvent(
        {
          type: "message",
          subtype: "bot_message",
          bot_id: "BOTHER",
          user: "ULOCAL",
          channel: "C1",
          ts: "1.0",
          text: "<@ULOCAL> loop",
        },
        options,
      ),
    ).toBe(true);
  });

  it("admits a foreign bot only when explicitly mentioned or addressed by a chat alias", () => {
    const options = {
      selfBotId: "BLOCAL",
      selfUserId: "ULOCAL",
      botMessageAliasesByChat: { C1: ["Hana"] },
    };
    const bot = {
      type: "message",
      subtype: "bot_message",
      bot_id: "BFOREIGN",
      channel: "C1",
      ts: "1.0",
    } as const;

    expect(shouldIgnoreSlackMessageEvent({ ...bot, text: "status update" }, options)).toBe(true);
    expect(shouldIgnoreSlackMessageEvent({ ...bot, text: "oi <@ULOCAL>, consegue responder?" }, options)).toBe(false);
    expect(shouldIgnoreSlackMessageEvent({ ...bot, text: "hana: consegue responder?" }, options)).toBe(false);
    expect(shouldIgnoreSlackMessageEvent({ ...bot, text: "Hana—consegue responder?" }, options)).toBe(false);
    expect(shouldIgnoreSlackMessageEvent({ ...bot, text: "Hana" }, options)).toBe(false);
  });

  it("rejects aliases from another chat, mid-sentence, or partial words", () => {
    const options = {
      selfBotId: "BLOCAL",
      selfUserId: "ULOCAL",
      botMessageAliasesByChat: { C1: ["Hana"] },
    };
    const bot = {
      type: "message",
      subtype: "bot_message",
      bot_id: "BFOREIGN",
      ts: "1.0",
    } as const;

    expect(shouldIgnoreSlackMessageEvent({ ...bot, channel: "C2", text: "Hana, oi" }, options)).toBe(true);
    expect(shouldIgnoreSlackMessageEvent({ ...bot, channel: "C1", text: "oi Hana, tudo bem?" }, options)).toBe(true);
    expect(shouldIgnoreSlackMessageEvent({ ...bot, channel: "C1", text: "Hanami não é alias" }, options)).toBe(true);
    expect(shouldIgnoreSlackMessageEvent({ ...bot, channel: "C1", text: " Hana, não começa no alias" }, options)).toBe(
      true,
    );
  });

  it("accepts Slack file_share events so audio uploads are routed", () => {
    expect(
      shouldIgnoreSlackMessageEvent({
        type: "message",
        subtype: "file_share",
        user: "U1",
        channel: "C1",
        ts: "1.0",
        files: [{ id: "F1", mimetype: "audio/mp4", filetype: "m4a" }],
      }),
    ).toBe(false);
    expect(
      shouldIgnoreSlackMessageEvent({
        type: "message",
        subtype: "message_changed",
        user: "U1",
        channel: "C1",
        ts: "1.0",
      }),
    ).toBe(true);
  });
});
