import {
  dbFindProjectByLinkedAsset,
  dbCreateProject,
  dbGetProjectDetails,
  dbListProjects,
  dbTouchProjectSignal,
  dbUpdateProject,
  dbUpsertProjectLink,
} from "./project-db.js";
import { rmSync } from "node:fs";
import type {
  AttachProjectWorkflowRunInput,
  AttachProjectWorkflowRunResult,
  AttachProjectTaskInput,
  AttachProjectTaskResult,
  CreateProjectInput,
  CreateProjectTaskInput,
  CreateProjectTaskResult,
  DispatchProjectTaskInput,
  DispatchProjectTaskResult,
  ProjectDetails,
  ProjectLink,
  ProjectLinkAssetType,
  ProjectListQuery,
  ProjectOperationalSurface,
  ProjectRecord,
  ProjectResourceLink,
  ProjectResourceType,
  ProjectStatus,
  ProjectStatusEntry,
  ProjectSummary,
  ProjectTaskActorInput,
  ProjectTaskDispatchOptions,
  ProjectTaskLaunchResult,
  ProjectTaskSurface,
  ProjectWorkflowAggregate,
  ProjectWorkflowDefaults,
  ProjectWorkflowLinkSurface,
  ProjectWorkflowLinkRole,
  StartProjectWorkflowRunInput,
  StartProjectWorkflowRunResult,
  UpdateProjectInput,
  UpsertProjectLinkInput,
} from "./types.js";
import {
  assertCanAttachTaskToWorkflowNodeRun,
  attachTaskToWorkflowNodeRun,
  getWorkflowRunDetails,
  startWorkflowRun,
} from "../workflows/index.js";
import type {
  WorkflowNodeRunMutationResult,
  WorkflowNodeRunStatus,
  WorkflowNodeRunView,
  WorkflowRunDetails,
  WorkflowRunStatus,
} from "../workflows/types.js";
import type { DispatchTaskInput, TaskRecord } from "../tasks/types.js";

const VALID_PROJECT_STATUSES = new Set<ProjectStatus>(["active", "paused", "blocked", "done", "archived"]);
const DEFAULT_PROJECT_HYPOTHESIS = "Needs hypothesis";
const DEFAULT_PROJECT_NEXT_STEP = "Define next step";
const WORKFLOW_STATUS_PRECEDENCE: WorkflowRunStatus[] = [
  "failed",
  "cancelled",
  "running",
  "blocked",
  "ready",
  "waiting",
  "draft",
  "done",
  "archived",
];
const WORKFLOW_HOT_PRECEDENCE: Array<WorkflowRunStatus | "missing"> = [
  "failed",
  "blocked",
  "running",
  "ready",
  "waiting",
  "draft",
  "cancelled",
  "done",
  "archived",
  "missing",
];
const NODE_HOT_PRECEDENCE: WorkflowNodeRunStatus[] = [
  "failed",
  "blocked",
  "running",
  "ready",
  "awaiting_release",
  "pending",
  "cancelled",
  "skipped",
  "done",
  "archived",
];
const PROJECT_STATUS_PRECEDENCE: ProjectStatus[] = ["active", "blocked", "paused", "done", "archived"];
const VALID_PROJECT_RESOURCE_TYPES = new Set<ProjectResourceType>([
  "repo",
  "worktree",
  "notion_page",
  "notion_database",
  "file",
  "url",
  "group",
  "contact",
]);
const VALID_PROJECT_WORKFLOW_ROLES = new Set<ProjectWorkflowLinkRole>(["primary", "support"]);

type WorkflowHeatCandidate = {
  link: ProjectWorkflowLinkSurface;
  details: WorkflowRunDetails | null;
};

