import { describe, expect, it, mock } from "bun:test";
import { projectRealityReturnSchema } from "../cli/commands/operational-return-schemas.js";
import type { TaskEvent } from "../tasks/types.js";
import type { ProjectDetails } from "./types.js";

// Events for a high-volume task: 250 old progress events followed by one recent
// checkpoint miss. The mocks below mirror the REAL SQL semantics:
// - dbListTaskEvents:      ORDER BY created_at ASC LIMIT ?  (oldest slice)
// - dbListRecentTaskEvents: ORDER BY created_at DESC, id DESC LIMIT ?, re-ordered ASC
const HIGH_VOLUME_BASE_AT = REALITY_FIXTURE_EVALUATED_AT - 1_000_000;
const highVolumeEvents: TaskEvent[] = [
  ...Array.from({ length: 250 }, (_, index) => ({
    id: index + 1,
    taskId: "task-high-volume",
    type: "task.progress" as const,
    message: `Progress sync ${index + 1}`,
    createdAt: HIGH_VOLUME_BASE_AT + index,
  })),
  {
    id: 251,
    taskId: "task-high-volume",
    type: "task.checkpoint.missed" as const,
    message: "Checkpoint missed; report still pending.",
    createdAt: HIGH_VOLUME_BASE_AT + 300,
  },
];

mock.module("../tasks/task-db.js", () => ({
  dbGetTask: (taskId: string) => ({
    id: taskId,
    title: "High-volume task",
    status: "in_progress",
    priority: "high",
    progress: 65,
    summary: null,
    blockerReason: null,
  }),
  dbGetActiveAssignment: () => ({
    id: "assignment-high-volume",
    status: "accepted",
    checkpointDueAt: REALITY_FIXTURE_EVALUATED_AT + 60_000,
    checkpointLastReportAt: HIGH_VOLUME_BASE_AT,
    checkpointOverdueCount: 0,
  }),
  dbListTaskEvents: (taskId: string, limit = 100) =>
    highVolumeEvents
      .filter((event) => event.taskId === taskId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, limit),
  dbListRecentTaskEvents: (taskId: string, limit = 100) =>
    highVolumeEvents
      .filter((event) => event.taskId === taskId)
      .sort((left, right) => right.createdAt - left.createdAt || right.id - left.id)
      .slice(0, limit)
      .reverse(),
}));

mock.module("../workflows/service.js", () => ({
  getWorkflowRunDetails: (workflowRunId: string) => ({
    run: { id: workflowRunId, title: "High-volume workflow", status: "running" },
    nodes: [
      {
        id: "wf-node-high-volume",
        specNodeKey: "implement",
        label: "Implement",
        kind: "task",
        requirement: "required",
        releaseMode: "auto",
        status: "running",
        currentTaskId: "task-high-volume",
        taskAttempts: [{ taskId: "task-high-volume", attempt: 1 }],
      },
    ],
  }),
}));

mock.module("../tasks/task-doc.js", () => ({
  getTaskDocPath: (task: { id: string }) => `/state/tasks/${task.id}/TASK.md`,
  taskDocExists: () => false,
  readTaskDocFrontmatter: () => ({}),
}));
import {
  blockedHotPathFixture,
  emptyProjectFallbackFixture,
  overdueCheckpointFixture,
  projectWithoutExecutionFixture,
  readyFocusedWorkflowFixture,
  REALITY_FIXTURE_EVALUATED_AT,
  runtimeDocumentDivergenceFixture,
} from "./__fixtures__/reality.js";
import { buildProjectReality, collectProjectRealityState } from "./reality.js";

