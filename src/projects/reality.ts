import { dbGetActiveAssignment, dbGetTask, dbListRecentTaskEvents } from "../tasks/task-db.js";
import { getTaskDocPath, readTaskDocFrontmatter, taskDocExists } from "../tasks/task-doc.js";
import type { TaskAssignment, TaskEvent, TaskPriority, TaskStatus } from "../tasks/types.js";
import { getWorkflowRunDetails } from "../workflows/service.js";
import type {
  WorkflowNodeKind,
  WorkflowNodeReleaseMode,
  WorkflowNodeRequirement,
  WorkflowNodeRunStatus,
  WorkflowRunStatus,
} from "../workflows/types.js";
import type { ProjectDetails, ProjectStatus } from "./types.js";

export type ProjectRealitySource =
  | "task_runtime"
  | "workflow_runtime"
  | "checkpoint_event"
  | "project_next_step"
  | "project_state"
  | "task_document";

export type ProjectRealitySignalKind =
  | "required_blocker"
  | "checkpoint_overdue"
  | "missing_report"
  | "document_divergence"
  | "missing_workflow"
  | "missing_task"
  | "project_next_step"
  | "focused_workflow_ready"
  | "current_task"
  | "project_without_execution";

export interface ProjectRealitySignalReference {
  kind: ProjectRealitySignalKind;
  ref: string;
  project_id: string;
  workflow_run_id?: string;
  node_run_id?: string;
  task_id?: string;
  event_id?: number;
  field?: string;
}

export interface ProjectRealityAttentionSignal {
  type: ProjectRealitySignalKind;
  severity: "blocking" | "attention";
  source: ProjectRealitySource;
  reason: string;
  signal: ProjectRealitySignalReference;
}

export interface ProjectRealityDocumentDivergence {
  task_id: string;
  document_path: string;
  field: "title" | "status" | "priority" | "progress" | "summary" | "blocker_reason";
  runtime_value: string | number | null;
  document_value: string | number | null;
  authoritative_source: "task_runtime";
  signal: ProjectRealitySignalReference;
}

export interface ProjectRealityWorkflowNodeState {
  node_run_id: string;
  node_key: string;
  node_label: string;
  kind: WorkflowNodeKind;
  requirement: WorkflowNodeRequirement;
  release_mode: WorkflowNodeReleaseMode;
  status: WorkflowNodeRunStatus;
  current_task_id: string | null;
  task_attempt_ids: string[];
}

export interface ProjectRealityWorkflowState {
  workflow_run_id: string;
  title: string | null;
  status: WorkflowRunStatus | null;
  role: string | null;
  is_focused: boolean;
  exists: boolean;
  nodes: ProjectRealityWorkflowNodeState[];
}

export interface ProjectRealityTaskDocumentState {
  path: string;
  exists: boolean;
  frontmatter: {
    title: string | null;
    status: TaskStatus | null;
    priority: TaskPriority | null;
    progress: number | null;
    summary: string | null;
    blocker_reason: string | null;
  } | null;
}

export interface ProjectRealityTaskState {
  task_id: string;
  title: string | null;
  status: TaskStatus | null;
  priority: TaskPriority | null;
  progress: number | null;
  summary: string | null;
  blocker_reason: string | null;
  workflow_run_id: string;
  node_run_id: string;
  node_key: string;
  node_label: string;
  node_requirement: WorkflowNodeRequirement;
  is_current: boolean;
  attempt: number | null;
  assignment: {
    assignment_id: string;
    status: TaskAssignment["status"];
    checkpoint_due_at: number | null;
    checkpoint_last_report_at: number | null;
    checkpoint_overdue_count: number;
  } | null;
  latest_checkpoint_event: {
    event_id: number;
    created_at: number;
    message: string | null;
  } | null;
  latest_progress_at: number | null;
  document: ProjectRealityTaskDocumentState;
}

export interface ProjectRealityAuthoritativeState {
  project: {
    project_id: string;
    slug: string;
    status: ProjectStatus;
    next_step: string;
  };
  workflows: ProjectRealityWorkflowState[];
  tasks: ProjectRealityTaskState[];
}

