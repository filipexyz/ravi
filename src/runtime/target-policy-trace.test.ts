import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { recordRuntimeTraceEvent } from "../session-trace/runtime-trace.js";
import { reconstructRuntimeTargetHealth, reconstructRuntimeTargetTurnState } from "./target-policy-trace.js";

let stateDir: string | null = null;
const sessionKey = "agent:main:target-restart";

describe("runtime target trace reconstruction", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-target-trace-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("reconstructs attempts after restart without a new database table", () => {
    recordRuntimeTraceEvent({
      sessionKey,
      sessionName: "target-restart",
      agentId: "main",
      eventType: "runtime.start",
      eventGroup: "runtime",
      status: "starting",
      payloadJson: { runtimeTargetPolicyId: "p1", runtimeTargetId: "primary", logicalTurnId: "logical-1" },
    });
    recordRuntimeTraceEvent({
      sessionKey,
      sessionName: "target-restart",
      agentId: "main",
      eventType: "runtime.target.start_failed",
      eventGroup: "runtime",
      status: "failed",
      payloadJson: { policyId: "p1", targetId: "primary", logicalTurnId: "logical-1" },
    });
    recordRuntimeTraceEvent({
      sessionKey,
      sessionName: "target-restart",
      agentId: "main",
      eventType: "runtime.target.switch_requested",
      eventGroup: "runtime",
      status: "recovering",
      payloadJson: { policyId: "p1", targetId: "primary", logicalTurnId: "logical-1" },
    });

    expect(reconstructRuntimeTargetTurnState(sessionKey, "p1")).toMatchObject({
      logicalTurnId: "logical-1",
      attempts: [{ targetId: "primary", attempt: 1, outcome: "recoverable_failure" }],
      sideEffectBoundaryCrossed: false,
      terminal: false,
    });
  });

  it("allows a circuit-open target to re-enter after its cooldown", () => {
    const policy = {
      id: "recovering-circuit",
      strategy: "health-aware" as const,
      maxAttemptsPerTarget: 1,
      cooldownMs: 100,
      circuitBreakerThreshold: 1,
      targets: [{ id: "primary", runtimeProvider: "codex", model: "primary" }],
    };
    const beforeFailure = Date.now();
    recordRuntimeTraceEvent({
      sessionKey,
      sessionName: "target-restart",
      agentId: "main",
      eventType: "runtime.target.switch_requested",
      eventGroup: "runtime",
      status: "recovering",
      payloadJson: { policyId: policy.id, targetId: "primary", logicalTurnId: "logical-circuit" },
    });

    expect(reconstructRuntimeTargetHealth(sessionKey, policy, beforeFailure).get("primary")?.status).toBe("open");
    expect(reconstructRuntimeTargetHealth(sessionKey, policy, Date.now() + 101).get("primary")?.status).toBe("healthy");
  });

  it("reconstructs bounded credential recovery without consuming the target attempt", () => {
    recordRuntimeTraceEvent({
      sessionKey,
      sessionName: "target-restart",
      agentId: "main",
      eventType: "runtime.start",
      eventGroup: "runtime",
      status: "starting",
      payloadJson: { runtimeTargetPolicyId: "credential", runtimeTargetId: "primary", logicalTurnId: "logical-cred" },
    });
    recordRuntimeTraceEvent({
      sessionKey,
      sessionName: "target-restart",
      agentId: "main",
      eventType: "runtime.target.credential_recovery",
      eventGroup: "runtime",
      status: "recovering",
      payloadJson: { policyId: "credential", targetId: "primary", logicalTurnId: "logical-cred" },
    });

    expect(reconstructRuntimeTargetTurnState(sessionKey, "credential")).toMatchObject({
      logicalTurnId: "logical-cred",
      attempts: [],
      credentialRecoveries: { primary: 1 },
      terminal: false,
    });
  });

  it("reconstructs a deferred task quota across target replay", () => {
    recordRuntimeTraceEvent({
      sessionKey,
      sessionName: "target-restart",
      agentId: "main",
      eventType: "runtime.start",
      eventGroup: "runtime",
      status: "starting",
      payloadJson: {
        runtimeTargetPolicyId: "task-quota",
        runtimeTargetId: "primary",
        logicalTurnId: "logical-task-quota",
      },
    });
    recordRuntimeTraceEvent({
      sessionKey,
      sessionName: "target-restart",
      agentId: "main",
      eventType: "runtime.target.switch_requested",
      eventGroup: "runtime",
      status: "recovering",
      error: "provider quota exhausted",
      payloadJson: {
        policyId: "task-quota",
        targetId: "primary",
        logicalTurnId: "logical-task-quota",
        taskQuotaTaskId: "task-quota-1",
      },
    });

    expect(reconstructRuntimeTargetTurnState(sessionKey, "task-quota")).toMatchObject({
      logicalTurnId: "logical-task-quota",
      pendingTaskQuota: { taskId: "task-quota-1", error: "provider quota exhausted" },
      terminal: false,
    });
  });

  it("reconstructs a durable side-effect boundary when the daemon stops after tool start", () => {
    recordRuntimeTraceEvent({
      sessionKey,
      sessionName: "target-restart",
      agentId: "main",
      eventType: "runtime.start",
      eventGroup: "runtime",
      status: "starting",
      payloadJson: {
        runtimeTargetPolicyId: "post-tool",
        runtimeTargetId: "primary",
        logicalTurnId: "logical-tool",
      },
    });
    recordRuntimeTraceEvent({
      sessionKey,
      sessionName: "target-restart",
      agentId: "main",
      eventType: "tool.start",
      eventGroup: "tool",
      status: "running",
      payloadJson: {
        policyId: "post-tool",
        targetId: "primary",
        logicalTurnId: "logical-tool",
        toolId: "write-1",
        toolName: "write",
      },
    });

    expect(reconstructRuntimeTargetTurnState(sessionKey, "post-tool")).toMatchObject({
      logicalTurnId: "logical-tool",
      sideEffectBoundaryCrossed: true,
      terminal: true,
    });
  });
});
