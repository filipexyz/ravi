import * as closeAllDbs from "../db/close-all.js";
import * as natsConnection from "../nats.js";
import { describe, expect, it, mock, spyOn } from "bun:test";
import { StateSchemaNotReadyError } from "../db/schema-owner.js";
import * as runtimeIdentity from "../runtime-process-identity.js";
import * as runtimeState from "../db/runtime-state.js";
import { configStore } from "../config-store.js";
import * as nativeDrivers from "./native/driver.js";
import * as outboundStream from "./outbound-stream.js";
import * as runnerHealth from "./health.js";
import * as backend from "./backend.js";
import * as backendEgress from "./backend-egress.js";
import * as inboundActions from "./inbound-actions.js";
import { ChannelOutboundConsumer } from "./outbound-consumer.js";
import { ChannelPresenceConsumer } from "./presence-consumer.js";
import {
  CHANNEL_OUTBOUND_PUBLISH_RETENTION_MS,
  type ChannelOutboundPublishResult,
  channelOutboundPublishRequestFingerprint,
  ChannelOutboundPublishReconciler,
  sqliteChannelOutboundPublishOutboxStore,
} from "./outbound-publish-outbox.js";
import { CHANNEL_OUTBOUND_RECEIPT_RETENTION_MS, sqliteChannelOutboundReceiptStore } from "./outbound-receipts.js";
import {
  CHANNEL_OUTBOUND_RECEIPT_PRUNE_INTERVAL_MS,
  ChannelRunner,
  runChannelRunnerFromEnv,
  collectNativeRuntimeDeliveries,
  pruneChannelOutboundPublishOutbox,
  pruneChannelOutboundReceiptLedger,
  resolveChannelRunnerLogLevel,
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
import { buildRunnerPm2Env } from "./pm2-env.js";
import { RUNNER_RELEASE_GUARD_ADAPTER_ID } from "./runner-release-status.js";

describe("channel runner PM2 environment", () => {
  it("does not use Slack connection env as runner configuration", () => {
    const previousConnection = process.env.RAVI_SLACK_CONNECTION;
    const previousConnections = process.env.RAVI_SLACK_CONNECTIONS;
    const previousCredentialConnection = process.env.RAVI_SLACK_CREDENTIAL_CONNECTION;

    try {
      process.env.RAVI_SLACK_CONNECTION = "primary-slack";
      process.env.RAVI_SLACK_CONNECTIONS = "primary-slack,secondary-slack";
      process.env.RAVI_SLACK_CREDENTIAL_CONNECTION = "legacy";

      const env = buildRunnerPm2Env();

      expect(env).not.toHaveProperty("RAVI_SLACK_CONNECTION");
      expect(env).not.toHaveProperty("RAVI_SLACK_CONNECTIONS");
      expect(env).not.toHaveProperty("RAVI_SLACK_CREDENTIAL_CONNECTION");
    } finally {
      setOptionalEnv("RAVI_SLACK_CONNECTION", previousConnection);
      setOptionalEnv("RAVI_SLACK_CONNECTIONS", previousConnections);
      setOptionalEnv("RAVI_SLACK_CREDENTIAL_CONNECTION", previousCredentialConnection);
    }
  });

  it("preserves channel runner behavior flags", () => {
    const previousConsumeOutbound = process.env.RAVI_CHANNELS_CONSUME_OUTBOUND;
    const previousThreadReplyMode = process.env.RAVI_SLACK_THREAD_REPLY_MODE;

    try {
      process.env.RAVI_CHANNELS_CONSUME_OUTBOUND = "0";
      process.env.RAVI_SLACK_THREAD_REPLY_MODE = "thread";

      expect(buildRunnerPm2Env()).toMatchObject({
        RAVI_CHANNELS_CONSUME_OUTBOUND: "0",
        RAVI_SLACK_THREAD_REPLY_MODE: "thread",
      });
    } finally {
      setOptionalEnv("RAVI_CHANNELS_CONSUME_OUTBOUND", previousConsumeOutbound);
      setOptionalEnv("RAVI_SLACK_THREAD_REPLY_MODE", previousThreadReplyMode);
    }
  });
});

describe("channel runner log level", () => {
  it("logs at info by default instead of the CLI's error level", () => {
    expect(resolveChannelRunnerLogLevel({})).toBe("info");
    expect(resolveChannelRunnerLogLevel({ RAVI_CLI_LOG_LEVEL: "error" })).toBe("info");
  });

  it("follows RAVI_LOG_LEVEL like the daemon and ignores invalid values", () => {
    expect(resolveChannelRunnerLogLevel({ RAVI_LOG_LEVEL: " WARN " })).toBe("warn");
    expect(resolveChannelRunnerLogLevel({ RAVI_LOG_LEVEL: "debug" })).toBe("debug");
    expect(resolveChannelRunnerLogLevel({ RAVI_LOG_LEVEL: "verbose" })).toBe("info");
  });

  it("carries RAVI_LOG_LEVEL into the runner's PM2 env", () => {
    const previous = process.env.RAVI_LOG_LEVEL;
    try {
      process.env.RAVI_LOG_LEVEL = "debug";
      expect(buildRunnerPm2Env()).toMatchObject({ RAVI_LOG_LEVEL: "debug" });
    } finally {
      setOptionalEnv("RAVI_LOG_LEVEL", previous);
    }
  });
});

function setOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

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
        disposition: "deferred",
        record: {
          idempotencyKey: job.request.idempotencyKey,
          requestFingerprint: channelOutboundPublishRequestFingerprint(job),
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
            format: "markdown",
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
            format: "markdown",
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
    await outputSink!.emit({
      protocol: "ravi.channel.backend",
      schemaVersion: 1,
      outputId: "output-safe-error",
      correlationId: "correlation-safe-error",
      binding: {
        channelInstanceId: "slack-a",
        agentId: "agent-a",
        chatId: "chat-a",
        messageId: "message-a",
        sessionId: "session-a",
        turnId: "turn-safe-error",
      },
      target: {
        channelKind: "slack",
        connectionId: "slack-a",
        conversationId: "C123~1713000000.000100",
      },
      kind: "safe_error",
      error: {
        code: "INTERNAL",
        category: "internal",
        retryable: false,
      },
      emittedAt: "2026-07-29T12:00:03.000Z",
    });
    expect(publishOutbound).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        jobId: "channel-output:output-safe-error",
        request: expect.objectContaining({
          origin: expect.objectContaining({
            emitId: "output-safe-error",
            responsePhase: "safe_error",
          }),
          content: {
            type: "text",
            text: "The agent could not complete this request because of an internal error.",
            format: "markdown",
          },
        }),
      }),
    );
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
        emittedAt: "2026-07-29T12:00:04.000Z",
      }),
    ).rejects.toThrow("runtime_surface_mismatch");
    expect(publishOutbound).toHaveBeenCalledTimes(3);
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