describe("project reality projection", () => {
  it("keeps task runtime authoritative when TASK.md diverges", () => {
    const state = runtimeDocumentDivergenceFixture();
    const before = structuredClone(state);
    const projection = buildProjectReality(state, REALITY_FIXTURE_EVALUATED_AT);

    expect(state).toEqual(before);
    expect(projection.authority).toEqual({
      project: "project_record",
      workflows: "workflow_runtime",
      tasks: "task_runtime",
      task_document: "non_authoritative",
    });
    expect(projection.document_divergences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task_id: "task-reality",
          field: "status",
          runtime_value: "in_progress",
          document_value: "open",
          authoritative_source: "task_runtime",
        }),
        expect.objectContaining({
          task_id: "task-reality",
          field: "progress",
          runtime_value: 65,
          document_value: 10,
          authoritative_source: "task_runtime",
        }),
      ]),
    );
    expect(projection.recommended_next_action).toMatchObject({
      type: "follow_project_next_step",
      source: "project_next_step",
      signal: {
        ref: "project:proj-reality:next_step",
      },
      precedence: {
        rank: 3,
      },
    });
  });

  it("selects an overdue checkpoint before the manual project next step", () => {
    const projection = buildProjectReality(overdueCheckpointFixture(), REALITY_FIXTURE_EVALUATED_AT);

    expect(projection.attention_signals).toContainEqual(
      expect.objectContaining({
        type: "checkpoint_overdue",
        source: "checkpoint_event",
        signal: expect.objectContaining({
          ref: "task_event:88",
          event_id: 88,
          task_id: "task-reality",
        }),
      }),
    );
    expect(projection.recommended_next_action).toMatchObject({
      type: "request_checkpoint_report",
      source: "checkpoint_event",
      signal: {
        ref: "task_event:88",
      },
      precedence: {
        rank: 2,
      },
    });
    expect(projection.recommended_next_action.reason).toContain("precedes project.next_step");
  });

  it("selects a blocked required hot path before checkpoint and manual signals", () => {
    const projection = buildProjectReality(blockedHotPathFixture(), REALITY_FIXTURE_EVALUATED_AT);

    expect(projection.attention_signals[0]).toMatchObject({
      type: "required_blocker",
      severity: "blocking",
      source: "task_runtime",
      signal: {
        ref: "task:task-reality:blocked",
        task_id: "task-reality",
      },
    });
    expect(projection.recommended_next_action).toMatchObject({
      type: "resolve_required_blocker",
      source: "task_runtime",
      signal: {
        ref: "task:task-reality:blocked",
      },
      precedence: {
        rank: 1,
      },
    });
    expect(projection.recommended_next_action.action).toContain("Independent review evidence is missing");
  });

  it("uses the manual next step for a project without workflow or task", () => {
    const projection = buildProjectReality(projectWithoutExecutionFixture(), REALITY_FIXTURE_EVALUATED_AT);

    expect(projection.authoritative_state.workflows).toEqual([]);
    expect(projection.authoritative_state.tasks).toEqual([]);
    expect(projection.attention_signals).toContainEqual(
      expect.objectContaining({
        type: "project_without_execution",
        signal: expect.objectContaining({
          ref: "project:proj-reality:execution_missing",
        }),
      }),
    );
    expect(projection.recommended_next_action).toMatchObject({
      type: "follow_project_next_step",
      action: "Define the kickoff owner.",
      source: "project_next_step",
      signal: {
        ref: "project:proj-reality:next_step",
      },
    });
  });

  it("advances a ready focused workflow only when higher-precedence signals are absent", () => {
    const projection = buildProjectReality(readyFocusedWorkflowFixture(), REALITY_FIXTURE_EVALUATED_AT);

    expect(projection.recommended_next_action).toMatchObject({
      type: "advance_focused_workflow",
      source: "workflow_runtime",
      signal: {
        ref: "workflow_node:wf-node-reality:ready",
      },
      precedence: {
        rank: 4,
      },
    });
  });

  it("always emits one schema-valid fallback action when no execution signal exists", () => {
    const projection = buildProjectReality(emptyProjectFallbackFixture(), REALITY_FIXTURE_EVALUATED_AT);

    expect(projection.recommended_next_action).toMatchObject({
      type: "define_project_execution",
      source: "project_state",
      signal: {
        ref: "project:proj-reality:execution_missing",
      },
      precedence: {
        rank: 5,
      },
    });
    expect(projectRealityReturnSchema.parse(projection)).toEqual(projection);
  });

  it("reads the most recent task events for high-volume tasks", () => {
    const details = {
      project: {
        id: "proj-high-volume",
        slug: "high-volume",
        title: "High volume",
        status: "active",
        summary: "",
        hypothesis: "",
        nextStep: "",
        lastSignalAt: REALITY_FIXTURE_EVALUATED_AT,
        createdAt: REALITY_FIXTURE_EVALUATED_AT,
        updatedAt: REALITY_FIXTURE_EVALUATED_AT,
      },
      tags: [],
      links: [],
      linkedWorkflows: [
        {
          linkId: "link-high-volume",
          role: "primary",
          workflowRunId: "wf-run-high-volume",
          workflowRunTitle: "High-volume workflow",
          workflowRunStatus: "running",
          workflowSpecId: null,
          workflowSpecTitle: null,
          createdAt: REALITY_FIXTURE_EVALUATED_AT,
          updatedAt: REALITY_FIXTURE_EVALUATED_AT,
        },
      ],
      workflowAggregate: null,
      operational: null,
    } as unknown as ProjectDetails;

    const state = collectProjectRealityState(details);
    const task = state.tasks.find((candidate) => candidate.task_id === "task-high-volume");

    // The recent checkpoint miss (event 251) must be visible even though the task
    // has more than 200 older progress events.
    expect(task?.latest_checkpoint_event).toEqual({
      event_id: 251,
      created_at: HIGH_VOLUME_BASE_AT + 300,
      message: "Checkpoint missed; report still pending.",
    });
    expect(task?.latest_progress_at).toBe(HIGH_VOLUME_BASE_AT + 249);

    const projection = buildProjectReality(state, REALITY_FIXTURE_EVALUATED_AT);
    expect(projection.attention_signals).toContainEqual(
      expect.objectContaining({
        type: "missing_report",
        source: "checkpoint_event",
        signal: expect.objectContaining({
          ref: "task_event:251",
          event_id: 251,
          task_id: "task-high-volume",
        }),
      }),
    );
    expect(projection.recommended_next_action).toMatchObject({
      type: "request_checkpoint_report",
      source: "checkpoint_event",
      signal: { ref: "task_event:251" },
    });
  });

  it("includes source, reason, and signal reference in every recommendation", () => {
    for (const fixture of [
      runtimeDocumentDivergenceFixture(),
      overdueCheckpointFixture(),
      blockedHotPathFixture(),
      projectWithoutExecutionFixture(),
      readyFocusedWorkflowFixture(),
      emptyProjectFallbackFixture(),
    ]) {
      const projection = buildProjectReality(fixture, REALITY_FIXTURE_EVALUATED_AT);
      expect(projectRealityReturnSchema.parse(projection)).toEqual(projection);
      const action = projection.recommended_next_action;
      expect(action.source.length).toBeGreaterThan(0);
      expect(action.reason.length).toBeGreaterThan(0);
      expect(action.signal.ref.length).toBeGreaterThan(0);
    }
  });
});
