export type TaskStatus = "open" | "dispatched" | "in_progress" | "blocked" | "done" | "failed";

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export type TaskEventType =
  | "task.created"
  | "task.dispatched"
  | "task.progress"
  | "task.blocked"
  | "task.done"
  | "task.failed";

export interface TaskRecord {
  id: string;
  title: string;
  instructions: string;
  status: TaskStatus;
  priority: TaskPriority;
  progress: number;
  createdBy?: string;
  assigneeAgentId?: string;
  assigneeSessionName?: string;
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
  createdAt: number;
}

export interface CreateTaskInput {
  title: string;
  instructions: string;
  priority?: TaskPriority;
  createdBy?: string;
}

export interface DispatchTaskInput {
  agentId: string;
  sessionName: string;
  assignedBy?: string;
}

export interface TaskProgressInput {
  actor?: string;
  agentId?: string;
  sessionName?: string;
  message?: string;
  progress?: number;
}

export interface TaskTerminalInput {
  actor?: string;
  agentId?: string;
  sessionName?: string;
  message: string;
}

export interface ListTasksOptions {
  status?: TaskStatus;
  agentId?: string;
  sessionName?: string;
}
