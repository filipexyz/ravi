export type TaskStatus = "open" | "dispatched" | "in_progress" | "blocked" | "done" | "failed";

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export type TaskWorktreeMode = "inherit" | "path";

export const TASK_REPORT_EVENTS = ["blocked", "done", "failed"] as const;

export type TaskReportEvent = (typeof TASK_REPORT_EVENTS)[number];

export type TaskEventType =
  | "task.created"
  | "task.dispatched"
  | "task.progress"
  | "task.checkpoint.missed"
  | "task.comment"
  | "task.blocked"
  | "task.done"
  | "task.failed"
  | "task.child.blocked"
  | "task.child.done"
  | "task.child.failed";

export interface TaskWorktreeConfig {
  mode: TaskWorktreeMode;
  path?: string;
  branch?: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  instructions: string;
  status: TaskStatus;
  priority: TaskPriority;
  progress: number;
  checkpointIntervalMs?: number;
  reportToSessionName?: string;
  reportEvents?: TaskReportEvent[];
  parentTaskId?: string;
  taskDir?: string;
  createdBy?: string;
  createdByAgentId?: string;
  createdBySessionName?: string;
  assigneeAgentId?: string;
  assigneeSessionName?: string;
  worktree?: TaskWorktreeConfig;
  summary?: string;
  blockerReason?: string;
  createdAt: number;
  updatedAt: number;
  dispatchedAt?: number;
  startedAt?: number;
  completedAt?: number;
}

export interface TaskAssignment {
  id: string;
  taskId: string;
  agentId: string;
  sessionName: string;
  assignedBy?: string;
  assignedByAgentId?: string;
  assignedBySessionName?: string;
  worktree?: TaskWorktreeConfig;
  checkpointIntervalMs?: number;
  reportToSessionName?: string;
  reportEvents?: TaskReportEvent[];
  checkpointLastReportAt?: number;
  checkpointDueAt?: number;
  checkpointOverdueCount?: number;
  status: "assigned" | "accepted" | "blocked" | "done" | "failed" | "superseded";
  assignedAt: number;
  acceptedAt?: number;
  completedAt?: number;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  type: TaskEventType;
  actor?: string;
  agentId?: string;
  sessionName?: string;
  message?: string;
  progress?: number;
  relatedTaskId?: string;
  createdAt: number;
}

export interface TaskComment {
  id: string;
  taskId: string;
  author?: string;
  authorAgentId?: string;
  authorSessionName?: string;
  body: string;
  createdAt: number;
}

export interface CreateTaskInput {
  title: string;
  instructions: string;
  priority?: TaskPriority;
  checkpointIntervalMs?: number;
  reportToSessionName?: string;
  reportEvents?: TaskReportEvent[];
  createdBy?: string;
  createdByAgentId?: string;
  createdBySessionName?: string;
  parentTaskId?: string;
  worktree?: TaskWorktreeConfig;
}

export interface DispatchTaskInput {
  agentId: string;
  sessionName: string;
  assignedBy?: string;
  assignedByAgentId?: string;
  assignedBySessionName?: string;
  worktree?: TaskWorktreeConfig;
  checkpointIntervalMs?: number;
  reportToSessionName?: string;
  reportEvents?: TaskReportEvent[];
}

export interface TaskProgressInput {
  actor?: string;
  agentId?: string;
  sessionName?: string;
  message?: string;
  progress?: number;
  resetCheckpoint?: boolean;
}

export interface TaskTerminalInput {
  actor?: string;
  agentId?: string;
  sessionName?: string;
  message: string;
  progress?: number;
}

export interface TaskCommentInput {
  author?: string;
  authorAgentId?: string;
  authorSessionName?: string;
  body: string;
}

export interface ListTasksOptions {
  status?: TaskStatus;
  agentId?: string;
  sessionName?: string;
  parentTaskId?: string;
}
