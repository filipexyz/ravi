import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDb } from "../router/router-db.js";
import { recordRuntimeSafetyTraceEvent, recordRuntimeTraceEvent } from "../session-trace/runtime-trace.js";
import { listPendingRuntimeTargetResponseEvents } from "../session-trace/session-trace-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createRuntimeTargetResponseEmitId, readRuntimeTargetResponseOutbox } from "./target-response-outbox.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-target-response-outbox-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("runtime target response outbox", () => {
  it("keeps a committed response replayable with at-least-once semantics until delivery is acknowledged", () => {
    const logicalTurnId = "turn-crash-window";
    const emitId = createRuntimeTargetResponseEmitId(logicalTurnId);
    expect(createRuntimeTargetResponseEmitId(logicalTurnId)).toBe(emitId);

    recordRuntimeSafetyTraceEvent({
      sessionKey: "agent:dev:outbox",
      sessionName: "outbox",
      agentId: "dev",
      runId: "run-outbox",
      turnId: logicalTurnId,
      eventType: "runtime.target.succeeded",
      eventGroup: "runtime_target",
      status: "complete",
      messageId: emitId,
      payloadJson: {
        responseOutbox: {
          emitId,
          response: "committed response",
          target: {
            channel: "whatsapp",
            accountId: "main",
            chatId: "safe-smoke-chat",
          },
          metadata: { provider: "codex" },
          instanceId: "whatsapp",
          version: 2,
        },
      },
    });

    const pending = listPendingRuntimeTargetResponseEvents();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.messageId).toBe(emitId);
    const firstDelivery = readRuntimeTargetResponseOutbox(pending[0]!);
    expect(firstDelivery).toMatchObject({
      sessionName: "outbox",
      instanceId: "whatsapp",
      response: {
        response: "committed response",
        target: {
          channel: "whatsapp",
          accountId: "main",
          chatId: "safe-smoke-chat",
        },
        metadata: { provider: "codex" },
        _emitId: emitId,
      },
    });
    expect((firstDelivery?.response as { _v?: number } | undefined)?._v).toBe(2);

    // Simulate a crash after the external provider accepted the first delivery
    // but before Ravi persisted the dispatch acknowledgement. Restart reads the
    // same committed event again; physical delivery is deliberately at-least-once.
    const replayAfterCrash = readRuntimeTargetResponseOutbox(listPendingRuntimeTargetResponseEvents()[0]!);
    expect(replayAfterCrash).toEqual(firstDelivery);

    recordRuntimeSafetyTraceEvent({
      sessionKey: "agent:dev:outbox",
      sessionName: "outbox",
      agentId: "dev",
      runId: "run-outbox",
      turnId: logicalTurnId,
      eventType: "runtime.target.response_dispatched",
      eventGroup: "runtime_target",
      status: "complete",
      messageId: emitId,
      payloadJson: { emitId },
    });

    expect(listPendingRuntimeTargetResponseEvents()).toEqual([]);
  });

  it("propagates journal failures for safety transitions while observability stays best-effort", () => {
    getDb().exec("DROP TABLE session_events");
    const event = {
      sessionKey: "agent:dev:journal-failure",
      sessionName: "journal-failure",
      eventType: "runtime.target.switching",
      eventGroup: "runtime_target",
      status: "started",
    } as const;

    expect(() => recordRuntimeSafetyTraceEvent(event)).toThrow();
    expect(() => recordRuntimeTraceEvent(event)).not.toThrow();
  });
});
