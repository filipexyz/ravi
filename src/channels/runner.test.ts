import { describe, expect, it, mock } from "bun:test";
import { CHANNEL_OUTBOUND_PUBLISH_RETENTION_MS } from "./outbound-publish-outbox.js";
import { CHANNEL_OUTBOUND_RECEIPT_RETENTION_MS } from "./outbound-receipts.js";
import {
  CHANNEL_OUTBOUND_RECEIPT_PRUNE_INTERVAL_MS,
  pruneChannelOutboundPublishOutbox,
  pruneChannelOutboundReceiptLedger,
  runChannelOutboundLedgerMaintenance,
  slackAdapterHealth,
  startChannelOutboundReceiptPruner,
} from "./runner.js";

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
