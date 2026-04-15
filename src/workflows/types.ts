import type { TaskPriority, TaskReadiness, TaskRecord, TaskWorktreeConfig } from "../tasks/types.js";

export type WorkflowNodeKind = "task" | "gate" | "approval";

export type WorkflowNodeRequirement = "required" | "optional";

export type WorkflowNodeReleaseMode = "auto" | "manual";

export type WorkflowRunStatus =
  | "draft"
  | "waiting"
  | "ready"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled"
  | "archived";

export type WorkflowNodeRunStatus =
  | "pending"
  | "awaiting_release"
  | "ready"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "skipped"
  | "cancelled"
  | "archived";

export interface WorkflowSpecPolicy {
  completionMode?: "all_required";
}

export interface WorkflowSpecNode {
  key: string;
  label: string;
  kind: WorkflowNodeKind;
  requirement: WorkflowNodeRequirement;
  releaseMode: WorkflowNodeReleaseMode;
}

export interface WorkflowSpecEdge {
  from: string;
  to: string;
}

export interface WorkflowSpec {
  id: string;
  title: string;
  summary?: string;
  policy: WorkflowSpecPolicy;
  nodes: WorkflowSpecNode[];
  edges: WorkflowSpecEdge[];
  createdBy?: string;
  createdByAgentId?: string;
  createdBySessionName?: string;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateWorkflowSpecInput {
  id?: string;
  title: string;
  summary?: string;
  policy?: WorkflowSpecPolicy;
  nodes: WorkflowSpecNode[];
  edges?: WorkflowSpecEdge[];
  createdBy?: string;
  createdByAgentId?: string;
  createdBySessionName?: string;
}

export interface WorkflowRun {
  id: string;
  workflowSpecId: string;
  title: string;
  summary?: string;
  policy: WorkflowSpecPolicy;
  status: WorkflowRunStatus;
  createdBy?: string;
  createdByAgentId?: string;
  createdBySessionName?: string;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  completedAt?: number;
}

export interface StartWorkflowRunInput {
  runId?: string;
  createdBy?: string;
  createdByAgentId?: string;
  createdBySessionName?: string;
}

export interface WorkflowRunEdge {
  workflowRunId: string;
  fromNodeRunId: string;
  toNodeRunId: string;
  createdAt: number;
}

export interface WorkflowNodeRun {
  id: string;
  workflowRunId: string;
  specNodeKey: string;
  label: string;
  kind: WorkflowNodeKind;
  requirement: WorkflowNodeRequirement;
  releaseMode: WorkflowNodeReleaseMode;
  status: WorkflowNodeRunStatus;
  waitingOnNodeKeys: string[];
  currentTaskId?: string;
  attemptCount: number;
  releasedAt?: number;
  releasedBy?: string;
  releasedByAgentId?: string;
  releasedBySessionName?: string;
  readyAt?: number;
  blockedAt?: number;
  completedAt?: number;
  skippedAt?: number;
  cancelledAt?: number;
  archivedAt?: number;
  lastTaskTransitionAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowNodeRunTaskAttempt {
  workflowNodeRunId: string;
  taskId: string;
  attempt: number;
  createdAt: number;
}

export interface WorkflowRunCounts {
  total: number;
  pending: number;
  awaitingRelease: number;
  ready: number;
  running: number;
  blocked: number;
  done: number;
  failed: number;
  skipped: number;
  cancelled: number;
  archived: number;
}

export interface WorkflowRunTaskSurface {
  id: string;
  title: string;
  status: TaskRecord["status"];
  visualStatus: TaskRecord["status"] | "waiting";
  progress: number;
  priority: TaskPriority;
  readiness: TaskReadiness;
}

export interface TaskWorkflowSurface {
  workflowRunId: string;
  workflowRunTitle: string;
  workflowRunStatus: WorkflowRunStatus;
  workflowSpecId: string;
  workflowSpecTitle: string;
  workflowNodeRunId: string;
  nodeKey: string;
  nodeLabel: string;
  nodeKind: WorkflowNodeKind;
  nodeRequirement: WorkflowNodeRequirement;
  nodeReleaseMode: WorkflowNodeReleaseMode;
  nodeStatus: WorkflowNodeRunStatus;
  waitingOnNodeKeys: string[];
  currentTaskId: string | null;
  currentTaskAttempt: number | null;
  attemptCount: number;
  isCurrentTask: boolean;
}

export interface WorkflowNodeRunView extends WorkflowNodeRun {
  upstreamNodeKeys: string[];
  downstreamNodeKeys: string[];
  taskAttempts: WorkflowNodeRunTaskAttempt[];
  currentTask: WorkflowRunTaskSurface | null;
}

export interface WorkflowRunDetails {
  run: WorkflowRun;
  spec: WorkflowSpec;
  nodes: WorkflowNodeRunView[];
  edges: WorkflowRunEdge[];
  counts: WorkflowRunCounts;
}

export interface WorkflowActorInput {
  actor?: string;
  agentId?: string;
  sessionName?: string;
}

export interface WorkflowNodeRunMutationResult {
  run: WorkflowRun;
  nodeRun: WorkflowNodeRun;
  details: WorkflowRunDetails;
}

export interface WorkflowTaskCreateInput {
  title: string;
  instructions: string;
  priority?: TaskPriority;
  profileId?: string;
  agentId?: string;
  sessionName?: string;
  worktree?: TaskWorktreeConfig;
}
