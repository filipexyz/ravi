import { describe, expect, it } from "bun:test";
import { projectRealityReturnSchema } from "../cli/commands/operational-return-schemas.js";
import {
  blockedHotPathFixture,
  emptyProjectFallbackFixture,
  overdueCheckpointFixture,
  projectWithoutExecutionFixture,
  readyFocusedWorkflowFixture,
  REALITY_FIXTURE_EVALUATED_AT,
  runtimeDocumentDivergenceFixture,
} from "./__fixtures__/reality.js";
import { buildProjectReality } from "./reality.js";

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
