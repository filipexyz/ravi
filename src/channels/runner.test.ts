import { describe, expect, it, mock } from "bun:test";
import type { StoredRemoteInstallationCredential } from "../cloud-auth/installation-storage.js";
import { CHANNEL_OUTBOUND_PUBLISH_RETENTION_MS } from "./outbound-publish-outbox.js";
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
import type {
  NativeInboundChannelActionResponder,
  NativeInboundChannelActionResponderConnection,
} from "./inbound-actions.js";
import type { NativeInboundChannelActionHandler } from "./native/driver.js";
import { installationChannelName, mergeInstallationCredentialChannels } from "./native/installation-channels.js";
import { createSlackNativeChannelDriver } from "./slack/driver.js";

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
      },
    );
    const runtime = await driver.createRuntime({
      channel: {
        name: "slack-a",
        provider: "slack",
        credentialConnection: "connection-a",
      },
      host: {} as never,
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
    await runtime.start();
    expect(start).toHaveBeenCalledTimes(1);
    expect(runtime.health()).toMatchObject({
      status: "starting",
      reason: "opening_socket",
      reconnectCount: 0,
    });
    await runtime.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("materializes one credential-backed native runtime without copying credential material", () => {
    const endpointUrl = "https://remote.example";
    const stored: StoredRemoteInstallationCredential = {
      endpointUrl,
      credential: {
        provider: "example",
        credentialId: "credential-example",
        material: { privateValue: "must-not-enter-channel-config" },
      },
      createdAt: "2026-07-25T12:00:00.000Z",
      updatedAt: "2026-07-25T12:00:00.000Z",
    };

    const channels = mergeInstallationCredentialChannels({
      configured: {},
      credentials: [stored],
      registry: {
        get(provider) {
          return provider === "example"
            ? {
                descriptor: {
                  requiredHostCapabilities: ["installation_credentials"],
                },
              }
            : undefined;
        },
      },
      now: Date.parse("2026-07-25T13:00:00.000Z"),
    });

    expect(channels).toEqual({
      [installationChannelName("example", endpointUrl)]: {
        name: installationChannelName("example", endpointUrl),
        provider: "example",
        enabled: true,
        credentialConnection: endpointUrl,
        createdAt: 0,
        updatedAt: 0,
      },
    });
    expect(JSON.stringify(channels)).not.toContain("must-not-enter-channel-config");
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
