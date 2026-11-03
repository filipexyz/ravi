import { describe, expect, test } from "bun:test";

import { mentionsAgent, shouldAgentReply } from "./reply-policy";

const base = { roomKind: "shared" as const, replyPolicy: "mention" as const, assistantName: "Lúcia", text: "", isAction: false, humanAuthorCount: 2 };

describe("Page chat reply policy", () => {
  test("a private room and the always policy always get an answer", () => {
    expect(shouldAgentReply({ ...base, roomKind: "private", text: "oi" })).toBe(true);
    expect(shouldAgentReply({ ...base, replyPolicy: "always", text: "oi" })).toBe(true);
  });

  test("a shared room answers one person alone, a mention or a click, and otherwise stays quiet", () => {
    expect(shouldAgentReply({ ...base, humanAuthorCount: 1, text: "oi" })).toBe(true);
    expect(shouldAgentReply({ ...base, text: "Bruno, olha isso" })).toBe(false);
    expect(shouldAgentReply({ ...base, text: "@ravi resume?" })).toBe(true);
    expect(shouldAgentReply({ ...base, isAction: true })).toBe(true);
  });

  test("a mention ignores case and accents and must be a whole word", () => {
    expect(mentionsAgent("@LUCIA pode ver?", "Lúcia")).toBe(true);
    expect(mentionsAgent("oi @Ravi.", "Lúcia")).toBe(true);
    expect(mentionsAgent("email ravi@acme.test", "Lúcia")).toBe(false);
    expect(mentionsAgent("@ravizinho", "Lúcia")).toBe(false);
    expect(mentionsAgent("@Ana Paula veja", "Ana Paula")).toBe(true);
  });
});
