import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

const { initProject } = await import("./index.js");

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-project-init-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("project bootstrap", () => {
  it("initializes a project with cheap links and one canonical workflow run", () => {
    const result = initProject({
      title: "Ops Cadence",
      summary: "Keep work aligned",
      hypothesis: "Workflow is the primary attachment",
      nextStep: "Review the ready node",
      ownerAgentId: "main",
      operatorSessionName: "ops-room",
      resources: [
        {
          type: "worktree",
          assetId: "/tmp/ravi.bot",
          label: "ravi.bot worktree",
        },
      ],
      workflowTemplates: ["technical-change"],
      createdBy: "test",
    });

    expect(result.details.project).toMatchObject({
      slug: "ops-cadence",
      ownerAgentId: "main",
      operatorSessionName: "ops-room",
      summary: "Keep work aligned",
      hypothesis: "Workflow is the primary attachment",
      nextStep: "Review the ready node",
    });
    expect(result.ownerLink).toMatchObject({
      assetType: "agent",
      assetId: "main",
      role: "owner",
    });
    expect(result.sessionLink).toMatchObject({
      assetType: "session",
      assetId: "ops-room",
      role: "operator",
    });
    expect(result.resourceLinks).toEqual([
      expect.objectContaining({
        assetType: "resource",
        assetId: "/tmp/ravi.bot",
        role: "substrate",
        metadata: expect.objectContaining({
          type: "worktree",
          locator: "/tmp/ravi.bot",
          label: "ravi.bot worktree",
        }),
      }),
    ]);
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]).toMatchObject({
      source: "template",
      templateId: "technical-change",
      role: "primary",
      workflowStatus: "ready",
      workflowSpecId: "wf-spec-canonical-technical-change-v1",
    });
    expect(result.details.linkedWorkflows).toEqual([
      expect.objectContaining({
        workflowRunId: result.workflows[0]?.workflowRunId,
        workflowSpecId: "wf-spec-canonical-technical-change-v1",
        workflowRunStatus: "ready",
        role: "primary",
      }),
    ]);
    expect(result.details.workflowAggregate).toMatchObject({
      total: 1,
      overallStatus: "ready",
      primaryWorkflowRunId: result.workflows[0]?.workflowRunId,
      primaryWorkflowStatus: "ready",
    });
    expect(result.details.operational).toMatchObject({
      runtimeStatus: "ready",
      workflowCount: 1,
      hottestWorkflowRunId: result.workflows[0]?.workflowRunId,
      hottestTaskId: null,
    });
  });

  it("rejects bootstraps with more than two workflows", () => {
    expect(() =>
      initProject({
        title: "Too many workflows",
        workflowTemplates: ["technical-change", "gated-release", "operational-response"],
      }),
    ).toThrow("Project init supports at most 2 workflows per bootstrap.");
  });
});