export type ProjectRealityActionType =
  | "resolve_required_blocker"
  | "request_checkpoint_report"
  | "follow_project_next_step"
  | "advance_focused_workflow"
  | "continue_current_task"
  | "reconcile_workflow_link"
  | "define_project_execution";

export interface ProjectRealityRecommendedAction {
  type: ProjectRealityActionType;
  action: string;
  source: Exclude<ProjectRealitySource, "task_document">;
  reason: string;
  signal: ProjectRealitySignalReference;
  precedence: {
    rank: number;
    rule: string;
  };
}

export interface ProjectRealityProjection {
  evaluated_at: number;
  authority: {
    project: "project_record";
    workflows: "workflow_runtime";
    tasks: "task_runtime";
    task_document: "non_authoritative";
  };
  authoritative_state: ProjectRealityAuthoritativeState;
  attention_signals: ProjectRealityAttentionSignal[];
  document_divergences: ProjectRealityDocumentDivergence[];
  recommended_next_action: ProjectRealityRecommendedAction;
}

const PRECEDENCE_RULE =
  "required_blocker > overdue_checkpoint_or_missing_report > project_next_step > focused_workflow_ready > runtime_fallback";

function signalReference(
  state: ProjectRealityAuthoritativeState,
  input: Omit<ProjectRealitySignalReference, "project_id">,
): ProjectRealitySignalReference {
  return {
    ...input,
    project_id: state.project.project_id,
  };
}

function toTaskDocumentState(
  task: { id: string; taskDir?: string } | null,
  taskId: string,
): ProjectRealityTaskDocumentState {
  const taskRef = task ?? { id: taskId };
  const path = getTaskDocPath(taskRef);
  const exists = taskDocExists(taskRef);
  if (!exists) {
    return {
      path,
      exists: false,
      frontmatter: null,
    };
  }

  const frontmatter = readTaskDocFrontmatter(taskRef);
  return {
    path,
    exists: true,
    frontmatter: {
      title: frontmatter.title ?? null,
      status: frontmatter.status ?? null,
      priority: frontmatter.priority ?? null,
      progress: frontmatter.progress ?? null,
      summary: frontmatter.summary ?? null,
      blocker_reason: frontmatter.blockerReason ?? null,
    },
  };
}

function latestEvent(events: TaskEvent[], type: TaskEvent["type"]): TaskEvent | null {
  return (
    events
      .filter((event) => event.type === type)
      .sort((left, right) => right.createdAt - left.createdAt || right.id - left.id)[0] ?? null
  );
}

function toAssignmentState(assignment: TaskAssignment | null): ProjectRealityTaskState["assignment"] {
  if (!assignment) {
    return null;
  }
  return {
    assignment_id: assignment.id,
    status: assignment.status,
    checkpoint_due_at: assignment.checkpointDueAt ?? null,
    checkpoint_last_report_at: assignment.checkpointLastReportAt ?? null,
    checkpoint_overdue_count: assignment.checkpointOverdueCount ?? 0,
  };
}

