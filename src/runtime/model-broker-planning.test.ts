import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type {
  ModelBroker,
  ModelBrokerAttemptFeedback,
  ModelBrokerResolveRequest,
  RuntimeModelBrokerRouteLease,
} from "./model-broker.js";
import {
  abandonClaimedRuntimeModelBrokerPlan,
  buildRuntimeModelBrokerPlanIdentity,
  claimRuntimeModelBrokerPlan,
  planRuntimeModelBrokerRoute,
  releaseRuntimeModelBrokerPlanForAdvance,
  resetRuntimeModelBrokerPlansForTests,
} from "./model-broker-planning.js";
import { registerModelBroker, unregisterModelBroker } from "./model-broker-registry.js";

const BROKER_ID = "planning-test";
let previousRuntimeId: string | undefined;
let resolveInputs: ModelBrokerResolveRequest[];
let feedbackInputs: ModelBrokerAttemptFeedback[];
let leaseLifetimeMs: number;
let releaseResolve: (() => void) | undefined;

beforeEach(() => {
  previousRuntimeId = process.env.RAVI_RUNTIME_ID;
  process.env.RAVI_RUNTIME_ID = "runtime_test";
  resolveInputs = [];
  feedbackInputs = [];
  leaseLifetimeMs = 60_000;
  releaseResolve = undefined;
  resetRuntimeModelBrokerPlansForTests();
  registerModelBroker(BROKER_ID, () => testBroker());
});

afterEach(() => {
  unregisterModelBroker(BROKER_ID);
  resetRuntimeModelBrokerPlansForTests();
  if (previousRuntimeId === undefined) delete process.env.RAVI_RUNTIME_ID;
  else process.env.RAVI_RUNTIME_ID = previousRuntimeId;
});

