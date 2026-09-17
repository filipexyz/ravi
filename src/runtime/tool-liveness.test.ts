import { describe, expect, it } from "bun:test";
import {
  createToolLivenessLease,
  DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS,
  MAX_DECLARED_TOOL_TIMEOUT_MS,
  resolveDeclaredToolTimeoutMs,
  type ToolLivenessSchedule,
} from "./tool-liveness.js";

interface ScheduledCallback {
  at: number;
  callback: () => void;
  cancelled: boolean;
}

function createManualScheduler() {
  let now = 0;
  const callbacks: ScheduledCallback[] = [];
  const schedule: ToolLivenessSchedule = (callback, delayMs) => {
    const scheduled = { at: now + delayMs, callback, cancelled: false };
    callbacks.push(scheduled);
    return () => {
      scheduled.cancelled = true;
    };
  };
  const advance = (durationMs: number) => {
    const target = now + durationMs;
    while (true) {
      const next = callbacks
        .filter((scheduled) => !scheduled.cancelled && scheduled.at <= target)
        .sort((left, right) => left.at - right.at)[0];
      if (!next) break;
      next.cancelled = true;
      now = next.at;
      next.callback();
    }
    now = target;
  };
  return { advance, schedule };
}

describe("declared tool timeout", () => {
  it("honors the timeout a tool declares, with margin", () => {
    expect(resolveDeclaredToolTimeoutMs({ timeout: 300 })).toBe(375_000);
    // Declared timeouts below the generic window are raised to it, never lowered.
    expect(resolveDeclaredToolTimeoutMs({ timeout: "120" })).toBe(DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS);
  });

  it("falls back when the tool declares nothing usable", () => {
    expect(resolveDeclaredToolTimeoutMs({})).toBe(DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS);
    expect(resolveDeclaredToolTimeoutMs({ timeout: 0 })).toBe(DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS);
    expect(resolveDeclaredToolTimeoutMs({ timeout: "soon" })).toBe(DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS);
    expect(resolveDeclaredToolTimeoutMs(undefined)).toBe(DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS);
  });

  it("never shortens the default window below the generic one", () => {
    expect(resolveDeclaredToolTimeoutMs({ timeout: 10 })).toBe(DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS);
  });

  it("clamps to the ceiling so one call cannot park the session forever", () => {
    expect(resolveDeclaredToolTimeoutMs({ timeout: 24 * 60 * 60 })).toBe(MAX_DECLARED_TOOL_TIMEOUT_MS);
  });
});

describe("tool liveness lease", () => {
  it("keeps a long-running tool alive while matching progress continues", () => {
    const clock = createManualScheduler();
    const inactive: string[] = [];
    const lease = createToolLivenessLease({
      inactivityTimeoutMs: 5 * 60_000,
      onInactive: (toolUseId) => inactive.push(toolUseId),
      schedule: clock.schedule,
    });

    lease.start("tool-1");
    clock.advance(4 * 60_000);
    expect(lease.progress("tool-1")).toBe(true);
    clock.advance(4 * 60_000);
    expect(lease.progress("tool-1")).toBe(true);
    clock.advance(4 * 60_000);

    expect(inactive).toEqual([]);
    clock.advance(60_000);
    expect(inactive).toEqual(["tool-1"]);
  });

  it("does not renew one tool from another tool's progress", () => {
    const clock = createManualScheduler();
    const inactive: string[] = [];
    const lease = createToolLivenessLease({
      inactivityTimeoutMs: 100,
      onInactive: (toolUseId) => inactive.push(toolUseId),
      schedule: clock.schedule,
    });

    lease.start("tool-1");
    clock.advance(90);
    expect(lease.progress("tool-2")).toBe(false);
    clock.advance(10);

    expect(inactive).toEqual(["tool-1"]);
  });

  it("honors a timeout declared for the specific tool", () => {
    const clock = createManualScheduler();
    const inactive: Array<{ id: string; timeoutMs: number }> = [];
    const lease = createToolLivenessLease({
      inactivityTimeoutMs: 5 * 60_000,
      onInactive: (toolUseId, timeoutMs) => inactive.push({ id: toolUseId, timeoutMs }),
      schedule: clock.schedule,
    });

    // The caller declared 20 minutes for this one: the generic 5 minute window
    // must not fire first, and the reported timeout must be the effective one.
    lease.start("tool-long", 20 * 60_000);
    clock.advance(19 * 60_000);
    expect(inactive).toEqual([]);

    clock.advance(60_000);
    expect(inactive).toEqual([{ id: "tool-long", timeoutMs: 20 * 60_000 }]);
  });

  it("falls back to the lease default when a declared timeout is unusable", () => {
    const clock = createManualScheduler();
    const inactive: Array<{ id: string; timeoutMs: number }> = [];
    const lease = createToolLivenessLease({
      inactivityTimeoutMs: 100,
      onInactive: (toolUseId, timeoutMs) => inactive.push({ id: toolUseId, timeoutMs }),
      schedule: clock.schedule,
    });

    lease.start("tool-1", 0);
    clock.advance(100);

    expect(inactive).toEqual([{ id: "tool-1", timeoutMs: 100 }]);
  });

  it("cancels the inactivity deadline when the tool completes", () => {
    const clock = createManualScheduler();
    const inactive: string[] = [];
    const lease = createToolLivenessLease({
      inactivityTimeoutMs: 100,
      onInactive: (toolUseId) => inactive.push(toolUseId),
      schedule: clock.schedule,
    });

    lease.start("tool-1");
    clock.advance(90);
    lease.clear();
    clock.advance(100);

    expect(inactive).toEqual([]);
  });
});
