import { describe, expect, it } from "bun:test";
import {
  classifyRuntimeTargetFailure,
  decideRuntimeTargetFailure,
  isRuntimeTargetAutoRollbackEligible,
  selectRuntimeTarget,
  type RuntimeTargetPolicy,
  type RuntimeTargetTurnState,
} from "./target-policy.js";

const policy: RuntimeTargetPolicy = {
  id: "test",
  strategy: "ordered",
  maxAttemptsPerTarget: 1,
  targets: [
    { id: "primary", runtimeProvider: "provider-a", model: "model-a", requiredCapabilities: ["tools"] },
    { id: "secondary", runtimeProvider: "provider-b", model: "model-b", requiredCapabilities: ["tools"] },
  ],
};
const emptyState: RuntimeTargetTurnState = {
  logicalTurnId: "turn-1",
  attempts: [],
  sideEffectBoundaryCrossed: false,
  terminal: false,
};
const context = {
  now: 100,
  registeredProviders: new Set(["provider-a", "provider-b"]),
  availableCapabilities: new Map([
    ["provider-a", new Set(["tools"])],
    ["provider-b", new Set(["tools"])],
  ]),
};

describe("runtime target policy", () => {
  it("selects deterministically without provider-specific priority in core", () => {
    expect(selectRuntimeTarget(policy, emptyState, context)).toMatchObject({
      status: "selected",
      target: { id: "primary" },
    });
  });

  it("orders health-aware targets by consecutive failures with stable tie-breaking", () => {
    expect(
      selectRuntimeTarget({ ...policy, strategy: "health-aware" }, emptyState, {
        ...context,
        health: new Map([
          ["primary", { targetId: "primary", status: "healthy", consecutiveFailures: 2 }],
          ["secondary", { targetId: "secondary", status: "healthy", consecutiveFailures: 0 }],
        ]),
      }),
    ).toMatchObject({ status: "selected", target: { id: "secondary" } });
  });

  it("classifies request and session failures as non-replayable scopes", () => {
    expect(classifyRuntimeTargetFailure({ error: "unsupported schema", recoverable: true })).toEqual({
      recoverable: false,
      scope: "request",
    });
    expect(classifyRuntimeTargetFailure({ error: "session resume incompatible", recoverable: true })).toEqual({
      recoverable: false,
      scope: "session",
    });
    expect(classifyRuntimeTargetFailure({ error: "permission denied for this model", recoverable: true })).toEqual({
      recoverable: false,
      scope: "request",
    });
    expect(classifyRuntimeTargetFailure({ error: "provider unavailable", recoverable: true })).toEqual({
      recoverable: true,
      scope: "target",
    });
  });

  it("fails closed for unknown failures and does not let metadata override safety classification", () => {
    expect(
      classifyRuntimeTargetFailure({
        error: "invalid response schema",
        recoverable: true,
        metadata: { failureScope: "target" },
      }),
    ).toEqual({ recoverable: false, scope: "request" });
    expect(
      classifyRuntimeTargetFailure({
        error: "permission denied",
        recoverable: true,
        metadata: { failureScope: "target" },
      }),
    ).toEqual({ recoverable: false, scope: "request" });
    expect(
      classifyRuntimeTargetFailure({
        error: "TypeError: cannot read properties of undefined",
        recoverable: true,
      }),
    ).toEqual({ recoverable: false, scope: "unknown" });
    expect(classifyRuntimeTargetFailure({ error: "RangeError: invalid array length", recoverable: true })).toEqual({
      recoverable: false,
      scope: "unknown",
    });
    expect(classifyRuntimeTargetFailure({ error: "AssertionError: invariant failed", recoverable: true })).toEqual({
      recoverable: false,
      scope: "unknown",
    });
    for (const error of [
      "RangeError: credential unavailable",
      "AssertionError: Invalid API key",
      "TypeError: token expired",
    ]) {
      expect(classifyRuntimeTargetFailure({ error, recoverable: true })).toEqual({
        recoverable: false,
        scope: "unknown",
      });
    }
    expect(
      classifyRuntimeTargetFailure({ error: "provider unavailable", errorName: "RangeError", recoverable: true }),
    ).toEqual({ recoverable: false, scope: "unknown" });
    expect(
      classifyRuntimeTargetFailure({ error: "provider unavailable", errorName: "AssertionError", recoverable: true }),
    ).toEqual({ recoverable: false, scope: "unknown" });
    for (const errorName of ["RangeError", "AssertionError"]) {
      for (const error of ["Invalid API key", "credential unavailable", "provider outage timed out"]) {
        expect(classifyRuntimeTargetFailure({ error, errorName, recoverable: true })).toEqual({
          recoverable: false,
          scope: "unknown",
        });
      }
    }
    expect(
      classifyRuntimeTargetFailure({
        error: "unexpected internal failure",
        recoverable: true,
        metadata: { failureScope: "target" },
      }),
    ).toEqual({ recoverable: false, scope: "unknown" });
    expect(classifyRuntimeTargetFailure({ error: "unexpected internal failure", recoverable: true })).toEqual({
      recoverable: false,
      scope: "unknown",
    });
    expect(classifyRuntimeTargetFailure({ error: "Invalid API key", recoverable: true })).toEqual({
      recoverable: false,
      scope: "unknown",
    });
    for (const failure of [
      { error: "Invalid API key", errorName: "Error", caughtException: true },
      { error: "token expired", errorName: "InternalStateError", caughtException: true },
      { error: "credential unavailable", caughtException: true },
    ]) {
      expect(classifyRuntimeTargetFailure({ ...failure, recoverable: true })).toEqual({
        recoverable: false,
        scope: "unknown",
      });
    }
    expect(
      classifyRuntimeTargetFailure({
        error: "credential expired",
        recoverable: true,
        metadata: { failureScope: "credential" },
      }),
    ).toEqual({ recoverable: true, scope: "credential" });
    expect(
      classifyRuntimeTargetFailure({
        error: "provider unavailable",
        errorName: "Error",
        caughtException: true,
        recoverable: true,
        targetFailure: true,
      }),
    ).toEqual({ recoverable: true, scope: "target" });
    expect(
      classifyRuntimeTargetFailure({
        error: "rate limited",
        recoverable: true,
        rawEvent: { type: "error", status: 429 },
        credentialFailure: true,
      }),
    ).toEqual({ recoverable: true, scope: "credential" });
    expect(
      classifyRuntimeTargetFailure({
        error: "authentication-shaped invalid request",
        recoverable: true,
        metadata: { failureScope: "request" },
        credentialFailure: true,
        targetFailure: true,
      }),
    ).toEqual({ recoverable: false, scope: "request" });
  });

  it("advances after target exhaustion and reports prior rejection", () => {
    const state = {
      ...emptyState,
      attempts: [{ targetId: "primary", attempt: 1, startedAt: 1, outcome: "recoverable_failure" as const }],
    };
    expect(selectRuntimeTarget(policy, state, context)).toEqual({
      status: "selected",
      target: policy.targets[1],
      rejected: [{ targetId: "primary", reason: "attempts_exhausted" }],
    });
  });

  it("filters cooldown, open circuits, missing capabilities and permissions", () => {
    const selected = selectRuntimeTarget(policy, emptyState, {
      ...context,
      permittedTargetIds: new Set(["secondary"]),
      health: new Map([
        ["secondary", { targetId: "secondary", status: "cooldown", cooldownUntil: 200, consecutiveFailures: 1 }],
      ]),
    });
    expect(selected).toEqual({
      status: "exhausted",
      rejected: [
        { targetId: "primary", reason: "permission_denied" },
        { targetId: "secondary", reason: "cooldown", detail: "200" },
      ],
    });
  });

  it("fails closed when a reconstructed turn crossed a durable side-effect boundary", () => {
    expect(
      selectRuntimeTarget(policy, { ...emptyState, sideEffectBoundaryCrossed: true, terminal: true }, context),
    ).toEqual({
      status: "exhausted",
      rejected: [
        { targetId: "primary", reason: "side_effect_boundary" },
        { targetId: "secondary", reason: "side_effect_boundary" },
      ],
    });
  });

  it("separates credential recovery, target switching and unsafe replay", () => {
    expect(
      decideRuntimeTargetFailure({
        recoverable: true,
        replayEligible: true,
        scope: "credential",
        sideEffectBoundaryCrossed: false,
        attemptsOnTarget: 0,
        maxAttemptsPerTarget: 2,
        credentialRecoveryEligible: true,
        credentialRecoveriesOnTarget: 0,
        maxCredentialRecoveryAttemptsPerTarget: 1,
      }),
    ).toBe("recover_credential");
    expect(
      decideRuntimeTargetFailure({
        recoverable: true,
        replayEligible: true,
        scope: "credential",
        sideEffectBoundaryCrossed: false,
        attemptsOnTarget: 1,
        maxAttemptsPerTarget: 2,
        credentialRecoveryEligible: true,
        credentialRecoveriesOnTarget: 1,
        maxCredentialRecoveryAttemptsPerTarget: 1,
      }),
    ).toBe("switch_target");
    expect(
      decideRuntimeTargetFailure({
        recoverable: true,
        replayEligible: true,
        scope: "target",
        sideEffectBoundaryCrossed: false,
        attemptsOnTarget: 1,
        maxAttemptsPerTarget: 2,
      }),
    ).toBe("switch_target");
    expect(
      decideRuntimeTargetFailure({
        recoverable: true,
        replayEligible: true,
        scope: "target",
        sideEffectBoundaryCrossed: true,
        attemptsOnTarget: 1,
        maxAttemptsPerTarget: 2,
      }),
    ).toBe("terminate");
    expect(
      decideRuntimeTargetFailure({
        recoverable: true,
        replayEligible: true,
        scope: "request",
        sideEffectBoundaryCrossed: false,
        attemptsOnTarget: 0,
        maxAttemptsPerTarget: 2,
      }),
    ).toBe("terminate");
  });

  it("only allows same-target credential rollback for Claude with a healthy managed credential", () => {
    expect(
      isRuntimeTargetAutoRollbackEligible({
        runtimeProvider: "claude",
        managedCredentialId: "rcred_claude",
        managedCredentialStatus: "healthy",
      }),
    ).toBe(true);
    expect(isRuntimeTargetAutoRollbackEligible({ runtimeProvider: "claude", managedCredentialId: null })).toBe(false);
    expect(
      isRuntimeTargetAutoRollbackEligible({
        runtimeProvider: "claude",
        managedCredentialId: "rcred_claude",
        managedCredentialStatus: "cooldown",
      }),
    ).toBe(false);
    for (const runtimeProvider of ["codex", "pi", "trace-provider"]) {
      expect(
        isRuntimeTargetAutoRollbackEligible({
          runtimeProvider,
          managedCredentialId: `rcred_${runtimeProvider}`,
          managedCredentialStatus: "healthy",
        }),
      ).toBe(false);
    }
    expect(
      decideRuntimeTargetFailure({
        recoverable: true,
        replayEligible: true,
        scope: "credential",
        sideEffectBoundaryCrossed: false,
        attemptsOnTarget: 0,
        maxAttemptsPerTarget: 2,
        credentialRecoveriesOnTarget: 0,
        maxCredentialRecoveryAttemptsPerTarget: 1,
      }),
    ).toBe("terminate");
  });
});
