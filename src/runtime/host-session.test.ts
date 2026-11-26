import { describe, expect, it } from "bun:test";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import {
  getPendingRuntimeTurnSuccessors,
  isExplicitLocalRuntimeAbort,
  isProviderEndedAfterCompletedTools,
  type RuntimeHostStreamingSession,
  type RuntimeUserMessage,
  stashPendingRuntimeMessages,
} from "./host-session.js";

describe("isProviderEndedAfterCompletedTools", () => {
  it("recovers after tools and materialized output even when the host labeled provider_interrupted", () => {
    expect(
      isProviderEndedAfterCompletedTools(
        { internalAbortReason: "provider_interrupted", toolRunning: false },
        { startedTool: true, materializedOutput: true },
      ),
    ).toBe(true);
  });

  it("does not recover an explicit local abort after tools", () => {
    expect(isExplicitLocalRuntimeAbort("explicit_abort")).toBe(true);
    expect(isExplicitLocalRuntimeAbort("explicit_abort_deferred")).toBe(true);
    expect(isExplicitLocalRuntimeAbort("crash_recovery_ownership_lost")).toBe(true);
    expect(isExplicitLocalRuntimeAbort("provider_interrupted")).toBe(false);
    expect(
      isProviderEndedAfterCompletedTools(
        { internalAbortReason: "explicit_abort", toolRunning: false },
        { startedTool: true, materializedOutput: true },
      ),
    ).toBe(false);
  });

  it("recovers a completed-tool turn without materialized text when there is no local abort", () => {
    expect(
      isProviderEndedAfterCompletedTools({ toolRunning: false }, { startedTool: true, materializedOutput: false }),
    ).toBe(true);
  });

  it("does not report intentional steering after completed tools as provider failure", () => {
    for (const materializedOutput of [false, true]) {
      expect(
        isProviderEndedAfterCompletedTools(
          { toolRunning: false, currentTurnSuperseded: true },
          { startedTool: true, materializedOutput },
        ),
      ).toBe(false);
    }
  });

  it("does not recover text-only interrupts", () => {
    expect(
      isProviderEndedAfterCompletedTools({ toolRunning: false }, { startedTool: false, materializedOutput: true }),
    ).toBe(false);
  });
});

describe("getPendingRuntimeTurnSuccessors", () => {
  it("keeps unyielded queued input when the live turn no longer names its pending ids", () => {
    const yielded = createQueuedRuntimeUserMessage({ prompt: "already handed off" });
    yielded.clientMessageId = "ravi:current";
    const successor = createQueuedRuntimeUserMessage({ prompt: "queued after handoff" });

    expect(
      getPendingRuntimeTurnSuccessors({
        pendingMessages: [yielded, successor],
      } as RuntimeHostStreamingSession).map((message) => message.message.content),
    ).toEqual(["queued after handoff"]);
  });

  it("returns nothing when the only pending atoms already belong to the yielded turn", () => {
    const yielded = createQueuedRuntimeUserMessage({ prompt: "already handed off" });
    yielded.clientMessageId = "ravi:current";

    expect(
      getPendingRuntimeTurnSuccessors({
        pendingMessages: [yielded],
      } as RuntimeHostStreamingSession),
    ).toEqual([]);
  });

  it("fails closed when nothing has been yielded and pending ids are missing", () => {
    const current = createQueuedRuntimeUserMessage({ prompt: "current physical turn" });

    expect(
      getPendingRuntimeTurnSuccessors({
        pendingMessages: [current],
      } as RuntimeHostStreamingSession),
    ).toEqual([]);
  });
});

