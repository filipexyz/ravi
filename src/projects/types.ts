import type {
  TaskAssignment,
  TaskEvent,
  TaskLaunchPlan,
  TaskPriority,
  TaskProfileArtifactRef,
  TaskProfileInputValues,
  TaskReadiness,
  TaskRecord,
  TaskReportEvent,
  TaskStatus,
  TaskWorktreeConfig,
} from "../tasks/types.js";
import type {
  WorkflowNodeRunStatus,
  WorkflowNodeKind,
  WorkflowNodeRequirement,
  WorkflowNodeReleaseMode,
  WorkflowNodeRunMutationResult,
  WorkflowRunStatus,
} from "../workflows/types.js";

export type ProjectStatus = "active" | "paused" | "blocked" | "done" | "archived";

export type ProjectLinkAssetType = "workflow" | "session" | "agent" | "resource" | "spec";

export type ProjectWorkflowLinkRole = "primary" | "support";

export type ProjectResourceType =
  | "repo"
  | "worktree"
  | "notion_page"
  | "notion_database"
  | "file"
  | "url"
  | "group"
  | "contact";

export interface ProjectRecord {
  id: string;
  slug: string;
  title: string;
  status: ProjectStatus;
  summary: string;
  hypothesis: string;
  nextStep: string;
  lastSignalAt: number;
  ownerAgentId?: string;
  operatorSessionName?: string;
  createdBy?: string;
  createdByAgentId?: string;
  createdBySessionName?: string;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSummary extends ProjectRecord {
  linkCount: number;
}

export interface ProjectWorkflowLinkSurface {
  linkId: string;
  role: string | null;
  workflowRunId: string;
  workflowRunTitle: string | null;
  workflowRunStatus: WorkflowRunStatus | null;
  workflowSpecId: string | null;
  workflowSpecTitle: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectWorkflowAggregate {
  total: number;
  missing: number;
  draft: number;
  waiting: number;
  ready: number;
  running: number;
  blocked: number;
  done: number;
  failed: number;
  cancelled: number;
  archived: number;
  primaryWorkflowRunId: string | null;
  primaryWorkflowTitle: string | null;
  primaryWorkflowStatus: WorkflowRunStatus | null;
  focusedWorkflowRunId: string | null;
  focusedWorkflowTitle: string | null;
  focusedWorkflowStatus: WorkflowRunStatus | null;
  focusedWorkflowRole: string | null;
  overallStatus: WorkflowRunStatus | null;
}

export interface ProjectTaskSurface {
  projectId: string;
  projectSlug: string;
  projectTitle: string;
  projectStatus: ProjectStatus;
  projectSummary: string;
  projectNextStep: string;
  projectLastSignalAt: number;
  workflowRunId: string;
  workflowRunTitle: string | null;
  workflowRunStatus: WorkflowRunStatus | null;
  workflowLinkId: string;
  workflowLinkRole: string | null;
  workflowCount: number;
  workflowAggregateStatus: WorkflowRunStatus | null;
  focusedWorkflowRunId: string | null;
  focusedWorkflowTitle: string | null;
  focusedWorkflowStatus: WorkflowRunStatus | null;
  focusedWorkflowRole: string | null;
  hottestWorkflowRunId: string | null;
  hottestWorkflowTitle: string | null;
  hottestWorkflowStatus: WorkflowRunStatus | null;
  hottestNodeRunId: string | null;
  hottestNodeKey: string | null;
  hottestNodeLabel: string | null;
  hottestNodeKind: WorkflowNodeKind | null;
  hottestNodeRequirement: WorkflowNodeRequirement | null;
  hottestNodeReleaseMode: WorkflowNodeReleaseMode | null;
  hottestNodeStatus: WorkflowNodeRunStatus | null;
  hottestTaskId: string | null;
  hottestTaskTitle: string | null;
  hottestTaskStatus: TaskStatus | null;
  hottestTaskProgress: number | null;
  hottestTaskPriority: TaskPriority | null;
}

export interface ProjectLinkedAssetMatch {
  project: ProjectRecord;
  link: ProjectLink;
}

export interface ProjectLink {
  id: string;
  projectId: string;
  assetType: ProjectLinkAssetType;
  assetId: string;
  role?: string;
  metadata?: Record<string, unknown>;
  createdBy?: string;
  createdByAgentId?: string;
  createdBySessionName?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectResourceLink extends ProjectLink {
  assetType: "resource";
  resourceType: ProjectResourceType | null;
  locator: string;
  label: string | null;
}

export interface ProjectDetails {
  project: ProjectRecord;
  links: ProjectLink[];
  linkedWorkflows: ProjectWorkflowLinkSurface[];
  workflowAggregate: ProjectWorkflowAggregate | null;
  operational: ProjectOperationalSurface | null;
}

export interface ProjectOperationalSurface {
  runtimeStatus: WorkflowRunStatus | null;
  workflowCount: number;
  hottestWorkflowRunId: string | null;
  hottestWorkflowTitle: string | null;
  hottestWorkflowStatus: WorkflowRunStatus | null;
  hottestNodeRunId: string | null;
  hottestNodeKey: string | null;
  hottestNodeLabel: string | null;
  hottestNodeKind: WorkflowNodeKind | null;
  hottestNodeRequirement: WorkflowNodeRequirement | null;
  hottestNodeReleaseMode: WorkflowNodeReleaseMode | null;
  hottestNodeStatus: WorkflowNodeRunStatus | null;
  hottestTaskId: string | null;
  hottestTaskTitle: string | null;
  hottestTaskStatus: TaskStatus | null;
  hottestTaskProgress: number | null;
  hottestTaskPriority: TaskPriority | null;
}

export interface ProjectStatusEntry {
  project: ProjectSummary;
  links: ProjectLink[];
  linkedWorkflows: ProjectWorkflowLinkSurface[];
  workflowAggregate: ProjectWorkflowAggregate | null;
  operational: ProjectOperationalSurface | null;
}

export interface CreateProjectInput {
  title: string;
  slug: string;
  status?: ProjectStatus;
  summary: string;
  hypothesis: string;
  nextStep: string;
  lastSignalAt: number;
  ownerAgentId?: string | null;
  operatorSessionName?: string | null;
  createdBy?: string;
  createdByAgentId?: string;
  createdBySessionName?: string;
}

export interface UpdateProjectInput {
  title?: string;
  status?: ProjectStatus;
  summary?: string;
  hypothesis?: string;
  nextStep?: string;
  lastSignalAt?: number;
  ownerAgentId?: string | null;
  operatorSessionName?: string | null;
}

export interface UpsertProjectLinkInput {
  projectRef: string;
  assetType: ProjectLinkAssetType;
  assetId: string;
  role?: string | null;
  metadata?: Record<string, unknown>;
  createdBy?: string;
  createdByAgentId?: string;
  createdBySessionName?: string;
}

export interface ProjectListQuery {
  status?: ProjectStatus;
}

export interface ProjectLinkQuery {
  projectRef: string;
  assetType?: ProjectLinkAssetType;
}

export type ProjectWorkflowTemplateId = "technical-change" | "gated-release" | "operational-response";

export interface ProjectBootstrapResourceInput {
  type: ProjectResourceType;
  assetId: string;
  label?: string;
  role?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ProjectInitInput {
  title: string;
  slug?: string;
  status?: ProjectStatus;
  summary?: string;
  hypothesis?: string;
  nextStep?: string;
  lastSignalAt?: number;
  ownerAgentId?: string | null;
  operatorSessionName?: string | null;
  resources?: ProjectBootstrapResourceInput[];
  workflowRunIds?: string[];
  workflowTemplates?: ProjectWorkflowTemplateId[];
  createdBy?: string;
  createdByAgentId?: string;
  createdBySessionName?: string;
}

export interface ProjectInitializedWorkflow {
  source: "existing" | "template";
  templateId?: ProjectWorkflowTemplateId;
  workflowRunId: string;
  workflowSpecId: string | null;
  workflowTitle: string | null;
  workflowStatus: WorkflowRunStatus | null;
  role: ProjectWorkflowLinkRole | null;
}

export interface ProjectWorkflowTemplateSummary {
  id: ProjectWorkflowTemplateId;
  specId: string;
  title: string;
  summary: string;
  shape: string;
  nodeCount: number;
}

export interface ProjectInitResult {
  details: ProjectDetails;
  ownerLink: ProjectLink | null;
  sessionLink: ProjectLink | null;
  resourceLinks: ProjectLink[];
  workflows: ProjectInitializedWorkflow[];
}

export interface ProjectWorkflowDefaults {
  ownerAgentId: string | null;
  operatorSessionName: string | null;
}

export interface AttachProjectWorkflowRunInput {
  projectRef: string;
  workflowRunId: string;
  role?: ProjectWorkflowLinkRole | null;
  createdBy?: string;
  createdByAgentId?: string;
  createdBySessionName?: string;
}

export interface AttachProjectWorkflowRunResult {
  details: ProjectDetails;
  workflow: ProjectWorkflowLinkSurface;
  defaults: ProjectWorkflowDefaults;
}

export interface StartProjectWorkflowRunInput {
  projectRef: string;
  workflowSpecId: string;
  workflowRunId?: string;
  role?: ProjectWorkflowLinkRole | null;
  createdBy?: string;
  createdByAgentId?: string;
  createdBySessionName?: string;
}

export interface StartProjectWorkflowRunResult extends AttachProjectWorkflowRunResult {
  run: import("../workflows/types.js").WorkflowRunDetails;
}

export interface ProjectTaskActorInput {
  createdBy?: string;
  createdByAgentId?: string;
  createdBySessionName?: string;
}

export interface ProjectTaskDispatchOptions {
  agentId?: string | null;
  sessionName?: string | null;
  worktree?: TaskWorktreeConfig;
  checkpointIntervalMs?: number;
  reportToSessionName?: string;
  reportEvents?: TaskReportEvent[];
}

export interface ProjectWorkflowTaskRefInput {
  projectRef: string;
  workflowRunId?: string | null;
  nodeKey: string;
}

export interface CreateProjectTaskInput
  extends ProjectWorkflowTaskRefInput,
    ProjectTaskActorInput,
    ProjectTaskDispatchOptions {
  title: string;
  instructions: string;
  priority?: TaskPriority;
  profileId?: string;
  parentTaskId?: string;
  dependsOnTaskIds?: string[];
  profileInput?: TaskProfileInputValues;
  dispatch?: boolean;
}

export interface AttachProjectTaskInput
  extends ProjectWorkflowTaskRefInput,
    ProjectTaskActorInput,
    ProjectTaskDispatchOptions {
  taskId: string;
  dispatch?: boolean;
}

export interface DispatchProjectTaskInput extends ProjectTaskActorInput, ProjectTaskDispatchOptions {
  projectRef: string;
  taskId: string;
}

export type ProjectTaskLaunchResult =
  | {
      mode: "launch_planned";
      task: TaskRecord;
      launchPlan: TaskLaunchPlan;
      readiness: TaskReadiness;
      event: TaskEvent;
    }
  | {
      mode: "dispatched";
      task: TaskRecord;
      assignment: TaskAssignment;
      event: TaskEvent;
      sessionName: string;
      readiness: TaskReadiness;
      primaryArtifact: TaskProfileArtifactRef | null;
      dispatchSummary: string;
    };

export interface ProjectTaskWorkflowContext {
  details: ProjectDetails;
  workflow: ProjectWorkflowLinkSurface;
  defaults: ProjectWorkflowDefaults;
}

export interface CreateProjectTaskResult extends ProjectTaskWorkflowContext {
  task: TaskRecord;
  createdTask: TaskRecord;
  event: TaskEvent;
  relatedEvents: Array<{ task: TaskRecord; event: TaskEvent }>;
  attached: WorkflowNodeRunMutationResult;
  launch: ProjectTaskLaunchResult | null;
}

export interface AttachProjectTaskResult extends ProjectTaskWorkflowContext {
  task: TaskRecord;
  attached: WorkflowNodeRunMutationResult;
  launch: ProjectTaskLaunchResult | null;
}

export interface DispatchProjectTaskResult {
  details: ProjectDetails;
  defaults: ProjectWorkflowDefaults;
  task: TaskRecord;
  project: ProjectTaskSurface | null;
  launch: ProjectTaskLaunchResult;
}
