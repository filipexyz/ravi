import { describe, expect, it, mock } from "bun:test";
import type { NativeInboundChannelActionRequest, NativeInboundChannelActionResult } from "../channels/native/driver.js";
import type { RouterConfig } from "../router/types.js";
import { handleSlashCommand } from "./registry.js";

function input(text: string) {
  return {
    text,
    messageId: "message-a",
    senderId: "sender-a",
    senderName: "Sender",
    chatId: "conversation-a",
    isGroup: false,
    channelType: "example",
    accountId: "account-a",
    routerConfig: {} as RouterConfig,
    send: mock(async () => {}),
  };
}

function handled(
  request: NativeInboundChannelActionRequest,
  text = "Continue in the browser.",
): NativeInboundChannelActionResult {
  return {
    protocol: request.protocol,
    schemaVersion: request.schemaVersion,
    requestId: request.requestId,
    disposition: "handled",
    text,
    completedAt: "2026-07-24T18:00:02.000Z",
  };
}

describe("native inbound slash actions", () => {
  it("intercepts a declared action before model processing without forwarding arguments", async () => {
    const handleInput = input("/account.connect never-forward-this");
    const requester = mock(async (request: NativeInboundChannelActionRequest) => handled(request));

    await expect(
      handleSlashCommand(handleInput, {
        nativeInboundActions: new Set(["account.connect"]),
        requestNativeInboundAction: requester,
      }),
    ).resolves.toBe(true);

    expect(requester).toHaveBeenCalledTimes(1);
    const request = requester.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      action: "account.connect",
      hasArguments: true,
      identity: {
        channelKind: "example",
        accountId: "account-a",
        conversationId: "conversation-a",
        senderId: "sender-a",
        messageId: "message-a",
      },
    });
    expect(JSON.stringify(request)).not.toContain("never-forward-this");
    expect(handleInput.send).toHaveBeenCalledWith("account-a", "conversation-a", "Continue in the browser.");
  });

  it("fails closed when the declared action runtime is unavailable", async () => {
    const handleInput = input("/account.connect");

    await expect(
      handleSlashCommand(handleInput, {
        nativeInboundActions: new Set(["account.connect"]),
        requestNativeInboundAction: async () => null,
      }),
    ).resolves.toBe(true);

    expect(handleInput.send).toHaveBeenCalledWith(
      "account-a",
      "conversation-a",
      "⚠️ /account.connect is temporarily unavailable.",
    );
  });

  it("allows undeclared commands to continue through normal processing", async () => {
    const handleInput = input("/unknown");
    const requester = mock(async (request: NativeInboundChannelActionRequest) => handled(request));

    await expect(
      handleSlashCommand(handleInput, {
        nativeInboundActions: new Set(["account.connect"]),
        requestNativeInboundAction: requester,
      }),
    ).resolves.toBe(false);
    expect(requester).not.toHaveBeenCalled();
    expect(handleInput.send).not.toHaveBeenCalled();
  });
});
