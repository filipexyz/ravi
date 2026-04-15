import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  dbCreateWorkflowRun,
  dbCreateWorkflowSpec,
  dbGetWorkflowNodeRunByKey,
  dbGetWorkflowNodeRunByTaskId,
  dbGetWorkflowRun,
  dbGetWorkflowSpec,
  dbInsertWorkflowNodeRuns,
  dbInsertWorkflowRunEdges,
  dbLinkTaskToWorkflowNodeRun,
  dbListWorkflowNodeRuns,
  dbListWorkflowNodeRunTaskAttempts,
  dbListWorkflowRunEdges,
  dbListWorkflowRuns,
  dbListWorkflowSpecs,
  dbUpdateWorkflowNodeRun,
  dbUpdateWorkflowRun,
} from "./workflow-db.js";
import { dbGetActiveAssignment, dbGetTask, dbListTaskDependencies } from "../tasks/task-db.js";
import type { TaskAssignment, TaskReadiness, TaskRecord, TaskStatus } from "../tasks/types.js";
import type {
  CreateWorkflowSpecInput,
  StartWorkflowRunInput,
  WorkflowActorInput,
  WorkflowNodeKind,
  WorkflowNodeReleaseMode,
  WorkflowNodeRequirement,
  WorkflowNodeRun,
  WorkflowNodeRunMutationResult,
  WorkflowNodeRunView,
  WorkflowRun,
  WorkflowRunCounts,
  WorkflowRunDetails,
  WorkflowRunEdge,
  WorkflowRunTaskSurface,
  WorkflowSpec,
  WorkflowSpecEdge,
  WorkflowSpecNode,
  WorkflowSpecPolicy,
} from "./types.js";

const WorkflowSpecNodeSchema = z.object({
  key: z.string().trim().min(1),
  label: z.string().trim().min(1),
  kind: z.enum(["task", "gate", "approval"]).optional(),
  requirement: z.enum(["required", "optional"]).optional(),
  releaseMode: z.enum(["auto", "manual"]).optional(),
});

const WorkflowSpecEdgeSchema = z.object({
  from: z.string().trim().min(1),
  to: z.string().trim().min(1),
});

export const WorkflowSpecDefinitionSchema = z.object({
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1).optional(),
  policy: z
    .object({
      completionMode: z.literal("all_required").optional(),
    })
    .partial()
    .optional(),
  nodes: z.array(WorkflowSpecNodeSchema).min(1),
  edges: z.array(WorkflowSpecEdgeSchema).optional(),
});

function normalizeNode(input: z.infer<typeof WorkflowSpecNodeSchema>): WorkflowSpecNode {
  const kind: WorkflowNodeKind = input.kind ?? "task";
  const requirement: WorkflowNodeRequirement = input.requirement ?? "required";
  const releaseMode: WorkflowNodeReleaseMode = input.releaseMode ?? (kind === "task" ? "auto" : "manual");
  if (kind !== "task" && releaseMode !== "manual") {
    throw new Error(`Node ${input.key} (${kind}) must use releaseMode=manual.`);
  }
  return {
    key: input.key,
    label: input.label,
    kind,
    requirement,
    releaseMode,
  };
}

function normalizePolicy(policy?: WorkflowSpecPolicy | null): WorkflowSpecPolicy {
  return {
    completionMode: policy?.completionMode ?? "all_required",
  };
}

