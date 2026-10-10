import { describe, expect, it } from "bun:test";

import { buildTurnReplyTarget, readTurnReplyTarget, TURN_REPLY_TARGET_METADATA_KEY } from "./turn-reply-target.js";

describe("turn reply target", () => {
  it("records a suppressed turn as posting nowhere, whatever chat it had", () => {
    expect(buildTurnReplyTarget({ suppressed: true, target: { channel: "whatsapp", chatId: "1@g.us" } })).toEqual({
      kind: "none",
    });
  });

  it("records the bound chat, or unresolved when there is none yet", () => {
    expect(
      buildTurnReplyTarget({
        suppressed: false,
        target: { channel: "whatsapp", chatId: " 1@g.us ", canonicalChatId: "chat_1", instanceId: "" },
      }),
    ).toEqual({ kind: "chat", channel: "whatsapp", chatId: "1@g.us", canonicalChatId: "chat_1" });
    expect(buildTurnReplyTarget({ suppressed: false, target: null })).toEqual({ kind: "unresolved" });
    expect(buildTurnReplyTarget({ suppressed: false, target: { channel: "whatsapp", chatId: "" } })).toEqual({
      kind: "unresolved",
    });
  });

  it("reads it back from context metadata, and nothing for a missing or malformed value", () => {
    const chat = { kind: "chat" as const, channel: "whatsapp", chatId: "1@g.us" };
    expect(readTurnReplyTarget({ [TURN_REPLY_TARGET_METADATA_KEY]: chat })).toEqual(chat);
    expect(readTurnReplyTarget({ [TURN_REPLY_TARGET_METADATA_KEY]: { kind: "none" } })).toEqual({ kind: "none" });
    for (const value of [undefined, "none", [], { kind: "chat", channel: "whatsapp" }, { kind: "other" }]) {
      expect(readTurnReplyTarget({ [TURN_REPLY_TARGET_METADATA_KEY]: value })).toBeNull();
    }
    expect(readTurnReplyTarget(null)).toBeNull();
  });
});
