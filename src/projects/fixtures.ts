import { rmSync } from "node:fs";
import { join } from "node:path";
import { createProject, getProjectDetails, linkProject } from "./index.js";
import type { ProjectResourceType, ProjectStatus } from "./types.js";
import { getAgent } from "../router/index.js";
import { getDb } from "../router/router-db.js";
import { deleteSessionByName, getOrCreateSession } from "../router/sessions.js";
import {
  blockTask,
  completeTask,
  createTask,
  dbDeleteTask,
  getCanonicalTaskDir,
  reportTaskProgress,
} from "../tasks/index.js";
import {
  attachTaskToWorkflowNodeRun,
  createWorkflowSpec,
  getWorkflowRunDetails,
  startWorkflowRun,
  syncWorkflowNodeRunForTask,
} from "../workflows/index.js";

type FixtureTaskState = "in_progress" | "blocked" | "done";

interface CanonicalFixtureTaskDefinition {
  nodeKey: string;
  title: string;
  instructions: string;
  priority: "normal" | "high";
  finalState: FixtureTaskState;
  message: string;
  progress?: number;
}

interface CanonicalFixtureResourceDefinition {
  assetId: string;
  type: ProjectResourceType;
  label: string;
  role: string;
  metadata?: Record<string, unknown>;
}

interface CanonicalFixtureDefinition {
  key: string;
  project: {
    slug: string;
    title: string;
    status: ProjectStatus;
    summary: string;
    hypothesis: string;
    nextStep: string;
  };
  sessionName: string;
  workflow: {
    specId: string;
    runId: string;
    title: string;
    nodes: Array<{
      key: string;
      label: string;
      kind: "task";
      requirement: "required" | "optional";
      releaseMode: "auto" | "manual";
    }>;
    edges: Array<{ from: string; to: string }>;
  };
  resource: CanonicalFixtureResourceDefinition;
  tasks: CanonicalFixtureTaskDefinition[];
}

export interface SeededCanonicalProjectFixtureTask {
  nodeKey: string;
  taskId: string;
  title: string;
  status: string;
}

export interface SeededCanonicalProjectFixture {
  key: string;
  projectId: string;
  projectSlug: string;
  projectTitle: string;
  projectStatus: ProjectStatus;
  workflowSpecId: string;
  workflowRunId: string;
  workflowStatus: string | null;
  operatorSessionName: string;
  resourceAssetId: string;
  resourceType: ProjectResourceType;
  tasks: SeededCanonicalProjectFixtureTask[];
  proofCommands: string[];
}

export interface SeedCanonicalProjectFixturesResult {
  generatedAt: number;
  total: number;
  fixtures: SeededCanonicalProjectFixture[];
}

export interface SeedCanonicalProjectFixturesOptions {
  ownerAgentId?: string;
  actor?: string;
  actorAgentId?: string;
  actorSessionName?: string;
}

const fixtureWorktree = process.env.RAVI_FIXTURE_WORKTREE ?? process.env.RAVI_REPO ?? process.cwd();