function validateWorkflowGraph(nodes: WorkflowSpecNode[], edges: WorkflowSpecEdge[]): void {
  const nodeKeys = new Set<string>();
  for (const node of nodes) {
    if (nodeKeys.has(node.key)) {
      throw new Error(`Duplicate workflow node key: ${node.key}`);
    }
    nodeKeys.add(node.key);
  }

  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    if (!nodeKeys.has(edge.from)) {
      throw new Error(`Workflow edge references missing from node: ${edge.from}`);
    }
    if (!nodeKeys.has(edge.to)) {
      throw new Error(`Workflow edge references missing to node: ${edge.to}`);
    }
    if (edge.from === edge.to) {
      throw new Error(`Workflow edge cannot point to itself: ${edge.from}`);
    }
    const key = `${edge.from}->${edge.to}`;
    if (edgeKeys.has(key)) {
      throw new Error(`Duplicate workflow edge: ${key}`);
    }
    edgeKeys.add(key);
  }

  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(node.key, []);
  }
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (nodeKey: string) => {
    if (visiting.has(nodeKey)) {
      throw new Error(`Workflow graph must be acyclic. Cycle detected at ${nodeKey}.`);
    }
    if (visited.has(nodeKey)) {
      return;
    }
    visiting.add(nodeKey);
    for (const next of adjacency.get(nodeKey) ?? []) {
      visit(next);
    }
    visiting.delete(nodeKey);
    visited.add(nodeKey);
  };

  for (const node of nodes) {
    visit(node.key);
  }
}

function normalizeSpecInput(input: CreateWorkflowSpecInput): CreateWorkflowSpecInput {
  const parsed = WorkflowSpecDefinitionSchema.parse({
    title: input.title,
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.policy ? { policy: input.policy } : {}),
    nodes: input.nodes,
    ...(input.edges ? { edges: input.edges } : {}),
  });
  const nodes = parsed.nodes.map(normalizeNode);
  const edges = parsed.edges ?? [];
  validateWorkflowGraph(nodes, edges);

  return {
    ...(input.id?.trim() ? { id: input.id.trim() } : {}),
    title: parsed.title,
    ...(parsed.summary ? { summary: parsed.summary } : {}),
    policy: normalizePolicy(parsed.policy),
    nodes,
    edges,
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    ...(input.createdByAgentId ? { createdByAgentId: input.createdByAgentId } : {}),
    ...(input.createdBySessionName ? { createdBySessionName: input.createdBySessionName } : {}),
  };
}

function buildIncomingNodeKeys(spec: WorkflowSpec): Map<string, string[]> {
  const incoming = new Map<string, string[]>();
  for (const node of spec.nodes) {
    incoming.set(node.key, []);
  }
  for (const edge of spec.edges) {
    incoming.get(edge.to)?.push(edge.from);
  }
  return incoming;
}

function buildNodeMaps(nodeRuns: WorkflowNodeRun[], edges: WorkflowRunEdge[]) {
  const byId = new Map(nodeRuns.map((nodeRun) => [nodeRun.id, nodeRun]));
  const byKey = new Map(nodeRuns.map((nodeRun) => [nodeRun.specNodeKey, nodeRun]));
  const incoming = new Map<string, WorkflowNodeRun[]>();
  const outgoing = new Map<string, WorkflowNodeRun[]>();
  for (const nodeRun of nodeRuns) {
    incoming.set(nodeRun.id, []);
    outgoing.set(nodeRun.id, []);
  }
  for (const edge of edges) {
    const from = byId.get(edge.fromNodeRunId);
    const to = byId.get(edge.toNodeRunId);
    if (from && to) {
      outgoing.get(from.id)?.push(to);
      incoming.get(to.id)?.push(from);
    }
  }
  return { byId, byKey, incoming, outgoing };
}

function shouldAwaitManualRelease(nodeRun: Pick<WorkflowNodeRun, "kind" | "releaseMode" | "releasedAt">): boolean {
  return (nodeRun.kind !== "task" || nodeRun.releaseMode === "manual") && typeof nodeRun.releasedAt !== "number";
}

function nodeRunSatisfiesOutgoingEdges(nodeRun: WorkflowNodeRun): boolean {
  if (nodeRun.status === "done") {
    return true;
  }
  if (nodeRun.status === "archived") {
    return true;
  }
  return (nodeRun.status === "skipped" || nodeRun.status === "cancelled") && nodeRun.requirement === "optional";
}

