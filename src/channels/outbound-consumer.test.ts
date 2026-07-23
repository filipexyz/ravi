import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { NativeTextDelivery } from "./native/types.js";
import {
  type ChannelOutboundConsumerOptions,
  acknowledgeChannelOutboundMessage,
  channelOutboundRequestFingerprint,
  missingAdapterRetryDelayMs,
  persistDeliveredMessage,
  processChannelOutboundJob as processChannelOutboundJobWithNats,
} from "./outbound-consumer.js";
import {
  getChannelOutboundReceipt,
  sqliteChannelOutboundReceiptStore,
  type ChannelOutboundReceiptStore,
} from "./outbound-receipts.js";
import type { ChannelOutboundJob } from "./outbound-stream.js";

function processChannelOutboundJob(job: ChannelOutboundJob, options: ChannelOutboundConsumerOptions) {
  return processChannelOutboundJobWithNats(job, {
    flushNats: async () => {},
    ...options,
  });
}

describe("channel outbound consumer", () => {
  it("delivers text with the matching native adapter and emits delivery telemetry without direct presence renewal", async () => {
    const emitEvent = mock(async () => {});
    const delivery: NativeTextDelivery = {
      channelId: "slack",
      supports: (target) => target.channel === "slack",
      deliverText: mock(async () => ({
        provider: "slack",
        messageId: "slack:C123:1711111111.000100",
        platformMessageId: "1711111111.000100",
      })),
    };

    const result = await processChannelOutboundJob(makeJob(), {
      deliveries: [delivery],
      emitEvent,
      persistDelivery: false,
    });

    expect(result).toMatchObject({ disposition: "ack", status: "delivered", retryable: false });
    expect(delivery.deliverText).toHaveBeenCalledWith({
      sessionName: "ravi-channels",
      emitId: "emit_1",
      idempotencyKey: "runtime:ravi-channels:emit_1:slack:T1:C123:1711111111.000010",
      target: {
        channel: "slack",
        accountId: "T1",
        instanceId: "slack-main",
        chatId: "C123",
        threadId: "1711111111.000010",
      },
      text: "hello Slack",
    });
    expect(emitEvent).not.toHaveBeenCalledWith("ravi.channel.presence.slack", expect.anything());
    expect(emitEvent).toHaveBeenCalledWith(
      "ravi.session.ravi-channels.delivery",
      expect.objectContaining({
        status: "delivered",
        provider: "slack",
        messageId: "slack:C123:1711111111.000100",
        providerMessageId: "1711111111.000100",
        platformMessageId: "1711111111.000100",
        idempotencyKey: "runtime:ravi-channels:emit_1:slack:T1:C123:1711111111.000010",
        jobId: "runtime:ravi-channels:emit_1",
      }),
    );
  });

  it("naks missing-adapter failures with bounded backoff instead of acknowledging terminal loss", async () => {
    const emitEvent = mock(async () => {});
    const result = await processChannelOutboundJob(makeJob(), {
      deliveries: [],
      emitEvent,
      persistDelivery: false,
      deliveryAttempt: 2,
    });

    expect(result).toMatchObject({
      disposition: "nak",
      status: "failed",
      retryable: true,
      phase: "adapter_lookup",
      nakDelayMs: 60_000,
    });
    expect(emitEvent).toHaveBeenCalledWith(
      "ravi.session.ravi-channels.delivery",
      expect.objectContaining({
        status: "failed",
        reason: "missing_adapter",
        retryable: true,
        retryDelayMs: 60_000,
        deliveryAttempt: 2,
      }),
    );
  });

  it("recovers a missing-adapter redelivery when the matching adapter appears later", async () => {
    const emitEvent = mock(async () => {});
    const missing = await processChannelOutboundJob(makeJob(), {
      deliveries: [],
      emitEvent,
      persistDelivery: false,
      deliveryAttempt: 1,
    });
    const delivery = makeDelivery();
    const delivered = await processChannelOutboundJob(makeJob(), {
      deliveries: [delivery],
      emitEvent,
      persistDelivery: false,
      deliveryAttempt: 2,
    });

    expect(missing).toMatchObject({
      disposition: "nak",
      retryable: true,
      nakDelayMs: 30_000,
    });
    expect(delivered).toEqual({ disposition: "ack", status: "delivered", retryable: false });
    expect(delivery.deliverText).toHaveBeenCalledTimes(1);
  });

  it("applies the retry delay to JetStream NAKs", () => {
    const ack = mock(() => {});
    const nak = mock((_delayMs?: number) => {});

    acknowledgeChannelOutboundMessage(
      { ack, nak },
      { disposition: "nak", status: "failed", retryable: true, nakDelayMs: 120_000 },
    );

    expect(ack).not.toHaveBeenCalled();
    expect(nak).toHaveBeenCalledWith(120_000);
    expect(missingAdapterRetryDelayMs(10)).toBe(300_000);
  });

  it("naks retryable adapter send failures", async () => {
    const emitEvent = mock(async () => {});
    const delivery: NativeTextDelivery = {
      channelId: "slack",
      supports: () => true,
      deliverText: mock(async () => {
        throw new Error("slack unavailable");
      }),
    };

    const result = await processChannelOutboundJob(makeJob(), {
      deliveries: [delivery],
      emitEvent,
      persistDelivery: false,
    });

    expect(result).toMatchObject({
      disposition: "nak",
      status: "failed",
      retryable: true,
      error: "slack unavailable",
    });
    expect(emitEvent).toHaveBeenCalledWith(
      "ravi.session.ravi-channels.delivery",
      expect.objectContaining({
        status: "failed",
        reason: "send_error",
        error: "slack unavailable",
      }),
    );
  });

  describe("durable post-send receipts", () => {
    let stateDir: string | null = null;

    beforeEach(async () => {
      stateDir = await createIsolatedRaviState("ravi-outbound-receipts-");
    });

    afterEach(async () => {
      await cleanupIsolatedRaviState(stateDir);
      stateDir = null;
    });

    it("delivers once from a fresh ledger and exposes canonical provider identity in telemetry", async () => {
      const delivery = makeDelivery();
      const emitEvent = mock(async () => {});
      const persist = mock(() => ({
        canonicalMessageId: "cm_123",
        platformMessageId: "1711111111.000100",
        providerTimestamp: 1_711_111_111_000,
      }));
      const recordTrace = mock(() => null);

      const first = await processChannelOutboundJob(makeJob(), {
        deliveries: [delivery],
        emitEvent,
        persistDeliveredMessage: persist,
        recordDeliveryTrace: recordTrace,
      });
      const repeated = await processChannelOutboundJob(makeJob(), {
        deliveries: [delivery],
        emitEvent,
        persistDeliveredMessage: persist,
        recordDeliveryTrace: recordTrace,
      });

      expect(first).toEqual({ disposition: "ack", status: "delivered", retryable: false });
      expect(repeated).toEqual({ disposition: "ack", status: "delivered", retryable: false });
      expect(delivery.deliverText).toHaveBeenCalledTimes(1);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(recordTrace).toHaveBeenCalledTimes(1);
      expect(emitEvent).toHaveBeenCalledTimes(1);
      expect(emitEvent).toHaveBeenCalledWith(
        "ravi.session.ravi-channels.delivery",
        expect.objectContaining({
          canonicalMessageId: "cm_123",
          messageId: "slack:C123:1711111111.000100",
          platformMessageId: "1711111111.000100",
          providerMessageId: "1711111111.000100",
          providerTimestamp: 1_711_111_111_000,
          idempotencyKey: makeJob().request.idempotencyKey,
        }),
      );
      expect(recordTrace).toHaveBeenCalledWith(
        expect.objectContaining({
          delivery: expect.objectContaining({
            canonicalMessageId: "cm_123",
            platformMessageId: "1711111111.000100",
            providerMessageId: "1711111111.000100",
            providerTimestamp: 1_711_111_111_000,
            idempotencyKey: makeJob().request.idempotencyKey,
          }),
        }),
      );
      expect(getChannelOutboundReceipt(makeJob().request.idempotencyKey)).toMatchObject({
        state: "complete",
        canonicalMessageId: "cm_123",
        platformMessageId: "1711111111.000100",
        providerTimestamp: 1_711_111_111_000,
      });
    });

    it("naks an emit failure and resumes telemetry without sending or persisting twice", async () => {
      const delivery = makeDelivery();
      let emitAttempts = 0;
      const emitEvent = mock(async () => {
        emitAttempts++;
        if (emitAttempts === 1) throw new Error("NATS unavailable");
      });
      const persist = mock(() => ({
        canonicalMessageId: "cm_123",
        platformMessageId: "1711111111.000100",
        providerTimestamp: 1_711_111_111_000,
      }));
      const recordTrace = mock(() => null);

      const failed = await processChannelOutboundJob(makeJob(), {
        deliveries: [delivery],
        emitEvent,
        persistDeliveredMessage: persist,
        recordDeliveryTrace: recordTrace,
      });
      expect(failed).toMatchObject({
        disposition: "nak",
        status: "delivered",
        retryable: true,
        phase: "telemetry_emit",
        error: "NATS unavailable",
      });
      expect(getChannelOutboundReceipt(makeJob().request.idempotencyKey)).toMatchObject({
        state: "persisted",
        lastErrorPhase: "telemetry_emit",
        traceRecordedAt: expect.any(Number),
      });

      const retried = await processChannelOutboundJob(makeJob(), {
        deliveries: [delivery],
        emitEvent,
        persistDeliveredMessage: persist,
        recordDeliveryTrace: recordTrace,
      });

      expect(retried).toEqual({ disposition: "ack", status: "delivered", retryable: false });
      expect(delivery.deliverText).toHaveBeenCalledTimes(1);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(recordTrace).toHaveBeenCalledTimes(1);
      expect(emitEvent).toHaveBeenCalledTimes(2);
      expect(getChannelOutboundReceipt(makeJob().request.idempotencyKey)).toMatchObject({ state: "complete" });
    });

    it("waits for the NATS flush before completing and re-emits telemetry after a failed flush", async () => {
      const order: string[] = [];
      const delivery = makeDelivery();
      const emitEvent = mock(async () => {
        order.push("emit");
      });
      let flushAttempts = 0;
      const flushNats = mock(async () => {
        order.push("flush");
        flushAttempts++;
        if (flushAttempts === 1) throw new Error("NATS flush unavailable");
      });
      const receiptStore: ChannelOutboundReceiptStore = {
        ...sqliteChannelOutboundReceiptStore,
        markComplete: (idempotencyKey, completedAt) => {
          order.push("complete");
          return sqliteChannelOutboundReceiptStore.markComplete(idempotencyKey, completedAt);
        },
      };

      const failed = await processChannelOutboundJob(makeJob(), {
        deliveries: [delivery],
        emitEvent,
        flushNats,
        receiptStore,
        persistDeliveredMessage: () => ({}),
        recordDeliveryTrace: () => null,
      });

      expect(failed).toMatchObject({
        disposition: "nak",
        status: "delivered",
        retryable: true,
        phase: "telemetry_emit",
        error: "NATS flush unavailable",
      });
      expect(order).toEqual(["emit", "flush"]);
      expect(getChannelOutboundReceipt(makeJob().request.idempotencyKey)).toMatchObject({
        state: "persisted",
        lastErrorPhase: "telemetry_emit",
      });

      const retried = await processChannelOutboundJob(makeJob(), {
        deliveries: [delivery],
        emitEvent,
        flushNats,
        receiptStore,
        persistDeliveredMessage: () => ({}),
        recordDeliveryTrace: () => null,
      });

      expect(retried).toEqual({ disposition: "ack", status: "delivered", retryable: false });
      expect(order).toEqual(["emit", "flush", "emit", "flush", "complete"]);
      expect(delivery.deliverText).toHaveBeenCalledTimes(1);
      expect(emitEvent).toHaveBeenCalledTimes(2);
      expect(flushNats).toHaveBeenCalledTimes(2);
      expect(getChannelOutboundReceipt(makeJob().request.idempotencyKey)).toMatchObject({ state: "complete" });
    });

    it("naks canonical persistence failure and resumes it without a second provider send", async () => {
      const delivery = makeDelivery();
      let persistAttempts = 0;
      const persist = mock(() => {
        persistAttempts++;
        if (persistAttempts === 1) throw new Error("SQLite busy");
        return {
          canonicalMessageId: "cm_123",
          platformMessageId: "1711111111.000100",
          providerTimestamp: 1_711_111_111_000,
        };
      });
      const emitEvent = mock(async () => {});
      const recordTrace = mock(() => null);

      const failed = await processChannelOutboundJob(makeJob(), {
        deliveries: [delivery],
        emitEvent,
        persistDeliveredMessage: persist,
        recordDeliveryTrace: recordTrace,
      });
      expect(failed).toMatchObject({
        disposition: "nak",
        status: "delivered",
        retryable: true,
        phase: "canonical_persist",
        error: "SQLite busy",
      });
      expect(getChannelOutboundReceipt(makeJob().request.idempotencyKey)).toMatchObject({
        state: "sent",
        lastErrorPhase: "canonical_persist",
      });

      const retried = await processChannelOutboundJob(makeJob(), {
        deliveries: [delivery],
        emitEvent,
        persistDeliveredMessage: persist,
        recordDeliveryTrace: recordTrace,
      });

      expect(retried).toEqual({ disposition: "ack", status: "delivered", retryable: false });
      expect(delivery.deliverText).toHaveBeenCalledTimes(1);
      expect(persist).toHaveBeenCalledTimes(2);
      expect(recordTrace).toHaveBeenCalledTimes(1);
      expect(emitEvent).toHaveBeenCalledTimes(1);
    });

    it("allows only one active runner to call the provider for an idempotency key", async () => {
      let releaseSend!: () => void;
      let markStarted!: () => void;
      const sendReleased = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      const sendStarted = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const delivery: NativeTextDelivery = {
        channelId: "slack",
        supports: () => true,
        deliverText: mock(async () => {
          markStarted();
          await sendReleased;
          return {
            provider: "slack",
            platformMessageId: "1711111111.000100",
            providerTimestamp: 1_711_111_111_000,
          };
        }),
      };
      const emitEvent = mock(async () => {});
      const persist = mock(() => ({}));
      const firstRun = processChannelOutboundJob(makeJob(), {
        deliveries: [delivery],
        emitEvent,
        persistDeliveredMessage: persist,
        recordDeliveryTrace: () => null,
      });
      await sendStarted;

      const contender = await processChannelOutboundJob(makeJob(), {
        deliveries: [delivery],
        emitEvent,
        persistDeliveredMessage: persist,
        recordDeliveryTrace: () => null,
      });
      expect(contender).toMatchObject({
        disposition: "nak",
        retryable: true,
        phase: "receipt_claim",
      });
      expect(delivery.deliverText).toHaveBeenCalledTimes(1);

      releaseSend();
      await expect(firstRun).resolves.toEqual({ disposition: "ack", status: "delivered", retryable: false });
      expect(delivery.deliverText).toHaveBeenCalledTimes(1);
    });

    it("reclaims an expired lease and reuses the same provider idempotency token", async () => {
      const job = makeJob();
      const fingerprint = channelOutboundRequestFingerprint(job);
      sqliteChannelOutboundReceiptStore.claim({
        idempotencyKey: job.request.idempotencyKey,
        requestFingerprint: fingerprint,
        owner: "dead-runner",
        jobId: job.jobId,
        requestId: job.request.requestId,
        sessionName: job.request.origin.sessionName,
        provider: "slack",
        now: 1,
        leaseMs: 1,
      });
      const delivery = makeDelivery();

      const result = await processChannelOutboundJob(job, {
        deliveries: [delivery],
        emitEvent: async () => {},
        persistDeliveredMessage: () => ({}),
        recordDeliveryTrace: () => null,
      });

      expect(result).toEqual({ disposition: "ack", status: "delivered", retryable: false });
      expect(delivery.deliverText).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: job.request.idempotencyKey }),
      );
      expect(getChannelOutboundReceipt(job.request.idempotencyKey)).toMatchObject({ state: "complete" });
    });

    it("fails closed when the same idempotency key carries different content", async () => {
      const delivery = makeDelivery();
      const emitEvent = mock(async () => {});
      const firstJob = makeJob();
      const conflictingJob = makeJob();
      conflictingJob.request.content.text = "different content";

      await processChannelOutboundJob(firstJob, {
        deliveries: [delivery],
        emitEvent,
        persistDeliveredMessage: () => ({}),
        recordDeliveryTrace: () => null,
      });
      const result = await processChannelOutboundJob(conflictingJob, {
        deliveries: [delivery],
        emitEvent,
        persistDeliveredMessage: () => ({}),
        recordDeliveryTrace: () => null,
      });

      expect(result).toMatchObject({
        disposition: "ack",
        status: "failed",
        retryable: false,
        phase: "receipt_claim",
      });
      expect(delivery.deliverText).toHaveBeenCalledTimes(1);
      expect(emitEvent).toHaveBeenLastCalledWith(
        "ravi.session.ravi-channels.delivery",
        expect.objectContaining({ status: "failed", reason: "idempotency_conflict" }),
      );
    });

    it("recovers a receipt write failure after lease expiry without reporting send_error", async () => {
      const delivery = makeDelivery();
      const emitEvent = mock(async () => {});
      let failReceiptWrite = true;
      const receiptStore: ChannelOutboundReceiptStore = {
        ...sqliteChannelOutboundReceiptStore,
        recordSent: (input) => {
          if (failReceiptWrite) {
            failReceiptWrite = false;
            throw new Error("receipt disk unavailable");
          }
          return sqliteChannelOutboundReceiptStore.recordSent(input);
        },
      };

      const failed = await processChannelOutboundJob(makeJob(), {
        deliveries: [delivery],
        emitEvent,
        receiptStore,
        claimLeaseMs: 1,
        persistDeliveredMessage: () => ({}),
        recordDeliveryTrace: () => null,
      });
      expect(failed).toMatchObject({
        disposition: "nak",
        status: "delivered",
        phase: "receipt_write",
        error: "receipt disk unavailable",
      });
      expect(getChannelOutboundReceipt(makeJob().request.idempotencyKey)).toMatchObject({
        state: "claimed",
        lastErrorPhase: "receipt_write",
      });
      expect(emitEvent).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: "send_error" }));

      await new Promise((resolve) => setTimeout(resolve, 5));
      const retried = await processChannelOutboundJob(makeJob(), {
        deliveries: [delivery],
        emitEvent,
        receiptStore,
        claimLeaseMs: 1,
        persistDeliveredMessage: () => ({}),
        recordDeliveryTrace: () => null,
      });
      expect(retried).toEqual({ disposition: "ack", status: "delivered", retryable: false });
      expect(delivery.deliverText).toHaveBeenCalledTimes(2);
      expect(delivery.deliverText).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ idempotencyKey: makeJob().request.idempotencyKey }),
      );
      expect(delivery.deliverText).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ idempotencyKey: makeJob().request.idempotencyKey }),
      );
    });

    it("retries an at-least-once trace after trace recording fails", async () => {
      const delivery = makeDelivery();
      let traceAttempts = 0;
      const recordTrace = mock(() => {
        traceAttempts++;
        if (traceAttempts === 1) throw new Error("trace unavailable");
        return null;
      });
      const emitEvent = mock(async () => {});
      const persist = mock(() => ({}));

      const failed = await processChannelOutboundJob(makeJob(), {
        deliveries: [delivery],
        emitEvent,
        persistDeliveredMessage: persist,
        recordDeliveryTrace: recordTrace,
      });
      expect(failed).toMatchObject({ disposition: "nak", phase: "trace_record", status: "delivered" });

      const retried = await processChannelOutboundJob(makeJob(), {
        deliveries: [delivery],
        emitEvent,
        persistDeliveredMessage: persist,
        recordDeliveryTrace: recordTrace,
      });
      expect(retried).toEqual({ disposition: "ack", status: "delivered", retryable: false });
      expect(delivery.deliverText).toHaveBeenCalledTimes(1);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(recordTrace).toHaveBeenCalledTimes(2);
      expect(emitEvent).toHaveBeenCalledTimes(1);
    });

    it("treats delivery telemetry as at-least-once when completing its receipt fails", async () => {
      const delivery = makeDelivery();
      const emitEvent = mock(async () => {});
      const persist = mock(() => ({}));
      const recordTrace = mock(() => null);
      let failComplete = true;
      const receiptStore: ChannelOutboundReceiptStore = {
        ...sqliteChannelOutboundReceiptStore,
        markComplete: (idempotencyKey, completedAt) => {
          if (failComplete) {
            failComplete = false;
            throw new Error("complete write failed");
          }
          return sqliteChannelOutboundReceiptStore.markComplete(idempotencyKey, completedAt);
        },
      };

      const failed = await processChannelOutboundJob(makeJob(), {
        deliveries: [delivery],
        emitEvent,
        receiptStore,
        persistDeliveredMessage: persist,
        recordDeliveryTrace: recordTrace,
      });
      expect(failed).toMatchObject({ disposition: "nak", phase: "receipt_complete", status: "delivered" });

      const retried = await processChannelOutboundJob(makeJob(), {
        deliveries: [delivery],
        emitEvent,
        receiptStore,
        persistDeliveredMessage: persist,
        recordDeliveryTrace: recordTrace,
      });
      expect(retried).toEqual({ disposition: "ack", status: "delivered", retryable: false });
      expect(delivery.deliverText).toHaveBeenCalledTimes(1);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(recordTrace).toHaveBeenCalledTimes(1);
      expect(emitEvent).toHaveBeenCalledTimes(2);
      expect(emitEvent).toHaveBeenNthCalledWith(
        2,
        "ravi.session.ravi-channels.delivery",
        expect.objectContaining({ idempotencyKey: makeJob().request.idempotencyKey }),
      );
    });

    it("completes without canonical identity when the provider omits its platform message id", async () => {
      const delivery: NativeTextDelivery = {
        channelId: "slack",
        supports: () => true,
        deliverText: mock(async () => ({ provider: "slack", messageId: "delivery-only" })),
      };
      const persist = mock(() => ({}));

      const result = await processChannelOutboundJob(makeJob(), {
        deliveries: [delivery],
        emitEvent: async () => {},
        persistDeliveredMessage: persist,
        recordDeliveryTrace: () => null,
      });

      expect(result).toEqual({ disposition: "ack", status: "delivered", retryable: false });
      expect(persist).toHaveBeenCalledWith(makeJob(), { provider: "slack", messageId: "delivery-only" }, "hello Slack");
      expect(getChannelOutboundReceipt(makeJob().request.idempotencyKey)).toMatchObject({
        state: "complete",
        deliveryMessageId: "delivery-only",
      });
      expect(getChannelOutboundReceipt(makeJob().request.idempotencyKey)?.platformMessageId).toBeUndefined();
      expect(getChannelOutboundReceipt(makeJob().request.idempotencyKey)?.canonicalMessageId).toBeUndefined();
    });
  });

  it("persists the real provider id when the delivery id is composite", () => {
    const saveMessageMeta = mock(() => undefined);
    const upsertChatMessage = mock(() => ({
      canonicalMessageId: "cm_123",
      providerMessageId: "1711111111.000100",
      providerTimestamp: 1_711_111_111_000,
    }));

    const persisted = persistDeliveredMessage(
      makeJob(),
      {
        provider: "slack",
        messageId: "slack:C123:1711111111.000100",
        platformMessageId: "1711111111.000100",
        providerTimestamp: 1_711_111_111_000,
      },
      "hello Slack",
      {
        resolveContext: () => ({ agentId: "main", canonicalChatId: "chat_123", agentIdentity: null }),
        saveMessageMeta: saveMessageMeta as never,
        upsertChatMessage: upsertChatMessage as never,
      },
    );

    expect(saveMessageMeta).toHaveBeenCalledWith(
      "1711111111.000100",
      "C123",
      expect.objectContaining({
        identityProvenance: expect.objectContaining({
          providerMessageId: "1711111111.000100",
          deliveryMessageId: "slack:C123:1711111111.000100",
        }),
      }),
    );
    expect(upsertChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMessageId: "1711111111.000100",
        providerTimestamp: 1_711_111_111_000,
      }),
    );
    expect(persisted).toEqual({
      canonicalMessageId: "cm_123",
      platformMessageId: "1711111111.000100",
      providerTimestamp: 1_711_111_111_000,
    });
  });

  it("keeps provider identity metadata but skips canonical upsert when routing context is absent", () => {
    const saveMessageMeta = mock(() => undefined);
    const upsertChatMessage = mock(() => {
      throw new Error("must not upsert without canonical context");
    });

    const persisted = persistDeliveredMessage(
      makeJob(),
      {
        provider: "slack",
        platformMessageId: "1711111111.000100",
        providerTimestamp: 1_711_111_111_000,
      },
      "hello Slack",
      {
        resolveContext: () => ({}),
        saveMessageMeta: saveMessageMeta as never,
        upsertChatMessage: upsertChatMessage as never,
      },
    );

    expect(saveMessageMeta).toHaveBeenCalledTimes(1);
    expect(upsertChatMessage).not.toHaveBeenCalled();
    expect(persisted).toEqual({
      platformMessageId: "1711111111.000100",
      providerTimestamp: 1_711_111_111_000,
    });
  });

  it("fingerprints equivalent request objects deterministically", () => {
    const original = makeJob();
    const reordered = makeJob();
    reordered.request.target = {
      threadId: reordered.request.target.threadId,
      chatId: reordered.request.target.chatId,
      instanceId: reordered.request.target.instanceId,
      accountId: reordered.request.target.accountId,
      channel: reordered.request.target.channel,
    };

    expect(channelOutboundRequestFingerprint(reordered)).toBe(channelOutboundRequestFingerprint(original));
  });
});

function makeDelivery(): NativeTextDelivery {
  return {
    channelId: "slack",
    supports: (target) => target.channel === "slack",
    deliverText: mock(async () => ({
      provider: "slack",
      messageId: "slack:C123:1711111111.000100",
      platformMessageId: "1711111111.000100",
      providerTimestamp: 1_711_111_111_000,
    })),
  };
}

function makeJob(): ChannelOutboundJob {
  return {
    jobId: "runtime:ravi-channels:emit_1",
    status: "queued",
    attemptCount: 0,
    createdAt: 1782920000000,
    updatedAt: 1782920000000,
    request: {
      requestId: "runtime:ravi-channels:emit_1",
      channelId: "slack",
      instanceId: "slack-main",
      accountId: "T1",
      targetChatId: "C123",
      targetThreadId: "1711111111.000010",
      origin: {
        sessionName: "ravi-channels",
        emitId: "emit_1",
      },
      content: {
        type: "text",
        text: "hello Slack",
      },
      idempotencyKey: "runtime:ravi-channels:emit_1:slack:T1:C123:1711111111.000010",
      target: {
        channel: "slack",
        accountId: "T1",
        instanceId: "slack-main",
        chatId: "C123",
        threadId: "1711111111.000010",
      },
    },
  };
}
