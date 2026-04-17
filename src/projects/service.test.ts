import { afterEach, describe, expect, it } from "bun:test";
import { getDb } from "../router/router-db.js";
import {
  attachProjectWorkflowRun,
  createProjectTask,
  createProject,
  getProjectResourceLink,
  getProjectDetails,
  linkProject,
  listProjectResourceLinks,
  listProjectStatusEntries,
  listProjects,
  startProjectWorkflowRun,
  updateProject,
} from "./index.js";
import { createWorkflowSpec, startWorkflowRun } from "../workflows/index.js";
import { dbDeleteTask, getCanonicalTaskDir, getTaskDetails } from "../tasks/index.js";
import { rmSync } from "node:fs";

const createdProjectIds: string[] = [];
const createdWorkflowRunIds: string[] = [];
const createdWorkflowSpecIds: string[] = [];
const createdTaskIds: string[] = [];

afterEach(() => {
  while (createdTaskIds.length > 0) {
    const taskId = createdTaskIds.pop();
    if (taskId) {
      dbDeleteTask(taskId);
      rmSync(getCanonicalTaskDir(taskId), { recursive: true, force: true });
    }
  }
  const db = getDb();
  while (createdProjectIds.length > 0) {
    const projectId = createdProjectIds.pop();
    if (projectId) {
      db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    }
  }
  while (createdWorkflowRunIds.length > 0) {
    const runId = createdWorkflowRunIds.pop();
    if (runId) {
      db.prepare("DELETE FROM workflow_runs WHERE id = ?").run(runId);
    }
  }
  while (createdWorkflowSpecIds.length > 0) {
    const specId = createdWorkflowSpecIds.pop();
    if (specId) {
      db.prepare("DELETE FROM workflow_specs WHERE id = ?").run(specId);
    }
  }
});

