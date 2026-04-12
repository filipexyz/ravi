import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import {
  archiveTask,
  blockTask,
  createTask,
  buildTaskEventPayload,
  buildTaskDispatchPrompt,
  buildTaskResumePrompt,
  buildTaskStreamSnapshot,
  commentTask,
  completeTask,
  dbCreateTask,
  dbDeleteTask,
  dbDispatchTask,
  dbGetTask,
  dbReportTaskProgress,
  dispatchTask,
  getTaskDetails,
  isTaskRecoveryFresh,
  isTaskStreamCommand,
  requireTaskRuntimeAgent,
  readTaskDocFrontmatter,
  resolveBrainstormTaskSlug,
  resolveTaskCreateAssigneeAgent,
  resolveTaskProfile,
  resolveTaskProfilePrimaryArtifact,
  resolveTaskSessionContext,
  resolveTaskWorktreeContext,
  unarchiveTask,
} from "./index.js";
import { dbCreateAgent, dbDeleteAgent } from "../router/router-db.js";
import { deleteSession, resolveSession } from "../router/sessions.js";
import type { ResolvedTaskProfile } from "./types.js";

const createdTaskIds: string[] = [];
const tempStateDirs: string[] = [];
const createdAgentIds: string[] = [];
const createdSessionNames: string[] = [];

function buildTestProfile(
  profileId: "default" | "brainstorm" | "task-doc-optional" | "task-doc-none" | string,
  overrides: Partial<ResolvedTaskProfile> = {},
): ResolvedTaskProfile {
  const normalizedId = profileId || "default";
  const taskDocumentUsage =
    normalizedId === "brainstorm" || normalizedId === "task-doc-none"
      ? "none"
      : normalizedId === "task-doc-optional"
        ? "optional"
        : "required";

  return {
    id: normalizedId,
    version: "1",
    requestedId: normalizedId,
    resolvedFromFallback: false,
    label:
      normalizedId === "brainstorm"
        ? "Brainstorm"
        : normalizedId === "task-doc-none"
          ? "Runtime Only"
          : normalizedId === "task-doc-optional"
            ? "Task Doc Optional"
            : normalizedId,
    description: `Test profile ${normalizedId}.`,
    sessionNameTemplate: "<task-id>-work",
    workspaceBootstrap: {
      mode: "inherit",
      ensureTaskDir: taskDocumentUsage !== "none",
    },
    sync: {
      artifactFirst: normalizedId === "default",
      ...(taskDocumentUsage !== "none" ? { taskDocument: { mode: taskDocumentUsage } } : {}),
    },
    rendererHints: {
      label:
        normalizedId === "brainstorm"
          ? "Brainstorm draft"
          : normalizedId === "task-doc-none"
            ? "Runtime only"
            : normalizedId === "task-doc-optional"
              ? "TASK.md optional"
              : "TASK.md first",
      showTaskDoc: taskDocumentUsage !== "none",
      showWorkspace: true,
    },
    defaultTags: [],
    inputs: [],
    completion: {
      summaryRequired: true,
      summaryLabel: "Resumo",
    },
    progress: {
      requireMessage: true,
    },
    artifacts:
      normalizedId === "brainstorm"
        ? [
            {
              kind: "brainstorm-draft",
              label: "Brainstorm draft",
              pathTemplate: "{{session.cwd}}/.genie/brainstorms/{{profileState.brainstorm.slug}}/DRAFT.md",
              primary: true,
            },
            {
              kind: "brainstorm-design",
              label: "Brainstorm design",
              pathTemplate: "{{session.cwd}}/.genie/brainstorms/{{profileState.brainstorm.slug}}/DESIGN.md",
              primaryWhenStatuses: ["done"],
            },
            {
              kind: "brainstorm-jar",
              label: "Brainstorm jar",
              pathTemplate: "{{session.cwd}}/.genie/brainstorm.md",
            },
          ]
        : taskDocumentUsage !== "none"
          ? [
              {
                kind: "task-doc",
                label: "TASK.md",
                pathTemplate: "{{task.taskDocPath}}",
                primary: true,
              },
            ]
          : [],
    state:
      normalizedId === "brainstorm"
        ? [
            {
              path: "brainstorm.slug",
              valueTemplate: "{{task.title}}",
              transform: "slug",
            },
          ]
        : [],
    templates: {
      dispatch: "dispatch {{task.id}}",
      resume: "resume {{task.id}}",
      dispatchSummary: "summary {{task.id}}",
      dispatchEventMessage: "event {{task.id}}",
    },
    sourceKind: "system",
    source: `system:${normalizedId}`,
    manifestPath: null,
    ...overrides,
  };
}

