import { describe, expect, it, mock, spyOn } from "bun:test";
import { CHANNEL_OUTBOUND_PUBLISH_RETENTION_MS, type ChannelOutboundPublishResult } from "./outbound-publish-outbox.js";
import { CHANNEL_OUTBOUND_RECEIPT_RETENTION_MS } from "./outbound-receipts.js";
import {
  CHANNEL_OUTBOUND_RECEIPT_PRUNE_INTERVAL_MS,
  collectNativeRuntimeDeliveries,
  pruneChannelOutboundPublishOutbox,
  pruneChannelOutboundReceiptLedger,
  runChannelOutboundLedgerMaintenance,
  slackAdapterHealth,
  startChannelRunnerBackendEgressResponder,
  startChannelRunnerInboundActionResponder,
  startChannelOutboundReceiptPruner,
} from "./runner.js";
import type { ChannelBackendEgressResponder, ChannelBackendEgressResponderConnection } from "./backend-egress.js";
import type { ChannelOutputSink } from "./backend.js";
import type {
  NativeInboundChannelActionResponder,
  NativeInboundChannelActionResponderConnection,
} from "./inbound-actions.js";
import type { NativeInboundChannelActionHandler } from "./native/driver.js";
import type { ChannelRuntimeEventSink } from "./runtime-events.js";
import { createSlackNativeChannelDriver } from "./slack/driver.js";
import type { ChannelOutboundJob } from "./outbound-stream.js";

