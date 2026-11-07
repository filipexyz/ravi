import { describe, expect, it } from "bun:test";
import {
  canReleaseRuntimeDeliveryBarrier,
  createQueuedRuntimeUserMessage,
  createRuntimeMessageGenerator,
  getDeliverableRuntimeMessages,
  getRuntimeMessagesAfterTurn,
  pickRuntimeTurnAuthorityEnvelope,
  prepareRuntimeInterruptSuccessor,
  shouldInterruptRuntimeForIncoming,
} from "./delivery-queue.js";
import {
  resolveRuntimeToolEffectFence,
  shutdownRuntimeStreamingSession,
  stashCurrentTurnRuntimeMessages,
  stashPendingRuntimeMessages,
} from "./host-session.js";
import type { RuntimeHostStreamingSession, RuntimeUserMessage } from "./host-session.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { buildChannelTurnOrigin, buildSessionRelayTurnOrigin } from "./turn-origin.js";
import type { RuntimeSessionHandle } from "./types.js";
import { PROVIDER_CAPACITY_EXHAUSTED_MESSAGE, PROVIDER_CAPACITY_EXHAUSTED_REASON } from "./provider-capacity-retry.js";

function makeRuntimeSession(): RuntimeSessionHandle {
  return {
    provider: "codex",
    events: (async function* () {})(),
    interrupt: async () => {},
  };
}

function makeStreamingSession(overrides: Partial<RuntimeHostStreamingSession> = {}): RuntimeHostStreamingSession {
  return {
    agentId: "main",
    queryHandle: makeRuntimeSession(),
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [],
    currentModel: "gpt-5.4",
    toolRunning: false,
    lastActivity: Date.now(),
    done: false,
    interrupted: false,
    turnActive: false,
    compacting: false,
    onTurnComplete: null,
    currentToolSafety: null,
    pendingAbort: false,
    ...overrides,
  };
}

describe("runtime turn authority cleanup", () => {
  for (const boundary of ["complete", "preparation-failure", "return"] as const) {
    it(`releases the physical turn exactly once on ${boundary}`, async () => {
      const session = makeStreamingSession({ pendingMessages: [createQueuedRuntimeUserMessage({ prompt: "work" })] });
      let released = 0;
      const generator = createRuntimeMessageGenerator({
        sessionName: "authority-cleanup",
        session,
        stashedMessages: new Map(),
        afterTurnEnd: () => {
          released++;
        },
        traceTurnStart: () => {
          if (boundary === "preparation-failure") throw new Error("durable preparation failed");
          return undefined;
        },
      });
      if (boundary === "preparation-failure") {
        await expect(generator.next()).rejects.toThrow("durable preparation failed");
      } else {
        await generator.next();
        expect(released).toBe(0);
        if (boundary === "complete") {
          session.onTurnComplete?.();
          expect(released).toBe(1);
        }
        session.done = true;
        await generator.return(undefined);
      }
      expect(released).toBe(1);
    });
  }
});