export function collectProjectRealityState(details: ProjectDetails): ProjectRealityAuthoritativeState {
  const focusedWorkflowRunId = details.workflowAggregate?.focusedWorkflowRunId ?? null;
  const workflows: ProjectRealityWorkflowState[] = [];
  const tasks = new Map<string, ProjectRealityTaskState>();

  for (const linkedWorkflow of details.linkedWorkflows) {
    const workflow = getWorkflowRunDetails(linkedWorkflow.workflowRunId);
    const workflowState: ProjectRealityWorkflowState = {
      workflow_run_id: linkedWorkflow.workflowRunId,
      title: workflow?.run.title ?? linkedWorkflow.workflowRunTitle,
      status: workflow?.run.status ?? linkedWorkflow.workflowRunStatus,
      role: linkedWorkflow.role,
      is_focused: linkedWorkflow.workflowRunId === focusedWorkflowRunId,
      exists: Boolean(workflow),
      nodes: [],
    };

    if (workflow) {
      for (const node of workflow.nodes) {
        const attemptsByTaskId = new Map<string, number | null>(
          node.taskAttempts.map((attempt) => [attempt.taskId, attempt.attempt]),
        );
        if (node.currentTaskId && !attemptsByTaskId.has(node.currentTaskId)) {
          attemptsByTaskId.set(node.currentTaskId, null);
        }
        const taskAttemptIds = [...attemptsByTaskId.keys()].sort();

        workflowState.nodes.push({
          node_run_id: node.id,
          node_key: node.specNodeKey,
          node_label: node.label,
          kind: node.kind,
          requirement: node.requirement,
          release_mode: node.releaseMode,
          status: node.status,
          current_task_id: node.currentTaskId ?? null,
          task_attempt_ids: taskAttemptIds,
        });

        for (const [taskId, attempt] of attemptsByTaskId) {
          const task = dbGetTask(taskId);
          const events = task ? dbListRecentTaskEvents(taskId, 200) : [];
          const checkpointEvent = latestEvent(events, "task.checkpoint.missed");
          const progressEvent = latestEvent(events, "task.progress");
          tasks.set(`${linkedWorkflow.workflowRunId}:${node.id}:${taskId}`, {
            task_id: taskId,
            title: task?.title ?? null,
            status: task?.status ?? null,
            priority: task?.priority ?? null,
            progress: task?.progress ?? null,
            summary: task?.summary ?? null,
            blocker_reason: task?.blockerReason ?? null,
            workflow_run_id: linkedWorkflow.workflowRunId,
            node_run_id: node.id,
            node_key: node.specNodeKey,
            node_label: node.label,
            node_requirement: node.requirement,
            is_current: node.currentTaskId === taskId,
            attempt,
            assignment: task ? toAssignmentState(dbGetActiveAssignment(taskId)) : null,
            latest_checkpoint_event: checkpointEvent
              ? {
                  event_id: checkpointEvent.id,
                  created_at: checkpointEvent.createdAt,
                  message: checkpointEvent.message ?? null,
                }
              : null,
            latest_progress_at: progressEvent?.createdAt ?? null,
            document: toTaskDocumentState(task, taskId),
          });
        }
      }
      workflowState.nodes.sort(
        (left, right) =>
          left.node_key.localeCompare(right.node_key) || left.node_run_id.localeCompare(right.node_run_id),
      );
    }

    workflows.push(workflowState);
  }

  workflows.sort(
    (left, right) =>
      Number(right.is_focused) - Number(left.is_focused) ||
      (left.role === "primary" ? -1 : 0) - (right.role === "primary" ? -1 : 0) ||
      left.workflow_run_id.localeCompare(right.workflow_run_id),
  );

  return {
    project: {
      project_id: details.project.id,
      slug: details.project.slug,
      status: details.project.status,
      next_step: details.project.nextStep,
    },
    workflows,
    tasks: [...tasks.values()].sort(
      (left, right) =>
        left.workflow_run_id.localeCompare(right.workflow_run_id) ||
        left.node_key.localeCompare(right.node_key) ||
        (left.attempt ?? Number.MAX_SAFE_INTEGER) - (right.attempt ?? Number.MAX_SAFE_INTEGER) ||
        left.task_id.localeCompare(right.task_id),
    ),
  };
}

function valuesEqual(left: string | number | null, right: string | number | null): boolean {
  return left === right;
}