describe("channel runner native delivery registry", () => {
  it("registers optional text, chat action, and presence adapters together", () => {
    const delivery = {
      channelId: "slack",
      supports: () => true,
      deliverText: mock(async () => ({ provider: "slack" })),
    };
    const actions = {
      channelId: "slack",
      supports: () => true,
      executeChatAction: mock(async () => ({ provider: "slack" })),
    };
    const presence = {
      channelId: "slack",
      supports: () => true,
      sendPresence: mock(async () => ({ provider: "slack", status: "active" as const })),
    };

    expect(
      collectNativeRuntimeDeliveries([
        {
          delivery,
          actions,
          presence,
        },
      ]),
    ).toEqual({
      deliveries: [delivery],
      actionDeliveries: [actions],
      presenceDeliveries: [presence],
    });
  });

  it("runs Slack through the same versioned driver lifecycle", async () => {
    const start = mock(() => {});
    const stop = mock(async () => {});
    const status = mock(() => ({
      state: "connecting" as const,
      reconnectCount: 0,
      reason: "opening_socket" as const,
    }));
    const delivery = {
      channelId: "slack",
      supports: () => true,
      deliverText: mock(async () => ({ provider: "slack" })),
    };
    const actions = {
      channelId: "slack",
      supports: () => true,
      executeChatAction: mock(async () => ({ provider: "slack" })),
    };
    const presence = {
      channelId: "slack",
      supports: () => true,
      sendPresence: mock(async () => ({ provider: "slack", status: "active" as const })),
    };
    let publishAttempt = 0;
    const resolveCanonicalMessageId = mock(() => "message-assistant-a");
    const publishOutbound = mock(async (job: ChannelOutboundJob): Promise<ChannelOutboundPublishResult | undefined> => {
      publishAttempt++;
      if (publishAttempt !== 1) return undefined;
      return {
        ok: false,
        record: {
          idempotencyKey: job.request.idempotencyKey,
          requestFingerprint: "test-fingerprint",
          jobId: job.jobId,
          sessionName: job.request.origin.sessionName,
          channelId: job.request.channelId,
          status: "pending",
          job,
          attemptCount: 1,
          nextAttemptAt: 1_782_920_030_000,
          lastErrorMessage: "JetStream unavailable",
          lastErrorAt: 1_782_920_000_000,
          createdAt: 1_782_920_000_000,
          updatedAt: 1_782_920_000_000,
        },
        error: new Error("JetStream unavailable"),
        nextAttemptAt: 1_782_920_030_000,
      };
    });
    const driver = createSlackNativeChannelDriver(
      {},
      {
        createRuntime: mock(async () => ({
          id: "slack-a",
          accountId: "slack-a",
          instanceId: "slack-a",
          connection: "connection-a",
          delivery,
          actions,
          presence,
          socketMode: { start, stop, status } as never,
        })),
        publishOutbound,
        resolveCanonicalMessageId,
        now: () => 1_782_920_000_000,
      },
    );
    let outputSink: ChannelOutputSink | undefined;
    let runtimeEventSink: ChannelRuntimeEventSink | undefined;
    const unregisterOutputSink = mock(() => {});
    const unregisterRuntimeEventSink = mock(() => {});
    const runtime = await driver.createRuntime({
      channel: {
        name: "slack-a",
        provider: "slack",
        credentialConnection: "connection-a",
      },
      host: {
        registerOutputSink: mock((_target, sink: ChannelOutputSink) => {
          outputSink = sink;
          return unregisterOutputSink;
        }),
        registerRuntimeEventSink: mock((_target, sink: ChannelRuntimeEventSink) => {
          runtimeEventSink = sink;
          return unregisterRuntimeEventSink;
        }),
      } as never,
    });

    expect(driver.descriptor).toMatchObject({
      protocol: "ravi.channel.native-driver",
      schemaVersion: 1,
      provider: "slack",
    });
    expect(runtime.descriptor).toMatchObject({
      provider: "slack",
      runtimeId: "slack-a",
      channelInstanceId: "slack-a",
    });
    expect(runtime.delivery).toBe(delivery);
    expect(runtime.actions).toBe(actions);
    expect(runtime.presence).toBe(presence);
    expect(outputSink).toBeDefined();
    expect(runtimeEventSink).toBeDefined();
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    let deferredPublishWarning = "";
    try {
      await outputSink!.emit({
        protocol: "ravi.channel.backend",
        schemaVersion: 1,
        outputId: "output-a",
        correlationId: "correlation-a",
        binding: {
          channelInstanceId: "slack-a",
          agentId: "agent-a",
          chatId: "chat-a",
          messageId: "message-a",
          sessionId: "session-a",
          turnId: "turn-a",
        },
        target: {
          channelKind: "slack",
          connectionId: "slack-a",
          conversationId: "C123~1713000000.000100",
        },
        kind: "assistant_message",
        content: [{ type: "text", text: "done" }],
        emittedAt: "2026-07-29T12:00:00.000Z",
      });
      deferredPublishWarning = stderrSpy.mock.calls.map(([line]) => String(line)).join("");
    } finally {
      stderrSpy.mockRestore();
    }
    expect(deferredPublishWarning).toContain("Slack outbound publish deferred; durable retry remains pending");
    expect(deferredPublishWarning).toContain("jobId=channel-output:output-a");
    expect(deferredPublishWarning).toContain("nextAttemptAt=1782920030000");
    expect(resolveCanonicalMessageId).toHaveBeenCalledWith(
      expect.objectContaining({
        outputId: "output-a",
        binding: expect.objectContaining({ turnId: "turn-a" }),
      }),
    );
    expect(publishOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "channel-output:output-a",
        createdAt: 1_782_920_000_000,
        request: expect.objectContaining({
          idempotencyKey: "output-a",
          origin: expect.objectContaining({
            sessionName: "session-a",
            emitId: "output-a",
            responsePhase: "final_answer",
            canonicalMessageId: "message-assistant-a",
          }),
          content: {
            type: "text",
            text: "done",
          },
          target: expect.objectContaining({
            chatId: "C123",
            threadId: "1713000000.000100",
            canonicalChatId: "chat-a",
          }),
        }),
      }),
    );
    await runtimeEventSink!.emit(
      {
        protocol: "ravi.channel.runtime-events",
        schemaVersion: 1,
        eventId: "event-commentary-a",
        kind: "turn.assistant_message",
        occurredAt: "2026-07-29T12:00:01.000Z",
        sequence: 2,
        correlation: {
          correlationId: "correlation-a",
          ingressRequestId: "ingress-a",
          binding: {
            channelInstanceId: "slack-a",
            agentId: "agent-a",
            chatId: "chat-a",
            messageId: "message-a",
            sessionId: "session-a",
            turnId: "turn-a",
          },
        },
        payload: {
          phase: "commentary",
          content: [{ type: "text", text: "Checking the current state." }],
        },
      },
      {
        channelKind: "slack",
        connectionId: "slack-a",
        conversationId: "C123~1713000000.000100",
      },
    );
    expect(publishOutbound).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        jobId: "channel-runtime:event-commentary-a",
        request: expect.objectContaining({
          idempotencyKey: "event-commentary-a",
          origin: expect.objectContaining({
            sessionName: "session-a",
            emitId: "event-commentary-a",
            responsePhase: "commentary",
          }),
          content: {
            type: "text",
            text: "Checking the current state.",
          },
          target: expect.objectContaining({
            chatId: "C123",
            threadId: "1713000000.000100",
            canonicalChatId: "chat-a",
          }),
        }),
      }),
    );
    await runtimeEventSink!.emit(
      {
        protocol: "ravi.channel.runtime-events",
        schemaVersion: 1,
        eventId: "event-final-a",
        kind: "turn.assistant_message",
        occurredAt: "2026-07-29T12:00:02.000Z",
        sequence: 3,
        correlation: {
          correlationId: "correlation-a",
          ingressRequestId: "ingress-a",
          binding: {
            channelInstanceId: "slack-a",
            agentId: "agent-a",
            chatId: "chat-a",
            messageId: "message-a",
            sessionId: "session-a",
            turnId: "turn-a",
          },
        },
        payload: {
          phase: "final_answer",
          content: [{ type: "text", text: "done" }],
        },
      },
      {
        channelKind: "slack",
        connectionId: "slack-a",
        conversationId: "C123~1713000000.000100",
      },
    );
    expect(publishOutbound).toHaveBeenCalledTimes(2);
    resolveCanonicalMessageId.mockImplementationOnce((() => undefined) as never);
    await expect(
      outputSink!.emit({
        protocol: "ravi.channel.backend",
        schemaVersion: 1,
        outputId: "output-missing-canonical",
        correlationId: "correlation-missing-canonical",
        binding: {
          channelInstanceId: "slack-a",
          agentId: "agent-a",
          chatId: "chat-a",
          messageId: "message-a",
          sessionId: "session-a",
          turnId: "turn-missing-canonical",
        },
        target: {
          channelKind: "slack",
          connectionId: "slack-a",
          conversationId: "C123~1713000000.000100",
        },
        kind: "assistant_message",
        content: [{ type: "text", text: "must not publish" }],
        emittedAt: "2026-07-29T12:00:03.000Z",
      }),
    ).rejects.toThrow("runtime_surface_mismatch");
    expect(publishOutbound).toHaveBeenCalledTimes(2);
    expect(delivery.deliverText).not.toHaveBeenCalled();
    await runtime.start();
    expect(start).toHaveBeenCalledTimes(1);
    expect(runtime.health()).toMatchObject({
      status: "starting",
      reason: "opening_socket",
      reconnectCount: 0,
    });
    await runtime.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(unregisterOutputSink).toHaveBeenCalledTimes(1);
    expect(unregisterRuntimeEventSink).toHaveBeenCalledTimes(1);
  });
  it("starts one inbound action responder only when a native runtime exposes handlers", () => {
    const connection = {} as NativeInboundChannelActionResponderConnection;
    const handler = {
      supports: (action: string) => action === "connect",
      handle: mock(async () => {
        throw new Error("not invoked by runner registration");
      }),
    } satisfies NativeInboundChannelActionHandler;
    const responder = {
      stop: mock(async () => {}),
    } satisfies NativeInboundChannelActionResponder;
    const startResponder = mock(() => responder);

    expect(
      startChannelRunnerInboundActionResponder({
        connection,
        handlers: [],
        startResponder,
      }),
    ).toBeNull();
    expect(startResponder).not.toHaveBeenCalled();

    expect(
      startChannelRunnerInboundActionResponder({
        connection,
        handlers: [handler],
        startResponder,
      }),
    ).toBe(responder);
    expect(startResponder).toHaveBeenCalledTimes(1);
    expect(startResponder).toHaveBeenCalledWith({
      connection,
      handlers: [handler],
    });
  });

  it("registers one cross-process backend egress responder with the runner connection", () => {
    const connection = {} as ChannelBackendEgressResponderConnection;
    const responder = {
      stop: mock(async () => {}),
    } satisfies ChannelBackendEgressResponder;
    const startResponder = mock(() => responder);

    expect(
      startChannelRunnerBackendEgressResponder({
        connection,
        startResponder,
      }),
    ).toBe(responder);
    expect(startResponder).toHaveBeenCalledTimes(1);
    expect(startResponder).toHaveBeenCalledWith({ connection });
  });
});

