import type {
  ProjectRealityAuthoritativeState,
  ProjectRealityTaskState,
  ProjectRealityWorkflowState,
} from "../reality.js";

export const REALITY_FIXTURE_EVALUATED_AT = 1_800_000_000_000;

function baseWorkflow(overrides: Partial<ProjectRealityWorkflowState> = {}): ProjectRealityWorkflowState {
  return {
    workflow_run_id: "wf-run-reality",
    title: "Reality workflow",
    status: "running",
    role: "primary",
    is_focused: true,
    exists: true,
    nodes: [
      {
        node_run_id: "wf-node-reality",
        node_key: "implement",
        node_label: "Implement",
        kind: "task",
        requirement: "required",
        release_mode: "auto",
        status: "running",
        current_task_id: "task-reality",
        task_attempt_ids: ["task-reality"],
      },
    ],
    ...overrides,
  };
}

function baseTask(overrides: Partial<ProjectRealityTaskState> = {}): ProjectRealityTaskState {
  return {
    task_id: "task-reality",
    title: "Implement reality projection",
    status: "in_progress",
    priority: "high",
    progress: 65,
    summary: null,
    blocker_reason: null,
    workflow_run_id: "wf-run-reality",
    node_run_id: "wf-node-reality",
    node_key: "implement",
    node_label: "Implement",
    node_requirement: "required",
    is_current: true,
    attempt: 1,
    assignment: {
      assignment_id: "assignment-reality",
      status: "accepted",
      checkpoint_due_at: REALITY_FIXTURE_EVALUATED_AT + 60_000,
      checkpoint_last_report_at: REALITY_FIXTURE_EVALUATED_AT - 60_000,
      checkpoint_overdue_count: 0,
    },
    latest_checkpoint_event: null,
    latest_progress_at: REALITY_FIXTURE_EVALUATED_AT - 60_000,
    document: {
      path: "/state/tasks/task-reality/TASK.md",
      exists: true,
      frontmatter: {
        title: "Implement reality projection",
        status: "in_progress",
        priority: "high",
        progress: 65,
        summary: null,
        blocker_reason: null,
      },
    },
    ...overrides,
  };
}

function baseState(
  input: { nextStep?: string; workflows?: ProjectRealityWorkflowState[]; tasks?: ProjectRealityTaskState[] } = {},
): ProjectRealityAuthoritativeState {
  return {
    project: {
      project_id: "proj-reality",
      slug: "project-reality",
      status: "active",
      next_step: input.nextStep ?? "Review the implementation evidence.",
    },
    workflows: input.workflows ?? [baseWorkflow()],
    tasks: input.tasks ?? [baseTask()],
  };
}

export function runtimeDocumentDivergenceFixture(): ProjectRealityAuthoritativeState {
  return baseState({
    tasks: [
      baseTask({
        document: {
          path: "/state/tasks/task-reality/TASK.md",
          exists: true,
          frontmatter: {
            title: "Implement reality projection",
            status: "open",
            priority: "high",
            progress: 10,
            summary: null,
            blocker_reason: null,
          },
        },
      }),
    ],
  });
}

export function overdueCheckpointFixture(): ProjectRealityAuthoritativeState {
  return baseState({
    tasks: [
      baseTask({
        assignment: {
          assignment_id: "assignment-reality",
          status: "accepted",
          checkpoint_due_at: REALITY_FIXTURE_EVALUATED_AT - 120_000,
          checkpoint_last_report_at: REALITY_FIXTURE_EVALUATED_AT - 600_000,
          checkpoint_overdue_count: 2,
        },
        latest_checkpoint_event: {
          event_id: 88,
          created_at: REALITY_FIXTURE_EVALUATED_AT - 30_000,
          message: "Checkpoint overdue 2x; real report still pending.",
        },
        latest_progress_at: REALITY_FIXTURE_EVALUATED_AT - 600_000,
      }),
    ],
  });
}

export function blockedHotPathFixture(): ProjectRealityAuthoritativeState {
  const workflow = baseWorkflow({
    status: "running",
    nodes: [
      {
        node_run_id: "wf-node-reality",
        node_key: "implement",
        node_label: "Implement",
        kind: "task",
        requirement: "required",
        release_mode: "auto",
        status: "blocked",
        current_task_id: "task-reality",
        task_attempt_ids: ["task-reality"],
      },
    ],
  });
  const task = baseTask({
    status: "blocked",
    blocker_reason: "Independent review evidence is missing.",
    assignment: {
      assignment_id: "assignment-reality",
      status: "blocked",
      checkpoint_due_at: REALITY_FIXTURE_EVALUATED_AT - 120_000,
      checkpoint_last_report_at: REALITY_FIXTURE_EVALUATED_AT - 600_000,
      checkpoint_overdue_count: 2,
    },
  });
  return baseState({ workflows: [workflow], tasks: [task] });
}

export function projectWithoutExecutionFixture(): ProjectRealityAuthoritativeState {
  return baseState({
    nextStep: "Define the kickoff owner.",
    workflows: [],
    tasks: [],
  });
}

export function readyFocusedWorkflowFixture(): ProjectRealityAuthoritativeState {
  const workflow = baseWorkflow({
    status: "ready",
    nodes: [
      {
        node_run_id: "wf-node-reality",
        node_key: "implement",
        node_label: "Implement",
        kind: "task",
        requirement: "required",
        release_mode: "auto",
        status: "ready",
        current_task_id: null,
        task_attempt_ids: [],
      },
    ],
  });
  return baseState({
    nextStep: "",
    workflows: [workflow],
    tasks: [],
  });
}

export function emptyProjectFallbackFixture(): ProjectRealityAuthoritativeState {
  return baseState({
    nextStep: "",
    workflows: [],
    tasks: [],
  });
}
