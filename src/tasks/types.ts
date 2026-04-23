import type { RuntimeEffort } from "../runtime/effort.js";

export type TaskStatus = "open" | "dispatched" | "in_progress" | "blocked" | "done" | "failed";

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export type TaskWorktreeMode = "inherit" | "path";

export type TaskReadinessState = "ready" | "waiting" | "active" | "terminal";

export type TaskArchiveMode = "include" | "exclude" | "only";

export type TaskProfileTaskDocumentMode = "required" | "optional";

export type TaskProfileTaskDocumentUsage = TaskProfileTaskDocumentMode | "none";

export type TaskWorkspaceBootstrapMode = "inherit" | "task_dir" | "path";

export type TaskProfileScaffoldPreset = "doc-first" | "brainstorm" | "runtime-only" | "content";

export type TaskProfileSourceKind = "system" | "plugin" | "workspace" | "user";

export type TaskProfileArtifactKind = string;

export type TaskProfileStateTransform = "identity" | "slug";

export type TaskRuntimeEffort = RuntimeEffort;

export type TaskRuntimeThinking = "off" | "normal" | "verbose";

export type TaskRuntimeOptionsSource =
  | "dispatch_override"
  | "task_override"
  | "profile_default"
  | "session_override"
  | "agent_default"
  | "global_default"
  | "runtime_default";

export interface TaskRuntimeOptions {
  model?: string;
  effort?: TaskRuntimeEffort;
  thinking?: TaskRuntimeThinking;
}

export interface TaskRuntimeResolution {
  options: TaskRuntimeOptions;
  sources: {
    model: TaskRuntimeOptionsSource | null;
    effort: TaskRuntimeOptionsSource | null;
    thinking: TaskRuntimeOptionsSource | null;
  };
  hasTaskRuntimeContext: boolean;
}

export const TASK_REPORT_EVENTS = ["blocked", "done", "failed"] as const;

export type TaskReportEvent = (typeof TASK_REPORT_EVENTS)[number];

export type TaskEventType =
  | "task.created"
  | "task.dispatched"
  | "task.launch-planned"
  | "task.ready"
  | "task.dependency.added"
  | "task.dependency.removed"
  | "task.dependency.satisfied"
  | "task.progress"
  | "task.checkpoint.missed"
  | "task.comment"
  | "task.archived"
  | "task.unarchived"
  | "task.blocked"
  | "task.done"
  | "task.failed"
  | "task.child.blocked"
  | "task.child.done"
  | "task.child.failed";

export const TASK_AUTOMATION_EVENTS = [
  "task.blocked",
  "task.done",
  "task.failed",
  "task.child.blocked",
  "task.child.done",
  "task.child.failed",
] as const;

export type TaskAutomationEventType = (typeof TASK_AUTOMATION_EVENTS)[number];

export type TaskAutomationRunStatus = "claimed" | "spawned" | "skipped" | "failed";