describe("managed runner boot identity", () => {
  it("records its PID-bound boot receipt before starting adapters", async () => {
    const order: string[] = [];
    const receipt = spyOn(runtimeIdentity, "recordManagedRuntimeBoot").mockImplementation((name) => {
      order.push(name);
      return true;
    });
    const start = spyOn(ChannelRunner.prototype, "start").mockImplementation(async () => {
      order.push("adapters");
      throw new Error("stop before opening sockets");
    });
    try {
      await expect(runChannelRunnerFromEnv()).rejects.toThrow("stop before opening sockets");
      expect(order).toEqual(["ravi-channels", "adapters"]);
    } finally {
      start.mockRestore();
      receipt.mockRestore();
    }
  });
});

describe("channel runner drain", () => {
  it.each(["connect", "refresh", "infrastructure", "modules", "native"] as const)(
    "fences startup suspended at %s and waits for its partial cleanup",
    async (stage) => {
      let entered!: () => void;
      const pending = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let resume!: () => void;
      const release = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let finishCleanup!: () => void;
      const cleanup = new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
      const waitAt = async (point: typeof stage) => {
        if (point !== stage) return;
        entered();
        await release;
      };
      const stopNative = spyOn(nativeDrivers.NativeChannelDriverManager.prototype, "stop").mockImplementation(
        async () => cleanup,
      );
      const startOutbound = spyOn(ChannelOutboundConsumer.prototype, "start").mockImplementation(() => {});
      const startPublish = spyOn(ChannelOutboundPublishReconciler.prototype, "start").mockImplementation(() => {});
      const startPresence = spyOn(ChannelPresenceConsumer.prototype, "start").mockImplementation(() => {});
      const startBackend = spyOn(backend, "startChannelBackendPublicationReconciler").mockImplementation(() => {
        throw new Error("Unexpected backend startup after drain");
      });
      const startEgress = spyOn(backendEgress, "startChannelBackendEgressResponder").mockReturnValue({
        stop: async () => {},
      });
      const startInbound = spyOn(inboundActions, "startNativeInboundChannelActionResponder").mockReturnValue({
        stop: async () => {},
      });
      const spies = [
        stopNative,
        startOutbound,
        startPublish,
        startPresence,
        startBackend,
        startEgress,
        startInbound,
        spyOn(runtimeState, "assertRuntimeStateReady").mockImplementation(() => {}),
        spyOn(natsConnection, "connectNats").mockImplementation(async () => {
          await waitAt("connect");
          return {} as never;
        }),
        spyOn(natsConnection, "getNats").mockReturnValue({} as never),
        spyOn(configStore, "startRefresh").mockImplementation(async () => waitAt("refresh")),
        spyOn(configStore, "getConfig").mockReturnValue({ channels: {} } as ReturnType<typeof configStore.getConfig>),
        spyOn(outboundStream, "ensureChannelOutboundInfrastructure").mockImplementation(async () =>
          waitAt("infrastructure"),
        ),
        spyOn(sqliteChannelOutboundReceiptStore, "pruneExpired").mockReturnValue(0),
        spyOn(sqliteChannelOutboundPublishOutboxStore, "prunePublished").mockReturnValue(0),
        spyOn(runnerHealth, "startChannelRunnerHealthResponder").mockReturnValue({
          subject: "test.health",
          stop: async () => {},
        }),
        spyOn(nativeDrivers, "loadNativeChannelDriverModules").mockImplementation(async () => {
          await waitAt("modules");
          return { loadedProviders: [], failures: [] };
        }),
        spyOn(nativeDrivers.NativeChannelDriverManager.prototype, "start").mockImplementation(async () =>
          waitAt("native"),
        ),
      ];
      try {
        const runner = new ChannelRunner();
        const starting = runner.start();
        await pending;
        let proved = false;
        const draining = runner.requestDrain().then((proof) => {
          proved = true;
          return proof;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(proved).toBe(false);
        expect((runner as unknown as { running: boolean }).running).toBe(false);
        await expect(runner.start()).rejects.toThrow("WORK_DRAIN_ADMISSION_CLOSED");
        resume();
        await starting;
        if (stage === "native") {
          expect(stopNative).toHaveBeenCalledWith({ requireDrain: true });
          expect(proved).toBe(false);
        }
        finishCleanup();
        await draining;
        expect((runner as unknown as { running: boolean }).running).toBe(false);
        for (const start of [startOutbound, startPublish, startPresence, startBackend, startEgress, startInbound]) {
          expect(start).not.toHaveBeenCalled();
        }
      } finally {
        resume();
        finishCleanup();
        for (const spy of spies) spy.mockRestore();
      }
    },
  );

  it("keeps databases open until every component has completed drain", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const nativeStop = mock(async () => pending);
    const outboundStop = mock(async () => {});
    const closeDbs = spyOn(closeAllDbs, "closeAllRaviDbs").mockImplementation(() => {});
    const closeBroker = spyOn(natsConnection, "closeNats").mockImplementation(async () => {});
    try {
      const runner = new ChannelRunner();
      const internals = runner as unknown as {
        nativeChannelManager: { stop: typeof nativeStop };
        outboundConsumer: { stop: typeof outboundStop };
      };
      internals.nativeChannelManager = { stop: nativeStop };
      internals.outboundConsumer = { stop: outboundStop };
      const stopping = runner.stop();
      expect(nativeStop).toHaveBeenCalledWith({ requireDrain: true });
      expect(outboundStop).toHaveBeenCalledTimes(1);
      expect(closeDbs).not.toHaveBeenCalled();
      expect(closeBroker).not.toHaveBeenCalled();
      finish();
      await stopping;
      expect(closeDbs).toHaveBeenCalledTimes(1);
      expect(closeBroker).toHaveBeenCalledTimes(1);
    } finally {
      closeDbs.mockRestore();
      closeBroker.mockRestore();
    }
  });

  it("does not close databases or broker when a component lacks drain proof", async () => {
    const closeDbs = spyOn(closeAllDbs, "closeAllRaviDbs").mockImplementation(() => {});
    const closeBroker = spyOn(natsConnection, "closeNats").mockImplementation(async () => {});
    try {
      const runner = new ChannelRunner();
      (runner as unknown as { nativeChannelManager: { stop(): Promise<void> } }).nativeChannelManager = {
        stop: async () => {
          throw new Error("unpersisted callback");
        },
      };
      await expect(runner.stop()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
      expect(closeDbs).not.toHaveBeenCalled();
      expect(closeBroker).not.toHaveBeenCalled();
    } finally {
      closeDbs.mockRestore();
      closeBroker.mockRestore();
    }
  });

  it("database close failure rejects shutdown and latches every later channel drain request", async () => {
    const cause = new Error("SQLite close failed");
    const closeDbs = spyOn(closeAllDbs, "closeAllRaviDbs").mockImplementation(() => {
      throw cause;
    });
    const closeBroker = spyOn(natsConnection, "closeNats").mockResolvedValue(undefined);
    try {
      const runner = new ChannelRunner();
      await expect(runner.stop()).rejects.toBe(cause);
      expect(runner.drainStatus()).toMatchObject({ phase: "blocked", failures: ["channel-runner-stop"] });
      await expect(runner.requestDrain()).rejects.toThrow("WORK_DRAIN_UNPROVEN");
      expect(closeBroker).not.toHaveBeenCalled();
    } finally {
      closeDbs.mockRestore();
      closeBroker.mockRestore();
    }
  });
});

describe("channel runner release drift", () => {
  const refusal = () => new StateSchemaNotReadyError("channel-outbound-publish");

  /** Starts a runner with every component stubbed, so only the wiring into the reconcile loop is exercised. */
  async function startStubbedRunner(options: ConstructorParameters<typeof ChannelRunner>[0]) {
    const spies = [
      spyOn(ChannelOutboundConsumer.prototype, "start").mockImplementation(() => {}),
      spyOn(ChannelOutboundPublishReconciler.prototype, "start").mockImplementation(() => {}),
      spyOn(ChannelPresenceConsumer.prototype, "start").mockImplementation(() => {}),
      spyOn(backend, "startChannelBackendPublicationReconciler").mockReturnValue((async () => ({})) as never),
      spyOn(backendEgress, "startChannelBackendEgressResponder").mockReturnValue({ stop: async () => {} }),
      spyOn(inboundActions, "startNativeInboundChannelActionResponder").mockReturnValue({ stop: async () => {} }),
      spyOn(runtimeState, "assertRuntimeStateReady").mockImplementation(() => {}),
      spyOn(natsConnection, "connectNats").mockResolvedValue({} as never),
      spyOn(natsConnection, "getNats").mockReturnValue({} as never),
      spyOn(configStore, "startRefresh").mockResolvedValue(undefined as never),
      spyOn(configStore, "getConfig").mockReturnValue({ channels: {} } as ReturnType<typeof configStore.getConfig>),
      spyOn(outboundStream, "ensureChannelOutboundInfrastructure").mockResolvedValue(undefined as never),
      spyOn(sqliteChannelOutboundReceiptStore, "pruneExpired").mockReturnValue(0),
      spyOn(sqliteChannelOutboundPublishOutboxStore, "prunePublished").mockReturnValue(0),
      spyOn(runnerHealth, "startChannelRunnerHealthResponder").mockReturnValue({
        subject: "test.health",
        stop: async () => {},
      }),
      spyOn(nativeDrivers, "loadNativeChannelDriverModules").mockResolvedValue({ loadedProviders: [], failures: [] }),
      spyOn(nativeDrivers.NativeChannelDriverManager.prototype, "start").mockResolvedValue(undefined as never),
    ];
    const runner = new ChannelRunner(options);
    await runner.start();
    const reconciler = (
      runner as unknown as {
        outboundPublishReconciler: { options: { onLoopFailure(error: unknown): void; onLoopSuccess(): void } };
      }
    ).outboundPublishReconciler;
    return {
      runner,
      reconciler: reconciler.options,
      restore: () => {
        for (const spy of spies) spy.mockRestore();
      },
    };
  }

  it("feeds the outbound reconcile loop's refusals to the release guard and reports the drift once", async () => {
    const drifts: unknown[] = [];
    const { reconciler, restore } = await startStubbedRunner({
      releaseGuard: { runningVersion: "3.261119.6", readInstalledVersion: () => "3.261119.9" },
      onReleaseDrift: (relaunch) => drifts.push(relaunch),
    });
    try {
      reconciler.onLoopFailure(refusal());
      reconciler.onLoopFailure(refusal());
      reconciler.onLoopSuccess(); // a pass that clears the guard restarts the count
      reconciler.onLoopFailure(refusal());
      reconciler.onLoopFailure(refusal());
      expect(drifts).toEqual([]);

      reconciler.onLoopFailure(refusal());
      reconciler.onLoopFailure(refusal());
      expect(drifts).toEqual([{ runningVersion: "3.261119.6", installedVersion: "3.261119.9", refusals: 3 }]);
    } finally {
      restore();
    }
  });

  it("reports a refused state guard as a degraded adapter until a pass is accepted", async () => {
    const { runner, reconciler, restore } = await startStubbedRunner({
      releaseGuard: { runningVersion: "3.261119.9", readInstalledVersion: () => "3.261119.9" },
    });
    const guardEntries = () =>
      runner.status().adapters.filter((adapter) => adapter.id === RUNNER_RELEASE_GUARD_ADAPTER_ID);
    try {
      expect(guardEntries()).toEqual([]);

      // A failure that is not a state refusal is the reconcile loop's own business, not the guard's.
      reconciler.onLoopFailure(new Error("NATS unavailable"));
      expect(guardEntries()).toEqual([]);

      // One refusal is enough: a refused pass is a pass that did not reconcile, whatever the releases are.
      reconciler.onLoopFailure(refusal());
      expect(guardEntries()).toEqual([
        {
          id: RUNNER_RELEASE_GUARD_ADAPTER_ID,
          channelId: "runner",
          status: "degraded",
          reason: "state_refused",
          detail: "STATE_SCHEMA_NOT_READY",
        },
      ]);

      reconciler.onLoopSuccess();
      expect(guardEntries()).toEqual([]);
    } finally {
      restore();
    }
  });

  it("does not report drift for a runner on the installed release", async () => {
    const drifts: unknown[] = [];
    const { reconciler, restore } = await startStubbedRunner({
      releaseGuard: { runningVersion: "3.261119.9", readInstalledVersion: () => "3.261119.9" },
      onReleaseDrift: (relaunch) => drifts.push(relaunch),
    });
    try {
      for (let pass = 0; pass < 10; pass++) reconciler.onLoopFailure(refusal());
      expect(drifts).toEqual([]);
    } finally {
      restore();
    }
  });
});