function getWorkflowNodeRunPreconditions(
  nodeRun: WorkflowNodeRun,
  nodeRuns = dbListWorkflowNodeRuns(nodeRun.workflowRunId),
  edges = dbListWorkflowRunEdges(nodeRun.workflowRunId),
): {
  waitingOnNodeKeys: string[];
  awaitingRelease: boolean;
} {
  const { incoming } = buildNodeMaps(nodeRuns, edges);
  const predecessors = incoming.get(nodeRun.id) ?? [];
  const waitingOnNodeKeys = predecessors
    .filter((predecessor) => !nodeRunSatisfiesOutgoingEdges(predecessor))
    .map((predecessor) => predecessor.specNodeKey);
  return {
    waitingOnNodeKeys,
    awaitingRelease: waitingOnNodeKeys.length === 0 && shouldAwaitManualRelease(nodeRun),
  };
}

function deriveWorkflowNodeRunStatusForBoundTask(
  nodeRun: WorkflowNodeRun,
  task: TaskRecord,
  activeAssignment?: TaskAssignment | null,
  preconditions = getWorkflowNodeRunPreconditions(nodeRun),
): {
  status: WorkflowNodeRun["status"];
  waitingOnNodeKeys: string[];
} {
  if (preconditions.waitingOnNodeKeys.length > 0) {
    return {
      status: "pending",
      waitingOnNodeKeys: preconditions.waitingOnNodeKeys,
    };
  }
  if (preconditions.awaitingRelease) {
    return {
      status: "awaiting_release",
      waitingOnNodeKeys: [],
    };
  }
  return {
    status: deriveWorkflowNodeRunStatusFromTask(task, activeAssignment),
    waitingOnNodeKeys: [],
  };
}

function deriveTaskLifecycleStatus(
  task: Pick<TaskRecord, "status">,
  activeAssignment?: Pick<TaskAssignment, "status" | "acceptedAt"> | null,
): TaskStatus {
  if (
    task.status === "dispatched" &&
    activeAssignment &&
    (activeAssignment.status === "accepted" || typeof activeAssignment.acceptedAt === "number")
  ) {
    return "in_progress";
  }
  return task.status;
}

function deriveTaskReadiness(task: TaskRecord, activeAssignment?: TaskAssignment | null): TaskReadiness {
  const unsatisfiedDependencyCount = dbListTaskDependencies(task.id).filter(
    (dependency) => !dependency.satisfiedAt,
  ).length;
  const activeStatus = deriveTaskLifecycleStatus(task, activeAssignment);

  if (activeStatus === "done" || activeStatus === "failed") {
    return {
      state: "terminal",
      label: `terminal (${activeStatus})`,
      canStart: false,
      dependencyCount: unsatisfiedDependencyCount,
      satisfiedDependencyCount: 0,
      unsatisfiedDependencyCount,
      unsatisfiedDependencyIds: [],
      hasLaunchPlan: false,
    };
  }

  if (activeStatus === "dispatched" || activeStatus === "in_progress" || activeStatus === "blocked") {
    return {
      state: "active",
      label: activeStatus === "blocked" ? "already started; currently blocked" : "already started",
      canStart: false,
      dependencyCount: unsatisfiedDependencyCount,
      satisfiedDependencyCount: 0,
      unsatisfiedDependencyCount,
      unsatisfiedDependencyIds: [],
      hasLaunchPlan: false,
    };
  }

  if (unsatisfiedDependencyCount > 0) {
    return {
      state: "waiting",
      label: `waiting on ${unsatisfiedDependencyCount} local dependencies`,
      canStart: false,
      dependencyCount: unsatisfiedDependencyCount,
      satisfiedDependencyCount: 0,
      unsatisfiedDependencyCount,
      unsatisfiedDependencyIds: [],
      hasLaunchPlan: false,
    };
  }

  return {
    state: "ready",
    label: "ready to start",
    canStart: true,
    dependencyCount: 0,
    satisfiedDependencyCount: 0,
    unsatisfiedDependencyCount: 0,
    unsatisfiedDependencyIds: [],
    hasLaunchPlan: false,
  };
}