function deriveDocumentDivergences(state: ProjectRealityAuthoritativeState): ProjectRealityDocumentDivergence[] {
  const divergences: ProjectRealityDocumentDivergence[] = [];

  for (const task of state.tasks) {
    if (!task.is_current || !task.document.exists || !task.document.frontmatter || !task.status) {
      continue;
    }
    const fields: Array<{
      field: ProjectRealityDocumentDivergence["field"];
      runtime: string | number | null;
      document: string | number | null;
    }> = [
      { field: "title", runtime: task.title, document: task.document.frontmatter.title },
      { field: "status", runtime: task.status, document: task.document.frontmatter.status },
      { field: "priority", runtime: task.priority, document: task.document.frontmatter.priority },
      { field: "progress", runtime: task.progress, document: task.document.frontmatter.progress },
      { field: "summary", runtime: task.summary, document: task.document.frontmatter.summary },
      { field: "blocker_reason", runtime: task.blocker_reason, document: task.document.frontmatter.blocker_reason },
    ];

    for (const field of fields) {
      if (valuesEqual(field.runtime, field.document)) {
        continue;
      }
      divergences.push({
        task_id: task.task_id,
        document_path: task.document.path,
        field: field.field,
        runtime_value: field.runtime,
        document_value: field.document,
        authoritative_source: "task_runtime",
        signal: signalReference(state, {
          kind: "document_divergence",
          ref: `task_document:${task.task_id}:${field.field}`,
          workflow_run_id: task.workflow_run_id,
          node_run_id: task.node_run_id,
          task_id: task.task_id,
          field: field.field,
        }),
      });
    }
  }

  return divergences.sort(
    (left, right) => left.task_id.localeCompare(right.task_id) || left.field.localeCompare(right.field),
  );
}

interface BlockCandidate {
  workflow: ProjectRealityWorkflowState;
  node: ProjectRealityWorkflowNodeState;
  task: ProjectRealityTaskState | null;
}

function deriveBlockCandidates(state: ProjectRealityAuthoritativeState): BlockCandidate[] {
  const candidates: BlockCandidate[] = [];
  for (const workflow of state.workflows) {
    for (const node of workflow.nodes) {
      if (node.requirement !== "required") {
        continue;
      }
      const task =
        state.tasks.find(
          (candidate) =>
            candidate.workflow_run_id === workflow.workflow_run_id &&
            candidate.node_run_id === node.node_run_id &&
            candidate.is_current,
        ) ?? null;
      if (node.status === "blocked" || task?.status === "blocked") {
        candidates.push({ workflow, node, task });
      }
    }
  }
  return candidates.sort(
    (left, right) =>
      Number(right.workflow.is_focused) - Number(left.workflow.is_focused) ||
      (left.workflow.role === "primary" ? -1 : 0) - (right.workflow.role === "primary" ? -1 : 0) ||
      left.workflow.workflow_run_id.localeCompare(right.workflow.workflow_run_id) ||
      left.node.node_key.localeCompare(right.node.node_key),
  );
}

interface CheckpointCandidate {
  task: ProjectRealityTaskState;
  kind: "checkpoint_overdue" | "missing_report";
}

function deriveCheckpointCandidates(
  state: ProjectRealityAuthoritativeState,
  evaluatedAt: number,
): CheckpointCandidate[] {
  return state.tasks
    .filter((task) => {
      if (!task.is_current || !task.assignment || !["dispatched", "in_progress"].includes(task.status ?? "")) {
        return false;
      }
      const assignmentOverdue = task.assignment.checkpoint_overdue_count > 0;
      const checkpointEventPending =
        Boolean(task.latest_checkpoint_event) &&
        (task.latest_progress_at === null || (task.latest_checkpoint_event?.created_at ?? 0) > task.latest_progress_at);
      const reportDue = task.assignment.checkpoint_due_at !== null && task.assignment.checkpoint_due_at <= evaluatedAt;
      return assignmentOverdue || checkpointEventPending || reportDue;
    })
    .map((task) => ({
      task,
      kind:
        task.assignment && task.assignment.checkpoint_overdue_count > 0
          ? ("checkpoint_overdue" as const)
          : ("missing_report" as const),
    }))
    .sort(
      (left, right) =>
        (right.task.assignment?.checkpoint_overdue_count ?? 0) -
          (left.task.assignment?.checkpoint_overdue_count ?? 0) ||
        (left.task.assignment?.checkpoint_due_at ?? Number.MAX_SAFE_INTEGER) -
          (right.task.assignment?.checkpoint_due_at ?? Number.MAX_SAFE_INTEGER) ||
        left.task.task_id.localeCompare(right.task.task_id),
    );
}