const CANONICAL_PROJECT_FIXTURES: CanonicalFixtureDefinition[] = [
  {
    key: "ops-cadence",
    project: {
      slug: "demo-ops-cadence",
      title: "Ops Cadence",
      status: "active",
      summary: "Keep day-to-day release work aligned through one workflow-backed project surface.",
      hypothesis:
        "The workflow run should stay as the primary attachment while sessions and resources stay cheap links.",
      nextStep: "Review the release blockers and decide whether ship can start.",
    },
    sessionName: "demo-ops-cadence-room",
    workflow: {
      specId: "wf-spec-demo-ops-cadence",
      runId: "wf-run-demo-ops-cadence",
      title: "Ops Cadence",
      nodes: [
        { key: "triage", label: "Triage", kind: "task", requirement: "required", releaseMode: "auto" },
        { key: "ship", label: "Ship", kind: "task", requirement: "required", releaseMode: "auto" },
      ],
      edges: [{ from: "triage", to: "ship" }],
    },
    resource: {
      assetId: fixtureWorktree,
      type: "worktree",
      label: "ravi.bot worktree",
      role: "substrate",
      metadata: {
        lane: "core",
      },
    },
    tasks: [
      {
        nodeKey: "triage",
        title: "Audit the release queue",
        instructions: "Review the current release blockers and confirm ownership before opening the ship node.",
        priority: "high",
        finalState: "in_progress",
        progress: 42,
        message: "Triaging open release blockers and confirming who owns the last unresolved check.",
      },
    ],
  },
  {
    key: "launch-copy-refresh",
    project: {
      slug: "demo-launch-copy-refresh",
      title: "Launch Copy Refresh",
      status: "blocked",
      summary: "Coordinate launch copy work with explicit workflow state and a concrete blocker.",
      hypothesis: "Project status should stay readable even when the workflow is blocked on one concrete task.",
      nextStep: "Resolve the compliance wording so publish can be released.",
    },
    sessionName: "demo-launch-copy-refresh-room",
    workflow: {
      specId: "wf-spec-demo-launch-copy-refresh",
      runId: "wf-run-demo-launch-copy-refresh",
      title: "Launch Copy Refresh",
      nodes: [
        { key: "draft", label: "Draft", kind: "task", requirement: "required", releaseMode: "auto" },
        { key: "legal", label: "Legal", kind: "task", requirement: "required", releaseMode: "auto" },
        { key: "publish", label: "Publish", kind: "task", requirement: "required", releaseMode: "auto" },
      ],
      edges: [
        { from: "draft", to: "legal" },
        { from: "legal", to: "publish" },
      ],
    },
    resource: {
      assetId: join(fixtureWorktree, "README.md"),
      type: "file",
      label: "Launch copy brief",
      role: "brief",
      metadata: {
        audience: "launch",
      },
    },
    tasks: [
      {
        nodeKey: "draft",
        title: "Write the refreshed launch copy",
        instructions: "Produce the revised hero copy, CTA, and pricing paragraph for review.",
        priority: "high",
        finalState: "done",
        message: "Draft and CTA variants approved for legal review.",
      },
      {
        nodeKey: "legal",
        title: "Clear the pricing claim with legal",
        instructions: "Validate the final pricing statement and capture the approved wording.",
        priority: "high",
        finalState: "blocked",
        progress: 61,
        message: "Blocked on final compliance wording for the pricing claim.",
      },
    ],
  },
  {
    key: "founder-intake-automation",
    project: {
      slug: "demo-founder-intake-automation",
      title: "Founder Intake Automation",
      status: "done",
      summary: "Show a completed project that still keeps its workflow and task lineage visible for demos.",
      hypothesis: "Finished work should remain explorable without adding project ownership columns to tasks.",
      nextStep: "Archive after the next demo loop if nobody needs the live context anymore.",
    },
    sessionName: "demo-founder-intake-automation-room",
    workflow: {
      specId: "wf-spec-demo-founder-intake-automation",
      runId: "wf-run-demo-founder-intake-automation",
      title: "Founder Intake Automation",
      nodes: [
        { key: "scoping", label: "Scoping", kind: "task", requirement: "required", releaseMode: "auto" },
        { key: "handoff", label: "Handoff", kind: "task", requirement: "required", releaseMode: "auto" },
      ],
      edges: [{ from: "scoping", to: "handoff" }],
    },
    resource: {
      assetId: "https://github.com/filipexyz/ravi",
      type: "url",
      label: "Founder intake demo thread",
      role: "reference",
      metadata: {
        source: "demo",
      },
    },
    tasks: [
      {
        nodeKey: "scoping",
        title: "Map the intake constraints",
        instructions: "Capture the founder intake happy path and the minimum operator fallbacks.",
        priority: "normal",
        finalState: "done",
        message: "Captured intake constraints and mapped the happy path.",
      },
      {
        nodeKey: "handoff",
        title: "Ship the operator handoff checklist",
        instructions: "Publish the operator checklist and the first-response handoff script.",
        priority: "normal",
        finalState: "done",
        message: "Bot handoff script and operator checklist shipped.",
      },
    ],
  },
];

function buildActor(options: SeedCanonicalProjectFixturesOptions) {
  return {
    createdBy: options.actor ?? "projects.fixtures.seed",
    ...(options.actorAgentId ? { createdByAgentId: options.actorAgentId } : {}),
    ...(options.actorSessionName ? { createdBySessionName: options.actorSessionName } : {}),
  };
}

function ensureFixtureSession(sessionName: string, ownerAgentId: string) {
  const agent = getAgent(ownerAgentId);
  if (!agent) {
    throw new Error(`Agent not found: ${ownerAgentId}`);
  }

  return getOrCreateSession(`agent:${ownerAgentId}:fixture:${sessionName}`, ownerAgentId, agent.cwd, {
    name: sessionName,
  });
}

function collectFixtureTaskIds(): string[] {
  const taskIds = new Set<string>();

  for (const fixture of CANONICAL_PROJECT_FIXTURES) {
    const details = getWorkflowRunDetails(fixture.workflow.runId);
    if (!details) {
      continue;
    }

    for (const node of details.nodes) {
      if (node.currentTask?.id) {
        taskIds.add(node.currentTask.id);
      }
      for (const attempt of node.taskAttempts) {
        taskIds.add(attempt.taskId);
      }
    }
  }

  return [...taskIds];
}

export function clearCanonicalProjectFixtures(): void {
  getProjectDetails("__fixture-bootstrap__");
  const db = getDb();
  const taskIds = collectFixtureTaskIds();

  for (const taskId of taskIds) {
    dbDeleteTask(taskId);
    rmSync(getCanonicalTaskDir(taskId), { recursive: true, force: true });
  }

  for (const fixture of CANONICAL_PROJECT_FIXTURES) {
    db.prepare("DELETE FROM workflow_runs WHERE id = ?").run(fixture.workflow.runId);
    db.prepare("DELETE FROM workflow_specs WHERE id = ?").run(fixture.workflow.specId);
    db.prepare("DELETE FROM projects WHERE slug = ?").run(fixture.project.slug);
    deleteSessionByName(fixture.sessionName);
  }
}