function deriveWorkflowNodeRunStatusFromTask(
  task: TaskRecord,
  activeAssignment?: TaskAssignment | null,
): WorkflowNodeRun["status"] {
  const activeStatus = deriveTaskLifecycleStatus(task, activeAssignment);
  const readiness = deriveTaskReadiness(task, activeAssignment);
  switch (activeStatus) {
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "dispatched":
    case "in_progress":
      return "running";
    case "open":
    default:
      return readiness.state === "waiting" ? "pending" : "ready";
  }
}

function buildWorkflowTaskSurface(taskId?: string): WorkflowRunTaskSurface | null {
  if (!taskId) {
    return null;
  }
  const task = dbGetTask(taskId);
  if (!task) {
    return null;
  }
  const activeAssignment = dbGetActiveAssignment(taskId);
  const readiness = deriveTaskReadiness(task, activeAssignment);
  const visualStatus =
    task.status === "open" && readiness.state === "waiting"
      ? "waiting"
      : deriveTaskLifecycleStatus(task, activeAssignment);
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    visualStatus,
    progress: task.progress,
    priority: task.priority,
    readiness,
  };
}

function summarizeNodeRuns(nodeRuns: WorkflowNodeRun[]): WorkflowRunCounts {
  return nodeRuns.reduce<WorkflowRunCounts>(
    (counts, nodeRun) => {
      counts.total += 1;
      switch (nodeRun.status) {
        case "pending":
          counts.pending += 1;
          break;
        case "awaiting_release":
          counts.awaitingRelease += 1;
          break;
        case "ready":
          counts.ready += 1;
          break;
        case "running":
          counts.running += 1;
          break;
        case "blocked":
          counts.blocked += 1;
          break;
        case "done":
          counts.done += 1;
          break;
        case "failed":
          counts.failed += 1;
          break;
        case "skipped":
          counts.skipped += 1;
          break;
        case "cancelled":
          counts.cancelled += 1;
          break;
        case "archived":
          counts.archived += 1;
          break;
      }
      return counts;
    },
    {
      total: 0,
      pending: 0,
      awaitingRelease: 0,
      ready: 0,
      running: 0,
      blocked: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      cancelled: 0,
      archived: 0,
    },
  );
}

function deriveWorkflowRunStatus(run: WorkflowRun, nodeRuns: WorkflowNodeRun[]): WorkflowRun["status"] {
  if (typeof run.archivedAt === "number") {
    return "archived";
  }

  const activeNodes = nodeRuns.filter((nodeRun) => nodeRun.status !== "archived");
  if (activeNodes.length === 0) {
    return "draft";
  }

  if (activeNodes.some((nodeRun) => nodeRun.status === "failed")) {
    return "failed";
  }

  if (activeNodes.some((nodeRun) => nodeRun.status === "cancelled" && nodeRun.requirement === "required")) {
    return "cancelled";
  }

  if (activeNodes.some((nodeRun) => nodeRun.status === "running")) {
    return "running";
  }

  if (activeNodes.some((nodeRun) => nodeRun.status === "blocked")) {
    return "blocked";
  }

  if (activeNodes.some((nodeRun) => nodeRun.status === "ready")) {
    return "ready";
  }

  if (activeNodes.some((nodeRun) => nodeRun.status === "pending" || nodeRun.status === "awaiting_release")) {
    return "waiting";
  }

  const requiredNodes = activeNodes.filter((nodeRun) => nodeRun.requirement === "required");
  const completionSet = requiredNodes.length > 0 ? requiredNodes : activeNodes;
  if (
    completionSet.every(
      (nodeRun) =>
        nodeRun.status === "done" ||
        (nodeRun.requirement === "optional" && (nodeRun.status === "skipped" || nodeRun.status === "cancelled")),
    )
  ) {
    return "done";
  }

  return "waiting";
}

