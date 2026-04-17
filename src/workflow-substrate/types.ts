import type { TaskAssignment, TaskLaunchPlan, TaskReadiness, TaskRecord, TaskStatus } from "../tasks/types.js";

export type WorkflowStatus = "draft" | "ready" | "running" | "blocked" | "done" | "failed" | "archived";

export interface WorkflowRecord {
  id: string;
  title: string;
  summary?: string;
  status: WorkflowStatus;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  createdBy?: string;
  createdByAgentId?: string;
  createdBySessionName?: string;
}

export interface WorkflowTaskMembership {
  workflowId: string;
  taskId: string;
  nodeKey?: string;
  label?: string;
  createdAt: number;
  removedAt?: number;
  removedBy?: string;
}

export interface CreateWorkflowInput {
  title: string;
  summary?: string;
  createdBy?: string;
  createdByAgentId?: string;
  createdBySessionName?: string;
}

export interface WorkflowMutationActor {
  actor?: string;
  agentId?: string;
  sessionName?: string;
}

export interface AddWorkflowTaskInput extends WorkflowMutationActor {
  nodeKey?: string;
  label?: string;
}

export interface RemoveWorkflowTaskInput extends WorkflowMutationActor {}

export interface WorkflowArchiveInput extends WorkflowMutationActor {}

export interface WorkflowCurrentMember {
  workflowId: string;
  taskId: string;
  nodeKey?: string;
  label?: string;
  membershipCreatedAt: number;
  task: TaskRecord;
  activeAssignment: TaskAssignment | null;
  lifecycleStatus: TaskStatus;
  visualStatus: TaskStatus | "waiting";
  readiness: TaskReadiness;
  launchPlan: TaskLaunchPlan | null;
  internalUpstreamTaskIds: string[];
  externalUpstreamTaskIds: string[];
  internalDownstreamTaskIds: string[];
}

export interface WorkflowHistoryMember {
  workflowId: string;
  taskId: string;
  nodeKey?: string;
  label?: string;
  membershipCreatedAt: number;
  historyState: "archived" | "removed";
  historyAt: number;
  historyBy?: string;
  task: TaskRecord;
  activeAssignment: TaskAssignment | null;
  lifecycleStatus: TaskStatus;
  visualStatus: TaskStatus | "waiting";
}

export interface WorkflowEdge {
  fromTaskId: string;
  toTaskId: string;
}

export interface WorkflowExternalPrerequisite {
  taskId: string;
  dependsOnTaskId: string;
  dependsOnTaskTitle: string;
  dependsOnTaskStatus: TaskStatus;
  dependsOnTaskProgress: number;
  satisfied: boolean;
}

export interface WorkflowAggregate {
  memberCount: number;
  historyCount: number;
  archivedHistoryCount: number;
  removedHistoryCount: number;
  readyCount: number;
  waitingCount: number;
  runningCount: number;
  blockedCount: number;
  doneCount: number;
  failedCount: number;
}

export interface WorkflowSnapshot {
  workflow: WorkflowRecord;
  status: WorkflowStatus;
  summary?: string;
  aggregate: WorkflowAggregate;
  members: WorkflowCurrentMember[];
  history: WorkflowHistoryMember[];
  edges: WorkflowEdge[];
  externalPrerequisites: WorkflowExternalPrerequisite[];
}
