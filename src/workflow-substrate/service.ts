import {
  dbGetActiveAssignment,
  dbGetTask,
  deriveTaskReadStatus,
  deriveTaskVisualStatus,
  getTaskDependencySurface,
} from "../tasks/index.js";
import {
  dbAddTaskToWorkflow,
  dbArchiveWorkflow,
  dbCreateWorkflow,
  dbGetWorkflow,
  dbListWorkflowMemberships,
  dbListWorkflows,
  dbRemoveTaskFromWorkflow,
  dbSetWorkflowStatus,
  dbUnarchiveWorkflow,
} from "./workflow-db.js";
import type {
  AddWorkflowTaskInput,
  CreateWorkflowInput,
  RemoveWorkflowTaskInput,
  WorkflowArchiveInput,
  WorkflowCurrentMember,
  WorkflowEdge,
  WorkflowExternalPrerequisite,
  WorkflowHistoryMember,
  WorkflowSnapshot,
  WorkflowStatus,
  WorkflowTaskMembership,
} from "./types.js";

function buildCurrentMemberView(
  membership: WorkflowTaskMembership,
  aggregateTaskIds: ReadonlySet<string>,
): WorkflowCurrentMember | null {
  const task = dbGetTask(membership.taskId);
  if (!task || task.archivedAt) {
    return null;
  }

  const activeAssignment = dbGetActiveAssignment(task.id);
  const dependencySurface = getTaskDependencySurface(task, activeAssignment);

  return {
    workflowId: membership.workflowId,
    taskId: membership.taskId,
    ...(membership.nodeKey ? { nodeKey: membership.nodeKey } : {}),
    ...(membership.label ? { label: membership.label } : {}),
    membershipCreatedAt: membership.createdAt,
    task,
    activeAssignment,
    lifecycleStatus: deriveTaskReadStatus(task, activeAssignment),
    visualStatus: deriveTaskVisualStatus(task, dependencySurface.readiness, activeAssignment),
    readiness: dependencySurface.readiness,
    launchPlan: dependencySurface.launchPlan,
    internalUpstreamTaskIds: dependencySurface.dependencies
      .map((edge) => edge.relatedTaskId)
      .filter((taskId) => aggregateTaskIds.has(taskId)),
    externalUpstreamTaskIds: dependencySurface.dependencies
      .map((edge) => edge.relatedTaskId)
      .filter((taskId) => !aggregateTaskIds.has(taskId)),
    internalDownstreamTaskIds: dependencySurface.dependents
      .map((edge) => edge.relatedTaskId)
      .filter((taskId) => aggregateTaskIds.has(taskId)),
  };
}

function buildHistoryMemberView(membership: WorkflowTaskMembership): WorkflowHistoryMember | null {
  const task = dbGetTask(membership.taskId);
  if (!task) {
    return null;
  }

  const activeAssignment = dbGetActiveAssignment(task.id);
  const historyState = typeof membership.removedAt === "number" ? "removed" : task.archivedAt ? "archived" : null;
  const historyAt = membership.removedAt ?? task.archivedAt;
  if (!historyState || typeof historyAt !== "number") {
    return null;
  }

  const dependencySurface = getTaskDependencySurface(task, activeAssignment);
  return {
    workflowId: membership.workflowId,
    taskId: membership.taskId,
    ...(membership.nodeKey ? { nodeKey: membership.nodeKey } : {}),
    ...(membership.label ? { label: membership.label } : {}),
    membershipCreatedAt: membership.createdAt,
    historyState,
    historyAt,
    ...(historyState === "removed" && membership.removedBy ? { historyBy: membership.removedBy } : {}),
    task,
    activeAssignment,
    lifecycleStatus: deriveTaskReadStatus(task, activeAssignment),
    visualStatus: deriveTaskVisualStatus(task, dependencySurface.readiness, activeAssignment),
  };
}