describe("model-broker route planning cache", () => {
  test("isolates equal turn IDs across sessions", async () => {
    const first = await plan("session_a", "same_turn");
    const second = await plan("session_b", "same_turn");

    expect(resolveInputs.map(({ sessionKey, turnId }) => ({ sessionKey, turnId }))).toEqual([
      { sessionKey: "session_a", turnId: "same_turn" },
      { sessionKey: "session_b", turnId: "same_turn" },
    ]);
    expect(first?.lease.leaseId).not.toBe(second?.lease.leaseId);
  });

  test("single-flights duplicate preflight and permits one atomic claim", async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    releaseResolve = () => unblock();

    const first = plan("session_a", "turn_a", blocked);
    const duplicate = plan("session_a", "turn_a", blocked);
    await Promise.resolve();
    expect(resolveInputs).toHaveLength(1);
    releaseResolve();
    const [firstPlan, duplicatePlan] = await Promise.all([first, duplicate]);
    expect(firstPlan).toBe(duplicatePlan);

    const identity = buildRuntimeModelBrokerPlanIdentity({
      selection: firstPlan!.selection,
      runtimeId: "runtime_test",
      agentId: "main",
      sessionKey: "session_a",
      turnId: "turn_a",
    });
    expect(claimRuntimeModelBrokerPlan(identity)?.plan.lease.leaseId).toBe(firstPlan?.lease.leaseId);
    expect(() => claimRuntimeModelBrokerPlan(identity)).toThrow("already claimed");
    await expect(plan("session_a", "turn_a")).rejects.toThrow("already has a claimed");
  });

  test("re-resolves an expired lease with the same stable turn identity", async () => {
    let now = 1_000_000;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
    try {
      await plan("session_a", "stable_turn");
      now += 56_000;
      await plan("session_a", "stable_turn");
    } finally {
      nowSpy.mockRestore();
    }

    expect(resolveInputs).toHaveLength(2);
    expect(resolveInputs.map((input) => input.turnId)).toEqual(["stable_turn", "stable_turn"]);
  });

  test("never returns a cached lease below the builder's 30-second launch horizon", async () => {
    let now = 1_000_000;
    leaseLifetimeMs = 35_000;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
    try {
      await plan("session_a", "stable_turn");
      now += 6_000;
      await plan("session_a", "stable_turn");
    } finally {
      nowSpy.mockRestore();
    }

    expect(resolveInputs).toHaveLength(2);
    expect(resolveInputs.map((input) => input.turnId)).toEqual(["stable_turn", "stable_turn"]);
  });

  test("replays the same stable turn after an in-memory cache loss", async () => {
    await plan("session_a", "stable_turn");
    resetRuntimeModelBrokerPlansForTests();
    await plan("session_a", "stable_turn");

    expect(resolveInputs).toHaveLength(2);
    expect(resolveInputs[0]).toMatchObject(resolveInputs[1]!);
  });

  test("reports an effect-safe abandonment and releases the claim before provider start", async () => {
    const route = await plan("session_a", "turn_a");
    const claim = claimRuntimeModelBrokerPlan(
      buildRuntimeModelBrokerPlanIdentity({
        selection: route!.selection,
        runtimeId: "runtime_test",
        agentId: "main",
        sessionKey: "session_a",
        turnId: "turn_a",
      }),
    );
    await abandonClaimedRuntimeModelBrokerPlan(claim!, "provider_resolution_failed");

    expect(feedbackInputs).toEqual([
      expect.objectContaining({
        attemptId: route?.lease.attemptId,
        turnId: "turn_a",
        outcome: "abandoned",
        effectState: "none",
        failureKind: "provider_resolution_failed",
      }),
    ]);
    await expect(plan("session_a", "turn_a")).resolves.toBeDefined();
  });

  test("releases only the exact claimed attempt after authoritative advance", async () => {
    const route = await plan("session_a", "stable_turn");
    const identity = buildRuntimeModelBrokerPlanIdentity({
      selection: route!.selection,
      runtimeId: "runtime_test",
      agentId: "main",
      sessionKey: "session_a",
      turnId: "stable_turn",
    });
    claimRuntimeModelBrokerPlan(identity);

    expect(() =>
      releaseRuntimeModelBrokerPlanForAdvance({
        ...identity,
        leaseId: route!.lease.leaseId,
        attemptId: "another_attempt",
      }),
    ).toThrow("different model-broker route attempt");
    expect(
      releaseRuntimeModelBrokerPlanForAdvance({
        ...identity,
        leaseId: route!.lease.leaseId,
        attemptId: route!.lease.attemptId,
      }),
    ).toBe(true);

    await plan("session_a", "stable_turn");
    expect(resolveInputs).toHaveLength(2);
    expect(resolveInputs.map((input) => input.turnId)).toEqual(["stable_turn", "stable_turn"]);
  });
});

function plan(sessionKey: string, turnId: string, blocked?: Promise<void>) {
  if (blocked) pendingResolve = blocked;
  return planRuntimeModelBrokerRoute({
    agent: {
      id: "main",
      defaults: { modelBroker: { brokerId: BROKER_ID, profileRef: "profile_test", required: true } },
    },
    sessionKey,
    turnId,
  });
}

let pendingResolve: Promise<void> | undefined;

function testBroker(): ModelBroker {
  return {
    id: BROKER_ID,
    async resolveRoute(input) {
      resolveInputs.push(input);
      const blocked = pendingResolve;
      pendingResolve = undefined;
      if (blocked) await blocked;
      return lease(input, resolveInputs.length);
    },
    async reportAttempt(input) {
      feedbackInputs.push(input);
      return { recorded: true, nextAction: "retain" };
    },
  };
}

function lease(input: ModelBrokerResolveRequest, ordinal: number): RuntimeModelBrokerRouteLease {
  return {
    version: 1,
    brokerId: BROKER_ID,
    leaseId: `lease_${ordinal}`,
    attemptId: `attempt_${ordinal}`,
    turnId: input.turnId,
    runtimeId: input.runtimeId,
    runtimeProvider: "pi",
    model: "openai/gpt-test",
    routeRevision: "route_a",
    compatibilityRevision: "compat_a",
    expiresAt: Date.now() + leaseLifetimeMs,
    transport: {
      scheme: "local-http-forwarder-v1",
      protocol: "openai-completions",
      origin: "http://127.0.0.1:43123",
      path: "/v1/chat/completions",
      publicHeaders: {},
    },
  };
}
