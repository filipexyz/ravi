import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTask,
  buildTaskEventPayload,
  buildTaskResumePrompt,
  buildTaskStreamSnapshot,
  completeTask,
  dbCreateTask,
  dbDeleteTask,
  dbDispatchTask,
  dbReportTaskProgress,
  getTaskDetails,
  isTaskRecoveryFresh,
  isTaskStreamCommand,
  readTaskDocFrontmatter,
} from "./index.js";

const createdTaskIds: string[] = [];
const tempStateDirs: string[] = [];

afterEach(() => {
  while (createdTaskIds.length > 0) {
    const id = createdTaskIds.pop();
    if (id) dbDeleteTask(id);
  }

  while (tempStateDirs.length > 0) {
    const dir = tempStateDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }

  delete process.env.RAVI_STATE_DIR;
});

describe("task substrate contract", () => {
  it("builds a canonical event payload for the v3 substrate", () => {
    const created = dbCreateTask({
      title: "Stream payload smoke",
      instructions: "Create an event payload with the canonical task entity",
      createdBy: "test",
      createdByAgentId: "main",
      createdBySessionName: "dev",
      worktree: {
        mode: "path",
        path: "../stream-worktree",
        branch: "feature/stream",
      },
    });
    createdTaskIds.push(created.task.id);

    const payload = buildTaskEventPayload(created.task, created.event);

    expect(payload.kind).toBe("task.event");
    expect(payload.task.id).toBe(created.task.id);
    expect(payload.task.parentTaskId).toBeNull();
    expect(payload.task.taskDir).toBeNull();
    expect(payload.task.createdBy).toBe("test");
    expect(payload.task.createdByAgentId).toBe("main");
    expect(payload.task.createdBySessionName).toBe("dev");
    expect(payload.parentTaskId).toBeNull();
    expect(payload.createdByAgentId).toBe("main");
    expect(payload.createdBySessionName).toBe("dev");
    expect(payload.task.worktree).toEqual({
      mode: "path",
      path: "../stream-worktree",
      branch: "feature/stream",
    });
    expect(payload.event.type).toBe("task.created");
    expect(payload.task.artifacts).toEqual({
      status: "planned",
      supportedKinds: ["file", "url", "text"],
      items: [],
    });
    expect(payload.artifacts.status).toBe("planned");
  });

  it("builds a task snapshot with selection details and forward-compatible artifact placeholders", () => {
    const created = dbCreateTask({
      title: "Snapshot smoke",
      instructions: "Create -> dispatch -> report so the snapshot exposes current task state",
      createdBy: "test",
      worktree: {
        mode: "path",
        path: "../snapshot-worktree",
        branch: "feature/snapshot",
      },
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
      worktree: {
        mode: "path",
        path: "/tmp/ravi-task-snapshot-worktree",
        branch: "feature/snapshot",
      },
    });
    dbReportTaskProgress(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "working",
      progress: 35,
    });

    const snapshot = buildTaskStreamSnapshot({
      taskId: created.task.id,
      eventsLimit: 10,
    });

    expect(snapshot.query).toEqual({
      taskId: created.task.id,
      status: null,
      agentId: null,
      sessionName: null,
      eventsLimit: 10,
    });
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({
      id: created.task.id,
      status: "in_progress",
      progress: 35,
      worktree: {
        mode: "path",
        path: "../snapshot-worktree",
        branch: "feature/snapshot",
      },
    });
    expect(snapshot.stats).toEqual({
      total: 1,
      open: 0,
      dispatched: 0,
      inProgress: 1,
      blocked: 0,
      done: 0,
      failed: 0,
    });
    expect(snapshot.selectedTask?.activeAssignment?.sessionName).toBe(`${created.task.id}-work`);
    expect(snapshot.selectedTask?.parentTask).toBeNull();
    expect(snapshot.selectedTask?.childTasks).toEqual([]);
    expect(snapshot.selectedTask?.activeAssignment?.worktree).toEqual({
      mode: "path",
      path: "/tmp/ravi-task-snapshot-worktree",
      branch: "feature/snapshot",
    });
    expect(snapshot.selectedTask?.events.map((event) => event.type)).toEqual([
      "task.created",
      "task.dispatched",
      "task.progress",
    ]);
    expect(snapshot.selectedTask?.task.artifacts.supportedKinds).toEqual(["file", "url", "text"]);
    expect(snapshot.artifacts.status).toBe("planned");
  });

  it("recognizes the canonical task commands exposed by the v3 stream boundary", () => {
    expect(isTaskStreamCommand("task.create")).toBe(true);
    expect(isTaskStreamCommand("task.dispatch")).toBe(true);
    expect(isTaskStreamCommand("task.report")).toBe(true);
    expect(isTaskStreamCommand("task.done")).toBe(true);
    expect(isTaskStreamCommand("task.block")).toBe(true);
    expect(isTaskStreamCommand("task.fail")).toBe(true);
    expect(isTaskStreamCommand("snapshot.open")).toBe(false);
  });

  it("builds a resume prompt that preserves task progress across daemon restart", () => {
    const created = dbCreateTask({
      title: "Resume smoke",
      instructions: "Continue from previous progress after restart",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });
    const progressed = dbReportTaskProgress(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      progress: 42,
      message: "halfway there",
    });

    const prompt = buildTaskResumePrompt(progressed.task, "dev", `${created.task.id}-work`, {
      effectiveCwd: "/tmp/ravi-task-recovery",
      taskDocPath: `/tmp/ravi-task-recovery/tasks/${created.task.id}/TASK.md`,
    });

    expect(prompt).toContain(`task ${created.task.id}`);
    expect(prompt).toContain("Status atual: in_progress");
    expect(prompt).toContain("Progresso atual: 42%");
    expect(prompt).toContain("carregue a skill `ravi-system-tasks-manager`");
    expect(prompt).toContain(`/tmp/ravi-task-recovery/tasks/${created.task.id}/TASK.md`);
    expect(prompt).toContain(`ravi tasks done ${created.task.id}`);
  });

  it("recovers only fresh active tasks after restart", () => {
    const now = 3_000_000;
    expect(
      isTaskRecoveryFresh(
        {
          id: "task-fresh",
          title: "Fresh",
          instructions: "Fresh task",
          status: "in_progress",
          priority: "normal",
          progress: 80,
          createdAt: now - 10_000,
          updatedAt: now - 5_000,
        },
        {
          id: "asg-fresh",
          taskId: "task-fresh",
          agentId: "dev",
          sessionName: "task-fresh-work",
          status: "accepted",
          assignedAt: now - 15_000,
          acceptedAt: now - 8_000,
        },
        now,
      ),
    ).toBe(true);

    expect(
      isTaskRecoveryFresh(
        {
          id: "task-stale",
          title: "Stale",
          instructions: "Old task",
          status: "in_progress",
          priority: "normal",
          progress: 90,
          createdAt: now - 3_000_000,
          updatedAt: now - 2_000_000,
        },
        {
          id: "asg-stale",
          taskId: "task-stale",
          agentId: "dev",
          sessionName: "task-stale-work",
          status: "accepted",
          assignedAt: now - 2_100_000,
        },
        now,
      ),
    ).toBe(false);
  });

  it("creates a canonical TASK.md with minimal frontmatter for new tasks", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-task-doc-"));
    tempStateDirs.push(stateDir);
    process.env.RAVI_STATE_DIR = stateDir;

    const created = createTask({
      title: "Task doc create smoke",
      instructions: "Write the body here first and let the CLI recognize frontmatter changes.",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    expect(created.task.taskDir).toBe(join(stateDir, "tasks", created.task.id));

    const docPath = join(created.task.taskDir!, "TASK.md");
    const doc = readFileSync(docPath, "utf8");
    expect(doc).toContain(`id: "${created.task.id}"`);
    expect(doc).toContain("parent_task_id: null");
    expect(doc).toContain('status: "open"');
    expect(doc).toContain('priority: "normal"');
    expect(doc).toContain("## Workflow");
    expect(doc).toContain("## Plan");
    expect(doc).toContain("## Activity Log");
    expect(readTaskDocFrontmatter(created.task)).toMatchObject({
      id: created.task.id,
      status: "open",
      priority: "normal",
      progress: 0,
    });
  });

  it("materializes TASK.md for legacy tasks when details are requested", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-task-doc-legacy-"));
    tempStateDirs.push(stateDir);
    process.env.RAVI_STATE_DIR = stateDir;

    const created = dbCreateTask({
      title: "Legacy task",
      instructions: "Backfill TASK.md on first read",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    expect(created.task.taskDir).toBeUndefined();

    const details = getTaskDetails(created.task.id);
    expect(details.task?.taskDir).toBe(join(stateDir, "tasks", created.task.id));
    expect(readFileSync(join(details.task!.taskDir!, "TASK.md"), "utf8")).toContain("Task Document Materialized");
  });

  it("records terminal child callbacks on the parent runtime and TASK.md", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-task-lineage-"));
    tempStateDirs.push(stateDir);
    process.env.RAVI_STATE_DIR = stateDir;

    const parent = createTask({
      title: "Parent runtime task",
      instructions: "Own the parent document",
      createdBy: "test",
    });
    const child = createTask({
      title: "Child runtime task",
      instructions: "Finish and notify the parent",
      createdBy: "test",
      parentTaskId: parent.task.id,
    });
    createdTaskIds.push(parent.task.id, child.task.id);

    dbDispatchTask(child.task.id, {
      agentId: "dev",
      sessionName: `${child.task.id}-work`,
      assignedBy: "test",
    });

    const completed = completeTask(child.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${child.task.id}-work`,
      message: "child shipped",
    });

    expect(completed.relatedEvents).toHaveLength(1);
    expect(completed.relatedEvents[0]?.event.type).toBe("task.child.done");
    expect(completed.relatedEvents[0]?.event.relatedTaskId).toBe(child.task.id);

    const parentDetails = getTaskDetails(parent.task.id);
    expect(parentDetails.childTasks.map((task) => task.id)).toEqual([child.task.id]);
    expect(parentDetails.events.map((event) => event.type)).toContain("task.child.done");

    const childDetails = getTaskDetails(child.task.id);
    expect(childDetails.parentTask?.id).toBe(parent.task.id);
    expect(readTaskDocFrontmatter(childDetails.task!)).toMatchObject({
      parentTaskId: parent.task.id,
    });

    const parentDoc = readFileSync(join(parent.task.taskDir!, "TASK.md"), "utf8");
    expect(parentDoc).toContain("Child Task Done");
    expect(parentDoc).toContain(child.task.id);
    expect(parentDoc).toContain("child shipped");

    const snapshot = buildTaskStreamSnapshot({ taskId: parent.task.id, eventsLimit: 20 });
    expect(snapshot.selectedTask?.childTasks.map((task) => task.id)).toEqual([child.task.id]);
  });
});