function normalizeText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function slugifyProject(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function normalizeNullableText(value?: string | null): string | null | undefined {
  if (value === undefined) return undefined;
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeProjectResourceType(value: unknown): ProjectResourceType | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase() as ProjectResourceType;
  return VALID_PROJECT_RESOURCE_TYPES.has(normalized) ? normalized : null;
}

function toProjectResourceLink(link: ProjectLink): ProjectResourceLink | null {
  if (link.assetType !== "resource") {
    return null;
  }

  return {
    ...link,
    assetType: "resource",
    resourceType: normalizeProjectResourceType(link.metadata?.type),
    locator: normalizeNullableText(link.metadata?.locator as string | null | undefined) ?? link.assetId,
    label: normalizeNullableText(link.metadata?.label as string | null | undefined) ?? null,
  };
}

function matchProjectResourceLink(link: ProjectResourceLink, resourceRef: string): boolean {
  const normalizedRef = resourceRef.trim();
  if (!normalizedRef) {
    return false;
  }

  const normalizedNeedle = normalizedRef.toLowerCase();
  return (
    link.id === normalizedRef ||
    link.assetId === normalizedRef ||
    link.locator === normalizedRef ||
    (link.label ? link.label.toLowerCase() === normalizedNeedle : false)
  );
}

function buildProjectWorkflowSurface(link: ProjectDetails["links"][number]): ProjectWorkflowLinkSurface {
  const details = getWorkflowRunDetails(link.assetId);
  return {
    linkId: link.id,
    role: link.role ?? null,
    workflowRunId: link.assetId,
    workflowRunTitle: details?.run.title ?? null,
    workflowRunStatus: details?.run.status ?? null,
    workflowSpecId: details?.spec.id ?? null,
    workflowSpecTitle: details?.spec.title ?? null,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}

export function normalizeProjectWorkflowLinkRole(value?: string | null): ProjectWorkflowLinkRole {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Workflow link role is required.");
  }
  const canonical = normalized === "secondary" ? "support" : normalized;
  if (!VALID_PROJECT_WORKFLOW_ROLES.has(canonical as ProjectWorkflowLinkRole)) {
    throw new Error(`Invalid workflow link role: ${value}. Use primary|support.`);
  }
  return canonical as ProjectWorkflowLinkRole;
}

function compareWorkflowFocus(left: ProjectWorkflowLinkSurface, right: ProjectWorkflowLinkSurface): number {
  return (
    right.updatedAt - left.updatedAt ||
    right.createdAt - left.createdAt ||
    (left.role === "primary" ? -1 : 0) - (right.role === "primary" ? -1 : 0) ||
    left.workflowRunId.localeCompare(right.workflowRunId)
  );
}

function pickFocusedWorkflow(workflows: ProjectWorkflowLinkSurface[]): ProjectWorkflowLinkSurface | null {
  return [...workflows].sort(compareWorkflowFocus)[0] ?? null;
}

function deriveProjectWorkflowAggregate(workflows: ProjectWorkflowLinkSurface[]): ProjectWorkflowAggregate | null {
  if (workflows.length === 0) {
    return null;
  }

  const primary =
    workflows.find((workflow) => workflow.role === "primary") ??
    [...workflows].sort(
      (left, right) => right.updatedAt - left.updatedAt || left.workflowRunId.localeCompare(right.workflowRunId),
    )[0];
  const focused = pickFocusedWorkflow(workflows);

  const aggregate: ProjectWorkflowAggregate = {
    total: workflows.length,
    missing: 0,
    draft: 0,
    waiting: 0,
    ready: 0,
    running: 0,
    blocked: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    archived: 0,
    primaryWorkflowRunId: primary?.workflowRunId ?? null,
    primaryWorkflowTitle: primary?.workflowRunTitle ?? null,
    primaryWorkflowStatus: primary?.workflowRunStatus ?? null,
    focusedWorkflowRunId: focused?.workflowRunId ?? null,
    focusedWorkflowTitle: focused?.workflowRunTitle ?? null,
    focusedWorkflowStatus: focused?.workflowRunStatus ?? null,
    focusedWorkflowRole: focused?.role ?? null,
    overallStatus: null,
  };

  for (const workflow of workflows) {
    if (!workflow.workflowRunStatus) {
      aggregate.missing += 1;
      continue;
    }
    aggregate[workflow.workflowRunStatus] += 1;
  }

  for (const status of WORKFLOW_STATUS_PRECEDENCE) {
    if (aggregate[status] > 0) {
      aggregate.overallStatus = status;
      break;
    }
  }

  return aggregate;
}

function rankByOrder<T extends string>(value: T | null | undefined, order: readonly T[]): number {
  if (!value) return order.length;
  const index = order.indexOf(value);
  return index >= 0 ? index : order.length;
}

function compareWorkflowHeat(left: WorkflowHeatCandidate, right: WorkflowHeatCandidate): number {
  const leftStatus = left.details?.run.status ?? "missing";
  const rightStatus = right.details?.run.status ?? "missing";
  return (
    rankByOrder(leftStatus, WORKFLOW_HOT_PRECEDENCE) - rankByOrder(rightStatus, WORKFLOW_HOT_PRECEDENCE) ||
    (left.link.role === "primary" ? -1 : 0) - (right.link.role === "primary" ? -1 : 0) ||
    (right.details?.run.updatedAt ?? right.link.updatedAt) - (left.details?.run.updatedAt ?? left.link.updatedAt) ||
    left.link.workflowRunId.localeCompare(right.link.workflowRunId)
  );
}

function pickHottestWorkflow(workflows: ProjectWorkflowLinkSurface[]): WorkflowHeatCandidate | null {
  const candidates = workflows
    .map((workflow) => ({
      link: workflow,
      details: getWorkflowRunDetails(workflow.workflowRunId),
    }))
    .sort(compareWorkflowHeat);
  return candidates[0] ?? null;
}

function pickHottestNode(details: WorkflowRunDetails): WorkflowNodeRunView | null {
  const nodes = [...details.nodes];
  nodes.sort((left, right) => {
    return (
      rankByOrder(left.status, NODE_HOT_PRECEDENCE) - rankByOrder(right.status, NODE_HOT_PRECEDENCE) ||
      Number(Boolean(right.currentTask)) - Number(Boolean(left.currentTask)) ||
      (right.lastTaskTransitionAt ?? 0) - (left.lastTaskTransitionAt ?? 0) ||
      right.updatedAt - left.updatedAt ||
      left.specNodeKey.localeCompare(right.specNodeKey)
    );
  });
  return nodes[0] ?? null;
}

function deriveProjectOperationalSurface(
  workflows: ProjectWorkflowLinkSurface[],
  workflowAggregate: ProjectWorkflowAggregate | null,
): ProjectOperationalSurface | null {
  if (workflows.length === 0) {
    return null;
  }

  const hottestWorkflow = pickHottestWorkflow(workflows);
  const hottestNode = hottestWorkflow?.details ? pickHottestNode(hottestWorkflow.details) : null;
  const hottestTask = hottestNode?.currentTask ?? null;

  return {
    runtimeStatus:
      workflowAggregate?.overallStatus ??
      hottestWorkflow?.details?.run.status ??
      hottestWorkflow?.link.workflowRunStatus ??
      null,
    workflowCount: workflows.length,
    hottestWorkflowRunId: hottestWorkflow?.link.workflowRunId ?? null,
    hottestWorkflowTitle:
      hottestWorkflow?.details?.run.title ??
      hottestWorkflow?.link.workflowRunTitle ??
      hottestWorkflow?.link.workflowRunId ??
      null,
    hottestWorkflowStatus: hottestWorkflow?.details?.run.status ?? hottestWorkflow?.link.workflowRunStatus ?? null,
    hottestNodeRunId: hottestNode?.id ?? null,
    hottestNodeKey: hottestNode?.specNodeKey ?? null,
    hottestNodeLabel: hottestNode?.label ?? null,
    hottestNodeKind: hottestNode?.kind ?? null,
    hottestNodeRequirement: hottestNode?.requirement ?? null,
    hottestNodeReleaseMode: hottestNode?.releaseMode ?? null,
    hottestNodeStatus: hottestNode?.status ?? null,
    hottestTaskId: hottestTask?.id ?? null,
    hottestTaskTitle: hottestTask?.title ?? null,
    hottestTaskStatus: hottestTask?.status ?? null,
    hottestTaskProgress: hottestTask?.progress ?? null,
    hottestTaskPriority: hottestTask?.priority ?? null,
  };
}

function enrichProjectDetails(details: ProjectDetails): ProjectDetails {
  const linkedWorkflows = details.links
    .filter((link) => link.assetType === "workflow")
    .map(buildProjectWorkflowSurface);
  const workflowAggregate = deriveProjectWorkflowAggregate(linkedWorkflows);
  return {
    ...details,
    linkedWorkflows,
    workflowAggregate,
    operational: deriveProjectOperationalSurface(linkedWorkflows, workflowAggregate),
  };
}

export function normalizeProjectStatus(value?: string): ProjectStatus {
  const normalized = (value?.trim().toLowerCase() || "active") as ProjectStatus;
  if (!VALID_PROJECT_STATUSES.has(normalized)) {
    throw new Error(`Invalid project status: ${value}. Use active|paused|blocked|done|archived.`);
  }
  return normalized;
}

export function createProject(
  input: Omit<CreateProjectInput, "slug" | "summary" | "hypothesis" | "nextStep" | "lastSignalAt"> & {
    slug?: string;
    summary?: string;
    hypothesis?: string;
    nextStep?: string;
    lastSignalAt?: number;
  },
): ProjectRecord {
  const title = normalizeText(input.title, "Project title");
  const slug = slugifyProject(input.slug?.trim() || title);
  if (!slug) {
    throw new Error("Project slug is required.");
  }

  return dbCreateProject({
    ...input,
    title,
    slug,
    status: normalizeProjectStatus(input.status),
    summary: input.summary?.trim() ? input.summary.trim() : title,
    hypothesis: input.hypothesis?.trim() ? input.hypothesis.trim() : DEFAULT_PROJECT_HYPOTHESIS,
    nextStep: input.nextStep?.trim() ? input.nextStep.trim() : DEFAULT_PROJECT_NEXT_STEP,
    lastSignalAt: input.lastSignalAt ?? Date.now(),
    ownerAgentId: normalizeNullableText(input.ownerAgentId) ?? null,
    operatorSessionName: normalizeNullableText(input.operatorSessionName) ?? null,
  });
}

export function listProjects(query: ProjectListQuery = {}): ProjectSummary[] {
  return dbListProjects(query);
}

export function listProjectStatusEntries(query: ProjectListQuery = {}): ProjectStatusEntry[] {
  return dbListProjects(query)
    .map((summary) => {
      const details = getProjectDetails(summary.id);
      if (!details) {
        return {
          project: summary,
          links: [],
          linkedWorkflows: [],
          workflowAggregate: null,
          operational: null,
        } satisfies ProjectStatusEntry;
      }
      return {
        project: summary,
        links: details.links,
        linkedWorkflows: details.linkedWorkflows,
        workflowAggregate: details.workflowAggregate,
        operational: details.operational,
      } satisfies ProjectStatusEntry;
    })
    .sort((left, right) => {
      return (
        rankByOrder(left.operational?.runtimeStatus ?? "missing", WORKFLOW_HOT_PRECEDENCE) -
          rankByOrder(right.operational?.runtimeStatus ?? "missing", WORKFLOW_HOT_PRECEDENCE) ||
        rankByOrder(left.project.status, PROJECT_STATUS_PRECEDENCE) -
          rankByOrder(right.project.status, PROJECT_STATUS_PRECEDENCE) ||
        right.project.lastSignalAt - left.project.lastSignalAt ||
        left.project.slug.localeCompare(right.project.slug)
      );
    });
}

export function getProjectDetails(ref: string): ProjectDetails | null {
  const details = dbGetProjectDetails(normalizeText(ref, "Project reference"));
  return details ? enrichProjectDetails(details) : null;
}

export function listProjectLinks(ref: string, assetType?: ProjectLinkAssetType): ProjectLink[] {
  const details = getProjectDetails(ref);
  if (!details) {
    throw new Error(`Project not found: ${ref}`);
  }

  if (!assetType) {
    return details.links;
  }

  return details.links.filter((link) => link.assetType === assetType);
}

export function getProjectLink(ref: string, linkRef: string): ProjectLink | null {
  const normalizedRef = normalizeText(linkRef, "Link reference");
  return listProjectLinks(ref).find((link) => link.id === normalizedRef || link.assetId === normalizedRef) ?? null;
}

export function listProjectResourceLinks(ref: string, resourceType?: ProjectResourceType): ProjectResourceLink[] {
  const links = listProjectLinks(ref, "resource")
    .map(toProjectResourceLink)
    .filter((link): link is ProjectResourceLink => Boolean(link));

  if (!resourceType) {
    return links;
  }

  return links.filter((link) => link.resourceType === resourceType);
}

export function getProjectResourceLink(ref: string, resourceRef: string): ProjectResourceLink | null {
  const normalizedRef = normalizeText(resourceRef, "Resource reference");
  return listProjectResourceLinks(ref).find((link) => matchProjectResourceLink(link, normalizedRef)) ?? null;
}

export function getProjectSurfaceByWorkflowRunId(runId: string): ProjectTaskSurface | null {
  const normalizedRunId = normalizeText(runId, "Workflow run id");
  const linked = dbFindProjectByLinkedAsset("workflow", normalizedRunId);
  if (!linked) {
    return null;
  }

  const details = getProjectDetails(linked.project.id);
  const matchedWorkflow = details?.linkedWorkflows.find((workflow) => workflow.workflowRunId === normalizedRunId);
  if (!details || !matchedWorkflow) {
    return null;
  }

  return {
    projectId: details.project.id,
    projectSlug: details.project.slug,
    projectTitle: details.project.title,
    projectStatus: details.project.status,
    projectSummary: details.project.summary,
    projectNextStep: details.project.nextStep,
    projectLastSignalAt: details.project.lastSignalAt,
    workflowRunId: matchedWorkflow.workflowRunId,
    workflowRunTitle: matchedWorkflow.workflowRunTitle,
    workflowRunStatus: matchedWorkflow.workflowRunStatus,
    workflowLinkId: matchedWorkflow.linkId,
    workflowLinkRole: matchedWorkflow.role,
    workflowCount: details.linkedWorkflows.length,
    workflowAggregateStatus: details.workflowAggregate?.overallStatus ?? null,
    focusedWorkflowRunId: details.workflowAggregate?.focusedWorkflowRunId ?? null,
    focusedWorkflowTitle: details.workflowAggregate?.focusedWorkflowTitle ?? null,
    focusedWorkflowStatus: details.workflowAggregate?.focusedWorkflowStatus ?? null,
    focusedWorkflowRole: details.workflowAggregate?.focusedWorkflowRole ?? null,
    hottestWorkflowRunId: details.operational?.hottestWorkflowRunId ?? null,
    hottestWorkflowTitle: details.operational?.hottestWorkflowTitle ?? null,
    hottestWorkflowStatus: details.operational?.hottestWorkflowStatus ?? null,
    hottestNodeRunId: details.operational?.hottestNodeRunId ?? null,
    hottestNodeKey: details.operational?.hottestNodeKey ?? null,
    hottestNodeLabel: details.operational?.hottestNodeLabel ?? null,
    hottestNodeKind: details.operational?.hottestNodeKind ?? null,
    hottestNodeRequirement: details.operational?.hottestNodeRequirement ?? null,
    hottestNodeReleaseMode: details.operational?.hottestNodeReleaseMode ?? null,
    hottestNodeStatus: details.operational?.hottestNodeStatus ?? null,
    hottestTaskId: details.operational?.hottestTaskId ?? null,
    hottestTaskTitle: details.operational?.hottestTaskTitle ?? null,
    hottestTaskStatus: details.operational?.hottestTaskStatus ?? null,
    hottestTaskProgress: details.operational?.hottestTaskProgress ?? null,
    hottestTaskPriority: details.operational?.hottestTaskPriority ?? null,
  };
}

function resolveProjectWorkflowDefaults(project: ProjectRecord): ProjectWorkflowDefaults {
  return {
    ownerAgentId: normalizeNullableText(project.ownerAgentId) ?? null,
    operatorSessionName: normalizeNullableText(project.operatorSessionName) ?? null,
  };
}

function resolveProjectWorkflowRole(
  details: ProjectDetails,
  preferredRole?: ProjectWorkflowLinkRole | string | null,
): ProjectWorkflowLinkRole {
  if (preferredRole !== undefined && preferredRole !== null) {
    return normalizeProjectWorkflowLinkRole(preferredRole);
  }
  return details.workflowAggregate?.primaryWorkflowRunId ? "support" : "primary";
}

function resolveProjectActor(
  project: ProjectRecord,
  input: ProjectTaskActorInput,
): Required<ProjectWorkflowDefaults> & ProjectTaskActorInput {
  const defaults = resolveProjectWorkflowDefaults(project);
  const ownerAgentId = defaults.ownerAgentId ?? normalizeNullableText(input.createdByAgentId) ?? null;
  const operatorSessionName = defaults.operatorSessionName ?? normalizeNullableText(input.createdBySessionName) ?? null;
  return {
    ownerAgentId,
    operatorSessionName,
    createdBy: normalizeNullableText(input.createdBy) ?? operatorSessionName ?? undefined,
    createdByAgentId: ownerAgentId ?? undefined,
    createdBySessionName: operatorSessionName ?? undefined,
  };
}

function resolveProjectWorkflowActor(
  project: ProjectRecord,
  input: Pick<AttachProjectWorkflowRunInput, "createdBy" | "createdByAgentId" | "createdBySessionName">,
): Required<ProjectWorkflowDefaults> &
  Pick<AttachProjectWorkflowRunInput, "createdBy" | "createdByAgentId" | "createdBySessionName"> {
  return resolveProjectActor(project, input);
}

function requireProjectDetails(projectRef: string): ProjectDetails {
  const normalizedProjectRef = normalizeText(projectRef, "Project reference");
  const details = getProjectDetails(normalizedProjectRef);
  if (!details) {
    throw new Error(`Project not found: ${normalizedProjectRef}`);
  }
  return details;
}

function resolveProjectWorkflowForTaskOp(
  details: ProjectDetails,
  workflowRunId?: string | null,
): ProjectWorkflowLinkSurface {
  const normalizedRunId = normalizeNullableText(workflowRunId);
  if (normalizedRunId) {
    const linked = details.linkedWorkflows.find((workflow) => workflow.workflowRunId === normalizedRunId);
    if (!linked) {
      throw new Error(`Workflow ${normalizedRunId} is not linked to project ${details.project.slug}.`);
    }
    return linked;
  }

  const focusedRunId =
    details.workflowAggregate?.focusedWorkflowRunId ??
    details.workflowAggregate?.primaryWorkflowRunId ??
    (details.linkedWorkflows.length === 1 ? details.linkedWorkflows[0]?.workflowRunId : null);
  if (!focusedRunId) {
    throw new Error(`Project ${details.project.slug} has no focused workflow; pass --workflow explicitly.`);
  }

  const linked = details.linkedWorkflows.find((workflow) => workflow.workflowRunId === focusedRunId);
  if (!linked) {
    throw new Error(`Focused workflow ${focusedRunId} is not linked to project ${details.project.slug}.`);
  }
  return linked;
}

async function loadTaskRuntime(): Promise<typeof import("../tasks/index.js")> {
  return await import("../tasks/index.js");
}

function resolveProjectTaskDispatchInput(
  project: ProjectRecord,
  task: TaskRecord,
  input: ProjectTaskDispatchOptions & ProjectTaskActorInput & { dispatch?: boolean },
  actor: Required<ProjectWorkflowDefaults> & ProjectTaskActorInput,
  defaultSessionName: string,
  requireDispatch: boolean,
): DispatchTaskInput | null {
  const wantsDispatch =
    requireDispatch ||
    input.dispatch === true ||
    Boolean(normalizeNullableText(input.agentId)) ||
    Boolean(normalizeNullableText(input.sessionName));
  if (!wantsDispatch) {
    return null;
  }

  const agentId = normalizeNullableText(input.agentId) ?? actor.ownerAgentId;
  if (!agentId) {
    throw new Error(`Project ${project.slug} has no owner agent; pass --agent to dispatch task ${task.id}.`);
  }

  const sessionName = normalizeNullableText(input.sessionName) ?? actor.operatorSessionName ?? defaultSessionName;
  return {
    agentId,
    sessionName,
    assignedBy: actor.createdBy,
    ...(actor.createdByAgentId ? { assignedByAgentId: actor.createdByAgentId } : {}),
    ...(actor.createdBySessionName ? { assignedBySessionName: actor.createdBySessionName } : {}),
    ...(input.worktree ? { worktree: input.worktree } : {}),
    ...(typeof input.checkpointIntervalMs === "number" ? { checkpointIntervalMs: input.checkpointIntervalMs } : {}),
    ...(input.reportToSessionName ? { reportToSessionName: input.reportToSessionName } : {}),
    ...(input.reportEvents ? { reportEvents: input.reportEvents } : {}),
  };
}

function findLinkedWorkflowOrThrow(details: ProjectDetails, workflowRunId: string): ProjectWorkflowLinkSurface {
  const workflow = details.linkedWorkflows.find((entry) => entry.workflowRunId === workflowRunId);
  if (!workflow) {
    throw new Error(`Workflow ${workflowRunId} did not remain linked to project ${details.project.id}.`);
  }
  return workflow;
}

function cleanupCreatedTask(taskId: string, taskRuntime: typeof import("../tasks/index.js")): void {
  taskRuntime.dbDeleteTask(taskId);
  rmSync(taskRuntime.getCanonicalTaskDir(taskId), { recursive: true, force: true });
}

async function maybeDispatchProjectTask(
  project: ProjectRecord,
  task: TaskRecord,
  input: ProjectTaskDispatchOptions & ProjectTaskActorInput & { dispatch?: boolean },
  actor: Required<ProjectWorkflowDefaults> & ProjectTaskActorInput,
  requireDispatch: boolean,
): Promise<ProjectTaskLaunchResult | null> {
  const taskRuntime = await loadTaskRuntime();
  const dispatchInput = resolveProjectTaskDispatchInput(
    project,
    task,
    input,
    actor,
    taskRuntime.getDefaultTaskSessionNameForTask(task),
    requireDispatch,
  );
  return dispatchInput
    ? ((await taskRuntime.queueOrDispatchTask(task.id, dispatchInput)) as ProjectTaskLaunchResult)
    : null;
}

export function attachProjectWorkflowRun(input: AttachProjectWorkflowRunInput): AttachProjectWorkflowRunResult {
  const projectRef = normalizeText(input.projectRef, "Project reference");
  const workflowRunId = normalizeText(input.workflowRunId, "Workflow run id");
  const details = getProjectDetails(projectRef);
  if (!details) {
    throw new Error(`Project not found: ${projectRef}`);
  }

  const workflow = getWorkflowRunDetails(workflowRunId);
  if (!workflow) {
    throw new Error(`Workflow run not found: ${workflowRunId}`);
  }

  const actor = resolveProjectWorkflowActor(details.project, input);
  const role = resolveProjectWorkflowRole(details, input.role);
  const linkedDetails = linkProject({
    projectRef: details.project.id,
    assetType: "workflow",
    assetId: workflow.run.id,
    role,
    ...(actor.createdBy ? { createdBy: actor.createdBy } : {}),
    ...(actor.createdByAgentId ? { createdByAgentId: actor.createdByAgentId } : {}),
    ...(actor.createdBySessionName ? { createdBySessionName: actor.createdBySessionName } : {}),
  });
  const linkedWorkflow = linkedDetails.linkedWorkflows.find((entry) => entry.workflowRunId === workflow.run.id);
  if (!linkedWorkflow) {
    throw new Error(`Workflow ${workflow.run.id} did not remain linked to project ${linkedDetails.project.id}.`);
  }

  return {
    details: linkedDetails,
    workflow: linkedWorkflow,
    defaults: {
      ownerAgentId: actor.ownerAgentId,
      operatorSessionName: actor.operatorSessionName,
    },
  };
}

export function startProjectWorkflowRun(input: StartProjectWorkflowRunInput): StartProjectWorkflowRunResult {
  const projectRef = normalizeText(input.projectRef, "Project reference");
  const workflowSpecId = normalizeText(input.workflowSpecId, "Workflow spec id");
  const details = getProjectDetails(projectRef);
  if (!details) {
    throw new Error(`Project not found: ${projectRef}`);
  }

  const actor = resolveProjectWorkflowActor(details.project, input);
  const run = startWorkflowRun(workflowSpecId, {
    ...(input.workflowRunId?.trim() ? { runId: input.workflowRunId.trim() } : {}),
    ...(actor.createdBy ? { createdBy: actor.createdBy } : {}),
    ...(actor.createdByAgentId ? { createdByAgentId: actor.createdByAgentId } : {}),
    ...(actor.createdBySessionName ? { createdBySessionName: actor.createdBySessionName } : {}),
  });
  const attached = attachProjectWorkflowRun({
    projectRef: details.project.id,
    workflowRunId: run.run.id,
    ...(input.role ? { role: input.role } : {}),
    ...(actor.createdBy ? { createdBy: actor.createdBy } : {}),
    ...(actor.createdByAgentId ? { createdByAgentId: actor.createdByAgentId } : {}),
    ...(actor.createdBySessionName ? { createdBySessionName: actor.createdBySessionName } : {}),
  });

  return {
    ...attached,
    run,
  };
}

export async function createProjectTask(input: CreateProjectTaskInput): Promise<CreateProjectTaskResult> {
  const details = requireProjectDetails(input.projectRef);
  const workflow = resolveProjectWorkflowForTaskOp(details, input.workflowRunId);
  const nodeKey = normalizeText(input.nodeKey, "Workflow node key");
  assertCanAttachTaskToWorkflowNodeRun(workflow.workflowRunId, nodeKey);

  const actor = resolveProjectActor(details.project, input);
  const taskRuntime = await loadTaskRuntime();
  const created = taskRuntime.createTask({
    title: normalizeText(input.title, "Task title"),
    instructions: normalizeText(input.instructions, "Task instructions"),
    priority: input.priority ?? "normal",
    ...(input.profileId?.trim() ? { profileId: input.profileId.trim() } : {}),
    ...(input.parentTaskId?.trim() ? { parentTaskId: input.parentTaskId.trim() } : {}),
    ...(input.dependsOnTaskIds ? { dependsOnTaskIds: input.dependsOnTaskIds } : {}),
    ...(input.profileInput ? { profileInput: input.profileInput } : {}),
    ...(typeof input.checkpointIntervalMs === "number" ? { checkpointIntervalMs: input.checkpointIntervalMs } : {}),
    ...(input.reportToSessionName ? { reportToSessionName: input.reportToSessionName } : {}),
    ...(input.reportEvents ? { reportEvents: input.reportEvents } : {}),
    ...(actor.createdBy ? { createdBy: actor.createdBy } : {}),
    ...(actor.createdByAgentId ? { createdByAgentId: actor.createdByAgentId } : {}),
    ...(actor.createdBySessionName ? { createdBySessionName: actor.createdBySessionName } : {}),
    ...(input.worktree ? { worktree: input.worktree } : {}),
  });

  let attached: WorkflowNodeRunMutationResult;
  try {
    attached = attachTaskToWorkflowNodeRun(workflow.workflowRunId, nodeKey, created.task.id);
  } catch (error) {
    cleanupCreatedTask(created.task.id, taskRuntime);
    throw error;
  }

  const launch = await maybeDispatchProjectTask(details.project, created.task, input, actor, false);
  const refreshedDetails = requireProjectDetails(details.project.id);
  const refreshedWorkflow = findLinkedWorkflowOrThrow(refreshedDetails, workflow.workflowRunId);

  return {
    details: refreshedDetails,
    workflow: refreshedWorkflow,
    defaults: {
      ownerAgentId: actor.ownerAgentId,
      operatorSessionName: actor.operatorSessionName,
    },
    task: launch?.task ?? created.task,
    createdTask: created.task,
    event: created.event,
    relatedEvents: created.relatedEvents,
    attached,
    launch,
  };
}

export async function attachProjectTask(input: AttachProjectTaskInput): Promise<AttachProjectTaskResult> {
  const details = requireProjectDetails(input.projectRef);
  const workflow = resolveProjectWorkflowForTaskOp(details, input.workflowRunId);
  const nodeKey = normalizeText(input.nodeKey, "Workflow node key");
  const taskRuntime = await loadTaskRuntime();
  const existingTask = taskRuntime.dbGetTask(normalizeText(input.taskId, "Task id"));
  if (!existingTask) {
    throw new Error(`Task not found: ${input.taskId}`);
  }

  const actor = resolveProjectActor(details.project, input);
  const attached = attachTaskToWorkflowNodeRun(workflow.workflowRunId, nodeKey, existingTask.id);
  const launch = await maybeDispatchProjectTask(details.project, existingTask, input, actor, false);
  const refreshedTask = launch?.task ?? taskRuntime.dbGetTask(existingTask.id);
  if (!refreshedTask) {
    throw new Error(`Task not found after attach: ${existingTask.id}`);
  }

  const refreshedDetails = requireProjectDetails(details.project.id);
  const refreshedWorkflow = findLinkedWorkflowOrThrow(refreshedDetails, workflow.workflowRunId);
  return {
    details: refreshedDetails,
    workflow: refreshedWorkflow,
    defaults: {
      ownerAgentId: actor.ownerAgentId,
      operatorSessionName: actor.operatorSessionName,
    },
    task: refreshedTask,
    attached,
    launch,
  };
}

export async function dispatchProjectTask(input: DispatchProjectTaskInput): Promise<DispatchProjectTaskResult> {
  const details = requireProjectDetails(input.projectRef);
  const actor = resolveProjectActor(details.project, input);
  const taskRuntime = await loadTaskRuntime();
  const task = taskRuntime.dbGetTask(normalizeText(input.taskId, "Task id"));
  if (!task) {
    throw new Error(`Task not found: ${input.taskId}`);
  }

  const existingProject = taskRuntime.getTaskProjectSurface(task.id);
  if (existingProject && existingProject.projectId !== details.project.id) {
    throw new Error(
      `Task ${task.id} belongs to project ${existingProject.projectSlug}; cannot dispatch from ${details.project.slug}.`,
    );
  }

  const launch = await maybeDispatchProjectTask(details.project, task, input, actor, true);
  if (!launch) {
    throw new Error(`Project ${details.project.slug} did not resolve a dispatch target for task ${task.id}.`);
  }

  return {
    details: requireProjectDetails(details.project.id),
    defaults: {
      ownerAgentId: actor.ownerAgentId,
      operatorSessionName: actor.operatorSessionName,
    },
    task: launch.task,
    project: taskRuntime.getTaskProjectSurface(task.id),
    launch,
  };
}

export function updateProject(ref: string, input: UpdateProjectInput): ProjectRecord {
  const normalizedRef = normalizeText(ref, "Project reference");
  const normalizedInput: UpdateProjectInput = {};

  if (input.title !== undefined) normalizedInput.title = normalizeText(input.title, "Project title");
  if (input.status !== undefined) normalizedInput.status = normalizeProjectStatus(input.status);
  if (input.summary !== undefined) normalizedInput.summary = normalizeText(input.summary, "Project summary");
  if (input.hypothesis !== undefined)
    normalizedInput.hypothesis = normalizeText(input.hypothesis, "Project hypothesis");
  if (input.nextStep !== undefined) normalizedInput.nextStep = normalizeText(input.nextStep, "Project next step");
  if (input.lastSignalAt !== undefined) normalizedInput.lastSignalAt = input.lastSignalAt;
  if (Object.prototype.hasOwnProperty.call(input, "ownerAgentId")) {
    normalizedInput.ownerAgentId = normalizeNullableText(input.ownerAgentId) ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(input, "operatorSessionName")) {
    normalizedInput.operatorSessionName = normalizeNullableText(input.operatorSessionName) ?? null;
  }

  return dbUpdateProject(normalizedRef, normalizedInput);
}

export function linkProject(input: UpsertProjectLinkInput & { lastSignalAt?: number }): ProjectDetails {
  const normalizedProjectRef = normalizeText(input.projectRef, "Project reference");
  const normalizedAssetId = normalizeText(input.assetId, "Link target");
  dbUpsertProjectLink({
    ...input,
    projectRef: normalizedProjectRef,
    assetId: normalizedAssetId,
    role: normalizeNullableText(input.role) ?? null,
  });
  dbTouchProjectSignal(normalizedProjectRef, input.lastSignalAt ?? Date.now());
  return getProjectDetails(normalizedProjectRef)!;
}