export interface TaskAutomation {
  id: string;
  name: string;
  enabled: boolean;
  eventTypes: TaskAutomationEventType[];
  filter?: string;
  titleTemplate: string;
  instructionsTemplate: string;
  priority?: TaskPriority;
  profileId?: string;
  agentId?: string;
  sessionNameTemplate?: string;
  checkpointIntervalMs?: number;
  reportToSessionNameTemplate?: string;
  reportEvents?: TaskReportEvent[];
  profileInput?: Record<string, string>;
  inheritParentTask: boolean;
  inheritWorktree: boolean;
  inheritCheckpoint: boolean;
  inheritReportTo: boolean;
  inheritReportEvents: boolean;
  fireCount: number;
  lastFiredAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskAutomationInput {
  name: string;
  enabled?: boolean;
  eventTypes: TaskAutomationEventType[];
  filter?: string;
  titleTemplate: string;
  instructionsTemplate: string;
  priority?: TaskPriority;
  profileId?: string;
  agentId?: string;
  sessionNameTemplate?: string;
  checkpointIntervalMs?: number;
  reportToSessionNameTemplate?: string;
  reportEvents?: TaskReportEvent[];
  profileInput?: Record<string, string>;
  inheritParentTask?: boolean;
  inheritWorktree?: boolean;
  inheritCheckpoint?: boolean;
  inheritReportTo?: boolean;
  inheritReportEvents?: boolean;
}

export interface TaskAutomationRun {
  id: number;
  automationId: string;
  triggerTaskId: string;
  triggerEventId: number;
  triggerEventType: TaskAutomationEventType;
  spawnedTaskId?: string;
  status: TaskAutomationRunStatus;
  message?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskWorktreeConfig {
  mode: TaskWorktreeMode;
  path?: string;
  branch?: string;
}

export interface TaskProfileWorkspaceBootstrap {
  mode: TaskWorkspaceBootstrapMode;
  path?: string;
  branch?: string;
  ensureTaskDir: boolean;
}

export interface TaskProfileRendererHints {
  label: string;
  showTaskDoc: boolean;
  showWorkspace: boolean;
}

export interface TaskProfileTaskDocumentSyncPolicy {
  mode: TaskProfileTaskDocumentMode;
}

export interface TaskProfileSyncPolicy {
  artifactFirst?: boolean;
  taskDocument?: TaskProfileTaskDocumentSyncPolicy;
}

export interface TaskProfileInputDefinition {
  key: string;
  label?: string;
  description?: string;
  required?: boolean;
  defaultValue?: string;
}

export type TaskProfileInputValues = Record<string, string>;

export interface TaskProfileCompletionPolicy {
  summaryRequired?: boolean;
  summaryLabel?: string;
  notes?: string;
}

export interface TaskProfileProgressPolicy {
  requireMessage?: boolean;
  notes?: string;
}

export interface TaskProfileTemplates {
  create: string;
  dispatch: string;
  resume: string;
  dispatchSummary: string;
  dispatchEventMessage: string;
  reportDoneMessage: string;
  reportBlockedMessage: string;
  reportFailedMessage: string;
}

export interface TaskProfileArtifactDefinition {
  kind: TaskProfileArtifactKind;
  label: string;
  pathTemplate: string;
  primary?: boolean;
  primaryWhenStatuses?: TaskStatus[];
  showWhenStatuses?: TaskStatus[];
}

export interface TaskProfileArtifactRef {
  kind: TaskProfileArtifactKind;
  label: string;
  path: string;
}

export interface BrainstormTaskProfileState {
  slug: string;
}

export interface TaskProfileState {
  brainstorm?: BrainstormTaskProfileState;
  [key: string]: unknown;
}

export interface TaskProfileStateFieldDefinition {
  path: string;
  valueTemplate: string;
  transform?: TaskProfileStateTransform;
}

export interface TaskProfileDefinition {
  id: string;
  version: string;
  label: string;
  description: string;
  sessionNameTemplate: string;
  runtimeDefaults?: TaskRuntimeOptions;
  workspaceBootstrap: TaskProfileWorkspaceBootstrap;
  sync: TaskProfileSyncPolicy;
  rendererHints: TaskProfileRendererHints;
  defaultTags: string[];
  inputs: TaskProfileInputDefinition[];
  completion: TaskProfileCompletionPolicy;
  progress: TaskProfileProgressPolicy;
  templates: TaskProfileTemplates;
  artifacts: TaskProfileArtifactDefinition[];
  state: TaskProfileStateFieldDefinition[];
  sourceKind: TaskProfileSourceKind;
  source: string;
  manifestPath?: string | null;
}

export interface TaskProfileSnapshot extends TaskProfileDefinition {
  manifestPath?: string | null;
}

export interface ResolvedTaskProfile extends TaskProfileDefinition {
  requestedId: string | null;
  resolvedFromFallback: boolean;
}

export interface TaskRecord {
  id: string;
  title: string;
  instructions: string;
  status: TaskStatus;
  priority: TaskPriority;
  progress: number;
  profileId?: string;
  profileVersion?: string;
  profileSource?: string;
  profileSnapshot?: TaskProfileSnapshot;
  profileState?: TaskProfileState;
  profileInput?: TaskProfileInputValues;
  runtimeOverride?: TaskRuntimeOptions;
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
  archivedAt?: number;
  archivedBy?: string;
  archiveReason?: string;
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
  runtimeOverride?: TaskRuntimeOptions;
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

export interface TaskDependencyRecord {
  taskId: string;
  dependsOnTaskId: string;
  createdAt: number;
  satisfiedAt?: number;
  satisfiedByEventId?: number;
}

export interface TaskLaunchPlan {
  taskId: string;
  agentId: string;
  sessionName: string;
  assignedBy?: string;
  assignedByAgentId?: string;
  assignedBySessionName?: string;
  worktree?: TaskWorktreeConfig;
  runtimeOverride?: TaskRuntimeOptions;
  checkpointIntervalMs?: number;
  reportToSessionName?: string;
  reportEvents?: TaskReportEvent[];
  createdAt: number;
  updatedAt: number;
}

export interface TaskDependencyEdge {
  direction: "dependency" | "dependent";
  taskId: string;
  relatedTaskId: string;
  relatedTaskTitle: string;
  relatedTaskStatus: TaskStatus;
  relatedTaskProgress: number;
  relatedTaskAssigneeAgentId?: string;
  relatedTaskAssigneeSessionName?: string;
  satisfied: boolean;
  createdAt: number;
  satisfiedAt?: number;
  satisfiedByEventId?: number;
}

export interface TaskReadiness {
  state: TaskReadinessState;
  label: string;
  canStart: boolean;
  dependencyCount: number;
  satisfiedDependencyCount: number;
  unsatisfiedDependencyCount: number;
  unsatisfiedDependencyIds: string[];
  hasLaunchPlan: boolean;
}

export interface CreateTaskInput {
  title: string;
  instructions: string;
  priority?: TaskPriority;
  profileId?: string;
  profileVersion?: string;
  profileSource?: string;
  profileSnapshot?: TaskProfileSnapshot;
  profileState?: TaskProfileState;
  profileInput?: TaskProfileInputValues;
  runtimeOverride?: TaskRuntimeOptions;
  checkpointIntervalMs?: number;
  reportToSessionName?: string;
  reportEvents?: TaskReportEvent[];
  createdBy?: string;
  createdByAgentId?: string;
  createdBySessionName?: string;
  parentTaskId?: string;
  dependsOnTaskIds?: string[];
  worktree?: TaskWorktreeConfig;
}

export interface DispatchTaskInput {
  agentId: string;
  sessionName: string;
  assignedBy?: string;
  assignedByAgentId?: string;
  assignedBySessionName?: string;
  worktree?: TaskWorktreeConfig;
  runtimeOverride?: TaskRuntimeOptions;
  checkpointIntervalMs?: number;
  reportToSessionName?: string;
  reportEvents?: TaskReportEvent[];
}

export interface QueueTaskLaunchInput extends DispatchTaskInput {}

export interface TaskProgressInput {
  actor?: string;
  agentId?: string;
  sessionName?: string;
  message: string;
  progress?: number;
  resetCheckpoint?: boolean;
}

export interface TaskArchiveInput {
  actor?: string;
  agentId?: string;
  sessionName?: string;
  reason: string;
}

export interface TaskUnarchiveInput {
  actor?: string;
  agentId?: string;
  sessionName?: string;
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
  rootTaskId?: string;
  onlyRootTasks?: boolean;
  profileId?: string;
  query?: string;
  limit?: number;
  archiveMode?: TaskArchiveMode;
}