function buildWorkflowEdges(members: WorkflowCurrentMember[]): WorkflowEdge[] {
  const seen = new Set<string>();
  const edges: WorkflowEdge[] = [];
  for (const member of members) {
    for (const upstreamTaskId of member.internalUpstreamTaskIds) {
      const key = `${upstreamTaskId}->${member.taskId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      edges.push({
        fromTaskId: upstreamTaskId,
        toTaskId: member.taskId,
      });
    }
  }
  return edges;
}

function buildExternalPrerequisites(members: WorkflowCurrentMember[]): WorkflowExternalPrerequisite[] {
  const seen = new Set<string>();
  const prerequisites: WorkflowExternalPrerequisite[] = [];
  for (const member of members) {
    const dependencySurface = getTaskDependencySurface(member.task, member.activeAssignment);
    for (const dependency of dependencySurface.dependencies) {
      if (member.internalUpstreamTaskIds.includes(dependency.relatedTaskId)) {
        continue;
      }

      const key = `${member.taskId}:${dependency.relatedTaskId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      prerequisites.push({
        taskId: member.taskId,
        dependsOnTaskId: dependency.relatedTaskId,
        dependsOnTaskTitle: dependency.relatedTaskTitle,
        dependsOnTaskStatus: dependency.relatedTaskStatus,
        dependsOnTaskProgress: dependency.relatedTaskProgress,
        satisfied: dependency.satisfied,
      });
    }
  }
  return prerequisites;
}

function deriveWorkflowStatus(snapshot: Pick<WorkflowSnapshot, "workflow" | "members">): WorkflowStatus {
  if (snapshot.workflow.archivedAt) {
    return "archived";
  }

  if (snapshot.members.length === 0) {
    return "draft";
  }

  if (snapshot.members.some((member) => member.lifecycleStatus === "failed")) {
    return "failed";
  }

  if (
    snapshot.members.some(
      (member) => member.lifecycleStatus === "dispatched" || member.lifecycleStatus === "in_progress",
    )
  ) {
    return "running";
  }

  if (snapshot.members.some((member) => member.task.status === "open" && member.readiness.state === "ready")) {
    return "ready";
  }

  if (snapshot.members.every((member) => member.lifecycleStatus === "done")) {
    return "done";
  }

  return "blocked";
}

function buildWorkflowSnapshot(workflowId: string): WorkflowSnapshot | null {
  const workflow = dbGetWorkflow(workflowId);
  if (!workflow) {
    return null;
  }

  const memberships = dbListWorkflowMemberships(workflowId);
  const currentMemberships = memberships.filter((membership) => !membership.removedAt);
  const aggregateTaskIds = new Set(
    currentMemberships
      .map((membership) => dbGetTask(membership.taskId))
      .filter((task): task is NonNullable<typeof task> => Boolean(task && !task.archivedAt))
      .map((task) => task.id),
  );

  const members = currentMemberships
    .map((membership) => buildCurrentMemberView(membership, aggregateTaskIds))
    .filter((member): member is WorkflowCurrentMember => Boolean(member));

  const history = memberships
    .map((membership) => buildHistoryMemberView(membership))
    .filter((member): member is WorkflowHistoryMember => Boolean(member))
    .sort((left, right) => right.historyAt - left.historyAt);

  const snapshot: WorkflowSnapshot = {
    workflow,
    status: workflow.status,
    summary: workflow.summary,
    aggregate: {
      memberCount: members.length,
      historyCount: history.length,
      archivedHistoryCount: history.filter((member) => member.historyState === "archived").length,
      removedHistoryCount: history.filter((member) => member.historyState === "removed").length,
      readyCount: members.filter((member) => member.task.status === "open" && member.readiness.state === "ready")
        .length,
      waitingCount: members.filter((member) => member.visualStatus === "waiting").length,
      runningCount: members.filter(
        (member) => member.lifecycleStatus === "dispatched" || member.lifecycleStatus === "in_progress",
      ).length,
      blockedCount: members.filter((member) => member.lifecycleStatus === "blocked").length,
      doneCount: members.filter((member) => member.lifecycleStatus === "done").length,
      failedCount: members.filter((member) => member.lifecycleStatus === "failed").length,
    },
    members,
    history,
    edges: [],
    externalPrerequisites: [],
  };

  snapshot.status = deriveWorkflowStatus(snapshot);
  snapshot.edges = buildWorkflowEdges(snapshot.members);
  snapshot.externalPrerequisites = buildExternalPrerequisites(snapshot.members);
  return snapshot;
}

function syncWorkflowStatusFromSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  if (snapshot.workflow.status === snapshot.status) {
    return snapshot;
  }

  const workflow = dbSetWorkflowStatus(snapshot.workflow.id, snapshot.status);
  return {
    ...snapshot,
    workflow,
  };
}