describe("channel runner outbound receipt maintenance", () => {
  it("prunes expired receipts in every state using the 14-day safety window", () => {
    const pruneExpired = mock(() => 3);
    const now = Date.UTC(2026, 6, 21);

    expect(pruneChannelOutboundReceiptLedger(now, { pruneExpired })).toBe(3);
    expect(pruneExpired).toHaveBeenCalledWith(now - CHANNEL_OUTBOUND_RECEIPT_RETENTION_MS, now);
    expect(CHANNEL_OUTBOUND_RECEIPT_RETENTION_MS).toBe(14 * 24 * 60 * 60 * 1_000);
  });

  it("prunes published outbox jobs using the same 14-day safety window", () => {
    const prunePublished = mock(() => 4);
    const now = Date.UTC(2026, 6, 21);

    expect(pruneChannelOutboundPublishOutbox(now, { prunePublished })).toBe(4);
    expect(prunePublished).toHaveBeenCalledWith(now - CHANNEL_OUTBOUND_PUBLISH_RETENTION_MS, now);
    expect(CHANNEL_OUTBOUND_PUBLISH_RETENTION_MS).toBe(CHANNEL_OUTBOUND_RECEIPT_RETENTION_MS);
  });

  it("runs receipt and publish outbox pruning in the same maintenance pass", () => {
    const pruneExpired = mock(() => 2);
    const prunePublished = mock(() => 1);
    const now = Date.UTC(2026, 6, 21);

    expect(
      runChannelOutboundLedgerMaintenance(now, {
        receiptStore: { pruneExpired },
        publishOutboxStore: { prunePublished },
      }),
    ).toEqual({ receipts: 2, publishJobs: 1 });
    expect(pruneExpired).toHaveBeenCalledWith(now - CHANNEL_OUTBOUND_RECEIPT_RETENTION_MS, now);
    expect(prunePublished).toHaveBeenCalledWith(now - CHANNEL_OUTBOUND_PUBLISH_RETENTION_MS, now);
  });

  it("runs periodic pruning on an unref timer and clears it when stopped", () => {
    const pruneExpired = mock(() => 2);
    const prunePublished = mock(() => 1);
    const unref = mock(() => {});
    const timer = { unref } as unknown as ReturnType<typeof setInterval>;
    let callback: (() => void) | undefined;
    const setIntervalForTest = mock((scheduled: () => void, intervalMs: number) => {
      callback = scheduled;
      expect(intervalMs).toBe(CHANNEL_OUTBOUND_RECEIPT_PRUNE_INTERVAL_MS);
      return timer;
    });
    const clearIntervalForTest = mock((_timer: ReturnType<typeof setInterval>) => {});
    const now = Date.UTC(2026, 6, 21);

    const stop = startChannelOutboundReceiptPruner({
      now: () => now,
      store: { pruneExpired },
      publishOutboxStore: { prunePublished },
      setInterval: setIntervalForTest,
      clearInterval: clearIntervalForTest,
    });

    expect(setIntervalForTest).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
    expect(pruneExpired).not.toHaveBeenCalled();
    expect(prunePublished).not.toHaveBeenCalled();
    callback?.();
    expect(pruneExpired).toHaveBeenCalledWith(now - CHANNEL_OUTBOUND_RECEIPT_RETENTION_MS, now);
    expect(prunePublished).toHaveBeenCalledWith(now - CHANNEL_OUTBOUND_PUBLISH_RETENTION_MS, now);

    stop();
    expect(clearIntervalForTest).toHaveBeenCalledWith(timer);
    expect(CHANNEL_OUTBOUND_RECEIPT_PRUNE_INTERVAL_MS).toBe(6 * 60 * 60 * 1_000);
  });
});

