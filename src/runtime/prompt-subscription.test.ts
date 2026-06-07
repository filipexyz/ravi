import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const consumeCalls: Array<Record<string, unknown>> = [];
const ensureInfrastructureMock = mock(async () => {});
const emitCalls: Array<{ topic: string; payload: Record<string, unknown> }> = [];

let running = false;

const fakeConsumer = {
  consume: mock(async (options: Record<string, unknown>) => {
    consumeCalls.push(options);
    running = false;
    return (async function* () {})();
  }),
};

const fakeJetStream = {
  consumers: {
    get: mock(async () => fakeConsumer),
  },
};

mock.module("../nats.js", () => ({
  ensureConnected: mock(async () => ({
    jetstream: () => fakeJetStream,
  })),
  getNats: mock(() => ({
    jetstream: () => fakeJetStream,
  })),
  publish: mock(async (topic: string, payload: Record<string, unknown>) => {
    emitCalls.push({ topic, payload });
  }),
  subscribe: mock(async function* () {}),
  closeNats: mock(async () => {}),
  nats: {
    emit: mock(async (topic: string, payload: Record<string, unknown>) => {
      emitCalls.push({ topic, payload });
    }),
    subscribe: mock(async function* () {}),
    close: mock(async () => {}),
  },
}));

const { RuntimePromptSubscription } = await import("./prompt-subscription.js");

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  running = true;
  consumeCalls.length = 0;
  emitCalls.length = 0;
  ensureInfrastructureMock.mockClear();
  fakeConsumer.consume.mockClear();
  fakeJetStream.consumers.get.mockClear();
});

describe("RuntimePromptSubscription", () => {
  it("aborts the pull loop when SESSION_PROMPTS resources disappear", async () => {
    const subscription = new RuntimePromptSubscription({
      isRunning: () => running,
      getStreamingSessionCount: () => 0,
      ensurePromptInfrastructure: ensureInfrastructureMock,
      markConsumerReady: mock(() => {}),
      handlePrompt: mock(async () => {}),
    });

    subscription.subscribe();

    await waitUntil(() => consumeCalls.length === 1 && !subscription.active);

    expect(ensureInfrastructureMock).toHaveBeenCalled();
    expect(fakeJetStream.consumers.get).toHaveBeenCalledWith("SESSION_PROMPTS", "ravi-prompts");
    expect(consumeCalls[0]).toMatchObject({
      expires: 2000,
      abort_on_missing_resource: true,
    });
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
