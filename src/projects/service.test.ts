import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { getDb } from "../router/router-db.js";
import {
  attachProjectWorkflowRun,
  createProjectTask,
  createProject,
  detachProjectWorkflowRun,
  getProjectResourceLink,
  getProjectDetails,
  linkProject,
  listProjectResourceLinks,
  listProjectStatusEntries,
  listProjectTasks,
  listProjects,
  setProjectFocusedWorkflow,
  startProjectWorkflowRun,
  TERMINAL_WORKFLOW_GRACE_MS,
  updateProject,
} from "./index.js";
import { createWorkflowSpec, startWorkflowRun } from "../workflows/index.js";
import { dbDeleteTask, getCanonicalTaskDir, getTaskDetails } from "../tasks/index.js";
import { attachTagSlugsToAsset } from "../tags/helpers.js";
import { detachTagFromSelector, searchTagBindingsForSelector } from "../tags/service.js";
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
      for (const binding of searchTagBindingsForSelector({ selector: { project: projectId } }).bindings) {
        detachTagFromSelector({
          slug: binding.tagSlug,
          selector: { project: projectId },
          actor: "projects-test",
        });
      }
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
      slug: `project-surface-${randomUUID().slice(0, 8)}`,
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

  it("filters project lists by canonical tags and surfaces tag bindings", () => {
    const tagged = createProject({
      title: "Tagged Alignment",
      summary: "Should appear in tag filtered lists",
      hypothesis: "Tags group project surfaces",
      nextStep: "Keep tag filtering canonical",
    });
    const untagged = createProject({
      title: "Untagged Alignment",
      summary: "Should not appear in tag filtered lists",
      hypothesis: "No tag binding",
      nextStep: "Stay outside filtered lists",
    });
    createdProjectIds.push(tagged.id, untagged.id);

    attachTagSlugsToAsset({
      assetType: "project",
      assetId: tagged.slug,
      tags: ["Ops.Team"],
      source: "projects.service.test",
      createdBy: "projects-test",
    });

    const listed = listProjects({ tagSlug: "Ops.Team" });
    expect(listed.map((project) => project.slug)).toEqual([tagged.slug]);
    expect(listed[0].tags?.map((tag) => tag.tagSlug)).toEqual(["ops.team"]);

    const details = getProjectDetails(tagged.id);
    expect(details?.tags).toContainEqual(
      expect.objectContaining({
        tagSlug: "ops.team",
        assetType: "project",
        assetId: tagged.slug,
      }),
    );
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
    const fixtureSuffix = randomUUID().slice(0, 8);
    const spec = createWorkflowSpec({
      id: `wf-spec-project-runtime-${fixtureSuffix}`,
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
      runId: `wf-run-project-runtime-${fixtureSuffix}`,
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

  it("unlinks a workflow run, promotes the latest support to primary, and clears explicit focus", () => {
    const spec = createWorkflowSpec({
      id: "wf-spec-project-unlink",
      title: "Project unlink",
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
      runId: "wf-run-project-unlink-primary",
      createdBy: "test",
    });
    const supportRun = startWorkflowRun(spec.id, {
      runId: "wf-run-project-unlink-support",
      createdBy: "test",
    });
    createdWorkflowRunIds.push(primaryRun.run.id, supportRun.run.id);

    const project = createProject({ title: "Project Unlink" });
    createdProjectIds.push(project.id);
    linkProject({
      projectRef: project.id,
      assetType: "workflow",
      assetId: primaryRun.run.id,
      role: "primary",
      createdBy: "test",
    });
    attachProjectWorkflowRun({
      projectRef: project.id,
      workflowRunId: supportRun.run.id,
      createdBy: "test",
    });
    setProjectFocusedWorkflow(project.id, primaryRun.run.id);

    const detached = detachProjectWorkflowRun({
      projectRef: project.id,
      workflowRunId: primaryRun.run.id,
    });

    expect(detached.removedWorkflow.workflowRunId).toBe(primaryRun.run.id);
    expect(detached.promotedPrimaryWorkflowRunId).toBe(supportRun.run.id);
    expect(detached.details.linkedWorkflows).toHaveLength(1);
    expect(detached.details.linkedWorkflows[0]).toMatchObject({
      workflowRunId: supportRun.run.id,
      role: "primary",
    });
    expect(detached.details.project.focusedWorkflowRunId).toBeUndefined();
    expect(detached.details.workflowAggregate).toMatchObject({
      total: 1,
      primaryWorkflowRunId: supportRun.run.id,
      focusedWorkflowRunId: supportRun.run.id,
    });

    expect(() =>
      detachProjectWorkflowRun({
        projectRef: project.id,
        workflowRunId: primaryRun.run.id,
      }),
    ).toThrow(`Workflow ${primaryRun.run.id} is not linked to project ${project.slug}.`);
  });

  it("excludes stale terminal workflows from the aggregate and the hottest surface", () => {
    const db = getDb();
    const spec = createWorkflowSpec({
      id: "wf-spec-project-stale-terminal",
      title: "Project stale terminal",
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

    const staleRun = startWorkflowRun(spec.id, {
      runId: "wf-run-project-stale-failed",
      createdBy: "test",
    });
    const recentRun = startWorkflowRun(spec.id, {
      runId: "wf-run-project-recent-failed",
      createdBy: "test",
    });
    createdWorkflowRunIds.push(staleRun.run.id, recentRun.run.id);

    const staleProject = createProject({ title: "Stale failed project" });
    const recentProject = createProject({ title: "Recent failed project" });
    createdProjectIds.push(staleProject.id, recentProject.id);

    linkProject({
      projectRef: staleProject.id,
      assetType: "workflow",
      assetId: staleRun.run.id,
      role: "primary",
      createdBy: "test",
    });
    linkProject({
      projectRef: recentProject.id,
      assetType: "workflow",
      assetId: recentRun.run.id,
      role: "primary",
      createdBy: "test",
    });

    db.prepare("UPDATE workflow_runs SET status = 'failed' WHERE id IN (?, ?)").run(staleRun.run.id, recentRun.run.id);
    db.prepare("UPDATE workflow_runs SET updated_at = ? WHERE id = ?").run(
      Date.now() - TERMINAL_WORKFLOW_GRACE_MS - 60_000,
      staleRun.run.id,
    );
    db.prepare("UPDATE project_links SET updated_at = ? WHERE project_id = ? AND asset_id = ?").run(
      Date.now() - TERMINAL_WORKFLOW_GRACE_MS - 60_000,
      staleProject.id,
      staleRun.run.id,
    );

    const staleDetails = getProjectDetails(staleProject.id);
    expect(staleDetails?.workflowAggregate?.overallStatus).toBeNull();
    expect(staleDetails?.workflowAggregate?.failed).toBe(0);
    expect(staleDetails?.workflowAggregate?.total).toBe(1);
    expect(staleDetails?.operational?.runtimeStatus).toBeNull();
    expect(staleDetails?.operational?.hottestWorkflowRunId).toBeNull();

    const staleEntry = listProjectStatusEntries().find((entry) => entry.project.id === staleProject.id);
    expect(staleEntry?.operational?.runtimeStatus).toBeNull();

    const recentDetails = getProjectDetails(recentProject.id);
    expect(recentDetails?.workflowAggregate?.overallStatus).toBe("failed");
    expect(recentDetails?.workflowAggregate?.failed).toBe(1);
    expect(recentDetails?.operational?.runtimeStatus).toBe("failed");
    expect(recentDetails?.operational?.hottestWorkflowRunId).toBe(recentRun.run.id);
  });

  it("does not promote a stale terminal support workflow when unlinking the primary", () => {
    const db = getDb();
    const spec = createWorkflowSpec({
      id: "wf-spec-project-unlink-stale-support",
      title: "Project unlink stale support",
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
      runId: "wf-run-project-unlink-stale-primary",
      createdBy: "test",
    });
    const supportRun = startWorkflowRun(spec.id, {
      runId: "wf-run-project-unlink-stale-support",
      createdBy: "test",
    });
    createdWorkflowRunIds.push(primaryRun.run.id, supportRun.run.id);

    const project = createProject({ title: "Project Unlink Stale Support" });
    createdProjectIds.push(project.id);
    linkProject({
      projectRef: project.id,
      assetType: "workflow",
      assetId: primaryRun.run.id,
      role: "primary",
      createdBy: "test",
    });
    attachProjectWorkflowRun({
      projectRef: project.id,
      workflowRunId: supportRun.run.id,
      createdBy: "test",
    });

    const staleAt = Date.now() - TERMINAL_WORKFLOW_GRACE_MS - 60_000;
    db.prepare("UPDATE workflow_runs SET status = 'failed', updated_at = ? WHERE id = ?").run(
      staleAt,
      supportRun.run.id,
    );
    db.prepare("UPDATE project_links SET updated_at = ? WHERE project_id = ? AND asset_id = ?").run(
      staleAt,
      project.id,
      supportRun.run.id,
    );

    const detached = detachProjectWorkflowRun({
      projectRef: project.id,
      workflowRunId: primaryRun.run.id,
    });

    expect(detached.promotedPrimaryWorkflowRunId).toBeNull();
    expect(detached.details.linkedWorkflows).toHaveLength(1);
    expect(detached.details.linkedWorkflows[0]).toMatchObject({
      workflowRunId: supportRun.run.id,
      role: "support",
    });
    expect(detached.details.workflowAggregate).toMatchObject({
      total: 1,
      overallStatus: null,
      primaryWorkflowRunId: null,
      focusedWorkflowRunId: null,
    });
    expect(detached.details.operational?.runtimeStatus).toBeNull();
  });

  it("keeps recently failed runs with old links in the aggregate by using the run clock", () => {
    const db = getDb();
    const spec = createWorkflowSpec({
      id: "wf-spec-project-run-clock",
      title: "Project run clock",
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
    const freshFailedRun = startWorkflowRun(spec.id, {
      runId: "wf-run-project-fresh-failed",
      createdBy: "test",
    });
    const oldFailedRun = startWorkflowRun(spec.id, {
      runId: "wf-run-project-old-failed",
      createdBy: "test",
    });
    createdWorkflowRunIds.push(freshFailedRun.run.id, oldFailedRun.run.id);

    const freshProject = createProject({ title: "Fresh failed old link project" });
    const oldProject = createProject({ title: "Old failed old link project" });
    createdProjectIds.push(freshProject.id, oldProject.id);

    linkProject({
      projectRef: freshProject.id,
      assetType: "workflow",
      assetId: freshFailedRun.run.id,
      role: "primary",
      createdBy: "test",
    });
    linkProject({
      projectRef: oldProject.id,
      assetType: "workflow",
      assetId: oldFailedRun.run.id,
      role: "primary",
      createdBy: "test",
    });

    const staleAt = Date.now() - TERMINAL_WORKFLOW_GRACE_MS - 60_000;
    db.prepare("UPDATE workflow_runs SET status = 'failed', updated_at = ? WHERE id = ?").run(
      Date.now(),
      freshFailedRun.run.id,
    );
    db.prepare("UPDATE workflow_runs SET status = 'failed', updated_at = ? WHERE id = ?").run(
      staleAt,
      oldFailedRun.run.id,
    );
    db.prepare("UPDATE project_links SET updated_at = ?").run(staleAt);

    const freshDetails = getProjectDetails(freshProject.id);
    expect(freshDetails?.workflowAggregate?.overallStatus).toBe("failed");
    expect(freshDetails?.operational?.runtimeStatus).toBe("failed");

    const oldDetails = getProjectDetails(oldProject.id);
    expect(oldDetails?.workflowAggregate?.overallStatus).toBeNull();
    expect(oldDetails?.operational?.runtimeStatus).toBeNull();
  });

  it("rejects focusing a terminal workflow run and falls back when the focused run turns terminal", () => {
    const db = getDb();
    const spec = createWorkflowSpec({
      id: "wf-spec-project-terminal-focus",
      title: "Project terminal focus",
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
      runId: "wf-run-project-terminal-focus-first",
      createdBy: "test",
    });
    const secondRun = startWorkflowRun(spec.id, {
      runId: "wf-run-project-terminal-focus-second",
      createdBy: "test",
    });
    createdWorkflowRunIds.push(firstRun.run.id, secondRun.run.id);

    const project = createProject({ title: "Project Terminal Focus" });
    createdProjectIds.push(project.id);
    linkProject({
      projectRef: project.id,
      assetType: "workflow",
      assetId: firstRun.run.id,
      role: "primary",
      createdBy: "test",
    });
    attachProjectWorkflowRun({
      projectRef: project.id,
      workflowRunId: secondRun.run.id,
      createdBy: "test",
    });

    db.prepare("UPDATE workflow_runs SET status = 'failed' WHERE id = ?").run(secondRun.run.id);
    expect(() => setProjectFocusedWorkflow(project.id, secondRun.run.id)).toThrow(
      `Workflow ${secondRun.run.id} is terminal (status failed); focus requires an active run.`,
    );

    const focused = setProjectFocusedWorkflow(project.id, firstRun.run.id);
    expect(focused.details.workflowAggregate?.focusedWorkflowRunId).toBe(firstRun.run.id);

    db.prepare("UPDATE workflow_runs SET status = 'failed' WHERE id = ?").run(firstRun.run.id);
    const afterTerminal = getProjectDetails(project.id);
    expect(afterTerminal?.project.focusedWorkflowRunId).toBe(firstRun.run.id);
    expect(afterTerminal?.workflowAggregate?.focusedWorkflowRunId).toBe(secondRun.run.id);
  });

  it("keeps explicit focus stable across link touches and falls back to the heuristic when cleared", () => {
    const spec = createWorkflowSpec({
      id: "wf-spec-project-explicit-focus",
      title: "Project explicit focus",
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
      runId: "wf-run-project-focus-first",
      createdBy: "test",
    });
    const secondRun = startWorkflowRun(spec.id, {
      runId: "wf-run-project-focus-second",
      createdBy: "test",
    });
    const thirdRun = startWorkflowRun(spec.id, {
      runId: "wf-run-project-focus-third",
      createdBy: "test",
    });
    createdWorkflowRunIds.push(firstRun.run.id, secondRun.run.id, thirdRun.run.id);

    const project = createProject({ title: "Project Explicit Focus" });
    createdProjectIds.push(project.id);
    linkProject({
      projectRef: project.id,
      assetType: "workflow",
      assetId: firstRun.run.id,
      role: "primary",
      createdBy: "test",
    });
    attachProjectWorkflowRun({
      projectRef: project.id,
      workflowRunId: secondRun.run.id,
      createdBy: "test",
    });

    const focused = setProjectFocusedWorkflow(project.id, firstRun.run.id);
    expect(focused.focusedWorkflowRunId).toBe(firstRun.run.id);
    expect(focused.details.project.focusedWorkflowRunId).toBe(firstRun.run.id);
    expect(focused.details.workflowAggregate?.focusedWorkflowRunId).toBe(firstRun.run.id);

    linkProject({
      projectRef: project.id,
      assetType: "workflow",
      assetId: thirdRun.run.id,
      role: "support",
      createdBy: "test",
    });
    const afterLink = getProjectDetails(project.id);
    expect(afterLink?.workflowAggregate?.focusedWorkflowRunId).toBe(firstRun.run.id);

    const cleared = setProjectFocusedWorkflow(project.id, null);
    expect(cleared.focusedWorkflowRunId).toBeNull();
    expect(cleared.details.project.focusedWorkflowRunId).toBeUndefined();
    expect(cleared.details.workflowAggregate?.focusedWorkflowRunId).toBe(thirdRun.run.id);

    expect(() => setProjectFocusedWorkflow(project.id, "wf-run-not-linked")).toThrow(
      `Workflow wf-run-not-linked is not linked to project ${project.slug}.`,
    );
  });

  it("lists project tasks through the task -> node run -> run -> link chain with status filters", async () => {
    const spec = createWorkflowSpec({
      id: "wf-spec-project-task-list",
      title: "Project task list",
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
      runId: "wf-run-project-task-list",
      createdBy: "test",
    });
    createdWorkflowRunIds.push(run.run.id);

    const project = createProject({ title: "Project Task List" });
    createdProjectIds.push(project.id);
    linkProject({
      projectRef: project.id,
      assetType: "workflow",
      assetId: run.run.id,
      role: "primary",
      createdBy: "test",
    });

    const created = await createProjectTask({
      projectRef: project.id,
      nodeKey: "ship",
      title: "Ship attempt",
      instructions: "Execute the concrete workflow task",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    const tasks = listProjectTasks(project.id);
    expect(tasks).toEqual([
      expect.objectContaining({
        taskId: created.task.id,
        title: "Ship attempt",
        status: "open",
        nodeKey: "ship",
        nodeLabel: "Ship",
        workflowRunId: run.run.id,
        isCurrent: true,
      }),
    ]);

    expect(listProjectTasks(project.id, { status: "done" })).toEqual([]);
    expect(() => listProjectTasks("proj-missing")).toThrow("Project not found: proj-missing");
  });
});