describe("channel runner Slack health projection", () => {
  it("does not call an opening socket connected before Slack hello", () => {
    expect(
      slackAdapterHealth("hana-slack", {
        state: "connecting",
        reconnectCount: 0,
        reason: "awaiting_hello",
      }),
    ).toEqual({
      id: "slack:hana-slack",
      channelId: "slack",
      status: "starting",
      reason: "awaiting_hello",
      reconnectCount: 0,
    });
  });

  it("projects heartbeat and reconnect lifecycle without exposing credentials", () => {
    const health = slackAdapterHealth("hana-slack", {
      state: "connected",
      connectedAt: 1_721_563_201_000,
      lastPongAt: 1_721_563_202_000,
      reconnectCount: 2,
    });

    expect(health).toEqual({
      id: "slack:hana-slack",
      channelId: "slack",
      status: "connected",
      connectedAt: 1_721_563_201_000,
      lastPongAt: 1_721_563_202_000,
      reconnectCount: 2,
    });
    expect(JSON.stringify(health)).not.toContain("xapp-");
    expect(JSON.stringify(health)).not.toContain("xoxb-");

    expect(
      slackAdapterHealth("hana-slack", {
        state: "reconnecting",
        reconnectCount: 3,
        reason: "heartbeat_timeout",
      }),
    ).toMatchObject({
      status: "reconnecting",
      reason: "heartbeat_timeout",
      reconnectCount: 3,
    });
  });
});