function refreshWorkflowRunStatus(runId: string): WorkflowRun {
  const run = dbGetWorkflowRun(runId);
  if (!run) {
    throw new Error(`Workflow run not found: ${runId}`);
  }
  const nodeRuns = dbListWorkflowNodeRuns(runId);
  const nextStatus = deriveWorkflowRunStatus(run, nodeRuns);
  const completedAt =
    nextStatus === "done" || nextStatus === "failed" || nextStatus === "cancelled"
      ? (run.completedAt ?? Date.now())
      : undefined;
  return dbUpdateWorkflowRun(runId, {
    status: nextStatus,
    ...(completedAt !== undefined ? { completedAt } : {}),
  });
}

function reconcileWorkflowRun(runId: string): WorkflowRun {
  const edges = dbListWorkflowRunEdges(runId);

  let changed = true;
  while (changed) {
    changed = false;
    const nodeRuns = dbListWorkflowNodeRuns(runId);

    for (const nodeRun of nodeRuns) {
      if (
        nodeRun.status === "done" ||
        nodeRun.status === "failed" ||
        nodeRun.status === "skipped" ||
        nodeRun.status === "cancelled" ||
        nodeRun.status === "archived"
      ) {
        continue;
      }

      const preconditions = getWorkflowNodeRunPreconditions(nodeRun, nodeRuns, edges);
      const waitingOnNodeKeys = preconditions.waitingOnNodeKeys;

      if (nodeRun.currentTaskId) {
        const task = dbGetTask(nodeRun.currentTaskId);
        const nextStatus = task
          ? deriveWorkflowNodeRunStatusForBoundTask(
              nodeRun,
              task,
              dbGetActiveAssignment(nodeRun.currentTaskId),
              preconditions,
            ).status
          : nodeRun.status;
        if (
          nodeRun.status !== nextStatus ||
          JSON.stringify(nodeRun.waitingOnNodeKeys) !== JSON.stringify(waitingOnNodeKeys)
        ) {
          dbUpdateWorkflowNodeRun(nodeRun.id, { status: nextStatus, waitingOnNodeKeys });
          changed = true;
        }
        continue;
      }

      if (waitingOnNodeKeys.length > 0) {
        if (
          nodeRun.status !== "pending" ||
          JSON.stringify(nodeRun.waitingOnNodeKeys) !== JSON.stringify(waitingOnNodeKeys)
        ) {
          dbUpdateWorkflowNodeRun(nodeRun.id, {
            status: "pending",
            waitingOnNodeKeys,
          });
          changed = true;
        }
        continue;
      }

      if (preconditions.awaitingRelease) {
        if (nodeRun.status !== "awaiting_release" || nodeRun.waitingOnNodeKeys.length > 0) {
          dbUpdateWorkflowNodeRun(nodeRun.id, {
            status: "awaiting_release",
            waitingOnNodeKeys: [],
          });
          changed = true;
        }
        continue;
      }

      if (nodeRun.status !== "ready" || nodeRun.waitingOnNodeKeys.length > 0) {
        dbUpdateWorkflowNodeRun(nodeRun.id, {
          status: "ready",
          waitingOnNodeKeys: [],
          ...(nodeRun.readyAt ? {} : { readyAt: Date.now() }),
        });
        changed = true;
      }
    }
  }

  return refreshWorkflowRunStatus(runId);
}

export function createWorkflowSpec(input: CreateWorkflowSpecInput): WorkflowSpec {
  return dbCreateWorkflowSpec(normalizeSpecInput(input));
}

export function listWorkflowSpecs(): WorkflowSpec[] {
  return dbListWorkflowSpecs();
}

export function getWorkflowSpec(specId: string): WorkflowSpec | null {
  return dbGetWorkflowSpec(specId);
}

