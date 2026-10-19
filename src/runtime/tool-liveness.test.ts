import { describe, expect, it } from "bun:test";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "../approval/timeouts.js";
import {
  APPROVAL_GATED_TOOL_TIMEOUT_MS,
  createApprovalWaitLeaseTracker,
  createToolLivenessLease,
  DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS,
  MAX_DECLARED_TOOL_TIMEOUT_MS,
  resolveDeclaredToolTimeoutMs,
  resolveToolInactivityTimeoutMs,
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

describe("approval-gated tools", () => {
  it("keeps the generic window for ordinary tools", () => {
    expect(resolveToolInactivityTimeoutMs("Bash", {})).toBe(DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS);
    expect(resolveToolInactivityTimeoutMs("Bash", { timeout: 600 })).toBe(750_000);
    expect(resolveToolInactivityTimeoutMs(undefined, {})).toBe(DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS);
  });

  it("outlasts the approval's delivery and answer timeouts", () => {
    expect(APPROVAL_GATED_TOOL_TIMEOUT_MS).toBeGreaterThan(2 * DEFAULT_APPROVAL_TIMEOUT_MS);
    for (const tool of ["ExitPlanMode", "AskUserQuestion", "mcp__spec__exit_spec_mode"]) {
      expect(resolveToolInactivityTimeoutMs(tool, {})).toBe(APPROVAL_GATED_TOOL_TIMEOUT_MS);
    }
  });

  it("lets an unanswered plan approval time out in the hook before the lease recovers the turn", () => {
    const clock = createManualScheduler();
    const inactive: string[] = [];
    const lease = createToolLivenessLease({
      onInactive: (toolUseId) => inactive.push(toolUseId),
      schedule: clock.schedule,
    });

    lease.start("plan-1", resolveToolInactivityTimeoutMs("ExitPlanMode", { plan: "do it" }));
    // Worst case: delivery takes its whole window, then nobody answers.
    clock.advance(2 * DEFAULT_APPROVAL_TIMEOUT_MS);
    expect(inactive).toEqual([]);

    // The hook has denied with "Plano rejeitado: Timeout" by now; tool.ended clears the lease.
    lease.clear();
    clock.advance(APPROVAL_GATED_TOOL_TIMEOUT_MS);
    expect(inactive).toEqual([]);
  });

  it("still recovers a gated tool that never returns", () => {
    const clock = createManualScheduler();
    const inactive: string[] = [];
    const lease = createToolLivenessLease({
      onInactive: (toolUseId) => inactive.push(toolUseId),
      schedule: clock.schedule,
    });

    lease.start("plan-1", resolveToolInactivityTimeoutMs("ExitPlanMode", {}));
    clock.advance(APPROVAL_GATED_TOOL_TIMEOUT_MS);
    expect(inactive).toEqual(["plan-1"]);
  });
});

describe("approval wait lease tracker", () => {
  it("keeps a Bash call alive while its permission card waits, then gives it its window back", () => {
    const scheduler = createManualScheduler();
    const inactive: string[] = [];
    const lease = createToolLivenessLease({
      onInactive: (toolUseId) => inactive.push(toolUseId),
      schedule: scheduler.schedule,
    });
    const tracker = createApprovalWaitLeaseTracker({
      lease,
      currentTool: () => ({ id: "bash-1", name: "Bash", input: { command: "curl example.com" } }),
    });

    lease.start("bash-1");
    tracker.begin();
    // The approval waits its full window: the generic window alone would have expired.
    scheduler.advance(DEFAULT_APPROVAL_TIMEOUT_MS + 1_000);
    expect(inactive).toEqual([]);

    tracker.end();
    scheduler.advance(DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS - 1);
    expect(inactive).toEqual([]);
    scheduler.advance(1);
    expect(inactive).toEqual(["bash-1"]);
  });

  it("gives a tool that starts during an approval the approval window", () => {
    const tracker = createApprovalWaitLeaseTracker({
      lease: { start: () => {} },
      currentTool: () => undefined,
    });
    expect(tracker.timeoutForStartingTool(DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS)).toBe(DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS);
    tracker.begin();
    expect(tracker.timeoutForStartingTool(DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS)).toBe(APPROVAL_GATED_TOOL_TIMEOUT_MS);
    tracker.end();
    tracker.end();
    expect(tracker.timeoutForStartingTool(DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS)).toBe(DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS);
  });
});
