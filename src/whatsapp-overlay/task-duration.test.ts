import { describe, expect, it } from "bun:test";

declare global {
  var RaviWaOverlayTaskDuration:
    | {
        getTaskDurationMs(task: Record<string, unknown> | null | undefined, now?: number): number | null;
      }
    | undefined;
}

await import("../../extensions/whatsapp-overlay/task-duration.js");

function getTaskDurationMs(task: Record<string, unknown>, now: number): number | null {
  return globalThis.RaviWaOverlayTaskDuration?.getTaskDurationMs(task, now) ?? null;
}

describe("whatsapp overlay task duration", () => {
  it("measures queued tasks from dispatchedAt instead of waiting for startedAt", () => {
    expect(
      getTaskDurationMs(
        {
          status: "dispatched",
          createdAt: 1_000,
          dispatchedAt: 2_000,
          startedAt: 5_000,
        },
        11_000,
      ),
    ).toBe(9_000);
  });

  it("falls back to createdAt for in-progress tasks when dispatchedAt is missing", () => {
    expect(
      getTaskDurationMs(
        {
          status: "in_progress",
          createdAt: 1_500,
          startedAt: 4_000,
          updatedAt: 6_000,
        },
        9_500,
      ),
    ).toBe(8_000);
  });

  it("keeps completedAt or updatedAt as the terminal end for done and failed tasks", () => {
    expect(
      getTaskDurationMs(
        {
          status: "done",
          createdAt: 1_000,
          dispatchedAt: 2_000,
          startedAt: 4_000,
          completedAt: 7_000,
          updatedAt: 8_500,
        },
        20_000,
      ),
    ).toBe(5_000);

    expect(
      getTaskDurationMs(
        {
          status: "failed",
          createdAt: 1_000,
          dispatchedAt: 3_000,
          updatedAt: 9_000,
        },
        20_000,
      ),
    ).toBe(6_000);
  });
});
