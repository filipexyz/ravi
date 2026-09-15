import { describe, expect, it } from "bun:test";
import { createToolLivenessLease, type ToolLivenessSchedule } from "./tool-liveness.js";

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