describe("runtime delivery queue", () => {
  it("waits only the remaining restored capacity delay and preserves the cohort's spent budget", async () => {
    const cohort = ["first", "second"].map((prompt) => {
      const message = createQueuedRuntimeUserMessage({ prompt });
      message.clientMessageId = "failed-physical-delivery";
      message.replay = true;
      message.providerCapacityRetry = { startedAt: 1_000, retries: 2, notBefore: 13_000 };
      return message;
    });
    const successor = createQueuedRuntimeUserMessage({ prompt: "independent successor" });
    const session = makeStreamingSession({ pendingMessages: [...cohort, successor] });
    let now = 8_000;
    const waits: number[] = [];
    const generator = createRuntimeMessageGenerator({
      sessionName: "dev",
      session,
      stashedMessages: new Map(),
      capacityRetryRuntime: {
        now: () => now,
        wait: async (delayMs) => {
          waits.push(delayMs);
          expect(session.currentTurnPendingIds).toEqual(cohort.map((message) => message.pendingId!));
          expect(session.turnActive).toBe(true);
          expect(shouldInterruptRuntimeForIncoming("dev", session, "immediate_interrupt").interrupt).toBe(true);
          expect(session.pendingMessages).toEqual([...cohort, successor]);
          expect(cohort[0]?.providerCapacityRetry?.notBefore).toBe(13_000);
          now += delayMs;
        },
      },
    });

    const result = await generator.next();
    expect(waits).toEqual([5_000]);
    expect(result.value).toMatchObject({ message: { content: "first\n\nsecond" }, replay: false });
    expect(result.value?.clientMessageId).not.toBe("failed-physical-delivery");
    expect(cohort.map((message) => message.providerCapacityRetry)).toEqual([
      { startedAt: 1_000, retries: 2 },
      { startedAt: 1_000, retries: 2 },
    ]);
    expect(session.currentTurnPendingIds).toEqual(cohort.map((message) => message.pendingId!));
    expect(successor.providerCapacityRetry).toBeUndefined();
    session.done = true;
    session.onTurnComplete?.();
    await generator.return(undefined);
  });

  for (const timing of ["before wait", "during wait", "during preparation"] as const) {
    it(`expires a restored capacity retry ${timing} without delivering it or consuming its successor`, async () => {
      const retry = createQueuedRuntimeUserMessage({ prompt: "expired work" });
      retry.providerCapacityRetry = { startedAt: 1_000, retries: 3, notBefore: 13_000 };
      const successor = createQueuedRuntimeUserMessage({ prompt: "fresh successor" });
      const session = makeStreamingSession({
        pendingMessages: [retry, successor],
        currentTraceTurnId: "consumed-previous-trace",
        currentCrashRecoveryAttemptId: "consumed-previous-attempt",
        currentCrashRecoveryTerminal: {
          status: "failed",
          completedAt: 7_000,
          startedTool: false,
          materializedOutput: false,
        },
      });
      let released = 0;
      let now = timing === "before wait" ? 31_000 : 8_000;
      const expired: Array<{ reason: string; error: string; deliverableMessages: RuntimeUserMessage[] }> = [];
      const generator = createRuntimeMessageGenerator({
        sessionName: "dev",
        session,
        stashedMessages: new Map(),
        afterTurnEnd: () => {
          released++;
        },
        capacityRetryRuntime: {
          now: () => now,
          wait: async (delayMs) => {
            now += timing === "during wait" ? 30_000 : delayMs;
          },
        },
        transformTurnPrompt: ({ combinedPrompt }) => {
          if (timing === "during preparation") now = 31_000;
          return combinedPrompt;
        },
        onCapacityRetryExhausted: (input) => {
          expired.push(input);
          expect(session.pendingMessages).toEqual([successor]);
          if (timing !== "during preparation") {
            expect(session.turnActive).toBe(false);
            expect(session.currentTurnPendingIds).toBeUndefined();
            expect(session.currentCrashRecoveryAttemptId).toBeUndefined();
            expect(session.currentTraceTurnId).toBeUndefined();
          }
        },
      });

      const result = await generator.next();
      expect(result.value).toMatchObject({ message: { content: "fresh successor" } });
      expect(released).toBe(timing === "during preparation" ? 1 : 0);
      expect(expired).toHaveLength(1);
      expect(expired[0]).toMatchObject({
        reason: PROVIDER_CAPACITY_EXHAUSTED_REASON,
        error: PROVIDER_CAPACITY_EXHAUSTED_MESSAGE,
        deliverableMessages: [retry],
      });
      expect(session.durableTurnPreparationFailed).toBe(false);
      session.done = true;
      session.onTurnComplete?.();
      await generator.return(undefined);
    });
  }

  it("does not replenish retries after a restored third retry is handed off", async () => {
    const retry = createQueuedRuntimeUserMessage({ prompt: "last permitted attempt" });
    retry.providerCapacityRetry = { startedAt: 1_000, retries: 3, notBefore: 13_000 };
    const session = makeStreamingSession({ pendingMessages: [retry] });
    const generator = createRuntimeMessageGenerator({
      sessionName: "dev",
      session,
      stashedMessages: new Map(),
      capacityRetryRuntime: {
        now: () => 14_000,
        wait: async () => {
          throw new Error("must not wait again");
        },
      },
    });
    expect((await generator.next()).done).toBe(false);
    expect(retry.providerCapacityRetry).toEqual({ startedAt: 1_000, retries: 3 });
    session.done = true;
    session.onTurnComplete?.();
    await generator.return(undefined);
  });

  for (const capacity of [true, false]) {
    it(`checks the deadline after preparing a live retry only for capacity (capacity=${capacity})`, async () => {
      const retry = createQueuedRuntimeUserMessage({ prompt: "retry work" });
      retry.clientMessageId = "failed-live-delivery";
      retry.replay = true;
      if (capacity) retry.providerCapacityRetry = { startedAt: 1_000, retries: 1 };
      const successor = createQueuedRuntimeUserMessage({ prompt: "fresh successor" });
      const session = makeStreamingSession({ pendingMessages: [retry, successor] });
      let now = 2_000;
      let released = 0;
      const expired: RuntimeUserMessage[][] = [];
      const generator = createRuntimeMessageGenerator({
        sessionName: "dev",
        session,
        stashedMessages: new Map(),
        capacityRetryRuntime: { now: () => now },
        afterTurnEnd: () => {
          released++;
        },
        traceTurnStart: async () => {
          now = 31_000;
          return undefined;
        },
        onCapacityRetryExhausted: ({ deliverableMessages, reason }) => {
          expired.push(deliverableMessages);
          expect(reason).toBe(PROVIDER_CAPACITY_EXHAUSTED_REASON);
          expect(session.pendingMessages).toEqual([successor]);
        },
      });
      const result = await generator.next();
      expect(result.value?.message.content).toBe(capacity ? "fresh successor" : "retry work");
      expect(expired).toEqual(capacity ? [[retry]] : []);
      expect(released).toBe(capacity ? 1 : 0);
      expect(successor.providerCapacityRetry).toBeUndefined();
      session.done = true;
      session.onTurnComplete?.();
      await generator.return(undefined);
    });
  }

  for (const cancellation of ["abort", "supersession"] as const) {
    it(`cancels a restored capacity wait on ${cancellation} without delivering its old cohort`, async () => {
      const retry = createQueuedRuntimeUserMessage({ prompt: "cancelled work" });
      retry.providerCapacityRetry = { startedAt: 1_000, retries: 1, notBefore: 13_000 };
      const successor = createQueuedRuntimeUserMessage({ prompt: "successor" });
      const session = makeStreamingSession({ pendingMessages: [retry, successor] });
      const generator = createRuntimeMessageGenerator({
        sessionName: "dev",
        session,
        stashedMessages: new Map(),
        capacityRetryRuntime: {
          now: () => 8_000,
          wait: async (_delayMs, signal) => {
            if (cancellation === "abort") session.abortController.abort();
            else {
              session.currentTurnSuperseded = true;
              session.interrupted = true;
            }
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            });
          },
        },
      });

      const result = await generator.next();
      expect(session.pendingMessages).toEqual([successor]);
      if (cancellation === "abort") expect(result.done).toBe(true);
      else {
        expect(result.value).toMatchObject({ message: { content: "successor" } });
        expect(session.interrupted).toBe(false);
      }
      session.done = true;
      session.onTurnComplete?.();
      await generator.return(undefined);
    });
  }

  it("fails closed on malformed persisted retry scheduling and leaves independent input queued", async () => {
    const retry = createQueuedRuntimeUserMessage({ prompt: "malformed retry" });
    retry.providerCapacityRetry = { startedAt: 1_000, retries: 0, notBefore: 13_000 };
    const successor = createQueuedRuntimeUserMessage({ prompt: "successor" });
    const session = makeStreamingSession({ pendingMessages: [retry, successor] });
    const generator = createRuntimeMessageGenerator({ sessionName: "dev", session, stashedMessages: new Map() });
    await expect(generator.next()).rejects.toThrow(PROVIDER_CAPACITY_EXHAUSTED_MESSAGE);
    expect(session.pendingMessages).toEqual([successor]);
    expect(session.turnActive).toBe(false);
    expect(session.durableTurnPreparationFailed).not.toBe(true);
  });

  for (const timing of ["during wait", "during preparation"] as const) {
    it(`settles the original channel request on restored retry cancellation ${timing} before continuing`, async () => {
      const retry = createQueuedRuntimeUserMessage(channelPrompt("cancelled work", "cancelled-channel-turn"));
      retry.providerCapacityRetry = { startedAt: 1_000, retries: 1, notBefore: 13_000 };
      const successor = createQueuedRuntimeUserMessage(channelPrompt("successor", "successor-channel-turn"));
      const session = makeStreamingSession({ pendingMessages: [retry, successor] });
      let settled = false;
      let released = 0;
      let now = 8_000;
      const cancelled: RuntimeUserMessage[][] = [];
      const cancel = () => {
        session.currentTurnSuperseded = true;
        session.interrupted = true;
      };
      const generator = createRuntimeMessageGenerator({
        sessionName: "dev",
        session,
        stashedMessages: new Map(),
        capacityRetryRuntime: {
          now: () => now,
          wait: async (delayMs) => {
            now += delayMs;
            if (timing === "during wait") cancel();
          },
        },
        beforeTurnStart: ({ deliverableMessages }) => {
          if (deliverableMessages[0]?.pendingId === successor.pendingId) expect(settled).toBe(true);
        },
        transformTurnPrompt: ({ combinedPrompt }) => {
          if (timing === "during preparation") cancel();
          return combinedPrompt;
        },
        afterTurnEnd: () => {
          released++;
        },
        onCapacityRetryCancelled: async ({ deliverableMessages }) => {
          expect(session.pendingMessages).toEqual([successor]);
          cancelled.push(deliverableMessages);
          await Promise.resolve();
          settled = true;
        },
      });

      const result = await generator.next();
      expect(settled).toBe(true);
      expect(released).toBe(timing === "during preparation" ? 1 : 0);
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0]?.[0]?.launchPrompt?._channelBackend?.binding.turnId).toBe("cancelled-channel-turn");
      expect(session.pendingMessages).toEqual([successor]);
      if (timing === "during wait") expect(result.value?.message.content).toBe("successor");
      else expect(result.done).toBe(true);
      session.done = true;
      session.onTurnComplete?.();
      await generator.return(undefined);
    });
  }

  it("never restores a discarded capacity cohort when cancellation reporting fails", async () => {
    const retry = createQueuedRuntimeUserMessage(channelPrompt("cancelled work", "cancelled-channel-turn"));
    retry.providerCapacityRetry = { startedAt: 1_000, retries: 1, notBefore: 13_000 };
    const successor = createQueuedRuntimeUserMessage({ prompt: "successor" });
    const session = makeStreamingSession({ pendingMessages: [retry, successor] });
    const generator = createRuntimeMessageGenerator({
      sessionName: "dev",
      session,
      stashedMessages: new Map(),
      capacityRetryRuntime: {
        now: () => 8_000,
        wait: async () => {
          session.abortController.abort();
        },
      },
      onCapacityRetryCancelled: () => {
        throw new Error("channel ledger unavailable");
      },
    });
    await expect(generator.next()).rejects.toThrow("channel ledger unavailable");
    expect(session.pendingMessages).toEqual([successor]);
    expect(session.durableTurnPreparationFailed).toBe(false);
  });

  for (const interrupted of [false, true]) {
    it(`hands the next provider input to a human behind 64 reports (interrupt=${interrupted})`, async () => {
      const active = createQueuedRuntimeUserMessage(progressPrompt("active report", 0));
      const reports = Array.from({ length: 64 }, (_, index) =>
        createQueuedRuntimeUserMessage(progressPrompt(`report ${index}: evidence-${index}`, index + 1)),
      );
      const questions = Array.from({ length: 4 }, (_, index) =>
        createQueuedRuntimeUserMessage(channelPrompt(`human question ${index}`, `human-${index}`)),
      );
      const session = makeStreamingSession({ pendingMessages: [active] });
      const handoffs: RuntimeUserMessage[][] = [];
      const generator = createRuntimeMessageGenerator({
        sessionName: "queue-fixture",
        session,
        stashedMessages: new Map(),
        beforeTurnStart: ({ deliverableMessages }) => {
          handoffs.push(deliverableMessages);
          session.currentSource = deliverableMessages[0]?.launchPrompt?.source;
        },
      });
      await generator.next();
      session.pendingMessages.push(...reports, ...questions);
      if (interrupted) {
        const successor = prepareRuntimeInterruptSuccessor("queue-fixture", session);
        expect(successor?.message.message.content).toContain("human question 0");
        expect(successor?.message.message.content).not.toContain("evidence-");
        session.interrupted = true;
        session.currentTurnSuperseded = true;
      }
      session.turnActive = false;
      session.onTurnComplete?.();
      const next = await generator.next();
      expect(next.value?.message.content).toContain("human question 0");
      expect(next.value?.message.content).not.toContain("evidence-");
      expect(handoffs[1]?.every((message) => message.launchPrompt?._channelBackend)).toBe(true);
      expect(session.pendingMessages.filter((message) => reports.includes(message))).toHaveLength(64);

      // Drain real generator turns. Every report's full content and pending id
      // must survive batching, and each original atom is acknowledged only once.
      const delivered = [...handoffs[1]!];
      let reportTurns = 0;
      while (session.pendingMessages.length > (session.currentTurnPendingIds?.length ?? 0)) {
        session.turnActive = false;
        session.onTurnComplete?.();
        const turn = await generator.next();
        const batch = handoffs[handoffs.length - 1]!;
        delivered.push(...batch);
        if (batch.some((message) => reports.some((report) => report.pendingId === message.pendingId))) {
          reportTurns++;
          for (const message of batch) expect(turn.value?.message.content).toContain(message.message.content);
        }
      }
      session.done = true;
      session.turnActive = false;
      session.onTurnComplete?.();
      expect((await generator.next()).done).toBe(true);
      expect(session.pendingMessages).toEqual([]);
      for (const report of reports) {
        expect(delivered.filter((message) => message.pendingId === report.pendingId)).toHaveLength(1);
      }
      for (let index = 0; index < 4; index++) {
        expect(delivered.map((message) => message.message.content).join("\n")).toContain(`human question ${index}`);
      }
      expect(reportTurns).toBeLessThanOrEqual(4);
    });
  }

  it("does not consolidate progress across authority, surface, completion or replay boundaries", () => {
    const first = createQueuedRuntimeUserMessage(progressPrompt("first evidence", 1));
    const compatible = createQueuedRuntimeUserMessage(progressPrompt("second evidence", 2));
    expect(
      getDeliverableRuntimeMessages(
        "queue-fixture",
        makeStreamingSession({
          pendingMessages: [first, compatible],
        }),
      ),
    ).toEqual([first, compatible]);
    for (const boundary of ["caller", "surface", "complete", "replay", "principal"] as const) {
      const other = createQueuedRuntimeUserMessage(progressPrompt("separate evidence", 3));
      if (boundary === "caller") other.launchPrompt!._turnOrigin!.callerContextId = "different-context";
      if (boundary === "surface") other.launchPrompt!.source!.threadId = "another-thread";
      if (boundary === "complete") other.launchPrompt!._slackThreadLifecycle!.eventType = "thread.close";
      if (boundary === "principal") other.launchPrompt!._turnOrigin!.principal.id = "other-agent";
      if (boundary === "replay") {
        other.replay = true;
        other.clientMessageId = "existing-attempt";
      }
      expect(
        getDeliverableRuntimeMessages(
          "queue-fixture",
          makeStreamingSession({
            pendingMessages: [first, other, compatible],
          }),
        ),
      ).toEqual([first]);
    }
  });

  it("never promotes a human through ambiguous replay or a different active surface", () => {
    const report = createQueuedRuntimeUserMessage(progressPrompt("pending reconciliation", 1));
    report.replay = true;
    report.clientMessageId = "existing-attempt";
    const human = createQueuedRuntimeUserMessage(channelPrompt("next question", "human"));
    expect(
      getDeliverableRuntimeMessages(
        "queue-fixture",
        makeStreamingSession({
          pendingMessages: [report, human],
        }),
      ),
    ).toEqual([report]);
    const session = makeStreamingSession({
      turnActive: true,
      currentSource: { ...report.launchPrompt!.source!, threadId: "another-thread" },
      currentTurnPendingIds: [report.pendingId!],
      pendingMessages: [report, human],
    });
    expect(prepareRuntimeInterruptSuccessor("queue-fixture", session)).toBeNull();
  });

  it("bounds progress by bytes without dropping a long blocker or acknowledging arrivals during a batch", async () => {
    const first = createQueuedRuntimeUserMessage(progressPrompt("first evidence", 1));
    const second = createQueuedRuntimeUserMessage(progressPrompt("second evidence", 2));
    const blocker = createQueuedRuntimeUserMessage(progressPrompt(`BLOCKER: ${"x".repeat(33 * 1024)}`, 3));
    const session = makeStreamingSession({ pendingMessages: [first, second, blocker] });
    const generator = createRuntimeMessageGenerator({
      sessionName: "queue-fixture",
      session,
      stashedMessages: new Map(),
    });
    const batch = await generator.next();
    expect(batch.value?.message.content).toContain("first evidence");
    expect(batch.value?.message.content).toContain("second evidence");
    expect(batch.value?.message.content).not.toContain("BLOCKER:");
    const arrival = createQueuedRuntimeUserMessage(progressPrompt("new decision during delivery", 4));
    session.pendingMessages.push(arrival);
    session.turnActive = false;
    session.onTurnComplete?.();
    const next = await generator.next();
    expect(next.value?.message.content).toContain(blocker.message.content);
    expect(session.pendingMessages).toEqual([blocker, arrival]);
    session.done = true;
    session.turnActive = false;
    session.onTurnComplete?.();
    await generator.next();
    expect(session.pendingMessages).toEqual([arrival]);
  });

  it("replays the complete original progress batch under its original delivery id", async () => {
    const reports = [1, 2, 3].map((index) =>
      createQueuedRuntimeUserMessage(progressPrompt(`evidence ${index}`, index)),
    );
    const session = makeStreamingSession({ pendingMessages: [...reports] });
    const generator = createRuntimeMessageGenerator({
      sessionName: "queue-fixture",
      session,
      stashedMessages: new Map(),
    });
    const original = (await generator.next()).value!;
    for (const report of reports) report.replay = true;
    const human = createQueuedRuntimeUserMessage(channelPrompt("arrived after ambiguous delivery", "later"));
    session.pendingMessages.push(human);
    session.interrupted = true;
    session.turnActive = false;
    session.onTurnComplete?.();
    const retry = (await generator.next()).value!;
    expect(retry.message.content).toBe(original.message.content);
    expect(retry.clientMessageId).toBe(original.clientMessageId);
    expect(retry.replay).toBe(true);
    expect(session.currentTurnPendingIds).toEqual(reports.map((report) => report.pendingId!));
    session.done = true;
    session.turnActive = false;
    session.onTurnComplete?.();
    await generator.next();
    expect(session.pendingMessages).toEqual([human]);
  });

  for (const restored of [false, true]) {
    for (const humanArrives of [false, true]) {
      it(`retries the complete capacity-rejected report cohort before fresh input (restored=${restored}, human=${humanArrives})`, async () => {
        let reports = [1, 2, 3].map((index) =>
          createQueuedRuntimeUserMessage(progressPrompt(`retry evidence ${index}`, index)),
        );
        let session = makeStreamingSession({ pendingMessages: [...reports] });
        let now = 8_000;
        const waits: number[] = [];
        const createGenerator = () =>
          createRuntimeMessageGenerator({
            sessionName: "queue-fixture",
            session,
            stashedMessages: new Map(),
            capacityRetryRuntime: {
              now: () => now,
              wait: async (delayMs) => {
                waits.push(delayMs);
                now += delayMs;
              },
            },
          });
        let generator = createGenerator();
        const original = (await generator.next()).value!;
        for (const report of reports) {
          report.providerCapacityRetry = {
            startedAt: 1_000,
            retries: 1,
            ...(restored ? { notBefore: 13_000 } : {}),
          };
          report.replay = false;
        }
        const fresh = createQueuedRuntimeUserMessage(progressPrompt("new report after failure", 4));
        const human = createQueuedRuntimeUserMessage(channelPrompt("human after failure", "later"));
        session.pendingMessages.push(fresh, ...(humanArrives ? [human] : []));
        if (restored) {
          await generator.return(undefined);
          // Restart snapshots carry scheduled retries as pending-only work,
          // retaining the prior physical id and explicitly clearing replay.
          session = makeStreamingSession({ pendingMessages: structuredClone(session.pendingMessages) });
          reports = session.pendingMessages.slice(0, reports.length);
          generator = createGenerator();
        } else {
          session.interrupted = true;
          session.turnActive = false;
          session.onTurnComplete?.();
        }

        const retry = (await generator.next()).value!;
        expect(retry.message.content).toBe(original.message.content);
        expect(retry.clientMessageId).not.toBe(original.clientMessageId);
        expect(retry.replay).toBe(false);
        expect(session.currentTurnPendingIds).toEqual(reports.map((report) => report.pendingId!));
        expect(reports.map((report) => report.providerCapacityRetry)).toEqual(
          reports.map(() => ({ startedAt: 1_000, retries: 1 })),
        );
        expect(waits).toEqual(restored ? [5_000] : []);

        session.turnActive = false;
        session.onTurnComplete?.();
        const successor = (await generator.next()).value!;
        expect(successor.message.content).toContain(humanArrives ? "human after failure" : "new report after failure");
        expect(successor.message.content).not.toContain("retry evidence");
        expect(
          session.pendingMessages.some((message) => reports.some((report) => report.pendingId === message.pendingId)),
        ).toBe(false);
        expect(session.pendingMessages.every((message) => message.providerCapacityRetry === undefined)).toBe(true);
        session.done = true;
        session.turnActive = false;
        session.onTurnComplete?.();
        await generator.next();
        expect(session.pendingMessages.map((message) => message.pendingId)).toEqual(
          humanArrives ? [fresh.pendingId!] : [],
        );
      });
    }
  }

  it("keeps a Slack DM turn ahead of a system return addressed to the default DM", () => {
    const active = createQueuedRuntimeUserMessage(surfacePrompt("private DM request", "slack", "D_SOURCE"));
    const notification = createQueuedRuntimeUserMessage({
      ...surfacePrompt("[System] Inform: another thread finished", "slack", "D_DEFAULT"),
      deliveryBarrier: "after_tool",
    });
    const session = makeStreamingSession({
      turnActive: true,
      currentSource: active.launchPrompt!.source,
      currentReplyTarget: active.launchPrompt!.source,
      currentTurnToolStarted: true,
      toolRunning: false,
      pendingMessages: [active, notification],
      currentTurnPendingIds: [active.pendingId!],
    });

    expect(prepareRuntimeInterruptSuccessor("dev", session)).toBeNull();
    expect(session.pendingMessages).toEqual([active, notification]);
    expect(session.currentSource).toEqual(active.launchPrompt!.source);
    expect(session.currentReplyTarget).toEqual(active.launchPrompt!.source);
  });

  for (const boundary of ["source-less", "thread", "account"] as const) {
    for (const barrier of ["after_tool", "immediate_interrupt"] as const) {
      it(`does not cross a ${boundary} boundary for ${barrier} input`, () => {
        const source = {
          channel: "slack",
          accountId: "slack-a",
          instanceId: "instance-a",
          chatId: "D_SOURCE",
        };
        const incomingSource =
          boundary === "source-less"
            ? undefined
            : boundary === "thread"
              ? { ...source, threadId: "thread-1" }
              : { ...source, accountId: "slack-b", instanceId: "instance-b" };
        const active = createQueuedRuntimeUserMessage({ prompt: "private request", source });
        const incoming = createQueuedRuntimeUserMessage({
          prompt: "[System] Inform: other work finished",
          source: incomingSource,
          deliveryBarrier: barrier,
          _turnOrigin: buildSessionRelayTurnOrigin("inform"),
        });
        const session = makeStreamingSession({
          turnActive: true,
          currentSource: source,
          currentReplyTarget: source,
          currentTurnPendingIds: [active.pendingId!],
          pendingMessages: [active, incoming],
        });

        expect(prepareRuntimeInterruptSuccessor("dev", session)).toBeNull();
        expect(session.pendingMessages).toEqual([active, incoming]);
        expect(session.currentReplyTarget).toEqual(source);
      });
    }
  }
  it("shares post-interrupt retention without changing pending identity or order", () => {
    const accepted = createQueuedRuntimeUserMessage({ prompt: "accepted request" });
    const successor = createQueuedRuntimeUserMessage({ prompt: "queued successor", deliveryBarrier: "after_task" });
    const session = makeStreamingSession({
      pendingMessages: [accepted, successor],
      currentTurnPendingIds: [accepted.pendingId!],
      interrupted: true,
    });

    const retained = getRuntimeMessagesAfterTurn(session, new Set([accepted.pendingId!]));

    expect(retained).toBe(session.pendingMessages);
    expect(retained).toEqual([accepted, successor]);
    expect(retained[0]).toBe(accepted);
    expect(retained[1]?.deliveryBarrier).toBe("after_task");
    expect(session.interrupted).toBe(true);
    expect(session.currentTurnPendingIds).toEqual([accepted.pendingId!]);
  });

  it("uses live superseded IDs rather than captured normal-completion IDs", () => {
    const accepted = createQueuedRuntimeUserMessage({ prompt: "superseded request" });
    const successor = createQueuedRuntimeUserMessage({ prompt: "replacement request" });
    const session = makeStreamingSession({
      pendingMessages: [accepted, successor],
      currentTurnPendingIds: [accepted.pendingId!],
      currentTurnSuperseded: true,
      interrupted: true,
    });

    expect(getRuntimeMessagesAfterTurn(session, new Set([successor.pendingId!]))).toEqual([successor]);
    expect(session.pendingMessages).toEqual([accepted, successor]);
    expect(session.currentTurnSuperseded).toBe(true);
  });

  it("uses captured yielded IDs for normal completion and keeps unnamed queued atoms", () => {
    const accepted = createQueuedRuntimeUserMessage({ prompt: "completed request" });
    const successor = createQueuedRuntimeUserMessage({ prompt: "later request" });
    const unnamed = { ...createQueuedRuntimeUserMessage({ prompt: "unnamed" }), pendingId: undefined };
    const session = makeStreamingSession({
      pendingMessages: [accepted, successor, unnamed],
      currentTurnPendingIds: [successor.pendingId!],
    });

    expect(getRuntimeMessagesAfterTurn(session, new Set([accepted.pendingId!]))).toEqual([successor, unnamed]);
    expect(session.pendingMessages).toEqual([accepted, successor, unnamed]);
  });

  it("preserves conservative interrupted selection when current-turn IDs are absent", () => {
    const accepted = createQueuedRuntimeUserMessage({ prompt: "unclassified request" });
    const session = makeStreamingSession({
      pendingMessages: [accepted],
      currentTurnSuperseded: true,
      interrupted: true,
    });

    expect(getRuntimeMessagesAfterTurn(session, new Set([accepted.pendingId!]))).toBe(session.pendingMessages);
    expect(session.currentTurnPendingIds).toBeUndefined();
  });

  it("keeps admitted cron runs separate and preserves their identity in continuations", () => {
    const first = createQueuedRuntimeUserMessage({ prompt: "first", _cron: true, _jobId: "job", _cronRunId: "run-1" });
    const second = createQueuedRuntimeUserMessage({
      prompt: "second",
      _cron: true,
      _jobId: "job",
      _cronRunId: "run-2",
    });
    const session = makeStreamingSession({ pendingMessages: [first, second] });
    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([first]);
    expect(pickRuntimeTurnAuthorityEnvelope(first.launchPrompt)).toMatchObject({
      _cron: true,
      _jobId: "job",
      _cronRunId: "run-1",
    });
  });
  it("distinguishes host write-ahead from Codex and Pi asynchronous tool observation", () => {
    expect(resolveRuntimeToolEffectFence("claude", "ravi-host")).toBe("host_write_ahead");
    expect(resolveRuntimeToolEffectFence("grok", "ravi-host")).toBe("host_write_ahead");
    expect(resolveRuntimeToolEffectFence("codex", "ravi-host")).toBe("provider_event_only");
    expect(resolveRuntimeToolEffectFence("pi", "provider-native")).toBe("provider_event_only");
    expect(resolveRuntimeToolEffectFence("pi", "ravi-host")).toBe("provider_event_only");
  });

  it("refreshes lastActivity when a new turn starts on a reused session", async () => {
    const staleActivityAt = Date.now() - 15 * 60 * 1000;
    const queuedMessage = createQueuedRuntimeUserMessage({ prompt: "continua" });
    const session = makeStreamingSession({
      pendingMessages: [queuedMessage],
      lastActivity: staleActivityAt,
      durableTurnPreparationFailed: true,
    });
    const generator = createRuntimeMessageGenerator({
      sessionName: "dev",
      session,
      stashedMessages: new Map(),
    });

    const result = await generator.next();

    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({
      type: "user",
      message: { role: "user", content: "continua" },
    });
    expect(session.turnActive).toBe(true);
    expect(session.durableTurnPreparationFailed).toBe(false);
    expect(session.lastActivity).toBeGreaterThan(staleActivityAt);

    session.done = true;
    session.onTurnComplete?.();
    await generator.return(undefined);
  });

  it("yields the session's current model, effort and thinking with each turn", async () => {
    const session = makeStreamingSession({
      pendingMessages: [createQueuedRuntimeUserMessage({ prompt: "task turn" })],
      currentEffort: "low",
      currentThinking: "verbose",
    });
    const generator = createRuntimeMessageGenerator({
      sessionName: "dev",
      session,
      stashedMessages: new Map(),
      beforeTurnStart: () => {
        session.currentModel = "task-model";
        session.currentEffort = "xhigh";
      },
    });

    const result = await generator.next();

    expect(result.value).toMatchObject({
      runtimeOptions: { model: "task-model", effort: "xhigh", thinking: "verbose" },
    });
    session.done = true;
    session.onTurnComplete?.();
    await generator.return(undefined);
  });

  it("cancels idle session eviction when a new turn starts", async () => {
    const idleTimer = setTimeout(() => {}, 60_000);
    const queuedMessage = createQueuedRuntimeUserMessage({ prompt: "voltei" });
    const session = makeStreamingSession({
      pendingMessages: [queuedMessage],
      idleSessionEvictionTimer: idleTimer,
    });
    const generator = createRuntimeMessageGenerator({
      sessionName: "dev",
      session,
      stashedMessages: new Map(),
    });

    await generator.next();

    expect(session.idleSessionEvictionTimer).toBeUndefined();

    session.done = true;
    session.onTurnComplete?.();
    await generator.return(undefined);
  });

  it("fails closed before provider delivery when durable turn preparation fails", async () => {
    const queuedMessage = createQueuedRuntimeUserMessage({ prompt: "must stay durable" });
    const session = makeStreamingSession({
      pendingMessages: [queuedMessage],
      currentCrashRecoveryAttemptId: "stale-attempt",
    });
    const generator = createRuntimeMessageGenerator({
      sessionName: "dev",
      session,
      stashedMessages: new Map(),
      traceTurnStart: () => {
        throw new Error("ledger unavailable");
      },
    });

    await expect(generator.next()).rejects.toThrow("ledger unavailable");
    expect(session.pendingMessages).toEqual([queuedMessage]);
    expect(session.turnActive).toBe(false);
    expect(session.currentTurnPendingIds).toBeUndefined();
    expect(session.currentTraceTurnId).toBeUndefined();
    expect(session.currentCrashRecoveryAttemptId).toBeUndefined();
    expect(session.durableTurnPreparationFailed).toBe(true);
    expect(session.onTurnComplete).toBeNull();
  });

  it("retains a terminal latch until the next physical handoff begins", async () => {
    const active = createQueuedRuntimeUserMessage({ prompt: "already complete" });
    const successor = createQueuedRuntimeUserMessage({ prompt: "next turn" });
    const session = makeStreamingSession({ pendingMessages: [active] });
    const generator = createRuntimeMessageGenerator({
      sessionName: "dev",
      session,
      stashedMessages: new Map(),
    });

    expect((await generator.next()).value).toMatchObject({
      message: { content: "already complete" },
    });
    session.pendingMessages.push(successor);
    session.currentCrashRecoveryTerminal = {
      status: "complete",
      completedAt: Date.now(),
      startedTool: false,
      materializedOutput: false,
    };

    const nextTurn = generator.next();
    session.onTurnComplete?.();

    // Snapshot code may run synchronously in this exact terminal->drain gap.
    expect(session.currentCrashRecoveryTerminal?.status).toBe("complete");
    expect((await nextTurn).value).toMatchObject({
      message: { content: "next turn" },
    });
    expect(session.currentCrashRecoveryTerminal).toBeUndefined();

    session.done = true;
    session.onTurnComplete?.();
    await generator.return(undefined);
  });

  it("clears idle session eviction timer during runtime shutdown", () => {
    const idleTimer = setTimeout(() => {}, 60_000);
    const session = makeStreamingSession({
      idleSessionEvictionTimer: idleTimer,
    });

    shutdownRuntimeStreamingSession(session, "test");

    expect(session.idleSessionEvictionTimer).toBeUndefined();
    expect(session.done).toBe(true);
  });

  it("keeps the original launch prompt envelope on queued messages", () => {
    const queuedMessage = createQueuedRuntimeUserMessage({
      prompt: "continua",
      deliveryBarrier: "after_response",
      deliveryBarrierSource: "default",
      taskBarrierTaskId: "task-1",
      source: {
        channel: "whatsapp",
        accountId: "main",
        chatId: "group:1",
        sourceMessageId: "wamid-1",
      },
      context: {
        channelId: "whatsapp",
        channelName: "WhatsApp",
        accountId: "main",
        chatId: "group:1",
        messageId: "wamid-1",
        senderId: "user-1",
        isGroup: true,
        timestamp: 1,
      },
      _agentId: "e2-filipe",
    });

    expect(queuedMessage.launchPrompt).toMatchObject({
      prompt: "continua",
      deliveryBarrier: "after_response",
      deliveryBarrierSource: "default",
      taskBarrierTaskId: "task-1",
      source: {
        channel: "whatsapp",
        accountId: "main",
        chatId: "group:1",
        sourceMessageId: "wamid-1",
      },
      context: {
        messageId: "wamid-1",
        senderId: "user-1",
      },
      _agentId: "e2-filipe",
    });
    expect(queuedMessage.deliveryBarrierSource).toBe("default");
  });

  it("does not request provider interrupt while the runtime is between turns", () => {
    const session = makeStreamingSession({
      turnActive: false,
      pushMessage: null,
      pendingMessages: [createQueuedRuntimeUserMessage({ prompt: "continua" })],
    });

    expect(shouldInterruptRuntimeForIncoming("dev", session, "after_tool")).toEqual({
      interrupt: false,
      reason: "idle_gap",
    });
  });

  it("still requests provider interrupt for active text generation", () => {
    const session = makeStreamingSession({
      turnActive: true,
      pushMessage: null,
    });

    expect(shouldInterruptRuntimeForIncoming("dev", session, "after_tool")).toEqual({
      interrupt: true,
      reason: "response",
    });
  });

  it("queues behind a short tool and interrupts behind a long one", () => {
    const shortTool = makeStreamingSession({
      turnActive: true,
      toolRunning: true,
      currentToolSafety: "unsafe",
      currentToolName: "bash",
      toolStartTime: Date.now() - 2_000,
    });
    // 2s: enfileirar é melhor, porque a tool termina e a mensagem entra em seguida.
    expect(shouldInterruptRuntimeForIncoming("dev", shortTool, "after_tool")).toEqual({
      interrupt: false,
      reason: "tool",
    });

    const longTool = makeStreamingSession({
      turnActive: true,
      toolRunning: true,
      currentToolSafety: "unsafe",
      currentToolName: "bash",
      toolStartTime: Date.now() - 30_000,
    });
    // 30s e unsafe: ainda assim interrompe. A mensagem da pessoa não fica presa
    // atrás de um `sleep 100`.
    expect(shouldInterruptRuntimeForIncoming("dev", longTool, "after_tool")).toEqual({
      interrupt: true,
      reason: "long_running_tool",
    });
  });

  it("keeps an end-of-turn follow-up queued behind a long tool and active text", () => {
    const longTool = makeStreamingSession({
      turnActive: true,
      toolRunning: true,
      currentToolSafety: "unsafe",
      currentToolName: "bash",
      toolStartTime: Date.now() - 30_000,
    });
    expect(shouldInterruptRuntimeForIncoming("dev", longTool, "after_response")).toEqual({
      interrupt: false,
      reason: "tool",
    });

    const generating = makeStreamingSession({ turnActive: true, pushMessage: null });
    expect(shouldInterruptRuntimeForIncoming("dev", generating, "after_response")).toEqual({
      interrupt: false,
      reason: "response",
    });
  });

  it("lets an explicit interrupt win over a running tool", () => {
    const session = makeStreamingSession({
      turnActive: true,
      toolRunning: true,
      currentToolSafety: "unsafe",
      currentToolName: "bash",
      toolStartTime: Date.now() - 500,
    });

    // 500ms de tool: curto demais para o limiar, mas o pedido é explícito.
    expect(shouldInterruptRuntimeForIncoming("dev", session, "immediate_interrupt")).toEqual({
      interrupt: true,
      reason: "explicit_interrupt",
    });
  });

  it("keeps every interrupt lane closed while a provider tool callback is being delivered", () => {
    const session = makeStreamingSession({
      turnActive: true,
      toolRunning: false,
      currentToolSafety: "safe",
      toolResultDeliveryPending: true,
    });

    for (const barrier of ["immediate_interrupt", "after_tool", "after_response", "after_task"] as const) {
      expect(canReleaseRuntimeDeliveryBarrier("dev", session, barrier, undefined, false)).toBe(false);
    }
    expect(shouldInterruptRuntimeForIncoming("dev", session, "immediate_interrupt")).toEqual({
      interrupt: false,
      reason: "tool_result_delivery",
    });
    expect(shouldInterruptRuntimeForIncoming("dev", session, "after_tool")).toEqual({
      interrupt: false,
      reason: "tool_result_delivery",
    });
  });

  it("delivers the steering prompt next instead of replaying the superseded channel turn", async () => {
    const active = createQueuedRuntimeUserMessage(channelPrompt("implement the old plan", "turn-a"));
    const steering = createQueuedRuntimeUserMessage(channelPrompt("stop and use the new plan", "turn-b"));
    const session = makeStreamingSession({
      pendingMessages: [active],
    });
    const generator = createRuntimeMessageGenerator({
      sessionName: "dev",
      session,
      stashedMessages: new Map(),
    });

    const first = await generator.next();
    expect(first.value).toMatchObject({
      message: { content: "implement the old plan" },
    });

    session.pendingMessages.push(steering);
    session.currentTurnSuperseded = true;
    session.interrupted = true;
    session.turnActive = false;
    session.onTurnComplete?.();

    const second = await generator.next();
    expect(second.value).toMatchObject({
      message: { content: "stop and use the new plan" },
    });
    expect(session.pendingMessages).toEqual([steering]);

    session.done = true;
    session.onTurnComplete?.();
    await generator.return(undefined);
  });

  it("wakes the generator and drains after_tool FIFO after a fatal tool barrier clears", async () => {
    const active = createQueuedRuntimeUserMessage({ prompt: "run bash", deliveryBarrier: "after_tool" });
    const first = createQueuedRuntimeUserMessage({ prompt: "first follow-up", deliveryBarrier: "after_tool" });
    const second = createQueuedRuntimeUserMessage({ prompt: "second follow-up", deliveryBarrier: "after_tool" });
    const session = makeStreamingSession({
      pendingMessages: [active],
    });
    const generator = createRuntimeMessageGenerator({
      sessionName: "dev",
      session,
      stashedMessages: new Map(),
    });

    expect((await generator.next()).value).toMatchObject({
      message: { content: "run bash" },
    });

    session.toolRunning = true;
    session.pendingMessages.push(first, second);
    expect(canReleaseRuntimeDeliveryBarrier("dev", session, "after_tool")).toBe(false);
    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([]);

    session.toolRunning = false;
    session.turnActive = false;
    expect(canReleaseRuntimeDeliveryBarrier("dev", session, "after_tool")).toBe(true);
    session.onTurnComplete?.();

    expect((await generator.next()).value).toMatchObject({
      message: { content: "first follow-up\n\nsecond follow-up" },
    });
    expect(session.pendingMessages.map((message) => message.message.content)).toEqual([
      "first follow-up",
      "second follow-up",
    ]);

    session.done = true;
    session.onTurnComplete?.();
    await generator.return(undefined);
  });

  it("coalesces a compatible channel backlog behind the latest interrupting prompt", async () => {
    const active = createQueuedRuntimeUserMessage(channelPrompt("old active work", "turn-a"));
    const queued = createQueuedRuntimeUserMessage(channelPrompt("first steering detail", "turn-b"));
    const latest = createQueuedRuntimeUserMessage(channelPrompt("latest steering direction", "turn-c"));
    const session = makeStreamingSession({ pendingMessages: [active] });
    const generator = createRuntimeMessageGenerator({
      sessionName: "dev",
      session,
      stashedMessages: new Map(),
    });

    expect((await generator.next()).value).toMatchObject({
      message: { content: "old active work" },
    });
    session.pendingMessages.push(queued, latest);

    const prepared = prepareRuntimeInterruptSuccessor("dev", session);

    expect(prepared?.coalescedMessages).toEqual([queued]);
    expect(session.pendingMessages).toHaveLength(2);
    expect(session.pendingMessages[0]).toBe(active);
    expect(session.pendingMessages[1]).toMatchObject({
      pendingId: latest.pendingId,
      message: { content: "first steering detail\n\nlatest steering direction" },
      launchPrompt: {
        prompt: "first steering detail\n\nlatest steering direction",
        _channelBackend: { binding: { turnId: "turn-c" } },
      },
    });

    session.currentTurnSuperseded = true;
    session.interrupted = true;
    session.turnActive = false;
    session.onTurnComplete?.();

    expect((await generator.next()).value).toMatchObject({
      message: { content: "first steering detail\n\nlatest steering direction" },
    });

    session.done = true;
    session.onTurnComplete?.();
    await generator.return(undefined);
  });

  it("preserves FIFO instead of combining or reordering different actors", () => {
    const active = createQueuedRuntimeUserMessage(channelPrompt("active", "turn-a"));
    const otherActor = createQueuedRuntimeUserMessage(channelPrompt("other actor", "turn-b", "user-b"));
    const latest = createQueuedRuntimeUserMessage(channelPrompt("latest", "turn-c", "user-a"));
    const session = makeStreamingSession({
      turnActive: true,
      pendingMessages: [active, otherActor, latest],
      currentTurnPendingIds: [active.pendingId!],
    });

    const prepared = prepareRuntimeInterruptSuccessor("dev", session);

    expect(prepared?.coalescedMessages).toEqual([]);
    expect(prepared?.message).toBe(otherActor);
    expect(session.pendingMessages.map((message) => message.message.content)).toEqual([
      "active",
      "other actor",
      "latest",
    ]);
  });

  it("keeps different queued threads behind the active reply surface", () => {
    const active = createQueuedRuntimeUserMessage(channelPrompt("active", "turn-a"));
    const firstThread = createQueuedRuntimeUserMessage(channelPrompt("thread one", "turn-b", "user-a", "thread-1"));
    const secondThread = createQueuedRuntimeUserMessage(channelPrompt("thread two", "turn-c", "user-a", "thread-2"));
    const session = makeStreamingSession({
      turnActive: true,
      pendingMessages: [active, firstThread, secondThread],
      currentTurnPendingIds: [active.pendingId!],
    });

    const prepared = prepareRuntimeInterruptSuccessor("dev", session);

    expect(prepared).toBeNull();
    expect(session.pendingMessages).toEqual([active, firstThread, secondThread]);
  });

  it("does not fold Ravi Commands into conversational steering", () => {
    const active = createQueuedRuntimeUserMessage(channelPrompt("active", "turn-a"));
    const command = createQueuedRuntimeUserMessage({
      ...channelPrompt("#deploy", "turn-b"),
      commands: [
        {
          id: "deploy",
          scope: "agent",
          sourcePath: "/commands/deploy.md",
          originalText: "#deploy",
          arguments: "",
          renderedPromptSha256: "a".repeat(64),
        },
      ],
    });
    const steering = createQueuedRuntimeUserMessage(channelPrompt("after command", "turn-c"));
    const session = makeStreamingSession({
      turnActive: true,
      pendingMessages: [active, command, steering],
      currentTurnPendingIds: [active.pendingId!],
    });

    const prepared = prepareRuntimeInterruptSuccessor("dev", session);

    expect(prepared?.coalescedMessages).toEqual([]);
    expect(prepared?.message).toBe(command);
    expect(session.pendingMessages).toEqual([active, command, steering]);
  });

  it("replays an active prompt marked for provider reconciliation", async () => {
    const active = createQueuedRuntimeUserMessage(channelPrompt("keep this work", "turn-a"));
    const session = makeStreamingSession({
      pendingMessages: [active],
    });
    const generator = createRuntimeMessageGenerator({
      sessionName: "dev",
      session,
      stashedMessages: new Map(),
    });

    const first = await generator.next();
    expect(first.value).toMatchObject({
      clientMessageId: expect.stringContaining("ravi:"),
      replay: false,
    });
    active.replay = true;
    session.interrupted = true;
    session.turnActive = false;
    session.onTurnComplete?.();

    const replay = await generator.next();
    expect(replay.value).toMatchObject({
      message: { content: "keep this work" },
      clientMessageId: first.value?.clientMessageId,
      replay: true,
    });
    expect(session.pendingMessages).toEqual([active]);

    session.done = true;
    session.onTurnComplete?.();
    await generator.return(undefined);
  });

  it("keeps later messages out of a stashed delivery attempt", () => {
    const active = createQueuedRuntimeUserMessage({ prompt: "original" });
    active.clientMessageId = "ravi:original";
    active.replay = true;
    const later = createQueuedRuntimeUserMessage({ prompt: "later" });
    const session = makeStreamingSession({
      pendingMessages: [active, later],
    });

    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([active]);
  });

  it("never folds queued messages from different senders into one turn", () => {
    const source = { channel: "whatsapp", accountId: "wa", chatId: "group:1" };
    const stranger = createQueuedRuntimeUserMessage({
      prompt: "stranger",
      source: { ...source, actorType: "unknown", normalizedSenderId: "5511900000001" },
    });
    const owner = createQueuedRuntimeUserMessage({
      prompt: "owner",
      source: { ...source, actorType: "contact", contactId: "owner" },
    });
    const ownerAgain = createQueuedRuntimeUserMessage({
      prompt: "owner again",
      source: { ...source, actorType: "contact", contactId: "owner" },
    });
    const anonymous = createQueuedRuntimeUserMessage({
      prompt: "anonymous",
      source: { ...source, actorType: "unknown" },
    });

    expect(getDeliverableRuntimeMessages("dev", makeStreamingSession({ pendingMessages: [stranger, owner] }))).toEqual([
      stranger,
    ]);
    expect(
      getDeliverableRuntimeMessages("dev", makeStreamingSession({ pendingMessages: [owner, ownerAgain, stranger] })),
    ).toEqual([owner, ownerAgain]);
    expect(
      getDeliverableRuntimeMessages("dev", makeStreamingSession({ pendingMessages: [anonymous, anonymous] })),
    ).toEqual([anonymous]);
  });

  it("keeps a prior delivery attempt out of a fresh unassigned batch", () => {
    const fresh = createQueuedRuntimeUserMessage({ prompt: "fresh" });
    const priorAttempt = createQueuedRuntimeUserMessage({ prompt: "prior attempt" });
    priorAttempt.clientMessageId = "ravi:prior";
    priorAttempt.replay = true;
    const session = makeStreamingSession({
      pendingMessages: [fresh, priorAttempt],
    });

    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([fresh]);
  });

  it("keeps intentional restarts mergeable even when the old turn had a delivery id", () => {
    const active = createQueuedRuntimeUserMessage({ prompt: "original" });
    active.clientMessageId = "ravi:original";
    const later = createQueuedRuntimeUserMessage({ prompt: "later" });
    const session = makeStreamingSession({
      pendingMessages: [active, later],
    });

    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([active, later]);
  });

  it("never combines queued messages from different reply surfaces", () => {
    const slack = createQueuedRuntimeUserMessage(surfacePrompt("from Slack", "slack", "chat-a"));
    const whatsapp = createQueuedRuntimeUserMessage(surfacePrompt("from WhatsApp", "whatsapp", "chat-b"));
    const session = makeStreamingSession({ pendingMessages: [slack, whatsapp] });

    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([slack]);
    session.pendingMessages.shift();
    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([whatsapp]);
  });

  it("keeps adjacent messages from the same reply surface in one turn", () => {
    const first = createQueuedRuntimeUserMessage(surfacePrompt("first", "slack", "chat-a"));
    const second = createQueuedRuntimeUserMessage(surfacePrompt("second", "slack", "chat-a"));
    const session = makeStreamingSession({ pendingMessages: [first, second] });

    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([first, second]);
  });

  for (const suppressed of [false, true]) {
    it(`uses the bound output for a source-less resumed turn (suppressed=${suppressed})`, () => {
      const active = createQueuedRuntimeUserMessage({ prompt: "CLI resume" });
      const human = createQueuedRuntimeUserMessage(surfacePrompt("human steering", "whatsapp", "chat-a"));
      const session = makeStreamingSession({
        turnActive: true,
        currentReplyTarget: human.launchPrompt!.source,
        suppressChatEmit: suppressed,
        pendingMessages: [active, human],
        currentTurnPendingIds: [active.pendingId!],
      });
      const prepared = prepareRuntimeInterruptSuccessor("dev", session);
      if (suppressed) expect(prepared).toBeNull();
      else expect(prepared?.message.pendingId).toBe(human.pendingId);
    });
  }

  for (const blocked of [false, true]) {
    it(`handles a cron without canonical identity before human steering (different account=${blocked})`, () => {
      const active = createQueuedRuntimeUserMessage(surfacePrompt("active", "whatsapp", "chat-a"));
      const source = active.launchPrompt!.source!;
      const cron = createQueuedRuntimeUserMessage({
        prompt: "scheduled followup",
        deliveryBarrier: "after_response",
        source: {
          channel: source.channel,
          accountId: blocked ? "another-account" : source.accountId,
          chatId: source.chatId,
          suppressPresence: true,
        },
      });
      const human = createQueuedRuntimeUserMessage(surfacePrompt("human steering", "whatsapp", "chat-a"));
      const session = makeStreamingSession({
        turnActive: true,
        currentSource: source,
        pendingMessages: [active, cron, human],
        currentTurnPendingIds: [active.pendingId!],
      });
      const prepared = prepareRuntimeInterruptSuccessor("dev", session);
      if (blocked) {
        expect(prepared).toBeNull();
        expect(session.pendingMessages).toEqual([active, cron, human]);
      } else {
        expect(prepared?.message.pendingId).toBe(human.pendingId);
        expect(prepared?.coalescedMessages).not.toContain(cron);
        expect(session.pendingMessages).toContain(cron);
      }
    });
  }

  it("keeps a different reply surface queued without creating a continuation", () => {
    const active = createQueuedRuntimeUserMessage(surfacePrompt("active", "slack", "chat-a"));
    const otherSurface = createQueuedRuntimeUserMessage(surfacePrompt("wait", "whatsapp", "chat-b"));
    const session = makeStreamingSession({
      turnActive: true,
      currentSource: active.launchPrompt?.source,
      pendingMessages: [active, otherSurface],
      currentTurnPendingIds: [active.pendingId!],
    });

    active.clientMessageId = "ravi:already-delivered";
    const prepared = prepareRuntimeInterruptSuccessor("dev", session);

    expect(prepared).toBeNull();
    expect(session.pendingMessages).toEqual([active, otherSurface]);
    expect(active.clientMessageId).toBe("ravi:already-delivered");
  });

  it("keeps the active turn's authority, backend and model intact while another thread waits", () => {
    const original = {
      ...channelPrompt("original work", "turn-original", "original-actor", "thread-original"),
      _runtimeModel: "original-model",
      _modelBrokerTurnId: "consumed-model-broker-plan",
      _runtimePrompt: "model-facing original work",
      taskBarrierTaskId: "original-task",
    };
    const active = createQueuedRuntimeUserMessage(original);
    const incoming = createQueuedRuntimeUserMessage(channelPrompt("new work", "turn-new", "other-actor", "thread-new"));
    const session = makeStreamingSession({
      turnActive: true,
      currentSource: original.source,
      currentTurnPendingIds: [active.pendingId!],
      pendingMessages: [active, incoming],
    });

    expect(prepareRuntimeInterruptSuccessor("dev", session)).toBeNull();
    expect(session.pendingMessages).toEqual([active, incoming]);
    expect(active.launchPrompt).toMatchObject({
      source: original.source,
      context: original.context,
      _channelBackend: original._channelBackend,
      _runtimeModel: "original-model",
      taskBarrierTaskId: "original-task",
    });
    expect(active.message.content).toBe("model-facing original work");
    expect(active.launchPrompt?._modelBrokerTurnId).toBe("consumed-model-broker-plan");
    expect(session.currentSource).toEqual(original.source);
  });

  it("finishes the active channel turn before draining another channel after a tool", async () => {
    const active = createQueuedRuntimeUserMessage(surfacePrompt("original WhatsApp work", "whatsapp", "wa"));
    const incoming = createQueuedRuntimeUserMessage(surfacePrompt("Slack request", "slack", "slack"));
    const session = makeStreamingSession({ pendingMessages: [active] });
    const generator = createRuntimeMessageGenerator({ sessionName: "dev", session, stashedMessages: new Map() });
    await generator.next();
    session.currentSource = active.launchPrompt!.source;
    session.currentTurnToolStarted = true;
    session.pendingMessages.push(incoming);
    expect(prepareRuntimeInterruptSuccessor("dev", session)).toBeNull();
    expect(getDeliverableRuntimeMessages("dev", session)).not.toContain(incoming);
    expect(session.pendingMessages).toEqual([active, incoming]);

    session.turnActive = false;
    session.onTurnComplete?.();
    expect((await generator.next()).value?.message.content).toBe("Slack request");
    session.currentSource = incoming.launchPrompt!.source;
    expect(session.pendingMessages).toEqual([incoming]);
    expect(prepareRuntimeInterruptSuccessor("dev", session)).toBeNull();

    session.done = true;
    session.onTurnComplete?.();
    await generator.return(undefined);
  });

  it("does not mutate the queue while an interrupt is already in flight", () => {
    const active = createQueuedRuntimeUserMessage(surfacePrompt("active", "whatsapp", "wa"));
    const incoming = createQueuedRuntimeUserMessage(surfacePrompt("incoming", "slack", "slack"));
    const session = makeStreamingSession({
      turnActive: true,
      currentSource: active.launchPrompt!.source,
      currentTurnPendingIds: [active.pendingId!],
      pendingMessages: [active, incoming],
    });
    session.currentTurnSuperseded = true;
    session.interrupted = true;
    expect(prepareRuntimeInterruptSuccessor("dev", session)).toBeNull();
    expect(session.pendingMessages).toEqual([active, incoming]);
  });

  it("keeps repeated cross-chat interrupt attempts from duplicating the original request", () => {
    const active = createQueuedRuntimeUserMessage(surfacePrompt("original", "whatsapp", "wa"));
    const incoming = createQueuedRuntimeUserMessage(surfacePrompt("first", "slack", "slack"));
    const session = makeStreamingSession({
      turnActive: true,
      currentSource: active.launchPrompt!.source,
      currentTurnPendingIds: [active.pendingId!],
      pendingMessages: [active, incoming],
    });
    expect(prepareRuntimeInterruptSuccessor("dev", session)).toBeNull();
    const later = createQueuedRuntimeUserMessage(surfacePrompt("second", "slack", "slack"));
    session.pendingMessages.push(later);
    expect(prepareRuntimeInterruptSuccessor("dev", session)).toBeNull();
    expect(session.pendingMessages).toEqual([active, incoming, later]);
  });

  for (const state of [
    { name: "thinking", toolRunning: false },
    { name: "short tool", toolRunning: true, toolAgeMs: 0 },
    { name: "long tool", toolRunning: true, toolAgeMs: 60_000 },
    { name: "pending result", toolResultDeliveryPending: true },
    { name: "compaction", compacting: true },
  ]) {
    it(`serializes different reply surfaces while the active turn is ${state.name}`, () => {
      const active = createQueuedRuntimeUserMessage(surfacePrompt("original", "whatsapp", "wa"));
      const incoming = createQueuedRuntimeUserMessage(surfacePrompt("incoming", "slack", "slack"));
      const session = makeStreamingSession({
        ...state,
        toolStartTime: Date.now() - (state.toolAgeMs ?? 0),
        turnActive: true,
        currentSource: active.launchPrompt!.source,
        currentTurnPendingIds: [active.pendingId!],
        pendingMessages: [active, incoming],
      });
      expect(prepareRuntimeInterruptSuccessor("dev", session)).toBeNull();
      expect(session.pendingMessages).toEqual([active, incoming]);
    });
  }

  for (const barrier of ["after_tool", "after_response", "immediate_interrupt"] as const) {
    it(`does not let a later same-surface interrupt bypass an earlier different surface (${barrier})`, () => {
      const active = createQueuedRuntimeUserMessage(surfacePrompt("active", "slack", "chat-a"));
      const otherSurface = createQueuedRuntimeUserMessage({
        ...surfacePrompt("other surface first", "whatsapp", "chat-b"),
        deliveryBarrier: barrier,
      });
      const sameSurface = createQueuedRuntimeUserMessage(surfacePrompt("same surface later", "slack", "chat-a"));
      const session = makeStreamingSession({
        turnActive: true,
        currentSource: active.launchPrompt?.source,
        pendingMessages: [active, otherSurface, sameSurface],
        currentTurnPendingIds: [active.pendingId!],
      });

      expect(prepareRuntimeInterruptSuccessor("dev", session)).toBeNull();
      expect(session.pendingMessages).toEqual([active, otherSurface, sameSurface]);
    });
  }

  it("marks only the active delivery as ambiguous when stashing inactivity recovery", () => {
    const active = createQueuedRuntimeUserMessage({ prompt: "active" });
    const later = createQueuedRuntimeUserMessage({ prompt: "later" });
    const session = makeStreamingSession({
      pendingMessages: [active, later],
      currentTurnPendingIds: [active.pendingId!],
    });
    const stash = new Map<string, RuntimeUserMessage[]>();

    stashPendingRuntimeMessages("dev", session, stash, { reconcileCurrentTurn: true });

    expect(stash.get("dev")?.map((message) => message.replay)).toEqual([true, undefined]);
    expect(stash.get("dev")?.[0]?.terminalReplayAllowed).toBe(true);
  });

  it("stashes only the successor when an interrupted turn was intentionally superseded", () => {
    const active = createQueuedRuntimeUserMessage(channelPrompt("old work", "turn-a"));
    const steering = createQueuedRuntimeUserMessage(channelPrompt("new direction", "turn-b"));
    const session = makeStreamingSession({
      pendingMessages: [active, steering],
      currentTurnPendingIds: [active.pendingId!],
      currentTurnSuperseded: true,
    });
    const pendingStash = new Map();
    const currentTurnStash = new Map();

    stashPendingRuntimeMessages("dev", session, pendingStash);
    expect(pendingStash.get("dev")).toEqual([steering]);
    expect(stashCurrentTurnRuntimeMessages("dev", session, currentTurnStash)).toBe(1);
    expect(currentTurnStash.get("dev")).toEqual([steering]);
  });

  it("does not replay a provider-native current turn before its asynchronous tool event can arrive", () => {
    const active = createQueuedRuntimeUserMessage(channelPrompt("may already have run a tool", "turn-a"));
    const successor = createQueuedRuntimeUserMessage(channelPrompt("independent successor", "turn-b"));
    const session = makeStreamingSession({
      pendingMessages: [active, successor],
      currentTraceTurnId: "turn-provider-native",
      currentCrashRecoveryAttemptId: "attempt-provider-native",
      currentTurnPendingIds: [active.pendingId!],
      toolEffectFence: "provider_event_only",
    });
    const crashRecovery = {
      acceptingDeliveries: true,
      getActiveTurnAttempt: () => ({ startedTool: false, materializedOutput: false }),
    } as unknown as RuntimeCrashRecoveryCoordinator;
    const stash = new Map<string, RuntimeUserMessage[]>();

    expect(stashPendingRuntimeMessages("dev", session, stash, { crashRecovery })).toBe(1);
    expect(stash.get("dev")).toEqual([successor]);

    const reconciliationStash = new Map<string, RuntimeUserMessage[]>();
    expect(
      stashPendingRuntimeMessages("dev", session, reconciliationStash, {
        crashRecovery,
        reconcileCurrentTurn: true,
      }),
    ).toBe(2);
    expect(reconciliationStash.get("dev")?.[0]).toMatchObject({
      replay: true,
      terminalReplayAllowed: false,
    });
    expect(reconciliationStash.get("dev")?.[1]?.replay).toBeUndefined();
  });

  it("never replays a completed physical turn while preserving its independent successors", () => {
    const active = createQueuedRuntimeUserMessage(channelPrompt("already complete", "turn-a"));
    const successor = createQueuedRuntimeUserMessage(channelPrompt("independent successor", "turn-b"));
    const session = makeStreamingSession({
      pendingMessages: [active, successor],
      currentTurnPendingIds: [active.pendingId!],
      currentCrashRecoveryTerminal: {
        status: "complete",
        completedAt: Date.now(),
        startedTool: false,
        materializedOutput: false,
      },
      toolEffectFence: "host_write_ahead",
    });
    const beforeDrain = new Map<string, RuntimeUserMessage[]>();

    expect(stashPendingRuntimeMessages("dev", session, beforeDrain)).toBe(1);
    expect(beforeDrain.get("dev")).toEqual([successor]);

    session.pendingMessages = [successor];
    session.currentTurnPendingIds = undefined;
    const afterDrain = new Map<string, RuntimeUserMessage[]>();

    expect(stashPendingRuntimeMessages("dev", session, afterDrain)).toBe(1);
    expect(afterDrain.get("dev")).toEqual([successor]);
  });

  it("delivers at most one channel backend message in a local runtime turn", () => {
    const first = createQueuedRuntimeUserMessage(channelPrompt("first", "turn-a"));
    const second = createQueuedRuntimeUserMessage(channelPrompt("second", "turn-b"));
    const session = makeStreamingSession({
      pendingMessages: [first, second],
    });

    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([first]);
  });

  it("preserves normal message batching boundaries around channel backend turns", () => {
    const normalBefore = createQueuedRuntimeUserMessage({ prompt: "normal before" });
    const backend = createQueuedRuntimeUserMessage(channelPrompt("backend", "turn-a"));
    const normalAfter = createQueuedRuntimeUserMessage({ prompt: "normal after" });
    const session = makeStreamingSession({
      pendingMessages: [normalBefore, backend, normalAfter],
    });

    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([normalBefore]);

    session.pendingMessages.shift();
    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([backend]);

    session.pendingMessages.shift();
    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([normalAfter]);
  });

  it("isolates typed internal origins from surrounding external messages", () => {
    const externalBefore = createQueuedRuntimeUserMessage({ prompt: "external before" });
    const internal = createQueuedRuntimeUserMessage({
      prompt: "internal",
      _turnOrigin: buildSessionRelayTurnOrigin("inform", {
        agentId: "origin-agent",
        sessionKey: "agent:origin-agent:main",
      }),
    });
    const externalAfter = createQueuedRuntimeUserMessage({ prompt: "external after" });
    const session = makeStreamingSession({
      pendingMessages: [externalBefore, internal, externalAfter],
    });

    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([externalBefore]);

    session.pendingMessages.shift();
    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([internal]);

    session.pendingMessages.shift();
    expect(getDeliverableRuntimeMessages("dev", session)).toEqual([externalAfter]);
  });
});