export function startWorkflowRun(specId: string, input: StartWorkflowRunInput = {}): WorkflowRunDetails {
  const spec = dbGetWorkflowSpec(specId);
  if (!spec) {
    throw new Error(`Workflow spec not found: ${specId}`);
  }

  const run = dbCreateWorkflowRun(spec, input);
  const incoming = buildIncomingNodeKeys(spec);
  const now = Date.now();
  const nodeRuns: WorkflowNodeRun[] = spec.nodes.map((node) => {
    const waitingOnNodeKeys = incoming.get(node.key) ?? [];
    const awaitingRelease =
      waitingOnNodeKeys.length === 0 && shouldAwaitManualRelease({ ...node, releasedAt: undefined });
    const status: WorkflowNodeRun["status"] =
      waitingOnNodeKeys.length > 0 ? "pending" : awaitingRelease ? "awaiting_release" : "ready";
    return {
      id: `wf-node-run-${randomUUID()}`,
      workflowRunId: run.id,
      specNodeKey: node.key,
      label: node.label,
      kind: node.kind,
      requirement: node.requirement,
      releaseMode: node.releaseMode,
      status,
      waitingOnNodeKeys: status === "pending" ? waitingOnNodeKeys : [],
      attemptCount: 0,
      ...(status === "ready" ? { readyAt: now } : {}),
      createdAt: now,
      updatedAt: now,
    };
  });
  dbInsertWorkflowNodeRuns(nodeRuns.map(({ createdAt: _createdAt, updatedAt: _updatedAt, ...nodeRun }) => nodeRun));

  const nodeRunByKey = new Map(nodeRuns.map((nodeRun) => [nodeRun.specNodeKey, nodeRun]));
  dbInsertWorkflowRunEdges(
    spec.edges.map((edge) => ({
      workflowRunId: run.id,
      fromNodeRunId: nodeRunByKey.get(edge.from)!.id,
      toNodeRunId: nodeRunByKey.get(edge.to)!.id,
      createdAt: now,
    })),
  );

  reconcileWorkflowRun(run.id);
  return getWorkflowRunDetails(run.id)!;
}

export function listWorkflowRuns(): WorkflowRun[] {
  return dbListWorkflowRuns();
}

export function getWorkflowRunDetails(runId: string): WorkflowRunDetails | null {
  const run = dbGetWorkflowRun(runId);
  if (!run) {
    return null;
  }
  const spec = dbGetWorkflowSpec(run.workflowSpecId);
  if (!spec) {
    throw new Error(`Workflow spec not found for run ${runId}: ${run.workflowSpecId}`);
  }
  const nodeRuns = dbListWorkflowNodeRuns(runId);
  const edges = dbListWorkflowRunEdges(runId);
  const { incoming, outgoing } = buildNodeMaps(nodeRuns, edges);
  const nodes: WorkflowNodeRunView[] = nodeRuns.map((nodeRun) => ({
    ...nodeRun,
    upstreamNodeKeys: (incoming.get(nodeRun.id) ?? []).map((candidate) => candidate.specNodeKey),
    downstreamNodeKeys: (outgoing.get(nodeRun.id) ?? []).map((candidate) => candidate.specNodeKey),
    taskAttempts: dbListWorkflowNodeRunTaskAttempts(nodeRun.id),
    currentTask: buildWorkflowTaskSurface(nodeRun.currentTaskId),
  }));

  return {
    run,
    spec,
    nodes,
    edges,
    counts: summarizeNodeRuns(nodeRuns),
  };
}

function assertNodeRunMutable(nodeRun: WorkflowNodeRun): void {
  if (nodeRun.status === "archived") {
    throw new Error(`Workflow node ${nodeRun.specNodeKey} is archived.`);
  }
  if (nodeRun.status === "cancelled") {
    throw new Error(`Workflow node ${nodeRun.specNodeKey} is cancelled.`);
  }
  if (nodeRun.status === "skipped") {
    throw new Error(`Workflow node ${nodeRun.specNodeKey} is skipped.`);
  }
}

function ensureNodeRunWithoutActiveTask(nodeRun: WorkflowNodeRun): void {
  if (!nodeRun.currentTaskId) {
    return;
  }
  const currentTask = dbGetTask(nodeRun.currentTaskId);
  if (currentTask && currentTask.status !== "done" && currentTask.status !== "failed") {
    throw new Error(
      `Workflow node ${nodeRun.specNodeKey} is attached to active task ${nodeRun.currentTaskId}; finish that task first.`,
    );
  }
}

