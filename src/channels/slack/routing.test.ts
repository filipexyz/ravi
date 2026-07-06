import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SLACK_ROUTING_POLICY,
  normalizeSlackRoutingPolicy,
  resolveSlackThreadContext,
  shouldIgnoreSlackMessageEvent,
  slackPeerKindForChannelType,
} from "./routing.js";

describe("Slack routing policy", () => {
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

  it("maps Slack IMs to dm sessions and channels to channel sessions", () => {
    expect(slackPeerKindForChannelType("im")).toBe("dm");
    expect(slackPeerKindForChannelType("channel")).toBe("channel");
    expect(slackPeerKindForChannelType(undefined)).toBe("channel");
  });

  it("ignores bot and non-message events", () => {
    expect(shouldIgnoreSlackMessageEvent({ type: "reaction_added", user: "U1", channel: "C1", ts: "1.0" })).toBe(true);
    expect(shouldIgnoreSlackMessageEvent({ type: "message", bot_id: "B1", channel: "C1", ts: "1.0" })).toBe(true);
    expect(shouldIgnoreSlackMessageEvent({ type: "message", user: "U1", channel: "C1", ts: "1.0" })).toBe(false);
  });
});