function checkpointSignal(
  state: ProjectRealityAuthoritativeState,
  candidate: CheckpointCandidate,
): {
  source: "checkpoint_event" | "task_runtime";
  signal: ProjectRealitySignalReference;
} {
  const event = candidate.task.latest_checkpoint_event;
  if (event) {
    return {
      source: "checkpoint_event",
      signal: signalReference(state, {
        kind: candidate.kind,
        ref: `task_event:${event.event_id}`,
        workflow_run_id: candidate.task.workflow_run_id,
        node_run_id: candidate.task.node_run_id,
        task_id: candidate.task.task_id,
        event_id: event.event_id,
      }),
    };
  }
  const assignmentId = candidate.task.assignment?.assignment_id ?? candidate.task.task_id;
  return {
    source: "task_runtime",
    signal: signalReference(state, {
      kind: candidate.kind,
      ref: `task_assignment:${assignmentId}:checkpoint_due_at`,
      workflow_run_id: candidate.task.workflow_run_id,
      node_run_id: candidate.task.node_run_id,
      task_id: candidate.task.task_id,
    }),
  };
}

function deriveAttentionSignals(
  state: ProjectRealityAuthoritativeState,
  divergences: ProjectRealityDocumentDivergence[],
  blocks: BlockCandidate[],
  checkpoints: CheckpointCandidate[],
): ProjectRealityAttentionSignal[] {
  const signals: ProjectRealityAttentionSignal[] = [];

  for (const candidate of blocks) {
    const source = candidate.task?.status === "blocked" ? "task_runtime" : "workflow_runtime";
    const signal = signalReference(state, {
      kind: "required_blocker",
      ref: candidate.task
        ? `task:${candidate.task.task_id}:blocked`
        : `workflow_node:${candidate.node.node_run_id}:blocked`,
      workflow_run_id: candidate.workflow.workflow_run_id,
      node_run_id: candidate.node.node_run_id,
      ...(candidate.task ? { task_id: candidate.task.task_id } : {}),
    });
    signals.push({
      type: "required_blocker",
      severity: "blocking",
      source,
      reason:
        candidate.task?.blocker_reason ??
        `Required workflow node ${candidate.node.node_label} is blocked in runtime state.`,
      signal,
    });
  }

  for (const candidate of checkpoints) {
    const resolved = checkpointSignal(state, candidate);
    signals.push({
      type: candidate.kind,
      severity: "attention",
      source: resolved.source,
      reason:
        candidate.kind === "checkpoint_overdue"
          ? `Task checkpoint is overdue ${candidate.task.assignment?.checkpoint_overdue_count ?? 1} time(s); a current report is still pending.`
          : "The task checkpoint due time passed without a newer progress report.",
      signal: resolved.signal,
    });
  }

  for (const divergence of divergences) {
    signals.push({
      type: "document_divergence",
      severity: "attention",
      source: "task_document",
      reason: `TASK.md ${divergence.field} differs from authoritative task runtime state.`,
      signal: divergence.signal,
    });
  }

  for (const workflow of state.workflows.filter((candidate) => !candidate.exists)) {
    signals.push({
      type: "missing_workflow",
      severity: "attention",
      source: "workflow_runtime",
      reason: "The project link references a workflow run that is not present in workflow runtime.",
      signal: signalReference(state, {
        kind: "missing_workflow",
        ref: `workflow_run:${workflow.workflow_run_id}:missing`,
        workflow_run_id: workflow.workflow_run_id,
      }),
    });
  }

  for (const task of state.tasks.filter((candidate) => candidate.status === null)) {
    signals.push({
      type: "missing_task",
      severity: "attention",
      source: "task_runtime",
      reason: "The workflow node references a task attempt that is not present in task runtime.",
      signal: signalReference(state, {
        kind: "missing_task",
        ref: `task:${task.task_id}:missing`,
        workflow_run_id: task.workflow_run_id,
        node_run_id: task.node_run_id,
        task_id: task.task_id,
      }),
    });
  }

  if (state.workflows.length === 0 && state.tasks.length === 0) {
    signals.push({
      type: "project_without_execution",
      severity: "attention",
      source: "project_state",
      reason: "The project has no linked workflow or workflow-derived task.",
      signal: signalReference(state, {
        kind: "project_without_execution",
        ref: `project:${state.project.project_id}:execution_missing`,
      }),
    });
  }

  return signals.sort(
    (left, right) =>
      (left.severity === "blocking" ? -1 : 0) - (right.severity === "blocking" ? -1 : 0) ||
      left.signal.ref.localeCompare(right.signal.ref),
  );
}

