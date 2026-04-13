import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  dbAddTaskComment,
  dbArchiveTask,
  dbBlockTask,
  dbCompleteTask,
  dbCreateTask,
  dbHasActiveTaskForSession,
  dbResolveActiveTaskBindingForSession,
  dbDeleteTask,
  dbDispatchTask,
  dbGetActiveAssignment,
  dbGetTask,
  dbSetTaskDir,
  dbListChildTasks,
  dbListTasks,
  dbListTaskComments,
  dbListTaskEvents,
  dbRegisterTaskCheckpointMiss,
  dbReportTaskProgress,
  dbUnarchiveTask,
} from "./task-db.js";

const createdTaskIds: string[] = [];
let stateDir: string | null = null;

setDefaultTimeout(20_000);

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-task-db-test-");
});

afterEach(async () => {
  while (createdTaskIds.length > 0) {
    const id = createdTaskIds.pop();
    if (id) dbDeleteTask(id);
  }
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("task-db", () => {
  it("tracks a minimal task lifecycle", () => {
    const created = dbCreateTask({
      title: "Task DB Smoke",
      instructions: "Validate create -> dispatch -> report -> done",
      createdBy: "test",
      createdByAgentId: "main",
      createdBySessionName: "dev",
    });
    createdTaskIds.push(created.task.id);

    expect(created.task.status).toBe("open");
    expect(created.event.type).toBe("task.created");
    expect(created.task.profileId).toBe("default");
    expect(created.task.createdByAgentId).toBe("main");
    expect(created.task.createdBySessionName).toBe("dev");
    expect(created.task.reportToSessionName).toBe("dev");
    expect(created.task.reportEvents).toEqual(["done"]);

    const dispatched = dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });
    expect(dispatched.task.status).toBe("dispatched");
    expect(dispatched.assignment.agentId).toBe("dev");
    expect(dispatched.assignment.checkpointIntervalMs).toBe(300000);
    expect(dispatched.assignment.checkpointOverdueCount).toBe(0);
    expect(dispatched.assignment.checkpointDueAt).toBeGreaterThan(dispatched.assignment.assignedAt);
    expect(dispatched.assignment.reportToSessionName).toBe("dev");
    expect(dispatched.assignment.reportEvents).toEqual(["done"]);
    expect(dbGetActiveAssignment(created.task.id)?.sessionName).toBe(`${created.task.id}-work`);

    const progressed = dbReportTaskProgress(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "investigando o fluxo principal da task",
      progress: 35,
    });
    expect(progressed.task.status).toBe("in_progress");
    expect(progressed.task.progress).toBe(35);

    const completed = dbCompleteTask(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "done",
    });
    expect(completed.task.status).toBe("done");
    expect(completed.task.progress).toBe(100);
    expect(dbGetTask(created.task.id)?.summary).toBe("done");

    const eventTypes = dbListTaskEvents(created.task.id).map((event) => event.type);
    expect(eventTypes).toEqual(["task.created", "task.dispatched", "task.progress", "task.done"]);
  });

  it("resolves the active task binding for a dispatched session", () => {
    const created = dbCreateTask({
      title: "Resolve active task binding",
      instructions: "Bind the active assignment back to the session env",
      createdBy: "test",
      parentTaskId: "task-parent-1",
    });
    createdTaskIds.push(created.task.id);

    const sessionName = `${created.task.id}-work`;
    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName,
      assignedBy: "test",
      worktree: {
        mode: "path",
        path: `/tmp/${created.task.id}`,
      },
    });

    expect(dbResolveActiveTaskBindingForSession(sessionName)).toEqual({
      task: expect.objectContaining({
        id: created.task.id,
        parentTaskId: "task-parent-1",
        assigneeSessionName: sessionName,
      }),
      assignment: expect.objectContaining({
        taskId: created.task.id,
        agentId: "dev",
        sessionName,
        worktree: {
          mode: "path",
          path: `/tmp/${created.task.id}`,
        },
      }),
    });
    expect(dbResolveActiveTaskBindingForSession(sessionName, created.task.id)?.task.id).toBe(created.task.id);
  });

  it("does not guess a current task when a session has multiple active assignments", () => {
    const sessionName = "shared-runtime-session";
    const first = dbCreateTask({
      title: "Shared session A",
      instructions: "Keep the session ambiguous",
      createdBy: "test",
    });
    const second = dbCreateTask({
      title: "Shared session B",
      instructions: "Keep the session ambiguous",
      createdBy: "test",
    });
    createdTaskIds.push(first.task.id, second.task.id);

    dbDispatchTask(first.task.id, {
      agentId: "dev",
      sessionName,
      assignedBy: "test",
    });
    dbDispatchTask(second.task.id, {
      agentId: "dev",
      sessionName,
      assignedBy: "test",
    });

    expect(dbResolveActiveTaskBindingForSession(sessionName)).toBeNull();
    expect(dbResolveActiveTaskBindingForSession(sessionName, second.task.id)?.task.id).toBe(second.task.id);
  });

  it("archives and restores visibility without changing execution status", () => {
    const created = dbCreateTask({
      title: "Archive visibility smoke",
      instructions: "Archive should be orthogonal to execution status",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });
    dbReportTaskProgress(created.task.id, {
      actor: "worker",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "investigando o core de tasks",
      progress: 40,
    });

    const archived = dbArchiveTask(created.task.id, {
      actor: "operator",
      reason: "tirar backlog antigo da lista default",
    });

    expect(archived.task.status).toBe("in_progress");
    expect(archived.task.progress).toBe(40);
    expect(archived.task.archivedAt).toBeDefined();
    expect(archived.task.archivedBy).toBe("operator");
    expect(archived.task.archiveReason).toBe("tirar backlog antigo da lista default");
    expect(dbGetActiveAssignment(created.task.id)?.status).toBe("accepted");
    expect(dbListTasks({ archiveMode: "exclude" }).map((task) => task.id)).not.toContain(created.task.id);
    expect(dbListTasks({ archiveMode: "only" }).map((task) => task.id)).toContain(created.task.id);
    expect(dbListTasks({ archiveMode: "include" }).map((task) => task.id)).toContain(created.task.id);

    const unarchived = dbUnarchiveTask(created.task.id, {
      actor: "operator",
    });

    expect(unarchived.task.status).toBe("in_progress");
    expect(unarchived.task.archivedAt).toBeUndefined();
    expect(unarchived.task.archivedBy).toBeUndefined();
    expect(unarchived.task.archiveReason).toBeUndefined();
    expect(dbListTasks({ archiveMode: "exclude" }).map((task) => task.id)).toContain(created.task.id);
    expect(dbListTaskEvents(created.task.id).map((event) => event.type)).toEqual([
      "task.created",
      "task.dispatched",
      "task.progress",
      "task.archived",
      "task.unarchived",
    ]);
  });

  it("persists an explicit task profile on create", () => {
    const created = dbCreateTask({
      title: "Task profile persistence",
      instructions: "Persist the selected task profile in the row",
      createdBy: "test",
      profileId: "task-doc-none",
      profileInput: {
        flavor: "matcha",
      },
    });
    createdTaskIds.push(created.task.id);

    expect(created.task.profileId).toBe("task-doc-none");
    expect(created.task.profileInput).toEqual({
      flavor: "matcha",
    });
    expect(dbGetTask(created.task.id)?.profileId).toBe("task-doc-none");
    expect(dbGetTask(created.task.id)?.profileInput).toEqual({
      flavor: "matcha",
    });
  });

  it("filters tasks by profile, text, lineage, assignee, and limit", () => {
    const root = dbCreateTask({
      title: "Pipeline root",
      instructions: "Track the main pipeline work",
      createdBy: "test",
    });
    const child = dbCreateTask({
      title: "Pipeline child",
      instructions: "Investigate the child branch of the pipeline",
      createdBy: "test",
      parentTaskId: root.task.id,
      profileId: "brainstorm",
    });
    const grandchild = dbCreateTask({
      title: "Pipeline grandchild",
      instructions: "Follow the nested pipeline branch",
      createdBy: "test",
      parentTaskId: child.task.id,
      profileId: "brainstorm",
    });
    const otherRoot = dbCreateTask({
      title: "WhatsApp ergonomics",
      instructions: "Inspect another operational surface",
      createdBy: "test",
      profileId: "task-doc-none",
    });
    createdTaskIds.push(root.task.id, child.task.id, grandchild.task.id, otherRoot.task.id);

    dbDispatchTask(child.task.id, {
      agentId: "dev",
      sessionName: `${child.task.id}-work`,
      assignedBy: "test",
    });
    dbReportTaskProgress(child.task.id, {
      actor: "worker",
      agentId: "dev",
      sessionName: `${child.task.id}-work`,
      message: "Investigando a pipeline principal",
      progress: 45,
    });

    dbDispatchTask(grandchild.task.id, {
      agentId: "qa",
      sessionName: `${grandchild.task.id}-work`,
      assignedBy: "test",
    });
    dbReportTaskProgress(grandchild.task.id, {
      actor: "worker",
      agentId: "qa",
      sessionName: `${grandchild.task.id}-work`,
      message: "Detalhando a pipeline derivada",
      progress: 25,
    });

    expect(dbListTasks({ profileId: "task-doc-none" }).map((task) => task.id)).toEqual([otherRoot.task.id]);
    expect(dbListTasks({ parentTaskId: root.task.id }).map((task) => task.id)).toEqual([child.task.id]);
    expect(dbListTasks({ rootTaskId: root.task.id }).map((task) => task.id)).toEqual(
      expect.arrayContaining([root.task.id, child.task.id, grandchild.task.id]),
    );
    expect(dbListTasks({ rootTaskId: root.task.id }).map((task) => task.id)).not.toContain(otherRoot.task.id);
    expect(dbListTasks({ onlyRootTasks: true }).map((task) => task.id)).toEqual(
      expect.arrayContaining([root.task.id, otherRoot.task.id]),
    );
    expect(dbListTasks({ onlyRootTasks: true }).map((task) => task.id)).not.toContain(child.task.id);
    expect(
      dbListTasks({
        status: "in_progress",
        agentId: "dev",
        query: "pipeline",
        limit: 1,
      }).map((task) => task.id),
    ).toEqual([child.task.id]);
  });

  it("rejects task_dir persistence for profiles that do not bootstrap a canonical task dir", () => {
    const created = dbCreateTask({
      title: "Video Rapha dir guard",
      instructions: "video-rapha must not persist task_dir",
      createdBy: "test",
      profileId: "video-rapha",
      profileVersion: "1",
      profileSource: "system:video-rapha",
      profileSnapshot: {
        id: "video-rapha",
        version: "1",
        label: "Video Rapha",
        description: "guard",
        sessionNameTemplate: "<task-id>-work",
        workspaceBootstrap: {
          mode: "path",
          path: "~/ravi/videomaker",
          ensureTaskDir: false,
        },
        sync: {
          artifactFirst: false,
        },
        rendererHints: {
          label: "Video Rapha project",
          showTaskDoc: false,
          showWorkspace: true,
        },
        defaultTags: [],
        inputs: [],
        completion: {},
        progress: {},
        templates: {
          dispatch: "dispatch",
          resume: "resume",
          dispatchSummary: "summary",
          dispatchEventMessage: "event",
          reportDoneMessage: "{{report.text}}",
          reportBlockedMessage: "{{report.text}}",
          reportFailedMessage: "{{report.text}}",
        },
        artifacts: [],
        state: [],
        sourceKind: "system",
        source: "system:video-rapha",
        manifestPath: null,
      },
    });
    createdTaskIds.push(created.task.id);

    expect(() => dbSetTaskDir(created.task.id, `/tmp/${created.task.id}`)).toThrow(
      `Task ${created.task.id} profile video-rapha forbids task_dir persistence.`,
    );
  });

  it("stores a task-level checkpoint default and materializes it on dispatch", () => {
    const created = dbCreateTask({
      title: "Checkpoint default",
      instructions: "Persist task checkpoint defaults before dispatch",
      createdBy: "test",
      checkpointIntervalMs: 600000,
    });
    createdTaskIds.push(created.task.id);

    expect(created.task.checkpointIntervalMs).toBe(600000);

    const dispatched = dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });

    expect(dispatched.assignment.checkpointIntervalMs).toBe(600000);
    expect(dispatched.assignment.checkpointLastReportAt).toBeUndefined();
    expect(dispatched.assignment.checkpointDueAt).toBeGreaterThan(dispatched.assignment.assignedAt);
  });

  it("snapshots explicit report configuration into the assignment on dispatch", () => {
    const created = dbCreateTask({
      title: "Explicit task reporting",
      instructions: "Report target and events should be explicit and snapshotted",
      createdBy: "creator",
      createdBySessionName: "creator-session",
      reportToSessionName: "ops-session",
      reportEvents: ["blocked", "failed"],
    });
    createdTaskIds.push(created.task.id);

    const dispatched = dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "dispatcher",
    });

    expect(created.task.reportToSessionName).toBe("ops-session");
    expect(created.task.reportEvents).toEqual(["blocked", "failed"]);
    expect(dispatched.assignment.reportToSessionName).toBe("ops-session");
    expect(dispatched.assignment.reportEvents).toEqual(["blocked", "failed"]);
  });

  it("resets checkpoint timing only on a real report and clears overdue count", () => {
    const created = dbCreateTask({
      title: "Checkpoint report reset",
      instructions: "Only ravi tasks report should reset the checkpoint clock",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    const dispatched = dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });
    const firstDueAt = dispatched.assignment.checkpointDueAt!;

    dbReportTaskProgress(created.task.id, {
      actor: "sync",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "sincronizando progresso vindo do TASK.md",
      progress: 10,
      resetCheckpoint: false,
    });

    const afterDocumentSync = dbGetActiveAssignment(created.task.id)!;
    expect(afterDocumentSync.checkpointLastReportAt).toBeUndefined();
    expect(afterDocumentSync.checkpointDueAt).toBe(firstDueAt);

    const missed = dbRegisterTaskCheckpointMiss(created.task.id, afterDocumentSync.id, firstDueAt + 1);
    expect(missed?.assignment.checkpointOverdueCount).toBe(1);

    const reported = dbReportTaskProgress(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "retomando o trabalho depois do checkpoint perdido",
      progress: 35,
    });

    const assignment = dbGetActiveAssignment(created.task.id)!;
    expect(reported.task.progress).toBe(35);
    expect(assignment.checkpointLastReportAt).toBeDefined();
    expect(assignment.checkpointDueAt).toBeGreaterThan(assignment.checkpointLastReportAt!);
    expect(assignment.checkpointOverdueCount).toBe(0);
  });

  it("rolls the next due checkpoint forward and records overdue events", () => {
    const created = dbCreateTask({
      title: "Checkpoint overdue",
      instructions: "Overdue checkpoints should roll forward by interval",
      createdBy: "test",
      checkpointIntervalMs: 1000,
    });
    createdTaskIds.push(created.task.id);

    const dispatched = dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });

    const missed = dbRegisterTaskCheckpointMiss(
      created.task.id,
      dispatched.assignment.id,
      dispatched.assignment.checkpointDueAt! + 2500,
    );
    expect(missed?.missedCount).toBe(3);
    expect(missed?.assignment.checkpointOverdueCount).toBe(3);
    expect(missed?.assignment.checkpointDueAt).toBe(dispatched.assignment.checkpointDueAt! + 3000);
    expect(missed?.event.type).toBe("task.checkpoint.missed");
  });

  it("does not reopen a terminal task on late progress", () => {
    const created = dbCreateTask({
      title: "Terminal guard smoke",
      instructions: "Late progress must not reopen done task",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });
    dbCompleteTask(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "done",
    });

    const late = dbReportTaskProgress(created.task.id, {
      actor: "late-agent",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "still working",
      progress: 10,
    });

    expect(late.task.status).toBe("done");
    expect(late.task.progress).toBe(100);
    expect(late.event.message).toContain("Ignored late progress");
    expect(dbGetTask(created.task.id)?.status).toBe("done");
  });

  it("rejects progress reports without descriptive text", () => {
    const created = dbCreateTask({
      title: "Progress message contract",
      instructions: "Progress updates must always include useful text",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });

    expect(() =>
      dbReportTaskProgress(created.task.id, {
        actor: "test",
        agentId: "dev",
        sessionName: `${created.task.id}-work`,
        message: "ok",
        progress: 10,
      }),
    ).toThrow("Task progress requires a descriptive message.");
    expect(dbGetTask(created.task.id)?.status).toBe("dispatched");
    expect(dbListTaskEvents(created.task.id).map((event) => event.type)).toEqual(["task.created", "task.dispatched"]);
  });

  it("tracks whether a session still has an active task", () => {
    const created = dbCreateTask({
      title: "Task activity lookup",
      instructions: "Verify active task lookup by session name",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    const sessionName = `${created.task.id}-work`;

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName,
      assignedBy: "test",
    });

    expect(dbHasActiveTaskForSession(sessionName)).toBe(true);

    dbCompleteTask(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName,
      message: "done",
    });

    expect(dbHasActiveTaskForSession(sessionName)).toBe(false);
  });

  it("persists comments separately from operational events", () => {
    const created = dbCreateTask({
      title: "Comment persistence smoke",
      instructions: "Comments should not be confused with task events",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    const comment = dbAddTaskComment(created.task.id, {
      author: "operator",
      authorAgentId: "main",
      authorSessionName: "dev",
      body: "olha esse edge case antes de seguir",
    });

    expect(comment.taskId).toBe(created.task.id);
    expect(comment.authorAgentId).toBe("main");
    expect(comment.authorSessionName).toBe("dev");
    expect(dbListTaskComments(created.task.id)).toEqual([comment]);
    expect(dbListTaskEvents(created.task.id).map((event) => event.type)).toEqual(["task.created"]);
  });

  it("surfaces a dispatch summary in the dispatched event for the operator", () => {
    const created = dbCreateTask({
      title: "Dispatch summary surface",
      instructions: "Make dispatch intent visible outside the worker history",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    const dispatched = dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });

    expect(dispatched.event.type).toBe("task.dispatched");
    expect(dispatched.event.message).toContain("Dispatch summary surfaced here");
    expect(dispatched.event.message).toContain("did not provide a profile-specific summary");
    expect(dispatched.event.message).toContain("ravi tasks report|done|block|fail");
  });

  it("respects explicit progress when a task is blocked", () => {
    const created = dbCreateTask({
      title: "Blocked progress contract",
      instructions: "Blocking should preserve the TASK.md progress when provided",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });

    const blocked = dbBlockTask(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "waiting on upstream decision",
      progress: 90,
    });

    expect(blocked.task.status).toBe("blocked");
    expect(blocked.task.progress).toBe(90);
    expect(blocked.event.type).toBe("task.blocked");
    expect(blocked.event.progress).toBe(90);
  });

  it("deduplicates repeated completion for the same task", () => {
    const created = dbCreateTask({
      title: "Terminal dedupe smoke",
      instructions: "Calling done twice should not append a second terminal event",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });

    const first = dbCompleteTask(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "done once",
    });
    const second = dbCompleteTask(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "done twice",
    });

    expect(second.wasNoop).toBe(true);
    expect(second.event.id).toBe(first.event.id);
    expect(dbListTaskEvents(created.task.id).map((event) => event.type)).toEqual([
      "task.created",
      "task.dispatched",
      "task.done",
    ]);
  });

  it("can ignore the currently dispatched task when checking active work for a session", () => {
    const first = dbCreateTask({
      title: "First active task",
      instructions: "Keep session busy",
      createdBy: "test",
    });
    const second = dbCreateTask({
      title: "Second active task",
      instructions: "Should still see other active task",
      createdBy: "test",
    });
    createdTaskIds.push(first.task.id, second.task.id);

    const sessionName = "shared-task-session";

    dbDispatchTask(first.task.id, {
      agentId: "dev",
      sessionName,
      assignedBy: "test",
    });
    dbDispatchTask(second.task.id, {
      agentId: "dev",
      sessionName,
      assignedBy: "test",
    });

    expect(dbHasActiveTaskForSession(sessionName, second.task.id)).toBe(true);

    dbCompleteTask(first.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName,
      message: "done",
    });

    expect(dbHasActiveTaskForSession(sessionName, second.task.id)).toBe(false);
  });

  it("persists worktree metadata on both the task and the dispatched assignment", () => {
    const created = dbCreateTask({
      title: "Task worktree persistence",
      instructions: "Store worktree metadata across task lifecycle",
      createdBy: "test",
      worktree: {
        mode: "path",
        path: "../feature-worktree",
        branch: "feature/task-runtime",
      },
    });
    createdTaskIds.push(created.task.id);

    expect(created.task.worktree).toEqual({
      mode: "path",
      path: "../feature-worktree",
      branch: "feature/task-runtime",
    });

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
      worktree: {
        mode: "path",
        path: "/tmp/ravi-task-worktree",
        branch: "feature/task-runtime",
      },
    });

    expect(dbGetTask(created.task.id)?.worktree).toEqual({
      mode: "path",
      path: "../feature-worktree",
      branch: "feature/task-runtime",
    });
    expect(dbGetActiveAssignment(created.task.id)?.worktree).toEqual({
      mode: "path",
      path: "/tmp/ravi-task-worktree",
      branch: "feature/task-runtime",
    });
  });

  it("persists parent-child lineage in the runtime", () => {
    const parent = dbCreateTask({
      title: "Parent task",
      instructions: "Owns child work",
      createdBy: "test",
    });
    const child = dbCreateTask({
      title: "Child task",
      instructions: "Linked to the parent task",
      createdBy: "test",
      parentTaskId: parent.task.id,
    });
    createdTaskIds.push(parent.task.id, child.task.id);

    expect(dbGetTask(child.task.id)?.parentTaskId).toBe(parent.task.id);
    expect(dbListChildTasks(parent.task.id).map((task) => task.id)).toEqual([child.task.id]);
  });
});