export function assertCanAttachTaskToWorkflowNodeRun(runId: string, nodeKey: string): WorkflowNodeRun {
  const nodeRun = dbGetWorkflowNodeRunByKey(runId, nodeKey);
  if (!nodeRun) {
    throw new Error(`Workflow node ${nodeKey} not found in run ${runId}.`);
  }
  if (nodeRun.kind !== "task") {
    throw new Error(`Workflow node ${nodeKey} is ${nodeRun.kind}; only task nodes can bind tasks.`);
  }
  assertNodeRunMutable(nodeRun);
  if (nodeRun.status === "done") {
    throw new Error(`Workflow node ${nodeKey} is already done.`);
  }

  const preconditions = getWorkflowNodeRunPreconditions(nodeRun);
  if (preconditions.waitingOnNodeKeys.length > 0) {
    throw new Error(
      `Workflow node ${nodeKey} is waiting on ${preconditions.waitingOnNodeKeys.join(", ")} before attaching a task.`,
    );
  }
  if (preconditions.awaitingRelease) {
    throw new Error(`Workflow node ${nodeKey} requires manual release before attaching a task.`);
  }

  if (nodeRun.currentTaskId) {
    if (nodeRun.status !== "failed") {
      throw new Error(`Workflow node ${nodeKey} already has current task ${nodeRun.currentTaskId}.`);
    }
    ensureNodeRunWithoutActiveTask(nodeRun);
  }

  if (nodeRun.status === "running" || nodeRun.status === "blocked") {
    throw new Error(`Workflow node ${nodeKey} is ${nodeRun.status}; finish the current attempt first.`);
  }

  return nodeRun;
}

export function releaseWorkflowNodeRun(
  runId: string,
  nodeKey: string,
  actor: WorkflowActorInput = {},
): WorkflowNodeRunMutationResult {
  const nodeRun = dbGetWorkflowNodeRunByKey(runId, nodeKey);
  if (!nodeRun) {
    throw new Error(`Workflow node ${nodeKey} not found in run ${runId}.`);
  }
  if (nodeRun.status !== "awaiting_release") {
    throw new Error(`Workflow node ${nodeKey} is ${nodeRun.status}, not awaiting_release.`);
  }
  ensureNodeRunWithoutActiveTask(nodeRun);

  const now = Date.now();
  const nextStatus: WorkflowNodeRun["status"] = nodeRun.kind === "task" ? "ready" : "done";
  const updatedNodeRun = dbUpdateWorkflowNodeRun(nodeRun.id, {
    status: nextStatus,
    waitingOnNodeKeys: [],
    releasedAt: now,
    ...(actor.actor !== undefined ? { releasedBy: actor.actor } : {}),
    ...(actor.agentId !== undefined ? { releasedByAgentId: actor.agentId } : {}),
    ...(actor.sessionName !== undefined ? { releasedBySessionName: actor.sessionName } : {}),
    ...(nextStatus === "ready" ? { readyAt: now } : {}),
    ...(nextStatus === "done" ? { completedAt: now } : {}),
  });
  reconcileWorkflowRun(runId);

  return {
    run: dbGetWorkflowRun(runId)!,
    nodeRun: updatedNodeRun,
    details: getWorkflowRunDetails(runId)!,
  };
}

export function skipWorkflowNodeRun(runId: string, nodeKey: string): WorkflowNodeRunMutationResult {
  const nodeRun = dbGetWorkflowNodeRunByKey(runId, nodeKey);
  if (!nodeRun) {
    throw new Error(`Workflow node ${nodeKey} not found in run ${runId}.`);
  }
  assertNodeRunMutable(nodeRun);
  if (nodeRun.requirement !== "optional") {
    throw new Error(`Workflow node ${nodeKey} is required and cannot be skipped.`);
  }
  ensureNodeRunWithoutActiveTask(nodeRun);
  const updatedNodeRun = dbUpdateWorkflowNodeRun(nodeRun.id, {
    status: "skipped",
    waitingOnNodeKeys: [],
    skippedAt: Date.now(),
  });
  reconcileWorkflowRun(runId);
  return {
    run: dbGetWorkflowRun(runId)!,
    nodeRun: updatedNodeRun,
    details: getWorkflowRunDetails(runId)!,
  };
}

