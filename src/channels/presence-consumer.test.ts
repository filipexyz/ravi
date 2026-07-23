import { describe, expect, it, mock } from "bun:test";
import { processChannelPresenceRequest, subjectForChannelPresence } from "./presence-consumer.js";
import type { NativePresenceDelivery } from "./native/types.js";

describe("channel presence consumer", () => {
  it("routes native presence requests to the matching adapter", async () => {
    const sendPresence = mock(async () => ({
      provider: "slack",
      status: "active" as const,
    }));
    const adapter: NativePresenceDelivery = {
      channelId: "slack",
      supports: (target) => target.channel === "slack",
      sendPresence,
    };

    await processChannelPresenceRequest(
      {
        channelId: "slack",
        sessionName: "ravi-hil",
        active: true,
        reason: "runtime-turn.started",
        timestamp: 1783100000000,
        target: {
          channel: "slack",
          accountId: "ravi-rbbt-slack",
          chatId: "C123",
          sourceMessageId: "1713000000.000100",
        },
      },
      { deliveries: [adapter] },
    );

    expect(sendPresence).toHaveBeenCalledWith({
      sessionName: "ravi-hil",
      active: true,
      reason: "runtime-turn.started",
      target: {
        channel: "slack",
        accountId: "ravi-rbbt-slack",
        chatId: "C123",
        sourceMessageId: "1713000000.000100",
      },
    });
  });

  it("keeps only one active status target per session", async () => {
    const sendPresence = mock(async () => ({
      provider: "slack",
      status: "active" as const,
    }));
    const adapter: NativePresenceDelivery = {
      channelId: "slack",
      supports: (target) => target.channel === "slack",
      sendPresence,
    };
    const presenceState = { activeTargetsBySession: new Map() };

    await processChannelPresenceRequest(
      {
        channelId: "slack",
        sessionName: "ravi-hil",
        active: true,
        timestamp: 1783100000000,
        target: {
          channel: "slack",
          accountId: "ravi-rbbt-slack",
          chatId: "C123",
          sourceMessageId: "inbound-1",
        },
      },
      { deliveries: [adapter], presenceState },
    );

    await processChannelPresenceRequest(
      {
        channelId: "slack",
        sessionName: "ravi-hil",
        active: true,
        reason: "native-delivery-renew",
        timestamp: 1783100001000,
        target: {
          channel: "slack",
          accountId: "ravi-rbbt-slack",
          chatId: "C123",
          sourceMessageId: "inbound-1",
          statusAnchorKind: "last_outbound_message",
          statusAnchorMessageId: "outbound-1",
        },
      },
      { deliveries: [adapter], presenceState },
    );

    await processChannelPresenceRequest(
      {
        channelId: "slack",
        sessionName: "ravi-hil",
        active: false,
        reason: "terminal-stop",
        timestamp: 1783100002000,
        target: {
          channel: "slack",
          accountId: "ravi-rbbt-slack",
          chatId: "C123",
          sourceMessageId: "inbound-1",
        },
      },
      { deliveries: [adapter], presenceState },
    );

    expect(sendPresence).toHaveBeenNthCalledWith(1, {
      sessionName: "ravi-hil",
      active: true,
      reason: undefined,
      target: expect.objectContaining({ sourceMessageId: "inbound-1" }),
    });
    expect(sendPresence).toHaveBeenNthCalledWith(2, {
      sessionName: "ravi-hil",
      active: false,
      reason: "native-delivery-renew:replace-anchor",
      target: expect.objectContaining({ sourceMessageId: "inbound-1" }),
    });
    expect(sendPresence).toHaveBeenNthCalledWith(3, {
      sessionName: "ravi-hil",
      active: true,
      reason: "native-delivery-renew",
      target: expect.objectContaining({ statusAnchorMessageId: "outbound-1" }),
    });
    expect(sendPresence).toHaveBeenNthCalledWith(4, {
      sessionName: "ravi-hil",
      active: false,
      reason: "terminal-stop:current-anchor",
      target: expect.objectContaining({ statusAnchorMessageId: "outbound-1" }),
    });
    expect(sendPresence).toHaveBeenNthCalledWith(5, {
      sessionName: "ravi-hil",
      active: false,
      reason: "terminal-stop",
      target: expect.objectContaining({ sourceMessageId: "inbound-1" }),
    });
    expect(presenceState.activeTargetsBySession.has("ravi-hil")).toBe(false);
  });

  it("clears the source fallback anchor when re-anchoring without local state", async () => {
    const sendPresence = mock(async () => ({
      provider: "slack",
      status: "active" as const,
    }));
    const adapter: NativePresenceDelivery = {
      channelId: "slack",
      supports: (target) => target.channel === "slack",
      sendPresence,
    };
    const presenceState = { activeTargetsBySession: new Map() };

    await processChannelPresenceRequest(
      {
        channelId: "slack",
        sessionName: "ravi-hil",
        active: true,
        reason: "native-delivery-renew",
        timestamp: 1783100001000,
        target: {
          channel: "slack",
          accountId: "ravi-rbbt-slack",
          chatId: "C123",
          sourceMessageId: "inbound-1",
          statusAnchorKind: "last_outbound_message",
          statusAnchorMessageId: "outbound-1",
        },
      },
      { deliveries: [adapter], presenceState },
    );

    expect(sendPresence).toHaveBeenNthCalledWith(1, {
      sessionName: "ravi-hil",
      active: false,
      reason: "native-delivery-renew:replace-anchor",
      target: expect.objectContaining({
        sourceMessageId: "inbound-1",
      }),
    });
    expect(sendPresence).toHaveBeenNthCalledWith(2, {
      sessionName: "ravi-hil",
      active: true,
      reason: "native-delivery-renew",
      target: expect.objectContaining({
        sourceMessageId: "inbound-1",
        statusAnchorMessageId: "outbound-1",
      }),
    });
  });

  it("retries clearing recent session anchors before activating a new source message", async () => {
    const sendPresence = mock(async () => ({
      provider: "slack",
      status: "active" as const,
    }));
    const adapter: NativePresenceDelivery = {
      channelId: "slack",
      supports: (target) => target.channel === "slack",
      sendPresence,
    };
    const presenceState = { activeTargetsBySession: new Map() };

    await processChannelPresenceRequest(
      {
        channelId: "slack",
        sessionName: "ravi-hil",
        active: true,
        reason: "runtime-turn.started",
        timestamp: 1783100000000,
        target: {
          channel: "slack",
          accountId: "ravi-rbbt-slack",
          chatId: "C123",
          sourceMessageId: "inbound-1",
        },
      },
      { deliveries: [adapter], presenceState },
    );

    await processChannelPresenceRequest(
      {
        channelId: "slack",
        sessionName: "ravi-hil",
        active: false,
        reason: "terminal-stop",
        timestamp: 1783100001000,
        target: {
          channel: "slack",
          accountId: "ravi-rbbt-slack",
          chatId: "C123",
          sourceMessageId: "inbound-1",
        },
      },
      { deliveries: [adapter], presenceState },
    );

    await processChannelPresenceRequest(
      {
        channelId: "slack",
        sessionName: "ravi-hil",
        active: true,
        reason: "runtime-turn.started",
        timestamp: 1783100002000,
        target: {
          channel: "slack",
          accountId: "ravi-rbbt-slack",
          chatId: "C123",
          sourceMessageId: "inbound-2",
        },
      },
      { deliveries: [adapter], presenceState },
    );

    expect(sendPresence).toHaveBeenNthCalledWith(1, {
      sessionName: "ravi-hil",
      active: true,
      reason: "runtime-turn.started",
      target: expect.objectContaining({ sourceMessageId: "inbound-1" }),
    });
    expect(sendPresence).toHaveBeenNthCalledWith(2, {
      sessionName: "ravi-hil",
      active: false,
      reason: "terminal-stop",
      target: expect.objectContaining({ sourceMessageId: "inbound-1" }),
    });
    expect(sendPresence).toHaveBeenNthCalledWith(3, {
      sessionName: "ravi-hil",
      active: false,
      reason: "runtime-turn.started:replace-anchor",
      target: expect.objectContaining({ sourceMessageId: "inbound-1" }),
    });
    expect(sendPresence).toHaveBeenNthCalledWith(4, {
      sessionName: "ravi-hil",
      active: true,
      reason: "runtime-turn.started",
      target: expect.objectContaining({ sourceMessageId: "inbound-2" }),
    });
  });

  it("normalizes native presence subjects", () => {
    expect(subjectForChannelPresence("Slack Connect")).toBe("ravi.channel.presence.slack_connect");
    expect(subjectForChannelPresence("")).toBe("ravi.channel.presence.unknown");
  });
});
