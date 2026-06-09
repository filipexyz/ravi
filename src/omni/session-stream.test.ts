import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

let currentJsm: PromptJsm;

const { ensureSessionConsumer, ensureSessionPromptInfrastructure, ensureSessionPromptsStream } = await import(
  "./session-stream.js"
);

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  currentJsm = makePromptJsm();
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
