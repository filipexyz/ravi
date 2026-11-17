import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as routerDb from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  getSlackAutomaticTerminalManifest,
  prepareSlackAutomaticTerminalManifest,
} from "./slack/automatic-terminal-manifest.js";
import {
  recordTerminalProjectionWithRecovery,
  TerminalProjectionRecoveryError,
  type TerminalProjectionRecoveryState,
} from "./terminal-projection-recovery.js";

type RecordInput = Parameters<typeof routerDb.dbRecordChannelBackendRuntimeEvent>[0];
const originalRecord = routerDb.dbRecordChannelBackendRuntimeEvent;
const originalReadRuntime = routerDb.dbGetChannelBackendRuntimeState;
const restoreSpies: Array<() => void> = [];
let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-terminal-projection-recovery-");
  routerDb.dbCreateAgent({ id: "agent-recovery", cwd: "/tmp/ravi-terminal-recovery-agent" });
});

afterEach(async () => {
  for (const restore of restoreSpies.splice(0).reverse()) restore();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("terminal projection persistence recovery", () => {
  it("acknowledges the committed terminal synchronously, once, with the post-bootstrap sequence", async () => {
    const input = terminalInput();
    const record = observeRecorder(originalRecord);
    const onCommitted = mock(() => {
      expect(routerDb.getDb().inTransaction).toBe(false);
      expect(getSlackAutomaticTerminalManifest(input.slackTerminalManifest!.responseId)).toEqual(
        input.slackTerminalManifest!,
      );
    });
    const work = recordTerminalProjectionWithRecovery(input, { mayRecover: () => true, onCommitted });
    expect(onCommitted).toHaveBeenCalledTimes(1);
    const result = await work;
    expect(record).toHaveBeenCalledTimes(1);
    expect(result.runtime).toMatchObject({ state: "completed", lastSequence: 2, lastDeltaSequence: 0 });
    expect(terminalCounts()).toEqual({ assistants: 1, manifests: 1 });
  });

  it("preserves the original initial-write fence when strict recovery is unavailable", async () => {
    const input = terminalInput();
    const onCommitted = mock(() => {});
    const result = await recordTerminalProjectionWithRecovery(
      { ...input, mayWrite: () => true },
      {
        mayRecover: () => false,
        onCommitted,
      },
    );
    expect(result.runtime.state).toBe("completed");
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it("propagates the callback's exact error without retrying a committed transaction", async () => {
    const input = terminalInput();
    const callbackError = new Error("post-commit callback failed");
    const record = observeRecorder(originalRecord);
    const onCommitted = mock(() => {
      throw callbackError;
    });
    const work = recordTerminalProjectionWithRecovery(input, {
      mayRecover: () => true,
      onCommitted,
      onState: () => {
        throw new Error("diagnostic failed");
      },
    });
    expect(onCommitted).toHaveBeenCalledTimes(1);
    await expect(work).rejects.toBe(callbackError);
    expect(record).toHaveBeenCalledTimes(1);
    expect(routerDb.dbGetChannelBackendRuntimeState(input.turnId)?.lastSequence).toBe(2);
    expect(terminalCounts()).toEqual({ assistants: 1, manifests: 1 });
  });

  it("confirms an actual commit followed by an exception without another write or callback", async () => {
    const input = terminalInput();
    const record = observeRecorder((operation) => {
      originalRecord(operation);
      throw new Error("exception after actual commit");
    });
    const onCommitted = mock(() => {});
    const work = recordTerminalProjectionWithRecovery(input, { mayRecover: () => true, onCommitted });
    expect(onCommitted).toHaveBeenCalledTimes(1);
    const result = await work;
    expect(result.runtime.lastSequence).toBe(2);
    expect(result.slackTerminalManifest).toEqual(input.slackTerminalManifest!);
    expect(record).toHaveBeenCalledTimes(1);
    expect(terminalCounts()).toEqual({ assistants: 1, manifests: 1 });
  });

  it("settles a positively confirmed commit after owner loss without scheduling fresh work", async () => {
    const input = terminalInput();
    let owns = true;
    const states: TerminalProjectionRecoveryState[] = [];
    const record = observeRecorder((operation) => {
      originalRecord(operation);
      owns = false;
      throw new Error("exception after commit and retirement");
    });
    const onCommitted = mock(() => {});
    const work = recordTerminalProjectionWithRecovery(input, {
      mayRecover: () => owns,
      onCommitted,
      onState: (state) => states.push(state),
    });
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect((await work).runtime.state).toBe("completed");
    expect(record).toHaveBeenCalledTimes(1);
    expect(states.map((state) => state.status)).toEqual(["recorded"]);
  });

  it("retries a finished typed lock refusal once with frozen content, time and manifest", async () => {
    const input = terminalInput();
    const expected = structuredClone(input);
    const failure = busyError();
    let calls = 0;
    const record = observeRecorder((operation) => {
      if (++calls === 1) throw failure;
      return originalRecord(operation);
    });
    const onCommitted = mock(() => {});
    const result = await recordTerminalProjectionWithRecovery(input, {
      mayRecover: () => true,
      onCommitted,
      onState: (state) => {
        if (state.status !== "retry_scheduled") return;
        input.assistantText = "mutated after the refusal";
        input.occurredAt = input.occurredAt! + 10_000;
        input.slackTerminalManifest!.textFingerprint = "mutated-fingerprint";
      },
    });
    expect(record).toHaveBeenCalledTimes(2);
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(result.runtime.updatedAt).toBe(expected.occurredAt!);
    expect(result.slackTerminalManifest).toEqual(expected.slackTerminalManifest);
    expect(routerDb.dbGetChatMessage(result.runtime.assistantMessageId!)?.content).toEqual({
      blocks: [{ type: "text", text: expected.assistantText }],
    });
    expect(terminalCounts()).toEqual({ assistants: 1, manifests: 1 });
  });

  it("stops at two recorder calls and retains the typed failure when lock refusal persists", async () => {
    const input = terminalInput();
    const failure = busyError();
    const record = observeRecorder(() => {
      throw failure;
    });
    const onCommitted = mock(() => {});
    const error = await rejectedRecovery(
      recordTerminalProjectionWithRecovery(input, {
        mayRecover: () => true,
        onCommitted,
        onState: () => {
          throw new Error("diagnostic failure must not mask lock refusal");
        },
      }),
    );
    expect(error.cause).toBe(failure);
    expect(error.outcome).toMatchObject({
      status: "retry_exhausted",
      round: 2,
      maxRounds: 2,
      errorCode: "SQLITE_BUSY",
    });
    expect(record).toHaveBeenCalledTimes(2);
    expect(onCommitted).not.toHaveBeenCalled();
    expect(routerDb.dbGetChannelBackendRuntimeState(input.turnId)).toMatchObject({ state: "running", lastSequence: 1 });
    expect(terminalCounts()).toEqual({ assistants: 0, manifests: 0 });
  });

  it("stops before an additional call when the owner is lost during the timer", async () => {
    const input = terminalInput();
    let owns = true;
    const failure = busyError();
    const record = observeRecorder(() => {
      throw failure;
    });
    const onCommitted = mock(() => {});
    const error = await rejectedRecovery(
      recordTerminalProjectionWithRecovery(input, {
        mayRecover: () => owns,
        onCommitted,
        onState: (state) => {
          if (state.status === "retry_scheduled")
            queueMicrotask(() => {
              owns = false;
            });
        },
      }),
    );
    expect(error.outcome.status).toBe("owner_lost");
    expect(error.cause).toBe(failure);
    expect(record).toHaveBeenCalledTimes(1);
    expect(onCommitted).not.toHaveBeenCalled();
    expect(terminalCounts()).toEqual({ assistants: 0, manifests: 0 });
  });

  it("revalidates the sequence and delta witness after the timer before another write", async () => {
    const input = terminalInput();
    const failure = busyError();
    const record = observeRecorder(() => {
      throw failure;
    });
    const error = await rejectedRecovery(
      recordTerminalProjectionWithRecovery(input, {
        mayRecover: () => true,
        onState: (state) => {
          if (state.status !== "retry_scheduled") return;
          queueMicrotask(() =>
            originalRecord({
              turnId: input.turnId,
              runtimeGenerationId: input.runtimeGenerationId,
              assistantDelta: true,
              occurredAt: input.occurredAt! - 1,
            }),
          );
        },
      }),
    );
    expect(error.outcome).toMatchObject({ status: "non_retryable", errorCode: "TERMINAL_WITNESS_CONFLICT" });
    expect(record).toHaveBeenCalledTimes(1);
    expect(routerDb.dbGetChannelBackendRuntimeState(input.turnId)).toMatchObject({
      state: "running",
      lastSequence: 2,
      lastDeltaSequence: 1,
    });
    expect(terminalCounts()).toEqual({ assistants: 0, manifests: 0 });
  });

  it("uses readback-only recovery after an unknown read and never retries the write on later absence", async () => {
    const input = terminalInput();
    const failure = busyError();
    const record = observeRecorder(() => {
      throw failure;
    });
    let reads = 0;
    const read = spyOn(routerDb, "dbGetChannelBackendRuntimeState").mockImplementation((turnId) => {
      if (++reads === 2) throw new Error("readback unavailable");
      return originalReadRuntime(turnId);
    });
    restoreSpies.push(() => read.mockRestore());
    const error = await rejectedRecovery(recordTerminalProjectionWithRecovery(input, { mayRecover: () => true }));
    expect(error.outcome.status).toBe("outcome_unknown");
    expect(error.cause).toBe(failure);
    expect(record).toHaveBeenCalledTimes(1);
    expect(reads).toBe(3);
    expect(terminalCounts()).toEqual({ assistants: 0, manifests: 0 });
  });

  it("refuses a deterministic manifest conflict without a timer, terminal or callback", async () => {
    const input = terminalInput();
    input.slackTerminalManifest!.sourceId = "different-source";
    const record = observeRecorder(originalRecord);
    const onCommitted = mock(() => {});
    const states: TerminalProjectionRecoveryState[] = [];
    const error = await rejectedRecovery(
      recordTerminalProjectionWithRecovery(input, {
        mayRecover: () => true,
        onCommitted,
        onState: (state) => states.push(state),
      }),
    );
    expect(error.outcome.status).toBe("non_retryable");
    expect(record).toHaveBeenCalledTimes(1);
    expect(onCommitted).not.toHaveBeenCalled();
    expect(states.some((state) => state.status === "retry_scheduled")).toBe(false);
    expect(terminalCounts()).toEqual({ assistants: 0, manifests: 0 });
  });

  it("never adopts a terminal already present before this invocation", async () => {
    const input = terminalInput();
    originalRecord(input);
    const record = observeRecorder(originalRecord);
    const onCommitted = mock(() => {});
    const error = await rejectedRecovery(
      recordTerminalProjectionWithRecovery(input, { mayRecover: () => true, onCommitted }),
    );
    expect(error.outcome).toMatchObject({ status: "non_retryable", errorCode: "ALREADY_TERMINAL" });
    expect(record).not.toHaveBeenCalled();
    expect(onCommitted).not.toHaveBeenCalled();
    expect(routerDb.dbGetChannelBackendRuntimeState(input.turnId)?.lastSequence).toBe(2);
  });

  it("does not classify unknown numeric SQLite extensions or arbitrary busy text as transient", async () => {
    const input = terminalInput();
    const failure = Object.assign(new Error("busy in an unrelated operation"), { errno: 1029 });
    const record = observeRecorder(() => {
      throw failure;
    });
    const error = await rejectedRecovery(recordTerminalProjectionWithRecovery(input, { mayRecover: () => true }));
    expect(error.outcome.status).toBe("non_retryable");
    expect(error.cause).toBe(failure);
    expect(record).toHaveBeenCalledTimes(1);
  });
});

/** Build accepted ingress followed by the same running bootstrap the projector performs before terminal capture. */
function terminalInput(): RecordInput {
  const acceptedAt = Date.parse("2026-07-24T18:00:00.000Z");
  const ingress = routerDb.dbAcceptChannelBackendIngress({
    channelInstanceId: "terminal-recovery-instance",
    idempotencyKey: "terminal-recovery-ingress",
    requestFingerprint: "terminal-recovery-request",
    requestId: "terminal-recovery-request",
    localActorId: "terminal-recovery-actor",
    agentId: "agent-recovery",
    clientMessageId: "terminal-recovery-client-message",
    sessionKey: "agent-recovery:terminal-recovery-session",
    sessionName: "terminal-recovery-session",
    turnId: "terminal-recovery-turn",
    external: {
      channelKind: "custom",
      connectionId: "terminal-recovery-connection",
      conversationId: "terminal-recovery-conversation",
      senderId: "terminal-recovery-sender",
      messageId: "terminal-recovery-source",
    },
    content: { blocks: [{ type: "text", text: "fixture input" }] },
    receivedAt: acceptedAt,
    acceptedAt,
  });
  const receipt = ingress.receipt;
  originalRecord({
    turnId: receipt.turnId,
    state: "running",
    runtimeGenerationId: "generation-recovery",
    occurredAt: acceptedAt + 1_000,
  });
  const text = "Complete terminal\nwith every line";
  return {
    turnId: receipt.turnId,
    state: "completed",
    assistantText: text,
    runtimeGenerationId: "generation-recovery",
    occurredAt: acceptedAt + 2_000,
    slackTerminalManifest: prepareSlackAutomaticTerminalManifest({
      turnId: receipt.turnId,
      sourceId: receipt.messageId,
      sourceReceivedAt: receipt.acceptedAt,
      scope: "fixture-installation:C123",
      target: {
        channel: "slack",
        accountId: "fixture-slack",
        instanceId: "fixture-slack",
        chatId: "C123",
        canonicalChatId: receipt.chatId,
      },
      kind: "final_answer",
      text,
      media: [],
    }),
  };
}

/** Observe logical recorder calls without replacing the recorder's transaction or retry policy on successful calls. */
function observeRecorder(implementation: typeof originalRecord) {
  const spy = spyOn(routerDb, "dbRecordChannelBackendRuntimeEvent").mockImplementation(implementation);
  restoreSpies.push(() => spy.mockRestore());
  return spy;
}

/** A finished typed refusal of the logical recorder, distinct from a real SQLite contention oracle. */
function busyError(): Error & { code: string; errno: number } {
  return Object.assign(new Error("typed recorder lock refusal"), { code: "SQLITE_BUSY", errno: 5 });
}

/** Require a classified recovery error without accepting callback or fixture failures as a passing rejection. */
async function rejectedRecovery(work: Promise<unknown>): Promise<TerminalProjectionRecoveryError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(TerminalProjectionRecoveryError);
    return error as TerminalProjectionRecoveryError;
  }
  throw new Error("Expected terminal persistence refusal");
}

/** Count durable assistant and manifest rows to detect duplicate projection or partially accepted recovery. */
function terminalCounts(): { assistants: number; manifests: number } {
  const database = routerDb.getDb();
  const assistants = database
    .prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE actor_type = 'agent'")
    .get() as { count: number };
  const manifests = database.prepare("SELECT COUNT(*) AS count FROM slack_automatic_terminal_manifests").get() as {
    count: number;
  };
  return { assistants: assistants.count, manifests: manifests.count };
}