async function materializeFixtureTaskState(
  taskId: string,
  task: CanonicalFixtureTaskDefinition,
  actor: string,
  sessionName: string,
): Promise<string> {
  switch (task.finalState) {
    case "in_progress": {
      const result = reportTaskProgress(taskId, {
        actor,
        sessionName,
        message: task.message,
        progress: task.progress ?? 35,
      });
      syncWorkflowNodeRunForTask(taskId);
      return result.task.status;
    }
    case "blocked": {
      const result = blockTask(taskId, {
        actor,
        sessionName,
        message: task.message,
        progress: task.progress ?? 50,
      });
      return result.task.status;
    }
    case "done": {
      const result = await completeTask(taskId, {
        actor,
        sessionName,
        message: task.message,
      });
      return result.task.status;
    }
  }
}

export async function seedCanonicalProjectFixtures(
  options: SeedCanonicalProjectFixturesOptions = {},
): Promise<SeedCanonicalProjectFixturesResult> {
  clearCanonicalProjectFixtures();

  const ownerAgentId = options.ownerAgentId ?? "main";
  const actor = buildActor(options);
  const fixtures: SeededCanonicalProjectFixture[] = [];

  for (const fixture of CANONICAL_PROJECT_FIXTURES) {
    const operatorSession = ensureFixtureSession(fixture.sessionName, ownerAgentId);

    createWorkflowSpec({
      id: fixture.workflow.specId,
      title: fixture.workflow.title,
      summary: fixture.project.summary,
      nodes: fixture.workflow.nodes,
      edges: fixture.workflow.edges,
      ...actor,
    });

    startWorkflowRun(fixture.workflow.specId, {
      runId: fixture.workflow.runId,
      ...actor,
    });

    const project = createProject({
      title: fixture.project.title,
      slug: fixture.project.slug,
      status: fixture.project.status,
      summary: fixture.project.summary,
      hypothesis: fixture.project.hypothesis,
      nextStep: fixture.project.nextStep,
      ownerAgentId,
      operatorSessionName: operatorSession.name ?? fixture.sessionName,
      ...actor,
    });

    linkProject({
      projectRef: project.id,
      assetType: "workflow",
      assetId: fixture.workflow.runId,
      role: "primary",
      ...actor,
    });
    linkProject({
      projectRef: project.id,
      assetType: "session",
      assetId: operatorSession.name ?? fixture.sessionName,
      role: "operator",
      ...actor,
    });
    linkProject({
      projectRef: project.id,
      assetType: "agent",
      assetId: ownerAgentId,
      role: "owner",
      ...actor,
    });
    linkProject({
      projectRef: project.id,
      assetType: "resource",
      assetId: fixture.resource.assetId,
      role: fixture.resource.role,
      metadata: {
        ...(fixture.resource.metadata ?? {}),
        type: fixture.resource.type,
        label: fixture.resource.label,
        locator: fixture.resource.assetId,
      },
      ...actor,
    });

    const seededTasks: SeededCanonicalProjectFixtureTask[] = [];
    for (const task of fixture.tasks) {
      const created = createTask({
        title: task.title,
        instructions: task.instructions,
        priority: task.priority,
        ...actor,
      });

      attachTaskToWorkflowNodeRun(fixture.workflow.runId, task.nodeKey, created.task.id);
      const status = await materializeFixtureTaskState(
        created.task.id,
        task,
        actor.createdBy,
        operatorSession.name ?? fixture.sessionName,
      );

      seededTasks.push({
        nodeKey: task.nodeKey,
        taskId: created.task.id,
        title: task.title,
        status,
      });
    }

    const details = getProjectDetails(project.id);
    fixtures.push({
      key: fixture.key,
      projectId: project.id,
      projectSlug: fixture.project.slug,
      projectTitle: fixture.project.title,
      projectStatus: fixture.project.status,
      workflowSpecId: fixture.workflow.specId,
      workflowRunId: fixture.workflow.runId,
      workflowStatus: details?.workflowAggregate?.overallStatus ?? null,
      operatorSessionName: operatorSession.name ?? fixture.sessionName,
      resourceAssetId: fixture.resource.assetId,
      resourceType: fixture.resource.type,
      tasks: seededTasks,
      proofCommands: [
        `ravi projects status ${fixture.project.slug}`,
        `ravi projects show ${fixture.project.slug}`,
        `ravi workflows runs show ${fixture.workflow.runId}`,
        ...seededTasks.map((task) => `ravi tasks show ${task.taskId}`),
      ],
    });
  }

  return {
    generatedAt: Date.now(),
    total: fixtures.length,
    fixtures,
  };
}
