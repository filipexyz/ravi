import { describe, expect, it } from "bun:test";
import {
  resolveChatActionAvailability,
  unavailableChatActionWithoutSurface,
  type ChatActionSurface,
} from "./chat-actions.js";

const slackSurface: ChatActionSurface = {
  id: "chat_slack",
  channel: "slack",
  instanceId: "hana-slack",
  platformChatId: "C123",
  credentialConfigured: true,
  ownMessageCount: 2,
  ownTextMessageCount: 1,
  eligibleStickerCount: 0,
};

describe("resolveChatActionAvailability", () => {
  it("exposes native Slack actions with explicit scopes and execution modes", () => {
    expect(resolveChatActionAvailability(slackSurface, "message.edit")).toMatchObject({
      status: "available",
      executionMode: "durable",
      requiredScopes: ["chat:write"],
      scopeVerification: "deferred",
    });
    expect(resolveChatActionAvailability(slackSurface, "message.react")).toMatchObject({
      status: "available",
      executionMode: "durable",
      requiredScopes: ["reactions:write"],
    });
    expect(resolveChatActionAvailability(slackSurface, "media.send")).toMatchObject({
      status: "available",
      executionMode: "provider_confirmed",
      requiredScopes: ["files:write"],
    });
    expect(resolveChatActionAvailability(slackSurface, "thread.create")).toMatchObject({
      status: "available",
      executionMode: "durable",
      requiredScopes: ["chat:write"],
    });
  });

  it("offers internal close only on an open Slack thread", () => {
    expect(
      resolveChatActionAvailability(
        {
          ...slackSurface,
          id: "chat_thread",
          platformChatId: "C123#1713000000.000100",
          chatType: "thread",
          threadLifecycleStatus: "open",
          credentialConfigured: false,
        },
        "thread.close",
      ),
    ).toMatchObject({
      status: "available",
      executionMode: "internal",
      scopeVerification: "not_required",
    });
    expect(resolveChatActionAvailability(slackSurface, "thread.close")).toMatchObject({
      status: "unavailable",
      unavailableReason: { code: "invalid_target" },
    });
    expect(
      resolveChatActionAvailability(
        { ...slackSurface, chatType: "thread", threadLifecycleStatus: "closed" },
        "thread.close",
      ),
    ).toMatchObject({
      status: "unavailable",
      unavailableReason: { code: "invalid_target" },
    });
  });

  it("keeps thread lifecycle actions Slack-only", () => {
    const whatsapp = {
      ...slackSurface,
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "5511999999999",
    };
    expect(resolveChatActionAvailability(whatsapp, "thread.create")).toMatchObject({
      status: "unavailable",
      unavailableReason: { code: "unsupported_channel" },
    });
    expect(resolveChatActionAvailability(whatsapp, "thread.close")).toMatchObject({
      status: "unavailable",
      unavailableReason: { code: "unsupported_channel" },
    });
  });

  it("fails closed for Slack stickers and missing credentials", () => {
    expect(resolveChatActionAvailability(slackSurface, "sticker.send")).toMatchObject({
      status: "unavailable",
      unavailableReason: { code: "unsupported_channel" },
    });
    expect(
      resolveChatActionAvailability({ ...slackSurface, credentialConfigured: false }, "message.react"),
    ).toMatchObject({
      status: "unavailable",
      unavailableReason: { code: "missing_connection" },
    });
  });

  it("requires an eligible own message for edit and delete", () => {
    expect(resolveChatActionAvailability({ ...slackSurface, ownTextMessageCount: 0 }, "message.edit")).toMatchObject({
      status: "unavailable",
      unavailableReason: { code: "no_eligible_resource" },
    });
    expect(resolveChatActionAvailability({ ...slackSurface, ownMessageCount: 0 }, "message.delete")).toMatchObject({
      status: "unavailable",
      unavailableReason: { code: "no_eligible_resource" },
    });
  });

  it("keeps quoted reply planned and empty surfaces unavailable", () => {
    expect(resolveChatActionAvailability(slackSurface, "message.reply")).toEqual({
      actionId: "message.reply",
      surfaceId: "chat_slack",
      status: "planned",
    });
    expect(unavailableChatActionWithoutSurface("message.react")).toMatchObject({
      status: "unavailable",
      unavailableReason: { code: "no_surface" },
    });
  });
});
