import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  acquireProviderContinuityProbeLease,
  inspectProviderContinuityTargetEligibility,
  readProviderContinuityHealth,
  recordProviderContinuityTargetFailure,
  recordProviderContinuityTargetSuccess,
  releaseProviderContinuityProbeLease,
} from "./recovery.js";
import {
  PROVIDER_CONTINUITY_DEFAULTS,
  type ProviderContinuityFailureEvidence,
  type ProviderContinuityTarget,
} from "./types.js";

let stateDir: string | null = null;
const target: ProviderContinuityTarget = { provider: "codex", model: "gpt-5" };

function qualifiedFailure(now: number): ProviderContinuityFailureEvidence {
  return {
    kind: "overload",
    confidence: "high",
    safeToRetry: true,
    safeToSwitch: true,
    credentialRecoveryEligible: false,
    qualifiedForCircuit: true,
    code: "provider_overloaded",
    message: "synthetic overload",
    retryAfterMs: 1_000,
    observedAt: now,
    fingerprint: `failure-${now}`,
  };
}

describe("provider continuity recovery and failback", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-provider-continuity-recovery-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("opens only after three qualified failures and a timer never closes it directly", () => {
    const base = 10_000;
    for (let index = 0; index < 2; index += 1) {
      const health = recordProviderContinuityTargetFailure({
        agentId: "main",
        target,
        evidence: qualifiedFailure(base + index),
        now: base + index,
      });
      expect(health.state).toBe("closed");
      expect(health.consecutiveQualifiedFailures).toBe(index + 1);
    }
    const opened = recordProviderContinuityTargetFailure({
      agentId: "main",
      target,
      evidence: qualifiedFailure(base + 2),
      now: base + 2,
    });
    expect(opened.state).toBe("open");

    const afterTimer = inspectProviderContinuityTargetEligibility({
      agentId: "main",
      target,
      targetIndex: 0,
      safeNewRequest: true,
      deadlineAt: base + 120_000,
      now: (opened.probeEligibleAt ?? base) + 1,
    });
    expect(afterTimer.health.state).toBe("open");
    expect(afterTimer.eligible).toBe(true);
    expect(afterTimer.probe).toBe(true);
  });

  it("admits one half-open probe, reopens on failure, and rejects concurrent probes", () => {
    const base = 20_000;
    for (let index = 0; index < 3; index += 1) {
      recordProviderContinuityTargetFailure({
        agentId: "main",
        target,
        evidence: qualifiedFailure(base + index),
        now: base + index,
      });
    }
    const opened = readProviderContinuityHealth({ agentId: "main", target, now: base + 3 });
    const probeAt = (opened.probeEligibleAt ?? base) + 1;
    const first = acquireProviderContinuityProbeLease({
      agentId: "main",
      target,
      deadlineAt: probeAt + 120_000,
      now: probeAt,
    });
    const concurrent = acquireProviderContinuityProbeLease({
      agentId: "main",
      target,
      deadlineAt: probeAt + 120_000,
      now: probeAt,
    });
    expect(first.acquired).toBe(true);
    expect(concurrent).toMatchObject({ acquired: false, reason: "half_open_probe_lease_busy" });

    const reopened = recordProviderContinuityTargetFailure({
      agentId: "main",
      target,
      evidence: qualifiedFailure(probeAt + 1),
      now: probeAt + 1,
    });
    expect(reopened.state).toBe("open");
    expect(reopened.probationSuccesses).toBe(0);
  });

  it("requires three probe successes and five stable minutes before failback", () => {
    const base = 30_000;
    for (let index = 0; index < 3; index += 1) {
      recordProviderContinuityTargetFailure({
        agentId: "main",
        target,
        evidence: qualifiedFailure(base + index),
        now: base + index,
      });
    }
    let cursor = (readProviderContinuityHealth({ agentId: "main", target }).probeEligibleAt ?? base) + 1;
    for (let success = 1; success <= 3; success += 1) {
      const lease = acquireProviderContinuityProbeLease({
        agentId: "main",
        target,
        deadlineAt: cursor + 120_000,
        now: cursor,
      });
      expect(lease.acquired).toBe(true);
      const health = recordProviderContinuityTargetSuccess({
        agentId: "main",
        target,
        probe: true,
        leaseId: lease.leaseId,
        now: cursor + 1,
      });
      expect(health.probationSuccesses).toBe(success);
      expect(health.state).toBe(success === 3 ? "closed" : "half_open");
      cursor += 10;
    }
    const stable = readProviderContinuityHealth({ agentId: "main", target });
    expect(stable.stableSince).not.toBeNull();
    const beforeDwell = inspectProviderContinuityTargetEligibility({
      agentId: "main",
      target,
      targetIndex: 0,
      safeNewRequest: true,
      deadlineAt: cursor + 1_000_000,
      now: (stable.stableSince ?? cursor) + PROVIDER_CONTINUITY_DEFAULTS.failbackDwellMs - 1,
    });
    expect(beforeDwell).toMatchObject({
      eligible: false,
      rejectionReasons: ["failback_dwell_not_elapsed"],
    });
    const afterDwell = inspectProviderContinuityTargetEligibility({
      agentId: "main",
      target,
      targetIndex: 0,
      safeNewRequest: true,
      deadlineAt: cursor + 1_000_000,
      now: (stable.stableSince ?? cursor) + PROVIDER_CONTINUITY_DEFAULTS.failbackDwellMs,
    });
    expect(afterDwell).toMatchObject({ eligible: true, probe: false });
  });

  it("keeps non-qualified failure and ordinary success in the closed state", () => {
    const nonQualified: ProviderContinuityFailureEvidence = {
      ...qualifiedFailure(40_000),
      kind: "authentication",
      qualifiedForCircuit: false,
      code: "auth_invalid",
    };
    const failed = recordProviderContinuityTargetFailure({
      agentId: "main",
      target,
      evidence: nonQualified,
      now: 40_000,
    });
    expect(failed).toMatchObject({
      state: "closed",
      consecutiveQualifiedFailures: 0,
      lastFailureAt: 40_000,
    });
    const succeeded = recordProviderContinuityTargetSuccess({
      agentId: "main",
      target,
      now: 40_001,
    });
    expect(succeeded).toMatchObject({
      state: "closed",
      consecutiveQualifiedFailures: 0,
      lastSuccessAt: 40_001,
    });
  });

  it("rejects deadline, unsafe probe, busy lease, and premature acquisition deterministically", () => {
    const base = 50_000;
    expect(
      inspectProviderContinuityTargetEligibility({
        agentId: "main",
        target,
        targetIndex: 0,
        safeNewRequest: true,
        deadlineAt: base,
        now: base,
      }),
    ).toMatchObject({ eligible: false, rejectionReasons: ["deadline_expired"] });
    expect(
      acquireProviderContinuityProbeLease({
        agentId: "main",
        target,
        deadlineAt: base + 1_000,
        now: base,
      }),
    ).toMatchObject({ acquired: false, reason: "circuit_not_probeable" });

    for (let index = 0; index < 3; index += 1) {
      recordProviderContinuityTargetFailure({
        agentId: "main",
        target,
        evidence: qualifiedFailure(base + index),
        now: base + index,
      });
    }
    const opened = readProviderContinuityHealth({ agentId: "main", target });
    const probeAt = opened.probeEligibleAt ?? base + 30_002;
    expect(
      acquireProviderContinuityProbeLease({
        agentId: "main",
        target,
        deadlineAt: probeAt + 120_000,
        now: probeAt - 1,
      }),
    ).toMatchObject({ acquired: false, reason: "probe_wait_not_elapsed" });
    expect(
      inspectProviderContinuityTargetEligibility({
        agentId: "main",
        target,
        targetIndex: 0,
        safeNewRequest: false,
        deadlineAt: probeAt + 120_000,
        now: probeAt,
      }),
    ).toMatchObject({
      eligible: false,
      rejectionReasons: ["probe_requires_safe_new_request"],
    });

    const lease = acquireProviderContinuityProbeLease({
      agentId: "main",
      target,
      deadlineAt: probeAt + 120_000,
      now: probeAt,
    });
    expect(lease.acquired).toBe(true);
    expect(
      inspectProviderContinuityTargetEligibility({
        agentId: "main",
        target,
        targetIndex: 0,
        safeNewRequest: false,
        deadlineAt: probeAt + 120_000,
        now: probeAt + 1,
      }),
    ).toMatchObject({
      eligible: false,
      rejectionReasons: ["probe_requires_safe_new_request"],
    });
    expect(
      inspectProviderContinuityTargetEligibility({
        agentId: "main",
        target,
        targetIndex: 0,
        safeNewRequest: true,
        deadlineAt: probeAt + 120_000,
        now: probeAt + 1,
      }),
    ).toMatchObject({
      eligible: false,
      rejectionReasons: ["half_open_probe_lease_busy"],
    });
    expect(() =>
      recordProviderContinuityTargetSuccess({
        agentId: "main",
        target,
        probe: true,
        leaseId: "wrong-lease",
        now: probeAt + 1,
      }),
    ).toThrow("Probe lease mismatch");

    expect(
      releaseProviderContinuityProbeLease({
        agentId: "main",
        target,
        leaseId: "wrong-lease",
        now: probeAt + 2,
      }).probeLeaseId,
    ).toBe(lease.leaseId);
    const released = releaseProviderContinuityProbeLease({
      agentId: "main",
      target,
      leaseId: lease.leaseId ?? "",
      now: probeAt + 3,
    });
    expect(released.probeLeaseId).toBeNull();
    expect(
      acquireProviderContinuityProbeLease({
        agentId: "main",
        target,
        deadlineAt: probeAt + 4,
        now: probeAt + 4,
      }),
    ).toMatchObject({ acquired: false, reason: "deadline_expired" });
  });
});
