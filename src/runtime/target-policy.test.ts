import { describe, expect, it } from "bun:test";
import {
  classifyRuntimeTargetFailure,
  decideRuntimeTargetFailure,
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
    expect(classifyRuntimeTargetFailure({ error: "provider unavailable", recoverable: true })).toEqual({
      recoverable: true,
      scope: "target",
    });
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

  it("separates credential recovery, target switching and unsafe replay", () => {
    expect(
      decideRuntimeTargetFailure({
        recoverable: true,
        replayEligible: true,
        scope: "credential",
        sideEffectBoundaryCrossed: false,
        attemptsOnTarget: 0,
        maxAttemptsPerTarget: 2,
      }),
    ).toBe("recover_credential");
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
});