function requireWorkflowSnapshot(workflowId: string): WorkflowSnapshot {
  const snapshot = buildWorkflowSnapshot(workflowId);
  if (!snapshot) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }
  return snapshot;
}

function requireTaskExists(taskId: string): void {
  if (!dbGetTask(taskId)) {
    throw new Error(`Task not found: ${taskId}`);
  }
}

export function getWorkflowDetails(workflowId: string): WorkflowSnapshot | null {
  return buildWorkflowSnapshot(workflowId);
}

export function listWorkflows(options?: { archived?: "exclude" | "include" | "only" }): WorkflowSnapshot[] {
  return dbListWorkflows(options).map((workflow) => requireWorkflowSnapshot(workflow.id));
}

export function createWorkflow(input: CreateWorkflowInput): WorkflowSnapshot {
  const workflow = dbCreateWorkflow(input);
  return syncWorkflowStatusFromSnapshot(requireWorkflowSnapshot(workflow.id));
}

export function archiveWorkflow(
  workflowId: string,
  input: WorkflowArchiveInput = {},
): { snapshot: WorkflowSnapshot; wasNoop?: boolean } {
  const result = dbArchiveWorkflow(workflowId, input);
  return {
    snapshot: syncWorkflowStatusFromSnapshot(requireWorkflowSnapshot(result.workflow.id)),
    ...(result.wasNoop ? { wasNoop: true } : {}),
  };
}

export function unarchiveWorkflow(
  workflowId: string,
  input: WorkflowArchiveInput = {},
): { snapshot: WorkflowSnapshot; wasNoop?: boolean } {
  const result = dbUnarchiveWorkflow(workflowId, input);
  return {
    snapshot: syncWorkflowStatusFromSnapshot(requireWorkflowSnapshot(result.workflow.id)),
    ...(result.wasNoop ? { wasNoop: true } : {}),
  };
}

export function addTaskToWorkflow(
  workflowId: string,
  taskId: string,
  input: AddWorkflowTaskInput = {},
): { snapshot: WorkflowSnapshot; membership: WorkflowTaskMembership; wasNoop?: boolean } {
  requireTaskExists(taskId);
  const result = dbAddTaskToWorkflow(workflowId, taskId, input);
  return {
    snapshot: syncWorkflowStatusFromSnapshot(requireWorkflowSnapshot(workflowId)),
    membership: result.membership,
    ...(result.wasNoop ? { wasNoop: true } : {}),
  };
}

export function removeTaskFromWorkflow(
  workflowId: string,
  taskId: string,
  input: RemoveWorkflowTaskInput = {},
): { snapshot: WorkflowSnapshot; membership: WorkflowTaskMembership | null; wasNoop?: boolean } {
  const result = dbRemoveTaskFromWorkflow(workflowId, taskId, input);
  return {
    snapshot: syncWorkflowStatusFromSnapshot(requireWorkflowSnapshot(workflowId)),
    membership: result.membership,
    ...(result.wasNoop ? { wasNoop: true } : {}),
  };
}
