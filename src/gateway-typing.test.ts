import { describe, expect, it } from "bun:test";
import { SessionTypingTracker } from "./gateway-typing.js";

describe("SessionTypingTracker", () => {
  it("suppresses duplicate typing transitions per session", () => {
    const tracker = new SessionTypingTracker();

    expect(tracker.shouldEmit("session-a", true)).toBe(true);
    expect(tracker.shouldEmit("session-a", true)).toBe(false);
    expect(tracker.shouldEmit("session-a", false)).toBe(true);
    expect(tracker.shouldEmit("session-a", false)).toBe(false);
  });

  it("resets state when cleared", () => {
    const tracker = new SessionTypingTracker();

    expect(tracker.shouldEmit("session-a", true)).toBe(true);
    tracker.clear("session-a");
    expect(tracker.shouldEmit("session-a", true)).toBe(true);
  });
});