function writeRuntimeOnlyTaskDirProfile(workspaceDir: string, profileId: string): void {
  const profileDir = join(workspaceDir, ".ravi", "task-profiles", profileId);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(profileDir, "profile.json"),
    JSON.stringify(
      {
        id: profileId,
        version: "1",
        label: "Runtime Dir",
        description: "Runtime-only profile that still bootstraps a task dir.",
        sessionNameTemplate: "<task-id>-research",
        workspaceBootstrap: {
          mode: "inherit",
          ensureTaskDir: true,
        },
        sync: {
          artifactFirst: false,
        },
        rendererHints: {
          label: "Research brief",
          showTaskDoc: false,
          showWorkspace: true,
        },
        defaultTags: ["task.profile.runtime-dir"],
        inputs: [
          {
            key: "question",
            required: true,
          },
        ],
        completion: {
          summaryRequired: true,
          summaryLabel: "Research outcome",
        },
        progress: {
          requireMessage: true,
        },
        artifacts: [
          {
            kind: "researchBrief",
            label: "Research brief",
            pathTemplate: "{{task.taskDir}}/RESEARCH.md",
            primary: true,
          },
        ],
        state: [],
        templates: {
          dispatch: "Dispatch {{task.id}} using {{artifacts.primary.path}} for {{input.question}}",
          resume: "Resume {{task.id}} using {{artifacts.primary.path}}",
          dispatchSummary: "Primary {{artifacts.primary.path}}",
          dispatchEventMessage: "Event {{task.id}}",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

afterEach(() => {
  while (createdTaskIds.length > 0) {
    const id = createdTaskIds.pop();
    if (id) dbDeleteTask(id);
  }

  while (createdSessionNames.length > 0) {
    const sessionName = createdSessionNames.pop();
    if (!sessionName) continue;
    const session = resolveSession(sessionName);
    if (session) {
      deleteSession(session.sessionKey);
    }
  }

  while (createdAgentIds.length > 0) {
    const id = createdAgentIds.pop();
    if (id) dbDeleteAgent(id);
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
    expect(payload.task.profileId).toBe("default");
    expect(payload.task.taskProfile.sync.taskDocument?.mode ?? "none").toBe("required");
    expect(payload.task.checkpointIntervalMs).toBe(300000);
    expect(payload.task.reportToSessionName).toBe("dev");
    expect(payload.task.reportEvents).toEqual(["done"]);
    expect(payload.task.parentTaskId).toBeNull();
    expect(payload.task.taskDir).toBeNull();
    expect(payload.task.createdBy).toBe("test");
    expect(payload.task.createdByAgentId).toBe("main");
    expect(payload.task.createdBySessionName).toBe("dev");
    expect(payload.task.workSessionName).toBeNull();
    expect(payload.parentTaskId).toBeNull();
    expect(payload.profileId).toBe("default");
    expect(payload.taskProfile.sync.taskDocument?.mode ?? "none").toBe("required");
    expect(payload.createdByAgentId).toBe("main");
    expect(payload.createdBySessionName).toBe("dev");
    expect(payload.reportToSessionName).toBe("dev");
    expect(payload.reportEvents).toEqual(["done"]);
    expect(payload.activeAssignment).toBeNull();
    expect(payload.task.worktree).toEqual({
      mode: "path",
      path: "../stream-worktree",
      branch: "feature/stream",
    });
    expect(payload.event.type).toBe("task.created");
    expect(payload.task.artifacts).toMatchObject({
      status: "planned",
      supportedKinds: ["file", "url", "text"],
      primary: {
        kind: "task-doc",
        role: "primary",
        label: "TASK.md",
      },
      items: [
        {
          kind: "task-doc",
          role: "primary",
          label: "TASK.md",
        },
      ],
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
      message: "preenchendo o snapshot com progresso narrado",
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
      archiveMode: "exclude",
      eventsLimit: 10,
    });
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({
      id: created.task.id,
      status: "in_progress",
      progress: 35,
      profileId: "default",
      checkpointIntervalMs: 300000,
      workSessionName: `${created.task.id}-work`,
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
    expect(snapshot.selectedTask?.activeAssignment?.checkpointLastReportAt).toBeDefined();
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
    expect(snapshot.selectedTask?.comments).toEqual([]);
    expect(snapshot.selectedTask?.task.artifacts.supportedKinds).toEqual(["file", "url", "text"]);
    expect(snapshot.selectedTask?.task.artifacts.primary).toMatchObject({
      kind: "task-doc",
      role: "primary",
      label: "TASK.md",
      exists: false,
    });
    expect(snapshot.selectedTask?.task.artifacts.primary?.path.absolutePath).toContain(created.task.id);
    expect(snapshot.artifacts.status).toBe("planned");
  });

  it("surfaces brainstorm draft/design artifacts with workspace-relative and absolute paths", () => {
    const agentId = "brainstorm-surface-agent";
    const agentCwd = "/tmp/ravi-brainstorm-surface";
    createdAgentIds.push(agentId);
    dbCreateAgent({ id: agentId, cwd: agentCwd });

    const created = createTask({
      title: "Brainstorm artifact surface",
      instructions: "Expose brainstorm artifacts in task read surfaces.",
      createdBy: "test",
      createdByAgentId: agentId,
      profileId: "brainstorm",
    });
    createdTaskIds.push(created.task.id);

    const payload = buildTaskEventPayload(created.task, created.event);
    const snapshot = buildTaskStreamSnapshot({ taskId: created.task.id, eventsLimit: 10 });
    const slug = resolveBrainstormTaskSlug(created.task.title);

    expect(payload.profileId).toBe("brainstorm");
    expect(payload.task.artifacts.workspaceRoot).toBe(agentCwd);
    expect(payload.task.artifacts.primary).toMatchObject({
      kind: "brainstorm-draft",
      role: "primary",
      label: "Brainstorm draft",
      exists: false,
      path: {
        absolutePath: `${agentCwd}/.genie/brainstorms/${slug}/DRAFT.md`,
        workspaceRelativePath: `.genie/brainstorms/${slug}/DRAFT.md`,
        displayPath: `.genie/brainstorms/${slug}/DRAFT.md`,
      },
    });
    expect(payload.task.artifacts.items).toContainEqual(
      expect.objectContaining({
        kind: "brainstorm-design",
        role: "supporting",
        label: "Brainstorm design",
        exists: false,
        path: {
          absolutePath: `${agentCwd}/.genie/brainstorms/${slug}/DESIGN.md`,
          workspaceRelativePath: `.genie/brainstorms/${slug}/DESIGN.md`,
          displayPath: `.genie/brainstorms/${slug}/DESIGN.md`,
        },
      }),
    );
    expect(snapshot.selectedTask?.task.artifacts).toEqual(payload.task.artifacts);
    expect(snapshot.artifacts).toEqual(payload.task.artifacts);
  });

  it("hides archived tasks from list snapshots by default and exposes filters when requested", () => {
    const visible = dbCreateTask({
      title: "Visible task",
      instructions: "Should stay in the default snapshot",
      createdBy: "test",
    });
    const hidden = dbCreateTask({
      title: "Archived task",
      instructions: "Should leave the default snapshot",
      createdBy: "test",
    });
    createdTaskIds.push(visible.task.id, hidden.task.id);

    archiveTask(hidden.task.id, {
      actor: "operator",
      reason: "old backlog",
    });

    const defaultSnapshot = buildTaskStreamSnapshot({ eventsLimit: 10 });
    expect(defaultSnapshot.query).toEqual({
      taskId: null,
      status: null,
      agentId: null,
      sessionName: null,
      archiveMode: "exclude",
      eventsLimit: 10,
    });
    expect(defaultSnapshot.items.map((task) => task.id)).toContain(visible.task.id);
    expect(defaultSnapshot.items.map((task) => task.id)).not.toContain(hidden.task.id);

    const archivedSnapshot = buildTaskStreamSnapshot({ archived: true, eventsLimit: 10 });
    expect(archivedSnapshot.query.archiveMode).toBe("only");
    expect(archivedSnapshot.items.map((task) => task.id)).toContain(hidden.task.id);
    expect(archivedSnapshot.items.map((task) => task.id)).not.toContain(visible.task.id);
    expect(archivedSnapshot.items[0]?.archivedBy).toBe("operator");
    expect(archivedSnapshot.items[0]?.archiveReason).toBe("old backlog");

    const allSnapshot = buildTaskStreamSnapshot({ all: true, eventsLimit: 10 });
    expect(allSnapshot.query.archiveMode).toBe("include");
    expect(allSnapshot.items.map((task) => task.id)).toEqual(expect.arrayContaining([visible.task.id, hidden.task.id]));

    const restored = unarchiveTask(hidden.task.id, { actor: "operator" });
    expect(restored.task.archivedAt).toBeUndefined();
  });

  it("preserves explicit report configuration in terminal event payloads", () => {
    const created = dbCreateTask({
      title: "Dispatcher notify smoke",
      instructions: "The report target should stay explicit after the task completes",
      createdBy: "creator",
      createdByAgentId: "main",
      createdBySessionName: "creator-session",
      reportToSessionName: "lead-session",
      reportEvents: ["blocked", "done"],
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "dispatcher-session",
      assignedByAgentId: "main",
      assignedBySessionName: "dispatcher-session",
    });

    const completed = completeTask(created.task.id, {
      actor: `${created.task.id}-work`,
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "feito",
    });

    const payload = buildTaskEventPayload(completed.task, completed.event);

    expect(payload.event.type).toBe("task.done");
    expect(payload.activeAssignment).toBeNull();
    expect(payload.dispatcherSessionName).toBe("dispatcher-session");
    expect(payload.createdBySessionName).toBe("creator-session");
    expect(payload.reportToSessionName).toBe("lead-session");
    expect(payload.reportEvents).toEqual(["blocked", "done"]);
  });

  it("persists task comments in details/snapshot without steering terminal work", async () => {
    const created = createTask({
      title: "Comment snapshot smoke",
      instructions: "Expose comments separately from task events",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    const result = await commentTask(created.task.id, {
      author: "operator",
      authorAgentId: "main",
      authorSessionName: "dev",
      body: "alinha a direção antes de despachar",
    });

    expect(result.steeredSessionName).toBeUndefined();

    const details = getTaskDetails(created.task.id);
    expect(details.comments).toHaveLength(1);
    expect(details.comments[0]).toMatchObject({
      body: "alinha a direção antes de despachar",
      authorAgentId: "main",
      authorSessionName: "dev",
    });
    expect(details.events.map((event) => event.type)).toContain("task.comment");

    const snapshot = buildTaskStreamSnapshot({ taskId: created.task.id, eventsLimit: 10 });
    expect(snapshot.selectedTask?.comments).toHaveLength(1);
    expect(snapshot.selectedTask?.comments[0]?.body).toBe("alinha a direção antes de despachar");
  });

  it("recognizes the canonical task commands exposed by the v3 stream boundary", () => {
    expect(isTaskStreamCommand("task.create")).toBe(true);
    expect(isTaskStreamCommand("task.dispatch")).toBe(true);
    expect(isTaskStreamCommand("task.report")).toBe(true);
    expect(isTaskStreamCommand("task.comment")).toBe(true);
    expect(isTaskStreamCommand("task.archive")).toBe(true);
    expect(isTaskStreamCommand("task.unarchive")).toBe(true);
    expect(isTaskStreamCommand("task.done")).toBe(true);
    expect(isTaskStreamCommand("task.block")).toBe(true);
    expect(isTaskStreamCommand("task.fail")).toBe(true);
    expect(isTaskStreamCommand("snapshot.open")).toBe(false);
  });

  it("rejects create-time assignee resolution when the agent is missing from runtime config", () => {
    expect(() => requireTaskRuntimeAgent("ghost-agent")).toThrow("Agent not found in runtime config: ghost-agent");
    expect(() => resolveTaskCreateAssigneeAgent("ghost-agent", undefined)).toThrow(
      "Agent not found in runtime config: ghost-agent",
    );
  });

  it("rejects dispatch before creating session or assignment when the agent is missing", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-task-invalid-agent-dispatch-"));
    tempStateDirs.push(stateDir);
    process.env.RAVI_STATE_DIR = stateDir;

    const created = createTask({
      title: "Invalid dispatch target",
      instructions: "Reject a missing agent before any dispatch side effect",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    const sessionName = `${created.task.id}-ghost`;

    await expect(
      dispatchTask(created.task.id, {
        agentId: "ghost-agent",
        sessionName,
        assignedBy: "test",
      }),
    ).rejects.toThrow("Agent not found in runtime config: ghost-agent");

    expect(resolveSession(sessionName)).toBeNull();
    expect(dbGetTask(created.task.id)?.status).toBe("open");
    expect(dbGetTask(created.task.id)?.assigneeAgentId).toBeUndefined();
    expect(getTaskDetails(created.task.id).activeAssignment).toBeNull();
    expect(getTaskDetails(created.task.id).events.map((event) => event.type)).toEqual(["task.created"]);
  });

  it("builds a resume prompt that preserves task progress across daemon restart", () => {
    const created = dbCreateTask({
      title: "Resume smoke",
      instructions: "Continue from previous progress after restart",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    const _dispatched = dbDispatchTask(created.task.id, {
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
      sessionCwd: "/tmp/ravi-task-recovery",
      taskDocPath: `/tmp/ravi-task-recovery/tasks/${created.task.id}/TASK.md`,
    });

    expect(prompt).toContain(`task ${created.task.id}`);
    expect(prompt).toContain("Resume smoke");
    expect(prompt).toContain("42%");
    expect(prompt).toContain("profile: default");
    expect(prompt).toContain(`/tmp/ravi-task-recovery/tasks/${created.task.id}/TASK.md`);
    expect(prompt).toContain("cwd efetivo da sessão: /tmp/ravi-task-recovery");
    expect(prompt).toContain("worktree contextual: agent default cwd");
  });

  it("resolves a stable brainstorm slug from the task title and centers dispatch on the draft artifact", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-task-brainstorm-"));
    tempStateDirs.push(stateDir);
    process.env.RAVI_STATE_DIR = stateDir;

    const created = createTask({
      title: "Brainstorm Núcleo API / v2",
      instructions: "Refinar a ideia antes de criar um wish executável",
      createdBy: "test",
      profileId: "brainstorm",
    });
    createdTaskIds.push(created.task.id);

    expect(created.task.profileId).toBe("brainstorm");
    expect(created.task.taskDir).toBeUndefined();
    expect(resolveBrainstormTaskSlug(created.task.title)).toBe("brainstorm-nucleo-api-v2");
    expect(created.task.profileState).toEqual({
      brainstorm: {
        slug: "brainstorm-nucleo-api-v2",
      },
    });

    const taskProfile = resolveTaskProfile(created.task.profileId);
    const primaryArtifact = resolveTaskProfilePrimaryArtifact(created.task, {
      effectiveCwd: "/tmp/brainstorm-agent",
      worktree: {
        mode: "path",
        path: "/tmp/brainstorm-worktree",
      },
      taskProfile,
    });

    expect(primaryArtifact).toEqual({
      kind: "brainstorm-draft",
      label: "Brainstorm draft",
      path: "/tmp/brainstorm-agent/.genie/brainstorms/brainstorm-nucleo-api-v2/DRAFT.md",
    });

    const prompt = buildTaskDispatchPrompt(created.task, "dev", `${created.task.id}-work`, {
      sessionCwd: "/tmp/brainstorm-agent",
      worktree: {
        mode: "path",
        path: "/tmp/brainstorm-worktree",
      },
      taskProfile,
      primaryArtifact,
    });

    expect(prompt).toContain("profile efetivo: brainstorm");
    expect(prompt).not.toContain("taskDocMode");
    expect(prompt).toContain("brainstorm slug: brainstorm-nucleo-api-v2");
    expect(prompt).toContain("carregue a skill `brainstorm`");
    expect(prompt).toContain("/tmp/brainstorm-agent/.genie/brainstorms/brainstorm-nucleo-api-v2/DRAFT.md");
    expect(prompt).not.toContain("carregue a skill `ravi-system-tasks-manager`");
    expect(prompt).not.toContain("faça toda escrita primeiro no TASK.md");
  });

  it("builds a brainstorm resume prompt that points back to the persisted draft artifact", () => {
    const task = {
      id: "task-brainstorm-resume",
      title: "Brainstorm Session Resume",
      instructions: "Continue refining the idea",
      status: "in_progress" as const,
      priority: "high" as const,
      progress: 65,
      profileId: "brainstorm",
      profileState: {
        brainstorm: {
          slug: "legacy-brainstorm-slug",
        },
      },
      createdAt: 1,
      updatedAt: 2,
    };
    const taskProfile = resolveTaskProfile(task.profileId);
    const primaryArtifact = resolveTaskProfilePrimaryArtifact(task, {
      effectiveCwd: "/tmp/brainstorm-agent",
      worktree: {
        mode: "path",
        path: "/tmp/brainstorm-worktree",
      },
      taskProfile,
    });

    const prompt = buildTaskResumePrompt(task, "dev", `${task.id}-work`, {
      sessionCwd: "/tmp/brainstorm-agent",
      worktree: {
        mode: "path",
        path: "/tmp/brainstorm-worktree",
      },
      taskProfile,
      primaryArtifact,
    });

    expect(prompt).toContain(`task ${task.id}`);
    expect(prompt).toContain("Brainstorm Session Resume");
    expect(prompt).toContain("65%");
    expect(prompt).toContain("profile: brainstorm");
    expect(prompt).toContain("slug: legacy-brainstorm-slug");
    expect(prompt).toContain("/tmp/brainstorm-agent/.genie/brainstorms/legacy-brainstorm-slug/DRAFT.md");
    expect(prompt).toContain("cwd efetivo da sessão: /tmp/brainstorm-agent");
    expect(prompt).toContain("worktree contextual: /tmp/brainstorm-worktree");
  });

  it("promotes brainstorm design artifacts on done while keeping the jar as supporting state", () => {
    const task = {
      id: "task-brainstorm-done",
      title: "Brainstorm Done Artifact",
      instructions: "Finalize into design and jar",
      status: "done" as const,
      priority: "high" as const,
      progress: 100,
      profileId: "brainstorm",
      profileState: {
        brainstorm: {
          slug: "stable-brainstorm-slug",
        },
      },
      assigneeAgentId: "dev",
      createdAt: 1,
      updatedAt: 2,
      completedAt: 3,
    };

    const surfaced = buildTaskEventPayload(task, {
      id: 99,
      taskId: task.id,
      type: "task.done",
      createdAt: 3,
      progress: 100,
      message: "done",
    }).task.artifacts;

    expect(surfaced.primary).toMatchObject({
      kind: "brainstorm-design",
      label: "Brainstorm design",
      path: {
        workspaceRelativePath: ".genie/brainstorms/stable-brainstorm-slug/DESIGN.md",
      },
    });
    expect(surfaced.items).toContainEqual(
      expect.objectContaining({
        kind: "brainstorm-draft",
        path: expect.objectContaining({
          workspaceRelativePath: ".genie/brainstorms/stable-brainstorm-slug/DRAFT.md",
        }),
      }),
    );
    expect(surfaced.items).toContainEqual(
      expect.objectContaining({
        kind: "brainstorm-jar",
        path: expect.objectContaining({
          workspaceRelativePath: ".genie/brainstorm.md",
        }),
      }),
    );
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
    expect(created.task.profileId).toBe("default");

    const docPath = join(created.task.taskDir!, "TASK.md");
    const doc = readFileSync(docPath, "utf8");
    expect(doc).toContain(`id: "${created.task.id}"`);
    expect(doc).toContain("parent_task_id: null");
    expect(doc).toContain('status: "open"');
    expect(doc).toContain('priority: "normal"');
    expect(doc).toContain("progress_note: null");
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

  it("creates an optional-doc profile without materializing TASK.md by default", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-task-doc-optional-"));
    tempStateDirs.push(stateDir);
    process.env.RAVI_STATE_DIR = stateDir;

    const created = createTask({
      title: "Optional doc profile",
      instructions: "Keep the task dir but do not materialize TASK.md on create/details.",
      createdBy: "test",
      profileId: "task-doc-optional",
    });
    createdTaskIds.push(created.task.id);

    const docPath = join(created.task.taskDir!, "TASK.md");
    expect(created.task.profileId).toBe("task-doc-optional");
    expect(created.task.taskDir).toBe(join(stateDir, "tasks", created.task.id));
    expect(() => readFileSync(docPath, "utf8")).toThrow();

    const details = getTaskDetails(created.task.id);
    expect(details.task?.profileId).toBe("task-doc-optional");
    expect(details.taskProfile?.sync.taskDocument?.mode ?? "none").toBe("optional");
    expect(() => readFileSync(docPath, "utf8")).toThrow();
  });

  it("creates a runtime-only profile without TASK.md materialization and omits TASK.md-first dispatch instructions", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-task-doc-none-"));
    tempStateDirs.push(stateDir);
    process.env.RAVI_STATE_DIR = stateDir;

    const created = createTask({
      title: "Runtime only profile",
      instructions: "Do not create TASK.md for runtime-only work.",
      createdBy: "test",
      profileId: "task-doc-none",
    });
    createdTaskIds.push(created.task.id);

    expect(created.task.profileId).toBe("task-doc-none");
    expect(created.task.taskDir).toBeUndefined();

    const details = getTaskDetails(created.task.id);
    expect(details.task?.taskDir).toBeUndefined();
    expect(details.taskProfile?.sync.taskDocument?.mode ?? "none").toBe("none");

    const prompt = buildTaskDispatchPrompt(details.task!, "dev", `${created.task.id}-work`, {
      sessionCwd: "/tmp/runtime-only",
      taskProfile: details.taskProfile!,
    });
    expect(prompt).toContain("profile efetivo: task-doc-none");
    expect(prompt).not.toContain("taskDocMode");
    expect(prompt).not.toContain("carregue a skill `ravi-system-tasks-manager`");
    expect(prompt).not.toContain("faça toda escrita primeiro no TASK.md");
    expect(prompt).not.toContain("trabalhe a partir de");
    expect(prompt).toContain("cwd efetivo da sessão: /tmp/runtime-only");
    expect(prompt).toContain("worktree contextual: agent default cwd");
  });

  it("does not materialize TASK.md for runtime-only profiles that still bootstrap a task dir", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-task-runtime-dir-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "ravi-task-runtime-workspace-"));
    tempStateDirs.push(stateDir, workspaceDir);
    process.env.RAVI_STATE_DIR = stateDir;
    writeRuntimeOnlyTaskDirProfile(workspaceDir, "runtime-dir");

    const previousCwd = process.cwd();
    const agentId = "test-runtime-dir-agent";
    createdAgentIds.push(agentId);
    dbCreateAgent({ id: agentId, cwd: "/tmp/ravi-runtime-dir-agent" });

    try {
      process.chdir(workspaceDir);

      const created = createTask({
        title: "Runtime dir profile",
        instructions: "Bootstrap the task dir but never materialize TASK.md.",
        createdBy: "test",
        profileId: "runtime-dir",
        profileInput: {
          question: "what still leaks?",
        },
      });
      createdTaskIds.push(created.task.id);

      expect(created.task.taskDir).toBe(join(stateDir, "tasks", created.task.id));
      expect(() => readFileSync(join(created.task.taskDir!, "TASK.md"), "utf8")).toThrow();

      const dispatched = await dispatchTask(created.task.id, {
        agentId,
        sessionName: `${created.task.id}-research`,
        assignedBy: "test",
      });

      expect(dispatched.task.profileId).toBe("runtime-dir");
      expect(() => readFileSync(join(dispatched.task.taskDir!, "TASK.md"), "utf8")).toThrow();

      const details = getTaskDetails(created.task.id);
      expect(details.task?.profileId).toBe("runtime-dir");
      expect(details.taskProfile?.sync.taskDocument?.mode ?? "none").toBe("none");
      expect(() => readFileSync(join(details.task!.taskDir!, "TASK.md"), "utf8")).toThrow();
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("fails closed when a runtime-only task dir contains an unexpected legacy TASK.md", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-task-runtime-dir-legacy-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "ravi-task-runtime-legacy-workspace-"));
    tempStateDirs.push(stateDir, workspaceDir);
    process.env.RAVI_STATE_DIR = stateDir;
    writeRuntimeOnlyTaskDirProfile(workspaceDir, "runtime-dir");

    const previousCwd = process.cwd();
    const agentId = "test-runtime-dir-legacy-agent";
    createdAgentIds.push(agentId);
    dbCreateAgent({ id: agentId, cwd: "/tmp/ravi-runtime-dir-agent" });

    try {
      process.chdir(workspaceDir);

      const created = createTask({
        title: "Runtime dir validation",
        instructions: "Fail if a legacy TASK.md appears.",
        createdBy: "test",
        profileId: "runtime-dir",
        profileInput: {
          question: "why must this fail?",
        },
      });
      createdTaskIds.push(created.task.id);

      writeFileSync(join(created.task.taskDir!, "TASK.md"), "# legacy\n", "utf8");

      await expect(
        dispatchTask(created.task.id, {
          agentId,
          sessionName: `${created.task.id}-research`,
          assignedBy: "test",
        }),
      ).rejects.toThrow(`Task ${created.task.id} profile runtime-dir forbids TASK.md, but found unexpected`);
      expect(() => getTaskDetails(created.task.id)).toThrow(
        `Task ${created.task.id} profile runtime-dir forbids TASK.md, but found unexpected`,
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("keeps the effective session cwd on the agent while resolving worktree metadata", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-task-worktree-cwd-"));
    tempStateDirs.push(stateDir);
    process.env.RAVI_STATE_DIR = stateDir;

    const agentId = "test-task-worktree-cwd-agent";
    const agentCwd = "/tmp/ravi-task-agent-cwd";
    const sessionName = "test-task-worktree-cwd-session";
    createdAgentIds.push(agentId);
    createdSessionNames.push(sessionName);
    dbCreateAgent({ id: agentId, cwd: agentCwd });

    const created = createTask({
      title: "Task session cwd semantics",
      instructions: "Do not let worktree override the session cwd.",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    const context = resolveTaskSessionContext(
      created.task,
      resolveTaskProfile(created.task.profileId),
      agentId,
      sessionName,
      {
        mode: "path",
        path: "../feature-worktree",
        branch: "feature/task-runtime",
      },
    );

    expect(context.sessionCwd).toBe(agentCwd);
    expect(context.worktree).toEqual({
      mode: "path",
      path: resolvePath(agentCwd, "../feature-worktree"),
      branch: "feature/task-runtime",
    });

    const session = resolveSession(sessionName);
    expect(session?.agentCwd).toBe(agentCwd);
  });

  it("derives bootstrap worktree metadata without treating it as the effective session cwd", () => {
    const baseTask = {
      id: "task-bootstrap-worktree",
      title: "Bootstrap worktree metadata",
      instructions: "Expose worktree as context only.",
      status: "open",
      priority: "normal",
      progress: 0,
      createdAt: 1,
      updatedAt: 1,
    } as const;

    const taskDirProfile: ResolvedTaskProfile = buildTestProfile("task-dir-profile", {
      label: "Task Dir Profile",
      description: "Uses task_dir as contextual worktree metadata.",
      workspaceBootstrap: {
        mode: "task_dir",
        ensureTaskDir: true,
        branch: "feature/task-dir",
      },
      rendererHints: {
        label: "Task Dir",
        showTaskDoc: true,
        showWorkspace: true,
      },
    });

    expect(
      resolveTaskWorktreeContext(
        "/tmp/ravi-agent-cwd",
        {
          ...baseTask,
          taskDir: "/tmp/ravi/tasks/task-bootstrap-worktree",
        },
        taskDirProfile,
      ),
    ).toEqual({
      mode: "path",
      path: "/tmp/ravi/tasks/task-bootstrap-worktree",
      branch: "feature/task-dir",
    });

    const explicitPathProfile: ResolvedTaskProfile = {
      ...taskDirProfile,
      id: "path-profile",
      requestedId: "path-profile",
      label: "Path Profile",
      description: "Uses a configured path as contextual worktree metadata.",
      workspaceBootstrap: {
        mode: "path",
        path: "../bootstrap-worktree",
        ensureTaskDir: false,
        branch: "feature/bootstrap",
      },
      source: "system:path-profile",
    };

    expect(resolveTaskWorktreeContext("/tmp/ravi-agent-cwd", baseTask, explicitPathProfile)).toEqual({
      mode: "path",
      path: resolvePath("/tmp/ravi-agent-cwd", "../bootstrap-worktree"),
      branch: "feature/bootstrap",
    });
  });

  it("keeps legacy default tasks side-effect free on details lookup", () => {
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
    expect(details.task?.profileId).toBe("default");
    expect(details.taskProfile?.sync.taskDocument?.mode ?? "none").toBe("required");
    expect(details.task?.taskDir).toBeUndefined();
    expect(dbGetTask(created.task.id)?.taskDir).toBeUndefined();
    expect(() => readFileSync(join(stateDir, "tasks", created.task.id, "TASK.md"), "utf8")).toThrow();
  });

  it("does not reconcile runtime state from TASK.md frontmatter on details lookup", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-task-doc-sync-"));
    tempStateDirs.push(stateDir);
    process.env.RAVI_STATE_DIR = stateDir;

    const created = createTask({
      title: "Frontmatter sync smoke",
      instructions: "The agent may edit TASK.md before calling ravi tasks report",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });

    const docPath = join(created.task.taskDir!, "TASK.md");
    const updatedDoc = readFileSync(docPath, "utf8")
      .replace('status: "open"', 'status: "in_progress"')
      .replace("progress: 0", "progress: 5")
      .replace("progress_note: null", 'progress_note: "mapeando o boundary de report no core"');
    writeFileSync(docPath, updatedDoc, "utf8");

    const details = getTaskDetails(created.task.id);
    expect(details.task?.status).toBe("dispatched");
    expect(details.task?.progress).toBe(0);
    expect(details.activeAssignment?.status).toBe("assigned");
    expect(details.activeAssignment?.checkpointLastReportAt).toBeUndefined();
    expect(details.events.map((event) => event.type)).toEqual(["task.created", "task.dispatched"]);
    expect(readTaskDocFrontmatter(details.task!)).toMatchObject({
      status: "in_progress",
      progress: 5,
      progressNote: "mapeando o boundary de report no core",
    });
  });

  it("ignores in-progress TASK.md edits without progress_note on details lookup", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-task-doc-sync-missing-note-"));
    tempStateDirs.push(stateDir);
    process.env.RAVI_STATE_DIR = stateDir;

    const created = createTask({
      title: "Frontmatter sync requires progress note",
      instructions: "Do not sync in-progress frontmatter without a descriptive note",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });

    const docPath = join(created.task.taskDir!, "TASK.md");
    const updatedDoc = readFileSync(docPath, "utf8")
      .replace('status: "open"', 'status: "in_progress"')
      .replace("progress: 0", "progress: 5");
    writeFileSync(docPath, updatedDoc, "utf8");

    const details = getTaskDetails(created.task.id);
    expect(details.task?.status).toBe("dispatched");
    expect(details.task?.progress).toBe(0);
    expect(details.events.map((event) => event.type)).toEqual(["task.created", "task.dispatched"]);
    expect(readTaskDocFrontmatter(details.task!)).toMatchObject({
      status: "in_progress",
      progress: 5,
    });
  });

  it("does not materialize terminal TASK.md state on details lookup", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-task-doc-terminal-read-"));
    tempStateDirs.push(stateDir);
    process.env.RAVI_STATE_DIR = stateDir;

    const created = createTask({
      title: "Terminal frontmatter should not auto-complete on read",
      instructions: "Only explicit commands should close the task",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });
    dbReportTaskProgress(created.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      message: "mantendo a task em andamento antes da marcacao terminal no markdown",
      progress: 20,
    });

    const docPath = join(created.task.taskDir!, "TASK.md");
    const updatedDoc = readFileSync(docPath, "utf8")
      .replace('status: "open"', 'status: "done"')
      .replace("progress: 0", "progress: 100")
      .replace("summary: null", 'summary: "done only in markdown"');
    writeFileSync(docPath, updatedDoc, "utf8");

    const details = getTaskDetails(created.task.id);

    expect(details.task?.status).toBe("in_progress");
    expect(details.task?.progress).toBe(20);
    expect(details.task?.summary).toBeUndefined();
    expect(dbGetTask(created.task.id)?.status).toBe("in_progress");
    expect(dbGetTask(created.task.id)?.progress).toBe(20);
    expect(details.events.map((event) => event.type)).toEqual(["task.created", "task.dispatched", "task.progress"]);
    expect(readTaskDocFrontmatter(details.task!)).toMatchObject({
      status: "done",
      progress: 100,
      summary: "done only in markdown",
    });
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

  it("records blocked child callbacks on the parent runtime and TASK.md", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-task-lineage-blocked-"));
    tempStateDirs.push(stateDir);
    process.env.RAVI_STATE_DIR = stateDir;

    const parent = createTask({
      title: "Parent blocked callback task",
      instructions: "Track child blockers",
      createdBy: "test",
    });
    const child = createTask({
      title: "Child blocked runtime task",
      instructions: "Block and notify the parent",
      createdBy: "test",
      parentTaskId: parent.task.id,
    });
    createdTaskIds.push(parent.task.id, child.task.id);

    dbDispatchTask(child.task.id, {
      agentId: "dev",
      sessionName: `${child.task.id}-work`,
      assignedBy: "test",
    });

    const blocked = blockTask(child.task.id, {
      actor: "test",
      agentId: "dev",
      sessionName: `${child.task.id}-work`,
      message: "waiting on parent decision",
      progress: 90,
    });

    expect(blocked.relatedEvents).toHaveLength(1);
    expect(blocked.relatedEvents[0]?.event.type).toBe("task.child.blocked");
    expect(blocked.relatedEvents[0]?.event.relatedTaskId).toBe(child.task.id);

    const parentDetails = getTaskDetails(parent.task.id);
    expect(parentDetails.events.map((event) => event.type)).toContain("task.child.blocked");

    const parentDoc = readFileSync(join(parent.task.taskDir!, "TASK.md"), "utf8");
    expect(parentDoc).toContain("Child Task Blocked");
    expect(parentDoc).toContain(child.task.id);
    expect(parentDoc).toContain("waiting on parent decision");
    expect(parentDoc).toContain("90%");
  });
});