function progressPrompt(prompt: string, index: number) {
  const source = channelPrompt("", "unused").source;
  return {
    prompt,
    deliveryBarrier: "after_tool" as const,
    source: {
      ...source,
      actorType: "system",
      contactId: undefined,
      normalizedSenderId: undefined,
      sourceMessageId: "report-thread",
      suppressPresence: true,
    },
    _turnOrigin: buildChannelTurnOrigin("session.return", { type: "agent", id: "worker" }, "producer-context"),
    _slackThreadLifecycle: {
      eventType: "thread.report",
      eventId: `report-${index}`,
      requestId: "request-a",
      parentSessionKey: "parent",
      childSessionKey: "child",
      childSessionName: "child",
      providerThreadId: "thread-a",
    },
  };
}

function channelPrompt(prompt: string, turnId: string, senderId = "user-a", threadId?: string) {
  return {
    prompt,
    deliveryBarrier: "after_tool" as const,
    source: {
      channel: "custom",
      accountId: "connection-a",
      instanceId: "channel-instance-a",
      chatId: "conversation-a",
      ...(threadId ? { threadId } : {}),
      canonicalChatId: "chat-a",
      actorType: "contact" as const,
      contactId: senderId,
      normalizedSenderId: senderId,
      sourceMessageId: `message-${turnId}`,
    },
    context: {
      channelId: "custom",
      channelName: "Custom",
      accountId: "connection-a",
      instanceId: "channel-instance-a",
      chatId: "conversation-a",
      canonicalChatId: "chat-a",
      messageId: `message-${turnId}`,
      senderId,
      isGroup: true,
      timestamp: 1,
      actorType: "contact" as const,
      contactId: senderId,
      normalizedSenderId: senderId,
    },
    _agentId: "agent-a",
    _channelBackend: {
      protocol: "ravi.channel.backend" as const,
      schemaVersion: 1 as const,
      ingressRequestId: `request-${turnId}`,
      correlationId: `correlation-${turnId}`,
      binding: {
        channelInstanceId: "channel-instance-a",
        agentId: "agent-a",
        chatId: "chat-a",
        messageId: `message-${turnId}`,
        sessionId: "session-a",
        turnId,
      },
      target: {
        channelKind: "custom",
        connectionId: "connection-a",
        conversationId: "conversation-a",
      },
    },
  };
}

function surfacePrompt(prompt: string, channel: string, canonicalChatId: string, threadId?: string) {
  return {
    prompt,
    deliveryBarrier: "after_tool" as const,
    source: {
      channel,
      accountId: `${channel}-account`,
      instanceId: `${channel}-instance`,
      chatId: canonicalChatId,
      canonicalChatId,
      ...(threadId ? { threadId } : {}),
    },
  };
}
