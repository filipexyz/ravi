import { describe, expect, it, mock } from "bun:test";
import type { NativeTextDelivery } from "./native/types.js";
import { processChannelOutboundJob } from "./outbound-consumer.js";
import type { ChannelOutboundJob } from "./outbound-stream.js";

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
        platformMessageId: "1711111111.000100",
        jobId: "runtime:ravi-channels:emit_1",
      }),
    );
  });

  it("acks terminal missing-adapter failures", async () => {
    const emitEvent = mock(async () => {});
    const result = await processChannelOutboundJob(makeJob(), {
      deliveries: [],
      emitEvent,
      persistDelivery: false,
    });

    expect(result).toMatchObject({
      disposition: "ack",
      status: "failed",
      retryable: false,
    });
    expect(emitEvent).toHaveBeenCalledWith(
      "ravi.session.ravi-channels.delivery",
      expect.objectContaining({
        status: "failed",
        reason: "missing_adapter",
      }),
    );
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

  it("redelivers at least once after provider success when the JetStream ack is lost", async () => {
    const deliveries: string[] = [];
    const delivery: NativeTextDelivery = {
      channelId: "slack",
      supports: () => true,
      deliverText: mock(async (request) => {
        deliveries.push(request.emitId ?? "missing");
        return {
          provider: "slack",
          messageId: `slack:${deliveries.length}`,
        };
      }),
    };
    const job = makeJob();

    const first = await processChannelOutboundJob(job, {
      deliveries: [delivery],
      emitEvent: mock(async () => {}),
      persistDelivery: false,
    });
    // The outer consumer would ACK JetStream here. Simulate a process crash
    // before that ACK reaches the broker by processing the same job again.
    const replayAfterCrash = await processChannelOutboundJob(job, {
      deliveries: [delivery],
      emitEvent: mock(async () => {}),
      persistDelivery: false,
    });

    expect(first.disposition).toBe("ack");
    expect(replayAfterCrash.disposition).toBe("ack");
    expect(deliveries).toEqual(["emit_1", "emit_1"]);
  });
});

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
