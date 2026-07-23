import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

let currentJsm: PromptJsm;
const promptPublishMock = mock(async (_subject: string, _payload: Uint8Array) => ({}));
const runtimeEmitMock = mock(async (_topic: string, _payload: Record<string, unknown>) => {});
const recordPromptPublishedTraceMock = mock(() => null);
const actualChannelTraceModule = await import("../session-trace/channel-trace.js");

mock.module("../nats.js", () => ({
  ensureConnected: mock(async () => ({
    jetstream: () => ({
      publish: promptPublishMock,
    }),
  })),
  getNats: mock(() => ({
    jetstreamManager: async () => currentJsm,
  })),
  nats: {
    emit: runtimeEmitMock,
  },
}));

mock.module("../session-trace/channel-trace.js", () => ({
  ...actualChannelTraceModule,
  recordPromptPublishedTrace: recordPromptPublishedTraceMock,
}));

const {
  ensureSessionConsumer,
  ensureSessionPromptInfrastructure,
  ensureSessionPromptsStream,
  publishSessionPrompt,
  resetSessionPromptInfrastructureCacheForTests,
} = await import("./session-stream.js");

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  resetSessionPromptInfrastructureCacheForTests();
  currentJsm = makePromptJsm();
  promptPublishMock.mockClear();
  runtimeEmitMock.mockClear();
  recordPromptPublishedTraceMock.mockClear();
});

describe("session prompt JetStream infrastructure", () => {
  it("shares concurrent infrastructure recovery in one process", async () => {
    const streamAddGate = deferred<void>();
    const calls = {
      streamAdds: 0,
      consumerAdds: 0,
    };
    let streamExists = false;
    let consumerExists = false;

    currentJsm = makePromptJsm({
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

    const firstEnsure = ensureSessionPromptInfrastructure(currentJsm as never);
    await waitUntil(() => calls.streamAdds === 1);
    const secondEnsure = ensureSessionPromptInfrastructure(currentJsm as never);

    streamAddGate.resolve();
    await Promise.all([firstEnsure, secondEnsure]);

    expect(calls.streamAdds).toBe(1);
    expect(calls.consumerAdds).toBe(1);
  });

  it("caches successful infrastructure validation off the publish hot path", async () => {
    const streamInfo = mock(async () => ({}));
    const consumerInfo = mock(async () => ({}));
    currentJsm = makePromptJsm({
      streams: { info: streamInfo },
      consumers: { info: consumerInfo },
    });

    await ensureSessionPromptInfrastructure(currentJsm as never);
    await ensureSessionPromptInfrastructure(currentJsm as never);

    expect(streamInfo).toHaveBeenCalledTimes(1);
    expect(consumerInfo).toHaveBeenCalledTimes(1);
  });

  it("force revalidates cached infrastructure for health checks and recovery", async () => {
    const streamInfo = mock(async () => ({}));
    const consumerInfo = mock(async () => ({}));
    currentJsm = makePromptJsm({
      streams: { info: streamInfo },
      consumers: { info: consumerInfo },
    });

    await ensureSessionPromptInfrastructure(currentJsm as never);
    await ensureSessionPromptInfrastructure(currentJsm as never, { force: true });

    expect(streamInfo).toHaveBeenCalledTimes(2);
    expect(consumerInfo).toHaveBeenCalledTimes(2);
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
    currentJsm = makePromptJsm({
      streams: {
        info: streamInfo,
        add: streamAdd,
      },
    });

    await ensureSessionPromptsStream(currentJsm as never);

    expect(streamAdd).toHaveBeenCalledTimes(1);
    expect(streamInfo).toHaveBeenCalledTimes(2);
  });

  it("treats consumer add conflicts as success when the consumer now exists", async () => {
    let consumerExists = false;
    const consumerInfo = mock(async () => {
      if (!consumerExists) throw new Error("consumer not found");
      return {};
    });
    const consumerAdd = mock(async () => {
      consumerExists = true;
      throw new Error("consumer already exists");
    });
    currentJsm = makePromptJsm({
      consumers: {
        info: consumerInfo,
        add: consumerAdd,
      },
    });

    await ensureSessionConsumer(currentJsm as never);

    expect(consumerAdd).toHaveBeenCalledTimes(1);
    expect(consumerInfo).toHaveBeenCalledTimes(2);
  });

  it("announces a sourced prompt to the runtime after its durable publish", async () => {
    const callOrder: string[] = [];
    promptPublishMock.mockImplementationOnce(async () => {
      callOrder.push("prompt");
      return {};
    });
    runtimeEmitMock.mockImplementationOnce(async () => {
      callOrder.push("runtime");
    });
    const source = {
      channel: "slack",
      accountId: "hana-slack",
      instanceId: "slack-main",
      chatId: "C123",
      sourceMessageId: "1784824412.623669",
    };

    await publishSessionPrompt("ravi-slack-channel", {
      prompt: "deixa eu testar",
      source,
      deliveryBarrier: "after_tool",
      deliveryBarrierSource: "default",
    });

    expect(callOrder).toEqual(["prompt", "runtime"]);
    expect(runtimeEmitMock).toHaveBeenCalledWith(
      "ravi.session.ravi-slack-channel.runtime",
      expect.objectContaining({
        type: "prompt.published",
        sessionName: "ravi-slack-channel",
        _source: source,
        deliveryBarrier: "after_tool",
        deliveryBarrierSource: "default",
      }),
    );
  });
});

function makePromptJsm(overrides: PromptJsmOverrides = {}): PromptJsm {
  return {
    streams: {
      info: mock(async () => ({})),
      add: mock(async () => ({})),
      ...(overrides.streams ?? {}),
    },
    consumers: {
      list: mock(() => ({
        next: mock(async () => []),
      })),
      delete: mock(async () => true),
      info: mock(async () => ({})),
      add: mock(async () => ({})),
      ...(overrides.consumers ?? {}),
    },
  };
}

interface PromptJsm {
  streams: {
    info: ReturnType<typeof mock>;
    add: ReturnType<typeof mock>;
  };
  consumers: {
    list: ReturnType<typeof mock>;
    delete: ReturnType<typeof mock>;
    info: ReturnType<typeof mock>;
    add: ReturnType<typeof mock>;
  };
}

interface PromptJsmOverrides {
  streams?: Partial<PromptJsm["streams"]>;
  consumers?: Partial<PromptJsm["consumers"]>;
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