export function cancelWorkflowNodeRun(runId: string, nodeKey: string): WorkflowNodeRunMutationResult {
  const nodeRun = dbGetWorkflowNodeRunByKey(runId, nodeKey);
  if (!nodeRun) {
    throw new Error(`Workflow node ${nodeKey} not found in run ${runId}.`);
  }
  assertNodeRunMutable(nodeRun);
  ensureNodeRunWithoutActiveTask(nodeRun);
  const updatedNodeRun = dbUpdateWorkflowNodeRun(nodeRun.id, {
    status: "cancelled",
    waitingOnNodeKeys: [],
    cancelledAt: Date.now(),
  });
  reconcileWorkflowRun(runId);
  return {
    run: dbGetWorkflowRun(runId)!,
    nodeRun: updatedNodeRun,
    details: getWorkflowRunDetails(runId)!,
  };
}

export function archiveWorkflowNodeRun(runId: string, nodeKey: string): WorkflowNodeRunMutationResult {
  const nodeRun = dbGetWorkflowNodeRunByKey(runId, nodeKey);
  if (!nodeRun) {
    throw new Error(`Workflow node ${nodeKey} not found in run ${runId}.`);
  }
  ensureNodeRunWithoutActiveTask(nodeRun);
  const updatedNodeRun = dbUpdateWorkflowNodeRun(nodeRun.id, {
    status: "archived",
    waitingOnNodeKeys: [],
    archivedAt: Date.now(),
  });
  reconcileWorkflowRun(runId);
  return {
    run: dbGetWorkflowRun(runId)!,
    nodeRun: updatedNodeRun,
    details: getWorkflowRunDetails(runId)!,
  };
}

export function attachTaskToWorkflowNodeRun(
  runId: string,
  nodeKey: string,
  taskId: string,
): WorkflowNodeRunMutationResult {
  const nodeRun = assertCanAttachTaskToWorkflowNodeRun(runId, nodeKey);
  if (!dbGetTask(taskId)) {
    throw new Error(`Task not found: ${taskId}`);
  }

  dbLinkTaskToWorkflowNodeRun(nodeRun.id, taskId);
  return syncWorkflowNodeRunForTask(taskId)!;
}

export function syncWorkflowNodeRunForTask(taskId: string): WorkflowNodeRunMutationResult | null {
  const nodeRun = dbGetWorkflowNodeRunByTaskId(taskId);
  if (!nodeRun) {
    return null;
  }
  if (nodeRun.status === "archived" || nodeRun.status === "skipped" || nodeRun.status === "cancelled") {
    return {
      run: dbGetWorkflowRun(nodeRun.workflowRunId)!,
      nodeRun,
      details: getWorkflowRunDetails(nodeRun.workflowRunId)!,
    };
  }

  const task = dbGetTask(taskId);
  if (!task) {
    return null;
  }

  const activeAssignment = dbGetActiveAssignment(taskId);
  const derived = deriveWorkflowNodeRunStatusForBoundTask(nodeRun, task, activeAssignment);
  const now = Date.now();
  const updatedNodeRun = dbUpdateWorkflowNodeRun(nodeRun.id, {
    status: derived.status,
    currentTaskId: taskId,
    waitingOnNodeKeys: derived.waitingOnNodeKeys,
    lastTaskTransitionAt: now,
    ...(derived.status === "ready" ? { readyAt: now } : {}),
    ...(derived.status === "blocked" ? { blockedAt: now } : {}),
    ...(derived.status === "done" ? { completedAt: now } : {}),
  });

  reconcileWorkflowRun(nodeRun.workflowRunId);
  return {
    run: dbGetWorkflowRun(nodeRun.workflowRunId)!,
    nodeRun: updatedNodeRun,
    details: getWorkflowRunDetails(nodeRun.workflowRunId)!,
  };
}