function deriveRecommendedAction(
  state: ProjectRealityAuthoritativeState,
  blocks: BlockCandidate[],
  checkpoints: CheckpointCandidate[],
): ProjectRealityRecommendedAction {
  const block = blocks[0];
  if (block) {
    const taskSignal = block.task?.status === "blocked";
    return {
      type: "resolve_required_blocker",
      action: block.task
        ? `Resolve the blocker for task ${block.task.task_id} (${block.node.node_label}): ${block.task.blocker_reason ?? "inspect the runtime blocker signal"}.`
        : `Resolve the blocker for required workflow node ${block.node.node_label}.`,
      source: taskSignal ? "task_runtime" : "workflow_runtime",
      reason:
        "Selected first because a required blocker precedes checkpoint, project.next_step, and ready-workflow signals.",
      signal: signalReference(state, {
        kind: "required_blocker",
        ref: block.task ? `task:${block.task.task_id}:blocked` : `workflow_node:${block.node.node_run_id}:blocked`,
        workflow_run_id: block.workflow.workflow_run_id,
        node_run_id: block.node.node_run_id,
        ...(block.task ? { task_id: block.task.task_id } : {}),
      }),
      precedence: {
        rank: 1,
        rule: PRECEDENCE_RULE,
      },
    };
  }

  const checkpoint = checkpoints[0];
  if (checkpoint) {
    const resolved = checkpointSignal(state, checkpoint);
    return {
      type: "request_checkpoint_report",
      action: `Request and reconcile a current progress report for task ${checkpoint.task.task_id}.`,
      source: resolved.source,
      reason:
        "Selected because no required blocker exists; an overdue checkpoint or missing report precedes project.next_step and a ready focused workflow.",
      signal: resolved.signal,
      precedence: {
        rank: 2,
        rule: PRECEDENCE_RULE,
      },
    };
  }

  const nextStep = state.project.next_step.trim();
  if (nextStep) {
    return {
      type: "follow_project_next_step",
      action: nextStep,
      source: "project_next_step",
      reason:
        "Selected because no required blocker or overdue/missing report exists; project.next_step precedes a ready focused workflow.",
      signal: signalReference(state, {
        kind: "project_next_step",
        ref: `project:${state.project.project_id}:next_step`,
      }),
      precedence: {
        rank: 3,
        rule: PRECEDENCE_RULE,
      },
    };
  }

  const focusedWorkflow = state.workflows.find((workflow) => workflow.is_focused && workflow.exists);
  const readyNode = focusedWorkflow?.nodes
    .filter((node) => node.status === "ready" || node.status === "awaiting_release")
    .sort(
      (left, right) =>
        (left.status === "awaiting_release" ? -1 : 0) - (right.status === "awaiting_release" ? -1 : 0) ||
        left.node_key.localeCompare(right.node_key),
    )[0];
  if (focusedWorkflow && (readyNode || focusedWorkflow.status === "ready")) {
    const nodeLabel = readyNode?.node_label ?? focusedWorkflow.title ?? focusedWorkflow.workflow_run_id;
    const action =
      readyNode?.status === "awaiting_release" || readyNode?.release_mode === "manual"
        ? `Release the ready node ${nodeLabel} in focused workflow ${focusedWorkflow.workflow_run_id}.`
        : `Advance the ready node ${nodeLabel} in focused workflow ${focusedWorkflow.workflow_run_id}.`;
    return {
      type: "advance_focused_workflow",
      action,
      source: "workflow_runtime",
      reason:
        "Selected because no required blocker, overdue/missing report, or project.next_step exists; the focused workflow is ready.",
      signal: signalReference(state, {
        kind: "focused_workflow_ready",
        ref: readyNode
          ? `workflow_node:${readyNode.node_run_id}:${readyNode.status}`
          : `workflow_run:${focusedWorkflow.workflow_run_id}:ready`,
        workflow_run_id: focusedWorkflow.workflow_run_id,
        ...(readyNode ? { node_run_id: readyNode.node_run_id } : {}),
      }),
      precedence: {
        rank: 4,
        rule: PRECEDENCE_RULE,
      },
    };
  }

  const currentTask = state.tasks
    .filter((task) => task.is_current && ["open", "dispatched", "in_progress"].includes(task.status ?? ""))
    .sort(
      (left, right) =>
        Number(
          state.workflows.find((workflow) => workflow.workflow_run_id === right.workflow_run_id)?.is_focused ?? false,
        ) -
          Number(
            state.workflows.find((workflow) => workflow.workflow_run_id === left.workflow_run_id)?.is_focused ?? false,
          ) || left.task_id.localeCompare(right.task_id),
    )[0];
  if (currentTask) {
    return {
      type: "continue_current_task",
      action: `Continue task ${currentTask.task_id} (${currentTask.node_label}) from authoritative runtime state.`,
      source: "task_runtime",
      reason: "No higher-precedence signal exists; the current runtime task is the remaining executable lead.",
      signal: signalReference(state, {
        kind: "current_task",
        ref: `task:${currentTask.task_id}:${currentTask.status}`,
        workflow_run_id: currentTask.workflow_run_id,
        node_run_id: currentTask.node_run_id,
        task_id: currentTask.task_id,
      }),
      precedence: {
        rank: 5,
        rule: PRECEDENCE_RULE,
      },
    };
  }

  const missingWorkflow = state.workflows.find((workflow) => !workflow.exists);
  if (missingWorkflow) {
    return {
      type: "reconcile_workflow_link",
      action: `Reconcile missing workflow runtime ${missingWorkflow.workflow_run_id} before planning more work.`,
      source: "workflow_runtime",
      reason: "No higher-precedence executable signal exists, and the linked workflow cannot be read from runtime.",
      signal: signalReference(state, {
        kind: "missing_workflow",
        ref: `workflow_run:${missingWorkflow.workflow_run_id}:missing`,
        workflow_run_id: missingWorkflow.workflow_run_id,
      }),
      precedence: {
        rank: 5,
        rule: PRECEDENCE_RULE,
      },
    };
  }

  return {
    type: "define_project_execution",
    action: "Define project.next_step and link a workflow or task before execution.",
    source: "project_state",
    reason: "No required blocker, overdue report, manual next step, ready workflow, or current task exists.",
    signal: signalReference(state, {
      kind: "project_without_execution",
      ref: `project:${state.project.project_id}:execution_missing`,
    }),
    precedence: {
      rank: 5,
      rule: PRECEDENCE_RULE,
    },
  };
}

export function buildProjectReality(
  state: ProjectRealityAuthoritativeState,
  evaluatedAt: number,
): ProjectRealityProjection {
  const documentDivergences = deriveDocumentDivergences(state);
  const blockCandidates = deriveBlockCandidates(state);
  const checkpointCandidates = deriveCheckpointCandidates(state, evaluatedAt);
  const recommendedNextAction = deriveRecommendedAction(state, blockCandidates, checkpointCandidates);

  return {
    evaluated_at: evaluatedAt,
    authority: {
      project: "project_record",
      workflows: "workflow_runtime",
      tasks: "task_runtime",
      task_document: "non_authoritative",
    },
    authoritative_state: state,
    attention_signals: deriveAttentionSignals(state, documentDivergences, blockCandidates, checkpointCandidates),
    document_divergences: documentDivergences,
    recommended_next_action: recommendedNextAction,
  };
}

export function getProjectReality(details: ProjectDetails, evaluatedAt = Date.now()): ProjectRealityProjection {
  return buildProjectReality(collectProjectRealityState(details), evaluatedAt);
}
