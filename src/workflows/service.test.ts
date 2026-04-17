import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

mock.module("../omni/session-stream.js", () => ({
  publishSessionPrompt: mock(async () => {}),
}));

const {
  archiveWorkflowNodeRun,
  attachTaskToWorkflowNodeRun,
  cancelWorkflowNodeRun,
  createWorkflowSpec,
  getWorkflowRunDetails,
  releaseWorkflowNodeRun,
  skipWorkflowNodeRun,
  startWorkflowRun,
} = await import("./index.js");

const { completeTask, createTask } = await import("../tasks/index.js");

afterAll(() => mock.restore());

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-workflows-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("workflow substrate v1 service", () => {
  it("creates a spec and starts a run with structural node states", () => {
    const spec = createWorkflowSpec({
      id: "wf-spec-editorial",
      title: "Editorial",
      nodes: [
        { key: "draft", label: "Draft" },
        { key: "approve", label: "Approve", kind: "approval" },
        { key: "publish", label: "Publish" },
      ],
      edges: [
        { from: "draft", to: "approve" },
        { from: "approve", to: "publish" },
      ],
    });

    expect(spec.nodes).toEqual([
      expect.objectContaining({ key: "draft", kind: "task", requirement: "required", releaseMode: "auto" }),
      expect.objectContaining({ key: "approve", kind: "approval", requirement: "required", releaseMode: "manual" }),
      expect.objectContaining({ key: "publish", kind: "task", requirement: "required", releaseMode: "auto" }),
    ]);

    const run = startWorkflowRun(spec.id, { runId: "wf-run-editorial-1" });
    expect(run.run.status).toBe("ready");
    expect(run.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ specNodeKey: "draft", status: "ready", waitingOnNodeKeys: [] }),
        expect.objectContaining({ specNodeKey: "approve", status: "pending", waitingOnNodeKeys: ["draft"] }),
        expect.objectContaining({ specNodeKey: "publish", status: "pending", waitingOnNodeKeys: ["approve"] }),
      ]),
    );
  });

  it("moves downstream nodes through task completion and manual release", async () => {
    const spec = createWorkflowSpec({
      id: "wf-spec-release",
      title: "Manual release flow",
      nodes: [
        { key: "build", label: "Build" },
        { key: "gate", label: "Gate", kind: "approval" },
        { key: "ship", label: "Ship" },
      ],
      edges: [
        { from: "build", to: "gate" },
        { from: "gate", to: "ship" },
      ],
    });
    const run = startWorkflowRun(spec.id, { runId: "wf-run-release-1" });

    const buildTask = await createTask({
      title: "Build artifact",
      instructions: "Produce the release candidate",
      createdBy: "test",
    });
    attachTaskToWorkflowNodeRun(run.run.id, "build", buildTask.task.id);

    await completeTask(buildTask.task.id, {
      actor: "test",
      message: "ready for approval",
    });

    let details = getWorkflowRunDetails(run.run.id)!;
    expect(details.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          specNodeKey: "build",
          status: "done",
          currentTask: expect.objectContaining({ id: buildTask.task.id }),
        }),
        expect.objectContaining({ specNodeKey: "gate", status: "awaiting_release", waitingOnNodeKeys: [] }),
        expect.objectContaining({ specNodeKey: "ship", status: "pending", waitingOnNodeKeys: ["gate"] }),
      ]),
    );
    expect(details.run.status).toBe("waiting");

    releaseWorkflowNodeRun(run.run.id, "gate", { actor: "test" });
    details = getWorkflowRunDetails(run.run.id)!;
    expect(details.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ specNodeKey: "gate", status: "done" }),
        expect.objectContaining({ specNodeKey: "ship", status: "ready", waitingOnNodeKeys: [] }),
      ]),
    );
    expect(details.run.status).toBe("ready");
  });

  it("skips optional nodes and enforces one workflow node owner per task", async () => {
    const spec = createWorkflowSpec({
      id: "wf-spec-optional",
      title: "Optional branch",
      nodes: [
        { key: "core", label: "Core task" },
        { key: "secondary", label: "Secondary task" },
        { key: "nice_to_have", label: "Nice to have", requirement: "optional" },
      ],
      edges: [],
    });
    const run = startWorkflowRun(spec.id, { runId: "wf-run-optional-1" });

    const optionalResult = skipWorkflowNodeRun(run.run.id, "nice_to_have");
    expect(optionalResult.nodeRun.status).toBe("skipped");

    const sharedTask = await createTask({
      title: "Shared task",
      instructions: "Attach only once",
      createdBy: "test",
    });
    attachTaskToWorkflowNodeRun(run.run.id, "core", sharedTask.task.id);

    expect(() => attachTaskToWorkflowNodeRun(run.run.id, "secondary", sharedTask.task.id)).toThrow(
      /already belongs to workflow node run/,
    );
  });

  it("does not allow attaching a task to a downstream node before predecessors are satisfied", async () => {
    const spec = createWorkflowSpec({
      id: "wf-spec-gating",
      title: "Sequential gating",
      nodes: [
        { key: "build", label: "Build" },
        { key: "ship", label: "Ship" },
      ],
      edges: [{ from: "build", to: "ship" }],
    });
    const run = startWorkflowRun(spec.id, { runId: "wf-run-gating-1" });

    const shipTask = await createTask({
      title: "Ship attempt",
      instructions: "Should stay behind build",
      createdBy: "test",
    });

    expect(() => attachTaskToWorkflowNodeRun(run.run.id, "ship", shipTask.task.id)).toThrow(/waiting on build/);
  });

  it("unblocks downstream nodes when a predecessor is archived or an optional predecessor is cancelled", () => {
    const archivedSpec = createWorkflowSpec({
      id: "wf-spec-archive-unblock",
      title: "Archive predecessor",
      nodes: [
        { key: "a", label: "A" },
        { key: "b", label: "B" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    const archivedRun = startWorkflowRun(archivedSpec.id, { runId: "wf-run-archive-unblock-1" });
    const archivedDetails = archiveWorkflowNodeRun(archivedRun.run.id, "a").details;
    expect(archivedDetails.run.status).toBe("ready");
    expect(archivedDetails.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ specNodeKey: "a", status: "archived" }),
        expect.objectContaining({ specNodeKey: "b", status: "ready", waitingOnNodeKeys: [] }),
      ]),
    );

    const cancelledSpec = createWorkflowSpec({
      id: "wf-spec-cancel-unblock",
      title: "Cancel optional predecessor",
      nodes: [
        { key: "a", label: "Optional A", requirement: "optional" },
        { key: "b", label: "B" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    const cancelledRun = startWorkflowRun(cancelledSpec.id, { runId: "wf-run-cancel-unblock-1" });
    const cancelledDetails = cancelWorkflowNodeRun(cancelledRun.run.id, "a").details;
    expect(cancelledDetails.run.status).toBe("ready");
    expect(cancelledDetails.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ specNodeKey: "a", status: "cancelled", requirement: "optional" }),
        expect.objectContaining({ specNodeKey: "b", status: "ready", waitingOnNodeKeys: [] }),
      ]),
    );
  });
});
