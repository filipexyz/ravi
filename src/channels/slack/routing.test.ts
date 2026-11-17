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
  slackTextMentionsUser,
} from "./routing.js";

describe("Slack routing policy", () => {
  it("uses channel routing defaults over environment routing policy", () => {
    expect(
      slackRoutingPolicyFromChannelDefaults(
        { subscriptionScope: "chat", rootReplyMode: "new_thread" },
        { RAVI_SLACK_SUBSCRIPTION_SCOPE: "thread", RAVI_SLACK_THREAD_REPLY_MODE: "channel_root" },
      ),
    ).toMatchObject({ subscriptionScope: "chat", rootReplyMode: "new_thread", threadReplyMode: "channel_root" });
    expect(slackRoutingPolicyFromEnv({})).toEqual(DEFAULT_SLACK_ROUTING_POLICY);
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
    expect(isSlackMessageEventStructurallyEligible({ type: "app_mention", channel: "C1", ts: "1.0" })).toBe(true);
  });

  it.each(["status update", "<@ULOCAL> loop"])("ignores the local bot by either id: %s", (text) => {
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
          text,
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
          text,
        },
        options,
      ),
    ).toBe(true);
  });

  it("admits foreign bots without requiring mentions, aliases, or a text prefix", () => {
    const options = {
      selfBotId: "BLOCAL",
      selfUserId: "ULOCAL",
    };
    const bot = {
      type: "message",
      subtype: "bot_message",
      bot_id: "BFOREIGN",
      channel: "C1",
      ts: "1.0",
    } as const;

    expect(shouldIgnoreSlackMessageEvent({ ...bot, text: "status update" }, options)).toBe(false);
    expect(shouldIgnoreSlackMessageEvent({ ...bot, text: "1. First\n2. Second\n\n3. Third" }, options)).toBe(false);
    expect(shouldIgnoreSlackMessageEvent({ ...bot, text: "oi <@ULOCAL>, consegue responder?" }, options)).toBe(false);
    expect(shouldIgnoreSlackMessageEvent({ ...bot, text: "<@UOTHER> status" }, options)).toBe(false);
    expect(shouldIgnoreSlackMessageEvent({ ...bot, channel: "C2", text: " Status update" }, options)).toBe(false);
  });

  it.each([
    { bot_id: "BFOREIGN" },
    { subtype: "bot_message", user: "UFOREIGN" },
    { subtype: "bot_message", user: "UFOREIGN", bot_id: "BFOREIGN" },
    { subtype: "thread_broadcast", user: "UFOREIGN", bot_id: "BFOREIGN" },
    { subtype: "file_share", bot_id: "BFOREIGN" },
  ])("admits supported foreign bot identity shapes without addressing: %j", (identity) => {
    expect(
      shouldIgnoreSlackMessageEvent(
        { type: "message", channel: "C1", ts: "1.0", text: "update", ...identity },
        { selfBotId: "BLOCAL", selfUserId: "ULOCAL" },
      ),
    ).toBe(false);
  });

  it("rejects a bot subtype without any sender identity", () => {
    expect(
      shouldIgnoreSlackMessageEvent(
        { type: "message", subtype: "bot_message", channel: "C1", ts: "1.0", text: "update" },
        { selfBotId: "BLOCAL", selfUserId: "ULOCAL" },
      ),
    ).toBe(true);
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

  it("detects an explicit mention of one Slack user id, with or without a label", () => {
    expect(slackTextMentionsUser("<@ULOCAL> ta ai?", "ULOCAL")).toBe(true);
    expect(slackTextMentionsUser("oi <@ULOCAL|ravi>", "ULOCAL")).toBe(true);
    expect(slackTextMentionsUser("<@ULOCAL2> ta ai?", "ULOCAL")).toBe(false);
    expect(slackTextMentionsUser("<@UOTHER> ULOCAL", "ULOCAL")).toBe(false);
    expect(slackTextMentionsUser("<@ULOCAL>", undefined)).toBe(false);
    expect(slackTextMentionsUser("", "ULOCAL")).toBe(false);
  });
});
