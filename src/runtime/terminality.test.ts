import { describe, expect, it } from "bun:test";
import { createRuntimeTerminalEventTracker, isRuntimeTerminalEvent } from "./terminality.js";
import type { RuntimeEvent } from "./types.js";

describe("runtime terminality helpers", () => {
  it("recognizes canonical terminal runtime events", () => {
    const events: RuntimeEvent[] = [
      { type: "turn.complete", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "turn.failed", error: "failed" },
      { type: "turn.interrupted" },
      { type: "assistant.message", text: "not terminal" },
    ];

    expect(events.map((event) => isRuntimeTerminalEvent(event))).toEqual([true, true, true, false]);
  });

  it("allows only one terminal event per accepted provider turn", () => {
    const tracker = createRuntimeTerminalEventTracker();

    expect(tracker.accept({ type: "assistant.message", text: "hello" })).toBe(true);
    expect(tracker.accept({ type: "turn.failed", error: "first" })).toBe(true);
    expect(tracker.terminalEmitted).toBe(true);
    expect(tracker.accept({ type: "turn.interrupted" })).toBe(false);
    expect(tracker.fail({ error: "second" })).toBeNull();
  });

  it("builds fallback terminal events when no native terminal was emitted", () => {
    const tracker = createRuntimeTerminalEventTracker();

    expect(tracker.fail({ error: "stream ended", recoverable: true })).toEqual({
      type: "turn.failed",
      error: "stream ended",
      recoverable: true,
    });
    expect(tracker.interrupt()).toBeNull();
  });
});