describe("projects service", () => {
  it("creates projects with required human fields and defaults", () => {
    const project = createProject({
      title: "Ops Cadence",
    });
    createdProjectIds.push(project.id);

    expect(project).toMatchObject({
      slug: "ops-cadence",
      status: "active",
      summary: "Ops Cadence",
      hypothesis: "Needs hypothesis",
      nextStep: "Define next step",
    });
    expect(project.lastSignalAt).toBeNumber();
  });

  it("updates projects without introducing task or workflow ownership columns", () => {
    const created = createProject({
      title: "Project Surface",
      summary: "Initial summary",
      hypothesis: "Initial hypothesis",
      nextStep: "Initial next step",
      ownerAgentId: "main",
      operatorSessionName: "main-session",
    });
    createdProjectIds.push(created.id);

    const updated = updateProject(created.id, {
      status: "blocked",
      hypothesis: "Waiting on upstream confirmation",
      nextStep: "Review workflow release state",
      ownerAgentId: null,
      operatorSessionName: null,
    });

    expect(updated).toMatchObject({
      id: created.id,
      status: "blocked",
      hypothesis: "Waiting on upstream confirmation",
      nextStep: "Review workflow release state",
    });
    expect(updated.ownerAgentId).toBeUndefined();
    expect(updated.operatorSessionName).toBeUndefined();
  });

  it("links cheap polymorphic context and surfaces link counts on list/show", () => {
    const project = createProject({
      title: "Alignment Layer",
      summary: "Organize scattered work",
      hypothesis: "Workflow should be the primary attachment",
      nextStep: "Attach the current workflow run",
    });
    createdProjectIds.push(project.id);

    const linked = linkProject({
      projectRef: project.id,
      assetType: "workflow",
      assetId: "wf-run-123",
      role: "primary",
      createdBy: "task-project-v0-work",
    });

    expect(linked.links).toContainEqual(
      expect.objectContaining({
        assetType: "workflow",
        assetId: "wf-run-123",
        role: "primary",
      }),
    );

    const details = getProjectDetails(project.slug);
    expect(details?.links).toHaveLength(1);

    const listed = listProjects();
    expect(listed.find((entry) => entry.id === project.id)?.linkCount).toBe(1);
  });

  it("lists and resolves resource links with typed metadata", () => {
    const project = createProject({
      title: "Resource Surface",
      summary: "Track cheap context without new ownership columns",
      hypothesis: "Resources should stay explorable as first-class cheap links",
      nextStep: "Attach repo, URL, and group context",
    });
    createdProjectIds.push(project.id);

    linkProject({
      projectRef: project.id,
      assetType: "resource",
      assetId: "/tmp/ravi.bot",
      role: "substrate",
      metadata: {
        type: "worktree",
        locator: "/tmp/ravi.bot",
        label: "ravi.bot worktree",
      },
      createdBy: "test",
    });
    linkProject({
      projectRef: project.id,
      assetType: "resource",
      assetId: "group:120363425628305127",
      role: "room",
      metadata: {
        type: "group",
        locator: "group:120363425628305127",
        label: "group 120363425628305127",
      },
      createdBy: "test",
    });

    expect(listProjectResourceLinks(project.id)).toEqual([
      expect.objectContaining({
        assetId: "/tmp/ravi.bot",
        resourceType: "worktree",
        locator: "/tmp/ravi.bot",
        label: "ravi.bot worktree",
      }),
      expect.objectContaining({
        assetId: "group:120363425628305127",
        resourceType: "group",
        locator: "group:120363425628305127",
        label: "group 120363425628305127",
      }),
    ]);
    expect(listProjectResourceLinks(project.id, "group")).toEqual([
      expect.objectContaining({
        assetId: "group:120363425628305127",
        resourceType: "group",
      }),
    ]);
    expect(getProjectResourceLink(project.id, "ravi.bot worktree")).toMatchObject({
      assetId: "/tmp/ravi.bot",
      resourceType: "worktree",
      locator: "/tmp/ravi.bot",
    });
  });

  it("enriches project details with linked workflow runtime state", () => {
    const spec = createWorkflowSpec({
      id: "wf-spec-project-runtime",
      title: "Project runtime",
      createdBy: "test",
      nodes: [
        {
          key: "ship",
          label: "Ship",
          kind: "task",
          requirement: "required",
          releaseMode: "auto",
        },
      ],
    });
    createdWorkflowSpecIds.push(spec.id);
    const run = startWorkflowRun(spec.id, {
      runId: "wf-run-project-runtime",
      createdBy: "test",
    });
    createdWorkflowRunIds.push(run.run.id);

    const project = createProject({
      title: "Ops Cadence",
      summary: "Aggregate runtime from workflow links",
      hypothesis: "Workflow is the main attachment",
      nextStep: "Review workflow state",
    });
    createdProjectIds.push(project.id);

    const linked = linkProject({
      projectRef: project.id,
      assetType: "workflow",
      assetId: run.run.id,
      role: "primary",
      createdBy: "test",
    });

    expect(linked.workflowAggregate).toMatchObject({
      total: 1,
      overallStatus: "ready",
      primaryWorkflowRunId: run.run.id,
      primaryWorkflowStatus: "ready",
      focusedWorkflowRunId: run.run.id,
      focusedWorkflowStatus: "ready",
      focusedWorkflowRole: "primary",
    });
    expect(linked.linkedWorkflows).toEqual([
      expect.objectContaining({
        workflowRunId: run.run.id,
        workflowRunTitle: "Project runtime",
        workflowRunStatus: "ready",
        workflowSpecId: spec.id,
        workflowSpecTitle: "Project runtime",
        role: "primary",
      }),
    ]);

    const details = getProjectDetails(project.id);
    expect(details?.workflowAggregate?.overallStatus).toBe("ready");
    expect(details?.linkedWorkflows[0]).toMatchObject({
      workflowRunId: run.run.id,
      workflowRunStatus: "ready",
    });
    expect(details?.operational).toMatchObject({
      runtimeStatus: "ready",
      workflowCount: 1,
      hottestWorkflowRunId: run.run.id,
      hottestWorkflowTitle: "Project runtime",
      hottestWorkflowStatus: "ready",
      hottestNodeKey: "ship",
      hottestNodeLabel: "Ship",
      hottestNodeStatus: "ready",
    });
  });

  it("starts workflow runs from the project surface with inherited owner/session defaults", () => {
    const spec = createWorkflowSpec({
      id: "wf-spec-project-start",
      title: "Project start",
      createdBy: "test",
      nodes: [
        {
          key: "ship",
          label: "Ship",
          kind: "task",
          requirement: "required",
          releaseMode: "auto",
        },
      ],
    });
    createdWorkflowSpecIds.push(spec.id);

    const project = createProject({
      title: "Project Start Ops",
      ownerAgentId: "main",
      operatorSessionName: "ops-room",
    });
    createdProjectIds.push(project.id);

    const started = startProjectWorkflowRun({
      projectRef: project.id,
      workflowSpecId: spec.id,
      createdBy: "task-project-run-ops-work",
    });
    createdWorkflowRunIds.push(started.run.run.id);

    expect(started.defaults).toEqual({
      ownerAgentId: "main",
      operatorSessionName: "ops-room",
    });
    expect(started.run.run).toMatchObject({
      workflowSpecId: spec.id,
      createdBy: "task-project-run-ops-work",
      createdByAgentId: "main",
      createdBySessionName: "ops-room",
    });
    expect(started.workflow).toMatchObject({
      workflowRunId: started.run.run.id,
      role: "primary",
    });
    expect(started.details.workflowAggregate).toMatchObject({
      primaryWorkflowRunId: started.run.run.id,
      focusedWorkflowRunId: started.run.run.id,
      focusedWorkflowRole: "primary",
    });
  });

  it("creates task attempts from project workflow node context without storing project ownership on tasks", async () => {
    const spec = createWorkflowSpec({
      id: "wf-spec-project-task-create",
      title: "Project task create",
      createdBy: "test",
      nodes: [
        {
          key: "ship",
          label: "Ship",
          kind: "task",
          requirement: "required",
          releaseMode: "auto",
        },
      ],
    });
    createdWorkflowSpecIds.push(spec.id);
    const run = startWorkflowRun(spec.id, {
      runId: "wf-run-project-task-create",
      createdBy: "test",
    });
    createdWorkflowRunIds.push(run.run.id);

    const project = createProject({
      title: "Project Task Ops",
      ownerAgentId: "main",
      operatorSessionName: "ops-room",
    });
    createdProjectIds.push(project.id);
    linkProject({
      projectRef: project.id,
      assetType: "workflow",
      assetId: run.run.id,
      role: "primary",
      createdBy: "test",
    });

    const created = await createProjectTask({
      projectRef: project.slug,
      nodeKey: "ship",
      title: "Ship attempt",
      instructions: "Execute the concrete workflow task",
      priority: "high",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    expect(created.defaults).toEqual({
      ownerAgentId: "main",
      operatorSessionName: "ops-room",
    });
    expect(created.createdTask).toMatchObject({
      id: created.task.id,
      createdBy: "test",
      createdByAgentId: "main",
      createdBySessionName: "ops-room",
    });
    expect(created.attached.nodeRun).toMatchObject({
      workflowRunId: run.run.id,
      specNodeKey: "ship",
      currentTaskId: created.task.id,
    });
    expect(getTaskDetails(created.task.id).project).toMatchObject({
      projectId: project.id,
      projectSlug: "project-task-ops",
      workflowRunId: run.run.id,
      workflowLinkRole: "primary",
    });
    expect(created.task).not.toHaveProperty("projectId");
  });

  it("attaches support workflows without stealing the project primary, while surfacing focus", () => {
    const spec = createWorkflowSpec({
      id: "wf-spec-project-support-focus",
      title: "Project support focus",
      createdBy: "test",
      nodes: [
        {
          key: "ship",
          label: "Ship",
          kind: "task",
          requirement: "required",
          releaseMode: "auto",
        },
      ],
    });
    createdWorkflowSpecIds.push(spec.id);
    const primaryRun = startWorkflowRun(spec.id, {
      runId: "wf-run-project-primary",
      createdBy: "test",
    });
    const supportRun = startWorkflowRun(spec.id, {
      runId: "wf-run-project-support",
      createdBy: "test",
    });
    createdWorkflowRunIds.push(primaryRun.run.id, supportRun.run.id);

    const project = createProject({ title: "Project Support Focus" });
    createdProjectIds.push(project.id);

    linkProject({
      projectRef: project.id,
      assetType: "workflow",
      assetId: primaryRun.run.id,
      role: "primary",
      createdBy: "test",
    });

    const attached = attachProjectWorkflowRun({
      projectRef: project.id,
      workflowRunId: supportRun.run.id,
      createdBy: "test",
    });

    expect(attached.workflow).toMatchObject({
      workflowRunId: supportRun.run.id,
      role: "support",
    });
    expect(attached.details.workflowAggregate).toMatchObject({
      primaryWorkflowRunId: primaryRun.run.id,
      primaryWorkflowStatus: "ready",
      focusedWorkflowRunId: supportRun.run.id,
      focusedWorkflowStatus: "ready",
      focusedWorkflowRole: "support",
    });
  });

  it("keeps only one workflow primary per project when a new primary is attached", () => {
    const spec = createWorkflowSpec({
      id: "wf-spec-project-primary-swap",
      title: "Project primary swap",
      createdBy: "test",
      nodes: [
        {
          key: "ship",
          label: "Ship",
          kind: "task",
          requirement: "required",
          releaseMode: "auto",
        },
      ],
    });
    createdWorkflowSpecIds.push(spec.id);
    const firstRun = startWorkflowRun(spec.id, {
      runId: "wf-run-project-first-primary",
      createdBy: "test",
    });
    const secondRun = startWorkflowRun(spec.id, {
      runId: "wf-run-project-second-primary",
      createdBy: "test",
    });
    createdWorkflowRunIds.push(firstRun.run.id, secondRun.run.id);

    const project = createProject({ title: "Project Primary Swap" });
    createdProjectIds.push(project.id);

    linkProject({
      projectRef: project.id,
      assetType: "workflow",
      assetId: firstRun.run.id,
      role: "primary",
      createdBy: "test",
    });

    const details = linkProject({
      projectRef: project.id,
      assetType: "workflow",
      assetId: secondRun.run.id,
      role: "primary",
      createdBy: "test",
    });

    expect(details.linkedWorkflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflowRunId: firstRun.run.id,
          role: "support",
        }),
        expect.objectContaining({
          workflowRunId: secondRun.run.id,
          role: "primary",
        }),
      ]),
    );
    expect(details.workflowAggregate).toMatchObject({
      primaryWorkflowRunId: secondRun.run.id,
      focusedWorkflowRunId: secondRun.run.id,
      focusedWorkflowRole: "primary",
    });
  });

  it("lists operational project entries sorted by runtime heat and signal", () => {
    const spec = createWorkflowSpec({
      id: "wf-spec-project-ops",
      title: "Project ops",
      createdBy: "test",
      nodes: [
        {
          key: "ship",
          label: "Ship",
          kind: "task",
          requirement: "required",
          releaseMode: "auto",
        },
      ],
    });
    createdWorkflowSpecIds.push(spec.id);

    const run = startWorkflowRun(spec.id, {
      runId: "wf-run-project-ops",
      createdBy: "test",
    });
    createdWorkflowRunIds.push(run.run.id);

    const hotProject = createProject({
      title: "Hot project",
      summary: "Has a linked workflow",
      hypothesis: "Workflow is moving",
      nextStep: "Check shipping",
      lastSignalAt: Date.now(),
    });
    const coldProject = createProject({
      title: "Cold project",
      summary: "No workflow yet",
      hypothesis: "Needs attachment",
      nextStep: "Attach runtime",
      lastSignalAt: Date.now() - 86_400_000,
    });
    createdProjectIds.push(hotProject.id, coldProject.id);

    linkProject({
      projectRef: hotProject.id,
      assetType: "workflow",
      assetId: run.run.id,
      role: "primary",
      createdBy: "test",
    });

    const entries = listProjectStatusEntries().filter(
      (entry) => entry.project.id === hotProject.id || entry.project.id === coldProject.id,
    );

    expect(entries[0]).toMatchObject({
      project: {
        id: hotProject.id,
        slug: "hot-project",
      },
      operational: {
        runtimeStatus: "ready",
        hottestWorkflowRunId: run.run.id,
      },
    });
    expect(entries[1]).toMatchObject({
      project: {
        id: coldProject.id,
        slug: "cold-project",
      },
      operational: null,
    });
  });

  it("rejects linking the same workflow run to multiple projects", () => {
    const spec = createWorkflowSpec({
      id: "wf-spec-unique-project-link",
      title: "Unique project workflow",
      createdBy: "test",
      nodes: [
        {
          key: "ship",
          label: "Ship",
          kind: "task",
          requirement: "required",
          releaseMode: "auto",
        },
      ],
    });
    createdWorkflowSpecIds.push(spec.id);
    const run = startWorkflowRun(spec.id, {
      runId: "wf-run-unique-project-link",
      createdBy: "test",
    });
    createdWorkflowRunIds.push(run.run.id);

    const first = createProject({ title: "First project" });
    const second = createProject({ title: "Second project" });
    createdProjectIds.push(first.id, second.id);

    linkProject({
      projectRef: first.id,
      assetType: "workflow",
      assetId: run.run.id,
      createdBy: "test",
    });

    expect(() =>
      linkProject({
        projectRef: second.id,
        assetType: "workflow",
        assetId: run.run.id,
        createdBy: "test",
      }),
    ).toThrow(`Workflow ${run.run.id} already linked to project ${first.id}.`);
  });
});
