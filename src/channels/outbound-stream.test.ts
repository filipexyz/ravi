import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  CHANNEL_OUTBOUND_CONSUMER,
  CHANNEL_OUTBOUND_STREAM,
  buildChannelChatActionJob,
  buildChannelOutboundJobFromResponse,
  buildChannelTextOutboundJob,
  ensureChannelOutboundConsumer,
  ensureChannelOutboundInfrastructure,
  ensureChannelOutboundStream,
  resetChannelOutboundInfrastructureCacheForTests,
  subjectForChannel,
} from "./outbound-stream.js";

let currentJsm: ChannelOutboundJsm;

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  resetChannelOutboundInfrastructureCacheForTests();
  currentJsm = makeChannelOutboundJsm();
});

describe("channel outbound jobs", () => {
  it("builds durable outbound jobs from runtime responses", () => {
    const result = buildChannelOutboundJobFromResponse(
      "ravi-channels",
      {
        response: "hello Slack",
        _emitId: "emit_1",
        metadata: {
          item: {
            phase: "commentary",
          },
        },
        target: {
          channel: "slack",
          accountId: "workspace:T1",
          instanceId: "slack-main",
          chatId: "C123",
          threadId: "1711111111.000100",
        },
      },
      { now: 1782920000000 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.job).toMatchObject({
      jobId: "runtime:ravi-channels:emit_1",
      status: "queued",
      attemptCount: 0,
      createdAt: 1782920000000,
      updatedAt: 1782920000000,
      request: {
        requestId: "runtime:ravi-channels:emit_1",
        channelId: "slack",
        instanceId: "slack-main",
        accountId: "workspace:T1",
        targetChatId: "C123",
        targetThreadId: "1711111111.000100",
        origin: {
          sessionName: "ravi-channels",
          emitId: "emit_1",
          responsePhase: "commentary",
        },
        content: {
          type: "text",
          text: "hello Slack",
        },
      },
    });
    expect(result.job.request.idempotencyKey).toBe(
      "runtime:ravi-channels:emit_1:slack:workspace:T1:C123:1711111111.000100",
    );
  });

  it("does not create jobs for responses that must not be delivered", () => {
    expect(buildChannelOutboundJobFromResponse("s", { response: "x" })).toEqual({
      ok: false,
      reason: "missing_target",
    });
    expect(
      buildChannelOutboundJobFromResponse("s", {
        response: "x",
        target: { channel: "slack", accountId: "a", chatId: "c" },
      }),
    ).toEqual({ ok: false, reason: "missing_emit_id" });
    expect(
      buildChannelOutboundJobFromResponse("s", {
        response: "@@SILENT@@",
        _emitId: "e",
        target: { channel: "slack", accountId: "a", chatId: "c" },
      }),
    ).toEqual({ ok: false, reason: "silent_response" });
  });

  it("builds explicitly idempotent text jobs for channel backend projections", () => {
    const job = buildChannelTextOutboundJob({
      requestId: "channel-runtime:event-commentary-a",
      sessionName: "ravi-channels",
      emitId: "event-commentary-a",
      idempotencyKey: "event-commentary-a",
      responsePhase: "commentary",
      now: 1_782_920_000_000,
      target: {
        channel: "slack",
        accountId: "workspace:T1",
        instanceId: "slack-main",
        chatId: "C123",
        threadId: "1711111111.000100",
      },
      text: "\nChecking the current state.\n",
    });

    expect(job).toMatchObject({
      jobId: "channel-runtime:event-commentary-a",
      status: "queued",
      createdAt: 1_782_920_000_000,
      request: {
        requestId: "channel-runtime:event-commentary-a",
        channelId: "slack",
        accountId: "workspace:T1",
        targetChatId: "C123",
        targetThreadId: "1711111111.000100",
        origin: {
          sessionName: "ravi-channels",
          emitId: "event-commentary-a",
          responsePhase: "commentary",
        },
        content: {
          type: "text",
          text: "\nChecking the current state.\n",
        },
        idempotencyKey: "event-commentary-a",
      },
    });
  });

  it("builds deterministic durable jobs for native chat actions", () => {
    const job = buildChannelChatActionJob({
      sessionName: "ravi-slack-channel",
      requestId: "chat-action:test",
      now: 1_782_920_000_000,
      target: {
        channel: "slack",
        accountId: "ravi-slack",
        chatId: "C123",
      },
      content: {
        type: "chat_action",
        actionId: "message.delete",
        canonicalMessageId: "cm_123",
        providerMessageId: "1711111111.000100",
      },
    });

    expect(job).toMatchObject({
      jobId: "chat-action:test",
      status: "queued",
      request: {
        requestId: "chat-action:test",
        channelId: "slack",
        accountId: "ravi-slack",
        targetChatId: "C123",
        origin: {
          sessionName: "ravi-slack-channel",
          emitId: "chat-action:test",
          responsePhase: "chat_action",
        },
        content: {
          type: "chat_action",
          actionId: "message.delete",
          canonicalMessageId: "cm_123",
          providerMessageId: "1711111111.000100",
        },
      },
    });
    expect(job.request.idempotencyKey).toBe("chat-action:test:slack:ravi-slack:C123:message.delete:1711111111.000100");
  });

  it("normalizes channel ids into NATS subject tokens", () => {
    expect(subjectForChannel("slack")).toBe("ravi.channel.outbound.slack");
    expect(subjectForChannel("Slack Connect")).toBe("ravi.channel.outbound.slack_connect");
    expect(subjectForChannel("")).toBe("ravi.channel.outbound.unknown");
  });
});

describe("channel outbound JetStream infrastructure", () => {
  it("shares concurrent infrastructure recovery in one process", async () => {
    const streamAddGate = deferred<void>();
    const calls = {
      streamAdds: 0,
      consumerAdds: 0,
    };
    let streamExists = false;
    let consumerExists = false;

    currentJsm = makeChannelOutboundJsm({
      streams: {
        info: mock(async () => {
          if (!streamExists) throw new Error("stream not found");
          return {};
        }),
        add: mock(async () => {
          calls.streamAdds++;
          await streamAddGate.promise;
          streamExists = true;
          return {};
        }),
      },
      consumers: {
        info: mock(async () => {
          if (!consumerExists) throw new Error("consumer not found");
          return {};
        }),
        add: mock(async () => {
          calls.consumerAdds++;
          consumerExists = true;
          return {};
        }),
      },
    });

    const firstEnsure = ensureChannelOutboundInfrastructure(currentJsm as never);
    await waitUntil(() => calls.streamAdds === 1);
    const secondEnsure = ensureChannelOutboundInfrastructure(currentJsm as never);

    streamAddGate.resolve();
    await Promise.all([firstEnsure, secondEnsure]);

    expect(calls.streamAdds).toBe(1);
    expect(calls.consumerAdds).toBe(1);

    await ensureChannelOutboundInfrastructure(currentJsm as never);
    expect(calls.streamAdds).toBe(1);
    expect(calls.consumerAdds).toBe(1);
  });

  it("treats stream add conflicts as success when the stream now exists", async () => {
    let streamExists = false;
    const streamInfo = mock(async () => {
      if (!streamExists) throw new Error("stream not found");
      return {};
    });
    const streamAdd = mock(async () => {
      streamExists = true;
      throw new Error("stream name already in use");
    });
    currentJsm = makeChannelOutboundJsm({
      streams: {
        info: streamInfo,
        add: streamAdd,
      },
    });

    await ensureChannelOutboundStream(currentJsm as never);

    expect(streamAdd).toHaveBeenCalledTimes(1);
    expect(streamInfo).toHaveBeenCalledTimes(2);
  });

  it("creates the durable shared consumer", async () => {
    let consumerConfig: Record<string, unknown> | null = null;
    currentJsm = makeChannelOutboundJsm({
      consumers: {
        info: mock(async () => {
          throw new Error("consumer not found");
        }),
        add: mock(async (stream: string, config: Record<string, unknown>) => {
          consumerConfig = { stream, ...config };
          return {};
        }),
      },
    });

    await ensureChannelOutboundConsumer(currentJsm as never);

    expect(consumerConfig).toMatchObject({
      stream: CHANNEL_OUTBOUND_STREAM,
      durable_name: CHANNEL_OUTBOUND_CONSUMER,
    });
  });

  it("recreates a stale consumer when its sequence is ahead of the stream", async () => {
    const consumerDelete = mock(async () => true);
    const consumerAdd = mock(async () => ({}));
    currentJsm = makeChannelOutboundJsm({
      streams: {
        info: mock(async () => ({ state: { last_seq: 6 } })),
      },
      consumers: {
        info: mock(async () => ({ ack_floor: { stream_seq: 618 }, delivered: { stream_seq: 618 } })),
        delete: consumerDelete,
        add: consumerAdd,
      },
    });

    await ensureChannelOutboundConsumer(currentJsm as never);

    expect(consumerDelete).toHaveBeenCalledWith(CHANNEL_OUTBOUND_STREAM, CHANNEL_OUTBOUND_CONSUMER);
    expect(consumerAdd).toHaveBeenCalledTimes(1);
  });
});

function makeChannelOutboundJsm(overrides: ChannelOutboundJsmOverrides = {}): ChannelOutboundJsm {
  return {
    streams: {
      info: mock(async () => ({})),
      add: mock(async () => ({})),
      ...(overrides.streams ?? {}),
    },
    consumers: {
      info: mock(async () => ({})),
      add: mock(async () => ({})),
      delete: mock(async () => true),
      ...(overrides.consumers ?? {}),
    },
  };
}

interface ChannelOutboundJsm {
  streams: {
    info: ReturnType<typeof mock>;
    add: ReturnType<typeof mock>;
  };
  consumers: {
    info: ReturnType<typeof mock>;
    add: ReturnType<typeof mock>;
    delete: ReturnType<typeof mock>;
  };
}

interface ChannelOutboundJsmOverrides {
  streams?: Partial<ChannelOutboundJsm["streams"]>;
  consumers?: Partial<ChannelOutboundJsm["consumers"]>;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