describe("stashPendingRuntimeMessages after a superseded turn is interrupted", () => {
  // 26/11 19:58Z: a person's message started a turn, a second message superseded it before the provider
  // checked the prompt ("prompt_check: the turn was stopped before its prompt was checked"), the runtime
  // restarted and only the second message was re-delivered. The first one existed nowhere else.
  function supersededSession(overrides: Partial<RuntimeHostStreamingSession> = {}) {
    const current = createQueuedRuntimeUserMessage({ prompt: "dava pra usar isso de quais formas aqui?" });
    const successor = createQueuedRuntimeUserMessage({ prompt: "estuda mais a documentação" });
    const session = {
      pendingMessages: [current, successor],
      currentTurnPendingIds: [current.pendingId!],
      currentTurnSuperseded: true,
      toolEffectFence: "host_write_ahead",
      ...overrides,
    } as RuntimeHostStreamingSession;
    return { session, current, successor };
  }
  const contents = (stash: Map<string, RuntimeUserMessage[]>) =>
    (stash.get("main") ?? []).map((message) => message.message.content);

  it("keeps the interrupted turn's own message, before its successor, when the turn left no effect", () => {
    const { session } = supersededSession();
    const stash = new Map<string, RuntimeUserMessage[]>();

    const count = stashPendingRuntimeMessages("main", session, stash, { keepSupersededTurnWithoutEffects: true });

    expect(count).toBe(2);
    expect(contents(stash)).toEqual(["dava pra usar isso de quais formas aqui?", "estuda mais a documentação"]);
    // The recovered turn stays its own cohort; the follow-up does not fold into it.
    expect((stash.get("main") ?? []).map((message) => message.retainsInputCohort === true)).toEqual([true, false]);
  });

  it("drops the superseded turn when the crash-recovery coordinator is not accepting deliveries", () => {
    const { session } = supersededSession();
    const stash = new Map<string, RuntimeUserMessage[]>();
    const crashRecovery = { acceptingDeliveries: false } as unknown as RuntimeCrashRecoveryCoordinator;

    stashPendingRuntimeMessages("main", session, stash, { keepSupersededTurnWithoutEffects: true, crashRecovery });

    expect(contents(stash)).toEqual(["estuda mais a documentação"]);
  });

  it("drops the superseded turn when its durable attempt record is missing", () => {
    const { session } = supersededSession({ currentCrashRecoveryAttemptId: "attempt-missing" });
    const stash = new Map<string, RuntimeUserMessage[]>();
    const crashRecovery = {
      acceptingDeliveries: true,
      getActiveTurnAttempt: () => undefined,
    } as unknown as RuntimeCrashRecoveryCoordinator;

    stashPendingRuntimeMessages("main", session, stash, { keepSupersededTurnWithoutEffects: true, crashRecovery });

    expect(contents(stash)).toEqual(["estuda mais a documentação"]);
  });

  it("drops the superseded turn when the provider has no durable pre-tool acknowledgement", () => {
    const { session } = supersededSession({ toolEffectFence: "provider_event_only" });
    const stash = new Map<string, RuntimeUserMessage[]>();

    stashPendingRuntimeMessages("main", session, stash, { keepSupersededTurnWithoutEffects: true });

    expect(contents(stash)).toEqual(["estuda mais a documentação"]);
  });

  it("still drops the superseded turn when the caller does not ask to keep it", () => {
    const { session } = supersededSession();
    const stash = new Map<string, RuntimeUserMessage[]>();

    stashPendingRuntimeMessages("main", session, stash);

    expect(contents(stash)).toEqual(["estuda mais a documentação"]);
  });

  it("drops the superseded turn once it started a tool: its prompt reached the provider", () => {
    const { session } = supersededSession({ currentTurnToolStarted: true });
    const stash = new Map<string, RuntimeUserMessage[]>();

    stashPendingRuntimeMessages("main", session, stash, { keepSupersededTurnWithoutEffects: true });

    expect(contents(stash)).toEqual(["estuda mais a documentação"]);
  });

  it("drops the superseded turn once its input was mutated", () => {
    const { session } = supersededSession({ currentTurnInputMutated: true });
    const stash = new Map<string, RuntimeUserMessage[]>();

    stashPendingRuntimeMessages("main", session, stash, { keepSupersededTurnWithoutEffects: true });

    expect(contents(stash)).toEqual(["estuda mais a documentação"]);
  });

  it("keeps every pending message when the turn was not superseded", () => {
    const { session } = supersededSession({ currentTurnSuperseded: false });
    const stash = new Map<string, RuntimeUserMessage[]>();

    stashPendingRuntimeMessages("main", session, stash, { keepSupersededTurnWithoutEffects: true });

    expect(contents(stash)).toHaveLength(2);
  });
});
