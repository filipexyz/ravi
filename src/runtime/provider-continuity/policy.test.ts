import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dbCreateAgent } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  applyProviderContinuityPlan,
  clearProviderContinuityPolicy,
  createProviderContinuityBatchPreview,
  createProviderContinuityPolicyPreview,
  getProviderContinuityBatch,
  reorderProviderContinuityPolicy,
  setProviderContinuityPolicy,
} from "./policy.js";
import { getProviderContinuityPolicy, writeProviderContinuityPolicy } from "./store.js";
import {
  PROVIDER_CONTINUITY_SNAPSHOT,
  PROVIDER_CONTINUITY_SPEC_VERSION,
  type ProviderContinuityPolicyConfig,
} from "./types.js";

let stateDir: string | null = null;

function policy(
  targets: Array<{ provider: string; model: string }> = [
    { provider: "codex", model: "gpt-5" },
    { provider: "claude", model: "sonnet" },
  ],
): ProviderContinuityPolicyConfig {
  return {
    specVersion: PROVIDER_CONTINUITY_SPEC_VERSION,
    compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
    strategy: "ordered",
    targets,
    deadlineMs: 120_000,
    enabled: true,
  };
}

describe("provider continuity policy and batch control", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-provider-continuity-policy-");
    // Initializes the default `main` agent.
    expect(getProviderContinuityPolicy("main")).toBeNull();
    dbCreateAgent({ id: "agent-a", cwd: stateDir });
    dbCreateAgent({ id: "agent-b", cwd: stateDir });
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("freezes exact order and applies a single-agent CAS plan", () => {
    const preview = createProviderContinuityPolicyPreview({
      agentId: "agent-a",
      desiredPolicy: policy(),
      expectedVersion: 0,
      now: 1_000,
    });
    expect(preview.plan.items[0]).toMatchObject({ action: "create", beforeVersion: 0, valid: true });
    expect(preview.plan.exactAgentIds).toEqual(["agent-a"]);

    const applied = applyProviderContinuityPlan({
      agentId: "agent-a",
      planHash: preview.plan.planHash,
      approvalRef: "approval-1",
      idempotencyKey: "policy-apply-1",
      now: 1_001,
    });
    expect(applied.outcome).toBe("applied");
    expect(applied.policy?.version).toBe(1);
    expect(applied.policy?.targets).toEqual(policy().targets);
  });

  it("replays the same apply and rejects an idempotency payload collision", () => {
    const preview = createProviderContinuityPolicyPreview({
      agentId: "agent-a",
      desiredPolicy: policy(),
      expectedVersion: 0,
      now: 2_000,
      ttlMs: 10,
    });
    const first = applyProviderContinuityPlan({
      agentId: "agent-a",
      planHash: preview.plan.planHash,
      approvalRef: "approval-2",
      idempotencyKey: "policy-apply-2",
      now: 2_001,
    });
    const replay = applyProviderContinuityPlan({
      agentId: "agent-a",
      planHash: preview.plan.planHash,
      approvalRef: "approval-2",
      idempotencyKey: "policy-apply-2",
      now: 2_999,
    });
    expect(replay).toEqual(first);
    expect(() =>
      applyProviderContinuityPlan({
        agentId: "agent-a",
        planHash: preview.plan.planHash,
        approvalRef: "approval-2",
        idempotencyKey: "policy-apply-different-key",
        now: 3_000,
      }),
    ).toThrow("already applied with a different idempotency key");
    expect(getProviderContinuityPolicy("agent-a")?.version).toBe(1);

    const other = createProviderContinuityPolicyPreview({
      agentId: "agent-b",
      desiredPolicy: policy([{ provider: "pi", model: "openai/gpt-5" }]),
      expectedVersion: 0,
      now: 2_100,
    });
    expect(() =>
      applyProviderContinuityPlan({
        agentId: "agent-b",
        planHash: other.plan.planHash,
        approvalRef: "approval-other",
        idempotencyKey: "policy-apply-2",
        now: 2_101,
      }),
    ).toThrow("reused with a different payload");
    expect(getProviderContinuityPolicy("agent-b")).toBeNull();
  });

  it("makes direct set idempotent, reorders exactly, and clears by version", () => {
    const first = setProviderContinuityPolicy({
      agentId: "agent-a",
      desiredPolicy: policy(),
      expectedVersion: 0,
      approvalRef: "approval-set",
      idempotencyKey: "direct-set",
      now: 3_000,
    });
    const replay = setProviderContinuityPolicy({
      agentId: "agent-a",
      desiredPolicy: policy(),
      expectedVersion: 0,
      approvalRef: "approval-set",
      idempotencyKey: "direct-set",
      now: 3_100,
    });
    expect(replay).toEqual(first);
    expect(getProviderContinuityPolicy("agent-a")?.version).toBe(1);

    const reordered = reorderProviderContinuityPolicy({
      agentId: "agent-a",
      fromIndex: 1,
      toIndex: 0,
      expectedVersion: 1,
      approvalRef: "approval-reorder",
      idempotencyKey: "direct-reorder",
      now: 3_200,
    });
    expect(reordered.policy?.targets.map((target) => target.provider)).toEqual(["claude", "codex"]);
    expect(reordered.policy?.version).toBe(2);

    const cleared = clearProviderContinuityPolicy({
      agentId: "agent-a",
      expectedVersion: 2,
      approvalRef: "approval-clear",
      idempotencyKey: "direct-clear",
      now: 3_300,
    });
    expect(cleared.outcome).toBe("applied");
    expect(cleared.policy).toBeNull();
  });

  it("applies batches atomically per agent and reports explicit partial success", () => {
    const preview = createProviderContinuityBatchPreview({
      selector: { kind: "selected", agentIds: ["agent-a", "agent-b"] },
      desiredPolicy: policy(),
      now: 4_000,
    });
    writeProviderContinuityPolicy({
      agentId: "agent-b",
      expectedVersion: 0,
      policy: policy([{ provider: "pi", model: "openai/gpt-5" }]),
      now: 4_001,
    });

    const applied = applyProviderContinuityPlan({
      batchId: preview.batch.batchId,
      planHash: preview.batch.plan.planHash,
      approvalRef: "approval-batch",
      idempotencyKey: "batch-apply",
      now: 4_002,
    }).batch;
    expect(applied.status).toBe("partial_success");
    expect(applied.outcomes).toEqual([
      expect.objectContaining({ agentId: "agent-a", outcome: "applied" }),
      expect.objectContaining({ agentId: "agent-b", outcome: "stale" }),
    ]);
    expect(getProviderContinuityPolicy("agent-a")?.targets).toEqual(policy().targets);
    expect(getProviderContinuityPolicy("agent-b")?.targets).toEqual([{ provider: "pi", model: "openai/gpt-5" }]);
    expect(getProviderContinuityBatch(applied.batchId)).toEqual(applied);
  });

  it("performs zero policy writes for invalid or expired previews", () => {
    const invalid = createProviderContinuityPolicyPreview({
      agentId: "agent-a",
      desiredPolicy: policy(),
      expectedVersion: 9,
      now: 5_000,
    });
    expect(invalid.plan.items[0]?.valid).toBe(false);
    expect(() =>
      applyProviderContinuityPlan({
        agentId: "agent-a",
        planHash: invalid.plan.planHash,
        approvalRef: "approval-invalid",
        idempotencyKey: "invalid-apply",
        now: 5_001,
      }),
    ).toThrow("zero writes");
    expect(getProviderContinuityPolicy("agent-a")).toBeNull();

    const expired = createProviderContinuityPolicyPreview({
      agentId: "agent-a",
      desiredPolicy: policy(),
      expectedVersion: 0,
      now: 6_000,
      ttlMs: 1,
    });
    expect(() =>
      applyProviderContinuityPlan({
        agentId: "agent-a",
        planHash: expired.plan.planHash,
        approvalRef: "approval-expired",
        idempotencyKey: "expired-apply",
        now: 6_002,
      }),
    ).toThrow("expired");
    expect(getProviderContinuityPolicy("agent-a")).toBeNull();
  });
});
