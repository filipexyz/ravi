import { describe, expect, it } from "bun:test";
import { isApprovalReactionEmoji, normalizeReactionEmoji } from "./reaction-emoji.js";

describe("normalizeReactionEmoji", () => {
  it("maps Slack approval short names to unicode", () => {
    expect(normalizeReactionEmoji("+1")).toBe("👍");
    expect(normalizeReactionEmoji(":thumbsup:")).toBe("👍");
    expect(normalizeReactionEmoji("+1::skin-tone-2")).toBe("👍");
    expect(normalizeReactionEmoji("THUMBS_UP")).toBe("👍");
    expect(normalizeReactionEmoji("heart")).toBe("❤️");
    expect(normalizeReactionEmoji(":red_heart:")).toBe("❤️");
    expect(normalizeReactionEmoji("heavy_black_heart")).toBe("❤");
  });

  it("keeps unicode approval emojis stable, including skin-tone thumbs", () => {
    expect(normalizeReactionEmoji("👍")).toBe("👍");
    expect(normalizeReactionEmoji("👍🏻")).toBe("👍");
    expect(normalizeReactionEmoji("❤️")).toBe("❤️");
    expect(normalizeReactionEmoji("❤")).toBe("❤");
  });

  it("returns cleaned Slack names for unknown reactions", () => {
    expect(normalizeReactionEmoji(":eyes:")).toBe("eyes");
    expect(normalizeReactionEmoji("hourglass_flowing_sand")).toBe("hourglass_flowing_sand");
  });
});

describe("isApprovalReactionEmoji", () => {
  it("accepts unicode and Slack names for thumbs-up and heart", () => {
    expect(isApprovalReactionEmoji("👍")).toBe(true);
    expect(isApprovalReactionEmoji("❤️")).toBe(true);
    expect(isApprovalReactionEmoji("❤")).toBe(true);
    expect(isApprovalReactionEmoji("+1")).toBe(true);
    expect(isApprovalReactionEmoji("thumbsup")).toBe(true);
    expect(isApprovalReactionEmoji("heart")).toBe(true);
  });

  it("rejects empty values and unrelated emoji", () => {
    expect(isApprovalReactionEmoji(undefined)).toBe(false);
    expect(isApprovalReactionEmoji("")).toBe(false);
    expect(isApprovalReactionEmoji("👀")).toBe(false);
    expect(isApprovalReactionEmoji("eyes")).toBe(false);
    expect(isApprovalReactionEmoji("-1")).toBe(false);
  });
});
