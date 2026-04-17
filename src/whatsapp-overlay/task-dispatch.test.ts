import { describe, expect, it } from "bun:test";
import type { TaskStreamSelection, TaskStreamTaskEntity } from "../tasks/index.js";
import { buildOverlayTaskDispatchState, resolveOverlayTaskDefaultSessionName } from "./task-dispatch.js";

function makeTask(overrides: Partial<TaskStreamTaskEntity> = {}): TaskStreamTaskEntity {
  const readiness =
    overrides.readiness ??
    ({
      state: "ready",
      label: "ready to start",
      canStart: true,
      dependencyCount: 0,
      satisfiedDependencyCount: 0,
      unsatisfiedDependencyCount: 0,
      unsatisfiedDependencyIds: [],
      hasLaunchPlan: false,
    } as TaskStreamTaskEntity["readiness"]);
  return {
    id: overrides.id ?? "task-1",
    title: overrides.title ?? "Task",
    instructions: overrides.instructions ?? "Ship it",
    status: overrides.status ?? "open",
    visualStatus: overrides.visualStatus ?? overrides.status ?? "open",
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
        sync: {},
        sessionNameTemplate: "<task-id>-work",
        workspaceBootstrap: { mode: "inherit", ensureTaskDir: true },
        rendererHints: {},
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
    createdAt: overrides.createdAt ?? 1_000,
    updatedAt: overrides.updatedAt ?? 1_000,
    dispatchedAt: overrides.dispatchedAt ?? null,
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    readiness,
    launchPlan: overrides.launchPlan ?? null,
    dependencyCount: overrides.dependencyCount ?? readiness.dependencyCount,
    satisfiedDependencyCount: overrides.satisfiedDependencyCount ?? readiness.satisfiedDependencyCount,
    unsatisfiedDependencyCount: overrides.unsatisfiedDependencyCount ?? readiness.unsatisfiedDependencyCount,
    workflow: overrides.workflow ?? null,
    project: overrides.project ?? null,
    artifacts: overrides.artifacts ?? {
      status: "planned",
      supportedKinds: [],
      workspaceRoot: null,
      items: [],
      primary: null,
    },
  };
}

function makeSelection(
  overrides: { task?: Partial<TaskStreamTaskEntity>; activeAssignment?: TaskStreamSelection["activeAssignment"] } = {},
): TaskStreamSelection {
  return {
    task: makeTask(overrides.task),
    parentTask: null,
    childTasks: [],
    dependencies: [],
    dependents: [],
    launchPlan: overrides.task?.launchPlan ?? null,
    readiness:
      overrides.task?.readiness ??
      ({
        state: "ready",
        label: "ready to start",
        canStart: true,
        dependencyCount: 0,
        satisfiedDependencyCount: 0,
        unsatisfiedDependencyCount: 0,
        unsatisfiedDependencyIds: [],
        hasLaunchPlan: false,
      } as TaskStreamSelection["readiness"]),
    activeAssignment: overrides.activeAssignment ?? null,
    assignments: [],
    events: [],
    comments: [],
  };
}

describe("whatsapp overlay task dispatch", () => {
  it("uses the profile session template for the default dispatch session name", () => {
    expect(resolveOverlayTaskDefaultSessionName(makeTask({ id: "task-abc" }))).toBe("task-abc-work");
  });

  it("allows dispatch for open tasks without an active assignment", () => {
    expect(
      buildOverlayTaskDispatchState(makeSelection(), {
        actorSessionName: "ops-hub",
        actorAgentId: "ops",
        availableSessions: [{ sessionName: "ops-hub", agentId: "ops" }],
      }),
    ).toEqual({
      allowed: true,
      reason: null,
      defaultSessionName: "task-1-work",
      defaultAgentId: "ops",
      defaultReportToSessionName: "ops-hub",
    });
  });

  it("blocks dispatch for already assigned or queued tasks", () => {
    expect(
      buildOverlayTaskDispatchState(
        makeSelection({
          task: { assigneeAgentId: "main", assigneeSessionName: "task-1-work" },
        }),
      ),
    ).toMatchObject({
      allowed: false,
      reason: "assigned",
      defaultSessionName: "task-1-work",
      defaultAgentId: "main",
    });

    expect(
      buildOverlayTaskDispatchState(
        makeSelection({
          task: { status: "dispatched" },
        }),
      ),
    ).toMatchObject({
      allowed: false,
      reason: "not_open",
      defaultSessionName: "task-1-work",
    });
  });

  it("prefers an explicit report target and the matching default work session", () => {
    expect(
      buildOverlayTaskDispatchState(
        makeSelection({
          task: {
            reportToSessionName: "lead-room",
          },
        }),
        {
          actorSessionName: "ops-hub",
          actorAgentId: "ops",
          availableSessions: [
            { sessionName: "task-1-work", agentId: "worker" },
            { sessionName: "lead-room", agentId: "lead" },
          ],
        },
      ),
    ).toEqual({
      allowed: true,
      reason: null,
      defaultSessionName: "task-1-work",
      defaultAgentId: "worker",
      defaultReportToSessionName: "lead-room",
    });
  });
});
