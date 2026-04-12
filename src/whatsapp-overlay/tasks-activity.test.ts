import { describe, expect, it } from "bun:test";
import type { TaskStreamTaskEntity } from "../tasks/index.js";
import { buildOverlayTasksDailyActivity } from "./tasks-activity.js";

function toLocalDateKey(value: number): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function atLocalDate(year: number, monthIndex: number, day: number, hour = 12): number {
  return new Date(year, monthIndex, day, hour, 0, 0, 0).getTime();
}

function makeTask(overrides: Partial<TaskStreamTaskEntity>): TaskStreamTaskEntity {
  return {
    id: overrides.id ?? "task-1",
    title: overrides.title ?? "Task",
    instructions: overrides.instructions ?? "Do the work",
    status: overrides.status ?? "open",
    priority: overrides.priority ?? "normal",
    progress: overrides.progress ?? 0,
    profileId: overrides.profileId ?? "default",
    taskProfile:
      overrides.taskProfile ??
      ({
        id: "default",
        version: "1",
        label: "Default",
        description: "Default profile",
        prompt: { mode: "inline", template: "" },
        defaults: {},
        assignment: { mode: "manual" },
        progress: { mode: "manual" },
        templates: {},
        artifacts: [],
        state: [],
        sourceKind: "system",
        source: "test",
      } as unknown as TaskStreamTaskEntity["taskProfile"]),
    checkpointIntervalMs: overrides.checkpointIntervalMs ?? null,
    reportToSessionName: overrides.reportToSessionName ?? null,
    reportEvents: overrides.reportEvents ?? ["done"],
    parentTaskId: overrides.parentTaskId ?? null,
    taskDir: overrides.taskDir ?? null,
    createdBy: overrides.createdBy ?? null,
    createdByAgentId: overrides.createdByAgentId ?? null,
    createdBySessionName: overrides.createdBySessionName ?? null,
    assigneeAgentId: overrides.assigneeAgentId ?? null,
    assigneeSessionName: overrides.assigneeSessionName ?? null,
    workSessionName: overrides.workSessionName ?? null,
    worktree: overrides.worktree ?? null,
    summary: overrides.summary ?? null,
    blockerReason: overrides.blockerReason ?? null,
    archivedAt: overrides.archivedAt ?? null,
    archivedBy: overrides.archivedBy ?? null,
    archiveReason: overrides.archiveReason ?? null,
    createdAt: overrides.createdAt ?? atLocalDate(2026, 3, 1, 9),
    updatedAt: overrides.updatedAt ?? atLocalDate(2026, 3, 1, 9),
    dispatchedAt: overrides.dispatchedAt ?? null,
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    artifacts: overrides.artifacts ?? {
      status: "planned",
      supportedKinds: [],
      workspaceRoot: null,
      items: [],
      primary: null,
    },
  };
}

describe("whatsapp overlay tasks daily activity", () => {
  it("aggregates the last 84 local days by completedAt and highlights done volume", () => {
    const now = atLocalDate(2026, 3, 12, 18);
    const activity = buildOverlayTasksDailyActivity({
      now,
      tasks: [
        makeTask({ id: "done-today", status: "done", completedAt: atLocalDate(2026, 3, 12, 10) }),
        makeTask({ id: "done-yesterday-1", status: "done", completedAt: atLocalDate(2026, 3, 11, 9) }),
        makeTask({ id: "done-yesterday-2", status: "done", completedAt: atLocalDate(2026, 3, 11, 17) }),
        makeTask({ id: "failed-yesterday", status: "failed", completedAt: atLocalDate(2026, 3, 11, 19) }),
        makeTask({ id: "done-before-gap", status: "done", completedAt: atLocalDate(2026, 3, 9, 11) }),
        makeTask({ id: "open-task", status: "open", completedAt: null }),
      ],
    });

    expect(activity.days).toBe(84);
    expect(activity.buckets).toHaveLength(84);
    expect(activity.endDate).toBe(toLocalDateKey(now));
    expect(activity.totalCount).toBe(5);
    expect(activity.totalDoneCount).toBe(4);
    expect(activity.totalFailedCount).toBe(1);
    expect(activity.activeDays).toBe(3);
    expect(activity.maxDoneCount).toBe(2);
    expect(activity.currentStreak).toBe(2);
    expect(activity.bestDay).toMatchObject({
      date: toLocalDateKey(atLocalDate(2026, 3, 11, 12)),
      count: 3,
      doneCount: 2,
      failedCount: 1,
    });

    const yesterday = activity.buckets.find((bucket) => bucket.date === toLocalDateKey(atLocalDate(2026, 3, 11, 12)));
    expect(yesterday).toMatchObject({
      count: 3,
      doneCount: 2,
      failedCount: 1,
    });
  });

  it("keeps the period intact even when there are no done tasks yet", () => {
    const now = atLocalDate(2026, 3, 12, 18);
    const activity = buildOverlayTasksDailyActivity({
      now,
      tasks: [makeTask({ id: "failed-only", status: "failed", completedAt: atLocalDate(2026, 3, 10, 15) })],
    });

    expect(activity.buckets).toHaveLength(84);
    expect(activity.totalCount).toBe(1);
    expect(activity.totalDoneCount).toBe(0);
    expect(activity.totalFailedCount).toBe(1);
    expect(activity.activeDays).toBe(0);
    expect(activity.maxDoneCount).toBe(0);
    expect(activity.currentStreak).toBe(0);
    expect(activity.bestDay).toBeNull();
  });

  it("uses the explicit overlay timezone and local today key instead of UTC day boundaries", () => {
    const activity = buildOverlayTasksDailyActivity({
      now: Date.parse("2026-04-12T12:00:00Z"),
      timeZone: "America/Sao_Paulo",
      todayKey: "2026-04-12",
      tasks: [
        makeTask({ id: "before-midnight-local", status: "done", completedAt: Date.parse("2026-04-12T02:30:00Z") }),
        makeTask({ id: "after-midnight-local", status: "done", completedAt: Date.parse("2026-04-12T03:30:00Z") }),
      ],
    });

    expect(activity.timeZone).toBe("America/Sao_Paulo");
    expect(activity.endDate).toBe("2026-04-12");
    expect(activity.buckets.find((bucket) => bucket.date === "2026-04-11")).toMatchObject({
      count: 1,
      doneCount: 1,
      failedCount: 0,
    });
    expect(activity.buckets.find((bucket) => bucket.date === "2026-04-12")).toMatchObject({
      count: 1,
      doneCount: 1,
      failedCount: 0,
    });
  });
});
