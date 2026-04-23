import { describe, expect, it } from "bun:test";
import { ensureOverlayAssistantMessageId, resolveOverlayAssistantMessageSlotKey } from "./live-assistant.js";

describe("whatsapp overlay live assistant threading", () => {
  it("uses the runtime item id as the assistant message slot key", () => {
    expect(resolveOverlayAssistantMessageSlotKey({ item: { id: "msg_123" } })).toBe("item:msg_123");
  });

  it("falls back to the default assistant slot when no runtime item id exists", () => {
    expect(resolveOverlayAssistantMessageSlotKey()).toBe("default");
    expect(resolveOverlayAssistantMessageSlotKey({ thread: { id: "thread_1" } })).toBe("default");
  });

  it("keeps the same live assistant message id for the same runtime item", () => {
    const activeIdsByKey: Record<string, string> = {};
    const first = ensureOverlayAssistantMessageId(activeIdsByKey, 1_000, { item: { id: "msg_alpha" } });
    const second = ensureOverlayAssistantMessageId(activeIdsByKey, 2_000, { item: { id: "msg_alpha" } });

    expect(first).toBe("live:assistant:item:msg_alpha");
    expect(second).toBe(first);
  });

  it("creates different live assistant message ids for different runtime items in the same turn", () => {
    const activeIdsByKey: Record<string, string> = {};
    const first = ensureOverlayAssistantMessageId(activeIdsByKey, 1_000, { item: { id: "msg_alpha" } });
    const second = ensureOverlayAssistantMessageId(activeIdsByKey, 1_500, { item: { id: "msg_beta" } });

    expect(first).toBe("live:assistant:item:msg_alpha");
    expect(second).toBe("live:assistant:item:msg_beta");
    expect(second).not.toBe(first);
  });
});
