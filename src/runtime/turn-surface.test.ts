import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { configStore } from "../config-store.js";
import { isSameRuntimeTurnSurface } from "./turn-surface.js";

const canonical = {
  channel: "whatsapp",
  accountId: "test-account",
  instanceId: "test-instance",
  chatId: "test-group@g.us",
  canonicalChatId: "chat-test",
};
const transport = { channel: canonical.channel, accountId: canonical.accountId, chatId: canonical.chatId };

describe("runtime turn surface identity", () => {
  let resolve: ReturnType<typeof spyOn>;
  beforeEach(() => {
    resolve = spyOn(configStore, "resolveInstanceId").mockImplementation((account) =>
      account === "test-account" || account === "test-instance" ? "test-instance" : undefined,
    );
  });
  afterEach(() => resolve.mockRestore());
  it("resolves channel and account aliases for attached CLI output", () => {
    expect(
      isSameRuntimeTurnSurface(
        { ...canonical, accountId: "test-instance" },
        { ...transport, channel: "whatsapp-baileys" },
      ),
    ).toBe(true);
  });
  it("matches transport-only and canonical sources in either direction", () => {
    expect(isSameRuntimeTurnSurface(canonical, transport)).toBe(true);
    expect(isSameRuntimeTurnSurface(transport, canonical)).toBe(true);
  });
  for (const change of [
    { accountId: "other-account" },
    { instanceId: "other-instance" },
    { channel: "slack" },
    { chatId: "other-group@g.us" },
    { threadId: "other-thread" },
    { canonicalChatId: "other-canonical" },
  ]) {
    it(`rejects conflicting identity ${JSON.stringify(change)}`, () => {
      expect(isSameRuntimeTurnSurface(canonical, { ...transport, ...change })).toBe(false);
    });
  }
  it("does not match missing sources or incomplete transport identity to a chat", () => {
    expect(isSameRuntimeTurnSurface(canonical, undefined)).toBe(false);
    expect(isSameRuntimeTurnSurface(undefined, undefined)).toBe(true);
    expect(isSameRuntimeTurnSurface({ ...transport, accountId: "" }, { ...transport, accountId: "" })).toBe(false);
  });
});
